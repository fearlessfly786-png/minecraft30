import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * POST /api/github/save   — starts the export, returns IMMEDIATELY.
 * GET  /api/github/save?job=<id> — polls the running export's status.
 *
 * Pushes the ENTIRE game source (src/, public/, prisma/ + root config files)
 * to the caller's GitHub account.
 *
 * Body: { token: string; repo: string }
 *   - token: a GitHub personal access token. Classic token needs the "repo"
 *     scope; a fine-grained token needs Contents read/write (+ Administration
 *     read/write when the repository has to be created).
 *   - repo:  repository name. Created under the caller's account when it does
 *     not exist yet; otherwise the source is pushed on top of / over whatever
 *     is already there.
 *
 * WHY ASYNCHRONOUS (the "GitHub request failed (502)" fix):
 *   The sandbox preview gateway cuts proxied HTTP responses at ~30 s. The
 *   first export of this game moves ~45 MB of source (public/ models alone),
 *   which a git push can easily exceed — the browser then received the
 *   gateway's "502 Bad Gateway" while the server quietly kept working. Every
 *   retry hit the same wall, the classic "GitHub request failed (502)" loop.
 *
 *   Now POST only validates the token, resolves/creates the repository and
 *   STARTS the heavy work in the background, answering in ~1-2 s. The client
 *   polls GET ?job=<id> every 2 s for live progress; the push runs to
 *   completion server-side no matter how long it takes. The browser never
 *   holds a long request again, so the gateway can no longer 502 it.
 *
 * Upload strategy (fast + reliable):
 *   Files are copied into a throwaway temp repository, committed once, and
 *   uploaded with a single `git push` (the original implementation made ~100
 *   sequential REST calls). Only 1-2 tiny REST calls remain, used to
 *   validate the token and find/create the repository.
 *
 * The token never touches persistent storage; it is used in-memory for the
 * duration of this export only.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GITHUB_API = 'https://api.github.com';
const MAX_FILE_BYTES = 95 * 1024 * 1024; // GitHub hard-rejects blobs > 100 MB
const GIT_TIMEOUT_MS = 900_000; // hard cap per git command — the push runs in
// the BACKGROUND now, so a slow first upload of ~45 MB may take minutes and
// must NOT be cut off (no HTTP deadline applies to it any more).

/** Source directories pushed to the repository (relative to the project root). */
const SOURCE_DIRS = ['src', 'public', 'prisma'];

/** Standalone config / lock files pushed from the project root. */
const SOURCE_ROOT_FILES = new Set([
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'next.config.ts',
  'postcss.config.mjs',
  'components.json',
  'eslint.config.mjs',
  'next-env.d.ts',
  '.gitignore',
  'README.md',
]);

/** Directories never descended into while walking the source tree. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.turbo', '.vercel']);

interface RepoFile {
  /** Slash-separated path relative to the project root. */
  path: string;
  /** Absolute source path — files are STREAM-COPIED from here into the
   *  temp working tree instead of being buffered in JS. Holding the whole
   *  repo's bytes (public/ alone is ~45MB) in Buffer[] used to spike the
   *  server's RSS ~2x on every save; fs.copyFile moves the same bytes
   *  through the filesystem without any JS-side buffer. */
  src: string;
}

/** Error carrying the HTTP status from a failed GitHub REST call. */
class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Minimal typed GitHub REST call with consistent headers + error extraction. */
async function github(
  token: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ratfire-game-source-export',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // non-JSON error body — fall through with the generic message
    }
  }
  if (!res.ok) {
    const message =
      (typeof payload.message === 'string' && payload.message) ||
      `GitHub API request failed (${res.status})`;
    throw new GitHubError(res.status, message);
  }
  return payload;
}

/** Strips the secret from any git output before it reaches logs or the client. */
function redact(text: string, token: string): string {
  let out = text.split(token).join('***');
  out = out.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  out = out.replace(/https:\/\/[^@\s/]+@github\.com/g, 'https://***@github.com');
  return out;
}

/** Runs one git command inside `cwd`; rejects with redacted stderr on failure. */
function runGit(args: string[], cwd: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_CONFIG_NOSYSTEM: '1',
          HOME: cwd, // isolate from the machine's global git credentials
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redact(
            `${stderr || stdout || error.message}`.trim(),
            token
          );
          reject(new Error(detail || 'git command failed'));
          return;
        }
        resolve(`${stdout}${stderr}`);
      }
    );
  });
}

/** Recursively collects source files from one directory. */
async function collectDir(
  root: string,
  dir: string,
  out: RepoFile[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDir(root, full, out);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      out.push({ path: rel, src: full });
    }
  }
}

/** Gathers every file that belongs in the exported repository. */
async function collectFiles(root: string): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const dir of SOURCE_DIRS) {
    const full = path.join(root, dir);
    try {
      await fs.access(full);
    } catch {
      continue;
    }
    await collectDir(root, full, out);
  }
  for (const name of SOURCE_ROOT_FILES) {
    try {
      const full = path.join(root, name);
      const stat = await fs.stat(full);
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
        out.push({ path: name, src: full });
      }
    } catch {
      // optional file — absent on this install
    }
  }
  return out;
}

/** Writes the collected files into the temp repository working tree
 *  (stream copy — no intermediate JS buffers). */
async function writeFiles(baseDir: string, files: RepoFile[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const target = path.join(baseDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.src, target);
    })
  );
}

// ---------------------------------------------------------------------------
// Background export jobs — the heavy work runs detached from the HTTP
// request; the client polls GET ?job=<id> for live progress.
// ---------------------------------------------------------------------------

interface ExportJob {
  state: 'preparing' | 'pushing' | 'done' | 'error';
  /** Human-readable phase for the progress UI. */
  phase: string;
  error?: string;
  url?: string;
  files?: number;
  created: number;
}

const jobs = new Map<string, ExportJob>();

/** Drops jobs older than 30 min (client long gone) — keeps the map tiny. */
function pruneJobs(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of jobs) {
    if (job.created < cutoff) jobs.delete(id);
  }
}

/** New export id — random, unguessable, safe in a URL query. */
function newJobId(): string {
  return `ghx_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** The heavy part — runs in the background after POST has already answered.
 *  Collects the source tree, commits it in a throwaway repo and pushes. */
async function runExportJob(
  job: ExportJob,
  token: string,
  login: string,
  repoName: string,
  defaultBranch: string,
  htmlUrl: string
): Promise<void> {
  let tmp = '';
  try {
    // ---------- collect every source file from disk ----------
    job.state = 'preparing';
    job.phase = 'collecting';
    const files = await collectFiles(process.cwd());
    if (files.length === 0) {
      throw new Error('No source files found on the server to upload.');
    }
    job.files = files.length;

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-export-'));

    job.phase = 'staging';
    await writeFiles(tmp, files);

    job.state = 'pushing';

    // Fresh isolated history; identity is per-invocation, never persisted.
    job.phase = 'committing';
    await runGit(['init', '-b', defaultBranch, '.'], tmp, token);
    await runGit(
      [
        '-c',
        'user.name=RATFIRE Export',
        '-c',
        'user.email=noreply@users.noreply.github.com',
        'add',
        '-A',
      ],
      tmp,
      token
    );
    await runGit(
      [
        '-c',
        'user.name=RATFIRE Export',
        '-c',
        'user.email=noreply@users.noreply.github.com',
        'commit',
        '-m',
        'Add RATFIRE game source',
        '--no-gpg-sign',
      ],
      tmp,
      token
    );
    await runGit(
      [
        'remote',
        'add',
        'origin',
        `https://x-access-token:${token}@github.com/${login}/${repoName}.git`,
      ],
      tmp,
      token
    );

    job.phase = 'uploading';
    const refspec = `HEAD:refs/heads/${defaultBranch}`;
    try {
      await runGit(['push', '-u', 'origin', refspec], tmp, token);
    } catch (pushError) {
      const detail =
        pushError instanceof Error ? pushError.message : String(pushError);
      if (/non-fast-forward|fetch first|rejected|stale info/i.test(detail)) {
        // Remote already has history (previous export) — the export owns the
        // repository content, so overwrite it with the current source tree.
        await runGit(['push', '--force', 'origin', refspec], tmp, token);
      } else if (/authentication|could not read|403/i.test(detail)) {
        throw new GitHubError(
          401,
          'GitHub rejected the push for this token — make sure it has write access to the repository (classic token with the "repo" scope, or a fine-grained token with Contents read & write).'
        );
      } else {
        throw new Error(`Git push failed: ${detail}`);
      }
    }

    job.state = 'done';
    job.phase = 'done';
    job.url = htmlUrl;
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const isGitHubError = error instanceof GitHubError;
    let message = error instanceof Error ? error.message : 'Unexpected error.';
    if (isTimeout) {
      message =
        'A GitHub request timed out (network or GitHub was slow) — press Save again to retry.';
    }
    const hint =
      isGitHubError && (error.status === 401 || error.status === 403)
        ? ' — check that the token is valid and has the required permissions (classic token with the "repo" scope, or a fine-grained token with Contents + Administration read & write).'
        : '';
    job.state = 'error';
    job.phase = 'error';
    job.error = `${message}${hint}`;
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function POST(request: Request) {
  let body: { token?: unknown; repo?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; repo?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body.' },
      { status: 400 }
    );
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const repoName = typeof body.repo === 'string' ? body.repo.trim() : '';

  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'A GitHub personal access token is required.' },
      { status: 400 }
    );
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repoName)) {
    return NextResponse.json(
      { ok: false, error: 'Repository name may only contain letters, numbers, dots, dashes and underscores.' },
      { status: 400 }
    );
  }

  try {
    pruneJobs();

    // ---------- 1) identify the authenticated account (fast REST) ----------
    const me = await github(token, '/user');
    const login = typeof me.login === 'string' ? me.login : '';
    if (!login) {
      throw new GitHubError(
        401,
        'Could not resolve the GitHub account for this token.'
      );
    }

    // ---------- 2) find or create the repository (fast REST) ----------
    let htmlUrl = `https://github.com/${login}/${repoName}`;
    let defaultBranch = 'main';
    let created = false;

    try {
      const existing = await github(token, `/repos/${login}/${repoName}`);
      htmlUrl =
        typeof existing.html_url === 'string' ? existing.html_url : htmlUrl;
      if (
        typeof existing.default_branch === 'string' &&
        existing.default_branch
      ) {
        defaultBranch = existing.default_branch;
      }
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        const newRepo = await github(token, '/user/repos', {
          method: 'POST',
          body: JSON.stringify({
            name: repoName,
            description:
              'RATFIRE — third-person three.js game built with Next.js',
            private: false,
            auto_init: false,
          }),
        });
        htmlUrl =
          typeof newRepo.html_url === 'string' ? newRepo.html_url : htmlUrl;
        if (
          typeof newRepo.default_branch === 'string' &&
          newRepo.default_branch
        ) {
          defaultBranch = newRepo.default_branch;
        }
        created = true;
      } else {
        throw error;
      }
    }

    // ---------- 3) start the heavy push in the background ----------
    const jobId = newJobId();
    const job: ExportJob = {
      state: 'preparing',
      phase: 'starting',
      created: Date.now(),
    };
    jobs.set(jobId, job);
    // Detached — the HTTP response is already on its way; the push may take
    // minutes for a first ~45 MB export and MUST NOT be tied to any request.
    void runExportJob(job, token, login, repoName, defaultBranch, htmlUrl);

    // ---------- 4) answer immediately (well inside the gateway budget) ----
    return NextResponse.json({
      ok: true,
      jobId,
      url: htmlUrl,
      owner: login,
      repo: repoName,
      branch: defaultBranch,
      created,
      method: 'git-cli-async',
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const isGitHubError = error instanceof GitHubError;
    let message = error instanceof Error ? error.message : 'Unexpected error.';
    if (isTimeout) {
      message =
        'A GitHub request timed out (network or GitHub was slow) — press Save again to retry.';
    }
    const hint =
      isGitHubError && (error.status === 401 || error.status === 403)
        ? ' — check that the token is valid and has the required permissions (classic token with the "repo" scope, or a fine-grained token with Contents + Administration read & write).'
        : '';
    return NextResponse.json({ ok: false, error: `${message}${hint}` }, { status: isGitHubError && error.status === 401 ? 401 : 500 });
  }
}

/** GET /api/github/save?job=<id> — live progress for a running export. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = (url.searchParams.get('job') || '').trim();
  if (!jobId) {
    return NextResponse.json(
      { ok: false, error: 'Missing job id.' },
      { status: 400 }
    );
  }
  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json(
      { ok: false, error: 'Unknown or expired export — start a new save.' },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    job: {
      state: job.state,
      phase: job.phase,
      error: job.error ?? null,
      url: job.url ?? null,
      files: job.files ?? null,
    },
  });
}

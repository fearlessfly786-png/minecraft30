/**
 * FERN DECOR — the user-uploaded fern_grass_02.glb scattered across the
 * world, streaming with the terrain chunks — with TWO seasonal variants:
 *
 *  - GREEN FERNS root on the GRASS biome (the summer meadow).
 *  - FROST FERNS root on the SNOW biome: their albedo is REGENERATED at
 *    load time from the original leaf texture — a deterministic per-pixel
 *    bake cools every surviving leaf toward icy blue and lays clumpy
 *    snow/ice accumulation across the fronds (plus rare glints), while the
 *    alpha channel is left untouched so the leaf silhouette stays identical.
 *    Frost ferns match their summer siblings in size and density — they
 *    merely nestle a few units INTO the snow, so they read as fronds
 *    sprouting up through the snow cover, carrying snow on every frond.
 *
 * The GLB (served from /public/models) is loaded once, its primitive is
 * baked Y-up / XZ-centred / normalised to exactly ONE unit tall and then
 * CROWN-ANCHORED: the plant is re-grounded by its root zone (the lowest
 * vertices near the central axis), NOT by its bounding box — the bbox
 * minimum of this model is the tips of the drooping outer fronds, so
 * grounding the bbox leaves the whole base hovering in mid-air. After the
 * anchor the fern sits flush on the block top with ZERO gap between plant
 * and terrain, in BOTH biomes (grass + snow share the baked geometry).
 * Each variant draws as ONE InstancedMesh — two draw calls render the
 * whole fern field (plus two in the shadow pass).
 *
 * Generation is fully deterministic from the session seed + chunk coords,
 * so a chunk always regrows the exact same ferns every time it streams in:
 *
 *  - PATCHY MEADOWS: a per-4x4-cell patch hash opens a share of the cells;
 *    inside a live patch every plantable block rolls a small chance, so
 *    ferns appear in natural clusters with a few lone stragglers between.
 *  - BIOME-GATED: the block must bucket as GRASS (green fern) or SNOW
 *    (frost fern) with the exact thresholds of terrainChunks.ts — never on
 *    sand, glacier ice, mesa, red dunes or volcano rock.
 *  - WALL-SAFE JITTER: blocks beside any riser wall hug the block centre —
 *    the sprawling fern's leaf radius (~0.3 blocks) then never pokes
 *    through the wall face.
 *  - SLOT POOLS: instances live in fixed per-variant pools; chunks borrow
 *    slots on build and release them on unload (hidden with a zero-scale
 *    matrix, instance count follows the high-water mark), so walking
 *    recycles the same GPU buffers forever — zero allocation churn.
 *  - WIND: a tiny onBeforeCompile vertex bend sways every frond; the phase
 *    comes from the instance's world origin so no two ferns move in sync.
 *    The bend runs before the instance matrix, so the sway scales with the
 *    fern and costs nothing on the CPU.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { iceFactor, winterFactor } from './winterBiomes';
import { desertFactor } from './desertBiomes';
import { redFactor, mesaFactor, volcanoFactor } from './extraBiomes';
import { volcanoSampleAt } from './volcanoTerrain';

const FERN_MODEL_URL = '/models/fern_grass_02.glb';

// Biome thresholds — MUST mirror terrainChunks.ts: a fern only roots where
// the chunk builder itself paints the GRASS or SNOW bucket.
const SNOW_THRESH = 0.5;
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

/** Patch/density tuning per variant. Both variants share IDENTICAL
 *  density and size (the snow ferns are simply the winter costume of the
 *  same plant) — all plantable blocks are candidates, sloped ones hug the
 *  block centre so leaves never clip the riser walls. Ferns root ONLY on
 *  grass (green) or snow (frost) blocks: a pure chunk of either biome
 *  grows ~22 ferns. LOW_SPEC devices take about a third. */
const PATCH_CELL = 4; // blocks per patch cell
const VARIANT_PARAMS = [
  // GREEN — the summer meadow
  {
    open: 0.6, // share of meadow cells that grow ferns
    chance: 0.14, // per plantable block inside a live patch
    lone: 0.01, // per plantable block outside patches (stragglers)
    lowOpen: 0.45,
    lowChance: 0.07,
    lowLone: 0.006,
    patchSalt: 77,
    nestle: 0.04, // of a block — seats the anchored base slightly INTO
    // the block top so the plant can never lift free of the terrain,
    // whatever the random tilt; buried geometry is hidden by the block
    sizeMul: 1,
  },
  // FROST — the same plant in its winter costume: identical density and
  // size, only nestling a touch into the snow it sprouts through
  {
    open: 0.6,
    chance: 0.14,
    lone: 0.01,
    lowOpen: 0.45,
    lowChance: 0.07,
    lowLone: 0.006,
    patchSalt: 177,
    nestle: 0.06, // of a block — the root sits under the snow surface
    sizeMul: 1,
  },
];

/** Fixed seed for the frost bake — every client paints identical ice. */
const FROST_SEED = 0x51ab7e;

export interface FernDecorHandle {
  /** Terrain hook: a chunk mesh finished building. */
  onChunkBuilt(cx: number, cz: number): void;
  /** Terrain hook: a chunk was unloaded — its ferns return to the pool. */
  onChunkUnloaded(cx: number, cz: number): void;
  /** Advance the wind clock (call once per frame with seconds). */
  update(dt: number): void;
  /** Debug probe: pool + placement counters. */
  stats(): {
    ferns: number;
    green: number;
    frost: number;
    capacity: number;
    chunks: number;
    pending: number;
    ready: boolean;
    triangles: number;
  };
  dispose(): void;
}

// ---------------- deterministic frost-bake noise (module-level, pure) ---
function vhash(ix: number, iy: number): number {
  let h =
    (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ FROST_SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(u: number, v: number): number {
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const fu = u - ix;
  const fv = v - iy;
  const su = fu * fu * (3 - 2 * fu);
  const sv = fv * fv * (3 - 2 * fv);
  const a = vhash(ix, iy);
  const b = vhash(ix + 1, iy);
  const c = vhash(ix, iy + 1);
  const d = vhash(ix + 1, iy + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
function frostFbm(u: number, v: number): number {
  return (
    vnoise(u, v) * 0.55 +
    vnoise(u * 2.7 + 13.1, v * 2.7 + 7.7) * 0.3 +
    vnoise(u * 6.1 + 3.3, v * 6.1 + 11.9) * 0.15
  );
}
function smooth01(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Regenerate the leaf albedo as an ICY FROST version: clumpy snow/ice
 * accumulation over the fronds, the surviving leaf cooled toward icy
 * blue-green, rare glints in the frost. Alpha is untouched — the cutout
 * leaf silhouette stays exactly the original's. Sampler state (flipY,
 * wrap, filters) is inherited from the source GLTF texture so the bake
 * samples identically to the original map.
 */
function createFrostMap(src: THREE.Texture): THREE.CanvasTexture | null {
  const img = src.image as HTMLImageElement | ImageBitmap | undefined;
  if (!img || img.width <= 0 || img.height <= 0) return null;
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);

  const frame = ctx.getImageData(0, 0, w, h);
  const d = frame.data;
  // noise cells sized for the texture aspect (2:1) so clumps stay round
  const nu = 24;
  const nv = Math.max(4, Math.round((24 * h) / w));

  for (let y = 0; y < h; y++) {
    const vy = (y / h) * nv;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue; // outside the leaf — untouched
      const r = d[i] / 255;
      const g = d[i + 1] / 255;
      const b = d[i + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      // HEAVY clumpy frost mask — snow blankets most of the frond with
      // crusty edges: a broad low-frequency blanket plus a fine high-
      // frequency crust, biased (gently) toward the brighter leaf faces
      const n = frostFbm((x / w) * nu, vy);
      const crust = vnoise((x / w) * nu * 4.3 + 31.7, vy * 4.3 + 17.3);
      let frost = smooth01(n * 0.78 + crust * 0.22 + (lum - 0.5) * 0.18 - 0.24);
      frost *= 0.72 + 0.28 * smooth01((lum - 0.1) / 0.55);

      // cool the surviving leaf: greens sink, blues lift — icy tundra tone
      let nr = r * 0.6 + 0.06;
      let ng = g * 0.74 + 0.1;
      let nb = Math.min(1, b * 1.1 + 0.22);

      // lay the snow: bright packed snow, barely shaded so the fronds
      // read as CARRYING snow rather than being tinted by it
      const shade = 0.88 + 0.12 * lum;
      nr = nr * (1 - frost) + 0.95 * shade * frost;
      ng = ng * (1 - frost) + 0.97 * shade * frost;
      nb = nb * (1 - frost) + 1.0 * shade * frost;

      // glints inside the frost (deterministic per pixel) — sparkling ice
      if (frost > 0.5 && vhash(x * 3 + 11, y * 3 + 29) > 0.993) {
        nr = 1;
        ng = 1;
        nb = 1;
      }

      d[i] = nr * 255;
      d[i + 1] = ng * 255;
      d[i + 2] = nb * 255;
      // alpha stays exactly as authored — same MASK silhouette
    }
  }
  ctx.putImageData(frame, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = src.flipY;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.magFilter = src.magFilter;
  tex.minFilter = src.minFilter;
  tex.generateMipmaps = src.generateMipmaps;
  tex.colorSpace = src.colorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createFernDecor(
  scene: THREE.Scene,
  opts: {
    block: number;
    gridOffset: number;
    /** Deterministic integer block height at grid coords (terrain handle). */
    blockHeight(gx: number, gz: number): number;
    /** Per-session terrain seed — salts the fern layout like lootChests. */
    seedZ: number;
    /** Must match the terrain's chunkBlocks (16). */
    chunkBlocks?: number;
    lowSpec?: boolean;
  }
): FernDecorHandle {
  const block = opts.block;
  const gridOffset = opts.gridOffset;
  const blockHeight = opts.blockHeight;
  const chunkBlocks = opts.chunkBlocks ?? 16;
  const lowSpec = !!opts.lowSpec;
  const salt = Math.floor(opts.seedZ * 1000) | 0;

  // ---------------- deterministic rng (mirrors lootChests.ts) ----------
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x: number, z: number, s: number): number {
    let h =
      (Math.imul(x, 374761393) +
        Math.imul(z, 668265263) +
        Math.imul(s, 2246822519)) |
      0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const unit = (v: number) => (v % 1000) / 1000; // hash -> [0,1)

  // ---------------- biome check (mirrors terrainChunks.ts buckets) ------
  /** Which fern variant roots here: 0 = green (grass biome), 1 = frost
   *  (snow biome), null = not plantable (ice/lava/volcano/mesa/red/desert). */
  function fernBucket(gx: number, gz: number): 0 | 1 | null {
    if (iceFactor(gx, gz) > ICE_THRESH) return null;
    if (volcanoSampleAt(gx, gz).lava > LAVA_LEVEL) return null;
    if (volcanoFactor(gx, gz) > VOLCANO_THRESH) return null;
    if (mesaFactor(gx, gz) > MESA_THRESH) return null;
    if (redFactor(gx, gz) > RED_THRESH) return null;
    if (desertFactor(gx, gz) > DESERT_THRESH) return null;
    if (winterFactor(gx, gz) > SNOW_THRESH) return 1;
    return 0;
  }

  // ---------------- per-variant instance pools -------------------------
  interface FernVariant {
    mesh: THREE.InstancedMesh;
    material: THREE.MeshStandardMaterial;
    /** Texture this variant OWNS (the frost bake) — disposed explicitly. */
    ownedMap: THREE.Texture | null;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live ferns of this variant
  }
  const variants: FernVariant[] = [];
  const bakedGeos: THREE.BufferGeometry[] = [];
  let rawTriangles = 0;
  let ready = false;
  let disposed = false;

  const POOL_GREEN = lowSpec ? 600 : 1800;
  const POOL_FROST = POOL_GREEN; // identical plant, identical meadow

  function makeVariantPool(
    material: THREE.MeshStandardMaterial,
    geometry: THREE.BufferGeometry,
    capacity: number,
    ownedMap: THREE.Texture | null
  ): FernVariant {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true; // two extra draws in the shadow pass — worth it
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // instances span the streamed world
    mesh.count = 0;
    // decorations must never intercept bullets or pickers (same rule as
    // footprintSystem)
    mesh.raycast = () => {};
    mesh.matrixAutoUpdate = false;
    const freeSlots: number[] = [];
    for (let i = capacity - 1; i >= 0; i--) {
      mesh.setMatrixAt(i, HIDE);
      freeSlots.push(i);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    return {
      mesh,
      material,
      ownedMap,
      capacity,
      freeSlots,
      slotFree: new Uint8Array(capacity).fill(1),
      highWater: 0,
      active: 0,
    };
  }
  function allocIn(v: FernVariant): number {
    const s = v.freeSlots.pop();
    if (s === undefined) return -1;
    v.slotFree[s] = 0;
    if (s + 1 > v.highWater) v.highWater = s + 1;
    return s;
  }
  function releaseIn(v: FernVariant, s: number): void {
    v.slotFree[s] = 1;
    v.freeSlots.push(s);
    while (v.highWater > 0 && v.slotFree[v.highWater - 1]) v.highWater--;
  }
  function syncVariant(v: FernVariant): void {
    v.mesh.count = v.highWater;
    v.mesh.instanceMatrix.needsUpdate = true;
  }

  // chunk bookkeeping
  const loadedChunks = new Set<string>();
  const decorated = new Map<string, number[][]>(); // chunkKey -> slots per variant
  const pendingChunks = new Set<string>(); // built while the GLB was loading
  const pendingList: Array<{ cx: number; cz: number }> = [];

  function chunkKey(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  // ---------------- placement scratch ----------------------------------
  const m4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

  // ---------------- model load + bake ----------------------------------
  const timeU = { value: Math.random() * 100 };

  /** Wind bend shared by both variants: one clock, per-instance phase
   *  from the instance's world origin (instanceMatrix[3]). */
  function applyWindBend(m: THREE.Material): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uFernTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uFernTime;'
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float fPhase = dot(instanceMatrix[3].xz, vec2(0.0493, 0.0371));',
            '  float fBend = clamp(transformed.y, 0.0, 1.0);',
            '  fBend *= fBend;',
            '  transformed.x += (sin(uFernTime * 1.9 + fPhase) * 0.045 +',
            '    sin(uFernTime * 4.7 + fPhase * 2.3) * 0.012) * fBend;',
            '  transformed.z += (cos(uFernTime * 1.6 + fPhase * 1.7) * 0.040 +',
            '    cos(uFernTime * 3.9 + fPhase) * 0.010) * fBend;',
            '#endif',
          ].join('\n')
        );
    };
  }

  new GLTFLoader().load(
    FERN_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);

      // Measure the whole plant, then normalise it: Y-up, centred on XZ,
      // grounded at y=0, exactly ONE unit tall — instance scale then sets
      // the final fern height in world units.
      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const norm = 1 / Math.max(1e-6, size.y);

      const bake = new THREE.Matrix4()
        .makeScale(norm, norm, norm)
        .multiply(
          new THREE.Matrix4().makeTranslation(
            -(box.min.x + box.max.x) / 2,
            -box.min.y,
            -(box.min.z + box.max.z) / 2
          )
        );

      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;

        // The primitive's transform relative to the scene root is baked
        // into a private geometry copy — the instance matrices then only
        // carry position/rotation/scale, and the wind shader can assume a
        // clean Y-up one-unit-tall space. Both variants share this geometry.
        const rel = new THREE.Matrix4()
          .copy(mesh.matrixWorld)
          .premultiply(root.matrixWorld.clone().invert());
        const geo = mesh.geometry
          .clone()
          .applyMatrix4(new THREE.Matrix4().multiplyMatrices(bake, rel));

        // CROWN ANCHOR (zero-gap seat, both variants share this): this
        // plant is a drooping rosette — its bbox minimum is the TIPS of
        // the outer fronds (radius ~1.4x its height), while the crown the
        // fronds grow from sits ~0.2 of the height ABOVE that plane.
        // Grounding the bbox therefore floats the visible base well clear
        // of the ground ("distance between fern and terrain"). Re-anchor
        // by the ROOT ZONE: find the lowest vertices near the central
        // axis and sink the geometry so they rest exactly on the block
        // top — outer fronds then lie on / just into the ground. A no-op
        // for any model whose true base IS its bbox minimum.
        const posA = geo.attributes.position;
        let crownY = Infinity;
        for (let i = 0; i < posA.count; i++) {
          const x = posA.getX(i);
          const z = posA.getZ(i);
          // central column: radius < 0.2 of the plant's height (the geo
          // is already XZ-centred, so radius is direct)
          if (x * x + z * z < 0.04 && posA.getY(i) < crownY)
            crownY = posA.getY(i);
        }
        if (Number.isFinite(crownY) && crownY > 0) {
          geo.translate(0, -Math.min(crownY, 0.35), 0);
        }

        bakedGeos.push(geo);
        rawTriangles +=
          (geo.index ? geo.index.count : geo.attributes.position.count) / 3;

        let src = mesh.material as THREE.Material;
        if (Array.isArray(src)) src = src[0];
        const base = (src as THREE.MeshStandardMaterial).clone();

        // GREEN (summer) variant — the original albedo
        base.side = THREE.DoubleSide; // leaves are single planes
        if (base.alphaTest <= 0) base.alphaTest = 0.5; // MASK safety
        applyWindBend(base);
        variants.push(makeVariantPool(base, geo, POOL_GREEN, null));

        // FROST (winter) variant — the albedo REGENERATED with ice over
        // the leaves (same normal/roughness maps: snow changes the colour
        // of the fronds, not their micro-relief)
        const frost = base.clone();
        const frostMap = base.map ? createFrostMap(base.map) : null;
        if (frostMap) {
          frost.map = frostMap;
        } else {
          // bake unavailable (no image yet) — fall back to a cool tint
          frost.color.setRGB(0.72, 0.85, 1.0);
        }
        applyWindBend(frost); // clone() does not carry onBeforeCompile
        variants.push(
          makeVariantPool(frost, geo, POOL_FROST, frostMap)
        );
      });

      ready = true;

      // grow the ferns for every chunk that streamed in while loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('fernDecor: fern model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (variants.length === 0) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x9e3779b9);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const cells = Math.max(1, Math.floor(chunkBlocks / PATCH_CELL));

    // per-variant live patch mask (independent fields -> the green and
    // frost colonies interleave organically across the climate border)
    const patchLive: boolean[] = VARIANT_PARAMS.map((P) => {
      const open = lowSpec ? P.lowOpen : P.open;
      return new Array(cells * cells).fill(false).map((_, cell) => {
        const px = cell % cells;
        const pz = Math.floor(cell / cells);
        return (
          unit(hash2(cx * cells + px, cz * cells + pz, salt + P.patchSalt)) <
          open
        );
      });
    });

    const chunkSlots: number[][] = variants.map(() => []);

    for (let pz = 0; pz < cells; pz++) {
      for (let px = 0; px < cells; px++) {
        for (let lz = 0; lz < PATCH_CELL; lz++) {
          for (let lx = 0; lx < PATCH_CELL; lx++) {
            const gx = baseX + px * PATCH_CELL + lx;
            const gz = baseZ + pz * PATCH_CELL + lz;
            if (gx >= baseX + chunkBlocks || gz >= baseZ + chunkBlocks)
              continue; // ragged chunkBlocks sizes

            const bucket = fernBucket(gx, gz);
            if (bucket === null) continue;
            const P = VARIANT_PARAMS[bucket];
            const chance = lowSpec ? P.lowChance : P.chance;
            const loneC = lowSpec ? P.lowLone : P.lone;

            const h = blockHeight(gx, gz);
            const hpx = blockHeight(gx + 1, gz);
            const hnx = blockHeight(gx - 1, gz);
            const hpz = blockHeight(gx, gz + 1);
            const hnz = blockHeight(gx, gz - 1);

            const r = rng();
            const live = patchLive[bucket][pz * cells + px];
            const inPatch = live && r < chance;
            const lone = !live && r < loneC;
            if (!inPatch && !lone) continue;

            const v = variants[bucket];
            const slot = allocIn(v);
            if (slot < 0) continue; // pool exhausted — fewer ferns here

            const flat =
              hpx === h && hnx === h && hpz === h && hnz === h;

            // position: seated ON the block's top surface — the crown-
            // anchored bake puts the root zone exactly at this plane and
            // the small nestle presses it flush into the block (zero gap
            // between plant and terrain); frost ferns sink a touch deeper
            // so they sprout up through the snow cover. Flat
            // blocks may drift wide (overlapping tops are seamless);
            // blocks beside ANY wall hug the centre — the fern's leaf
            // radius (~0.3 blocks) then stays clear of the riser face.
            const spread = flat ? 0.56 : 0.3;
            pos.set(
              (gx - gridOffset) * block + (rng() - 0.5) * block * spread,
              h * block + block / 2 - P.nestle * block,
              (gz - gridOffset) * block + (rng() - 0.5) * block * spread
            );
            // size: a fern clump about a third to half a block tall (the
            // plant sprawls ~3x wider than tall). Sloped blocks and frost
            // ferns shrink a touch so the silhouette stays tidy.
            scl.setScalar(
              block *
                (0.28 + rng() * 0.27) *
                P.sizeMul *
                (flat ? 1 : 0.8)
            );
            euler.set(
              (rng() - 0.5) * 0.14,
              rng() * Math.PI * 2,
              (rng() - 0.5) * 0.14
            );
            quat.setFromEuler(euler);
            m4.compose(pos, quat, scl);
            v.mesh.setMatrixAt(slot, m4);
            chunkSlots[bucket].push(slot);
          }
        }
      }
    }

    decorated.set(key, chunkSlots);
    for (let i = 0; i < variants.length; i++) {
      if (chunkSlots[i].length > 0) {
        variants[i].active += chunkSlots[i].length;
        syncVariant(variants[i]);
      }
    }
  }

  // ---------------- hooks + frame --------------------------------------
  function onChunkBuilt(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    loadedChunks.add(key);
    if (!ready) {
      if (!pendingChunks.has(key)) {
        pendingChunks.add(key);
        pendingList.push({ cx, cz });
      }
      return;
    }
    placeChunk(cx, cz);
  }

  function onChunkUnloaded(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    loadedChunks.delete(key);
    pendingChunks.delete(key);
    const chunkSlots = decorated.get(key);
    if (!chunkSlots) return;
    decorated.delete(key);
    for (let i = 0; i < chunkSlots.length; i++) {
      const slots = chunkSlots[i];
      if (slots.length === 0) continue;
      for (const s of slots) releaseIn(variants[i], s);
      variants[i].active -= slots.length;
      syncVariant(variants[i]);
    }
  }

  function update(dt: number): void {
    if (ready) timeU.value += Math.min(dt, 0.1);
  }

  function stats() {
    const green = variants[0]?.active ?? 0;
    const frost = variants[1]?.active ?? 0;
    return {
      ferns: green + frost,
      green,
      frost,
      capacity: variants.reduce((n, v) => n + v.capacity, 0),
      chunks: decorated.size,
      pending: pendingList.length,
      ready,
      triangles: Math.round((green + frost) * rawTriangles),
    };
  }

  function dispose(): void {
    disposed = true;
    for (const v of variants) {
      scene.remove(v.mesh);
      v.mesh.dispose();
      const m = v.material as THREE.MeshStandardMaterial;
      for (const key of [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap',
        'alphaMap',
        'displacementMap',
      ] as const) {
        (m[key] as THREE.Texture | null)?.dispose();
      }
      if (v.ownedMap) v.ownedMap.dispose(); // frost bake (already covered
      // by the map dispose above, but explicit is safer against clones)
      m.dispose();
    }
    variants.length = 0;
    for (const g of bakedGeos) g.dispose();
    bakedGeos.length = 0;
    decorated.clear();
    loadedChunks.clear();
    pendingChunks.clear();
    pendingList.length = 0;
  }

  return { onChunkBuilt, onChunkUnloaded, update, stats, dispose };
}

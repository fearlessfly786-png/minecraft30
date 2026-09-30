/**
 * BAMBOO DECOR — the user-uploaded "Bamboo Bush" (Sketchfab export —
 * public/models/bamboo_bush/bamboo_bush.glb, one textured primitive:
 * 1024² RGBA leaf atlas with binary-ish alpha, ~1.1k triangles per clump)
 * scattered across the GRASS biome ONLY, streaming with the terrain
 * chunks — the tall bamboo sibling of the fern field
 * (src/game/fernDecor.ts), the calendula flowers (src/game/flowerDecor.ts)
 * and the jasmine field (src/game/jasmineDecor.ts).
 *
 * Same machinery as the other planted decor:
 *  - ONE InstancedMesh renders the whole bamboo field (the plant carries
 *    a single material — baked into ONE merged geometry with one group,
 *    so it is 1 draw call total, +1 in the shadow pass). Fixed slot pool
 *    with a free-list + high-water mark: chunks borrow slots on build and
 *    release them on unload (hidden with a zero-scale matrix), so walking
 *    recycles the same GPU buffers forever — zero allocation churn.
 *  - ALPHA-MASKED: the source material ships as alphaMode BLEND, which
 *    sorts terribly under instancing — its alpha atlas is measured as
 *    ~97% binary (41% fully clear / 56% fully opaque / 3% soft rim), so
 *    the bake re-flags it alphaTest 0.5 (the fern's own recipe): crisp
 *    leaf cutouts, correct depth writes, zero sorting artifacts.
 *  - GRASS-ONLY: the block must pass the same biome gates as the fern's
 *    green bucket with the exact terrainChunks.ts thresholds — never on
 *    snow, ice, sand, mesa, red dunes or volcano rock (per request: the
 *    bamboo belongs to the greenland region alone).
 *  - FLUSH SEAT: the plant is baked Y-up / XZ-centred / normalised to
 *    exactly ONE unit tall and then ROOT-ANCHORED exactly like the other
 *    plants — re-grounded by the lowest vertices near the central axis
 *    (NOT the bbox), so the stalk bases rest on the block's TOP surface
 *    with zero gap, and a small nestle presses the base slightly INTO
 *    the block so the random tilt can never lift it free.
 *  - WIND: a tiny onBeforeCompile vertex bend sways the plants; the phase
 *    comes from the instance's world origin so no two clumps move in
 *    sync. Bamboo bends GENTLY high up — stiff stalks, rustling leaves.
 *  - SPACED LATTICE: the clumps root on a coarse global lattice (one
 *    candidate every SPACING² blocks) with a salted grove hash — the
 *    giant clumps keep clear ground between each other instead of
 *    merging into a wall (user request), and the spacing holds across
 *    chunk borders because the lattice is world-space, not per-chunk.
 *  - Raycast disabled (footprintSystem rule) so bullets/pickers never hit
 *    a bamboo clump; castShadow on; full dispose().
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { iceFactor, winterFactor } from './winterBiomes';
import { desertFactor } from './desertBiomes';
import { redFactor, mesaFactor, volcanoFactor } from './extraBiomes';
import { volcanoSampleAt } from './volcanoTerrain';

const BAMBOO_MODEL_URL = '/models/bamboo_bush/bamboo_bush.glb';

// Biome thresholds — MUST mirror terrainChunks.ts / fernDecor.ts: bamboo
// roots ONLY where the chunk builder paints the GRASS bucket.
const SNOW_THRESH = 0.5;
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

// Spacing/density tuning — the bamboo roots on a coarse global LATTICE
// (one candidate every BAMBOO_SPACING² blocks, wherever the biome is
// grass) so the giant clumps keep clear space BETWEEN EACH OTHER instead
// of crowding the same blocks (user request). Each lattice point grows a
// grove with a salted hash chance; the roots drift a little on flat
// ground but can never meet a neighbour (min root gap ≈ SPACING - 2×JITTER
// ≈ 3.6 blocks — the widest crowns just brush, the stalks never merge).
// Clumps stand 3.6-8.0 blocks tall (4x the original range per user
// request).
const BAMBOO_SPACING = 6; // blocks between root lattice points
const JITTER = 1.2; // blocks of root drift on flat ground (±)
const GROVE_CHANCE = 0.5; // share of lattice points that grow a clump
const LOW_GROVE = 0.35; // lowSpec: fewer groves
const PATCH_SALT = 811; // distinct from the ferns (77 / 177), calendula
// (411), jasmine (611) and the desert plant (711) — the groves
// interleave, never copy, the other plants' layouts.
const NESTLE = 0.05; // of a block — seats the base INTO the block top

export interface BambooDecorHandle {
  /** Terrain hook: a chunk mesh finished building. */
  onChunkBuilt(cx: number, cz: number): void;
  /** Terrain hook: a chunk was unloaded — its bamboo returns to the pool. */
  onChunkUnloaded(cx: number, cz: number): void;
  /** Advance the wind clock (call once per frame with seconds). */
  update(dt: number): void;
  /** Debug probe: pool + placement counters. */
  stats(): {
    plants: number;
    capacity: number;
    chunks: number;
    pending: number;
    ready: boolean;
    triangles: number;
  };
  dispose(): void;
}

export function createBambooDecor(
  scene: THREE.Scene,
  opts: {
    block: number;
    gridOffset: number;
    /** Deterministic integer block height at grid coords (terrain handle). */
    blockHeight(gx: number, gz: number): number;
    /** Per-session terrain seed — salts the bamboo layout like the ferns. */
    seedZ: number;
    /** Must match the terrain's chunkBlocks (16). */
    chunkBlocks?: number;
    lowSpec?: boolean;
  }
): BambooDecorHandle {
  const block = opts.block;
  const gridOffset = opts.gridOffset;
  const blockHeight = opts.blockHeight;
  const chunkBlocks = opts.chunkBlocks ?? 16;
  const lowSpec = !!opts.lowSpec;
  const salt = Math.floor(opts.seedZ * 1000) | 0;

  // ---------------- deterministic rng (mirrors jasmineDecor.ts) -----------
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

  // ---------------- biome check (GRASS bucket only) ---------------------
  /** False everywhere the chunk builder would NOT paint grass — the
   *  bamboo belongs to the greenland region alone (user request). */
  function isBambooBlock(gx: number, gz: number): boolean {
    if (iceFactor(gx, gz) > ICE_THRESH) return false;
    if (volcanoSampleAt(gx, gz).lava > LAVA_LEVEL) return false;
    if (volcanoFactor(gx, gz) > VOLCANO_THRESH) return false;
    if (mesaFactor(gx, gz) > MESA_THRESH) return false;
    if (redFactor(gx, gz) > RED_THRESH) return false;
    if (desertFactor(gx, gz) > DESERT_THRESH) return false;
    if (winterFactor(gx, gz) > SNOW_THRESH) return false;
    return true;
  }

  // ---------------- instance pool --------------------------------------
  interface BambooPool {
    mesh: THREE.InstancedMesh;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live plants
  }
  // ~1.1k tris per clump — the cheapest plant in the field, so the pool
  // can stay generous while the worst-case triangle load remains in the
  // same league as the ferns (~550k tris at full).
  const POOL = lowSpec ? 180 : 500;

  const bakedGeos: THREE.BufferGeometry[] = [];
  const poolMats: THREE.Material[] = [];
  let pool: BambooPool | null = null;
  let rawTriangles = 0;
  let ready = false;
  let disposed = false;

  function makePool(
    materials: THREE.Material[],
    geometry: THREE.BufferGeometry,
    capacity: number
  ): BambooPool {
    const mesh = new THREE.InstancedMesh(geometry, materials, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
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
      capacity,
      freeSlots,
      slotFree: new Uint8Array(capacity).fill(1),
      highWater: 0,
      active: 0,
    };
  }
  function allocSlot(): number {
    if (!pool) return -1;
    const s = pool.freeSlots.pop();
    if (s === undefined) return -1;
    pool.slotFree[s] = 0;
    if (s + 1 > pool.highWater) pool.highWater = s + 1;
    return s;
  }
  function releaseSlot(s: number): void {
    if (!pool) return;
    pool.slotFree[s] = 1;
    pool.freeSlots.push(s);
    while (pool.highWater > 0 && pool.slotFree[pool.highWater - 1])
      pool.highWater--;
  }
  function syncPool(): void {
    if (!pool) return;
    pool.mesh.count = pool.highWater;
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  // chunk bookkeeping
  const loadedChunks = new Set<string>();
  const decorated = new Map<string, number[]>(); // chunkKey -> slots
  const pendingChunks = new Set<string>(); // built while the model loaded
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

  /** Wind bend (fernDecor pattern): per-instance phase from the instance's
   *  world origin, quadratic bend with height — bamboo sway: stiff stalks
   *  so the movement starts higher up and rustles the leaves. */
  function applyWindBend(m: THREE.Material): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBambooTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uBambooTime;'
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float fPhase = dot(instanceMatrix[3].xz, vec2(0.0521, 0.0413));',
            '  float fBend = clamp(transformed.y, 0.0, 1.0);',
            '  fBend *= fBend * fBend;', // cubic — stalks hinge, leaves rustle
            '  transformed.x += (sin(uBambooTime * 1.4 + fPhase) * 0.034 +',
            '    sin(uBambooTime * 3.7 + fPhase * 2.3) * 0.010) * fBend;',
            '  transformed.z += (cos(uBambooTime * 1.1 + fPhase * 1.4) * 0.030 +',
            '    cos(uBambooTime * 3.1 + fPhase) * 0.009) * fBend;',
            '#endif',
          ].join('\n')
        );
    };
  }

  new GLTFLoader().load(
    BAMBOO_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();

      // PASS 1 — bake every primitive into root space (the Sketchfab root
      // carries the Z-up -> Y-up fix-up matrix), collect the unique
      // materials. UVs are PRESERVED (the bamboo is texture-mapped, unlike
      // the vertex-coloured jasmine).
      interface Part {
        geo: THREE.BufferGeometry;
        matIndex: number;
      }
      const parts: Part[] = [];
      const matIndexByUuid = new Map<string, number>();
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const rel = new THREE.Matrix4()
          .copy(mesh.matrixWorld)
          .premultiply(rootInv);
        const geo = mesh.geometry.clone().applyMatrix4(rel);
        let src = mesh.material as THREE.Material;
        if (Array.isArray(src)) src = src[0];
        const std = src as THREE.MeshStandardMaterial;
        let mi = matIndexByUuid.get(std.uuid);
        if (mi === undefined) {
          const clone = std.clone();
          // BLEND -> ALPHA-TEST MASK: instanced alpha blending sorts
          // per-instance and reads wrong from every angle. The atlas is
          // ~97% binary alpha, so a 0.5 cut (the fern recipe) gives crisp
          // leaves, correct depth writes and stable shadows.
          clone.transparent = false;
          clone.alphaTest = 0.5;
          clone.side = THREE.DoubleSide; // leaves read from every side
          mi = poolMats.length;
          matIndexByUuid.set(std.uuid, mi);
          poolMats.push(clone);
        }
        parts.push({ geo, matIndex: mi });
      });
      if (parts.length === 0) return;

      // Measure the whole plant, then normalise it: Y-up, centred on XZ,
      // grounded at y=0, exactly ONE unit tall.
      const box = new THREE.Box3();
      for (const p of parts) {
        p.geo.computeBoundingBox();
        if (p.geo.boundingBox) box.union(p.geo.boundingBox);
      }
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
      for (const p of parts) p.geo.applyMatrix4(bake);

      // merge (position / normal / uv — the leaf atlas needs its UVs)
      let vTotal = 0;
      let iTotal = 0;
      for (const p of parts) {
        vTotal += p.geo.attributes.position.count;
        iTotal += p.geo.index
          ? p.geo.index.count
          : p.geo.attributes.position.count;
      }
      const posArr = new Float32Array(vTotal * 3);
      const norArr = new Float32Array(vTotal * 3);
      const uvArr = new Float32Array(vTotal * 2);
      const idxArr = new Uint32Array(iTotal);
      const merged = new THREE.BufferGeometry();
      let vOff = 0;
      let iOff = 0;
      let allNormals = true;
      for (const p of parts) {
        const pa = p.geo.attributes.position;
        const na = p.geo.attributes.normal as
          | THREE.BufferAttribute
          | THREE.InterleavedBufferAttribute
          | undefined;
        const ua = p.geo.attributes.uv as
          | THREE.BufferAttribute
          | THREE.InterleavedBufferAttribute
          | undefined;
        if (!na) allNormals = false;
        const n = pa.count;
        for (let i = 0; i < n; i++) {
          posArr[(vOff + i) * 3] = pa.getX(i);
          posArr[(vOff + i) * 3 + 1] = pa.getY(i);
          posArr[(vOff + i) * 3 + 2] = pa.getZ(i);
          if (na) {
            norArr[(vOff + i) * 3] = na.getX(i);
            norArr[(vOff + i) * 3 + 1] = na.getY(i);
            norArr[(vOff + i) * 3 + 2] = na.getZ(i);
          }
          if (ua) {
            uvArr[(vOff + i) * 2] = ua.getX(i);
            uvArr[(vOff + i) * 2 + 1] = ua.getY(i);
          }
        }
        const groupStart = iOff;
        if (p.geo.index) {
          const ia = p.geo.index.array;
          for (let i = 0; i < ia.length; i++) idxArr[iOff + i] = ia[i] + vOff;
          iOff += ia.length;
        } else {
          for (let i = 0; i < n; i++) idxArr[iOff + i] = i + vOff;
          iOff += n;
        }
        merged.addGroup(groupStart, iOff - groupStart, p.matIndex);
        vOff += n;
        p.geo.dispose(); // merged — the private copy is done
      }
      merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      merged.setIndex(new THREE.BufferAttribute(idxArr, 1));
      if (allNormals) {
        merged.setAttribute('normal', new THREE.BufferAttribute(norArr, 3));
      } else {
        merged.computeVertexNormals(); // safety net for odd exports
      }
      rawTriangles = iTotal / 3;

      // ROOT ANCHOR — the zero-gap seat (identical to the fern bake): the
      // plant is re-grounded by its lowest vertices near the central axis
      // (where the bamboo stalks converge), NOT by the bbox — so the
      // stalk bases rest exactly on the block's TOP surface and can never
      // hover. A no-op for models whose true base IS their bbox minimum.
      const posA = merged.attributes.position;
      let rootY = Infinity;
      for (let i = 0; i < posA.count; i++) {
        const x = posA.getX(i);
        const z = posA.getZ(i);
        if (x * x + z * z < 0.04 && posA.getY(i) < rootY)
          rootY = posA.getY(i);
      }
      if (Number.isFinite(rootY) && rootY > 0) {
        merged.translate(0, -Math.min(rootY, 0.35), 0);
      }
      bakedGeos.push(merged);

      for (const m of poolMats) applyWindBend(m);
      pool = makePool(poolMats, merged, POOL);
      ready = true;

      // grow the bamboo for every chunk that streamed in while loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('bambooDecor: bamboo model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (!pool) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x6d0ba1c3);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const groveC = lowSpec ? LOW_GROVE : GROVE_CHANCE;

    const slots: number[] = [];

    // SPACED LATTICE walk: candidates exist only where the WORLD grid
    // coords are a multiple of BAMBOO_SPACING in both axes (proper mod
    // for negative coords), so clumps can never sit side by side and the
    // spacing survives chunk borders — every chunk evaluates the exact
    // same world-space lattice.
    for (let lz = 0; lz < chunkBlocks; lz++) {
      for (let lx = 0; lx < chunkBlocks; lx++) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        const mx = ((gx % BAMBOO_SPACING) + BAMBOO_SPACING) % BAMBOO_SPACING;
        const mz = ((gz % BAMBOO_SPACING) + BAMBOO_SPACING) % BAMBOO_SPACING;
        if (mx !== 0 || mz !== 0) continue; // not a lattice point

        if (!isBambooBlock(gx, gz)) continue; // grass biome only
        if (rng() >= groveC) continue; // this grove point stays empty

        const slot = allocSlot();
        if (slot < 0) return; // pool exhausted — stop here quietly

        const h = blockHeight(gx, gz);
        const hpx = blockHeight(gx + 1, gz);
        const hnx = blockHeight(gx - 1, gz);
        const hpz = blockHeight(gx, gz + 1);
        const hnz = blockHeight(gx, gz - 1);
        const flat =
          hpx === h && hnx === h && hpz === h && hnz === h;

        // position: seated ON the block's top surface — the root-
        // anchored bake puts the stalk bases exactly at this plane and
        // the small nestle presses them flush into the block (zero gap
        // between bamboo and terrain). Flat lattice points may drift up
        // to ±JITTER blocks; blocks beside ANY wall hug the centre so
        // the clump stays clear of the riser face.
        const j = flat ? JITTER : 0.15;
        pos.set(
          (gx - gridOffset) * block + (rng() - 0.5) * block * 2 * j,
          h * block + block / 2 - NESTLE * block,
          (gz - gridOffset) * block + (rng() - 0.5) * block * 2 * j
        );
        // size: 4X the original grove range (user request) — bamboo
        // stands 3.6-8.0 blocks tall, a proper bamboo-forest clump
        // towering over the meadow plants. Sloped blocks shrink a
        // touch so the silhouette stays tidy.
        scl.setScalar(
          block * (3.6 + rng() * 4.4) * (flat ? 1 : 0.8)
        );
        euler.set(
          (rng() - 0.5) * 0.10,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.10
        );
        quat.setFromEuler(euler);
        m4.compose(pos, quat, scl);
        pool.mesh.setMatrixAt(slot, m4);
        slots.push(slot);
      }
    }

    decorated.set(key, slots);
    if (slots.length > 0) {
      pool.active += slots.length;
      syncPool();
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
    const slots = decorated.get(key);
    if (!slots) return;
    decorated.delete(key);
    if (slots.length > 0 && pool) {
      for (const s of slots) releaseSlot(s);
      pool.active -= slots.length;
      syncPool();
    }
  }

  function update(dt: number): void {
    if (ready) timeU.value += Math.min(dt, 0.1);
  }

  function stats() {
    return {
      plants: pool?.active ?? 0,
      capacity: pool?.capacity ?? 0,
      chunks: decorated.size,
      pending: pendingList.length,
      ready,
      triangles: Math.round((pool?.active ?? 0) * rawTriangles),
    };
  }

  function dispose(): void {
    disposed = true;
    if (pool) {
      scene.remove(pool.mesh);
      pool.mesh.dispose();
      pool = null;
    }
    for (const m of poolMats) m.dispose();
    poolMats.length = 0;
    for (const g of bakedGeos) g.dispose();
    bakedGeos.length = 0;
    decorated.clear();
    loadedChunks.clear();
    pendingChunks.clear();
    pendingList.length = 0;
  }

  return { onChunkBuilt, onChunkUnloaded, update, stats, dispose };
}

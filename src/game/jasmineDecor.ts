/**
 * JASMINE DECOR — the user-uploaded "jasmine" plant (Sketchfab export —
 * public/models/jasmine/jasmine.glb, 4 matte vertex-colour materials:
 * white petals / yellow-white heart / green leaves / brown stems, no
 * textures, ~27k triangles per plant) scattered across the GRASS biome
 * ONLY, streaming with the terrain chunks — the white-flower sibling of
 * the calendula field (see src/game/flowerDecor.ts) and the fern field
 * (see src/game/fernDecor.ts).
 *
 * Same machinery as the other planted decor:
 *  - ONE InstancedMesh renders the whole jasmine field (the plant carries
 *    4 materials — Core / Petal / Leaf / Stem — baked into ONE merged
 *    geometry with 4 groups, so it is 4 draw calls total, +4 in the
 *    shadow pass). Fixed slot pool with a free-list + high-water mark:
 *    chunks borrow slots on build and release them on unload (hidden with
 *    a zero-scale matrix), so walking recycles the same GPU buffers
 *    forever — zero allocation churn.
 *  - HEAVY-MODEL CAP: at ~27k tris per plant (3.5x the calendula) the
 *    pool is capped at 400 (150 lowSpec) so the worst-case triangle load
 *    stays in the same league as the rest of the field — the cap quietly
 *    stops placement once full, exactly like the other pools.
 *  - DETERMINISTIC: per-chunk mulberry32 seeded by (chunk coords + session
 *    terrain seed) with its own patch salt, so a chunk always regrows the
 *    exact same jasmine colonies, interleaving with (not copying) the
 *    fern + calendula layouts.
 *  - GRASS-ONLY: the block must pass the same biome gates as the fern's
 *    green bucket with the exact terrainChunks.ts thresholds — never on
 *    snow, ice, sand, mesa, red dunes or volcano rock (per request: the
 *    flowers belong to the grassland region alone).
 *  - FLUSH SEAT: the plant is baked Y-up / XZ-centred / normalised to
 *    exactly ONE unit tall and then ROOT-ANCHORED exactly like the fern —
 *    re-grounded by the lowest vertices near the central axis (NOT the
 *    bbox), so the stems rest on the block's TOP surface with zero gap,
 *    and a small nestle presses the base slightly INTO the block so the
 *    random tilt can never lift it free.
 *  - WIND: a tiny onBeforeCompile vertex bend sways the plants; the phase
 *    comes from the instance's world origin so no two plants move in sync.
 *  - Raycast disabled (footprintSystem rule) so bullets/pickers never hit
 *    a jasmine; castShadow on; full dispose().
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { iceFactor, winterFactor } from './winterBiomes';
import { desertFactor } from './desertBiomes';
import { redFactor, mesaFactor, volcanoFactor } from './extraBiomes';
import { volcanoSampleAt } from './volcanoTerrain';

const JASMINE_MODEL_URL = '/models/jasmine/jasmine.glb';

// Biome thresholds — MUST mirror terrainChunks.ts / fernDecor.ts: jasmine
// roots ONLY where the chunk builder paints the GRASS bucket.
const SNOW_THRESH = 0.5;
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

// Patch/density tuning — the same chances as the calendula flowers (the
// jasmine grows like the other plants): clumps of ~0.16-0.30 of a block,
// in patchy colonies interleaved with the fern/flower patches.
const PATCH_CELL = 4; // blocks per patch cell
const PATCH_OPEN = 0.55; // share of meadow cells that grow jasmine
const PATCH_CHANCE = 0.15; // per plantable block inside a live patch
const LONE_CHANCE = 0.012; // per plantable block outside patches
const PATCH_SALT = 611; // distinct from the ferns (77 / 177) + calendula (411)
const LOW_OPEN = 0.4;
const LOW_CHANCE = 0.075;
const LOW_LONE = 0.007;
const NESTLE = 0.05; // of a block — seats the base INTO the block top

export interface JasmineDecorHandle {
  /** Terrain hook: a chunk mesh finished building. */
  onChunkBuilt(cx: number, cz: number): void;
  /** Terrain hook: a chunk was unloaded — its jasmine return to the pool. */
  onChunkUnloaded(cx: number, cz: number): void;
  /** Advance the wind clock (call once per frame with seconds). */
  update(dt: number): void;
  /** Debug probe: pool + placement counters. */
  stats(): {
    flowers: number;
    capacity: number;
    chunks: number;
    pending: number;
    ready: boolean;
    triangles: number;
  };
  dispose(): void;
}

export function createJasmineDecor(
  scene: THREE.Scene,
  opts: {
    block: number;
    gridOffset: number;
    /** Deterministic integer block height at grid coords (terrain handle). */
    blockHeight(gx: number, gz: number): number;
    /** Per-session terrain seed — salts the jasmine layout like the ferns. */
    seedZ: number;
    /** Must match the terrain's chunkBlocks (16). */
    chunkBlocks?: number;
    lowSpec?: boolean;
  }
): JasmineDecorHandle {
  const block = opts.block;
  const gridOffset = opts.gridOffset;
  const blockHeight = opts.blockHeight;
  const chunkBlocks = opts.chunkBlocks ?? 16;
  const lowSpec = !!opts.lowSpec;
  const salt = Math.floor(opts.seedZ * 1000) | 0;

  // ---------------- deterministic rng (mirrors fernDecor.ts) -----------
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

  // ---------------- biome check (GRASS bucket only) ---------------------
  /** False everywhere the chunk builder would NOT paint grass — the
   *  jasmine belongs to the grassland region alone (user request). */
  function isJasmineBlock(gx: number, gz: number): boolean {
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
  interface JasminePool {
    mesh: THREE.InstancedMesh;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live plants
  }
  // 27k tris per plant (3.5x the calendula) — cap the pool so the
  // worst-case triangle load stays in the field's league.
  const POOL = lowSpec ? 150 : 400;

  const bakedGeos: THREE.BufferGeometry[] = [];
  const poolMats: THREE.Material[] = [];
  let pool: JasminePool | null = null;
  let rawTriangles = 0;
  let ready = false;
  let disposed = false;

  function makePool(
    materials: THREE.Material[],
    geometry: THREE.BufferGeometry,
    capacity: number
  ): JasminePool {
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
   *  world origin, quadratic bend with height — slightly gentler than the
   *  ferns: the jasmine's stiff stems carry the white crowns. */
  function applyWindBend(m: THREE.Material): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uJasmineTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uJasmineTime;'
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float fPhase = dot(instanceMatrix[3].xz, vec2(0.0473, 0.0389));',
            '  float fBend = clamp(transformed.y, 0.0, 1.0);',
            '  fBend *= fBend;',
            '  transformed.x += (sin(uJasmineTime * 1.6 + fPhase) * 0.030 +',
            '    sin(uJasmineTime * 4.0 + fPhase * 2.1) * 0.008) * fBend;',
            '  transformed.z += (cos(uJasmineTime * 1.3 + fPhase * 1.6) * 0.026 +',
            '    cos(uJasmineTime * 3.4 + fPhase) * 0.007) * fBend;',
            '#endif',
          ].join('\n')
        );
    };
  }

  new GLTFLoader().load(
    JASMINE_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();

      // PASS 1 — bake every primitive into root space, collect the unique
      // materials (petal white / heart yellow / leaf green / stem brown).
      // The whole 4-mesh plant becomes ONE merged geometry with
      // per-mesh groups, so ONE InstancedMesh draws the entire field.
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
          clone.side = THREE.DoubleSide; // petals + leaves read from below
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

      // merge (position / normal — the jasmine is pure vertex colour, so
      // its unused UVs are dropped here)
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
      merged.setIndex(new THREE.BufferAttribute(idxArr, 1));
      if (allNormals) {
        merged.setAttribute('normal', new THREE.BufferAttribute(norArr, 3));
      } else {
        merged.computeVertexNormals(); // safety net for odd exports
      }
      rawTriangles = iTotal / 3;

      // ROOT ANCHOR — the zero-gap seat (identical to the fern bake): the
      // plant is re-grounded by its lowest vertices near the central axis
      // (where the stems converge), NOT by the bbox — so the stems rest
      // exactly on the block's TOP surface and can never hover. A no-op
      // for models whose true base IS their bbox minimum.
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

      // grow the jasmine for every chunk that streamed in while loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('jasmineDecor: jasmine model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (!pool) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x51a5e0d5);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const cells = Math.max(1, Math.floor(chunkBlocks / PATCH_CELL));

    // per-chunk live patch mask (own salt -> the white colonies
    // interleave organically with the fern + calendula patches)
    const open = lowSpec ? LOW_OPEN : PATCH_OPEN;
    const patchLive: boolean[] = new Array(cells * cells)
      .fill(false)
      .map((_, cell) => {
        const px = cell % cells;
        const pz = Math.floor(cell / cells);
        return (
          unit(hash2(cx * cells + px, cz * cells + pz, salt + PATCH_SALT)) <
          open
        );
      });

    const slots: number[] = [];

    for (let pz = 0; pz < cells; pz++) {
      for (let px = 0; px < cells; px++) {
        for (let lz = 0; lz < PATCH_CELL; lz++) {
          for (let lx = 0; lx < PATCH_CELL; lx++) {
            const gx = baseX + px * PATCH_CELL + lx;
            const gz = baseZ + pz * PATCH_CELL + lz;
            if (gx >= baseX + chunkBlocks || gz >= baseZ + chunkBlocks)
              continue; // ragged chunkBlocks sizes

            if (!isJasmineBlock(gx, gz)) continue;
            const chance = lowSpec ? LOW_CHANCE : PATCH_CHANCE;
            const loneC = lowSpec ? LOW_LONE : LONE_CHANCE;

            const h = blockHeight(gx, gz);
            const hpx = blockHeight(gx + 1, gz);
            const hnx = blockHeight(gx - 1, gz);
            const hpz = blockHeight(gx, gz + 1);
            const hnz = blockHeight(gx, gz - 1);

            const r = rng();
            const live = patchLive[pz * cells + px];
            const inPatch = live && r < chance;
            const lone = !live && r < loneC;
            if (!inPatch && !lone) continue;

            const slot = allocSlot();
            if (slot < 0) return; // pool exhausted — stop here quietly

            const flat =
              hpx === h && hnx === h && hpz === h && hnz === h;

            // position: seated ON the block's top surface — the root-
            // anchored bake puts the stem base exactly at this plane and
            // the small nestle presses it flush into the block (zero gap
            // between jasmine and terrain). Flat blocks may drift wide;
            // blocks beside ANY wall hug the centre — the plant radius
            // then stays clear of the riser face.
            const spread = flat ? 0.56 : 0.3;
            pos.set(
              (gx - gridOffset) * block + (rng() - 0.5) * block * spread,
              h * block + block / 2 - NESTLE * block,
              (gz - gridOffset) * block + (rng() - 0.5) * block * spread
            );
            // size: 3x the original bake (user request) — a proper plant
            // ~0.48-0.90 blocks tall, standing with the ferns. Sloped
            // blocks shrink a touch so the silhouette stays tidy.
            scl.setScalar(
              block * (0.48 + rng() * 0.42) * (flat ? 1 : 0.8)
            );
            euler.set(
              (rng() - 0.5) * 0.12,
              rng() * Math.PI * 2,
              (rng() - 0.5) * 0.12
            );
            quat.setFromEuler(euler);
            m4.compose(pos, quat, scl);
            pool.mesh.setMatrixAt(slot, m4);
            slots.push(slot);
          }
        }
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
      flowers: pool?.active ?? 0,
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

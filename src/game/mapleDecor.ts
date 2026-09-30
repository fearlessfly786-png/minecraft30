/**
 * MAPLE DECOR — the user-uploaded "Low Polly Japanese Maple Tree"
 * (Sketchfab export repacked at the JSON level into
 * public/models/japanese_maple/japanese_maple.glb — the source required
 * the legacy KHR_materials_pbrSpecularGlossiness extension which modern
 * three.js GLTFLoader refuses to parse; geometry/texture bytes untouched:
 * trunk ~480 tris + leaf canopy ~312 tris, two textured materials)
 * scattered across the GRASS biome ONLY, streaming with the terrain
 * chunks — the leafy sibling of the bamboo groves (src/game/bambooDecor.ts);
 * the fern, calendula and jasmine stay in their own patches.
 *
 * Same machinery as the other planted decor:
 *  - ONE InstancedMesh renders the whole maple forest (both materials
 *    baked into ONE merged geometry with two groups — 2 draw calls
 *    total, +2 in the shadow pass). Fixed slot pool with a free-list +
 *    high-water mark: chunks borrow slots on build and release them on
 *    unload (hidden with a zero-scale matrix), so walking recycles the
 *    same GPU buffers forever — zero allocation churn.
 *  - DENSE WOODLAND (user request: "tree to tree distance [should not
 *    be] too much — the trees are too far away from each other"): the
 *    maples root on a tight global lattice — one candidate every
 *    SPACING² blocks with a HIGH grow chance — so neighbouring crowns
 *    almost touch and the meadow reads as a real maple wood. The
 *    lattice is world-space, so the density holds across chunk borders.
 *  - ALPHA-MASKED: the canopy ships as alphaMode BLEND, which sorts
 *    terribly under instancing — the leaf atlas is re-flagged alphaTest
 *    0.5 (the bamboo/fern recipe): crisp cutouts, correct depth writes,
 *    zero sorting artifacts.
 *  - GRASS-ONLY: the block must pass the same biome gates as the
 *    bamboo's GRASS bucket with the exact terrainChunks.ts thresholds —
 *    never on snow, ice, sand, mesa, red dunes or volcano rock (per
 *    request: the maple belongs to the grassland region alone).
 *  - FLUSH SEAT: the tree is baked Y-up / XZ-centred / normalised to
 *    exactly ONE unit tall and then ROOT-ANCHORED — re-grounded by the
 *    lowest vertices near the central axis (the trunk base), NOT the
 *    bbox — so the trunk rests on the block's TOP surface with zero
 *    gap, and a small nestle presses the base INTO the block so the
 *    random tilt can never lift it free.
 *  - WIND: a tiny onBeforeCompile vertex bend sways the canopy — the
 *    trunk stays stiff (quadratic bend hinges at mid-height), the phase
 *    comes from the instance's world origin so no two trees move in
 *    sync. Both materials share the clock so trunk and leaves bend as
 *    one wood.
 *  - TINT: every tree gets a subtle per-instance drift (sunlit vs
 *    shaded foliage) via instanceColor — no two crowns read identical.
 *  - Raycast disabled (footprintSystem rule) so bullets/pickers never
 *    hit a tree; castShadow on; full dispose().
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { iceFactor, winterFactor } from './winterBiomes';
import { desertFactor } from './desertBiomes';
import { redFactor, mesaFactor, volcanoFactor } from './extraBiomes';
import { volcanoSampleAt } from './volcanoTerrain';

const MAPLE_MODEL_URL = '/models/japanese_maple/japanese_maple.glb';

// Biome thresholds — MUST mirror terrainChunks.ts / bambooDecor.ts: the
// maple roots ONLY where the chunk builder paints the GRASS bucket.
const SNOW_THRESH = 0.5;
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

// Spacing/density tuning — the user asked for maples that are RARE in the
// grassland with WIDE gaps between neighbouring trees, so the maple grows
// on a WIDE global lattice: one candidate every MAPLE_SPACING² blocks and
// only a small share of candidates grow. Min root gap ≈ SPACING - 2×JITTER
// ≈ 10 blocks; the expected distance to the nearest neighbouring trunk is
// ~27 blocks — scattered lone maples across the meadow. (For reference:
// the bamboo groves sit 6 blocks apart at 50% chance; the desert dead
// trees sat 9 apart at 34%.)
const MAPLE_SPACING = 12; // blocks between root lattice points
const JITTER = 1.0; // blocks of root drift on flat ground (±)
const STAND_CHANCE = 0.2; // share of lattice points that grow a tree (RARE)
const LOW_STAND = 0.1; // lowSpec: fewer trees
const PATCH_SALT = 921; // distinct from the ferns (77 / 177), calendula
// (411), jasmine (611), desert plant (711), bamboo (811) and the desert
// dead trees (911) — the maples interleave, never copy, the other
// plants' layouts.
const NESTLE = 0.05; // of a block — seats the base INTO the block top

export interface MapleDecorHandle {
  /** Terrain hook: a chunk mesh finished building. */
  onChunkBuilt(cx: number, cz: number): void;
  /** Terrain hook: a chunk was unloaded — its trees return to the pool. */
  onChunkUnloaded(cx: number, cz: number): void;
  /** Advance the wind clock (call once per frame with seconds). */
  update(dt: number): void;
  /** Debug probe: pool + placement counters. */
  stats(): {
    trees: number;
    capacity: number;
    chunks: number;
    pending: number;
    ready: boolean;
    triangles: number;
  };
  dispose(): void;
}

export function createMapleDecor(
  scene: THREE.Scene,
  opts: {
    block: number;
    gridOffset: number;
    /** Deterministic integer block height at grid coords (terrain handle). */
    blockHeight(gx: number, gz: number): number;
    /** Per-session terrain seed — salts the maple layout like the ferns. */
    seedZ: number;
    /** Must match the terrain's chunkBlocks (16). */
    chunkBlocks?: number;
    lowSpec?: boolean;
  }
): MapleDecorHandle {
  const block = opts.block;
  const gridOffset = opts.gridOffset;
  const blockHeight = opts.blockHeight;
  const chunkBlocks = opts.chunkBlocks ?? 16;
  const lowSpec = !!opts.lowSpec;
  const salt = Math.floor(opts.seedZ * 1000) | 0;

  // ---------------- deterministic rng (mirrors bambooDecor.ts) -----------
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
   *  maple belongs to the grassland region alone (user request). */
  function isMapleBlock(gx: number, gz: number): boolean {
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
  interface MaplePool {
    mesh: THREE.InstancedMesh;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live trees
  }
  // ~0.8k tris per tree — the pool keeps the worst-case triangle load in
  // the same league as the fern field (~700k tris at full).
  const POOL = lowSpec ? 320 : 900;

  const bakedGeos: THREE.BufferGeometry[] = [];
  const poolMats: THREE.Material[] = [];
  let pool: MaplePool | null = null;
  let rawTriangles = 0;
  let ready = false;
  let disposed = false;

  function makePool(
    materials: THREE.Material[],
    geometry: THREE.BufferGeometry,
    capacity: number
  ): MaplePool {
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
    if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
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
  const tint = new THREE.Color();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

  /** Subtle per-tree tint: the maple carries its own painted textures, so
   *  the drift stays gentle — sunlit vs shaded crowns, a faint warm/cool
   *  swing, never flat-identical, never cartoonish. */
  function rollTint(rng: () => number): void {
    const bright = 0.88 + rng() * 0.18; // 0.88-1.06
    const warm = (rng() - 0.5) * 0.06; // faint autumn swing
    tint.setRGB(
      bright * (1 + warm),
      bright * (1 + warm * 0.3),
      bright * (1 - warm * 0.7)
    );
  }

  // ---------------- model load + bake ----------------------------------
  const timeU = { value: Math.random() * 100 };

  /** Wind bend (bambooDecor pattern, tree variant): per-instance phase
   *  from the instance's world origin, QUADRATIC bend with height — a
   *  stiff trunk hinging at mid-height so the crown sways while the base
   *  stays planted. Amplitude is gentler than the bamboo's rustle. */
  function applyWindBend(m: THREE.Material): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uMapleTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uMapleTime;'
        )
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  float fPhase = dot(instanceMatrix[3].xz, vec2(0.0371, 0.0523));',
            '  float fBend = clamp(transformed.y, 0.0, 1.0);',
            '  fBend *= fBend;', // quadratic — trunk stiff, crown sways
            '  transformed.x += (sin(uMapleTime * 0.9 + fPhase) * 0.022 +',
            '    sin(uMapleTime * 2.3 + fPhase * 1.7) * 0.007) * fBend;',
            '  transformed.z += (cos(uMapleTime * 0.8 + fPhase * 1.3) * 0.020 +',
            '    cos(uMapleTime * 2.1 + fPhase) * 0.006) * fBend;',
            '#endif',
          ].join('\n')
        );
    };
  }

  new GLTFLoader().load(
    MAPLE_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();

      // PASS 1 — bake every primitive into root space (the Sketchfab root
      // carries the Z-up -> Y-up fix-up matrix), collect the unique
      // materials. UVs are PRESERVED (both the bark and the leaf canopy
      // are texture-mapped).
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
          if (clone.transparent) {
            // BLEND -> ALPHA-TEST MASK: instanced alpha blending sorts
            // per-instance and reads wrong from every angle — the leaf
            // cutouts re-flag alphaTest 0.5 (the bamboo recipe).
            clone.transparent = false;
            clone.alphaTest = 0.5;
          }
          clone.side = THREE.DoubleSide; // foliage reads from every side
          mi = poolMats.length;
          matIndexByUuid.set(std.uuid, mi);
          poolMats.push(clone);
        }
        parts.push({ geo, matIndex: mi });
      });
      if (parts.length === 0) return;

      // Measure the whole tree, then normalise it: Y-up, centred on XZ,
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

      // merge (position / normal / uv — both materials need their UVs)
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

      // ROOT ANCHOR — the zero-gap seat (identical to the other bakes):
      // the tree is re-grounded by its lowest vertices near the central
      // axis (where the trunk meets the ground), NOT by the bbox — so the
      // trunk base rests exactly on the block's TOP surface and can never
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

      // grow the maples for every chunk that streamed in while loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('mapleDecor: japanese maple model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (!pool) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x5c1ea7d9);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const standC = lowSpec ? LOW_STAND : STAND_CHANCE;

    const slots: number[] = [];

    // SPACED LATTICE walk (DENSE variant): candidates exist only where
    // the WORLD grid coords are a multiple of MAPLE_SPACING in both axes
    // (proper mod for negative coords) — but unlike the sparse groves,
    // MOST candidates grow, so neighbouring trees stand just a few blocks
    // apart (user request). The spacing survives chunk borders because
    // the lattice is world-space, not per-chunk.
    for (let lz = 0; lz < chunkBlocks; lz++) {
      for (let lx = 0; lx < chunkBlocks; lx++) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        const mx = ((gx % MAPLE_SPACING) + MAPLE_SPACING) % MAPLE_SPACING;
        const mz = ((gz % MAPLE_SPACING) + MAPLE_SPACING) % MAPLE_SPACING;
        if (mx !== 0 || mz !== 0) continue; // not a lattice point

        if (!isMapleBlock(gx, gz)) continue; // grass biome only
        if (rng() >= standC) continue; // this lattice point stays empty

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
        // anchored bake puts the trunk base exactly at this plane and
        // the small nestle presses it flush into the block (zero gap).
        // Flat lattice points may drift up to ±JITTER blocks; blocks
        // beside ANY wall hug the centre so the trunk stays clear of
        // the riser face.
        const j = flat ? JITTER : 0.15;
        pos.set(
          (gx - gridOffset) * block + (rng() - 0.5) * block * 2 * j,
          h * block + block / 2 - NESTLE * block,
          (gz - gridOffset) * block + (rng() - 0.5) * block * 2 * j
        );
        // size: a proper meadow maple — 2.6-4.4 blocks tall, its crown
        // spanning most of the gap to the next tree. Sloped blocks
        // shrink a touch so the silhouette stays tidy.
        scl.setScalar(
          block * (2.6 + rng() * 1.8) * (flat ? 1 : 0.8)
        );
        euler.set(
          (rng() - 0.5) * 0.06,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.06
        );
        quat.setFromEuler(euler);
        m4.compose(pos, quat, scl);
        pool.mesh.setMatrixAt(slot, m4);
        rollTint(rng);
        pool.mesh.setColorAt(slot, tint);
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
      trees: pool?.active ?? 0,
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

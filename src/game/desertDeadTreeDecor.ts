/**
 * DESERT DEAD TREE DECOR — the user-uploaded "dead_tree" (Sketchfab
 * export — public/models/desert_dead_tree/dead_tree.glb, 1 textured
 * mesh, ~1k triangles, opaque JPEG albedo) scattered across the DESERT
 * biome ONLY, streaming with the terrain chunks — the SECOND tree
 * species of the dune sea (the first uploaded dead tree was removed per
 * user request); the fern,
 * calendula, jasmine and bamboo stay in their own regions.
 *
 * PHASE-SHIFTED LATTICE: it shares the first desert tree's coarse
 * world-space lattice (SPACING 9) but shifted +4 blocks in BOTH axes —
 * the two species root BETWEEN each other and can never stack on the
 * same block, and the spacing holds across chunk borders.
 *
 * Same machinery as the other planted decor:
 *  - ONE InstancedMesh renders the whole field (single material baked
 *    into ONE merged geometry — 1 draw call, +1 in the shadow pass).
 *    Fixed slot pool with a free-list + high-water mark: chunks borrow
 *    slots on build and release them on unload (hidden with a
 *    zero-scale matrix) — zero allocation churn.
 *  - WEATHERED-TIMBER TINT: a subtle per-instance sun-bleached drift
 *    via instanceColor — no two trunks read flat-identical.
 *  - DESERT-ONLY: the block must pass the exact sandParts bucket of
 *    terrainChunks.ts — ice/lava/volcano/mesa/red are rejected first,
 *    then desertFactor must exceed DESERT_THRESH (per request: this
 *    tree belongs to the desert zone alone).
 *  - FLUSH SEAT: baked Y-up / XZ-centred / ONE unit tall, then
 *    ROOT-ANCHORED by the lowest near-axis vertices (the trunk base),
 *    NOT the bbox — zero gap to the block top, small nestle INTO the
 *    sand so the random tilt can never lift it free.
 *  - RIGID: no wind bend — dead trees stand stiff.
 *  - Raycast disabled (footprintSystem rule) so bullets/pickers never
 *    hit a tree; castShadow on; full dispose().
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { iceFactor } from './winterBiomes';
import { desertFactor } from './desertBiomes';
import { redFactor, mesaFactor, volcanoFactor } from './extraBiomes';
import { volcanoSampleAt } from './volcanoTerrain';

const DESERT_DEAD_TREE_MODEL_URL = '/models/desert_dead_tree/dead_tree.glb';

// Biome thresholds — MUST mirror terrainChunks.ts: the tree roots ONLY
// where the chunk builder paints the SAND bucket (the desert biome).
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

// Spacing/density tuning — lone dead trees on the dunes: a coarse global
// lattice with a modest grow chance keeps them well apart (min trunk gap
// ≈ SPACING - 2×JITTER ≈ 5.6 blocks).
const TREE_SPACING = 9; // blocks between root lattice points
const JITTER = 1.7; // blocks of root drift on flat sand (±)
const STAND_CHANCE = 0.3; // share of lattice points that grow a tree
const LOW_STAND = 0.24; // lowSpec: fewer trees
const PATCH_SALT = 921; // distinct from the ferns (77 / 177), calendula
// (411), jasmine (611), desert plant (711) and bamboo (811) — the dead
// trees interleave, never copy, the other plants' layouts.
const NESTLE = 0.05; // of a block — seats the base INTO the block top

export interface DesertDeadTreeDecorHandle {
  /** Terrain hook: a chunk mesh finished building. */
  onChunkBuilt(cx: number, cz: number): void;
  /** Terrain hook: a chunk was unloaded — its trees return to the pool. */
  onChunkUnloaded(cx: number, cz: number): void;
  /** Rigid trees — no wind clock; kept for the common decor interface. */
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

export function createDesertDeadTreeDecor(
  scene: THREE.Scene,
  opts: {
    block: number;
    gridOffset: number;
    /** Deterministic integer block height at grid coords (terrain handle). */
    blockHeight(gx: number, gz: number): number;
    /** Per-session terrain seed — salts the tree layout like the ferns. */
    seedZ: number;
    /** Must match the terrain's chunkBlocks (16). */
    chunkBlocks?: number;
    lowSpec?: boolean;
  }
): DesertDeadTreeDecorHandle {
  const block = opts.block;
  const gridOffset = opts.gridOffset;
  const blockHeight = opts.blockHeight;
  const chunkBlocks = opts.chunkBlocks ?? 16;
  const lowSpec = !!opts.lowSpec;
  const salt = Math.floor(opts.seedZ * 1000) | 0;

  // ---------------- deterministic rng (mirrors bambooDecor.ts) ----------
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

  // ---------------- biome check (SAND bucket only) ----------------------
  /** False everywhere the chunk builder would NOT paint sand — the dead
   *  tree belongs to the desert region alone (user request). The checks
   *  mirror the terrainChunks.ts bucket exactly: ice / caldera lava /
   *  volcano / mesa / red dunes are rejected first (they outrank
   *  desert), then the golden dune sea itself must pass DESERT_THRESH. */
  function isDesertDeadTreeBlock(gx: number, gz: number): boolean {
    if (iceFactor(gx, gz) > ICE_THRESH) return false;
    if (volcanoSampleAt(gx, gz).lava > LAVA_LEVEL) return false;
    if (volcanoFactor(gx, gz) > VOLCANO_THRESH) return false;
    if (mesaFactor(gx, gz) > MESA_THRESH) return false;
    if (redFactor(gx, gz) > RED_THRESH) return false;
    return desertFactor(gx, gz) > DESERT_THRESH;
  }

  // ---------------- instance pool --------------------------------------
  interface TreePool {
    mesh: THREE.InstancedMesh;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live trees
  }
  // ~1.9k tris per tree — a comfortable pool keeps the worst-case
  // triangle load in the same league as the rest of the field.
  const POOL = lowSpec ? 60 : 160;

  const bakedGeos: THREE.BufferGeometry[] = [];
  const poolMats: THREE.Material[] = [];
  let pool: TreePool | null = null;
  let rawTriangles = 0;
  let ready = false;
  let disposed = false;

  function makePool(
    materials: THREE.Material[],
    geometry: THREE.BufferGeometry,
    capacity: number
  ): TreePool {
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

  /** Weathered-timber tint (per-instance): the tree now carries its own
   *  diffuse albedo, so the tint stays SUBTLE — a soft sun-bleached
   *  drift between trunks, never flat-identical, never cartoonish. */
  function rollTint(rng: () => number): void {
    const bright = 0.85 + rng() * 0.23; // 0.85-1.08
    const warm = rng() * 0.05; // faint brown drift
    tint.setRGB(
      bright * (1 + warm),
      bright * (1 + warm * 0.4),
      bright * (1 - warm * 0.5)
    );
  }

  // ---------------- model load + bake ----------------------------------
  new GLTFLoader().load(
    DESERT_DEAD_TREE_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();

      // bake every primitive into root space, collect the unique
      // materials (the tree is a single untextured pbr primitive —
      // the loop stays general for odd exports).
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
          clone.side = THREE.DoubleSide; // gnarled branches read both ways
          mi = poolMats.length;
          matIndexByUuid.set(std.uuid, mi);
          poolMats.push(clone);
        }
        parts.push({ geo, matIndex: mi });
      });
      if (parts.length === 0) return;

      // Measure the whole tree, then normalise it: Y-up, centred on
      // XZ, grounded at y=0, exactly ONE unit tall. (UVs kept — the
      // primitive carries a texcoord set even though the material is
      // untextured today.)
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

      // merge (position / normal / uv)
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
          for (let i = 0; i < ia.length; i++)
            idxArr[iOff + i] = ia[i] + vOff;
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

      // ROOT ANCHOR — the zero-gap seat: re-ground by the lowest
      // vertices near the central axis (the trunk base), NOT the bbox
      // — so the trunk rests exactly on the block's TOP surface and
      // can never hover. A no-op for models whose true base IS their
      // bbox minimum.
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

      pool = makePool(poolMats, merged, POOL);
      ready = true;

      // grow the trees for every chunk that streamed in while loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('desertDeadTreeDecor: dead tree model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (!pool) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x5e91b2d3);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const standC = lowSpec ? LOW_STAND : STAND_CHANCE;

    const slots: number[] = [];

    // SPACED LATTICE walk: candidates exist only where the WORLD grid
    // coords are a multiple of TREE_SPACING in both axes (proper mod for
    // negative coords) — lone trees, never groves, and the spacing
    // survives chunk borders.
    for (let lz = 0; lz < chunkBlocks; lz++) {
      for (let lx = 0; lx < chunkBlocks; lx++) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        // +4 phase shift: this species roots BETWEEN the first desert
        // tree's lattice points — never on the same block as one.
        const mx = ((gx - 4) % TREE_SPACING + TREE_SPACING) % TREE_SPACING;
        const mz = ((gz - 4) % TREE_SPACING + TREE_SPACING) % TREE_SPACING;
        if (mx !== 0 || mz !== 0) continue; // not a lattice point

        if (!isDesertDeadTreeBlock(gx, gz)) continue; // desert biome only
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

        // position: seated ON the block's top surface — the root-anchored
        // bake puts the trunk base exactly at this plane and the small
        // nestle presses it flush into the sand (zero gap). Flat lattice
        // points may drift up to ±JITTER blocks; blocks beside ANY wall
        // hug the centre so the trunk stays clear of the riser face.
        const j = flat ? JITTER : 0.15;
        pos.set(
          (gx - gridOffset) * block + (rng() - 0.5) * block * 2 * j,
          h * block + block / 2 - NESTLE * block,
          (gz - gridOffset) * block + (rng() - 0.5) * block * 2 * j
        );
        // size: a slightly smaller second species — ~2.0-4.8 blocks
        // tall, so the two dead-tree kinds read apart at a glance.
        // Sloped blocks shrink a touch so the silhouette stays tidy.
        scl.setScalar(
          block * (2.0 + rng() * 2.8) * (flat ? 1 : 0.8)
        );
        euler.set(
          (rng() - 0.5) * 0.08,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.08
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

  function update(_dt: number): void {
    // rigid dead trees — no wind clock (kept for the decor interface)
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

/**
 * DEAD TREE DECOR — the user-uploaded "Dead Trees" (Sketchfab export —
 * public/models/dead_trees/dead_trees.glb) contains FOUR separate dead
 * tree meshes (polySurface736_lambert39/40/41/42 — gnarled leafless
 * trunks, 2.7k-8.5k triangles each, untextured flat-grey materials).
 * Per the user request the four trees are SEPARATED in the bake and each
 * becomes its own InstancedMesh variant, scattered across the DESERT
 * biome ONLY, streaming with the terrain chunks — the bleak sibling of
 * the desert-plant field (src/game/desertPlantDecor.ts); the fern,
 * calendula, jasmine and bamboo stay in their own regions.
 *
 * Same machinery as the other planted decor:
 *  - FOUR InstancedMeshes (one per separated tree) render the whole dead
 *    forest — 4 draw calls, +4 in the shadow pass. Fixed slot pools with
 *    a free-list + high-water mark: chunks borrow slots on build and
 *    release them on unload (hidden with a zero-scale matrix), so
 *    walking recycles the same GPU buffers forever — zero churn.
 *  - BLEACHED WOOD TINT: the source ships as flat 0.5-grey untextured
 *    lambert, so every instance gets a subtle per-tree tint (soft
 *    sun-bleached browns/greys via instanceColor) — no two trunks read
 *    exactly alike under the desert sun.
 *  - DESERT-ONLY: the block must pass the exact sandParts bucket of
 *    terrainChunks.ts — ice/lava/volcano/mesa/red are rejected first,
 *    then desertFactor must exceed DESERT_THRESH — so the trees root
 *    ONLY in the golden dune sea, never on grass, snow, glacier, red
 *    dunes, mesa or volcano rock (per request: dead trees belong to the
 *    desert zone alone).
 *  - SPACED LATTICE: the trunks root on a coarse global lattice (one
 *    candidate every SPACING² blocks) with a salted hash — dead trees
 *    keep clear ground between each other, and the spacing holds across
 *    chunk borders because the lattice is world-space, not per-chunk.
 *  - FLUSH SEAT: each tree is baked Y-up / XZ-centred / normalised to
 *    exactly ONE unit tall and then ROOT-ANCHORED — re-grounded by the
 *    lowest vertices near the central axis (the trunk base), NOT the
 *    bbox — so the trunk rests on the block's TOP surface with zero gap,
 *    and a small nestle presses the base INTO the sand so the random
 *    tilt can never lift it free.
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

const DEAD_TREES_MODEL_URL = '/models/dead_trees/dead_trees.glb';

// Biome thresholds — MUST mirror terrainChunks.ts: the trees root ONLY
// where the chunk builder paints the SAND bucket (the desert biome).
const ICE_THRESH = 0.5;
const DESERT_THRESH = 0.5;
const RED_THRESH = 0.5;
const MESA_THRESH = 0.5;
const VOLCANO_THRESH = 0.5;
const LAVA_LEVEL = 0.55;

// Spacing/density tuning — dead trees are lone wrecks on the dunes: a
// coarse global lattice with a modest grow chance keeps them well apart
// (min trunk gap ≈ SPACING - 2×JITTER ≈ 5.6 blocks).
const TREE_SPACING = 9; // blocks between root lattice points
const JITTER = 1.7; // blocks of root drift on flat sand (±)
const STAND_CHANCE = 0.34; // share of lattice points that grow a tree
const LOW_STAND = 0.24; // lowSpec: fewer trees
const PATCH_SALT = 911; // distinct from the ferns (77 / 177), calendula
// (411), jasmine (611), desert plant (711) and bamboo (811) — the dead
// forest interleaves, never copies, the other plants' layouts.
const NESTLE = 0.05; // of a block — seats the base INTO the block top

export interface DeadTreeDecorHandle {
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

export function createDeadTreeDecor(
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
): DeadTreeDecorHandle {
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
   *  trees belong to the desert region alone (user request). The checks
   *  mirror the terrainChunks.ts bucket exactly: ice / caldera lava /
   *  volcano / mesa / red dunes are rejected first (they outrank
   *  desert), then the golden dune sea itself must pass DESERT_THRESH. */
  function isDeadTreeBlock(gx: number, gz: number): boolean {
    if (iceFactor(gx, gz) > ICE_THRESH) return false;
    if (volcanoSampleAt(gx, gz).lava > LAVA_LEVEL) return false;
    if (volcanoFactor(gx, gz) > VOLCANO_THRESH) return false;
    if (mesaFactor(gx, gz) > MESA_THRESH) return false;
    if (redFactor(gx, gz) > RED_THRESH) return false;
    return desertFactor(gx, gz) > DESERT_THRESH;
  }

  // ---------------- instance pools (one per separated tree) -------------
  interface TreePool {
    mesh: THREE.InstancedMesh;
    capacity: number;
    freeSlots: number[];
    slotFree: Uint8Array;
    highWater: number; // instances [0..highWater) are drawn
    active: number; // live trees
  }
  // ~2.7k-8.5k tris per tree — four modest pools keep the worst-case
  // triangle load in the same league as the rest of the field.
  const POOL_PER_VARIANT = lowSpec ? 30 : 90;

  const bakedGeos: THREE.BufferGeometry[] = [];
  const poolMats: THREE.Material[] = [];
  const pools: TreePool[] = [];
  const variantTriangles: number[] = [];
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
  function allocSlot(p: TreePool): number {
    const s = p.freeSlots.pop();
    if (s === undefined) return -1;
    p.slotFree[s] = 0;
    if (s + 1 > p.highWater) p.highWater = s + 1;
    return s;
  }
  function releaseSlot(p: TreePool, s: number): void {
    p.slotFree[s] = 1;
    p.freeSlots.push(s);
    while (p.highWater > 0 && p.slotFree[p.highWater - 1]) p.highWater--;
  }
  function syncPool(p: TreePool): void {
    p.mesh.count = p.highWater;
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  // chunk bookkeeping — slots are tagged with the variant pool that owns
  // them (a chunk can mix all four separated trees)
  const loadedChunks = new Set<string>();
  const decorated = new Map<string, Array<{ v: number; slot: number }>>();
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

  /** Bleached-wood tint (per-instance): soft sun-bleached greys and
   *  dry browns so the flat-grey source reads like weathered timber
   *  under the desert sun — no two trunks identical. */
  function rollTint(rng: () => number): void {
    const bright = 0.82 + rng() * 0.3; // 0.82-1.12
    const warm = rng() * 0.08; // brown shift
    tint.setRGB(
      bright * (1 + warm),
      bright * (1 + warm * 0.4),
      bright * (1 - warm * 0.5)
    );
  }

  // ---------------- model load + bake ----------------------------------
  new GLTFLoader().load(
    DEAD_TREES_MODEL_URL,
    (gltf) => {
      if (disposed) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const rootInv = root.matrixWorld.clone().invert();

      // SEPARATE THE FOUR TREES — every mesh node becomes its own baked
      // geometry + variant pool (the user asked for the four dead-tree
      // meshes to be separated and placed individually).
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

        // measure THIS tree, then normalise it: Y-up, centred on XZ,
        // grounded at y=0, exactly ONE unit tall.
        geo.computeBoundingBox();
        const box = geo.boundingBox ?? new THREE.Box3();
        const size = new THREE.Vector3();
        box.getSize(size);
        const norm = 1 / Math.max(1e-6, size.y);
        geo.applyMatrix4(
          new THREE.Matrix4()
            .makeScale(norm, norm, norm)
            .multiply(
              new THREE.Matrix4().makeTranslation(
                -(box.min.x + box.max.x) / 2,
                -box.min.y,
                -(box.min.z + box.max.z) / 2
              )
            )
        );

        // ROOT ANCHOR — the zero-gap seat: re-ground by the lowest
        // vertices near the central axis (the trunk base), NOT the bbox.
        const posA = geo.attributes.position;
        let rootY = Infinity;
        for (let i = 0; i < posA.count; i++) {
          const x = posA.getX(i);
          const z = posA.getZ(i);
          if (x * x + z * z < 0.04 && posA.getY(i) < rootY)
            rootY = posA.getY(i);
        }
        if (Number.isFinite(rootY) && rootY > 0) {
          geo.translate(0, -Math.min(rootY, 0.35), 0);
        }

        // material: lighten the flat 0.5-grey source to bleached timber;
        // the per-instance tint rolls on top of this base.
        const clone = std.clone();
        clone.color = new THREE.Color(0.86, 0.8, 0.72);
        clone.side = THREE.DoubleSide;

        const v = pools.length;
        bakedGeos.push(geo);
        poolMats.push(clone);
        variantTriangles.push(
          (geo.index ? geo.index.count : geo.attributes.position.count) / 3
        );
        pools.push(makePool([clone], geo, POOL_PER_VARIANT));
      });
      if (pools.length === 0) return;

      ready = true;

      // grow the dead forest for every chunk that streamed in while
      // loading
      for (const { cx, cz } of pendingList) {
        if (loadedChunks.has(chunkKey(cx, cz))) placeChunk(cx, cz);
      }
      pendingList.length = 0;
      pendingChunks.clear();
    },
    undefined,
    (err) => {
      console.warn('deadTreeDecor: dead trees model failed to load', err);
    }
  );

  // ---------------- per-chunk deterministic scatter ---------------------
  function placeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (decorated.has(key)) return;
    if (pools.length === 0) return;

    const rng = mulberry32(hash2(cx, cz, salt) ^ 0x7d3a91c7);
    const baseX = cx * chunkBlocks;
    const baseZ = cz * chunkBlocks;
    const standC = lowSpec ? LOW_STAND : STAND_CHANCE;

    const placed: Array<{ v: number; slot: number }> = [];

    // SPACED LATTICE walk: candidates exist only where the WORLD grid
    // coords are a multiple of TREE_SPACING in both axes (proper mod for
    // negative coords) — lone trees, never groves, and the spacing
    // survives chunk borders.
    for (let lz = 0; lz < chunkBlocks; lz++) {
      for (let lx = 0; lx < chunkBlocks; lx++) {
        const gx = baseX + lx;
        const gz = baseZ + lz;
        const mx = ((gx % TREE_SPACING) + TREE_SPACING) % TREE_SPACING;
        const mz = ((gz % TREE_SPACING) + TREE_SPACING) % TREE_SPACING;
        if (mx !== 0 || mz !== 0) continue; // not a lattice point

        if (!isDeadTreeBlock(gx, gz)) continue; // desert biome only
        if (rng() >= standC) continue; // this lattice point stays empty

        // pick which of the four separated trees stands here
        const v = Math.min(pools.length - 1, Math.floor(rng() * pools.length));
        const p = pools[v];
        const slot = allocSlot(p);
        if (slot < 0) continue; // this variant's pool is full — try luck elsewhere

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
        // size: proper dead trees — ~2.5-5.5 blocks tall, towering over
        // the desert shrubs. Sloped blocks shrink a touch so the
        // silhouette stays tidy.
        scl.setScalar(
          block * (2.5 + rng() * 3.0) * (flat ? 1 : 0.8)
        );
        euler.set(
          (rng() - 0.5) * 0.08,
          rng() * Math.PI * 2,
          (rng() - 0.5) * 0.08
        );
        quat.setFromEuler(euler);
        m4.compose(pos, quat, scl);
        p.mesh.setMatrixAt(slot, m4);
        rollTint(rng);
        p.mesh.setColorAt(slot, tint);
        placed.push({ v, slot });
      }
    }

    decorated.set(key, placed);
    if (placed.length > 0) {
      for (const { v, slot } of placed) pools[v].active++;
      for (const p of pools) syncPool(p);
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
    const placed = decorated.get(key);
    if (!placed) return;
    decorated.delete(key);
    if (placed.length > 0) {
      for (const { v, slot } of placed) {
        releaseSlot(pools[v], slot);
        pools[v].active--;
      }
      for (const p of pools) syncPool(p);
    }
  }

  function update(_dt: number): void {
    // rigid dead trees — no wind clock (kept for the decor interface)
  }

  function stats() {
    let trees = 0;
    let capacity = 0;
    let triangles = 0;
    for (let v = 0; v < pools.length; v++) {
      trees += pools[v].active;
      capacity += pools[v].capacity;
      triangles += pools[v].active * variantTriangles[v];
    }
    return {
      trees,
      capacity,
      chunks: decorated.size,
      pending: pendingList.length,
      ready,
      triangles: Math.round(triangles),
    };
  }

  function dispose(): void {
    disposed = true;
    for (const p of pools) {
      scene.remove(p.mesh);
      p.mesh.dispose();
    }
    pools.length = 0;
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

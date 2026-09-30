import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { getGlobalMuted, onMuteChange } from '@/game/muteState';

/* ============================================================================
 * petHelicopter.ts — "HAWK" the RATFIRE pet military attack helicopter:
 * an ULTRAREALISTIC mini gunship with fully procedural textures and a
 * completely working flight + combat brain.
 *
 * ULTRAREALISTIC TEXTURES (all painted on canvas — no asset files):
 *  - 3-tone military camouflage (olive drab / dark green / earth brown)
 *    painted as feathered irregular blotches over a tan base, weathered
 *    with panel seams, rivet rows, scuffs, chipped paint and oil streaks
 *  - dedicated fuselage skin: same camo + "RF-HEL 02" stencils, RATFIRE
 *    pet-unit marking, NO STEP access hatch, yellow rescue band and an
 *    ordnance warning triangle
 *  - olive ordnance skin for the rocket pods: yellow ordnance bands,
 *    panel seams, rivets and a stencil code (visible hardware)
 *  - brushed dark metal with heat tints for the rotor hub, exhausts, gun
 *  - yellow/black hazard stripes on the fin tip
 *
 * MODEL (hand-built from primitives, merged per material like petDrone):
 *  - teardrop gunship fuselage + tandem canopy (tinted glass), chin
 *    fairing, engine deck with side intakes and heat-stained exhaust
 *    nozzles, tapered tail boom, swept fin + horizontal stabilizer
 *  - MAIN ROTOR: mast, machined hub, 4 twisted blades that CONE UPWARD
 *    as RPM builds (real centripetal coning) + translucent blur disc
 *  - TAIL ROTOR on its own gearbox: hub + 2 crossed blades + blur disc,
 *    spinning ~5x the main rotor on the fin
 *  - stub wings carrying two rocket pods (4 visible rockets that empty
 *    and reload), chin MINIGUN turret with a barrel that SPINS while
 *    firing (recoil, additive muzzle flash + point light)
 *  - FLIR sensor ball + lens on the nose, landing skids, blade antennas
 *  - aviation lights: green right / red left wingtip nav LEDs, white
 *    double-flash tail strobe, 1 Hz belly beacon, night spotlight under
 *    the nose that fades in with the night factor (day/night aware)
 *
 * BRAIN (`update`) — flies like a REAL helicopter:
 *  - ROTOR SPOOL-UP on spawn: RPM climbs from 0 over ~4 s (blades visibly
 *    accelerate, coning + blur + audio all follow the spool)
 *  - damped-spring formation flight (its own slot sits wider and LOWER
 *    than BUZZ's so both pets share the sky), eased terrain glide,
 *    velocity-aligned heading that holds when hovering like a real ship
 *  - HELICOPTER ATTITUDE: nose pitches down hard with speed (up to ~20°),
 *    the ship banks into every turn, hover bob + idle sway, ground
 *    clearance via terrain height, world-anchored hover slot, parked
 *    combat pivot onto the designated target
 *
 * COMBAT (`fireGun` / `launchRocket`):
 *  - chin minigun on its OWN aiming turret (yaws/pitches onto the ordered
 *    point independent of the body heading, barrel spins while firing,
 *    recoils, additive muzzle flash + point light, ~9 rounds/s, spread)
 *  - two wing pods with 2 rockets each; every launch hides its rocket
 *    (the tube visibly empties) and reloads after 8 s; rockets fly
 *    through the game's pooled bullet system via the `ordnance`
 *    callbacks — homing supported through `fireHomingRocket`
 *
 * SOUND: synthesized turbine whine (two detuned saws + band-passed noise)
 * PLUS the classic blade-slap "wop-wop" (LFO-gated band-passed noise)
 * whose chop rate follows rotor RPM. Gain follows the spool and speed.
 * ALL VOLUMES ARE KEPT LOW (below even BUZZ's already-halved levels)
 * per the user's standing low-volume preference; everything is covered
 * by the global mute (muteState).
 *
 * Scale: 100 world units = 1 m -> fuselage ~72 u long, rotor span ~94 u.
 * The helicopter flies with +Z as its nose. `dispose()` frees everything.
 * ==========================================================================*/

/** Live target a homing rocket chases. Structurally identical to
 *  bulletSystem's RocketTracker / petDrone's PetRocketTracker. */
export interface PetHeliRocketTracker {
  getPos(): THREE.Vector3 | null;
  getVel?(): THREE.Vector3 | null;
}

/** Ammo plumbing: HAWK computes each shot, the game's pooled bullet
 *  system flies it — the same tracers, rockets, explosions and audio
 *  the player's weapons use. The page assigns the real impls once
 *  `bullets` exists. (Structurally identical to PetDroneOrdnance, so
 *  the page can share one wired object between both pets.) */
export interface PetHeliOrdnance {
  fireBullet(origin: THREE.Vector3, dir: THREE.Vector3): void;
  fireRocket(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Homing variant — wired by the page when the pooled system supports
   *  it; `launchRocket(aim, { tracker })` upgrades itself automatically. */
  fireHomingRocket?(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    tracker: PetHeliRocketTracker
  ): void;
}

export interface PetHeliOptions {
  /** Low-end devices: fewer segments, no blur discs, no spotlight, no
   *  synthesized audio (BUZZ does the same for lowSpec builds). */
  lowSpec?: boolean;
  /** Terrain height callback for ground clearance (world units). */
  heightAt?: (x: number, z: number) => number;
  /** Weapon plumbing into the game's bullet/rocket system. */
  ordnance?: PetHeliOrdnance;
}

export interface PetHeliUpdateContext {
  /** 0 = full day, 1 = deep night — drives the spotlight/glow. */
  night?: number;
  /** Designated world target. While the heli is PARKED (below flight
   *  speed) it yaws in place to face this point — a real gunship slews
   *  around its axis without translating, so the hover slot stays put. */
  combatTarget?: THREE.Vector3;
  /** AUTONOMOUS/PREVIEW flight: world hover point the caller wants held
   *  (the lobby preview and any future AI brain). Flown through the exact
   *  same spring, heading, banking, bob and terrain glide. */
  flightOverride?: THREE.Vector3;
}

export interface PetHelicopter {
  /** Root group — already added to the scene you passed in. */
  group: THREE.Group;
  /** Drive the companion brain once per frame. */
  update(
    dt: number,
    targetPos: THREE.Vector3,
    targetYaw: number,
    ctx?: PetHeliUpdateContext
  ): void;
  /** Fire one chin-minigun round at a world point (rate-limited inside).
   *  Hold-order friendly: call every frame while the trigger is held. */
  fireGun(aim: THREE.Vector3): boolean;
  /** Launch one rocket from a wing pod at a world point (cooldown +
   *  per-tube reload). Returns false while reloading/empty. Pass a
   *  `tracker` and the rocket becomes a HOMING missile (true PN). */
  launchRocket(
    aim: THREE.Vector3,
    launchOpts?: { tracker?: PetHeliRocketTracker }
  ): boolean;
  /** How many rockets are currently loaded across both pods. */
  rocketsLoaded(): number;
  /** Instantly reload every rocket tube (the pods visibly re-arm). */
  resupply(): void;
  /** Smoothed own-flight velocity (world units/s). */
  velocity(): THREE.Vector3;
  /** Free geometries, materials, textures and the audio nodes. */
  dispose(): void;
  /** Build stats for debug surfaces. */
  stats: { meshes: number; triangles: number };
}

/* ---------------- small texture factory helpers ---------------- */

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('petHelicopter: 2D canvas unavailable');
  return [canvas, ctx];
}

function finishTexture(
  canvas: HTMLCanvasElement,
  repeat: number
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

/** Deterministic PRNG so every client paints the exact same ship. */
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * ULTRAREALISTIC 3-tone military camouflage (repeats 2x): irregular
 * feathered blotches of olive drab, dark green and earth brown over a
 * tan base — each blotch is a wandering chain of soft overlapping
 * circles (real camo never has hard stencil edges) — then weathered
 * with panel seams, rivet rows, micro grain, chipped paint, scuff
 * scratches and thin translucent oil streaks running down-panel.
 */
function camoTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512);
  const rand = makeRand(20240921);
  // tan base coat
  ctx.fillStyle = '#8a7c58';
  ctx.fillRect(0, 0, 512, 512);

  // 3-tone feathered blotch chains
  const tones = ['#55603a', '#3d4728', '#6b5233'];
  for (let b = 0; b < 84; b++) {
    const tone = tones[b % tones.length];
    let x = rand() * 512;
    let y = rand() * 512;
    let dir = rand() * Math.PI * 2;
    const lobes = 8 + Math.floor(rand() * 7);
    for (let l = 0; l < lobes; l++) {
      dir += (rand() - 0.5) * 1.1;
      x += Math.cos(dir) * (12 + rand() * 20);
      y += Math.sin(dir) * (12 + rand() * 20);
      ctx.globalAlpha = 0.2 + rand() * 0.16;
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.arc(x, y, 15 + rand() * 28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // panel seams: slightly darker joints running both ways
  ctx.strokeStyle = 'rgba(30,34,20,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const oy = Math.round(60 + i * 78 + (rand() - 0.5) * 26);
    ctx.beginPath();
    ctx.moveTo(0, oy);
    ctx.lineTo(512, oy);
    ctx.stroke();
    const ox = Math.round(50 + i * 84 + (rand() - 0.5) * 30);
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, 512);
    ctx.stroke();
  }
  // rivet rows along two seams
  ctx.fillStyle = 'rgba(20,24,12,0.5)';
  for (const ry of [138, 372]) {
    for (let rx = 8; rx < 512; rx += 22) {
      ctx.beginPath();
      ctx.arc(rx, ry, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // oil streaks: thin dark translucent runs trailing down-panel
  for (let i = 0; i < 10; i++) {
    const sx = rand() * 512;
    const sy = rand() * 512;
    const len = 40 + rand() * 90;
    const grad = ctx.createLinearGradient(sx, sy, sx, sy + len);
    grad.addColorStop(0, 'rgba(22,18,8,0.32)');
    grad.addColorStop(1, 'rgba(22,18,8,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.4 + rand() * 2.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (rand() - 0.5) * 12, sy + len);
    ctx.stroke();
  }
  // chipped paint + scuffs (bright metal showing through)
  for (let i = 0; i < 170; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(255,255,235,0.08)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(rand() * 512, rand() * 512, 1 + rand() * 4, 1 + rand() * 2);
  }
  // micro grain
  for (let i = 0; i < 1500; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.04)';
    ctx.fillRect(rand() * 512, rand() * 512, 1, 1);
  }
  return finishTexture(canvas, 2);
}

/**
 * Dedicated fuselage skin (1:1): same camo family but with big painted
 * markings — "RF-HEL 02" stencil, RATFIRE pet-unit tag, NO STEP access
 * hatch with hinge dots, yellow rescue band and an ordnance warning
 * triangle. (Primitive boxes wrap the same texture on every face — the
 * same accepted approach BUZZ's panel skin uses.)
 */
function fuselageTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512);
  const rand = makeRand(910517);
  ctx.fillStyle = '#7d7150';
  ctx.fillRect(0, 0, 512, 512);

  // the same 3-tone feathered camo (denser, larger lobes)
  const tones = ['#57613b', '#3f492a', '#6e5534'];
  for (let b = 0; b < 70; b++) {
    const tone = tones[b % tones.length];
    let x = rand() * 512;
    let y = rand() * 512;
    let dir = rand() * Math.PI * 2;
    const lobes = 9 + Math.floor(rand() * 8);
    for (let l = 0; l < lobes; l++) {
      dir += (rand() - 0.5) * 1.2;
      x += Math.cos(dir) * (14 + rand() * 22);
      y += Math.sin(dir) * (14 + rand() * 22);
      ctx.globalAlpha = 0.2 + rand() * 0.14;
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.arc(x, y, 18 + rand() * 30, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // access hatch outline + hinge dots + NO STEP stencil
  ctx.strokeStyle = 'rgba(28,32,18,0.55)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(60, 96, 118, 74);
  ctx.fillStyle = 'rgba(28,32,18,0.55)';
  for (const hx of [60, 178]) {
    ctx.beginPath();
    ctx.arc(hx, 133, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(24,28,14,0.8)';
  ctx.fillText('NO STEP', 119, 133);

  // yellow rescue band + arrow
  ctx.fillStyle = '#e8b428';
  ctx.fillRect(330, 402, 158, 16);
  ctx.beginPath();
  ctx.moveTo(340, 430);
  ctx.lineTo(372, 414);
  ctx.lineTo(372, 446);
  ctx.closePath();
  ctx.fill();

  // RF-HEL 02 stencil + RATFIRE pet-unit tag
  ctx.fillStyle = 'rgba(20,24,12,0.88)';
  ctx.font = '900 44px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('RF-HEL 02', 256, 268);
  ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(230,220,190,0.75)';
  ctx.fillText('RATFIRE PET UNIT', 256, 296);

  // ordnance warning triangle
  ctx.fillStyle = '#e2af1c';
  ctx.beginPath();
  ctx.moveTo(430, 120);
  ctx.lineTo(458, 168);
  ctx.lineTo(402, 168);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#241f10';
  ctx.font = '900 30px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText('!', 430, 158);

  // weathering: oil runs + chipped edges + grain
  for (let i = 0; i < 9; i++) {
    const sx = rand() * 512;
    const sy = rand() * 512;
    const len = 50 + rand() * 90;
    const grad = ctx.createLinearGradient(sx, sy, sx, sy + len);
    grad.addColorStop(0, 'rgba(22,18,8,0.28)');
    grad.addColorStop(1, 'rgba(22,18,8,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (rand() - 0.5) * 10, sy + len);
    ctx.stroke();
  }
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(255,255,230,0.07)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(rand() * 512, rand() * 512, 1 + rand() * 4, 1 + rand() * 2);
  }
  return finishTexture(canvas, 1);
}

/**
 * Machined dark metal (brushed circular grain + bluish heat stains) for
 * the rotor hub, mast, exhaust nozzles and gun hardware.
 */
function metalTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  ctx.fillStyle = '#3a3f45';
  ctx.fillRect(0, 0, 256, 256);
  // brushed rings
  ctx.globalAlpha = 0.14;
  for (let r = 6; r < 190; r += 5) {
    ctx.strokeStyle = (r / 5) % 2 > 1 ? '#4b525a' : '#2c3138';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(128, 128, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // bluish heat stains (exhaust metal tint)
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 8 + Math.random() * 26;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(120,110,160,0.16)');
    grad.addColorStop(1, 'rgba(120,110,160,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // grain
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle =
      Math.random() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }
  return finishTexture(canvas, 1);
}

/** Yellow/black hazard stripes (fin tip rescue band). */
function hazardTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128);
  ctx.fillStyle = '#23262b';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#f2c230';
  ctx.save();
  ctx.translate(64, 64);
  ctx.rotate(-Math.PI / 4);
  for (let x = -128; x < 128; x += 32) {
    ctx.fillRect(x, -128, 16, 256);
  }
  ctx.restore();
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 1);
  }
  return finishTexture(canvas, 3);
}

/**
 * Olive-drab ordnance skin for the rocket pods: military green with
 * classic yellow ordnance bands, panel seams, rivets and a stencil
 * code — the pods read as visible hardware against the camo fuselage.
 */
function podTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const rand = makeRand(4477);
  ctx.fillStyle = '#6b7a42';
  ctx.fillRect(0, 0, 256, 256);
  // worn tone patches
  for (let i = 0; i < 10; i++) {
    const w = 30 + rand() * 90;
    const h = 20 + rand() * 60;
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(255,255,235,0.07)' : 'rgba(20,26,8,0.10)';
    ctx.fillRect(rand() * (256 - w), rand() * (256 - h), w, h);
  }
  // panel seams
  ctx.strokeStyle = 'rgba(38,46,20,0.9)';
  ctx.lineWidth = 2;
  for (const o of [52, 128, 204]) {
    ctx.beginPath();
    ctx.moveTo(0, o);
    ctx.lineTo(256, o);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(o, 0);
    ctx.lineTo(o, 256);
    ctx.stroke();
  }
  // rivets
  ctx.fillStyle = '#93a465';
  for (let x = 26; x < 256; x += 52) {
    for (let y = 26; y < 256; y += 52) {
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // yellow ordnance bands — the horizontal one wraps each launch tube
  ctx.fillStyle = '#f0b71e';
  ctx.fillRect(0, 92, 256, 20);
  ctx.fillRect(0, 182, 256, 10);
  // stencil ordnance code
  ctx.fillStyle = 'rgba(24,28,10,0.85)';
  ctx.font = '900 24px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RF-HEL', 128, 152);
  // scuffs
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle =
      rand() > 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,230,0.06)';
    ctx.fillRect(rand() * 256, rand() * 256, 3, 1);
  }
  return finishTexture(canvas, 1);
}

/* ---------------- geometry bucket helper ---------------- */

type Vec3 = [number, number, number];

class Bucket {
  geos: THREE.BufferGeometry[] = [];
  add(
    geo: THREE.BufferGeometry,
    pos: Vec3 = [0, 0, 0],
    rot: Vec3 = [0, 0, 0],
    scale: Vec3 = [1, 1, 1]
  ): void {
    // RoundedBoxGeometry is non-indexed while primitive geometries are
    // indexed — normalize everything to non-indexed so mergeGeometries
    // always finds compatible attribute sets.
    if (geo.index) geo = geo.toNonIndexed();
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
      new THREE.Vector3(...scale)
    );
    geo.applyMatrix4(m);
    this.geos.push(geo);
  }
  mesh(material: THREE.Material, shadows: boolean): THREE.Mesh | null {
    if (this.geos.length === 0) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos = [];
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadows;
    return mesh;
  }
}

/* ---------------- module ---------------- */

export function createPetHelicopter(
  scene: THREE.Scene,
  opts: PetHeliOptions = {}
): PetHelicopter {
  const low = opts.lowSpec ?? false;
  const seg = low ? 2 : 3; // rounded-box segments
  const rad = low ? 8 : 14; // cylinder/sphere radial segments

  /* ----- materials (procedural textures, no asset files) ----- */
  const camoTex = camoTexture();
  const fuselageTex = fuselageTexture();
  const metalTex = metalTexture();
  const hazardTex = hazardTexture();
  const podTex = podTexture();

  const camoMat = new THREE.MeshStandardMaterial({
    map: camoTex,
    metalness: 0.35,
    roughness: 0.62,
  });
  const fuselageMat = new THREE.MeshStandardMaterial({
    map: fuselageTex,
    metalness: 0.35,
    roughness: 0.6,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    map: metalTex,
    metalness: 0.9,
    roughness: 0.35,
  });
  const hazardMat = new THREE.MeshStandardMaterial({
    map: hazardTex,
    metalness: 0.15,
    roughness: 0.6,
  });
  const podMat = new THREE.MeshStandardMaterial({
    map: podTex,
    metalness: 0.3,
    roughness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x191c21,
    metalness: 0.3,
    roughness: 0.7,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a1016,
    metalness: 1.0,
    roughness: 0.1,
  });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x1c1f1a,
    metalness: 0.4,
    roughness: 0.5,
  });
  const navGreenMat = new THREE.MeshBasicMaterial({ color: 0x36ff6a });
  const navRedMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
  const strobeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffb020 });
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd27a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const blurMat = new THREE.MeshBasicMaterial({
    color: 0x8a948f,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  /* ----- static merged buckets ----- */
  const fuselage = new Bucket(); // skinned hull (fuselage texture)
  const camo = new Bucket(); // camo-skinned hull parts
  const dark = new Bucket(); // near-black hardware
  const metal = new Bucket(); // machined metal hardware
  const pod = new Bucket(); // ordnance (pods)
  const hazard = new Bucket(); // hazard stripes
  const glass = new Bucket(); // canopy glass

  // ----- hull: teardrop gunship body (nose = +Z) -----
  fuselage.add(new RoundedBoxGeometry(24, 14, 52, seg, 4), [0, -1, 0]);
  fuselage.add(new RoundedBoxGeometry(18, 10, 30, seg, 3.4), [0, 6.5, -4]);
  fuselage.add(
    new RoundedBoxGeometry(15, 9, 14, seg, 3),
    [0, -1.5, 27],
    [-0.14, 0, 0]
  );
  fuselage.add(new RoundedBoxGeometry(10, 4.5, 10, seg, 2), [0, -6, 24]);
  // engine deck
  fuselage.add(new RoundedBoxGeometry(15, 7.5, 17, seg, 2.8), [0, 13, -9]);
  // engine side intakes (dark throats + metal lips)
  for (const sx of [-1, 1]) {
    dark.add(
      new THREE.CylinderGeometry(3.0, 3.4, 5.5, rad),
      [sx * 8.4, 12, -4],
      [0, 0, Math.PI / 2]
    );
    metal.add(
      new THREE.CylinderGeometry(3.7, 3.7, 1.6, rad),
      [sx * 10.6, 12, -4],
      [0, 0, Math.PI / 2]
    );
    // heat-stained exhaust nozzles angled back+out
    metal.add(
      new THREE.CylinderGeometry(2.4, 3.1, 9, rad),
      [sx * 5.8, 12.6, -17.5],
      [Math.PI / 2 - 0.28, 0, sx * 0.22]
    );
    dark.add(
      new THREE.CylinderGeometry(2.0, 2.4, 1.2, rad),
      [sx * 6.9, 13.6, -21.6],
      [Math.PI / 2 - 0.28, 0, sx * 0.22]
    );
  }

  // ----- tandem canopy: tinted glass wedge + side windows -----
  glass.add(
    new RoundedBoxGeometry(11.5, 6.5, 13, seg, 2.6),
    [0, 8.2, 10],
    [0.22, 0, 0]
  );
  for (const sx of [-1, 1]) {
    glass.add(
      new THREE.BoxGeometry(1.2, 4, 8),
      [sx * 8.7, 5.5, 4],
      [0, 0, sx * 0.14]
    );
  }

  // ----- tail boom (tapered, slightly upswept) + fin + stabilizer -----
  camo.add(
    new THREE.CylinderGeometry(7.2, 4.2, 44, rad),
    [0, 6, -46],
    [Math.PI / 2 + 0.1, 0, 0]
  );
  camo.add(
    new RoundedBoxGeometry(3.6, 18, 9, seg, 1.6),
    [0, 15, -66],
    [-0.16, 0, 0]
  );
  hazard.add(
    new RoundedBoxGeometry(3.8, 3.2, 9.2, seg, 1.4),
    [0, 23.4, -67.4],
    [-0.16, 0, 0]
  );
  camo.add(new RoundedBoxGeometry(22, 1.5, 6, seg, 0.7), [0, 9, -58]);

  // ----- stub wings + rocket pods -----
  for (const sx of [-1, 1]) {
    camo.add(new RoundedBoxGeometry(14, 1.6, 7.5, seg, 0.8), [sx * 15.5, 4, -3]);
    pod.add(
      new THREE.CylinderGeometry(4.2, 4.2, 20, rad),
      [sx * 15.5, -0.5, -2],
      [Math.PI / 2, 0, 0]
    );
    dark.add(
      new THREE.CylinderGeometry(3.6, 3.6, 1.2, rad),
      [sx * 15.5, -0.5, 8.4],
      [Math.PI / 2, 0, 0]
    );
  }

  // ----- landing skids: two rails + struts -----
  for (const sx of [-1, 1]) {
    dark.add(new RoundedBoxGeometry(2.4, 2.4, 40, seg, 1.1), [sx * 8.5, -13, 2]);
    for (const sz of [-1, 1]) {
      dark.add(
        new THREE.BoxGeometry(1.9, 6.5, 1.9),
        [sx * 8.5, -9.4, sz * 11],
        [0, 0, sx * 0.16]
      );
    }
    dark.add(
      new THREE.BoxGeometry(1.9, 6, 1.9),
      [sx * 8.5, -10, 17],
      [0.4, 0, sx * 0.16]
    );
    dark.add(
      new THREE.BoxGeometry(1.9, 6, 1.9),
      [sx * 8.5, -10, -13],
      [-0.4, 0, sx * 0.16]
    );
  }

  // ----- blade antennas -----
  dark.add(
    new THREE.BoxGeometry(0.7, 3.5, 2.2),
    [0, 9.5, -30],
    [0.3, 0, 0]
  );
  dark.add(new THREE.BoxGeometry(0.7, 3, 2), [0, -8.5, -8]);

  const fuselageMesh = fuselage.mesh(fuselageMat, true);
  const camoMesh = camo.mesh(camoMat, true);
  const darkMesh = dark.mesh(darkMat, true);
  const metalMesh = metal.mesh(metalMat, true);
  const podMesh = pod.mesh(podMat, true);
  const hazardMesh = hazard.mesh(hazardMat, true);
  const glassMesh = glass.mesh(glassMat, false);

  const root = new THREE.Group();
  root.name = 'petHelicopter';
  for (const m of [
    fuselageMesh,
    camoMesh,
    darkMesh,
    metalMesh,
    podMesh,
    hazardMesh,
    glassMesh,
  ]) {
    if (m) root.add(m);
  }

  // ----- FLIR sensor ball + lens on the nose -----
  const flirBall = new THREE.Mesh(
    new THREE.SphereGeometry(4.2, rad, Math.max(6, rad - 4)),
    glassMat
  );
  flirBall.castShadow = true;
  flirBall.position.set(0, 1, 30);
  root.add(flirBall);
  const flirLens = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 2.8, 2, rad),
    metalMat
  );
  flirLens.rotation.x = Math.PI / 2;
  flirLens.position.set(0, 1, 33.2);
  root.add(flirLens);

  // ----- nav lights + strobe + beacon (blink via color swap) -----
  const navGreen = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, rad, Math.max(5, rad - 4)),
    navGreenMat
  );
  navGreen.position.set(22.5, 4.5, -3);
  root.add(navGreen);
  const navRed = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, rad, Math.max(5, rad - 4)),
    navRedMat
  );
  navRed.position.set(-22.5, 4.5, -3);
  root.add(navRed);
  const strobe = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, rad, Math.max(5, rad - 4)),
    strobeMat
  );
  strobe.position.set(0, 7, -69);
  root.add(strobe);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.3, rad, Math.max(5, rad - 4)),
    beaconMat
  );
  beacon.position.set(0, -8.5, 6);
  root.add(beacon);

  // ----- night spotlight under the nose -----
  const headlight = new THREE.SpotLight(0xfff2cc, 0, low ? 500 : 800, 0.5, 0.55, 1.2);
  headlight.position.set(0, -4, 20);
  root.add(headlight);
  const headTarget = new THREE.Object3D();
  headTarget.position.set(0, -60, 140);
  root.add(headTarget);
  headlight.target = headTarget;

  // ----- MAIN ROTOR: mast (static) + spinning hub with 4 coning blades --
  const rotor = new THREE.Group();
  rotor.position.set(0, 21, -3);
  root.add(rotor);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(1.9, 2.3, 6, rad),
    metalMat
  );
  mast.position.y = -4.4;
  mast.castShadow = true;
  root.add(mast);
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 4.2, 2.4, rad),
    metalMat
  );
  hub.castShadow = true;
  rotor.add(hub);
  const hubCap = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 2.2, 1.6, rad),
    metalMat
  );
  hubCap.position.y = 1.9;
  rotor.add(hubCap);
  // one shared twisted blade; 4 pivots at 90° steps, each blade cones up
  // with RPM (centripetal coning) via its own rotation.z at runtime
  const bladeGeo = new RoundedBoxGeometry(44, 0.8, 4.4, 1, 0.3);
  const blades: THREE.Mesh[] = [];
  for (let b = 0; b < 4; b++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (b * Math.PI) / 2;
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.x = 24; // blade spans x=2..46
    blade.rotation.x = 0.12; // built-in pitch (angle of attack)
    blade.castShadow = true;
    pivot.add(blade);
    rotor.add(pivot);
    blades.push(blade);
  }
  let blur: THREE.Mesh | null = null;
  if (!low) {
    blur = new THREE.Mesh(new THREE.CircleGeometry(47, 26), blurMat);
    blur.rotation.x = -Math.PI / 2;
    blur.position.y = 0.9;
    rotor.add(blur);
  }

  // ----- TAIL ROTOR: gearbox stub + hub + 2 crossed blades + blur disc --
  const tailRotor = new THREE.Group();
  tailRotor.position.set(2.9, 16, -67);
  root.add(tailRotor);
  const tailGear = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.4, 3, Math.max(6, rad - 6)),
    darkMat
  );
  tailGear.rotation.z = Math.PI / 2;
  tailGear.position.x = -1.8;
  tailRotor.add(tailGear);
  const tailHub = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.6, 1.6, rad),
    metalMat
  );
  tailHub.rotation.z = Math.PI / 2;
  tailRotor.add(tailHub);
  const tailBladeGeo = new RoundedBoxGeometry(0.7, 18, 3.2, 1, 0.3);
  const tailA = new THREE.Mesh(tailBladeGeo, bladeMat);
  tailA.position.y = 9.5;
  tailA.rotation.x = -0.12;
  tailA.castShadow = true;
  tailRotor.add(tailA);
  const tailB = new THREE.Mesh(tailBladeGeo, bladeMat);
  tailB.position.y = -9.5;
  tailB.rotation.x = 0.12;
  tailB.castShadow = true;
  tailRotor.add(tailB);
  let tailBlur: THREE.Mesh | null = null;
  if (!low) {
    tailBlur = new THREE.Mesh(new THREE.CircleGeometry(11, 20), blurMat);
    tailBlur.rotation.y = Math.PI / 2;
    tailBlur.position.x = 0.6;
    tailRotor.add(tailBlur);
  }

  // ----- chin MINIGUN turret (aims + fires independent of the body
  // heading; the barrel SPINS while firing) -----
  const turret = new THREE.Group();
  turret.position.set(0, -6.8, 16);
  root.add(turret);
  const turretDark = new Bucket();
  turretDark.add(new RoundedBoxGeometry(6.5, 4.5, 7, seg, 1.6), [0, 0, 0]);
  const turretDarkMesh = turretDark.mesh(darkMat, true);
  if (turretDarkMesh) turret.add(turretDarkMesh);
  const barrelGroup = new THREE.Group();
  barrelGroup.position.set(0, -0.7, 3.5);
  turret.add(barrelGroup);
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.85, 1.05, 11, rad),
    darkMat
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.castShadow = true;
  barrelGroup.add(barrel);
  const shroud = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, 2.6, rad),
    metalMat
  );
  shroud.rotation.x = Math.PI / 2;
  shroud.position.z = -2;
  barrelGroup.add(shroud);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.7, 10);
  turret.add(muzzle);
  // muzzle flash: additive glow ball at the tip + a brief point light
  const flash = new THREE.Mesh(new THREE.SphereGeometry(2.4, 8, 6), flashMat);
  flash.position.set(0, -0.7, 12);
  flash.scale.set(1, 1, 1.6);
  turret.add(flash);
  const flashLight = new THREE.PointLight(0xffc36b, 0, 160, 2);
  flashLight.position.set(0, -0.7, 11);
  if (!low) turret.add(flashLight);

  // ----- rockets: 2 per pod, each its own mesh so launches can empty and
  // reload the tubes visibly (shared merged geometry, one draw call each)
  const rockets: Array<{
    group: THREE.Group;
    loaded: boolean;
    reloadAt: number;
  }> = [];
  const rocketProto = new Bucket();
  rocketProto.add(
    new THREE.CylinderGeometry(1.5, 1.5, 7, rad),
    [0, 0, 0],
    [Math.PI / 2, 0, 0]
  );
  rocketProto.add(
    new THREE.CylinderGeometry(0.05, 1.5, 3, rad),
    [0, 0, 4.9],
    [Math.PI / 2, 0, 0]
  );
  rocketProto.add(
    new THREE.CylinderGeometry(1.05, 1.3, 1, Math.max(6, rad - 4)),
    [0, 0, -3.9],
    [Math.PI / 2, 0, 0]
  );
  rocketProto.add(new THREE.BoxGeometry(2.4, 0.35, 2.2), [0, 1.25, -3]);
  rocketProto.add(new THREE.BoxGeometry(2.4, 0.35, 2.2), [0, -1.25, -3]);
  rocketProto.add(new THREE.BoxGeometry(0.35, 2.4, 2.2), [1.25, 0, -3]);
  rocketProto.add(new THREE.BoxGeometry(0.35, 2.4, 2.2), [-1.25, 0, -3]);
  const rocketMeshProto = rocketProto.mesh(metalMat, true);
  if (rocketMeshProto) {
    const rocketGeo = rocketMeshProto.geometry;
    // interleave left/right so launches alternate pods; two stacked
    // tubes per pod (the yellow ordnance band wraps each tube)
    for (const sx of [-1, 1]) {
      for (const oy of [-1.9, 1.9]) {
        const g = new THREE.Group();
        g.position.set(sx * 15.5, -0.5 + oy, 10.2);
        const rm = new THREE.Mesh(rocketGeo, metalMat);
        rm.castShadow = true;
        g.add(rm);
        root.add(g);
        rockets.push({ group: g, loaded: true, reloadAt: 0 });
      }
    }
  }

  scene.add(root);

  /* ----- brain state ----- */
  const anchor = new THREE.Vector3(); // spring anchor (world), seeded on 1st update
  let seeded = false;
  let rpm = 0; // rotor spool 0..1 (blades visibly spin up on spawn)
  let yawSm = 0;
  let yawRateSm = 0;
  let slotYawSm = 0; // formation yaw — world-anchored while the target idles
  let baseY = 0; // eased player altitude reference (smooth terrain following)
  let pitchSm = 0;
  let rollSm = 0;
  let nightSm = 0;
  let idleTime = 0;
  let swayPhase = Math.random() * Math.PI * 2;
  const lastTarget = new THREE.Vector3();
  const targetVel = new THREE.Vector3();
  const lastAnchor = new THREE.Vector3(); // own-flight velocity source
  const heliVel = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /* ----- tiny synthesized turbine + blade slap (mute-aware, LOW) ----- */
  let audioCtx: AudioContext | null = null;
  let humGain: GainNode | null = null;
  let chopLfo: OscillatorNode | null = null;
  let humStarted = false;
  let muted = getGlobalMuted();
  const offMute = onMuteChange((m) => {
    muted = m;
  });

  function ensureHum(): void {
    if (humStarted || low) return;
    humStarted = true;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
      humGain = audioCtx.createGain();
      humGain.gain.value = 0;
      humGain.connect(audioCtx.destination);
      // two detuned saws = turbine whine (higher than BUZZ's quad hum)
      for (const f of [150, 187]) {
        const osc = audioCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        const og = audioCtx.createGain();
        og.gain.value = 0.5;
        osc.connect(og);
        og.connect(humGain);
        osc.start();
      }
      // shared noise source buffer
      const len = audioCtx.sampleRate * 1.2;
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      // band-passed noise = airframe wash
      const noise = audioCtx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 620;
      bp.Q.value = 1.2;
      const ng = audioCtx.createGain();
      ng.gain.value = 0.5;
      noise.connect(bp);
      bp.connect(ng);
      ng.connect(humGain);
      noise.start();
      // THE CLASSIC "WOP-WOP": band-passed thump whose gain is modulated
      // by a slow LFO = blade slap (the LFO rate follows the spool)
      const chop = audioCtx.createBufferSource();
      chop.buffer = buf;
      chop.loop = true;
      const chopBp = audioCtx.createBiquadFilter();
      chopBp.type = 'bandpass';
      chopBp.frequency.value = 130;
      chopBp.Q.value = 1.1;
      const chopGain = audioCtx.createGain();
      chopGain.gain.value = 0.55;
      chop.connect(chopBp);
      chopBp.connect(chopGain);
      chopGain.connect(humGain);
      chop.start();
      chopLfo = audioCtx.createOscillator();
      chopLfo.type = 'sine';
      chopLfo.frequency.value = 9;
      const lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 0.45; // chop depth — gain swings 0.10..1.00
      chopLfo.connect(lfoGain);
      lfoGain.connect(chopGain.gain);
      chopLfo.start();
    } catch {
      audioCtx = null;
      humGain = null;
      chopLfo = null;
    }
  }

  /* ----- combat state ----- */
  const GUN_RATE = 0.11; // s between chin-gun rounds (~9 rps)
  const ROCKET_CD = 1.25; // s between rocket launches
  const ROCKET_RELOAD = 8; // s for one tube to reload
  let lastShotAt = -10;
  let lastLaunchAt = -10;
  let lastOrderAt = -10; // last fire order — the turret stays on target a while
  let flashT = 0; // muzzle flash envelope 0..1
  let turretKick = 0; // gun recoil envelope 0..1
  let launchKick = 0; // rocket launch nose-pop envelope 0..1
  let barrelSpin = 0; // minigun barrel angular speed (spins up while firing)
  let turretYaw = 0;
  let turretPitch = 0;
  const lastAim = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  const shotDir = new THREE.Vector3();
  const aimLocal = new THREE.Vector3();

  /** Tiny synthesized gun crack / rocket thump (best-effort, mute-aware).
   *  KEPT LOW per the user's standing volume preference. */
  function combatSound(kind: 'shot' | 'thump'): void {
    if (!audioCtx || muted || low) return;
    try {
      const t0 = audioCtx.currentTime;
      const g = audioCtx.createGain();
      g.connect(audioCtx.destination);
      const o = audioCtx.createOscillator();
      if (kind === 'shot') {
        o.type = 'square';
        o.frequency.setValueAtTime(1400, t0);
        o.frequency.exponentialRampToValueAtTime(220, t0 + 0.06);
        g.gain.setValueAtTime(0.02, t0); // low per user preference
        g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.07);
        o.start(t0);
        o.stop(t0 + 0.08);
      } else {
        o.type = 'sine';
        o.frequency.setValueAtTime(140, t0);
        o.frequency.exponentialRampToValueAtTime(36, t0 + 0.3);
        g.gain.setValueAtTime(0.07, t0); // low per user preference
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
        o.start(t0);
        o.stop(t0 + 0.34);
      }
      o.connect(g);
    } catch {
      // audio is best-effort
    }
  }

  /* ----- weapon orders (called from the game loop / input handlers) ----- */
  function fireGun(aim: THREE.Vector3): boolean {
    if (!opts.ordnance) return false;
    const nowS = performance.now() / 1000;
    if (nowS - lastShotAt < GUN_RATE) return false;
    lastShotAt = nowS;
    lastOrderAt = nowS;
    lastAim.copy(aim);
    ensureHum();
    muzzle.getWorldPosition(shotOrigin);
    shotDir.copy(aim).sub(shotOrigin).normalize();
    // light spread so bursts read as a gun, not a laser
    shotDir.x += (Math.random() - 0.5) * 0.02;
    shotDir.y += (Math.random() - 0.5) * 0.02;
    shotDir.z += (Math.random() - 0.5) * 0.02;
    shotDir.normalize();
    opts.ordnance.fireBullet(shotOrigin, shotDir);
    flashT = 1;
    turretKick = 1;
    combatSound('shot');
    return true;
  }

  function launchRocket(
    aim: THREE.Vector3,
    launchOpts?: { tracker?: PetHeliRocketTracker }
  ): boolean {
    if (!opts.ordnance) return false;
    const nowS = performance.now() / 1000;
    if (nowS - lastLaunchAt < ROCKET_CD) return false;
    const slot = rockets.find((r) => r.loaded);
    if (!slot) return false;
    lastLaunchAt = nowS;
    lastOrderAt = nowS;
    lastAim.copy(aim);
    ensureHum();
    slot.loaded = false;
    slot.reloadAt = nowS + ROCKET_RELOAD;
    slot.group.visible = false; // the tube visibly empties, then reloads
    slot.group.getWorldPosition(shotOrigin);
    shotDir.copy(aim).sub(shotOrigin).normalize();
    if (launchOpts?.tracker && opts.ordnance.fireHomingRocket) {
      // HOMING: the rocket chases the tracked target (true PN in the
      // bullet system) — the same plumbing BUZZ's homing rockets use
      opts.ordnance.fireHomingRocket(shotOrigin, shotDir, launchOpts.tracker);
    } else {
      opts.ordnance.fireRocket(shotOrigin, shotDir);
    }
    launchKick = 1;
    combatSound('thump');
    return true;
  }

  function rocketsLoaded(): number {
    return rockets.reduce((n, r) => n + (r.loaded ? 1 : 0), 0);
  }

  /** RESUPPLY: every tube snaps back to loaded and its rocket mesh
   *  re-appears — the pods visibly re-arm on the spot. */
  function resupply(): void {
    for (const r of rockets) {
      r.loaded = true;
      r.group.visible = true;
    }
  }

  /* ----- per-frame brain ----- */
  function update(
    dt: number,
    targetPos: THREE.Vector3,
    targetYaw: number,
    ctx?: PetHeliUpdateContext
  ): void {
    if (!seeded) {
      seeded = true;
      // spawn: high and behind-left — the spring flies the approach in
      anchor.copy(targetPos).add(tmp.set(-40, 260, -90));
      lastAnchor.copy(anchor);
      lastTarget.copy(targetPos);
      baseY = targetPos.y;
      yawSm = targetYaw; // spawn facing the player, then follow our own path
      slotYawSm = targetYaw;
    }

    // --- estimate the target's velocity (drives standoff + hum + slot) ---
    tmp.copy(targetPos).sub(lastTarget).divideScalar(Math.max(dt, 1e-4));
    targetVel.lerp(tmp, 1 - Math.exp(-6 * dt));
    lastTarget.copy(targetPos);
    const speed = targetVel.length();
    const speedF = THREE.MathUtils.clamp(speed / 420, 0, 1);
    if (speed > 24) idleTime = 0;
    else idleTime += dt;

    // --- ROTOR SPOOL-UP: RPM climbs from 0 over ~4 s on spawn, then
    // holds flight RPM (sound, coning, blur discs all follow it) ---
    rpm += (1 - rpm) * (1 - Math.exp(-0.85 * dt));

    // --- formation offset: shoulder -> alongside -> wide standoff.
    // HAWK stands off wider and LOWER than BUZZ (whose slot sits 248 up)
    // so both pets can share the sky without ever overlapping. ---
    const alongside = THREE.MathUtils.smoothstep(speedF, 0.25, 0.85);
    const wide = THREE.MathUtils.smoothstep(speedF, 0.9, 1.0);
    const right = 96 + alongside * 30 + wide * 40;
    const up = 178 - alongside * 28 + wide * 46;
    const back = 96 - alongside * 66 + wide * 38;
    // --- eased altitude reference: the raw player Y stair-steps over the
    // blocky terrain, bounces on every jump and plunges on hard drops —
    // easing turns all of those into one smooth glide ---
    baseY += (targetPos.y - baseY) * (1 - Math.exp(-2.2 * dt));
    // --- formation yaw: the hover spot is WORLD-ANCHORED while the player
    // stands still; it swings back onto the shoulder while they move ---
    if (speed > 60) {
      let dsy = targetYaw - slotYawSm;
      dsy = Math.atan2(Math.sin(dsy), Math.cos(dsy));
      slotYawSm += dsy * (1 - Math.exp(-2.8 * dt));
    } else if (idleTime > 5) {
      let dsy = targetYaw - slotYawSm;
      dsy = Math.atan2(Math.sin(dsy), Math.cos(dsy));
      slotYawSm += dsy * (1 - Math.exp(-0.4 * dt));
    }
    const sinY = Math.sin(slotYawSm);
    const cosY = Math.cos(slotYawSm);
    // yaw frame (character faces +Z at yaw 0):
    //   forward = ( sinY, cosY)   right = (-cosY, sinY)
    if (ctx?.flightOverride) {
      // AUTONOMOUS/PREVIEW flight: hold the caller's hover point through
      // the exact same spring/heading/banking/glide code
      desired.copy(ctx.flightOverride);
    } else {
      desired.set(
        targetPos.x - cosY * right - sinY * back,
        baseY + up,
        targetPos.z + sinY * right - cosY * back
      );
    }
    // ground clearance: never dip under terrain + 82 (both flight modes)
    if (opts.heightAt) {
      const g = opts.heightAt(desired.x, desired.z);
      desired.y = Math.max(desired.y, g + 82);
    }

    // --- critically-damped spring toward the formation slot (slightly
    // heavier than BUZZ's 3.4 — a helicopter has more mass to throw) ---
    const k = 1 - Math.exp(-3.0 * dt);
    anchor.lerp(desired, k);

    // --- our OWN flight velocity (from the spring path; excludes the bob
    // and sway that are added to root later, so it is pure translation) ---
    tmp.copy(anchor).sub(lastAnchor).divideScalar(Math.max(dt, 1e-4));
    heliVel.lerp(tmp, 1 - Math.exp(-8 * dt));
    lastAnchor.copy(anchor);
    const flyX = heliVel.x;
    const flyZ = heliVel.z;
    const flySpeed = Math.hypot(flyX, flyZ);

    // --- hover bob + idle sway (a real heli never sits perfectly still) --
    swayPhase += dt * (idleTime > 5 ? 0.8 : 1.9);
    const bob = Math.sin(swayPhase) * 3.1 + Math.sin(swayPhase * 1.7) * 1.3;
    root.position.copy(anchor);
    root.position.y += bob;
    if (idleTime > 5) {
      root.position.x += Math.sin(swayPhase * 0.6) * 4;
    }

    // --- orientation: face our OWN flight direction, never the player's
    // yaw — a hovering heli holds its heading exactly like a real ship ---
    let yawRate = 0;
    if (flySpeed > 60) {
      // heading from velocity: forward = (sin yaw, cos yaw)
      const desiredYaw = Math.atan2(flyX, flyZ);
      let dyaw = desiredYaw - yawSm;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const step = dyaw * (1 - Math.exp(-4.0 * dt));
      yawSm += step;
      yawRate = dt > 1e-4 ? step / dt : 0; // signed rad/s (+ = arcing left)
    } else if (ctx?.combatTarget) {
      // PARKED COMBAT PIVOT: with no flight motion, slew in place to face
      // the designated target — the gunship spins on its own axis without
      // translating, so the hover slot never moves
      const wantYaw = Math.atan2(
        ctx.combatTarget.x - anchor.x,
        ctx.combatTarget.z - anchor.z
      );
      let dyaw = wantYaw - yawSm;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      const step = dyaw * (1 - Math.exp(-2.6 * dt));
      yawSm += step;
      yawRate = dt > 1e-4 ? step / dt : 0;
    }
    yawRateSm += (yawRate - yawRateSm) * (1 - Math.exp(-6 * dt));
    root.rotation.y = yawSm + (idleTime > 5 ? Math.sin(swayPhase * 0.5) * 0.13 : 0);
    // HELICOPTER ATTITUDE — banking comes from the heli's own motion in
    // its own yaw frame. Real ships tilt far more than quads: the nose
    // dips hard with forward speed (up to ~0.36 rad) and the hull banks
    // into every turn (slips + arcs).
    const fwdX = Math.sin(yawSm);
    const fwdZ = Math.cos(yawSm);
    const vAlong = flyX * fwdX + flyZ * fwdZ;
    const vSide = -flyX * fwdZ + flyZ * fwdX;
    const bankEase = 1 - Math.exp(-4.2 * dt);
    pitchSm += (THREE.MathUtils.clamp(vAlong * 0.001, -0.36, 0.36) - pitchSm) *
      bankEase;
    rollSm += (THREE.MathUtils.clamp(
      vSide * 0.0012 - yawRateSm * 0.55, -0.4, 0.4
    ) - rollSm) * bankEase;
    root.rotation.x = pitchSm + launchKick * 0.14;
    root.rotation.z = rollSm;

    // --- rotors: spooled RPM, blade coning, blur discs, tail rotor ---
    const spin = rpm * 30; // rad/s at the main rotor
    rotor.rotation.y += spin * dt;
    for (const blade of blades) {
      // centripetal coning: blades flex upward as RPM builds
      blade.rotation.z = 0.055 + rpm * 0.05;
    }
    tailRotor.rotation.x += rpm * 155 * dt; // tail spins ~5x, own axis
    if (blur) {
      (blur.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.smoothstep(rpm, 0.5, 0.92) * 0.15;
    }
    if (tailBlur) {
      (tailBlur.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.smoothstep(rpm, 0.5, 0.92) * 0.18;
    }

    // --- lights: double-flash tail strobe, 1 Hz belly beacon, spotlight --
    const t = performance.now() / 1000;
    const ph = t % 1.4;
    const strobeOn = ph < 0.06 || (ph > 0.16 && ph < 0.22);
    strobeMat.color.setHex(strobeOn ? 0xffffff : 0x2a2d33);
    beaconMat.color.setHex(t % 1 < 0.5 ? 0xffb020 : 0x5a4010);
    const nRaw = ctx?.night ?? 0;
    nightSm += (nRaw - nightSm) * (1 - Math.exp(-2 * dt));
    headlight.intensity = nightSm * (low ? 1.5 : 2.5);

    // --- combat per-frame: turret tracking, flash/recoil, barrel spin ---
    const onTarget = t - lastOrderAt < 2.5;
    if (onTarget) {
      // swing the chin turret onto the last ordered world point (in the
      // heli's LOCAL frame, so body heading never matters)
      aimLocal.copy(lastAim);
      root.worldToLocal(aimLocal);
      const dx = aimLocal.x;
      const dy = aimLocal.y + 6.8;
      const dz = aimLocal.z - 16;
      const wantYaw = THREE.MathUtils.clamp(Math.atan2(dx, dz), -1.15, 1.15);
      const wantPitch = THREE.MathUtils.clamp(
        Math.atan2(-dy, Math.hypot(dx, dz)),
        -0.35,
        1.35
      );
      const tEase = 1 - Math.exp(-7 * dt);
      turretYaw += (wantYaw - turretYaw) * tEase;
      turretPitch += (wantPitch - turretPitch) * tEase;
    } else {
      const tEase = 1 - Math.exp(-3 * dt);
      turretYaw += (0 - turretYaw) * tEase;
      turretPitch += (0 - turretPitch) * tEase;
    }
    turret.rotation.y = turretYaw;
    turret.rotation.x = turretPitch;
    // minigun barrel spins up while firing, coasts down after
    barrelSpin += ((flashT > 0 ? 30 : 0) - barrelSpin) *
      (1 - Math.exp(-9 * dt));
    barrelGroup.rotation.z += barrelSpin * dt;
    flashT = Math.max(0, flashT - dt * 14);
    flashMat.opacity = flashT * 0.9;
    flash.scale.setScalar(0.7 + flashT * 0.9);
    flash.scale.z = (0.7 + flashT * 0.9) * 1.6;
    flashLight.intensity = flashT * 22;
    turretKick = Math.max(0, turretKick - dt * 9);
    turret.position.z = 16 - turretKick * 1.8;
    launchKick = Math.max(0, launchKick - dt * 2.6);
    for (const r of rockets) {
      if (!r.loaded && t >= r.reloadAt) {
        r.loaded = true;
        r.group.visible = true;
      }
    }

    // --- audio: turbine + blade slap follow RPM/speed + mute (LOW) ---
    ensureHum();
    if (audioCtx && humGain) {
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => undefined);
      }
      // LOW VOLUME per the user's standing preference — below even
      // BUZZ's already-halved levels. Gain = 0 until the rotor has
      // spooled, then follows RPM and flight speed.
      const targetGain = muted ? 0 : rpm * (0.0055 + speedF * 0.005);
      humGain.gain.value += (targetGain - humGain.gain.value) *
        (1 - Math.exp(-2 * dt));
      // blade-slap rate follows the spool (5.5 Hz parked -> 14 Hz flat out)
      if (chopLfo) {
        chopLfo.frequency.value = 5.5 + rpm * 8.5;
      }
    }
  }

  /* ----- stats + disposal ----- */
  let triangles = 0;
  let meshCount = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      meshCount++;
      const g = m.geometry as THREE.BufferGeometry;
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });

  function dispose(): void {
    offMute();
    bladeGeo.dispose();
    tailBladeGeo.dispose();
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
      chopLfo = null;
    }
    scene.remove(root);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) mat.dispose();
      }
    });
    camoTex.dispose();
    fuselageTex.dispose();
    metalTex.dispose();
    hazardTex.dispose();
    podTex.dispose();
  }

  return {
    group: root,
    update,
    fireGun,
    launchRocket,
    rocketsLoaded,
    resupply,
    velocity: () => heliVel.clone(),
    dispose,
    stats: { meshes: meshCount, triangles: Math.round(triangles) },
  };
}

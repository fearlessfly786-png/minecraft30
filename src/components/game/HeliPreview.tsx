'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  createPetHelicopter,
  type PetHelicopter,
} from '@/game/petHelicopter';
import { createDisplayPodium } from '@/components/game/displayPodium';

/**
 * Live 3D helicopter preview for the PET lobby panel.
 *
 * The HAWK sibling of DronePreview: a self-contained Three.js scene (own
 * canvas + WebGL context, alpha transparent so the panel glass shows
 * through) showing the REAL HAWK airframe — the exact petHelicopter.ts
 * gunship that flies beside you in game — hovering at the CENTRE of the
 * SAME display podium the CHARACTER panel uses (the shared 4-piece
 * photo-scanned steel pedestal from displayPodium.ts, with contact shadow
 * and ornament inlay), so both panels read as one display room with its
 * piece parked on the podium centre mark. Flight runs the helicopter's
 * own spring brain through the `flightOverride` hover point, so the
 * hover bob, ROTOR SPOOL-UP (RPM climbs from 0 with blade coning + blur
 * discs fading in), tail-rotor spin and velocity-aligned nose are
 * genuine in-game flight logic, not an animation fake.
 *
 * `lowSpec: true` keeps the preview ALWAYS SILENT: the turbine/blade-slap
 * audio context is never created (petHelicopter skips it for low-spec
 * builds).
 *
 * Teardown disposes the airframe, the shared podium and the renderer so
 * open/close never leaks WebGL contexts.
 */

/** Centre hover: HAWK parks directly over the podium's centre mark,
 *  gently bobbing in place (world units, game scale). The gunship is
 *  bigger than BUZZ so it floats a touch higher. */
const HOVER_BASE_Y = 70;
const HOVER_WAVE_Y = 9;

/** Camera framing: slow auto-orbit at this radius/height, drag to steer.
 *  Pulled back slightly vs the drone room — the helicopter is wider. */
const CAMERA_FOV = 40;
const CAMERA_R = 300;
const CAMERA_Y = 105;
const LOOK_Y = 50;
const AUTO_ORBIT_SPEED = 0.3; // rad/s
const DRAG_SENSITIVITY = 0.008;

/** Character-panel studio lights, rescaled to this world (directional
 *  lights only care about direction — the multiply just keeps magnitudes
 *  sane). */
const LIGHT_SCALE = 130;

export default function HeliPreview() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    // Alpha-transparent like the dressing room: the panel glass gradient
    // shows through instead of a solid backdrop.
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 5, 4000);

    // RATFIRE light language — the CHARACTER panel's exact studio trio:
    // cool key from the front-left, warm amber rim from behind-right, soft
    // ambient fill. One light language across both display rooms.
    const keyLight = new THREE.DirectionalLight(0xcfe8ff, 2.4);
    keyLight.position.set(-2.2, 3.2, 2.6).multiplyScalar(LIGHT_SCALE);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xfbbf24, 1.7);
    rimLight.position.set(2.4, 2.4, -2.8).multiplyScalar(LIGHT_SCALE);
    scene.add(rimLight);
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    // ===== the CHARACTER panel's PBR steel podium (shared module) =====
    const podium = createDisplayPodium(scene, renderer);

    // The REAL HAWK airframe (silent: lowSpec never creates the audio).
    const heli: PetHelicopter = createPetHelicopter(scene, { lowSpec: true });

    // ===== responsive sizing: canvas fills the container at any dpr =====
    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // ===== pointer drag to orbit + gentle auto orbit =====
    let dragging = false;
    let lastX = 0;
    let azimuth = 0.8;
    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      // Synthetic events (tests) carry inactive pointer ids — ignore the
      // DOMException instead of surfacing it as an unhandled error.
      try {
        container.setPointerCapture?.(event.pointerId);
      } catch {
        /* no active pointer — dragging still works via pointermove */
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      azimuth -= dx * DRAG_SENSITIVITY;
    };
    const endDrag = () => {
      dragging = false;
    };
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointerleave', endDrag);

    // ===== render loop: fly the heli's own brain at the podium centre =====
    const clock = new THREE.Clock();
    const origin = new THREE.Vector3(); // the heli's "player" stands at 0
    const hoverPoint = new THREE.Vector3();
    let elapsed = 1.7; // seed the bob mid-wave so the motion reads instantly

    // Pre-warm the flight brain: petHelicopter seeds its spring anchor
    // high above the origin on first update, which reads as a long
    // empty-podium wait while the gunship descends. A few fat-dt updates
    // snap the spring onto the centre hover point so HAWK is on station
    // from frame one — and the rotor finishes its SPOOL-UP live (the
    // blades visibly accelerate + cone up, exactly like a real start-up).
    const seedHover = (seconds: number) => {
      elapsed += seconds;
      hoverPoint.set(
        0,
        HOVER_BASE_Y + Math.sin(elapsed * 0.8) * HOVER_WAVE_Y,
        0
      );
      heli.update(seconds, origin, 0, { flightOverride: hoverPoint });
    };
    seedHover(0.9);
    seedHover(0.9);
    seedHover(0.9);

    let raf = 0;
    const tick = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;
      // the podium CENTRE: x/z pinned to 0, only the hover bob moves
      hoverPoint.set(
        0,
        HOVER_BASE_Y + Math.sin(elapsed * 0.8) * HOVER_WAVE_Y,
        0
      );
      // The pet brain flies itself to the override point — bob, rotor
      // RPM, blade coning, idle sway and the velocity-aligned nose are
      // all genuine game logic.
      heli.update(dt, origin, 0, { flightOverride: hoverPoint });

      if (!dragging) azimuth += AUTO_ORBIT_SPEED * dt;
      camera.position.set(
        Math.sin(azimuth) * CAMERA_R,
        CAMERA_Y,
        Math.cos(azimuth) * CAMERA_R
      );
      camera.lookAt(0, LOOK_Y, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', endDrag);
      container.removeEventListener('pointerleave', endDrag);

      // Full teardown so open/close never leaks WebGL contexts.
      heli.dispose();
      podium.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 cursor-grab active:cursor-grabbing"
      aria-hidden="true"
    />
  );
}

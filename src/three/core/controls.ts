/**
 * OrbitControls conventions (scenes3d.md A11):
 *  - damping 0.08, rotateSpeed 0.6, pan off, distance/polar clamps from meta.camera;
 *  - cooperative wheel: zoom only with Ctrl (trackpad pinch) or when the stage is "engaged"
 *    (clicked within 8 s, focused, or fullscreen); otherwise the page scrolls and a hint shows;
 *  - touch inline: controls disabled, `touch-action: pan-y` so page scroll is never trapped;
 *    fullscreen / immersive: full controls with `touch-action: none`;
 *  - auto-rotate pauses for 6 s after any interaction;
 *  - keyboard: ←/→ azimuth ±15°, ↑/↓ polar ±10°, +/- dolly (handled via `keyboard()`).
 */
import { MathUtils, type PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toVec3 } from './tween';
import type { SceneMeta } from './types';

export interface ControlsEnv {
  signal: AbortSignal;
  invalidate(): void;
  /** Show the "hold Ctrl to zoom" hint. */
  hint(): void;
  /** Element whose focus counts as engagement (the focusable stage). */
  focusEl: HTMLElement;
}

export class ControlsManager {
  readonly controls: OrbitControls | null;
  private engagedUntil = 0;
  private autoSpeed = 0;
  private autoAllowed = false;
  private resumeAt = 0;
  private immersive = false;
  private readonly coarse = matchMedia('(pointer: coarse)').matches;
  private readonly zoomAllowed: boolean;

  constructor(
    camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    meta: SceneMeta,
    private readonly env: ControlsEnv,
  ) {
    const mode = meta.controls ?? 'orbit';
    this.zoomAllowed = mode === 'orbit';
    if (mode === 'none') {
      this.controls = null;
      canvas.style.touchAction = 'pan-y';
      return;
    }
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 0.8;
    c.enablePan = !!meta.pan;
    c.screenSpacePanning = true;
    c.keys = { LEFT: '', UP: '', RIGHT: '', BOTTOM: '' };
    this.controls = c;
    this.configure(meta);

    const { signal } = env;
    // Cooperative wheel (capture phase runs before OrbitControls' own listener).
    canvas.addEventListener(
      'wheel',
      (e) => {
        const ok = this.zoomAllowed && (e.ctrlKey || this.engaged());
        c.enableZoom = ok;
        if (!ok && this.zoomAllowed) env.hint();
      },
      { capture: true, passive: true, signal },
    );
    canvas.addEventListener('pointerdown', () => this.engage(), { signal });
    c.addEventListener('start', () => this.interacted());
    c.addEventListener('change', () => env.invalidate());
    this.applyTouchMode();
  }

  /** Apply camera clamps for the current variant. */
  configure(meta: SceneMeta): void {
    const c = this.controls;
    if (!c) return;
    const cam = meta.camera;
    const d = toVec3(cam.position).distanceTo(toVec3(cam.target));
    c.minDistance = cam.minDistance ?? d * 0.45;
    c.maxDistance = cam.maxDistance ?? d * 2.2;
    c.minPolarAngle = cam.minPolar ?? 0.12;
    c.maxPolarAngle = cam.maxPolar ?? Math.PI * 0.52;
    c.minAzimuthAngle = cam.minAzimuth ?? -Infinity;
    c.maxAzimuthAngle = cam.maxAzimuth ?? Infinity;
    if ((meta.controls ?? 'orbit') === 'orbit-limited') {
      c.enableZoom = false;
    }
    c.enablePan = !!meta.pan;
    const ar = meta.autoRotate;
    this.autoSpeed = ar === true ? 0.4 : typeof ar === 'number' ? ar : 0;
  }

  engage(ms = 8000): void {
    this.engagedUntil = performance.now() + ms;
  }

  engaged(): boolean {
    return (
      this.immersive ||
      performance.now() < this.engagedUntil ||
      document.activeElement === this.env.focusEl ||
      !!document.fullscreenElement
    );
  }

  /** Any user interaction: pause auto-rotation for 6 s. */
  interacted(): void {
    this.resumeAt = performance.now() + 6000;
    this.engage();
  }

  /** Whether auto-rotation may run (motion allowed and not reduced). */
  setAutoRotateAllowed(on: boolean): void {
    this.autoAllowed = on;
    if (!on && this.controls) this.controls.autoRotate = false;
  }

  get autoRotating(): boolean {
    return !!this.controls?.autoRotate;
  }

  /** Whether the auto-rotation would like continuous frames. */
  wantsFrames(): boolean {
    return this.autoAllowed && this.autoSpeed > 0;
  }

  setImmersive(on: boolean): void {
    this.immersive = on;
    this.applyTouchMode();
  }

  private applyTouchMode(): void {
    const c = this.controls;
    if (!c) return;
    const inlineTouch = this.coarse && !this.immersive;
    c.enabled = !inlineTouch;
    this.canvas.style.touchAction = inlineTouch ? 'pan-y' : 'none';
  }

  /** Per-frame update; returns true while the camera is still moving (damping / auto-rotate). */
  update(dt: number): boolean {
    const c = this.controls;
    if (!c) return false;
    const auto = this.autoAllowed && this.autoSpeed > 0 && performance.now() >= this.resumeAt;
    c.autoRotate = auto;
    c.autoRotateSpeed = this.autoSpeed;
    const moved = c.update(dt);
    return moved || auto;
  }

  /** Keyboard orbit. Returns true when the key was handled. */
  keyboard(e: KeyboardEvent): boolean {
    const c = this.controls;
    if (!c || e.altKey || e.metaKey || e.ctrlKey) return false;
    const az = MathUtils.degToRad(15);
    const po = MathUtils.degToRad(10);
    switch (e.key) {
      case 'ArrowLeft':
        c.rotateLeft(-az);
        break;
      case 'ArrowRight':
        c.rotateLeft(az);
        break;
      case 'ArrowUp':
        c.rotateUp(po);
        break;
      case 'ArrowDown':
        c.rotateUp(-po);
        break;
      case '+':
      case '=':
        if (!this.zoomAllowed) return false;
        c.dollyIn(1.15);
        c.update();
        break;
      case '-':
      case '_':
        if (!this.zoomAllowed) return false;
        c.dollyOut(1.15);
        c.update();
        break;
      default:
        return false;
    }
    this.interacted();
    this.env.invalidate();
    return true;
  }

  dispose(): void {
    this.controls?.dispose();
  }
}

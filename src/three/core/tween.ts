/**
 * Tiny tween engine driven by the host loop (real time, not the animation clock, so user-driven
 * transitions still run while ambient motion is paused). Under reduced motion every tween becomes a
 * cut, except `fade: true` tweens, which are clamped to 150 ms.
 */
import { Color, Vector3, type PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraPose, Ease, EaseName, Tween, Tweener, TweenOptions, Vec3Like } from './types';

export const EASES: Record<EaseName, Ease> = {
  linear: (k) => k,
  quadOut: (k) => 1 - (1 - k) * (1 - k),
  quadInOut: (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2),
  cubicOut: (k) => 1 - (1 - k) ** 3,
  cubicInOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  backOut: (k) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
  },
};

export function toVec3(v: Vec3Like, out = new Vector3()): Vector3 {
  return v instanceof Vector3 ? out.copy(v) : out.set(v[0], v[1], v[2]);
}

interface Active {
  start: number;
  duration: number;
  ease: Ease;
  fn: (k: number) => void;
  resolve: () => void;
  onComplete: (() => void) | undefined;
  cancelled: boolean;
}

export class TweenEngine implements Tweener {
  private items = new Set<Active>();

  constructor(
    private readonly env: {
      reduced(): boolean;
      invalidate(): void;
      camera: PerspectiveCamera;
      controls: OrbitControls | null;
      /** Called when a camera tween changes the fov (host re-applies its aspect fit). */
      setFov(deg: number): void;
      getFov(): number;
    },
  ) {}

  get active(): number {
    return this.items.size;
  }

  run(fn: (k: number) => void, opts: TweenOptions = {}): Tween {
    const reduced = this.env.reduced();
    let duration = opts.duration ?? 700;
    if (reduced) duration = opts.fade ? Math.min(duration, 150) : 0;
    const ease = typeof opts.ease === 'function' ? opts.ease : EASES[opts.ease ?? 'cubicInOut'];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const item: Active = {
      start: performance.now() + (reduced ? 0 : (opts.delay ?? 0)),
      duration,
      ease,
      fn,
      resolve,
      onComplete: opts.onComplete,
      cancelled: false,
    };
    if (duration <= 0) {
      fn(1);
      opts.onComplete?.();
      resolve();
      this.env.invalidate();
      return { cancel() {}, done };
    }
    this.items.add(item);
    this.env.invalidate();
    return {
      cancel: () => {
        if (item.cancelled) return;
        item.cancelled = true;
        this.items.delete(item);
        resolve();
      },
      done,
    };
  }

  to<T extends object>(target: T, to: Partial<Record<keyof T, number>>, opts?: TweenOptions): Tween {
    const rec = target as unknown as Record<string, number>;
    const keys = Object.keys(to);
    const from = keys.map((k) => rec[k] ?? 0);
    const dest = keys.map((k) => (to as Record<string, number>)[k] ?? 0);
    return this.run((e) => {
      keys.forEach((k, i) => {
        const a = from[i] ?? 0;
        rec[k] = a + ((dest[i] ?? 0) - a) * e;
      });
    }, opts);
  }

  vec3(v: Vector3, to: Vec3Like, opts?: TweenOptions): Tween {
    const a = v.clone();
    const b = toVec3(to);
    return this.run((e) => v.lerpVectors(a, b, e), opts);
  }

  color(c: Color, to: Color, opts?: TweenOptions): Tween {
    const a = c.clone();
    const b = to.clone();
    return this.run((e) => c.lerpColors(a, b, e), opts);
  }

  camera(pose: CameraPose, opts?: TweenOptions): Tween {
    const cam = this.env.camera;
    const ctl = this.env.controls;
    const p0 = cam.position.clone();
    const t0 = ctl ? ctl.target.clone() : new Vector3();
    const p1 = toVec3(pose.position);
    const t1 = toVec3(pose.target);
    const f0 = this.env.getFov();
    const f1 = pose.fov ?? f0;
    // Interpolate in spherical-ish space around the moving target to avoid cutting through the model.
    const off0 = p0.clone().sub(t0);
    const off1 = p1.clone().sub(t1);
    const r0 = off0.length();
    const r1 = off1.length();
    off0.normalize();
    off1.normalize();
    const tgt = new Vector3();
    const dir = new Vector3();
    return this.run((e) => {
      tgt.lerpVectors(t0, t1, e);
      dir.copy(off0).lerp(off1, e);
      if (dir.lengthSq() < 1e-6) dir.copy(off1);
      dir.normalize().multiplyScalar(r0 + (r1 - r0) * e);
      cam.position.copy(tgt).add(dir);
      if (ctl) ctl.target.copy(tgt);
      if (f1 !== f0) this.env.setFov(f0 + (f1 - f0) * e);
      cam.lookAt(tgt);
      ctl?.update();
    }, { duration: 750, ease: 'cubicInOut', ...opts });
  }

  /** Advance all tweens. Returns true while any is still running. */
  tick(now = performance.now()): boolean {
    for (const it of [...this.items]) {
      if (it.cancelled) continue;
      const k = Math.min(1, Math.max(0, (now - it.start) / it.duration));
      if (now < it.start) continue;
      it.fn(it.ease(k));
      if (k >= 1) {
        this.items.delete(it);
        it.onComplete?.();
        it.resolve();
      }
    }
    return this.items.size > 0;
  }

  cancelAll(): void {
    for (const it of this.items) {
      it.cancelled = true;
      it.resolve();
    }
    this.items.clear();
  }
}

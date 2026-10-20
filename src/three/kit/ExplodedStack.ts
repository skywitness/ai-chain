/**
 * ExplodedStack: ordered layers whose spacing is driven by an explode value 0..1
 * (scenes3d.md A15). Layer i sits at base_i + i·gap·explode along `axis`. Exposes per-layer label
 * anchors (the layer's far edge) for leader labels.
 */
import { Box3, Group, Vector3, type Object3D } from 'three';
import type { Tween, Tweener, TweenOptions } from '../core/types';

export interface StackLayer {
  object: Object3D;
  /** Optional label shown by the scene at `anchor(i)`. */
  label?: string;
}

export interface ExplodedStackOptions {
  layers: readonly StackLayer[];
  /** Extra spacing per layer at explode = 1 (world units). Default 0.6. */
  gap?: number;
  axis?: 'x' | 'y' | 'z';
  /** Initial explode value. Default 0. */
  explode?: number;
}

export class ExplodedStack {
  readonly group = new Group();
  readonly layers: readonly StackLayer[];
  private readonly base: Vector3[];
  private readonly gap: number;
  private readonly axis: 'x' | 'y' | 'z';
  private value = 0;
  private tween: Tween | null = null;

  constructor(opts: ExplodedStackOptions) {
    this.layers = opts.layers;
    this.gap = opts.gap ?? 0.6;
    this.axis = opts.axis ?? 'y';
    this.group.name = 'ExplodedStack';
    this.base = opts.layers.map((l) => {
      this.group.add(l.object);
      return l.object.position.clone();
    });
    this.set(opts.explode ?? 0);
  }

  get explode(): number {
    return this.value;
  }

  /** Apply an explode value immediately. */
  set(v: number): void {
    this.value = Math.max(0, Math.min(1, v));
    this.layers.forEach((l, i) => {
      const b = this.base[i]!;
      l.object.position.copy(b);
      l.object.position[this.axis] += i * this.gap * this.value;
      l.object.updateMatrix();
    });
  }

  /** Animate to an explode value with the scene's tweener (a cut under reduced motion). */
  animateTo(v: number, tween: Tweener, opts?: TweenOptions): Tween {
    this.tween?.cancel();
    const from = this.value;
    this.tween = tween.run((k) => this.set(from + (v - from) * k), { duration: 800, ...opts });
    return this.tween;
  }

  /** World-space anchor at the +X far edge of layer i (for leader labels). */
  anchor(i: number, out = new Vector3()): Vector3 {
    const l = this.layers[i];
    if (!l) return out.set(0, 0, 0);
    const box = new Box3().setFromObject(l.object);
    return out.set(box.max.x, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
  }

  dispose(): void {
    this.tween?.cancel();
    this.group.removeFromParent();
  }
}

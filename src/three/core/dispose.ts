/**
 * Memory hygiene: a DisposableBag for everything a scene creates, plus deepDispose() as the safety
 * net that walks an Object3D tree (geometries, materials and every texture slot).
 */
import type { Material, Object3D, Texture } from 'three';
import type { Disposable } from './types';

export class DisposableBag implements Disposable {
  private items = new Set<Disposable>();
  private fns: (() => void)[] = [];

  track<T extends Disposable>(o: T): T {
    this.items.add(o);
    return o;
  }

  /** Register a cleanup function (listener removal, observer disconnect…). */
  defer(fn: () => void): void {
    this.fns.push(fn);
  }

  untrack(o: Disposable): void {
    this.items.delete(o);
  }

  get size(): number {
    return this.items.size + this.fns.length;
  }

  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.warn('[scene] cleanup failed', e);
      }
    }
    for (const o of [...this.items].reverse()) {
      try {
        o.dispose();
      } catch (e) {
        console.warn('[scene] dispose failed', e);
      }
    }
    this.items.clear();
  }
}

function isTexture(v: unknown): v is Texture {
  return !!v && typeof v === 'object' && (v as { isTexture?: boolean }).isTexture === true;
}

export function disposeMaterial(m: Material): void {
  for (const value of Object.values(m)) {
    if (isTexture(value)) value.dispose();
  }
  const uniforms = (m as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
  if (uniforms) {
    for (const u of Object.values(uniforms)) {
      if (isTexture(u?.value)) u.value.dispose();
    }
  }
  m.dispose();
}

/** Dispose every geometry, material and texture under `root`, then detach it. */
export function deepDispose(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Object3D & {
      geometry?: { dispose(): void };
      material?: Material | Material[];
      dispose?: () => void;
    };
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
    // InstancedMesh / BatchedMesh own GPU buffers too.
    if ((o as { isInstancedMesh?: boolean }).isInstancedMesh || (o as { isBatchedMesh?: boolean }).isBatchedMesh) {
      mesh.dispose?.();
    }
  });
  root.removeFromParent();
}

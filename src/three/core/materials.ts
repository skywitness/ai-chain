/**
 * Palette-bound material registry. Every material made here follows the theme: when the palette
 * changes, `apply()` re-resolves each binding in place (no material re-creation, no recompiles).
 *
 * Families (scenes3d.md A14): basic = unlit diagram (toneMapped false), standard = hardware,
 * glass = translucent enclosure (depthWrite false), line = LineBasicMaterial.
 */
import {
  Color,
  DoubleSide,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type LineBasicMaterialParameters,
  type Material,
  type MeshBasicMaterialParameters,
  type MeshStandardMaterialParameters,
} from 'three';
import { paletteColor } from './theme';
import type { ColorRef, Disposable, Materials, Palette } from './types';

interface Binding {
  material: Material;
  prop: string;
  ref: ColorRef;
  adjust: ((c: Color, p: Palette) => void) | undefined;
}

export function resolveColor(p: Palette, ref: ColorRef): Color {
  return typeof ref === 'function' ? ref(p).clone() : paletteColor(p, ref).clone();
}

export class MaterialRegistry implements Materials, Disposable {
  private bindings: Binding[] = [];
  private owned = new Set<Material>();

  constructor(private palette: Palette) {}

  color(ref: ColorRef): Color {
    return resolveColor(this.palette, ref);
  }

  bind<M extends Material>(material: M, prop: string, ref: ColorRef, adjust?: (c: Color, p: Palette) => void): M {
    const b: Binding = { material, prop, ref, adjust };
    this.bindings.push(b);
    this.owned.add(material);
    this.applyOne(b);
    return material;
  }

  basic(ref: ColorRef, params: MeshBasicMaterialParameters = {}): MeshBasicMaterial {
    return this.bind(new MeshBasicMaterial({ toneMapped: false, ...params }), 'color', ref);
  }

  standard(ref: ColorRef, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    return this.bind(new MeshStandardMaterial({ metalness: 0.35, roughness: 0.45, ...params }), 'color', ref);
  }

  glass(ref: ColorRef, opacity = 0.16, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    return this.bind(
      new MeshStandardMaterial({
        transparent: true,
        opacity,
        depthWrite: false,
        metalness: 0.1,
        roughness: 0.25,
        side: DoubleSide,
        ...params,
      }),
      'color',
      ref,
    );
  }

  line(ref: ColorRef, params: LineBasicMaterialParameters = {}): LineBasicMaterial {
    return this.bind(new LineBasicMaterial({ toneMapped: false, ...params }), 'color', ref);
  }

  /** Re-resolve all bindings for a new palette (called by the host on theme change). */
  apply(p: Palette): void {
    this.palette = p;
    for (const b of this.bindings) this.applyOne(b);
  }

  private applyOne(b: Binding): void {
    const target = (b.material as unknown as Record<string, unknown>)[b.prop];
    const c = resolveColor(this.palette, b.ref);
    b.adjust?.(c, this.palette);
    if (target instanceof Color) target.copy(c);
    else (b.material as unknown as Record<string, unknown>)[b.prop] = c;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned.clear();
    this.bindings = [];
  }
}

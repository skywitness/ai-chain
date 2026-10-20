/**
 * A thin wrapper over LabelHandle that only calls `set` when something actually changes, so the
 * per-frame draw code can "set" freely without invalidating demand-mode frames (reduced motion
 * must settle to a still frame).
 */
import type { LabelHandle, LabelLayer, LabelSpec } from '../../core/types';

export interface Lbl {
  readonly h: LabelHandle;
  text(t: string): void;
  vis(v: boolean): void;
  kind(k: NonNullable<LabelSpec['kind']>): void;
  swatch(s: string): void;
  prio(n: number): void;
  align(a: NonNullable<LabelSpec['align']>, offset?: readonly [number, number]): void;
}

export function lbl(layer: LabelLayer, spec: LabelSpec): Lbl {
  const h = layer.add(spec);
  let text = spec.text;
  let visible = spec.visible !== false;
  let kind = spec.kind ?? 'default';
  let swatch = spec.swatch ?? '';
  let prio = spec.priority ?? 0;
  let align = `${spec.align ?? 'center'}|${spec.offset?.join(',') ?? ''}`;
  return {
    h,
    text(t) {
      if (t !== text) h.set({ text: (text = t) });
    },
    vis(v) {
      if (v !== visible) h.set({ visible: (visible = v) });
    },
    kind(k) {
      if (k !== kind) h.set({ kind: (kind = k) });
    },
    swatch(s) {
      if (s !== swatch) h.set({ swatch: (swatch = s) });
    },
    prio(n) {
      if (n !== prio) h.set({ priority: (prio = n) });
    },
    align(a, offset) {
      const key = `${a}|${offset?.join(',') ?? ''}`;
      if (key === align) return;
      align = key;
      h.set(offset ? { align: a, offset } : { align: a });
    },
  };
}

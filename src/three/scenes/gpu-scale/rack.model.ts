/**
 * gpu-scale — the NVL72-style rack model shared by the `chip` (pod of racks) and `rack` (exploded)
 * variants. Units are metres; rack-local origin = floor centre, front faces +z.
 *
 * Slot plan (top → bottom, 1U = 44.5 mm; power-shelf count is illustrative 示意):
 *   0 management switch · 1–3 power shelves · 4–13 compute trays (10) · 14–22 NVLink switch trays (9)
 *   · 23–30 compute trays (8) · 31–33 power shelves · 34–39 blank (6U).
 */
import { Matrix4, Vector3, type BufferGeometry } from 'three';
import { T, bx, face, mat, type FrontKind, type InstItem, type Tone } from './kit';

export const U = 0.0445;
export const RACK = { w: 0.6, d: 1.2, h: 2.06, top: 1.93 } as const;
export const TRAY_W = 0.44;
export const FRONT_Z = 0.52;

export type Kind = 'mgmt' | 'power' | 'compute' | 'switch' | 'blank';
export interface Slot {
  /** First slot index (top = 0). */
  slot: number;
  units: number;
  kind: Kind;
  /** Functional group 0–5 (explode groups). */
  group: number;
}

export const SLOTS: readonly Slot[] = (() => {
  const s: Slot[] = [{ slot: 0, units: 1, kind: 'mgmt', group: 0 }];
  for (let i = 1; i <= 3; i++) s.push({ slot: i, units: 1, kind: 'power', group: 0 });
  for (let i = 4; i <= 13; i++) s.push({ slot: i, units: 1, kind: 'compute', group: 1 });
  for (let i = 14; i <= 22; i++) s.push({ slot: i, units: 1, kind: 'switch', group: 2 });
  for (let i = 23; i <= 30; i++) s.push({ slot: i, units: 1, kind: 'compute', group: 3 });
  for (let i = 31; i <= 33; i++) s.push({ slot: i, units: 1, kind: 'power', group: 4 });
  s.push({ slot: 34, units: 6, kind: 'blank', group: 5 });
  return s;
})();

/** Vertical centre of a slot run (rack-local y). */
export const slotY = (slot: number, units = 1) => RACK.top - (slot + units / 2) * U;

export const DEPTH: Record<Kind, number> = { mgmt: 0.42, power: 0.72, compute: 0.86, switch: 0.8, blank: 0.02 };

export const KIND_TONE: Record<Kind, Tone> = {
  compute: face(T.compute, 0.58),
  switch: face(T.nvswitch, 0.62),
  power: face(T.power, 0.6),
  mgmt: face(T.muted, 0.25),
  blank: face(T.cabinet, 0.55),
};
export const KIND_FRONT: Record<Kind, FrontKind> = { compute: 'compute', switch: 'switch', power: 'power', mgmt: 'mgmt', blank: 'blank' };
export const KIND_HOTSPOT: Record<Kind, string | null> = {
  compute: 'compute-tray',
  switch: 'nvlink-switch',
  power: 'power',
  mgmt: null,
  blank: null,
};

/** Rack frame (posts, caps, plinth, mounting rails) as one rack-local geometry. */
export function frameGeometry(): BufferGeometry[] {
  const { w, d, h, top } = RACK;
  const g: BufferGeometry[] = [];
  const p = 0.035;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) g.push(bx(p, h - 0.12, p, sx * (w / 2 - p / 2), 0.1 + (h - 0.12) / 2, sz * (d / 2 - p / 2)));
  g.push(bx(w, 0.06, d, 0, h - 0.03, 0)); // top cap
  g.push(bx(w, 0.1, d, 0, 0.05, 0)); // plinth
  // EIA mounting rails (front and rear)
  for (const sx of [-1, 1])
    for (const z of [FRONT_Z - 0.01, -0.46]) g.push(bx(0.018, top - 0.12, 0.022, sx * (TRAY_W / 2 + 0.012), 0.12 + (top - 0.12) / 2, z));
  // side rails at top and bottom
  for (const sx of [-1, 1]) for (const y of [0.11, top + 0.01]) g.push(bx(0.02, 0.025, d - 0.06, sx * (w / 2 - 0.02), y, 0));
  return g;
}

export interface RackPlace {
  /** Rack-local → world. */
  m: Matrix4;
  /** Slot indices to leave out (e.g. the hero tray that is pulled out). */
  skip?: ReadonlySet<number>;
  /** Extra rack-local offset per slot (explode). */
  offset?: (s: Slot) => Vector3 | null;
}

const _m = new Matrix4();
const _o = new Vector3();

/** Instance items for tray bodies, per-kind fronts and LED anchors of a set of racks. */
export function trayItems(racks: readonly RackPlace[]) {
  const bodies: InstItem[] = [];
  const fronts: Record<Kind, InstItem[]> = { compute: [], switch: [], power: [], mgmt: [], blank: [] };
  const leds: { pos: Vector3; kind: Kind }[] = [];
  for (const r of racks) {
    for (const s of SLOTS) {
      if (r.skip?.has(s.slot)) continue;
      const o = r.offset?.(s) ?? _o.set(0, 0, 0);
      const y = slotY(s.slot, s.units) + o.y;
      const dep = DEPTH[s.kind];
      const hh = s.units * U - 0.0035;
      const id = KIND_HOTSPOT[s.kind];
      if (s.kind !== 'blank')
        bodies.push({ m: _m.copy(r.m).multiply(mat(o.x, y, FRONT_Z - dep / 2 + o.z, TRAY_W, hh, dep)).clone(), tone: T.chassis, id });
      fronts[s.kind].push({ m: _m.copy(r.m).multiply(mat(o.x, y, FRONT_Z + 0.002 + o.z)).clone(), tone: KIND_TONE[s.kind], id });
      if (s.kind !== 'blank')
        leds.push({ pos: new Vector3(TRAY_W / 2 - 0.035 + o.x, y + 0.008, FRONT_Z + 0.008 + o.z).applyMatrix4(r.m), kind: s.kind });
    }
  }
  return { bodies, fronts, leds };
}

/** Rear spine parts in rack-local coordinates: busbar, 4 NVLink cable cartridges, 2 manifolds. */
export const REAR = {
  busbar: { x: 0, z: -0.5, w: 0.05, d: 0.014, from: 1, to: 33 },
  cartridges: { xs: [-0.17, -0.09, 0.09, 0.17], z: -0.465, w: 0.07, d: 0.06, from: 4, to: 30 },
  manifolds: { xs: [-0.25, 0.25], z: -0.53, r: 0.02, from: 3, to: 31 },
} as const;

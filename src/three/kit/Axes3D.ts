/**
 * Axes3D: linear or log axes in a box, optional grid planes, and HTML tick / title labels through
 * the LabelLayer (scenes3d.md A15). `map(x, y, z)` converts data values to world positions.
 */
import { BufferGeometry, Float32BufferAttribute, Group, LineSegments, Vector3 } from 'three';
import type { LabelHandle, LabelLayer, Materials, Vec3Like } from '../core/types';

export interface AxisSpec {
  /** zh-TW axis title, e.g. 「每百萬 token 價格（美元，對數）」. */
  label: string;
  domain: readonly [number, number];
  scale?: 'linear' | 'log';
  /** Tick values, or a count for linear axes. Log axes default to powers of ten. */
  ticks?: readonly number[] | number;
  format?: (v: number) => string;
}

export interface Axes3DOptions {
  /** World size of the box along x, y, z. */
  size: readonly [number, number, number];
  /** World position of the data minimum corner. Default: box centred on the origin, y from 0. */
  origin?: Vec3Like;
  x?: AxisSpec;
  y?: AxisSpec;
  z?: AxisSpec;
  /** Grid planes to draw. Default ['xz', 'xy']. */
  grid?: readonly ('xy' | 'xz' | 'yz')[];
  labels: LabelLayer;
  materials: Materials;
}

type Key = 'x' | 'y' | 'z';
const IDX: Record<Key, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export class Axes3D {
  readonly group = new Group();
  private readonly origin: Vector3;
  private readonly size: readonly [number, number, number];
  private readonly specs: Partial<Record<Key, AxisSpec>>;
  private readonly handles: LabelHandle[] = [];
  private readonly geos: BufferGeometry[] = [];

  constructor(private readonly opts: Axes3DOptions) {
    this.size = opts.size;
    this.specs = { ...(opts.x ? { x: opts.x } : {}), ...(opts.y ? { y: opts.y } : {}), ...(opts.z ? { z: opts.z } : {}) };
    const o = opts.origin;
    this.origin = o
      ? o instanceof Vector3
        ? o.clone()
        : new Vector3(o[0], o[1], o[2])
      : new Vector3(-opts.size[0] / 2, 0, -opts.size[2] / 2);
    this.group.name = 'Axes3D';
    this.build();
  }

  /** Normalised position 0..1 of a value on an axis. */
  norm(axis: Key, v: number): number {
    const s = this.specs[axis];
    if (!s) return 0;
    const [a, b] = s.domain;
    if (s.scale === 'log') {
      const la = Math.log10(Math.max(a, 1e-12));
      const lb = Math.log10(Math.max(b, 1e-12));
      return (Math.log10(Math.max(v, 1e-12)) - la) / (lb - la || 1);
    }
    return (v - a) / (b - a || 1);
  }

  /** Data → world. */
  map(x: number, y: number, z: number, out = new Vector3()): Vector3 {
    return out.set(
      this.origin.x + this.norm('x', x) * this.size[0],
      this.origin.y + this.norm('y', y) * this.size[1],
      this.origin.z + this.norm('z', z) * this.size[2],
    );
  }

  private ticks(axis: Key): number[] {
    const s = this.specs[axis];
    if (!s) return [];
    if (Array.isArray(s.ticks)) return [...(s.ticks as number[])];
    const [a, b] = s.domain;
    if (s.scale === 'log') {
      const out: number[] = [];
      for (let e = Math.ceil(Math.log10(a)); e <= Math.floor(Math.log10(b)); e++) out.push(10 ** e);
      return out;
    }
    const n = typeof s.ticks === 'number' ? s.ticks : 5;
    return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  }

  private build(): void {
    const { materials, labels } = this.opts;
    const axisPos: number[] = [];
    const gridPos: number[] = [];
    const o = this.origin;
    const [sx, sy, sz] = this.size;
    const corner = (dx: number, dy: number, dz: number) => [o.x + dx, o.y + dy, o.z + dz];
    // Axis lines from the origin corner.
    if (this.specs.x) axisPos.push(...corner(0, 0, sz), ...corner(sx, 0, sz));
    if (this.specs.y) axisPos.push(...corner(0, 0, sz), ...corner(0, sy, sz));
    if (this.specs.z) axisPos.push(...corner(sx, 0, 0), ...corner(sx, 0, sz));

    const planes = this.opts.grid ?? ['xz', 'xy'];
    for (const key of ['x', 'y', 'z'] as Key[]) {
      for (const v of this.ticks(key)) {
        const t = this.norm(key, v);
        if (t < -1e-6 || t > 1 + 1e-6) continue;
        const d = [0, 0, 0] as [number, number, number];
        d[IDX[key]] = t * this.size[IDX[key]];
        for (const p of planes) {
          if (!p.includes(key)) continue;
          const other = p.replace(key, '') as Key;
          const a = [...d] as [number, number, number];
          const b = [...d] as [number, number, number];
          b[IDX[other]] = this.size[IDX[other]];
          if (p === 'xy') {
            a[2] = 0;
            b[2] = 0;
          }
          if (p === 'yz') {
            a[0] = 0;
            b[0] = 0;
          }
          gridPos.push(...corner(...a), ...corner(...b));
        }
        const s = this.specs[key]!;
        const text = s.format ? s.format(v) : formatTick(v);
        const pos = new Vector3(...(corner(...d) as [number, number, number]));
        if (key === 'x') pos.z = o.z + sz + 0.15;
        if (key === 'y') pos.set(o.x - 0.15, pos.y, o.z + sz);
        if (key === 'z') pos.x = o.x + sx + 0.15;
        this.handles.push(labels.add({ text, position: pos, kind: 'tag', priority: -1, align: key === 'y' ? 'left' : 'below' }));
      }
      const s = this.specs[key];
      if (s) {
        const mid = [0, 0, 0] as [number, number, number];
        mid[IDX[key]] = this.size[IDX[key]] / 2;
        const p = new Vector3(...(corner(...mid) as [number, number, number]));
        if (key === 'x') p.z = o.z + sz + 0.55;
        if (key === 'y') p.set(o.x - 0.6, p.y, o.z + sz);
        if (key === 'z') p.x = o.x + sx + 0.6;
        this.handles.push(labels.add({ text: s.label, position: p, kind: 'muted', priority: 5 }));
      }
    }
    const mk = (pos: number[], ref: 'muted' | 'grid', opacity: number) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      this.geos.push(g);
      const m = materials.line(ref, { transparent: opacity < 1, opacity });
      const l = new LineSegments(g, m);
      l.matrixAutoUpdate = false;
      this.group.add(l);
    };
    if (gridPos.length) mk(gridPos, 'grid', 0.7);
    if (axisPos.length) mk(axisPos, 'muted', 1);
  }

  dispose(): void {
    for (const h of this.handles) h.remove();
    for (const g of this.geos) g.dispose();
    this.group.removeFromParent();
  }
}

function formatTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${+(v / 1e12).toPrecision(3)}兆`;
  if (a >= 1e8) return `${+(v / 1e8).toPrecision(3)}億`;
  if (a >= 1e4) return `${+(v / 1e4).toPrecision(3)}萬`;
  if (a > 0 && a < 0.01) return v.toExponential(0);
  return `${+v.toPrecision(3)}`;
}

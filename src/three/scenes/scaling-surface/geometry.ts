/**
 * Procedural geometry for scaling-surface: the loss surface grid, its skirt walls, iso-loss contours
 * (marching squares), draped polylines, an in-place updatable tube, the budget cut face and the
 * fading floor grid. Everything is built once (or updated in place) — no per-frame allocation.
 */
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, Shape, Vector3 } from 'three';
import { height, HALF, LG_D, LG_N, wx, wy, wz, E, Y_MAX } from './law';

export type LgPoint = readonly [lgN: number, lgD: number];

/* ───────── surface ───────── */

export interface SurfaceGeo {
  geometry: BufferGeometry;
  /** Normalised height 0..1 per vertex (for colouring). */
  t: Float32Array;
}

export function buildSurface(seg: number): SurfaceGeo {
  const n = seg + 1;
  const pos = new Float32Array(n * n * 3);
  const t = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const lgD = LG_D[0] + ((LG_D[1] - LG_D[0]) * j) / seg;
    for (let i = 0; i < n; i++) {
      const lgN = LG_N[0] + ((LG_N[1] - LG_N[0]) * i) / seg;
      const k = j * n + i;
      const y = height(lgN, lgD);
      pos[k * 3] = wx(lgN);
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = wz(lgD);
      t[k] = y / Y_MAX;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < seg; j++)
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(n * n * 3), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, t };
}

/** Vertical walls from the surface edge down to the floor (y = 0), outward normals; t = normalised height (top) or −1 (bottom). */
export function buildSkirt(seg: number): SurfaceGeo {
  const pos: number[] = [];
  const nor: number[] = [];
  const tt: number[] = [];
  const edge = (pts: LgPoint[], normal: Vector3) => {
    const v = (p: LgPoint, top: boolean): [number, number, number] => [wx(p[0]), top ? height(p[0], p[1]) : 0, wz(p[1])];
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s]!;
      const b = pts[s + 1]!;
      let tri: [number, number, number][][] = [
        [v(a, false), v(b, false), v(a, true)],
        [v(a, true), v(b, false), v(b, true)],
      ];
      // Flip the winding when it does not face `normal`.
      const [p0, p1, p2] = tri[0]!;
      const e1 = new Vector3(p1![0] - p0![0], p1![1] - p0![1], p1![2] - p0![2]);
      const e2 = new Vector3(p2![0] - p0![0], p2![1] - p0![1], p2![2] - p0![2]);
      if (e1.cross(e2).dot(normal) < 0) tri = tri.map((t) => [t[0]!, t[2]!, t[1]!]);
      for (const t of tri)
        for (const p of t) {
          pos.push(...p);
          nor.push(normal.x, normal.y, normal.z);
          tt.push(p[1] > 0 ? p[1] / Y_MAX : -1);
        }
    }
  };
  const line = (fn: (u: number) => LgPoint) => Array.from({ length: seg + 1 }, (_, s) => fn(s / seg));
  const n = (u: number) => LG_N[0] + (LG_N[1] - LG_N[0]) * u;
  const d = (u: number) => LG_D[0] + (LG_D[1] - LG_D[0]) * u;
  edge(line((u) => [n(u), LG_D[1]]), new Vector3(0, 0, 1));
  edge(line((u) => [n(u), LG_D[0]]), new Vector3(0, 0, -1));
  edge(line((u) => [LG_N[1], d(u)]), new Vector3(1, 0, 0));
  edge(line((u) => [LG_N[0], d(u)]), new Vector3(-1, 0, 0));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.length), 3));
  return { geometry: g, t: new Float32Array(tt) };
}

/* ───────── contours (marching squares on ln(L − E)) ───────── */

/** Iso-loss contours at the given reducible-loss levels (L − E). Returns one position array per level. */
export function contours(levels: readonly number[], grid: number, lift: number): Float32Array[] {
  const n = grid + 1;
  const hN = (LG_N[1] - LG_N[0]) / grid;
  const hD = (LG_D[1] - LG_D[0]) / grid;
  const v = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) v[j * n + i] = Math.log(height(LG_N[0] + i * hN, LG_D[0] + j * hD) / wy(E + 1));
  const out: Float32Array[] = [];
  for (const r of levels) {
    const c = Math.log(r);
    const y = wy(E + r) + lift;
    const seg: number[] = [];
    const P = (i: number, j: number, di: number, dj: number, a: number, b: number) => {
      const t = Math.min(1, Math.max(0, (c - a) / (b - a)));
      const lgN = LG_N[0] + (i + di * t) * hN;
      const lgD = LG_D[0] + (j + dj * t) * hD;
      return [wx(lgN), y, wz(lgD)];
    };
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) {
        const v0 = v[j * n + i]!;
        const v1 = v[j * n + i + 1]!;
        const v2 = v[(j + 1) * n + i + 1]!;
        const v3 = v[(j + 1) * n + i]!;
        const cs = (v0 > c ? 1 : 0) | (v1 > c ? 2 : 0) | (v2 > c ? 4 : 0) | (v3 > c ? 8 : 0);
        if (cs === 0 || cs === 15) continue;
        const e = [
          () => P(i, j, 1, 0, v0, v1), // bottom (j)
          () => P(i + 1, j, 0, 1, v1, v2), // right (i + 1)
          () => P(i, j + 1, 1, 0, v3, v2), // top (j + 1)
          () => P(i, j, 0, 1, v0, v3), // left (i)
        ];
        const pairs = CASES[cs] ?? [];
        for (const [a, b] of pairs) seg.push(...e[a]!(), ...e[b]!());
      }
    out.push(new Float32Array(seg));
  }
  return out;
}

const CASES: Record<number, [number, number][]> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  5: [
    [3, 0],
    [1, 2],
  ],
  6: [[0, 2]],
  7: [[3, 2]],
  8: [[2, 3]],
  9: [[0, 2]],
  10: [
    [0, 1],
    [2, 3],
  ],
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[3, 0]],
};

/** A polyline in (lgN, lgD) lifted onto the surface. */
export function drape(pts: readonly LgPoint[], lift: number): Vector3[] {
  return pts.map(([n, d]) => new Vector3(wx(n), height(n, d) + lift, wz(d)));
}

/** `count` points from a → b in (lgN, lgD), linearly. */
export function lgLine(a: LgPoint, b: LgPoint, count: number): LgPoint[] {
  return Array.from({ length: count }, (_, s) => {
    const u = s / (count - 1);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u] as const;
  });
}

/** Resample a polyline to exactly `n` points by arc length. */
export function resample(pts: readonly Vector3[], n: number, out: Vector3[] = []): Vector3[] {
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
  const total = len[len.length - 1]!;
  let k = 0;
  for (let s = 0; s < n; s++) {
    const target = (total * s) / (n - 1);
    while (k < pts.length - 2 && len[k + 1]! < target) k++;
    const span = len[k + 1]! - len[k]! || 1;
    const u = Math.min(1, Math.max(0, (target - len[k]!) / span));
    (out[s] ??= new Vector3()).lerpVectors(pts[k]!, pts[Math.min(k + 1, pts.length - 1)]!, u);
  }
  out.length = n;
  return out;
}

/* ───────── tube (updated in place) ───────── */

const T = new Vector3();
const S = new Vector3();
const Nn = new Vector3();
const Bn = new Vector3();
const UP = new Vector3(0, 1, 0);

/** A round tube through exactly `samples` points; `set()` rewrites the buffers without allocating. */
export class Tube {
  readonly geometry = new BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;

  constructor(
    readonly samples: number,
    readonly radial = 8,
  ) {
    this.pos = new Float32Array(samples * radial * 3);
    this.nor = new Float32Array(samples * radial * 3);
    const idx: number[] = [];
    for (let s = 0; s < samples - 1; s++)
      for (let r = 0; r < radial; r++) {
        const a = s * radial + r;
        const b = s * radial + ((r + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        idx.push(a, b, c, b, d, c);
      }
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.nor, 3));
    this.geometry.setIndex(idx);
  }

  set(pts: readonly Vector3[], radius: number): void {
    const n = this.samples;
    const R = this.radial;
    for (let s = 0; s < n; s++) {
      const p = pts[Math.min(s, pts.length - 1)]!;
      const a = pts[Math.max(0, s - 1)]!;
      const b = pts[Math.min(pts.length - 1, s + 1)]!;
      T.subVectors(b, a);
      if (T.lengthSq() < 1e-12) T.set(1, 0, 0);
      T.normalize();
      S.crossVectors(T, UP);
      if (S.lengthSq() < 1e-8) S.set(1, 0, 0);
      S.normalize();
      Nn.copy(S);
      Bn.crossVectors(T, Nn).normalize();
      for (let r = 0; r < R; r++) {
        const th = (r / R) * Math.PI * 2;
        const c = Math.cos(th);
        const si = Math.sin(th);
        const k = (s * R + r) * 3;
        const ox = c * Nn.x + si * Bn.x;
        const oy = c * Nn.y + si * Bn.y;
        const oz = c * Nn.z + si * Bn.z;
        this.nor[k] = ox;
        this.nor[k + 1] = oy;
        this.nor[k + 2] = oz;
        this.pos[k] = p.x + ox * radius;
        this.pos[k + 1] = p.y + oy * radius;
        this.pos[k + 2] = p.z + oz * radius;
      }
    }
    this.geometry.attributes['position']!.needsUpdate = true;
    this.geometry.attributes['normal']!.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/* ───────── budget cut face ───────── */

/** A vertical strip from a top polyline down to y = 0, with a fixed sample count. */
export class CutFace {
  readonly geometry = new BufferGeometry();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;

  constructor(readonly samples: number) {
    this.pos = new Float32Array(samples * 2 * 3);
    this.col = new Float32Array(samples * 2 * 3);
    const nor = new Float32Array(samples * 2 * 3);
    const k = Math.SQRT1_2;
    for (let i = 0; i < samples * 2; i++) nor.set([k, 0, k], i * 3);
    const idx: number[] = [];
    for (let s = 0; s < samples - 1; s++) {
      const t0 = s * 2;
      const b0 = t0 + 1;
      const t1 = t0 + 2;
      const b1 = t0 + 3;
      idx.push(b0, b1, t0, t0, b1, t1);
    }
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(nor, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.col, 3));
    this.geometry.setIndex(idx);
  }

  set(top: readonly Vector3[]): void {
    for (let s = 0; s < this.samples; s++) {
      const p = top[Math.min(s, top.length - 1)]!;
      this.pos.set([p.x, p.y, p.z, p.x, 0, p.z], s * 6);
    }
    this.geometry.attributes['position']!.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** Vertical gradient: `top` colour at the surface edge, `bottom` at the floor. */
  recolor(top: Color, bottom: Color): void {
    for (let s = 0; s < this.samples; s++) this.col.set([top.r, top.g, top.b, bottom.r, bottom.g, bottom.b], s * 6);
    this.geometry.attributes['color']!.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/* ───────── floor & shapes ───────── */

export function roundedRect(w: number, d: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A square grid of short segments whose alpha fades with distance from the centre (RGBA colours). */
export function buildFloorGrid(radius: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 16;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++)
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.hypot(x, z) / radius;
        // Hide the part under the plinth so the grid reads as a floor around it.
        const under = Math.max(Math.abs(x), Math.abs(z)) < HALF + 0.5 ? 0 : 1;
        fade.push(Math.max(0, 1 - r * r) ** 1.6 * under);
      }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  return {
    geometry,
    recolor(c: Color, alpha: number) {
      const attr = geometry.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}

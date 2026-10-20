/**
 * energy — scene-private geometry helpers.
 *
 *  - Primitive builders that sit on y = 0 (rounded boxes, cylinders, domes, a hyperboloid
 *    cooling tower).
 *  - `PartList` → `Facility`: many primitives merged into ONE vertex-coloured mesh (one draw call
 *    per facility). Each part keeps a palette tint, so theme switches only rewrite the colour
 *    attribute. `dim` washes the facility toward the background (step focus); `hot` adds a
 *    highlight glow (hover).
 *  - Transmission: lattice pylon geometry, gantry frames and catenary conductors.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
  type MeshStandardMaterialParameters,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Palette } from '../../core/types';

export type Tint = (p: Palette) => Color;
export type XZ = readonly [number, number];

/* ───────────────────────── primitives (base on y = 0) ───────────────────────── */

export function rbox(w: number, h: number, d: number, r = 0.03): BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2.2, h / 2.2, d / 2.2));
  g.translate(0, h / 2, 0);
  return g;
}

export function box(w: number, h: number, d: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

export function cyl(rTop: number, rBottom: number, h: number, seg = 16, open = false): BufferGeometry {
  const g = new CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  g.translate(0, h / 2, 0);
  return g;
}

/** Upper hemisphere centred on the origin. */
export function dome(r: number, seg = 20): BufferGeometry {
  return new SphereGeometry(r, seg, Math.max(4, Math.round(seg / 3)), 0, Math.PI * 2, 0, Math.PI / 2);
}

/** Natural-draft cooling tower: a hyperboloid shell (base radius, waist radius at waistAt·h). */
export function coolingTower(h: number, rBase: number, rWaist: number, waistAt = 0.74, seg = 28): BufferGeometry {
  const y0 = h * waistAt;
  const b = y0 / Math.sqrt((rBase / rWaist) ** 2 - 1);
  const pts: Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const y = (h * i) / 12;
    pts.push(new Vector2(rWaist * Math.sqrt(1 + ((y - y0) / b) ** 2), y));
  }
  return new LatheGeometry(pts, seg);
}
export function towerTopRadius(h: number, rBase: number, rWaist: number, waistAt = 0.74): number {
  const y0 = h * waistAt;
  const b = y0 / Math.sqrt((rBase / rWaist) ** 2 - 1);
  return rWaist * Math.sqrt(1 + ((h - y0) / b) ** 2);
}

/** A thin square beam from a to b (for lattice towers and gantries). */
export function beam(a: Vector3, b: Vector3, t: number): BufferGeometry {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new BoxGeometry(t, len, t);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  g.applyMatrix4(new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
  return g;
}

/** A round pipe / rod from a to b. */
export function rod(a: readonly [number, number, number], b: readonly [number, number, number], r: number, seg = 8): BufferGeometry {
  const va = new Vector3(...a);
  const vb = new Vector3(...b);
  const dir = new Vector3().subVectors(vb, va);
  const g = new CylinderGeometry(r, r, dir.length(), seg, 1);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  g.applyMatrix4(new Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
  return g;
}

export function roundedRect(w: number, d: number, r: number, cx = 0, cz = 0): Shape {
  const s = new Shape();
  const x = cx - w / 2;
  const y = cz - d / 2;
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

/* ───────────────────────── merged, vertex-coloured facilities ───────────────────────── */

export interface Place {
  x?: number;
  y?: number;
  z?: number;
  ry?: number;
  rx?: number;
  rz?: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);

export class PartList {
  readonly items: { geo: BufferGeometry; tint: Tint }[] = [];

  add(geo: BufferGeometry, tint: Tint, at: Place = {}): this {
    _e.set(at.rx ?? 0, at.ry ?? 0, at.rz ?? 0);
    _m.compose(_p.set(at.x ?? 0, at.y ?? 0, at.z ?? 0), _q.setFromEuler(_e), _s);
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(_m);
    this.items.push({ geo: g, tint });
    return this;
  }
}

/** Merge positions + normals (uv dropped) and return per-part vertex ranges. */
export function mergeParts(list: PartList): { geometry: BufferGeometry; ranges: { start: number; count: number; tint: Tint }[] } {
  let n = 0;
  for (const it of list.items) n += it.geo.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const ranges: { start: number; count: number; tint: Tint }[] = [];
  let o = 0;
  for (const it of list.items) {
    const p = it.geo.getAttribute('position') as BufferAttribute;
    const q = it.geo.getAttribute('normal') as BufferAttribute | undefined;
    pos.set(p.array as Float32Array, o * 3);
    if (q) nor.set(q.array as Float32Array, o * 3);
    ranges.push({ start: o, count: p.count, tint: it.tint });
    o += p.count;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new BufferAttribute(nor, 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, ranges };
}

/** Dim / hover / warning state for any lit material whose `color` is free (tint lives in vertex or instance colours). */
export class Fx {
  /** 0 = normal, 1 = fully receded (step focus). */
  dim = 0;
  /** 0..1 hover highlight. */
  hot = 0;
  /** 0..1 warning accent coloured by `warnTint` (bottlenecks). */
  warn = 0;
  warnTint: Tint | null = null;
  constructor(readonly mat: MeshStandardMaterial) {}

  apply(p: Palette): void {
    const dark = p.theme === 'dark';
    const k = this.dim * (dark ? 0.74 : 0.68);
    const m = this.mat;
    m.color.setScalar(1 - k);
    m.emissive.copy(p.bg).multiplyScalar(k * (dark ? 0.45 : 0.9));
    if (this.hot > 0) m.emissive.lerp(p.highlight, this.hot * (dark ? 0.34 : 0.22));
    if (this.warn > 0 && this.warnTint) m.emissive.lerp(this.warnTint(p), this.warn * (dark ? 0.45 : 0.32));
  }
}

export class Facility {
  readonly mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  readonly fx: Fx;
  private readonly ranges: { start: number; count: number; tint: Tint }[];

  constructor(list: PartList, params: MeshStandardMaterialParameters = {}, name = '') {
    const { geometry, ranges } = mergeParts(list);
    this.ranges = ranges;
    this.mesh = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08, ...params }));
    this.mesh.name = name;
    this.mesh.matrixAutoUpdate = false;
    this.fx = new Fx(this.mesh.material);
  }

  recolor(p: Palette): void {
    const attr = this.mesh.geometry.getAttribute('color') as BufferAttribute;
    const a = attr.array as Float32Array;
    for (const r of this.ranges) {
      const c = r.tint(p);
      for (let i = r.start; i < r.start + r.count; i++) {
        a[i * 3] = c.r;
        a[i * 3 + 1] = c.g;
        a[i * 3 + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
    this.fx.apply(p);
  }
}

/* ───────────────────────── transmission ───────────────────────── */

/** Pylon height (to the lower crossarm) and conductor layout: a triangular (delta) single circuit. */
export const PYLON = { h: 0.74, arm: 0.3, top: 0.9 };
/** Conductor attachment points in the pylon's local frame [right, up]: phases A, B (lower arm), C (top). */
export const PHASES: readonly (readonly [number, number])[] = [
  [-PYLON.arm, PYLON.h - 0.07],
  [PYLON.arm, PYLON.h - 0.07],
  [0, PYLON.top - 0.05],
];
export const GANTRY = { h: 0.56, half: 0.3 };
export const GANTRY_PHASES: readonly (readonly [number, number])[] = [
  [-0.2, GANTRY.h - 0.04],
  [0.2, GANTRY.h - 0.04],
  [0, GANTRY.h - 0.04],
];

/** A low-poly lattice tower, crossarm along local X (the line runs along local Z). */
export function pylonGeometry(): BufferGeometry {
  const L = new PartList();
  const t: Tint = () => new Color();
  const { h, arm, top } = PYLON;
  const b = 0.13;
  const w = 0.045;
  const legs: Vector3[][] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const a = new Vector3(sx * b, 0, sz * b);
      const c = new Vector3(sx * w, h, sz * w);
      legs.push([a, c]);
      L.add(beam(a, c, 0.022), t);
    }
  // X bracing on the four faces at two levels.
  const at = (sx: number, sz: number, y: number) => {
    const k = y / h;
    return new Vector3(sx * (b + (w - b) * k), y, sz * (b + (w - b) * k));
  };
  const levels = [0.04, 0.34, 0.6];
  for (let li = 0; li < levels.length - 1; li++) {
    const y0 = levels[li]!;
    const y1 = levels[li + 1]!;
    for (const s of [-1, 1]) {
      L.add(beam(at(-1, s, y0), at(1, s, y1), 0.012), t);
      L.add(beam(at(1, s, y0), at(-1, s, y1), 0.012), t);
      L.add(beam(at(s, -1, y0), at(s, 1, y1), 0.012), t);
      L.add(beam(at(s, 1, y0), at(s, -1, y1), 0.012), t);
    }
  }
  // Lower crossarm (two phases), the peak and the top arm (third phase).
  L.add(beam(new Vector3(-arm - 0.02, h, 0), new Vector3(arm + 0.02, h, 0), 0.03), t);
  L.add(beam(new Vector3(-arm, h, 0), new Vector3(-w, h - 0.09, 0), 0.014), t);
  L.add(beam(new Vector3(arm, h, 0), new Vector3(w, h - 0.09, 0), 0.014), t);
  L.add(beam(new Vector3(-w, h, 0), new Vector3(0, top, 0), 0.02), t);
  L.add(beam(new Vector3(w, h, 0), new Vector3(0, top, 0), 0.02), t);
  L.add(beam(new Vector3(-0.06, top - 0.02, 0), new Vector3(0.06, top - 0.02, 0), 0.02), t);
  // Insulator strings.
  for (const [x, y] of PHASES) L.add(cyl(0.012, 0.012, 0.07, 5), t, { x, y: y, z: 0 });
  return mergeParts(L).geometry;
}

/** A substation gantry (two posts + beam), crossbeam along local X. */
export function addGantry(L: PartList, tint: Tint, x: number, z: number, yaw: number): void {
  const { h, half } = GANTRY;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const pt = (lx: number, y: number) => new Vector3(x + lx * c, y, z - lx * s);
  L.add(beam(pt(-half, 0), pt(-half, h + 0.02), 0.035), tint);
  L.add(beam(pt(half, 0), pt(half, h + 0.02), 0.035), tint);
  L.add(beam(pt(-half - 0.03, h), pt(half + 0.03, h), 0.035), tint);
  for (const [px, py] of GANTRY_PHASES) L.add(cyl(0.01, 0.01, 0.05, 5), tint, { x: x + px * c, y: py, z: z - px * s });
}

export interface Support {
  x: number;
  z: number;
  /** Yaw of the crossarm frame (local X = crossarm, local Z = along the line). */
  yaw: number;
  kind: 'pylon' | 'gantry';
}

/** Supports along a polyline: gantries at both ends, pylons at interior points. Yaw bisects the turn. */
export function supportsFor(pts: readonly XZ[]): Support[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    // Local Z along the line → yaw = atan2(dx, dz).
    return { x: p[0], z: p[1], yaw: Math.atan2(dx, dz), kind: i === 0 || i === pts.length - 1 ? 'gantry' : 'pylon' };
  });
}

/** World position of phase k at a support. */
export function phasePoint(s: Support, k: number, out = new Vector3()): Vector3 {
  const [lx, ly] = (s.kind === 'pylon' ? PHASES : GANTRY_PHASES)[k]!;
  return out.set(s.x + lx * Math.cos(s.yaw), ly, s.z - lx * Math.sin(s.yaw));
}

/** Catenary (parabolic sag) samples from a to b. */
export function sagPoints(a: Vector3, b: Vector3, sag: number, n = 12): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(new Vector3().lerpVectors(a, b, t).add(new Vector3(0, -sag * 4 * t * (1 - t), 0)));
  }
  return out;
}

/** Conductors for a route: three phases per span → line-segment pairs; returns the phase-C path too. */
export function routeWires(sup: readonly Support[]): { segs: number[]; top: Vector3[] } {
  const segs: number[] = [];
  const top: Vector3[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i < sup.length - 1; i++) {
    const s0 = sup[i]!;
    const s1 = sup[i + 1]!;
    const span = Math.hypot(s1.x - s0.x, s1.z - s0.z);
    for (let k = 0; k < 3; k++) {
      const pts = sagPoints(phasePoint(s0, k, a), phasePoint(s1, k, b), 0.05 * span);
      for (let j = 0; j < pts.length - 1; j++) segs.push(pts[j]!.x, pts[j]!.y, pts[j]!.z, pts[j + 1]!.x, pts[j + 1]!.y, pts[j + 1]!.z);
      if (k === 2) top.push(...(i === 0 ? pts : pts.slice(1)));
    }
  }
  return { segs, top };
}

/* ───────────────────────── misc ───────────────────────── */

/** Grid lines over a rectangle, alpha fading toward the edges (vertex RGBA). */
export function plateGrid(w: number, d: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 12;
  const f = (x: number, z: number) => {
    const ex = 1 - Math.abs(x) / (w / 2);
    const ez = 1 - Math.abs(z) / (d / 2);
    return Math.min(1, Math.min(ex, ez) * 5) ** 1.5;
  };
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++)
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        fade.push(f(x, z));
      }
  };
  for (let x = -w / 2 + step; x < w / 2 - 1e-6; x += step) add(x, -d / 2, x, d / 2);
  for (let z = -d / 2 + step; z < d / 2 - 1e-6; z += step) add(-w / 2, z, w / 2, z);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  return {
    geometry,
    recolor(c: Color, alpha: number) {
      const attr = geometry.getAttribute('color') as BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}


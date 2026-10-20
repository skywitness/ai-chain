/**
 * network — shared helpers for the three variant builders (scaleUp.ts, scaleOut.ts, cpo.ts):
 * the builder contract, a faded floor grid with a contact glow, one-draw-call polylines with
 * per-line colour/alpha, instancing helpers and small easing utilities.
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import type { CameraPose, CardContent, Palette, SceneContext, SceneInstance } from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';

/** What every variant builder returns. */
export interface Built extends SceneInstance {
  /** World point near the stage centre, used for cards of hotspots that live in another variant. */
  anchor: readonly [number, number, number];
}
export type Builder = (ctx: SceneContext) => Built;

/** The step id for a step index (meta.json order); 'overview' when out of range. */
export const stepIdOf = (ctx: SceneContext, i: number): string => ctx.json.steps?.[i]?.id ?? 'overview';

/** Text of a meta.json hotspot (label / detail) so 3D cards and the HTML list never diverge. */
export function hotspotText(ctx: SceneContext, id: string): { label: string; detail: string } {
  const h = ctx.json.hotspots?.find((x) => x.id === id);
  return { label: h?.label ?? id, detail: h?.detail ?? '' };
}

/** A card for a meta.json hotspot plus a 「名詞解釋」 link when it names a glossary term. */
export function hotspotCard(ctx: SceneContext, id: string, extra: Partial<CardContent> = {}): CardContent {
  const h = ctx.json.hotspots?.find((x) => x.id === id);
  const c: CardContent = { title: h?.label ?? id };
  if (h?.detail) c.body = h.detail;
  if (h?.glossary) {
    c.href = `/glossary/#${h.glossary}`;
    c.linkLabel = '名詞解釋 →';
  }
  return { ...c, ...extra };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

export const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

/* ───────────────────────── instancing ───────────────────────── */

const M4 = new Matrix4();
const Q = new Quaternion();
const S = new Vector3();
const UP = new Vector3(0, 1, 0);
const DIR = new Vector3();
const MID = new Vector3();

/** An InstancedMesh whose disposal is tracked; instance colours start white (material colour). */
export function instanced(ctx: SceneContext, geo: BufferGeometry, mat: Material, count: number, colors = false): InstancedMesh {
  const m = new InstancedMesh(geo, mat, Math.max(1, count));
  if (colors) for (let i = 0; i < count; i++) m.setColorAt(i, WHITE);
  ctx.track({ dispose: () => m.dispose() });
  return m;
}
const WHITE = new Color(1, 1, 1);

export function placeAt(mesh: InstancedMesh, i: number, p: Vector3, scale = 1, rotY = 0): void {
  Q.setFromAxisAngle(UP, rotY);
  mesh.setMatrixAt(i, M4.compose(p, Q, S.setScalar(scale)));
}

/** Orient a unit cylinder (height 1 along +Y, radius 1) from a to b with radius r. */
export function placeLink(mesh: InstancedMesh, i: number, a: Vector3, b: Vector3, r: number): void {
  DIR.subVectors(b, a);
  const len = Math.max(1e-4, DIR.length());
  MID.addVectors(a, b).multiplyScalar(0.5);
  Q.setFromUnitVectors(UP, DIR.multiplyScalar(1 / len));
  mesh.setMatrixAt(i, M4.compose(MID, Q, S.set(r, len, r)));
}

export function commit(mesh: InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
}

/** Mark a static object (and its children) as not needing matrix updates. */
export function freeze(o: Object3D): void {
  o.updateMatrixWorld(true);
  o.traverse((c) => {
    c.matrixAutoUpdate = false;
  });
}

/* ───────────────────────── polylines ───────────────────────── */

/**
 * Many polylines in ONE LineSegments with per-line RGBA (vertex colours with alpha). Lines can be
 * recoloured / faded individually; call `commit()` after a batch of `set()` calls.
 */
export class Polylines {
  readonly object: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly ranges: [number, number][] = [];
  private readonly col: Float32BufferAttribute;

  constructor(ctx: SceneContext, lines: readonly (readonly Vector3[])[]) {
    const pos: number[] = [];
    for (const l of lines) {
      const start = pos.length / 3;
      for (let i = 0; i < l.length - 1; i++) {
        const a = l[i]!;
        const b = l[i + 1]!;
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      this.ranges.push([start, pos.length / 3 - start]);
    }
    const g = ctx.track(new BufferGeometry());
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.col = new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
    g.setAttribute('color', this.col);
    g.computeBoundingSphere();
    const m = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    this.object = new LineSegments(g, m);
  }

  get count(): number {
    return this.ranges.length;
  }

  set(i: number, c: Color, a: number): void {
    const r = this.ranges[i];
    if (!r) return;
    const arr = this.col.array as Float32Array;
    for (let v = r[0]; v < r[0] + r[1]; v++) {
      arr[v * 4] = c.r;
      arr[v * 4 + 1] = c.g;
      arr[v * 4 + 2] = c.b;
      arr[v * 4 + 3] = a;
    }
  }

  commit(): void {
    this.col.needsUpdate = true;
  }
}

/** Sample a polyline into a rounded path: every inner corner becomes a short quadratic bend. */
export function rounded(points: readonly Vector3[], r = 0.08, steps = 4): Vector3[] {
  if (points.length < 3) return points.map((p) => p.clone());
  const out: Vector3[] = [points[0]!.clone()];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const d0 = p1.distanceTo(p0);
    const d1 = p1.distanceTo(p2);
    const rr = Math.min(r, d0 * 0.45, d1 * 0.45);
    a.subVectors(p0, p1).normalize().multiplyScalar(rr).add(p1);
    b.subVectors(p2, p1).normalize().multiplyScalar(rr).add(p1);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push(
        new Vector3(
          u * u * a.x + 2 * u * t * p1.x + t * t * b.x,
          u * u * a.y + 2 * u * t * p1.y + t * t * b.y,
          u * u * a.z + 2 * u * t * p1.z + t * t * b.z,
        ),
      );
    }
  }
  out.push(points[points.length - 1]!.clone());
  return out;
}

/* ───────────────────────── floor ───────────────────────── */

/**
 * A rectangular grid of short segments whose alpha fades towards the edges (elliptical falloff),
 * plus a soft radial contact glow underneath the subject. Returns a palette re-tinter.
 */
export function addFloor(
  ctx: SceneContext,
  parent: Object3D,
  opts: { w: number; d: number; step: number; y?: number; cx?: number; cz?: number; glow?: [number, number] },
): { apply(p: Palette): void } {
  const { w, d, step } = opts;
  const y = opts.y ?? 0;
  const cx = opts.cx ?? 0;
  const cz = opts.cz ?? 0;
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const push = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(cx + x, y, cz + z);
        const r = Math.hypot(x / (w / 2), z / (d / 2));
        fade.push(Math.max(0, 1 - r * r) ** 1.5);
      }
    }
  };
  const nx = Math.floor(w / 2 / step);
  const nz = Math.floor(d / 2 / step);
  for (let i = -nx; i <= nx; i++) push(i * step, -d / 2, i * step, d / 2);
  for (let i = -nz; i <= nz; i++) push(-w / 2, i * step, w / 2, i * step);
  const g = ctx.track(new BufferGeometry());
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const col = new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
  g.setAttribute('color', col);
  const mat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const grid = new LineSegments(g, mat);
  grid.renderOrder = -2;
  parent.add(grid);

  const tex = ctx.track(radialTexture(256));
  const sm = ctx.track(new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  const [gw, gd] = opts.glow ?? [w * 0.7, d * 0.7];
  const glow = new Mesh(ctx.track(new PlaneGeometry(gw, gd)), sm);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(cx, y + 0.002, cz);
  glow.renderOrder = -1;
  parent.add(glow);

  const c = new Color();
  return {
    apply(p: Palette) {
      const dark = p.theme === 'dark';
      c.copy(p.grid).lerp(p.fg, dark ? 0.1 : 0.05);
      const a = dark ? 0.6 : 0.8;
      const arr = col.array as Float32Array;
      for (let i = 0; i < fade.length; i++) {
        arr[i * 4] = c.r;
        arr[i * 4 + 1] = c.g;
        arr[i * 4 + 2] = c.b;
        arr[i * 4 + 3] = (fade[i] ?? 0) * a;
      }
      col.needsUpdate = true;
      sm.color.copy(dark ? p.flow : p.fg);
      sm.opacity = dark ? 0.07 : 0.06;
    },
  };
}

/** A pose helper: spherical offset (azimuth from +Z towards +X, elevation) around a target. */
export function orbitPose(target: readonly [number, number, number], dist: number, azDeg: number, elDeg: number, fov?: number): CameraPose {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const [tx, ty, tz] = target;
  const pose: CameraPose = {
    position: [tx + dist * Math.cos(el) * Math.sin(az), ty + dist * Math.sin(el), tz + dist * Math.cos(el) * Math.cos(az)],
    target: [tx, ty, tz],
  };
  if (fov !== undefined) pose.fov = fov;
  return pose;
}

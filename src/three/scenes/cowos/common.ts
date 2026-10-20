/**
 * cowos — shared helpers: theme colours derived from the palette (no hex), the floor, grids whose
 * instance order lets a quality tier draw a regular subset, and small maths utilities.
 */
import {
  BufferGeometry,
  DirectionalLight,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type CanvasTexture,
  type InstancedMesh,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import type { StudioLights } from '../../core/lights';
import type { Palette, QualityTier, SceneContext } from '../../core/types';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';

/* ───────────────────────── colours ───────────────────────── */

/** Material colours for package parts, all derived from palette tokens. */
export interface PartColors {
  silicon: Color;
  siliconDeep: Color;
  logic: Color;
  hbm: Color;
  hbmBase: Color;
  mask: Color;
  abf: Color;
  core: Color;
  copper: Color;
  solder: Color;
  organic: Color;
  lsi: Color;
  metal: Color;
  dielectric: Color;
}

const mix = (a: Color, b: Color, k: number) => a.clone().lerp(b, k);

export function partColors(p: Palette): PartColors {
  const dark = p.theme === 'dark';
  const silicon = dark ? mix(p.muted, p.fg, 0.32).lerp(p.coolant, 0.08) : mix(p.fg, p.bg, 0.5).lerp(p.coolant, 0.08);
  const green = p.seg['foundation-models'];
  return {
    silicon,
    siliconDeep: dark ? mix(p.muted, p.bg, 0.25) : mix(p.fg, p.bg, 0.3),
    logic: dark ? mix(p.seg['ai-accelerators'], silicon, 0.22) : mix(p.seg['ai-accelerators'], silicon, 0.2),
    hbm: dark ? mix(p.seg['memory-storage'], silicon, 0.16) : mix(p.seg['memory-storage'], silicon, 0.12),
    hbmBase: dark ? mix(p.muted, p.fg, 0.15) : mix(p.fg, p.bg, 0.38),
    // Solder-mask green, kept muted: the substrate is context, the dies are the subject.
    mask: dark ? mix(green, p.bg, 0.6).lerp(p.muted, 0.3) : mix(green, p.muted, 0.45).lerp(p.fg, 0.35),
    abf: dark ? mix(green, p.bg, 0.4).lerp(p.fg, 0.1) : mix(green, p.bg, 0.25).lerp(p.muted, 0.25),
    core: dark ? mix(p.muted, p.bg, 0.15) : mix(p.muted, p.bg, 0.25),
    // Copper leans red-brown (heat) and is muted, so wiring and vias never read as the amber power flow.
    copper: dark ? mix(p.heat, p.muted, 0.3).lerp(p.power, 0.12) : mix(p.heat, p.fg, 0.22).lerp(p.power, 0.1),
    solder: dark ? mix(p.fg, p.muted, 0.38) : mix(p.fg, p.bg, 0.6).lerp(p.muted, 0.15),
    organic: dark ? mix(p.power, p.bg, 0.42) : mix(p.power, p.bg, 0.28),
    lsi: dark ? mix(p.optic, p.fg, 0.3) : mix(p.optic, p.fg, 0.15),
    metal: dark ? mix(p.fg, p.bg, 0.55) : mix(p.fg, p.bg, 0.6),
    dielectric: dark ? mix(p.coolant, p.fg, 0.35) : mix(p.coolant, p.bg, 0.2),
  };
}

/* ───────────────────────── highlight ───────────────────────── */

/**
 * Emissive "hot" tint for hotspot highlights. Each part keeps a 0..1 heat value; `apply()` writes
 * emissive = highlight × heat × k (re-run on theme changes).
 */
export class Heat {
  private parts = new Map<string, { mats: MeshStandardMaterial[]; v: number; tween: { cancel(): void } | null }>();
  constructor(private readonly ctx: SceneContext) {}

  add(id: string, mats: MeshStandardMaterial[]): void {
    const cur = this.parts.get(id);
    if (cur) cur.mats.push(...mats);
    else this.parts.set(id, { mats: [...mats], v: 0, tween: null });
  }

  set(id: string, on: boolean): void {
    const e = this.parts.get(id);
    if (!e) return;
    e.tween?.cancel();
    const from = e.v;
    const to = on ? 1 : 0;
    e.tween = this.ctx.tween.run(
      (k) => {
        e.v = from + (to - from) * k;
        this.paint(id);
      },
      { duration: 200, ease: 'cubicOut', fade: true },
    );
  }

  private paint(id: string): void {
    const e = this.parts.get(id);
    if (!e) return;
    const p = this.ctx.palette;
    const k = (p.theme === 'dark' ? 0.42 : 0.3) * e.v;
    for (const m of e.mats) m.emissive.copy(p.highlight).multiplyScalar(k);
  }

  apply(): void {
    for (const id of this.parts.keys()) this.paint(id);
  }

  dispose(): void {
    for (const e of this.parts.values()) e.tween?.cancel();
  }
}

/* ───────────────────────── grids ───────────────────────── */

/**
 * Points of a regular grid, ordered so that prefixes are regular subsets:
 * [even/even] (double pitch) → [odd/odd] (with the first: a checkerboard) → the rest.
 */
export interface OrderedGrid {
  pts: [number, number][];
  quarter: number;
  half: number;
}

export function orderedGrid(x0: number, x1: number, z0: number, z1: number, pitch: number, keep?: (x: number, z: number) => boolean): OrderedGrid {
  const nx = Math.max(1, Math.floor((x1 - x0) / pitch + 1e-6) + 1);
  const nz = Math.max(1, Math.floor((z1 - z0) / pitch + 1e-6) + 1);
  const ox = (x0 + x1) / 2 - ((nx - 1) * pitch) / 2;
  const oz = (z0 + z1) / 2 - ((nz - 1) * pitch) / 2;
  const cls: [number, number][][] = [[], [], [], []];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const x = ox + i * pitch;
      const z = oz + j * pitch;
      if (keep && !keep(x, z)) continue;
      const c = i % 2 === 0 && j % 2 === 0 ? 0 : i % 2 === 1 && j % 2 === 1 ? 1 : 2 + (i % 2);
      cls[c]!.push([x, z]);
    }
  return { pts: cls.flat(), quarter: cls[0]!.length, half: cls[0]!.length + cls[1]!.length };
}

/** Concatenate grids keeping the tier-subset property (all quarters, then the halves, then the rest). */
export function joinGrids(grids: OrderedGrid[]): OrderedGrid {
  const a: [number, number][] = [];
  const b: [number, number][] = [];
  const c: [number, number][] = [];
  for (const g of grids) {
    a.push(...g.pts.slice(0, g.quarter));
    b.push(...g.pts.slice(g.quarter, g.half));
    c.push(...g.pts.slice(g.half));
  }
  return { pts: [...a, ...b, ...c], quarter: a.length, half: a.length + b.length };
}

/** How many grid instances a tier draws: high = all, medium = checkerboard, low = double pitch. */
export function tierCount(g: OrderedGrid, tier: QualityTier): number {
  if (tier.particles >= 0.99) return g.pts.length;
  if (tier.particles >= 0.4) return g.half;
  return g.quarter;
}

const m4 = new Matrix4();
const q0 = new Quaternion();
const vp = new Vector3();
const vs = new Vector3();

/** Write translation + scale matrices for a grid at height y. */
export function placeGrid(mesh: InstancedMesh, g: OrderedGrid, y: number, sx = 1, sy = 1, sz = sx): void {
  g.pts.forEach(([x, z], i) => mesh.setMatrixAt(i, m4.compose(vp.set(x, y, z), q0, vs.set(sx, sy, sz))));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

export function setMatrix(mesh: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  mesh.setMatrixAt(i, m4.compose(vp.set(x, y, z), q0, vs.set(sx, sy, sz)));
}

/* ───────────────────────── floor ───────────────────────── */

export interface Floor {
  group: Group;
  apply(p: Palette): void;
}

/** A faded square grid plus a soft contact shadow (as in chain-panorama). */
export function buildFloor(ctx: SceneContext, radius: number, step: number, shadowW: number, shadowD: number): Floor {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++)
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.hypot(x, z * 1.25) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.7);
      }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const geo = ctx.track(new BufferGeometry());
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const col = new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
  geo.setAttribute('color', col);
  const mat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const lines = new LineSegments(geo, mat);
  lines.renderOrder = -2;
  const shadowTex = ctx.track(radialTexture(256));
  const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(shadowW, shadowD)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.004;
  shadow.renderOrder = -1;
  const group = new Group();
  group.add(lines, shadow);
  return {
    group,
    apply(p) {
      const dark = p.theme === 'dark';
      const c = p.grid.clone().lerp(p.fg, dark ? 0.1 : 0.05);
      const a = dark ? 0.6 : 0.85;
      for (let i = 0; i < fade.length; i++) col.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * a);
      col.needsUpdate = true;
      shadowMat.color.copy(dark ? p.bg.clone().lerp(p.fg, 0.04) : p.fg);
      shadowMat.opacity = dark ? 0.55 : 0.16;
      if (dark) shadowMat.color.multiplyScalar(0.2);
    },
  };
}

/* ───────────────────────── die floorplan texture ───────────────────────── */

/**
 * A neutral (white/grey) multiply map that hints at a logic die's floorplan (示意): compute tiles,
 * a central cache/crossbar band, HBM PHY strips on the long edges (v = 0 / 1) and a die-to-die
 * strip on the +u edge, inside a seal ring. Theme colour comes from the material colour.
 */
export function floorplanTexture(): CanvasTexture {
  return canvasTexture(512, 404, (g, w, h) => {
    g.fillStyle = 'rgb(255,255,255)';
    g.fillRect(0, 0, w, h);
    const ink = (a: number) => `rgba(0,0,0,${a})`;
    const pad = 16;
    const phy = 20;
    const d2d = 26;
    g.fillStyle = ink(0.13);
    g.fillRect(pad + 30, pad, w - 2 * pad - d2d - 60, phy - 6); // HBM PHY (top edge)
    g.fillRect(pad + 30, h - pad - phy + 6, w - 2 * pad - d2d - 60, phy - 6); // HBM PHY (bottom edge)
    g.fillStyle = ink(0.16);
    g.fillRect(w - pad - d2d + 6, pad + 40, d2d - 10, h - 2 * pad - 80); // die-to-die link
    const x0 = pad + 6;
    const x1 = w - pad - d2d - 4;
    const band = h * 0.15;
    const top = pad + phy + 4;
    const bottom = h - pad - phy - 4;
    const mid = (top + bottom) / 2;
    g.fillStyle = ink(0.1);
    g.fillRect(x0, mid - band / 2, x1 - x0, band);
    const cols = 8;
    const gap = 6;
    const cw = (x1 - x0 - gap * (cols - 1)) / cols;
    for (const [y0, y1] of [
      [top, mid - band / 2 - gap],
      [mid + band / 2 + gap, bottom],
    ] as const) {
      const rows = 2;
      const rh = (y1 - y0 - gap * (rows - 1)) / rows;
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++) {
          g.fillStyle = ink(0.05 + ((c + r) % 3) * 0.012);
          g.fillRect(x0 + c * (cw + gap), y0 + r * (rh + gap), cw, rh);
        }
    }
    g.strokeStyle = ink(0.2);
    g.lineWidth = 3;
    g.strokeRect(pad / 2, pad / 2, w - pad, h - pad);
  });
}

/* ───────────────────────── misc ───────────────────────── */

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Make a mesh pick-only (invisible but raycastable, per the picker contract). */
export function pickProxy(mesh: Mesh): Mesh {
  (mesh.material as Material).visible = false;
  return mesh;
}

/**
 * The studio rim light (behind-left) mirrors straight into the camera off large flat die tops in
 * this scene's low three-quarter views. Keep it as an edge accent only. Call after `lights.apply`.
 */
export function dampRim(lights: StudioLights, k = 0.4): void {
  const rim = lights.group.children[2];
  if (rim instanceof DirectionalLight) rim.intensity *= k;
}

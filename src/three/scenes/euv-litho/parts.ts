/**
 * euv-litho geometry and texture builders (scene-private). Everything is procedural; textures are
 * greyscale masks tinted by palette-bound material colours, or redrawn from palette CSS colours.
 */
import {
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  Matrix4,
  Quaternion,
  RingGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { canvasTexture } from '../../kit/canvasTex';
import type { OpticEl } from './optics';

const Y = new Vector3(0, 1, 0);
const Zf = new Vector3(0, 0, 1);
const m4 = new Matrix4();
const q = new Quaternion();

/** Concatenate geometries (non-indexed; position + normal only) into one static buffer. */
export function mergeStatic(geos: BufferGeometry[]): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      else nrm.push(0, 1, 0);
    }
    if (g !== g0) g.dispose();
    g0.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

/** Place a geometry: rotate local +Y onto `dir`, then translate to `at`. */
export function placeY(g: BufferGeometry, dir: Vector3, at: Vector3): BufferGeometry {
  q.setFromUnitVectors(Y, dir.clone().normalize());
  return g.applyMatrix4(m4.compose(at, q, new Vector3(1, 1, 1)));
}

/** A box with softly rounded edges (technical-diorama look). */
export function box(w: number, h: number, d: number, at: Vector3 | readonly [number, number, number], radius = 0.03): BufferGeometry {
  const r = Math.min(radius, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.max(0.001, r));
  const p = at instanceof Vector3 ? at : new Vector3(at[0], at[1], at[2]);
  g.translate(p.x, p.y, p.z);
  return g;
}

/** Cylinder between two points. */
export function rod(a: Vector3, b: Vector3, r: number, seg = 12, open = false): BufferGeometry {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new CylinderGeometry(r, r, len, seg, 1, open);
  return placeY(g, dir, a.clone().add(b).multiplyScalar(0.5));
}

/**
 * Mirror substrate behind the reflective face of an element (disc, or a ring with a central hole).
 * The face sits at the element position; the substrate extends behind it along −n.
 */
export function mirrorSubstrate(e: OpticEl, thickness: number): BufferGeometry {
  const R = e.size ?? 0.3;
  let g: BufferGeometry;
  if (e.hole) {
    const h = e.hole;
    const pts = [new Vector2(h, -thickness / 2), new Vector2(R, -thickness / 2), new Vector2(R, thickness / 2), new Vector2(h, thickness / 2), new Vector2(h, -thickness / 2)];
    g = new LatheGeometry(pts, 48);
  } else g = new CylinderGeometry(R, R * 0.97, thickness, 40);
  return placeY(g, e.n, e.pos.clone().addScaledVector(e.n, -thickness / 2 - 0.004));
}

/** The reflective face (local geometry facing +Z; place the mesh with `orientFace`). */
export function mirrorFace(e: OpticEl): BufferGeometry {
  const R = (e.size ?? 0.3) * 0.98;
  return e.hole ? new RingGeometry(e.hole, R, 56, 1) : new CircleGeometry(R, 48);
}

export function orientFace(obj: { position: Vector3; quaternion: Quaternion }, e: OpticEl, lift = 0.002): void {
  obj.position.copy(e.pos).addScaledVector(e.n, lift);
  obj.quaternion.setFromUnitVectors(Zf, e.n);
}

/**
 * Collector: an ellipsoidal dish (approximated by a paraboloid) with a central hole for the laser,
 * opening along `axis`. Returns the coating (inner) and the back shell.
 */
export function collectorGeometry(at: Vector3, axis: Vector3, R: number, hole: number): { face: BufferGeometry; back: BufferGeometry } {
  const depth = (r: number) => (r * r) / 2.1;
  const inner: Vector2[] = [];
  const outer: Vector2[] = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const r = hole + ((R - hole) * i) / n;
    inner.push(new Vector2(r, depth(r)));
  }
  for (let i = n; i >= 0; i--) {
    const r = hole + ((R - hole) * i) / n;
    outer.push(new Vector2(r + 0.02, depth(r) - 0.07));
  }
  const back = new LatheGeometry([...inner.slice(-1), ...outer, inner[0]!], 56);
  const face = new LatheGeometry(inner, 56);
  // The dish vertex (hole) sits at the collector position, opening toward +axis.
  for (const g of [face, back]) placeY(g, axis, at.clone().addScaledVector(axis, -depth(hole)));
  return { face, back };
}

/* ───────── floor grid (alpha fades with distance) ───────── */

export function floorGrid(rx: number, rz: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.hypot(x / rx, z / rz);
        fade.push(Math.max(0, 1 - r * r) ** 1.5);
      }
    }
  };
  for (let x = -rx; x <= rx + 1e-6; x += step) add(x, -rz, x, rz);
  for (let z = -rz; z <= rz + 1e-6; z += step) add(-rx, z, rx, z);
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

/** Edges of an axis-aligned box as line-segment positions. */
export function boxEdges(min: Vector3, max: Vector3): Float32BufferAttribute {
  const c = (i: number) => new Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
  const pairs = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const out: number[] = [];
  for (const [a, b] of pairs) {
    const pa = c(a!);
    const pb = c(b!);
    out.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
  }
  return new Float32BufferAttribute(out, 3);
}

/* ───────── textures (greyscale masks; white = full tint) ───────── */

/**
 * Wafer: exposure fields (26 mm across the slit × 33 mm, or 16.5 mm for a High-NA half field,
 * along the scan direction = texture u / world x) on a 300 mm disc, a notch, faint dies.
 */
export function drawWafer(tex: CanvasTexture, halfField: boolean): void {
  const c = tex.image as HTMLCanvasElement;
  const g = c.getContext('2d');
  if (!g) return;
  const S = c.width;
  const mm = S / 300;
  g.clearRect(0, 0, S, S);
  g.save();
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
  g.clip();
  const grd = g.createRadialGradient(S * 0.42, S * 0.38, S * 0.05, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgb(255,255,255)');
  grd.addColorStop(1, 'rgb(208,208,208)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const fx = (halfField ? 16.5 : 33) * mm; // scan direction (u → world x)
  const fz = 26 * mm;
  const ox = S / 2 - fx / 2;
  const oz = S / 2 - fz / 2;
  g.lineWidth = Math.max(1, S / 512);
  for (let i = -12; i <= 12; i++) {
    for (let j = -8; j <= 8; j++) {
      const x = ox + i * fx;
      const y = oz + j * fz;
      const cx = x + fx / 2 - S / 2;
      const cy = y + fz / 2 - S / 2;
      if (Math.hypot(Math.abs(cx) + fx / 2, Math.abs(cy) + fz / 2) > S / 2 - 3 * mm) continue;
      g.fillStyle = 'rgb(186,186,186)';
      g.fillRect(x + 1, y + 1, fx - 2, fz - 2);
      // dies inside each field (2 × 2 for a full field, 1 × 2 for a half field)
      g.strokeStyle = 'rgb(150,150,150)';
      const dx = halfField ? 1 : 2;
      for (let a = 0; a < dx; a++)
        for (let b = 0; b < 2; b++) g.strokeRect(x + 2 + (a * (fx - 4)) / dx, y + 2 + (b * (fz - 4)) / 2, (fx - 4) / dx - 2, (fz - 4) / 2 - 2);
    }
  }
  g.restore();
  // notch
  g.fillStyle = 'rgba(0,0,0,0)';
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.arc(S / 2, S - 1, 3 * mm, 0, Math.PI * 2);
  g.fill();
  g.globalCompositeOperation = 'source-over';
  tex.needsUpdate = true;
}

export function waferTexture(halfField: boolean): CanvasTexture {
  const t = canvasTexture(512, 512, () => {});
  drawWafer(t, halfField);
  return t;
}

/** Reflective EUV mask, pattern side: Mo/Si multilayer (white) with absorber patterns (dark). */
export function reticleTexture(rng: () => number): CanvasTexture {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = 'rgb(70,70,70)'; // absorber border (black border region)
    g.fillRect(0, 0, w, h);
    const mx = w * 0.16;
    const my = h * 0.08;
    g.fillStyle = 'rgb(255,255,255)';
    g.fillRect(mx, my, w - 2 * mx, h - 2 * my);
    // blocks of lines and rectangles (circuit-like pattern, illustrative)
    g.fillStyle = 'rgb(92,92,92)';
    const cols = 4;
    const rows = 5;
    const cw = (w - 2 * mx) / cols;
    const rh = (h - 2 * my) / rows;
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const x0 = mx + i * cw + 3;
        const y0 = my + j * rh + 3;
        const kind = Math.floor(rng() * 3);
        if (kind === 0) for (let k = 0; k < cw - 8; k += 4) g.fillRect(x0 + k, y0, 2, rh - 6);
        else if (kind === 1) for (let k = 0; k < rh - 8; k += 4) g.fillRect(x0, y0 + k, cw - 6, 2);
        else
          for (let k = 0; k < 6; k++)
            g.fillRect(x0 + rng() * (cw - 16), y0 + rng() * (rh - 12), 4 + rng() * 10, 3 + rng() * 6);
      }
  });
}

/** World size of a comparison coupon (x = scan direction, z = slit direction). */
export const COUPON = { w: 1.15, d: 0.92, field: 0.62 };

/**
 * Comparison coupon: one exposure field (full 26 × 33 mm or High-NA half 26 × 16.5 mm) filled with
 * a line/space pattern whose pitch scales with 1/NA (示意). The canvas has the coupon's aspect, so
 * the field keeps its true 26 : 33 (or 26 : 16.5) proportions on screen.
 */
export function couponTexture(halfField: boolean, pitch: number): CanvasTexture {
  const H = 256;
  const W = Math.round((H * COUPON.w) / COUPON.d);
  return canvasTexture(W, H, (g, w, h) => {
    g.fillStyle = 'rgb(205,205,205)';
    g.fillRect(0, 0, w, h);
    // field: scan direction along u (x), slit direction along v (z)
    const fz = h * COUPON.field;
    const fx = (fz * (halfField ? 16.5 : 33)) / 26;
    const x0 = (w - fx) / 2;
    const y0 = (h - fz) / 2;
    g.fillStyle = 'rgb(255,255,255)';
    g.fillRect(x0, y0, fx, fz);
    g.fillStyle = 'rgb(95,95,95)';
    for (let x = x0 + pitch * 0.5; x < x0 + fx - pitch * 0.4; x += pitch) g.fillRect(x, y0 + 6, pitch / 2, fz - 12);
    g.strokeStyle = 'rgb(40,40,40)';
    g.lineWidth = 3;
    g.strokeRect(x0, y0, fx, fz);
  });
}

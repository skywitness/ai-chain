/**
 * euv-litho optical layout: the EUV light path as an ordered list of optical elements in the
 * diorama's XY plane (z = 0; x to the right, y up), plus the ray / beam geometry derived from it.
 *
 * Order (both variants): plasma → collector → intermediate focus (IF) → field facet mirror →
 * pupil facet mirror → fold mirror → reflective reticle → projection optics (6 mirrors) → wafer.
 *  - euv:     NXE-style unobscured 6-mirror projection, NA 0.33, image side telecentric (M6 above
 *             the wafer).
 *  - high-na: EXE-style anamorphic projection, NA 0.55, larger mirrors, an intermediate image at the
 *             hole of M6 and a central obscuration (M5 and M6 have central holes; light reaches
 *             the wafer through the hole in M5).
 * Mirror orientations are never hand-tuned: each normal is the bisector of the incoming and
 * outgoing chief rays (law of reflection). Angles and proportions are schematic (示意).
 */
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

export type Variant = 'euv' | 'high-na';
export const NA: Record<Variant, number> = { euv: 0.33, 'high-na': 0.55 };
/** Reticle-to-wafer reduction in the scan direction (the stages move at this speed ratio). */
export const SCAN_MAG: Record<Variant, number> = { euv: 4, 'high-na': 8 };

export interface OpticEl {
  id: string;
  pos: Vector3;
  /** Beam half-width on this element (0 = a focus or the source point). */
  r: number;
  /** Inner edge of an annular footprint (central obscuration). */
  rIn?: number;
  /** Physical mirror radius and central hole (mirrors only). */
  size?: number;
  hole?: number;
  mirror: boolean;
  /** Surface normal (mirrors: bisector; wafer: up). */
  n: Vector3;
  /** In-plane tangent × orientation sign (ray / ring parameterisation). */
  t: Vector3;
}

const v = (x: number, y: number) => new Vector3(x, y, 0);

/* ───────── shared upstream geometry ───────── */
export const COLLECTOR = v(-4.4, -1.0);
export const IF_POS = v(-2.61, 1.29);
/** Source axis: collector → intermediate focus. */
export const AXIS = IF_POS.clone().sub(COLLECTOR).normalize();
/** Droplet stream direction (perpendicular to the axis, in plane; generator side). */
export const DROP_DIR = new Vector3(-AXIS.y, AXIS.x, 0);
export const PLASMA = COLLECTOR.clone().addScaledVector(AXIS, 0.62);
export const GENERATOR = PLASMA.clone().addScaledVector(DROP_DIR, 0.95);
export const CATCHER = PLASMA.clone().addScaledVector(DROP_DIR, -0.78);
/** CO₂ beam: laser exit → turning mirror (behind the collector) → plasma (through the hole). */
export const TURN = COLLECTOR.clone().addScaledVector(AXIS, -0.78);
export const LASER_EXIT = v(-5.5, TURN.y);
export const LASER_BOX = { x: -6.15, w: 1.3, h: 0.44, d: 0.6 };

export const RETICLE = v(0.9, 3.0);
/** Visual chief-ray angle at the reticle (real tools: about 6°; exaggerated so parts don't touch). */
const RET_ANGLE = (13 * Math.PI) / 180;
const FOLD = RETICLE.clone().add(v(-Math.sin(RET_ANGLE) * 1.45, -Math.cos(RET_ANGLE) * 1.45));
const M1 = RETICLE.clone().add(v(Math.sin(RET_ANGLE) * 1.3, -Math.cos(RET_ANGLE) * 1.3));

export const WAFER = v(1.95, -2.05);
export const WAFER_R = 0.8;
export const RETICLE_SIZE = 0.81; // 152 mm mask at the wafer scale (300 mm → 1.6)

interface Spec {
  id: string;
  p: Vector3;
  r: number;
  rIn?: number;
  size?: number;
  hole?: number;
  mirror?: boolean;
}

const UP: Spec[] = [
  { id: 'plasma', p: PLASMA, r: 0 },
  { id: 'collector', p: COLLECTOR, r: 0.62, size: 0.72, hole: 0.13, mirror: true },
  { id: 'if', p: IF_POS, r: 0 },
  { id: 'ffm', p: v(-1.5, 2.75), r: 0.42, mirror: true },
  { id: 'pfm', p: v(-0.55, 0.95), r: 0.3, mirror: true },
  { id: 'fold', p: FOLD, r: 0.2, size: 0.25, mirror: true },
  { id: 'reticle', p: RETICLE, r: 0.16, mirror: true },
];

const tanNA = (na: number) => Math.tan(Math.asin(na));

const POB: Record<Variant, Spec[]> = {
  euv: [
    { id: 'm1', p: M1, r: 0.2, mirror: true },
    { id: 'm2', p: v(2.85, 2.1), r: 0.27, mirror: true },
    { id: 'm3', p: v(2.35, 0.75), r: 0.22, mirror: true },
    { id: 'm4', p: v(0.8, 0.45), r: 0.26, mirror: true },
    { id: 'm5', p: v(0.72, -1.15), r: 0.15, mirror: true },
    // M6 directly above the wafer: the final cone's half-angle is asin(NA).
    { id: 'm6', p: v(1.95, -0.3), r: (2.05 - 0.3) * tanNA(NA.euv), mirror: true },
    { id: 'wafer', p: WAFER, r: 0 },
  ],
  'high-na': [
    { id: 'm1', p: M1, r: 0.26, mirror: true },
    { id: 'm2', p: v(2.98, 2.28), r: 0.36, mirror: true },
    { id: 'm3', p: v(2.78, 0.82), r: 0.32, mirror: true },
    { id: 'm4', p: v(1.95, 1.18), r: 0.32, mirror: true },
    { id: 'image', p: v(1.95, 0.02), r: 0 }, // intermediate image at the hole of M6
    { id: 'm5', p: v(1.95, -1.6), r: 0.64, rIn: 0.34, size: 0.7, hole: 0.31, mirror: true },
    { id: 'm6', p: v(1.95, -0.15), r: (2.05 - 0.15) * tanNA(NA['high-na']), rIn: 0.3, hole: 0.2, mirror: true },
    { id: 'wafer', p: WAFER, r: 0 },
  ],
};

/** The ordered optical train for a variant, with normals, tangents and orientation signs. */
export function buildTrain(variant: Variant): OpticEl[] {
  const specs = [...UP, ...POB[variant]];
  const els: OpticEl[] = specs.map((s) => {
    const e: OpticEl = {
      id: s.id,
      pos: s.p.clone(),
      r: s.r,
      mirror: !!s.mirror,
      n: new Vector3(0, 1, 0),
      t: new Vector3(1, 0, 0),
    };
    if (s.rIn !== undefined) e.rIn = s.rIn;
    if (s.mirror) e.size = s.size ?? s.r * 1.12 + 0.05;
    if (s.hole !== undefined) e.hole = s.hole;
    return e;
  });
  const din = new Vector3();
  const dout = new Vector3();
  els.forEach((e, i) => {
    const prev = els[i - 1];
    const next = els[i + 1];
    if (e.mirror && prev && next) {
      din.subVectors(e.pos, prev.pos).normalize();
      dout.subVectors(next.pos, e.pos).normalize();
      e.n.subVectors(dout, din).normalize();
    }
    e.t.set(-e.n.y, e.n.x, 0); // in-plane tangent
  });
  orientSigns(els);
  return els;
}

/** Lateral offset of a ray with pupil coordinate f ∈ [−1, 1] on an element. */
export function offsetOf(e: OpticEl, f: number): number {
  if (e.r === 0) return 0;
  if (e.rIn !== undefined) {
    const k = Math.min(1, Math.max(0, (Math.abs(f) - 0.5) / 0.5));
    return Math.sign(f) * (e.rIn + k * (e.r - e.rIn));
  }
  return f * e.r;
}

export function rayPoint(e: OpticEl, f: number, out = new Vector3()): Vector3 {
  return out.copy(e.pos).addScaledVector(e.t, offsetOf(e, f));
}

/**
 * Choose the sign of each element's tangent so that marginal rays never cross between two
 * finite footprints (the shorter pairing never crosses), and pass straight through foci.
 */
function orientSigns(els: OpticEl[]): void {
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 1; i < els.length; i++) {
    const e = els[i]!;
    if (e.r === 0) continue;
    const p = els[i - 1]!;
    const lenFor = (sign: number) => {
      e.t.multiplyScalar(sign);
      let s: number;
      if (p.r > 0) {
        s = rayPoint(p, 1, a).distanceTo(rayPoint(e, 1, b)) + rayPoint(p, -1, a).distanceTo(rayPoint(e, -1, b));
      } else {
        // Through a focus: prefer the continuation with the smallest kink.
        const pp = els[i - 2];
        if (!pp) s = 0;
        else {
          const d1 = a.subVectors(p.pos, rayPoint(pp, 1, new Vector3())).normalize();
          const d2 = b.subVectors(rayPoint(e, 1, new Vector3()), p.pos).normalize();
          s = -d1.dot(d2);
        }
      }
      e.t.multiplyScalar(sign);
      return s;
    };
    if (lenFor(-1) < lenFor(1)) e.t.multiplyScalar(-1);
  }
}

/** Polyline of one ray through the whole train. */
export function rayPath(els: OpticEl[], f: number): Vector3[] {
  return els.map((e) => rayPoint(e, f));
}

/* ───────── beams: translucent tubes between footprints + crisp marginal-ray lines ───────── */

export interface BeamSegment {
  /** Index of the element the segment starts at. */
  from: number;
  /** Vertex range in the tube geometry. */
  start: number;
  count: number;
  /** Vertex range in the line geometry. */
  lStart: number;
  lCount: number;
  /** Reflections before this segment (for the 示意 dimming along the path). */
  bounces: number;
}

const Z = new Vector3(0, 0, 1);

/** A footprint ring on an element: centre + rad·(cosφ·t + sinφ·z), lying in the mirror plane. */
function ring(e: OpticEl, rad: number, n: number): Vector3[] {
  const out: Vector3[] = [];
  for (let k = 0; k <= n; k++) {
    const phi = (k / n) * Math.PI * 2;
    out.push(e.pos.clone().addScaledVector(e.t, Math.cos(phi) * rad).addScaledVector(Z, Math.sin(phi) * rad));
  }
  return out;
}

export function buildBeams(els: OpticEl[], seg = 40): { tubes: BufferGeometry; lines: BufferGeometry; segments: BeamSegment[] } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const lpos: number[] = [];
  const segments: BeamSegment[] = [];
  const push = (arr: number[], p: Vector3) => arr.push(p.x, p.y, p.z);
  const tube = (a: Vector3[], b: Vector3[]) => {
    for (let k = 0; k < seg; k++) {
      const a0 = a[k]!;
      const a1 = a[k + 1]!;
      const b0 = b[k]!;
      const b1 = b[k + 1]!;
      for (const p of [a0, b0, b1, a0, b1, a1]) {
        push(pos, p);
        nrm.push(0, 0, 1);
      }
    }
  };
  let bounces = 0;
  for (let i = 0; i < els.length - 1; i++) {
    const A = els[i]!;
    const B = els[i + 1]!;
    if (i > 0 && A.mirror) bounces++;
    const start = pos.length / 3;
    const lStart = lpos.length / 3;
    tube(ring(A, A.r, seg), ring(B, B.r, seg));
    if (A.rIn !== undefined || B.rIn !== undefined) {
      const ra = A.rIn ?? (A.r === 0 ? 0 : A.r);
      const rb = B.rIn ?? (B.r === 0 ? 0 : B.r);
      tube(ring(A, ra, seg), ring(B, rb, seg));
    }
    for (const f of [-1, 1]) {
      push(lpos, rayPoint(A, f));
      push(lpos, rayPoint(B, f));
    }
    segments.push({ from: i, start, count: pos.length / 3 - start, lStart, lCount: lpos.length / 3 - lStart, bounces });
  }
  const tubes = new BufferGeometry();
  tubes.setAttribute('position', new Float32BufferAttribute(pos, 3));
  tubes.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  tubes.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  tubes.computeBoundingSphere();
  const lines = new BufferGeometry();
  lines.setAttribute('position', new Float32BufferAttribute(lpos, 3));
  lines.setAttribute('color', new Float32BufferAttribute(new Float32Array((lpos.length / 3) * 4), 4));
  lines.computeBoundingSphere();
  return { tubes, lines, segments };
}

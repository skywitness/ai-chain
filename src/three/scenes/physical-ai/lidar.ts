/**
 * physical-ai · a tiny spinning-LiDAR simulator: rays from the roof sensor (one per beam per
 * azimuth step) are intersected ONCE with the street's simple primitives (axis-aligned boxes,
 * spheres and the ground plane). The hits are sorted by azimuth so the "sweep" can be drawn
 * with draw ranges of one shared buffer (no per-frame uploads).
 */
import type { Rng } from '../../core/types';

export interface BoxObs {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Point class written for hits on this obstacle. */
  cls: number;
}
export interface SphereObs {
  c: readonly [number, number, number];
  r: number;
  cls: number;
}

export interface LidarSpec {
  origin: readonly [number, number, number];
  /** Beam elevations in radians (negative = downwards). */
  beams: readonly number[];
  azSteps: number;
  maxRange: number;
  /** Ground plane y = 0 is only hit inside these bounds [minX, maxX, minZ, maxZ]. */
  ground: readonly [number, number, number, number];
  groundCls: number;
  boxes: readonly BoxObs[];
  spheres: readonly SphereObs[];
  /** Range noise (m, standard deviation). */
  noise: number;
}

export interface Cloud {
  /** xyz per point, sorted by azimuth (radians, 0..2π, measured from +x towards +z). */
  positions: Float32Array;
  az: Float32Array;
  cls: Uint8Array;
  count: number;
}

export function castCloud(spec: LidarSpec, rng: Rng): Cloud {
  const [ox, oy, oz] = spec.origin;
  const hx: number[] = [];
  const hy: number[] = [];
  const hz: number[] = [];
  const ha: number[] = [];
  const hc: number[] = [];
  const cosB = spec.beams.map(Math.cos);
  const sinB = spec.beams.map(Math.sin);
  for (let a = 0; a < spec.azSteps; a++) {
    const az = ((a + 0.5) / spec.azSteps) * Math.PI * 2;
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    for (let b = 0; b < spec.beams.length; b++) {
      const dx = ca * cosB[b]!;
      const dy = sinB[b]!;
      const dz = sa * cosB[b]!;
      let best = spec.maxRange;
      let cls = -1;
      // ground
      if (dy < -1e-4) {
        const t = -oy / dy;
        if (t < best) {
          const x = ox + dx * t;
          const z = oz + dz * t;
          const g = spec.ground;
          if (x >= g[0] && x <= g[1] && z >= g[2] && z <= g[3]) {
            best = t;
            cls = spec.groundCls;
          }
        }
      }
      for (const bx of spec.boxes) {
        const t = rayBox(ox, oy, oz, dx, dy, dz, bx.min, bx.max, best);
        if (t < best) {
          best = t;
          cls = bx.cls;
        }
      }
      for (const s of spec.spheres) {
        const t = raySphere(ox, oy, oz, dx, dy, dz, s.c, s.r, best);
        if (t < best) {
          best = t;
          cls = s.cls;
        }
      }
      if (cls < 0) continue;
      // Pull each hit slightly towards the sensor so it sits in front of the surface it lies on.
      const r = best - 0.07 + rng.normal() * spec.noise;
      hx.push(ox + dx * r);
      hy.push(Math.max(0.01, oy + dy * r));
      hz.push(oz + dz * r);
      ha.push(az);
      hc.push(cls);
    }
  }
  const n = ha.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => ha[i]! - ha[j]!);
  const positions = new Float32Array(n * 3);
  const azs = new Float32Array(n);
  const cl = new Uint8Array(n);
  order.forEach((src, i) => {
    positions[i * 3] = hx[src]!;
    positions[i * 3 + 1] = hy[src]!;
    positions[i * 3 + 2] = hz[src]!;
    azs[i] = ha[src]!;
    cl[i] = hc[src]!;
  });
  return { positions, az: azs, cls: cl, count: n };
}

function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  best: number,
): number {
  let t0 = 0;
  let t1 = best;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let k = 0; k < 3; k++) {
    const dk = d[k]!;
    const ok = o[k]!;
    if (Math.abs(dk) < 1e-9) {
      if (ok < min[k]! || ok > max[k]!) return Infinity;
      continue;
    }
    let ta = (min[k]! - ok) / dk;
    let tb = (max[k]! - ok) / dk;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0 > 1e-3 ? t0 : Infinity;
}

function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  c: readonly [number, number, number],
  r: number,
  best: number,
): number {
  const lx = c[0] - ox;
  const ly = c[1] - oy;
  const lz = c[2] - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  const t = tca - Math.sqrt(r * r - d2);
  return t > 1e-3 && t < best ? t : Infinity;
}

/** First index i with az[i] >= a (binary search). */
export function lowerBound(az: Float32Array, n: number, a: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (az[mid]! < a) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

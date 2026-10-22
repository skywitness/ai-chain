/**
 * Zoom-dependent spread of crowded columns on the unit sphere (proposals/scene-memory-fab-map.yaml →
 * globe-cluster-spread).
 *
 * Memory fabs crowd into a few clusters (利川／華城／器興／平澤／龍仁／清州 lie within ~100 km;
 * 平澤 P1–P5 share one campus). For each zoom level the markers are relaxed apart until no two are
 * closer than that level's separation, with a weak spring back to their true positions, so a cluster
 * becomes a small fan around where it really is. The scene interpolates between levels as the camera
 * altitude changes and draws a thin leader line from each moved column to its true position.
 */
import { Vector3 } from 'three';

const GOLDEN = 2.399963229728653;
const UP = new Vector3(0, 1, 0);

/**
 * Relax unit vectors `base` so that every pair is at least `sep` radians apart (`sepOf(i, j)` when
 * given: e.g. a tighter spacing inside one campus keeps its columns together as a group).
 */
function relax(base: readonly Vector3[], sep: number, iters: number, sepOf?: (i: number, j: number) => number): Vector3[] {
  const n = base.length;
  const p = base.map((v) => v.clone());
  // Only pairs that can ever meet: a blob of k markers spreads to about √k · sep.
  const reach = Math.cos(Math.min(Math.PI / 2, sep * (2 + Math.sqrt(n) * 1.6)));
  const pairs: number[] = [];
  const seps: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (base[i]!.dot(base[j]!) > reach) {
        pairs.push(i, j);
        seps.push(sepOf ? sepOf(i, j) : sep);
      }
  if (!pairs.length) return p;
  const d = new Vector3();
  const t = new Vector3();
  const e = new Vector3();
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let k = 0; k < pairs.length; k += 2) {
      const i = pairs[k]!;
      const j = pairs[k + 1]!;
      const a = p[i]!;
      const b = p[j]!;
      const want = seps[k >> 1]!;
      const ang = Math.acos(Math.max(-1, Math.min(1, a.dot(b))));
      if (ang >= want) continue;
      moved = true;
      // Direction from a to b in a's tangent plane (deterministic when the two coincide).
      d.copy(b).addScaledVector(a, -a.dot(b));
      if (d.lengthSq() < 1e-14) {
        e.crossVectors(UP, a);
        if (e.lengthSq() < 1e-8) e.set(1, 0, 0);
        e.normalize();
        t.crossVectors(a, e);
        const th = (i * 7 + j * 3) * GOLDEN;
        d.copy(e).multiplyScalar(Math.cos(th)).addScaledVector(t, Math.sin(th));
      }
      d.normalize();
      const push = (want - ang) * 0.5 * 0.6;
      a.addScaledVector(d, -push).normalize();
      b.addScaledVector(d, push).normalize();
    }
    // Weak spring back to the true position keeps the fan centred on the real cluster.
    for (let i = 0; i < n; i++) p[i]!.lerp(base[i]!, 0.015).normalize();
    if (!moved && it > 4) break;
  }
  return p;
}

export interface Spread {
  /** Unit normals at zoom `s` (1 = from orbit, smaller = closer), written into `out`. */
  at(s: number, out: Vector3[]): void;
}

/**
 * Precompute relaxed layouts for the zoom levels `levels` (descending, e.g. [1, 0.8, 0.64]);
 * `sepAt(s)` gives the minimum separation in radians at zoom `s`; `pairSep(i, j, s)` may override
 * it for particular pairs (columns of one campus).
 */
export function createSpread(
  base: readonly Vector3[],
  levels: readonly number[],
  sepAt: (s: number) => number,
  pairSep?: (i: number, j: number, s: number, sep: number) => number,
): Spread {
  const layouts = levels.map((s) => {
    const sep = sepAt(s);
    return relax(base, sep, 220, pairSep ? (i, j) => pairSep(i, j, s, sep) : undefined);
  });
  const last = levels.length - 1;
  return {
    at(s, out) {
      let a = 0;
      while (a < last && s < levels[a + 1]!) a++;
      if (a >= last || s >= levels[0]!) {
        const L = layouts[s >= levels[0]! ? 0 : last]!;
        for (let i = 0; i < L.length; i++) out[i]!.copy(L[i]!);
        return;
      }
      // Interpolate in log zoom between level a and a + 1.
      const k = Math.log(levels[a]! / s) / Math.log(levels[a]! / levels[a + 1]!);
      const A = layouts[a]!;
      const B = layouts[a + 1]!;
      for (let i = 0; i < A.length; i++) out[i]!.copy(A[i]!).lerp(B[i]!, k).normalize();
    },
  };
}

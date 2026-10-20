/**
 * taiwan-map island builders: the extruded land (main island bevelled, Penghu and the islets in
 * place, Kinmen and Matsu moved into labelled insets), the coastline and county borders as single
 * LineSegments, inset frames, and a faint 1° graticule. Input is src/data/geo/taiwan.json (rings
 * already projected with projectTw: x east, y north, 1 unit = 100 km); world = (x, height, −y).
 */
import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Shape, Vector2, type Color } from 'three';
import { projectTw } from '../../kit/projectTw';

export interface TwGeo {
  groups: Record<string, number[][]>;
  borders: number[][];
  counties: { id: string; name: string; en?: string; x: number; y: number }[];
  bbox: number[];
}

/** Land slab: top face at y = 0, bottom at −LAND_T. */
export const LAND_T = 0.075;

/** Where the Kinmen and Matsu insets are drawn (projected x, y = north), and their frame size. */
export const INSETS = {
  matsu: { at: [-1.32, 1.72] as const, half: 0.2, name: '馬祖' },
  kinmen: { at: [-1.62, 0.92] as const, half: 0.24, name: '金門' },
} as const;

function centroid(rings: readonly number[][]): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const r of rings)
    for (let i = 0; i < r.length; i += 2) {
      sx += r[i]!;
      sy += r[i + 1]!;
      n++;
    }
  return n ? [sx / n, sy / n] : [0, 0];
}

function ringPoints(flat: readonly number[], dx: number, dy: number): Vector2[] {
  const pts: Vector2[] = [];
  for (let i = 0; i < flat.length; i += 2) pts.push(new Vector2(flat[i]! + dx, flat[i + 1]! + dy));
  // Drop a closing duplicate (ExtrudeGeometry closes the contour itself).
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a && b && pts.length > 3 && a.distanceTo(b) < 1e-6) pts.pop();
  return pts;
}

/** Concatenate non-indexed geometries (position + normal only). */
function mergeNonIndexed(parts: readonly BufferGeometry[]): BufferGeometry {
  let n = 0;
  for (const g of parts) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    const gi = g.index ? g.toNonIndexed() : g;
    const p = gi.getAttribute('position');
    const q = gi.getAttribute('normal');
    pos.set(p.array as Float32Array, o * 3);
    nrm.set(q.array as Float32Array, o * 3);
    o += p.count;
    if (gi !== g) gi.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

/** Signed area (shoelace) of a flat ring. */
function area(flat: readonly number[]): number {
  let s = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += flat[i * 2]! * flat[j * 2 + 1]! - flat[j * 2]! * flat[i * 2 + 1]!;
  }
  return s / 2;
}

export interface IslandParts {
  land: BufferGeometry;
  coast: BufferGeometry;
  borders: BufferGeometry;
  frames: BufferGeometry;
  /** world-space centres of the insets (x, z) for labels */
  insetCentres: Record<'matsu' | 'kinmen', [number, number]>;
}

/** Offsets that move a group into its inset. */
function insetOffset(geo: TwGeo, key: 'matsu' | 'kinmen'): [number, number] {
  const [cx, cy] = centroid(geo.groups[key] ?? []);
  const [tx, ty] = INSETS[key].at;
  return [tx - cx, ty - cy];
}

export function buildIsland(geo: TwGeo): IslandParts {
  const parts: BufferGeometry[] = [];
  const coastPos: number[] = [];
  const pushRing = (pts: Vector2[], y: number) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      coastPos.push(a.x, y, -a.y, b.x, y, -b.y);
    }
  };
  const groups: [string, number, number][] = [
    ['main', 0, 0],
    ['penghu', 0, 0],
    ['islets', 0, 0],
    ['kinmen', ...insetOffset(geo, 'kinmen')],
    ['matsu', ...insetOffset(geo, 'matsu')],
  ];
  for (const [key, dx, dy] of groups) {
    for (const ring of geo.groups[key] ?? []) {
      if (ring.length < 6) continue;
      const pts = ringPoints(ring, dx, dy);
      if (pts.length < 3) continue;
      const big = key === 'main';
      const tiny = Math.abs(area(ring)) < 2e-4;
      const shape = new Shape(pts);
      const g = new ExtrudeGeometry(shape, {
        depth: big ? LAND_T - 0.02 : LAND_T * (tiny ? 0.55 : 0.75),
        bevelEnabled: big,
        bevelThickness: 0.01,
        bevelSize: 0.008,
        bevelSegments: 2,
        curveSegments: 1,
      });
      g.rotateX(-Math.PI / 2);
      g.computeBoundingBox();
      // Put the top cap at y = 0.
      g.translate(0, -(g.boundingBox?.max.y ?? 0), 0);
      g.deleteAttribute('uv');
      parts.push(g);
      pushRing(pts, 0.002);
    }
  }
  const land = mergeNonIndexed(parts);
  for (const p of parts) p.dispose();
  // Vertex shade: top 1, walls a step darker, underside darker still (material colour × this).
  const nrm = land.getAttribute('normal');
  const shade = new Float32Array(nrm.count * 3);
  for (let i = 0; i < nrm.count; i++) {
    const ny = nrm.getY(i);
    const k = ny > 0.6 ? 1 : ny < -0.6 ? 0.55 : 0.78 + 0.12 * ny;
    shade[i * 3] = shade[i * 3 + 1] = shade[i * 3 + 2] = k;
  }
  land.setAttribute('color', new Float32BufferAttribute(shade, 3));

  const coast = new BufferGeometry();
  coast.setAttribute('position', new Float32BufferAttribute(coastPos, 3));

  const borderPos: number[] = [];
  for (const line of geo.borders) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      borderPos.push(line[i]!, 0.003, -line[i + 1]!, line[i + 2]!, 0.003, -line[i + 3]!);
    }
  }
  const borders = new BufferGeometry();
  borders.setAttribute('position', new Float32BufferAttribute(borderPos, 3));

  // Inset frames: rounded-corner squares drawn as segments.
  const framePos: number[] = [];
  const insetCentres = {} as Record<'matsu' | 'kinmen', [number, number]>;
  for (const key of ['matsu', 'kinmen'] as const) {
    const { at, half } = INSETS[key];
    const [cx, cy] = at;
    insetCentres[key] = [cx, -cy];
    const r = 0.04;
    const pts: [number, number][] = [];
    const corner = (ox: number, oy: number, a0: number) => {
      for (let k = 0; k <= 4; k++) {
        const a = a0 + (k / 4) * (Math.PI / 2);
        pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
      }
    };
    corner(cx + half - r, cy + half - r, 0);
    corner(cx - half + r, cy + half - r, Math.PI / 2);
    corner(cx - half + r, cy - half + r, Math.PI);
    corner(cx + half - r, cy - half + r, Math.PI * 1.5);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      framePos.push(a[0], -LAND_T + 0.004, -a[1], b[0], -LAND_T + 0.004, -b[1]);
    }
  }
  const frames = new BufferGeometry();
  frames.setAttribute('position', new Float32BufferAttribute(framePos, 3));

  return { land, coast, borders, frames, insetCentres };
}

/** 1° graticule (lat 21–27°N, lon 118–124°E) as faded segments with RGBA vertex colours. */
export function buildGraticule(y: number, radius: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 24;
  const seg = (lonA: number, latA: number, lonB: number, latB: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const [x, yy] = projectTw(lonA + (lonB - lonA) * t, latA + (latB - latA) * t);
        pos.push(x, y, -yy);
        const r = Math.hypot(x, yy) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.5);
      }
    }
  };
  for (let lat = 21; lat <= 27; lat++) seg(117.5, lat, 124.5, lat);
  for (let lon = 118; lon <= 124; lon++) seg(lon, 20.5, lon, 27.5);
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

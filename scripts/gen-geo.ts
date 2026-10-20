/**
 * Generates the geo assets used by the Globe kit and the taiwan-map scene:
 *
 *   src/data/geo/land-dots.json  equal-area (Fibonacci-lattice) dot sampling of world land,
 *                                from world-atlas land-50m (Natural Earth, public domain)
 *   src/data/geo/taiwan.json     simplified Taiwan outline groups + county borders + county
 *                                label anchors, projected with projectTw (taiwan-atlas,
 *                                MOI data under 政府資料開放授權條款 第 1 版)
 *
 * Run: npx tsx scripts/gen-geo.ts   (npm run gen:geo). Outputs are committed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { geoBounds, geoCentroid, geoContains } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';
import type { Topology } from 'topojson-specification';
import { TW_ORIGIN, TW_UNIT_KM, projectTw } from '../src/three/kit/projectTw';

const require = createRequire(import.meta.url);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(require.resolve(p), 'utf8')) as T;
const OUT = 'src/data/geo';
mkdirSync(OUT, { recursive: true });

/* ───────────────────────── land dots ───────────────────────── */

const LATTICE = 34000; // ≈ 29% land → ~10k dots, ~1.1° spacing

function landDots(): void {
  const topo = readJson<Topology>('world-atlas/land-50m.json');
  const land = feature(topo, topo.objects['land']!) as FeatureCollection<Geometry> | Feature<Geometry>;
  const feats = 'features' in land ? land.features : [land];
  // Split into single polygons with bounding boxes for a cheap prefilter.
  const polys: { f: Feature<Polygon>; lon0: number; lon1: number; lat0: number; lat1: number; wraps: boolean }[] = [];
  for (const f of feats) {
    const g = f.geometry;
    const list: Position[][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const coords of list) {
      const pf: Feature<Polygon> = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: coords } };
      const [[lon0, lat0], [lon1, lat1]] = geoBounds(pf);
      polys.push({ f: pf, lon0, lon1, lat0, lat1, wraps: lon0 > lon1 });
    }
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: number[] = [];
  for (let i = 0; i < LATTICE; i++) {
    const y = 1 - (2 * (i + 0.5)) / LATTICE;
    const lat = (Math.asin(y) * 180) / Math.PI;
    let lon = ((i * golden * 180) / Math.PI) % 360;
    if (lon > 180) lon -= 360;
    const p: [number, number] = [lon, lat];
    const hit = polys.some((q) => {
      if (lat < q.lat0 - 0.01 || lat > q.lat1 + 0.01) return false;
      const inLon = q.wraps ? lon >= q.lon0 || lon <= q.lon1 : lon >= q.lon0 - 0.01 && lon <= q.lon1 + 0.01;
      return inLon && geoContains(q.f, p);
    });
    if (hit) pts.push(Math.round(lat * 10) / 10, Math.round(lon * 10) / 10);
  }
  const out = {
    v: 1,
    source: 'Natural Earth 1:50m land (public domain) via world-atlas 2.0.2',
    lattice: LATTICE,
    count: pts.length / 2,
    /** flat [lat0, lon0, lat1, lon1, …], degrees rounded to 0.1 */
    points: pts,
  };
  writeFileSync(`${OUT}/land-dots.json`, JSON.stringify(out));
  console.log(`land-dots.json: ${out.count} dots`);
}

/* ───────────────────────── Taiwan ───────────────────────── */

type XY = [number, number];

/** Douglas–Peucker in projected units. */
function simplify(points: XY[], tol: number): XY[] {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const flat = (pts: XY[]) => pts.flatMap(([x, y]) => [r3(x), r3(y)]);

function ringArea(pts: XY[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
  return Math.abs(a / 2);
}

function taiwan(): void {
  const topo = readJson<Topology>('taiwan-atlas/counties-10t.json');
  const nation = feature(topo, topo.objects['nation']!) as FeatureCollection<MultiPolygon | Polygon> | Feature<MultiPolygon | Polygon>;
  const nf = 'features' in nation ? nation.features : [nation];
  const groups: Record<'main' | 'penghu' | 'kinmen' | 'matsu' | 'islets', number[][]> = {
    main: [],
    penghu: [],
    kinmen: [],
    matsu: [],
    islets: [],
  };
  let mainArea = 0;
  const rings: { lonlat: Position[]; xy: XY[]; area: number }[] = [];
  for (const f of nf) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      const outer = poly[0]!;
      const xy = outer.map(([lon, lat]) => projectTw(lon!, lat!));
      const area = ringArea(xy);
      rings.push({ lonlat: outer, xy, area });
      mainArea = Math.max(mainArea, area);
    }
  }
  let dropped = 0;
  for (const r of rings) {
    const [lon, lat] = r.lonlat.reduce((s, p) => [s[0]! + p[0]! / r.lonlat.length, s[1]! + p[1]! / r.lonlat.length], [0, 0]);
    const isMain = r.area === mainArea;
    let key: keyof typeof groups = 'islets';
    if (isMain) key = 'main';
    else if (lon! < 118.6) key = 'kinmen';
    else if (lat! > 25.8 && lon! < 120.7) key = 'matsu';
    else if (lon! > 119.2 && lon! < 119.8 && lat! > 23.0 && lat! < 23.9) key = 'penghu';
    // Drop specks smaller than ~0.05 km² except around Matsu/Kinmen where islands are small.
    const minArea = key === 'islets' || key === 'penghu' ? 0.00002 : 0.000005;
    if (!isMain && r.area < minArea) {
      dropped++;
      continue;
    }
    const tol = isMain ? 0.0035 : 0.0015;
    let s = simplify(r.xy, tol);
    if (s.length < 4) s = r.xy.length <= 12 ? r.xy : simplify(r.xy, tol / 3);
    if (s.length >= 4) groups[key].push(flat(s));
  }

  // Internal county borders.
  const borders = mesh(
    topo,
    topo.objects['counties'] as Parameters<typeof mesh>[1],
    (a, b) => a !== b,
  ) as MultiLineString;
  const borderLines = borders.coordinates
    .map((line) => simplify(line.map(([lon, lat]) => projectTw(lon!, lat!)), 0.003))
    .filter((l) => l.length >= 2)
    .map(flat);

  const counties = (
    feature(topo, topo.objects['counties']!) as FeatureCollection<Geometry, { COUNTYID: string; COUNTYNAME: string; COUNTYENG: string }>
  ).features.map((f) => {
    const [lon, lat] = geoCentroid(f);
    const [x, y] = projectTw(lon, lat);
    return { id: f.properties.COUNTYID, name: f.properties.COUNTYNAME, en: f.properties.COUNTYENG, x: r3(x), y: r3(y) };
  });

  const all = [...groups.main, ...groups.penghu, ...groups.islets].flat();
  const xs = all.filter((_, i) => i % 2 === 0);
  const ys = all.filter((_, i) => i % 2 === 1);
  const out = {
    v: 1,
    source: '內政部國土測繪中心（taiwan-atlas counties-10t，政府資料開放授權條款 第 1 版）',
    projection: { name: 'projectTw', origin: TW_ORIGIN, unitKm: TW_UNIT_KM },
    /** bbox of main island + Penghu + islets (Kinmen / Matsu are insets) */
    bbox: [r3(Math.min(...xs)), r3(Math.min(...ys)), r3(Math.max(...xs)), r3(Math.max(...ys))],
    /** each ring is a flat [x0, y0, x1, y1, …] outer ring (y = north) */
    groups,
    borders: borderLines,
    counties,
  };
  writeFileSync(`${OUT}/taiwan.json`, JSON.stringify(out));
  const n = (k: keyof typeof groups) => `${groups[k].length} rings / ${groups[k].reduce((s, r) => s + r.length / 2, 0)} pts`;
  console.log(
    `taiwan.json: main ${n('main')}, penghu ${n('penghu')}, kinmen ${n('kinmen')}, matsu ${n('matsu')}, islets ${n('islets')}, ` +
      `${borderLines.length} border lines, ${counties.length} counties, dropped ${dropped} specks`,
  );
}

landDots();
taiwan();

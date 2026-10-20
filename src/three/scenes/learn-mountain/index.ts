/**
 * learn-mountain — 學習之山 (variant: default).
 *
 * The site's learning articles as a terraced mountain built from stacked contour layers, like a
 * laser-cut topographic model: the wide base terrace is 入門, the middle one 進階, the summit 深入.
 * Each article is a beacon on its terrace, coloured by track (the 2D learning map's colours) and
 * placed so tracks keep the same direction on every terrace (left → right: 晶片與硬體,
 * 基礎設施與商業, 基礎概念, 模型與軟體, 社會與未來). Prerequisites are trails that hug the terrain
 * (along a terrace, or up the slopes between terraces); PathFlow light climbs them from the
 * prerequisite to the article. Hover: card with the title, level, track and prerequisites, and the
 * node's own trails light up. Click: opens the article.
 *
 * Steps (由淺入深): 總覽 → 入門台地 → 進階台地 → 深入台地 → 攻頂路線 (the summit article with the most
 * prerequisites, its whole prerequisite tree lit). Labels stay calm: terrace names, a few signs, and
 * article titles only for the focused terrace / the nearest 入門 nodes / hover; phones keep only the
 * terrace names in the overview. A screen-space pass (labelPlace.ts) picks the side of each article
 * label so labels neither overlap each other nor cover a lit beacon. Terrace names form a legend
 * beside the left rims in the wide overview and become signs on the terrace walls in closer steps
 * and on narrow stages. Small monochrome model trees on the flanks are decor only.
 * Portrait stages use their own steeper step poses (re-applied when the stage flips orientation).
 * Reduced motion: static dotted trails, still flag; every step shows its final state.
 *
 * Data ('curriculum', docs/SCENES.md): { slug, title, level, order, track, prereqs, href }[].
 * Without data the fixture (the curriculum registry) is used and the stage shows 「示意資料」.
 */
import {
  Box3,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type SceneContext,
} from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { alignOf, offsetFor, placeLabels, type PlaceCandidate, type Rect, type Side } from './labelPlace';
import {
  CONTOURS,
  GROUND_Y,
  BAND_F,
  LEVEL_NAME,
  TRACK_LAYER,
  TRACK_NAME,
  TRACK_ORDER,
  ancestors,
  bandPoint,
  contourRadius,
  heightAt,
  layoutEdges,
  layoutNodes,
  routeTarget,
  shortTitle,
  terraceIndex,
  type Article,
  type Level,
  type TrackId,
} from './layout';

/* ───────────────────────── data ───────────────────────── */

interface CurriculumRow {
  slug: string;
  title: string;
  level: number;
  order: number;
  track: string;
  prereqs: string[];
  href?: string;
}

function isCurriculum(d: unknown): d is CurriculumRow[] {
  return (
    Array.isArray(d) &&
    d.length > 0 &&
    d.every((r) => {
      const a = r as CurriculumRow;
      return (
        !!a &&
        typeof a === 'object' &&
        typeof a.slug === 'string' &&
        typeof a.title === 'string' &&
        Number.isFinite(a.level) &&
        Number.isFinite(a.order) &&
        typeof a.track === 'string' &&
        Array.isArray(a.prereqs)
      );
    })
  );
}

function normalise(rows: readonly CurriculumRow[]): Article[] {
  const seen = new Set<string>();
  const out: Article[] = [];
  for (const r of [...rows].sort((a, b) => a.order - b.order)) {
    if (!r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push({
      slug: r.slug,
      title: r.title,
      level: Math.min(3, Math.max(1, Math.round(r.level))) as Level,
      order: r.order,
      track: ((TRACK_ORDER as readonly string[]).includes(r.track) ? r.track : 'foundations') as TrackId,
      prereqs: r.prereqs.filter((p): p is string => typeof p === 'string' && p !== r.slug),
      href: typeof r.href === 'string' && r.href ? r.href : `/learn/${r.slug}/`,
    });
  }
  const known = new Set(out.map((a) => a.slug));
  for (const a of out) a.prereqs = [...new Set(a.prereqs.filter((p) => known.has(p)))];
  return out;
}

/* ───────────────────────── constants ───────────────────────── */

const BEVEL = 0.09;
const ORB_Y = 0.3;
const ORB_R = 0.15;
const TUBE_R = 0.024;
const FLOW_MAX = 380;

/** Node weights: 1 = focused, lower = dimmed. Edge weights: 1 = lit, 0.45 = resting, ~0 = hidden. */
const EDGE_REST = 0.45;

const HOME: CameraPose = { position: [1.9, 11.7, 14.9], target: [0, 0.85, 0.75] };
/** Portrait home: the mountain is much wider than tall, so it is framed a little tighter than the
 *  width alone would allow (the base terrace's outer rim may touch the edges). */
const PORTRAIT_ZOOM = 0.9;
const PORTRAIT: CameraPose = {
  position: [1.1 * PORTRAIT_ZOOM, 0.9 + 18.5 * PORTRAIT_ZOOM, 0.45 + 10.75 * PORTRAIT_ZOOM],
  target: [0, 0.9, 0.45],
  fov: 44,
};
/** Unit view direction of the home pose (route framing keeps the same viewing angle). */
const HOME_DIR = new Vector3(1.9, 10.85, 14.15).normalize();
const STEP_POSES: readonly (CameraPose | null)[] = [
  null,
  { position: [1.0, 8.6, 14.8], target: [0, 0.35, 1.45] },
  { position: [0.9, 10.2, 13.0], target: [0, 1.3, 0.35] },
  { position: [0.73, 11.8, 8.1], target: [0, 2.85, -0.15] },
  null, // route: framed around the route nodes
];

/** Portrait stages look down more steeply so one terrace fills the tall frame. ctx.setPose scales
 *  every pose's distance by |PORTRAIT| / |HOME|; dividing by PORTRAIT_ZOOM keeps these step poses
 *  independent of the tighter portrait home framing. */
const PORTRAIT_DIR = new Vector3(1.1, 18.5, 10.75).normalize();
const portraitPose = (position: [number, number, number], target: [number, number, number]): CameraPose => ({
  position: position.map((v, k) => target[k]! + (v - target[k]!) / PORTRAIT_ZOOM) as [number, number, number],
  target,
});
const STEP_POSES_PORTRAIT: readonly (CameraPose | null)[] = [
  null,
  portraitPose([0.78, 11.4, 12.9], [0, 1.0, 1.4]),
  portraitPose([0.76, 14.65, 8.93], [0, 1.85, 1.5]),
  portraitPose([0.62, 13.27, 6.73], [0, 2.9, 0.7]),
  null,
];
/** Where a terrace's name sits on narrow stages: a sign on the terrace's front-left wall. */
const narrowTagPoint = (lv: Level): [number, number, number] => {
  const c = CONTOURS[terraceIndex(lv)]!;
  const th = -0.78;
  const r = contourRadius(c, th) + 0.02;
  return [c.cx + Math.sin(th) * r, lv === 1 ? c.top - 0.36 : c.top - 0.2, c.cz + Math.cos(th) * r];
};

/** Low-poly two-tier conifer (one indexed geometry, base at y = 0). */
function twoTierTree(): BufferGeometry {
  const parts = [new ConeGeometry(0.15, 0.3, 7, 1), new ConeGeometry(0.11, 0.25, 7, 1)];
  parts[0]!.translate(0, 0.17, 0);
  parts[1]!.translate(0, 0.36, 0);
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const g of parts) {
    const off = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    const gi = g.getIndex()!;
    for (let k = 0; k < gi.count; k++) idx.push(off + gi.getX(k));
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
const m4Tree = new Matrix4();
const qTree = new Quaternion();
const pvTree = new Vector3();
const scTree = new Vector3();

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<CurriculumRow[]>({
  json,
  meta: {
    camera: {
      ...HOME,
      fov: 34,
      minDistance: 6,
      maxDistance: 30,
      minPolar: 0.35,
      maxPolar: 1.38,
      portrait: PORTRAIT,
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 45, tris: 140_000 },
  },
  guard: isCurriculum,
  fixture: () => import('../../fixtures/learn-mountain.json'),

  create(ctx: SceneContext<CurriculumRow[]>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'learn-mountain';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));

    const articles = normalise(ctx.data ?? []);
    const nodes = layoutNodes(articles);
    const edges = layoutEdges(nodes);
    const N = nodes.length;
    const nextOf: number[][] = nodes.map(() => []);
    const prevOf: number[][] = nodes.map(() => []);
    const edgesOf: number[][] = nodes.map(() => []);
    edges.forEach((e, k) => {
      nextOf[e.from]!.push(e.to);
      prevOf[e.to]!.push(e.from);
      edgesOf[e.from]!.push(k);
      edgesOf[e.to]!.push(k);
    });
    const levels = ([1, 2, 3] as const).filter((l) => nodes.some((n) => n.level === l));
    const first = nodes.length ? nodes.reduce((a, b) => (b.a.order < a.a.order ? b : a)) : null;
    const target = routeTarget(nodes);
    const routeSet = target >= 0 ? new Set([...ancestors(nodes, target), target]) : new Set<number>();

    /* ───────── terrain: stacked contour layers ───────── */
    const terrainCap = (p: Palette, i: number): Color => {
      const dark = p.theme === 'dark';
      const c = CONTOURS[i]!;
      const k = i / (CONTOURS.length - 1);
      const out = p.bg.clone();
      if (dark) out.lerp(p.muted, 0.36).lerp(p.fg, 0.05 + 0.1 * k + (c.level ? 0.035 : 0));
      else out.lerp(p.muted, 0.2 - 0.1 * k - (c.level ? 0.03 : 0)).lerp(p.fg, 0.015);
      return out;
    };
    const terrainSide = (p: Palette, i: number): Color => {
      const dark = p.theme === 'dark';
      return terrainCap(p, i).lerp(dark ? p.bg : p.muted, dark ? 0.35 : 0.28);
    };
    const terrain = new Group();
    terrain.name = 'terrain';
    root.add(terrain);
    CONTOURS.forEach((c, i) => {
      const pts: Vector2[] = [];
      const M = 160;
      for (let s = 0; s < M; s++) {
        const th = (s / M) * Math.PI * 2;
        const r = contourRadius(c, th) - BEVEL;
        // Shape (x, y) = world (x, −z); see the rotateX below.
        pts.push(new Vector2(c.cx + Math.sin(th) * r, -(c.cz + Math.cos(th) * r)));
      }
      const bt = 0.06;
      const geo = ctx.track(
        new ExtrudeGeometry(new Shape(pts), {
          depth: Math.max(0.02, c.top - c.bottom - 2 * bt),
          bevelEnabled: true,
          bevelThickness: bt,
          bevelSize: BEVEL,
          bevelSegments: 3,
          curveSegments: 1,
        }),
      );
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, c.bottom + bt, 0);
      const cap = materials.standard((p) => terrainCap(p, i), { roughness: 0.92, metalness: 0 });
      const side = materials.standard((p) => terrainSide(p, i), { roughness: 0.95, metalness: 0 });
      const mesh = new Mesh(geo, [cap, side]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      terrain.add(mesh);
    });

    // Rim lines on every layer (terraces stronger): one LineSegments.
    const rimGeo = ctx.track(new BufferGeometry());
    const rimMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const rims = new LineSegments(rimGeo, rimMat);
    rims.renderOrder = 2;
    root.add(rims);
    const rimPos: number[] = [];
    const rimOwner: number[] = [];
    CONTOURS.forEach((c, i) => {
      const M = 160;
      const r0 = (th: number) => contourRadius(c, th) - BEVEL * 0.55;
      for (let s = 0; s < M; s++) {
        for (const th of [(s / M) * Math.PI * 2, ((s + 1) / M) * Math.PI * 2]) {
          const r = r0(th);
          rimPos.push(c.cx + Math.sin(th) * r, c.top + 0.004, c.cz + Math.cos(th) * r);
          rimOwner.push(i);
        }
      }
    });
    rimGeo.setAttribute('position', new Float32BufferAttribute(rimPos, 3));
    rimGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(rimOwner.length * 4), 4));

    // Floor: concentric contour rings fading outwards + a soft contact shadow.
    const floorGeo = ctx.track(new BufferGeometry());
    const floorMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const floor = new LineSegments(floorGeo, floorMat);
    floor.position.y = GROUND_Y + 0.002;
    root.add(floor);
    const floorPos: number[] = [];
    const floorFade: number[] = [];
    const base = CONTOURS[0]!;
    [1.1, 1.2, 1.31, 1.43, 1.56, 1.7].forEach((k, ring) => {
      const M = 180;
      for (let s = 0; s < M; s++) {
        for (const th of [(s / M) * Math.PI * 2, ((s + 1) / M) * Math.PI * 2]) {
          const r = contourRadius({ ...base, ph: base.ph + ring * 0.7 }, th) * k;
          const x = base.cx + Math.sin(th) * r;
          const z = base.cz + Math.cos(th) * r;
          floorPos.push(x, 0, z);
          // Fade with ring index and towards the back so the floor frames the front.
          floorFade.push((1 - ring / 6) ** 1.4 * (0.55 + 0.45 * Math.max(0, Math.cos(th))));
        }
      }
    });
    floorGeo.setAttribute('position', new Float32BufferAttribute(floorPos, 3));
    floorGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(floorFade.length * 4), 4));
    const shadowTex = ctx.track(radialTexture(256));
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = new Mesh(ctx.track(new PlaneGeometry(22, 15)), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, GROUND_Y + 0.001, 0.2);
    root.add(shadow);

    /* ───────── summit flag ───────── */
    const t3 = CONTOURS[terraceIndex(3)]!;
    const [fx, fz] = bandPoint(3, Math.PI, 0.12);
    const flagBase = new Vector3(fx, t3.top, fz);
    const poleMat = materials.standard('muted', { roughness: 0.5, metalness: 0.4 });
    const pole = new Mesh(ctx.track(new CylinderGeometry(0.022, 0.026, 1.05, 8)), poleMat);
    pole.position.copy(flagBase).add(new Vector3(0, 0.525, 0));
    root.add(pole);
    const flagGeo = ctx.track(new BufferGeometry());
    flagGeo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0.62, -0.17, 0, 0, -0.34, 0], 3));
    flagGeo.computeVertexNormals();
    const flagMat = materials.standard('highlight', { side: DoubleSide, roughness: 0.6, metalness: 0 });
    const flag = new Mesh(flagGeo, flagMat);
    flag.position.copy(flagBase).add(new Vector3(0.02, 1.04, 0));
    root.add(flag);

    /* ───────── decor: small two-tier model trees (sides and back only, away from nodes and trails) ───────── */
    const treeGeo = ctx.track(twoTierTree());
    // A muted sage, close to the terrain so the trees read as decor, not as data.
    const treeMat = materials.standard(
      (p) => (p.theme === 'dark' ? terrainCap(p, 2).lerp(p.pos, 0.15) : terrainCap(p, 2).lerp(p.pos, 0.34).multiplyScalar(0.94)),
      { roughness: 0.9, metalness: 0, flatShading: true },
    );
    const treeSpots: [number, number, number, number][] = [];
    {
      const rnd = ctx.rng;
      const base0 = CONTOURS[0]!;
      const addCluster = (x: number, z: number, y: number, n: number, spread: number, s0: number) => {
        for (let k = 0; k < n; k++) {
          const a = rnd.range(0, Math.PI * 2);
          const r = spread * Math.sqrt(rnd());
          treeSpots.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r, s0 * rnd.range(0.72, 1.18)]);
        }
      };
      // Floor groves around the flanks (the front stays open for the trailhead and track signs).
      for (const side of [-1, 1]) {
        for (const th of [1.0, 1.35, 1.75, 2.2, 2.65]) {
          const t = side * (th + rnd.range(-0.08, 0.08));
          const r = contourRadius(base0, t) * rnd.range(1.08, 1.2);
          addCluster(base0.cx + Math.sin(t) * r, base0.cz + Math.cos(t) * r, GROUND_Y, 2 + rnd.int(3), 0.42, 1);
        }
      }
      // Terrace flanks beyond the node rows, and the back of the summit behind the flag.
      for (const [lv, ths, f] of [
        [1, [1.72, 2.05, 2.45], 0.55],
        [2, [1.9, 2.3], 0.5],
      ] as const) {
        for (const th of ths) for (const side of [-1, 1]) {
          const [x, z] = bandPoint(lv, side * (th + rnd.range(-0.05, 0.05)), f);
          addCluster(x, z, CONTOURS[terraceIndex(lv)]!.top, 1 + rnd.int(2), 0.22, 0.85);
        }
      }
      for (const th of [Math.PI - 0.75, Math.PI + 0.7, Math.PI - 0.35]) {
        const [x, z] = bandPoint(3, th, 0.55);
        addCluster(x, z, t3.top, 2, 0.25, 0.8);
      }
    }
    // Keep only trees that stand on the surface they were placed on, clear of nodes and the flag.
    const trees = treeSpots.filter(
      ([x, y, z]) =>
        Math.abs(heightAt(x, z) - y) < 0.01 &&
        Math.hypot(x - flagBase.x, z - flagBase.z) > 0.55 &&
        nodes.every((n) => Math.hypot(x - n.x, z - n.z) > 0.7),
    );
    const treeMesh = new InstancedMesh(treeGeo, treeMat, Math.max(1, trees.length));
    treeMesh.count = trees.length;
    trees.forEach(([x, y, z, s], i) => treeMesh.setMatrixAt(i, m4Tree.compose(pvTree.set(x, y, z), qTree.identity(), scTree.setScalar(s))));
    treeMesh.instanceMatrix.needsUpdate = true;
    treeMesh.computeBoundingSphere();
    root.add(treeMesh);
    ctx.track({ dispose: () => treeMesh.dispose() });

    /* ───────── nodes ───────── */
    const orbGeo = ctx.track(new SphereGeometry(ORB_R, 22, 14));
    const orbLit = ctx.track(new MeshStandardMaterial({ roughness: 0.32, metalness: 0.08 }));
    const orbGlow = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
    const orbs = new InstancedMesh<SphereGeometry, MeshStandardMaterial | MeshBasicMaterial>(orbGeo, orbLit, Math.max(1, N));
    orbs.count = N;
    orbs.instanceMatrix.setUsage(DynamicDrawUsage);
    orbs.renderOrder = 4;
    root.add(orbs);
    ctx.track({ dispose: () => orbs.dispose() });
    const padGeo = ctx.track(new CylinderGeometry(0.2, 0.24, 0.05, 32));
    const padMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }));
    const pads = new InstancedMesh(padGeo, padMat, Math.max(1, N));
    pads.count = N;
    root.add(pads);
    ctx.track({ dispose: () => pads.dispose() });
    const stemGeo = ctx.track(new CylinderGeometry(0.014, 0.014, 1, 6));
    const stemMat = ctx.track(new MeshStandardMaterial({ roughness: 0.5, metalness: 0.2 }));
    const stems = new InstancedMesh(stemGeo, stemMat, Math.max(1, N));
    stems.count = N;
    root.add(stems);
    ctx.track({ dispose: () => stems.dispose() });
    const glows = ctx.track(new GlowSprites({ count: N + 1, theme: ctx.theme }));
    root.add(glows.object);

    const orbPos = nodes.map((n) => new Vector3(n.x, n.y + ORB_Y, n.z));
    const m4 = new Matrix4();
    const q = new Quaternion();
    const sc = new Vector3();
    const pv = new Vector3();
    nodes.forEach((n, i) => {
      pads.setMatrixAt(i, m4.makeTranslation(n.x, n.y + 0.025, n.z));
      stems.setMatrixAt(i, m4.compose(pv.set(n.x, n.y + ORB_Y / 2, n.z), q.identity(), sc.set(1, ORB_Y, 1)));
    });
    pads.instanceMatrix.needsUpdate = true;
    stems.instanceMatrix.needsUpdate = true;

    /** Per-node state: w = focus weight (1 = lit, low = dimmed), h = hover 0..1. */
    const nodeW = new Float32Array(N).fill(1);
    const nodeH = new Float32Array(N);
    const trackColor = (p: Palette, t: TrackId): Color => p.layer[TRACK_LAYER[t]];

    /* ───────── trails ───────── */
    const E = edges.length;
    const edgeW = new Float32Array(E).fill(EDGE_REST);
    const tubeGeo = ctx.track(new BufferGeometry());
    const tubeMat = ctx.track(new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const tubes = new Mesh(tubeGeo, tubeMat);
    tubes.renderOrder = 3;
    root.add(tubes);
    const tubeRange: [number, number][] = [];
    const tubeU: number[] = [];
    {
      const pos: number[] = [];
      const idx: number[] = [];
      const seg = 60;
      const rad = 5;
      for (const e of edges) {
        const curve = new CatmullRomCurve3(e.points.map((p) => new Vector3(p[0], p[1], p[2])), false, 'centripetal');
        const g = new TubeGeometry(curve, seg, TUBE_R, rad, false);
        const start = pos.length / 3;
        const gp = g.getAttribute('position');
        for (let v = 0; v < gp.count; v++) {
          pos.push(gp.getX(v), gp.getY(v), gp.getZ(v));
          tubeU.push(Math.floor(v / (rad + 1)) / seg);
        }
        const gi = g.getIndex();
        if (gi) for (let k = 0; k < gi.count; k++) idx.push(start + gi.getX(k));
        tubeRange.push([start, gp.count]);
        g.dispose();
      }
      tubeGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      tubeGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(tubeU.length * 4), 4));
      tubeGeo.setIndex(idx);
      tubeGeo.computeBoundingSphere();
    }

    const edgeColors = (p: Palette, k: number, n: number): Color[] => {
      const e = edges[k]!;
      const a = trackColor(p, nodes[e.from]!.a.track);
      const b = trackColor(p, nodes[e.to]!.a.track);
      return Array.from({ length: n }, (_, s) => a.clone().lerp(b, n > 1 ? s / (n - 1) : 0));
    };
    const FLOW_STRIDE = 2;
    const flow = ctx.track(
      new PathFlow({
        paths: edges.map((e, k) => {
          const pts = e.points.filter((_, s) => s % FLOW_STRIDE === 0 || s === e.points.length - 1).map((p) => [p[0], p[1] + 0.012, p[2]] as const);
          return { points: pts, color: edgeColors(ctx.palette, k, pts.length) };
        }),
        count: Math.max(1, FLOW_MAX),
        size: 0.08,
        sizeVariance: 0.25,
        speed: 0.5,
        speedVariance: 0.2,
        smooth: false,
        fadeEnds: 0.08,
        theme: ctx.theme,
        seed: 5,
      }),
    );
    flow.setCount(E ? scaleCount(FLOW_MAX, ctx.tier, 60) : 0);
    flow.setReduced(!ctx.animate);
    root.add(flow.object);
    const flowLen = edges.map((e) => e.points.filter((_, s) => s % FLOW_STRIDE === 0 || s === e.points.length - 1).length);

    /* ───────── drawing ───────── */
    const cTmp = new Color();
    const cDim = new Color();
    const writeNodes = () => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      const ground = terrainCap(p, 0);
      for (let i = 0; i < N; i++) {
        const n = nodes[i]!;
        const w = nodeW[i]!;
        const h = nodeH[i]!;
        const tc = trackColor(p, n.a.track);
        cDim.copy(terrainCap(p, terraceIndex(n.level)));
        cTmp.copy(tc).lerp(cDim, (1 - w) * (dark ? 0.9 : 0.66));
        if (h > 0) cTmp.lerp(dark ? p.fg : tc, 0.25 * h);
        orbs.setColorAt(i, cTmp);
        orbs.setMatrixAt(i, m4.compose(orbPos[i]!, q.identity(), sc.setScalar(1 + 0.32 * h)));
        cTmp.copy(tc).lerp(ground, dark ? 0.55 : 0.45).lerp(cDim, (1 - w) * 0.6);
        pads.setColorAt(i, cTmp);
        stems.setColorAt(i, cTmp.copy(tc).lerp(cDim, 0.35 + (1 - w) * 0.5));
        const ga = (dark ? 0.62 : 0.34) * (0.12 + 0.88 * w) + (dark ? 0.35 : 0.22) * h;
        glows.set(i, orbPos[i]!, (dark ? 1.05 : 0.8) + 0.55 * h, tc, ga);
      }
      for (const m of [orbs, pads, stems]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    };
    const writeTubes = () => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      const attr = tubeGeo.getAttribute('color') as Float32BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let k = 0; k < E; k++) {
        const e = edges[k]!;
        const a = trackColor(p, nodes[e.from]!.a.track);
        const b = trackColor(p, nodes[e.to]!.a.track);
        const w = edgeW[k]!;
        const alpha = w < 0.02 ? 0 : (dark ? 0.04 : 0.05) + (dark ? 0.8 : 0.78) * w * w;
        const [start, count] = tubeRange[k]!;
        for (let v = start; v < start + count; v++) {
          cTmp.copy(a).lerp(b, tubeU[v]!);
          if (dark) cTmp.lerp(p.fg, 0.12 * w);
          const o = v * 4;
          arr[o] = cTmp.r;
          arr[o + 1] = cTmp.g;
          arr[o + 2] = cTmp.b;
          arr[o + 3] = alpha;
        }
      }
      attr.needsUpdate = true;
    };
    const writeFlow = () => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      flow.recolor((k) => {
        const w = edgeW[k]!;
        const cols = edgeColors(p, k, flowLen[k]!);
        if (w >= 0.9) return cols;
        // Dimmed paths fade into the terrain (light) or towards black (dark, additive).
        const amt = w >= EDGE_REST - 0.01 ? (dark ? 0.35 : 0.3) : dark ? 0.92 : 0.85;
        const ground = terrainCap(p, 2);
        return cols.map((c) => (dark ? c.multiplyScalar(1 - amt) : c.lerp(ground, amt)));
      });
    };
    const writeStatic = (p: Palette) => {
      const dark = p.theme === 'dark';
      // Rim lines: terrace rims stronger, steps faint.
      const rc = rimGeo.getAttribute('color') as Float32BufferAttribute;
      const ink = dark ? p.fg : p.fg.clone().lerp(p.muted, 0.35);
      rimOwner.forEach((i, v) => {
        const lv = CONTOURS[i]!.level;
        const c = terrainCap(p, i).lerp(ink, dark ? 0.45 : 0.4);
        rc.setXYZW(v, c.r, c.g, c.b, lv ? (dark ? 0.6 : 0.55) : dark ? 0.2 : 0.22);
      });
      rc.needsUpdate = true;
      const fc = floorGeo.getAttribute('color') as Float32BufferAttribute;
      const gc = p.grid.clone().lerp(p.fg, dark ? 0.12 : 0.08);
      floorFade.forEach((f, v) => fc.setXYZW(v, gc.r, gc.g, gc.b, f * (dark ? 0.75 : 0.85)));
      fc.needsUpdate = true;
      shadowMat.color.copy(dark ? p.bg.clone().lerp(p.flow, 0.25) : p.fg);
      shadowMat.opacity = dark ? 0.22 : 0.09;
      stemMat.color.set(1, 1, 1);
      orbs.material = dark ? orbGlow : orbLit;
      flow.setTheme(p.theme);
      flow.setSize(dark ? 0.085 : 0.065);
      flow.setOpacity(dark ? 0.95 : 0.85);
      glows.setTheme(p.theme);
      glows.set(N, flagBase.clone().add(new Vector3(0.3, 0.95, 0)), dark ? 1.5 : 1.1, p.highlight, dark ? 0.35 : 0.18);
      lights.apply(p);
    };
    const redraw = () => {
      writeNodes();
      writeTubes();
      ctx.invalidate();
    };

    /* ───────── focus (steps, hover, list) ───────── */
    interface Focus {
      nodes: (i: number) => number;
      edges: (k: number) => number;
      labels: Set<number>;
      /** Max node labels shown at once. */
      max: number;
    }
    const levelFocus = (lv: Level): Focus => ({
      nodes: (i) => {
        const d = nodes[i]!.level - lv;
        return d === 0 ? 1 : d < 0 ? 0.55 : 0.28;
      },
      edges: (k) => {
        const e = edges[k]!;
        const to = nodes[e.to]!.level;
        const from = nodes[e.from]!.level;
        if (to === lv) return 1;
        if (lv === 1 && from === 1) return 0.3;
        return 0.04;
      },
      labels: new Set(nodes.filter((n) => n.level === lv).map((n) => n.i)),
      max: 14,
    });
    const STEP_FOCUS: (() => Focus)[] = [
      // Overview: only a few names, taken from the nearest 入門 articles (where the climb starts).
      () => ({ nodes: () => 1, edges: () => EDGE_REST, labels: new Set(nodes.filter((n) => n.level === 1).map((n) => n.i)), max: 3 }),
      () => levelFocus(1),
      () => levelFocus(2),
      () => levelFocus(3),
      () => ({
        nodes: (i) => (routeSet.has(i) ? 1 : 0.25),
        edges: (k) => (routeSet.has(edges[k]!.from) && routeSet.has(edges[k]!.to) ? 1 : 0.04),
        labels: routeSet,
        max: 14,
      }),
    ];
    const nodeFocus = (i: number): Focus => {
      const set = new Set([i, ...prevOf[i]!, ...nextOf[i]!]);
      const own = new Set(edgesOf[i]);
      return { nodes: (j) => (set.has(j) ? 1 : 0.3), edges: (k) => (own.has(k) ? 1 : 0.05), labels: set, max: 10 };
    };
    const groupFocus = (members: Set<number>, edgeTest: (k: number) => boolean, max = 0): Focus => ({
      nodes: (j) => (members.has(j) ? 1 : 0.3),
      edges: (k) => (edgeTest(k) ? 1 : 0.05),
      labels: max ? members : new Set(),
      max,
    });

    let curStep = 0;
    let stepFocus: Focus = STEP_FOCUS[0]!();
    let hoverFocus: Focus | null = null;
    let focusTween: { cancel(): void } | null = null;
    const applyFocus = () => {
      const f = hoverFocus ?? stepFocus;
      focusTween?.cancel();
      const n0 = Float32Array.from(nodeW);
      const e0 = Float32Array.from(edgeW);
      const n1 = Float32Array.from(nodes, (_, i) => f.nodes(i));
      const e1 = Float32Array.from(edges, (_, k) => f.edges(k));
      focusTween = ctx.tween.run(
        (k) => {
          for (let i = 0; i < N; i++) nodeW[i] = n0[i]! + (n1[i]! - n0[i]!) * k;
          for (let i = 0; i < E; i++) edgeW[i] = e0[i]! + (e1[i]! - e0[i]!) * k;
          redraw();
        },
        { duration: 380, ease: 'cubicOut', fade: true, onComplete: () => writeFlow() },
      );
      writeFlow();
      updateLabels();
    };

    /* ───────── labels ───────── */
    // Fixed labels (terrace names, signs, landmarks, the route goal) are mirrored here so the
    // article-label pass below (labelPlace.ts) keeps clear of them.
    interface FixedLabel {
      pos: Vector3;
      align: NonNullable<LabelSpec['align']>;
      offset: readonly [number, number];
      kind: NonNullable<LabelSpec['kind']>;
      text: string;
      swatch: boolean;
      visible: boolean;
    }
    const v3 = (p: LabelSpec['position']): Vector3 =>
      p instanceof Vector3 ? p.clone() : p ? new Vector3(p[0], p[1], p[2]) : new Vector3();
    const fixedLabels: FixedLabel[] = [];
    let labelsDirty = true;
    const addFixed = (spec: LabelSpec): LabelHandle => {
      const f: FixedLabel = {
        pos: v3(spec.position),
        align: spec.align ?? 'center',
        offset: spec.offset ?? [0, 0],
        kind: spec.kind ?? 'default',
        text: spec.text,
        swatch: !!spec.swatch,
        visible: spec.visible !== false,
      };
      fixedLabels.push(f);
      const h = labels.add(spec);
      return {
        set(patch) {
          if (patch.position) f.pos.copy(v3(patch.position));
          if (patch.align) f.align = patch.align;
          if (patch.offset) f.offset = patch.offset;
          if (patch.kind) f.kind = patch.kind;
          if (patch.text !== undefined) f.text = patch.text;
          if (patch.swatch !== undefined) f.swatch = !!patch.swatch;
          if (patch.visible !== undefined) f.visible = patch.visible;
          labelsDirty = true;
          h.set(patch);
        },
        remove() {
          f.visible = false;
          h.remove();
        },
        get shown() {
          return h.shown;
        },
      };
    };
    // Label sizes, measured with the LabelLayer's own markup and styles (cleared on resize: the
    // font size follows the stage width).
    const labelHost = ctx.stage.querySelector<HTMLElement>('.scene-labels') ?? ctx.stage;
    const measurer = document.createElement('div');
    measurer.className = 'scene-label';
    measurer.setAttribute('aria-hidden', 'true');
    measurer.style.cssText = 'visibility:hidden;transform:none;left:-9999px;top:0';
    labelHost.appendChild(measurer);
    const sizes = new Map<string, [number, number]>();
    const labelSize = (kind: string, swatch: boolean, text: string): [number, number] => {
      const key = `${kind}|${swatch ? 1 : 0}|${text}`;
      let s = sizes.get(key);
      if (!s) {
        measurer.dataset['kind'] = kind;
        measurer.textContent = '';
        if (swatch) {
          const dot = document.createElement('i');
          dot.className = 'scene-label-swatch';
          measurer.appendChild(dot);
        }
        measurer.appendChild(document.createTextNode(text));
        s = [Math.ceil(measurer.offsetWidth), Math.ceil(measurer.offsetHeight)];
        sizes.set(key, s);
      }
      return s;
    };

    // Article labels hang off the orb; the pass picks the side. Preferred sides: outwards on the
    // flanks (where the row climbs across the screen), below / above for the front and back rows
    // of a staggered row, alternating above / below along a single row at the front; then the
    // same sides shifted outwards.
    const rowK: number[] = [];
    {
      const seen = new Map<number, number>();
      for (const n of nodes) {
        const k = (seen.get(n.level) ?? -1) + 1;
        seen.set(n.level, k);
        rowK.push(k);
      }
    }
    const nodePrefer: Side[][] = nodes.map((n, i) => {
      const L = n.theta < 0;
      const out: Side = L ? 'left' : 'right';
      const inn: Side = L ? 'right' : 'left';
      const bOut: Side = L ? 'belowL' : 'belowR';
      const aOut: Side = L ? 'aboveL' : 'aboveR';
      if (Math.abs(n.theta) > (n.level === 3 ? 1.35 : 0.88)) return [out, bOut, aOut, 'below', 'above', inn];
      const band = BAND_F[n.level];
      if (n.f > band + 0.01) return ['below', bOut, out, 'above', aOut, inn];
      if (n.f < band - 0.01) return ['above', aOut, out, 'below', bOut, inn];
      return rowK[i]! % 2 ? ['below', 'above', bOut, aOut, out, inn] : ['above', 'below', aOut, bOut, out, inn];
    });
    const nodeText = nodes.map((n) => shortTitle(n.a.title));
    const nodeLabels: LabelHandle[] = nodes.map((n, i) =>
      labels.add({
        text: nodeText[i]!,
        position: orbPos[i]!,
        align: alignOf(nodePrefer[i]![0]!),
        swatch: ctx.palette.css[`layer-${TRACK_LAYER[n.a.track]}`] ?? '',
        priority: 10,
        hotspot: n.a.slug,
        visible: false,
      }),
    );
    const nodeSide: (Side | null)[] = nodes.map(() => null);
    const nodeOff: [number, number][] = nodes.map(() => [0, 0]);
    const nodeShown = new Uint8Array(N);

    // Terrace names (colour means track in this scene, so they carry no swatch).
    const terraceLabels = levels.map((lv) => {
      const count = nodes.filter((n) => n.level === lv).length;
      return {
        lv,
        h: addFixed({
          text: `${LEVEL_NAME[lv]}・${count} 篇`,
          kind: 'strong',
          priority: 40,
          hotspot: `level-${lv}`,
        }),
      };
    });
    const placeTerraceLabels = () => {
      // Wide overview: a legend down the terraces' left rims. Closer steps and narrow stages: a sign
      // on each terrace's front-left wall (the left rims leave the frame when the camera moves in).
      const legend = ctx.size.aspect >= 1.2 && curStep === 0;
      const kind = ctx.size.width < 600 ? 'default' : 'strong';
      for (const t of terraceLabels) {
        const c = CONTOURS[terraceIndex(t.lv)]!;
        if (!legend) {
          t.h.set({ kind, position: narrowTagPoint(t.lv), align: 'center', offset: [0, 0] });
        } else {
          const th = -Math.PI / 2 + 0.08;
          const r = contourRadius(c, th) - BEVEL * 0.5;
          t.h.set({ kind, position: [c.cx + Math.sin(th) * r, c.top, c.cz + Math.cos(th) * r], align: 'left', offset: [0, -2] });
        }
      }
    };
    placeTerraceLabels();
    const trailheadLabel = first
      ? addFixed({
          text: '登山口',
          position: [first.x, first.y, first.z + 0.32],
          align: 'below',
          kind: 'tag',
          priority: 36,
          hotspot: 'trailhead',
        })
      : null;
    const summitLabel = addFixed({
      text: '山頂',
      position: [flagBase.x + 0.3, flagBase.y + 1.12, flagBase.z],
      align: 'right',
      kind: 'tag',
      priority: 35,
    });
    // Track signs on the floor in front of the base wall, below each track's direction.
    const trackSigns = TRACK_ORDER.filter((t) => nodes.some((n) => n.a.track === t)).map((t) => {
      const own = nodes.filter((n) => n.a.track === t);
      const th = own.reduce((s, n) => s + n.theta, 0) / own.length;
      return {
        t,
        th,
        h: addFixed({
          text: TRACK_NAME[t],
          align: 'center',
          kind: 'tag',
          swatch: ctx.palette.css[`layer-${TRACK_LAYER[t]}`] ?? '',
          priority: 30,
          hotspot: `track-${t}`,
        }),
      };
    });
    /** Wide stages: each sign below its track's direction. Narrow stages: the flanks leave the
     *  frame, so the signs line up (same left → right order) on the floor in front of the mountain. */
    const placeTrackSigns = () => {
      const narrow = ctx.size.aspect < 1.2;
      const b0 = CONTOURS[0]!;
      const n = trackSigns.length;
      trackSigns.forEach((s, k) => {
        const ts = narrow ? (n > 1 ? -0.62 + (1.24 * k) / (n - 1) : 0) : s.th * 0.92;
        const r = contourRadius(b0, ts) + (narrow ? 0.75 : 0.42);
        s.h.set({ position: [b0.cx + Math.sin(ts) * r, GROUND_Y, b0.cz + Math.cos(ts) * r] });
      });
    };
    placeTrackSigns();

    let labelCands = new Set<number>();
    let labelMax = 0;
    const updateLabels = () => {
      const f = hoverFocus ?? stepFocus;
      const overview = curStep === 0 && !hoverFocus;
      // Small stages (phones): the overview keeps only the terrace names and the two landmarks.
      const small = ctx.size.width < 600;
      for (const s of trackSigns) s.h.set({ visible: overview && !small });
      trailheadLabel?.set({ visible: curStep <= 1 || !!hoverFocus });
      summitLabel.set({ visible: curStep === 0 || curStep === 3 });
      const routeOn = curStep === 4 && !hoverFocus && target >= 0;
      routeLabel?.set({ visible: routeOn });
      labelCands = new Set(f.labels);
      if (routeOn) labelCands.delete(target);
      if (hoverFocus && hovered >= 0) labelCands.add(hovered);
      labelMax = small ? (overview ? 0 : Math.max(2, Math.round(f.max * 0.35))) : f.max;
      labels.setMax(fixedLabels.filter((l) => l.visible).length + labelMax + 1);
      labelsDirty = true;
      ctx.invalidate();
    };

    /* ───────── article-label pass (before a frame, whenever the view or the label set changed) ───────── */
    const viewSig = new Float64Array(20);
    const vScr = new Vector3();
    const vAux = new Vector3();
    const scr = { x: 0, y: 0 };
    const project = (w: Vector3): boolean => {
      vScr.copy(w).project(ctx.camera);
      scr.x = ((vScr.x + 1) / 2) * ctx.size.width;
      scr.y = ((1 - vScr.y) / 2) * ctx.size.height;
      return vScr.z < 1 && vScr.z > -1;
    };
    const layoutLabels = () => {
      const cam = ctx.camera;
      const W = ctx.size.width;
      const H = ctx.size.height;
      cam.updateMatrixWorld();
      const me = cam.matrixWorld.elements;
      const pe = cam.projectionMatrix.elements;
      let changed = labelsDirty;
      for (let k = 0; k < 16; k++) {
        if (viewSig[k] !== me[k]) {
          viewSig[k] = me[k]!;
          changed = true;
        }
      }
      const tail = [pe[0]!, pe[5]!, W, H];
      for (let k = 0; k < 4; k++) {
        if (viewSig[16 + k] !== tail[k]) {
          viewSig[16 + k] = tail[k]!;
          changed = true;
        }
      }
      if (!changed) return;
      labelsDirty = false;

      const taken: Rect[] = [];
      for (const l of fixedLabels) {
        if (!l.visible || !l.text || occluded(l.pos) || !project(l.pos)) continue;
        const [w, h] = labelSize(l.kind, l.swatch, l.text);
        let x = scr.x - w / 2;
        let y = scr.y - h / 2;
        if (l.align === 'above') y = scr.y - h - 8;
        else if (l.align === 'below') y = scr.y + 8;
        else if (l.align === 'left') x = scr.x - w - 10;
        else if (l.align === 'right') x = scr.x + 10;
        taken.push({ x: x + l.offset[0], y: y + l.offset[1], w, h });
      }

      const f = hoverFocus ?? stepFocus;
      const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
      const hard = new Map<number, Rect>();
      const soft = new Map<number, Rect>();
      const cands: (PlaceCandidate & { depth: number })[] = [];
      for (let i = 0; i < N; i++) {
        const o = orbPos[i]!;
        if (occluded(o)) continue;
        const depth = -vAux.copy(o).applyMatrix4(cam.matrixWorldInverse).z;
        if (depth <= 0 || !project(o)) continue;
        const cx = scr.x;
        const cy = scr.y;
        const px = H / 2 / (depth * tanHalf);
        const r = ORB_R * px * (1 + 0.32 * nodeH[i]!);
        const n = nodes[i]!;
        project(vAux.set(n.x, n.y, n.z));
        // Obstacle = orb and stem (a label may overlap the flat pad on the ground).
        const top = cy - r;
        const bottom = Math.max(cy + r, scr.y);
        (f.nodes(i) >= 0.6 ? hard : soft).set(i, { x: cx - r, y: top, w: 2 * r, h: bottom - top });
        if (!labelCands.has(i)) continue;
        const [w, h] = labelSize('default', true, nodeText[i]!);
        cands.push({ key: i, cx, cy, top, bottom, r, w, h, prefer: nodePrefer[i]!, prev: nodeShown[i] ? nodeSide[i]! : null, depth });
      }
      // The hovered article first, then the nearest ones.
      const hov = hoverFocus ? hovered : -1;
      cands.sort((a, b) => Number(b.key === hov) - Number(a.key === hov) || a.depth - b.depth);
      const placed = placeLabels(cands, taken, hard, soft, W, H, labelMax);
      const byKey = new Map(cands.map((c) => [c.key, c]));
      for (let i = 0; i < N; i++) {
        const side = placed.get(i);
        const c = byKey.get(i);
        if (side && c) {
          const off = offsetFor(c, side);
          const cur = nodeOff[i]!;
          if (!nodeShown[i] || nodeSide[i] !== side || cur[0] !== off[0] || cur[1] !== off[1]) {
            nodeShown[i] = 1;
            nodeSide[i] = side;
            nodeOff[i] = off;
            nodeLabels[i]!.set({ visible: true, align: alignOf(side), offset: off });
          }
        } else if (nodeShown[i]) {
          nodeShown[i] = 0;
          nodeLabels[i]!.set({ visible: false });
        }
      }
    };

    /* ───────── occlusion (labels and picking behind the mountain) ───────── */
    const camTmp = new Vector3();
    const occluded = (w: Vector3, camera: PerspectiveCamera = ctx.camera): boolean => {
      camTmp.copy(camera.position);
      const S = 16;
      for (let s = 1; s < S; s++) {
        const t = 0.06 + (0.9 * s) / S;
        const x = camTmp.x + (w.x - camTmp.x) * t;
        const y = camTmp.y + (w.y - camTmp.y) * t;
        const z = camTmp.z + (w.z - camTmp.z) * t;
        if (y < heightAt(x, z) - 0.04) return true;
      }
      return false;
    };
    labels.setOccluder((w, cam) => occluded(w, cam));

    /* ───────── hotspots & cards ───────── */
    let hovered = -1;
    const setHover = (i: number, on: boolean) => {
      if (on) {
        hovered = i;
        nodeH[i] = 1;
        hoverFocus = nodeFocus(i);
      } else {
        if (hovered === i) {
          hovered = -1;
          hoverFocus = null;
        }
        nodeH[i] = 0;
      }
      applyFocus();
    };
    const setGroup = (f: Focus | null) => {
      hoverFocus = f;
      applyFocus();
    };
    const titleOf = (i: number) => nodes[i]!.a.title;
    const cardFor = (i: number, prefix = ''): CardContent => {
      const n = nodes[i]!;
      const pre = prevOf[i]!.map((j) => nodes[j]!).sort((a, b) => a.a.order - b.a.order);
      const nxt = nextOf[i]!.map((j) => nodes[j]!).sort((a, b) => a.a.order - b.a.order);
      const c: CardContent = {
        title: `${prefix}${n.a.title}`,
        subtitle: `${LEVEL_NAME[n.level]}・${TRACK_NAME[n.a.track]}・編號 ${n.a.order}`,
        swatch: ctx.palette.css[`layer-${TRACK_LAYER[n.a.track]}`] ?? '',
        body: pre.length ? `建議先讀 ${pre.length} 篇；讀完可接著讀 ${nxt.length} 篇。` : `登山口：不需要先讀其他文章；讀完可接著讀 ${nxt.length} 篇。`,
        href: n.a.href,
        linkLabel: '開啟文章 →',
      };
      const items = [
        ...pre.map((m) => ({ label: shortTitle(m.a.title), meta: '先讀', href: m.a.href })),
        ...nxt.slice(0, Math.max(2, 6 - pre.length)).map((m) => ({ label: shortTitle(m.a.title), meta: '接著讀', href: m.a.href })),
      ];
      if (items.length) c.items = items;
      return c;
    };
    const poseNear = (v: Vector3): CameraPose => ({
      position: [v.x * 0.6 + 1.2, v.y + 6.2, v.z + 9.4],
      target: [v.x * 0.8, v.y, v.z],
    });
    nodes.forEach((n, i) => {
      hotspots.register(n.a.slug, {
        label: titleOf(i),
        href: n.a.href,
        anchor: orbPos[i]!,
        card: () => cardFor(i),
        onHighlight: (on) => setHover(i, on),
        pose: poseNear(orbPos[i]!),
      });
    });
    const pickList = nodes.map((n, i) => ({ position: orbPos[i]!, id: n.a.slug }));
    ctx.picker.addPoints(() => pickList, { cull: (w) => occluded(w) });

    if (first) {
      hotspots.register('trailhead', {
        href: first.a.href,
        anchor: orbPos[first.i]!,
        card: () => cardFor(first.i, '登山口：'),
        onHighlight: (on) => setHover(first.i, on),
        pose: STEP_POSES[1]!,
      });
    }
    const listItems = (members: number[]) =>
      members
        .map((j) => nodes[j]!)
        .sort((a, b) => a.a.order - b.a.order)
        .slice(0, 8)
        .map((m) => ({ label: shortTitle(m.a.title), meta: `${m.a.order}`, href: m.a.href }));
    for (const lv of [1, 2, 3] as const) {
      const members = nodes.filter((n) => n.level === lv).map((n) => n.i);
      const c = CONTOURS[terraceIndex(lv)]!;
      hotspots.register(`level-${lv}`, {
        anchor: new Vector3(c.cx, c.top + 0.3, c.cz + contourRadius(c, 0) * 0.85),
        onHighlight: (on) => setGroup(on ? groupFocus(new Set(members), (k) => nodes[edges[k]!.to]!.level === lv, 8) : null),
        card: () => {
          const h = hsText.get(`level-${lv}`);
          const card: CardContent = { title: `${h?.label ?? LEVEL_NAME[lv]}・${members.length} 篇` };
          if (h?.detail) card.body = h.detail;
          const items = listItems(members);
          if (items.length) card.items = items;
          return card;
        },
        pose: STEP_POSES[lv]!,
      });
    }
    hotspots.register('prereq-trails', {
      anchor: new Vector3(0, 1.6, 2.2),
      onHighlight: (on) => setGroup(on ? groupFocus(new Set(nodes.map((n) => n.i)), () => true) : null),
    });
    for (const t of TRACK_ORDER) {
      const members = nodes.filter((n) => n.a.track === t).map((n) => n.i);
      const set = new Set(members);
      const centre = members.reduce((s, j) => s.add(orbPos[j]!), new Vector3()).divideScalar(Math.max(1, members.length));
      hotspots.register(`track-${t}`, {
        anchor: centre,
        onHighlight: (on) =>
          setGroup(on ? groupFocus(set, (k) => set.has(edges[k]!.from) && set.has(edges[k]!.to), members.length > 6 ? 0 : 6) : null),
        card: () => {
          const h = hsText.get(`track-${t}`);
          const per = ([1, 2, 3] as const).map((lv) => `${LEVEL_NAME[lv]} ${members.filter((j) => nodes[j]!.level === lv).length} 篇`).join('・');
          const card: CardContent = { title: TRACK_NAME[t], subtitle: per, swatch: ctx.palette.css[`layer-${TRACK_LAYER[t]}`] ?? '' };
          if (h?.detail) card.body = h.detail;
          const items = listItems(members);
          if (items.length) card.items = items;
          return card;
        },
        pose: members.length ? poseNear(centre) : ctx.homePose,
      });
    }

    /* ───────── steps ───────── */
    /** Frame the route's bounding box from the home viewing angle. */
    const routePose = (): CameraPose => {
      if (!routeSet.size) return ctx.homePose;
      const box = new Box3();
      for (const j of routeSet) box.expandByPoint(orbPos[j]!);
      const c = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      const portrait = ctx.size.portrait;
      const dir = portrait ? PORTRAIT_DIR : HOME_DIR;
      const d = portrait
        ? Math.max(12, size.x * 1.45 + 3) / PORTRAIT_ZOOM
        : Math.max(12, Math.max(size.x, size.z * 1.4) * 1.4 + 4);
      return { position: [c.x + dir.x * d, c.y + dir.y * d, c.z + dir.z * d], target: [c.x, c.y, c.z] };
    };
    let routeLabel: LabelHandle | null = null;
    if (target >= 0) {
      routeLabel = addFixed({
        text: `目標：${shortTitle(nodes[target]!.a.title)}`,
        position: [orbPos[target]!.x, orbPos[target]!.y + 0.25, orbPos[target]!.z],
        align: 'above',
        kind: 'strong',
        swatch: ctx.palette.css[`layer-${TRACK_LAYER[nodes[target]!.a.track]}`] ?? '',
        priority: 45,
        visible: false,
      });
    }
    const stepPose = (i: number): CameraPose =>
      i === 4 ? routePose() : ((ctx.size.portrait ? STEP_POSES_PORTRAIT : STEP_POSES)[i] ?? ctx.homePose);
    let wasPortrait = ctx.size.portrait;
    const showStep = (i: number) => {
      curStep = i;
      stepFocus = (STEP_FOCUS[i] ?? STEP_FOCUS[0]!)();
      hoverFocus = null;
      nodeSide.fill(null);
      placeTerraceLabels();
      applyFocus();
      ctx.setPose(stepPose(i));
    };

    /* ───────── palette ───────── */
    const applyPalette = (p: Palette) => {
      writeStatic(p);
      writeNodes();
      writeTubes();
      writeFlow();
      nodeLabels.forEach((h, i) => h.set({ swatch: p.css[`layer-${TRACK_LAYER[nodes[i]!.a.track]}`] ?? '' }));
      for (const s of trackSigns) s.h.set({ swatch: p.css[`layer-${TRACK_LAYER[s.t]}`] ?? '' });
      if (routeLabel && target >= 0) routeLabel.set({ swatch: p.css[`layer-${TRACK_LAYER[nodes[target]!.a.track]}`] ?? '' });
    };
    applyPalette(ctx.palette);
    updateLabels();

    const setStill = () => {
      flag.rotation.y = 0;
    };

    return {
      update(_dt, t) {
        flow.update(t);
        if (ctx.animate) flag.rotation.y = 0.22 * Math.sin(t * 1.3) + 0.08 * Math.sin(t * 3.1);
        layoutLabels();
      },
      setStep(i) {
        showStep(i);
      },
      onMotion(animate) {
        flow.setReduced(!animate);
        if (!animate) setStill();
      },
      onQuality(_q, tier) {
        flow.setCount(E ? scaleCount(FLOW_MAX, tier, 60) : 0);
      },
      onPalette(p) {
        applyPalette(p);
      },
      onResize() {
        sizes.clear();
        placeTerraceLabels();
        placeTrackSigns();
        updateLabels();
        // The stage flipped between portrait and landscape: re-frame the current step (the host
        // already re-frames step 0 through homePose).
        if (ctx.size.portrait !== wasPortrait) {
          wasPortrait = ctx.size.portrait;
          if (curStep > 0) ctx.setPose(stepPose(curStep));
        }
      },
      dispose() {
        focusTween?.cancel();
        measurer.remove();
        root.removeFromParent();
      },
    };
  },
});

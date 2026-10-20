/**
 * taiwan-map — 台灣 AI 供應鏈地圖 (variant: map).
 *
 * An extruded Taiwan (src/data/geo/taiwan.json, projected with kit projectTw) with county borders,
 * Penghu in place and Kinmen / Matsu as framed insets, on a faint 1° graticule. Every site in the
 * page data (science parks, fabs, packaging plants, server clusters, HQ clusters) is a tower of
 * stacked discs: one disc per company of the site (本站名冊), so height = company count, discs
 * sorted upstream → downstream; colour = the site's dominant segment. Close sites are relaxed apart
 * with a leader line to their true position. Ports and research institutes are small markers.
 * Gold ArcRibbons ship chips and servers from 桃園機場 / 高雄港 to 美國, 日本, 韓國, 歐洲 (directions
 * only, 示意); cyan arcs bring designs, tools, materials and HBM in.
 *
 * Steps follow 「一顆 AI 晶片的旅程」: 總覽 → 晶片設計 → 晶圓製造 → 封裝測試 → 伺服器 → 出貨全球.
 * Steps 1–4 light up the discs of the step's segments (the rest fade), add the matching import arcs
 * and extend a gold journey route (PathFlow) from stop to stop.
 * Hover a tower for its company list (card), click/tap for an interactive card with company links.
 * Reduced motion: no flows (static dotted route), no arc pulses or stop pulse, camera cuts.
 */
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type CardItem,
  type LabelHandle,
  type Palette,
  type PickHit,
  type SceneContext,
  type SegmentId,
  type Tween,
} from '../../core/types';
import { ArcRibbons, type Arc } from '../../kit/ArcRibbons';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { projectTw } from '../../kit/projectTw';
import {
  REGIONS,
  SEG_SHORT,
  SEG_TITLE,
  buildSites,
  isTaiwanData,
  nearestSite,
  relax,
  type Region,
  type SiteModel,
  type TaiwanData,
} from './data';
import { INSETS, LAND_T, buildGraticule, buildIsland, type TwGeo } from './island';
import { createLegend, type LegendState } from './legend';

/* ───────────────────────── constants ───────────────────────── */

type V3 = [number, number, number];
const R_T = 0.04; // tower radius (4 km)
const R_MARK = 0.024;
const GAP = 0.014;
const BASE_Y = 0.004;
const FLOW_MAX = 420;

/** World (x, z) of a real place. */
const at = (lat: number, lon: number): [number, number] => {
  const [x, y] = projectTw(lon, lat);
  return [x, -y];
};

/** Camera on a sphere around `target`: az 0 = from the south, negative = from the west. */
function orbit(target: V3, az: number, el: number, dist: number): CameraPose {
  const c = Math.cos(el);
  return {
    position: [target[0] + dist * Math.sin(az) * c, target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(az) * c],
    target,
  };
}

interface PosePair {
  l: CameraPose;
  p: CameraPose;
}
const HOME: PosePair = {
  l: orbit([0.12, 0.1, 0.12], -0.36, 0.95, 6.7),
  p: orbit([0.02, 0.1, -0.08], -0.2, 1.02, 7.3),
};

/* Destinations: compass directions from Taiwan, at diorama distance (示意, not to scale). */
interface Dest {
  id: 'dest-us' | 'dest-jp' | 'dest-kr' | 'dest-eu';
  name: string;
  l: [number, number];
  p: [number, number];
}
const DESTS: readonly Dest[] = [
  { id: 'dest-us', name: '美國', l: [2.75, -0.5], p: [1.55, -0.45] },
  { id: 'dest-jp', name: '日本', l: [2.45, -1.6], p: [1.35, -2.3] },
  { id: 'dest-kr', name: '韓國', l: [0.85, -2.75], p: [0.45, -2.85] },
  { id: 'dest-eu', name: '歐洲', l: [-2.5, -1.6], p: [-1.45, -2.65] },
];
const DEST_LINKS: Record<Dest['id'], CardItem[]> = {
  'dest-us': [
    { label: '名詞：設計定案（tape-out）', href: '/glossary/#tape-out' },
    { label: '環節：AI 晶片與加速器', href: '/chain/ai-accelerators/' },
  ],
  'dest-jp': [{ label: '環節：半導體設備與材料', href: '/chain/semi-equipment-materials/' }],
  'dest-kr': [
    { label: '名詞：HBM', href: '/glossary/#hbm' },
    { label: '名詞：CoWoS', href: '/glossary/#cowos' },
  ],
  'dest-eu': [{ label: '名詞：EUV', href: '/glossary/#euv' }],
};

/* Real places used by the arcs and the journey (snapped to a data site when one is close). */
const PLACES = {
  airport: { lat: 25.0777, lon: 121.2328 },
  khPort: { lat: 22.6133, lon: 120.2792 },
  hsp: { lat: 24.78, lon: 121.0136 },
  stsp: { lat: 23.107, lon: 120.272 },
  ap6: { lat: 24.7069, lon: 120.9072 },
  ap7: { lat: 23.4742, lon: 120.3016 },
  hwaya: { lat: 25.0436, lon: 121.3727 },
} as const;
type PlaceKey = keyof typeof PLACES;

interface ArcSpec {
  from: PlaceKey | Dest['id'];
  to: PlaceKey | Dest['id'];
  kind: 'export' | 'import';
  height: number;
  label?: string;
  /** where the label sits along the arc (0 = start, 1 = end; default the apex) */
  labelT?: number;
}
const ARCS: readonly ArcSpec[] = [
  { from: 'airport', to: 'dest-us', kind: 'export', height: 0.62 },
  { from: 'airport', to: 'dest-jp', kind: 'export', height: 0.5 },
  { from: 'airport', to: 'dest-kr', kind: 'export', height: 0.42 },
  { from: 'airport', to: 'dest-eu', kind: 'export', height: 0.66 },
  { from: 'khPort', to: 'dest-us', kind: 'export', height: 0.55 },
  { from: 'khPort', to: 'dest-eu', kind: 'export', height: 0.6 },
  { from: 'dest-us', to: 'hsp', kind: 'import', height: 0.55, label: '設計定案' },
  { from: 'dest-eu', to: 'stsp', kind: 'import', height: 0.62, label: 'EUV 曝光機', labelT: 0.7 },
  { from: 'dest-jp', to: 'hsp', kind: 'import', height: 0.48, label: '光阻・矽晶圓', labelT: 0.4 },
  { from: 'dest-kr', to: 'ap6', kind: 'import', height: 0.42 },
  { from: 'dest-kr', to: 'ap7', kind: 'import', height: 0.6, label: 'HBM' },
];
const EXPORTS_AIR = [0, 1, 2, 3];
const EXPORTS_ALL = [0, 1, 2, 3, 4, 5];
const IMPORTS = [6, 7, 8, 9, 10];

/* The chip's journey (示意路線). */
const STOPS: readonly { label: string; place: PlaceKey }[] = [
  { label: '① 設計', place: 'hsp' },
  { label: '② 晶圓', place: 'stsp' },
  { label: '③ 封裝', place: 'ap7' },
  { label: '④ 組裝', place: 'hwaya' },
  { label: '⑤ 出貨', place: 'airport' },
];

interface StepSpec {
  /** segments whose discs light up (null = dominant-colour overview) */
  segs: readonly SegmentId[] | null;
  /** site kinds that count as focused too */
  kinds: readonly string[];
  /** site kinds that stay faded whatever their companies (fabs vs packaging plants share a segment) */
  off?: readonly string[];
  arcs: readonly number[];
  faint: readonly number[];
  /** journey stops revealed */
  stops: number;
  pose: PosePair | null;
}
const STEPS: readonly StepSpec[] = [
  { segs: null, kinds: [], arcs: [], faint: EXPORTS_AIR, stops: 0, pose: null },
  {
    segs: ['eda-ip-design', 'ai-accelerators'],
    kinds: [],
    arcs: [6],
    faint: [],
    stops: 1,
    // Wide enough to show where the designs come from (美國) next to the Hsinchu cluster.
    pose: { l: orbit([0.95, 0.12, -1.15], -0.3, 0.92, 4.5), p: orbit([0.55, 0.12, -1.15], -0.15, 1.0, 5.6) },
  },
  {
    segs: ['foundry-packaging', 'memory-storage', 'semi-equipment-materials'],
    kinds: ['fab'],
    off: ['packaging'],
    arcs: [7, 8],
    faint: [],
    stops: 2,
    pose: { l: orbit([-0.3, 0.1, -0.32], -0.46, 0.94, 6.0), p: orbit([-0.22, 0.1, -0.32], -0.2, 1.02, 7.3) },
  },
  {
    segs: ['foundry-packaging'],
    kinds: ['packaging'],
    off: ['fab'],
    arcs: [9, 10],
    faint: [],
    stops: 3,
    pose: { l: orbit([-0.2, 0.1, -0.5], -0.36, 0.94, 6.3), p: orbit([-0.15, 0.1, -0.6], -0.18, 1.02, 7.3) },
  },
  {
    segs: ['servers-systems', 'networking-optics', 'energy-power', 'datacenter-infra'],
    kinds: ['server-cluster'],
    arcs: [],
    faint: [],
    stops: 4,
    pose: { l: orbit([0.4, 0.18, -1.25], -0.32, 0.9, 3.7), p: orbit([0.35, 0.18, -1.3], -0.15, 0.97, 4.4) },
  },
  {
    segs: null,
    kinds: [],
    arcs: EXPORTS_ALL,
    faint: IMPORTS,
    stops: 5,
    pose: { l: orbit([0.1, 0.1, -0.2], -0.28, 0.98, 7.0), p: orbit([0.0, 0.1, -0.45], -0.12, 1.06, 8.2) },
  },
];

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<TaiwanData>({
  json,
  meta: {
    camera: {
      ...HOME.l,
      fov: 34,
      near: 0.05,
      far: 80,
      minDistance: 1.4,
      maxDistance: 11,
      minPolar: 0.18,
      maxPolar: 1.22,
      minAzimuth: -1.6,
      maxAzimuth: 1.2,
      portrait: { ...HOME.p, fov: 38 },
    },
    controls: 'orbit',
    pan: true,
    loop: 'continuous',
    budget: { calls: 40, tris: 120_000 },
  },
  guard: isTaiwanData,
  fixture: () => import('../../fixtures/taiwan-map.json'),

  async create(ctx: SceneContext<TaiwanData>) {
    const { scene, materials, labels, hotspots } = ctx;
    const geo = (await import('../../../data/geo/taiwan.json')).default as unknown as TwGeo;
    const root = new Group();
    root.name = 'taiwan-map';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const m4 = new Matrix4();
    const q = new Quaternion();
    const v = new Vector3();
    const sc = new Vector3();
    const tmpC = new Color();

    /* ───────── data → sites ───────── */
    const sites: SiteModel[] = ctx.data ? buildSites(ctx.data) : [];
    const maxN = Math.max(1, ...sites.map((s) => s.slices.length));
    const pitch = Math.min(0.032, 0.85 / maxN);
    const sliceH = pitch * 0.76;
    const footprint = (s: SiteModel) => (s.slices.length ? R_T + 0.008 : R_MARK);
    relax(sites, footprint, GAP);
    const towerTop = (s: SiteModel) => (s.slices.length ? BASE_Y + s.slices.length * pitch : 0.07);
    const place = (key: PlaceKey): { x: number; z: number; site: SiteModel | null } => {
      const p = PLACES[key];
      const s = nearestSite(sites, p.lat, p.lon, 7);
      if (s) return { x: s.px, z: s.pz, site: s };
      const [x, z] = at(p.lat, p.lon);
      return { x, z, site: null };
    };

    /* ───────── sea, graticule, island ───────── */
    const seaTex = ctx.track(radialTexture(256));
    const seaMat = ctx.track(new MeshBasicMaterial({ map: seaTex, transparent: true, depthWrite: false, toneMapped: false }));
    const sea = new Mesh(ctx.track(new CircleGeometry(5.6, 72)), seaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, -LAND_T - 0.004, -0.4);
    sea.renderOrder = -2;
    root.add(sea);

    const grat = buildGraticule(-LAND_T - 0.002, 4.2);
    const gratMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const gratLines = new LineSegments(ctx.track(grat.geometry), gratMat);
    gratLines.renderOrder = -1;
    root.add(gratLines);

    const island = buildIsland(geo);
    const landMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02 }));
    const land = new Mesh(ctx.track(island.land), landMat);
    root.add(land);
    const coastMat = materials.line('fg', { transparent: true, opacity: 0.4, depthWrite: false });
    const coast = new LineSegments(ctx.track(island.coast), coastMat);
    coast.renderOrder = 1;
    root.add(coast);
    const borderMat = materials.line('muted', { transparent: true, opacity: 0.5, depthWrite: false });
    const borders = new LineSegments(ctx.track(island.borders), borderMat);
    borders.renderOrder = 1;
    root.add(borders);

    // Decor: inset frames, scale bar (50 km) and a north arrow, one LineSegments.
    const decorPos = Array.from(island.frames.getAttribute('position').array as Float32Array);
    const SB: V3 = [0.98, -LAND_T + 0.004, 1.92];
    const yb = SB[1];
    decorPos.push(SB[0], yb, SB[2], SB[0] + 0.5, yb, SB[2]);
    for (const dx of [0, 0.25, 0.5]) decorPos.push(SB[0] + dx, yb, SB[2] - 0.035, SB[0] + dx, yb, SB[2] + (dx === 0.25 ? 0 : 0.035));
    const NA: V3 = [1.62, yb, 1.62];
    decorPos.push(NA[0], yb, NA[2] + 0.12, NA[0], yb, NA[2] - 0.16);
    decorPos.push(NA[0], yb, NA[2] - 0.16, NA[0] - 0.05, yb, NA[2] - 0.08, NA[0], yb, NA[2] - 0.16, NA[0] + 0.05, yb, NA[2] - 0.08);
    island.frames.dispose();
    const decorGeo = ctx.track(new BufferGeometry());
    decorGeo.setAttribute('position', new Float32BufferAttribute(decorPos, 3));
    const decorMat = materials.line('fg', { transparent: true, opacity: 0.35, depthWrite: false });
    root.add(new LineSegments(decorGeo, decorMat));

    /* ───────── towers ───────── */
    interface SliceRef {
      site: number;
      k: number;
    }
    const sliceRefs: SliceRef[] = [];
    for (const s of sites) s.slices.forEach((_, k) => sliceRefs.push({ site: s.index, k }));
    const sliceGeo = ctx.track(new CylinderGeometry(R_T, R_T, sliceH, 24, 1));
    sliceGeo.translate(0, sliceH / 2, 0);
    const sliceMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.12 }));
    const slices = new InstancedMesh(sliceGeo, sliceMat, Math.max(1, sliceRefs.length));
    slices.count = sliceRefs.length;
    slices.instanceMatrix.setUsage(DynamicDrawUsage);
    sliceRefs.forEach((r, i) => {
      const s = sites[r.site]!;
      slices.setMatrixAt(i, m4.makeTranslation(s.px, BASE_Y + r.k * pitch, s.pz));
    });
    slices.setColorAt(0, tmpC.set(0, 0, 0));
    slices.frustumCulled = false;
    root.add(slices);
    ctx.track({ dispose: () => slices.dispose() });

    // Base pads: round rings for areas, square rings for single plants / ports / institutes.
    const areaSites = sites.filter((s) => s.area);
    const plantSites = sites.filter((s) => !s.area);
    const ringRound = ctx.track(new RingGeometry(R_T + 0.006, R_T + 0.017, 40, 1));
    ringRound.rotateX(-Math.PI / 2);
    const ringSquare = ctx.track(new RingGeometry(R_T + 0.008, R_T + 0.02, 4, 1, Math.PI / 4));
    ringSquare.rotateX(-Math.PI / 2);
    const baseMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    const makeBases = (geo: BufferGeometry, list: SiteModel[]) => {
      const m = new InstancedMesh(geo, baseMat, Math.max(1, list.length));
      m.count = list.length;
      list.forEach((s, i) => {
        const r = s.slices.length ? 1 : 0.62;
        m.setMatrixAt(i, m4.compose(v.set(s.px, BASE_Y, s.pz), q.identity(), sc.set(r, 1, r)));
      });
      m.setColorAt(0, tmpC.set(0, 0, 0));
      m.renderOrder = 2;
      root.add(m);
      ctx.track({ dispose: () => m.dispose() });
      return m;
    };
    const basesRound = makeBases(ringRound, areaSites);
    const basesSquare = makeBases(ringSquare, plantSites);

    // Markers for sites without companies (ports, institutes).
    const emptySites = sites.filter((s) => !s.slices.length);
    const markGeo = ctx.track(new OctahedronGeometry(0.026, 0));
    const markMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 }));
    const markers = new InstancedMesh(markGeo, markMat, Math.max(1, emptySites.length));
    markers.count = emptySites.length;
    emptySites.forEach((s, i) => markers.setMatrixAt(i, m4.compose(v.set(s.px, 0.05, s.pz), q.identity(), sc.set(1, 1.35, 1))));
    markers.setColorAt(0, tmpC.set(0, 0, 0));
    root.add(markers);
    ctx.track({ dispose: () => markers.dispose() });

    // Leader lines + true-position dots for displaced sites.
    const leaderPos: number[] = [];
    const moved = sites.filter((s) => Math.hypot(s.px - s.x, s.pz - s.z) > 0.012);
    for (const s of moved) {
      const d = Math.hypot(s.px - s.x, s.pz - s.z);
      const r = footprint(s) / d;
      leaderPos.push(s.x, 0.005, s.z, s.px + (s.x - s.px) * r, 0.005, s.pz + (s.z - s.pz) * r);
    }
    const leaderGeo = ctx.track(new BufferGeometry());
    leaderGeo.setAttribute('position', new Float32BufferAttribute(leaderPos, 3));
    const leaderMat = materials.line('fg', { transparent: true, opacity: 0.45, depthWrite: false });
    const leaders = new LineSegments(leaderGeo, leaderMat);
    leaders.renderOrder = 2;
    root.add(leaders);
    const dotGeo = ctx.track(new CircleGeometry(0.008, 12));
    dotGeo.rotateX(-Math.PI / 2);
    const dotMat = materials.basic('fg', { transparent: true, opacity: 0.7, depthWrite: false });
    const dots = new InstancedMesh(dotGeo, dotMat, Math.max(1, moved.length));
    dots.count = moved.length;
    moved.forEach((s, i) => dots.setMatrixAt(i, m4.makeTranslation(s.x, 0.006, s.z)));
    dots.renderOrder = 2;
    root.add(dots);
    ctx.track({ dispose: () => dots.dispose() });

    // Invisible picking proxies (one per site).
    const proxyGeo = ctx.track(new CylinderGeometry(1, 1, 1, 10, 1));
    proxyGeo.translate(0, 0.5, 0);
    const proxyMat = ctx.track(new MeshBasicMaterial({ visible: false }));
    const proxies = new InstancedMesh(proxyGeo, proxyMat, Math.max(1, sites.length));
    proxies.count = sites.length;
    sites.forEach((s, i) => {
      const r = footprint(s) * 1.35;
      proxies.setMatrixAt(i, m4.compose(v.set(s.px, 0, s.pz), q.identity(), sc.set(r, towerTop(s) + 0.05, r)));
    });
    proxies.computeBoundingSphere();
    root.add(proxies);
    ctx.track({ dispose: () => proxies.dispose() });

    /* ───────── glows ───────── */
    const G_DEST = sites.length;
    const G_STOP = G_DEST + DESTS.length;
    const glows = ctx.track(new GlowSprites({ count: G_STOP + STOPS.length, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── destinations ───────── */
    let portrait = ctx.size.portrait;
    const destXZ = (d: Dest) => (portrait ? d.p : d.l);
    const destRingGeo = ctx.track(new RingGeometry(0.07, 0.095, 48, 1));
    destRingGeo.rotateX(-Math.PI / 2);
    const destMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    const destRings = new InstancedMesh(destRingGeo, destMat, DESTS.length * 2);
    destRings.renderOrder = 2;
    destRings.setColorAt(0, tmpC.set(0, 0, 0));
    root.add(destRings);
    ctx.track({ dispose: () => destRings.dispose() });
    const destProxy = new InstancedMesh(proxyGeo, proxyMat, DESTS.length);
    root.add(destProxy);
    ctx.track({ dispose: () => destProxy.dispose() });
    const destAnchors = DESTS.map(() => {
      const g = new Group();
      root.add(g);
      return g;
    });
    const destLabels = DESTS.map((d) =>
      labels.add({ text: d.name, position: [0, 0, 0], align: 'above', offset: [0, -6], kind: 'strong', priority: 32, hotspot: d.id }),
    );

    /* ───────── arcs ───────── */
    const arcs = ctx.track(new ArcRibbons({ count: ARCS.length, mode: 'planar', segments: 48, flow: 0.32, theme: ctx.theme }));
    // Known kit issue (proposals/scene-taiwan-map.yaml): left → right strips are back-face culled.
    arcs.object.material.side = DoubleSide;
    arcs.object.material.forceSinglePass = true;
    root.add(arcs.object);
    const endpoint = (key: ArcSpec['from']): V3 => {
      const d = DESTS.find((x) => x.id === key);
      if (d) {
        const [x, z] = destXZ(d);
        return [x, -LAND_T + 0.012, z];
      }
      const p = place(key as PlaceKey);
      const top = p.site ? (p.site.slices.length ? towerTop(p.site) : 0.07) : 0.02;
      return [p.x, Math.min(top, 0.12), p.z];
    };
    const arcAlpha = ARCS.map(() => 0);
    const arcProg = ARCS.map(() => 0);
    const arcLabels = ARCS.map((a) =>
      a.label ? labels.add({ text: a.label, position: [0, 0, 0], kind: 'tag', priority: 18, visible: false }) : null,
    );
    // Additive blending pales the light-gold highlight on the dark sea: lean it toward amber there.
    const cExport = new Color();
    const exportColor = (p: Palette) => (p.theme === 'dark' ? cExport.copy(p.highlight).lerp(p.power, 0.55) : cExport.copy(p.highlight));
    // …and two cyan arcs that cross (HBM to 竹南 and 嘉義) would add up to white: tone them down there.
    const cImport = new Color();
    const importColor = (p: Palette) => (p.theme === 'dark' ? cImport.copy(p.flow).lerp(p.bg, 0.3) : cImport.copy(p.flow));
    const layoutArcs = (p: Palette) => {
      const list: Arc[] = ARCS.map((a, i) => ({
        start: endpoint(a.from),
        end: endpoint(a.to),
        height: a.height,
        width: a.kind === 'export' ? 0.03 : 0.026,
        color: a.kind === 'export' ? exportColor(p) : importColor(p),
        alpha: arcAlpha[i]!,
        progress: arcProg[i]!,
      }));
      arcs.setArcs(list);
      ARCS.forEach((a, i) => {
        const h = arcLabels[i];
        if (!h) return;
        const s = endpoint(a.from);
        const e = endpoint(a.to);
        // ArcRibbons planar curve: quadratic Bézier with control = midpoint + up · 2·height.
        const t = a.labelT ?? 0.5;
        const ws = (1 - t) * (1 - t);
        const wm = 2 * t * (1 - t);
        const we = t * t;
        const pt = (j: number) => ws * s[j]! + wm * (s[j]! + e[j]!) / 2 + we * e[j]!;
        h.set({ position: [pt(0), pt(1) + wm * 2 * a.height, pt(2)] });
      });
      DESTS.forEach((d, i) => {
        const [x, z] = destXZ(d);
        destRings.setMatrixAt(i * 2, m4.compose(v.set(x, -LAND_T, z), q.identity(), sc.set(1, 1, 1)));
        destRings.setMatrixAt(i * 2 + 1, m4.compose(v.set(x, -LAND_T + 0.001, z), q.identity(), sc.set(0.45, 1, 0.45)));
        destProxy.setMatrixAt(i, m4.compose(v.set(x, -LAND_T, z), q.identity(), sc.set(0.16, 0.22, 0.16)));
        // 韓國 sits at the top edge of the wide landscape views: its label goes beside the ring there.
        const side = !portrait && d.id === 'dest-kr';
        destLabels[i]!.set({ position: [x, 0.02, z], align: side ? 'right' : 'above', offset: side ? [10, 0] : [0, -6] });
        destAnchors[i]!.position.set(x, 0.05, z);
        destAnchors[i]!.updateMatrixWorld();
      });
      destRings.instanceMatrix.needsUpdate = true;
      destProxy.instanceMatrix.needsUpdate = true;
      destProxy.computeBoundingSphere();
    };

    /* ───────── journey ───────── */
    const stopPts = STOPS.map((st) => {
      const p = place(st.place);
      return new Vector3(p.x, 0.03, p.z);
    });
    const routePts: Vector3[] = [];
    const legEnd: number[] = [1];
    {
      const dir = new Vector3().subVectors(stopPts[1]!, stopPts[0]!).setY(0).normalize();
      routePts.push(stopPts[0]!.clone().addScaledVector(dir, R_T + 0.014));
    }
    const edge = R_T + 0.014;
    for (let i = 1; i < stopPts.length; i++) {
      const dir = new Vector3().subVectors(stopPts[i]!, stopPts[i - 1]!).setY(0).normalize();
      const a = stopPts[i - 1]!.clone().addScaledVector(dir, edge);
      const b = stopPts[i]!.clone().addScaledVector(dir, -edge);
      if (i > 1) routePts.push(a.clone());
      const len = a.distanceTo(b);
      const lift = 0.05 + 0.12 * len;
      // Sideways bulge so legs that run back along the corridor never overlap: (dz, −dx) points east
      // for a southbound leg and west for a northbound one.
      const bulge = Math.min(0.24, 0.12 * len);
      const n = Math.max(8, Math.round(len * 40));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const w = 4 * t * (1 - t);
        routePts.push(
          new Vector3()
            .lerpVectors(a, b, t)
            .setY(a.y + (b.y - a.y) * t + lift * w)
            .add(v.set(dir.z * bulge * w, 0, -dir.x * bulge * w)),
        );
      }
      legEnd.push(routePts.length);
    }
    const routeGeo = ctx.track(new BufferGeometry().setFromPoints(routePts));
    const routeMat = materials.line('highlight', { transparent: true, opacity: 0.55, depthWrite: false });
    const route = new Line(routeGeo, routeMat);
    route.renderOrder = 6;
    route.visible = false;
    root.add(route);
    let flow: PathFlow | null = null;
    const stopRingGeo = ctx.track(new RingGeometry(R_T + 0.03, R_T + 0.045, 40, 1));
    stopRingGeo.rotateX(-Math.PI / 2);
    const stopMat = materials.basic('highlight', { transparent: true, opacity: 0.95, depthWrite: false });
    const stopRings = new InstancedMesh(stopRingGeo, stopMat, STOPS.length);
    stopRings.count = 0;
    stopRings.instanceMatrix.setUsage(DynamicDrawUsage);
    stopRings.renderOrder = 3;
    root.add(stopRings);
    ctx.track({ dispose: () => stopRings.dispose() });
    const stopLabels = STOPS.map((st, i) =>
      labels.add({
        text: st.label,
        position: [stopPts[i]!.x, 0.01, stopPts[i]!.z],
        align: 'below',
        offset: [0, 8],
        kind: 'strong',
        priority: 34,
        visible: false,
      }),
    );
    let stopsShown = 0;
    let flowBase = 0; // high-tier particle count of the current route
    const buildFlow = (n: number) => {
      if (flow) {
        flow.dispose();
        flow = null;
      }
      route.visible = n >= 2;
      if (n < 2) return;
      route.geometry.setDrawRange(0, legEnd[n - 1]!);
      // Particles travel the newest leg only; earlier legs stay as the thin route line.
      const pts = routePts.slice(n === 2 ? 0 : legEnd[n - 2]!, legEnd[n - 1]);
      const len = pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]!) : 0), 0);
      flowBase = Math.min(FLOW_MAX, Math.round(len * 70));
      flow = new PathFlow({
        paths: [{ points: pts, color: ctx.palette.highlight }],
        count: flowBase,
        size: 0.05,
        sizeVariance: 0.2,
        speed: 0.55,
        speedVariance: 0.08,
        smooth: false,
        samples: 160,
        fadeEnds: 0.03,
        theme: ctx.theme,
        seed: 5,
      });
      flow.setCount(scaleCount(flowBase, ctx.tier, 24));
      flow.setReduced(!ctx.animate);
      flow.object.renderOrder = 7;
      root.add(flow.object);
      applyFlowTheme(ctx.palette);
    };
    const applyFlowTheme = (p: Palette) => {
      if (!flow) return;
      const c = exportColor(p).clone();
      flow.recolor(() => c);
      flow.setTheme(p.theme);
      flow.setSize(0.04);
      flow.setOpacity(p.theme === 'dark' ? 0.8 : 0.9);
    };

    /* ───────── labels ───────── */
    const regionSites = new Map<string, SiteModel[]>(REGIONS.map((r) => [r.id, sites.filter((s) => s.region.id === r.id)]));
    const regionAnchor = (r: Region): V3 => {
      const list = regionSites.get(r.id) ?? [];
      if (!list.length) {
        const [x, z] = at(r.lat, r.lon);
        return [x, 0.02, z];
      }
      const x = list.reduce((s, x) => s + x.px, 0) / list.length;
      const z = list.reduce((s, x) => s + x.pz, 0) / list.length;
      return [x, 0.02, z];
    };
    // When region labels collide (small 4:3 page stage), the biggest clusters keep theirs.
    const regionBonus = (r: Region) => (r.id === 'hsinchu' ? 2 : r.id === 'taipei' ? 1 : 0);
    const regionLabels = REGIONS.map((r) => {
      const [x, z] = at(r.label.lat, r.label.lon);
      return labels.add({
        text: r.name,
        position: [x, -LAND_T, z],
        align: r.label.side,
        kind: 'strong',
        priority: 26 + regionBonus(r),
        hotspot: r.id,
      });
    });
    const siteLabels: LabelHandle[] = sites.map((s) =>
      labels.add({
        text: s.short,
        position: [s.px, towerTop(s) + 0.02, s.pz],
        align: 'above',
        priority: 10,
        visible: false,
        hotspot: s.region.id,
      }),
    );
    const misc = [
      labels.add({ text: '台灣海峽', position: [-1.5, -LAND_T, -0.3], kind: 'muted', priority: 3 }),
      labels.add({ text: '太平洋', position: [1.5, -LAND_T, 0.35], kind: 'muted', priority: 3 }),
      labels.add({ text: '50 km', position: [SB[0] + 0.25, yb, SB[2] + 0.05], align: 'below', kind: 'tag', priority: 2 }),
      labels.add({ text: '北', position: [NA[0], yb, NA[2] - 0.17], align: 'above', kind: 'tag', priority: 2 }),
      ...(['matsu', 'kinmen'] as const).map((k) =>
        labels.add({
          text: INSETS[k].name,
          position: [island.insetCentres[k][0] - INSETS[k].half + 0.02, -LAND_T, island.insetCentres[k][1] - INSETS[k].half],
          align: 'above',
          kind: 'tag',
          priority: 4,
        }),
      ),
    ];
    for (const c of geo.counties) {
      if (!['G', 'U', 'V', 'M', 'T', 'X'].includes(c.id)) continue;
      misc.push(labels.add({ text: c.name, position: [c.x, 0.01, -c.y], kind: 'tag', priority: 1 }));
    }

    /* ───────── colour state ───────── */
    let step = 0;
    let spec: StepSpec = STEPS[0]!;
    let regionHot: string | null = null;
    let hoverSite = -1;
    const sliceFrom = new Float32Array(sliceRefs.length * 3);
    const sliceTo = new Float32Array(sliceRefs.length * 3);
    const siteFocus = new Float32Array(sites.length); // 0..1 (animated)
    const siteFocusTo = new Float32Array(sites.length);
    const siteHot = new Float32Array(sites.length);
    const landColor = (p: Palette, out = new Color()) =>
      out.copy(p.bg).lerp(p.fg, p.theme === 'dark' ? 0.14 : 0.045);
    const cLand = new Color();
    const cFade = new Color();

    const siteOff = (s: SiteModel) => !!spec.segs && !!spec.off?.includes(s.kind);
    /** companies of `s` that belong to this step (0 for a site kind the step leaves out) */
    const stepCount = (s: SiteModel) => {
      const segs = spec.segs;
      return segs && !siteOff(s) ? s.slices.filter((x) => x.segment && segs.includes(x.segment)).length : 0;
    };
    const focusOf = (s: SiteModel): number => {
      if (!spec.segs) return 1;
      if (siteOff(s)) return 0;
      if (spec.kinds.includes(s.kind)) return 1;
      return s.slices.some((sl) => sl.segment && spec.segs!.includes(sl.segment)) ? 1 : 0;
    };
    const targetSliceColor = (r: SliceRef, p: Palette, out: Color) => {
      const s = sites[r.site]!;
      const sl = s.slices[r.k]!;
      const dark = p.theme === 'dark';
      if (!spec.segs) {
        out.copy(s.dominant ? p.seg[s.dominant] : p.muted);
        if (r.k % 2) out.lerp(p.bg, dark ? 0.12 : 0.08);
        return out;
      }
      const on = !!sl.segment && spec.segs.includes(sl.segment) && !siteOff(s);
      out.copy(sl.segment ? p.seg[sl.segment] : p.muted);
      if (!on) out.lerp(cFade, dark ? 0.8 : 0.78);
      return out;
    };
    const computeSliceTargets = (p: Palette) => {
      landColor(p, cLand);
      cFade.copy(cLand).lerp(p.muted, p.theme === 'dark' ? 0.25 : 0.2);
      sliceRefs.forEach((r, i) => {
        targetSliceColor(r, p, tmpC);
        sliceTo[i * 3] = tmpC.r;
        sliceTo[i * 3 + 1] = tmpC.g;
        sliceTo[i * 3 + 2] = tmpC.b;
      });
      sites.forEach((s, i) => (siteFocusTo[i] = focusOf(s)));
    };
    const cHi = new Color();
    const baseC = new Color();
    const writeColors = (k: number) => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      cHi.copy(p.highlight);
      sliceRefs.forEach((r, i) => {
        tmpC.setRGB(
          sliceFrom[i * 3]! + (sliceTo[i * 3]! - sliceFrom[i * 3]!) * k,
          sliceFrom[i * 3 + 1]! + (sliceTo[i * 3 + 1]! - sliceFrom[i * 3 + 1]!) * k,
          sliceFrom[i * 3 + 2]! + (sliceTo[i * 3 + 2]! - sliceFrom[i * 3 + 2]!) * k,
        );
        const hot = siteHot[r.site]!;
        if (hot > 0) tmpC.lerp(cHi, hot * (dark ? 0.28 : 0.22));
        slices.setColorAt(i, tmpC);
      });
      if (slices.instanceColor) slices.instanceColor.needsUpdate = true;
      // bases, markers, glows follow the site focus
      baseC.copy(p.fg).lerp(p.bg, dark ? 0.45 : 0.4);
      const write = (mesh: InstancedMesh, list: SiteModel[]) => {
        list.forEach((s, i) => {
          const f = siteFocus[s.index]!;
          tmpC.copy(baseC).lerp(cLand, 0.75 * (1 - f));
          if (siteHot[s.index]! > 0) tmpC.lerp(cHi, siteHot[s.index]!);
          mesh.setColorAt(i, tmpC);
        });
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      };
      write(basesRound, areaSites);
      write(basesSquare, plantSites);
      emptySites.forEach((s, i) => {
        const f = siteFocus[s.index]!;
        tmpC.copy(s.kind === 'port' ? p.highlight : p.optic).lerp(cLand, 0.7 * (1 - f));
        if (siteHot[s.index]! > 0) tmpC.lerp(cHi, siteHot[s.index]!);
        markers.setColorAt(i, tmpC);
      });
      if (markers.instanceColor) markers.instanceColor.needsUpdate = true;
      sites.forEach((s) => {
        const f = siteFocus[s.index]!;
        const hot = siteHot[s.index]!;
        const col = s.dominant ? p.seg[s.dominant] : s.kind === 'port' ? p.highlight : p.optic;
        const n = s.slices.length;
        const size = (n ? 0.2 + 0.012 * Math.min(n, 30) : 0.14) * (1 + 0.6 * hot);
        const a = ((dark ? 0.32 : 0.2) * (0.25 + 0.75 * f) + hot * 0.45) * (n || s.kind === 'port' ? 1 : 0.7);
        glows.set(s.index, [s.px, towerTop(s) + 0.01, s.pz], size, hot > 0 ? tmpC.copy(col).lerp(cHi, 0.4) : col, a);
      });
    };
    const snapFrom = () => {
      if (!slices.instanceColor) return;
      sliceRefs.forEach((_, i) => {
        slices.getColorAt(i, tmpC);
        sliceFrom[i * 3] = tmpC.r;
        sliceFrom[i * 3 + 1] = tmpC.g;
        sliceFrom[i * 3 + 2] = tmpC.b;
      });
    };
    let colorTween: Tween | null = null;
    const focusFrom = new Float32Array(sites.length);
    const retarget = (animate: boolean) => {
      colorTween?.cancel();
      snapFrom();
      focusFrom.set(siteFocus);
      computeSliceTargets(ctx.palette);
      const apply = (k: number) => {
        for (let i = 0; i < sites.length; i++) siteFocus[i] = focusFrom[i]! + (siteFocusTo[i]! - focusFrom[i]!) * k;
        writeColors(k);
      };
      if (!animate) {
        apply(1);
        sliceFrom.set(sliceTo);
        return;
      }
      colorTween = ctx.tween.run(apply, { duration: 650, ease: 'cubicInOut', fade: true });
    };

    /* ───────── hover / region highlight ───────── */
    const hotTween = new Map<number, Tween>();
    const refreshHot = () => {
      sites.forEach((s, i) => {
        const want = i === hoverSite ? 1 : regionHot === s.region.id ? 0.55 : 0;
        if (Math.abs(siteHot[i]! - want) > 1e-3 || hotTween.has(i)) {
          if (want === 0 && siteHot[i] === 0) return;
          hotTween.get(i)?.cancel();
          const from = siteHot[i]!;
          hotTween.set(
            i,
            ctx.tween.run(
              (k) => {
                siteHot[i] = from + (want - from) * k;
                writeColors(1);
              },
              { duration: 200, ease: 'cubicOut', fade: true, onComplete: () => hotTween.delete(i) },
            ),
          );
        }
      });
    };
    let lastHit: { site: number; point: Vector3 } | null = null;
    ctx.picker.onHover((hit) => {
      const idx = hit && hit.object === proxies && hit.instanceId !== undefined ? hit.instanceId : -1;
      lastHit = idx >= 0 && hit ? { site: idx, point: hit.point.clone() } : null;
      if (idx !== hoverSite) {
        hoverSite = idx;
        refreshHot();
      }
    });

    /* ───────── cards ───────── */
    const companyItems = (s: SiteModel, max: number): CardItem[] => {
      const segs = spec.segs;
      const off = siteOff(s);
      const on = (x: SiteModel['slices'][number]) => (!off && segs && x.segment && segs.includes(x.segment) ? 1 : 0);
      // The step's companies first, then the data's own order (anchor companies lead).
      const list = [...s.slices].sort((a, b) => on(b) - on(a) || a.order - b.order);
      const items: CardItem[] = list.slice(0, max).map((c) => ({
        label: c.name,
        ...(c.segment ? { meta: SEG_SHORT[c.segment] } : {}),
        href: `/companies/${c.id}/`,
      }));
      if (list.length > max) items.push({ label: `……另有 ${list.length - max} 家` });
      return items;
    };
    const siteCard = (s: SiteModel): CardContent => {
      const n = s.slices.length;
      const c: CardContent = { title: s.name, subtitle: `${s.kindLabel}・${s.region.name}` };
      if (s.dominant) c.swatch = ctx.palette.css[`seg-${s.dominant}`] ?? '';
      if (n) {
        const segs = spec.segs;
        const k = stepCount(s);
        c.body =
          `本站名冊收錄 ${n} 家位於此處的公司，每片圓盤代表一家；最多的是「${s.dominant ? SEG_TITLE[s.dominant] : '其他'}」。` +
          (segs ? `與這一步相關的有 ${k} 家。` : '');
        c.items = companyItems(s, 8);
        if (s.dominant) {
          c.href = `/chain/${s.dominant}/`;
          c.linkLabel = `前往「${SEG_TITLE[s.dominant]}」環節 →`;
        }
      } else {
        c.body =
          s.kind === 'port'
            ? '晶片與伺服器出口的門戶；港口與機場本身不計入公司數。'
            : s.kind === 'research'
              ? '研發與算力機構，不計入公司數。'
              : '本站名冊目前沒有位於此處的公司。';
      }
      return c;
    };
    const regionCard = (r: Region): CardContent => {
      const list = [...(regionSites.get(r.id) ?? [])].sort((a, b) => b.slices.length - a.slices.length);
      const ids = new Set(list.flatMap((s) => s.slices.map((x) => x.id)));
      const counts = new Map<SegmentId, number>();
      for (const s of list) for (const x of s.slices) if (x.segment) counts.set(x.segment, (counts.get(x.segment) ?? 0) + 1);
      const dom = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const c: CardContent = {
        title: r.name,
        subtitle: list.length ? `${list.length} 個據點・本站名冊 ${ids.size} 家公司` : '本站名冊目前沒有此區的據點',
      };
      const d = hsText.get(r.id)?.detail;
      if (d) c.body = d;
      if (list.length) c.items = list.slice(0, 6).map((s) => ({ label: s.name, meta: s.slices.length ? `${s.slices.length} 家` : s.kindLabel }));
      if (dom) {
        c.href = `/chain/${dom}/`;
        c.linkLabel = `前往「${SEG_TITLE[dom]}」環節 →`;
        c.swatch = ctx.palette.css[`seg-${dom}`] ?? '';
      }
      return c;
    };
    const destCard = (d: Dest): CardContent => {
      const c: CardContent = { title: d.name, subtitle: '方向示意，不代表距離與貿易量', items: DEST_LINKS[d.id] };
      const t = hsText.get(d.id)?.detail;
      if (t) c.body = t;
      return c;
    };

    /* ───────── hotspots ───────── */
    const regionPose = (r: Region): CameraPose => {
      const a = regionAnchor(r);
      return orbit([a[0], 0.15, a[2]], -0.45, 0.88, 2.4);
    };
    for (const r of REGIONS) {
      hotspots.register(r.id, {
        anchor: regionAnchor(r),
        pose: regionPose(r),
        card: (hit: PickHit | null) =>
          hit && hit.object === proxies && hit.instanceId !== undefined && sites[hit.instanceId] ? siteCard(sites[hit.instanceId]!) : regionCard(r),
        onHighlight: (on) => {
          regionHot = on ? r.id : regionHot === r.id ? null : regionHot;
          refreshHot();
        },
        onSelect: (source) => {
          if (source === 'pointer' && lastHit && sites[lastHit.site]?.region.id === r.id) {
            const s = sites[lastHit.site]!;
            ctx.card.show(siteCard(s), lastHit.point, { interactive: true });
            ctx.announce(`已選取：${s.name}`);
            return true;
          }
          return false;
        },
      });
    }
    ctx.picker.add(proxies, {
      id: ({ instanceId }) => (instanceId !== undefined ? (sites[instanceId]?.region.id ?? null) : null),
      recursive: false,
    });
    const destHot = DESTS.map(() => 0);
    DESTS.forEach((d, i) => {
      hotspots.register(d.id, {
        anchor: destAnchors[i]!,
        pose: orbit([destXZ(d)[0] * 0.55, 0.1, destXZ(d)[1] * 0.55 - 0.3], -0.3, 0.95, 5.2),
        card: () => destCard(d),
        onHighlight: (on) => {
          destHot[i] = on ? 1 : 0;
          applyDest(ctx.palette);
        },
      });
    });
    ctx.picker.add(destProxy, {
      id: ({ instanceId }) => (instanceId !== undefined ? (DESTS[instanceId]?.id ?? null) : null),
      recursive: false,
    });

    /* ───────── legend ───────── */
    const legend = createLegend(ctx.stage);
    // Labels whose anchor falls under the legend box are hidden rather than half covered.
    const pv = new Vector3();
    labels.setOccluder((w, cam) => {
      pv.copy(w).project(cam);
      return legend.covers(((pv.x + 1) / 2) * ctx.size.width, ((1 - pv.y) / 2) * ctx.size.height, 16, 96);
    });
    const legendState = (p: Palette): LegendState => {
      if (step === 5)
        return {
          title: '出口與進口（方向示意）',
          keys: [
            { label: '出口：晶片與伺服器', color: `#${exportColor(p).getHexString()}`, shape: 'line' },
            { label: '進口：設計、設備與材料', color: p.css['scene-flow'] ?? '', shape: 'line' },
          ],
          note: '弧線粗細不代表貿易量；目的地只表示方向。',
        };
      if (spec.segs)
        return {
          title: '亮色＝這一步的環節',
          keys: spec.segs.map((s) => ({ label: SEG_SHORT[s], color: p.css[`seg-${s}`] ?? '' })),
          note: '每片圓盤＝一家公司（本站名冊），其餘環節變淡。',
        };
      const counts = new Map<SegmentId, number>();
      for (const s of sites) if (s.dominant) counts.set(s.dominant, (counts.get(s.dominant) ?? 0) + s.slices.length);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      return {
        title: '每片圓盤＝一家公司・顏色＝主要環節',
        keys: top.map(([s]) => ({ label: SEG_SHORT[s], color: p.css[`seg-${s}`] ?? '' })),
        note: '公司數依本站名冊；金色弧線為出口方向（示意）。',
      };
    };

    /* ───────── palette ───────── */
    /** destinations that one of the step's arcs touches (all of them in 總覽) */
    const destUsed = (id: Dest['id']) => [...spec.arcs, ...spec.faint].some((i) => ARCS[i]!.from === id || ARCS[i]!.to === id);
    const applyDest = (p: Palette) => {
      const dark = p.theme === 'dark';
      DESTS.forEach((d, i) => {
        const hot = destHot[i]!;
        // A destination the step does not use recedes, so the eye goes to the arcs that matter.
        const dim = destUsed(d.id) ? 0 : 1 - hot;
        tmpC.copy(p.fg).lerp(p.bg, dark ? 0.35 : 0.3).lerp(p.highlight, hot).lerp(p.bg, dim * 0.6);
        destRings.setColorAt(i * 2, tmpC);
        destRings.setColorAt(i * 2 + 1, tmpC.copy(p.highlight).lerp(p.bg, (dark ? 0.2 : 0.1) + dim * 0.55));
        const [x, z] = destXZ(d);
        glows.set(G_DEST + i, [x, -LAND_T + 0.02, z], 0.42 + 0.25 * hot, p.highlight, ((dark ? 0.4 : 0.25) + 0.35 * hot) * (1 - dim * 0.75));
        destLabels[i]!.set({ kind: dim > 0.5 ? 'default' : 'strong', priority: dim > 0.5 ? 20 : 32 });
      });
      if (destRings.instanceColor) destRings.instanceColor.needsUpdate = true;
      ctx.invalidate();
    };
    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      lights.apply(p);
      landColor(p, landMat.color);
      seaMat.color.copy(p.coolant).lerp(p.bg, dark ? 0.72 : 0.8);
      seaMat.opacity = dark ? 0.55 : 0.6;
      grat.recolor(p.grid.clone().lerp(p.fg, dark ? 0.12 : 0.06), dark ? 0.75 : 0.9);
      coastMat.opacity = dark ? 0.55 : 0.42;
      borderMat.opacity = dark ? 0.55 : 0.5;
      baseMat.opacity = dark ? 0.85 : 0.9;
      sliceMat.emissive.copy(p.fg).multiplyScalar(dark ? 0.04 : 0);
      glows.setTheme(p.theme);
      arcs.setTheme(p.theme);
      arcs.setOpacity(dark ? 0.95 : 1);
      applyFlowTheme(p);
      layoutArcs(p);
      applyDest(p);
      retarget(false);
      legend.set(legendState(p));
    };

    /* ───────── steps ───────── */
    const arcTweens: Tween[] = [];
    const showArcs = (instant: boolean) => {
      arcTweens.forEach((t) => t.cancel());
      arcTweens.length = 0;
      ARCS.forEach((a, i) => {
        const want = spec.arcs.includes(i) ? 1 : spec.faint.includes(i) ? (ctx.theme === 'dark' ? 0.55 : 0.7) : 0;
        const fromA = arcAlpha[i]!;
        const fromP = arcProg[i]!;
        const toP = want > 0 ? 1 : fromP;
        const fresh = want > 0 && fromA < 0.01;
        if (instant || !ctx.animate) {
          arcAlpha[i] = want;
          arcProg[i] = want > 0 ? 1 : 0;
          arcs.setAlpha(i, want);
          arcs.setProgress(i, arcProg[i]!);
        } else {
          if (fresh) arcs.setProgress(i, 0);
          const p0 = fresh ? 0 : fromP;
          arcTweens.push(
            ctx.tween.run(
              (k) => {
                arcAlpha[i] = fromA + (want - fromA) * k;
                arcs.setAlpha(i, arcAlpha[i]!);
                if (want > 0) {
                  arcProg[i] = p0 + (toP - p0) * k;
                  arcs.setProgress(i, arcProg[i]!);
                }
              },
              { duration: fresh ? 1100 : 500, ease: 'cubicInOut', delay: fresh ? 250 : 0 },
            ),
          );
          if (want === 0) arcProg[i] = 0;
        }
        arcLabels[i]?.set({ visible: spec.arcs.includes(i) && !!a.label });
      });
    };
    const showStops = () => {
      stopsShown = spec.stops;
      stopRings.count = stopsShown;
      for (let i = 0; i < stopsShown; i++) stopRings.setMatrixAt(i, m4.makeTranslation(stopPts[i]!.x, BASE_Y + 0.002, stopPts[i]!.z));
      stopRings.instanceMatrix.needsUpdate = true;
      stopLabels.forEach((h, i) => h.set({ visible: i < stopsShown, kind: i === stopsShown - 1 ? 'strong' : 'tag', priority: i === stopsShown - 1 ? 36 : 28 }));
      STOPS.forEach((_, i) => {
        const on = i < stopsShown;
        const cur = i === stopsShown - 1;
        glows.set(G_STOP + i, [stopPts[i]!.x, 0.05, stopPts[i]!.z], cur ? 0.5 : 0.3, ctx.palette.highlight, on ? (cur ? 0.6 : 0.3) : 0);
      });
      buildFlow(stopsShown);
    };
    // 總覽 names the biggest towers so each tall stack can be told apart at a glance.
    const bigSites = new Set(
      sites
        .filter((s) => s.slices.length >= 3)
        .sort((a, b) => b.slices.length - a.slices.length)
        .slice(0, 6)
        .map((s) => s.index),
    );
    const behind = new Set(
      sites
        .filter((s) =>
          sites.some(
            (t) => t.slices.length >= s.slices.length + 3 && Math.abs(t.px - s.px) < 0.07 && t.pz > s.pz && t.pz - s.pz < 0.3,
          ),
        )
        .map((s) => s.index),
    );
    const showLabels = () => {
      sites.forEach((s, i) => {
        const segs = spec.segs;
        const k = stepCount(s);
        const on = segs
          ? !siteOff(s) && !behind.has(i) && (k > 0 || spec.kinds.includes(s.kind))
          : step === 0 && bigSites.has(i);
        siteLabels[i]!.set({
          visible: on,
          kind: segs ? 'default' : 'tag',
          priority: segs ? 8 + Math.min(k, 20) + (spec.kinds.includes(s.kind) ? 4 : 0) : 6 + Math.min(s.slices.length, 15),
        });
      });
      regionLabels.forEach((h, i) => {
        const b = regionBonus(REGIONS[i]!);
        h.set({ kind: spec.segs ? 'default' : 'strong', priority: (spec.segs ? 14 : 26) + b });
      });
    };
    const go = (pair: PosePair | null) => {
      const pose = pair ? (portrait ? pair.p : pair.l) : portrait ? HOME.p : HOME.l;
      if (!portrait) return ctx.setPose(pose);
      // ctx.setPose scales portrait poses by |portrait home| / |landscape home|: pre-compensate.
      const k = new Vector3(...(HOME.p.position as V3)).distanceTo(new Vector3(...(HOME.p.target as V3))) /
        new Vector3(...(HOME.l.position as V3)).distanceTo(new Vector3(...(HOME.l.target as V3)));
      const t = new Vector3(...(pose.target as V3));
      const pos = new Vector3(...(pose.position as V3)).sub(t).divideScalar(k).add(t);
      return ctx.setPose({ position: pos, target: pose.target });
    };
    const applyStep = (i: number, first: boolean) => {
      step = Math.max(0, Math.min(STEPS.length - 1, i));
      spec = STEPS[step]!;
      retarget(!first);
      showArcs(first);
      showStops();
      showLabels();
      applyDest(ctx.palette);
      legend.set(legendState(ctx.palette));
    };

    applyPalette(ctx.palette);
    applyStep(ctx.step, true);

    /* ───────── bounded pan ───────── */
    const BOUNDS = { x: [-1.8, 1.9], y: [-0.1, 0.9], z: [-2.8, 2.3] } as const;
    const clampV = new Vector3();

    return {
      update(dt, t) {
        arcs.update(t);
        flow?.update(t);
        if (stopsShown > 0 && dt > 0) {
          const i = stopsShown - 1;
          const s = 1 + 0.12 * Math.sin(t * 2.4);
          stopRings.setMatrixAt(i, m4.compose(v.set(stopPts[i]!.x, BASE_Y + 0.002, stopPts[i]!.z), q.identity(), sc.set(s, 1, s)));
          stopRings.instanceMatrix.needsUpdate = true;
        }
        const c = ctx.controls;
        if (c) {
          const tg = c.target;
          clampV.set(
            Math.min(BOUNDS.x[1], Math.max(BOUNDS.x[0], tg.x)),
            Math.min(BOUNDS.y[1], Math.max(BOUNDS.y[0], tg.y)),
            Math.min(BOUNDS.z[1], Math.max(BOUNDS.z[0], tg.z)),
          );
          if (!clampV.equals(tg)) {
            ctx.camera.position.add(v.subVectors(clampV, tg));
            tg.copy(clampV);
          }
        }
      },
      setStep(i) {
        applyStep(i, false);
        go(STEPS[step]!.pose);
      },
      onMotion(animate) {
        flow?.setReduced(!animate);
        if (!animate) {
          for (let i = 0; i < stopsShown; i++) stopRings.setMatrixAt(i, m4.makeTranslation(stopPts[i]!.x, BASE_Y + 0.002, stopPts[i]!.z));
          stopRings.instanceMatrix.needsUpdate = true;
          arcs.update(0);
        }
      },
      onQuality(_q, tier) {
        if (flow) flow.setCount(scaleCount(flowBase, tier, 24));
      },
      onPalette(p) {
        applyPalette(p);
        showStops();
      },
      onResize(size) {
        legend.invalidate();
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          layoutArcs(ctx.palette);
          applyDest(ctx.palette);
        }
      },
      dispose() {
        colorTween?.cancel();
        arcTweens.forEach((t) => t.cancel());
        hotTween.forEach((t) => t.cancel());
        flow?.dispose();
        flow = null;
        labels.setOccluder(null);
        legend.dispose();
        root.removeFromParent();
      },
    };
  },
});

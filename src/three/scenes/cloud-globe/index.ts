/**
 * cloud-globe — 雲端與新雲版圖 (variant: globe).
 *
 * A dotted globe (kit Globe) with every AI campus from the page data as a pillar:
 *  - height ∝ √MW (calm spikes that still separate 15 MW from 5 GW);
 *  - colour = build status: operating green (--c-pos), construction amber, planned violet; the solid
 *    lower part is the power already online (`mwNow` / `mw` when the data has it, else a status
 *    default marked 示意) and the rest is a translucent ghost;
 *  - cross-section = operator type: round 超大規模雲, square 新雲, triangular 主權 AI,
 *    hexagonal AI 實驗室, diamond 託管與開發商 (type derived from the operator string, data.ts);
 *  - campuses ≥ 1 GW wear a ring whose area ∝ planned GW (pulsing in the GW step).
 * ArcRibbons draw illustrative request routes (租用算力) and HQ → campus ownership arcs
 * (超大規模雲 / 新雲); a small 2D bar panel (overlay.ts) sums the campus power per operator in the
 * type steps and online / unfinished / planned power in 建置進度 (always computed from the data).
 * HTML chips filter by operator type; the legend shows per-step totals computed from the data.
 * Hover a pillar for its card; click/tap opens an interactive card.
 *
 * Steps: 總覽 (slow spin) → 租用算力 → 超大規模雲 → 新雲 → 主權 AI → GW 級園區 → 建置進度.
 * Regional steps use an oblique "from the south" camera so the pillars stand up on screen; on
 * portrait stages they look down more steeply and zoom in (hotspot poses are re-registered).
 * Campus labels pick their side (above / right / left / below) in a light greedy pass so crowded
 * clusters keep more names (layoutLabels); on phone-size stages the overlay compacts.
 * Reduced motion: no spin, no arc flow or ring pulses, camera moves are cuts, filters snap.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type LabelHandle,
  type Palette,
  type PickHit,
  type SceneContext,
  type ScreenPoint,
  type Tween,
} from '../../core/types';
import { ArcRibbons, type Arc } from '../../kit/ArcRibbons';
import { Globe, latLonToVec3, vec3ToLatLon } from '../../kit/Globe';
import { GlowSprites } from '../../kit/GlowSprites';
import {
  REGIONS,
  STATUS_INFO,
  STATUS_ORDER,
  TAIWAN,
  TYPE_INFO,
  TYPE_ORDER,
  USER_CITIES,
  fmtLatLon,
  fmtMW,
  isCloudData,
  normalise,
  type Campus,
  type CampusStatus,
  type CampusType,
  type CloudData,
  type Shape,
} from './data';
import { createOverlay, type BarPanel, type Filter } from './overlay';

/* ───────────────────────── constants ───────────────────────── */

const R = 1;
const DEG = Math.PI / 180;
const PILLAR_R = 0.0105;
const GW = 1000;
const SPIN = 0.05; // rad/s of camera orbit in 總覽 (≈ 2 min per turn)
const SHAPE_SEG: Record<Shape, number> = { round: 22, square: 4, triangle: 3, hex: 6, diamond: 4, pentagon: 5 };
const SHAPE_SCALE: Record<Shape, number> = { round: 1, square: 0.9, triangle: 1.28, hex: 1.04, diamond: 0.96, pentagon: 1.02 };
const heightFor = (mw: number | null) => (mw ? 0.01 + 0.25 * Math.sqrt(Math.min(mw, 9000) / 5000) : 0.024);
const ringFor = (mw: number) => 0.042 * Math.sqrt(mw / GW);
/** Arc lift: short hops stay low, ocean crossings rise a little (never a loop around the globe). */
const arcLift = (rad: number) => 0.02 + 0.15 * (rad / Math.PI);

type Tuple = [number, number, number];
const ll = (lat: number, lon: number, r: number): Tuple => {
  const c = Math.cos(lat * DEG);
  return [r * c * Math.sin(lon * DEG), r * Math.sin(lat * DEG), r * c * Math.cos(lon * DEG)];
};
const UP = new Vector3(0, 1, 0);
/** Camera on the ray through (lat, lon), looking at `target` (default: the globe centre). */
const centrePose = (lat: number, lon: number, dist: number, target: Tuple = [0, 0, 0]): CameraPose => ({
  position: ll(lat, lon, dist),
  target,
});
/**
 * Oblique regional view: the target sits on the surface at (lat, lon) and the camera looks at it
 * from the south (`az`° toward the east; negative = from the south-west), `elev`° above the local
 * horizon, so radial pillars stand up on screen.
 */
const obliquePose = (lat: number, lon: number, dist: number, elev = 40, az = 0, lead = 0.03): CameraPose => {
  const n = latLonToVec3(lat, lon, 1);
  const east = new Vector3().crossVectors(UP, n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new Vector3().crossVectors(n, east).normalize();
  const target = n.clone().multiplyScalar(R * 1.03);
  const e = elev * DEG;
  const h = Math.cos(e) * dist;
  const pos = target
    .clone()
    .addScaledVector(n, Math.sin(e) * dist)
    .addScaledVector(north, -Math.cos(az * DEG) * h)
    .addScaledVector(east, Math.sin(az * DEG) * h);
  // Aim a little in front of the subject (toward the camera): the view tilts down, the horizon
  // rises toward the top edge and the subject sits just above the middle of the frame.
  target.addScaledVector(north, -Math.cos(az * DEG) * lead * dist).addScaledVector(east, Math.sin(az * DEG) * lead * dist);
  return { position: pos.toArray() as Tuple, target: target.toArray() as Tuple };
};

/**
 * 總覽: a large globe seen from low latitudes and aimed above its centre, so the northern campus
 * belt (≈ 30–50°N, where nearly every campus sits) runs across the middle of the frame with its
 * pillars rising toward the top, and the empty southern ocean is cropped by the bottom edge. The
 * slow orbit then carries the same belt westward (North America → Asia → Middle East → Europe).
 */
const HOME = { lat: 16, lon: -88, dist: 2.8, portrait: 2.9 };
const HOME_TARGET: Tuple = [0, 0.45, 0];
const HOME_TARGET_PORTRAIT: Tuple = [0, 0.58, 0];
/** Longest HQ → campus arc drawn (longer ones would wrap round the back of the globe). */
const MAX_HQ_ARC = 50 * DEG;

interface StepSpec {
  filter: Filter;
  arcs: 'users' | 'hq' | null;
  spin?: boolean;
  /** Bar panel: MW per operator of the step's type. */
  operators?: boolean;
  gw?: boolean;
  pipeline?: boolean;
}
const STEPS: readonly StepSpec[] = [
  { filter: 'all', arcs: null, spin: true },
  { filter: 'all', arcs: 'users' },
  { filter: 'hyperscaler', arcs: 'hq', operators: true },
  { filter: 'neocloud', arcs: 'hq', operators: true },
  { filter: 'sovereign', arcs: null, operators: true },
  { filter: 'all', arcs: null, gw: true },
  { filter: 'all', arcs: null, pipeline: true },
];

type Align = 'above' | 'right' | 'left' | 'below';
const ALIGNS: readonly Align[] = ['above', 'right', 'left', 'below'];
/** A label taking part in the alignment pass (campus, user city or HQ tag). */
interface Tag {
  label: LabelHandle;
  /** World anchor (live: campus tops move with the pillars). */
  top: Vector3;
  text: string;
  prio: number;
  on: boolean;
  align: Align;
  /** Label style (sizes differ) and whether it has a leading swatch. */
  kind: 'default' | 'strong' | 'muted' | 'tag';
  swatch: boolean;
}

/* ───────────────────────── scratch ───────────────────────── */

/** Per-campus values eased toward their targets every frame (value, target). */
const EASED = [
  ['vis', 'visT'],
  ['focus', 'focusT'],
  ['hot', 'hotT'],
] as const;

const m4 = new Matrix4();
const ZERO = new Matrix4().makeScale(0, 0, 0);
const p3 = new Vector3();
const s3 = new Vector3();
const v3 = new Vector3();
const c3 = new Color();
const c4 = new Color();

/* ───────────────────────── helpers ───────────────────────── */

/** Per-instance alpha (InstancedBufferAttribute `aAlpha`) for basic/standard materials. */
function withInstanceAlpha<M extends MeshBasicMaterial | MeshStandardMaterial>(m: M, key: string): M {
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Lets instance colours glow a little (emissive += instanceColor · uBoost) so pillars read in dark. */
function withBoost(m: MeshStandardMaterial, u: { value: number }, key: string): MeshStandardMaterial {
  m.onBeforeCompile = (s) => {
    s.uniforms['uBoost'] = u;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uBoost;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * uBoost;\n#endif');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Unit normals for lat/lon items; items closer than `minDeg` are fanned out around their centre. */
function spreadNormals(items: readonly { lat: number; lon: number }[], minDeg: number, ringDeg: number): Vector3[] {
  const base = items.map((it) => latLonToVec3(it.lat, it.lon, 1));
  const out = base.map((v) => v.clone());
  const used = new Array<boolean>(items.length).fill(false);
  const cos = Math.cos(minDeg * DEG);
  for (let i = 0; i < base.length; i++) {
    if (used[i]) continue;
    const group = [i];
    for (let j = i + 1; j < base.length; j++) if (!used[j] && group.some((g) => base[g]!.dot(base[j]!) > cos)) group.push(j);
    if (group.length < 2) continue;
    const c = new Vector3();
    for (const g of group) {
      used[g] = true;
      c.add(base[g]!);
    }
    c.normalize();
    const east = new Vector3().crossVectors(UP, c);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = new Vector3().crossVectors(c, east).normalize();
    const r = ringDeg * DEG * (group.length > 3 ? 1.35 : 1);
    group.forEach((g, k) => {
      const a = (k / group.length) * Math.PI * 2 + Math.PI / 4;
      out[g] = c.clone().addScaledVector(east, Math.cos(a) * r).addScaledVector(north, Math.sin(a) * r).normalize();
    });
  }
  return out;
}

function buildGraticule(r: number): BufferGeometry {
  const pos: number[] = [];
  const push = (a: Tuple, b: Tuple) => pos.push(...a, ...b);
  for (let lat = -60; lat <= 60; lat += 30)
    for (let lon = -180; lon < 180; lon += 3) push(ll(lat, lon, r), ll(lat, lon + 3, r));
  for (let lon = -180; lon < 180; lon += 30)
    for (let lat = -78; lat < 78; lat += 3) push(ll(lat, lon, r), ll(lat + 3, lon, r));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

function shapeGeometry(shape: Shape): CylinderGeometry {
  const g = new CylinderGeometry(1, 1, 1, SHAPE_SEG[shape], 1);
  g.translate(0, 0.5, 0);
  if (shape === 'square') g.rotateY(Math.PI / 4);
  return g;
}

function flatDisc(geo: BufferGeometry, n: number): BufferGeometry {
  geo.rotateX(-Math.PI / 2);
  geo.setAttribute('aAlpha', new InstancedBufferAttribute(new Float32Array(n).fill(1), 1));
  return geo;
}

const angle = (a: Vector3, b: Vector3) => Math.acos(Math.max(-1, Math.min(1, a.dot(b))));

/**
 * Pillar orientation: local +Y along the surface normal, +X east, +Z south. A fixed local frame
 * (instead of setFromUnitVectors) keeps the square / diamond cross-sections consistent on screen.
 */
function frameQuat(n: Vector3): Quaternion {
  const east = new Vector3().crossVectors(UP, n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const south = new Vector3().crossVectors(east, n).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(east, n, south));
}

/** Ocean tint: a calmer, deeper sea than the kit default (proposals/scene-cloud-globe.yaml → globe-ocean-tint). */
function oceanTint(p: Palette): Color {
  return p.theme === 'dark' ? p.bg.clone().lerp(p.coolant, 0.055) : p.bg.clone().lerp(p.grid, 0.42).lerp(p.coolant, 0.035);
}

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<CloudData>({
  json,
  meta: {
    camera: {
      ...centrePose(HOME.lat, HOME.lon, HOME.dist, HOME_TARGET),
      fov: 34,
      near: 0.05,
      far: 60,
      minDistance: 1.3,
      maxDistance: 7.5,
      minPolar: 0.2,
      maxPolar: Math.PI - 0.2,
      portrait: { ...centrePose(HOME.lat, HOME.lon, HOME.portrait, HOME_TARGET_PORTRAIT), fov: 40 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 110_000 },
  },
  guard: isCloudData,
  fixture: () => import('../../fixtures/cloud-globe.json'),

  async create(ctx: SceneContext<CloudData>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'cloud-globe';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const data: CloudData = ctx.data ?? { campuses: [] };
    const campuses = normalise(data);
    const types = TYPE_ORDER.filter((t) => campuses.some((c) => c.type === t));
    const metaText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const sample = ctx.isFixture ? '（示意）' : '';

    /* ───────── globe ───────── */
    const globe = ctx.track(
      await Globe.create({
        materials,
        palette: ctx.palette,
        radius: R,
        density: ctx.quality === 'high' ? 1 : ctx.quality === 'medium' ? 0.6 : 0.4,
        markerCapacity: 32,
      }),
    );
    root.add(globe.group);
    // Kit tuning without editing the kit: a deeper ocean (bound after the kit's own binding, so it
    // wins on every theme change) and a slightly softer atmosphere rim.
    for (const o of globe.group.children) {
      if (!(o instanceof Mesh) || !(o.geometry instanceof SphereGeometry)) continue;
      if (o.material instanceof MeshBasicMaterial) materials.bind(o.material, 'color', oceanTint);
      else if (o.material instanceof ShaderMaterial && o.material.uniforms['uStrength']) o.material.uniforms['uStrength'].value = 0.42;
    }

    const gratMat = materials.line('grid', { transparent: true, opacity: 0.4, depthWrite: false });
    const graticule = new LineSegments(ctx.track(buildGraticule(R * 1.0015)), gratMat);
    graticule.matrixAutoUpdate = false;
    root.add(graticule);

    const halo = ctx.track(new GlowSprites({ count: 1, theme: ctx.theme }));
    root.add(halo.object);

    /* ───────── campus pillars ───────── */
    const boost = { value: 0.3 };
    const solidSmooth = ctx.track(withBoost(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.08 }), boost, 'cg-solid'));
    const solidFacet = ctx.track(
      withBoost(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.08, flatShading: true }), boost, 'cg-solid-flat'),
    );
    const ghostMat = ctx.track(
      withBoost(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.32, depthWrite: false }), boost, 'cg-ghost'),
    );

    interface CState extends Tag {
      c: Campus;
      n: Vector3;
      q: Quaternion;
      h: number;
      /** Solid (online) share of the pillar. */
      fill: number;
      shape: Shape;
      solid: InstancedMesh;
      ghost: InstancedMesh;
      slot: number;
      ring: number;
      vis: number;
      visT: number;
      focus: number;
      focusT: number;
      hot: number;
      hotT: number;
      pts: ScreenPoint[];
    }

    /** Data with `mwNow` shows the online share; otherwise each status has an illustrative default. */
    const hasNow = campuses.some((c) => c.mwNow !== null && c.mw);
    const fillOf = (c: Campus) => {
      if (c.mwNow === null || !c.mw) return STATUS_INFO[c.status].fill;
      const f = Math.min(1, c.mwNow / c.mw);
      // An operating campus always shows a solid base, however small its online share.
      return c.status === 'operating' ? Math.max(0.06, f) : f;
    };
    const normals = spreadNormals(campuses, 1.25, 0.72);
    const byType = new Map<CampusType, { solid: InstancedMesh; ghost: InstancedMesh; n: number }>();
    for (const t of types) {
      const shape = TYPE_INFO[t].shape;
      const n = campuses.filter((c) => c.type === t).length;
      const geo = ctx.track(shapeGeometry(shape));
      const solid = new InstancedMesh(geo, shape === 'round' ? solidSmooth : solidFacet, n);
      const ghost = new InstancedMesh(geo, ghostMat, n);
      ghost.renderOrder = 3;
      for (const m of [solid, ghost]) {
        for (let i = 0; i < n; i++) m.setColorAt(i, c3.setRGB(1, 1, 1));
        m.frustumCulled = false;
        root.add(m);
        ctx.track({ dispose: () => m.dispose() });
      }
      byType.set(t, { solid, ghost, n: 0 });
    }

    const N = campuses.length;
    const gwIdx: number[] = [];
    const states: CState[] = campuses.map((c, i) => {
      const bucket = byType.get(c.type)!;
      const n = normals[i]!;
      const ring = (c.mw ?? 0) >= GW ? gwIdx.push(i) - 1 : -1;
      const s: CState = {
        c,
        n,
        q: frameQuat(n),
        h: heightFor(c.mw),
        fill: fillOf(c),
        shape: TYPE_INFO[c.type].shape,
        solid: bucket.solid,
        ghost: bucket.ghost,
        slot: bucket.n++,
        ring,
        vis: 1,
        visT: 1,
        focus: 1,
        focusT: 1,
        hot: 0,
        hotT: 0,
        top: new Vector3(),
        pts: [],
        label: labels.add({ text: c.short, align: 'above', priority: 10 }),
        text: c.short,
        prio: 10,
        on: true,
        align: 'above',
        kind: 'default',
        swatch: true,
      };
      s.pts = [0.25, 0.6, 1].map(() => ({ position: new Vector3(), id: TYPE_INFO[c.type].hotspot }));
      return s;
    });

    // Base discs, GW rings (+ pulse), halos at operating pillar tops.
    const discMat = ctx.track(withInstanceAlpha(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }), 'cg-disc'));
    const discs = new InstancedMesh(ctx.track(flatDisc(new CircleGeometry(1, 28), N)), discMat, Math.max(1, N));
    discs.count = N;
    const ringMat = ctx.track(
      withInstanceAlpha(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }), 'cg-ring'),
    );
    const G = Math.max(1, gwIdx.length);
    const rings = new InstancedMesh(ctx.track(flatDisc(new RingGeometry(0.84, 1, 72), G)), ringMat, G);
    const pulseMat = ctx.track(
      withInstanceAlpha(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide }), 'cg-pulse'),
    );
    const pulses = new InstancedMesh(ctx.track(flatDisc(new RingGeometry(0.9, 1, 72), G)), pulseMat, G);
    rings.count = pulses.count = gwIdx.length;
    for (const m of [discs, rings, pulses]) {
      for (let i = 0; i < m.count; i++) m.setColorAt(i, c3.setRGB(1, 1, 1));
      m.frustumCulled = false;
      m.renderOrder = 2;
      root.add(m);
      ctx.track({ dispose: () => m.dispose() });
    }
    const instanced: InstancedMesh[] = [discs, rings, pulses, ...[...byType.values()].flatMap((b) => [b.solid, b.ghost])];
    const glows = ctx.track(new GlowSprites({ count: Math.max(1, N), theme: ctx.theme }));
    glows.setCount(N);
    root.add(glows.object);

    const hoverMat = materials.basic('fg', { transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide });
    const hoverGeo = ctx.track(new RingGeometry(0.74, 1, 48));
    hoverGeo.rotateX(-Math.PI / 2);
    const hoverRing = new Mesh(hoverGeo, hoverMat);
    hoverRing.renderOrder = 4;
    hoverRing.visible = false;
    root.add(hoverRing);

    /* ───────── arcs ───────── */
    const arcs = ctx.track(new ArcRibbons({ count: 64, mode: 'globe', radius: R * 1.002, segments: 56, flow: 0.32, theme: ctx.theme }));
    // Kit workaround (proposals/scene-agent-loop.yaml → arcribbons-backface-culling): the strip
    // winding flips with the screen direction of the arc, so FrontSide culls half of them.
    arcs.object.material.side = DoubleSide;
    arcs.object.material.forceSinglePass = true;
    root.add(arcs.object);
    const arcUniforms = arcs.object.material.uniforms;
    let arcTween: Tween | null = null;

    /* ───────── orientation labels ───────── */
    const regionLabels = REGIONS.map((r) => labels.add({ text: r.name, position: ll(r.lat, r.lon, R * 1.01), kind: 'tag', priority: 2 }));
    const twLabel = labels.add({ text: TAIWAN.name, position: ll(TAIWAN.lat, TAIWAN.lon, R * 1.01), kind: 'tag', align: 'right', priority: 6 });
    const cityTags: Tag[] = USER_CITIES.map((c) => {
      const top = new Vector3(...ll(c.lat, c.lon, R * 1.012));
      const prio = c.tw ? 60 : 24;
      const label = labels.add({ text: c.name, position: top, kind: c.tw ? 'strong' : 'muted', align: 'below', priority: prio, visible: false });
      return { label, top, text: c.name, prio, on: false, align: 'below', kind: c.tw ? 'strong' : 'muted', swatch: !!c.tw };
    });
    const cityLabels = cityTags.map((t) => t.label);
    const hqOps = new Map<string, { label: string; hq: readonly [number, number] }>();
    for (const c of campuses) if (c.hq && (c.type === 'hyperscaler' || c.type === 'neocloud')) hqOps.set(c.operatorShort, { label: c.operatorShort, hq: c.hq });
    const hqText = (names: readonly string[]) => {
      const t = names.join('、');
      return `${t}${/[A-Za-z0-9]$/.test(t) ? ' ' : ''}總部`;
    };
    const hqTags = new Map<string, Tag>();
    for (const [k, o] of hqOps) {
      const top = new Vector3(...ll(o.hq[0], o.hq[1], R * 1.01));
      const text = hqText([o.label]);
      const label = labels.add({ text, position: top, kind: 'tag', align: 'below', priority: 7, visible: false });
      hqTags.set(k, { label, top, text, prio: 7, on: false, align: 'below', kind: 'tag', swatch: false });
    }
    ctx.labels.setOccluder((w, cam) => globe.isBehind(w, cam));

    /* ───────── overlay (filter chips + legend) ───────── */
    let filter: Filter = 'all';
    let step = 0;
    let spec: StepSpec = STEPS[0]!;
    const counts: Partial<Record<CampusType, number>> = {};
    for (const c of campuses) counts[c.type] = (counts[c.type] ?? 0) + 1;
    const overlay = createOverlay(
      ctx.stage,
      types,
      (f) => {
        setFilter(f, true);
        const n = states.filter((s) => s.visT > 0).length;
        ctx.announce(`篩選：${f === 'all' ? '全部業者' : TYPE_INFO[f].label}，顯示 ${n} 座園區`);
      },
      ctx.signal,
    );
    overlay.setCounts(counts, N);

    /* ───────── palette ───────── */
    const pal = {
      status: { operating: new Color(), construction: new Color(), planned: new Color() } as Record<CampusStatus, Color>,
      dim: new Color(),
      fg: new Color(),
      flow: new Color(),
      accent: new Color(),
      tw: new Color(),
    };
    const statusCss = (s: CampusStatus) => ctx.palette.css[STATUS_INFO[s].token] ?? '';
    let dark = ctx.theme === 'dark';
    let dirty = true;

    const applyPalette = (p: Palette) => {
      dark = p.theme === 'dark';
      lights.apply(p);
      pal.status.operating.copy(p.pos);
      pal.status.construction.copy(p.power);
      pal.status.planned.copy(p.optic);
      pal.dim.copy(p.muted).lerp(p.bg, dark ? 0.35 : 0.25);
      pal.fg.copy(p.fg);
      pal.flow.copy(p.flow);
      pal.accent.copy(p.accent);
      pal.tw.copy(p.twAccent);
      boost.value = dark ? 0.34 : 0.07;
      // The ghost (power not yet online) is often most of a pillar: keep it legible on both grounds.
      ghostMat.opacity = dark ? 0.36 : 0.5;
      gratMat.opacity = dark ? 0.32 : 0.5;
      pulseMat.blending = dark ? AdditiveBlending : NormalBlending;
      ringMat.blending = dark ? AdditiveBlending : NormalBlending;
      pulseMat.needsUpdate = ringMat.needsUpdate = true;
      discMat.opacity = 1;
      globe.setPalette(p); // atmosphere: dark theme only
      halo.setTheme(p.theme);
      halo.set(0, [0, 0, 0], R * 2.5, dark ? c3.copy(p.flow).lerp(p.bg, 0.4) : c3.copy(p.fg), dark ? 0.1 : 0.06);
      glows.setTheme(p.theme);
      arcs.setTheme(p.theme);
      for (const s of states) s.label.set({ swatch: statusCss(s.c.status) });
      twLabel.set({ swatch: p.css['scene-tw-accent'] ?? '' });
      cityLabels.forEach((h, i) => h.set({ swatch: USER_CITIES[i]?.tw ? (p.css['scene-tw-accent'] ?? '') : '' }));
      rebuildArcs(false);
      rebuildMarkers();
      dirty = true;
    };

    /* ───────── per-frame instance writer ───────── */
    const writeInstances = () => {
      const discA = dark ? 0.62 : 0.5;
      const ringA = spec.gw ? (dark ? 0.95 : 0.85) : dark ? 0.3 : 0.32;
      const hovGW = hotspots.hovered === 'gw-campus';
      for (const s of states) {
        const fill = s.fill;
        const vis = s.vis;
        const h = s.h * Math.max(0.0001, vis);
        const w = PILLAR_R * SHAPE_SCALE[s.shape] * (1 + 0.32 * s.hot) * (0.35 + 0.65 * vis);
        // colour: status, dimmed when out of the step's focus, lifted toward fg when hot
        c3.copy(pal.status[s.c.status]).lerp(pal.dim, (1 - s.focus) * 0.78);
        if (s.hot > 0) c3.lerp(pal.fg, 0.18 * s.hot);
        // solid (built) part
        p3.copy(s.n).multiplyScalar(R);
        if (fill > 0) s.solid.setMatrixAt(s.slot, m4.compose(p3, s.q, s3.set(w, Math.max(1e-5, h * fill), w)));
        else s.solid.setMatrixAt(s.slot, ZERO);
        s.solid.setColorAt(s.slot, c3);
        // ghost (not yet built) part
        if (fill < 1) {
          p3.copy(s.n).multiplyScalar(R + h * fill);
          s.ghost.setMatrixAt(s.slot, m4.compose(p3, s.q, s3.set(w * 1.002, Math.max(1e-5, h * (1 - fill)), w * 1.002)));
        } else s.ghost.setMatrixAt(s.slot, ZERO);
        s.ghost.setColorAt(s.slot, c3);
        // footprint disc
        const i = s.c.index;
        p3.copy(s.n).multiplyScalar(R + 0.0012);
        const dr = PILLAR_R * (2.3 + 0.6 * s.hot) * (0.6 + 0.4 * vis);
        discs.setMatrixAt(i, m4.compose(p3, s.q, s3.set(dr, 1, dr)));
        c4.copy(c3).lerp(pal.dim, 0.7 * (1 - vis));
        discs.setColorAt(i, c4);
        (discs.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).setX(i, discA * (0.35 + 0.65 * vis) * (0.45 + 0.55 * s.focus));
        // top: labels, picking, halos
        s.top.copy(s.n).multiplyScalar(R + h + 0.004);
        s.pts[0]!.position.copy(s.n).multiplyScalar(R + 0.012 + h * 0.15);
        s.pts[1]!.position.copy(s.n).multiplyScalar(R + h * 0.6);
        s.pts[2]!.position.copy(s.top);
        s.label.set({ position: s.top });
        const glowA = s.c.status === 'operating' ? (dark ? 0.42 : 0.16) : s.c.status === 'construction' ? (dark ? 0.16 : 0) : 0;
        const gs = (0.032 + 0.04 * Math.sqrt(Math.min(s.c.mw ?? 100, 5000) / 5000)) * (1 + 0.6 * s.hot);
        glows.set(i, s.top, gs, c3, (glowA + 0.25 * s.hot) * vis * (0.3 + 0.7 * s.focus));
        // GW ring
        if (s.ring >= 0) {
          p3.copy(s.n).multiplyScalar(R + 0.0025);
          const rr = ringFor(s.c.mw ?? GW) * (0.5 + 0.5 * vis);
          rings.setMatrixAt(s.ring, m4.compose(p3, s.q, s3.set(rr, 1, rr)));
          rings.setColorAt(s.ring, c3);
          const a = (hovGW ? Math.max(ringA, 0.8) : ringA) * vis * (0.4 + 0.6 * s.focus);
          (rings.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).setX(s.ring, a);
          pulses.setColorAt(s.ring, c3);
        }
      }
      for (const m of instanced) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      discs.geometry.getAttribute('aAlpha').needsUpdate = true;
      rings.geometry.getAttribute('aAlpha').needsUpdate = true;
      const hov = hoverCampus ?? selected;
      hoverRing.visible = !!hov && hov.vis > 0.5;
      if (hov) {
        p3.copy(hov.n).multiplyScalar(R + 0.003);
        const hr = PILLAR_R * 3.4;
        hoverRing.position.copy(p3);
        hoverRing.quaternion.copy(hov.q);
        hoverRing.scale.set(hr, 1, hr);
      }
    };

    const writePulses = (t: number) => {
      const on = !!spec.gw && ctx.animate;
      pulses.visible = on;
      if (!on) return;
      const alpha = pulses.geometry.getAttribute('aAlpha') as InstancedBufferAttribute;
      for (const i of gwIdx) {
        const s = states[i]!;
        const ph = (t * 0.42 + i * 0.137) % 1;
        p3.copy(s.n).multiplyScalar(R + 0.003);
        const rr = ringFor(s.c.mw ?? GW) * (1 + 0.9 * ph) * s.vis;
        pulses.setMatrixAt(s.ring, m4.compose(p3, s.q, s3.set(rr, 1, rr)));
        alpha.setX(s.ring, (1 - ph) * (1 - ph) * (dark ? 0.75 : 0.6) * s.vis * s.focus);
      }
      pulses.instanceMatrix.needsUpdate = true;
      alpha.needsUpdate = true;
    };

    /* ───────── arcs & kit markers per step ───────── */
    const visible = (s: CState) => filter === 'all' || s.c.type === filter;

    /**
     * 租用算力: every city sends a request to the same large operating campus across the Pacific (one
     * remote data centre, many users). No "nearest campus" route: from Taipei that would often land
     * on a mainland-China cloud region, which is not where Taiwanese users' AI requests go.
     */
    interface Route {
      from: Vector3;
      to: CState;
      tw: boolean;
    }
    const userRoutes = (): Route[] => {
      const live = states.filter((s) => visible(s) && s.c.status === 'operating');
      const pool = live.length ? live : states.filter(visible);
      const biggest = [...pool].sort((a, b) => (b.c.mw ?? 0) - (a.c.mw ?? 0))[0];
      const routes: Route[] = [];
      if (!biggest) return routes;
      for (const city of USER_CITIES) routes.push({ from: latLonToVec3(city.lat, city.lon, 1), to: biggest, tw: !!city.tw });
      return routes;
    };
    /**
     * Camera over the middle of the main route (the great circle bulges toward the pole), so the
     * users and the campus sit left and right and the routes cross the middle of the frame.
     */
    const rentPose = (): CameraPose => {
      const routes = userRoutes();
      if (!routes.length) return ctx.homePose;
      const users = new Vector3();
      for (const city of USER_CITIES) users.add(latLonToVec3(city.lat, city.lon, 1));
      const mid = users.normalize().add(routes[0]!.to.n).normalize();
      const { lat, lon } = vec3ToLatLon(mid);
      // Portrait stages are narrow: back off a little so both ends of the routes stay inside.
      return centrePose(Math.max(-10, Math.min(55, lat - 4)), lon, (ctx.size.portrait ? 1.12 : 1) * 3.65, [0, 0.3, 0]);
    };

    /** Operators whose HQ arc is drawn (their HQ marker and label show too). */
    const hqDrawn = new Set<string>();
    const rebuildArcs = (animateIn: boolean) => {
      arcTween?.cancel();
      hqDrawn.clear();
      const list: Arc[] = [];
      const add = (from: Vector3, to: Vector3, color: Color, width: number, alpha: number) => {
        const a = angle(from, to);
        if (a < 2 * DEG) return;
        list.push({ start: from.clone().multiplyScalar(R), end: to.clone().multiplyScalar(R), height: arcLift(a), width, color: color.clone(), alpha, progress: 1 });
      };
      if (spec.arcs === 'users') {
        for (const r of userRoutes()) add(r.from, r.to.n, r.tw ? pal.tw : pal.flow, r.tw ? 0.0085 : 0.0058, r.tw ? 1 : 0.7);
      } else if (spec.arcs === 'hq') {
        for (const s of states) {
          if (!visible(s) || !s.c.hq || (s.c.type !== 'hyperscaler' && s.c.type !== 'neocloud')) continue;
          const hq = latLonToVec3(s.c.hq[0], s.c.hq[1], 1);
          if (angle(hq, s.n) > MAX_HQ_ARC) continue;
          add(hq, s.n, pal.accent, 0.0055, 0.85);
          hqDrawn.add(s.c.operatorShort);
        }
      }
      arcs.setArcs(list);
      if (animateIn && list.length && ctx.animate) {
        const n = list.length;
        list.forEach((_, i) => arcs.setProgress(i, 0));
        arcTween = ctx.tween.run(
          (k) => {
            for (let i = 0; i < n; i++) arcs.setProgress(i, Math.min(1, Math.max(0, (k * 1.5 - (i / n) * 0.5) * 1.05)));
          },
          { duration: 1500, ease: 'quadOut' },
        );
      }
    };

    const rebuildMarkers = () => {
      const p = ctx.palette;
      const marks: { id: string; lat: number; lon: number; color: Color; height: number; size: number }[] = [];
      if (spec.arcs === 'users')
        USER_CITIES.forEach((c) => marks.push({ id: c.name, lat: c.lat, lon: c.lon, color: (c.tw ? p.twAccent : p.fg).clone(), height: 0.014, size: 0.0062 }));
      if (spec.arcs === 'hq') {
        const seen = new Set<string>();
        for (const s of states) {
          if (!s.c.hq || seen.has(s.c.operatorShort) || !hqDrawn.has(s.c.operatorShort)) continue;
          seen.add(s.c.operatorShort);
          marks.push({ id: s.c.operatorShort, lat: s.c.hq[0], lon: s.c.hq[1], color: p.accent.clone(), height: 0.009, size: 0.0075 });
        }
      }
      globe.setMarkers(marks);
    };

    /* ───────── labels / legend per step & filter ───────── */
    let hoverCampus: CState | null = null;
    let selected: CState | null = null;
    let lastHov = '';
    let layoutAt = 0;

    const labelBudget = () => {
      const w = ctx.size.width;
      return w < 440 ? 4 : (w < 560 ? 7 : w < 900 ? 11 : 15) + (step === 0 ? 0 : 3);
    };

    const updateLabels = () => {
      const hov = hotspots.hovered;
      const hovType = types.find((t) => TYPE_INFO[t].hotspot === hov);
      for (const s of states) {
        const mw = s.c.mw;
        const big = (mw ?? 0) >= GW;
        const on = s.visT > 0 && (!spec.gw || big || s === hoverCampus);
        const withMW = (spec.gw || spec.pipeline) && mw;
        const isHot = s === hoverCampus || s === selected;
        const lit = isHot || hovType === s.c.type || (hov === 'gw-campus' && big);
        s.text = withMW ? `${s.c.short}・${fmtMW(mw)}` : s.c.short;
        s.on = on;
        s.prio = 10 + 22 * Math.sqrt(Math.min(mw ?? 60, 5000) / 5000) + (isHot ? 400 : lit ? 60 : 0);
        s.kind = isHot ? 'strong' : 'default';
        s.label.set({ text: s.text, visible: on, kind: s.kind, priority: s.prio });
      }
      layoutAt = 0;
      regionLabels.forEach((h) => h.set({ visible: step === 0 || spec.arcs === 'users' }));
      for (const t of cityTags) {
        t.on = spec.arcs === 'users';
        t.label.set({ visible: t.on });
      }
      // HQ tags: neighbours (e.g. Seattle and Redmond) share one label.
      const leaders: { k: string; v: Vector3; names: string[] }[] = [];
      for (const [k, o] of hqOps) {
        const t = hqTags.get(k)!;
        t.on = false;
        if (spec.arcs !== 'hq' || !hqDrawn.has(k)) {
          t.label.set({ visible: false });
          continue;
        }
        const v = latLonToVec3(o.hq[0], o.hq[1], 1);
        const lead = leaders.find((l) => angle(l.v, v) < 1.5 * DEG);
        if (lead) {
          lead.names.push(o.label);
          t.label.set({ visible: false });
        } else leaders.push({ k, v, names: [o.label] });
      }
      for (const l of leaders) {
        const t = hqTags.get(l.k)!;
        t.on = true;
        t.text = hqText(l.names);
        t.label.set({ visible: true, text: t.text });
      }
      labels.setMax(labelBudget());
    };

    /**
     * Label alignment pass (every ~200 ms): in priority order, keep each label (campuses, user cities,
     * HQ tags) on its current side if that spot is free, else try above → right → left → below.
     * Crowded clusters (the US belt, the Gulf, 台北／東京／首爾) then show more names instead of the
     * collision grid culling them; sticking to the current side first keeps labels from flickering
     * while the globe turns.
     */
    /** Placed boxes as inclusive cell ranges [x0, y0, x1, y1] on the host's 4 px collision grid. */
    const boxes: number[] = [];
    const cellBox = (x: number, y: number, w: number, h: number): [number, number, number, number] => {
      // Same quantisation as the host LabelLayer (rounded position, 2 px pad, 4 px cells).
      x = Math.round(x);
      y = Math.round(y);
      return [Math.floor((x - 2) / 4), Math.floor((y - 2) / 4), Math.floor((x + w + 2) / 4), Math.floor((y + h + 2) / 4)];
    };
    const overlaps = (b: readonly number[]) => {
      for (let i = 0; i < boxes.length; i += 4)
        if (b[0]! <= boxes[i + 2]! && b[2]! >= boxes[i]! && b[1]! <= boxes[i + 3]! && b[3]! >= boxes[i + 1]!) return true;
      return false;
    };
    const layoutLabels = () => {
      const { width: W, height: H } = ctx.size;
      // Mirrors .scene-label (Scene3D.astro): default/muted clamp(11px, .55rem + .4cqi, 13px) with
      // 9px padding; strong clamp(12px, .6rem + .5cqi, 15px) with 11px; tag 11px with 6px; a swatch
      // adds 8px + 6px gap. Underestimating a big label (台北) lets the host cull its neighbours.
      const fsD = Math.max(11, Math.min(13, 8.8 + 0.004 * W));
      const fsS = Math.max(12, Math.min(15, 9.6 + 0.005 * W));
      const metrics = (t: Tag): [fs: number, w0: number, h: number] => {
        const sw = t.swatch ? 14 : 0;
        if (t.kind === 'strong') return [fsS, 24 + sw, fsS * 1.35 + 9];
        if (t.kind === 'tag') return [11, 14 + sw, 11 * 1.35 + 4];
        return [fsD, 20 + sw, fsD * 1.35 + 7];
      };
      boxes.length = 0;
      let n = 0;
      const max = labelBudget();
      const list: Tag[] = [...states, ...cityTags, ...hqTags.values()].filter((s) => s.on).sort((a, b) => b.prio - a.prio);
      for (const s of list) {
        if (n >= max) break;
        if (globe.isBehind(s.top, ctx.camera)) continue;
        const p = ctx.project(s.top);
        if (!p) continue;
        const [fs, w0, lh] = metrics(s);
        let w = w0;
        for (const ch of s.text) w += ch === ' ' ? fs * 0.3 : ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.58;
        for (const a of [s.align, ...ALIGNS]) {
          const x = a === 'left' ? p.x - w - 10 : a === 'right' ? p.x + 10 : p.x - w / 2;
          const y = a === 'above' ? p.y - lh - 8 : a === 'below' ? p.y + 8 : p.y - lh / 2;
          if (x < 0 || y < 0 || x + w > W || y + lh > H) continue;
          const b = cellBox(x, y, w, lh);
          if (overlaps(b)) continue;
          boxes.push(...b);
          n++;
          if (a !== s.align) {
            s.align = a;
            s.label.set({ align: a });
          }
          break;
        }
      }
    };

    const gwTotal = (list: readonly CState[]) => list.reduce((a, s) => a + (s.c.mw ?? 0), 0);
    const gwText = (mw: number) => `約 ${fmtMW(mw)}`;
    const updateLegend = () => {
      const vis = states.filter((s) => s.visT > 0);
      if (spec.pipeline) {
        overlay.setExtra([hasNow ? '半透明段＝已宣布、尚未上線的電力' : '實心段比例為示意（資料未提供上線電力）']);
      } else if (spec.gw) {
        const big = vis.filter((s) => (s.c.mw ?? 0) >= GW);
        overlay.setExtra(['光環＝1 GW 以上：', { strong: `${big.length} 座` }, `，合計${gwText(gwTotal(big))}${sample}`]);
      } else if (spec.arcs === 'hq') overlay.setExtra(['弧線＝業者總部 → 自家園區']);
      else if (spec.arcs === 'users') overlay.setExtra(['弧線＝示意的請求路線（城市 → 園區）']);
      else overlay.setExtra([]);
    };

    /** 超大規模雲／新雲／主權 AI: planned power per operator (sums of the campuses on the globe). */
    const operatorPanel = (t: CampusType): BarPanel | null => {
      const list = states.filter((s) => s.c.type === t);
      const by = new Map<string, { mw: number; n: number }>();
      for (const s of list) {
        const o = by.get(s.c.operatorShort) ?? { mw: 0, n: 0 };
        o.mw += s.c.mw ?? 0;
        o.n++;
        by.set(s.c.operatorShort, o);
      }
      const rows = [...by.entries()]
        .filter(([, o]) => o.mw > 0)
        .sort((a, b) => b[1].mw - a[1].mw)
        .slice(0, 5)
        .map(([label, o]) => ({ label, value: o.mw, text: `${fmtMW(o.mw)}・${o.n} 座` }));
      if (rows.length < 2) return null;
      const unknown = list.filter((s) => !s.c.mw).length;
      return {
        title: `${TYPE_INFO[t].label}：各業者園區電力加總${sample}`,
        rows,
        note: `只加總地球儀上的園區${unknown ? `（另有 ${unknown} 座未公開電力）` : ''}，不是各公司的全部機房。`,
      };
    };
    /**
     * 建置進度: with `mwNow` in the data, planned power split into already online / announced but not
     * yet online (operating + construction) / planned; without it, planned power per build status.
     */
    const pipelinePanel = (): BarPanel => {
      const vis = states.filter((s) => s.visT > 0);
      const unknown = vis.filter((s) => !s.c.mw).length;
      const src = `依${ctx.isFixture ? '示意' : '頁面'}資料加總${unknown ? `，另有 ${unknown} 座未公開電力` : ''}`;
      if (hasNow) {
        let online = 0;
        let building = 0;
        let planned = 0;
        for (const s of vis) {
          const mw = s.c.mw ?? 0;
          if (s.c.status === 'planned') planned += mw;
          else {
            const now = s.c.mwNow ?? (s.c.status === 'operating' ? mw : 0);
            online += Math.min(now, mw);
            building += Math.max(0, mw - now);
          }
        }
        const row = (label: string, v: number, st: CampusStatus) => ({ label, value: v, text: gwText(v), color: STATUS_INFO[st].token });
        return {
          title: `規劃電力的進度${sample}`,
          rows: [row('已上線', online, 'operating'), row('興建或擴建中', building, 'construction'), row('尚未動工', planned, 'planned')],
          note: `${src}；營運中的園區多半仍在分期擴建，宣布的規模不等於已上線的算力。`,
        };
      }
      return {
        title: `各狀態園區的規劃電力加總${sample}`,
        rows: STATUS_ORDER.map((st) => {
          const sum = gwTotal(vis.filter((s) => s.c.status === st));
          return { label: STATUS_INFO[st].label, value: sum, text: gwText(sum), color: STATUS_INFO[st].token };
        }),
        note: `${src}；營運中的園區多半仍在分期擴建，已上線的電力少於規劃。`,
      };
    };
    const updatePanel = () => {
      if (spec.pipeline) overlay.setPanel(pipelinePanel());
      else if (spec.operators && filter !== 'all') overlay.setPanel(operatorPanel(filter));
      else overlay.setPanel(null);
    };

    const setFilter = (f: Filter, fromChip: boolean) => {
      filter = f;
      overlay.setFilter(f);
      for (const s of states) s.visT = visible(s) ? 1 : 0;
      if (selected && selected.visT === 0) {
        selected = null;
        ctx.card.hide();
      }
      rebuildArcs(fromChip);
      rebuildMarkers();
      updateLabels();
      updateLegend();
      updatePanel();
      if (fromChip) {
        pauseUntil = performance.now() + 9000;
        if (f !== 'all') flyTo(typePose(f));
      }
      ctx.invalidate();
    };

    /* ───────── camera ───────── */
    /** The densest group of campuses (weighted by √MW) within `radiusDeg` of one of them. */
    const clusterOf = (list: readonly CState[], radiusDeg = 26): CState[] => {
      const cos = Math.cos(radiusDeg * DEG);
      let best: CState[] = [];
      let bestW = -1;
      for (const a of list) {
        const near = list.filter((b) => a.n.dot(b.n) > cos);
        const w = near.reduce((sum, b) => sum + Math.sqrt(b.c.mw ?? 80), 0);
        if (w > bestW) {
          bestW = w;
          best = near;
        }
      }
      return best;
    };
    /** Regional views look down a little more on tall (portrait) stages, which show more sky. */
    const elev = () => (ctx.size.portrait ? 62 : 55);
    /** Oblique view over the densest cluster of `list`, close enough to read the pillars. */
    const clusterPose = (list: readonly CState[], fallback: CameraPose): CameraPose => {
      const cl = clusterOf(list);
      if (!cl.length) return fallback;
      const v = new Vector3();
      for (const s of cl) v.addScaledVector(s.n, Math.sqrt(s.c.mw ?? 80));
      v.normalize();
      let spread = 0;
      for (const s of cl) spread = Math.max(spread, angle(s.n, v));
      const { lat, lon } = vec3ToLatLon(v);
      // Portrait stages get the host's ×(portrait / main) distance scale; regional views zoom back in.
      const zoom = ctx.size.portrait ? 0.82 : 0.9;
      return obliquePose(lat - 1, lon, zoom * Math.min(2.2, Math.max(1.55, 1.4 + 1.3 * spread)), elev());
    };
    /** 建置進度: a wider look over the busiest region, from the south-south-east (unlike the GW step). */
    const pipePose = (): CameraPose => {
      const cl = clusterOf(states, 30);
      if (!cl.length) return ctx.homePose;
      const v = new Vector3();
      for (const s of cl) v.addScaledVector(s.n, Math.sqrt(s.c.mw ?? 80));
      const { lat, lon } = vec3ToLatLon(v.normalize());
      return obliquePose(lat - 1, lon, (ctx.size.portrait ? 0.95 : 1) * 2.0, elev(), 24);
    };
    /**
     * A type spread over several regions (主權 AI: the Gulf, India, Europe, Japan, Korea, Taiwan) gets
     * the 總覽 framing turned to its weighted centre longitude instead of a close-up of one cluster,
     * so every region the caption names is on screen.
     */
    const widePose = (list: readonly CState[]): CameraPose => {
      const v = new Vector3();
      for (const s of list) v.addScaledVector(s.n, Math.sqrt(s.c.mw ?? 80));
      const { lon } = vec3ToLatLon(v.normalize());
      return ctx.size.portrait
        ? centrePose(HOME.lat, lon, HOME.portrait, HOME_TARGET_PORTRAIT)
        : centrePose(HOME.lat, lon, HOME.dist, HOME_TARGET);
    };
    const typePose = (t: CampusType) => {
      const list = states.filter((s) => s.c.type === t);
      if (list.length >= 4 && clusterOf(list).length < list.length / 2) return widePose(list);
      return clusterPose(list, ctx.homePose);
    };
    const gwPose = () => clusterPose(states.filter((s) => (s.c.mw ?? 0) >= GW), ctx.homePose);
    const stepPose = (i: number): CameraPose => {
      const sp = STEPS[i] ?? STEPS[0]!;
      if (i === 0) return ctx.homePose;
      if (sp.arcs === 'users') return rentPose();
      if (sp.filter !== 'all') return typePose(sp.filter);
      if (sp.gw) return gwPose();
      return pipePose();
    };

    let posing = false;
    let flyToken = 0;
    const legs: Tween[] = [];
    const flyTo = (pose: CameraPose) => {
      const token = ++flyToken;
      legs.splice(0).forEach((t) => t.cancel());
      posing = true;
      const done = () => {
        if (token === flyToken) posing = false;
      };
      const cam = ctx.camera.position;
      const to = Array.isArray(pose.position) ? new Vector3(...(pose.position as Tuple)) : (pose.position as Vector3).clone();
      const a = angle(v3.copy(cam).normalize(), to.clone().normalize());
      if (a > 1.6 && ctx.animate) {
        // Long hop: two legs through a slerped midpoint so the camera swings around the globe.
        const from = cam.clone().normalize();
        const axis = new Vector3().crossVectors(from, to.clone().normalize());
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        const mid = from.applyAxisAngle(axis.normalize(), a / 2).multiplyScalar(Math.max(cam.length(), to.length()) * 1.06);
        const l1 = ctx.setPose({ position: mid, target: [0, 0, 0] }, { duration: 620, ease: (k) => k * k });
        legs.push(l1);
        void l1.done.then(() => {
          if (token !== flyToken) return;
          const l2 = ctx.setPose(pose, { duration: 680, ease: 'quadOut' });
          legs.push(l2);
          void l2.done.then(done);
        });
      } else {
        const l = ctx.setPose(pose);
        legs.push(l);
        void l.done.then(done);
      }
    };

    /* ───────── hotspots, cards, picking ───────── */
    const campusCard = (s: CState, link: boolean): CardContent => {
      const c = s.c;
      const card: CardContent = {
        title: c.name,
        subtitle: `${c.operator}・${TYPE_INFO[c.type].label}（${TYPE_INFO[c.type].shapeName}）`,
        swatch: statusCss(c.status),
        body: STATUS_INFO[c.status].note,
        items: [
          { label: '規劃電力', meta: c.mw ? `${gwText(c.mw)}${sample}` : '未公開' },
          ...(c.mwNow !== null && c.mw ? [{ label: '已上線', meta: c.mwNow > 0 ? `${gwText(c.mwNow)}${sample || '（估計）'}` : '尚未上線' }] : []),
          { label: '建置狀態', meta: STATUS_INFO[c.status].label },
          { label: '位置', meta: fmtLatLon(c.lat, c.lon) },
        ],
      };
      if (link) {
        card.href = TYPE_INFO[c.type].href;
        card.linkLabel = TYPE_INFO[c.type].linkLabel;
      }
      return card;
    };
    const topList = (list: readonly CState[], n: number) =>
      [...list]
        .sort((a, b) => (b.c.mw ?? 0) - (a.c.mw ?? 0))
        .slice(0, n)
        .map((s) => ({ label: s.c.short, meta: s.c.mw ? `${fmtMW(s.c.mw)}${sample}` : '未公開' }));
    const typeCard = (t: CampusType): CardContent => {
      const list = states.filter((s) => s.c.type === t);
      const info = TYPE_INFO[t];
      return {
        title: `${metaText.get(info.hotspot)?.label ?? info.label}（${list.length} 座）`,
        body: metaText.get(info.hotspot)?.detail ?? '',
        items: topList(list, 4),
        href: info.href,
        linkLabel: info.linkLabel,
      };
    };
    const pointCampus: CState[] = [];
    const points: ScreenPoint[] = [];
    const rebuildPoints = () => {
      points.length = 0;
      pointCampus.length = 0;
      for (const s of states) {
        if (s.visT === 0) continue;
        for (const p of s.pts) {
          points.push(p);
          pointCampus.push(s);
        }
      }
    };
    ctx.picker.addPoints(() => (rebuildPoints(), points), { cull: (w) => globe.isBehind(w, ctx.camera) });
    const typeHotspots = new Set(types.map((t) => TYPE_INFO[t].hotspot));
    const campusOf = (hit: PickHit | null): CState | null =>
      hit && hit.index !== undefined && hit.object === ctx.camera && hit.id && typeHotspots.has(hit.id) ? (pointCampus[hit.index] ?? null) : null;

    /** Card / focus anchors: the top of the largest pillar of a group (anchors are scene objects). */
    const anchors: Object3D[] = [];
    const anchorFor = (list: readonly CState[], fallback: Tuple): Object3D => {
      const s = [...list].sort((a, b) => (b.c.mw ?? 0) - (a.c.mw ?? 0))[0];
      const o = new Object3D();
      if (s) o.position.copy(s.n).multiplyScalar(R + s.h + 0.01);
      else o.position.set(...fallback);
      root.add(o);
      anchors.push(o);
      return o;
    };
    const fallbackAnchor = ll(HOME.lat, HOME.lon, R);
    const gwList = states.filter((s) => (s.c.mw ?? 0) >= GW);
    const anchorOf = {
      type: new Map(types.map((t) => [t, anchorFor(states.filter((s) => s.c.type === t), fallbackAnchor)] as const)),
      all: anchorFor(states, fallbackAnchor),
      gw: anchorFor(gwList, fallbackAnchor),
      build: anchorFor(
        states.filter((s) => s.c.status === 'construction'),
        fallbackAnchor,
      ),
    };
    const suppress = (src: string) => src === 'pointer' || src === 'touch';
    const taipei = USER_CITIES.find((c) => c.tw) ?? USER_CITIES[0]!;
    /** (Re)register the hotspots; their focus poses depend on the stage shape (landscape / portrait). */
    const registerHotspots = () => {
      for (const t of types) {
        hotspots.register(TYPE_INFO[t].hotspot, {
          anchor: anchorOf.type.get(t)!,
          pose: typePose(t),
          card: (hit) => {
            const s = campusOf(hit);
            return s ? campusCard(s, false) : typeCard(t);
          },
          onSelect: (src) => suppress(src),
        });
      }
      // Types missing from the data still give their list entry a sensible focus.
      for (const t of TYPE_ORDER) {
        const id = TYPE_INFO[t].hotspot;
        if (types.includes(t) || !metaText.has(id)) continue;
        hotspots.register(id, { anchor: anchorOf.all, pose: ctx.homePose });
      }
      hotspots.register('gw-campus', {
        anchor: anchorOf.gw,
        pose: gwPose(),
        card: () => ({
          title: metaText.get('gw-campus')?.label ?? 'GW 級巨型園區',
          body: metaText.get('gw-campus')?.detail ?? '',
          items: topList(gwList, 5),
          href: '/glossary/#gigawatt',
          linkLabel: '認識 GW →',
        }),
      });
      hotspots.register('build-status', {
        anchor: anchorOf.build,
        pose: pipePose(),
        card: () => ({
          title: metaText.get('build-status')?.label ?? '建置狀態',
          body: metaText.get('build-status')?.detail ?? '',
          items: STATUS_ORDER.map((st) => {
            const l = states.filter((s) => s.c.status === st);
            return { label: STATUS_INFO[st].label, meta: `${l.length} 座・${gwText(gwTotal(l))}${sample}` };
          }),
        }),
      });
      hotspots.register('cloud-request', { anchor: ll(taipei.lat, taipei.lon, R * 1.02), pose: rentPose() });
      hotspots.register('energy-siting', { anchor: ll(31.5, -99, R * 1.02), pose: obliquePose(31, -97, 2.2, elev()) });
    };
    registerHotspots();
    let portrait = ctx.size.portrait;

    ctx.picker.onHover((hit) => {
      const s = campusOf(hit);
      if (s !== hoverCampus) {
        hoverCampus = s;
        ctx.invalidate();
      }
    });
    ctx.picker.onClick((hit, ev) => {
      const s = campusOf(hit);
      if (!s) {
        selected = null;
        ctx.invalidate();
        return;
      }
      if (ev.pointerType === 'mouse' && (ev.ctrlKey || ev.metaKey)) return; // the registry opened a new tab
      selected = s;
      ctx.card.show(campusCard(s, true), s.top, { interactive: true });
      const c = s.c;
      ctx.announce(`已選取：${c.name}。${c.operator}，${TYPE_INFO[c.type].label}，${STATUS_INFO[c.status].label}，電力${c.mw ? gwText(c.mw) : '未公開'}。`);
      ctx.invalidate();
    });

    /* ───────── spin & interaction state ───────── */
    let pointerInside = false;
    let pauseUntil = 0;
    let spinVel = 0;
    let lastNow = performance.now();
    ctx.canvas.addEventListener('pointerenter', () => (pointerInside = true), { signal: ctx.signal });
    ctx.canvas.addEventListener('pointerleave', () => (pointerInside = false), { signal: ctx.signal });
    const onControlsStart = () => (pauseUntil = performance.now() + 8000);
    ctx.controls?.addEventListener('start', onControlsStart);

    /* ───────── steps ───────── */
    const applyStep = (i: number, fly: boolean) => {
      step = i;
      spec = STEPS[i] ?? STEPS[0]!;
      for (const s of states) s.focusT = spec.gw ? ((s.c.mw ?? 0) >= GW ? 1 : 0.22) : 1;
      setFilter(spec.filter, false);
      rebuildArcs(true);
      if (fly) flyTo(stepPose(i));
    };

    applyPalette(ctx.palette);
    applyStep(ctx.step, false);
    writeInstances();

    return {
      update(dt, t) {
        const now = performance.now();
        const rdt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        const cam = ctx.camera;
        const target = ctx.controls?.target ?? v3.set(0, 0, 0);

        // Slow orbit in 總覽 (ambient motion: dt is 0 when motion is off).
        const want = !!spec.spin && ctx.animate && !pointerInside && !ctx.card.visible && !posing && now > pauseUntil && !hotspots.hovered;
        spinVel += ((want ? SPIN : 0) - spinVel) * Math.min(1, rdt * 1.6);
        if (spinVel > 1e-4 && dt > 0) {
          p3.copy(cam.position).sub(target).applyAxisAngle(UP, -spinVel * dt);
          cam.position.copy(target).add(p3);
          cam.lookAt(target);
        }
        // Key light follows the viewer so the facing hemisphere is always lit.
        lights.group.rotation.y = Math.atan2(cam.position.x - target.x, cam.position.z - target.z);

        // Hover / list emphasis targets.
        const hov = hotspots.hovered ?? '';
        const key = `${hov}|${hoverCampus?.c.index ?? -1}|${selected?.c.index ?? -1}|${ctx.card.visible}`;
        if (key !== lastHov) {
          lastHov = key;
          if (selected && !ctx.card.visible) selected = null;
          const hovType = types.find((t) => TYPE_INFO[t].hotspot === hov);
          for (const s of states) {
            const single = s === hoverCampus || s === selected;
            s.hotT = single ? 1 : !hoverCampus && hovType === s.c.type ? 0.55 : hov === 'gw-campus' && (s.c.mw ?? 0) >= GW ? 0.55 : 0;
          }
          updateLabels();
          dirty = true;
        }

        // Ease per-campus values (snap when motion is off).
        const k = ctx.animate ? 1 - Math.exp(-rdt * 9) : 1;
        let moving = false;
        for (const s of states) {
          for (const [v, tg] of EASED) {
            const d = s[tg] - s[v];
            if (d === 0) continue;
            if (Math.abs(d) < 0.002) s[v] = s[tg];
            else {
              s[v] += d * k;
              moving = true;
            }
            dirty = true;
          }
        }
        if (dirty) {
          dirty = false;
          writeInstances();
        }
        writePulses(t);
        if (now - layoutAt > 200) {
          layoutAt = now;
          layoutLabels();
        }
        arcs.update(t);
        arcUniforms['uFlow']!.value = ctx.animate ? 0.32 : 0;
        return moving;
      },
      setStep(i) {
        applyStep(i, true);
      },
      onMotion(animate) {
        arcUniforms['uFlow']!.value = animate ? 0.32 : 0;
        if (!animate) {
          arcTween?.cancel();
          for (let i = 0; i < arcs.count; i++) arcs.setProgress(i, 1);
        }
        dirty = true;
        ctx.invalidate();
      },
      onPalette(p) {
        applyPalette(p);
      },
      onResize(size) {
        labels.setMax(labelBudget());
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          registerHotspots();
        }
      },
      dispose() {
        flyToken++;
        legs.forEach((t) => t.cancel());
        arcTween?.cancel();
        ctx.controls?.removeEventListener('start', onControlsStart);
        overlay.destroy();
        for (const a of anchors) a.removeFromParent();
        root.removeFromParent();
      },
    };
  },
});

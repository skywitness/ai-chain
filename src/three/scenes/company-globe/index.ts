/**
 * company-globe — 全球 AI 企業地球儀 (variant: globe).
 *
 * A dotted globe (kit Globe) with every company HQ from the page data (`companies`) as a small
 * puck coloured by its chain layer (--layer-*). Companies of one city stack into a column, bottom
 * → top in chain order (能源 → 晶片 → 系統 → 雲端與模型 → 應用, like the chain tower), so column
 * height = number of companies and the colour bands show what the city does. Overlapping columns
 * (e.g. 台北 / 新北, 聖塔克拉拉 / 聖荷西) are pushed apart on the sphere; a thin leader line joins a
 * moved column to its true position. Puck size = tier (一線 / 二線 / 三線與新創) or trailing
 * revenue (area ∝ USD revenue; undisclosed = a grey sliver), switched by an HTML toggle.
 * HTML chips filter by layer (filtered-out pucks collapse, the column shrinks). One InstancedMesh
 * draws every puck; picking is screen-space (ctx.picker.addPoints, one point per visible puck).
 * Hover a puck for its card; click opens /companies/<id>/; touch opens an interactive card.
 *
 * Steps: 總覽 (slow spin) → 城市聚落 (北台灣) → 晶片重鎮 (silicon filter) → 矽谷 → 雲端與模型
 * (cloud-models filter) → 營收規模 (revenue sizing). Close-ups use an oblique camera so the
 * columns stand up on screen.
 * Reduced motion: no spin, camera cuts, filter / size changes snap.
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
  InstancedMesh,
  LatheGeometry,
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
  Vector2,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { LAYER_IDS } from '../../core/ids';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type CardItem,
  type LabelHandle,
  type LayerId,
  type Palette,
  type PickHit,
  type SceneContext,
  type ScreenPoint,
  type Tween,
} from '../../core/types';
import { Globe, latLonToVec3, vec3ToLatLon } from '../../kit/Globe';
import { GlowSprites } from '../../kit/GlowSprites';
import {
  HUBS,
  LAYER_INFO,
  SEG_SHORT,
  TIER_LABEL,
  buildCities,
  fmtRevenue,
  isCompanyData,
  normalise,
  type City,
  type Company,
  type CompanyData,
  type Hub,
} from './data';
import { createOverlay, type Filter, type SizeMode } from './overlay';

/* ───────────────────────── constants ───────────────────────── */

const R = 1;
const DEG = Math.PI / 180;
/** Puck radius by tier (world units on the unit globe). */
const TIER_R: Readonly<Record<1 | 2 | 3, number>> = { 1: 0.0125, 2: 0.0095, 3: 0.0078 };
/** Revenue sizing: area ∝ revenue between these radii; undisclosed → a thin grey sliver. */
const REV_MIN = 0.006;
const REV_MAX = 0.022;
const SLIVER_R = 0.0062;
/** Column pitch per company (scaled down when the tallest city would exceed MAX_COLUMN). */
const PITCH_MAX = 0.0062;
const MAX_COLUMN = 0.3;
/** Puck thickness as a share of the pitch (the rest is the gap between pucks). */
const THICK = 0.76;
const SPIN = 0.05; // rad/s camera orbit in 總覽
/** Closest zoom for global views (orbit target at the globe centre). */
const GLOBAL_MIN = 1.3;
/** Column height scale for a camera altitude above the surface (1 from orbit, COL_MIN up close). */
const COL_MIN = 0.2;
const scaleAt = (alt: number) => Math.min(1, Math.max(COL_MIN, (alt - 0.05) / 2.2));
/**
 * 總覽: from high over the Bering Sea. Seen from this latitude the North Pacific rim folds into
 * one hemisphere: East Asia (left), the US west coast (right) and the US east coast all sit
 * within ~60° of the view centre, so the columns stand up on screen instead of lying flat at the
 * limb; the slow orbit then carries the view eastward.
 */
const HOME = { lat: 55, lon: -176, dist: 3.85, portrait: 4.0 };

type Tuple = [number, number, number];
type Align = 'above' | 'left' | 'right';
const UP = new Vector3(0, 1, 0);
const ll = (lat: number, lon: number, r: number): Tuple => latLonToVec3(lat, lon, r).toArray() as Tuple;
const centrePose = (lat: number, lon: number, dist: number): CameraPose => ({ position: ll(lat, lon, dist), target: [0, 0, 0] });
/**
 * Oblique close-up: the target sits `lift` above the surface at (lat, lon) and the camera looks
 * at it from the south (`az`° toward the east), `elev`° above the local horizon, so the radial
 * columns stand up on screen (proposals/scene-company-globe.yaml → globe-oblique-pose).
 */
const obliquePose = (lat: number, lon: number, dist: number, elev: number, az = 0, lift = 0): CameraPose => {
  const n = latLonToVec3(lat, lon, 1);
  const east = new Vector3().crossVectors(UP, n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new Vector3().crossVectors(n, east).normalize();
  const target = n.clone().multiplyScalar(R + lift);
  const e = elev * DEG;
  const h = Math.cos(e) * dist;
  const pos = target
    .clone()
    .addScaledVector(n, Math.sin(e) * dist)
    .addScaledVector(north, -Math.cos(az * DEG) * h)
    .addScaledVector(east, Math.sin(az * DEG) * h);
  return { position: pos.toArray() as Tuple, target: target.toArray() as Tuple };
};

/**
 * True when the globe hides a world point: the segment camera → point enters the sphere first.
 * (The kit's `isBehind` tests the point's own normal, which also hides the tops of tall columns
 * that stick out past the limb and are plainly visible against the sky.)
 */
const occ = new Vector3();
function hiddenByGlobe(world: Vector3, cam: Vector3): boolean {
  occ.subVectors(world, cam);
  const len = occ.length();
  if (len < 1e-6) return false;
  occ.divideScalar(len);
  const b = cam.dot(occ);
  const c = cam.lengthSq() - R * R * 0.998;
  const disc = b * b - c;
  if (disc <= 0) return false;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < len - 1e-4;
}

/** Fixed local frame (+Y = normal, +X = east) so every column is oriented the same way. */
function frameQuat(n: Vector3): Quaternion {
  const east = new Vector3().crossVectors(UP, n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const south = new Vector3().crossVectors(east, n).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(east, n, south));
}

/** A coin with chamfered rims (lathe profile, base at y = 0, top at y = 1, radius 1). */
function puckGeometry(quality: string) {
  if (quality === 'low') {
    const g = new CylinderGeometry(1, 1, 1, 8, 1);
    g.translate(0, 0.5, 0);
    return g;
  }
  const b = 0.2;
  const prof = [
    [0, 0],
    [1 - b, 0],
    [1, b],
    [1, 1 - b],
    [1 - b, 1],
    [0, 1],
  ].map(([x, y]) => new Vector2(Math.max(1e-4, x!), y!));
  return new LatheGeometry(prof, quality === 'high' ? 18 : 12);
}

function buildGraticule(r: number): BufferGeometry {
  const pos: number[] = [];
  const push = (a: Tuple, b: Tuple) => pos.push(...a, ...b);
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 3) push(ll(lat, lon, r), ll(lat, lon + 3, r));
  for (let lon = -180; lon < 180; lon += 30) for (let lat = -78; lat < 78; lat += 3) push(ll(lat, lon, r), ll(lat + 3, lon, r));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

/** Instance colours glow a little in dark theme (emissive += instanceColor · uBoost). */
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

/** Calmer ocean than the kit default (same workaround as cloud-globe → globe-ocean-tint). */
function oceanTint(p: Palette): Color {
  return p.theme === 'dark' ? p.bg.clone().lerp(p.coolant, 0.055) : p.bg.clone().lerp(p.grid, 0.42).lerp(p.coolant, 0.035);
}

/* ───────────────────────── steps ───────────────────────── */

type View = 'home' | 'north-tw' | 'bay' | 'east-asia' | 'usa' | 'pacific';
interface StepSpec {
  filter: Filter;
  size: SizeMode;
  view: View;
  spin?: boolean;
  /** Label the biggest company of each large column in these hubs, or the top companies by revenue. */
  spot?: readonly string[] | 'revenue';
  /**
   * Companies the caption names (roster ids), labelled in this step when the data has them; the
   * `spot` heuristic fills in when fewer than two are present (other data sets).
   */
  names?: readonly string[];
  /** Column names the caption mentions: their labels win collisions in this step. */
  cities?: readonly string[];
}
const STEPS: readonly StepSpec[] = [
  { filter: 'all', size: 'tier', view: 'home', spin: true },
  {
    filter: 'all',
    size: 'tier',
    view: 'north-tw',
    spot: ['hub-taipei', 'hub-hsinchu'],
    names: ['tsmc', 'mediatek', 'foxconn', 'quanta'],
  },
  { filter: 'silicon', size: 'tier', view: 'east-asia' },
  { filter: 'all', size: 'tier', view: 'bay', spot: ['hub-bay-area'], names: ['nvidia', 'amd', 'openai', 'anthropic'] },
  { filter: 'cloud-models', size: 'tier', view: 'usa', cities: ['舊金山', '西雅圖一帶', '紐約', '北京', '杭州'] },
  { filter: 'all', size: 'revenue', view: 'pacific', spot: 'revenue' },
];

/* ───────────────────────── scratch ───────────────────────── */

const m4 = new Matrix4();
const ZERO = new Matrix4().makeScale(0, 0, 0);
const p3 = new Vector3();
const s3 = new Vector3();
const v3 = new Vector3();
const c3 = new Color();
const e3 = new Vector3();

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<CompanyData>({
  json,
  meta: {
    camera: {
      ...centrePose(HOME.lat, HOME.lon, HOME.dist),
      fov: 34,
      near: 0.02,
      far: 60,
      minDistance: 0.12,
      maxDistance: 7.5,
      minPolar: 0.15,
      maxPolar: Math.PI - 0.15,
      portrait: { ...centrePose(HOME.lat, HOME.lon, HOME.portrait), fov: 40 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 30, tris: 240_000 },
  },
  guard: isCompanyData,
  fixture: () => import('../../fixtures/company-globe.json'),

  async create(ctx: SceneContext<CompanyData>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'company-globe';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const companies = normalise(ctx.data);
    const N = companies.length;
    const metaText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const sample = ctx.isFixture ? '（示意）' : '';
    const maxRev = Math.max(1, ...companies.map((c) => c.rev ?? 0));
    const hasRevenue = companies.some((c) => c.rev != null);

    const revR = (c: Company) => (c.rev ? Math.sqrt(REV_MIN * REV_MIN + (REV_MAX * REV_MAX - REV_MIN * REV_MIN) * (c.rev / maxRev)) : SLIVER_R);
    const sizeKey = (c: Company) => (4 - c.tier) * 1e7 + (c.rev ?? 0);
    const cities = buildCities(companies, (c) => Math.max(TIER_R[c.tier], revR(c)), sizeKey);
    const maxCount = Math.max(1, ...cities.map((c) => c.members.length));
    const PITCH = Math.min(PITCH_MAX, MAX_COLUMN / maxCount);
    const layers = LAYER_IDS.filter((l) => companies.some((c) => c.layer === l));

    /* ───────── globe ───────── */
    const globe = ctx.track(
      await Globe.create({
        materials,
        palette: ctx.palette,
        radius: R,
        density: ctx.quality === 'high' ? 1 : ctx.quality === 'medium' ? 0.6 : 0.4,
        markerCapacity: 1,
      }),
    );
    root.add(globe.group);
    // Kit tuning without editing the kit: a calmer ocean (bound after the kit's own binding, so it
    // wins on every theme change), a softer atmosphere rim, and the unused kit marker mesh hidden.
    let dotMat: MeshBasicMaterial | null = null;
    /** Land-dot scale: 1 from orbit; up close each dot would be a puck-sized hexagon tile. */
    const dotScale = { value: 1 };
    for (const o of globe.group.children) {
      if (o instanceof InstancedMesh && o.geometry instanceof CylinderGeometry) o.visible = false;
      if (o instanceof InstancedMesh && o.geometry instanceof CircleGeometry && o.material instanceof MeshBasicMaterial) {
        // Land dots shrink and fade a little in close-ups so they read as a fine dot matrix behind
        // the columns (each dot is scaled about its own centre; CircleGeometry lies in local XY).
        const m = (dotMat = o.material);
        m.transparent = true;
        m.onBeforeCompile = (s) => {
          s.uniforms['uDotScale'] = dotScale;
          s.vertexShader = s.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uDotScale;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy *= uDotScale;');
        };
        m.customProgramCacheKey = () => 'cgl-land';
        m.needsUpdate = true;
      }
      if (!(o instanceof Mesh) || !(o.geometry instanceof SphereGeometry)) continue;
      if (o.material instanceof MeshBasicMaterial) materials.bind(o.material, 'color', oceanTint);
      else if (o.material instanceof ShaderMaterial && o.material.uniforms['uStrength']) o.material.uniforms['uStrength'].value = 0.42;
    }
    const gratMat = materials.line('grid', { transparent: true, opacity: 0.4, depthWrite: false });
    const graticule = new LineSegments(ctx.track(buildGraticule(R * 1.0015)), gratMat);
    graticule.matrixAutoUpdate = false;
    root.add(graticule);

    const glows = ctx.track(new GlowSprites({ count: 2, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── pucks (one InstancedMesh) ───────── */
    const boost = { value: 0.3 };
    const puckMat = ctx.track(withBoost(new MeshStandardMaterial({ roughness: 0.46, metalness: 0.08 }), boost, 'cgl-puck'));
    const pucks = new InstancedMesh(ctx.track(puckGeometry(ctx.quality)), puckMat, Math.max(1, N));
    pucks.count = N;
    pucks.frustumCulled = false;
    for (let i = 0; i < N; i++) pucks.setColorAt(i, c3.setRGB(1, 1, 1));
    root.add(pucks);
    ctx.track({ dispose: () => pucks.dispose() });

    interface CState {
      c: Company;
      city: CityState;
      vis: number;
      visT: number;
      hot: number;
      hotT: number;
      dim: number;
      dimT: number;
      center: Vector3;
      label: LabelHandle | null;
      /** side of the puck its name label sits on (two names in one column take both sides) */
      side: 'left' | 'right';
      /** the side in use (flipped inward near the stage edges) and the label's estimated width */
      sideNow: 'left' | 'right';
      textW: number;
    }
    interface CityState {
      city: City;
      q: Quaternion;
      top: number;
      visible: number;
      label: LabelHandle | null;
      anchor: Object3D;
      /** preferred label side, and the side in use (flipped inward near the stage edges) */
      align: Align;
      alignNow: Align;
    }
    const cityStates: CityState[] = cities.map((city) => ({
      city,
      q: frameQuat(city.n),
      top: R,
      visible: city.members.length,
      label: null,
      anchor: new Object3D(),
      align: 'above',
      alignNow: 'above',
    }));
    const states: CState[] = new Array<CState>(N);
    for (const cs of cityStates)
      for (const c of cs.city.members) states[c.i] = { c, city: cs, vis: 1, visT: 1, hot: 0, hotT: 0, dim: 0, dimT: 0, center: new Vector3(), label: null, side: 'right', sideNow: 'right', textW: 0 };

    /* ───────── city plinths + leader lines ───────── */
    const discMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    const discGeo = ctx.track(new CircleGeometry(1, 24));
    discGeo.rotateX(-Math.PI / 2);
    const discs = new InstancedMesh(discGeo, discMat, Math.max(1, cityStates.length));
    discs.count = cityStates.length;
    discs.frustumCulled = false;
    discs.renderOrder = 1;
    for (let i = 0; i < cityStates.length; i++) discs.setColorAt(i, c3.setRGB(1, 1, 1));
    root.add(discs);
    ctx.track({ dispose: () => discs.dispose() });

    const leadPos: number[] = [];
    for (const cs of cityStates) {
      const { n0, n, radius } = cs.city;
      if (n0.angleTo(n) < radius * 0.45) continue;
      leadPos.push(...n0.clone().multiplyScalar(R * 1.0008).toArray(), ...n.clone().multiplyScalar(R * 1.0008).toArray());
    }
    const leadGeo = ctx.track(new BufferGeometry());
    leadGeo.setAttribute('position', new Float32BufferAttribute(leadPos.length ? leadPos : [0, 0, 0, 0, 0, 0], 3));
    const leadMat = materials.line('fg', { transparent: true, opacity: 0.4, depthWrite: false });
    const leaders = new LineSegments(leadGeo, leadMat);
    leaders.visible = leadPos.length > 0;
    leaders.renderOrder = 2;
    root.add(leaders);

    /* hover ring around the hovered puck */
    const ringGeo = ctx.track(new RingGeometry(0.8, 1, 40));
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = materials.basic('fg', { transparent: true, opacity: 0.9, depthWrite: false, side: DoubleSide });
    const hoverRing = new Mesh(ringGeo, ringMat);
    hoverRing.visible = false;
    hoverRing.renderOrder = 5;
    root.add(hoverRing);

    /* ───────── labels ───────── */
    const cityName = (cs: CityState) => cs.city.name || '（未標示城市）';
    // A column next to a taller one puts its name beside its top (on the side away from the
    // taller column) so the two names do not collide in close-ups (e.g. 舊金山 beside 矽谷); a
    // column with taller neighbours on both sides (桃園 between 新竹 and 台北) keeps it above.
    const alignOf = (cs: CityState): Align => {
      const east = v3.crossVectors(UP, cs.city.n).normalize();
      const self = east.dot(cs.city.n);
      let westTaller = false;
      let eastTaller = false;
      for (const o of cityStates) {
        if (o === cs || o.city.members.length <= cs.city.members.length || o.city.n.angleTo(cs.city.n) >= 3.2 * DEG) continue;
        if (east.dot(o.city.n) > self) eastTaller = true;
        else westTaller = true;
      }
      return eastTaller === westTaller ? 'above' : eastTaller ? 'left' : 'right';
    };
    for (const cs of cityStates) {
      if (cs.city.members.length < 3) continue;
      cs.align = cs.alignNow = alignOf(cs);
      cs.label = labels.add({ text: cityName(cs), align: cs.align, priority: cs.city.members.length, ...(cs.city.hub ? { hotspot: cs.city.hub.id } : {}) });
    }
    // Far views label whole hubs (e.g. 矽谷與舊金山) on their tallest column; near views label columns.
    interface HubLabel {
      hub: Hub;
      cols: CityState[];
      tallest: CityState;
      label: LabelHandle;
      alignNow: Align;
    }
    const hubLabels: HubLabel[] = [];
    for (const h of HUBS) {
      const cols = cityStates.filter((cs) => cs.city.hub === h);
      const tallest = [...cols].sort((a, b) => b.city.members.length - a.city.members.length)[0];
      if (!tallest || cols.length < 2) continue;
      hubLabels.push({ hub: h, cols, tallest, alignNow: 'above', label: labels.add({ text: h.name, align: 'above', hotspot: h.id, visible: false }) });
    }
    let far = true;
    // Company name labels for the close-up and revenue steps (hidden until a step asks for them).
    const byRevenue = [...companies].filter((c) => c.rev != null).sort((a, b) => b.rev! - a.rev!);
    const byId = new Map(companies.map((c) => [c.id, c] as const));
    const named = (sp: StepSpec): Company[] => (sp.names ?? []).map((id) => byId.get(id)).filter((c): c is Company => !!c);
    const spotCandidates = new Set<Company>([...companies.filter((c) => c.tier === 1), ...byRevenue.slice(0, 16), ...STEPS.flatMap(named)]);
    for (const cs of cityStates) {
      const richest = cs.city.members.filter((c) => c.rev != null).sort((a, b) => b.rev! - a.rev!)[0];
      if (richest) spotCandidates.add(richest);
      if (cs.city.members.length < 4) continue;
      const top = [...cs.city.members].sort((a, b) => sizeKey(b) - sizeKey(a))[0];
      if (top) spotCandidates.add(top);
    }
    for (const c of spotCandidates) states[c.i]!.label = labels.add({ text: c.label, align: 'right', kind: 'tag', priority: 5, visible: false });
    // A column's names show only while its foot is on the visible hemisphere (a tall column whose
    // top pokes out past the limb would otherwise put e.g. 匹茲堡 beside the Bay Area), and never
    // under the HTML filter chips.
    const foot = new Vector3();
    let chips = { right: 0, bottom: 0 };
    labels.setOccluder((w, cam) => {
      if (hiddenByGlobe(foot.copy(w).setLength(R * 1.003), cam.position)) return true;
      if (chips.bottom <= 0) return false;
      e3.copy(w).project(cam);
      return ((1 - e3.y) / 2) * ctx.size.height < chips.bottom + 26 && ((e3.x + 1) / 2) * ctx.size.width < chips.right + 90;
    });

    /* ───────── overlay ───────── */
    let sizeMode: SizeMode = 'tier';
    let filterNow: Filter = 'all';
    let sizeK = 0;
    let spec: StepSpec = STEPS[0]!;
    const counts = Object.fromEntries(LAYER_IDS.map((l) => [l, companies.filter((c) => c.layer === l).length])) as Record<LayerId, number>;
    const overlay = createOverlay(
      ctx.stage,
      layers,
      {
        filter: (f) => {
          setFilter(f);
          const n = f === 'all' ? N : counts[f];
          ctx.announce(`篩選：${f === 'all' ? '全部層' : LAYER_INFO[f].title}，顯示 ${n} 家公司`);
        },
        size: (m) => {
          setSize(m);
          ctx.announce(m === 'tier' ? '圓片大小改為代表公司層級' : '圓片大小改為代表近一年營收');
        },
      },
      ctx.signal,
      ctx.isFixture,
    );
    overlay.setCounts(counts, N);
    const measureChips = () => {
      if (ctx.signal.aborted) return;
      chips = overlay.chipsBox();
      ctx.invalidate();
    };
    requestAnimationFrame(measureChips);

    /* ───────── palette ───────── */
    const pal = {
      layer: Object.fromEntries(LAYER_IDS.map((l) => [l, new Color()])) as Record<LayerId, Color>,
      dim: new Color(),
      muted: new Color(),
      fg: new Color(),
      plinth: new Color(),
    };
    let dark = ctx.theme === 'dark';
    let dirty = true;
    const applyPalette = (p: Palette) => {
      dark = p.theme === 'dark';
      lights.apply(p);
      for (const l of LAYER_IDS) pal.layer[l].copy(p.layer[l]);
      pal.dim.copy(p.muted).lerp(p.bg, dark ? 0.45 : 0.35);
      pal.muted.copy(p.muted).lerp(p.bg, dark ? 0.15 : 0.1);
      pal.fg.copy(p.fg);
      pal.plinth.copy(p.fg).lerp(p.bg, dark ? 0.62 : 0.55);
      boost.value = dark ? 0.3 : 0.05;
      gratMat.opacity = dark ? 0.32 : 0.5;
      discMat.opacity = dark ? 0.5 : 0.42;
      leadMat.opacity = dark ? 0.45 : 0.5;
      glows.setTheme(p.theme);
      glows.set(0, [0, 0, 0], R * 2.5, dark ? c3.copy(p.flow).lerp(p.bg, 0.4) : c3.copy(p.fg), dark ? 0.1 : 0.05);
      ringMat.blending = dark ? AdditiveBlending : NormalBlending;
      ringMat.needsUpdate = true;
      for (const s of states) s.label?.set({ swatch: p.css[`layer-${s.c.layer}`] ?? '' });
      dirty = true;
    };

    /* ───────── per-frame instance writer ───────── */
    /** Semantic zoom: columns are tall needles from orbit and short, fat stacks up close. */
    let colScale = 1;
    /** Pucks also shrink a little up close, so neighbouring columns separate. */
    let radScale = 1;
    const radiusOf = (s: CState) => {
      const tr = TIER_R[s.c.tier];
      return (tr + (revR(s.c) - tr) * sizeK) * radScale;
    };
    const writeInstances = () => {
      for (let k = 0; k < cityStates.length; k++) {
        const cs = cityStates[k]!;
        const n = cs.city.n;
        let y = 0;
        let vis = 0;
        for (const c of cs.city.members) {
          const s = states[c.i]!;
          const h = PITCH * colScale * s.vis;
          if (s.vis > 0.5) vis++;
          if (s.vis < 0.004) {
            pucks.setMatrixAt(c.i, ZERO);
            s.center.copy(n).multiplyScalar(R + y);
            continue;
          }
          const sliver = c.rev == null ? sizeK : 0;
          const r = radiusOf(s) * (0.3 + 0.7 * s.vis) * (1 + 0.3 * s.hot);
          const t = h * THICK * (1 - 0.6 * sliver);
          p3.copy(n).multiplyScalar(R + y + (h - t) / 2);
          pucks.setMatrixAt(c.i, m4.compose(p3, cs.q, s3.set(r, Math.max(1e-5, t), r)));
          c3.copy(pal.layer[c.layer]);
          if (sliver > 0) c3.lerp(pal.muted, 0.8 * sliver);
          if (s.dim > 0) c3.lerp(pal.dim, 0.72 * s.dim);
          if (s.hot > 0) c3.lerp(pal.fg, 0.22 * s.hot);
          pucks.setColorAt(c.i, c3);
          s.center.copy(n).multiplyScalar(R + y + h / 2);
          y += h;
        }
        cs.top = R + y;
        cs.visible = vis;
        // plinth: shrinks (but stays as a faint marker) when the filter hides the whole column
        p3.copy(n).multiplyScalar(R + 0.0009);
        const dr = cs.city.radius * radScale * (vis ? 1.35 : 0.7);
        discs.setMatrixAt(k, m4.compose(p3, cs.q, s3.set(dr, 1, dr)));
        discs.setColorAt(k, vis ? pal.plinth : c3.copy(pal.plinth).lerp(pal.dim, 0.5));
        cs.anchor.position.copy(n).multiplyScalar(cs.top + 0.004);
      }
      pucks.instanceMatrix.needsUpdate = true;
      if (pucks.instanceColor) pucks.instanceColor.needsUpdate = true;
      discs.instanceMatrix.needsUpdate = true;
      if (discs.instanceColor) discs.instanceColor.needsUpdate = true;
      updateLabelPositions();
      // hover ring + glow
      const hov = hoverCompany ?? selected;
      hoverRing.visible = !!hov && hov.vis > 0.5;
      if (hov && hoverRing.visible) {
        const r = radiusOf(hov) * 1.75;
        hoverRing.position.copy(hov.center);
        hoverRing.quaternion.copy(hov.city.q);
        hoverRing.scale.set(r, 1, r);
        glows.set(1, hov.center, r * 7, pal.layer[hov.c.layer], dark ? 0.55 : 0.22);
      } else glows.setAlpha(1, 0);
    };

    const updateLabelPositions = () => {
      for (const cs of cityStates) cs.label?.set({ position: cs.anchor.position });
      for (const hl of hubLabels) hl.label.set({ position: hl.tallest.anchor.position });
      // company names sit just right of their puck: offset = the puck's projected radius in px
      const k = ctx.size.height / 2 / Math.tan((ctx.camera.fov * DEG) / 2);
      for (const s of states) {
        if (!s.label) continue;
        const px = Math.round(Math.min(60, (radiusOf(s) * k) / Math.max(0.05, s.center.distanceTo(ctx.camera.position))));
        s.label.set({ position: s.center, offset: [s.sideNow === 'left' ? -px : px, 0] });
      }
    };

    /** Column and hub names near the left / right stage edge flip inward instead of being dropped. */
    const EDGE = 72;
    const sideAt = (pos: Vector3, base: Align): Align => {
      e3.copy(pos).project(ctx.camera);
      if (e3.z > 1) return base;
      const x = ((e3.x + 1) / 2) * ctx.size.width;
      return x > ctx.size.width - EDGE ? 'left' : x < EDGE ? 'right' : base;
    };
    const fitLabelSides = () => {
      for (const cs of cityStates) {
        if (!cs.label) continue;
        const a = sideAt(cs.anchor.position, cs.align);
        if (a !== cs.alignNow) cs.label.set({ align: (cs.alignNow = a) });
      }
      for (const hl of hubLabels) {
        const a = sideAt(hl.tallest.anchor.position, 'above');
        if (a !== hl.alignNow) hl.label.set({ align: (hl.alignNow = a) });
      }
      for (const s of nameShown) {
        const a = nameSide(s);
        if (a === s.sideNow) continue;
        s.label?.set({ align: (s.sideNow = a) });
        dirty = true; // the px offset follows the side (updateLabelPositions)
      }
    };
    /** Company names: the preferred side, unless the name would run off the stage there. */
    let nameShown: CState[] = [];
    const estW = (t: string) => {
      let w = 28;
      for (const ch of t) w += ch.charCodeAt(0) > 0x2e80 ? 12 : 7;
      return w;
    };
    const nameSide = (s: CState): 'left' | 'right' => {
      e3.copy(s.center).project(ctx.camera);
      if (e3.z > 1) return s.side;
      const x = ((e3.x + 1) / 2) * ctx.size.width;
      if (s.side === 'right' && x + s.textW > ctx.size.width - 4) return 'left';
      if (s.side === 'left' && x - s.textW < 4) return 'right';
      return s.side;
    };

    /* ───────── labels per step / filter ───────── */
    const labelBudget = () => (ctx.size.width < 560 ? 8 : ctx.size.width < 900 ? 12 : 16) + (spec.spot ? 4 : 0);
    const shownIn = (cs: CityState) => cs.city.members.reduce((a, c) => a + (states[c.i]!.visT > 0 ? 1 : 0), 0);
    const updateLabels = () => {
      const hov = hotspots.hovered ?? '';
      const merged = new Set<CityState>();
      for (const hl of hubLabels) {
        const n = hl.cols.reduce((a, cs) => a + shownIn(cs), 0);
        const lit = hl.hub.id === hov;
        const on = far && n > 0;
        if (on) for (const cs of hl.cols) merged.add(cs);
        hl.label.set({ text: `${hl.hub.name} ${n} 家`, visible: on, kind: lit ? 'strong' : 'default', priority: n + (lit ? 200 : 0) + (spec.spot === 'revenue' ? -20 : 0) + (hl.cols.some((cs) => spec.cities?.includes(cs.city.name)) ? 100 : 0) });
      }
      for (const cs of cityStates) {
        if (!cs.label) continue;
        const n = shownIn(cs);
        const lit = !!cs.city.hub && cs.city.hub.id === hov;
        cs.label.set({
          text: `${cityName(cs)} ${n} 家`,
          // from orbit with every layer shown, the 3–4 company towns would only crowd the coasts
          visible: n >= (far && filterNow === 'all' ? 5 : 1) && !merged.has(cs),
          kind: lit ? 'strong' : n >= 10 ? 'default' : 'muted',
          priority: n + (lit ? 200 : 0) + (spec.spot === 'revenue' ? -20 : 0) + (spec.cities?.includes(cs.city.name) ? 100 : 0),
        });
      }
      // company names
      const show = new Set<CState>();
      if (spec.spot === 'revenue') {
        // the largest company of each column, then the largest of those (one name per column, so
        // names in one tall column do not cover each other)
        const best = new Map<CityState, Company>();
        for (const c of byRevenue) if (states[c.i]!.visT > 0 && !best.has(states[c.i]!.city)) best.set(states[c.i]!.city, c);
        [...best.values()].slice(0, 10).forEach((c) => show.add(states[c.i]!));
      } else if (named(spec).length >= 2) {
        for (const c of named(spec)) if (states[c.i]!.visT > 0) show.add(states[c.i]!);
      } else if (spec.spot) {
        const hubs = new Set(spec.spot);
        for (const cs of cityStates) {
          if (!cs.city.hub || !hubs.has(cs.city.hub.id) || cs.city.members.length < 4) continue;
          const top = cs.city.members.filter((c) => states[c.i]!.visT > 0).sort((a, b) => sizeKey(b) - sizeKey(a))[0];
          if (top && states[top.i]!.label) show.add(states[top.i]!);
        }
      }
      if (hoverCompany?.label) show.add(hoverCompany);
      nameShown = [...show];
      const perColumn = new Map<CityState, number>();
      for (const s of [...show].sort((a, b) => sizeKey(b.c) - sizeKey(a.c))) {
        const n = perColumn.get(s.city) ?? 0;
        perColumn.set(s.city, n + 1);
        s.side = n % 2 ? 'left' : 'right';
      }
      for (const s of states) {
        if (!s.label) continue;
        const on = show.has(s);
        const rank = spec.spot === 'revenue' && s.c.rev ? 200 + 50 * Math.sqrt(s.c.rev / maxRev) : 12;
        const text = spec.spot === 'revenue' && s.c.rev ? `${s.c.label} ${fmtRevenue(s.c.rev)}` : s.c.label;
        s.textW = estW(text);
        if (on) s.sideNow = nameSide(s);
        s.label.set({
          visible: on,
          align: s.sideNow,
          text,
          kind: s === hoverCompany ? 'strong' : 'tag',
          priority: s === hoverCompany ? 500 : rank,
        });
      }
      labels.setMax(labelBudget());
    };

    const updateNote = () => {
      const vis = states.filter((s) => s.visT > 0);
      const nCities = cityStates.filter((cs) => cs.city.members.some((c) => states[c.i]!.visT > 0)).length;
      const parts: (string | { strong: string })[] = ['顯示 ', { strong: `${vis.length}` }, ` 家公司・${nCities} 座城市`];
      if (sizeMode === 'revenue') {
        const undisclosed = vis.filter((s) => s.c.rev == null).length;
        if (undisclosed) parts.push(`・${undisclosed} 家未公開營收`);
      }
      if (ctx.isFixture) parts.push('（示意資料）');
      overlay.setNote(parts);
    };

    const setFilter = (f: Filter) => {
      filterNow = f;
      overlay.setFilter(f);
      for (const s of states) s.visT = f === 'all' || s.c.layer === f ? 1 : 0;
      if (selected && selected.visT === 0) {
        selected = null;
        ctx.card.hide();
      }
      updateLabels();
      updateNote();
      dirty = true;
      ctx.invalidate();
    };
    const setSize = (m: SizeMode) => {
      sizeMode = hasRevenue ? m : 'tier';
      overlay.setSize(sizeMode);
      updateLabels();
      updateNote();
      dirty = true;
      ctx.invalidate();
    };

    /* ───────── camera ───────── */
    const portraitElev = () => (ctx.size.portrait ? 8 : 0);
    /** Whole-globe views step back a little more on portrait stages so both coasts stay in frame. */
    const globalK = () => (ctx.size.portrait ? 1.1 : 1);
    /**
     * Close-ups come nearer on portrait stages: the host scales every pose by |portrait| / |main|
     * to keep the horizontal extent, but a close-up's subject (two or three columns) is narrow.
     */
    const closeK = () => (ctx.size.portrait ? (HOME.dist / HOME.portrait) * 0.9 : 1);
    /** The densest group of companies (weighted) within `radiusDeg` of one of them. */
    const clusterCentre = (list: readonly Company[], radiusDeg: number): Vector3 | null => {
      if (!list.length) return null;
      const cos = Math.cos(radiusDeg * DEG);
      const ns = list.map((c) => latLonToVec3(c.lat, c.lon, 1));
      let best = -1;
      let centre: Vector3 | null = null;
      for (let i = 0; i < ns.length; i++) {
        const v = new Vector3();
        let w = 0;
        for (let j = 0; j < ns.length; j++)
          if (ns[i]!.dot(ns[j]!) > cos) {
            const k = 4 - list[j]!.tier;
            v.addScaledVector(ns[j]!, k);
            w += k;
          }
        if (w > best) {
          best = w;
          centre = v.normalize();
        }
      }
      return centre;
    };
    const hubPose = (h: Hub): CameraPose => {
      const top = Math.max(0, ...cityStates.filter((cs) => cs.city.hub === h).map((cs) => cs.city.members.length)) * PITCH * COL_MIN;
      return obliquePose(h.lat - 0.1, h.lon, h.dist * closeK(), 34 + portraitElev(), h.az, top * 0.45);
    };
    const viewPose = (v: View): CameraPose => {
      switch (v) {
        case 'home':
          return ctx.homePose;
        case 'north-tw':
          return obliquePose(25.2, 121.25, 0.3 * closeK(), 42 + portraitElev(), 6, 0.012);
        case 'bay':
          return obliquePose(37.95, -122.15, 0.42 * closeK(), 40 + portraitElev(), 0, 0.012);
        case 'east-asia':
          return centrePose(40, 150, 3.4 * globalK());
        case 'usa':
          return centrePose(50, -152, 3.6 * globalK());
        case 'pacific':
          return centrePose(54, -178, 3.7 * globalK());
      }
    };
    const layerPose = (l: LayerId): CameraPose => {
      const centre = clusterCentre(
        companies.filter((c) => c.layer === l),
        14,
      );
      if (!centre) return ctx.homePose;
      const { lat, lon } = vec3ToLatLon(centre);
      return obliquePose(lat - 2, lon, 1.7, 42 + portraitElev(), 0, 0.03);
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
      const a = v3.copy(cam).normalize().angleTo(to.clone().normalize());
      if (a > 1.4 && ctx.animate) {
        // Long hop: swing around the globe through a raised midpoint instead of cutting through it.
        const from = cam.clone().normalize();
        const axis = new Vector3().crossVectors(from, to.clone().normalize());
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        const mid = from.applyAxisAngle(axis.normalize(), a / 2).multiplyScalar(Math.max(cam.length(), to.length(), 3.2) * 1.05);
        const l1 = ctx.setPose({ position: mid, target: [0, 0, 0] }, { duration: 650, ease: (k) => k * k });
        legs.push(l1);
        void l1.done.then(() => {
          if (token !== flyToken) return;
          const l2 = ctx.setPose(pose, { duration: 750, ease: 'quadOut' });
          legs.push(l2);
          void l2.done.then(done);
        });
      } else {
        const l = ctx.setPose(pose, { duration: 900 });
        legs.push(l);
        void l.done.then(done);
      }
    };

    /* ───────── hotspots, cards, picking ───────── */
    let hoverCompany: CState | null = null;
    let selected: CState | null = null;
    const layerOfHotspot = new Map(LAYER_IDS.map((l) => [LAYER_INFO[l].hotspot, l] as const));
    const hubById = new Map(HUBS.map((h) => [h.id, h] as const));

    const companyCard = (s: CState): CardContent => {
      const c = s.c;
      const items: CardItem[] = [
        { label: '總部', meta: c.city || s.city.city.name || '—' },
        { label: '產業鏈', meta: `${LAYER_INFO[c.layer].title}${c.segment ? `・${SEG_SHORT[c.segment]}` : ''}` },
        { label: '公司層級', meta: TIER_LABEL[c.tier] },
        { label: '近一年營收', meta: c.rev ? `約 ${fmtRevenue(c.rev)}${sample}` : '未公開' },
      ];
      const card: CardContent = {
        title: c.label,
        swatch: ctx.palette.css[`layer-${c.layer}`] ?? '',
        items,
        href: c.href,
        linkLabel: '查看公司頁 →',
      };
      if (c.nameZh && c.nameZh !== c.name) card.subtitle = c.name;
      return card;
    };
    const topCompanies = (list: readonly Company[], n: number): CardItem[] =>
      [...list]
        .sort((a, b) => sizeKey(b) - sizeKey(a))
        .slice(0, n)
        .map((c) => ({ label: c.label, meta: c.segment ? SEG_SHORT[c.segment] : LAYER_INFO[c.layer].chip, href: c.href }));
    const layerCard = (l: LayerId): CardContent => {
      const info = LAYER_INFO[l];
      const list = companies.filter((c) => c.layer === l);
      return {
        title: `${info.title}（${list.length} 家）`,
        swatch: ctx.palette.css[`layer-${l}`] ?? '',
        body: metaText.get(info.hotspot)?.detail ?? '',
        items: info.segments.map((sg) => ({
          label: SEG_SHORT[sg],
          meta: `${list.filter((c) => c.segment === sg).length} 家`,
          href: `/chain/${sg}/`,
        })),
      };
    };
    const hubMembers = (h: Hub) => cityStates.filter((cs) => cs.city.hub === h).flatMap((cs) => cs.city.members);
    const hubCard = (h: Hub): CardContent => {
      const list = hubMembers(h);
      const mix = LAYER_IDS.map((l) => [l, list.filter((c) => c.layer === l).length] as const)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([l, n]) => `${LAYER_INFO[l].chip} ${n}`)
        .join('・');
      const card: CardContent = {
        title: `${h.name}（${list.length} 家）`,
        body: metaText.get(h.id)?.detail ?? '',
        items: topCompanies(list, 5),
      };
      if (mix) card.subtitle = mix;
      if (h.id === 'hub-hsinchu' || h.id === 'hub-taipei') {
        card.href = '/taiwan/';
        card.linkLabel = '看台灣 AI 供應鏈地圖 →';
      }
      return card;
    };

    const points: ScreenPoint[] = [];
    const pointState: CState[] = [];
    const rebuildPoints = () => {
      points.length = 0;
      pointState.length = 0;
      for (const cs of cityStates) {
        // top of the column first, so a column seen end-on picks its top puck
        for (let k = cs.city.members.length - 1; k >= 0; k--) {
          const s = states[cs.city.members[k]!.i]!;
          if (s.visT === 0 || s.vis < 0.5) continue;
          points.push({ position: s.center, id: LAYER_INFO[s.c.layer].hotspot });
          pointState.push(s);
        }
      }
      return points;
    };
    ctx.picker.addPoints(rebuildPoints, { cull: (w) => hiddenByGlobe(w, ctx.camera.position) });
    const stateOf = (hit: PickHit | null): CState | null =>
      hit && hit.index !== undefined && hit.object === ctx.camera && hit.id && layerOfHotspot.has(hit.id) ? (pointState[hit.index] ?? null) : null;

    /** Card / focus anchor: the live top of a column (updated by writeInstances). */
    const fallbackAnchor = new Object3D();
    fallbackAnchor.position.set(...ll(HOME.lat, HOME.lon, R));
    const anchorAt = (cs: CityState | undefined): Object3D => cs?.anchor ?? fallbackAnchor;
    const suppress = (src: string) => src === 'pointer';
    const registerHotspots = () => {
      for (const l of LAYER_IDS) {
        const best = [...cityStates].sort(
          (a, b) => b.city.members.filter((c) => c.layer === l).length - a.city.members.filter((c) => c.layer === l).length,
        )[0];
        hotspots.register(LAYER_INFO[l].hotspot, {
          anchor: anchorAt(best),
          pose: layerPose(l),
          card: (hit) => {
            const s = stateOf(hit);
            return s ? companyCard(s) : layerCard(l);
          },
          onSelect: (src) => suppress(src),
        });
      }
      for (const h of HUBS) {
        const tallest = cityStates.filter((cs) => cs.city.hub === h).sort((a, b) => b.city.members.length - a.city.members.length)[0];
        hotspots.register(h.id, { anchor: anchorAt(tallest), pose: hubPose(h), card: () => hubCard(h) });
      }
    };
    registerHotspots();
    let portrait = ctx.size.portrait;

    ctx.picker.onHover((hit) => {
      const s = stateOf(hit);
      if (s !== hoverCompany) {
        hoverCompany = s;
        ctx.invalidate();
      }
    });
    ctx.picker.onClick((hit, ev) => {
      const s = stateOf(hit);
      if (!s) {
        if (selected) {
          selected = null;
          dirty = true;
        }
        return;
      }
      if (ev.pointerType === 'mouse') {
        ctx.navigate(s.c.href, { newTab: ev.ctrlKey || ev.metaKey });
        return;
      }
      // touch / pen: the registry opened an interactive card with the link; keep the puck lit.
      selected = s;
      ctx.announce(`已選取：${s.c.label}，${s.city.city.name}，${LAYER_INFO[s.c.layer].title}，${TIER_LABEL[s.c.tier]}。`);
      dirty = true;
      ctx.invalidate();
    });

    /* ───────── spin & interaction state ───────── */
    let pointerInside = false;
    let pauseUntil = 0;
    let spinVel = 0;
    let lastNow = performance.now();
    let lastKey = '';
    ctx.canvas.addEventListener('pointerenter', () => (pointerInside = true), { signal: ctx.signal });
    ctx.canvas.addEventListener('pointerleave', () => (pointerInside = false), { signal: ctx.signal });
    const onControlsStart = () => (pauseUntil = performance.now() + 8000);
    ctx.controls?.addEventListener('start', onControlsStart);

    const applyEmphasis = () => {
      const hov = hotspots.hovered ?? '';
      const hovLayer = layerOfHotspot.get(hov);
      const hovHub = hubById.get(hov);
      const single = hoverCompany ?? selected;
      for (const s of states) {
        if (single) {
          s.hotT = s === single ? 1 : 0;
          s.dimT = 0;
        } else if (hovHub) {
          const inHub = s.city.city.hub === hovHub;
          s.hotT = inHub ? 0.4 : 0;
          s.dimT = inHub ? 0 : 0.6;
        } else if (hovLayer) {
          s.hotT = s.c.layer === hovLayer ? 0.35 : 0;
          s.dimT = s.c.layer === hovLayer ? 0 : 0.75;
        } else {
          s.hotT = 0;
          s.dimT = 0;
        }
      }
    };

    /* ───────── steps ───────── */
    const applyStep = (i: number, fly: boolean) => {
      spec = STEPS[i] ?? STEPS[0]!;
      setFilter(spec.filter);
      setSize(spec.size);
      if (fly) flyTo(viewPose(spec.view));
    };

    applyPalette(ctx.palette);
    applyStep(ctx.step, false);
    sizeK = (sizeMode as SizeMode) === 'revenue' ? 1 : 0;
    for (const s of states) s.vis = s.visT;
    writeInstances();
    updateLabels();

    return {
      update(dt) {
        const now = performance.now();
        const rdt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        const cam = ctx.camera;
        const target = ctx.controls?.target ?? v3.set(0, 0, 0);

        // Slow orbit in 總覽 (ambient motion: dt is 0 when motion is off).
        const want = !!spec.spin && ctx.animate && !pointerInside && !ctx.card.visible && !posing && now > pauseUntil && !hotspots.hovered;
        spinVel += ((want ? SPIN : 0) - spinVel) * Math.min(1, rdt * 1.6);
        if (spinVel > 1e-4 && dt > 0) {
          p3.copy(cam.position).sub(target).applyAxisAngle(UP, spinVel * dt);
          cam.position.copy(target).add(p3);
          cam.lookAt(target);
        }
        // Key light follows the viewer so the facing hemisphere is always lit.
        lights.group.rotation.y = Math.atan2(cam.position.x, cam.position.z);
        // Zoom limits: global views (target at the centre) keep their distance; close-ups (target
        // on the surface) may come near (OrbitControls' own minDistance is small, so a camera cut
        // to a close-up is never clamped). Never clamp while a camera move runs; never go underground.
        if (!posing && ctx.tween.active === 0 && target.length() < 0.3) {
          p3.subVectors(cam.position, target);
          if (p3.length() < GLOBAL_MIN) cam.position.copy(target).addScaledVector(p3.normalize(), GLOBAL_MIN);
        }
        if (cam.position.length() < R * 1.035) cam.position.setLength(R * 1.035);

        // Hover / list emphasis.
        if (selected && !ctx.card.visible) selected = null;
        const key = `${hotspots.hovered ?? ''}|${hoverCompany?.c.i ?? -1}|${selected?.c.i ?? -1}`;
        if (key !== lastKey) {
          lastKey = key;
          applyEmphasis();
          updateLabels();
          dirty = true;
        }
        const scale = scaleAt(cam.position.length() - R);
        if (Math.abs(scale - colScale) > 0.001) {
          colScale = scale;
          const z = (scale - COL_MIN) / (1 - COL_MIN);
          radScale = 0.62 + 0.38 * z;
          dotScale.value = 0.42 + 0.58 * Math.min(1, z * 1.4);
          if (dotMat) dotMat.opacity = 0.6 + 0.4 * Math.min(1, z * 1.6);
          dirty = true;
        }
        const isFar = cam.position.length() > 2.3;
        if (isFar !== far) {
          far = isFar;
          updateLabels();
        }

        // Ease per-company values and the size mode (snap when motion is off).
        const k = ctx.animate ? 1 - Math.exp(-rdt * 8) : 1;
        let moving = false;
        const sizeT = sizeMode === 'revenue' ? 1 : 0;
        if (sizeK !== sizeT) {
          const d = sizeT - sizeK;
          sizeK = Math.abs(d) < 0.002 ? sizeT : sizeK + d * k;
          moving ||= sizeK !== sizeT;
          dirty = true;
        }
        for (const s of states) {
          if (s.vis !== s.visT) {
            const d = s.visT - s.vis;
            s.vis = Math.abs(d) < 0.003 ? s.visT : s.vis + d * k;
            moving ||= s.vis !== s.visT;
            dirty = true;
          }
          if (s.hot !== s.hotT) {
            const d = s.hotT - s.hot;
            s.hot = Math.abs(d) < 0.003 ? s.hotT : s.hot + d * Math.max(k, 0.35);
            moving ||= s.hot !== s.hotT;
            dirty = true;
          }
          if (s.dim !== s.dimT) {
            const d = s.dimT - s.dim;
            s.dim = Math.abs(d) < 0.003 ? s.dimT : s.dim + d * Math.max(k, 0.35);
            moving ||= s.dim !== s.dimT;
            dirty = true;
          }
        }
        if (dirty) {
          dirty = false;
          writeInstances();
        }
        fitLabelSides();
        return moving;
      },
      setStep(i) {
        applyStep(i, true);
      },
      onMotion() {
        dirty = true;
        ctx.invalidate();
      },
      onPalette(p) {
        applyPalette(p);
      },
      onResize(size) {
        labels.setMax(labelBudget());
        measureChips();
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          registerHotspots();
        }
      },
      dispose() {
        flyToken++;
        legs.forEach((t) => t.cancel());
        ctx.controls?.removeEventListener('start', onControlsStart);
        overlay.destroy();
        root.removeFromParent();
      },
    };
  },
});

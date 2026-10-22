/**
 * memory-fab-map — 全球記憶體產能地圖 (variant: globe).
 *
 * A dotted globe (kit Globe) with every memory fab / HBM packaging plant from the page data as a
 * column rising from its site:
 *  - height ∝ √(monthly capacity, 千片/月) — a short stub when the data has no number;
 *  - colour = product family (DRAM / HBM 與 HBM 封裝 / NAND / HDD、SSD 與其他, theme tokens);
 *    a product filter shows every fab that makes the family and tints it in that family's colour;
 *  - status by form as well as colour: operating = solid; expanding = solid + a translucent
 *    extension (height from addKwpm) with a rim; construction / planned = a hatched, hollow ghost;
 *    delayed = ghost + a dashed warning ring at the foot.
 * Crowded clusters (首爾以南, 平澤 P1–P5, 台北、台中) are spread into a small fan that depends on the
 * zoom (layout.ts); a thin leader line joins a moved column to its true position. Columns, plinths
 * and the semantic zoom (column size follows camera altitude) are instanced, so the scene stays at
 * about fifteen draw calls. HTML chips (overlay.ts) filter by product and status (columns grow /
 * shrink in and out); a legend explains the forms; a bar panel sums the data per step. Hover a
 * column for its card (company, site, products, status, capacity with 估計, expansion, capex,
 * timeline); click opens the company page (touch: an interactive card with the link).
 *
 * Steps: 總覽 (slow spin, stops on interaction) → 韓國重鎮 (zoom to Korea) → HBM 擴產 (growth
 * filter: East Asia, then a slow glide to the United States) → NAND 版圖 (NAND filter) → 中國自主
 * (China, 自主 bright vs 外資 dimmed).
 * Reduced motion: no spin, camera cuts, filters snap.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
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
  type CardItem,
  type LabelHandle,
  type Palette,
  type PickHit,
  type SceneContext,
  type ScreenPoint,
  type Tween,
} from '../../core/types';
import { Globe, latLonToVec3, vec3ToLatLon } from '../../kit/Globe';
import { GlowSprites } from '../../kit/GlowSprites';
import {
  CAP_STATUS,
  FAMILY_INFO,
  FAMILY_ORDER,
  PRODUCT_LABEL,
  REF_CITIES,
  STATUS_INFO,
  countryName,
  fmtK,
  fmtNum,
  isMemoryFabData,
  normalise,
  type Fab,
  type Family,
  type MemoryFabData,
  type StatusFilter,
} from './data';
import { createSpread } from './layout';
import { createOverlay, type BarPanel, type ProductFilter } from './overlay';

/* ───────────────────────── constants ───────────────────────── */

const R = 1;
const DEG = Math.PI / 180;
/** Column radius and tallest column height seen from orbit (zoom s = 1). */
const R0 = 0.0088;
const H0 = 0.2;
/** Unknown capacity: a stub, as a share of the tallest column. */
const STUB = 0.2;
/** Camera altitude at which the zoom factor reaches 1, and its floor. */
const ALT_FAR = 1.75;
const S_MIN = 0.03;
const zoomAt = (alt: number) => Math.min(1, Math.max(S_MIN, alt / ALT_FAR));
const radAt = (s: number) => R0 * s ** 0.5;
const hAt = (s: number) => H0 * s ** 0.8;
/** Minimum separation between column centres (radians): tight from orbit, roomy for labels up close. */
const SEP_MIN = 0.019;
const sepAt = (s: number) => Math.max(2.7 * radAt(s), SEP_MIN);
const LEVELS = [1, 0.8, 0.64, 0.1];
/** Region labels from orbit, one name per column up close. */
const FAR = 0.56;
/** Reference cities show below this zoom, and win label collisions below REF_NEAR. */
const REF_ON = 0.45;
const REF_NEAR = 0.2;
/** Label zones: crossing one re-runs the label selection. */
const zoneOf = (z: number) => (z >= FAR ? 3 : z >= REF_ON ? 2 : z >= REF_NEAR ? 1 : 0);
const SPIN = 0.045; // rad/s camera orbit in 總覽

type Tuple = [number, number, number];
type Align = 'above' | 'right' | 'left' | 'below';
const ALIGNS: readonly Align[] = ['above', 'right', 'left', 'below'];
const UP = new Vector3(0, 1, 0);
const ll = (lat: number, lon: number, r: number): Tuple => latLonToVec3(lat, lon, r).toArray() as Tuple;
const centrePose = (lat: number, lon: number, dist: number, target: Tuple = [0, 0, 0]): CameraPose => ({ position: ll(lat, lon, dist), target });
/**
 * Oblique regional view: the target sits `lift` above the surface at (lat, lon); the camera looks at
 * it from the south (`az`° toward the east), `elev`° above the local horizon, so radial columns stand
 * up on screen (same maths as company-globe → globe-oblique-pose).
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
 * 總覽 (also the East Asia frame of HBM 擴產 and NAND 版圖, so those steps compare like small
 * multiples): from low over the South China Sea, aimed above the globe centre, so the memory belt
 * (Korea, Japan, Taiwan, eastern China, ≈ 25–40°N) runs across the upper middle with its columns
 * standing up, and Singapore (≈ 1°N) stands whole near the bottom, between the legend and the panel.
 * The slow orbit then carries the view westward and round to the United States.
 */
const HOME = { lat: 4, lon: 112, dist: 2.75, portrait: 3.0 };
const HOME_TARGET: Tuple = [0, 0.48, 0];
const HOME_TARGET_PORTRAIT: Tuple = [0, 0.48, 0];

/** Regional views (geography: where each country's memory sites are). */
interface RegionView {
  lat: number;
  lon: number;
  dist: number;
  elev: number;
  /**
   * Look from this many degrees east of south (0 = from due south). Korea uses a slight 3/4 view:
   * the crowded fan then spreads across the frame so every site keeps its name.
   */
  az?: number;
  /** Aim this far above the surface (keeps tall close-up columns in frame). */
  lift?: number;
  /**
   * Distance factor on portrait stages, before the host's own portrait scaling. Wide subjects (the
   * United States spans ≈ 40° of longitude) need more than compact clusters.
   */
  pk?: number;
  hotspot?: string;
}
const REGION_VIEW: Record<string, RegionView> = {
  KR: { lat: 36.7, lon: 127.25, dist: 0.17, elev: 58, az: 15, lift: 0.01, hotspot: 'region-korea' },
  TW: { lat: 23.75, lon: 120.9, dist: 0.3, elev: 60, lift: 0.006, hotspot: 'region-taiwan' },
  JP: { lat: 35.6, lon: 136.6, dist: 0.8, elev: 50, hotspot: 'region-japan' },
  CN: { lat: 33.2, lon: 114.6, dist: 1.0, elev: 54, hotspot: 'region-china' },
  US: { lat: 41.5, lon: -96.5, dist: 0.64, elev: 52, pk: 1.45, hotspot: 'region-us' },
  SG: { lat: 1.25, lon: 103.8, dist: 0.16, elev: 52 },
};

type View = 'home' | 'korea' | 'growth-asia' | 'us' | 'eastasia' | 'china';
type PanelKind = 'country' | 'korea' | 'growth' | 'nand' | 'china';
interface StepSpec {
  view: View;
  product: ProductFilter;
  status: StatusFilter;
  spin?: boolean;
  /** Which fab names to show from orbit (up close every visible column is named). */
  names?: (f: Fab) => boolean;
  /** Emphasis (1 = full colour, lower = dimmed). */
  focus?: (f: Fab) => number;
  /** Halo beacons on these fabs (the step's subject, visible even when a column is a stub). */
  beacon?: (f: Fab) => boolean;
  /**
   * A second view the camera glides to after a pause (ambient motion only; the reader's first
   * interaction cancels it). Under reduced motion the step keeps its first view.
   */
  then?: View;
  panel: PanelKind;
}
const STEPS: readonly StepSpec[] = [
  { view: 'home', product: 'all', status: 'all', spin: true, panel: 'country' },
  { view: 'korea', product: 'all', status: 'all', focus: (f) => (f.country === 'KR' ? 1 : 0.3), panel: 'korea' },
  {
    view: 'growth-asia',
    then: 'us',
    product: 'all',
    status: 'growth',
    names: (f) => STATUS_INFO[f.status].growth,
    beacon: (f) => STATUS_INFO[f.status].growth,
    panel: 'growth',
  },
  { view: 'eastasia', product: 'nand', status: 'all', names: (f) => f.families.has('nand'), panel: 'nand' },
  {
    view: 'china',
    product: 'all',
    status: 'all',
    names: (f) => f.country === 'CN',
    focus: (f) => (f.country === 'CN' ? (f.domestic ? 1 : 0.32) : 0.15),
    beacon: (f) => f.country === 'CN' && f.domestic,
    panel: 'china',
  },
];

/* ───────────────────────── helpers ───────────────────────── */

/** True when the globe hides a world point (segment camera → point enters the sphere first). */
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

/** Fixed local frame (+Y = normal, +X = east), written into `out` (no allocation). */
const fx = new Vector3();
const fz = new Vector3();
const fm = new Matrix4();
function frameInto(n: Vector3, out: Quaternion): Quaternion {
  fx.crossVectors(UP, n);
  if (fx.lengthSq() < 1e-8) fx.set(1, 0, 0);
  fx.normalize();
  fz.crossVectors(fx, n).normalize();
  return out.setFromRotationMatrix(fm.makeBasis(fx, n, fz));
}

function graticule(r: number, step: number, latMax: number, seg: number): BufferGeometry {
  const pos: number[] = [];
  for (let lat = -latMax; lat <= latMax + 1e-6; lat += step)
    for (let lon = -180; lon < 180; lon += seg) pos.push(...ll(lat, lon, r), ...ll(lat, lon + seg, r));
  for (let lon = -180; lon < 180; lon += step)
    for (let lat = -latMax - step * 0.5; lat < latMax + step * 0.5; lat += seg) pos.push(...ll(lat, lon, r), ...ll(lat + seg, lon, r));
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

/** A dashed ring in the XY plane (warning ring for delayed projects; laid flat by flatGeometry). */
function dashedRing(inner: number, outer: number, dashes: number, fill: number): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = 4;
  for (let d = 0; d < dashes; d++) {
    const a0 = (d / dashes) * Math.PI * 2;
    const a1 = a0 + (fill / dashes) * Math.PI * 2;
    const base = pos.length / 3;
    for (let k = 0; k <= steps; k++) {
      const a = a0 + ((a1 - a0) * k) / steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // built in XY like three's RingGeometry; flatGeometry() lays it into XZ
      pos.push(c * inner, s * inner, 0, c * outer, s * outer, 0);
    }
    for (let k = 0; k < steps; k++) {
      const i = base + k * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function columnGeometry(open: boolean, seg: number): CylinderGeometry {
  const g = new CylinderGeometry(1, 1, 1, seg, 1, open);
  g.translate(0, 0.5, 0);
  return g;
}
function flatGeometry<G extends BufferGeometry>(g: G, n: number): G {
  g.rotateX(-Math.PI / 2);
  g.setAttribute('aAlpha', new InstancedBufferAttribute(new Float32Array(Math.max(1, n)).fill(1), 1));
  return g;
}

/** Per-instance alpha (`aAlpha`) for basic materials. */
function withInstanceAlpha<M extends MeshBasicMaterial>(m: M, key: string): M {
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

/**
 * Hatched ghost (proposals/scene-memory-fab-map.yaml → hatched-ghost-material): screen-space
 * diagonal stripes modulate the alpha, so an unbuilt fab reads as "under construction" by its
 * texture, not only its colour; per-instance alpha (`aAlpha`) separates planned from construction.
 */
function hatched(
  m: MeshStandardMaterial,
  u: { uHatch: { value: number }; uLo: { value: number }; uDash: { value: number }; uBoost: { value: number } },
): MeshStandardMaterial {
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    // Dashes along the column in world units (uDash = dash pitch), so tall and short ghosts share
    // one rhythm; screen-space diagonal hatching inside each dash.
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nuniform float uDash;\nvarying float vAlpha;\nvarying float vDash;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAlpha = aAlpha;\n#ifdef USE_INSTANCING\nvDash = position.y * length(instanceMatrix[1].xyz) / uDash;\n#else\nvDash = position.y;\n#endif',
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uHatch;\nuniform float uLo;\nuniform float uBoost;\nvarying float vAlpha;\nvarying float vDash;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nif (fract(vDash) > 0.64) discard;\nfloat hatchK = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / uHatch));\ndiffuseColor.a *= vAlpha * mix(uLo, 1.0, hatchK);',
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * uBoost;\n#endif');
  };
  m.customProgramCacheKey = () => 'mf-ghost';
  return m;
}

/** Calmer ocean than the kit default (same workaround as cloud-globe → globe-ocean-tint). */
function oceanTint(p: Palette): Color {
  return p.theme === 'dark' ? p.bg.clone().lerp(p.coolant, 0.055) : p.bg.clone().lerp(p.grid, 0.42).lerp(p.coolant, 0.035);
}

/* ───────────────────────── scratch ───────────────────────── */

const m4 = new Matrix4();
const ZERO = new Matrix4().makeScale(0, 0, 0);
const p3 = new Vector3();
const s3 = new Vector3();
const v3 = new Vector3();
const e3 = new Vector3();
const c3 = new Color();
const c4 = new Color();

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<MemoryFabData>({
  json,
  meta: {
    camera: {
      ...centrePose(HOME.lat, HOME.lon, HOME.dist, HOME_TARGET),
      fov: 34,
      near: 0.01,
      far: 60,
      minDistance: 0.06,
      maxDistance: 7,
      minPolar: 0.18,
      maxPolar: Math.PI - 0.18,
      portrait: { ...centrePose(HOME.lat, HOME.lon, HOME.portrait, HOME_TARGET_PORTRAIT), fov: 40 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 30, tris: 130_000 },
  },
  guard: isMemoryFabData,
  fixture: () => import('../../fixtures/memory-fab-map.json'),

  async create(ctx: SceneContext<MemoryFabData>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'memory-fab-map';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const fabs = normalise(ctx.data);
    const N = fabs.length;
    const metaText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const sample = ctx.isFixture ? '（示意）' : '';

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
    // Kit tuning without editing the kit (as in company-globe): calmer ocean, softer rim, the unused
    // marker mesh hidden, and land dots that shrink in close-ups so they stay a fine dot matrix.
    const dotScale = { value: 1 };
    let landMat: MeshBasicMaterial | null = null;
    for (const o of globe.group.children) {
      if (o instanceof InstancedMesh && o.geometry instanceof CylinderGeometry) o.visible = false;
      if (o instanceof InstancedMesh && o.geometry instanceof CircleGeometry && o.material instanceof MeshBasicMaterial) {
        const m = (landMat = o.material);
        m.transparent = true;
        m.onBeforeCompile = (s) => {
          s.uniforms['uDotScale'] = dotScale;
          s.vertexShader = s.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uDotScale;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy *= uDotScale;');
        };
        m.customProgramCacheKey = () => 'mf-land';
        m.needsUpdate = true;
      }
      if (!(o instanceof Mesh) || !(o.geometry instanceof SphereGeometry)) continue;
      if (o.material instanceof MeshBasicMaterial) materials.bind(o.material, 'color', oceanTint);
      else if (o.material instanceof ShaderMaterial && o.material.uniforms['uStrength']) o.material.uniforms['uStrength'].value = 0.42;
    }
    const gratMat = materials.line('grid', { transparent: true, opacity: 0.4, depthWrite: false });
    const grat = new LineSegments(ctx.track(graticule(R * 1.0015, 30, 60, 3)), gratMat);
    grat.matrixAutoUpdate = false;
    root.add(grat);
    // A finer 2° graticule fades in up close, so a regional view still reads as a map.
    const fineMat = materials.line('muted', { transparent: true, opacity: 0, depthWrite: false });
    const fine = new LineSegments(ctx.track(graticule(R * 1.0008, 2, 70, 1)), fineMat);
    fine.matrixAutoUpdate = false;
    fine.visible = false;
    root.add(fine);

    /* ───────── columns ───────── */
    const boost = { value: 0.3 };
    const solidMat = ctx.track(withBoost(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.08 }), boost, 'mf-solid'));
    const extMat = ctx.track(
      withBoost(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.4, depthWrite: false }), boost, 'mf-ext'),
    );
    const hatchU = { uHatch: { value: 7 * ctx.renderer.getPixelRatio() }, uLo: { value: 0.45 }, uDash: { value: H0 * 0.08 }, uBoost: boost };
    const ghostMat = ctx.track(
      hatched(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.02, transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide }), hatchU),
    );
    const segs = ctx.quality === 'low' ? 12 : 20;
    const M = Math.max(1, N);
    const solid = new InstancedMesh(ctx.track(columnGeometry(false, segs)), solidMat, M);
    const ext = new InstancedMesh(ctx.track(columnGeometry(true, segs)), extMat, M);
    const ghostGeo = ctx.track(columnGeometry(true, segs));
    ghostGeo.setAttribute('aAlpha', new InstancedBufferAttribute(new Float32Array(M).fill(1), 1));
    const ghost = new InstancedMesh(ghostGeo, ghostMat, M);
    ext.renderOrder = 3;
    ghost.renderOrder = 3;

    const basicT = (key: string, side = false) =>
      ctx.track(withInstanceAlpha(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, ...(side ? { side: DoubleSide } : {}) }), key));
    // rims: the top edge of every extension / ghost (one instance each)
    const rims = new InstancedMesh(ctx.track(flatGeometry(new RingGeometry(0.8, 1, 32), M)), basicT('mf-rim', true), M);
    // plinths (0..N-1) and true-position pins (N..2N-1)
    const discs = new InstancedMesh(ctx.track(flatGeometry(new CircleGeometry(1, 24), 2 * M)), basicT('mf-disc'), 2 * M);
    const delayedIdx = fabs.filter((f) => f.status === 'delayed').map((f) => f.index);
    const W = Math.max(1, delayedIdx.length);
    const warns = new InstancedMesh(ctx.track(flatGeometry(dashedRing(1.45, 1.85, 12, 0.58), W)), basicT('mf-warn', true), W);
    rims.renderOrder = 4;
    discs.renderOrder = 2;
    warns.renderOrder = 2;
    const instanced = [solid, ext, ghost, rims, discs, warns];
    for (const m of instanced) {
      m.count = m === discs ? 2 * N : m === warns ? delayedIdx.length : N;
      for (let i = 0; i < m.instanceMatrix.count; i++) {
        m.setMatrixAt(i, ZERO);
        m.setColorAt(i, c3.setRGB(1, 1, 1));
      }
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      root.add(m);
      ctx.track({ dispose: () => m.dispose() });
    }

    // leader lines: true position → displayed foot
    const leadArr = new Float32Array(Math.max(1, N) * 6);
    const leadGeo = ctx.track(new BufferGeometry());
    // BufferAttribute (not Float32BufferAttribute, which copies) so applyZoom writes go straight in.
    leadGeo.setAttribute('position', new BufferAttribute(leadArr, 3).setUsage(DynamicDrawUsage));
    const leadMat = materials.line('fg', { transparent: true, opacity: 0.45, depthWrite: false });
    const leaders = new LineSegments(leadGeo, leadMat);
    leaders.frustumCulled = false;
    leaders.renderOrder = 2;
    root.add(leaders);

    // hover ring + glows (column tops, and a soft halo behind the globe at index N)
    const hoverGeo = ctx.track(new RingGeometry(0.74, 1, 40));
    hoverGeo.rotateX(-Math.PI / 2);
    const hoverMat = materials.basic('fg', { transparent: true, opacity: 0.85, depthWrite: false, side: DoubleSide });
    const hoverRing = new Mesh(hoverGeo, hoverMat);
    hoverRing.renderOrder = 5;
    hoverRing.visible = false;
    root.add(hoverRing);
    const glows = ctx.track(new GlowSprites({ count: N + 1, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── per-fab state ───────── */
    const maxTotal = Math.max(1, ...fabs.map((f) => (f.cap ?? 0) + (f.add ?? 0)));
    const frac = (v: number) => Math.sqrt(Math.max(0, v) / maxTotal);
    type Form = 'operating' | 'expanding' | 'ghost';
    interface FState {
      f: Fab;
      base: Vector3;
      n: Vector3;
      q: Quaternion;
      form: Form;
      /** Heights as a share of the tallest column (H). */
      hs: number;
      hg: number;
      vis: number;
      visT: number;
      solid: number;
      solidT: number;
      grow: number;
      growT: number;
      sdim: number;
      sdimT: number;
      focus: number;
      focusT: number;
      hot: number;
      hotT: number;
      fam: Family;
      top: Vector3;
      foot: Vector3;
      pts: ScreenPoint[];
      tag: Tag;
    }
    interface Tag {
      label: LabelHandle;
      top: Vector3;
      text: string;
      prio: number;
      on: boolean;
      align: Align;
      kind: 'default' | 'strong' | 'muted' | 'tag';
      swatch: boolean;
      /** No side of the anchor is clear of the HTML overlay (label hidden by the layout pass). */
      blocked?: boolean;
    }
    const states: FState[] = fabs.map((f) => {
      const st = STATUS_INFO[f.status];
      const form: Form = f.status === 'operating' ? 'operating' : f.status === 'expanding' ? 'expanding' : 'ghost';
      let hs = 0;
      let hg = 0;
      if (st.existing) hs = f.cap ? frac(f.cap) : STUB;
      if (form === 'expanding') hg = f.cap && f.add ? frac(f.cap + f.add) - hs : f.add ? frac(f.add) : STUB * 0.55;
      if (form === 'ghost') hg = f.add ? frac(f.add) : STUB * 1.5;
      const base = latLonToVec3(f.lat, f.lon, 1);
      const top = new Vector3();
      const label = labels.add({ text: f.short, align: 'above', priority: 10, visible: false });
      return {
        f,
        base,
        n: base.clone(),
        q: new Quaternion(),
        form,
        hs,
        hg: Math.max(form === 'operating' ? 0 : 0.035, hg),
        vis: 1,
        visT: 1,
        solid: 1,
        solidT: 1,
        grow: 1,
        growT: 1,
        sdim: 0,
        sdimT: 0,
        focus: 1,
        focusT: 1,
        hot: 0,
        hotT: 0,
        fam: f.primary,
        top,
        foot: new Vector3(),
        pts: [0, 1, 2].map(() => ({ position: new Vector3(), id: FAMILY_INFO[f.primary].hotspot })),
        tag: { label, top, text: f.short, prio: 10, on: false, align: 'above', kind: 'default', swatch: true },
      };
    });
    // Two fabs with the same map name (美光 and 華邦電 both run a 「台中廠」): prefix the company.
    for (const s of states) {
      if (states.some((o) => o !== s && o.f.short === s.f.short)) {
        s.tag.text = `${s.f.companyName}・${s.f.short}`;
        s.tag.label.set({ text: s.tag.text });
      }
    }
    // Columns of one campus (same company, same city) stay together as a tight group.
    const campusKey = states.map((s) => `${s.f.company}|${s.f.city}`);
    const spread = createSpread(
      states.map((s) => s.base),
      LEVELS,
      sepAt,
      (i, j, s, sep) => (campusKey[i] === campusKey[j] ? Math.min(sep, Math.max(2.5 * radAt(s), sep * 0.42)) : sep),
    );
    const normals = states.map((s) => s.n);

    /* ───────── regions (countries) ───────── */
    interface Region {
      code: string;
      name: string;
      members: FState[];
      centre: Vector3;
      anchor: Object3D;
      tag: Tag;
    }
    const regions: Region[] = [];
    for (const s of states) {
      let r = regions.find((x) => x.code === s.f.country);
      if (!r) {
        const anchor = new Object3D();
        root.add(anchor);
        const top = anchor.position;
        const label = labels.add({ text: countryName(s.f.country), object: anchor, position: [0, 0, 0], align: 'above', kind: 'strong', priority: 20, visible: false });
        r = { code: s.f.country, name: countryName(s.f.country), members: [], centre: new Vector3(), anchor, tag: { label, top, text: '', prio: 20, on: false, align: 'above', kind: 'strong', swatch: false } };
        regions.push(r);
      }
      r.members.push(s);
      r.centre.add(s.base);
    }
    // A country's title sits over the middle of its sites' extent (not their mean, which a campus of
    // five pulls toward itself): 「美國 4 座」 between 波夕 and 克萊, clear of both names.
    for (const r of regions) {
      const mid = vec3ToLatLon(r.centre.normalize());
      let la0 = 90;
      let la1 = -90;
      let lo0 = 180;
      let lo1 = -180;
      for (const s of r.members) {
        const dl = ((((s.f.lon - mid.lon) % 360) + 540) % 360) - 180;
        la0 = Math.min(la0, s.f.lat);
        la1 = Math.max(la1, s.f.lat);
        lo0 = Math.min(lo0, dl);
        lo1 = Math.max(lo1, dl);
      }
      latLonToVec3((la0 + la1) / 2, mid.lon + (lo0 + lo1) / 2, 1, r.centre);
    }
    /**
     * Campuses: three or more fabs of one company in one city (平澤 P1–P5) share one name label up
     * close, above their tallest column, so a crowded campus stays legible; hovering a column still
     * names it. Two side-by-side fabs with code names (利川 M14／M16, 清州 M15／M15X, 波夕 ID1／ID2)
     * share one label too (「利川 M14・M16」): their own labels would collide and one would vanish.
     */
    interface Campus {
      members: FState[];
      /** A code-named pair: the label lists both names. */
      pair: boolean;
      anchor: Vector3;
      tag: Tag;
    }
    const campuses: Campus[] = [];
    {
      const byKey = new Map<string, FState[]>();
      for (const s of states) {
        const k = `${s.f.company}|${s.f.city}`;
        byKey.set(k, [...(byKey.get(k) ?? []), s]);
      }
      for (const members of byKey.values()) {
        if (!members[0]!.f.city) continue;
        const pair = members.length === 2 && members.every((s) => s.f.short !== s.f.name);
        if (members.length < 3 && !pair) continue;
        if (pair) members.sort((a, b) => a.f.name.localeCompare(b.f.name));
        const anchor = new Vector3();
        const label = labels.add({ text: members[0]!.f.city, position: anchor, align: 'above', priority: 40, visible: false });
        campuses.push({ members, pair, anchor, tag: { label, top: anchor, text: '', prio: 40, on: false, align: 'above', kind: 'default', swatch: true } });
      }
    }
    const campusOf = new Map<FState, Campus>();
    for (const c of campuses) for (const s of c.members) campusOf.set(s, c);
    const refTags: Tag[] = REF_CITIES.map((c) => {
      const top = new Vector3(...ll(c.lat, c.lon, R * 1.002));
      const label = labels.add({ text: c.name, position: top, kind: 'muted', align: 'below', priority: 4, visible: false });
      return { label, top, text: c.name, prio: 4, on: false, align: 'below', kind: 'muted', swatch: false };
    });

    /* ───────── overlay ───────── */
    let product: ProductFilter = 'all';
    let status: StatusFilter = 'all';
    let spec: StepSpec = STEPS[0]!;
    const overlay = createOverlay(
      ctx.stage,
      {
        product: (f) => {
          setFilters(f, status, true);
          ctx.announce(`產品篩選：${f === 'all' ? '全部產品' : FAMILY_INFO[f].label}，顯示 ${visibleCount()} 座廠區`);
        },
        status: (f) => {
          setFilters(product, f, true);
          ctx.announce(`狀態篩選：${f === 'all' ? '全部狀態' : f === 'existing' ? '現有產能' : '擴產與新建'}，顯示 ${visibleCount()} 座廠區`);
        },
        // The 產能加總 toggle (compact mode) opened or closed the panel: lay the labels out again.
        layout: () => {
          layoutAt = 0;
          layoutPending = true;
          ctx.invalidate();
        },
      },
      ctx.signal,
      ctx.isFixture,
    );
    const productCounts = { all: N } as Record<ProductFilter, number>;
    for (const fam of FAMILY_ORDER) productCounts[fam] = fabs.filter((f) => f.families.has(fam)).length;
    overlay.setCounts(productCounts, {
      all: N,
      existing: fabs.filter((f) => STATUS_INFO[f.status].existing).length,
      growth: fabs.filter((f) => STATUS_INFO[f.status].growth).length,
    });
    let uiRects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const measureUi = () => {
      if (ctx.signal.aborted) return;
      uiRects = overlay.rects();
    };
    /** Short stages (a phone at the default 4:3 height) get the compact overlay. */
    const COMPACT_H = 330;
    overlay.setCompact(ctx.size.height < COMPACT_H);
    requestAnimationFrame(measureUi);

    /* ───────── palette ───────── */
    const pal = {
      fam: { dram: new Color(), hbm: new Color(), nand: new Color(), other: new Color() } as Record<Family, Color>,
      dim: new Color(),
      fg: new Color(),
      warn: new Color(),
      plinth: new Color(),
    };
    const famCss = (f: Family) => ctx.palette.css[FAMILY_INFO[f].token] ?? '';
    let dark = ctx.theme === 'dark';
    let dirty = true;
    const applyPalette = (p: Palette) => {
      dark = p.theme === 'dark';
      lights.apply(p);
      pal.fam.dram.copy(p.chart[0] ?? p.flow);
      pal.fam.hbm.copy(p.seg['memory-storage']);
      pal.fam.nand.copy(p.chart[2] ?? p.pos);
      pal.fam.other.copy(p.chart[3] ?? p.power);
      // Dimmed columns recede toward the ground colour (darker in the dark theme, where the emissive
      // boost would otherwise keep a muted column bright).
      pal.dim.copy(p.muted).lerp(p.bg, dark ? 0.62 : 0.3);
      pal.fg.copy(p.fg);
      pal.warn.copy(p.neg);
      pal.plinth.copy(p.fg).lerp(p.bg, dark ? 0.6 : 0.5);
      boost.value = dark ? 0.32 : 0.06;
      extMat.opacity = dark ? 0.36 : 0.42;
      hatchU.uLo.value = dark ? 0.55 : 0.62;
      gratMat.opacity = dark ? 0.32 : 0.5;
      for (const m of [rims.material, discs.material, warns.material] as MeshBasicMaterial[]) {
        m.blending = dark ? AdditiveBlending : NormalBlending;
        m.needsUpdate = true;
      }
      // Discs stay normal-blended (plinths are surfaces, not light).
      (discs.material as MeshBasicMaterial).blending = NormalBlending;
      hoverMat.blending = dark ? AdditiveBlending : NormalBlending;
      hoverMat.needsUpdate = true;
      globe.setPalette(p);
      glows.setTheme(p.theme);
      glows.set(N, [0, 0, 0], R * 2.5, dark ? c3.copy(p.flow).lerp(p.bg, 0.4) : c3.copy(p.fg), dark ? 0.1 : 0.05);
      for (const s of states) s.tag.label.set({ swatch: famCss(s.fam) });
      dirty = true;
    };

    /* ───────── zoom & layout ───────── */
    let zs = -1; // current zoom factor (s), -1 = not yet computed
    let rad = R0;
    let H = H0;
    const applyZoom = (s: number) => {
      zs = s;
      rad = radAt(s);
      H = hAt(s);
      hatchU.uDash.value = H * 0.11;
      spread.at(s, normals);
      for (const st of states) frameInto(st.n, st.q);
      // leader lines (only when the column moved more than about a column width)
      let k = 0;
      for (const st of states) {
        const moved = st.base.angleTo(st.n) > rad * 1.6;
        p3.copy(st.base).multiplyScalar(R * 1.0009);
        p3.toArray(leadArr, k);
        if (moved) p3.copy(st.n).multiplyScalar(R * 1.0009);
        p3.toArray(leadArr, k + 3);
        k += 6;
      }
      leadGeo.getAttribute('position').needsUpdate = true;
      leadGeo.computeBoundingSphere();
      const near = 1 - Math.min(1, Math.max(0, (s - 0.18) / (0.5 - 0.18)));
      fineMat.opacity = near * (dark ? 0.2 : 0.24);
      fine.visible = fineMat.opacity > 0.01;
      const zk = Math.min(1, Math.max(0, (s - 0.1) / 0.55));
      dotScale.value = 0.26 + 0.74 * zk;
      if (landMat) landMat.opacity = 0.55 + 0.45 * zk;
      leadMat.opacity = (dark ? 0.5 : 0.55) * (0.35 + 0.65 * near);
      dirty = true;
    };

    /** Fabs wearing a halo beacon in the current step. */
    const beaconOn: boolean[] = new Array<boolean>(N).fill(false);
    const glowBase = new Float32Array(Math.max(1, N));

    /* ───────── per-frame instance writer ───────── */
    const famColor = (s: FState) => pal.fam[s.fam];
    const discAlpha = (dark: boolean) => (dark ? 0.55 : 0.48);
    const writeInstances = () => {
      const discA = (discs.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).array as Float32Array;
      const ghostA = (ghost.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).array as Float32Array;
      const rimA = (rims.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).array as Float32Array;
      const warnA = (warns.geometry.getAttribute('aAlpha') as InstancedBufferAttribute).array as Float32Array;
      let w = 0;
      for (let i = 0; i < N; i++) {
        const s = states[i]!;
        const vis = s.vis;
        const r = rad * (0.3 + 0.7 * vis) * (1 + 0.35 * s.hot);
        // colour: family, dimmed out of focus, lifted toward fg when hot
        c3.copy(famColor(s)).lerp(pal.dim, Math.min(1, (1 - s.focus) * (dark ? 0.95 : 0.8)));
        if (s.hot > 0) c3.lerp(pal.fg, 0.2 * s.hot);
        // solid (existing capacity)
        const hs = s.hs * H * vis * s.solid;
        p3.copy(s.n).multiplyScalar(R);
        if (hs > 1e-6) solid.setMatrixAt(i, m4.compose(p3, s.q, s3.set(r, hs, r)));
        else solid.setMatrixAt(i, ZERO);
        c4.copy(c3).lerp(pal.dim, 0.7 * s.sdim);
        solid.setColorAt(i, c4);
        // growth: extension on top of the solid part, or a ghost from the ground
        const hg = s.hg * H * vis * s.grow;
        const g0 = s.form === 'expanding' ? hs : 0;
        const rg = r * (s.form === 'ghost' ? 1.04 : 1.012);
        if (hg > 1e-6 && s.form === 'expanding') {
          p3.copy(s.n).multiplyScalar(R + g0);
          ext.setMatrixAt(i, m4.compose(p3, s.q, s3.set(rg, hg, rg)));
        } else ext.setMatrixAt(i, ZERO);
        ext.setColorAt(i, c3);
        if (hg > 1e-6 && s.form === 'ghost') {
          p3.copy(s.n).multiplyScalar(R);
          ghost.setMatrixAt(i, m4.compose(p3, s.q, s3.set(rg, hg, rg)));
        } else ghost.setMatrixAt(i, ZERO);
        ghost.setColorAt(i, c3);
        ghostA[i] = s.f.status === 'planned' ? 0.62 : 1;
        // rim at the top of the growth part
        if (hg > 1e-6) {
          p3.copy(s.n).multiplyScalar(R + g0 + hg);
          rims.setMatrixAt(i, m4.compose(p3, s.q, s3.set(rg, 1, rg)));
        } else rims.setMatrixAt(i, ZERO);
        rims.setColorAt(i, c3);
        rimA[i] = (dark ? 0.85 : 0.95) * Math.min(1, vis * 1.5);
        const top = R + (s.form === 'expanding' ? hs + hg : s.form === 'ghost' ? hg : hs);
        // plinth + true-position pin
        p3.copy(s.n).multiplyScalar(R + 0.0009 * Math.max(0.15, zs));
        const dr = r * 2.1;
        discs.setMatrixAt(i, m4.compose(p3, s.q, s3.set(dr, 1, dr)));
        discs.setColorAt(i, c4.copy(c3).lerp(pal.plinth, 0.35));
        discA[i] = discAlpha(dark) * Math.min(1, vis) * (0.45 + 0.55 * s.focus);
        const moved = s.base.angleTo(s.n) > rad * 1.6;
        if (moved && vis > 0.02) {
          p3.copy(s.base).multiplyScalar(R + 0.0011 * Math.max(0.15, zs));
          const pr = rad * 0.42;
          discs.setMatrixAt(N + i, m4.compose(p3, s.q, s3.set(pr, 1, pr)));
          discs.setColorAt(N + i, pal.fg);
          discA[N + i] = (dark ? 0.75 : 0.7) * vis;
        } else {
          discs.setMatrixAt(N + i, ZERO);
          discA[N + i] = 0;
        }
        // delayed: dashed warning ring at the foot
        if (s.f.status === 'delayed') {
          p3.copy(s.n).multiplyScalar(R + 0.0013 * Math.max(0.15, zs));
          if (hg > 1e-6) warns.setMatrixAt(w, m4.compose(p3, s.q, s3.set(r, 1, r)));
          else warns.setMatrixAt(w, ZERO);
          warns.setColorAt(w, pal.warn);
          warnA[w] = (dark ? 0.95 : 1) * Math.min(1, vis);
          w++;
        }
        // tops: labels, picking, halos
        s.top.copy(s.n).multiplyScalar(top + 0.002);
        s.foot.copy(s.n).multiplyScalar(R + 0.001);
        s.pts[0]!.position.copy(s.n).multiplyScalar(R + (top - R) * 0.12 + 0.002);
        s.pts[1]!.position.copy(s.n).multiplyScalar(R + (top - R) * 0.55);
        s.pts[2]!.position.copy(s.top);
        s.tag.label.set({ position: s.top });
        const ga = beaconOn[i] ? (dark ? 0.6 : 0.3) : s.form === 'ghost' ? 0 : dark ? 0.38 : 0.12;
        glowBase[i] = (ga + 0.3 * s.hot) * vis * (0.25 + 0.75 * s.focus);
        glows.set(i, s.top, r * (beaconOn[i] ? 9 : 7), c3, glowBase[i]);
      }
      for (const m of instanced) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      for (const m of [discs, ghost, rims, warns]) m.geometry.getAttribute('aAlpha').needsUpdate = true;
      // campus anchors: the top of the tallest visible member
      for (const c of campuses) {
        let best: FState | null = null;
        for (const s of c.members) if (s.vis > 0.3 && (!best || s.top.lengthSq() > best.top.lengthSq())) best = s;
        if (best) c.anchor.copy(best.top);
        c.tag.label.set({ position: c.anchor });
      }
      // region anchors: above the tallest visible column of the country
      for (const rg of regions) {
        let t = R;
        for (const s of rg.members) if (s.vis > 0.3) t = Math.max(t, s.top.length());
        // up close the title floats well above the cluster, clear of the column names
        rg.anchor.position.copy(rg.centre).multiplyScalar(t + (t - R) * (zs < FAR ? 0.55 : 0) + 0.01);
      }
      const hov = hoverFab ?? selected;
      hoverRing.visible = !!hov && hov.vis > 0.5;
      if (hov) {
        hoverRing.position.copy(hov.n).multiplyScalar(R + 0.0016 * Math.max(0.15, zs));
        hoverRing.quaternion.copy(hov.q);
        const hr = rad * 3;
        hoverRing.scale.set(hr, 1, hr);
      }
    };

    /* ───────── filters ───────── */
    const matches = (f: Fab, p: ProductFilter) => p === 'all' || f.families.has(p);
    const partsFor = (f: Fab, st: StatusFilter): [number, number] => {
      const info = STATUS_INFO[f.status];
      if (st === 'existing') return [info.existing ? 1 : 0, 0];
      if (st === 'growth') return [info.existing && info.growth ? 1 : 0, info.growth ? 1 : 0];
      return [info.existing ? 1 : 0, info.growth ? 1 : 0];
    };
    const visibleCount = () => states.filter((s) => s.visT > 0).length;
    let hoverFab: FState | null = null;
    let selected: FState | null = null;

    const setFilters = (p: ProductFilter, st: StatusFilter, fromChip: boolean) => {
      product = p;
      status = st;
      overlay.setProduct(p);
      overlay.setStatus(st);
      for (const s of states) {
        const [a, b] = partsFor(s.f, st);
        const on = matches(s.f, p) && a + b > 0;
        s.visT = on ? 1 : 0;
        s.solidT = a;
        s.growT = b;
        s.sdimT = st === 'growth' ? 1 : 0;
        s.fam = p === 'all' ? s.f.primary : p;
        for (const pt of s.pts) pt.id = FAMILY_INFO[s.fam].hotspot;
        s.tag.label.set({ swatch: famCss(s.fam) });
      }
      if (selected && selected.visT === 0) {
        selected = null;
        ctx.card.hide();
      }
      if (fromChip) interacted = true;
      updateLabels();
      updatePanel();
      updateLegend();
      dirty = true;
      ctx.invalidate();
    };

    /* ───────── labels ───────── */
    const labelBudget = () => {
      const w = ctx.size.width;
      return w < 440 ? 6 : w < 640 ? 9 : w < 960 ? 13 : 18;
    };
    const updateLabels = () => {
      const far = zs >= FAR;
      const hovId = hotspots.hovered ?? '';
      // Campuses with three or more visible columns carry one label instead of their members'.
      const merged = new Set<Campus>();
      for (const c of campuses) {
        const vis = c.members.filter((s) => s.visT > 0 && (spec.names ? spec.names(s.f) : !far));
        const on = vis.length >= (c.pair ? 2 : 3);
        if (on) merged.add(c);
        const fam = vis[0]?.fam ?? c.members[0]!.fam;
        const lit = vis.some((s) => s.hotT > 0 && s !== hoverFab && s !== selected);
        const first = c.members[0]!.f;
        c.tag.on = on;
        c.tag.text = c.pair ? `${first.city} ${c.members.map((s) => s.f.name).join('・')}` : `${first.city}・${first.companyName} ${vis.length} 座`;
        c.tag.prio = 36 + vis.length + (lit ? 40 : 0);
        // A pair of different families (清州 M15 NAND, M15X HBM) gets no swatch rather than a wrong one.
        const mixed = vis.some((s) => s.fam !== fam);
        c.tag.swatch = !mixed;
        c.tag.label.set({ text: c.tag.text, visible: on && !c.tag.blocked, priority: c.tag.prio, swatch: mixed ? '' : famCss(fam) });
      }
      for (const s of states) {
        const isHot = s === hoverFab || s === selected;
        // From orbit only the step's subject is named; up close every column, unless the step names a subset.
        const camp = campusOf.get(s);
        const named = (spec.names ? spec.names(s.f) : !far) && !(camp && merged.has(camp));
        const on = s.visT > 0 && (named || isHot);
        const size = (s.f.cap ?? 0) + (s.f.add ?? 0);
        s.tag.on = on;
        s.tag.prio = 10 + 20 * Math.sqrt(size / maxTotal) + (isHot ? 400 : s.hotT > 0 ? 40 : 0) + (s.focusT >= 1 ? 8 : 0);
        s.tag.kind = isHot ? 'strong' : 'default';
        s.tag.label.set({ visible: on && !s.tag.blocked, kind: s.tag.kind, priority: s.tag.prio });
      }
      for (const r of regions) {
        const n = r.members.filter((s) => s.visT > 0).length;
        const lit = REGION_VIEW[r.code]?.hotspot === hovId;
        // From orbit the country names carry the map (in steps that name fabs they only fill the gaps);
        // up close they title the cluster in view. A country with three or more names to show from
        // orbit (韓國 in HBM 擴產) is too crowded for them all: its title comes first, so the cluster is
        // never left unnamed, and the names fill in around it where they fit.
        let crowd = 0;
        if (far && spec.names) {
          const seen = new Set<Campus>();
          for (const s of r.members) {
            if (s.visT === 0 || !spec.names(s.f)) continue;
            const camp = campusOf.get(s);
            if (!camp || !merged.has(camp)) crowd++;
            else if (!seen.has(camp)) {
              seen.add(camp);
              crowd++;
            }
          }
        }
        r.tag.on = n > 0;
        r.tag.text = `${r.name} ${n} 座`;
        // Up close only the countries the step is about outrank the fab names (中國自主 dims 韓國),
        // and on narrow stages (a few labels only) the fab names come first: the step names the country.
        const inFocus = !spec.focus || r.members.some((s) => spec.focus!(s.f) >= 0.5);
        const near = inFocus ? (labelBudget() < 13 ? 9 : 120) : 5;
        r.tag.prio = (far ? (spec.names ? (crowd >= 3 ? 90 : 6) : 30) : near) + n + (lit ? 300 : 0);
        r.tag.label.set({ text: r.tag.text, visible: r.tag.on && !r.tag.blocked, priority: r.tag.prio, kind: lit ? 'strong' : 'default' });
        r.tag.kind = lit ? 'strong' : 'default';
      }
      // Reference cities orient the close-ups (釜山 beside the Korean cluster); on wide stages they win
      // collisions there.
      for (const t of refTags) {
        t.on = zs < REF_ON;
        // On narrow stages (a few labels only) the fab names come first.
        t.prio = zs < REF_NEAR && labelBudget() >= 13 ? 60 : 4;
        t.label.set({ visible: t.on && !t.blocked, priority: t.prio });
      }
      labels.setMax(labelBudget());
      layoutAt = 0;
    };

    /**
     * Label alignment pass (every ~200 ms, as in cloud-globe): in priority order keep each label on
     * its current side if that spot is free, else try above → right → left → below, so crowded
     * clusters keep more names instead of the collision grid culling them.
     */
    let layoutAt = 0;
    let layoutPending = true;
    let lastCam = NaN;
    const boxes: number[] = [];
    const cellBox = (x: number, y: number, w: number, h: number): [number, number, number, number] => {
      x = Math.round(x);
      y = Math.round(y);
      return [Math.floor((x - 2) / 4), Math.floor((y - 2) / 4), Math.floor((x + w + 2) / 4), Math.floor((y + h + 2) / 4)];
    };
    const overlaps = (b: readonly number[]) => {
      for (let i = 0; i < boxes.length; i += 4)
        if (b[0]! <= boxes[i + 2]! && b[2]! >= boxes[i]! && b[1]! <= boxes[i + 3]! && b[3]! >= boxes[i + 1]!) return true;
      return false;
    };
    const underUi = (x: number, y: number, w: number, h: number) =>
      uiRects.some((r) => x < r.x1 + 4 && x + w > r.x0 - 4 && y < r.y1 + 4 && y + h > r.y0 - 4);
    /**
     * Label sizes measured the way the LabelLayer measures them (a hidden `.scene-label` in the
     * layer's container, cached per kind / swatch / text and cleared on resize), so this pass and the
     * layer's own collision culling agree on what fits. Falls back to an estimate if the layer's
     * container cannot be found.
     */
    const sizeCache = new Map<string, [number, number]>();
    let measurer: HTMLElement | null = null;
    const labelSize = (t: Tag): [number, number] => {
      const key = `${t.kind}|${t.swatch ? 1 : 0}|${t.text}`;
      const hit = sizeCache.get(key);
      if (hit) return hit;
      if (!measurer) {
        const host = ctx.stage.querySelector('.scene-label')?.parentElement;
        if (host) {
          measurer = document.createElement('div');
          measurer.className = 'scene-label';
          measurer.setAttribute('aria-hidden', 'true');
          measurer.style.cssText = 'visibility:hidden;transform:none;left:-9999px;top:0';
          host.appendChild(measurer);
        }
      }
      let size: [number, number];
      if (measurer) {
        measurer.dataset['kind'] = t.kind;
        measurer.textContent = '';
        if (t.swatch) {
          const i = document.createElement('i');
          i.className = 'scene-label-swatch';
          measurer.appendChild(i);
        }
        measurer.appendChild(document.createTextNode(t.text));
        size = [Math.ceil(measurer.offsetWidth), Math.ceil(measurer.offsetHeight)];
      } else {
        const Wd = ctx.size.width;
        const strong = t.kind === 'strong';
        const fs = strong ? Math.max(12, Math.min(15, 9.6 + 0.005 * Wd)) : Math.max(11, Math.min(13, 8.8 + 0.004 * Wd));
        let w = (strong ? 24 : 20) + (t.swatch ? 14 : 0);
        for (const ch of t.text) w += ch === ' ' ? fs * 0.3 : ch.charCodeAt(0) > 0x2e80 ? fs : fs * 0.58;
        size = [w, fs * 1.35 + (strong ? 9 : 7)];
      }
      if (size[0] > 0) sizeCache.set(key, size);
      return size;
    };
    const order: { t: Tag; z: number }[] = [];
    const layoutLabels = () => {
      measureUi();
      const { width: Wd, height: Ht } = ctx.size;
      boxes.length = 0;
      let n = 0;
      const max = labelBudget();
      // Same order as the LabelLayer: priority, then nearer first.
      order.length = 0;
      for (const t of [...states.map((s) => s.tag), ...campuses.map((c) => c.tag), ...regions.map((r) => r.tag), ...refTags]) {
        if (t.on) order.push({ t, z: e3.copy(t.top).project(ctx.camera).z });
      }
      order.sort((a, b) => b.t.prio - a.t.prio || a.z - b.z);
      // This pass decides which labels show: one that finds no free side (clear of the stage edge, the
      // chips / legend / panel and the labels placed before it) is hidden until a later pass finds
      // it a spot. Leaving it to the LabelLayer would let it keep a stale side, e.g. under a chip.
      for (const { t } of order) {
        let placed = false;
        const p = n < max && !hiddenByGlobe(t.top, ctx.camera.position) ? ctx.project(t.top) : null;
        if (p) {
          const [w, lh] = labelSize(t);
          let free = false; // some side is on stage and clear of the HTML overlay
          for (const a of [t.align, ...ALIGNS]) {
            const x = a === 'left' ? p.x - w - 10 : a === 'right' ? p.x + 10 : p.x - w / 2;
            const y = a === 'above' ? p.y - lh - 8 : a === 'below' ? p.y + 8 : p.y - lh / 2;
            if (x < 0 || y < 0 || x + w > Wd || y + lh > Ht) continue;
            if (underUi(x, y, w, lh)) continue;
            free = true;
            const b = cellBox(x, y, w, lh);
            if (overlaps(b)) continue;
            boxes.push(...b);
            n++;
            placed = true;
            if (a !== t.align) {
              t.align = a;
              t.label.set({ align: a });
            }
            break;
          }
          // The hovered / selected column's name always shows (the layer gives it precedence).
          if (!placed && free && t.prio >= 400) placed = true;
        }
        if (placed !== !t.blocked) {
          t.blocked = !placed;
          t.label.set({ visible: t.on && placed });
        }
      }
    };
    labels.setOccluder((w, cam) => {
      if (hiddenByGlobe(w, cam.position)) return true;
      if (!uiRects.length) return false;
      e3.copy(w).project(cam);
      const x = ((e3.x + 1) / 2) * ctx.size.width;
      const y = ((1 - e3.y) / 2) * ctx.size.height;
      return uiRects.some((r) => x > r.x0 - 6 && x < r.x1 + 6 && y > r.y0 - 6 && y < r.y1 + 6);
    });

    /* ───────── legend & panel ───────── */
    const updateLegend = () => {
      const parts: (string | { strong: string })[] = [];
      if (status === 'growth') parts.push('半透明段、虛線空心柱＝尚未量產的產能');
      else if (spec.panel === 'china') parts.push('亮色＝中國自主，淡色＝外資');
      else if (zs >= 0 && zs < FAR) parts.push('細線指向廠區實際位置');
      else parts.push('顯示 ', { strong: String(visibleCount()) }, ' 座廠區');
      overlay.setExtra(parts);
    };
    let legendNear = false;

    const capTotal = (list: readonly FState[]) => list.reduce((a, s) => a + (s.f.cap ?? 0), 0);
    const addTotal = (list: readonly FState[]) => list.reduce((a, s) => a + (s.f.add ?? 0), 0);
    const group = <K>(list: readonly FState[], key: (s: FState) => K) => {
      const m = new Map<K, FState[]>();
      for (const s of list) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
      return m;
    };
    const unknownNote = (n: number, what: string) => (n ? `另有 ${n} 座未公開${what}，未列入加總。` : '');
    /** Panel titles carry the unit (and 示意) so the rows stay short on phones. */
    const unit = (u: string) => `（${u}${ctx.isFixture ? '，示意' : ''}）`;
    /**
     * Capacity rows only add up the sites with a published figure, so every row says how many of its
     * wafer fabs that covers (「150（2/6 座）」); groups with no published figure stay listed as 未公開
     * instead of disappearing, so partial data never reads as a full comparison.
     */
    const capRow = (label: string, l: readonly FState[]) => {
      const fabs = l.filter((s) => s.f.wafer);
      const known = fabs.filter((s) => s.f.cap);
      const cap = capTotal(known);
      const partial = known.length < fabs.length;
      const cover = partial ? `（${known.length}/${fabs.length} 座）` : '';
      // A partial total is a lower bound: 「≥」 in the text and a bar that fades out at its end.
      return {
        label,
        value: cap,
        n: fabs.length,
        partial: partial && cap > 0,
        text: cap > 0 ? `${partial ? '≥ ' : ''}${fmtNum(cap)}${cover}` : `未公開${cover}`,
      };
    };
    const capRows = <R extends { value: number; n: number }>(rows: R[]) =>
      rows
        .filter((r) => r.n > 0)
        .sort((a, b) => b.value - a.value || b.n - a.n)
        .slice(0, 6)
        .map(({ n: _n, ...r }) => r);
    const capNote = '只加總有公開數字的晶圓廠；「≥」表示還有晶圓廠未公開產能，實際總量更多。括號是有數字的廠數／晶圓廠數，封裝與 HDD 廠不列入。';
    const panelFor = (kind: PanelKind): BarPanel | null => {
      const vis = states.filter((s) => s.visT > 0);
      const src = ctx.isFixture ? '依示意資料加總' : '依頁面資料加總';
      if (kind === 'country') {
        const ex = vis.filter((s) => STATUS_INFO[s.f.status].existing);
        const rows = capRows([...group(ex, (s) => s.f.country)].map(([c, l]) => capRow(countryName(c), l)));
        return {
          title: '各地已公開月產能',
          unit: unit('千片/月'),
          rows,
          note: `${src}，同一國家含外資廠。${capNote}`,
        };
      }
      if (kind === 'korea' || kind === 'nand' || kind === 'china') {
        const pool = vis.filter(
          (s) => STATUS_INFO[s.f.status].existing && (kind === 'korea' ? s.f.country === 'KR' : kind === 'china' ? s.f.country === 'CN' : s.f.families.has('nand')),
        );
        const rows = capRows(
          [...group(pool, (s) => s.f.company)].map(([, l]) => {
            const f = l[0]!.f;
            const own = kind === 'china' ? (f.domestic ? '・自主' : '・外資') : '';
            const row = capRow(`${f.companyName}${own}`, l);
            const color = kind === 'china' ? (f.domestic ? 'c-accent' : 'scene-muted') : kind === 'nand' ? FAMILY_INFO.nand.token : '';
            return color ? { ...row, color } : row;
          }),
        );
        const title = kind === 'korea' ? '韓國廠區：各公司已公開月產能' : kind === 'nand' ? 'NAND：各公司已公開月產能' : '中國境內：各公司已公開月產能';
        const extra = kind === 'nand' ? 'DRAM 與 NAND 共用的廠區整座計入。' : kind === 'china' ? '自主＝總部在中國的公司，外資＝外國公司在中國的廠區。' : '';
        return {
          title,
          unit: unit('千片/月'),
          rows,
          note: `${src}。${extra}${capNote}`,
        };
      }
      // growth: planned additions per country (expanding + new fabs), with the number of projects
      const pool = vis.filter((s) => STATUS_INFO[s.f.status].growth);
      const rows = [...group(pool, (s) => s.f.country)]
        .map(([c, l]) => {
          const add = addTotal(l);
          return { label: countryName(c), value: add, n: l.length, text: add > 0 ? `+${fmtNum(add)}・${l.length} 座` : `${l.length} 座`, color: FAMILY_INFO.hbm.token };
        })
        .sort((a, b) => b.value - a.value || b.n - a.n)
        .slice(0, 6)
        .map(({ n: _n, ...r }) => r);
      return {
        title: '擴產與新建：各地新增月產能',
        unit: unit('千片/月'),
        rows,
        note: `${src}，含興建與規劃中的新廠。${unknownNote(pool.filter((s) => !s.f.add).length, '新增產能')}`,
      };
    };
    /** The reader's status filter re-targets the overview panels (growth ↔ current capacity). */
    const panelKind = (): PanelKind => {
      if (status === 'growth' && spec.panel !== 'growth') return 'growth';
      if (status !== 'growth' && spec.panel === 'growth') return 'country';
      return spec.panel;
    };
    const updatePanel = () => overlay.setPanel(panelFor(panelKind()));

    /* ───────── camera ───────── */
    const portraitElev = () => (ctx.size.portrait ? 8 : 0);
    /**
     * Portrait stages are narrower, so close-ups step back a little more (on top of the host, which
     * scales every pose passed to ctx.setPose by |portrait| / |main|).
     */
    const closeK = (v?: RegionView) => (ctx.size.portrait ? (v?.pk ?? 1.08) : 1);
    /**
     * The East Asia frame in its landscape form. ctx.setPose fits it to portrait stages, so this (not
     * ctx.homePose, which is already the portrait pose there) is what steps and hotspots fly to;
     * passing ctx.homePose would apply the portrait scaling twice.
     */
    const asiaPose = (): CameraPose => centrePose(HOME.lat, HOME.lon, HOME.dist, HOME_TARGET);
    const regionPose = (code: string): CameraPose => {
      const v = REGION_VIEW[code];
      if (v) return obliquePose(v.lat, v.lon, v.dist * closeK(v), v.elev + portraitElev(), v.az ?? 0, v.lift ?? 0);
      const r = regions.find((x) => x.code === code);
      if (!r) return asiaPose();
      const { lat, lon } = vec3ToLatLon(r.centre);
      return obliquePose(lat - 0.5, lon, 0.6 * closeK(), 50 + portraitElev());
    };
    const viewPose = (v: View): CameraPose => {
      switch (v) {
        case 'home':
        case 'growth-asia':
        case 'eastasia':
          return asiaPose();
        case 'korea':
          return regionPose('KR');
        case 'us':
          return regionPose('US');
        case 'china':
          return regionPose('CN');
      }
    };
    let posing = false;
    let flyToken = 0;
    const legs: Tween[] = [];
    const flyTo = (pose: CameraPose, slow = 1) => {
      const token = ++flyToken;
      legs.splice(0).forEach((t) => t.cancel());
      posing = true;
      const done = () => {
        if (token === flyToken) posing = false;
      };
      const cam = ctx.camera.position;
      const to = Array.isArray(pose.position) ? new Vector3(...(pose.position as Tuple)) : (pose.position as Vector3).clone();
      const a = v3.copy(cam).normalize().angleTo(to.clone().normalize());
      if (a > 1.2 && ctx.animate) {
        // Long hop: swing around the globe through a raised midpoint instead of cutting through it.
        const from = cam.clone().normalize();
        const axis = new Vector3().crossVectors(from, to.clone().normalize());
        if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
        const mid = from.applyAxisAngle(axis.normalize(), a / 2).multiplyScalar(Math.max(cam.length(), to.length(), 3) * 1.05);
        const l1 = ctx.setPose({ position: mid, target: [0, 0, 0] }, { duration: 650 * slow, ease: (k) => k * k });
        legs.push(l1);
        void l1.done.then(() => {
          if (token !== flyToken) return;
          const l2 = ctx.setPose(pose, { duration: 800 * slow, ease: 'quadOut' });
          legs.push(l2);
          void l2.done.then(done);
        });
      } else {
        const l = ctx.setPose(pose, { duration: 950 * slow });
        legs.push(l);
        void l.done.then(done);
      }
    };

    /* ───────── cards, hotspots, picking ───────── */
    const qual = (f: Fab) => {
      const t = [f.capStatus ? CAP_STATUS[f.capStatus] : '', ctx.isFixture ? '示意' : ''].filter(Boolean);
      return t.length ? `（${t.join('・')}）` : '';
    };
    const fabCard = (s: FState): CardContent => {
      const f = s.f;
      const st = STATUS_INFO[f.status];
      const items: CardItem[] = [
        { label: '產品', meta: f.products.map((p) => PRODUCT_LABEL[p]).join('、') },
        { label: '狀態', meta: st.label },
      ];
      if (st.existing) items.push({ label: '月產能', meta: f.cap ? `${fmtK(f.cap)}${qual(f)}` : '未公開' });
      if (f.add) items.push({ label: st.existing ? '擴產' : '規劃產能', meta: `${st.existing ? '+' : ''}${fmtK(f.add)}${qual(f)}` });
      else if (!st.existing) items.push({ label: '規劃產能', meta: '未公開' });
      if (f.capex) items.push({ label: '資本支出', meta: `${f.capex}${sample}` });
      if (f.timeline) items.push({ label: '時程', meta: f.timeline });
      return {
        title: `${f.companyName}・${f.short}`,
        subtitle: [f.city, countryName(f.country)].filter(Boolean).join('・'),
        swatch: famCss(s.fam),
        body: f.note ?? st.note,
        items,
        href: f.href,
        linkLabel: '查看公司頁 →',
      };
    };
    const listFabs = (list: readonly FState[], n: number, by: (s: FState) => number, meta: (s: FState) => string): CardItem[] =>
      [...list]
        .sort((a, b) => by(b) - by(a))
        .slice(0, n)
        .map((s) => ({ label: `${s.f.companyName}・${s.f.short}`, meta: meta(s), href: s.f.href }));
    const capMeta = (s: FState) => (s.f.cap ? `${fmtK(s.f.cap)}${qual(s.f)}` : STATUS_INFO[s.f.status].label);
    const groupCard = (id: string, list: readonly FState[], by: (s: FState) => number, meta: (s: FState) => string): CardContent => ({
      title: `${metaText.get(id)?.label ?? id}・${list.length} 座`,
      body: metaText.get(id)?.detail ?? '',
      items: listFabs(list, 5, by, meta),
    });

    const points: ScreenPoint[] = [];
    const pointFab: FState[] = [];
    const rebuildPoints = () => {
      points.length = 0;
      pointFab.length = 0;
      for (const s of states) {
        if (s.visT === 0 || s.vis < 0.5) continue;
        for (const p of s.pts) {
          points.push(p);
          pointFab.push(s);
        }
      }
      return points;
    };
    ctx.picker.addPoints(rebuildPoints, { cull: (w) => hiddenByGlobe(w, ctx.camera.position) });
    const famHotspots = new Set(FAMILY_ORDER.map((f) => FAMILY_INFO[f].hotspot));
    const fabOf = (hit: PickHit | null): FState | null =>
      hit && hit.index !== undefined && hit.object === ctx.camera && hit.id && famHotspots.has(hit.id) ? (pointFab[hit.index] ?? null) : null;

    /** Card / focus anchors: live column tops (created once; updated by the instance writer). */
    const anchorUpdates: (() => void)[] = [];
    const anchorOf = (list: readonly FState[]) => {
      const s = [...list].sort((a, b) => b.hs + b.hg - (a.hs + a.hg))[0];
      const o = new Object3D();
      root.add(o);
      if (s) anchorUpdates.push(() => o.position.copy(s.top));
      else o.position.set(...ll(HOME.lat, HOME.lon, R));
      return o;
    };
    const famPose = (fam: Family): CameraPose => {
      const list = states.filter((s) => s.f.families.has(fam));
      if (!list.length) return asiaPose();
      const v = new Vector3();
      for (const s of list) v.addScaledVector(s.base, 1 + Math.sqrt((s.f.cap ?? 0) / maxTotal));
      const { lat, lon } = vec3ToLatLon(v.normalize());
      return centrePose(Math.max(-20, Math.min(55, lat)), lon, ctx.size.portrait ? 2.5 : 2.4, [0, 0.12, 0]);
    };
    const famList = new Map(FAMILY_ORDER.map((fam) => [fam, states.filter((s) => s.f.families.has(fam))] as const));
    const expList = states.filter((s) => s.f.status === 'expanding');
    const newList = states.filter((s) => s.f.status === 'construction' || s.f.status === 'planned');
    const lateList = states.filter((s) => s.f.status === 'delayed');
    const capList = states.filter((s) => s.f.cap);
    const anchors = {
      fam: new Map(FAMILY_ORDER.map((fam) => [fam, anchorOf(famList.get(fam)!)] as const)),
      exp: anchorOf(expList),
      fresh: anchorOf(newList),
      late: anchorOf(lateList),
      all: anchorOf(states),
    };
    const suppress = (src: string) => src === 'pointer';
    /** (Re)register the hotspots; their focus poses depend on the stage shape (landscape / portrait). */
    const registerHotspots = () => {
      for (const fam of FAMILY_ORDER) {
        const list = famList.get(fam)!;
        const id = FAMILY_INFO[fam].hotspot;
        hotspots.register(id, {
          anchor: anchors.fam.get(fam)!,
          pose: famPose(fam),
          card: (hit) => {
            const s = fabOf(hit);
            return s ? fabCard(s) : groupCard(id, list, (x) => x.f.cap ?? 0, capMeta);
          },
          onSelect: (src) => suppress(src),
        });
      }
      const growthPose = viewPose('growth-asia');
      hotspots.register('status-expanding', {
        anchor: anchors.exp,
        pose: growthPose,
        card: () => groupCard('status-expanding', expList, (x) => x.f.add ?? 0, (x) => (x.f.add ? `+${fmtK(x.f.add)}${sample}` : '新增產能未公開')),
      });
      hotspots.register('status-new', {
        anchor: anchors.fresh,
        pose: growthPose,
        card: () => groupCard('status-new', newList, (x) => x.f.add ?? 0, (x) => `${STATUS_INFO[x.f.status].label}${x.f.timeline ? `・${x.f.timeline}` : ''}`),
      });
      hotspots.register('status-delayed', {
        anchor: anchors.late,
        pose: lateList[0] ? regionPose(lateList[0].f.country) : growthPose,
        card: () => groupCard('status-delayed', lateList, (x) => x.f.add ?? 0, (x) => x.f.timeline ?? STATUS_INFO.delayed.label),
      });
      for (const [code, v] of Object.entries(REGION_VIEW)) {
        if (!v.hotspot) continue;
        const r = regions.find((x) => x.code === code);
        const list = r?.members ?? [];
        const id = v.hotspot;
        hotspots.register(id, {
          anchor: r ? r.anchor : ll(v.lat, v.lon, R * 1.02),
          pose: regionPose(code),
          card: () => groupCard(id, list, (x) => x.f.cap ?? x.f.add ?? 0, capMeta),
        });
      }
      hotspots.register('capacity', {
        anchor: anchors.all,
        pose: asiaPose(),
        card: () => groupCard('capacity', capList, (x) => x.f.cap ?? 0, capMeta),
      });
    };
    registerHotspots();
    let portrait = ctx.size.portrait;

    ctx.picker.onHover((hit) => {
      const s = fabOf(hit);
      if (s !== hoverFab) {
        hoverFab = s;
        ctx.invalidate();
      }
    });
    ctx.picker.onClick((hit, ev) => {
      const s = fabOf(hit);
      if (!s) {
        if (selected) {
          selected = null;
          dirty = true;
        }
        return;
      }
      if (ev.pointerType === 'mouse') {
        ctx.navigate(s.f.href, { newTab: ev.ctrlKey || ev.metaKey });
        return;
      }
      // touch / pen: the registry opened an interactive card with the link; keep the column lit.
      selected = s;
      const f = s.f;
      ctx.announce(`已選取：${f.companyName}${f.short}，${STATUS_INFO[f.status].label}，月產能${f.cap ? fmtK(f.cap) : '未公開'}。`);
      dirty = true;
      ctx.invalidate();
    });

    /* ───────── spin & interaction ───────── */
    let pointerInside = false;
    let interacted = false;
    let spinVel = 0;
    let lastNow = performance.now();
    let lastKey = '';
    ctx.canvas.addEventListener('pointerenter', () => (pointerInside = true), { signal: ctx.signal });
    ctx.canvas.addEventListener('pointerleave', () => (pointerInside = false), { signal: ctx.signal });
    const onControlsStart = () => (interacted = true);
    ctx.controls?.addEventListener('start', onControlsStart);

    const applyEmphasis = () => {
      const hov = hotspots.hovered ?? '';
      const single = hoverFab ?? selected;
      const famHov = FAMILY_ORDER.find((f) => FAMILY_INFO[f].hotspot === hov);
      const regHov = Object.entries(REGION_VIEW).find(([, v]) => v.hotspot === hov)?.[0];
      const statusHov = hov === 'status-expanding' ? ['expanding'] : hov === 'status-new' ? ['construction', 'planned'] : hov === 'status-delayed' ? ['delayed'] : null;
      const grp = !single && !!(famHov || regHov || statusHov);
      for (const s of states) {
        const base = spec.focus?.(s.f) ?? 1;
        const inGroup = famHov ? s.f.families.has(famHov) : regHov ? s.f.country === regHov : statusHov ? statusHov.includes(s.f.status) : false;
        const beacon = beaconOn[s.f.index] ? 0.55 : 0;
        s.hotT = single ? (s === single ? 1 : 0) : grp && inGroup ? 0.45 : beacon;
        s.focusT = grp ? (inGroup ? 1 : Math.min(base, 0.35)) : base;
      }
    };

    /* ───────── steps ───────── */
    let tourTimer = 0;
    let tourToken = 0;
    /** Steps with a second view: land on the first, pause, then glide on unless the reader took over. */
    const tour = (sp: StepSpec, fly: boolean) => {
      window.clearTimeout(tourTimer);
      const token = ++tourToken;
      if (!sp.then || !ctx.animate) {
        // Reduced motion: no automatic camera tour; the first view holds most of the step's subject
        // and the hotspot list reaches the second (e.g. 美國新產能).
        if (fly) flyTo(viewPose(sp.view));
        return;
      }
      if (fly) flyTo(viewPose(sp.view));
      let waits = 0;
      const glide = () => {
        if (token !== tourToken || interacted || ctx.signal.aborted || !ctx.animate) return;
        // The reader is exploring (pointer on the globe, a card open): wait a little longer.
        if ((pointerInside || ctx.card.visible || hotspots.hovered) && waits++ < 6) {
          tourTimer = window.setTimeout(glide, 2000);
          return;
        }
        flyTo(viewPose(sp.then!), 1.9);
      };
      tourTimer = window.setTimeout(glide, fly ? 6200 : 4800);
    };
    const applyStep = (i: number, fly: boolean) => {
      spec = STEPS[i] ?? STEPS[0]!;
      interacted = false;
      for (const s of states) beaconOn[s.f.index] = !!spec.beacon?.(s.f);
      setFilters(spec.product, spec.status, false);
      applyEmphasis();
      updateLabels();
      tour(spec, fly);
    };

    applyPalette(ctx.palette);
    applyZoom(zoomAt(ctx.camera.position.length() - R));
    applyStep(ctx.step, false);
    for (const s of states) {
      s.vis = s.visT;
      s.solid = s.solidT;
      s.grow = s.growT;
      s.sdim = s.sdimT;
      s.focus = s.focusT;
    }
    writeInstances();
    updateLabels();

    return {
      update(dt, t) {
        const now = performance.now();
        const rdt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        const cam = ctx.camera;
        const target = ctx.controls?.target ?? v3.set(0, 0, 0);

        // Slow orbit in 總覽 (ambient: dt is 0 when motion is off); stops once the reader interacts.
        const want = !!spec.spin && !interacted && ctx.animate && !pointerInside && !ctx.card.visible && !posing && !hotspots.hovered;
        spinVel += ((want ? SPIN : 0) - spinVel) * Math.min(1, rdt * 1.6);
        if (spinVel > 1e-4 && dt > 0) {
          p3.copy(cam.position).sub(target).applyAxisAngle(UP, -spinVel * dt);
          cam.position.copy(target).add(p3);
          cam.lookAt(target);
        }
        // Global views (orbit target at the centre) keep their distance; close-ups may come near.
        // Never clamp while a camera move runs; never go underground.
        if (!posing && ctx.tween.active === 0 && target.length() < 0.3) {
          p3.subVectors(cam.position, target);
          if (p3.length() < 1.3) cam.position.copy(target).addScaledVector(p3.normalize(), 1.3);
        }
        if (cam.position.length() < R * 1.012) cam.position.setLength(R * 1.012);
        // Key light follows the viewer so the facing hemisphere is always lit.
        lights.group.rotation.y = Math.atan2(cam.position.x, cam.position.z);

        // Semantic zoom: column size, cluster spread, fine graticule and the near plane follow altitude.
        const alt = cam.position.length() - R;
        const z = zoomAt(alt);
        if (Math.abs(z - zs) > 0.0015) {
          const was = zoneOf(zs);
          applyZoom(z);
          if (was !== zoneOf(zs)) updateLabels();
          const nearNow = zs < FAR;
          if (nearNow !== legendNear) {
            legendNear = nearNow;
            updateLegend();
          }
        }
        const nearPlane = Math.min(0.05, Math.max(0.002, alt * 0.2));
        if (Math.abs(nearPlane - cam.near) / cam.near > 0.15) {
          cam.near = nearPlane;
          cam.updateProjectionMatrix();
        }

        // Hover / list emphasis.
        if (selected && !ctx.card.visible) selected = null;
        const key = `${hotspots.hovered ?? ''}|${hoverFab?.f.index ?? -1}|${selected?.f.index ?? -1}`;
        if (key !== lastKey) {
          lastKey = key;
          applyEmphasis();
          updateLabels();
          dirty = true;
        }

        // Ease per-fab values (snap when motion is off).
        const k = ctx.animate ? 1 - Math.exp(-rdt * 8) : 1;
        let moving = false;
        for (const s of states) {
          if (s.vis !== s.visT) {
            const d = s.visT - s.vis;
            s.vis = Math.abs(d) < 0.003 ? s.visT : s.vis + d * k;
            moving ||= s.vis !== s.visT;
            dirty = true;
          }
          if (s.solid !== s.solidT) {
            const d = s.solidT - s.solid;
            s.solid = Math.abs(d) < 0.003 ? s.solidT : s.solid + d * k;
            moving ||= s.solid !== s.solidT;
            dirty = true;
          }
          if (s.grow !== s.growT) {
            const d = s.growT - s.grow;
            s.grow = Math.abs(d) < 0.003 ? s.growT : s.grow + d * k;
            moving ||= s.grow !== s.growT;
            dirty = true;
          }
          if (s.sdim !== s.sdimT) {
            const d = s.sdimT - s.sdim;
            s.sdim = Math.abs(d) < 0.003 ? s.sdimT : s.sdim + d * k;
            moving ||= s.sdim !== s.sdimT;
            dirty = true;
          }
          if (s.focus !== s.focusT) {
            const d = s.focusT - s.focus;
            s.focus = Math.abs(d) < 0.003 ? s.focusT : s.focus + d * Math.max(k, 0.3);
            moving ||= s.focus !== s.focusT;
            dirty = true;
          }
          if (s.hot !== s.hotT) {
            const d = s.hotT - s.hot;
            s.hot = Math.abs(d) < 0.003 ? s.hotT : s.hot + d * Math.max(k, 0.35);
            moving ||= s.hot !== s.hotT;
            dirty = true;
          }
        }
        if (dirty) {
          dirty = false;
          writeInstances();
          for (const u of anchorUpdates) u();
        }
        // Beacons breathe gently in steps that have them (ambient: frozen when motion is off).
        if (spec.beacon && ctx.animate) {
          for (let i = 0; i < N; i++) if (beaconOn[i]) glows.setAlpha(i, glowBase[i]! * (0.62 + 0.38 * Math.sin(t * 2.1 + i * 1.7)));
        }
        // Label layout: every ~200 ms, and once more after the camera settles (the demand loop under
        // reduced motion stops drawing as soon as nothing moves, so ask for the frame we need).
        const camKey = cam.position.x + cam.position.y * 3.1 + cam.position.z * 7.3 + cam.quaternion.x * 11 + cam.quaternion.y * 13;
        if (camKey !== lastCam) {
          lastCam = camKey;
          layoutPending = true;
        }
        if (now - layoutAt > 200 || (layoutPending && now - layoutAt > 60)) {
          layoutAt = now;
          layoutPending = false;
          layoutLabels();
        }
        return moving || layoutPending;
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
      onQuality() {
        hatchU.uHatch.value = 7 * ctx.renderer.getPixelRatio();
      },
      onResize(size) {
        hatchU.uHatch.value = 7 * ctx.renderer.getPixelRatio();
        sizeCache.clear(); // label font sizes follow the stage width (container query units)
        overlay.setCompact(size.height < COMPACT_H);
        measureUi();
        updateLabels(); // label budget and priorities follow the stage width
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          registerHotspots();
        }
      },
      dispose() {
        flyToken++;
        tourToken++;
        window.clearTimeout(tourTimer);
        legs.forEach((t) => t.cancel());
        ctx.controls?.removeEventListener('start', onControlsStart);
        overlay.destroy();
        measurer?.remove();
        root.removeFromParent();
      },
    };
  },
});

/**
 * model-galaxy — 大模型星系 (variant: galaxy). Page data: `models` (docs/SCENES.md).
 *
 * Each star is one model family placed in a glass "diorama box" (kit Axes3D):
 *   x = cost (costIndex 0–100 = log-scaled 3:1 blended price per million tokens, $0.05 → $100),
 *   y = capability index (refitted to the kinds on show), z = openness (closed at the back wall).
 * Colour = origin region (美國／中國／歐洲／台灣／其他), size = tier within its kind, shape = kind
 * (LLM sphere, image diamond, video cube, audio tetrahedron, world dodecahedron, robotics ring).
 * Drop lines and floor rings anchor every star. The efficient (Pareto) frontier of one kind is
 * projected onto the back wall. The kind filter hides other kinds (their scores come from other
 * benchmarks) and refits the capability axis; LLMs get $ ticks, other kinds an index.
 * The release-date slider shows the galaxy as of any month: stars appear at release and, when the
 * data carries `history`, glide along their version trails while the frontier climbs.
 *
 * Steps (由淺入深): 總覽 (3D) → 封閉與開放 (floor zones, high 3/4 view) → 能力與成本 (the box
 * presses flat against the back wall: a straight-on 2D chart in which the frontier runs through the
 * stars; its ends are named 最強旗艦 / 高 CP 值) → 前沿移動 (2D; time sweep, version trails and the
 * frontier at each year or half-year end) → 同能力降價 (2D; a dashed capability bar and the cheapest
 * model above it at each checkpoint).
 * Hover a star: card + its version trail. Click: /models/<id>/ (hotspot id = bare model id, matching
 * the page's hotspot list). In-stage HTML controls: colour legend, kind chips (= shape legend), time
 * slider with play. When few families carry earlier versions, the time views say how many do.
 * Star names are placed by placeLabels(): measured like the LabelLayer, kept clear of every other
 * label, the star discs and the HTML controls, and never nearer a neighbouring star (a star with no
 * such spot shows its name on hover only). On small stages fitStage() shrinks the diorama about the
 * chart's top so the axes stay clear of the fixed-size controls.
 * Reduced motion: no twinkle, glide, squash or sweep; the sweep step shows its final state (all
 * trails, every checkpoint frontier); the play button is hidden.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DynamicDrawUsage,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  Shape as ThreeShape,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type HotspotSpec,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type SceneContext,
} from '../../core/types';
import { Axes3D } from '../../kit/Axes3D';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import {
  KIND_CHIP,
  KIND_NAME,
  KINDS,
  ORIGIN_NAME,
  REGION_NAME,
  REGIONS,
  SHAPE_OF,
  SIZE_NAME,
  buildModels,
  checkpoints,
  cheapestAt,
  formatMonth,
  frontierAt,
  isModels,
  last,
  openText,
  pointAt,
  type Kind,
  type Model,
  type ModelDatum,
  type Region,
  type Shape,
  type Size,
  type TrackPoint,
} from './data';
import { createGalaxyUi, type KindFilter } from './ui';

/* ───────────────────────── layout & choreography ───────────────────────── */

interface Layout {
  size: readonly [number, number, number];
}
const LAND: Layout = { size: [7.2, 4.0, 3.0] };
const PORT: Layout = { size: [5.0, 5.2, 2.6] };
const OPEN_DOMAIN = [-0.12, 1.12] as const;
const PRICE_DOMAIN = [0.05, 100] as const; // costIndex 0 ↔ US$0.05, 100 ↔ US$100 (schema: log-scaled)
const priceOf = (ci: number) => PRICE_DOMAIN[0] * (PRICE_DOMAIN[1] / PRICE_DOMAIN[0]) ** (ci / 100);

const RADIUS: Record<Size, number> = { L: 0.15, M: 0.115, S: 0.085 };
const SHAPES: readonly Shape[] = ['sphere', 'diamond', 'cube', 'tetra', 'dodeca', 'ring'];
const SWEEP_SECONDS = 11;
const LABEL_FLOOR = 30;
const SWEEP_HOLD = 2.6;

type PoseKind = 'home' | 'side' | 'front';
type Align = 'right' | 'left' | 'above' | 'below';
/** Star label positions: [align, x offset in star radii, y offset (radii for above/below, else ± half a label + 0.7 r)]. */
const CANDS: readonly (readonly [Align, number, number])[] = [
  ['right', 1, 0],
  ['right', 0.7, -1],
  ['right', 0.7, 1],
  ['left', -1, 0],
  ['left', -0.7, -1],
  ['left', -0.7, 1],
  ['above', 0, -1],
  ['below', 0, 1],
];
interface StepCfg {
  pose: PoseKind;
  frontier: number;
  ghosts: number;
  trails: number;
  zones: number;
  threshold: number;
  sweep: boolean;
  ends: number;
  /** Depth of the openness axis: 1 = full 3D box, FLAT = pressed against the back wall (a 2D chart). */
  flat: number;
}
const FLAT = 0.04;
const STEPS: readonly StepCfg[] = [
  { pose: 'home', frontier: 0.8, ghosts: 0, trails: 0, zones: 0, threshold: 0, sweep: false, ends: 0, flat: 1 },
  { pose: 'side', frontier: 0, ghosts: 0, trails: 0, zones: 1, threshold: 0, sweep: false, ends: 0, flat: 1 },
  { pose: 'front', frontier: 1, ghosts: 0, trails: 0, zones: 0, threshold: 0, sweep: false, ends: 1, flat: FLAT },
  // Trails stay quiet so the moving frontier reads first; a hovered star shows its own at full strength.
  { pose: 'front', frontier: 1, ghosts: 1, trails: 0.34, zones: 0, threshold: 0, sweep: true, ends: 0, flat: FLAT },
  { pose: 'front', frontier: 0.55, ghosts: 0, trails: 0, zones: 0, threshold: 1, sweep: false, ends: 0, flat: FLAT },
];

const HOME: CameraPose = { position: [2.7, 4.3, 11.3], target: [0.15, 1.7, 0], fov: 36 };

const fmt = (v: number) => `${Math.round(v)}`;

/* scratch */
const m4 = new Matrix4();
const mUnflat = new Matrix4();
const ZERO = new Vector3();
const q = new Quaternion();
const qShape = new Quaternion();
const UP = new Vector3(0, 1, 0);
const vA = new Vector3();
const vB = new Vector3();
const vS = new Vector3();
const vScale = new Vector3();
const cTmp = new Color();
const cTmp2 = new Color();

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<ModelDatum[]>({
  json,
  meta: {
    camera: {
      ...HOME,
      minDistance: 5,
      maxDistance: 22,
      minPolar: 0.32,
      maxPolar: 1.56,
      minAzimuth: -1.2,
      maxAzimuth: 1.45,
      portrait: { position: [2.05, 4.55, 11.9], target: [0.2, 1.95, 0], fov: 44 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 60_000 },
  },
  guard: isModels,
  fixture: () => import('../../fixtures/model-galaxy.json'),

  create(ctx: SceneContext<ModelDatum[]>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'model-galaxy';
    scene.add(root);
    // Everything on the chart lives in `plot`, which can be flattened against the back wall (z scale
    // about the wall plane) for the 2D front steps; the ambient dust stays in `root`.
    const plot = new Group();
    plot.name = 'plot';
    root.add(plot);
    /** Non-star labels (axis furniture, frontier and cost-decline names), positioned in plot space so
     * they follow the flatten. Their live specs are kept so star labels can be placed clear of them. */
    const tags: LabelSpec[] = [];
    const addTag = (spec: LabelSpec): LabelHandle => {
      const live: LabelSpec = { ...spec, object: plot };
      const h = labels.add(live);
      tags.push(live);
      return {
        set(patch) {
          Object.assign(live, patch);
          h.set(patch);
        },
        remove() {
          h.remove();
        },
        get shown() {
          return h.shown;
        },
      };
    };
    // Measures label boxes exactly as the LabelLayer does (same element class, kind and swatch).
    const measurer = document.createElement('div');
    measurer.className = 'scene-label';
    measurer.setAttribute('aria-hidden', 'true');
    measurer.style.cssText = 'visibility:hidden;transform:none;left:-9999px;top:0';
    (ctx.stage.querySelector<HTMLElement>('.scene-labels') ?? ctx.stage).appendChild(measurer);
    const sizes = new Map<string, readonly [number, number]>();
    const measure = (text: string, kind: string, swatch: boolean): readonly [number, number] => {
      const key = `${kind}|${swatch ? 1 : 0}|${text}`;
      let sz = sizes.get(key);
      if (!sz) {
        measurer.dataset['kind'] = kind;
        measurer.textContent = '';
        if (swatch) {
          const i = document.createElement('i');
          i.className = 'scene-label-swatch';
          measurer.appendChild(i);
        }
        measurer.appendChild(document.createTextNode(text));
        sz = [Math.ceil(measurer.offsetWidth), Math.ceil(measurer.offsetHeight)];
        sizes.set(key, sz);
      }
      return sz;
    };
    const lights = addStudioLights(scene, ctx.palette);
    // A scatter plot is read through its labels: the axes alone need about 18 (titles, ticks, the
    // openness legend), so the low tier's 12 would leave no star names. Keep a floor of 30.
    const labelBudget = (maxLabels: number) => Math.max(LABEL_FLOOR, Math.round(maxLabels * 1.25));
    labels.setMax(labelBudget(ctx.tier.maxLabels));

    const models = buildModels(ctx.data ?? []);
    const n = models.length;
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const m of models)
      for (const p of m.track) {
        tMin = Math.min(tMin, p.t);
        tMax = Math.max(tMax, p.t);
      }
    if (!n) tMin = tMax = 0;
    tMin = Math.floor(tMin);
    tMax = Math.floor(tMax);
    const cps = checkpoints(tMin, tMax);

    const kindsPresent = KINDS.filter((k) => models.some((m) => m.kind === k));
    const mixed = kindsPresent.length > 1;
    // Scores of different kinds come from different benchmarks: start on the LLMs when mixed.
    let filter: KindFilter = models.some((m) => m.kind === 'llm') && models.some((m) => m.kind !== 'llm') ? 'llm' : 'all';
    let frontierText = '效率前沿';
    const frontierKind = (): Kind | null => (filter !== 'all' ? filter : kindsPresent.includes('llm') ? 'llm' : (kindsPresent[0] ?? null));
    const passes = (m: Model) => filter === 'all' || m.kind === filter;
    const inFrontier = (m: Model) => m.kind === frontierKind();
    /** Only LLM costs are per-million-token prices; other kinds carry an editorial cost index. */
    const priced = () => filter === 'llm' || (!mixed && kindsPresent[0] === 'llm');

    // Capability axis: fitted to the kinds on show (rescaled when the filter changes).
    let capLo = 0;
    let capHi = 100;
    const capTicks: number[] = [];
    const computeDomain = () => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of models) {
        if (!passes(m)) continue;
        for (const p of m.track) {
          lo = Math.min(lo, p.c);
          hi = Math.max(hi, p.c);
        }
      }
      if (!Number.isFinite(lo)) [lo, hi] = [0, 100];
      const step = hi - lo > 60 ? 20 : 10;
      capLo = Math.max(0, Math.floor((lo - 3) / step) * step);
      capHi = Math.min(100, Math.ceil((hi + 4) / step) * step);
      if (capHi - capLo < 2 * step) capHi = Math.min(100, capLo + 2 * step);
      capTicks.length = 0;
      for (let v = capLo; v <= capHi + 1e-6; v += step) capTicks.push(v);
    };
    computeDomain();

    /* ───────── stage: plinth, back wall, contact glow, dust ───────── */
    const plinthMat = materials.glass('fg', 0.05, { roughness: 0.4 });
    const plinthEdgeMat = materials.line('grid', { transparent: true, opacity: 0.9 });
    const wallMat = materials.glass('fg', 0.03);
    const shadowTex = ctx.track(radialTexture(256));
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    const stageGroup = new Group();
    plot.add(stageGroup);

    const dustTex = ctx.track(radialTexture(64));
    const dustMat = materials.bind(
      new PointsMaterial({ size: 0.07, map: dustTex, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: true }),
      'color',
      'fg',
    );
    const dustGeo = ctx.track(new BufferGeometry());
    {
      const pos: number[] = [];
      const rng = ctx.rng;
      let guard = 0;
      while (pos.length < 420 * 3 && guard++ < 5000) {
        const th = rng() * Math.PI * 2;
        const r = 6.5 + rng() * 10;
        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r * 0.75 - 2.5;
        const y = 2 + rng.normal() * 2.6;
        if (z > 4 && Math.abs(x) < 7) continue; // keep the space in front of the camera clear
        pos.push(x, y, z);
      }
      dustGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    }
    const dust = new Points(dustGeo, dustMat);
    dust.renderOrder = -2;
    root.add(dust);

    /* ───────── zones (step 封閉與開放) ───────── */
    const zoneClosedMat = materials.basic('muted', { transparent: true, opacity: 0, depthWrite: false });
    const zoneOpenMat = materials.basic('flow', { transparent: true, opacity: 0, depthWrite: false });
    const zoneGeo = ctx.track(new PlaneGeometry(1, 1));
    zoneGeo.rotateX(-Math.PI / 2);
    const zoneClosed = new Mesh(zoneGeo, zoneClosedMat);
    const zoneOpen = new Mesh(zoneGeo, zoneOpenMat);
    zoneClosed.renderOrder = zoneOpen.renderOrder = -1;
    plot.add(zoneClosed, zoneOpen);

    /* ───────── stars ───────── */
    const starMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.06 }));
    const shapeGeo: Record<Shape, BufferGeometry> = {
      sphere: ctx.track(new SphereGeometry(1, 24, 16)),
      diamond: ctx.track(new OctahedronGeometry(1.2, 0)),
      cube: ctx.track(new BoxGeometry(1.45, 1.45, 1.45)),
      tetra: ctx.track(new TetrahedronGeometry(1.35, 0)),
      dodeca: ctx.track(new DodecahedronGeometry(1.12, 0)),
      ring: ctx.track(new TorusGeometry(0.86, 0.3, 10, 26)),
    };
    const shapeRot: Record<Shape, Quaternion> = {
      sphere: new Quaternion(),
      diamond: new Quaternion(),
      cube: new Quaternion().setFromEuler(new Euler(0.42, 0.62, 0)),
      tetra: new Quaternion().setFromEuler(new Euler(-0.62, 0.8, 0.3)),
      dodeca: new Quaternion().setFromEuler(new Euler(0.3, 0.4, 0)),
      ring: new Quaternion().setFromEuler(new Euler(-0.35, 0.25, 0)),
    };
    const meshes = new Map<Shape, InstancedMesh>();
    for (const s of SHAPES) {
      const count = models.filter((m) => SHAPE_OF[m.kind] === s).length;
      if (!count) continue;
      const im = new InstancedMesh(shapeGeo[s], starMat, count);
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.setColorAt(0, cTmp.set(1, 1, 1));
      im.frustumCulled = false;
      im.name = `stars-${s}`;
      plot.add(im);
      ctx.track({ dispose: () => im.dispose() });
      meshes.set(s, im);
    }

    interface Star {
      m: Model;
      /** Hotspot id: the bare model id, so the page's hotspot list (Scene3D `hotspots`) links to it. */
      hid: string;
      mesh: InstancedMesh;
      idx: number;
      i: number;
      r: number;
      anchor: Object3D;
      cur: Vector3;
      /** `cur` in world space (after the flatten), for picking and label placement. */
      world: Vector3;
      target: Vector3;
      vis: number;
      visT: number;
      hot: number;
      hotT: number;
      phase: number;
      point: TrackPoint | null;
      trackPos: Vector3[];
      label: LabelHandle;
      /** Current label text (the short name, plus the frontier-end note in step 能力與成本). */
      text: string;
      frontier: boolean;
      /** Index into CANDS of the current label position. */
      cand: number;
      /** The last settled layout found no clear, unambiguous spot: the name stays hidden (card on hover). */
      noSpot: boolean;
      prio: number;
      rpx: number;
    }
    const RESERVED = new Set(json.hotspots.map((h) => h.id));
    const hidOf = (m: Model) => (RESERVED.has(m.id) ? `model-${m.id}` : m.id);
    const counters = new Map<Shape, number>();
    const stars: Star[] = models.map((m, i) => {
      const shape = SHAPE_OF[m.kind];
      const idx = counters.get(shape) ?? 0;
      counters.set(shape, idx + 1);
      const anchor = new Object3D();
      plot.add(anchor);
      const label = labels.add({
        text: m.short,
        object: anchor,
        align: 'right',
        offset: [4, 0],
        priority: 10,
        hotspot: hidOf(m),
      });
      return {
        m,
        hid: hidOf(m),
        mesh: meshes.get(shape)!,
        idx,
        i,
        r: RADIUS[m.size],
        anchor,
        cur: anchor.position,
        world: new Vector3(),
        target: new Vector3(),
        vis: 0,
        visT: 0,
        hot: 0,
        hotT: 0,
        phase: ctx.rng() * Math.PI * 2,
        point: null,
        trackPos: [],
        label,
        text: m.short,
        frontier: false,
        cand: 0,
        noSpot: false,
        prio: 0,
        rpx: 0,
      };
    });
    const starById = new Map(stars.map((s) => [s.m.id, s]));

    const glowExtra = cps.length + 2;
    const glows = ctx.track(new GlowSprites({ count: n + glowExtra, theme: ctx.theme }));
    glows.setCount(n);
    plot.add(glows.object);

    // Floor rings under each star.
    const ringGeo = ctx.track(new RingGeometry(0.62, 1, 28));
    ringGeo.rotateX(-Math.PI / 2);
    const feetMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
    const feet = new InstancedMesh(ringGeo, feetMat, Math.max(1, n));
    feet.instanceMatrix.setUsage(DynamicDrawUsage);
    feet.setColorAt(0, cTmp.set(1, 1, 1));
    feet.frustumCulled = false;
    feet.renderOrder = 1;
    plot.add(feet);
    ctx.track({ dispose: () => feet.dispose() });

    // One LineSegments for drop lines, frontier projectors and version trails (RGBA vertex colours).
    const trackPts = models.reduce((s, m) => s + m.track.length, 0);
    const lineCap = (n * 2 + trackPts) * 2 + 8;
    const linePos = new Float32Array(lineCap * 3);
    const lineCol = new Float32Array(lineCap * 4);
    const lineGeo = ctx.track(new BufferGeometry());
    const linePosAttr = new BufferAttribute(linePos, 3).setUsage(DynamicDrawUsage);
    const lineColAttr = new BufferAttribute(lineCol, 4).setUsage(DynamicDrawUsage);
    lineGeo.setAttribute('position', linePosAttr);
    lineGeo.setAttribute('color', lineColAttr);
    const lineMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const lines = new LineSegments(lineGeo, lineMat);
    lines.frustumCulled = false;
    lines.renderOrder = 2;
    plot.add(lines);

    // Rods: frontier, year-end frontiers, the cost-decline bar (opaque; fading = lerp to the background).
    const rodCap = n * (cps.length + 1) + 8;
    const rodGeo = ctx.track(new CylinderGeometry(1, 1, 1, 10, 1, true));
    const rodMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const rods = new InstancedMesh(rodGeo, rodMat, rodCap);
    rods.instanceMatrix.setUsage(DynamicDrawUsage);
    rods.setColorAt(0, cTmp.set(1, 1, 1));
    rods.frustumCulled = false;
    rods.count = 0;
    plot.add(rods);
    ctx.track({ dispose: () => rods.dispose() });

    // Dots: frontier joints on the wall, old versions on trails, cost-decline markers.
    const dotCap = n + trackPts + cps.length + 6;
    const dotGeo = ctx.track(new IcosahedronGeometry(1, 1));
    const dotMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    const dots = new InstancedMesh(dotGeo, dotMat, dotCap);
    dots.instanceMatrix.setUsage(DynamicDrawUsage);
    dots.setColorAt(0, cTmp.set(1, 1, 1));
    dots.frustumCulled = false;
    dots.count = 0;
    plot.add(dots);
    ctx.track({ dispose: () => dots.dispose() });

    const arrowMat = materials.basic('fg');
    const arrow = new Mesh(ctx.track(new ConeGeometry(0.075, 0.2, 14)), arrowMat);
    arrow.rotation.z = Math.PI / 2;
    arrow.visible = false;
    plot.add(arrow);

    // Axis highlight rods (shown while an axis hotspot is highlighted).
    const axisGlowMat = materials.basic('highlight', { transparent: true, opacity: 0.9, depthWrite: false });
    const axisRods = [0, 1, 2].map(() => {
      const r = new Mesh(rodGeo, axisGlowMat);
      r.visible = false;
      plot.add(r);
      return r;
    });

    /* ───────── layout-dependent parts ───────── */
    let L: Layout = ctx.size.aspect < 0.9 ? PORT : LAND;
    let axes: Axes3D | null = null;
    const origin = new Vector3();
    const wallZ = () => origin.z + 0.012;
    /** Plot space → world space (the flatten presses z towards the back wall). */
    const toWorld = (v: Vector3, out: Vector3) => out.set(v.x, v.y, origin.z + (v.z - origin.z) * fx.flat).applyMatrix4(root.matrix);
    const P = (ci: number, c: number, o: number, out = new Vector3()) => axes!.map(priceOf(ci), c, o, out);
    let stageObjects: { plinth: Mesh; edge: LineLoop; wall: Mesh; shadow: Mesh } | null = null;

    // Labels that are not stars.
    const titleCap = addTag({ text: '能力指數', align: 'above', kind: 'strong', priority: 28, hotspot: 'capability-axis' });
    const titleCost = addTag({ text: '成本（對數）', align: 'below', kind: 'default', priority: 26, hotspot: 'cost-axis' });
    const titleOpen = addTag({ text: '開放程度', align: 'above', kind: 'default', priority: 25, hotspot: 'openness-axis' });
    // Pools (the capability axis is refitted per filter; the cost ticks switch between $ and index).
    const capTickLabels = Array.from({ length: 12 }, () =>
      addTag({ text: '', align: 'left', kind: 'tag', priority: 29, hotspot: 'capability-axis', visible: false }),
    );
    const costTickLabels = Array.from({ length: 5 }, () =>
      addTag({ text: '', align: 'below', kind: 'tag', priority: 27, hotspot: 'cost-axis', visible: false }),
    );
    const openTicks = (['封閉', '開放權重', '完全開源'] as const).map((text) =>
      addTag({ text, align: 'right', kind: 'tag', priority: 12, hotspot: 'openness-axis' }),
    );
    const frontierLabel = addTag({ text: '效率前沿', align: 'above', kind: 'strong', priority: 32, hotspot: 'frontier', visible: false });
    const timeLabel = addTag({ text: '', align: 'right', kind: 'strong', priority: 40, always: true, visible: false });
    // Honesty note for the time views: the trails and old frontiers only cover families whose data
    // carries earlier versions (see `history` in data.ts).
    const coverageLabel = addTag({ text: '', align: 'left', kind: 'tag', priority: 39, visible: false });
    let coverageText = '';
    const zoneLabels = [
      addTag({ text: '封閉：只能透過 API／App 使用', align: 'right', kind: 'default', priority: 30, visible: false, hotspot: 'openness-axis' }),
      addTag({ text: '開放權重：可下載、自行部署', align: 'right', kind: 'default', priority: 30, visible: false, hotspot: 'openness-axis' }),
    ];
    // Checkpoint names sit right of each old frontier's expensive end (they are the key to step 前沿移動).
    const ghostLabels = cps.map(() => addTag({ text: '', align: 'right', offset: [14, 0], kind: 'tag', priority: 30, visible: false }));
    const thresholdLabel = addTag({ text: '', align: 'right', kind: 'tag', priority: 33, visible: false, hotspot: 'cost-decline' });
    const declineText = `同樣能力，成本一路下降${ctx.isFixture ? '（示意）' : ''}`;
    const declineLabel = addTag({
      text: declineText,
      align: 'above',
      kind: 'default',
      priority: 34,
      visible: false,
      hotspot: 'cost-decline',
    });
    const markerLabels = Array.from({ length: cps.length + 2 }, () =>
      addTag({ text: '', align: 'below', kind: 'default', priority: 36, visible: false, hotspot: 'cost-decline' }),
    );

    /** Axes (refitted per filter) and every position that depends on them. */
    const buildAxes = (snap: boolean) => {
      axes?.dispose();
      const [sx, sy, sz] = L.size;
      origin.set(-sx / 2, 0, -sz / 2);
      // Kit Axes3D draws the box, grid and axis lines; every tick label is ours (pooled, placed clear
      // of each other), so the kit's own labels are blank.
      const xTicks = priced() ? [0.1, 1, 10, 100] : [0, 25, 50, 75, 100].map(priceOf);
      axes = new Axes3D({
        size: L.size,
        origin,
        x: { label: '', domain: PRICE_DOMAIN, scale: 'log', ticks: xTicks, format: () => '' },
        y: { label: '', domain: [capLo, capHi], ticks: capTicks, format: () => '' },
        z: { label: '', domain: OPEN_DOMAIN, ticks: [0, 0.5, 1], format: () => '' },
        grid: ['xz', 'xy'],
        labels,
        materials,
      });
      plot.add(axes.group);

      const front = origin.z + sz;
      capTickLabels.forEach((l, j) => {
        const v = capTicks[j];
        l.set(v === undefined ? { visible: false } : { visible: true, text: `${v}`, position: [origin.x - 0.06, P(0, v, 0).y, front] });
      });
      costTickLabels.forEach((l, j) => {
        const v = xTicks[j];
        const text = v === undefined ? '' : priced() ? `$${v}` : `${Math.round((100 * Math.log(v / PRICE_DOMAIN[0])) / Math.log(PRICE_DOMAIN[1] / PRICE_DOMAIN[0]))}`;
        l.set(v === undefined ? { visible: false } : { visible: true, text, position: [axes!.map(v, capLo, 0).x, 0, front + 0.14] });
      });
      // The title hangs below the plinth, so it clears the tick row from every camera angle.
      titleCost.set({
        text: priced() ? '成本（對數）：每百萬 token 美元' : '成本（對數）：成本指數',
        position: [origin.x + sx * 0.5, -0.5, front + 0.2],
      });
      titleCap.set({ position: [origin.x, sy + 0.18, front] });

      for (const s of stars) s.trackPos = s.m.track.map((p) => P(p.ci, p.c, p.o));
      computeStatic();
      applyTime(snap);
    };

    const buildLayout = () => {
      const [sx, sy, sz] = L.size;
      buildAxes(true);

      // Plinth, wall and contact glow.
      if (stageObjects) {
        for (const o of Object.values(stageObjects)) {
          o.removeFromParent();
          o.geometry.dispose();
        }
      }
      const pw = sx + 1.0;
      const pd = sz + 1.0;
      const shape = roundedRect(pw, pd, 0.32);
      const pg = new ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false, curveSegments: 6 });
      pg.rotateX(-Math.PI / 2);
      pg.translate(0, -0.085, 0.05);
      const plinth = new Mesh(pg, plinthMat);
      plinth.renderOrder = -1;
      const edge = new LineLoop(new BufferGeometry().setFromPoints(shape.getPoints(8).map((p) => new Vector3(p.x, -0.012, -p.y + 0.05))), plinthEdgeMat);
      const wall = new Mesh(new PlaneGeometry(sx, sy), wallMat);
      wall.position.set(0, sy / 2, origin.z);
      wall.renderOrder = -1;
      const shadow = new Mesh(new PlaneGeometry(pw * 1.7, pd * 2.1), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(0, -0.1, 0.05);
      for (const o of [plinth, edge, wall, shadow]) {
        o.matrixAutoUpdate = false;
        o.updateMatrix();
        stageGroup.add(o);
      }
      stageObjects = { plinth, edge, wall, shadow };

      // Zones on the floor (openness bands).
      const zc0 = P(0, capLo, OPEN_DOMAIN[0]).z;
      const zc1 = P(0, capLo, 0.25).z;
      const zo0 = P(0, capLo, 0.45).z;
      const zo1 = P(0, capLo, OPEN_DOMAIN[1]).z;
      zoneClosed.scale.set(sx, 1, zc1 - zc0);
      zoneClosed.position.set(0, 0.004, (zc0 + zc1) / 2);
      zoneOpen.scale.set(sx, 1, zo1 - zo0);
      zoneOpen.position.set(0, 0.004, (zo0 + zo1) / 2);
      zoneLabels[0]!.set({ position: [origin.x + sx + 0.1, 0.02, (zc0 + zc1) / 2] });
      zoneLabels[1]!.set({ position: [origin.x + sx + 0.1, 0.02, (zo0 + zo1) / 2] });

      // Titles.
      // Openness reads like a vertical legend on the right: the title above the back end of the axis,
      // then 封閉 → 開放權重 → 完全開源 coming towards the viewer.
      titleOpen.set({ position: [origin.x + sx + 0.32, 0.12, P(0, capLo, 0).z - 0.1], offset: [0, -16] });
      [0, 0.5, 1].forEach((o, j) => openTicks[j]!.set({ position: [origin.x + sx + 0.4, 0, P(0, capLo, o).z] }));
      timeLabel.set({ position: [origin.x + 0.12, sy - 0.2, origin.z] });
      coverageLabel.set({ position: [origin.x + sx - 0.12, sy - 0.2, origin.z] });

      // Axis highlight rods.
      setRodMesh(axisRods[0]!, vA.set(origin.x, 0, origin.z + sz), vB.set(origin.x, sy, origin.z + sz), 0.028);
      setRodMesh(axisRods[1]!, vA.set(origin.x, 0, origin.z + sz), vB.set(origin.x + sx, 0, origin.z + sz), 0.028);
      setRodMesh(axisRods[2]!, vA.set(origin.x + sx, 0, origin.z), vB.set(origin.x + sx, 0, origin.z + sz), 0.028);
    };

    /* ───────── static analyses (per filter) ───────── */
    interface Ghost {
      label: string;
      t: number;
      pts: Vector3[];
    }
    let ghosts: Ghost[] = [];
    interface Marker {
      t: number;
      label: string;
      name: string;
      pos: Vector3;
    }
    let markers: Marker[] = [];
    let declineY = 0;
    let thresholdText = '';
    const computeStatic = () => {
      // The frontier as it stood at each checkpoint (year or half-year end).
      ghosts = [];
      for (const cp of cps) {
        const f = frontierAt(models, cp.t, inFrontier);
        if (f.length >= 2) ghosts.push({ label: cp.label, t: cp.t, pts: f.map((x) => P(x.p.ci, x.p.c, x.p.o).setZ(wallZ())) });
      }
      // Cost decline: fix the best score of the first checkpoint, then find the cheapest model that
      // reaches it at every later checkpoint (and today).
      markers = [];
      const first = ghosts[0];
      if (first) {
        const cap = Math.max(...frontierAt(models, first.t, inFrontier).map((x) => x.p.c));
        declineY = P(0, cap, 0).y;
        // With few families carrying earlier versions, the bar is only the best score in the data then.
        thresholdText = `能力門檻：${first.label}${coverageOf() ? '資料中' : ''}的最高分`;
        thresholdLabel.set({ text: thresholdText });
        let prev = Infinity;
        const at = [...cps.filter((c) => c.t >= first.t), { t: tMax + 0.99, label: formatMonth(tMax) }];
        for (const cp of at) {
          const c = cheapestAt(models, cp.t, cap, inFrontier);
          if (c && c.p.ci < prev - 0.5) {
            prev = c.p.ci;
            markers.push({ t: cp.t, label: cp.label, name: c.m.short, pos: P(c.p.ci, cap, 0).setZ(wallZ() + 0.02) });
          }
        }
        if (markers.length < 2) markers = [];
      }
    };

    /* ───────── time ───────── */
    let T = tMax;
    let frontierStars: Star[] = [];
    let dirty = true;
    const applyTime = (snap = false) => {
      for (const s of stars) {
        const p = pointAt(s.m, Math.floor(T) + 0.99);
        s.point = p;
        if (!p) {
          s.visT = 0;
          continue;
        }
        const k = s.m.track.indexOf(p);
        s.target.copy(s.trackPos[k] ?? s.target);
        s.visT = passes(s.m) ? 1 : 0;
        if (s.vis < 0.02 || snap) s.cur.copy(s.target);
      }
      const f = frontierAt(models, Math.floor(T) + 0.99, inFrontier);
      frontierStars = f.map((x) => starById.get(x.m.id)!).filter(Boolean);
      for (const s of stars) s.frontier = false;
      for (const s of frontierStars) s.frontier = true;
      starLabelStyle();
      ui?.setTime(T);
      dirty = true;
      ctx.invalidate();
    };
    const starLabelStyle = () => {
      const cfg = STEPS[ctx.step] ?? STEPS[0]!;
      const quiet = cfg.threshold > 0.5 ? -12 : 0; // the cost-decline markers own the labels in that step
      // Step 能力與成本 names the two ends of the frontier in the star labels themselves.
      const ends = cfg.ends > 0.5 && frontierStars.length > 1;
      const top = ends ? frontierStars[frontierStars.length - 1] : null;
      const low = ends ? frontierStars[0] : null;
      for (const s of stars) {
        const tw = s.m.region === 'tw' ? 4 : 0;
        const end = s === top ? '（最強旗艦）' : s === low ? '（高 CP 值）' : '';
        s.text = s.m.short + end;
        // The fraction (capability, then index) breaks ties, so this placement and the LabelLayer's
        // own priority sort agree on who gets a crowded spot first.
        s.prio = 8 + Math.round((s.point?.c ?? 0) / 8) + (s.frontier ? 8 : 0) + tw + quiet + (end ? 14 : 0) + (s.point?.c ?? 0) / 1000 + s.i / 1e5;
        s.label.set({ text: s.text, priority: s.prio, kind: s.frontier ? 'default' : 'tag' });
      }
      placeDirty = true;
    };
    /** Filter change: refit the capability axis, then let the stars glide to their new heights. */
    const applyFilter = (snap = false) => {
      computeDomain();
      buildAxes(snap);
      setFrontierText();
      refreshPicks();
    };
    function setFrontierText() {
      const fk = frontierKind();
      frontierText = mixed && fk ? `效率前沿（${KIND_CHIP[fk]}）` : '效率前沿';
      frontierLabel.set({ text: frontierText });
      coverageText = coverageOf();
    }
    /** The honesty note for the time views when few families of the frontier's kind carry earlier versions. */
    function coverageOf() {
      const fk = frontierKind();
      const fam = models.filter((m) => m.kind === fk);
      const withHistory = fam.filter((m) => m.track.length > 1).length;
      return fam.length && withHistory / fam.length < 0.75 ? `早期版本僅涵蓋 ${withHistory}／${fam.length} 個系列` : '';
    }

    /* ───────── effects (tweened per step) ───────── */
    const fx = { frontier: 0, ghosts: 0, trails: 0, zones: 0, threshold: 0, ends: 0, flat: 1, frontierHot: 0, declineHot: 0 };
    let trailFocus: Star | null = null;
    let fxTween: { cancel(): void } | null = null;
    const setFx = (cfg: StepCfg) => {
      fxTween?.cancel();
      const from = { ...fx };
      const to = { frontier: cfg.frontier, ghosts: cfg.ghosts, trails: cfg.trails, zones: cfg.zones, threshold: cfg.threshold, ends: cfg.ends, flat: cfg.flat };
      if (!ctx.animate) from.flat = fx.flat = to.flat; // no squash animation under reduced motion
      fxTween = ctx.tween.run(
        (k) => {
          for (const key of Object.keys(to) as (keyof typeof to)[]) fx[key] = from[key] + (to[key] - from[key]) * k;
          if (from.flat !== to.flat) placeDirty = true;
          dirty = true;
        },
        { duration: 650, fade: true },
      );
    };

    /* ───────── palette ───────── */
    const regionColor: Record<Region, Color> = { us: new Color(), cn: new Color(), eu: new Color(), tw: new Color(), other: new Color() };
    const regionCss: Record<Region, string> = { us: '', cn: '', eu: '', tw: '', other: '' };
    const cHi = new Color();
    const cBg = new Color();
    const cInk = new Color();
    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      lights.apply(p);
      const pick = (i: number) => p.chart[i] ?? p.fg;
      regionColor.us.copy(pick(0));
      regionColor.cn.copy(pick(1));
      regionColor.eu.copy(pick(6));
      regionColor.tw.copy(p.twAccent);
      regionColor.other.copy(pick(2));
      regionCss.us = p.css['chart-1'] ?? '';
      regionCss.cn = p.css['chart-2'] ?? '';
      regionCss.eu = p.css['chart-7'] ?? '';
      regionCss.tw = p.css['scene-tw-accent'] ?? '';
      regionCss.other = p.css['chart-3'] ?? '';
      cHi.copy(p.highlight);
      cBg.copy(p.bg);
      // The cost-decline marker is neutral ink, so it never reads as one of the region colours.
      cInk.copy(p.fg).lerp(p.bg, dark ? 0.08 : 0.12);
      starMat.emissive.copy(p.fg).multiplyScalar(dark ? 0.06 : 0);
      starMat.roughness = dark ? 0.3 : 0.38;
      shadowMat.color.copy(dark ? p.flow : p.fg);
      shadowMat.opacity = dark ? 0.07 : 0.06;
      plinthMat.opacity = dark ? 0.07 : 0.05;
      wallMat.opacity = dark ? 0.035 : 0.028;
      dustMat.opacity = dark ? 0.5 : 0.22;
      dustMat.size = dark ? 0.07 : 0.055;
      feetMat.opacity = dark ? 0.6 : 0.7;
      glows.setTheme(p.theme);
      for (const s of stars) s.label.set({ swatch: regionCss[s.m.region] });
      const hiCss = p.css['scene-highlight'] ?? '';
      const inkCss = p.css['scene-fg'] ?? '';
      for (const l of [frontierLabel, ...ghostLabels]) l.set({ swatch: hiCss });
      for (const l of [declineLabel, thresholdLabel, ...markerLabels]) l.set({ swatch: inkCss });
      ui?.setRegionColors(regionCss);
      dirty = true;
    };

    /* ───────── per-frame write ───────── */
    let li = 0;
    const pushLine = (a: Vector3, b: Vector3, c: Color, alphaA: number, alphaB = alphaA) => {
      if (li + 2 > lineCap) return;
      linePos.set([a.x, a.y, a.z, b.x, b.y, b.z], li * 3);
      lineCol.set([c.r, c.g, c.b, alphaA, c.r, c.g, c.b, alphaB], li * 4);
      li += 2;
    };
    let ri = 0;
    const pushRod = (a: Vector3, b: Vector3, radius: number, c: Color) => {
      if (ri >= rodCap) return;
      vS.subVectors(b, a);
      const len = vS.length();
      if (len < 1e-4) return;
      q.setFromUnitVectors(UP, vS.normalize());
      vS.addVectors(a, b).multiplyScalar(0.5);
      rods.setMatrixAt(ri, m4.compose(vS, q, vScale.set(radius, len, radius)));
      rods.setColorAt(ri, c);
      ri++;
    };
    let di = 0;
    const pushDot = (p: Vector3, radius: number, c: Color) => {
      if (di >= dotCap) return;
      dots.setMatrixAt(di, m4.compose(p, q.identity(), vScale.setScalar(radius)));
      dots.setColorAt(di, c);
      di++;
    };
    /** Cost-decline name rows (screen x spans [x0, x1, …]): below 0–2 and above 0–2 of the bar. */
    const rowSpans: number[][] = [[], [], [], [], [], []];
    const ROW_SLOTS = [
      ['below', 0],
      ['above', 0],
      ['below', 1],
      ['above', 1],
      ['below', 2],
      ['above', 2],
    ] as const;
    /** Row pitch (one label plus the LabelLayer's padding and 4 px grid) and the rows that fit
     * between the bar and the chart's floor / top (set per frame from the projected chart). */
    const rows = { pitch: 34, below: 3, above: 3 };
    /** First free row slot (index into ROW_SLOTS) for a span, or -1. `max` caps the rows tried per side. */
    const claimRow = (x0: number, x1: number, max: number, only?: 'below') => {
      for (let k = 0; k < ROW_SLOTS.length; k++) {
        const [side, row] = ROW_SLOTS[k]!;
        if ((only && side !== only) || row >= Math.min(max, side === 'below' ? rows.below : rows.above)) continue;
        const spans = rowSpans[k]!;
        let free = true;
        for (let j = 0; j < spans.length && free; j += 2) if (x1 > spans[j]! && x0 < spans[j + 1]!) free = false;
        if (free) {
          spans.push(x0, x1);
          return k;
        }
      }
      return -1;
    };
    const fade = (c: Color, a: number) => cTmp2.copy(c).lerp(cBg, (1 - Math.max(0, Math.min(1, a))) * (ctx.theme === 'dark' ? 1 : 0.8));

    const write = (t: number) => {
      const dark = ctx.theme === 'dark';
      li = ri = di = 0;
      plot.scale.z = fx.flat;
      plot.position.z = origin.z * (1 - fx.flat);
      // Floor rings fade out as the box flattens (they would read as dashes on the baseline).
      const feetK = Math.min(1, Math.max(0, (fx.flat - 0.15) / 0.5));
      // Stars keep their round, lit shape while the plot flattens: undo the z squash per instance.
      const unflat = fx.flat < 0.999;
      mUnflat.makeScale(1, 1, 1 / Math.max(fx.flat, 1e-3));
      // Stars, halos, feet, drop lines.
      let fi = 0;
      for (const s of stars) {
        toWorld(s.cur, s.world);
        const shown = s.vis > 0.004;
        const k = s.vis * (1 + 0.32 * s.hot);
        qShape.copy(shapeRot[SHAPE_OF[s.m.kind]]);
        m4.compose(ZERO, qShape, vB.setScalar(shown ? s.r * k : 0));
        if (unflat) m4.premultiply(mUnflat);
        s.mesh.setMatrixAt(s.idx, m4.setPosition(s.cur));
        cTmp.copy(regionColor[s.m.region]).lerp(cBg, 0.45 * fx.threshold * (1 - s.hot));
        s.mesh.setColorAt(s.idx, cTmp);
        const tw = ctx.animate ? 0.07 * Math.sin(t * 0.9 + s.phase) : 0;
        const a = s.vis * (1 - 0.55 * fx.threshold) * ((dark ? 0.5 : 0.32) + (s.frontier ? 0.12 : 0) + 0.4 * s.hot + tw);
        glows.set(s.i, s.cur, s.r * (dark ? 7.5 : 5.2) * (1 + 0.4 * s.hot), regionColor[s.m.region], Math.max(0, a));
        if (shown) {
          vA.set(s.cur.x, 0.006, s.cur.z);
          feet.setMatrixAt(fi, m4.compose(vA, q.identity(), vB.setScalar(s.r * 0.95 * s.vis * feetK)));
          feet.setColorAt(fi, cTmp.copy(regionColor[s.m.region]).lerp(cBg, 0.25));
          fi++;
          const la = s.vis * (dark ? 0.42 : 0.5) * (1 - 0.5 * fx.threshold);
          pushLine(vA, vB.set(s.cur.x, s.cur.y - s.r * 0.9, s.cur.z), regionColor[s.m.region], la * 0.35, la);
        }
        s.label.set({ visible: s.vis > 0.5 && !s.noSpot });
      }
      feet.count = fi;

      // Version trails (all in the sweep step, or the hovered star's own trail).
      for (const s of stars) {
        const focus = trailFocus === s ? 1 : 0;
        const a = Math.max(fx.trails, focus) * s.vis;
        if (a < 0.01 || !s.point) continue;
        const kLast = s.m.track.indexOf(s.point);
        for (let j = 0; j < kLast; j++) {
          const p0 = s.trackPos[j]!;
          const p1 = j + 1 === kLast ? s.cur : s.trackPos[j + 1]!;
          pushLine(p0, p1, regionColor[s.m.region], a * (dark ? 0.5 : 0.6) * (0.5 + (0.5 * (j + 1)) / kLast));
          pushDot(p0, 0.035, fade(regionColor[s.m.region], a * 0.9));
        }
      }

      // Checkpoint frontiers (faded copies of the frontier line on the wall).
      for (let gi = ghosts.length; gi < ghostLabels.length; gi++) ghostLabels[gi]!.set({ visible: false });
      ghosts.forEach((g, gi) => {
        const on = fx.ghosts * (g.t < Math.floor(T) + 0.49 ? 1 : 0);
        const lab = ghostLabels[gi];
        if (on < 0.01) {
          lab?.set({ visible: false });
          return;
        }
        const age = (ghosts.length - gi) / (ghosts.length + 1);
        const col = fade(cHi, on * (0.85 - 0.5 * age));
        const z = wallZ() - 0.004 * (gi + 1);
        for (let j = 0; j + 1 < g.pts.length; j++) pushRod(vA.copy(g.pts[j]!).setZ(z), vB.copy(g.pts[j + 1]!).setZ(z), 0.012, col);
        const top = g.pts[g.pts.length - 1]!;
        lab?.set({ visible: on > 0.4, text: g.label, position: [top.x, top.y, z] });
      });

      // Current frontier on the wall, projectors from its stars.
      const fa = Math.min(1, fx.frontier + 0.6 * fx.frontierHot);
      const members = frontierStars.filter((s) => s.vis > 0.02);
      if (fa > 0.01 && members.length) {
        // On light backgrounds the amber highlight needs full strength to read as a line.
        const col = fade(cHi, dark ? fa : Math.min(1, fa * 1.25));
        const rodR = 0.026 * (dark ? 1 : 1.2) * (1 + 0.4 * fx.frontierHot);
        const z = wallZ();
        for (let j = 0; j < members.length; j++) {
          const s = members[j]!;
          vA.set(s.cur.x, s.cur.y, z);
          pushDot(vA, 0.05 * (1 + 0.5 * fx.frontierHot), col);
          pushLine(s.cur, vA, cHi, 0.0, fa * (dark ? 0.55 : 0.65) * s.vis);
          if (j + 1 < members.length) {
            const s2 = members[j + 1]!;
            pushRod(vA, vB.set(s2.cur.x, s2.cur.y, z), rodR, col);
          }
        }
        const top = members[members.length - 1]!;
        // Name the line at the middle of its longest segment (the top end belongs to the flagship's label).
        let best = -1;
        for (let j = 0; j + 1 < members.length; j++) {
          const a = members[j]!.cur;
          const b = members[j + 1]!.cur;
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d > best) {
            best = d;
            frontierAnchor.set(a.x + (b.x - a.x) * 0.5, a.y + (b.y - a.y) * 0.5 + 0.04, z);
          }
        }
        if (best < 0) frontierAnchor.set(top.cur.x, top.cur.y + 0.12, z);
        frontierLabel.set({ visible: fa > 0.35, position: frontierAnchor });
      } else {
        frontierLabel.set({ visible: false });
      }

      // Cost decline at a fixed capability bar: a dashed threshold across the wall, the cheapest model
      // that clears it at each checkpoint, and an arrow towards cheaper.
      const ta = Math.min(1, fx.threshold + fx.declineHot);
      const shownMarkers = markers.filter((mk) => mk.t <= Math.floor(T) + 1.5);
      if (ta > 0.01 && shownMarkers.length >= 2) {
        const col = fade(cInk, ta);
        const [sx] = L.size;
        const z = wallZ() + 0.01;
        const DASH = 0.11;
        for (let x = origin.x; x < origin.x + sx - 1e-3; x += DASH * 2)
          pushLine(vA.set(x, declineY, z), vB.set(Math.min(x + DASH, origin.x + sx), declineY, z), cInk, ta * (dark ? 0.55 : 0.6));
        // Name the bar outside the chart's right edge when it fits there, else above the bar's right end.
        const end = ctx.project(toWorld(vA.set(origin.x + sx, declineY, z), vB));
        const tw = measure(thresholdText, 'tag', true)[0];
        const wide = !!end && end.x + tw + 16 < ctx.size.width;
        thresholdLabel.set({ visible: ta > 0.5, position: [origin.x + sx, declineY, z], align: wide ? 'right' : 'left', offset: wide ? [2, 0] : [-4, -13] });
        const a = shownMarkers[0]!.pos;
        const b = shownMarkers[shownMarkers.length - 1]!.pos;
        pushRod(vA.copy(a), vB.copy(b).setX(b.x - 0.16), 0.02, col);
        // Pack the names into rows above and below the bar, so on a narrow stage they stack instead of
        // being dropped by the LabelLayer: the threshold name (when it cannot sit outside the chart),
        // then the first and the latest marker (the two ends of the story), the others, and the drop
        // note last (the step caption says the same, so on a crowded phone stage it may give way).
        for (const r of rowSpans) r.length = 0;
        const GAP = 8;
        // How many rows fit between the bar and the chart's floor (clear of the cost ticks) and top.
        const lh = measure('同', 'default', true)[1];
        rows.pitch = lh + 10;
        const yBar = ctx.project(toWorld(vA.set(origin.x, declineY, z), vB))?.y ?? 0;
        const yFloor = ctx.project(toWorld(vA.set(origin.x, 0, z), vB))?.y ?? ctx.size.height;
        const yTop = ctx.project(toWorld(vA.set(origin.x, L.size[1], z), vB))?.y ?? 0;
        rows.below = Math.max(1, Math.floor((yFloor - yBar - 8 - lh) / rows.pitch) + 1);
        rows.above = Math.max(1, Math.floor((yBar - yTop - 8 - lh) / rows.pitch) + 1);
        if (!wide && end) rowSpans[1]!.push(end.x - 14 - tw - GAP, end.x - 14 + GAP);
        const order = shownMarkers.map((_, j) => j);
        if (order.length > 2) order.splice(1, 0, order.pop()!);
        const decline = { k: -1, x: 0 };
        const placeDecline = () => {
          // Under the middle of the biggest step (clear of the marker names at both ends).
          let gap = -1;
          for (let j = 0; j + 1 < shownMarkers.length; j++) {
            const p0 = shownMarkers[j]!.pos;
            const p1 = shownMarkers[j + 1]!.pos;
            if (Math.abs(p0.x - p1.x) > gap) {
              gap = Math.abs(p0.x - p1.x);
              declineAnchor.set((p0.x + p1.x) / 2, declineY, b.z);
            }
          }
          const dp = ctx.project(toWorld(declineAnchor, vB));
          if (!dp) return;
          const half = measure(declineText, 'default', true)[0] / 2;
          // Keep the note inside the stage.
          decline.x = Math.max(half + 6 - dp.x, Math.min(0, ctx.size.width - 6 - half - dp.x));
          decline.k = claimRow(dp.x + decline.x - half - GAP, dp.x + decline.x + half + GAP, 3, 'below');
          if (decline.k < 0) decline.k = claimRow(dp.x + decline.x - half - GAP, dp.x + decline.x + half + GAP, 3);
        };
        order.forEach((j) => {
          const mk = shownMarkers[j]!;
          pushDot(mk.pos, 0.07, col);
          // Centre the label on its marker, but slide it inwards near the chart's ends (clear of the ticks).
          const text = `${mk.label}・${mk.name}`;
          const u = (mk.pos.x - origin.x) / sx;
          const shift = u < 0.3 ? 1 : u > 0.7 ? -1 : 0;
          const mw = measure(text, 'default', true)[0];
          const ox = shift * (mw / 2 + 6);
          const mp = ctx.project(toWorld(mk.pos, vB));
          const k = mp ? claimRow(mp.x + ox - mw / 2 - GAP, mp.x + ox + mw / 2 + GAP, 3) : j % 2;
          const [align, row] = ROW_SLOTS[Math.max(0, k)]!;
          markerLabels[j]?.set({
            visible: ta > 0.5 && k >= 0,
            text,
            position: mk.pos,
            align,
            offset: [ox, (align === 'below' ? 1 : -1) * row * rows.pitch],
          });
          glows.set(n + j, mk.pos, 0.5, cInk, ta * (dark ? 0.45 : 0.3));
        });
        placeDecline();
        for (let j = shownMarkers.length; j < markerLabels.length; j++) markerLabels[j]!.set({ visible: false });
        glows.setCount(n + Math.min(glowExtra, shownMarkers.length));
        arrow.visible = true;
        arrow.position.set(b.x - 0.24, b.y, b.z);
        arrow.scale.setScalar(Math.max(0.01, ta));
        // The drop note: under the bar (else above it), in the first row clear of the marker names.
        const [dSide, dRow] = ROW_SLOTS[Math.max(0, decline.k)]!;
        declineLabel.set({
          visible: ta > 0.5 && decline.k >= 0,
          position: declineAnchor,
          align: dSide,
          offset: [decline.x, (dSide === 'below' ? 1 : -1) * dRow * rows.pitch],
        });
      } else {
        arrow.visible = false;
        declineLabel.set({ visible: false });
        thresholdLabel.set({ visible: false });
        for (const l of markerLabels) l.set({ visible: false });
        glows.setCount(n);
      }

      // Zones.
      zoneClosedMat.opacity = fx.zones * (dark ? 0.2 : 0.16);
      zoneOpenMat.opacity = fx.zones * (dark ? 0.16 : 0.14);
      zoneClosed.visible = zoneOpen.visible = fx.zones > 0.01;
      zoneLabels.forEach((l) => l.set({ visible: fx.zones > 0.5 }));
      openTicks.forEach((l) => l.set({ visible: fx.zones < 0.5 && fx.flat > 0.5 }));
      titleOpen.set({ visible: fx.flat > 0.5 });

      // Time headline.
      const timeShown = T < tMax - 0.5 || sweeping;
      timeLabel.set({ visible: timeShown, text: `截至 ${formatMonth(T)}` });
      coverageLabel.set({ visible: !!coverageText && (timeShown || fx.ghosts > 0.5 || fx.threshold > 0.5), text: coverageText });

      lineGeo.setDrawRange(0, li);
      lines.visible = li > 0;
      linePosAttr.needsUpdate = true;
      lineColAttr.needsUpdate = true;
      rods.count = ri;
      dots.count = di;
      rods.visible = ri > 0;
      dots.visible = di > 0;
      feet.visible = feet.count > 0;
      for (const im of [...meshes.values(), feet, rods, dots]) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    };
    /* ───────── star label placement ─────────
     * The LabelLayer has one alignment per label. Stars cluster (closed frontier models above all), so
     * each time the view changes we greedily give every star label the first side (current, right,
     * left, above, below) that clears the star discs, higher-priority labels and the HTML controls. */
    let placeDirty = true;
    let lastFlat = -1;
    let lastPlace = 0;
    let obstacles: { x: number; y: number; w: number; h: number }[] = [];
    let obstaclesAt = -1e9;
    const camSig = new Matrix4();
    let fovSig = 0;
    /** Screen boxes [x, y, w, h, …] of labels and HTML controls, and of the star discs. */
    const boxes: number[] = [];
    const discs: number[] = [];
    const hits = (list: readonly number[], x: number, y: number, w: number, h: number) => {
      for (let i = 0; i < list.length; i += 4)
        if (x < list[i]! + list[i + 2]! && x + w > list[i]! && y < list[i + 1]! + list[i + 3]! && y + h > list[i + 1]!) return true;
      return false;
    };
    /** Distance from a point to a box (0 inside). */
    const boxDist = (px: number, py: number, bx: number, by: number, w: number, h: number) =>
      Math.hypot(Math.max(bx - px, 0, px - bx - w), Math.max(by - py, 0, py - by - h));
    /** `fresh`: the view has settled, so place from scratch (deterministic); otherwise each label
     * keeps its current side while it still fits, so labels do not jump around during motion. */
    const placeLabels = (now: number, fresh: boolean) => {
      const W = ctx.size.width;
      const H = ctx.size.height;
      const cam = ctx.camera;
      if (now - obstaclesAt > 600) {
        obstacles = ui?.obstacles() ?? [];
        obstaclesAt = now;
      }
      boxes.length = 0;
      discs.length = 0;
      for (const o of obstacles) boxes.push(o.x, o.y, o.w, o.h);
      const k = H / (2 * Math.tan((cam.fov * Math.PI) / 360));
      const live: { s: Star; x: number; y: number }[] = [];
      for (const s of stars) {
        if (s.vis < 0.5) continue;
        vA.copy(s.world).project(cam);
        if (vA.z > 1) continue;
        const x = ((vA.x + 1) / 2) * W;
        const y = ((1 - vA.y) / 2) * H;
        s.rpx = (s.r * root.scale.x * (1 + 0.32 * s.hot) * k) / Math.max(0.1, cam.position.distanceTo(s.world));
        // A round star only fills the middle of its bounding square: reserve a slightly smaller box.
        const rb = s.rpx * 0.82;
        discs.push(x - rb, y - rb, 2 * rb, 2 * rb);
        live.push({ s, x, y });
      }
      // Every other label shown (they all outrank star labels in the LabelLayer).
      for (const t of tags) {
        if (t.visible === false || !t.text || !t.position) continue;
        const p = t.position;
        if (Array.isArray(p)) vB.set(p[0], p[1], p[2]);
        else vB.copy(p as Vector3);
        toWorld(vB, vA).project(cam);
        if (vA.z > 1) continue;
        const [w, h] = measure(t.text, t.kind ?? 'default', !!t.swatch);
        const px = ((vA.x + 1) / 2) * W + (t.offset?.[0] ?? 0);
        const py = ((1 - vA.y) / 2) * H + (t.offset?.[1] ?? 0);
        const a = t.align ?? 'center';
        const bx = a === 'left' ? px - w - 10 : a === 'right' ? px + 10 : px - w / 2;
        const by = a === 'above' ? py - h - 8 : a === 'below' ? py + 8 : py - h / 2;
        boxes.push(bx, by, w, h);
      }
      live.sort((a, b) => b.s.prio - a.s.prio);
      /** A label must read as its own star's name. Beside a star (left / right): the box must be clearly
       * nearer that star than any other. Centred above or below it the eye joins the name to the star
       * under (over) its middle, so plain box distance is too strict there (it hid names such as
       * Gemini's next to Claude): the middle of the facing edge must be much nearer its own star, and
       * no other star may sit right against the box. */
      const ambiguous = (self: Star, x: number, y: number, bx: number, by: number, w: number, h: number, centred: boolean) => {
        const d0 = boxDist(x, y, bx, by, w, h);
        if (!centred) {
          for (const o of live) if (o.s !== self && boxDist(o.x, o.y, bx, by, w, h) < d0 + 8) return true;
          return false;
        }
        const px = bx + w / 2;
        const py = y < by ? by : by + h;
        const a0 = Math.hypot(x - px, y - py);
        for (const o of live) {
          if (o.s === self) continue;
          if (Math.hypot(o.x - px, o.y - py) < Math.max(a0 + 12, a0 * 1.6)) return true;
          if (boxDist(o.x, o.y, bx, by, w, h) < Math.max(o.s.rpx + 6, d0)) return true;
        }
        return false;
      };
      for (const { s, x, y } of live) {
        const [w, h] = measure(s.text, s.frontier ? 'default' : 'tag', true);
        const r = s.rpx + 2;
        // Right of the star first (level, then diagonally), then left, then above / below (during motion
        // the current position is tried first). Frontier stars
        // that find no clear spot may cover part of a neighbouring star rather than lose their name.
        let chosen = -1;
        // The two named ends of the frontier (step 能力與成本) carry the step's point, so as a last
        // resort they accept a spot next to a near-coincident neighbour (both sit on the frontier's end).
        const isEnd = s.text !== s.m.short;
        const nPass = isEnd ? 4 : s.frontier ? 2 : 1;
        for (let pass = 0; pass < nPass && chosen < 0; pass++) {
          for (let n = fresh ? 0 : -1; n < CANDS.length; n++) {
            const ci = n < 0 ? s.cand : n;
            const [a, kx, ky] = CANDS[ci]!;
            const ox = kx * r;
            const oy = ky * (r * 0.7 + h / 2);
            const bx = (a === 'right' ? x + 10 : a === 'left' ? x - 10 - w : x - w / 2) + ox;
            const by = (a === 'above' ? y - 8 - h : a === 'below' ? y + 8 : y - h / 2) + (a === 'above' || a === 'below' ? ky * r : oy);
            if (bx < 0 || by < 0 || bx + w > W || by + h > H) continue;
            // The LabelLayer's collision grid (4 px cells, 2 px pad on both boxes) needs up to 8 px of clearance.
            if (hits(boxes, bx - 8, by - 8, w + 16, h + 16) || ((pass === 0 || pass === 2) && hits(discs, bx, by, w, h))) continue;
            if (pass < 2 && ambiguous(s, x, y, bx, by, w, h, a === 'above' || a === 'below')) continue;
            chosen = ci;
            boxes.push(bx, by, w, h);
            break;
          }
        }
        if (chosen >= 0) {
          s.cand = chosen;
          s.noSpot = false;
        } else if (fresh) s.noSpot = true;
        const [a, kx, ky] = CANDS[s.cand]!;
        const off: [number, number] = [kx * r, a === 'above' || a === 'below' ? ky * r : ky * (r * 0.7 + h / 2)];
        s.label.set({ align: a, offset: off, visible: !s.noSpot });
      }
    };

    /* ───────── picking & hotspots ───────── */
    const pickList: { position: Vector3; id: string }[] = [];
    const refreshPicks = () => {
      pickList.length = 0;
      for (const s of stars) if (s.visT > 0.5) pickList.push({ position: s.world, id: s.hid });
    };
    ctx.picker.addPoints(() => pickList);

    const fmtPrice = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
    const cardFor = (s: Star): CardContent => {
      const d = s.m.d;
      const pt = s.point ?? last(s.m);
      const llm = s.m.kind === 'llm';
      const c: CardContent = {
        title: d.title,
        subtitle: `${d.lab ? `${d.lab}・` : ''}${ORIGIN_NAME[d.origin] ?? d.origin}・${KIND_NAME[s.m.kind]}・${SIZE_NAME[s.m.size]}`,
        swatch: regionCss[s.m.region],
        items: [
          { label: '能力指數', meta: fmt(pt.c) },
          {
            label: '成本指數',
            // Only LLMs are priced per token; other kinds carry an editorial index.
            meta: llm ? `${fmt(pt.ci)}・約 $${fmtPrice(priceOf(pt.ci))}／百萬 token` : `${fmt(pt.ci)}（不按 token 計價，屬編輯評估）`,
          },
          { label: '開放程度', meta: openText(pt.o) },
          { label: s.m.track.length > 1 ? '此版本發布' : '發布', meta: formatMonth(pt.t) },
        ],
        href: d.href ?? `/models/${d.id}/`,
        linkLabel: '前往模型頁 →',
      };
      if (ctx.isFixture) c.body = '以下數值為示意資料。';
      else if (!llm) c.body = '不同類型的能力分數來自不同評測，不能與語言模型直接比較。';
      return c;
    };

    /** Whole-chart pose for hotspot focus: the 3D home view, or straight on while the box is flat. */
    const chartPose = (): CameraPose => (fx.flat < 0.5 ? frontPose() : ctx.homePose);
    /** The openness axis only exists in 3D: focusing it while flat brings the depth back. */
    const unflatten = () => {
      if (fx.flat > 0.99) return;
      const from = fx.flat;
      ctx.tween.run(
        (k) => {
          fx.flat = from + (1 - from) * k;
          placeDirty = dirty = true;
        },
        { duration: 650, fade: true },
      );
    };
    const poseNear = (p: Vector3): CameraPose => {
      const v = toWorld(p, new Vector3());
      return { position: [v.x * 0.6 + 2.2, v.y + 1.4, v.z + 6.4], target: [v.x * 0.75, v.y, v.z * 0.5] };
    };
    const markHot = (list: Star[], on: boolean, amount = 1) => {
      for (const s of list) s.hotT = on ? amount : 0;
      dirty = true;
      ctx.invalidate();
    };
    /** A star picked from the HTML list may be filtered out or not yet released: bring it back. */
    const reveal = (s: Star) => {
      if (!passes(s.m)) setFilter(s.m.kind, true);
      if (!pointAt(s.m, Math.floor(T) + 0.99)) {
        setSweep(false);
        T = tMax;
        applyTime(true);
        refreshPicks();
      }
    };

    for (const s of stars) {
      const spec: HotspotSpec = {
        label: s.m.d.title,
        href: s.m.d.href ?? `/models/${s.m.id}/`,
        anchor: s.anchor,
        card: () => cardFor(s),
        onHighlight: (on) => {
          s.hotT = on ? 1 : 0;
          trailFocus = on ? s : trailFocus === s ? null : trailFocus;
          dirty = true;
          ctx.invalidate();
        },
        onSelect: () => {
          reveal(s);
        },
      };
      Object.defineProperty(spec, 'pose', {
        get: () => {
          reveal(s); // list click: focus (pose) runs before select
          return poseNear(s.target);
        },
        enumerable: true,
      });
      hotspots.register(s.hid, spec);
    }

    const frontierAnchor = new Vector3();
    const declineAnchor = new Vector3();
    const frontPose = (): CameraPose => poseFor('front');
    const starsAnchor = new Vector3();
    hotspots.register('model-stars', {
      get anchor() {
        return starsAnchor.set(0, L.size[1] * 0.9, 0).applyMatrix4(root.matrix);
      },
      onHighlight: (on) => markHot(stars.filter((s) => s.visT > 0.5), on, 0.45),
      get pose() {
        return chartPose();
      },
    });
    hotspots.register('frontier', {
      get anchor() {
        return toWorld(frontierAnchor, new Vector3());
      },
      onHighlight: (on) => {
        ctx.tween.to(fx, { frontierHot: on ? 1 : 0 }, { duration: 220, fade: true });
        markHot(frontierStars, on, 0.6);
      },
      get pose() {
        return frontPose();
      },
    });
    hotspots.register('cost-decline', {
      get anchor() {
        return toWorld(declineAnchor, new Vector3());
      },
      onHighlight: (on) => {
        ctx.tween.to(fx, { declineHot: on ? 1 : 0 }, { duration: 220, fade: true });
      },
      get pose() {
        return frontPose();
      },
    });
    const twStars = stars.filter((s) => s.m.region === 'tw');
    if (twStars.length) {
      const twAnchor = new Vector3();
      const twCentre = () => {
        twAnchor.set(0, 0, 0);
        for (const s of twStars) twAnchor.add(s.target);
        return twAnchor.divideScalar(twStars.length);
      };
      hotspots.register('taiwan-models', {
        get anchor() {
          return toWorld(twCentre(), new Vector3());
        },
        onHighlight: (on) => markHot(twStars, on),
        get pose() {
          for (const s of twStars) reveal(s);
          return poseNear(twCentre().clone());
        },
      });
    }
    const axisHotspot = (id: string, rod: Mesh, anchor: () => Vector3, pose: () => CameraPose) =>
      hotspots.register(id, {
        get anchor() {
          return anchor();
        },
        onHighlight: (on) => {
          rod.visible = on;
          ctx.invalidate();
        },
        get pose() {
          return pose();
        },
      });
    axisHotspot('capability-axis', axisRods[0]!, () => toWorld(new Vector3(origin.x, L.size[1] * 0.6, origin.z + L.size[2]), new Vector3()), () => chartPose());
    axisHotspot('cost-axis', axisRods[1]!, () => toWorld(new Vector3(0, 0, origin.z + L.size[2]), new Vector3()), () => frontPose());
    axisHotspot('openness-axis', axisRods[2]!, () => toWorld(new Vector3(origin.x + L.size[0], 0, 0), new Vector3()), () => {
      unflatten();
      return poseFor('side');
    });

    /* ───────── camera poses ───────── */
    function poseFor(kind: PoseKind): CameraPose {
      if (kind === 'home') return ctx.homePose;
      const ty = L.size[1] * 0.47;
      // High three-quarter view onto the floor zones; on portrait stages aim higher so the box sits mid-stage.
      const lift = ctx.size.aspect < 0.9 ? 0.75 : 0;
      if (kind === 'side') return { position: [0.6, ty + 8.9 + lift, 9.6], target: [0.3, 0.95 + lift, 0.2] };
      // Straight on, aimed at the back wall: in the flattened steps this is a plain 2D chart.
      return { position: [0.3, ty + 0.3, 9.0], target: [0.3, ty - 0.05, origin.z] };
    }

    /* ───────── sweep (time animation) ───────── */
    let sweeping = false;
    let hold = 0;
    function setSweep(on: boolean) {
      sweeping = on && ctx.animate && tMax > tMin;
      hold = 0;
      ui?.setPlaying(sweeping);
      if (sweeping && T >= tMax - 0.01) {
        T = tMin;
        applyTime();
      }
      dirty = true;
      ctx.invalidate();
    }

    /* ───────── HTML controls ───────── */
    let ui: ReturnType<typeof createGalaxyUi> | null = null;
    function setFilter(k: KindFilter, snap = false) {
      if (k === filter) return;
      filter = k;
      ui?.setKind(k);
      applyFilter(snap);
      const shown = models.filter(passes).length;
      ctx.announce(`${k === 'all' ? '顯示全部類型' : `只顯示${KIND_NAME[k]}`}，共 ${shown} 個模型家族；能力軸已依顯示的模型重新調整。`);
    }
    ui = createGalaxyUi({
      stage: ctx.stage,
      signal: ctx.signal,
      regions: REGIONS.filter((r) => r !== 'other' || models.some((m) => m.region === 'other')).map((r) => ({ id: r, label: REGION_NAME[r] })),
      sizeKey: '大小＝等級　形狀＝類型',
      kinds: [
        { id: 'all', label: '全部', count: n },
        ...kindsPresent.map((k) => ({ id: k, label: KIND_CHIP[k], shape: SHAPE_OF[k], count: models.filter((m) => m.kind === k).length })),
      ],
      time: { min: tMin, max: tMax, value: T },
      onKind: (k) => setFilter(k),
      onTime: (t) => {
        if (sweeping) setSweep(false);
        T = Math.max(tMin, Math.min(tMax, t));
        applyTime();
        refreshPicks();
      },
      onPlay: (play) => setSweep(play),
    });
    ui.setKind(filter);
    ui.setPlayable(ctx.animate);

    /* ───────── stage fit ─────────
     * The HTML legend and controls are fixed in px, so on small stages (phones, short embeds) they
     * cover a larger share of the frame. Shrink the whole diorama about the chart's top (so the
     * camera poses, the reset view included, still frame it) to keep the axes clear of them. */
    const fitPivot = new Vector3();
    const fitStage = () => {
      const H = ctx.size.height;
      const [legend, ...bar] = ui?.obstacles() ?? [];
      const top = legend ? legend.y + legend.h : 0;
      let bottom = H;
      for (const b of bar) bottom = Math.min(bottom, b.y);
      // The poses are tuned for controls that leave ~88 % of the height free.
      const k = Math.min(1, Math.max(0.74, Math.max(0, bottom - top) / H / 0.88));
      fitPivot.set(0, L.size[1], 0);
      root.scale.setScalar(k);
      root.position.copy(fitPivot).multiplyScalar(1 - k);
      root.updateMatrix();
      root.updateMatrixWorld();
      obstaclesAt = -1e9;
      placeDirty = dirty = true;
    };

    /* ───────── initial build ───────── */
    applyPalette(ctx.palette);
    fitStage();
    buildLayout();
    setFrontierText();
    for (const s of stars) {
      s.vis = s.visT;
      s.cur.copy(s.target);
    }
    refreshPicks();
    write(0);

    const goStep = (i: number) => {
      const cfg = STEPS[i] ?? STEPS[0]!;
      setFx(cfg);
      if (cfg.sweep && ctx.animate) {
        T = tMin;
        applyTime();
        setSweep(true);
      } else {
        setSweep(false);
        T = tMax;
        applyTime();
      }
      refreshPicks();
      ctx.setPose(poseFor(cfg.pose));
    };

    return {
      update(dt, t) {
        // Sweep the release-date slider.
        if (sweeping && dt > 0) {
          if (T >= tMax) {
            hold += dt;
            if (hold > SWEEP_HOLD) {
              hold = 0;
              T = tMin;
              applyTime();
              refreshPicks();
            }
          } else {
            const prev = Math.floor(T);
            T = Math.min(tMax, T + (dt * (tMax - tMin)) / SWEEP_SECONDS);
            if (Math.floor(T) !== prev || T >= tMax) {
              applyTime();
              refreshPicks();
            } else ui?.setTime(T);
          }
          dirty = true;
        }
        // Smooth glides (instant without motion).
        const k = ctx.animate && dt > 0 ? 1 - Math.exp(-dt * 6.5) : 1;
        let moving = false;
        for (const s of stars) {
          const dv = s.visT - s.vis;
          const dh = s.hotT - s.hot;
          const dp = s.cur.distanceToSquared(s.target);
          if (Math.abs(dv) > 1e-3 || Math.abs(dh) > 1e-3 || dp > 1e-7) {
            s.vis += dv * k;
            s.hot += dh * Math.min(1, k * 1.6);
            if (s.visT > 0) s.cur.lerp(s.target, k);
            moving = true;
          } else {
            s.vis = s.visT;
            s.hot = s.hotT;
            s.cur.copy(s.target);
          }
        }
        if (ctx.animate && dt > 0) {
          dust.rotation.y += dt * 0.006;
          dirty = true; // twinkle
        }
        const now = performance.now();
        ctx.camera.updateMatrixWorld();
        const camMoved = !camSig.equals(ctx.camera.matrixWorld) || fovSig !== ctx.camera.fov;
        if (camMoved) {
          camSig.copy(ctx.camera.matrixWorld);
          fovSig = ctx.camera.fov;
        }
        const flatMoving = fx.flat !== lastFlat;
        lastFlat = fx.flat;
        if (camMoved || moving || flatMoving) placeDirty = true;
        if (placeDirty) {
          // Throttled while the view moves; one fresh, deterministic pass once it has settled.
          const settled = !camMoved && !moving && !flatMoving;
          if (settled || now - lastPlace > 90) {
            placeLabels(now, settled);
            lastPlace = now;
            if (settled) placeDirty = false;
          }
        }
        if (moving || dirty) {
          write(t);
          dirty = moving;
        }
        // Ask for one more frame until the labels have settled (matters in the demand loop).
        return moving || placeDirty;
      },
      setStep(i) {
        goStep(i);
      },
      setVariant() {
        goStep(ctx.step);
        return true;
      },
      onMotion(animate) {
        ui?.setPlayable(animate);
        if (!animate) {
          setSweep(false);
          if (ctx.step === 3) {
            T = tMax;
            applyTime();
          }
        } else if ((STEPS[ctx.step] ?? STEPS[0]!).sweep) setSweep(true);
        refreshPicks();
        dirty = true;
      },
      onPalette(pal) {
        applyPalette(pal);
        ctx.invalidate();
      },
      onQuality(_q, tier) {
        labels.setMax(labelBudget(tier.maxLabels));
      },
      onResize(size) {
        fitStage();
        const next = size.aspect < 0.9 ? PORT : LAND;
        if (next !== L) {
          L = next;
          fitStage();
          buildLayout();
          for (const s of stars) s.cur.copy(s.target);
          dirty = true;
          if (ctx.step > 0) ctx.setPose(poseFor((STEPS[ctx.step] ?? STEPS[0]!).pose));
        }
      },
      dispose() {
        fxTween?.cancel();
        measurer.remove();
        ui?.dispose();
        axes?.dispose();
        if (stageObjects) for (const o of Object.values(stageObjects)) o.geometry.dispose();
        root.removeFromParent();
      },
    };

    function setRodMesh(mesh: Mesh, a: Vector3, b: Vector3, radius: number) {
      vS.subVectors(b, a);
      const len = vS.length();
      mesh.quaternion.setFromUnitVectors(UP, vS.normalize());
      mesh.position.addVectors(a, b).multiplyScalar(0.5);
      mesh.scale.set(radius, len, radius);
    }
  },
});

/* ───────────────────────── helpers ───────────────────────── */

function roundedRect(w: number, d: number, r: number): ThreeShape {
  const s = new ThreeShape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

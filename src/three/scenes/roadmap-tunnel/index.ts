/**
 * roadmap-tunnel — 技術時光隧道 2024–2031 (variant: tunnel).
 *
 * A translucent tunnel runs along the time axis (x) from January 2024 to the end of 2031, divided
 * by year rings. Four rails on the wall are the trend categories 硬體／軟體／市場／政策 (the same
 * --chart-1/3/4/7 hues as /trends/). Every milestone of the page data (`trends`) sits on its lane at
 * its date: done = solid sphere, expected = hollow ring, speculative = dashed ring with a soft halo.
 * Year-only dates also get a translucent band across the whole year (date precision). A glowing
 * 「現在」 ring marks the data snapshot date (DATA_DATE): the shell and rails are solid before it,
 * translucent / dashed after it.
 *
 * Time travel: the in-stage slider, the wheel (stage engaged or Ctrl held), the +/− keys and
 * `scene:command {type:'time', t}` slide the camera along the tunnel (from the overview it dives in).
 * Hover a milestone: its trend lights up (thread + halos) and the card shows date, status and trend
 * title; click opens /trends/<id>/. Lane chips show or hide lanes.
 *
 * Steps (由淺入深): 總覽 (outside) → 四條軌道 (entrance) → 已發生 → 現在與預期 → 遠期推測 (a close
 * side view of the precision bands). Reduced motion: no particle flow or breathing halos, camera moves
 * are cuts and the time flow shows as static dotted streams.
 */
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Fog,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type ColorRef,
  type LabelHandle,
  type Palette,
  type SceneContext,
  type ScreenPoint,
  type Tween,
} from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { DATA_DATE } from '../../../lib/seo';
import {
  STATUSES,
  cleanLabel,
  dateText,
  isTrends,
  layoutMilestones,
  monthText,
  parseDate,
  type Milestone,
  type Status,
  type TrendDatum,
} from './data';
import { createTunnelUi } from './ui';

/* ───────────────────────── layout ───────────────────────── */

const T0 = 2024;
const T1 = 2032; // end of 2031
const MID = (T0 + T1) / 2;
const YEAR = 3.2; // world units per year
const R = 2.1; // tunnel radius
const RAIL_R = R * 0.92;
const SLOT = 0.2; // radians between marker slots around a rail
const GAP = 0.1; // years between markers that share a slot
const LOOK = 1.2; // the camera target sits LOOK units ahead of the focus time
const OVERVIEW_MIN = 13; // a longer camera offset counts as the outside overview
const xOf = (t: number) => (t - MID) * YEAR;
const X0 = xOf(T0);
const X1 = xOf(T1);

interface Lane {
  label: string;
  ref: ColorRef;
  css: string;
  hotspot: string;
  /** Angle around the axis: y = r·sin, z = r·cos (the overview camera looks from +z). */
  angle: number;
  /** In the fly-through view (looking +x, right = +z): is the lane on the upper half? */
  upper: boolean;
}
const LANES: readonly Lane[] = [
  {
    label: '硬體',
    ref: 'chart:1',
    css: 'chart-1',
    hotspot: 'lane-hardware',
    angle: -Math.PI / 4,
    upper: false,
  },
  {
    label: '軟體',
    ref: 'chart:3',
    css: 'chart-3',
    hotspot: 'lane-software',
    angle: (-3 * Math.PI) / 4,
    upper: false,
  },
  { label: '市場', ref: 'chart:4', css: 'chart-4', hotspot: 'lane-market', angle: Math.PI / 4, upper: true },
  {
    label: '政策',
    ref: 'chart:7',
    css: 'chart-7',
    hotspot: 'lane-policy',
    angle: (3 * Math.PI) / 4,
    upper: true,
  },
];

const STATUS_LABEL: Record<Status, string> = { done: '已發生', expected: '預期', speculative: '推測' };
const STATUS_HOTSPOT: Record<Status, string> = {
  done: 'status-done',
  expected: 'status-expected',
  speculative: 'status-speculative',
};

type PoseKind = 'home' | 'entrance' | 'fly' | 'side';
interface StepSpec {
  /** Focus time (fractional year) or 'now'. */
  t: number | 'now';
  kind: PoseKind;
  /** Dimming per status [done, expected, speculative]. */
  dim: readonly [number, number, number];
}
const STEPS: readonly StepSpec[] = [
  { t: 'now', kind: 'home', dim: [0, 0, 0] },
  { t: T0 + 0.25, kind: 'entrance', dim: [0, 0, 0] },
  { t: 2025.2, kind: 'fly', dim: [0, 0.75, 0.75] },
  { t: 'now', kind: 'fly', dim: [0.6, 0, 0.45] },
  { t: 2029.3, kind: 'side', dim: [0.7, 0.4, 0] },
];

type MovePose = Exclude<PoseKind, 'home'>;
/** Camera offset from the target, per pose kind: landscape (16:9) and portrait (4:5). */
const OFFSETS: Record<MovePose, readonly [Vector3, Vector3]> = {
  fly: [new Vector3(-5.2, 0.5, 0.3), new Vector3(-5.6, 0.55, 0.3)],
  entrance: [new Vector3(-7.6, 0.75, 0.6), new Vector3(-6.4, 0.75, 0.6)],
  side: [new Vector3(-3.4, 3.3, 8.4), new Vector3(-9.6, 4.2, 7.6)],
};
/** Vertical FOV per pose kind (at 16:9, and at 4:5 for portrait stages). */
const POSE_FOV: Record<MovePose, readonly [number, number]> = {
  fly: [54, 60],
  entrance: [52, 58],
  side: [40, 46],
};
/** Target height of the side view: lower on portrait stages so the tunnel clears the time slider. */
const SIDE_Y = [-0.25, -0.9] as const;
/**
 * Overview on near-square stages (the /trends/ hero is 1:1 on phones): the host keeps the 16:9
 * horizontal extent there, which leaves the tunnel a thin band between the legend and the slider,
 * so the same view is tightened and lifted above the in-stage controls.
 */
const SQUARE_HOME: CameraPose = { position: [-18.9, 7.2, 21.2], target: [-1.9, -1.5, 0], fov: 28 };
const SQUARE_MAX = 1.25;
/** Markers closer than this to the camera shrink so the fly-through never fills the frame with one sphere. */
const NEAR = 8.5;

const wallPos = (t: number, angle: number, r: number, out = new Vector3()) =>
  out.set(xOf(t), r * Math.sin(angle), r * Math.cos(angle));
const clampT = (t: number) => Math.min(T1 - 1 / 24, Math.max(T0 + 1 / 24, t));
const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * 「現在」 is the site's data snapshot date (資料基準日), not the reader's clock: the milestone
 * statuses (已發生／預期／推測) are true as of that date, so the ring and the statuses always agree,
 * and posters, screenshots and tests stay deterministic.
 */
function nowYearFraction(): number {
  const p = parseDate(DATA_DATE);
  if (p) return p.t;
  const d = new Date();
  return d.getFullYear() + d.getMonth() / 12 + 1 / 24;
}

/** A dashed ring: a torus whose index buffer keeps 4 of every 6 tubular segments. */
function dashedTorus(radius: number, tube: number, radial: number, tubular: number): TorusGeometry {
  const g = new TorusGeometry(radius, tube, radial, tubular);
  const src = g.getIndex()!;
  const keep: number[] = [];
  for (let j = 0; j < radial; j++)
    for (let i = 0; i < tubular; i++) {
      if (i % 6 >= 4) continue;
      const k = (j * tubular + i) * 6;
      for (let q = 0; q < 6; q++) keep.push(src.getX(k + q));
    }
  g.setIndex(keep);
  return g;
}

/* ───────────────────────── scene ───────────────────────── */

const m4 = new Matrix4();
const qId = new Quaternion();
const vA = new Vector3();
const vB = new Vector3();
const vS = new Vector3();
const vN = new Vector3();
const lastQ = new Quaternion(2, 0, 0, 0);
const lastP = new Vector3(Infinity, 0, 0);

export default defineScene<TrendDatum[]>({
  json,
  meta: {
    camera: {
      position: [-18.9, 7.2, 21.2],
      target: [-1.9, -0.9, 0],
      fov: 32,
      near: 0.1,
      far: 160,
      minDistance: 2.2,
      maxDistance: 34,
      minPolar: 0.35,
      maxPolar: 1.95,
      portrait: { position: [-22.4, 6.6, 9.4], target: [-6, -1.3, 0], fov: 46 },
    },
    controls: 'orbit-limited',
    loop: 'continuous',
    budget: { calls: 40, tris: 250_000 },
  },
  guard: isTrends,
  fixture: () => import('../../fixtures/roadmap-tunnel.json'),

  create(ctx: SceneContext<TrendDatum[]>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'roadmap-tunnel';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const fog = new Fog(ctx.palette.bg.getHex(), 200, 400);
    scene.fog = fog;
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const hi = ctx.quality === 'high';

    const nowT = clampT(nowYearFraction());
    const xNow = xOf(nowT);
    const trends = ctx.data ?? [];
    const ms = layoutMilestones(trends, T0, T1, GAP);
    const trendIds = [...new Set(ms.map((m) => m.trend.id))];
    const laneCount = LANES.map((_, i) => ms.filter((m) => m.lane === i).length);
    const msPos: Vector3[] = ms.map((m) => wallPos(m.tx, LANES[m.lane]!.angle + m.slot * SLOT, RAIL_R));

    /* ───────── shell, grid, lane bands ───────── */
    const shellGeo = (a: number, b: number) => {
      const g = ctx.track(new CylinderGeometry(R, R, b - a, 72, 1, true));
      g.rotateZ(-Math.PI / 2);
      g.translate((a + b) / 2, 0, 0);
      return g;
    };
    const glassPast = materials.glass((p) => p.fg.clone().lerp(p.bg, 0.25), 0.08, {
      roughness: 0.2,
      metalness: 0.05,
    });
    const glassFuture = materials.glass((p) => p.fg.clone().lerp(p.bg, 0.25), 0.035, {
      roughness: 0.2,
      metalness: 0.05,
    });
    const shellPast = new Mesh(shellGeo(X0, xNow), glassPast);
    const shellFuture = new Mesh(shellGeo(xNow, X1), glassFuture);
    shellPast.renderOrder = shellFuture.renderOrder = 1;
    root.add(shellPast, shellFuture);

    // Longitudinal lines every 30° plus faint quarter-year circles; alpha lower in the future.
    const gridGeo = ctx.track(new BufferGeometry());
    const gridPos: number[] = [];
    const gridFuture: number[] = []; // per vertex: 1 = future
    const gridKind: number[] = []; // 0 = long line, 1 = quarter circle
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      const y = R * Math.sin(a);
      const z = R * Math.cos(a);
      gridPos.push(X0, y, z, xNow, y, z, xNow, y, z, X1, y, z);
      gridFuture.push(0, 0, 1, 1);
      gridKind.push(0, 0, 0, 0);
    }
    for (let y = T0; y < T1; y++)
      for (const q of [0.25, 0.5, 0.75]) {
        const t = y + q;
        const fut = t > nowT ? 1 : 0;
        for (let s = 0; s < 64; s++) {
          const a0 = (s / 64) * Math.PI * 2;
          const a1 = ((s + 1) / 64) * Math.PI * 2;
          gridPos.push(
            xOf(t),
            R * Math.sin(a0),
            R * Math.cos(a0),
            xOf(t),
            R * Math.sin(a1),
            R * Math.cos(a1),
          );
          gridFuture.push(fut, fut);
          gridKind.push(1, 1);
        }
      }
    gridGeo.setAttribute('position', new Float32BufferAttribute(gridPos, 3));
    gridGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((gridPos.length / 3) * 4), 4));
    const gridMat = ctx.track(
      new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }),
    );
    const grid = new LineSegments(gridGeo, gridMat);
    grid.renderOrder = 2;
    root.add(grid);

    // Lane sectors: one soft band per lane on the inside of the wall (vertex alpha).
    const bandGeo = ctx.track(new BufferGeometry());
    {
      const pos: number[] = [];
      const idx: number[] = [];
      const cols = 9;
      const xs = [X0, xNow, X1];
      LANES.forEach((lane) => {
        const base = pos.length / 3;
        for (const x of xs)
          for (let c = 0; c < cols; c++) {
            const a = lane.angle + ((c / (cols - 1)) * 2 - 1) * 0.66;
            pos.push(x, R * 0.985 * Math.sin(a), R * 0.985 * Math.cos(a));
          }
        for (let r = 0; r < xs.length - 1; r++)
          for (let c = 0; c < cols - 1; c++) {
            const a = base + r * cols + c;
            idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
          }
      });
      bandGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      bandGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
      bandGeo.setIndex(idx);
    }
    const bandMat = ctx.track(
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      }),
    );
    const bands = new Mesh(bandGeo, bandMat);
    bands.renderOrder = 1;
    root.add(bands);

    /* ───────── year rings ───────── */
    const ringGeo = ctx.track(new TorusGeometry(R, 0.026, 8, hi ? 128 : 72));
    ringGeo.rotateY(Math.PI / 2);
    const years = Array.from({ length: T1 - T0 + 1 }, (_, i) => T0 + i);
    const pastYears = years.filter((y) => y <= nowT);
    const futureYears = years.filter((y) => y > nowT);
    const ringPastMat = materials.standard((p) => p.fg.clone().lerp(p.bg, p.theme === 'dark' ? 0.4 : 0.62), {
      roughness: 0.4,
      metalness: 0.3,
    });
    const ringFutureMat = materials.standard((p) => p.muted.clone(), {
      roughness: 0.4,
      metalness: 0.2,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const makeRings = (list: number[], mat: MeshStandardMaterial) => {
      const im = new InstancedMesh(ringGeo, mat, Math.max(1, list.length));
      im.count = list.length;
      list.forEach((y, i) => im.setMatrixAt(i, m4.makeTranslation(xOf(y), 0, 0)));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      ctx.track({ dispose: () => im.dispose() });
      root.add(im);
      return im;
    };
    makeRings(pastYears, ringPastMat);
    makeRings(futureYears, ringFutureMat).renderOrder = 3;

    /* ───────── 現在 ring ───────── */
    const nowGroup = new Group();
    nowGroup.position.x = xNow;
    root.add(nowGroup);
    const nowRingGeo = ctx.track(new TorusGeometry(R * 1.012, 0.048, 10, hi ? 160 : 96));
    nowRingGeo.rotateY(Math.PI / 2);
    const nowRingMat = materials.basic('highlight');
    nowGroup.add(new Mesh(nowRingGeo, nowRingMat));
    const membraneGeo = ctx.track(new CircleGeometry(R * 0.985, 72));
    membraneGeo.rotateY(Math.PI / 2);
    const membraneMat = materials.basic('highlight', {
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      side: DoubleSide,
    });
    const membrane = new Mesh(membraneGeo, membraneMat);
    membrane.renderOrder = 4;
    nowGroup.add(membrane);
    const badgeGeo = ctx.track(new OctahedronGeometry(0.15, 0));
    const badgeMat = materials.standard('highlight', { roughness: 0.3, metalness: 0.2 });
    materials.bind(badgeMat, 'emissive', 'highlight', (c, p) =>
      c.multiplyScalar(p.theme === 'dark' ? 0.45 : 0.15),
    );
    const badge = new Mesh(badgeGeo, badgeMat);
    badge.position.set(0, R + 0.32, 0);
    badge.scale.set(1, 1.35, 1);
    const badgeWorld = new Vector3(xNow, R + 0.32, 0);
    nowGroup.add(badge);

    /* ───────── rails, dashes, caps, arrows ───────── */
    const railGeo = ctx.track(new CylinderGeometry(0.024, 0.024, 1, 8, 1, true));
    railGeo.rotateZ(-Math.PI / 2);
    const railMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 }));
    const rails = new InstancedMesh(railGeo, railMat, LANES.length);
    const DASH = 0.2;
    const PERIOD = 0.36;
    const nDash = Math.max(1, Math.floor((X1 - xNow - 0.1) / PERIOD));
    const dashMat = ctx.track(
      new MeshStandardMaterial({
        roughness: 0.35,
        metalness: 0.2,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
      }),
    );
    const dashes = new InstancedMesh(railGeo, dashMat, LANES.length * nDash);
    const capGeo = ctx.track(new CylinderGeometry(0.12, 0.12, 0.07, 6));
    capGeo.rotateZ(-Math.PI / 2);
    const capMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.3 }));
    const caps = new InstancedMesh(capGeo, capMat, LANES.length);
    const arrowGeo = ctx.track(new ConeGeometry(0.1, 0.3, 14));
    arrowGeo.rotateZ(-Math.PI / 2);
    const arrows = new InstancedMesh(arrowGeo, dashMat, LANES.length);
    LANES.forEach((lane, i) => {
      wallPos(T0, lane.angle, RAIL_R, vA);
      const len = xNow - X0;
      rails.setMatrixAt(i, m4.compose(vB.set(X0 + len / 2, vA.y, vA.z), qId, vS.set(len, 1, 1)));
      for (let d = 0; d < nDash; d++)
        dashes.setMatrixAt(
          i * nDash + d,
          m4.compose(vB.set(xNow + 0.1 + d * PERIOD + DASH / 2, vA.y, vA.z), qId, vS.set(DASH, 1, 1)),
        );
      caps.setMatrixAt(i, m4.compose(vB.set(X0 - 0.06, vA.y, vA.z), qId, vS.set(1, 1, 1)));
      arrows.setMatrixAt(i, m4.compose(vB.set(X1 + 0.2, vA.y, vA.z), qId, vS.set(1, 1, 1)));
    });
    for (const im of [rails, dashes, caps, arrows]) {
      im.setColorAt(0, new Color());
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      ctx.track({ dispose: () => im.dispose() });
      root.add(im);
    }
    dashes.renderOrder = arrows.renderOrder = 3;

    /* ───────── markers ───────── */
    const byStatus: Record<Status, Milestone[]> = { done: [], expected: [], speculative: [] };
    for (const m of ms) byStatus[m.status].push(m);
    const slotOf = new Map<number, number>(); // milestone index → instance id within its status mesh
    for (const s of STATUSES) byStatus[s].forEach((m, i) => slotOf.set(m.index, i));

    const sphereGeo = ctx.track(new IcosahedronGeometry(0.13, hi ? 2 : 1));
    const ringMGeo = ctx.track(new TorusGeometry(0.118, 0.03, 8, hi ? 28 : 18));
    const dashMGeo = ctx.track(dashedTorus(0.124, 0.024, 6, 48));
    const markerMat = (transparent: boolean) =>
      ctx.track(
        new MeshStandardMaterial({
          roughness: 0.32,
          metalness: 0.18,
          transparent,
          opacity: transparent ? 0.95 : 1,
        }),
      );
    const doneMat = markerMat(false);
    const expMat = markerMat(false);
    const specMat = markerMat(true);
    const meshes: Record<Status, InstancedMesh> = {
      done: new InstancedMesh(sphereGeo, doneMat, Math.max(1, byStatus.done.length)),
      expected: new InstancedMesh(ringMGeo, expMat, Math.max(1, byStatus.expected.length)),
      speculative: new InstancedMesh(dashMGeo, specMat, Math.max(1, byStatus.speculative.length)),
    };
    for (const s of STATUSES) {
      const im = meshes[s];
      im.count = byStatus[s].length;
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.setColorAt(0, new Color());
      im.frustumCulled = false;
      im.renderOrder = 6;
      ctx.track({ dispose: () => im.dispose() });
      root.add(im);
    }

    // Precision bands: a translucent sleeve across the whole year for year-only dates.
    const yearOnly = ms.filter((m) => m.date.precision === 'year');
    const bandRGeo = ctx.track(new CylinderGeometry(0.07, 0.07, 1, 10, 1, false));
    bandRGeo.rotateZ(-Math.PI / 2);
    const fuzzMat = ctx.track(
      new MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false }),
    );
    const fuzz = new InstancedMesh(bandRGeo, fuzzMat, Math.max(1, yearOnly.length));
    fuzz.count = yearOnly.length;
    fuzz.setColorAt(0, new Color());
    fuzz.renderOrder = 5;
    fuzz.frustumCulled = false;
    ctx.track({ dispose: () => fuzz.dispose() });
    root.add(fuzz);

    /* ───────── glows: now ring, speculative halos, hovered trend ───────── */
    const NOW_GLOWS = 28;
    const SPEC0 = NOW_GLOWS;
    const HOT0 = SPEC0 + byStatus.speculative.length;
    const HOT_MAX = 48;
    const glows = ctx.track(new GlowSprites({ count: HOT0 + HOT_MAX, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── hovered-trend thread ───────── */
    const threadGeo = ctx.track(new BufferGeometry());
    threadGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(HOT_MAX * 6), 3));
    threadGeo.setDrawRange(0, 0);
    const threadMat = materials.line('highlight', {
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    const thread = new LineSegments(threadGeo, threadMat);
    thread.renderOrder = 20;
    thread.frustumCulled = false;
    root.add(thread);

    /* ───────── time flow ───────── */
    const FLOW_MAX = 280;
    const flowColors = (p: Palette) =>
      LANES.map((l, i) => {
        const c = materials.color(l.ref);
        if (!laneOn[i]) return [p.bg.clone(), p.bg.clone(), p.bg.clone()];
        return [c.clone(), c.clone(), c.clone().lerp(p.bg, 0.55)];
      });
    const laneOn = LANES.map(() => true);
    const flow = ctx.track(
      new PathFlow({
        paths: LANES.map((l, i) => ({
          points: [
            wallPos(T0, l.angle, RAIL_R - 0.03),
            wallPos(nowT, l.angle, RAIL_R - 0.03),
            wallPos(T1, l.angle, RAIL_R - 0.03),
          ],
          color: flowColors(ctx.palette)[i]!,
        })),
        count: scaleCount(FLOW_MAX, ctx.tier, 40),
        size: 0.06,
        sizeVariance: 0.3,
        speed: 0.75,
        speedVariance: 0.2,
        smooth: false,
        fadeEnds: 0.03,
        theme: ctx.theme,
        seed: 17,
      }),
    );
    flow.setReduced(!ctx.animate);
    root.add(flow.object);

    /* ───────── labels ───────── */
    const yearLabels = years.slice(0, -1).map((y) =>
      labels.add({
        text: String(y),
        position: [xOf(y), -R * 0.94 - 0.08, R * 0.34],
        align: 'below',
        priority: 26,
      }),
    );
    const nowLabel = labels.add({
      text: `現在・${monthText(nowT)}`,
      object: nowGroup,
      position: [0, R + 0.5, 0],
      align: 'above',
      kind: 'strong',
      priority: 45,
      hotspot: 'now',
    });
    const laneLabelPos = LANES.map(() => new Vector3());
    const laneLabels = LANES.map((l, i) =>
      labels.add({
        text: l.label,
        position: laneLabelPos[i]!,
        kind: 'strong',
        priority: 30,
        always: true,
        hotspot: l.hotspot,
      }),
    );
    const msLabels: LabelHandle[] = ms.map((m) =>
      labels.add({ text: m.short, position: msPos[m.index]!.clone(), align: 'above', priority: 8 }),
    );

    /* ───────── emphasis state ───────── */
    let close = false; // camera inside / near the tunnel (vs the outside overview)
    let focusT = nowT;
    const stepDim: [number, number, number] = [0, 0, 0];
    let hot: { kind: 'trend' | 'status' | 'lane' | 'precision' | 'now'; value: string | number } | null =
      null;
    let hotK = 0;
    let breath = 0;
    const statusIdx = (s: Status) => STATUSES.indexOf(s);
    const isHotMember = (m: Milestone) => {
      if (!hot) return true;
      switch (hot.kind) {
        case 'trend':
          return m.trend.id === hot.value;
        case 'status':
          return m.status === hot.value;
        case 'lane':
          return m.lane === hot.value;
        case 'precision':
          return m.date.precision === 'year';
        default:
          return true;
      }
    };
    const dimOf = (m: Milestone) => Math.max(stepDim[statusIdx(m.status)]!, isHotMember(m) ? 0 : 0.7 * hotK);
    const scaleOf = (m: Milestone) =>
      !laneOn[m.lane] ? 0.0001 : hot?.kind === 'trend' && hot.value === m.trend.id ? 1 + 0.3 * hotK : 1;

    /* ───────── palette-dependent colours ───────── */
    const laneC = LANES.map(() => new Color());
    const tmpC = new Color();
    const writeColors = () => {
      const p = ctx.palette;
      for (const m of ms) {
        const im = meshes[m.status];
        const id = slotOf.get(m.index)!;
        tmpC.copy(laneC[m.lane]!).lerp(p.bg, 0.72 * dimOf(m));
        im.setColorAt(id, tmpC);
      }
      for (const s of STATUSES) if (meshes[s].instanceColor) meshes[s].instanceColor!.needsUpdate = true;
      yearOnly.forEach((m, i) => {
        tmpC.copy(laneC[m.lane]!).lerp(p.bg, 0.6 * dimOf(m));
        fuzz.setColorAt(i, tmpC);
      });
      if (fuzz.instanceColor) fuzz.instanceColor.needsUpdate = true;
      const dark = p.theme === 'dark';
      const precisionBoost = hot?.kind === 'precision' ? hotK : 0;
      fuzzMat.opacity =
        (dark ? 0.2 : 0.26) + 0.18 * precisionBoost + (stepDim[2] === 0 && stepDim[0] > 0 ? 0.08 : 0);
      writeGlows();
    };
    const writeGlows = () => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      const nowBoost = hot?.kind === 'now' ? hotK : 0;
      for (let i = 0; i < NOW_GLOWS; i++) {
        const a = (i / NOW_GLOWS) * Math.PI * 2;
        glows.set(
          i,
          vA.set(xNow, R * 1.012 * Math.sin(a), R * 1.012 * Math.cos(a)),
          dark ? 0.62 : 0.5,
          p.highlight,
          ((dark ? 0.32 : 0.22) + 0.25 * nowBoost) * (1 + 0.25 * breath),
        );
      }
      byStatus.speculative.forEach((m, i) => {
        const on = laneOn[m.lane] ? 1 : 0;
        glows.set(
          SPEC0 + i,
          msPos[m.index]!,
          (dark ? 0.62 : 0.5) * nearK[m.index]!,
          laneC[m.lane]!,
          on * (dark ? 0.5 : 0.32) * (1 - dimOf(m)) * (1 + 0.3 * breath),
        );
      });
      const hotMs =
        hot?.kind === 'trend'
          ? ms.filter((m) => m.trend.id === hot!.value && laneOn[m.lane]).slice(0, HOT_MAX)
          : [];
      for (let i = 0; i < HOT_MAX; i++) {
        const m = hotMs[i];
        if (m)
          glows.set(
            HOT0 + i,
            msPos[m.index]!,
            (dark ? 0.75 : 0.62) * nearK[m.index]!,
            p.highlight,
            (dark ? 0.55 : 0.4) * hotK,
          );
        else glows.setAlpha(HOT0 + i, 0);
      }
    };

    /* ───────── matrices (rings face the camera) ───────── */
    const nearK = new Float32Array(ms.length).fill(1);
    const nearScale = (p: Vector3) => {
      const d = p.distanceTo(ctx.camera.position);
      return d >= NEAR ? 1 : Math.max(1e-4, (d / NEAR) * smooth(0.25, 0.8, d));
    };
    const writeMatrices = () => {
      const q = ctx.camera.quaternion;
      for (const m of ms) {
        const im = meshes[m.status];
        const id = slotOf.get(m.index)!;
        const k = (nearK[m.index] = nearScale(msPos[m.index]!));
        im.setMatrixAt(
          id,
          m4.compose(msPos[m.index]!, m.status === 'done' ? qId : q, vS.setScalar(scaleOf(m) * k)),
        );
      }
      LANES.forEach((lane, i) => {
        wallPos(T0, lane.angle, RAIL_R, vA).setX(X0 - 0.06);
        caps.setMatrixAt(i, m4.compose(vA, qId, vS.setScalar(nearScale(vA))));
      });
      caps.instanceMatrix.needsUpdate = true;
      const kb = nearScale(badgeWorld);
      badge.scale.set(kb, 1.35 * kb, kb);
      for (const s of STATUSES) meshes[s].instanceMatrix.needsUpdate = true;
      const cx = ctx.camera.position.x;
      yearOnly.forEach((m, i) => {
        const p = msPos[m.index]!;
        const xa = xOf(m.date.t0) + 0.06;
        const xb = xOf(m.date.t1) - 0.06;
        // Thin the sleeve where it passes close to the camera (its nearest point decides).
        const k = nearScale(vA.set(Math.min(xb, Math.max(xa, cx)), p.y, p.z));
        fuzz.setMatrixAt(
          i,
          m4.compose(vB.set((xa + xb) / 2, p.y, p.z), qId, vS.set(laneOn[m.lane] ? xb - xa : 0.0001, k, k)),
        );
      });
      fuzz.instanceMatrix.needsUpdate = true;
    };

    /* ───────── static colours (lanes, grid, bands, flow) ───────── */
    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      lights.apply(p);
      fog.color.copy(p.bg);
      LANES.forEach((l, i) => laneC[i]!.copy(materials.color(l.ref)));
      LANES.forEach((_, i) => {
        tmpC.copy(laneC[i]!).lerp(p.bg, laneOn[i] ? 0 : 0.8);
        rails.setColorAt(i, tmpC);
        caps.setColorAt(i, tmpC);
        arrows.setColorAt(i, tmpC);
        for (let d = 0; d < nDash; d++) dashes.setColorAt(i * nDash + d, tmpC);
      });
      for (const im of [rails, caps, arrows, dashes])
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      // grid
      const gc = p.grid.clone().lerp(p.fg, dark ? 0.12 : 0.1);
      const gAttr = gridGeo.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < gridFuture.length; i++) {
        const fut = gridFuture[i] === 1;
        const kind = gridKind[i];
        const a = kind === 0 ? (fut ? 0.16 : 0.34) : fut ? 0.07 : 0.16;
        gAttr.setXYZW(i, gc.r, gc.g, gc.b, a * (dark ? 1 : 1.25));
      }
      gAttr.needsUpdate = true;
      // lane bands: soft edges, past stronger than future
      const bAttr = bandGeo.getAttribute('color') as Float32BufferAttribute;
      let v = 0;
      LANES.forEach((_, li) => {
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 9; c++) {
            const edge = Math.sin((c / 8) * Math.PI);
            const a =
              (r === 0 ? 1 : r === 1 ? 0.85 : 0.4) * edge * (dark ? 0.11 : 0.1) * (laneOn[li] ? 1 : 0.15);
            bAttr.setXYZW(v++, laneC[li]!.r, laneC[li]!.g, laneC[li]!.b, a);
          }
      });
      bAttr.needsUpdate = true;
      glassPast.opacity = dark ? 0.075 : 0.09;
      glassFuture.opacity = dark ? 0.03 : 0.04;
      membraneMat.opacity = dark ? 0.05 : 0.07;
      dashMat.opacity = dark ? 0.75 : 0.85;
      flow.recolor((i) => flowColors(p)[i]);
      flow.setTheme(p.theme);
      flow.setSize(dark ? 0.06 : 0.05);
      flow.setOpacity(dark ? 0.85 : 0.7);
      glows.setTheme(p.theme);
      laneLabels.forEach((h, i) => h.set({ swatch: p.css[LANES[i]!.css] ?? '' }));
      nowLabel.set({ swatch: p.css['scene-highlight'] ?? '' });
      ui.setLaneColors(LANES.map((l) => p.css[l.css] ?? ''));
      writeColors();
    };

    /* ───────── UI (slider, lanes) ───────── */
    const ui = createTunnelUi({
      stage: ctx.stage,
      signal: ctx.signal,
      lanes: LANES.map((l, i) => ({ label: l.label, count: laneCount[i]! })),
      time: { min: T0, max: T1, value: nowT, now: nowT },
      onLane: (i, on) => setLane(i, on),
      onTime: (t) => travel(t, 'slider'),
      onNow: () => travel(nowT, 'button'),
    });
    ctx.track({ dispose: () => ui.dispose() });

    /* ───────── labels: placement & priorities ───────── */
    // Label budget: the fixed labels (years, lanes, 現在) never starve the milestone labels, even on
    // the low tier (12): the milestone share follows the tier, the total stays ≤ 40.
    const fixedLabels = yearLabels.length + LANES.length + 1;
    const labelBudget = (tierMax: number) => Math.min(40, fixedLabels + Math.min(tierMax, close ? 14 : 22));
    const setLabelMode = () => {
      labels.setMax(labelBudget(ctx.tier.maxLabels));
      ms.forEach((m) => {
        const p = msPos[m.index]!;
        const below = close && LANES[m.lane]!.upper;
        msLabels[m.index]!.set({
          align: below ? 'below' : 'above',
          position: vB.copy(p).setY(p.y + (below ? -0.17 : 0.17)),
        });
      });
      yearLabels.forEach((h) => h.set({ kind: close ? 'muted' : 'default' }));
      // Inside the tunnel the 「現在」 label (higher priority) may claim the space of a lane name.
      laneLabels.forEach((h) => h.set({ always: !close }));
    };
    const refreshPriorities = () => {
      ms.forEach((m) => {
        const h = msLabels[m.index]!;
        if (!laneOn[m.lane]) {
          h.set({ visible: false });
          return;
        }
        const dim = dimOf(m);
        let p = 8 + (m.key ? 4 : 0) - dim * 12;
        if (close) {
          const d = m.tx - focusT;
          p += Math.max(0, 12 - Math.abs(d) * 7);
          if (d < -0.5) p -= 8;
        }
        const member = hot && hot.kind !== 'now' && isHotMember(m);
        if (member && hot!.kind === 'trend') p += 200;
        h.set({ visible: true, priority: p, kind: dim > 0.35 ? 'muted' : 'default' });
      });
    };

    /* ───────── camera: poses & time travel ───────── */
    const portraitNow = () => ctx.size.portrait;
    const poseAt = (t: number, kind: MovePose): CameraPose => {
      const pi = portraitNow() ? 1 : 0;
      const target = new Vector3(xOf(t) + LOOK, kind === 'side' ? SIDE_Y[pi] : 0, 0);
      let fov = POSE_FOV[kind][pi];
      // Near-square stages: the host keeps the 16:9 horizontal extent, which would open the round
      // in-tunnel views to a fisheye; keep their vertical extent (the 4:5 value) instead.
      if (kind !== 'side' && squarish())
        fov =
          (2 *
            Math.atan((Math.tan((POSE_FOV[kind][1] * Math.PI) / 360) * ctx.size.aspect) / (16 / 9)) *
            180) /
          Math.PI;
      return { position: target.clone().add(OFFSETS[kind][pi]), target, fov };
    };
    const squarish = () => !ctx.size.portrait && ctx.size.aspect < SQUARE_MAX;
    const homeFor = (): CameraPose => (squarish() ? SQUARE_HOME : ctx.homePose);
    const nearPose = (p: CameraPose) =>
      ctx.camera.position.distanceTo(
        Array.isArray(p.position) ? vN.fromArray(p.position) : (p.position as Vector3),
      ) < 0.6;
    const target = (): Vector3 => ctx.controls?.target ?? vA.set(0, 0, 0);
    let camTween: Tween | null = null;
    const overviewDist = () => OVERVIEW_MIN * (portraitNow() ? 1.3 : 1);

    const travel = (t: number, source: 'slider' | 'wheel' | 'key' | 'button' | 'command') => {
      focusT = clampT(t);
      if (source !== 'slider') ui.setTime(focusT);
      const tg = target();
      const off = vB.copy(ctx.camera.position).sub(tg);
      camTween?.cancel();
      if (off.length() > overviewDist() || !ctx.controls) {
        camTween = ctx.tween.camera(poseAt(focusT, 'fly'), { duration: 1100 });
      } else {
        const dx = xOf(focusT) + LOOK - tg.x;
        let done = 0;
        camTween = ctx.tween.run(
          (k) => {
            const step = dx * k - done;
            done = dx * k;
            ctx.camera.position.x += step;
            tg.x += step;
            ctx.controls?.update();
          },
          { duration: source === 'slider' ? 260 : 420, ease: 'cubicOut' },
        );
      }
      refreshPriorities();
      ctx.invalidate();
    };

    /* ───────── lanes on/off ───────── */
    let pickPoints: ScreenPoint[] = [];
    let pickMs: Milestone[] = [];
    const rebuildPick = () => {
      pickMs = ms.filter((m) => laneOn[m.lane]);
      pickPoints = pickMs.map((m) => ({ position: msPos[m.index]!, id: m.trend.id }));
    };
    rebuildPick();
    const setLane = (i: number, on: boolean) => {
      if (!on && laneOn.filter(Boolean).length === 1 && laneOn[i]) return; // keep at least one lane
      laneOn[i] = on;
      ui.setLane(i, on);
      laneLabels[i]!.set({ kind: on ? 'strong' : 'muted' });
      rebuildPick();
      applyPalette(ctx.palette);
      writeMatrices();
      refreshPriorities();
      ctx.announce(`${LANES[i]!.label}軌道已${on ? '顯示' : '隱藏'}`);
      ctx.invalidate();
    };

    /* ───────── highlight (hover / list) ───────── */
    let hotTween: Tween | null = null;
    const setHot = (h: typeof hot) => {
      const same = (a: typeof hot, b: typeof hot) => a?.kind === b?.kind && a?.value === b?.value;
      if (same(h, hot) && h) return;
      hotTween?.cancel();
      if (h) {
        hot = h;
        if (h.kind === 'trend') writeThread(h.value as string);
      }
      const from = hotK;
      const to = h ? 1 : 0;
      hotTween = ctx.tween.run(
        (k) => {
          hotK = from + (to - from) * k;
          threadMat.opacity = hot?.kind === 'trend' ? 0.9 * hotK : 0;
          writeColors();
          writeMatrices();
        },
        {
          duration: 220,
          ease: 'cubicOut',
          fade: true,
          onComplete: () => {
            if (!h) {
              hot = null;
              threadGeo.setDrawRange(0, 0);
              writeColors();
              writeMatrices();
            }
            refreshPriorities();
          },
        },
      );
      refreshPriorities();
    };
    const writeThread = (id: string) => {
      const list = ms
        .filter((m) => m.trend.id === id && laneOn[m.lane])
        .sort((a, b) => a.tx - b.tx)
        .slice(0, HOT_MAX + 1);
      const attr = threadGeo.getAttribute('position') as Float32BufferAttribute;
      let n = 0;
      for (let i = 0; i + 1 < list.length; i++) {
        const a = msPos[list[i]!.index]!;
        const b = msPos[list[i + 1]!.index]!;
        attr.setXYZ(n++, a.x, a.y * 0.97, a.z * 0.97);
        attr.setXYZ(n++, b.x, b.y * 0.97, b.z * 0.97);
      }
      attr.needsUpdate = true;
      threadGeo.setDrawRange(0, n);
      threadGeo.computeBoundingSphere();
    };

    /* ───────── hotspots ───────── */
    const laneCss = (i: number) => ctx.palette.css[LANES[i]!.css] ?? '';
    const milestoneCard = (m: Milestone): CardContent => ({
      title: cleanLabel(m.label),
      subtitle: `${dateText(m.date)}・${STATUS_LABEL[m.status]}・${LANES[m.lane]!.label}`,
      body: `所屬趨勢：${m.trend.title}${m.date.precision === 'year' ? '。日期只確定到年份。' : ''}`,
      href: m.trend.href ?? `/trends/${m.trend.id}/`,
      linkLabel: '閱讀趨勢 →',
      swatch: laneCss(m.lane),
    });
    const trendCard = (id: string): CardContent | null => {
      const list = ms.filter((m) => m.trend.id === id);
      const tr = list[0]?.trend;
      if (!tr) return null;
      return {
        title: tr.title,
        subtitle: `${LANES[list[0]!.lane]!.label}・${list.length} 個里程碑`,
        items: list
          .slice(0, 5)
          .map((m) => ({ label: m.label, meta: `${dateText(m.date)}・${STATUS_LABEL[m.status]}` })),
        href: tr.href ?? `/trends/${tr.id}/`,
        linkLabel: '閱讀趨勢 →',
        swatch: laneCss(list[0]!.lane),
      };
    };
    for (const id of trendIds) {
      const first = ms.find((m) => m.trend.id === id)!;
      hotspots.register(id, {
        anchor: msPos[first.index]!,
        label: first.trend.title,
        href: first.trend.href ?? `/trends/${id}/`,
        card: (hit) => {
          const m = hit?.index !== undefined && hit.object === ctx.camera ? pickMs[hit.index] : undefined;
          return m && m.trend.id === id ? milestoneCard(m) : trendCard(id);
        },
        onHighlight: (on) => setHot(on ? { kind: 'trend', value: id } : null),
        pose: poseAt(first.tx, 'fly'),
      });
    }
    ctx.picker.addPoints(() => pickPoints, {
      cull: (w) => w.distanceToSquared(ctx.camera.position) > (fog.far * 0.9) ** 2,
    });

    LANES.forEach((lane, i) => {
      const trendsOf = [
        ...new Map(ms.filter((m) => m.lane === i).map((m) => [m.trend.id, m.trend])).values(),
      ];
      hotspots.register(lane.hotspot, {
        anchor: wallPos(T0, lane.angle, RAIL_R).setX(X0 - 0.06),
        card: () => {
          const t = hsText.get(lane.hotspot);
          const c: CardContent = {
            title: t?.label ?? `${lane.label}軌道`,
            swatch: laneCss(i),
            subtitle: `${laneCount[i]} 個里程碑`,
          };
          if (t?.detail) c.body = t.detail;
          if (t?.href) c.href = t.href;
          if (trendsOf.length)
            c.items = trendsOf
              .slice(0, 4)
              .map((tr) => ({ label: tr.title, href: tr.href ?? `/trends/${tr.id}/` }));
          return c;
        },
        onHighlight: (on) => setHot(on ? { kind: 'lane', value: i } : null),
        pose: poseAt(T0 + 0.25, 'entrance'),
      });
    });
    ctx.picker.add(caps, {
      id: (h) => (h.instanceId !== undefined ? (LANES[h.instanceId]?.hotspot ?? null) : null),
    });

    hotspots.register('now', {
      object: badge,
      anchor: badge,
      onHighlight: (on) => setHot(on ? { kind: 'now', value: 0 } : null),
      card: () => {
        const t = hsText.get('now');
        const c: CardContent = {
          title: `現在：${monthText(nowT)}`,
          swatch: ctx.palette.css['scene-highlight'] ?? '',
        };
        if (t?.detail) c.body = t.detail;
        return c;
      },
      pose: poseAt(nowT, 'fly'),
    });
    STATUSES.forEach((s, si) => {
      const first = byStatus[s][0];
      hotspots.register(STATUS_HOTSPOT[s], {
        anchor: first ? msPos[first.index]! : new Vector3(xNow, 0, 0),
        onHighlight: (on) => setHot(on ? { kind: 'status', value: s } : null),
        pose: si === 0 ? poseAt(2025.2, 'fly') : si === 1 ? poseAt(nowT, 'fly') : poseAt(2029.3, 'side'),
      });
    });
    hotspots.register('date-precision', {
      anchor: yearOnly[0] ? msPos[yearOnly[0].index]! : new Vector3(xNow, 0, 0),
      onHighlight: (on) => setHot(on ? { kind: 'precision', value: 0 } : null),
      pose: poseAt(2028.4, 'side'),
    });

    /* ───────── wheel, keys, page command ───────── */
    const view = ctx.root.querySelector<HTMLElement>('.scene-view') ?? ctx.stage;
    let engagedUntil = 0;
    ctx.canvas.addEventListener('pointerdown', () => (engagedUntil = performance.now() + 8000), {
      signal: ctx.signal,
    });
    ctx.canvas.addEventListener(
      'wheel',
      (e) => {
        const engaged =
          e.ctrlKey ||
          performance.now() < engagedUntil ||
          document.activeElement === view ||
          document.fullscreenElement === ctx.root ||
          ctx.root.classList.contains('is-immersive');
        if (!engaged) {
          ui.hint('按住 Ctrl 並滾動，即可在隧道中穿梭時間');
          return;
        }
        e.preventDefault();
        engagedUntil = performance.now() + 8000;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        travel(focusT + Math.max(-240, Math.min(240, dy)) * 0.0022, 'wheel');
      },
      { passive: false, signal: ctx.signal },
    );
    view.addEventListener(
      'keydown',
      (e) => {
        if (e.target !== view || e.altKey || e.metaKey || e.ctrlKey) return;
        const d = e.key === '+' || e.key === '=' ? 0.25 : e.key === '-' || e.key === '_' ? -0.25 : 0;
        if (!d) return;
        e.preventDefault();
        travel(focusT + d, 'key');
      },
      { signal: ctx.signal },
    );
    ctx.root.addEventListener(
      'scene:command',
      (e) => {
        const d = (e as CustomEvent<{ type?: string; t?: number }>).detail;
        if (d?.type === 'time' && typeof d.t === 'number' && Number.isFinite(d.t)) travel(d.t, 'command');
      },
      { signal: ctx.signal },
    );

    /* ───────── steps ───────── */
    let dimTween: Tween | null = null;
    let stepIndex = 0;
    let firstStep = true;
    const showStep = (i: number, animate = true) => {
      stepIndex = i;
      const s = STEPS[i] ?? STEPS[0]!;
      focusT = clampT(s.t === 'now' ? nowT : s.t);
      ui.setTime(focusT);
      dimTween?.cancel();
      const from = [...stepDim];
      dimTween = ctx.tween.run(
        (k) => {
          for (let j = 0; j < 3; j++) stepDim[j] = from[j]! + (s.dim[j]! - from[j]!) * k;
          writeColors();
        },
        { duration: 600, fade: true, onComplete: () => refreshPriorities() },
      );
      camTween?.cancel();
      const pose = s.kind === 'home' ? homeFor() : poseAt(focusT, s.kind);
      // The first call (right after create) cuts to the overview instead of zooming into it.
      camTween = ctx.tween.camera(pose, {
        duration: animate && !(firstStep && s.kind === 'home') ? 1100 : 0,
      });
      firstStep = false;
      refreshPriorities();
    };

    /* ───────── init ───────── */
    applyPalette(ctx.palette);
    writeMatrices();
    setLabelMode();
    refreshPriorities();
    let wasPortrait = ctx.size.portrait;
    let wasSquare = squarish();
    let nowInside = false;
    let laneLabelX = Infinity;
    const laneX = [0, 0, 0, 0];
    /**
     * Overview: names to the left of the entrance (the far-side rails above their cap). When the
     * entrance touches the stage edge (narrow stages) the top and bottom rails take above / below
     * and the middle two go to the right, nudged apart. Inside the tunnel: centred on the rail.
     */
    const placeLaneLabels = () => {
      if (close) {
        laneLabels.forEach((h) => h.set({ align: 'center', offset: [0, 0] }));
        return;
      }
      let minX = Infinity;
      LANES.forEach((_, i) => {
        laneX[i] = ctx.project(laneLabelPos[i]!)?.x ?? 0;
        minX = Math.min(minX, laneX[i]!);
      });
      const narrow = minX < 84;
      LANES.forEach((l, i) => {
        const back = Math.cos(l.angle) < 0;
        const h = laneLabels[i]!;
        if (!narrow) h.set({ align: back ? 'above' : 'left', offset: [0, 0] });
        else if (back === l.upper)
          h.set({ align: l.upper ? 'above' : 'below', offset: [Math.max(0, 36 - laneX[i]!), 0] });
        else h.set({ align: 'right', offset: [0, l.upper ? -5 : 5] });
      });
    };

    return {
      update(_dt, t) {
        flow.update(t);
        const cam = ctx.camera;
        const tg = target();
        const dist = cam.position.distanceTo(tg);
        // Fog: only inside / near the tunnel, so the far future fades into the background.
        const k = smooth(overviewDist() + 3, overviewDist() - 4, dist);
        fog.near = 200 + (7 - 200) * k;
        fog.far = 400 + (27 - 400) * k;
        const nextClose = dist < overviewDist();
        if (nextClose !== close) {
          close = nextClose;
          laneLabelX = Infinity;
          setLabelMode();
          refreshPriorities();
        }
        // Lane labels: at the entrance in the overview, a few units ahead of the camera inside.
        // (The target bound keeps them in frame in the steep portrait side view; on near-square
        // stages they sit a bit deeper, so the lower two clear the time slider.)
        const ahead = squarish() ? 5.6 : 4.6;
        const lx = close
          ? Math.min(X1 - 0.6, Math.max(X0 + 0.3, cam.position.x + ahead, tg.x - 0.6))
          : X0 - 0.3;
        if (Math.abs(lx - laneLabelX) > 0.02) {
          laneLabelX = lx;
          LANES.forEach((l, i) =>
            laneLabels[i]!.set({ position: wallPos(0, l.angle, RAIL_R, laneLabelPos[i]!).setX(lx) }),
          );
          placeLaneLabels();
        }
        // 「現在」 label: above the badge; just inside the ring's top once the badge leaves the frame
        // (standing in front of the ring, e.g. step 3 and the 現在 button).
        const pb = close ? ctx.project(vN.set(xNow, R + 0.5, 0)) : null;
        const inside = close && (!pb || pb.y < 44 || pb.x < 0 || pb.x > ctx.size.width);
        if (inside !== nowInside) {
          nowInside = inside;
          nowLabel.set(
            inside
              ? { position: [0, R - 0.16, 0], align: 'below' }
              : { position: [0, R + 0.5, 0], align: 'above' },
          );
        }
        // Rings face the camera.
        if (Math.abs(cam.quaternion.dot(lastQ)) < 0.999999 || cam.position.distanceToSquared(lastP) > 1e-6) {
          lastQ.copy(cam.quaternion);
          lastP.copy(cam.position);
          writeMatrices();
          if (!ctx.animate) writeGlows();
          placeLaneLabels();
        }
        if (ctx.animate) {
          breath = Math.sin(t * 1.6) * 0.5 + 0.5;
          writeGlows();
        }
      },
      setStep(i) {
        showStep(i);
      },
      setVariant() {
        showStep(stepIndex, false);
        return true;
      },
      onMotion(animate) {
        flow.setReduced(!animate);
        if (!animate) {
          breath = 0;
          writeGlows();
        }
      },
      onQuality(_q, tier) {
        flow.setCount(scaleCount(FLOW_MAX, tier, 40));
        labels.setMax(labelBudget(tier.maxLabels));
      },
      onPalette(p) {
        applyPalette(p);
      },
      onResize(size) {
        placeLaneLabels();
        const sq = squarish();
        if (size.portrait !== wasPortrait || sq !== wasSquare) {
          wasPortrait = size.portrait;
          wasSquare = sq;
          if (stepIndex > 0) showStep(stepIndex, false);
          // Resting at the overview (the host re-applies its home pose on a portrait flip):
          // switch to the framing for the new stage shape.
          else if (nearPose(ctx.homePose) || nearPose(SQUARE_HOME))
            camTween = ctx.tween.camera(homeFor(), { duration: 0 });
        }
      },
      dispose() {
        camTween?.cancel();
        dimTween?.cancel();
        hotTween?.cancel();
        scene.fog = null;
        root.removeFromParent();
      },
    };
  },
});

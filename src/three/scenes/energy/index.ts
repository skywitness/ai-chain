/**
 * energy — GW 級 AI：電力與能源 (variants: grid, onsite).
 *
 * A calm low-poly "technical diorama" on a rounded terrain plate (sizes and distances are 示意).
 *  - grid: a regional grid feeding a GW-scale AI campus. Back-left: a large nuclear plant
 *    (containment + dome, auxiliary building, turbine hall, hyperboloid cooling tower, cooling
 *    water) and an SMR site with three modules. Front-left: a combined-cycle gas plant (two gas
 *    turbines → HRSGs → stacks, a steam turbine hall) fed by a gas pipeline (pale yellow, unlike the amber power). Back-right: a
 *    solar field and battery containers. Every plant steps up at a gantry onto a three-phase
 *    line (delta pylons, three sagging conductors) into the grid substation, which steps down and
 *    feeds the campus substation and the data halls. Amber PathFlow particles = electricity.
 *  - onsite: behind-the-meter. Gas turbines, reciprocating gensets and fuel cells inside the
 *    campus fence (fed by a gas pipeline), a battery buffer, two flexible halls, and a metered
 *    back-up tie to the utility grid.
 *
 * Steps (由淺入深): 總覽 → 用電需求 (equal 1 GW columns: campus vs a large reactor, 示意) →
 * 發電來源 (nameplate frame vs average-output fill, 示意) → 輸電與變電 (step-up, three-phase
 * lines, step-down) → 自建電源 (onsite) → 瓶頸與交期 (interconnection queue, turbine and
 * transformer lead times, finished halls waiting for power).
 * Reduced motion: static dotted flows, frozen steam and clocks, each step's final state.
 * Portrait stages: the camera orbits to the east side so the plate's long axis runs up the screen.
 * Narrow stages (phones, < 640 px): a compact label placement (side, anchor, offset, shorter text).
 * The two variants share little geometry, so a variant switch remounts the scene.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  TorusGeometry,
  Vector3,
  type MeshStandardMaterialParameters,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type HotspotSpec,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type SceneCommand,
  type SceneContext,
  type Tween,
} from '../../core/types';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  Facility,
  Fx,
  PartList,
  addGantry,
  box,
  cyl,
  coolingTower,
  dome,
  plateGrid,
  pylonGeometry,
  rbox,
  rod,
  roundedRect,
  routeWires,
  supportsFor,
  towerTopRadius,
  type Support,
  type Tint,
  type XZ,
} from './parts';

type Variant = 'grid' | 'onsite';
type V3 = [number, number, number];

/* ───────────────────────── camera ───────────────────────── */

interface Orbit {
  t: V3;
  d: number;
  az: number;
  el: number;
  /** Extra distance factor on portrait stages (close-up steps need more room on a narrow stage). */
  pd?: number;
  /** Portrait azimuth / elevation offsets (default: orbit to the east side, slightly higher). */
  paz?: number;
  pel?: number;
  /** Portrait target offset. */
  pt?: V3;
  /** Extra elevation on narrow landscape stages (phones at 4:3; default NARROW_EL). */
  nel?: number;
}
const D2R = Math.PI / 180;
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const PORTRAIT_AZ = 72;
const PORTRAIT_EL = 6;
/**
 * Narrow landscape stages (phones, 4:3) keep the horizontal extent of the 16:9 framing, so the flat
 * plate leaves the lower quarter empty: look down more steeply there to give the labels room.
 */
const NARROW_EL = 14;
function orbit(o: Orbit, portrait = false): CameraPose {
  const az = (o.az + (portrait ? (o.paz ?? PORTRAIT_AZ) : 0)) * D2R;
  const el = (o.el + (portrait ? (o.pel ?? PORTRAIT_EL) : 0)) * D2R;
  const [x, y, z] = portrait && o.pt ? add3(o.t, o.pt) : o.t;
  const d = o.d * (portrait ? (o.pd ?? 1) : 1);
  return {
    position: [x + d * Math.cos(el) * Math.sin(az), y + d * Math.sin(el), z + d * Math.cos(el) * Math.cos(az)],
    target: [x, y, z],
  };
}
const HOME: Record<Variant, Orbit> = {
  grid: { t: [0, -0.9, -0.45], d: 19.6, az: 0, el: 45 },
  onsite: { t: [0, -0.9, -0.38], d: 19.4, az: 0, el: 46 },
};
/** Portrait home distance (both variants frame the whole plate). */
const PORTRAIT_D = 20.8;
/** Portrait home: nudge the target toward the camera (east) so the plate sits centred on the stage. */
const PORTRAIT_T: V3 = [0.9, 0, -0.35];
const cameraFor = (v: Variant) => ({
  ...orbit(HOME[v]),
  fov: 34,
  minDistance: 5,
  maxDistance: 30,
  minPolar: 0.18,
  maxPolar: 1.32,
  portrait: { ...orbit({ ...HOME[v], t: add3(HOME[v].t, PORTRAIT_T), d: PORTRAIT_D }, true), fov: 46 },
});

/** Step poses; null = home. Index = step. */
const STEP_POSES: Record<Variant, readonly (Orbit | null)[]> = {
  grid: [
    null,
    // 用電需求: the camera sits on the perpendicular bisector of the reactor ↔ campus columns, so
    // both are equally far away and equal heights read as equal on screen (also in portrait).
    { t: [-1.0, 1.15, 0.18], d: 16.2, az: -25, el: 12, paz: 0, pel: 14, pd: 1.32, pt: [0, -0.5, 0], nel: 6 },
    // 發電來源: from the front-left, so the four columns (nuclear, gas, solar, campus) separate on screen.
    // Portrait: from the south-east (az 45°), where no column hides behind another.
    { t: [0, 1.0, 0.3], d: 20.5, az: -12, el: 27, paz: 57, pel: 8, pt: [-0.5, -0.2, 0.2], nel: 9 },
    { t: [0.1, 0.0, -0.1], d: 13.4, az: 12, el: 37, pd: 1.2 },
    null,
    { t: [-0.55, -0.1, 0.65], d: 16.2, az: -2, el: 42, pd: 1.24 },
  ],
  onsite: [null, null, null, null, null, null],
};

/* ───────────────────────── layout (world units, 示意) ───────────────────────── */

const PLATE = { w: 16.6, d: 9.9, cz: -0.4, r: 1.1, t: 0.36 };
const COL_H = 3.0; // column height for 1 GW (示意)
/** Portrait stages have vertical room to spare: the comparison columns grow taller there. */
const COL_PORTRAIT = 1.5;
/** Stages narrower than this (CSS px; phones) use the compact label placement. */
const NARROW = 640;

const NUC = { x: -5.5, z: -2.2 };
const TOWER = { x: NUC.x + 1.45, z: NUC.z - 1.3, h: 1.9, rb: 0.74, rw: 0.45 };
const LAKE = { x: -5.9, z: -4.3, rx: 1.75, rz: 0.55 };
const SMR = { x: -1.85, z: -3.45 };
const GAS = { x: -5.25, z: 1.85 };
const SOLAR = { x0: 1.35, z0: -4.6, cols: 6, rows: 8, dx: 0.73, dz: 0.29 };
const BESS = { x: 6.8, z: -3.35 };
const SUB = { x: 0.3, z: 0.1 };
/** Step 5: an ordered (not yet delivered) gas turbine in front of the gas plant. */
const LEAD = { x: -3.15, z: 3.05 };
const CAMPUS: Record<Variant, XZ> = { grid: [4.8, 2.55], onsite: [3.75, 0.75] };
const subTr = (i: number): V3 => [SUB.x - 0.7 + 0.7 * i, 0.3, SUB.z + 0.1];

/** Onsite generation (behind the meter). */
const OT = { xs: [-5.1, -3.65, -2.2], z: -2.65 };
const OE = { x0: -5.5, dx: 0.62, n: 5, zs: [-1.27, -0.73] };
const OF = { x0: -5.55, dx: 0.5, n: 6, zs: [0.78, 1.18, 1.58] };
const OB = { xs: [1.25, 1.92, 2.59], zs: [2.5, 2.97] };
/** Revenue meter where the utility tie crosses the campus fence (point of interconnection). */
const METER = { x: 5.75, z: -2.9 };
/** Utility tie: from the back-right plate corner, diagonally across the fence to the campus substation. */
const UTIL: XZ[] = [
  [7.55, -4.45],
  [6.45, -3.35],
  [4.6, -2.15],
];
const FENCE_O = { x0: -7.05, x1: 5.75, z0: -3.5, z1: 3.75 };
/** Buried medium-voltage cable trenches: the collector runs along x, the trunk east along z. */
const CABLE = { x: -0.7, z: 0.26, w: 0.08 };
/** Onsite electrical yards (step-up transformers of each generation block). */
const OTR = { t: [-1.4, -2.25] as XZ, e: [-2.1, -0.4] as XZ, f: [-2.15, 1.2] as XZ };

interface RouteSpec {
  pts: XZ[];
  from: V3;
  to: V3;
  /** Override the support kinds at the ends (default gantry). */
  startPylon?: boolean;
  flow?: boolean;
}

/* ───────────────────────── colours ───────────────────────── */

const WHITE = new Color(1, 1, 1);
const isDark = (p: Palette) => p.theme === 'dark';
const T = {
  ground: (p: Palette) => p.bg.clone().lerp(p.muted, isDark(p) ? 0.17 : 0.15),
  pad: (p: Palette) => p.bg.clone().lerp(p.muted, isDark(p) ? 0.32 : 0.3),
  trench: (p: Palette) => p.bg.clone().lerp(p.muted, isDark(p) ? 0.5 : 0.5),
  concrete: (p: Palette) => (isDark(p) ? p.bg.clone().lerp(p.fg, 0.5) : p.bg.clone().lerp(WHITE, 0.6)),
  concrete2: (p: Palette) => (isDark(p) ? p.bg.clone().lerp(p.fg, 0.38) : p.bg.clone().lerp(p.muted, 0.1)),
  roof: (p: Palette) => (isDark(p) ? p.bg.clone().lerp(p.fg, 0.26) : p.bg.clone().lerp(p.muted, 0.3)),
  steel: (p: Palette) => (isDark(p) ? p.muted.clone().lerp(p.fg, 0.3) : p.fg.clone().lerp(p.bg, 0.52)),
  porcelain: (p: Palette) => (isDark(p) ? p.fg.clone().lerp(p.bg, 0.15) : p.bg.clone().lerp(p.muted, 0.45)),
  hole: (p: Palette) => (isDark(p) ? p.bg.clone().multiplyScalar(0.6) : p.fg.clone().lerp(p.bg, 0.45)),
  tree: (p: Palette) => p.pos.clone().lerp(p.bg, isDark(p) ? 0.5 : 0.42).lerp(p.muted, 0.15),
  water: (p: Palette) => p.coolant.clone().lerp(p.bg, isDark(p) ? 0.45 : 0.4),
  wire: (p: Palette) => p.fg.clone().lerp(p.bg, isDark(p) ? 0.45 : 0.4),
};
const A = {
  nuclear: (p: Palette) => p.optic.clone(),
  gas: (p: Palette) => p.heat.clone(),
  solar: (p: Palette) => p.coolant.clone().lerp(isDark(p) ? p.bg : p.fg, 0.18),
  battery: (p: Palette) => p.pos.clone(),
  campus: (p: Palette) => p.seg['datacenter-infra'].clone(),
  // Natural-gas pipe: a paler, quieter yellow than the amber electricity it must not be confused with.
  // On dark, darkening it toward the background would turn it amber too, so it is lightened instead.
  pipe: (p: Palette) => (p.chart[3] ?? p.highlight).clone().lerp(isDark(p) ? p.fg : p.bg, isDark(p) ? 0.42 : 0.38),
  fuel: (p: Palette) => (p.chart[4] ?? p.optic).clone(),
  power: (p: Palette) => p.power.clone(),
  meter: (p: Palette) => p.highlight.clone(),
  neg: (p: Palette) => p.neg.clone(),
};
const SW = {
  nuclear: 'scene-optic',
  gas: 'scene-heat',
  solar: 'scene-coolant',
  battery: 'c-pos',
  campus: 'seg-datacenter-infra',
  power: 'scene-power',
  pipe: 'chart-4', // shown as the lightened pipe tint (swatchCss)
  fuel: 'chart-5',
  meter: 'scene-highlight',
} as const;

/** CSS colour for a label / card swatch: the gas pipe uses its own (lightened) tint, the rest a token. */
const swatchCss = (key: keyof typeof SW, p: Palette): string => (key === 'pipe' ? `#${A.pipe(p).getHexString()}` : (p.css[SW[key]] ?? ''));

/* ───────────────────────── helpers ───────────────────────── */

const dummy = new Object3D();
interface Inst {
  x: number;
  y?: number;
  z: number;
  rx?: number;
  ry?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}
function placeInstances(mesh: InstancedMesh, items: readonly Inst[]): void {
  items.forEach((it, i) => {
    dummy.position.set(it.x, it.y ?? 0, it.z);
    dummy.rotation.set(it.rx ?? 0, it.ry ?? 0, 0);
    dummy.scale.set(it.sx ?? 1, it.sy ?? 1, it.sz ?? 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}

/** Pin a smoothed (Catmull-Rom) path to its right-angle corners: add a point just before and after each one. */
function tight(pts: readonly Vector3[], r = 0.1): Vector3[] {
  const out: Vector3[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const a = pts[i - 1]!;
    const b = pts[i + 1]!;
    const ra = Math.min(r, a.distanceTo(p) / 3);
    const rb = Math.min(r, b.distanceTo(p) / 3);
    out.push(p.clone().lerp(a, ra / Math.max(1e-6, a.distanceTo(p))), p, p.clone().lerp(b, rb / Math.max(1e-6, b.distanceTo(p))));
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Hotspot to pre-select after a step / variant change triggered from the hotspot list. */
let pending: string | null = null;

/* ───────────────────────── scene ───────────────────────── */

export default defineScene({
  json,
  meta: {
    camera: cameraFor('grid'),
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 48, tris: 48_000 },
    variants: { onsite: { camera: cameraFor('onsite') } },
  },

  create(ctx: SceneContext) {
    const { scene, labels, hotspots } = ctx;
    const variant: Variant = ctx.variant === 'onsite' ? 'onsite' : 'grid';
    const isGrid = variant === 'grid';
    const root = new Group();
    root.name = 'energy';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    let portrait = ctx.size.portrait;
    let narrow = ctx.size.width < NARROW;
    let colH = COL_H * (portrait ? COL_PORTRAIT : 1);
    const P = (o: Orbit | null): CameraPose => {
      if (narrow && !portrait) {
        const b = o ?? HOME[variant];
        return orbit({ ...b, el: b.el + (b.nel ?? NARROW_EL) });
      }
      return o ? orbit(o, portrait) : ctx.homePose;
    };

    /* ───────── registries ───────── */
    const facilities = new Map<string, Facility>();
    const fxs = new Map<string, Fx>(); // every dimmable thing by key
    const recolors: ((p: Palette) => void)[] = [];
    const fac = (key: string, list: PartList, params?: MeshStandardMaterialParameters): Facility => {
      const f = new Facility(list, params, key);
      ctx.track(f.mesh.geometry);
      ctx.track(f.mesh.material);
      root.add(f.mesh);
      facilities.set(key, f);
      fxs.set(key, f.fx);
      return f;
    };
    /** InstancedMesh with per-instance tints and an Fx on its material. */
    const instanced = (key: string | null, geo: BufferGeometry, items: readonly Inst[], tint: (i: number, p: Palette) => Color, params: MeshStandardMaterialParameters = {}) => {
      const mat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, ...params }));
      const mesh = ctx.track(new InstancedMesh(ctx.track(geo), mat, Math.max(1, items.length)));
      placeInstances(mesh, items);
      mesh.setColorAt(0, WHITE);
      const fx = new Fx(mat);
      if (key) fxs.set(key, fx);
      recolors.push((p) => {
        for (let i = 0; i < items.length; i++) mesh.setColorAt(i, tint(i, p));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        fx.apply(p);
      });
      root.add(mesh);
      return { mesh, fx };
    };

    /* ───────── plate, grid, shadow ───────── */
    const plateGeo = ctx.track(
      new ExtrudeGeometry(roundedRect(PLATE.w - 0.24, PLATE.d - 0.24, PLATE.r), {
        depth: PLATE.t - 0.12,
        bevelEnabled: true,
        bevelThickness: 0.06,
        bevelSize: 0.12,
        bevelSegments: 3,
        curveSegments: 10,
      }),
    );
    plateGeo.rotateX(-Math.PI / 2);
    plateGeo.translate(0, -(PLATE.t - 0.06), PLATE.cz);
    const plate = new Mesh(plateGeo, ctx.materials.standard(T.ground, { roughness: 0.95, metalness: 0 }));
    root.add(plate);

    const pgrid = plateGrid(PLATE.w - 0.8, PLATE.d - 0.8, 0.5);
    const pgridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const pgridLines = new LineSegments(ctx.track(pgrid.geometry), pgridMat);
    pgridLines.position.set(0, 0.004, PLATE.cz);
    root.add(pgridLines);

    const shadowMat = ctx.track(new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = new Mesh(ctx.track(new PlaneGeometry(PLATE.w * 1.5, PLATE.d * 1.6)), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, -PLATE.t - 0.02, PLATE.cz);
    root.add(shadow);

    /* ───────── shared builders ───────── */
    const steel = new PartList(); // gantries + yard steel (one facility)
    const wireSegs: number[] = [];
    const pylonItems: Inst[] = [];
    const powerPaths: FlowPath[] = [];
    const waitPaths: FlowPath[] = [];
    const gasPaths: FlowPath[] = [];
    const v3 = (a: readonly number[]) => new Vector3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);

    const addRoute = (r: RouteSpec): Support[] => {
      const sup = supportsFor(r.pts);
      if (r.startPylon) sup[0]!.kind = 'pylon';
      for (const s of sup) {
        if (s.kind === 'pylon') pylonItems.push({ x: s.x, z: s.z, ry: s.yaw });
        else addGantry(steel, T.steel, s.x, s.z, s.yaw);
      }
      const { segs, top } = routeWires(sup);
      wireSegs.push(...segs);
      if (r.flow !== false) powerPaths.push({ points: [v3(r.from), ...top, v3(r.to)] });
      return sup;
    };

    const transformer = (L: PartList, x: number, z: number, s = 1, ry = 0) => {
      const c = Math.cos(ry);
      const sn = Math.sin(ry);
      const at = (lx: number, lz: number) => ({ x: x + lx * c + lz * sn, z: z - lx * sn + lz * c });
      L.add(rbox(0.3 * s, 0.24 * s, 0.22 * s, 0.025), T.steel, { x, z, ry });
      for (const k of [-1, 1]) L.add(box(0.04 * s, 0.19 * s, 0.2 * s), T.steel, { ...at(k * 0.18 * s, 0), ry });
      for (const k of [-0.08, 0, 0.08]) L.add(cyl(0.014 * s, 0.022 * s, 0.13 * s, 6), T.porcelain, { ...at(k * s, -0.03 * s), y: 0.24 * s, ry });
    };

    /* ───────── campus (both variants) ───────── */
    const [cx, cz] = CAMPUS[variant];
    const hallPos: V3[] = [];
    const campusA = new PartList();
    const campusB = new PartList(); // the front row: "waiting" halls (grid) / flexible load (onsite)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 2; c++) {
        const hx = cx + (c ? 0.72 : -0.72);
        const hz = cz + (r - 1) * 0.8;
        hallPos.push([hx, 0.34, hz]);
        const L = r === 2 ? campusB : campusA;
        L.add(rbox(1.3, 0.34, 0.54, 0.04), T.concrete, { x: hx, z: hz });
        L.add(box(1.306, 0.05, 0.546), A.campus, { x: hx, y: 0.235, z: hz });
        L.add(box(1.2, 0.02, 0.44), T.roof, { x: hx, y: 0.34, z: hz });
        for (let u = 0; u < 5; u++) for (let w = 0; w < 2; w++) L.add(box(0.13, 0.06, 0.12), T.steel, { x: hx - 0.44 + u * 0.22, y: 0.36, z: hz - 0.1 + w * 0.2 });
      }
    const csx = cx - 2.05;
    const csz = cz - 0.75;
    campusA.add(box(0.86, 0.012, 1.22), T.pad, { x: csx, z: csz + 0.25 });
    transformer(campusA, csx + 0.12, csz + 0.02);
    transformer(campusA, csx + 0.12, csz + 0.5);
    campusA.add(rbox(0.36, 0.2, 0.3), T.concrete2, { x: csx + 0.05, z: csz + 0.98 });
    const campusTr: V3 = [csx + 0.12, 0.26, csz + 0.26];
    const fA = fac('campus', campusA);
    const fB = fac('campusB', campusB);
    // Internal feeders: campus transformers → each hall (along the gaps between rows).
    hallPos.forEach(([hx, , hz], i) => {
      const gapZ = hz - 0.4;
      const pts = [new Vector3(...campusTr), new Vector3(csx + 0.55, 0.07, gapZ), new Vector3(hx - 0.5, 0.07, gapZ), new Vector3(hx - 0.25, 0.3, hz - 0.12)];
      (isGrid && i >= 4 ? waitPaths : powerPaths).push({ points: pts, weight: 0.5, speed: 0.8 });
    });

    /* ───────── variant content ───────── */
    const fences: number[] = []; // dashed boundary segments (x,z pairs flattened as 3D)
    const rectLoop = (x0: number, z0: number, x1: number, z1: number, r: number) => {
      const s = roundedRect(x1 - x0, z1 - z0, r, (x0 + x1) / 2, (z0 + z1) / 2);
      const pts = s.getPoints(8);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        fences.push(a.x, 0.02, a.y, b.x, 0.02, b.y);
      }
    };
    rectLoop(csx - 0.55, csz - 0.55, cx + 1.55, cz + 1.25, 0.25);

    const glowSpecs: { pos: V3; size: number; tint: Tint; alpha: number }[] = [];
    const steam: number[] = []; // glow indices
    const stacks: { i: number; base: number }[] = [];
    const glow = (pos: V3, size: number, tint: Tint, alpha: number) => glowSpecs.push({ pos, size, tint, alpha }) - 1;
    const hallGlow = hallPos.map((p) => glow([p[0], 0.5, p[2]], 1.15, A.campus, 0.28));

    let pylonsMesh: InstancedMesh | null = null;
    let solarMesh: InstancedMesh | null = null;
    const treeCentres: [number, number, number][] = [];

    if (isGrid) {
      /* nuclear */
      const N = new PartList();
      const cx0 = NUC.x - 0.6;
      N.add(cyl(0.56, 0.56, 0.7, 28), T.concrete, { x: cx0, z: NUC.z });
      N.add(dome(0.56, 28), T.concrete, { x: cx0, y: 0.7, z: NUC.z });
      N.add(cyl(0.572, 0.572, 0.07, 28), A.nuclear, { x: cx0, y: 0.52, z: NUC.z });
      N.add(rbox(0.72, 0.42, 0.92), T.concrete2, { x: NUC.x + 0.15, z: NUC.z - 0.05 });
      N.add(rbox(1.2, 0.5, 0.6), T.concrete, { x: NUC.x + 1.05, z: NUC.z + 0.18 });
      N.add(box(1.14, 0.025, 0.54), T.roof, { x: NUC.x + 1.05, y: 0.5, z: NUC.z + 0.18 });
      N.add(coolingTower(TOWER.h, TOWER.rb, TOWER.rw), T.concrete, { x: TOWER.x, z: TOWER.z });
      N.add(cyl(TOWER.rb * 0.99, TOWER.rb + 0.012, 0.12, 28, true), T.hole, { x: TOWER.x, z: TOWER.z });
      N.add(new CircleGeometry(towerTopRadius(TOWER.h, TOWER.rb, TOWER.rw) - 0.01, 28), T.hole, { x: TOWER.x, y: TOWER.h - 0.05, z: TOWER.z, rx: -Math.PI / 2 });
      N.add(rod([NUC.x - 0.3, 0.05, NUC.z - 0.5], [LAKE.x + 0.4, 0.05, LAKE.z + 0.35], 0.04), T.steel);
      transformer(N, NUC.x + 1.75, NUC.z + 0.82);
      fac('nuclear', N);
      treeCentres.push([-7.4, -0.4, 6], [-3.0, -0.4, 4], [-0.2, -4.55, 5], [-3.4, -4.6, 4]);

      /* SMR site: three small modules on one reactor building */
      const S = new PartList();
      S.add(rbox(1.7, 0.24, 0.72), T.concrete2, { x: SMR.x, z: SMR.z });
      for (const i of [-1, 0, 1]) {
        const x = SMR.x + i * 0.5;
        S.add(cyl(0.17, 0.17, 0.16, 20), T.concrete, { x, y: 0.24, z: SMR.z });
        S.add(dome(0.17, 20), T.concrete, { x, y: 0.4, z: SMR.z });
        S.add(cyl(0.178, 0.178, 0.035, 20), A.nuclear, { x, y: 0.31, z: SMR.z });
      }
      S.add(rbox(0.95, 0.3, 0.36), T.concrete, { x: SMR.x + 0.15, z: SMR.z + 0.62 });
      transformer(S, SMR.x + 0.95, SMR.z + 0.66, 0.85);
      fac('smr', S);

      /* combined-cycle gas plant */
      const Gp = new PartList();
      for (let b = 0; b < 2; b++) {
        const bx = GAS.x - 0.6 + b * 1.0;
        Gp.add(rbox(0.36, 0.3, 0.82), T.concrete, { x: bx, z: GAS.z + 0.55 });
        Gp.add(box(0.366, 0.05, 0.826), A.gas, { x: bx, y: 0.2, z: GAS.z + 0.55 });
        Gp.add(rbox(0.42, 0.24, 0.3), T.concrete2, { x: bx, y: 0.3, z: GAS.z + 0.8 });
        Gp.add(rbox(0.46, 0.64, 0.6), T.concrete2, { x: bx, z: GAS.z - 0.2 });
        Gp.add(cyl(0.075, 0.09, 1.3, 14), T.concrete, { x: bx, z: GAS.z - 0.68 });
        Gp.add(cyl(0.079, 0.079, 0.06, 14), A.gas, { x: bx, y: 1.16, z: GAS.z - 0.68 });
        Gp.add(rod([bx, 0.07, GAS.z + 1.25], [bx, 0.07, GAS.z + 0.97], 0.03), A.pipe);
        stacks.push({ i: glow([bx, 1.45, GAS.z - 0.68], 0.55, A.gas, 0.3), base: 0.3 });
      }
      Gp.add(rbox(0.75, 0.44, 0.8), T.concrete, { x: GAS.x + 1.15, z: GAS.z + 0.1 });
      Gp.add(box(0.7, 0.025, 0.74), T.roof, { x: GAS.x + 1.15, y: 0.44, z: GAS.z + 0.1 });
      transformer(Gp, GAS.x + 1.78, GAS.z - 0.42);
      // Pipeline from the plate edge: metering station → header → turbines.
      const pz = GAS.z + 1.25;
      const GAS_Y = 0.07 + 0.034; // gas particles ride along the top of the pipe
      Gp.add(rod([-PLATE.w / 2 + 0.25, 0.07, pz], [GAS.x - 0.6, 0.07, pz], 0.035), A.pipe);
      Gp.add(rod([GAS.x - 0.6, 0.07, pz], [GAS.x + 0.4, 0.07, pz], 0.03), A.pipe);
      Gp.add(rbox(0.3, 0.17, 0.24), A.pipe, { x: -7.15, z: pz });
      fac('gas', Gp);
      for (let b = 0; b < 2; b++) {
        const bx = GAS.x - 0.6 + b * 1.0;
        gasPaths.push({ points: tight([v3([-PLATE.w / 2 + 0.3, GAS_Y, pz]), v3([bx, GAS_Y, pz]), v3([bx, GAS_Y, GAS.z + 0.97])]) });
      }
      treeCentres.push([-7.3, 3.4, 5], [-1.6, 2.4, 5], [-1.3, 3.75, 4]);

      /* solar field + battery containers */
      const tex = ctx.track(
        canvasTexture(128, 64, (g, w, h) => {
          g.fillStyle = 'white'; // neutral base: the panel tint comes from the instance colour
          g.fillRect(0, 0, w, h);
          g.strokeStyle = 'rgba(0,0,0,0.28)';
          g.lineWidth = 2;
          for (let x = 0; x <= w; x += w / 8) g.strokeRect(x, 0, 0.01, h);
          for (let y = 0; y <= h; y += h / 3) g.strokeRect(0, y, w, 0.01);
        }),
      );
      const panels: Inst[] = [];
      for (let r = 0; r < SOLAR.rows; r++)
        for (let c = 0; c < SOLAR.cols; c++) panels.push({ x: SOLAR.x0 + c * SOLAR.dx, y: 0.075, z: SOLAR.z0 + r * SOLAR.dz, rx: 0.45 });
      const solar = instanced('solar', new BoxGeometry(0.66, 0.018, 0.21), panels, (_, p) => A.solar(p), { map: tex, roughness: 0.32, metalness: 0.35 });
      const posts: Inst[] = panels.map((pn) => ({ x: pn.x, y: 0, z: pn.z }));
      instanced('solar2', box(0.03, 0.07, 0.03), posts, (_, p) => T.steel(p));
      solarMesh = solar.mesh;

      const Bs = new PartList();
      for (let r = 0; r < 4; r++)
        for (const k of [-1, 1]) {
          const x = BESS.x + k * 0.33;
          const z = BESS.z + (r - 1.5) * 0.42;
          Bs.add(rbox(0.56, 0.24, 0.24, 0.025), T.concrete, { x, z });
          Bs.add(box(0.566, 0.045, 0.246), A.battery, { x, y: 0.17, z });
        }
      for (let r = 0; r < 4; r++) Bs.add(rbox(0.16, 0.16, 0.12), T.steel, { x: SOLAR.x0 + SOLAR.cols * SOLAR.dx - 0.1, z: SOLAR.z0 + (r * 2 + 0.5) * SOLAR.dz });
      transformer(Bs, 4.65, -1.95);
      fac('bess', Bs);
      treeCentres.push([7.3, -0.6, 5], [7.3, 3.8, 3], [1.9, 3.8, 3]);

      /* grid substation */
      const Sb = new PartList();
      Sb.add(box(2.6, 0.012, 1.7), T.pad, { x: SUB.x, z: SUB.z });
      const St = new PartList();
      for (let i = 0; i < 3; i++) transformer(St, SUB.x - 0.7 + 0.7 * i, SUB.z + 0.1, 1.25);
      fac('subTr', St);
      for (const z of [SUB.z - 0.45, SUB.z + 0.6]) {
        Sb.add(rod([SUB.x - 1.05, 0.46, z], [SUB.x + 1.05, 0.46, z], 0.012, 5), T.steel);
        for (let x = SUB.x - 1.0; x <= SUB.x + 1.01; x += 0.5) Sb.add(box(0.03, 0.46, 0.03), T.steel, { x, z });
      }
      Sb.add(rbox(0.42, 0.22, 0.3), T.concrete2, { x: SUB.x + 1.0, z: SUB.z + 0.6 });
      fac('sub', Sb);
      rectLoop(SUB.x - 1.32, SUB.z - 0.87, SUB.x + 1.32, SUB.z + 0.87, 0.12);

      /* transmission lines */
      addRoute({ pts: [[NUC.x + 2.1, NUC.z + 0.7], [-2.6, -1.18], [-1.7, -0.78], [-1.0, -0.45]], from: [NUC.x + 1.75, 0.24, NUC.z + 0.82], to: subTr(0) });
      addRoute({ pts: [[SMR.x + 1.25, SMR.z + 0.78], [-0.4, -1.8], [-0.1, -0.78]], from: [SMR.x + 0.95, 0.2, SMR.z + 0.66], to: subTr(1) });
      addRoute({ pts: [[GAS.x + 2.12, GAS.z - 0.5], [-2.3, 1.02], [-1.5, 0.74], [-1.0, 0.55]], from: [GAS.x + 1.78, 0.24, GAS.z - 0.42], to: subTr(0) });
      addRoute({ pts: [[4.3, -1.75], [3.3, -1.5], [2.3, -1.18], [1.35, -0.78]], from: [4.65, 0.24, -1.95], to: subTr(2) });
      addRoute({ pts: [[SUB.x + 1.32, SUB.z + 0.45], [2.1, 1.0], [csx, csz - 0.45]], from: subTr(2), to: campusTr });
      // Generation → step-up transformer leads (short, on the ground).
      powerPaths.push({ points: [v3([NUC.x + 0.9, 0.48, NUC.z + 0.18]), v3([NUC.x + 1.5, 0.3, NUC.z + 0.6]), v3([NUC.x + 1.75, 0.24, NUC.z + 0.82])], weight: 0.25 });
      powerPaths.push({ points: [v3([GAS.x + 1.15, 0.42, GAS.z + 0.1]), v3([GAS.x + 1.55, 0.3, GAS.z - 0.2]), v3([GAS.x + 1.78, 0.24, GAS.z - 0.42])], weight: 0.25 });
      powerPaths.push({ points: [v3([BESS.x - 0.4, 0.2, BESS.z + 0.6]), v3([5.4, 0.2, -2.2]), v3([4.65, 0.24, -1.95])], weight: 0.3 });
      powerPaths.push({ points: [v3([3.6, 0.15, -2.4]), v3([4.2, 0.18, -2.15]), v3([4.65, 0.24, -1.95])], weight: 0.3 });

      /* steam over the cooling tower */
      for (let i = 0; i < 7; i++) steam.push(glow([TOWER.x, TOWER.h, TOWER.z], 0.8, (p) => p.fg.clone().lerp(p.bg, isDark(p) ? 0.35 : 0.55), 0.3));
    } else {
      /* onsite: gas turbines */
      const Tt = new PartList();
      for (const x of OT.xs) {
        Tt.add(rbox(0.34, 0.34, 0.42), T.concrete2, { x: x - 0.45, z: OT.z }); // inlet filter house
        Tt.add(rbox(0.62, 0.3, 0.36), T.concrete, { x: x + 0.02, z: OT.z }); // turbine enclosure
        Tt.add(box(0.626, 0.05, 0.366), A.gas, { x: x + 0.02, y: 0.2, z: OT.z });
        Tt.add(rbox(0.3, 0.26, 0.32), T.concrete2, { x: x + 0.5, z: OT.z }); // generator
        Tt.add(cyl(0.07, 0.085, 0.82, 14), T.concrete, { x: x + 0.2, z: OT.z - 0.3 }); // exhaust stack
        Tt.add(cyl(0.074, 0.074, 0.05, 14), A.gas, { x: x + 0.2, y: 0.7, z: OT.z - 0.3 });
        stacks.push({ i: glow([x + 0.2, 0.98, OT.z - 0.3], 0.5, A.gas, 0.28), base: 0.28 });
      }
      transformer(Tt, OTR.t[0], OTR.t[1], 0.9);
      fac('turbines', Tt);

      /* reciprocating gensets (containerised) */
      const E = new PartList();
      for (const z of OE.zs)
        for (let i = 0; i < OE.n; i++) {
          const x = OE.x0 + i * OE.dx;
          E.add(rbox(0.5, 0.22, 0.22, 0.02), T.concrete, { x, z });
          E.add(box(0.506, 0.04, 0.226), A.gas, { x, y: 0.15, z });
          E.add(box(0.2, 0.05, 0.16), T.steel, { x: x + 0.1, y: 0.22, z });
          E.add(cyl(0.022, 0.022, 0.16, 6), T.steel, { x: x - 0.15, y: 0.22, z });
        }
      transformer(E, OTR.e[0], OTR.e[1], 0.9);
      fac('engines', E);
      stacks.push({ i: glow([OE.x0 + 2 * OE.dx, 0.55, -1.0], 1.6, A.gas, 0.14), base: 0.14 });

      /* fuel cells */
      const Fc = new PartList();
      for (const z of OF.zs)
        for (let i = 0; i < OF.n; i++) {
          const x = OF.x0 + i * OF.dx;
          Fc.add(rbox(0.4, 0.2, 0.22, 0.02), T.concrete, { x, z });
          Fc.add(box(0.405, 0.035, 0.225), A.fuel, { x, y: 0.14, z });
        }
      transformer(Fc, OTR.f[0], OTR.f[1], 0.9);
      fac('fuelcells', Fc);

      /* battery buffer */
      const Bo = new PartList();
      for (const x of OB.xs)
        for (const z of OB.zs) {
          Bo.add(rbox(0.56, 0.24, 0.24, 0.025), T.concrete, { x, z });
          Bo.add(box(0.566, 0.045, 0.246), A.battery, { x, y: 0.17, z });
        }
      Bo.add(rbox(0.22, 0.2, 0.18), T.steel, { x: OB.xs[0]! - 0.55, z: 2.73 });
      fac('bessO', Bo);

      /* meter at the point of interconnection */
      const M = new PartList();
      M.add(box(0.5, 0.012, 0.4), T.pad, { x: METER.x, z: METER.z });
      M.add(rbox(0.2, 0.3, 0.16), A.meter, { x: METER.x, z: METER.z, ry: -0.6 });
      M.add(box(0.14, 0.08, 0.02), T.hole, { x: METER.x + 0.047, y: 0.17, z: METER.z + 0.066, ry: -0.6 });
      fac('meter', M);
      glow([METER.x, 0.3, METER.z], 0.9, A.meter, 0.35);

      /* gas pipeline network */
      const Pp = new PartList();
      const y = 0.06;
      const gy = y + 0.032; // gas particles ride along the top of the pipe
      const hz = -1.95;
      const pipe = (a: V3, b: V3) => Pp.add(rod(a, b, 0.03), A.pipe);
      pipe([-PLATE.w / 2 + 0.25, y, hz], [OT.xs[2]! + 0.35, y, hz]);
      Pp.add(rbox(0.3, 0.17, 0.24), A.pipe, { x: -7.45, z: hz });
      for (const x of OT.xs) {
        pipe([x, y, hz], [x, y, OT.z + 0.2]);
        gasPaths.push({ points: tight([v3([-PLATE.w / 2 + 0.3, gy, hz]), v3([x, gy, hz]), v3([x, gy, OT.z + 0.2])]) });
      }
      const ex = OE.x0 - 0.5;
      const fx = OF.x0 - 0.6;
      const eEnd = OE.x0 + (OE.n - 1) * OE.dx + 0.3;
      const fEnd = OF.x0 + (OF.n - 1) * OF.dx + 0.3;
      pipe([ex, y, hz], [ex, y, -1.0]);
      pipe([ex, y, -1.0], [eEnd, y, -1.0]);
      gasPaths.push({ points: tight([v3([-PLATE.w / 2 + 0.3, gy, hz]), v3([ex, gy, hz]), v3([ex, gy, -1.0]), v3([eEnd, gy, -1.0])]) });
      pipe([fx, y, hz], [fx, y, 0.4]);
      pipe([fx, y, 0.4], [fEnd, y, 0.4]);
      gasPaths.push({ points: tight([v3([-PLATE.w / 2 + 0.3, gy, hz]), v3([fx, gy, hz]), v3([fx, gy, 0.4]), v3([fEnd, gy, 0.4])]) });
      fac('pipes', Pp);

      /*
       * electrical: inside the fence each block's step-up transformer feeds buried medium-voltage
       * cables (cable trenches) that collect at x = CABLE.x and run east to the campus
       * substation; only the utility tie (back-up, through the meter) is an overhead line.
       */
      const tr = (t: XZ): V3 => [t[0], 0.22, t[1]];
      const Cb = new PartList();
      const ty = 0.035; // particles ride just above the trench covers
      const trench = (x0: number, z0: number, x1: number, z1: number) => {
        const len = Math.hypot(x1 - x0, z1 - z0);
        Cb.add(box(CABLE.w, 0.014, len + CABLE.w), T.trench, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, ry: Math.atan2(x1 - x0, z1 - z0) });
      };
      const trunkEnd = csx - 0.28;
      trench(CABLE.x, OTR.t[1], CABLE.x, CABLE.z);
      trench(CABLE.x, OTR.f[1], CABLE.x, CABLE.z);
      trench(CABLE.x, CABLE.z, trunkEnd, CABLE.z);
      Cb.add(rbox(0.3, 0.2, 0.26), T.concrete2, { x: CABLE.x - 0.3, z: CABLE.z }); // MV switchgear house
      for (const t of [OTR.t, OTR.e, OTR.f]) {
        trench(t[0] + 0.18, t[1], CABLE.x, t[1]);
        powerPaths.push({
          points: tight([v3(tr(t)), v3([t[0] + 0.22, ty, t[1]]), v3([CABLE.x, ty, t[1]]), v3([CABLE.x, ty, CABLE.z]), v3([trunkEnd, ty, CABLE.z]), v3(campusTr)]),
          weight: 0.8,
        });
      }
      fac('cables', Cb, { roughness: 0.9, metalness: 0 });
      addRoute({ pts: [...UTIL, [csx + 0.12, csz - 0.62]], from: [0, 0, 0], to: [0, 0, 0], startPylon: true, flow: false });
      // Generator leads.
      for (const x of OT.xs) powerPaths.push({ points: [v3([x + 0.5, 0.26, OT.z]), v3([x + 0.5, 0.18, OT.z + 0.32]), v3([OTR.t[0], 0.18, OT.z + 0.32]), v3(tr(OTR.t))], weight: 0.35 });
      for (const z of OE.zs) powerPaths.push({ points: [v3([OE.x0, 0.2, z]), v3([OE.x0 + 4 * OE.dx, 0.2, z]), v3(tr(OTR.e))], weight: 0.35 });
      for (const z of OF.zs) powerPaths.push({ points: [v3([OF.x0, 0.18, z]), v3([OF.x0 + 5 * OF.dx, 0.18, z]), v3(tr(OTR.f))], weight: 0.3 });
      // Battery buffer: two lanes (charge / discharge).
      powerPaths.push({ points: [v3([OB.xs[0]! - 0.55, 0.2, 2.73]), v3([csx - 0.05, 0.12, 1.9]), v3([csx + 0.12, 0.26, csz + 0.5])], weight: 0.4 });
      powerPaths.push({ points: [v3([csx + 0.2, 0.26, csz + 0.5]), v3([csx + 0.1, 0.12, 1.9]), v3([OB.xs[0]! - 0.45, 0.2, 2.73])], weight: 0.4 });

      rectLoop(FENCE_O.x0, FENCE_O.z0, FENCE_O.x1, FENCE_O.z1, 0.45);
      treeCentres.push([7.15, -1.7, 4], [7.0, 0.9, 4], [6.8, 3.4, 3], [-0.6, 2.9, 5], [-0.4, -3.05, 3], [3.1, -2.75, 3], [-7.5, 3.7, 3], [-7.3, -4.4, 3]);
    }

    /* ───────── steel, pylons, wires, fences ───────── */
    fac('gantry', steel, { metalness: 0.45, roughness: 0.42 });
    const pyl = instanced('pylons', pylonGeometry(), pylonItems, (_, p) => T.steel(p), { metalness: 0.5, roughness: 0.4 });
    pylonsMesh = pyl.mesh;
    const wireGeo = ctx.track(new BufferGeometry());
    wireGeo.setAttribute('position', new Float32BufferAttribute(wireSegs, 3));
    const wireMat = ctx.materials.line(T.wire, { transparent: true, opacity: 0.85 });
    const wires = new LineSegments(wireGeo, wireMat);
    root.add(wires);
    const fenceGeo = ctx.track(new BufferGeometry());
    fenceGeo.setAttribute('position', new Float32BufferAttribute(fences, 3));
    const fenceMat = ctx.track(new LineDashedMaterial({ dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.8, toneMapped: false }));
    const fenceLines = new LineSegments(fenceGeo, fenceMat);
    fenceLines.computeLineDistances();
    root.add(fenceLines);

    /* ───────── water, trees ───────── */
    if (isGrid) {
      const lake = new Mesh(ctx.track(new CircleGeometry(1, 48)), ctx.materials.standard(T.water, { roughness: 0.18, metalness: 0.15, transparent: true, opacity: 0.85 }));
      lake.rotation.x = -Math.PI / 2;
      lake.scale.set(LAKE.rx, LAKE.rz, 1);
      lake.position.set(LAKE.x, 0.01, LAKE.z);
      root.add(lake);
    }
    const trees: Inst[] = [];
    for (const [tx, tz, n] of treeCentres)
      for (let i = 0; i < n; i++) {
        const a = ctx.rng() * Math.PI * 2;
        const r = 0.12 + ctx.rng() * 0.42;
        const s = 0.75 + ctx.rng() * 0.6;
        trees.push({ x: tx + Math.cos(a) * r, z: tz + Math.sin(a) * r * 0.8, sx: s, sy: s * (0.9 + ctx.rng() * 0.4), sz: s });
      }
    const treeGeo = new ConeGeometry(0.1, 0.3, 7);
    treeGeo.translate(0, 0.15, 0);
    instanced(null, treeGeo, trees, (i, p) => T.tree(p).multiplyScalar(0.9 + ((i * 37) % 10) / 45), { roughness: 0.85, metalness: 0 });

    /* ───────── flows ───────── */
    const FLOW_MAX = isGrid ? 1100 : 1000;
    const flowOpts = { size: 0.07, sizeVariance: 0.3, speed: 0.85, speedVariance: 0.2, fadeEnds: 0.04, samples: 96, theme: ctx.theme };
    const flow = ctx.track(new PathFlow({ ...flowOpts, paths: powerPaths, count: FLOW_MAX, seed: 5 }));
    root.add(flow.object);
    const wait = waitPaths.length ? ctx.track(new PathFlow({ ...flowOpts, paths: waitPaths, count: 160, seed: 9 })) : null;
    if (wait) root.add(wait.object);
    const GAS_MAX = isGrid ? 160 : 320;
    const gasFlow = ctx.track(new PathFlow({ ...flowOpts, paths: gasPaths, count: GAS_MAX, size: 0.05, speed: 0.45, seed: 13 }));
    root.add(gasFlow.object);
    const flows = [flow, gasFlow, ...(wait ? [wait] : [])];
    const setCounts = (tier = ctx.tier) => {
      flow.setCount(scaleCount(FLOW_MAX, tier, 160));
      gasFlow.setCount(scaleCount(GAS_MAX, tier, 60));
      wait?.setCount(scaleCount(160, tier, 40));
    };
    setCounts();
    for (const f of flows) f.setReduced(!ctx.animate);

    /* ───────── glows ───────── */
    const glows = ctx.track(new GlowSprites({ count: glowSpecs.length + 2, theme: ctx.theme }));
    root.add(glows.object);
    const glowAlpha = glowSpecs.map((g) => g.alpha);

    /* ───────── columns (steps 1–2, grid) ───────── */
    interface Col {
      x: number;
      z: number;
      tint: Tint;
      top: readonly number[];
      fill: readonly number[];
      cur: { top: number; fill: number };
    }
    const cols: Col[] = isGrid
      ? [
          { x: cx - 0.72, z: cz, tint: A.campus, top: [0, 1, 1, 0, 0, 0], fill: [0, 1, 1, 0, 0, 0], cur: { top: 0, fill: 0 } },
          { x: NUC.x - 0.6, z: NUC.z, tint: A.nuclear, top: [0, 1, 1, 0, 0, 0], fill: [0, 1, 0.92, 0, 0, 0], cur: { top: 0, fill: 0 } },
          { x: GAS.x + 1.0, z: GAS.z + 0.15, tint: A.gas, top: [0, 0, 1, 0, 0, 0], fill: [0, 0, 0.55, 0, 0, 0], cur: { top: 0, fill: 0 } },
          { x: SOLAR.x0 + 1.85, z: SOLAR.z0 + 1.0, tint: A.solar, top: [0, 0, 1, 0, 0, 0], fill: [0, 0, 0.24, 0, 0, 0], cur: { top: 0, fill: 0 } },
        ]
      : [];
    const colGroup = new Group();
    root.add(colGroup);
    const outerGeo = ctx.track(new CylinderGeometry(0.4, 0.4, 1, 40, 1, true));
    outerGeo.translate(0, 0.5, 0);
    const innerGeo = ctx.track(new CylinderGeometry(0.3, 0.3, 1, 32));
    innerGeo.translate(0, 0.5, 0);
    const ringGeo = ctx.track(new TorusGeometry(0.4, 0.018, 6, 48));
    ringGeo.rotateX(Math.PI / 2);
    const outerMat = ctx.track(new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide, toneMapped: false }));
    const innerMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 }));
    const ringMat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
    const n = Math.max(1, cols.length);
    const colOuter = ctx.track(new InstancedMesh(outerGeo, outerMat, n));
    const colInner = ctx.track(new InstancedMesh(innerGeo, innerMat, n));
    const colRing = ctx.track(new InstancedMesh(ringGeo, ringMat, n));
    colOuter.renderOrder = 5;
    colGroup.add(colInner, colOuter, colRing);
    for (const m of [colOuter, colInner, colRing]) m.setColorAt(0, WHITE);
    const drawCols = () => {
      let any = false;
      cols.forEach((c, i) => {
        const top = Math.max(1e-3, c.cur.top * colH);
        const fill = Math.max(1e-3, c.cur.fill * colH);
        any ||= c.cur.top > 0.002;
        placeOne(colOuter, i, c.x, 0, c.z, c.cur.top > 0.002 ? 1 : 0.001, top);
        placeOne(colInner, i, c.x, 0, c.z, c.cur.fill > 0.002 ? 1 : 0.001, fill);
        placeOne(colRing, i, c.x, top, c.z, c.cur.top > 0.002 ? 1 : 0.001, 1);
      });
      colGroup.visible = any;
      for (const m of [colOuter, colInner, colRing]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
      }
    };
    const placeOne = (m: InstancedMesh, i: number, x: number, y: number, z: number, s: number, h: number) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s, h, s);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    };
    drawCols();
    // 1 GW reference line between the campus and reactor columns (step 1).
    const levelGeo = ctx.track(new BufferGeometry());
    const c0 = cols[0];
    const c1 = cols[1];
    levelGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    const placeLevel = () => {
      const a = levelGeo.getAttribute('position');
      if (c0 && c1) {
        a.setXYZ(0, c0.x, colH, c0.z);
        a.setXYZ(1, c1.x, colH, c1.z);
      }
      a.needsUpdate = true;
      levelGeo.computeBoundingSphere();
    };
    placeLevel();
    const levelMat = ctx.track(new LineDashedMaterial({ dashSize: 0.16, gapSize: 0.1, transparent: true, opacity: 0, toneMapped: false }));
    const level = new LineSegments(levelGeo, levelMat);
    level.computeLineDistances();
    level.visible = false;
    root.add(level);

    /* ───────── bottleneck props (step 5, grid) ───────── */
    interface Ghost {
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      tint: Tint;
      lead?: boolean;
    }
    const ghosts: Ghost[] = isGrid
      ? [
          { x: SUB.x, z: 1.6, w: 0.56, h: 0.07, d: 0.36, tint: A.solar },
          { x: SUB.x, z: 2.12, w: 0.56, h: 0.24, d: 0.24, tint: A.battery },
          { x: SUB.x, z: 2.64, w: 0.4, h: 0.32, d: 0.4, tint: A.gas },
          { x: SUB.x, z: 3.16, w: 0.56, h: 0.07, d: 0.36, tint: A.solar },
          { x: SUB.x, z: 3.68, w: 0.56, h: 0.24, d: 0.24, tint: A.battery },
          { x: LEAD.x, z: LEAD.z, w: 0.82, h: 0.3, d: 0.36, tint: A.gas, lead: true },
        ]
      : [];
    const ghostGroup = new Group();
    ghostGroup.visible = false;
    root.add(ghostGroup);
    const ghostMat = ctx.track(new MeshStandardMaterial({ transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.5 }));
    const ghostMesh = ctx.track(new InstancedMesh(ctx.track(box(1, 1, 1)), ghostMat, Math.max(1, ghosts.length)));
    placeInstances(
      ghostMesh,
      ghosts.map((g) => ({ x: g.x, z: g.z, sx: g.w, sy: g.h, sz: g.d })),
    );
    ghostMesh.setColorAt(0, WHITE);
    ghostGroup.add(ghostMesh);
    const edgePos: number[] = [];
    const edgeBase = new EdgesGeometry(new BoxGeometry(1, 1, 1));
    const eb = edgeBase.getAttribute('position');
    for (const g of ghosts)
      for (let i = 0; i < eb.count; i++) edgePos.push(g.x + eb.getX(i) * g.w, (eb.getY(i) + 0.5) * g.h, g.z + eb.getZ(i) * g.d);
    edgeBase.dispose();
    const edgeGeo = ctx.track(new BufferGeometry());
    edgeGeo.setAttribute('position', new Float32BufferAttribute(edgePos, 3));
    edgeGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(edgePos.length), 3));
    const edgeMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, toneMapped: false }));
    ghostGroup.add(new LineSegments(edgeGeo, edgeMat));
    // Barrier at the substation gate + two clocks (queue, turbine order).
    const barrierGeo = ctx.track(rod([SUB.x - 0.42, 0.3, 1.18], [SUB.x + 0.42, 0.3, 1.18], 0.025, 6));
    const barrier = new Mesh(barrierGeo, ctx.materials.basic('neg'));
    ghostGroup.add(barrier);
    const clockFace = ctx.track(new TorusGeometry(0.2, 0.022, 6, 40));
    const hourGeo = ctx.track(new BoxGeometry(0.03, 0.1, 0.012));
    hourGeo.translate(0, 0.05, 0);
    const minGeo = ctx.track(new BoxGeometry(0.022, 0.15, 0.012));
    minGeo.translate(0, 0.075, 0);
    const clockMat = ctx.materials.basic('highlight');
    const clocks = ghosts.length
      ? [
          [SUB.x + 0.75, 0.75, 1.55],
          [LEAD.x, 0.85, LEAD.z],
        ].map((p) => {
          const g = new Group();
          g.position.set(p[0]!, p[1]!, p[2]!);
          const ring = new Mesh(clockFace, clockMat);
          const hour = new Mesh(hourGeo, clockMat);
          hour.rotation.z = -2.1;
          const min = new Mesh(minGeo, clockMat);
          g.add(ring, hour, min);
          ghostGroup.add(g);
          return { g, min };
        })
      : [];

    /* ───────── labels ───────── */
    interface Lab {
      h: LabelHandle;
      steps: readonly number[] | null;
      swatch?: keyof typeof SW;
    }
    const labs: Lab[] = [];
    const lab = (spec: LabelSpec, steps: readonly number[] | null, swatch?: keyof typeof SW): LabelHandle => {
      const h = labels.add({ ...spec, visible: !steps || steps.includes(ctx.step), ...(swatch ? { swatch: swatchCss(swatch, ctx.palette) } : {}) });
      labs.push(swatch ? { h, steps, swatch } : { h, steps });
      return h;
    };
    /**
     * Stage-shape adaptive labels. Portrait stages orbit the camera to the east side of the plate;
     * narrow stages (phones, width < NARROW px) shrink the scene while labels keep their pixel size,
     * so some labels change side, anchor or offset there. Each rule returns every key it ever
     * changes, so switching back restores the default placement.
     */
    interface Shape {
      portrait: boolean;
      narrow: boolean;
    }
    const adapts: { h: LabelHandle; rule: (m: Shape) => Partial<LabelSpec> }[] = [];
    const adapt = (h: LabelHandle, rule: (m: Shape) => Partial<LabelSpec>) => adapts.push({ h, rule });
    const applyAdapts = () => {
      const m: Shape = { portrait, narrow };
      for (const a of adapts) a.h.set(a.rule(m));
    };
    /** Labels that ride on top of the comparison columns (their height depends on the stage shape). */
    const tops: { h: LabelHandle; x: number; z: number; dy: number }[] = [];
    const topLab = (x: number, z: number, dy: number, spec: LabelSpec, steps: readonly number[], swatch?: keyof typeof SW) => {
      const h = lab({ ...spec, position: [x, colH + dy, z] }, steps, swatch);
      tops.push({ h, x, z, dy });
      return h;
    };
    const placeTops = () => tops.forEach((a) => a.h.set({ position: [a.x, colH + a.dy, a.z] }));
    if (isGrid) {
      const ov = [0, 3, 5];
      // Narrow portrait: the gas plant label sits right next to the dome, so the plant is named at its cooling tower.
      const nucL: V3 = [NUC.x - 0.6, 1.35, NUC.z];
      const nucP: V3 = [TOWER.x, TOWER.h, TOWER.z];
      adapt(lab({ text: '核能電廠', position: nucL, align: 'above', kind: 'strong', priority: 30, hotspot: 'nuclear' }, [0, 3, 5], 'nuclear'), (m) =>
        m.portrait && m.narrow ? { position: nucP, align: 'right' } : { position: nucL, align: 'above' },
      );
      lab({ text: 'SMR 小型模組化反應爐', position: [SMR.x, 0.6, SMR.z], align: 'above', priority: 22, hotspot: 'smr' }, [0, 2, 3], 'nuclear');
      lab({ text: '燃氣電廠', position: [GAS.x - 0.1, 1.38, GAS.z - 0.68], align: 'above', kind: 'strong', priority: 30, hotspot: 'gas-plant' }, ov, 'gas');
      lab({ text: '太陽能', position: [SOLAR.x0 + 1.8, 0.2, SOLAR.z0 + 0.1], align: 'above', kind: 'strong', priority: 28, hotspot: 'solar' }, [0, 3], 'solar');
      // Narrow stages: the battery yard sits at the right edge, so its label goes to the left.
      adapt(lab({ text: '電池儲能', position: [BESS.x, 0.3, BESS.z - 0.75], align: 'above', kind: 'strong', priority: 26, hotspot: 'battery-storage' }, [0, 3], 'battery'), (m) => ({
        align: m.narrow ? 'left' : 'above',
      }));
      lab({ text: '電網變電站', position: [SUB.x, 0.55, SUB.z - 0.2], align: 'above', priority: 24, hotspot: 'substation' }, [0]);
      lab({ text: 'AI 園區（GW 級）', position: [cx, 0.5, cz - 1.0], align: 'above', kind: 'strong', priority: 32, hotspot: 'ai-campus' }, ov, 'campus');
      lab({ text: '高壓輸電線', position: [-2.3, 0.95, 1.02], align: 'above', kind: 'tag', priority: 12, hotspot: 'transmission' }, [0], 'power');
      lab({ text: '天然氣管線', position: [-7.0, 0.2, GAS.z + 1.25], align: 'below', kind: 'tag', priority: 9, hotspot: 'gas-plant' }, [2], 'pipe');
      // step 1 — the 1 GW comparison
      // On portrait and narrow stages the two columns sit near the stage edges: point their labels
      // inward; on narrow stages they would meet in the middle, so they split above / below the level line.
      const gwCampus = topLab(cols[0]!.x, cols[0]!.z, 0.1, { text: 'AI 園區用電 ≈ 1 GW（示意）', align: 'above', kind: 'strong', priority: 40, always: true, hotspot: 'ai-campus' }, [1], 'campus');
      const gwNuclear = topLab(cols[1]!.x, cols[1]!.z, 0.1, { text: '大型核能機組 ≈ 1 GW（示意）', align: 'above', kind: 'strong', priority: 40, always: true, hotspot: 'nuclear' }, [1], 'nuclear');
      adapt(gwCampus, (m) => ({ align: m.portrait || m.narrow ? 'left' : 'above', offset: m.narrow ? [0, 14] : [0, 0] }));
      adapt(gwNuclear, (m) => ({ align: m.portrait || m.narrow ? 'right' : 'above', offset: m.narrow ? [0, -14] : [0, 0] }));
      const same = topLab((cols[0]!.x + cols[1]!.x) / 2, (cols[0]!.z + cols[1]!.z) / 2, 0.05, { text: '等高＝同樣的功率', align: 'above', kind: 'muted', priority: 35, always: true }, [1]);
      adapt(same, (m) => ({ offset: m.narrow ? [0, -30] : [0, 0] }));
      // step 2 — nameplate vs average output
      const c2 = (i: number, text: string, hs: string, sw: keyof typeof SW) => {
        const c = cols[i]!;
        return topLab(c.x, c.z, 0.1, { text, align: 'above', kind: i === 0 ? 'default' : 'strong', priority: 40, always: true, hotspot: hs }, [2], sw);
      };
      // Landscape: the nuclear column stands just behind and left of the gas column, so the gas label
      // goes to the right of its column top (above it, it would cover the nuclear column on stages
      // narrower than a desktop). Narrow landscape (a phone at 4:3): above its column the campus label
      // would cover the solar column behind it, so it moves under the column's foot (over the halls).
      const campusTop = c2(0, '園區：全天候用電', 'ai-campus', 'campus');
      adapt(campusTop, (m) => {
        const c = cols[0]!;
        return m.narrow && !m.portrait ? { position: [c.x, 0, c.z], align: 'below' } : { position: [c.x, colH + 0.1, c.z], align: 'above' };
      });
      c2(1, '核能：全天候穩定', 'nuclear', 'nuclear');
      adapt(c2(2, '燃氣：依需求調度', 'gas-plant', 'gas'), (m) =>
        m.portrait ? { align: 'above', offset: [0, 0] } : { align: 'right', offset: m.narrow ? [0, 4] : [0, 0] },
      );
      // Portrait: the solar column stands at the stage's right edge, so its label goes to the left.
      adapt(c2(3, '太陽能：只在白天發電', 'solar', 'solar'), (m) => ({ align: m.portrait ? 'left' : 'above' }));
      // Narrow stages: the four column labels fill the sky, so the legend moves under the plate's front edge.
      const legend = topLab(-0.6, -0.6, 0.9, { text: '外框＝裝置容量・實心＝平均出力（示意）', align: 'center', kind: 'muted', priority: 45, always: true }, [2]);
      // Portrait: the sky is taken by the column labels too, so it sits under the plate's near corner.
      const legendN: V3 = [0, 0, PLATE.cz + PLATE.d / 2];
      const legendP: V3 = [3.2, 0, PLATE.cz + PLATE.d / 2];
      adapt(legend, (m) =>
        m.portrait ? { position: legendP, align: 'below' } : m.narrow ? { position: legendN, align: 'below' } : { position: [-0.6, colH + 0.9, -0.6], align: 'center' },
      );
      // Narrow stages: no room next to the column labels, so this aside yields to them (the caption says it too).
      adapt(lab({ text: '儲能：把白天的電移到晚上', position: [BESS.x + 0.6, 0.25, BESS.z + 0.45], align: 'right', priority: 38, always: true, hotspot: 'battery-storage' }, [2], 'battery'), (m) => ({
        align: m.portrait || m.narrow ? 'left' : 'right',
        always: !m.narrow,
      }));
      // step 3 — transmission
      // Portrait: the camera looks along -x, so the two step-up yards sit high on the stage beside the plant labels; push them outward.
      adapt(lab({ text: '升壓變壓器', position: [NUC.x + 1.75, 0.3, NUC.z + 0.82], align: 'below', kind: 'tag', priority: 18, hotspot: 'transmission' }, [3]), (m) => ({ align: m.portrait ? 'right' : 'below' }));
      adapt(lab({ text: '升壓變壓器', position: [GAS.x + 1.78, 0.3, GAS.z - 0.42], align: 'below', kind: 'tag', priority: 18, hotspot: 'transmission' }, [3]), (m) => ({ align: m.portrait ? 'left' : 'below' }));
      lab({ text: '三相輸電：每回路 3 條導線', position: [-1.7, 0.95, -0.78], align: 'above', priority: 34, hotspot: 'transmission' }, [3], 'power');
      lab({ text: '超高壓（數百 kV，示意）', position: [-2.3, 0.95, 1.02], align: 'above', kind: 'tag', priority: 20, hotspot: 'transmission' }, [3]);
      lab({ text: '電網變電站：降壓', position: [SUB.x, 0.4, SUB.z + 0.9], align: 'below', priority: 25, hotspot: 'substation' }, [3]);
      lab({ text: '園區變電站：再降到中壓', position: [csx - 0.2, 0.3, csz + 0.3], align: 'left', kind: 'tag', priority: 20, hotspot: 'substation' }, [3]);
      // step 5 — bottlenecks
      // Narrow landscape (a phone at the default 4:3 height): shorter text that fits beside the queue.
      const QUEUE = '排隊等併網的新案場（示意）';
      adapt(lab({ text: QUEUE, position: [SUB.x + 0.35, 0.3, 2.9], align: 'right', kind: 'strong', priority: 40, always: true, hotspot: 'interconnection-queue' }, [5]), (m) =>
        m.narrow && !m.portrait ? { text: '排隊等併網（示意）', align: 'below' } : { text: QUEUE, align: 'right' },
      );
      lab({ text: '燃氣渦輪：交期數年（示意）', position: [LEAD.x, 1.12, LEAD.z], align: 'above', priority: 38, always: true, hotspot: 'lead-times' }, [5], 'gas');
      lab({ text: '大型變壓器：交期拉長', position: [SUB.x - 0.7, 0.45, SUB.z - 0.3], align: 'above', priority: 36, hotspot: 'lead-times' }, [5]);
      const WAITING = '已完工、等待供電（示意）';
      const waitL: V3 = [cx, 0.4, cz + 1.15];
      const waitN: V3 = [cx - 0.72, 0.4, cz + 1.15];
      adapt(lab({ text: WAITING, position: waitL, align: 'below', priority: 36, always: true, hotspot: 'ai-campus' }, [5], 'campus'), (m) =>
        m.narrow && !m.portrait ? { text: '等待供電（示意）', position: waitN, offset: [0, 12] } : { text: WAITING, position: waitL, offset: [0, 0] },
      );
    } else {
      const all = [0, 4];
      // Narrow landscape: nudged left, clear of the short meter label on its right.
      adapt(lab({ text: 'AI 園區', position: [cx, 0.5, cz - 1.0], align: 'above', kind: 'strong', priority: 32, hotspot: 'ai-campus' }, all, 'campus'), (m) => ({
        offset: m.narrow && !m.portrait ? [-8, 2] : [0, 0],
      }));
      lab({ text: '燃氣渦輪', position: [OT.xs[1]!, 0.95, OT.z - 0.3], align: 'above', kind: 'strong', priority: 30, hotspot: 'onsite-turbines' }, all, 'gas');
      // Landscape: under the front row, in the gap above the fuel-cell header (above the rows it would
      // cover the turbines). Portrait: the rows run up the screen, so the label moves to their side.
      // Phones in portrait: a shorter label under the near end of the rows, clear of the fuel-cell label.
      const ENG_T = '往復式發電機組';
      const engL: V3 = [OE.x0 + 2 * OE.dx, 0.2, OE.zs[1]! + 0.12];
      const engP: V3 = [OE.x0 + 2 * OE.dx, 0.3, OE.zs[0]! - 0.1];
      const engNP: V3 = [OE.x0 + (OE.n - 1) * OE.dx + 0.3, 0.2, (OE.zs[0]! + OE.zs[1]!) / 2];
      adapt(lab({ text: ENG_T, position: engL, align: 'below', kind: 'strong', priority: 28, hotspot: 'recip-engines' }, all, 'gas'), (m) =>
        m.portrait && m.narrow
          ? { text: '往復式機組', position: engNP, align: 'below', offset: [40, 4] }
          : m.portrait
            ? { text: ENG_T, position: engP, align: 'left', offset: [0, 0] }
            : { text: ENG_T, position: engL, align: 'below', offset: [0, 0] },
      );
      lab({ text: '燃料電池', position: [OF.x0 + 2.5 * OF.dx, 0.25, OF.zs[2]! + 0.1], align: 'below', kind: 'strong', priority: 28, hotspot: 'fuel-cells' }, all, 'fuel');
      // Narrow landscape: to the right of the containers, leaving the strip under the plate to the fence note.
      const bufL: V3 = [OB.xs[1]!, 0.3, OB.zs[1]! + 0.15];
      const bufN: V3 = [OB.xs[2]! + 0.3, 0.2, (OB.zs[0]! + OB.zs[1]!) / 2];
      adapt(lab({ text: '電池緩衝', position: bufL, align: 'below', kind: 'strong', priority: 26, hotspot: 'battery-buffer' }, all, 'battery'), (m) =>
        m.narrow && !m.portrait ? { position: bufN, align: 'right' } : { position: bufL, align: 'below' },
      );
      // Portrait: the meter and the utility tie sit at the stage's right edge, so both labels go left.
      // Narrow stages: below (or left of) the meter the label would cover the campus and its label, so a
      // short label goes to the right, over the utility tie.
      const METER_T = '電表（計量點）';
      adapt(lab({ text: METER_T, position: [METER.x, 0.35, METER.z], align: 'below', kind: 'strong', priority: 34, always: true, hotspot: 'meter' }, all, 'meter'), (m) =>
        m.narrow ? { text: '電表', align: 'right' } : m.portrait ? { text: METER_T, align: 'left' } : { text: METER_T, align: 'below' },
      );
      adapt(lab({ text: '公用電網（備援）', position: [UTIL[0]![0], 0.95, UTIL[0]![1]], align: 'above', kind: 'muted', priority: 24, hotspot: 'meter' }, all), (m) => ({
        align: m.portrait ? 'left' : 'above',
      }));
      lab({ text: '天然氣管線', position: [-7.45, 0.2, -1.95], align: 'below', kind: 'tag', priority: 16 }, all, 'pipe');
      lab({ text: '彈性負載：可暫緩的運算', position: [cx, 0.4, cz + 1.15], align: 'below', priority: 22, hotspot: 'flexible-load' }, [4], 'campus');
      lab({ text: '園區變電站', position: [csx, 0.4, csz + 0.25], align: 'above', kind: 'tag', priority: 14 }, [4]);
      lab({ text: '地下中壓電纜', position: [CABLE.x, 0.05, -1.35], align: 'right', kind: 'tag', priority: 14 }, [4], 'power');
      // Portrait: the fence corner nearest the camera (bottom-left of the stage) has free room;
      // narrow landscape: the strip under the plate's front edge.
      const fenceL: V3 = [FENCE_O.x0 + 0.25, 0.05, FENCE_O.z1 - 0.1];
      const fenceP: V3 = [FENCE_O.x1 - 0.2, 0.05, FENCE_O.z1 - 0.1];
      const fenceN: V3 = [-1.2, 0, PLATE.cz + PLATE.d / 2];
      adapt(lab({ text: '虛線內＝表後（電表內側）', position: fenceL, align: 'right', kind: 'tag', priority: 12 }, [4]), (m) =>
        m.portrait ? { position: fenceP, align: 'right' } : m.narrow ? { position: fenceN, align: 'below' } : { position: fenceL, align: 'right' },
      );
    }
    labels.setMax(isGrid ? 24 : 20);
    applyAdapts();

    /* ───────── palette ───────── */
    const applyPalette = (p: Palette) => {
      const dark = isDark(p);
      lights.apply(p);
      pgrid.recolor(p.fg, dark ? 0.07 : 0.06);
      shadowMat.color.copy(dark ? p.bg.clone().multiplyScalar(0.2) : p.fg);
      shadowMat.opacity = dark ? 0.55 : 0.12;
      for (const f of facilities.values()) f.recolor(p);
      for (const r of recolors) r(p);
      fenceMat.color.copy(p.fg).lerp(p.bg, dark ? 0.4 : 0.45);
      levelMat.color.copy(p.fg);
      flow.recolor(() => p.power);
      wait?.recolor(() => p.power);
      // Gas: pale dots running along the top of the (yellow) pipe, never amber like electricity.
      gasFlow.recolor(() => (dark ? p.fg.clone() : WHITE.clone()));
      for (const f of flows) f.setTheme(p.theme);
      flow.setSize(dark ? 0.075 : 0.062);
      wait?.setSize(dark ? 0.075 : 0.062);
      gasFlow.setSize(dark ? 0.05 : 0.04);
      glows.setTheme(p.theme);
      glowSpecs.forEach((g, i) => glows.set(i, g.pos, g.size, g.tint(p), g.alpha * (dark ? 1 : 0.7)));
      cols.forEach((c, i) => {
        const col = c.tint(p);
        colOuter.setColorAt(i, col);
        colInner.setColorAt(i, col);
        colRing.setColorAt(i, col);
      });
      for (const m of [colOuter, colInner, colRing]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
      outerMat.opacity = dark ? 0.2 : 0.22;
      innerMat.emissive.setScalar(dark ? 0.12 : 0);
      ghosts.forEach((g, i) => ghostMesh.setColorAt(i, g.tint(p)));
      if (ghostMesh.instanceColor) ghostMesh.instanceColor.needsUpdate = true;
      const ec = edgeGeo.getAttribute('color');
      const per = ghosts.length ? edgePos.length / 3 / ghosts.length : 0;
      ghosts.forEach((g, gi) => {
        const c = g.tint(p);
        for (let i = 0; i < per; i++) ec.setXYZ(gi * per + i, c.r, c.g, c.b);
      });
      ec.needsUpdate = true;
      ghostMat.opacity = dark ? 0.28 : 0.34;
      for (const l of labs) if (l.swatch) l.h.set({ swatch: swatchCss(l.swatch, p) });
    };
    applyPalette(ctx.palette);

    /* ───────── hotspots ───────── */
    const hotTweens = new Map<Fx, Tween>();
    const setHot = (list: readonly Fx[], on: boolean) => {
      for (const fx of list) {
        hotTweens.get(fx)?.cancel();
        const from = fx.hot;
        hotTweens.set(
          fx,
          ctx.tween.run(
            (k) => {
              fx.hot = from + ((on ? 1 : 0) - from) * k;
              fx.apply(ctx.palette);
            },
            { duration: 220, ease: 'cubicOut', fade: true },
          ),
        );
      }
    };
    const command = (c: SceneCommand) => ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: c }));
    const cardFor = (id: string, href: string, linkLabel: string, swatch?: keyof typeof SW): CardContent => {
      const h = hsText.get(id);
      const c: CardContent = { title: h?.label ?? id, href, linkLabel };
      if (h?.detail) c.body = h.detail;
      if (swatch) c.swatch = swatchCss(swatch, ctx.palette);
      return c;
    };
    interface Hs {
      id: string;
      variant: Variant;
      keys: readonly string[];
      object?: Object3D | null;
      anchor: V3;
      pose: Orbit;
      href: string;
      link: string;
      swatch?: keyof typeof SW;
      /** Only meaningful in this step (selecting it elsewhere jumps there). */
      step?: number;
    }
    const gl = (id: string) => `/glossary/#${id}`;
    const G = 'grid';
    const O = 'onsite';
    const near = (t: V3, d = 6, az = 6, el = 36): Orbit => ({ t, d, az, el });
    const hsList: Hs[] = [
      { id: 'ai-campus', variant: variant, keys: isGrid ? ['campus', 'campusB'] : ['campus'], object: isGrid ? null : facilities.get('campus')?.mesh ?? null, anchor: [cx, 0.4, cz], pose: near([cx - 0.6, 0.2, cz], 6.8), href: '/chain/datacenter-infra/', link: '資料中心環節 →', swatch: 'campus' },
      { id: 'nuclear', variant: G, keys: ['nuclear'], anchor: [NUC.x - 0.3, 0.7, NUC.z], pose: near([NUC.x + 0.2, 0.5, NUC.z - 0.5], 6.2, 12, 30), href: gl('nuclear-power'), link: '名詞解釋：核能發電 →', swatch: 'nuclear' },
      { id: 'smr', variant: G, keys: ['smr'], anchor: [SMR.x, 0.45, SMR.z], pose: near([SMR.x, 0.2, SMR.z], 4.6, 4, 34), href: gl('smr'), link: '名詞解釋：SMR →', swatch: 'nuclear' },
      { id: 'gas-plant', variant: G, keys: ['gas'], anchor: [GAS.x, 0.6, GAS.z], pose: near([GAS.x + 0.3, 0.3, GAS.z], 5.6, 14, 32), href: gl('gas-turbine'), link: '名詞解釋：燃氣渦輪機 →', swatch: 'gas' },
      { id: 'solar', variant: G, keys: ['solar', 'solar2'], object: solarMesh, anchor: [SOLAR.x0 + 1.8, 0.2, SOLAR.z0 + 1.0], pose: near([SOLAR.x0 + 2.2, 0, SOLAR.z0 + 1.1], 5.8, 0, 40), href: gl('renewable-energy'), link: '名詞解釋：再生能源 →', swatch: 'solar' },
      { id: 'battery-storage', variant: G, keys: ['bess'], anchor: [BESS.x, 0.25, BESS.z], pose: near([BESS.x - 0.6, 0.1, BESS.z + 0.2], 4.8, -8, 36), href: gl('energy-storage'), link: '名詞解釋：儲能 →', swatch: 'battery' },
      { id: 'transmission', variant: G, keys: ['pylons', 'gantry'], object: pylonsMesh, anchor: [-1.7, 0.8, -0.78], pose: STEP_POSES.grid[3]!, href: gl('power-grid'), link: '名詞解釋：電網 →', swatch: 'power' },
      { id: 'substation', variant: G, keys: ['sub', 'subTr'], anchor: [SUB.x, 0.4, SUB.z], pose: near([SUB.x, 0.2, SUB.z], 5.2, 4, 40), href: gl('power-transformer'), link: '名詞解釋：變壓器 →' },
      { id: 'interconnection-queue', variant: G, keys: [], object: null, anchor: [SUB.x, 0.3, 2.8], pose: STEP_POSES.grid[5]!, href: gl('interconnection-queue'), link: '名詞解釋：併網排隊 →', step: 5 },
      { id: 'lead-times', variant: G, keys: ['subTr'], object: null, anchor: [LEAD.x, 0.6, LEAD.z], pose: STEP_POSES.grid[5]!, href: gl('heavy-electrical'), link: '名詞解釋：重電設備 →', step: 5 },
      { id: 'onsite-turbines', variant: O, keys: ['turbines'], anchor: [OT.xs[1]!, 0.5, OT.z], pose: near([OT.xs[1]!, 0.2, OT.z + 0.3], 5.6, 6, 34), href: gl('gas-turbine'), link: '名詞解釋：燃氣渦輪機 →', swatch: 'gas' },
      { id: 'recip-engines', variant: O, keys: ['engines'], anchor: [OE.x0 + 2 * OE.dx, 0.25, -1.0], pose: near([OE.x0 + 2 * OE.dx, 0.1, -1.0], 5, 6, 38), href: gl('behind-the-meter'), link: '名詞解釋：表後供電 →', swatch: 'gas' },
      { id: 'fuel-cells', variant: O, keys: ['fuelcells'], anchor: [OF.x0 + 2.5 * OF.dx, 0.2, OF.zs[1]!], pose: near([OF.x0 + 2.5 * OF.dx, 0.1, OF.zs[1]!], 4.8, 6, 38), href: gl('fuel-cell'), link: '名詞解釋：燃料電池 →', swatch: 'fuel' },
      { id: 'battery-buffer', variant: O, keys: ['bessO'], anchor: [OB.xs[1]!, 0.25, 2.78], pose: near([OB.xs[1]!, 0.1, 2.5], 4.6, 0, 38), href: gl('energy-storage'), link: '名詞解釋：儲能 →', swatch: 'battery' },
      { id: 'flexible-load', variant: O, keys: ['campusB'], anchor: [cx, 0.4, cz + 0.8], pose: near([cx, 0.2, cz + 0.6], 5, 0, 38), href: gl('flexible-load'), link: '名詞解釋：彈性負載 →', swatch: 'campus' },
      { id: 'meter', variant: O, keys: ['meter'], anchor: [METER.x, 0.3, METER.z], pose: near([METER.x - 0.5, 0.2, METER.z + 0.4], 5.2, -14, 34), href: gl('behind-the-meter'), link: '名詞解釋：表後供電 →', swatch: 'meter' },
    ];
    const campusGroup = new Group();
    if (isGrid) {
      // Both campus meshes under one pick target.
      campusGroup.add(fA.mesh, fB.mesh);
      root.add(campusGroup);
      hsList[0]!.object = campusGroup;
    }
    for (const h of hsList) {
      const here = h.variant === variant;
      const object = here ? (h.object !== undefined ? h.object : facilities.get(h.keys[0] ?? '')?.mesh ?? null) : null;
      const spec: HotspotSpec = {
        ...(object ? { object } : { pickable: false }),
        ...(here ? { anchor: h.anchor } : {}),
        card: () => cardFor(h.id, h.href, h.link, h.swatch),
        onHighlight: (on) => setHot(h.keys.map((k) => fxs.get(k)).filter((f): f is Fx => !!f), on && here),
        onSelect: () => {
          if (!here) {
            pending = h.id;
            command(h.variant === 'onsite' ? { type: 'step', index: 4 } : { type: 'variant', variant: 'grid' });
            return true;
          }
          if (h.step !== undefined && ctx.step !== h.step) {
            pending = h.id;
            command({ type: 'step', index: h.step });
            return true;
          }
          return false;
        },
      };
      // A live getter: the pose follows the stage shape (portrait orbits to the east side).
      if (here) Object.defineProperty(spec, 'pose', { get: () => orbit(h.pose, portrait), enumerable: true });
      hotspots.register(h.id, spec);
    }
    ctx.picker.add(ghostMesh, { id: (hit) => (hit.instanceId !== undefined && ghosts[hit.instanceId]?.lead ? 'lead-times' : 'interconnection-queue') });

    /* ───────── steps ───────── */
    type Dims = Record<string, number>;
    const STEP_DIMS: Record<Variant, readonly (Dims | null)[]> = {
      grid: [
        null,
        { campus: 0, campusB: 0, nuclear: 0, '*': 0.82 },
        { nuclear: 0, smr: 0, gas: 0, solar: 0, solar2: 0, bess: 0, campus: 0, campusB: 0, '*': 0.72 },
        { sub: 0, subTr: 0, gantry: 0, pylons: 0, campus: 0.3, campusB: 0.3, '*': 0.5 },
        null,
        { sub: 0.2, subTr: 0, gas: 0.1, campus: 0, campusB: 0.92, gantry: 0.2, pylons: 0.3, '*': 0.55 },
      ],
      onsite: [null, null, null, null, null, null],
    };
    let dimTween: Tween | null = null;
    let colTween: Tween | null = null;
    const applyStep = (i: number) => {
      const dims = STEP_DIMS[variant][i] ?? null;
      const entries = [...fxs.entries()];
      const from = entries.map(([, fx]) => fx.dim);
      const to = entries.map(([k]) => (dims ? (dims[k] ?? dims['*'] ?? 0) : 0));
      dimTween?.cancel();
      dimTween = ctx.tween.run(
        (k) =>
          entries.forEach(([, fx], j) => {
            fx.dim = from[j]! + (to[j]! - from[j]!) * k;
            fx.apply(ctx.palette);
          }),
        { duration: 650, fade: true },
      );
      // Wires / flows emphasis.
      wireMat.opacity = i === 3 ? 1 : i === 1 || i === 2 ? 0.45 : 0.85;
      flow.setOpacity(i === 1 || i === 2 ? 0.45 : 1);
      gasFlow.setOpacity(i === 1 ? 0.3 : 1);
      // Columns.
      colTween?.cancel();
      const c0s = cols.map((c) => ({ ...c.cur }));
      colTween = ctx.tween.run(
        (k) => {
          cols.forEach((c, j) => {
            c.cur.top = c0s[j]!.top + ((c.top[i] ?? 0) - c0s[j]!.top) * k;
            c.cur.fill = c0s[j]!.fill + ((c.fill[i] ?? 0) - c0s[j]!.fill) * k;
          });
          drawCols();
        },
        { duration: 900, ease: 'cubicInOut' },
      );
      level.visible = i === 1 && isGrid;
      ctx.tween.to(levelMat, { opacity: i === 1 ? 0.9 : 0 }, { duration: 500, delay: 500, fade: true });
      // Bottleneck props.
      const bn = i === 5 && isGrid;
      ghostGroup.visible = bn;
      if (wait) wait.object.visible = !bn;
      hallGlow.forEach((g, j) => (glowAlpha[g] = bn && j >= 4 ? 0 : (glowSpecs[g]?.alpha ?? 0)));
      const sub = fxs.get('subTr');
      if (sub) {
        sub.warnTint = A.gas;
        sub.warn = bn ? 0.6 : 0;
        sub.apply(ctx.palette);
      }
      for (const l of labs) l.h.set({ visible: !l.steps || l.steps.includes(i) });
      ctx.invalidate();
    };

    /* ───────── animation ───────── */
    const tmpV = new Vector3();
    const steamTint = new Color();
    const animateFrame = (t: number) => {
      const p = ctx.palette;
      const dark = isDark(p);
      for (const f of flows) f.update(t);
      steam.forEach((gi, j) => {
        const ph = (t * 0.07 + j / steam.length) % 1;
        tmpV.set(TOWER.x + 0.35 * ph, TOWER.h + 0.05 + ph * 1.25, TOWER.z - 0.15 * ph);
        steamTint.copy(p.fg).lerp(p.bg, dark ? 0.35 : 0.62);
        glows.set(gi, tmpV, 0.55 + ph * 1.1, steamTint, Math.sin(Math.PI * ph) * (dark ? 0.22 : 0.5));
      });
      for (const s of stacks) glows.setAlpha(s.i, s.base * (dark ? 1 : 0.7) * (0.8 + 0.2 * Math.sin(t * 2.2 + s.i)));
      hallGlow.forEach((g, j) => {
        let a = glowAlpha[g] ?? 0;
        // Onsite: the flexible (front-row) halls throttle down periodically.
        if (!isGrid && j >= 4) a *= 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * 0.55));
        glows.setAlpha(g, a * (dark ? 1 : 0.6));
      });
      for (const c of clocks) {
        c.min.rotation.z = -t * 1.4;
        c.g.quaternion.copy(ctx.camera.quaternion);
      }
      const sub = fxs.get('subTr');
      if (sub && sub.warn > 0) {
        sub.warn = 0.45 + 0.2 * Math.sin(t * 2.4);
        sub.apply(p);
      }
    };

    /* ───────── initial state ───────── */
    let lastT = 0;
    applyStep(ctx.step);
    animateFrame(0);

    return {
      update(_dt, t) {
        lastT = t;
        animateFrame(t);
      },
      setStep(i) {
        applyStep(i);
        const tw = ctx.setPose(P(STEP_POSES[variant][i] ?? null));
        const id = pending;
        pending = null;
        if (id) void tw.done.then(() => hotspots.select(id, 'command'));
      },
      onMotion(animate) {
        for (const f of flows) f.setReduced(!animate);
        animateFrame(lastT);
        ctx.invalidate();
      },
      onQuality(_q, tier) {
        setCounts(tier);
      },
      onPalette(p) {
        applyPalette(p);
        animateFrame(lastT);
      },
      onResize(size) {
        const nowNarrow = size.width < NARROW;
        if (nowNarrow !== narrow && size.portrait === portrait) {
          narrow = nowNarrow;
          applyAdapts();
          ctx.setPose(P(STEP_POSES[variant][ctx.step] ?? null));
        }
        if (size.portrait !== portrait) {
          narrow = nowNarrow;
          // Re-frame for the new stage shape (portrait orbits to the east side of the plate).
          portrait = size.portrait;
          colH = COL_H * (portrait ? COL_PORTRAIT : 1);
          drawCols();
          placeLevel();
          placeTops();
          applyAdapts();
          ctx.setPose(P(STEP_POSES[variant][ctx.step] ?? null));
        }
      },
      dispose() {
        hotTweens.forEach((t) => t.cancel());
        dimTween?.cancel();
        colTween?.cancel();
        root.removeFromParent();
      },
    };
  },
});

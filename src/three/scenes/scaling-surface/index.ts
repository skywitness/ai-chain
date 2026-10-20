/**
 * scaling-surface — 縮放定律曲面 (variant: default).
 *
 * A sculpted "terrain" of the scaling law: x = log parameters N, z = log training tokens D, height =
 * loss (示意, Chinchilla form, law.ts). The block stands on a plinth whose top is the irreducible
 * loss E. Iso-loss contours and decade grid lines are draped on the surface.
 *
 * Steps (由淺入深):
 *  0 總覽      axes, contours, "high loss here / low loss there".
 *  1 越大越好  three illustrative model sizes on the ridge, particles flowing down it (scale both
 *              together), two single-axis slices that flatten out, the E floor.
 *  2 固定預算  the surface is cut by the iso-compute plane C ≈ 6ND (a clipping plane; the part beyond
 *              the budget becomes a ghost). The cut face shows the U-shaped IsoFLOP profile with three
 *              allocations on it. A 「訓練預算 C」 slider (budget.ts) moves the cut.
 *  3 最適脊線  the compute-optimal ridge (D ≈ 20N) with the minima of a family of budgets.
 *  4 推論時縮放 an over-trained small model B on the same iso-loss contour as the optimal model A,
 *              and a DOM note card (note.ts) with an illustrative inference-time scaling sketch.
 * Reduced motion: no flowing particles (static dotted stream), camera cuts, 150 ms fades.
 * Layout: labels are fixed-size DOM, so the scene has width classes (NARROW, SMALL, ROOMY) on top of
 * portrait: inward label placements, shorter texts, a compact slider / note card and a few poses of
 * their own, so the key labels survive on the 4:3 phone stage (about 358 × 269) as well as at 16:9.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Plane,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type ColorRef,
  type HotspotSpec,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type PickHit,
  type SceneContext,
} from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { createBudgetControl } from './budget';
import { createNoteCard, noteLayout } from './note';
import { buildFloorGrid, buildSkirt, buildSurface, contours, CutFace, drape, lgLine, resample, roundedRect, Tube, type LgPoint } from './geometry';
import {
  E,
  HALF,
  height,
  isoLossLgD,
  isoSpan,
  LG_D,
  LG_N,
  LG_RATIO,
  LG6,
  lgCompute,
  lgDofZ,
  lgNofX,
  loss,
  optimum,
  ratioText,
  ridgeLgNForLoss,
  sci,
  wx,
  wy,
  wz,
  zhCount,
} from './law';

/* ───────────────────────── constants ───────────────────────── */

const LG_C_DEFAULT = 22;
const LG_C_MIN = 19.2;
const LG_C_MAX = 24.6;
/** A budget beyond the far corner: the cut plane misses the block (no cut). */
const LG_C_NONE = LG6 + LG_N[1] + LG_D[1] + 0.35;
const LIFT = 0.008;
const PIN_H = 0.46;
const PLINTH = HALF + 0.42;

/** Model-size markers (step 1): compute-optimal models at 10 億 / 100 億 / 1,000 億 parameters. */
const SIZES = [9, 10, 11] as const;
/** Over-trained small model B (step 4), ~1,000 tokens per parameter. */
const B_PT: LgPoint = [9.7, 12.7];
const FAMILY = [19.6, 20.6, 21.6, 22.6, 23.6, 24.4] as const;
/** Reducible-loss levels (L − E) for the contour lines, geometric so they spread evenly. */
const LEVELS = Array.from({ length: 13 }, (_, k) => 1.62 * 0.78 ** k);

type VisKey = 'size' | 'slices' | 'flow' | 'ridge' | 'cut' | 'alloc' | 'opt' | 'family' | 'isoLoss' | 'panel';
const STEP_VIS: readonly Record<VisKey, number>[] = [
  { size: 0, slices: 0, flow: 0, ridge: 0, cut: 0, alloc: 0, opt: 0, family: 0, isoLoss: 0, panel: 0 },
  { size: 1, slices: 1, flow: 1, ridge: 0.6, cut: 0, alloc: 0, opt: 0, family: 0, isoLoss: 0, panel: 0 },
  { size: 0, slices: 0, flow: 0, ridge: 0, cut: 1, alloc: 1, opt: 1, family: 0, isoLoss: 0, panel: 0 },
  { size: 0, slices: 0, flow: 1, ridge: 1, cut: 1, alloc: 0, opt: 1, family: 1, isoLoss: 0, panel: 0 },
  { size: 0, slices: 0, flow: 0, ridge: 0.45, cut: 0, alloc: 0, opt: 0, family: 0, isoLoss: 1, panel: 1 },
];

const FOV = 34;
const HOME: CameraPose = { position: [6.9, 7.3, 10.8], target: [0.35, 0.65, 0.3] };
const PORTRAIT_FOV = 46;
const PORTRAIT_HOME: CameraPose = { position: [6.15, 13.6, 11.2], target: [0.1, 0.7, 0.5], fov: PORTRAIT_FOV };
const STEP_POSES: readonly (CameraPose | null)[] = [
  null,
  { position: [6.2, 6.6, 10.4], target: [0.3, 0.7, 0.25] },
  { position: [8.8, 4.9, 8.8], target: [0.15, 0.7, 0.15] },
  { position: [8.4, 8.55, 9.1], target: [0.4, 0.6, 0.4] },
  { position: [7.1, 7.0, 12.0], target: [0.75, 1.1, -0.5] },
];
/** Portrait (4:5) poses, used as-is through ctx.tween.camera (setPose would rescale them again). */
const PORTRAIT_POSES: readonly CameraPose[] = [
  PORTRAIT_HOME,
  { position: [5.9, 13.25, 11.55], target: [0.1, 0.8, 0.5], fov: PORTRAIT_FOV },
  { position: [10.8, 9.55, 10.8], target: [0.2, 0.75, 0.2], fov: PORTRAIT_FOV },
  { position: [8.4, 13.6, 9.3], target: [0.2, 0.6, 0.3], fov: PORTRAIT_FOV },
  { position: [7.25, 14.3, 12.7], target: [0.3, 2.6, -0.6], fov: PORTRAIT_FOV },
];
/**
 * Narrow landscape stages (below NARROW): the budget steps pull back a little and sit higher, so the
 * front axis labels clear the slider at the bottom (labels are larger relative to the surface there).
 */
const NARROW_POSES: Readonly<Partial<Record<number, CameraPose>>> = {
  2: { position: [9.15, 4.67, 9.15], target: [0.15, 0.3, 0.15] },
  3: { position: [8.95, 8.55, 9.7], target: [0.65, 0.35, 0.65] },
};
/** Landscape phone stages (below SMALL): step 4 sits a little lower, so pin A's label clears the corner note card. */
const SMALL_POSES: Readonly<Partial<Record<number, CameraPose>>> = {
  4: { position: [7.1, 7.3, 12.0], target: [0.75, 1.4, -0.5] },
};
/** Step 4 on wide portrait stages, where the note card is a short strip: the surface moves up and closer. */
const PORTRAIT_ROW_4: CameraPose = { position: [6.28, 12.48, 12.19], target: [0, 1.9, 0.17], fov: PORTRAIT_FOV };

/**
 * Stage width classes (CSS px). Labels are fixed-size DOM, so on narrower stages they grow relative to
 * the surface: below NARROW, labels that would hang off the right edge move inside the plinth; below
 * SMALL (phones, including the 4:3 inline stage) texts get shorter and the slider / note card compact.
 */
const NARROW = 680;
const SMALL = 560;
/** Below this landscape width the front-corner ticks fall under the budget slider (steps 2–3). */
const ROOMY = 1000;

/** Pin indices in the shared InstancedMesh. */
const PIN = { size0: 0, big: 3, opt: 4, small: 5, a: 6, b: 7 } as const;
const PIN_COUNT = 8;

/* ───────────────────────── scene ───────────────────────── */

export default defineScene({
  json,
  meta: {
    camera: {
      ...HOME,
      fov: FOV,
      minDistance: 6,
      maxDistance: 24,
      minPolar: 0.3,
      maxPolar: 1.42,
      portrait: PORTRAIT_HOME,
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 45, tris: 120_000 },
  },

  create(ctx: SceneContext) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'scaling-surface';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette, { intensity: 0.9 });
    const prevClipping = ctx.renderer.localClippingEnabled;
    ctx.renderer.localClippingEnabled = true;
    let portrait = ctx.size.portrait; // same rule as the host (aspect < 1) so camera.portrait and the layout agree
    let narrow = ctx.size.width < NARROW;
    let roomy = ctx.size.width >= ROOMY;
    let small = ctx.size.width < SMALL; // phone-width stages (landscape 4:3 included): shorter labels
    const dark = () => ctx.theme === 'dark';

    /* ───────── clipping planes (budget cut) ───────── */
    const keepPlane = new Plane(new Vector3(-1, 0, -1).normalize(), 100);
    const ghostPlane = new Plane(new Vector3(1, 0, 1).normalize(), -100);
    const setPlane = (lgC: number) => {
      // x + z = k on the iso-compute line lgN + lgD = lgC − lg6.
      const k = wx(LG_N[0]) + wz(LG_D[0]) + 1.5 * (lgC - LG6 - LG_N[0] - LG_D[0]);
      keepPlane.constant = k / Math.SQRT2;
      ghostPlane.constant = -k / Math.SQRT2;
    };

    /* ───────── floor & plinth (top = irreducible loss E) ───────── */
    const grid = buildFloorGrid(11, 0.75);
    const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const gridLines = new LineSegments(ctx.track(grid.geometry), gridMat);
    gridLines.position.y = -0.24;
    root.add(gridLines);
    const shadowTex = ctx.track(radialTexture(256));
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = new Mesh(ctx.track(new PlaneGeometry(14, 14)), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.235;
    root.add(shadow);

    const plinthShape = roundedRect(PLINTH * 2, PLINTH * 2, 0.32);
    const plinthGeo = ctx.track(new ExtrudeGeometry(plinthShape, { depth: 0.22, bevelEnabled: false, curveSegments: 8 }));
    plinthGeo.rotateX(-Math.PI / 2);
    plinthGeo.translate(0, -0.222, 0);
    const plinthMat = materials.standard((p) => p.bg.clone().lerp(p.fg, p.theme === 'dark' ? 0.1 : 0.06), { roughness: 0.85, metalness: 0 });
    const plinth = new Mesh(plinthGeo, plinthMat);
    root.add(plinth);
    const rimMat = materials.line('fg', { transparent: true, opacity: 0.22 });
    const rim = new LineLoop(
      ctx.track(new BufferGeometry().setFromPoints(plinthShape.getPoints(12).map((p) => new Vector3(p.x, 0.003, -p.y)))),
      rimMat,
    );
    root.add(rim);

    /* ───────── the surface ───────── */
    const seg = ctx.quality === 'high' ? 120 : ctx.quality === 'medium' ? 90 : 64;
    const surf = buildSurface(seg);
    ctx.track(surf.geometry);
    const surfMat = ctx.track(
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.04,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        clippingPlanes: [keepPlane],
      }),
    );
    const surface = new Mesh(surf.geometry, surfMat);
    root.add(surface);
    const ghostMat = ctx.track(
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: DoubleSide,
        clippingPlanes: [ghostPlane],
      }),
    );
    const ghost = new Mesh(surf.geometry, ghostMat);
    ghost.renderOrder = 6;
    ghost.visible = false;
    root.add(ghost);

    const skirt = buildSkirt(seg);
    ctx.track(skirt.geometry);
    const skirtMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, clippingPlanes: [keepPlane] }));
    root.add(new Mesh(skirt.geometry, skirtMat));

    /* ───────── contours + decade grid on the surface (one geometry, two clipped views) ───────── */
    const linePos: number[] = [];
    const lineW: number[] = [];
    contours(LEVELS, 150, LIFT).forEach((arr, k) => {
      for (let i = 0; i < arr.length; i++) linePos.push(arr[i]!);
      const w = k % 3 === 0 ? 0.62 : 0.34;
      for (let i = 0; i < arr.length / 3; i++) lineW.push(w);
    });
    const decade = (pts: Vector3[]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        linePos.push(pts[i]!.x, pts[i]!.y, pts[i]!.z, pts[i + 1]!.x, pts[i + 1]!.y, pts[i + 1]!.z);
        lineW.push(0.16, 0.16);
      }
    };
    for (let n = LG_N[0] + 1; n < LG_N[1]; n++) decade(drape(lgLine([n, LG_D[0]], [n, LG_D[1]], 90), LIFT));
    for (let d = LG_D[0] + 1; d < LG_D[1]; d++) decade(drape(lgLine([LG_N[0], d], [LG_N[1], d], 90), LIFT));
    const lineGeo = ctx.track(new BufferGeometry());
    lineGeo.setAttribute('position', new Float32BufferAttribute(linePos, 3));
    lineGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((linePos.length / 3) * 4), 4));
    const lineMat = ctx.track(
      new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, clippingPlanes: [keepPlane] }),
    );
    const ghostLineMat = ctx.track(
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false, clippingPlanes: [ghostPlane] }),
    );
    const surfLines = new LineSegments(lineGeo, lineMat);
    surfLines.renderOrder = 2;
    const ghostLines = new LineSegments(lineGeo, ghostLineMat);
    ghostLines.renderOrder = 7;
    ghostLines.visible = false;
    root.add(surfLines, ghostLines);

    /* ───────── axes: ticks on the plinth + the loss gauge ───────── */
    const axisPos: number[] = [];
    const tickOut = 0.16;
    for (let n = LG_N[0]; n <= LG_N[1]; n++) axisPos.push(wx(n), 0.004, PLINTH - 0.02, wx(n), 0.004, PLINTH + tickOut);
    for (let d = LG_D[0]; d <= LG_D[1]; d++) axisPos.push(PLINTH - 0.02, 0.004, wz(d), PLINTH + tickOut, 0.004, wz(d));
    const LOSS_TICKS = [2, 2.5, 3, 3.5];
    const gx = -PLINTH + 0.06;
    const gz = PLINTH - 0.06;
    const gTop = wy(3.65);
    axisPos.push(gx, 0, gz, gx, gTop, gz);
    for (const lv of LOSS_TICKS) axisPos.push(gx, wy(lv), gz, gx - 0.14, wy(lv), gz);
    const axisLines = new LineSegments(ctx.track(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(axisPos, 3))), materials.line('muted'));
    root.add(axisLines);

    /* ───────── tubes & materials ───────── */
    const tubeMat = (ref: ColorRef, emissive = 0.2): MeshStandardMaterial => {
      const m = materials.standard(ref, { roughness: 0.38, metalness: 0.08, transparent: true });
      materials.bind(m, 'emissive', ref, (c, p) => c.multiplyScalar(p.theme === 'dark' ? emissive * 2.2 : emissive));
      return m;
    };
    const addTube = (samples: number, mat: MeshStandardMaterial, order = 3) => {
      const t = ctx.track(new Tube(samples, 8));
      const m = new Mesh(t.geometry, mat);
      m.renderOrder = order;
      m.visible = false;
      root.add(m);
      return { tube: t, mesh: m, mat };
    };

    // Ridge (D = 20N), its pick proxy and the flowing particles.
    const ridgeEnd = LG_D[1] - LG_RATIO;
    const ridgePts = drape(lgLine([LG_N[0] + 0.02, LG_N[0] + 0.02 + LG_RATIO], [ridgeEnd - 0.02, LG_D[1] - 0.02], 80), 0.018);
    const ridge = addTube(80, tubeMat('highlight', 0.3), 4);
    ridge.tube.set(ridgePts, 0.036);
    const ridgeProxyTube = ctx.track(new Tube(40, 6));
    ridgeProxyTube.set(resample(ridgePts, 40), 0.16);
    const ridgeProxy = new Mesh(ridgeProxyTube.geometry, ctx.track(new MeshBasicMaterial({ visible: false })));
    root.add(ridgeProxy);
    const FLOW_MAX = 150;
    const flow = ctx.track(
      new PathFlow({
        paths: [{ points: drape(lgLine([LG_N[0] + 0.05, LG_N[0] + 0.05 + LG_RATIO], [ridgeEnd - 0.05, LG_D[1] - 0.05], 40), 0.075) }],
        count: scaleCount(FLOW_MAX, ctx.tier, 40),
        size: 0.075,
        sizeVariance: 0.3,
        speed: 0.55,
        speedVariance: 0.2,
        fadeEnds: 0.08,
        theme: ctx.theme,
        seed: 5,
      }),
    );
    flow.setReduced(!ctx.animate);
    flow.object.visible = false;
    root.add(flow.object);

    // Single-axis slices (step 1).
    const SLICE_D = 9.55;
    const SLICE_N = 8.55;
    const sliceA = addTube(90, tubeMat('heat', 0.22));
    sliceA.tube.set(drape(lgLine([LG_N[0], SLICE_D], [LG_N[1], SLICE_D], 90), 0.016), 0.026);
    const sliceB = addTube(90, sliceA.mat);
    sliceB.tube.set(drape(lgLine([SLICE_N, LG_D[0]], [SLICE_N, LG_D[1]], 90), 0.016), 0.026);

    // Budget cut: face + iso-compute edge tube.
    const CUT_N = 96;
    const cut = ctx.track(new CutFace(CUT_N));
    const cutMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: DoubleSide, transparent: true }));
    const cutMesh = new Mesh(cut.geometry, cutMat);
    cutMesh.visible = false;
    cutMesh.renderOrder = 1;
    root.add(cutMesh);
    const iso = addTube(CUT_N, tubeMat('optic', 0.28), 4);

    // Iso-compute family + their minima (step 3).
    const famPos: number[] = [];
    for (const c of FAMILY) {
      const span = isoSpan(c);
      if (!span) continue;
      const s = c - LG6;
      const pts = drape(lgLine([span[0], s - span[0]], [span[1], s - span[1]], 70), 0.012);
      for (let i = 0; i < pts.length - 1; i++) famPos.push(pts[i]!.x, pts[i]!.y, pts[i]!.z, pts[i + 1]!.x, pts[i + 1]!.y, pts[i + 1]!.z);
    }
    const famMat = materials.line('optic', { transparent: true, opacity: 0 });
    const famLines = new LineSegments(ctx.track(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(famPos, 3))), famMat);
    famLines.visible = false;
    famLines.renderOrder = 3;
    root.add(famLines);
    const dotGeo = ctx.track(new SphereGeometry(0.06, 16, 12));
    const famDotMat = tubeMat('highlight', 0.35);
    const famDots = new InstancedMesh(dotGeo, famDotMat, FAMILY.length);
    famDots.visible = false;
    root.add(famDots);
    ctx.track({ dispose: () => famDots.dispose() });

    // Iso-loss contour through B (step 4).
    const L_B = loss(B_PT[0], B_PT[1]);
    const A_LGN = ridgeLgNForLoss(L_B);
    const A_PT: LgPoint = [A_LGN, A_LGN + LG_RATIO];
    const isoLossPts: Vector3[] = [];
    for (let i = 0; i <= 200; i++) {
      const n = LG_N[0] + ((LG_N[1] - LG_N[0]) * i) / 200;
      const d = isoLossLgD(L_B, n);
      if (d !== null) isoLossPts.push(new Vector3(wx(n), wy(L_B) + 0.02, wz(d)));
    }
    const isoLoss = addTube(90, tubeMat('pos', 0.25), 4);
    isoLoss.tube.set(resample(isoLossPts, 90), 0.03);

    /* ───────── pins (model markers) ───────── */
    const headGeo = ctx.track(new SphereGeometry(0.105, 24, 16));
    const stemGeo = ctx.track(new CylinderGeometry(0.013, 0.013, 1, 8, 1, true));
    stemGeo.translate(0, 0.5, 0);
    const headMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.1 }));
    const stemMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0 }));
    const heads = new InstancedMesh(headGeo, headMat, PIN_COUNT);
    const stems = new InstancedMesh(stemGeo, stemMat, PIN_COUNT);
    heads.renderOrder = 5;
    root.add(heads, stems);
    ctx.track({ dispose: () => (heads.dispose(), stems.dispose()) });
    const glows = ctx.track(new GlowSprites({ count: PIN_COUNT, theme: ctx.theme }));
    root.add(glows.object);
    const pinBase: Vector3[] = Array.from({ length: PIN_COUNT }, () => new Vector3());
    const pinLg: LgPoint[] = Array.from({ length: PIN_COUNT }, () => [0, 0] as const);
    const pinScale = new Float32Array(PIN_COUNT);
    const pinRef: ColorRef[] = ['highlight', 'highlight', 'highlight', 'heat', 'highlight', 'heat', 'highlight', 'pos'];
    const pinCol = pinRef.map(() => new Color());
    const stemCol = pinRef.map(() => new Color());
    const setPin = (i: number, p: LgPoint) => {
      pinLg[i] = p;
      pinBase[i]!.set(wx(p[0]), height(p[0], p[1]), wz(p[1]));
    };
    SIZES.forEach((n, i) => setPin(PIN.size0 + i, [n, n + LG_RATIO]));
    setPin(PIN.a, A_PT);
    setPin(PIN.b, B_PT);

    const m4 = new Matrix4();
    const q0 = new Quaternion();
    const v3 = new Vector3();
    const sc = new Vector3();
    let pinHot = 0;
    const drawPins = () => {
      for (let i = 0; i < PIN_COUNT; i++) {
        const s = pinScale[i]! * (1 + 0.25 * pinHot);
        const b = pinBase[i]!;
        const len = PIN_H * Math.min(1, pinScale[i]! * 1.4);
        heads.setMatrixAt(i, m4.compose(v3.set(b.x, b.y + len, b.z), q0, sc.setScalar(Math.max(1e-4, s))));
        stems.setMatrixAt(i, m4.compose(b, q0, sc.set(Math.max(1e-4, pinScale[i]!), Math.max(1e-4, len), Math.max(1e-4, pinScale[i]!))));
        heads.setColorAt(i, pinCol[i]!);
        stems.setColorAt(i, stemCol[i]!);
        glows.set(i, v3, 0.6 * s, pinCol[i]!, (dark() ? 0.75 : 0.45) * Math.min(1, pinScale[i]!));
      }
      heads.instanceMatrix.needsUpdate = true;
      stems.instanceMatrix.needsUpdate = true;
      if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
      if (stems.instanceColor) stems.instanceColor.needsUpdate = true;
      heads.computeBoundingSphere();
      stems.computeBoundingSphere();
    };
    const isoAnchor = new Vector3();
    const pinAnchor = new Vector3();
    const pinTop = (i: number) => v3.copy(pinBase[i]!).setY(pinBase[i]!.y + PIN_H + 0.1).toArray() as [number, number, number];

    /* ───────── note card: inference-time scaling (step 4, DOM — see note.ts) ───────── */
    const note = createNoteCard({ stage: ctx.stage });

    /* ───────── labels ───────── */
    const L = (spec: LabelSpec) => labels.add(spec);
    const N_TICK = ['1 億', '10 億', '100 億', '1,000 億', '1 兆'];
    const D_TICK = ['10 億', '100 億', '1,000 億', '1 兆', '10 兆'];
    const nTicks = N_TICK.map((t, i) =>
      L({ text: t, position: [wx(LG_N[0] + i), 0, PLINTH + 0.3], align: 'below', offset: [0, -6], kind: 'tag', priority: 6, hotspot: 'param-axis' }),
    );
    const dTicks = D_TICK.map((t, i) =>
      L({ text: t, position: [PLINTH + 0.3, 0, wz(LG_D[0] + i)], align: 'right', offset: [-6, 0], kind: 'tag', priority: 6, hotspot: 'token-axis' }),
    );
    LOSS_TICKS.forEach((v) =>
      L({ text: v.toFixed(1), position: [gx - 0.2, wy(v), gz], align: 'left', offset: [4, 0], kind: 'tag', priority: 3, hotspot: 'loss-surface' }),
    );
    const nTitle = L({ text: '參數量 N（對數）', position: [0.2, 0, PLINTH + 1.0], align: 'below', priority: 28, hotspot: 'param-axis' });
    const dTitle = L({ text: '訓練 Token 數 D（對數）', position: [PLINTH + 1.05, 0, 0.6], align: 'right', priority: 28, hotspot: 'token-axis' });
    const lTitle = L({ text: '損失 L（示意）', position: [gx, gTop + 0.08, gz], align: 'above', priority: 27, hotspot: 'loss-surface' });

    const hiCorner = L({ text: '模型小、資料少：損失高', position: [wx(8.25), height(8.25, 9.25) + 0.1, wz(9.25)], align: 'above', kind: 'muted', priority: 18 });
    const loCorner = L({ text: '模型大、資料多：損失低', position: [wx(11.6), height(11.6, 12.6) + 0.1, wz(12.6)], align: 'above', kind: 'muted', priority: 18 });
    const contourAt = isoLossLgD(E + LEVELS[3]!, 10.9) ?? 11;
    const contourTag = L({ text: '等損失線', position: [wx(10.9), wy(E + LEVELS[3]!) + 0.02, wz(contourAt)], align: 'right', kind: 'tag', priority: 8 });
    const floorTag = L({ text: '不可約損失 E', position: [gx - 0.2, 0.02, gz], align: 'left', offset: [4, 0], kind: 'tag', priority: 16, hotspot: 'irreducible-loss' });
    const sliceTagA = L({ text: '只加參數：被資料卡住', position: [wx(11.7), height(11.7, SLICE_D) + 0.12, wz(SLICE_D)], align: 'above', kind: 'muted', priority: 17 });
    const sliceTagB = L({ text: '只加資料：被模型大小卡住', position: [wx(SLICE_N), height(SLICE_N, 12.55) + 0.12, wz(12.55)], align: 'above', offset: [34, -2], kind: 'muted', priority: 17 });
    const sizeTags = SIZES.map((n, i) =>
      L({ text: `${zhCount(10 ** n)}參數（示意）`, position: pinTop(PIN.size0 + i), align: 'above', priority: 22, hotspot: 'model-markers' }),
    );
    const cutTag = L({ text: '固定預算的剖面', swatch: ctx.palette.css['scene-optic'] ?? '', position: [0, 0, 0], align: 'right', priority: 24, hotspot: 'iso-compute' });
    const formulaTag = L({ text: 'C ≈ 6 × N × D', position: [0, 0, 0], align: 'right', kind: 'tag', priority: 14, hotspot: 'iso-compute' });
    const bigTag = L({ text: '模型太大、資料不足', position: [0, 0, 0], align: 'right', priority: 21, hotspot: 'model-markers' });
    const optTag = L({ text: '', position: [0, 0, 0], align: 'above', kind: 'strong', priority: 26, hotspot: 'model-markers' });
    const smallTag = L({ text: '模型太小、資料過多', position: [0, 0, 0], align: 'left', priority: 21, hotspot: 'model-markers' });
    const ridgeTag = L({
      text: '運算最適脊線：約 20 Token／參數',
      swatch: ctx.palette.css['scene-highlight'] ?? '',
      position: [wx(8.9), height(8.9, 8.9 + LG_RATIO) + 0.12, wz(8.9 + LG_RATIO)],
      align: 'right',
      offset: [8, 0],
      priority: 25,
      hotspot: 'optimal-ridge',
    });
    const famO = optimum(FAMILY[4]);
    const famTag = L({ text: '各預算的最低點', position: [wx(famO.lgN) + 0.1, height(famO.lgN, famO.lgD) + 0.05, wz(famO.lgD)], align: 'right', kind: 'muted', priority: 12, hotspot: 'optimal-ridge' });
    const aTag = L({ text: 'A：運算最適', position: pinTop(PIN.a), align: 'above', priority: 26, hotspot: 'model-markers' });
    const bTag = L({ text: 'B：小模型、多訓練', position: pinTop(PIN.b), align: 'above', priority: 26, hotspot: 'model-markers' });
    const isoLossTag = L({
      text: '同損失線',
      swatch: ctx.palette.css['c-pos'] ?? '',
      position: isoLossPts[Math.floor(isoLossPts.length * 0.9)]!.toArray(),
      align: 'right',
      priority: 15,
    });
    const STEP_LABELS: readonly (readonly LabelHandle[])[] = [
      [hiCorner, loCorner, contourTag],
      [sliceTagA, sliceTagB, ...sizeTags],
      [cutTag, formulaTag, bigTag, optTag, smallTag],
      [cutTag, optTag, ridgeTag, famTag],
      [aTag, bTag, isoLossTag],
    ];
    const ALL_STEP_LABELS = [...new Set(STEP_LABELS.flat())];
    const showLabels = (step: number) => {
      const on = new Set(STEP_LABELS[step] ?? []);
      for (const h of ALL_STEP_LABELS) h.set({ visible: on.has(h) });
      // Landscape budget steps below ROOMY: the front-corner ticks sit where the slider is.
      const front = !(!roomy && !portrait && (step === 2 || step === 3));
      nTicks[nTicks.length - 1]!.set({ visible: front });
      dTicks[dTicks.length - 1]!.set({ visible: front });
      // Portrait / narrow budget views look straight down the cut, where this tag would cover the 「太小」 pin.
      // On phone stages it yields to the step-1 pin and slice labels.
      floorTag.set({
        kind: step === 1 ? 'default' : 'tag',
        priority: step === 1 && !small ? 24 : 16,
        visible: !((portrait || narrow) && (step === 2 || step === 3)),
      });
    };

    /* ───────── budget control ───────── */
    let budget = LG_C_DEFAULT;
    const budgetUi = createBudgetControl({
      stage: ctx.stage,
      signal: ctx.signal,
      min: LG_C_MIN,
      max: LG_C_MAX,
      step: 0.05,
      value: budget,
      label: '訓練預算 C（示意）',
      shortLabel: '預算 C（示意）',
      format: sci,
      onInput: (v) => {
        budget = v;
        applyCut();
        ctx.invalidate();
      },
    });
    budgetUi.show(false);

    /* ───────── visibility state ───────── */
    const vis: Record<VisKey, number> = { ...STEP_VIS[0]! };
    const hot: Partial<Record<VisKey, number>> = {};
    const eff = (k: VisKey) => Math.max(vis[k], hot[k] ?? 0);
    const fade = (obj: { visible: boolean }, mat: Material, v: number, base = 1) => {
      obj.visible = v > 0.01;
      mat.opacity = base * Math.min(1, v);
    };

    const famDotsDraw = (k: number) => {
      FAMILY.forEach((c, i) => {
        const o = optimum(c);
        famDots.setMatrixAt(i, m4.compose(v3.set(wx(o.lgN), height(o.lgN, o.lgD) + 0.02, wz(o.lgD)), q0, sc.setScalar(Math.max(1e-4, k))));
      });
      famDots.instanceMatrix.needsUpdate = true;
      famDots.computeBoundingSphere();
    };

    const topPts: Vector3[] = Array.from({ length: CUT_N }, () => new Vector3());
    const isoPts: Vector3[] = Array.from({ length: CUT_N }, () => new Vector3());

    /** Position the cut plane, cut face, budget edge and the three allocation pins. */
    function applyCut() {
      const c = vis.cut;
      const lgCd = LG_C_NONE + (budget - LG_C_NONE) * c;
      setPlane(c > 0.002 ? lgCd : LG_C_NONE + 5);
      const showIso = Math.max(c, hot.cut ?? 0);
      const lgCt = c > 0.002 ? lgCd : budget;
      const span = isoSpan(lgCt);
      const cutOn = c > 0.002 && !!span;
      cutMesh.visible = cutOn;
      ghost.visible = ghostLines.visible = cutOn;
      ghostMat.opacity = (dark() ? 0.1 : 0.12) * c;
      ghostLineMat.opacity = 0.4 * c;
      cutMat.opacity = Math.min(1, c * 1.6);
      iso.mesh.visible = !!span && showIso > 0.01;
      iso.mat.opacity = Math.min(1, showIso * 1.4);
      if (span) {
        const s = lgCt - LG6;
        for (let i = 0; i < CUT_N; i++) {
          const n = span[0] + ((span[1] - span[0]) * i) / (CUT_N - 1);
          const d = s - n;
          topPts[i]!.set(wx(n), height(n, d), wz(d));
          isoPts[i]!.copy(topPts[i]!).y += cutOn ? 0.004 : 0.02;
        }
        if (cutOn) cut.set(topPts);
        iso.tube.set(isoPts, 0.034);
        isoAnchor.copy(isoPts[Math.floor(CUT_N / 2)]!);
        // Allocation pins on the edge: the optimum and ±1 decade of N along the same budget.
        const o = optimum(lgCt);
        const lo = span[0] + 0.1;
        const hi = span[1] - 0.1;
        const on = Math.min(Math.max(o.lgN, lo), hi);
        setPin(PIN.opt, [on, s - on]);
        const bigN = Math.min(o.lgN + 1, hi);
        const smallN = Math.max(o.lgN - 1, lo);
        setPin(PIN.big, [bigN, s - bigN]);
        setPin(PIN.small, [smallN, s - smallN]);
        pinScale[PIN.opt] = eff('opt');
        pinScale[PIN.big] = bigN - on > 0.35 ? eff('alloc') : 0;
        pinScale[PIN.small] = on - smallN > 0.35 ? eff('alloc') : 0;
        // Step 2 (and portrait / phones): under the U curve, on the cut face, so the 太大／太小 tags beside
        // the pins and the ridge tag above stay clear.
        const below = portrait || narrow || ctx.step === 2;
        optTag.set({
          text: `最適：${zhCount(10 ** on)}參數 × ${zhCount(10 ** (s - on))} Token`,
          position: below ? [pinBase[PIN.opt]!.x, pinBase[PIN.opt]!.y - 0.02, pinBase[PIN.opt]!.z] : pinTop(PIN.opt),
          align: below ? 'below' : 'above',
          offset: below ? [0, 10] : [0, 0],
        });
        bigTag.set({ position: pinTop(PIN.big), visible: ctx.step === 2 && pinScale[PIN.big]! > 0.5 });
        smallTag.set({ position: pinTop(PIN.small), visible: ctx.step === 2 && pinScale[PIN.small]! > 0.5 });
        // Cut / formula tags at the high-N end of the edge (back right), clear of the pins.
        const endN = span[1] - 0.04;
        cutTag.set({ position: [wx(endN) + 0.1, height(endN, s - endN) + 0.15, wz(s - endN)] });
        formulaTag.set({ position: [wx(endN) + 0.1, height(endN, s - endN) - 0.25, wz(s - endN)] });
      } else {
        pinScale[PIN.opt] = pinScale[PIN.big] = pinScale[PIN.small] = 0;
      }
      drawPins();
      const first = [...pinScale].findIndex((v) => v > 0.5);
      pinAnchor.copy(pinBase[first < 0 ? PIN.size0 + 1 : first]!).y += PIN_H;
    }

    function applyVis() {
      for (let i = 0; i < SIZES.length; i++) pinScale[PIN.size0 + i] = eff('size');
      pinScale[PIN.a] = pinScale[PIN.b] = eff('isoLoss');
      fade(sliceA.mesh, sliceA.mat, eff('slices'));
      sliceB.mesh.visible = sliceA.mesh.visible;
      fade(ridge.mesh, ridge.mat, eff('ridge'));
      const fl = eff('flow');
      flow.object.visible = fl > 0.01;
      flow.setOpacity((dark() ? 1 : 0.85) * fl);
      fade(famLines, famMat, eff('family'), dark() ? 0.55 : 0.7);
      famDots.visible = eff('family') > 0.01;
      famDotsDraw(eff('family'));
      fade(isoLoss.mesh, isoLoss.mat, eff('isoLoss'));
      note.setOpacity(eff('panel'));
      applyCut();
      ctx.invalidate();
    }

    let visTween: { cancel(): void } | null = null;
    const goVis = (target: Record<VisKey, number>, duration = 750) => {
      visTween?.cancel();
      const from = { ...vis };
      visTween = ctx.tween.run(
        (k) => {
          for (const key of Object.keys(target) as VisKey[]) vis[key] = from[key] + (target[key] - from[key]) * k;
          applyVis();
        },
        { duration, ease: 'cubicInOut', fade: true },
      );
    };

    /* ───────── palette ───────── */
    const cLow = new Color();
    const cMid = new Color();
    const cHigh = new Color();
    const tmp = new Color();
    const tmp2 = new Color();
    const ramp = (t: number, out: Color) => {
      const u = Math.sqrt(Math.min(1, Math.max(0, t)));
      return u < 0.5 ? out.copy(cLow).lerp(cMid, u / 0.5) : out.copy(cMid).lerp(cHigh, (u - 0.5) / 0.5);
    };
    const applyPalette = (p: Palette) => {
      const dk = p.theme === 'dark';
      lights.apply(p);
      cLow.copy(p.coolant).lerp(p.optic, 0.1);
      cMid.copy(p.flow).lerp(p.bg, dk ? 0.5 : 0.3);
      cHigh.copy(p.power).lerp(p.bg, dk ? 0.45 : 0.42);
      const col = surf.geometry.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < surf.t.length; i++) {
        ramp(surf.t[i]!, tmp);
        col.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      col.needsUpdate = true;
      const scol = skirt.geometry.getAttribute('color') as Float32BufferAttribute;
      const base = tmp2.copy(p.bg).lerp(p.fg, dk ? 0.14 : 0.16);
      for (let i = 0; i < skirt.t.length; i++) {
        const t = skirt.t[i]!;
        if (t < 0) tmp.copy(base);
        else ramp(t, tmp).lerp(base, 0.45);
        scol.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      scol.needsUpdate = true;
      surfMat.emissive.copy(p.coolant).multiplyScalar(dk ? 0.06 : 0);
      ghostMat.emissive.copy(p.coolant).multiplyScalar(dk ? 0.1 : 0);
      // Lines: ink on light, soft light on dark.
      const ink = tmp.copy(p.fg).lerp(p.coolant, dk ? 0.15 : 0.2);
      const lc = lineGeo.getAttribute('color') as Float32BufferAttribute;
      const k = dk ? 0.55 : 0.72;
      for (let i = 0; i < lineW.length; i++) lc.setXYZW(i, ink.r, ink.g, ink.b, lineW[i]! * k);
      lc.needsUpdate = true;
      cut.recolor(tmp.copy(p.optic).lerp(p.bg, dk ? 0.2 : 0.38), tmp2.copy(p.optic).lerp(p.bg, dk ? 0.62 : 0.72));
      cutMat.emissive.copy(p.optic).multiplyScalar(dk ? 0.12 : 0.04);
      grid.recolor(tmp.copy(p.grid).lerp(p.fg, dk ? 0.08 : 0.04), dk ? 0.55 : 0.75);
      shadowMat.color.copy(dk ? p.flow : p.fg);
      shadowMat.opacity = dk ? 0.06 : 0.1;
      pinRef.forEach((r, i) => {
        pinCol[i]!.copy(materials.color(r));
        stemCol[i]!.copy(pinCol[i]!).lerp(p.fg, 0.35);
      });
      flow.recolor(() => p.highlight);
      flow.setTheme(p.theme);
      flow.setSize(dk ? 0.08 : 0.065);
      glows.setTheme(p.theme);
      cutTag.set({ swatch: p.css['scene-optic'] ?? '' });
      ridgeTag.set({ swatch: p.css['scene-highlight'] ?? '' });
      isoLossTag.set({ swatch: p.css['c-pos'] ?? '' });
      drawPins();
    };
    applyPalette(ctx.palette);
    applyVis();
    showLabels(0);

    /* ───────── panel layout ───────── */
    const layout = () => {
      note.setLayout(noteLayout(ctx.size, portrait), portrait, ctx.size.height);
      // Short label from NARROW down; it spans the stage only on phones and portrait stages.
      budgetUi.setLayout(portrait || small, narrow);
      // Portrait and narrow stages: tuck titles and tags inside the plinth outline instead of letting
      // them hang off the right edge (where the label layer would drop them).
      const inward = portrait || narrow;
      nTitle.set(
        portrait ? { position: [-1.4, 0, PLINTH + 1.15], align: 'below', offset: [16, 0] } : { position: [0.2, 0, PLINTH + 1.0], align: 'below', offset: [0, 0] },
      );
      dTitle.set(
        portrait
          ? { position: [PLINTH + 0.9, 0, 2.2], align: 'below', offset: [0, 0] }
          : narrow
            ? { position: [PLINTH + 0.75, 0, 1.6], align: 'below', offset: [12, 0] }
            : { position: [PLINTH + 1.05, 0, 0.6], align: 'right', offset: [0, 0] },
      );
      // Phones: beside the gauge top instead of centred above it (off-stage), yielding to pin labels.
      lTitle.set(small ? { align: 'right', offset: [-14, -2], priority: 15 } : { align: 'above', offset: [0, 0], priority: 27 });
      hiCorner.set({ text: small ? '損失高' : '模型小、資料少：損失高' });
      loCorner.set({ text: small ? '損失低' : '模型大、資料多：損失低' });
      // Above their pins: beside them they collide with the cut tag when the budget slider is high.
      bigTag.set({ align: 'above', text: portrait || small ? '模型太大' : '模型太大、資料不足' });
      smallTag.set({ align: 'above', text: portrait || small ? '模型太小' : '模型太小、資料過多' });
      cutTag.set({ align: inward ? 'above' : 'right', offset: inward ? [-24, -34] : [0, 0] });
      formulaTag.set({ align: inward ? 'below' : 'right', offset: inward ? [-30, 40] : [0, 0] });
      // Below NARROW the long slice tags collide with the pin labels; the caption carries 「被…卡住」.
      sliceTagA.set(narrow ? { text: '只加參數', offset: [14, 0] } : { text: '只加參數：被資料卡住', offset: [0, 0] });
      sliceTagB.set(
        narrow
          ? { text: '只加資料', align: 'left', offset: [-2, 0] }
          : { text: '只加資料：被模型大小卡住', ...(inward ? { align: 'right', offset: [6, 0] } : { align: 'above', offset: [34, -2] }) },
      );
      floorTag.set(inward ? { align: 'right', offset: [8, -12] } : { align: 'left', offset: [4, 0] });
      ridgeTag.set({ text: small ? '最適脊線：D ≈ 20N' : narrow ? '最適脊線：約 20 Token／參數' : '運算最適脊線：約 20 Token／參數' });
      // Left of its pin: above it, it sits at A's height just to the left and hides A's label.
      bTag.set({ text: portrait || small ? 'B：小模型' : 'B：小模型、多訓練', align: 'left', offset: [-4, 6] });
    };
    layout();
    let lastSize = { width: ctx.size.width, height: ctx.size.height };

    /* ───────── hotspots & cards ───────── */
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const baseCard = (id: string): CardContent => {
      const h = hsText.get(id);
      const c: CardContent = { title: h?.label ?? id };
      if (h?.detail) c.body = h.detail;
      if (h?.href) {
        c.href = h.href;
        c.linkLabel = '名詞解釋 →';
      }
      return c;
    };
    const fmtL = (v: number) => v.toFixed(2);
    const describe = (lg: LgPoint) =>
      `${zhCount(10 ** lg[0])}參數 × ${zhCount(10 ** lg[1])} Token（約 ${ratioText(lg[0], lg[1])} Token／參數），訓練運算 ≈ ${sci(lgCompute(lg[0], lg[1])).text} FLOP，示意損失 ${fmtL(loss(lg[0], lg[1]))}`;

    const pinCard = (i: number): CardContent => {
      const lg = pinLg[i]!;
      if (i < PIN.big)
        return {
          title: `${zhCount(10 ** lg[0])}參數的示意模型`,
          body: `以運算最適比例訓練：${describe(lg)}。參數每放大 10 倍，損失下降的幅度越來越小。`,
        };
      const opt = pinLg[PIN.opt]!;
      if (i === PIN.opt)
        return { title: '這個預算的最適配置（示意）', body: `${describe(lg)}。它是 U 形剖面的最低點，位在運算最適脊線上。` };
      if (i === PIN.big || i === PIN.small)
        return {
          title: i === PIN.big ? '模型太大、資料不足（示意）' : '模型太小、資料過多（示意）',
          body: `同一個預算下的另一種分配：${describe(lg)}，高於最適配置的 ${fmtL(loss(opt[0], opt[1]))}。`,
        };
      const a = pinLg[PIN.a]!;
      const b = pinLg[PIN.b]!;
      if (i === PIN.a) return { title: 'A：運算最適模型（示意）', body: `${describe(a)}。` };
      const k = 10 ** (a[0] - b[0]);
      const m = 10 ** (lgCompute(b[0], b[1]) - lgCompute(a[0], a[1]));
      return {
        title: 'B：小模型、多訓練（示意）',
        body: `${describe(b)}。損失與 A 相同，但參數只有 A 的約 1/${k.toFixed(1)}，每個 Token 的推論運算也少約 ${k.toFixed(1)} 倍；代價是訓練運算約為 A 的 ${m.toFixed(1)} 倍。`,
      };
    };

    const lastHit = new Map<string, PickHit>();
    const register = (
      id: string,
      spec: HotspotSpec & { anchor: Vector3 | [number, number, number] },
      dynamic?: (hit: PickHit | null) => CardContent | null,
    ) => {
      hotspots.register(id, {
        ...spec,
        card: (hit) => {
          if (hit) lastHit.set(id, hit);
          return dynamic?.(hit) ?? null;
        },
        onSelect: (source) => {
          // A pointer click opens an interactive card (with the glossary link) instead of leaving the page.
          if (source !== 'pointer') return false;
          const hit = lastHit.get(id) ?? null;
          const c = dynamic?.(hit) ?? baseCard(id);
          ctx.card.show(c, hit?.point ?? spec.anchor, { interactive: true });
          ctx.announce(`已選取：${c.title}${c.body ? `。${c.body}` : ''}`);
          return true;
        },
      });
    };
    const surfaceCard = (hit: PickHit | null): CardContent | null => {
      if (!hit || (hit.object !== surface && hit.object !== ghost)) return null;
      const n = Math.min(LG_N[1], Math.max(LG_N[0], lgNofX(hit.point.x)));
      const d = Math.min(LG_D[1], Math.max(LG_D[0], lgDofZ(hit.point.z)));
      return { ...baseCard('loss-surface'), title: '損失曲面上的一點（示意）', body: `${describe([n, d])}。` };
    };
    const hl = new Map<string, { cancel(): void }>();
    const tween1 = (key: string, fn: (k: number) => void, on: boolean) => {
      hl.get(key)?.cancel();
      hl.set(key, ctx.tween.run((k) => fn(on ? k : 1 - k), { duration: 220, ease: 'cubicOut', fade: true }));
    };
    const reveal = (key: VisKey, on: boolean) => {
      hot[key] = on ? 1 : 0;
      applyVis();
    };

    register(
      'loss-surface',
      {
        object: surface,
        anchor: [wx(9.2), height(9.2, 10.2) + 0.2, wz(10.2)],
        pose: { position: [5.2, 5.6, 8.4], target: [0, 0.8, 0] },
        onHighlight: (on) => tween1('surface', (k) => surfMat.emissive.copy(ctx.palette.highlight).multiplyScalar(k * (dark() ? 0.16 : 0.08)), on),
      },
      surfaceCard,
    );
    const nProxy = new Mesh(ctx.track(new BoxGeometry(PLINTH * 2, 0.12, 1.2)), ctx.track(new MeshBasicMaterial({ visible: false })));
    nProxy.position.set(0, 0, PLINTH + 0.5);
    const dProxy = new Mesh(ctx.track(new BoxGeometry(1.2, 0.12, PLINTH * 2)), nProxy.material);
    dProxy.position.set(PLINTH + 0.5, 0, 0);
    root.add(nProxy, dProxy);
    const axisHot = (on: boolean) => tween1('axis', (k) => axisLines.material.color.copy(materials.color('muted')).lerp(ctx.palette.highlight, k), on);
    register('param-axis', { object: nProxy, anchor: [0, 0.1, PLINTH + 0.3], pose: { position: [1.6, 3.6, 10.6], target: [0, 0.3, 2.4] }, onHighlight: axisHot });
    register('token-axis', { object: dProxy, anchor: [PLINTH + 0.3, 0.1, 0], pose: { position: [10.2, 3.8, 2.6], target: [2.4, 0.3, 0.3] }, onHighlight: axisHot });
    register('irreducible-loss', {
      object: plinth,
      anchor: [-PLINTH + 0.5, 0, PLINTH - 0.3],
      pose: { position: [5.8, 1.9, 9.2], target: [0, 0.3, 0.8] },
      onHighlight: (on) =>
        tween1(
          'rim',
          (k) => {
            rimMat.opacity = 0.22 + 0.6 * k;
            rimMat.color.copy(materials.color('fg')).lerp(ctx.palette.highlight, k);
          },
          on,
        ),
    });
    register(
      'iso-compute',
      {
        object: cutMesh,
        anchor: isoAnchor,
        pose: STEP_POSES[2]!,
        onHighlight: (on) => reveal('cut', on),
      },
      () => {
        const o = optimum(budget);
        return {
          ...baseCard('iso-compute'),
          title: `固定預算 C ≈ ${sci(budget).text} FLOP（示意）`,
          body: `沿這條等運算量線，N 與 D 此消彼長（C ≈ 6ND）。損失最低的配置：${describe([o.lgN, o.lgD])}。`,
        };
      },
    );
    ctx.picker.add(iso.mesh, { id: 'iso-compute' });
    register('optimal-ridge', { object: ridgeProxy, anchor: ridgePts[30]!, pose: STEP_POSES[3]!, onHighlight: (on) => reveal('ridge', on) });
    register(
      'model-markers',
      {
        object: heads,
        anchor: pinAnchor,
        pose: STEP_POSES[1]!,
        onHighlight: (on) => {
          const visible = [...pinScale].some((s) => s > 0.5);
          if (!visible || hot.size) reveal('size', on);
          tween1(
            'pins',
            (k) => {
              pinHot = k;
              drawPins();
            },
            on,
          );
        },
      },
      (hit) => (hit && hit.object === heads && hit.instanceId !== undefined ? pinCard(hit.instanceId) : null),
    );
    register('test-time', {
      anchor: pinTop(PIN.b),
      pose: STEP_POSES[4]!,
      onHighlight: (on) => {
        hot.isoLoss = on ? 1 : 0;
        reveal('panel', on);
      },
    });

    /* ───────── steps ───────── */
    const goPose = (i: number) => {
      // Explicit fov: after a portrait → landscape switch the camera may still carry the portrait fov.
      if (portrait) ctx.tween.camera((i === 4 && noteLayout(ctx.size, true) === 'row' ? PORTRAIT_ROW_4 : PORTRAIT_POSES[i]) ?? ctx.homePose);
      else ctx.setPose({ ...((small ? SMALL_POSES[i] : null) ?? (narrow ? NARROW_POSES[i] : null) ?? STEP_POSES[i] ?? ctx.homePose), fov: FOV });
    };
    const showStep = (i: number) => {
      goVis({ ...(STEP_VIS[i] ?? STEP_VIS[0]!) }, i === 2 || i === 3 ? 1100 : 750);
      showLabels(i);
      budgetUi.show(i === 2 || i === 3);
      goPose(i);
    };

    return {
      update(_dt, t) {
        if (flow.object.visible) flow.update(t);
      },
      setStep(i) {
        showStep(i);
      },
      onMotion(animate) {
        flow.setReduced(!animate);
      },
      onQuality(_q, tier) {
        flow.setCount(scaleCount(FLOW_MAX, tier, 40));
      },
      onPalette(p) {
        applyPalette(p);
        applyVis();
      },
      onResize(size) {
        const prevNote = noteLayout(lastSize, portrait);
        const nextNote = noteLayout(size, size.portrait);
        lastSize = { width: size.width, height: size.height };
        const nextSmall = size.width < SMALL;
        const nextNarrow = size.width < NARROW;
        const poseFlip = nextNarrow !== narrow || nextSmall !== small;
        if (size.width >= ROOMY !== roomy) {
          roomy = size.width >= ROOMY;
          showLabels(ctx.step);
        }
        if (size.portrait !== portrait || nextSmall !== small || nextNarrow !== narrow || nextNote !== prevNote) {
          const flipped = size.portrait !== portrait;
          portrait = size.portrait;
          small = nextSmall;
          narrow = nextNarrow;
          layout();
          showLabels(ctx.step);
          applyCut();
          // Re-frame on an orientation flip, when a landscape stage crosses NARROW / SMALL (their own
          // poses), or when step 4's note card changes shape on a portrait stage.
          if (flipped || (!portrait && poseFlip && (NARROW_POSES[ctx.step] || SMALL_POSES[ctx.step])) || (portrait && ctx.step === 4 && nextNote !== prevNote)) goPose(ctx.step);
        } else if (nextNote === 'mini') note.setLayout(nextNote, portrait, size.height); // the mini sketch follows the stage height
      },
      dispose() {
        visTween?.cancel();
        hl.forEach((t) => t.cancel());
        budgetUi.dispose();
        note.dispose();
        ctx.renderer.localClippingEnabled = prevClipping;
        root.removeFromParent();
      },
    };
  },
});

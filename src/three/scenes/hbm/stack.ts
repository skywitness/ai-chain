/**
 * hbm / variant "hbm" — an AI package diorama (heights exaggerated, 示意): package substrate → C4
 * bumps → silicon interposer → GPU die + four HBM stacks, two on each long side.
 *
 * The front-right stack is the "featured" one. It is built from instanced half-dies (split at
 * z = 0, its TSV row) so it can:
 *   step 1 晶粒堆疊  explode into base die + 12 (or 16) DRAM core dies;
 *   step 2 矽穿孔    open a cross-section: copper TSV columns, micro-bumps, data flowing up and
 *                    down the TSVs, along the base die to its PHY and across the interposer;
 *   step 3 接合填充  replay TC-NCF (film per die, bonded one by one) and MR-MUF (stack, one reflow,
 *                    then molded underfill), alternating;
 *   step 4 介面加寬  zoom onto the interposer lanes: 16 channels (HBM3E, 1,024 bits) split into
 *                    32 (HBM4, 2,048 bits); the base die switches to a foundry logic process.
 * A small in-stage control switches generation (HBM3E / HBM4) and stack height (12 / 16 layers).
 * Reduced motion: flows become static dotted streams; step 3 shows the finished bonded stack and
 * step 4 the HBM4 state.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Object3D as Obj3D,
  Vector3,
  type Raycaster,
  type Intersection,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type {
  CameraPose,
  CardContent,
  HotspotSource,
  LabelHandle,
  LabelSpec,
  Palette,
  SceneCameraSpec,
  SceneContext,
  SceneInstance,
} from '../../core/types';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  TSV_PER_GROUP,
  TSV_X,
  buildFloorGrid,
  createLegend,
  createTogglePanel,
  dieGeometry,
  easeOut,
  fadeToBg,
  lerp,
  paintBase,
  paintDram,
  paintGpu,
  siliconColor,
  smoothstep,
} from './shared';
import { crossLink, gotoStep, HIERARCHY_IDS, HOTSPOT_TEXT, LINKS, resumeFocus, STACK_PART_STEP } from './links';

/* ───────────────────────── dimensions (world units, heights exaggerated) ───────────────────────── */

const W = 1.6; // HBM die footprint (x)
const D = 1.75; // (z)
const H = 0.9; // assembled stack height = GPU die height (stacks sit flush with the GPU)
const Y0 = 0.022; // micro-bumps under the base die
const TB = 0.08; // base die thickness
const TOP_X = 0.03; // the top core die is left thicker
const EXPLODE = 2.0; // extra stack height at explode = 1
const NMAX = 16;
const GPU_W = 2.9;
const GPU_D = 3.7;
const SX = 2.85; // |x| of the HBM stacks (gap to the GPU exaggerated for legibility)
const SZ = 0.98; // |z|
const IP = { w: 8.1, d: 4.4, t: 0.12 }; // interposer (top at y = 0)
const C4H = 0.045;
const SUB = { w: 9.9, d: 6.0, t: 0.3 };
const SUB_TOP = -IP.t - C4H;
const FLOOR_Y = SUB_TOP - SUB.t - 0.02;
/** Featured first: front-right; then the three context stacks. */
const STACKS: readonly (readonly [number, number])[] = [
  [SX, SZ],
  [SX, -SZ],
  [-SX, SZ],
  [-SX, -SZ],
];
const MOLD_EPS = 0.004;
const CUT_EPS = 0.004; // gap between the mold halves and the cut plane
const TSV_R = 0.0085; // copper TSV (thinner than the micro-bump it lands on)
const BUMP_R = 0.0125;
const FLOW_LIFT = 0.03; // particles float clear of the surface they follow (no clipped discs)
const PHY_BUMPS = 8;
const LANES = 32;
const GAP_X0 = GPU_W / 2; // GPU edge (x > 0 side)
const GAP_X1 = SX - W / 2; // stack inner edge

const dimsFor = (count: number) => {
  const g = count > 12 ? 0.018 : 0.022;
  const t = (H - Y0 - TB - count * g - TOP_X) / count;
  return { g, t };
};

/* ───────────────────────── steps ───────────────────────── */

interface View {
  explode: number;
  gap: number;
  ghost: number;
  mold: number;
  fill: number;
  dim: number;
  dimGpu: number;
  tsv: number;
  lanes: number;
}
const VIEWS: readonly View[] = [
  { explode: 0, gap: 1, ghost: 0, mold: 1, fill: 1, dim: 0, dimGpu: 0, tsv: 0, lanes: 1 },
  { explode: 1, gap: 1, ghost: 0, mold: 0, fill: 0, dim: 1, dimGpu: 0.85, tsv: 0, lanes: 0.3 },
  { explode: 0, gap: 1.8, ghost: 1, mold: 0, fill: 0, dim: 1, dimGpu: 0.75, tsv: 1, lanes: 0.25 },
  { explode: 0, gap: 1.8, ghost: 1, mold: 1, fill: 1, dim: 1, dimGpu: 0.85, tsv: 0, lanes: 0.2 },
  { explode: 0, gap: 1, ghost: 0, mold: 1, fill: 1, dim: 0.35, dimGpu: 0, tsv: 0, lanes: 1 },
];
const TSV_VIEW = VIEWS[2]!;

export const STACK_CAMERA: SceneCameraSpec = {
  position: [6.2, 6.3, 9.6],
  target: [0.3, -0.1, 0.25],
  fov: 34,
  minDistance: 1.6,
  maxDistance: 22,
  minPolar: 0.12,
  maxPolar: 1.5,
  portrait: { position: [9.1, 10.3, 3.6], target: [0.3, -0.1, 0.3], fov: 36 },
};

const STEP_POSES: readonly (CameraPose | null)[] = [
  null,
  { position: [6.8, 3.6, 6.4], target: [2.7, 1.3, 0.9] },
  { position: [3.95, 1.5, 4.75], target: [2.5, 0.62, 0.98] },
  { position: [4.2, 2.05, 5.1], target: [2.7, 0.78, 0.98] },
  // In front of the GPU ↔ HBM gap, looking along it: the channel lanes read as the rungs of a
  // ladder between the GPU PHY (left) and the stack's base die (right). Framed so the front end of
  // the ladder (and its 「HBM4：2,048 位元」 label) sits clear of the bottom-left legend.
  { position: [2.0, 4.0, 5.7], target: [1.95, 0.2, 0.7] },
];
/**
 * Portrait stages (4:5) see a much narrower slice (null = landscape pose). The subject is pulled
 * back and pushed off-centre so the short side labels (compact texts) still fit beside it.
 */
const PORTRAIT_POSES: readonly (CameraPose | null)[] = [
  null,
  { position: [7.2, 3.9, 7.4], target: [2.35, 1.3, 0.9] },
  { position: [3.75, 1.5, 5.3], target: [2.62, 0.6, 0.98] },
  { position: [4.3, 2.15, 5.85], target: [2.95, 0.74, 0.98] },
  { position: [1.95, 6.0, 3.6], target: [1.8, 0.1, 0.5] },
];
/** Narrow stages (phones, portrait or 4:3) get short 3D label texts; the cards carry the rest. */
const isCompact = (s: { width: number; portrait: boolean }): boolean => s.portrait || s.width < 560;

/** Camera poses for list focus on context parts (featured parts use their step's pose). */
const PART_POSES: Record<string, CameraPose> = {
  gpu: { position: [1.4, 3.9, 6.0], target: [0.2, 0.4, 0.2] },
  interposer: { position: [-2.2, 2.6, 6.6], target: [-1.4, -0.1, 1.2] },
};

type Gen = 'hbm3e' | 'hbm4';
const GEN_TEXT: Record<Gen, { short: string; width: string; base: string }> = {
  hbm3e: { short: 'HBM3E', width: 'HBM3E：1,024 位元（16 個通道）', base: '基底晶粒：DRAM 製程' },
  hbm4: { short: 'HBM4', width: 'HBM4：2,048 位元（32 個通道）', base: '基底晶粒：邏輯製程（晶圓代工）' },
};

/* ───────────────────────── scratch ───────────────────────── */

const m4 = new Matrix4();
const qI = new Quaternion();
const v3 = new Vector3();
const s3 = new Vector3();
const setM = (mesh: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
  mesh.setMatrixAt(i, m4.compose(v3.set(x, y, z), qI, s3.set(sx, sy, sz)));
const touch = (...meshes: InstancedMesh[]) => {
  for (const m of meshes) {
    m.instanceMatrix.needsUpdate = true;
    m.boundingSphere = null;
  }
};

/** Make a mesh pickable only while `on()` is true (e.g. ghosted halves must not block picks). */
function gateRaycast(mesh: Mesh | InstancedMesh, on: () => boolean): void {
  const orig = mesh.raycast.bind(mesh);
  mesh.raycast = (r: Raycaster, hits: Intersection<Object3D>[]) => {
    if (on()) orig(r, hits);
  };
}

/* ───────────────────────── scene ───────────────────────── */

export function createStackScene(ctx: SceneContext): SceneInstance {
  const { scene, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'hbm-package';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);

  let gen: Gen = 'hbm3e';
  let n = 12;
  let step = 0;
  const cur: View = { ...VIEWS[0]! };
  let laneT = 0; // 0 = 16 channels (HBM3E), 1 = 32 channels (HBM4)
  let tsvVis = 0;
  let compact = isCompact(ctx.size);
  const hot: Record<string, number> = {};

  /* ───────── floor ───────── */
  const grid = buildFloorGrid(9, 0.6);
  const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const gridLines = new LineSegments(ctx.track(grid.geometry), gridMat);
  gridLines.position.y = FLOOR_Y;
  root.add(gridLines);
  const shadowMat = ctx.track(
    new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }),
  );
  const shadow = new Mesh(ctx.track(new PlaneGeometry(14, 10)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = FLOOR_Y + 0.005;
  root.add(shadow);

  /* ───────── package: substrate, C4 bumps, passives, interposer ───────── */
  const subMat = ctx.track(new MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }));
  const substrate = new Mesh(ctx.track(new RoundedBoxGeometry(SUB.w, SUB.t, SUB.d, 2, 0.06)), subMat);
  substrate.position.y = SUB_TOP - SUB.t / 2;
  root.add(substrate);

  const c4Pos: [number, number][] = [];
  for (const inset of [0.1, 0.24]) {
    const hw = IP.w / 2 - inset;
    const hd = IP.d / 2 - inset;
    for (let x = -hw; x <= hw + 1e-6; x += 0.17) c4Pos.push([x, hd], [x, -hd]);
    for (let z = -hd + 0.17; z < hd - 1e-6; z += 0.17) c4Pos.push([hw, z], [-hw, z]);
  }
  const c4Mat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }));
  const c4 = new InstancedMesh(ctx.track(new IcosahedronGeometry(0.034, 0)), c4Mat, c4Pos.length);
  c4Pos.forEach(([x, z], i) => setM(c4, i, x, SUB_TOP + C4H / 2, z, 1, 0.7, 1));
  root.add(c4);
  ctx.track({ dispose: () => c4.dispose() });

  // Decoupling capacitors on the substrate around the interposer (decor).
  const capPos: [number, number, boolean][] = [];
  for (let x = -3.6; x <= 3.6 + 1e-6; x += 0.4) capPos.push([x, IP.d / 2 + 0.42, false], [x, -IP.d / 2 - 0.42, false]);
  for (let z = -1.6; z <= 1.6 + 1e-6; z += 0.4) capPos.push([IP.w / 2 + 0.38, z, true], [-IP.w / 2 - 0.38, z, true]);
  const capMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35 }));
  const caps = new InstancedMesh(ctx.track(new BoxGeometry(0.18, 0.07, 0.1)), capMat, capPos.length);
  const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  capPos.forEach(([x, z, rot], i) => caps.setMatrixAt(i, m4.compose(v3.set(x, SUB_TOP + 0.035, z), rot ? qy : qI, s3.set(1, 1, 1))));
  root.add(caps);
  ctx.track({ dispose: () => caps.dispose() });

  const ipMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.12 }));
  const interposer = new Mesh(ctx.track(new BoxGeometry(IP.w, IP.t, IP.d)), ipMat);
  interposer.position.y = -IP.t / 2;
  root.add(interposer);

  /* ───────── interface lanes (one strip = one 64-bit channel, 示意) ───────── */
  const laneMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.25 }));
  const lanes = new InstancedMesh(ctx.track(new BoxGeometry(1, 0.004, 1)), laneMat, STACKS.length * LANES);
  root.add(lanes);
  ctx.track({ dispose: () => lanes.dispose() });
  const zLane16 = (j: number) => -D * 0.46 + (Math.floor(j / 2) + 0.5) * ((D * 0.92) / 16);
  const zLane32 = (j: number) => -D * 0.46 + (j + 0.5) * ((D * 0.92) / 32);
  const laneX = (sx: number) => {
    const sgn = Math.sign(sx);
    const a = sgn * (GAP_X0 - 0.22);
    const b = sx - sgn * (W / 2 - 0.3);
    return { mid: (a + b) / 2, len: Math.abs(b - a), a, b };
  };
  const layoutLanes = () => {
    STACKS.forEach(([sx, sz], s) => {
      const { mid, len } = laneX(sx);
      for (let j = 0; j < LANES; j++) {
        const z = sz + lerp(zLane16(j), zLane32(j), laneT);
        const w = j % 2 === 0 ? 0.022 : 0.022 * laneT;
        setM(lanes, s * LANES + j, mid, 0.002, z, len, 1, Math.max(w, 1e-4));
      }
    });
    touch(lanes);
  };

  // Invisible proxies over each gap: hover target for the 「介面」 hotspot.
  const proxyMat = ctx.track(new MeshBasicMaterial({ visible: false }));
  const proxies = new Group();
  for (const [sx, sz] of STACKS) {
    const p = new Mesh(ctx.track(new BoxGeometry(GAP_X1 - GAP_X0, 0.06, D)), proxyMat);
    p.position.set(Math.sign(sx) * (GAP_X0 + GAP_X1) / 2, 0.03, sz);
    proxies.add(p);
  }
  root.add(proxies);

  /* ───────── GPU die ───────── */
  const gpuTex = ctx.track(canvasTexture(512, 640, () => {}));
  const gpuMat = ctx.track(new MeshStandardMaterial({ map: gpuTex, roughness: 0.42, metalness: 0.25 }));
  const gpu = new Mesh(ctx.track(dieGeometry(GPU_W, H - Y0, GPU_D)), gpuMat);
  gpu.position.y = (Y0 + H) / 2;
  root.add(gpu);

  /* ───────── HBM materials & textures ───────── */
  const dramTex = ctx.track(canvasTexture(512, 512, () => {}));
  const baseTex = ctx.track(canvasTexture(512, 512, () => {}));
  const dieParams = { roughness: 0.5, metalness: 0.2 };
  const dramMat = ctx.track(new MeshStandardMaterial({ map: dramTex, ...dieParams }));
  const dramFrontMat = ctx.track(new MeshStandardMaterial({ map: dramTex, ...dieParams }));
  const baseMat = ctx.track(new MeshStandardMaterial({ map: baseTex, ...dieParams }));
  const baseFrontMat = ctx.track(new MeshStandardMaterial({ map: baseTex, ...dieParams }));
  const ctxMat = ctx.track(new MeshStandardMaterial({ map: dramTex, ...dieParams }));
  const fillMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }));
  const fillFrontMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }));
  const tsvMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }));
  const bumpMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.25 }));
  const moldParams = { transparent: true, depthWrite: false, roughness: 0.25, metalness: 0.05 };
  const moldMat = ctx.track(new MeshStandardMaterial(moldParams));
  const moldFrontMat = ctx.track(new MeshStandardMaterial(moldParams));
  const ctxMoldMat = ctx.track(new MeshStandardMaterial(moldParams));
  const headMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }));

  /* ───────── featured stack (instanced half-dies) ───────── */
  const feat = new Group();
  feat.position.set(SX, 0, SZ);
  root.add(feat);
  const backGeo = ctx.track(dieGeometry(W, 1, D, 'back'));
  const frontGeo = ctx.track(dieGeometry(W, 1, D, 'front'));
  const inst = (geo: BoxGeometry | CylinderGeometry, mat: MeshStandardMaterial, count: number) => {
    const m = new InstancedMesh(geo, mat, count);
    m.frustumCulled = false;
    feat.add(m);
    ctx.track({ dispose: () => m.dispose() });
    return m;
  };
  const dramBack = inst(backGeo, dramMat, NMAX);
  const dramFront = inst(frontGeo, dramFrontMat, NMAX);
  const fillBack = inst(backGeo, fillMat, NMAX);
  const fillFront = inst(frontGeo, fillFrontMat, NMAX);
  const tsvGeo = ctx.track(new CylinderGeometry(TSV_R, TSV_R, 1, 8, 1, true));
  const tsv = inst(tsvGeo, tsvMat, NMAX * TSV_X.length);
  const bumpGeo = ctx.track(new CylinderGeometry(BUMP_R, BUMP_R, 1, 10, 1));
  const bumps = inst(bumpGeo, bumpMat, NMAX * TSV_X.length + TSV_X.length + PHY_BUMPS);
  const baseBack = new Mesh(ctx.track(dieGeometry(W, TB, D, 'back')), baseMat);
  const baseFront = new Mesh(ctx.track(dieGeometry(W, TB, D, 'front')), baseFrontMat);
  baseBack.position.y = baseFront.position.y = Y0 + TB / 2;
  feat.add(baseBack, baseFront);
  const moldM = 0.045;
  // The mold halves stop just short of the cut plane (z = 0) so their translucent faces never
  // z-fight with the dies' cut faces in the cross-section steps.
  const moldHalfD = D / 2 + moldM - CUT_EPS;
  const moldBack = new Mesh(ctx.track(new BoxGeometry(W + 2 * moldM, 1, moldHalfD).translate(0, 0.5, -CUT_EPS - moldHalfD / 2)), moldMat);
  const moldFront = new Mesh(ctx.track(new BoxGeometry(W + 2 * moldM, 1, moldHalfD).translate(0, 0.5, CUT_EPS + moldHalfD / 2)), moldFrontMat);
  moldBack.renderOrder = moldFront.renderOrder = 6;
  feat.add(moldBack, moldFront);
  // Thermocompression bond head, cut away like the stack (back half only) so the cross-section of
  // the dies being bonded stays visible under it: a tool plate plus the head body above it.
  const headParts = [
    new BoxGeometry(W * 0.94, 0.1, D * 0.47).translate(0, -0.03, -D * 0.235),
    new BoxGeometry(W * 0.3, 0.3, D * 0.2).translate(0, 0.17, -D * 0.1),
  ];
  const headGeo = mergeGeometries(headParts);
  headParts.forEach((g) => g.dispose());
  const head = new Mesh(ctx.track(headGeo ?? new BoxGeometry(W * 0.94, 0.1, D * 0.47)), headMat);
  head.visible = false;
  feat.add(head);

  /* ───────── context stacks (always assembled) ───────── */
  const ctxPer = 1 + 2 * NMAX;
  const ctxLayers = new InstancedMesh(ctx.track(dieGeometry(W, 1, D)), ctxMat, (STACKS.length - 1) * ctxPer);
  ctxLayers.setColorAt(0, new Color());
  root.add(ctxLayers);
  ctx.track({ dispose: () => ctxLayers.dispose() });
  const ctxMold = new InstancedMesh(ctx.track(new BoxGeometry(W + 2 * moldM, 1, D + 2 * moldM).translate(0, 0.5, 0)), ctxMoldMat, STACKS.length - 1);
  ctxMold.renderOrder = 6;
  root.add(ctxMold);
  ctx.track({ dispose: () => ctxMold.dispose() });

  /* ───────── glows ───────── */
  const glows = ctx.track(new GlowSprites({ count: 3, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── step-3 bonding animation state ───────── */
  const anim = {
    present: new Float32Array(NMAX + 1).fill(1),
    drop: new Float32Array(NMAX + 1),
    fill: new Float32Array(NMAX + 1).fill(1),
    squeeze: new Float32Array(NMAX + 1).fill(1),
    film: false,
    reflow: 0,
    mold: 1,
    headOn: false,
    headY: 0,
    headHeat: 0,
    phase: '',
    active: false,
  };
  const resetAnim = (fillAll: number, moldK: number) => {
    anim.present.fill(1);
    anim.drop.fill(0);
    anim.fill.fill(fillAll);
    anim.squeeze.fill(1);
    anim.film = false;
    anim.reflow = 0;
    anim.mold = moldK;
    anim.headOn = false;
    anim.headHeat = 0;
  };
  let bondT = 0;

  /* ───────── layout ───────── */
  let stackTop = H;
  const dieBottom = (i: number, gap: number, G: number, t: number) => Y0 + TB + i * (gap + G) + (i - 1) * t;

  const layoutFeatured = () => {
    const { g, t } = dimsFor(n);
    const gap = g * cur.gap;
    const G = (EXPLODE / n) * cur.explode;
    let ti = 0;
    let bi = 0;
    for (const x of TSV_X) setM(tsv, ti++, x, Y0 + TB / 2, 0, 1, TB, 1);
    for (const x of TSV_X) setM(bumps, bi++, x, Y0 / 2, 0, 1, Y0, 1);
    for (let k = 0; k < PHY_BUMPS; k++) setM(bumps, bi++, -W / 2 + 0.07 + k * 0.042, Y0 / 2, 0, 1, Y0, 1);
    let dies = 0;
    let top = Y0 + TB;
    for (let i = 1; i <= n; i++) {
      if (!(anim.present[i]! > 0.5)) break;
      const th = i === n ? t + TOP_X : t;
      const bottom = dieBottom(i, gap, G, t) + anim.drop[i]!;
      const cy = bottom + th / 2;
      setM(dramBack, i - 1, 0, cy, 0, 1, th, 1);
      setM(dramFront, i - 1, 0, cy, 0, 1, th, 1);
      const fk = anim.fill[i]! * cur.fill;
      if (fk > 0.002) {
        const sq = anim.film ? 1 + 0.035 * anim.squeeze[i]! : 1;
        const sx = anim.film ? sq : fk;
        const x = anim.film ? 0 : (W / 2) * (1 - fk);
        setM(fillBack, i - 1, x, bottom - gap / 2, 0, sx, gap * (anim.film ? 0.98 : 1), sq);
        setM(fillFront, i - 1, x, bottom - gap / 2, 0, sx, gap * (anim.film ? 0.98 : 1), sq);
      } else {
        setM(fillBack, i - 1, 0, bottom, 0, 1e-4, 1e-4, 1e-4);
        setM(fillFront, i - 1, 0, bottom, 0, 1e-4, 1e-4, 1e-4);
      }
      for (const x of TSV_X) setM(bumps, bi++, x, bottom - gap / 2, 0, 1, gap, 1);
      if (i < n) for (const x of TSV_X) setM(tsv, ti++, x, cy, 0, 1, th, 1);
      dies = i;
      if (anim.drop[i]! < 1e-4) top = Math.max(top, bottom + th);
    }
    dramBack.count = dramFront.count = fillBack.count = fillFront.count = dies;
    tsv.count = ti;
    bumps.count = bi;
    touch(dramBack, dramFront, fillBack, fillFront, tsv, bumps);
    stackTop = top;
    // The mold's top face sits just inside the top die (the die's back side stays exposed, as on
    // a real ground stack) — coplanar faces would z-fight.
    moldBack.scale.y = moldFront.scale.y = top - MOLD_EPS;
    head.visible = anim.headOn;
    head.position.y = anim.headY;
  };

  const layoutContext = () => {
    const { g, t } = dimsFor(n);
    let k = 0;
    const cDie = new Color(1, 1, 1);
    const cBase = new Color();
    const cFill = new Color();
    const p = ctx.palette;
    baseTint(p, cBase);
    mufColor(p, cFill).multiplyScalar(1.4);
    STACKS.slice(1).forEach(([sx, sz], s) => {
      k = s * (1 + 2 * n);
      setM(ctxLayers, k, sx, Y0 + TB / 2, sz, 1, TB, 1);
      ctxLayers.setColorAt(k++, cBase);
      for (let i = 1; i <= n; i++) {
        const th = i === n ? t + TOP_X : t;
        const bottom = dieBottom(i, g, 0, t);
        setM(ctxLayers, k, sx, bottom + th / 2, sz, 1, th, 1);
        ctxLayers.setColorAt(k++, cDie);
        setM(ctxLayers, k, sx, bottom - g / 2, sz, 1.002, g, 1.002);
        ctxLayers.setColorAt(k++, cFill);
      }
      setM(ctxMold, s, sx, 0, sz, 1, H - MOLD_EPS, 1);
    });
    ctxLayers.count = (STACKS.length - 1) * (1 + 2 * n);
    if (ctxLayers.instanceColor) ctxLayers.instanceColor.needsUpdate = true;
    touch(ctxLayers, ctxMold);
  };

  /* ───────── colours ───────── */
  const tmp2 = new Color();
  const cHL = new Color();
  const cTint = new Color();
  const cFillC = new Color();
  const cSi = new Color();
  const mufColor = (p: Palette, out: Color) =>
    out.copy(p.seg['memory-storage']).lerp(p.bg, p.theme === 'dark' ? 0.55 : 0.35).lerp(p.fg, 0.08);
  const baseTint = (p: Palette, out: Color) =>
    gen === 'hbm4' ? out.setRGB(1, 1, 1).lerp(p.seg['foundry-packaging'], p.theme === 'dark' ? 0.32 : 0.22) : out.setRGB(1, 1, 1);

  const applyColors = () => {
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    const hl = (id: string, k = 0.3) => cHL.copy(p.highlight).multiplyScalar((hot[id] ?? 0) * (dark ? k : k * 0.6));
    const si = siliconColor(p, cSi); // scratch: this runs every frame during the step-3 replay

    fadeToBg(subMat, tmp2.copy(p.muted).lerp(p.bg, dark ? 0.6 : 0.35).lerp(p.seg['cloud-neocloud'], dark ? 0.1 : 0.2), p, cur.dim * 0.7);
    fadeToBg(ipMat, tmp2.copy(si).lerp(p.bg, dark ? 0.25 : 0.1), p, cur.dim * 0.55, hl('interposer'));
    fadeToBg(c4Mat, tmp2.copy(p.fg).lerp(p.bg, 0.45), p, cur.dim * 0.7);
    fadeToBg(capMat, tmp2.copy(p.muted).lerp(p.power, 0.25), p, cur.dim * 0.7);
    fadeToBg(laneMat, tmp2.copy(p.power).lerp(p.fg, dark ? 0.1 : 0.05), p, 1 - (0.25 + 0.75 * cur.lanes), hl('interface', 0.6));
    fadeToBg(gpuMat, tmp2.setRGB(1, 1, 1), p, cur.dimGpu * 0.8, hl('gpu'));
    fadeToBg(ctxMat, tmp2.setRGB(1, 1, 1), p, cur.dim * 0.8, hl('hbm-stack', 0.25));
    // Faded context parts go matte so the key light's specular cannot outshine the subject.
    gpuMat.roughness = 0.42 + 0.5 * cur.dimGpu;
    gpuMat.metalness = 0.25 * (1 - cur.dimGpu);
    ctxMat.roughness = 0.5 + 0.4 * cur.dim;
    ipMat.roughness = 0.6 + 0.3 * cur.dim;
    const moldC = tmp2.copy(p.seg['memory-storage']).lerp(p.fg, dark ? 0.05 : 0);
    for (const m of [moldMat, moldFrontMat, ctxMoldMat]) {
      m.color.copy(moldC);
      m.emissive.copy(p.seg['memory-storage']).multiplyScalar((dark ? 0.12 : 0.02) + (hot['hbm-stack'] ?? 0) * 0.25);
    }
    const moldA = dark ? 0.3 : 0.26;
    ctxMoldMat.opacity = moldA * (1 - 0.65 * cur.dim);
    const mk = cur.mold * anim.mold;
    moldMat.opacity = moldA * mk;
    moldFrontMat.opacity = moldA * mk * (1 - 0.85 * cur.ghost);
    moldBack.visible = moldMat.opacity > 0.01;
    moldFront.visible = moldFrontMat.opacity > 0.01;

    for (const m of [dramMat, dramFrontMat]) {
      m.color.setRGB(1, 1, 1);
      m.emissive.copy(hl('dram-die'));
    }
    const bt = baseTint(p, cTint);
    for (const m of [baseMat, baseFrontMat]) {
      m.color.copy(bt);
      m.emissive.copy(hl('base-die'));
    }
    // Light theme: the ghosted front halves stack up a dozen translucent layers; keep them fainter.
    const ghostA = 1 - (dark ? 0.95 : 0.975) * cur.ghost;
    const see = cur.ghost > 0.001;
    for (const m of [dramFrontMat, baseFrontMat, fillFrontMat]) {
      // `transparent` is part of the program key (OPAQUE define): recompile when it flips.
      if (m.transparent !== see) {
        m.transparent = see;
        m.needsUpdate = true;
      }
      m.opacity = ghostA;
      m.depthWrite = cur.ghost < 0.5;
    }
    const fc = anim.film ? cFillC.copy(p.coolant).lerp(p.bg, dark ? 0.25 : 0.1) : mufColor(p, cFillC);
    for (const m of [fillMat, fillFrontMat]) {
      m.color.copy(fc);
      m.emissive.copy(hl('fill', 0.4));
    }
    // Copper TSVs stay copper (a soft self-glow in the cross-section); solder bumps are silver-grey.
    tsvMat.color.copy(p.power).lerp(p.heat, 0.18);
    tsvMat.emissive
      .copy(p.power)
      .multiplyScalar(cur.tsv * tsvVis * (dark ? 0.22 : 0.06))
      .add(hl('tsv', 0.8));
    // Solder micro-bumps: bright tin-silver, clearly lighter than the grey silicon cut faces.
    bumpMat.color.copy(p.fg).lerp(p.bg, dark ? 0.12 : 0.86);
    bumpMat.emissive
      .copy(p.heat)
      .multiplyScalar(anim.reflow * (dark ? 0.9 : 0.6))
      .add(hl('micro-bump', 0.8));
    headMat.color.copy(p.fg).lerp(p.bg, dark ? 0.45 : 0.55);
    headMat.emissive.copy(p.heat).multiplyScalar(anim.headHeat * (dark ? 0.45 : 0.3));
  };

  /* ───────── flows ───────── */
  interface FlowSet {
    flow: PathFlow;
    max: number;
  }
  const flows: FlowSet[] = [];
  const makeFlow = (paths: FlowPath[], max: number, size: number, speed: number, seed: number): FlowSet => {
    const flow = new PathFlow({ paths, count: max, size, speed, speedVariance: 0.2, sizeVariance: 0.25, fadeEnds: 0.18, theme: ctx.theme, seed, smooth: false });
    flow.setCount(scaleCount(max, ctx.tier, 24));
    flow.setReduced(!ctx.animate);
    const fs = { flow, max };
    flows.push(fs);
    return fs;
  };
  const dirColor = (read: boolean, p: Palette) => (read ? p.flow : p.optic);

  const lanePaths = (laneCount: 16 | 32): { paths: FlowPath[]; read: boolean[] } => {
    const paths: FlowPath[] = [];
    const read: boolean[] = [];
    STACKS.forEach(([sx, sz]) => {
      const { a, b } = laneX(sx);
      for (let j = 0; j < laneCount; j++) {
        const z = sz + (laneCount === 16 ? zLane16(j * 2) : zLane32(j));
        const r = j % 2 === 0;
        const from: [number, number, number] = [b, FLOW_LIFT, z];
        const to: [number, number, number] = [a, FLOW_LIFT, z];
        paths.push({ points: r ? [from, to] : [to, from], color: dirColor(r, ctx.palette) });
        read.push(r);
      }
    });
    return { paths, read };
  };
  const lanes16 = lanePaths(16);
  const lanes32 = lanePaths(32);
  const flowA = makeFlow(lanes16.paths, 420, 0.05, 0.45, 3);
  const flowB = makeFlow(lanes32.paths, 840, 0.05, 0.45, 5);
  root.add(flowA.flow.object, flowB.flow.object);

  // TSV + PHY flows live in the featured stack's frame; rebuilt when the layer count changes.
  let tsvFlow: FlowSet | null = null;
  let phyFlow: FlowSet | null = null;
  let tsvRead: boolean[] = [];
  let phyRead: boolean[] = [];
  const buildTsvFlows = () => {
    for (const fs of [tsvFlow, phyFlow]) {
      if (!fs) continue;
      fs.flow.dispose();
      flows.splice(flows.indexOf(fs), 1);
    }
    const { g, t } = dimsFor(n);
    const gap = g * TSV_VIEW.gap;
    const yMid = (i: number) => (i === 0 ? Y0 + TB / 2 : dieBottom(i, gap, 0, t) + t / 2);
    const z = TSV_R + FLOW_LIFT; // just in front of the TSV, on the cut face
    const paths: FlowPath[] = [];
    tsvRead = [];
    for (let gI = 0; gI < TSV_X.length / TSV_PER_GROUP; gI++) {
      const c = gI * TSV_PER_GROUP + 1; // the middle TSV of each group
      const x = TSV_X[c]!;
      const r = gI % 2 === 0;
      const k = n - ((c * 7) % Math.max(2, Math.floor(n / 2)));
      const a: [number, number, number] = [x, yMid(Math.min(n - 1, Math.max(1, k))), z];
      const b: [number, number, number] = [x, yMid(0), z];
      paths.push({ points: r ? [a, b] : [b, a], color: dirColor(r, ctx.palette) });
      tsvRead.push(r);
    }
    tsvFlow = makeFlow(paths, 128, 0.04, 0.3, 9);
    const phy: FlowPath[] = [];
    phyRead = [];
    const gx = GAP_X0 - SX - 0.18;
    [7, 10, 13, 16].forEach((c, i) => {
      const x = TSV_X[c]!;
      const r = i % 2 === 0;
      const pts: [number, number, number][] = [
        [x, yMid(0), z],
        [-W / 2 + 0.12, yMid(0), z],
        [-W / 2 + 0.1, FLOW_LIFT, z],
        [gx, FLOW_LIFT, z],
      ];
      phy.push({ points: r ? pts : pts.slice().reverse(), color: dirColor(r, ctx.palette) });
      phyRead.push(r);
    });
    phyFlow = makeFlow(phy, 64, 0.032, 0.36, 13);
    feat.add(tsvFlow.flow.object, phyFlow.flow.object);
    applyFlowLook();
  };

  const applyFlowLook = () => {
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    const base = dark ? 1 : 0.85;
    const laneVis = 0.25 + 0.75 * cur.lanes;
    flowA.flow.setOpacity(base * laneVis * (1 - laneT));
    flowB.flow.setOpacity(base * laneVis * laneT);
    flowA.flow.object.visible = laneT < 0.999;
    flowB.flow.object.visible = laneT > 0.001;
    for (const fs of [tsvFlow, phyFlow]) {
      if (!fs) continue;
      fs.flow.setOpacity(base * tsvVis);
      fs.flow.object.visible = tsvVis > 0.01;
    }
    for (const fs of flows) {
      fs.flow.setTheme(p.theme);
      fs.flow.setSize(fs === tsvFlow || fs === phyFlow ? (dark ? 0.042 : 0.032) : dark ? 0.044 : 0.034);
    }
  };
  const recolorFlows = (p: Palette) => {
    flowA.flow.recolor((i) => dirColor(lanes16.read[i] ?? true, p));
    flowB.flow.recolor((i) => dirColor(lanes32.read[i] ?? true, p));
    tsvFlow?.flow.recolor((i) => dirColor(tsvRead[i] ?? true, p));
    phyFlow?.flow.recolor((i) => dirColor(phyRead[i] ?? true, p));
  };

  /* ───────── labels ───────── */
  const L = (spec: LabelSpec) => labels.add(spec);
  const featW = (x: number, y: number, z: number): [number, number, number] => [SX + x, y, SZ + z];
  const lab = {
    gpu: L({ text: 'GPU（AI 加速器）', position: [0, H + 0.02, 0], align: 'above', kind: 'strong', priority: 30, hotspot: 'gpu' }),
    stack: L({ text: 'HBM 堆疊', position: featW(0, H + 0.04, 0), align: 'above', kind: 'strong', priority: 30, hotspot: 'hbm-stack' }),
    ctxTags: STACKS.slice(1).map(([sx, sz]) =>
      L({ text: 'HBM', position: [sx, H + 0.04, sz], align: 'above', kind: 'tag', priority: 12, hotspot: 'hbm-stack' }),
    ),
    interposer: L({ text: '矽中介層', position: [-IP.w / 2 + 0.9, -IP.t / 2, IP.d / 2], align: 'below', offset: [0, 4], priority: 18, hotspot: 'interposer' }),
    substrate: L({ text: '封裝載板', position: [-SUB.w / 2 + 1.0, SUB_TOP - SUB.t, SUB.d / 2], align: 'below', priority: 14 }),
    gen: L({ text: '', position: featW(0, 0, D / 2 + 0.1), align: 'below', offset: [0, 10], kind: 'tag', priority: 16 }),
    base: L({ text: '基底晶粒（邏輯晶片）', align: 'left', priority: 26, hotspot: 'base-die' }),
    dram: L({ text: '', align: 'left', priority: 25, hotspot: 'dram-die' }),
    topDie: L({ text: '頂層晶粒（較厚）', align: 'left', priority: 18, hotspot: 'dram-die' }),
    banks: L({ text: '記憶體陣列', align: 'above', kind: 'tag', priority: 14, hotspot: 'dram-die' }),
    tsvZone: L({ text: 'TSV 區', align: 'above', kind: 'tag', priority: 14, hotspot: 'tsv' }),
    tsv: L({ text: 'TSV（矽穿孔）', align: 'right', priority: 26, hotspot: 'tsv' }),
    bump: L({ text: '微凸塊', align: 'right', priority: 24, hotspot: 'micro-bump' }),
    flowNote: L({ text: '資料沿 TSV 上下傳遞', align: 'above', kind: 'muted', priority: 20 }),
    phy: L({ text: '經中介層 → GPU', align: 'below', kind: 'tag', priority: 20, hotspot: 'interposer' }),
    phase: L({ text: '', align: 'above', kind: 'strong', priority: 40, always: true }),
    fillTag: L({ text: '', align: 'right', priority: 24, hotspot: 'fill' }),
    headTag: L({ text: '熱壓接合頭', align: 'right', kind: 'tag', priority: 18, hotspot: 'fill' }),
    width: L({ text: '', align: 'below', kind: 'strong', priority: 40, hotspot: 'interface' }),
    laneNote: L({ text: '每條線＝1 個 64 位元通道（示意）', align: 'above', kind: 'tag', priority: 22 }),
    baseProc: L({ text: '', align: 'right', priority: 24, hotspot: 'base-die' }),
    gpuPhy: L({ text: 'GPU 端 PHY', align: 'left', kind: 'tag', priority: 20, hotspot: 'gpu' }),
  };
  const STEP_LABELS: Record<number, LabelHandle[]> = {
    0: [lab.gpu, lab.stack, ...lab.ctxTags, lab.interposer, lab.substrate, lab.gen],
    // (The generation / height tag stays on the overview: here the toggles and 「DRAM ×n」 carry it,
    // and at the foot of the exploded stack it would sit under the legend on smaller stages.)
    1: [lab.base, lab.dram, lab.topDie, lab.banks, lab.tsvZone],
    2: [lab.base, lab.dram, lab.topDie, lab.tsv, lab.bump, lab.flowNote, lab.phy],
    3: [lab.phase, lab.fillTag, lab.headTag],
    4: [lab.width, lab.laneNote, lab.baseProc, lab.gpuPhy],
  };
  const allLabels = Object.values(STEP_LABELS).flat();
  let baseProcTop = false;

  const updateLabels = () => {
    const { g, t } = dimsFor(n);
    const gap = g * cur.gap;
    const G = (EXPLODE / n) * cur.explode;
    const midDie = Math.max(2, Math.round(n / 2));
    const dieY = (i: number) => dieBottom(i, gap, G, t) + t / 2;
    // Edge labels sit on the front edge, or on the cut face once the front half is ghosted.
    const zEdge = lerp(D / 2, 0.02, cur.ghost);
    const c = compact;
    lab.base.set({ text: c ? '基底晶粒' : '基底晶粒（邏輯晶片）', position: featW(-W / 2 - 0.02, Y0 + TB / 2, zEdge) });
    lab.dram.set({ text: c ? `DRAM ×${n}` : `DRAM 核心晶粒 ×${n}`, position: featW(-W / 2 - 0.02, dieY(midDie), zEdge) });
    lab.topDie.set({
      text: step === 2 ? (c ? '頂層無 TSV' : '頂層晶粒：不需 TSV') : c ? '頂層晶粒' : '頂層晶粒（較厚）',
      position: featW(-W / 2 - 0.02, dieY(n) + TOP_X / 2, zEdge),
    });
    lab.banks.set({ position: featW(0.42, stackTop, -0.42) });
    lab.tsvZone.set({ position: featW(-0.18, stackTop, 0) });
    lab.tsv.set({ text: c ? 'TSV' : 'TSV（矽穿孔）', position: featW(TSV_X[TSV_X.length - 1]! + 0.03, dieY(Math.max(1, n - 3)), 0.02) });
    lab.bump.set({ position: featW(TSV_X[TSV_X.length - 1]! + 0.02, dieBottom(Math.max(2, Math.round(n / 3)), gap, G, t) - gap / 2, 0.02) });
    lab.flowNote.set({ text: c ? '資料沿 TSV 上下' : '資料沿 TSV 上下傳遞', position: featW(0, stackTop + 0.04, 0) });
    // Front end of the interposer lanes, clear of the base-die label.
    lab.phy.set({ position: [GAP_X0 + 0.12, 0.01, SZ + D * 0.46] });
    lab.phase.set({ position: featW(0, Math.max(stackTop, anim.headOn ? anim.headY + 0.34 : 0) + 0.08, -0.1) });
    lab.fillTag.set({
      text: anim.film ? (c ? 'NCF 膜' : '非導電膜（NCF）') : c ? 'MUF 填充' : '模封填充材料（MUF）',
      position: featW(W / 2 + (anim.film ? 0.04 : 0.01), dieBottom(Math.min(n, 4), gap, G, t) - gap / 2, 0.15),
    });
    lab.headTag.set({ position: featW(W * 0.47, anim.headY + 0.02, -0.05), visible: step === 3 && anim.headOn });
    lab.gen.set({ text: `${GEN_TEXT[gen].short}・${n} 層・${gen === 'hbm4' ? '2,048' : '1,024'} 位元` });
    lab.width.set({ text: GEN_TEXT[gen].width, position: [(GAP_X0 + GAP_X1) / 2, 0.01, SZ + D / 2] });
    lab.laneNote.set({ position: [(GAP_X0 + GAP_X1) / 2, 0.01, SZ - D / 2] });
    // Portrait looks down on the stack (its base die is out of sight): tag the stack's top face.
    const topTag = ctx.size.portrait;
    if (topTag !== baseProcTop) {
      baseProcTop = topTag;
      lab.baseProc.set(topTag ? { align: 'center', kind: 'tag' } : { align: 'right', kind: 'default' });
    }
    lab.baseProc.set(
      topTag
        ? { text: gen === 'hbm4' ? '基底晶粒：邏輯製程' : '基底晶粒：DRAM 製程', position: featW(0, stackTop, 0.25) }
        : { text: c ? (gen === 'hbm4' ? '基底：邏輯製程' : '基底：DRAM 製程') : GEN_TEXT[gen].base, position: featW(0.1, Y0 + TB / 2, D / 2 + 0.02) },
    );
    lab.gpuPhy.set({ position: [GAP_X0, H, SZ - 0.15] });
    const shown = STEP_LABELS[step] ?? [];
    for (const h of allLabels) h.set({ visible: shown.includes(h) && (h !== lab.headTag || anim.headOn) });
  };

  /* ───────── combined refresh ───────── */
  const refresh = () => {
    layoutFeatured();
    applyColors();
    applyFlowLook();
    updateLabels();
    placeAnchors();
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    // Glows: reflow heat (step 3) and the pressed die (TC-NCF).
    glows.set(0, featW(0, stackTop * 0.5, 0.2), 1.9, p.heat, anim.reflow * (dark ? 0.55 : 0.3));
    glows.set(1, featW(0, anim.headY - 0.1, 0.2), 1.2, p.heat, anim.headHeat * (dark ? 0.5 : 0.25));
    glows.set(2, [(GAP_X0 + GAP_X1) / 2, 0.05, SZ], 1.5, p.flow, (hot['interface'] ?? 0) * (dark ? 0.5 : 0.25));
    ctx.invalidate();
  };

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    paintDram(dramTex, p);
    paintBase(baseTex, p);
    paintGpu(gpuTex, p, 2);
    grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.08 : 0.04), dark ? 0.55 : 0.75);
    shadowMat.color.copy(dark ? p.flow : p.fg);
    shadowMat.opacity = dark ? 0.07 : 0.08;
    glows.setTheme(p.theme);
    recolorFlows(p);
    layoutContext();
    lab.stack.set({ swatch: p.css['seg-memory-storage'] ?? '' });
    lab.gpu.set({ swatch: p.css['seg-ai-accelerators'] ?? '' });
    refresh();
  };

  /* ───────── generation / layer count ───────── */
  let laneTween: { cancel(): void } | null = null;
  let autoGen = -1; // seconds left before step 4's automatic HBM3E → HBM4 switch (−1 = none)
  const setGen = (g: Gen, opts: { announce?: boolean; instant?: boolean } = {}) => {
    gen = g;
    panel.set(0, g);
    laneTween?.cancel();
    const to = g === 'hbm4' ? 1 : 0;
    if (opts.instant) {
      laneT = to;
      layoutLanes();
      refresh();
    } else {
      const from = laneT;
      laneTween = ctx.tween.run(
        (k) => {
          laneT = from + (to - from) * k;
          layoutLanes();
          refresh();
        },
        { duration: 1400, ease: 'cubicInOut' },
      );
    }
    layoutContext();
    refresh();
    if (opts.announce) ctx.announce(g === 'hbm4' ? '已切換為 HBM4：每疊 2,048 位元、32 個通道' : '已切換為 HBM3E：每疊 1,024 位元、16 個通道');
  };
  const setLayers = (count: number) => {
    if (count === n) return;
    n = count;
    panel.set(1, String(count));
    buildTsvFlows();
    layoutContext();
    if (step === 3) bondT = 0;
    showStatic3IfNeeded();
    refresh();
    ctx.announce(`已切換為 ${count} 層 DRAM 核心晶粒`);
  };

  const panel = createTogglePanel(ctx, [
    {
      label: '世代',
      value: gen,
      options: [
        { id: 'hbm3e', text: 'HBM3E', aria: 'HBM3E：每疊 1,024 位元介面' },
        { id: 'hbm4', text: 'HBM4', aria: 'HBM4：每疊 2,048 位元介面' },
      ],
      onChange: (id) => {
        autoGen = -1;
        if (id !== gen) setGen(id as Gen, { announce: true });
      },
    },
    {
      label: '層數',
      value: String(n),
      options: [
        { id: '12', text: '12 層', aria: '12 層 DRAM 核心晶粒' },
        { id: '16', text: '16 層', aria: '16 層 DRAM 核心晶粒' },
      ],
      onChange: (id) => setLayers(Number(id)),
    },
  ]);

  const legend = createLegend(ctx, [
    { color: 'var(--scene-flow)', text: '讀取：HBM → GPU', short: '讀取 HBM→GPU' },
    { color: 'var(--scene-optic)', text: '寫入：GPU → HBM', short: '寫入 GPU→HBM' },
    { color: '', text: '厚度放大、線路簡化（示意）', short: '厚度放大（示意）' },
  ]);

  /* ───────── step 3: TC-NCF / MR-MUF timeline ───────── */
  const T_FILM = 0.46;
  const T_DROP = 0.16;
  const filmLen = () => n * T_FILM + 0.8 + 1.4;
  const mufLen = () => n * T_DROP + 0.3 + 1.2 + 1.5 + 1.6;
  const bondAt = (time: number) => {
    const { g, t } = dimsFor(n);
    const gap = g * cur.gap;
    const total = filmLen() + mufLen();
    let x = ((time % total) + total) % total;
    anim.reflow = 0;
    anim.headHeat = 0;
    anim.headOn = false;
    if (x < filmLen()) {
      // TC-NCF: each die arrives with its film, is pressed (heat + force) and released.
      anim.film = true;
      const k = Math.min(n + 1, Math.floor(x / T_FILM) + 1);
      for (let i = 1; i <= NMAX; i++) {
        anim.present[i] = i <= Math.min(k, n) ? 1 : 0;
        anim.drop[i] = 0;
        anim.fill[i] = 1;
        anim.squeeze[i] = i < k ? 1 : 0;
      }
      if (k <= n) {
        const u = (x - (k - 1) * T_FILM) / T_FILM;
        const fall = 1 - easeOut(u / 0.5);
        anim.drop[k] = u < 0.5 ? 0.5 * fall : 0;
        const press = smoothstep(0.5, 0.62, u) * (1 - smoothstep(0.82, 0.95, u));
        anim.squeeze[k] = smoothstep(0.5, 0.8, u);
        anim.headHeat = press;
        anim.headOn = true;
        const th = k === n ? t + TOP_X : t;
        const lift = smoothstep(0.85, 1, u) * 0.25;
        anim.headY = dieBottom(k, gap, 0, t) + th + anim.drop[k]! + 0.08 + lift;
      }
      anim.mold = smoothstep(n * T_FILM, n * T_FILM + 0.8, x);
      anim.phase = k <= n ? `TC-NCF：每層貼膜、逐層熱壓（第 ${Math.min(k, n)} 層）` : 'TC-NCF：全部接合後再模封';
    } else {
      // MR-MUF: stack all dies (pre-bond), one mass reflow, then molded underfill flows in.
      x -= filmLen();
      anim.film = false;
      const placeEnd = n * T_DROP;
      const k = Math.min(n + 1, Math.floor(x / T_DROP) + 1);
      const reflow0 = placeEnd + 0.3;
      const fill0 = reflow0 + 1.2;
      for (let i = 1; i <= NMAX; i++) {
        anim.present[i] = i <= Math.min(k, n) ? 1 : 0;
        anim.drop[i] = 0;
        anim.squeeze[i] = 1;
        anim.fill[i] = smoothstep(fill0, fill0 + 1.5, x - (i / n) * 0.12);
      }
      if (k <= n) anim.drop[k] = 0.35 * (1 - easeOut((x - (k - 1) * T_DROP) / T_DROP));
      anim.reflow = smoothstep(reflow0, reflow0 + 0.35, x) * (1 - smoothstep(fill0 - 0.2, fill0 + 0.2, x));
      anim.mold = smoothstep(fill0, fill0 + 1.5, x);
      anim.phase =
        x < reflow0 ? 'MR-MUF：先把晶粒逐層疊好' : x < fill0 ? 'MR-MUF：一次回焊，所有凸塊同時接合' : 'MR-MUF：灌入模封填充材料（MUF）';
    }
    lab.phase.set({ text: anim.phase });
  };
  const showStatic3IfNeeded = () => {
    if (step !== 3) return;
    if (!ctx.animate) {
      resetAnim(1, 1);
      anim.phase = '接合完成：凸塊間的縫隙已填滿';
      lab.phase.set({ text: anim.phase });
    } else bondAt(bondT);
  };

  /* ───────── hotspots ───────── */
  const textOf = (id: string) => HOTSPOT_TEXT.get(id);
  const cardFor = (id: string): CardContent => {
    const t = textOf(id);
    const c: CardContent = { title: t?.label ?? id };
    if (t?.detail) c.body = t.detail;
    const link = LINKS[id];
    if (link) {
      c.href = link[0];
      c.linkLabel = link[1];
    }
    if (id === 'hbm-stack') c.swatch = ctx.palette.css['seg-memory-storage'] ?? '';
    if (id === 'gpu') c.swatch = ctx.palette.css['seg-ai-accelerators'] ?? '';
    if (id === 'interface') c.items = [{ label: '目前顯示', meta: GEN_TEXT[gen].width }];
    if (id === 'dram-die') c.items = [{ label: '目前層數', meta: `${n} 層` }];
    return c;
  };
  const hotTweens = new Map<string, { cancel(): void }>();
  const lightUp = (id: string, on: boolean) => {
    hotTweens.get(id)?.cancel();
    const from = hot[id] ?? 0;
    hotTweens.set(
      id,
      ctx.tween.run(
        (k) => {
          hot[id] = from + ((on ? 1 : 0) - from) * k;
          refresh();
        },
        { duration: 200, fade: true },
      ),
    );
  };
  const anchors: { obj: Obj3D; at: () => [number, number, number] }[] = [];
  const placeAnchors = () => {
    for (const a of anchors) a.obj.position.set(...a.at());
  };
  const reg = (id: string, object: Object3D | undefined, anchor: () => [number, number, number], extra: Object3D[] = []) => {
    const obj = new Obj3D();
    root.add(obj);
    anchors.push({ obj, at: anchor });
    obj.position.set(...anchor());
    const partStep = STACK_PART_STEP[id];
    hotspots.register(id, {
      ...(object ? { object } : {}),
      anchor: obj,
      pose: PART_POSES[id] ?? (partStep ? STEP_POSES[partStep] : null) ?? ctx.homePose,
      card: () => cardFor(id),
      onHighlight: (on) => lightUp(id, on),
      onSelect: (source: HotspotSource) => {
        const want = STACK_PART_STEP[id];
        if (source !== 'pointer' && source !== 'touch' && want !== undefined && want > 0 && want !== step) gotoStep(ctx, want);
        if (source === 'pointer' && id === 'hbm-stack') {
          ctx.card.show(cardFor(id), anchor(), { interactive: true });
          ctx.announce(`已選取：${textOf(id)?.label ?? id}`);
          return true;
        }
        return false;
      },
    });
    for (const o of extra) ctx.picker.add(o, { id });
  };
  const moldPickable = () => step === 0 || step === 4;
  gateRaycast(moldBack, () => moldPickable() && moldBack.visible);
  gateRaycast(moldFront, () => moldPickable() && moldFront.visible);
  gateRaycast(dramFront, () => cur.ghost < 0.5);
  gateRaycast(baseFront, () => cur.ghost < 0.5);
  gateRaycast(fillFront, () => cur.ghost < 0.5);
  const moldGroup = new Group();
  feat.add(moldGroup);
  moldGroup.add(moldBack, moldFront);

  reg('hbm-stack', moldGroup, () => featW(0, H + 0.05, 0), [ctxMold, ctxLayers]);
  reg('gpu', gpu, () => [0, H, 0]);
  reg('interposer', interposer, () => [-IP.w / 2 + 0.9, 0, IP.d / 2]);
  reg('base-die', baseBack, () => featW(-W / 2, Y0 + TB, D / 2), [baseFront]);
  reg('dram-die', dramBack, () => featW(-W / 2, stackTop * 0.6, D / 2), [dramFront]);
  reg('tsv', tsv, () => featW(TSV_X[TSV_X.length - 1]!, stackTop * 0.5, 0.02));
  reg('micro-bump', bumps, () => featW(TSV_X[0]!, stackTop * 0.3, 0.02));
  reg('fill', fillBack, () => featW(W / 2, stackTop * 0.4, 0.2), [fillFront]);
  reg('interface', proxies, () => [(GAP_X0 + GAP_X1) / 2, 0.02, SZ]);
  for (const id of HIERARCHY_IDS) crossLink(ctx, id, 5);

  /* ───────── steps ───────── */
  let viewTween: { cancel(): void } | null = null;
  const goView = (i: number) => {
    viewTween?.cancel();
    const from = { ...cur };
    const to = VIEWS[i] ?? VIEWS[0]!;
    const tsvFrom = tsvVis;
    viewTween = ctx.tween.run(
      (k) => {
        for (const key of Object.keys(to) as (keyof View)[]) cur[key] = from[key] + (to[key] - from[key]) * k;
        // TSV flows fade in only once the cross-section has opened.
        tsvVis = to.tsv > 0 ? Math.max(tsvFrom, smoothstep(0.6, 1, k)) : tsvFrom * (1 - k);
        refresh();
      },
      { duration: 900, ease: 'cubicInOut' },
    );
  };

  const setStepInternal = (i: number) => {
    step = i >= 0 && i < VIEWS.length ? i : 0;
    bondT = 0;
    if (step === 3) showStatic3IfNeeded();
    else resetAnim(1, 1);
    if (step === 4) {
      if (ctx.animate) {
        setGen('hbm3e', { instant: true });
        autoGen = 1.8;
      } else {
        autoGen = -1;
        setGen('hbm4', { instant: true });
      }
    } else autoGen = -1;
    goView(step);
    ctx.setPose(poseFor(step));
  };
  const poseFor = (i: number): CameraPose =>
    (ctx.size.portrait ? PORTRAIT_POSES[i] : null) ?? STEP_POSES[i] ?? ctx.homePose;
  let wasPortrait = ctx.size.portrait;

  /* ───────── initial state ───────── */
  layoutLanes();
  buildTsvFlows();
  applyPalette(ctx.palette);
  labels.setMax(ctx.quality === 'low' ? 14 : 30);
  resumeFocus(ctx);

  return {
    update(dt, t) {
      for (const fs of flows) fs.flow.update(t);
      if (step === 3 && ctx.animate) {
        bondT += dt;
        bondAt(bondT);
        refresh();
      }
      if (autoGen >= 0 && ctx.animate) {
        autoGen -= dt;
        if (autoGen < 0) setGen('hbm4');
      }
    },
    setStep(i) {
      setStepInternal(i);
    },
    onMotion(animate) {
      for (const fs of flows) fs.flow.setReduced(!animate);
      if (step === 3) showStatic3IfNeeded();
      if (!animate && autoGen >= 0) {
        autoGen = -1;
        setGen('hbm4', { instant: true });
      }
      refresh();
    },
    onQuality(_q, tier) {
      for (const fs of flows) fs.flow.setCount(scaleCount(fs.max, tier, 24));
      labels.setMax(tier.maxLabels <= 12 ? 14 : 30);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onResize(size) {
      const nextCompact = isCompact(size);
      if (nextCompact !== compact || size.portrait !== wasPortrait) {
        compact = nextCompact;
        updateLabels();
        ctx.invalidate();
      }
      // Portrait ↔ landscape (phone rotation): re-frame the current step (step 0 is the host's job).
      if (size.portrait === wasPortrait) return;
      wasPortrait = size.portrait;
      if (step > 0) ctx.setPose(poseFor(step));
    },
    dispose() {
      viewTween?.cancel();
      laneTween?.cancel();
      hotTweens.forEach((tw) => tw.cancel());
      panel.dispose();
      legend.dispose();
      for (const fs of flows) fs.flow.dispose();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}


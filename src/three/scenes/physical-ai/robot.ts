/**
 * physical-ai · robot variant — a humanoid at a table doing a pick-and-place from a language
 * instruction. Sensors (head stereo cameras, wrist camera, 6-axis F/T, fingertip tactile, joint
 * encoders) stream into a floating VLA "tower" (input tokens → Transformer → action chunk), whose
 * actions stream to the arm joints (amber motor rings). The sim-to-real step reveals a mirrored
 * translucent simulation twin with parallel, colour-randomised environments.
 *
 * Steps: 0 總覽 · 1 感知 · 2 VLA 模型 · 3 致動與控制 · 4 模擬到現實.
 * Reduced motion: a representative static pose per step, frozen dot streams, no sweep of tokens.
 */
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Line,
  LineDashedMaterial,
  LineSegments,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  BoxGeometry,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneContext, SceneInstance } from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  DotStreams,
  PartsBuilder,
  buildFloorGrid,
  crossHotspots,
  fitPortrait,
  frustumFaces,
  frustumSegments,
  hotspotCard,
  roundedRect,
  type StreamSpec,
} from './common';
import {
  CUBE,
  HAND,
  PHASE_NAME,
  TASK_PERIOD,
  applyPose,
  buildRig,
  buildTable,
  cubeGeometry,
  newTaskPose,
  taskPose,
  type Rig,
  type TaskPhase,
} from './rig';

/* ───────────────────────── layout ───────────────────────── */

const REAL_X = 0.85;
const MIRROR_X = -0.85;
/** Parallel simulation environments (offsets after mirroring) and their task-time offsets. */
const ENV_OFFSETS: readonly [number, number, number][] = [
  [0, 0, 0],
  [-1.2, 0, -1.25],
  [0.1, 0, -1.7],
];
const ENV_TIME = [0, 3.4, 6.9];
const CHUNK = 8;
const CHUNK_DT = 0.2;

interface Layout {
  panel: [number, number, number];
  yaw: number;
  scale: number;
}
const LAYOUT: Record<'land' | 'port', Layout> = {
  land: { panel: [-0.95, 0.62, -0.05], yaw: 0.34, scale: 1 },
  port: { panel: [0.2, 2.18, -0.42], yaw: 0.12, scale: 0.86 },
};

/**
 * Step poses: [landscape, portrait]. null = home. Portrait poses are the ACTUAL camera poses at 4:5
 * (`fitPortrait` undoes the host's portrait distance scaling).
 */
const POSES: readonly (readonly [CameraPose, CameraPose] | null)[] = [
  null,
  [
    { position: [2.0, 1.72, 2.85], target: [0.62, 1.12, 0.22] },
    { position: [1.78, 1.95, 3.4], target: [0.7, 0.85, 0.15] },
  ],
  [
    { position: [0.5, 1.62, 3.5], target: [-0.32, 0.95, 0.05] },
    { position: [1.2, 2.55, 4.7], target: [0.35, 1.78, -0.1] },
  ],
  [
    { position: [-0.15, 1.7, 3.45], target: [0.2, 1.05, 0.05] },
    { position: [-0.25, 1.5, 3.45], target: [0.6, 0.92, 0.15] },
  ],
  [
    { position: [-0.75, 2.85, 6.1], target: [-1.05, 0.9, -0.4] },
    { position: [7.0, 4.7, 4.7], target: [-1.25, 1.0, -0.3] },
  ],
];

/** Static task times (reduced motion) per step: a moment that shows what the step teaches. */
const STATIC_T = [5.6, 3.25, 4.9, 5.4, 5.6];

/** Focus levels per step: [sense, think, act, chunk, frustum, sim]. */
const FOCUS: readonly (readonly number[])[] = [
  [0.75, 0.75, 0.75, 0.45, 0, 0],
  [1, 0.3, 0.15, 0, 1, 0],
  [0.55, 1, 0.55, 1, 0, 0],
  [0.25, 0.45, 1, 0.35, 0, 0],
  [0.2, 0.85, 0.55, 0, 0, 1],
];

const m4 = new Matrix4();
const m4b = new Matrix4();
const q = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const sc = new Vector3();
const AXIS_ROT: Record<'x' | 'y' | 'z', Matrix4> = {
  x: new Matrix4().makeRotationY(Math.PI / 2),
  y: new Matrix4().makeRotationX(Math.PI / 2),
  z: new Matrix4(),
};

export function create(ctx: SceneContext): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'physical-ai-robot';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  let portrait = ctx.size.portrait;
  const lay = () => LAYOUT[portrait ? 'port' : 'land'];

  /* ───────── floor ───────── */
  const grid = buildFloorGrid(4.6, 3.2, 0.4);
  const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const gridLines = new LineSegments(ctx.track(grid.geometry), gridMat);
  gridLines.position.set(0, -0.001, -0.3);
  root.add(gridLines);

  const platformGeo = ctx.track(new ExtrudeGeometry(roundedRect(1.75, 1.5, 0.3), { depth: 0.05, bevelEnabled: false, curveSegments: 8 }));
  platformGeo.rotateX(-Math.PI / 2);
  platformGeo.translate(0, -0.05, 0);
  const realPlatformMat = materials.glass('muted', 0.14, { roughness: 0.6 });
  const realPlatform = new Mesh(platformGeo, realPlatformMat);
  realPlatform.position.set(REAL_X, 0, 0.2);
  realPlatform.renderOrder = 1;
  root.add(realPlatform);

  const shadowTex = ctx.track(radialTexture(128));
  const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(1.7, 1.35)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(REAL_X, 0.003, 0.22);
  shadow.renderOrder = 2;
  root.add(shadow);

  /* ───────── real robot, table, cube ───────── */
  const robotMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.18 }));
  const real = new Group();
  real.position.set(REAL_X, 0, 0);
  root.add(real);
  const rig = buildRig(robotMat);
  real.add(rig.root);
  const table = buildTable().build();
  ctx.track(table.geometry);
  for (const l of rig.links) ctx.track(l.geo!.geometry);
  const tableMesh = new Mesh(table.geometry, robotMat);
  real.add(tableMesh);
  const cubeGeo = ctx.track(cubeGeometry());
  const cube = new Mesh(cubeGeo, materials.standard('heat', { roughness: 0.42, metalness: 0.05 }));
  real.add(cube);

  /* ───────── joint motor rings (one instanced draw) ───────── */
  const ringGeo = ctx.track(new TorusGeometry(1, 0.13, 8, 28));
  const ringMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const rings = new InstancedMesh(ringGeo, ringMat, rig.motors.length);
  rings.instanceMatrix.setUsage(DynamicDrawUsage);
  rings.setColorAt(0, new Color());
  rings.frustumCulled = false;
  root.add(rings);
  ctx.track({ dispose: () => rings.dispose() });

  /* ───────── VLA tower ───────── */
  const panel = new Group();
  panel.name = 'vla';
  root.add(panel);
  const PW = 1.0;
  const PD = 0.44;
  const PLATE_Y = [0, 0.27, 0.49, 0.76];
  const plateShape = roundedRect(PW, PD, 0.07);
  const plates = new PartsBuilder();
  for (const y of PLATE_Y) {
    const g = new ExtrudeGeometry(plateShape, { depth: 0.022, bevelEnabled: false, curveSegments: 6 });
    g.rotateX(-Math.PI / 2);
    plates.add(g, 'plate', [0, y - 0.022, 0]);
  }
  const platesGeo = plates.build();
  ctx.track(platesGeo.geometry);
  const plateMat = materials.glass('optic', 0.13, { roughness: 0.3 });
  const plateMesh = new Mesh(platesGeo.geometry, plateMat);
  plateMesh.renderOrder = 3;
  panel.add(plateMesh);
  const outline: number[] = [];
  const pts = plateShape.getPoints(8);
  for (const y of PLATE_Y)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      outline.push(a.x, y + 0.002, -a.y, b.x, y + 0.002, -b.y);
    }
  const outlineGeo = ctx.track(new BufferGeometry());
  outlineGeo.setAttribute('position', new Float32BufferAttribute(outline, 3));
  const outlineMat = materials.line('optic', { transparent: true, opacity: 0.75 });
  const outlineLines = new LineSegments(outlineGeo, outlineMat);
  outlineLines.renderOrder = 4;
  panel.add(outlineLines);

  // Tokens: 6 image, 4 language, 2 state (plate 0) · 2 × 10 latent (plates 1–2) · CHUNK actions (plate 3)
  interface Tok {
    x: number;
    y: number;
    z: number;
    w: number;
    h: number;
    kind: 'img' | 'lang' | 'state' | 'latent' | 'act';
  }
  const toks: Tok[] = [];
  for (let i = 0; i < 6; i++) toks.push({ x: -0.42 + i * 0.068, y: PLATE_Y[0]!, z: 0.07, w: 0.05, h: 0.036, kind: 'img' });
  for (let i = 0; i < 4; i++) toks.push({ x: 0.0 + i * 0.068, y: PLATE_Y[0]!, z: 0.07, w: 0.05, h: 0.036, kind: 'lang' });
  for (let i = 0; i < 2; i++) toks.push({ x: 0.33 + i * 0.068, y: PLATE_Y[0]!, z: 0.07, w: 0.05, h: 0.036, kind: 'state' });
  for (const l of [1, 2]) for (let i = 0; i < 10; i++) toks.push({ x: -0.405 + i * 0.09, y: PLATE_Y[l]!, z: 0.0, w: 0.04, h: 0.03, kind: 'latent' });
  const actStart = toks.length;
  for (let i = 0; i < CHUNK; i++) toks.push({ x: -0.315 + i * 0.09, y: PLATE_Y[3]!, z: 0.04, w: 0.06, h: 0.04, kind: 'act' });
  const tokGeo = ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.18));
  const tokMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1 }));
  const tokens = new InstancedMesh(tokGeo, tokMat, toks.length);
  tokens.instanceMatrix.setUsage(DynamicDrawUsage);
  tokens.setColorAt(0, new Color());
  panel.add(tokens);
  ctx.track({ dispose: () => tokens.dispose() });
  const tokTop = (t: Tok, out: Vector3) => out.set(t.x, t.y + t.h + 0.004, t.z);
  const tokBase = (t: Tok, out: Vector3) => out.set(t.x, t.y + 0.004, t.z);

  // "Attention" links between consecutive rows of tokens (one LineSegments).
  const rows: number[][] = [
    toks.map((t, i) => (t.y === PLATE_Y[0] ? i : -1)).filter((i) => i >= 0),
    toks.map((t, i) => (t.kind === 'latent' && t.y === PLATE_Y[1] ? i : -1)).filter((i) => i >= 0),
    toks.map((t, i) => (t.kind === 'latent' && t.y === PLATE_Y[2] ? i : -1)).filter((i) => i >= 0),
    toks.map((t, i) => (t.kind === 'act' ? i : -1)).filter((i) => i >= 0),
  ];
  const linkPos: number[] = [];
  const nearest = (from: Tok, row: number[], n: number) =>
    [...row].sort((a, b) => Math.abs(toks[a]!.x - from.x) - Math.abs(toks[b]!.x - from.x)).slice(0, n);
  for (let r = 1; r < rows.length; r++)
    for (const j of rows[r]!) {
      const tj = toks[j]!;
      const picks = nearest(tj, rows[r - 1]!, 3);
      picks.push(rows[r - 1]![ctx.rng.int(rows[r - 1]!.length)]!);
      for (const i of picks) {
        tokTop(toks[i]!, v1);
        tokBase(tj, v2);
        linkPos.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      }
    }
  const linkGeo = ctx.track(new BufferGeometry());
  linkGeo.setAttribute('position', new Float32BufferAttribute(linkPos, 3));
  const linkMat = materials.line('optic', { transparent: true, opacity: 0.22, depthWrite: false });
  const links = new LineSegments(linkGeo, linkMat);
  links.renderOrder = 4;
  panel.add(links);

  // Rising particles inside the tower (input → latent → latent → action).
  const towerPaths: FlowPath[] = [];
  for (let k = 0; k < 10; k++) {
    const i0 = rows[0]![Math.floor((k * rows[0]!.length) / 10)]!;
    const l1 = nearest(toks[i0]!, rows[1]!, 1)[0]!;
    const l2 = rows[2]![(rows[1]!.indexOf(l1) + (k % 3) - 1 + 10) % 10]!;
    const a = nearest(toks[l2]!, rows[3]!, 1)[0]!;
    towerPaths.push({
      points: [tokTop(toks[i0]!, new Vector3()), tokBase(toks[l1]!, new Vector3()), tokTop(toks[l1]!, new Vector3()), tokBase(toks[l2]!, new Vector3()), tokTop(toks[l2]!, new Vector3()), tokBase(toks[a]!, new Vector3())],
    });
  }
  const TOWER_MAX = 160;
  const towerFlow = ctx.track(
    new PathFlow({ paths: towerPaths, count: TOWER_MAX, size: 0.03, speed: 0.32, speedVariance: 0.2, fadeEnds: 0.08, theme: ctx.theme, seed: 5, smooth: true }),
  );
  towerFlow.setCount(scaleCount(TOWER_MAX, ctx.tier, 40));
  towerFlow.setReduced(!ctx.animate);
  towerFlow.object.renderOrder = 5;
  panel.add(towerFlow.object);

  /* ───────── action chunk (future grasp points) ───────── */
  const chunkGeo = ctx.track(new IcosahedronGeometry(1, 1));
  const chunkMat = materials.basic('optic', { transparent: true, opacity: 0.9, depthWrite: false });
  const chunkDots = new InstancedMesh(chunkGeo, chunkMat, CHUNK);
  chunkDots.instanceMatrix.setUsage(DynamicDrawUsage);
  chunkDots.frustumCulled = false;
  chunkDots.renderOrder = 6;
  root.add(chunkDots);
  ctx.track({ dispose: () => chunkDots.dispose() });
  const chunkLineGeo = ctx.track(new BufferGeometry());
  chunkLineGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array((CHUNK + 1) * 3), 3));
  const chunkLineMat = materials.line('optic', { transparent: true, opacity: 0.7, depthWrite: false });
  const chunkLine = new Line(chunkLineGeo, chunkLineMat);
  chunkLine.frustumCulled = false;
  chunkLine.renderOrder = 6;
  root.add(chunkLine);
  const chunkEnd = new Vector3();
  const chunkEndObj = new Group();
  root.add(chunkEndObj);

  /* ───────── chest → tower link (VLA runs on the edge computer) ───────── */
  const edgeGeo = ctx.track(new BufferGeometry());
  edgeGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
  const edgeMat = materials.bind(
    ctx.track(new LineDashedMaterial({ dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.8, toneMapped: false })),
    'color',
    'optic',
  );
  const edgeLine = new Line(edgeGeo, edgeMat);
  edgeLine.frustumCulled = false;
  root.add(edgeLine);

  /* ───────── camera frustums (head + wrist) ───────── */
  const frGeo = ctx.track(new BufferGeometry());
  // The head-camera frustum is tilted down (as on real humanoids) and long enough to land on the
  // table, so it visibly frames the cube and the tray it is looking at.
  const HEAD_FAR = 0.8;
  frGeo.setAttribute('position', new Float32BufferAttribute(frustumSegments(0.85, 1.35, 0.03, HEAD_FAR), 3));
  const frMat = materials.line('flow', { transparent: true, opacity: 0.85, depthWrite: false });
  const headFr = new LineSegments(frGeo, frMat);
  headFr.rotation.set(0.28, Math.PI, 0);
  rig.at.headCam.add(headFr);
  const fillMat = materials.glass('flow', 0.07);
  const headFill = new Mesh(ctx.track(frustumFaces(0.85, 1.35, HEAD_FAR)), fillMat);
  headFr.add(headFill);
  const wfGeo = ctx.track(new BufferGeometry());
  wfGeo.setAttribute('position', new Float32BufferAttribute(frustumSegments(1.1, 1.2, 0.01, 0.14), 3));
  const wristFr = new LineSegments(wfGeo, frMat);
  wristFr.rotation.set(-Math.PI / 2 - 0.42, 0, 0);
  rig.at.wristCam.add(wristFr);

  /* ───────── simulation twin (mirrored, parallel envs) ───────── */
  const sim = new Group();
  sim.name = 'sim';
  sim.visible = false;
  root.add(sim);
  const simX = 2 * MIRROR_X - REAL_X;
  const simPlatformMat = materials.glass('flow', 0.08, { roughness: 0.5 });
  const simPlatform = new Mesh(ctx.track(new ExtrudeGeometry(roundedRect(3.2, 3.0, 0.32), { depth: 0.05, bevelEnabled: false, curveSegments: 8 })), simPlatformMat);
  simPlatform.geometry.rotateX(-Math.PI / 2);
  simPlatform.geometry.translate(0, -0.05, 0);
  simPlatform.position.set(simX - 0.45, 0, -0.55);
  simPlatform.renderOrder = 1;
  sim.add(simPlatform);
  const simGrid = buildFloorGrid(1.55, 1.45, 0.2);
  const simGridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const simGridLines = new LineSegments(ctx.track(simGrid.geometry), simGridMat);
  simGridLines.position.set(simX - 0.45, 0.004, -0.55);
  sim.add(simGridLines);

  const ghostRig = buildRig(null);
  ghostRig.root.position.set(REAL_X, 0, 0);
  const MIR = new Matrix4().makeTranslation(2 * MIRROR_X, 0, 0).multiply(new Matrix4().makeScale(-1, 1, 1));
  const envM = ENV_OFFSETS.map((o) => new Matrix4().makeTranslation(o[0], o[1], o[2]).multiply(MIR));
  const ghostMat = materials.glass('flow', 0.2, { roughness: 0.35, metalness: 0 });
  // A double-sided transparent material is drawn in two passes (back, then front). On the low tier
  // one pass keeps the three twins inside the triangle budget.
  ghostMat.forceSinglePass = ctx.quality === 'low';
  const ghostEdgeMat = materials.basic('flow', { transparent: true, opacity: 0.16, wireframe: true, depthWrite: false });
  const ghostLinks = rig.links.map((l) => {
    const im = new InstancedMesh(l.geo!.geometry, ghostMat, ENV_OFFSETS.length);
    im.instanceMatrix.setUsage(DynamicDrawUsage);
    im.frustumCulled = false;
    im.renderOrder = 3;
    sim.add(im);
    ctx.track({ dispose: () => im.dispose() });
    return im;
  });
  const ghostWire = rig.links.map((l) => {
    const m = new Mesh(l.geo!.geometry, ghostEdgeMat);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = 4;
    sim.add(m);
    return m;
  });
  // Semi-opaque tables that write depth (drawn first), so the translucent ghosts stand behind them.
  const envMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: true, roughness: 0.5 }));
  const ghostTable = new InstancedMesh(table.geometry, envMat, ENV_OFFSETS.length);
  ghostTable.setColorAt(0, new Color());
  ghostTable.renderOrder = 2;
  sim.add(ghostTable);
  ctx.track({ dispose: () => ghostTable.dispose() });
  const ghostCubeMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  const ghostCube = new InstancedMesh(cubeGeo, ghostCubeMat, ENV_OFFSETS.length);
  ghostCube.instanceMatrix.setUsage(DynamicDrawUsage);
  ghostCube.setColorAt(0, new Color());
  ghostCube.frustumCulled = false;
  sim.add(ghostCube);
  ctx.track({ dispose: () => ghostCube.dispose() });
  const realM = new Matrix4().makeTranslation(REAL_X, 0, 0);
  ENV_OFFSETS.forEach((_, k) => ghostTable.setMatrixAt(k, m4.copy(envM[k]!).multiply(realM)));
  ghostTable.instanceMatrix.needsUpdate = true;
  // The reality gap: a dashed line on the floor along the mirror plane.
  const gapGeo = ctx.track(new BufferGeometry());
  gapGeo.setAttribute('position', new Float32BufferAttribute([MIRROR_X, 0.006, -1.9, MIRROR_X, 0.006, 1.15], 3));
  const gapMat = materials.bind(
    ctx.track(new LineDashedMaterial({ dashSize: 0.09, gapSize: 0.06, transparent: true, opacity: 0.9, toneMapped: false })),
    'color',
    'muted',
  );
  const gapLine = new Line(gapGeo, gapMat);
  gapLine.computeLineDistances();
  sim.add(gapLine);
  const gapEnd = new Group();
  gapEnd.position.set(MIRROR_X, 0.02, 1.15);
  sim.add(gapEnd);
  const simCenter = new Group();
  simCenter.position.set(simX, 1.0, 0);
  sim.add(simCenter);
  const simBack = new Group();
  simBack.position.set(simX - 1.2, 1.5, -1.25);
  sim.add(simBack);

  /* ───────── glows ───────── */
  const G = { head: 0, wrist: 1, ft: 2, tipL: 3, tipR: 4, chest: 5, panel: 6, motors: 7 };
  const glows = ctx.track(new GlowSprites({ count: 7 + rig.motors.length, theme: ctx.theme }));
  glows.object.renderOrder = 8;
  root.add(glows.object);

  /* ───────── streams (sensors → VLA → joints) ───────── */
  const inputAt = (kind: Tok['kind']) => {
    const list = toks.filter((t) => t.kind === kind);
    const x = list.reduce((s, t) => s + t.x, 0) / list.length;
    return new Vector3(x, PLATE_Y[0]! - 0.03, 0.05);
  };
  const imgIn = inputAt('img');
  const stateIn = inputAt('state');
  const actOut = new Vector3(0.0, PLATE_Y[3]! + 0.11, 0.04);
  const W = (o: Object3D, out: Vector3) => o.getWorldPosition(out);
  const P = (local: Vector3, out: Vector3) => panel.localToWorld(out.copy(local));
  const streamSpecs: StreamSpec[] = [
    { from: (o) => W(rig.at.headCam, o), to: (o) => P(imgIn, o), bend: [0, 0.32, 0.1], color: (p) => p.flow, group: 'sense', dots: 9 },
    { from: (o) => W(rig.at.wristCam, o), to: (o) => P(imgIn, o).add(v3.set(0.05, 0, 0)), bend: [0, 0.2, 0.25], color: (p) => p.flow, group: 'sense', dots: 9, phase: 0.33 },
    { from: (o) => W(rig.at.ft, o), to: (o) => P(stateIn, o), bend: [0, 0.12, 0.35], color: (p) => p.flow, group: 'sense', dots: 9, phase: 0.6 },
    { from: (o) => P(actOut, o), to: (o) => W(rig.at.shoulder, o), bend: [0, 0.38, 0.05], color: (p) => p.power, group: 'act', dots: 8 },
    { from: (o) => P(actOut, o), to: (o) => W(rig.at.elbow, o), bend: [0, 0.3, 0.2], color: (p) => p.power, group: 'act', dots: 8, phase: 0.4 },
    { from: (o) => P(actOut, o), to: (o) => W(rig.at.wrist, o), bend: [0, 0.25, 0.32], color: (p) => p.power, group: 'act', dots: 8, phase: 0.75 },
    { from: (o) => W(simCenter, o).add(v3.set(0, 0.55, 0)), to: (o) => P(imgIn, o).add(v3.set(-0.1, 0, 0)), bend: [0, 0.3, 0.1], color: (p) => p.optic, group: 'sim', dots: 9 },
    { from: (o) => W(simBack, o).add(v3.set(0, 0.2, 0)), to: (o) => P(imgIn, o).add(v3.set(-0.18, 0, 0)), bend: [0, 0.5, 0.1], color: (p) => p.optic, group: 'sim', dots: 9, phase: 0.5 },
  ];
  const streams = new DotStreams(ctx, streamSpecs, root);
  streams.setReduced(!ctx.animate);

  /* ───────── invisible pick proxies ───────── */
  const proxyMat = ctx.track(new MeshBasicMaterial({ visible: false }));
  const proxy = (parent: Object3D, geo: BufferGeometry, pos: [number, number, number] = [0, 0, 0]) => {
    const m = new Mesh(ctx.track(geo), proxyMat);
    m.position.set(...pos);
    parent.add(m);
    return m;
  };
  const pHead = proxy(rig.head, new SphereGeometry(0.15, 10, 8), [0, 0.11, 0.02]);
  const pWrist = proxy(rig.elbow, new SphereGeometry(0.075, 10, 8), [0, -0.28, 0.03]);
  const pHand = proxy(rig.wristRoll, new BoxGeometry(0.16, 0.12, 0.08), [0, -0.12, 0]);
  const pChest = proxy(rig.waist, new BoxGeometry(0.34, 0.26, 0.24), [0, 0.26, 0]);
  const pPanel = proxy(panel, new BoxGeometry(PW, 0.6, PD), [0, 0.33, 0]);
  const pChunk = proxy(panel, new BoxGeometry(PW * 0.8, 0.16, PD * 0.6), [0, PLATE_Y[3]! + 0.06, 0.02]);
  const pShoulder = proxy(rig.shoulderPitch, new SphereGeometry(0.09, 10, 8));
  const pElbow = proxy(rig.elbow, new SphereGeometry(0.08, 10, 8));
  const pSim = proxy(sim, new BoxGeometry(2.6, 1.9, 2.4), [simX - 0.45, 0.95, -0.5]);

  /* ───────── labels ───────── */
  labels.setMax(18);
  interface Lbl {
    h: LabelHandle;
    steps: readonly number[];
  }
  const L: Lbl[] = [];
  const lbl = (steps: readonly number[], spec: Parameters<typeof labels.add>[0]) => {
    const h = labels.add(spec);
    L.push({ h, steps });
    return h;
  };
  const sw = (p: Palette, k: 'flow' | 'optic' | 'power' | 'highlight' | 'heat' | 'coolant') => p.css[`scene-${k}`] ?? '';
  const panelTitle = lbl([0, 1, 2, 3, 4], { text: 'VLA 模型', object: panel, position: [0, 0.98, 0], align: 'above', kind: 'strong', priority: 32, hotspot: 'vla-model' });
  const stageSense = lbl([0], { text: '感知：相機與觸覺', object: rig.at.headCam, position: [0.02, 0.2, 0], align: 'above', kind: 'strong', priority: 30, hotspot: 'head-cameras' });
  const stageAct = lbl([0], { text: '動作：關節致動器', object: rig.at.elbow, position: [-0.08, -0.02, 0.05], align: 'left', kind: 'strong', priority: 28, hotspot: 'joint-actuators' });
  const instruction = lbl([0, 2], { text: '', object: panel, position: [-PW / 2 - 0.02, 0.02, 0.1], align: 'left', kind: 'default', priority: 26, hotspot: 'vla-model' });
  // 感知
  lbl([1], { text: '頭部雙目相機', object: rig.at.headCam, position: [0.1, 0.06, 0], align: 'right', priority: 20, hotspot: 'head-cameras' });
  lbl([1], { text: '手腕相機', object: rig.at.wristCam, position: [-0.05, 0.02, 0], align: 'left', priority: 18, hotspot: 'wrist-sensors' });
  lbl([1], { text: '力／力矩感測器', object: rig.at.ft, position: [0.07, 0, 0], align: 'right', priority: 17, hotspot: 'wrist-sensors' });
  lbl([1], { text: '指尖觸覺', object: rig.at.grasp, position: [0.06, -0.03, 0], align: 'right', priority: 16, hotspot: 'gripper' });
  lbl([1], { text: '關節編碼器（本體感覺）', object: rig.at.shoulder, position: [-0.08, 0.02, 0], align: 'left', priority: 15, hotspot: 'joint-actuators' });
  lbl([1], { text: '慣性測量單元（IMU）', object: rig.at.imu, position: [0.2, 0, 0.1], align: 'right', priority: 12 });
  // VLA
  lbl([2], { text: '影像 Token', object: panel, position: [-0.25, -0.04, 0.22], align: 'below', kind: 'tag', priority: 14, hotspot: 'vla-model' });
  lbl([2], { text: '語言 Token', object: panel, position: [0.1, -0.04, 0.22], align: 'below', kind: 'tag', priority: 14, hotspot: 'vla-model' });
  lbl([2], { text: '狀態', object: panel, position: [0.37, -0.04, 0.22], align: 'below', kind: 'tag', priority: 13, hotspot: 'vla-model' });
  lbl([2], { text: 'Transformer（視覺語言模型骨幹）', object: panel, position: [-PW / 2 - 0.02, 0.38, 0], align: 'left', kind: 'muted', priority: 15, hotspot: 'vla-model' });
  lbl([2], { text: '動作區塊', object: panel, position: [PW / 2 + 0.02, PLATE_Y[3]! + 0.04, 0], align: 'right', kind: 'default', priority: 19, hotspot: 'action-chunk' });
  lbl([2], { text: '未來夾爪路徑', object: chunkEndObj, position: [0, 0.03, 0], align: 'above', kind: 'tag', priority: 13, hotspot: 'action-chunk' });
  lbl([2], { text: '邊緣 AI 電腦', object: rig.at.chest, position: [0.13, 0.02, 0.02], align: 'right', priority: 17, hotspot: 'edge-computer' });
  const phaseLbl = lbl([2, 3], { text: '', object: panel, position: [PW / 2 + 0.02, PLATE_Y[3]! - 0.09, 0], align: 'right', kind: 'muted', priority: 18 });
  // 致動
  lbl([3], { text: '肩關節', object: rig.at.shoulder, position: [-0.09, 0.03, 0], align: 'left', priority: 18, hotspot: 'joint-actuators' });
  lbl([3], { text: '肘關節', object: rig.at.elbow, position: [-0.07, 0, 0], align: 'left', priority: 18, hotspot: 'joint-actuators' });
  lbl([3], { text: '腕關節', object: rig.at.wrist, position: [-0.06, 0, 0], align: 'left', priority: 17, hotspot: 'joint-actuators' });
  lbl([3], { text: '夾爪', object: rig.at.grasp, position: [-0.08, -0.02, 0], align: 'left', priority: 16, hotspot: 'gripper' });
  lbl([3], { text: '伺服馬達＋諧波減速機＋編碼器', object: rig.at.leftShoulder, position: [0.08, 0.04, 0], align: 'right', kind: 'muted', priority: 14, hotspot: 'joint-actuators' });
  lbl([3], { text: '腿部：線性致動器（滾柱螺桿）', object: rig.at.knee, position: [0.25, 0, 0], align: 'right', kind: 'muted', priority: 12, hotspot: 'joint-actuators' });
  lbl([3], { text: '閉迴路：編碼器 → 控制器 → 馬達', object: real, position: [-0.42, 0.77, 0.72], align: 'below', kind: 'tag', priority: 13 });
  // 模擬到現實
  lbl([4], { text: '模擬環境（虛擬分身）', object: simCenter, position: [0, 0.95, 0], align: 'above', kind: 'strong', priority: 30, hotspot: 'sim-twin' });
  lbl([4], { text: '真實世界', object: real, position: [0, 1.95, 0], align: 'above', kind: 'strong', priority: 30 });
  lbl([4], { text: '平行環境', object: simBack, position: [0, 0.35, 0], align: 'above', kind: 'tag', priority: 16, hotspot: 'sim-twin' });
  lbl([4], { text: '領域隨機化：顏色、光線、摩擦', object: simCenter, position: [0, -0.2, 0.55], align: 'below', kind: 'muted', priority: 18, hotspot: 'sim-twin' });
  lbl([4], { text: '策略部署', object: panel, position: [PW / 2 + 0.02, PLATE_Y[3]! + 0.04, 0], align: 'right', kind: 'default', priority: 19 });
  lbl([4], { text: '現實落差', object: gapEnd, position: [0, 0, 0], align: 'below', kind: 'tag', priority: 15 });

  /* ───────── palette ───────── */
  const roles: Record<string, Color> = {};
  const cTok: Record<Tok['kind'], Color> = { img: new Color(), lang: new Color(), state: new Color(), latent: new Color(), act: new Color() };
  const cRing = new Color();
  const cBg = new Color();
  const envColors: Color[] = [];
  const tmpC = new Color();
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    cBg.copy(p.bg);
    roles['shell'] = dark ? p.fg.clone().lerp(p.bg, 0.2) : p.bg.clone().lerp(p.fg, 0.02).multiplyScalar(1.07);
    roles['dark'] = dark ? p.bg.clone().lerp(p.fg, 0.2) : p.fg.clone().lerp(p.bg, 0.3);
    roles['accent'] = p.seg['physical-ai'].clone();
    roles['sensor'] = p.flow.clone();
    roles['compute'] = p.optic.clone();
    roles['table'] = dark ? p.bg.clone().lerp(p.fg, 0.16) : p.bg.clone().lerp(p.muted, 0.32);
    roles['tableLeg'] = p.muted.clone();
    roles['tray'] = p.coolant.clone();
    roles['mark'] = dark ? p.bg.clone().lerp(p.fg, 0.32) : p.bg.clone().lerp(p.fg, 0.35);
    for (const l of rig.links) l.geo!.recolor(roles);
    table.recolor(roles);
    cTok.img.copy(p.flow);
    cTok.lang.copy(p.highlight);
    cTok.state.copy(p.seg['physical-ai']);
    cTok.latent.copy(p.optic);
    cTok.act.copy(p.power);
    cRing.copy(p.power);
    grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.1 : 0.05), dark ? 0.6 : 0.8);
    simGrid.recolor(p.flow, dark ? 0.55 : 0.6);
    shadowMat.color.copy(dark ? p.bg.clone().lerp(p.fg, 0.05) : p.fg);
    shadowMat.opacity = dark ? 0.5 : 0.14;
    envColors.length = 0;
    for (let i = 0; i < p.chart.length; i++) envColors.push(p.chart[i]!.clone());
    towerFlow.recolor((i) => {
      const t0 = toks[rows[0]![Math.floor((i * rows[0]!.length) / 10)]!]!;
      return [cTok[t0.kind], cTok[t0.kind], p.optic, p.optic, p.optic, p.power];
    });
    towerFlow.setTheme(p.theme);
    towerFlow.setSize(dark ? 0.032 : 0.024);
    streams.setPalette(p);
    glows.setTheme(p.theme);
    stageSense.set({ swatch: sw(p, 'flow') });
    panelTitle.set({ swatch: sw(p, 'optic') });
    stageAct.set({ swatch: sw(p, 'power') });
    paintTokens();
  };

  /* ───────── state ───────── */
  const pose = newTaskPose();
  const fut = newTaskPose();
  const gaze = new Vector3();
  let taskT = STATIC_T[0]!;
  const focus = [...FOCUS[0]!];
  const actH: number[] = new Array<number>(CHUNK).fill(0.04);
  let lastInstr = '';
  let lastPhase: TaskPhase | '' = '';

  const paintTokens = () => {
    const lv = focus[1]!;
    toks.forEach((t, i) => {
      const h = t.kind === 'act' ? actH[i - actStart]! : t.h;
      m4.compose(v1.set(t.x, t.y + h / 2 + 0.002, t.z), q.identity(), sc.set(t.w, h, t.w));
      tokens.setMatrixAt(i, m4);
      tmpC.copy(cTok[t.kind]).lerp(cBg, (1 - lv) * 0.55);
      tokens.setColorAt(i, tmpC);
    });
    tokens.instanceMatrix.needsUpdate = true;
    if (tokens.instanceColor) tokens.instanceColor.needsUpdate = true;
  };

  const cubeWorld = (pz: typeof pose, gr: Rig, out: Vector3) => {
    if (pz.carry) return gr.at.grasp.getWorldPosition(out);
    out.copy(pz.rest);
    out.y += CUBE / 2;
    return gr.root.localToWorld(out);
  };

  const domainColor = (env: number, cycle: number, salt: number) => {
    const h = Math.imul(env * 73856093 + (cycle + 11) * 19349663 + salt * 83492791, 2654435761) >>> 0;
    return envColors[h % Math.max(1, envColors.length)] ?? cBg;
  };

  const updateRobot = () => {
    taskPose(taskT, pose);
    gaze.copy(pose.carry ? pose.wrist : pose.rest);
    if (pose.carry) gaze.y -= HAND;
    else gaze.y += CUBE / 2;
    applyPose(rig, pose, gaze);
    // cube
    cubeWorld(pose, rig, v1);
    real.worldToLocal(v1);
    cube.position.copy(v1);
    // instruction + phase (LabelHandle.set always invalidates: only call it on a change)
    const instr = pose.cycle % 2 === 0 ? '指令：「把方塊放進藍色托盤」' : '指令：「把方塊放回桌上的標記」';
    if (instr !== lastInstr) instruction.set({ text: (lastInstr = instr) });
    if (pose.phase !== lastPhase) phaseLbl.set({ text: `模型輸出 → ${PHASE_NAME[(lastPhase = pose.phase)]}` });
    // rings
    rig.motors.forEach((mo, i) => {
      mo.node.updateWorldMatrix(true, false);
      m4.copy(mo.node.matrixWorld).multiply(AXIS_ROT[mo.axis]).multiply(m4b.makeScale(mo.r, mo.r, mo.r));
      rings.setMatrixAt(i, m4);
      const lv = mo.arm ? focus[2]! : focus[2]! * 0.7;
      tmpC.copy(cRing).lerp(cBg, 0.62 * (1 - lv));
      rings.setColorAt(i, tmpC);
    });
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  };

  const updateChunk = () => {
    const lv = focus[3]!;
    chunkDots.visible = chunkLine.visible = lv > 0.01;
    // action tokens follow the chunk: height ∝ speed of the future step (gripper events count too)
    const prevW = v2.copy(pose.wrist);
    let prevOpen = pose.open;
    const arr = chunkLineGeo.getAttribute('position') as Float32BufferAttribute;
    rig.at.grasp.getWorldPosition(v1);
    arr.setXYZ(0, v1.x, v1.y, v1.z);
    for (let k = 1; k <= CHUNK; k++) {
      taskPose(taskT + k * CHUNK_DT, fut);
      const d = fut.wrist.distanceTo(prevW) / CHUNK_DT + Math.abs(fut.open - prevOpen) * 0.6;
      actH[k - 1] = 0.02 + Math.min(0.11, d * 0.28);
      prevW.copy(fut.wrist);
      prevOpen = fut.open;
      v1.copy(fut.wrist);
      v1.y -= HAND;
      real.localToWorld(v1);
      arr.setXYZ(k, v1.x, v1.y, v1.z);
      const s = (0.016 - k * 0.0009) * (0.4 + 0.6 * lv);
      m4.compose(v1, q.identity(), sc.set(s, s, s));
      chunkDots.setMatrixAt(k - 1, m4);
      if (k === CHUNK) chunkEnd.copy(v1);
    }
    arr.needsUpdate = true;
    chunkDots.instanceMatrix.needsUpdate = true;
    chunkMat.opacity = 0.95 * lv;
    chunkLineMat.opacity = 0.75 * lv;
    chunkEndObj.position.copy(chunkEnd);
    paintTokens();
  };

  const updateEdgeLine = () => {
    const arr = edgeGeo.getAttribute('position') as Float32BufferAttribute;
    rig.at.chest.getWorldPosition(v1);
    panel.localToWorld(v2.set(0.15, -0.01, 0.05));
    arr.setXYZ(0, v1.x, v1.y, v1.z);
    arr.setXYZ(1, v2.x, v2.y, v2.z);
    arr.needsUpdate = true;
    edgeLine.computeLineDistances();
  };

  const updateGlows = () => {
    const dark = ctx.theme === 'dark';
    const a = dark ? 1 : 0.65;
    const s = focus[0]!;
    glows.set(G.head, W(rig.at.headCam, v1), 0.16 + 0.06 * s, ctx.palette.flow, (0.25 + 0.55 * s) * a);
    glows.set(G.wrist, W(rig.at.wristCam, v1), 0.1, ctx.palette.flow, (0.2 + 0.5 * s) * a);
    glows.set(G.ft, W(rig.at.ft, v1), 0.12 + 0.12 * pose.force, ctx.palette.flow, (0.15 + 0.7 * pose.force) * (0.4 + 0.6 * s) * a);
    glows.set(G.tipL, W(rig.at.tipL, v1), 0.07 + 0.06 * pose.force, ctx.palette.flow, 0.8 * pose.force * s * a);
    glows.set(G.tipR, W(rig.at.tipR, v1), 0.07 + 0.06 * pose.force, ctx.palette.flow, 0.8 * pose.force * s * a);
    glows.set(G.chest, W(rig.at.chest, v1), 0.2, ctx.palette.optic, (0.2 + 0.5 * focus[1]!) * a);
    glows.set(G.panel, panel.localToWorld(v1.set(0, 0.4, 0)), 1.3 * lay().scale, ctx.palette.optic, (dark ? 0.16 : 0.08) * focus[1]!);
    rig.motors.forEach((mo, i) => {
      glows.set(G.motors + i, W(mo.node, v1), mo.r * 4.2, ctx.palette.power, (mo.arm ? 0.75 : 0.45) * focus[2]! * focus[2]! * a);
    });
  };

  const updateGhosts = () => {
    if (!sim.visible) return;
    ENV_OFFSETS.forEach((_, k) => {
      const tk = taskT * (k === 0 ? 1 : 1.12) + ENV_TIME[k]!;
      taskPose(tk, fut);
      gaze.copy(fut.carry ? fut.wrist : fut.rest);
      applyPose(ghostRig, fut, gaze);
      ghostRig.links.forEach((l, i) => {
        m4.copy(envM[k]!).multiply(l.node.matrixWorld);
        ghostLinks[i]!.setMatrixAt(k, m4);
        if (k === 0) ghostWire[i]!.matrix.copy(m4);
      });
      cubeWorld(fut, ghostRig, v1);
      m4b.makeTranslation(v1.x, v1.y, v1.z);
      ghostCube.setMatrixAt(k, m4.copy(envM[k]!).multiply(m4b));
      ghostCube.setColorAt(k, domainColor(k, fut.cycle, 1));
      tmpC.copy(domainColor(k, fut.cycle, 2)).lerp(cBg, ctx.theme === 'dark' ? 0.55 : 0.45);
      ghostTable.setColorAt(k, tmpC);
    });
    for (const im of ghostLinks) im.instanceMatrix.needsUpdate = true;
    ghostCube.instanceMatrix.needsUpdate = true;
    if (ghostCube.instanceColor) ghostCube.instanceColor.needsUpdate = true;
    if (ghostTable.instanceColor) ghostTable.instanceColor.needsUpdate = true;
  };

  const applyFocus = () => {
    streams.setGroup('sense', focus[0]!, true);
    streams.setGroup('act', focus[2]!, true);
    streams.setGroup('sim', focus[5]!, true);
    const fr = focus[4]!;
    headFr.visible = wristFr.visible = fr > 0.01;
    frMat.opacity = 0.85 * fr;
    fillMat.opacity = (ctx.theme === 'dark' ? 0.07 : 0.08) * fr;
    plateMat.opacity = (ctx.theme === 'dark' ? 0.13 : 0.16) * (0.45 + 0.55 * focus[1]!);
    outlineMat.opacity = 0.8 * (0.4 + 0.6 * focus[1]!);
    linkMat.opacity = (ctx.theme === 'dark' ? 0.24 : 0.3) * focus[1]!;
    towerFlow.setOpacity(0.25 + 0.75 * focus[1]!);
    const se = focus[5]!;
    sim.visible = se > 0.01;
    ghostMat.opacity = (ctx.theme === 'dark' ? 0.2 : 0.26) * se;
    ghostEdgeMat.opacity = (ctx.theme === 'dark' ? 0.16 : 0.2) * se;
    envMat.opacity = 0.6 * se;
    gapMat.opacity = 0.9 * se;
    ghostCubeMat.opacity = se;
    ghostCubeMat.transparent = se < 0.99;
    simPlatformMat.opacity = 0.08 * se;
    simGridMat.opacity = se;
    edgeLine.visible = focus[3]! > 0.6 && ctx.step === 2;
    edgeMat.opacity = 0.8;
  };

  const refresh = () => {
    updateRobot();
    updateChunk();
    updateEdgeLine();
    updateGlows();
    updateGhosts();
    streams.update(0);
  };

  /* ───────── hotspots ───────── */
  const pose3 = (i: number): CameraPose => {
    const p = POSES[i];
    if (!p) return ctx.homePose;
    return portrait ? fitPortrait(ctx, p[1]) : p[0];
  };
  const card = (id: string, extra: { label: string; href: string }[] = []) => () => hotspotCard(ctx, id, extra);
  const CHAIN = { label: '實體 AI 產業鏈', href: '/chain/physical-ai/' };
  hotspots.register('head-cameras', { object: pHead, card: card('head-cameras'), pose: pose3(1) });
  hotspots.register('wrist-sensors', { object: pWrist, card: card('wrist-sensors'), pose: pose3(1) });
  hotspots.register('gripper', { object: pHand, card: card('gripper'), pose: pose3(3) });
  hotspots.register('edge-computer', {
    object: pChest,
    card: card('edge-computer', [CHAIN]),
    pose: pose3(2),
    onHighlight: (on) => glows.setSize(G.chest, on ? 0.34 : 0.2),
  });
  hotspots.register('vla-model', { object: pPanel, card: card('vla-model', [{ label: '世界模型', href: '/glossary/#world-model' }]), pose: pose3(2) });
  ctx.picker.add(chunkDots, { id: 'action-chunk' });
  hotspots.register('action-chunk', { object: pChunk, anchor: chunkEndObj, card: card('action-chunk'), pose: pose3(2) });
  ctx.picker.add(rings, { id: 'joint-actuators' });
  ctx.picker.add(pElbow, { id: 'joint-actuators' });
  hotspots.register('joint-actuators', {
    object: pShoulder,
    card: card('joint-actuators', [
      { label: '諧波減速機', href: '/glossary/#harmonic-reducer' },
      { label: '人形機器人', href: '/glossary/#humanoid-robot' },
      CHAIN,
    ]),
    pose: pose3(3),
  });
  hotspots.register('sim-twin', {
    object: pSim,
    card: card('sim-twin', [
      { label: '合成資料', href: '/glossary/#synthetic-data' },
      { label: '數位孿生', href: '/glossary/#digital-twin' },
    ]),
    pose: pose3(4),
  });
  crossHotspots(ctx, ['lidar', 'car-cameras', 'radar', 'detections', 'trajectory', 'e2e-model']);

  /* ───────── steps, layout ───────── */
  let focusTween: { cancel(): void } | null = null;
  const setFocus = (i: number, instant: boolean) => {
    focusTween?.cancel();
    const from = [...focus];
    const to = FOCUS[i] ?? FOCUS[0]!;
    if (to[5]! > 0) sim.visible = true;
    const step = (k: number) => {
      for (let j = 0; j < focus.length; j++) focus[j] = from[j]! + (to[j]! - from[j]!) * k;
      applyFocus();
      refresh();
    };
    if (instant) step(1);
    else focusTween = ctx.tween.run(step, { duration: 650, ease: 'cubicInOut', fade: true });
  };
  const showLabels = (i: number) => {
    for (const l of L) l.h.set({ visible: l.steps.includes(i) });
    // The overview names the three stages of the loop (感知 → 模型 → 動作), as the scene title does.
    panelTitle.set({ text: i === 0 ? '模型：VLA' : 'VLA 模型' });
  };

  const applyLayout = () => {
    const l = lay();
    panel.position.set(...l.panel);
    panel.rotation.y = l.yaw;
    panel.scale.setScalar(l.scale);
    panel.updateMatrixWorld(true);
  };

  applyLayout();
  applyPalette(ctx.palette);
  setFocus(ctx.step, true);
  showLabels(ctx.step);
  if (!ctx.animate) taskT = STATIC_T[ctx.step] ?? STATIC_T[0]!;
  refresh();

  return {
    update(dt) {
      if (ctx.animate) taskT += dt;
      updateRobot();
      updateChunk();
      updateEdgeLine();
      updateGlows();
      updateGhosts();
      streams.update(dt);
      towerFlow.update(taskT);
    },
    setStep(i) {
      setFocus(i, false);
      showLabels(i);
      if (!ctx.animate) {
        taskT = STATIC_T[i] ?? STATIC_T[0]!;
        refresh();
      }
      ctx.setPose(i > 0 ? pose3(i) : ctx.homePose);
    },
    onMotion(animate) {
      streams.setReduced(!animate);
      towerFlow.setReduced(!animate);
      if (!animate) {
        taskT = STATIC_T[ctx.step] ?? STATIC_T[0]!;
        refresh();
      } else taskT = Math.floor(taskT / TASK_PERIOD) * TASK_PERIOD + (taskT % TASK_PERIOD);
    },
    onQuality(q, tier) {
      ghostMat.forceSinglePass = q === 'low';
      towerFlow.setCount(scaleCount(TOWER_MAX, tier, 40));
    },
    onPalette(p) {
      applyPalette(p);
      applyFocus();
      refresh();
    },
    onResize(size) {
      const next = size.portrait;
      if (next !== portrait) {
        portrait = next;
        applyLayout();
        refresh();
      }
    },
    dispose() {
      focusTween?.cancel();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

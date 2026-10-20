/**
 * Training zone: data-parallel training on a ring of 8 GPUs (示意).
 *
 * A dataset hub in the middle hands each GPU a different micro-batch (chart colours). Above every
 * GPU floats a 4-layer model replica: the forward pass lights the layers bottom → top (flow), the
 * backward pass leaves gradients top → bottom (heat, a different strength per GPU because every
 * GPU saw different data). Ring all-reduce then runs 2(N−1) = 14 hops around the torus
 * (reduce-scatter in heat, all-gather in highlight) while the per-GPU gradients converge to the
 * same average; finally every replica flashes the same update and the loss curve on the back
 * panel grows by one segment.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraPose, Palette, QualityTier } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  LabelSet,
  hardware,
  idle,
  makeFloor,
  poseAt,
  roundedRect,
  smooth,
  type V3,
  type Zone,
  type ZoneEnv,
} from './common';

const N = 8; // GPUs (示意)
const R = 2.3; // ring radius
const LAYERS = 4;
const PLATE_Y = [0.46, 0.62, 0.78, 0.94];
const HOPS = 2 * (N - 1);
const M = 120; // loss curve points
const PTS_PER_STEP = 12;
const CHART = { x0: -1.62, x1: 1.62, y0: 0.92, y1: 2.26, z: -3.42 };

type Phase = 'load' | 'forward' | 'backward' | 'allreduce' | 'update';
const PHASES: readonly Phase[] = ['load', 'forward', 'backward', 'allreduce', 'update'];
const PHASE_TEXT: Record<Phase, string> = {
  load: '① 分配資料：每張 GPU 拿到不同的小批次',
  forward: '② 前向傳播：逐層計算，算出損失',
  backward: '③ 反向傳播：算出每個權重的梯度',
  allreduce: '④ 梯度 all-reduce：交換並平均梯度',
  update: '⑤ 更新權重：每份副本做相同的更新',
};
const PHASE_SHORT: Record<Phase, string> = {
  load: '分配資料',
  forward: '前向傳播',
  backward: '反向傳播',
  allreduce: '梯度同步（all-reduce）',
  update: '更新權重',
};

const angle = (i: number) => ((i + 0.5) * Math.PI * 2) / N;
const modPos = (i: number, y = 0, r = R, out = new Vector3()) => out.set(Math.sin(angle(i)) * r, y, Math.cos(angle(i)) * r);
const HOP0 = 0.26; // ring flows are built for this hop time; slower steps rescale their clock

export function buildTraining(env: ZoneEnv): Zone {
  const { ctx, origin } = env;
  const { materials, rng } = ctx;
  const group = new Group();
  group.name = 'zone-training';
  group.position.copy(origin);
  env.parent.add(group);
  // Pickables of the data-parallel hotspot (hub + GPU modules) live in their own group.
  const dpGroup = new Group();
  group.add(dpGroup);
  const labels = new LabelSet(ctx, group);

  /* ───────── floor & platform ───────── */
  const floor = makeFloor(ctx, 6.5, 0.7, -0.13);
  group.add(floor.group);
  const platGeo = ctx.track(new CylinderGeometry(3.25, 3.32, 0.1, 96, 1));
  const platMat = materials.glass((p) => (p.theme === 'dark' ? p.muted : p.fg), 0.08, { roughness: 0.4 });
  const platform = new Mesh(platGeo, platMat);
  platform.position.y = -0.07;
  platform.renderOrder = 1;
  group.add(platform);
  const rimPts: Vector3[] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    rimPts.push(new Vector3(Math.sin(a) * 3.27, -0.015, Math.cos(a) * 3.27));
  }
  const rim = new LineLoop(ctx.track(new BufferGeometry().setFromPoints(rimPts)), materials.line('muted', { transparent: true, opacity: 0.55 }));
  group.add(rim);

  /* ───────── GPU modules (instanced: boards, dies, HBM) ───────── */
  const m4 = new Matrix4();
  const dummy = new Object3D();
  const place = (mesh: InstancedMesh, idx: number, i: number, local: V3, scaleY = 1) => {
    const a = angle(i);
    const p = modPos(i);
    dummy.position.set(local[0], local[1], local[2]).applyAxisAngle(Y_AXIS, a).add(p);
    dummy.rotation.set(0, a, 0);
    dummy.scale.set(1, scaleY, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(idx, dummy.matrix);
  };
  const boardMat = materials.standard((p) => hardware(p), { roughness: 0.55, metalness: 0.3 });
  const boards = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.94, 0.1, 0.94, 2, 0.035)), boardMat, N);
  const dieMat = materials.standard('seg:ai-accelerators', { roughness: 0.32, metalness: 0.45 });
  materials.bind(dieMat, 'emissive', 'seg:ai-accelerators', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.28 : 0.06));
  const dies = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.42, 0.07, 0.42, 1, 0.015)), dieMat, N);
  const hbmMat = materials.standard('seg:memory-storage', { roughness: 0.4, metalness: 0.35 });
  const hbms = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.13, 0.09, 0.17, 1, 0.012)), hbmMat, N * 4);
  for (let i = 0; i < N; i++) {
    place(boards, i, i, [0, 0.05, 0]);
    place(dies, i, i, [0, 0.135, 0]);
    [-1, 1].forEach((sx, a) =>
      [-1, 1].forEach((sz, b) => place(hbms, i * 4 + a * 2 + b, i, [sx * 0.3, 0.145, sz * 0.12])),
    );
  }
  for (const m of [boards, dies, hbms]) {
    m.matrixAutoUpdate = false;
    dpGroup.add(m);
    ctx.track({ dispose: () => m.dispose() });
  }

  /* ───────── model replicas (4 layer plates per GPU) ───────── */
  const plateMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.08, transparent: true, opacity: 0.93 }));
  const plates = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.66, 0.045, 0.66, 2, 0.02)), plateMat, N * LAYERS);
  plates.instanceMatrix.setUsage(DynamicDrawUsage);
  for (let i = 0; i < N; i++) for (let k = 0; k < LAYERS; k++) place(plates, i * LAYERS + k, i, [0, PLATE_Y[k]!, 0]);
  plates.setColorAt(0, new Color());
  plates.renderOrder = 3;
  group.add(plates);
  ctx.track({ dispose: () => plates.dispose() });
  // Faint posts tie each replica to its GPU.
  const postPos: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = modPos(i);
    for (const [dx, dz] of [
      [-0.28, -0.28],
      [0.28, 0.28],
    ] as const) {
      const q = new Vector3(dx, 0, dz).applyAxisAngle(Y_AXIS, angle(i)).add(p);
      postPos.push(q.x, 0.17, q.z, q.x, PLATE_Y[LAYERS - 1]!, q.z);
    }
  }
  const postGeo = ctx.track(new BufferGeometry());
  postGeo.setAttribute('position', new Float32BufferAttribute(postPos, 3));
  const posts = new LineSegments(postGeo, materials.line('muted', { transparent: true, opacity: 0.35 }));
  group.add(posts);

  /* ───────── dataset hub + spokes ───────── */
  const hubMat = materials.standard('seg:devtools-data-mlops', { roughness: 0.4, metalness: 0.2 });
  materials.bind(hubMat, 'emissive', 'seg:devtools-data-mlops', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.18 : 0.04));
  const hub = new InstancedMesh(ctx.track(new CylinderGeometry(0.42, 0.42, 0.11, 48, 1)), hubMat, 3);
  for (let d = 0; d < 3; d++) hub.setMatrixAt(d, m4.makeTranslation(0, 0.07 + d * 0.15, 0));
  hub.matrixAutoUpdate = false;
  dpGroup.add(hub);
  ctx.track({ dispose: () => hub.dispose() });
  const spokePos: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = modPos(i, 0.012, 0.48);
    const b = modPos(i, 0.012, R - 0.5);
    spokePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const spokeGeo = ctx.track(new BufferGeometry());
  spokeGeo.setAttribute('position', new Float32BufferAttribute(spokePos, 3));
  group.add(new LineSegments(spokeGeo, materials.line('muted', { transparent: true, opacity: 0.4 })));

  /* ───────── interconnect ring ───────── */
  const ringMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9 }));
  const ring = new Mesh(ctx.track(new TorusGeometry(R, 0.026, 8, 160)), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);
  const ringProxy = new Mesh(ctx.track(new TorusGeometry(R, 0.2, 6, 64)), ctx.track(new MeshBasicMaterial({ visible: false })));
  ringProxy.rotation.x = Math.PI / 2;
  ringProxy.position.y = 0.25;
  group.add(ringProxy);

  /* ───────── loss chart ───────── */
  const chart = new Group();
  group.add(chart);
  const panelW = CHART.x1 - CHART.x0 + 0.62;
  const panelH = CHART.y1 - CHART.y0 + 0.5;
  const panelMat = materials.glass((p) => (p.theme === 'dark' ? p.muted : p.fg), 0.06, { roughness: 0.5 });
  const panelShape = roundedRect(panelW, panelH, 0.14);
  const panel = new Mesh(ctx.track(new ShapeGeometry(panelShape, 6)), panelMat);
  panel.position.set((CHART.x0 + CHART.x1) / 2 - 0.06, (CHART.y0 + CHART.y1) / 2 + 0.02, CHART.z - 0.02);
  panel.renderOrder = 1;
  chart.add(panel);
  // [material, base opacity]: the whole chart fades out on the top-down all-reduce view (step 2).
  const chartMats: [{ opacity: number }, number][] = [];
  const fadeable = <T extends { opacity: number }>(m: T, base: number): T => {
    chartMats.push([m, base]);
    return m;
  };
  const edgeMat = fadeable(materials.line('muted', { transparent: true, opacity: 0.4 }), 0.4);
  const panelEdge = new LineLoop(ctx.track(new BufferGeometry().setFromPoints(panelShape.getPoints(6).map((q) => new Vector3(q.x, q.y, 0)))), edgeMat);
  panelEdge.position.copy(panel.position);
  chart.add(panelEdge);
  const axisPos: number[] = [CHART.x0, CHART.y0, CHART.z, CHART.x1 + 0.05, CHART.y0, CHART.z, CHART.x0, CHART.y0, CHART.z, CHART.x0, CHART.y1 + 0.08, CHART.z];
  const axisGeo = ctx.track(new BufferGeometry());
  axisGeo.setAttribute('position', new Float32BufferAttribute(axisPos, 3));
  chart.add(new LineSegments(axisGeo, fadeable(materials.line('muted', { transparent: true, opacity: 1 }), 1)));
  const gridPos: number[] = [];
  for (let g = 1; g <= 3; g++) {
    const y = CHART.y0 + ((CHART.y1 - CHART.y0) * g) / 3;
    gridPos.push(CHART.x0, y, CHART.z, CHART.x1, y, CHART.z);
  }
  const gridGeo = ctx.track(new BufferGeometry());
  gridGeo.setAttribute('position', new Float32BufferAttribute(gridPos, 3));
  chart.add(new LineSegments(gridGeo, fadeable(materials.line('grid', { transparent: true, opacity: 0.9 }), 0.9)));

  // Illustrative loss: a power-law-ish decay with smoothed noise (示意, not any real model).
  const loss: number[] = [];
  let n1 = 0;
  for (let i = 0; i < M; i++) {
    const s = i / (M - 1);
    n1 = n1 * 0.55 + rng.normal() * 0.45;
    loss.push(0.12 + 0.88 * (1 + s * 16) ** -0.78 + n1 * 0.03 * (1 - 0.6 * s));
  }
  const lmin = Math.min(...loss);
  const lmax = Math.max(...loss);
  const curvePts = loss.map((l, i) => new Vector3(CHART.x0 + 0.04 + ((CHART.x1 - CHART.x0 - 0.08) * i) / (M - 1), CHART.y0 + 0.06 + ((l - lmin) / (lmax - lmin)) * (CHART.y1 - CHART.y0 - 0.1), CHART.z + 0.012));
  const ribbon = ribbonGeometry(curvePts, 0.034);
  ctx.track(ribbon);
  const curveMat = fadeable(materials.basic('heat', { transparent: true }), 1);
  const curve = new Mesh(ribbon, curveMat);
  curve.renderOrder = 4;
  chart.add(curve);
  const head = new Mesh(ctx.track(new SphereGeometry(0.05, 16, 12)), curveMat);
  head.renderOrder = 5;
  chart.add(head);

  /* ───────── flows ───────── */
  const LOAD_T = 1.0;
  const dataPaths: FlowPath[] = [];
  for (let i = 0; i < N; i++) {
    const end = modPos(i, PLATE_Y[0]!);
    const pts = [new Vector3(0, 0.5, 0), modPos(i, 1.12, R * 0.42), modPos(i, 0.86, R * 0.82), end];
    const len = new CatmullRomCurve3(pts, false, 'centripetal').getLength();
    dataPaths.push({ points: pts, speed: len / (LOAD_T * 0.85) });
  }
  const dataFlow = ctx.track(
    new PathFlow({ paths: dataPaths, count: N * 4, size: 0.13, sizeVariance: 0, speed: 1, speedVariance: 0, mode: 'once', onceOffsets: [0, -0.06, -0.12, -0.18], fadeEnds: 0.1, byLength: false, theme: ctx.theme }),
  );
  let hop = HOP0;
  const ringPaths = (): FlowPath[] =>
    Array.from({ length: N }, (_, i) => {
      const pts: Vector3[] = [];
      const a0 = angle(i) + 0.34;
      const a1 = angle(i + 1) - 0.34;
      for (let s = 0; s <= 6; s++) {
        const u = s / 6;
        const a = a0 + (a1 - a0) * u;
        pts.push(new Vector3(Math.sin(a) * R, 0.2 + 0.32 * Math.sin(Math.PI * u), Math.cos(a) * R));
      }
      const len = new CatmullRomCurve3(pts, false, 'centripetal').getLength();
      return { points: pts, speed: len / HOP0 };
    });
  const offs = (from: number) => Array.from({ length: N - 1 }, (_, k) => [-(from + k), -(from + k) - 0.09]).flat();
  const flowOpts = { size: 0.11, sizeVariance: 0, speed: 1, speedVariance: 0, mode: 'once' as const, fadeEnds: 0.1, byLength: false, theme: ctx.theme };
  const rsFlow = ctx.track(new PathFlow({ ...flowOpts, paths: ringPaths(), count: N * 2 * (N - 1), onceOffsets: offs(0) }));
  const agFlow = ctx.track(new PathFlow({ ...flowOpts, paths: ringPaths(), count: N * 2 * (N - 1), onceOffsets: offs(N - 1) }));
  group.add(dataFlow.object, rsFlow.object, agFlow.object);

  const glows = ctx.track(new GlowSprites({ count: N + 2, theme: ctx.theme }));
  group.add(glows.object);

  /* ───────── labels ───────── */
  const phaseLabel = labels.add({ text: '', position: [0, 0, 3.3], align: 'below', kind: 'strong', priority: 40, always: true });
  const subLabel = labels.add({ text: '', position: [0, 0, 3.3], align: 'below', offset: [0, 31], kind: 'muted', priority: 32, always: true });
  labels.add({ text: '訓練資料', position: [0, 0.54, 0], align: 'above', priority: 22, hotspot: 'data-parallel' });
  const front = modPos(N - 1);
  labels.add({ text: 'GPU（示意 8 張）', position: [front.x - 0.5, 0.1, front.z + 0.1], align: 'left', priority: 18, hotspot: 'data-parallel' }, (s) => s !== 2);
  const right = modPos(0);
  // Step 1 (訓練迴圈, landscape) swaps the replica name for the two ends of GPU 2's replica, so the
  // direction of the passes reads; portrait stages have no free room beside the ring for them.
  let portrait = ctx.size.portrait;
  const g2 = modPos(1);
  labels.add({ text: '模型副本（4 層）', position: [right.x + 0.38, PLATE_Y[3]!, right.z], align: 'right', priority: 20, hotspot: 'model-replica' }, (s) => s !== 1 || portrait);
  labels.add({ text: '輸出層 → 損失', position: [g2.x + 0.5, PLATE_Y[3]!, g2.z], align: 'right', priority: 20, hotspot: 'model-replica' }, (s) => s === 1 && !portrait);
  labels.add({ text: '輸入層 ← 小批次', position: [g2.x + 0.5, PLATE_Y[0]!, g2.z], align: 'right', priority: 19, hotspot: 'model-replica' }, (s) => s === 1 && !portrait);
  labels.add({ text: '環狀 all-reduce', position: [0, 0.05, R + 0.05], align: 'below', offset: [0, 2], priority: 21, hotspot: 'all-reduce' });
  // Title sits inside the panel's top margin (no headroom needed above the chart on small stages).
  labels.add({ text: '損失曲線（示意）', position: [0.12, CHART.y1 + 0.15, CHART.z + 0.02], align: 'center', priority: 24, hotspot: 'loss-curve' }, (s) => s !== 2);
  // Axis tags are hidden on the top-down all-reduce view (the chart is out of frame there).
  labels.add({ text: '訓練步數 →', position: [CHART.x1 - 0.2, CHART.y0 - 0.02, CHART.z], align: 'below', kind: 'tag', priority: 6 }, (s) => s !== 2);
  labels.add({ text: '損失', position: [CHART.x0 - 0.02, CHART.y1 - 0.05, CHART.z], align: 'left', kind: 'tag', priority: 6 }, (s) => s !== 2);
  // GPU numbers (all-reduce view): outside the ring, except the two at the back, whose outside tag
  // would sit on their own replica; side GPUs align away from their replica.
  for (let i = 0; i < N; i++) {
    const back = Math.cos(angle(i)) < -0.5;
    const sx = Math.sin(angle(i));
    const p = modPos(i, 0.06, back ? R - 0.74 : R + 0.66);
    const align = back || Math.abs(sx) < 0.7 ? 'center' : sx > 0 ? 'right' : 'left';
    labels.add({ text: `GPU ${i + 1}`, position: [p.x, p.y, p.z], align, kind: 'tag', priority: 9 }, (s) => s === 2);
  }

  /* ───────── state ───────── */
  let step = 0;
  let ph = 0;
  let pt = 0;
  let iter = 0;
  let shown = 0; // revealed loss points
  let from = 0;
  let isStatic = false;
  const grad = new Float32Array(N); // per-GPU gradient strength (differs before all-reduce)
  let avg = 0.75;
  const hot = { data: 0, replica: 0, ring: 0, chart: 0 };
  const view = { chart: 1 }; // chart visibility (faded out on the top-down all-reduce view)
  const dur = (p: Phase) => (p === 'load' ? LOAD_T : p === 'forward' || p === 'backward' ? 1.35 : p === 'allreduce' ? HOPS * hop + 0.35 : 1.1);

  const newBatch = () => {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      grad[i] = 0.42 + 0.58 * rng();
      sum += grad[i]!;
    }
    avg = sum / N;
    if (shown >= M) shown = 0;
  };
  const enter = (p: Phase) => {
    if (p === 'load') {
      newBatch();
      iter++;
    }
    if (p === 'update') from = shown;
  };

  /* ───────── palette ───────── */
  const cBase = new Color();
  const cFlow = new Color();
  const cGrad = new Color();
  const cHi = new Color();
  const cHeat = new Color();
  const cRing = new Color();
  const cBatch: Color[] = Array.from({ length: N }, () => new Color());
  const tmp = new Color();
  const tmp2 = new Color();
  let dark = ctx.theme === 'dark';
  const applyPalette = (p: Palette) => {
    dark = p.theme === 'dark';
    // Idle layer plates: a quiet slate that still separates from the dark floor.
    if (dark) cBase.copy(p.muted).lerp(p.bg, 0.24);
    else idle(p, cBase).lerp(p.bg, 0.25);
    cFlow.copy(p.flow);
    cGrad.copy(p.heat);
    cHi.copy(p.highlight);
    cHeat.copy(p.heat);
    cRing.copy(p.muted).lerp(p.fg, dark ? 0.1 : 0.2);
    cBatch.forEach((c, i) => c.copy(p.chart[i % p.chart.length]!));
    floor.applyPalette(p);
    dataFlow.recolor((i) => cBatch[i]!);
    rsFlow.recolor(() => cGrad);
    agFlow.recolor(() => cHi);
    for (const f of [dataFlow, rsFlow, agFlow]) {
      f.setTheme(p.theme);
      f.setOpacity(dark ? 1 : 0.9);
    }
    dataFlow.setSize(dark ? 0.15 : 0.12);
    rsFlow.setSize(dark ? 0.16 : 0.14);
    agFlow.setSize(dark ? 0.16 : 0.14);
    glows.setTheme(p.theme);
    platMat.opacity = dark ? 0.08 : 0.05;
  };
  applyPalette(ctx.palette);

  /* ───────── drawing ───────── */
  const glowPos = new Vector3();
  const plateColor = (i: number, k: number, phase: Phase, t: number, out: Color) => {
    out.copy(cBase);
    const D = dur(phase);
    const g = grad[i]!;
    switch (phase) {
      case 'load': {
        if (k === 0) out.lerp(cBatch[i]!, 0.75 * smooth(LOAD_T * 0.6, LOAD_T, t));
        break;
      }
      case 'forward': {
        const f = (t / D) * (LAYERS + 0.4) - 0.3;
        const lit = smooth(k - 0.3, k + 0.15, f);
        const peak = 1 - smooth(k + 0.2, k + 1.4, f);
        if (k === 0) out.lerp(cBatch[i]!, 0.75 * (1 - lit));
        out.lerp(cFlow, lit * (0.5 + 0.4 * peak));
        break;
      }
      case 'backward': {
        const b = LAYERS - 0.7 - (t / D) * (LAYERS + 0.4);
        const got = smooth(k + 0.3, k - 0.15, b);
        out.lerp(cFlow, 0.5 * (1 - smooth(0, D * 0.8, t)));
        out.lerp(cGrad, got * (0.35 + 0.6 * g));
        break;
      }
      case 'allreduce': {
        const conv = smooth(0.1, HOPS * hop, t);
        out.lerp(cGrad, 0.35 + 0.6 * (g + (avg - g) * conv));
        break;
      }
      case 'update': {
        const u = t / D;
        const flash = Math.sin(Math.PI * Math.min(1, u * 1.5));
        out.lerp(cGrad, (0.35 + 0.6 * avg) * (1 - smooth(0, 0.55, u)));
        out.lerp(cHi, 0.85 * flash);
        break;
      }
      default:
    }
    if (hot.replica > 0) out.lerp(cHi, 0.25 * hot.replica);
    return out;
  };

  const draw = () => {
    const phase = PHASES[ph]!;
    const D = dur(phase);
    const t = pt;
    for (let i = 0; i < N; i++) for (let k = 0; k < LAYERS; k++) plates.setColorAt(i * LAYERS + k, plateColor(i, k, phase, t, tmp));
    if (plates.instanceColor) plates.instanceColor.needsUpdate = true;

    // Activation-front glows.
    for (let i = 0; i < N; i++) {
      let y = PLATE_Y[0]!;
      let a = 0;
      let c = cFlow;
      if (phase === 'load') {
        a = smooth(LOAD_T * 0.6, LOAD_T, t) * 0.8;
        c = cBatch[i]!;
      } else if (phase === 'forward') {
        const f = Math.min(LAYERS - 1, Math.max(0, (t / D) * (LAYERS + 0.4) - 0.3));
        y = PLATE_Y[0]! + f * (PLATE_Y[1]! - PLATE_Y[0]!);
        a = 0.95;
      } else if (phase === 'backward') {
        const b = Math.min(LAYERS - 1, Math.max(0, LAYERS - 0.7 - (t / D) * (LAYERS + 0.4)));
        y = PLATE_Y[0]! + b * (PLATE_Y[1]! - PLATE_Y[0]!);
        a = 0.6 + 0.4 * grad[i]!;
        c = cGrad;
      } else if (phase === 'update') {
        y = (PLATE_Y[0]! + PLATE_Y[LAYERS - 1]!) / 2;
        a = Math.sin(Math.PI * Math.min(1, (t / D) * 1.5));
        c = cHi;
      }
      glows.set(i, modPos(i, y, R, glowPos), phase === 'update' ? 1.5 : 1.05, c, a * (dark ? 0.75 : 0.45) * (isStatic ? 0.6 : 1));
    }
    glows.set(N, glowPos.set(0, 0.62, 0), 1.6 + 0.6 * hot.data, cBatch[2]!, (phase === 'load' ? 0.55 : 0.25 + 0.4 * hot.data) * (dark ? 1 : 0.6));

    // Ring: brightens while gradients travel.
    const ar = phase === 'allreduce' ? smooth(0, 0.3, t) * (1 - smooth(D - 0.3, D, t)) : 0;
    ringMat.color.copy(cRing).lerp(cGrad, Math.max(ar * 0.75, isStatic && step === 2 ? 0.6 : 0)).lerp(cHi, 0.55 * hot.ring);

    // Loss curve.
    if (phase === 'update' && !isStatic) shown = Math.min(M, from + Math.round(PTS_PER_STEP * smooth(0, D * 0.75, t)));
    const n = Math.max(2, shown);
    ribbon.setDrawRange(0, (n - 1) * 6);
    head.position.copy(curvePts[n - 1]!);
    head.visible = shown > 1;
    tmp2.copy(cHeat);
    const cv = view.chart;
    glows.set(N + 1, curvePts[n - 1]!, 0.55, tmp2, shown > 1 ? (dark ? 0.85 : 0.5) * cv : 0);
    panelMat.opacity = ((dark ? 0.06 : 0.05) + 0.07 * hot.chart) * cv;
    chart.visible = cv > 0.01;
    for (const [m, base] of chartMats) m.opacity = base * cv;

    // Flows.
    dataFlow.object.visible = isStatic ? step !== 2 : phase === 'load';
    rsFlow.object.visible = isStatic ? step === 2 : phase === 'allreduce';
    agFlow.object.visible = !isStatic && phase === 'allreduce';
    if (!isStatic) {
      if (phase === 'load') dataFlow.setTime(t);
      if (phase === 'allreduce') {
        rsFlow.setTime((t * HOP0) / hop);
        agFlow.setTime((t * HOP0) / hop);
      }
    }

    // Text.
    phaseLabel.set({ text: PHASE_TEXT[phase] });
    let sub = `訓練第 ${Math.max(1, iter)} 步（示意）`;
    if (phase === 'allreduce') {
      const h = Math.min(HOPS, Math.floor(t / hop) + 1);
      sub = h <= N - 1 ? `reduce-scatter（分段加總）第 ${h}／${N - 1} 步` : `all-gather（分送結果）第 ${h - (N - 1)}／${N - 1} 步`;
      if (isStatic) sub = `reduce-scatter ${N - 1} 步＋all-gather ${N - 1} 步`;
    }
    subLabel.set({ text: sub });
  };

  const advance = (dt: number) => {
    pt += dt;
    let phase = PHASES[ph]!;
    while (pt >= dur(phase)) {
      pt -= dur(phase);
      ph = (ph + 1) % PHASES.length;
      phase = PHASES[ph]!;
      enter(phase);
    }
  };

  const setStatic = (on: boolean) => {
    isStatic = on;
    for (const f of [dataFlow, rsFlow, agFlow]) f.setReduced(on);
  };

  /* ───────── hotspots ───────── */
  const W = (v: Vector3 | V3): V3 => (Array.isArray(v) ? [origin.x + v[0], origin.y + v[1], origin.z + v[2]] : [origin.x + v.x, origin.y + v.y, origin.z + v.z]);
  const hotTween = (key: keyof typeof hot) => (on: boolean) => {
    ctx.tween.to(hot, { [key]: on ? 1 : 0 } as Partial<Record<keyof typeof hot, number>>, { duration: 220, fade: true });
  };
  const gpuCard = (i: number) => ({
    title: `GPU ${i + 1}`,
    body: `拿到第 ${i + 1} 份小批次資料（每張 GPU 的資料以不同顏色表示），用自己的那份模型副本計算。目前：${PHASE_SHORT[PHASES[ph]!]}。`,
  });
  env.register('data-parallel', {
    object: dpGroup,
    anchor: W([0, 0.7, 0]),
    pose: poseAt(origin, [1.2, 3.4, 5.6], [0, 0.4, 0.4]),
    onHighlight: hotTween('data'),
    card: (hit) => {
      if (hit && hit.instanceId !== undefined && hit.object !== hub) return gpuCard(hit.object === hbms ? Math.floor(hit.instanceId / 4) : hit.instanceId);
      return null;
    },
  });
  env.register('model-replica', {
    object: plates,
    anchor: W(modPos(0, 0.8)),
    pose: poseAt(origin, [3.2, 2.2, 4.6], [0.8, 0.7, 1.6]),
    onHighlight: hotTween('replica'),
    card: (hit) => {
      if (hit?.instanceId === undefined) return null;
      const i = Math.floor(hit.instanceId / LAYERS);
      const k = hit.instanceId % LAYERS;
      return {
        title: `GPU ${i + 1} 的模型副本：第 ${k + 1} 層`,
        body: '每張 GPU 都有一份完全相同的模型。前向傳播由下往上計算，反向傳播由上往下算出梯度；all-reduce 之後，每份副本做出相同的更新，所以永遠保持一致。',
      };
    },
  });
  env.register('all-reduce', {
    object: ringProxy,
    anchor: W([0, 0.3, R]),
    pose: poseAt(origin, [0.6, 6.0, 5.2], [0, 0.4, 0.3]),
    onHighlight: hotTween('ring'),
  });
  env.register('loss-curve', {
    object: panel,
    anchor: W([0, (CHART.y0 + CHART.y1) / 2, CHART.z]),
    pose: poseAt(origin, [0.3, 2.4, 1.6], [0, 1.6, CHART.z]),
    onHighlight: hotTween('chart'),
  });

  /* ───────── zone API ───────── */
  const POSES: Record<number, CameraPose> = {
    2: poseAt(origin, [0.7, 8.6, 6.8], [0, 0.2, 0.95]),
  };

  let chartTween: { cancel(): void } | null = null;
  const start = (s: number) => {
    step = s;
    hop = s === 2 ? 0.34 : HOP0;
    labels.sync(group.visible, s);
    chartTween?.cancel();
    const want = s === 2 ? 0 : 1;
    if (!group.visible) view.chart = want;
    else if (view.chart !== want) chartTween = ctx.tween.to(view, { chart: want }, { duration: 450, fade: true });
    if (isStatic) {
      showStatic();
      return;
    }
    ph = s === 2 ? 2 : 0;
    pt = 0;
    if (iter === 0) shown = PTS_PER_STEP * 3;
    newBatch();
    iter++;
    draw();
  };

  const showStatic = () => {
    setStatic(true);
    newBatch();
    if (step === 2) {
      ph = 3;
      pt = HOPS * hop * 0.5;
    } else {
      ph = 1;
      pt = dur('forward');
    }
    shown = M;
    iter = Math.max(iter, 1);
    draw();
  };

  setStatic(!ctx.animate);

  return {
    id: 'training',
    group,
    start,
    update(dt) {
      if (dt > 0 && !isStatic) advance(dt);
      draw();
    },
    setMotion(animate) {
      if (!animate) showStatic();
      else {
        setStatic(false);
        start(step);
      }
    },
    setVisible(on) {
      group.visible = on;
      labels.sync(on, step);
    },
    onPalette(p) {
      applyPalette(p);
      draw();
    },
    onQuality(_tier: QualityTier) {
      /* particle counts here are structural (one comet per hop), nothing to scale */
    },
    pose: (s) => POSES[s] ?? null,
    onResize(pt) {
      if (pt === portrait) return;
      portrait = pt;
      labels.sync();
    },
  };
}

const Y_AXIS = new Vector3(0, 1, 0);

/** A flat ribbon (width w, in the XY plane) through `pts`; grow it with setDrawRange. */
function ribbonGeometry(pts: Vector3[], w: number): BufferGeometry {
  const pos = new Float32Array(pts.length * 2 * 3);
  const t = new Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    t.subVectors(b, a).normalize();
    const nx = -t.y * (w / 2);
    const ny = t.x * (w / 2);
    const p = pts[i]!;
    pos.set([p.x + nx, p.y + ny, p.z, p.x - nx, p.y - ny, p.z], i * 6);
  }
  const idx: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

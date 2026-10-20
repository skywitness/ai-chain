/**
 * Pipeline zone: the model-development conveyor as a closed loop (MLOps).
 *
 * Back row, left → right: 1 資料收集 → 2 品質過濾 → 3 去重 → 4 分詞; the belt turns at the right
 * end (token stream) into the front row, right → left: 5 預訓練 → 6 後訓練（SFT、RLHF）→ 7 評測 →
 * 8 部署; the left turn carries usage feedback and monitoring data back to the data stage.
 * Raw items (three source colours) thin out at the filter and dedupe stations (rejects drop into
 * bins), become small token particles after the tokenizer, and leave pretraining as model
 * checkpoints (large orbs) that pass post-training and evaluation before deployment.
 */
import {
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraPose, LabelHandle, Palette, QualityTier } from '../../core/types';
import { scaleCount } from '../../core/quality';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { LabelSet, hardware, idle, makeFloor, poseAt, roundedRect, type V3, type Zone, type ZoneEnv } from './common';

const L = 3.6; // half length of the straight part
const RT = 1.45; // belt centre-line radius at the turns
const BW = 0.5; // belt width
const XS = [-3.6, -1.2, 1.2, 3.6];
const BOX = { w: 0.86, h: 0.44, d: 0.8, roof: 0.07 };

interface Station {
  name: string;
  x: number;
  z: number;
  hs: string;
  group: 'data' | 'model' | 'eval' | 'deploy';
  scale: number;
}
const STATIONS: readonly Station[] = [
  { name: '1 資料收集', x: XS[0]!, z: -RT, hs: 'data-prep', group: 'data', scale: 1 },
  { name: '2 品質過濾', x: XS[1]!, z: -RT, hs: 'data-prep', group: 'data', scale: 1 },
  { name: '3 去重', x: XS[2]!, z: -RT, hs: 'data-prep', group: 'data', scale: 1 },
  { name: '4 分詞', x: XS[3]!, z: -RT, hs: 'data-prep', group: 'data', scale: 1 },
  { name: '5 預訓練', x: XS[3]!, z: RT, hs: 'pretraining', group: 'model', scale: 1.3 },
  { name: '6 後訓練（SFT、RLHF）', x: XS[2]!, z: RT, hs: 'post-training', group: 'model', scale: 1 },
  { name: '7 評測', x: XS[1]!, z: RT, hs: 'evaluation', group: 'eval', scale: 1 },
  { name: '8 部署', x: XS[0]!, z: RT, hs: 'deployment', group: 'deploy', scale: 1 },
];
const STEP_FOCUS: Record<number, readonly number[]> = { 6: [0, 1, 2, 3], 7: [4, 5, 6, 7] };

/** Point on the belt centre line: straight rows at z = ±RT, half circles at x = ±L. */
const turn = (side: 1 | -1, th: number, r = RT, y = 0.1) =>
  new Vector3(side * (L + r * Math.sin(th)), y, side === 1 ? -r * Math.cos(th) : r * Math.cos(th));

export function buildPipeline(env: ZoneEnv): Zone {
  const { ctx, origin } = env;
  const { materials } = ctx;
  const group = new Group();
  group.name = 'zone-pipeline';
  group.position.copy(origin);
  env.parent.add(group);
  const labels = new LabelSet(ctx, group);
  const m4 = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();
  const sc = new Vector3();

  /* ───────── floor + belt ───────── */
  const floor = makeFloor(ctx, 7.5, 0.75, -0.01);
  group.add(floor.group);
  const outer = roundedRect(2 * L + 2 * (RT + BW / 2), 2 * (RT + BW / 2), RT + BW / 2);
  outer.holes.push(roundedRect(2 * L + 2 * (RT - BW / 2), 2 * (RT - BW / 2), RT - BW / 2));
  const beltGeo = ctx.track(new ExtrudeGeometry(outer, { depth: 0.06, bevelEnabled: false, curveSegments: 24 }));
  beltGeo.rotateX(-Math.PI / 2);
  const beltMat = materials.standard((p) => (p.theme === 'dark' ? hardware(p) : idle(p).lerp(p.muted, 0.18)), { roughness: 0.7, metalness: 0.15 });
  const belt = new Mesh(beltGeo, beltMat);
  group.add(belt);
  // Rollers / slats across the belt.
  const slat: number[] = [];
  const pushSlat = (p: Vector3, nx: number, nz: number) => {
    slat.push(p.x - nx * (BW / 2 - 0.03), 0.064, p.z - nz * (BW / 2 - 0.03), p.x + nx * (BW / 2 - 0.03), 0.064, p.z + nz * (BW / 2 - 0.03));
  };
  for (let x = -L; x <= L + 1e-6; x += 0.3) {
    pushSlat(new Vector3(x, 0, -RT), 0, 1);
    pushSlat(new Vector3(x, 0, RT), 0, 1);
  }
  for (const side of [1, -1] as const)
    for (let i = 1; i < 15; i++) {
      const th = (i / 15) * Math.PI;
      const p = turn(side, th);
      const nx = (p.x - side * L) / RT;
      const nz = p.z / RT;
      pushSlat(p, nx, nz);
    }
  const slatGeo = ctx.track(new BufferGeometry());
  slatGeo.setAttribute('position', new Float32BufferAttribute(slat, 3));
  group.add(new LineSegments(slatGeo, materials.line('muted', { transparent: true, opacity: 0.5 })));

  /* ───────── stations: glass enclosures over the belt + coloured roofs (instanced) ───────── */
  const bodyMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.3, depthWrite: false }));
  const bodies = new InstancedMesh(ctx.track(new RoundedBoxGeometry(BOX.w, BOX.h, BOX.d, 2, 0.05)), bodyMat, STATIONS.length);
  const roofMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.2 }));
  const roofs = new InstancedMesh(ctx.track(new RoundedBoxGeometry(BOX.w + 0.1, BOX.roof, BOX.d + 0.08, 2, 0.03)), roofMat, STATIONS.length);
  STATIONS.forEach((s, i) => {
    bodies.setMatrixAt(i, m4.compose(v.set(s.x, 0.06 + (BOX.h / 2) * s.scale, s.z), q.identity(), sc.setScalar(s.scale)));
    roofs.setMatrixAt(i, m4.compose(v.set(s.x, 0.06 + (BOX.h + BOX.roof / 2) * s.scale, s.z), q.identity(), sc.setScalar(s.scale)));
  });
  for (const m of [bodies, roofs]) {
    m.setColorAt(0, new Color());
    group.add(m);
    ctx.track({ dispose: () => m.dispose() });
  }
  bodies.renderOrder = 6;
  const top = (i: number) => 0.06 + (BOX.h + BOX.roof) * STATIONS[i]!.scale;

  /* ───────── station icons (one instanced rounded box + a few meshes) ───────── */
  interface Prop {
    st: number;
    p: V3;
    s: V3;
    color: (p: Palette, out: Color) => Color;
  }
  const props: Prop[] = [];
  const add = (st: number, dp: V3, s: V3, color: Prop['color']) => {
    const S = STATIONS[st]!;
    props.push({ st, p: [S.x + dp[0], top(st) + dp[1], S.z + dp[2]], s, color });
  };
  const chart = (k: number) => (p: Palette, out: Color) => out.copy(p.chart[k]!);
  const seg = (id: 'ai-accelerators' | 'foundation-models' | 'cloud-neocloud' | 'memory-storage') => (p: Palette, out: Color) => out.copy(p.seg[id]);
  const hw = (p: Palette, out: Color) => hardware(p, out);
  const soft = (k: number) => (p: Palette, out: Color) => out.copy(p.chart[k]!).lerp(p.bg, 0.55);
  // 1 資料收集: a heap of documents / code from three sources.
  const SRC = [0, 3, 2];
  [
    [-0.17, 0.08, -0.1],
    [0.0, 0.08, -0.12],
    [0.17, 0.08, -0.08],
    [-0.12, 0.08, 0.1],
    [0.1, 0.08, 0.12],
    [-0.05, 0.22, 0.0],
    [0.1, 0.22, -0.02],
  ].forEach((d, k) => add(0, d as V3, [0.15, 0.15, 0.15], chart(SRC[k % 3]!)));
  // 2 品質過濾 / 3 去重: reject bins inside the loop.
  const BIN_Z = -0.55;
  for (const st of [1, 2]) props.push({ st, p: [STATIONS[st]!.x, 0.1, BIN_Z], s: [0.5, 0.2, 0.34], color: (p, out) => idle(p, out) });
  // 3 去重: an item and its duplicate.
  add(2, [-0.06, 0.1, -0.02], [0.2, 0.2, 0.2], chart(0));
  add(2, [0.1, 0.1, 0.06], [0.2, 0.2, 0.2], soft(0));
  // 4 分詞: a row of token chips.
  for (let k = 0; k < 5; k++) add(3, [-0.3 + k * 0.15, 0.06, 0], [0.11, 0.07, 0.2], (p, out) => out.copy(p.flow));
  // 5 預訓練: a GPU cluster (2 × 4).
  for (let a = 0; a < 2; a++) for (let b = 0; b < 4; b++) add(4, [-0.36 + b * 0.24, 0.06, -0.13 + a * 0.26], [0.19, 0.09, 0.19], seg('ai-accelerators'));
  // 6 後訓練: two GPUs (person icon added separately).
  for (let b = 0; b < 2; b++) add(5, [-0.22 + b * 0.24, 0.06, 0.1], [0.19, 0.09, 0.19], seg('ai-accelerators'));
  // 7 評測: a scoreboard of bars (示意).
  [0.2, 0.32, 0.26, 0.38].forEach((h, k) => add(6, [-0.27 + k * 0.18, h / 2 + 0.01, 0], [0.12, h, 0.12], (p, out) => out.copy(p.highlight)));
  // 8 部署: a serving rack with slots.
  add(7, [0, 0.29, 0], [0.4, 0.56, 0.34], hw);
  for (let k = 0; k < 3; k++) add(7, [0, 0.14 + k * 0.15, 0.17], [0.3, 0.06, 0.02], seg('cloud-neocloud'));
  const propMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.2 }));
  const propMesh = new InstancedMesh(ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.12)), propMat, props.length);
  props.forEach((pr, i) => propMesh.setMatrixAt(i, m4.compose(v.set(...pr.p), q.identity(), sc.set(...pr.s))));
  propMesh.setColorAt(0, new Color());
  group.add(propMesh);
  ctx.track({ dispose: () => propMesh.dispose() });
  // Funnel (filter) and a person (human feedback) — stock meshes.
  const funnelMat = materials.standard('seg:devtools-data-mlops', { roughness: 0.4, metalness: 0.2, side: DoubleSide });
  const funnel = new Mesh(ctx.track(new CylinderGeometry(0.24, 0.05, 0.26, 28, 1, true)), funnelMat);
  funnel.position.set(STATIONS[1]!.x, top(1) + 0.16, STATIONS[1]!.z);
  const personMat = materials.standard('highlight', { roughness: 0.5, metalness: 0.05 });
  const pHead = new Mesh(ctx.track(new SphereGeometry(0.07, 16, 12)), personMat);
  const pBody = new Mesh(ctx.track(new CapsuleGeometry(0.07, 0.1, 4, 10)), personMat);
  pHead.position.set(STATIONS[5]!.x + 0.22, top(5) + 0.27, STATIONS[5]!.z - 0.06);
  pBody.position.set(STATIONS[5]!.x + 0.22, top(5) + 0.12, STATIONS[5]!.z - 0.06);
  group.add(funnel, pHead, pBody);

  /* ───────── flows ───────── */
  const LANES = [-0.13, 0, 0.13];
  const rawPaths: FlowPath[] = [];
  const rawColor: (number | 'neg')[] = [];
  [1, 0.68, 0.46].forEach((w, s) => {
    LANES.forEach((dz, l) => {
      rawPaths.push({ points: [[XS[s]! + (s === 0 ? -0.1 : 0), 0.13, -RT + dz], [XS[s + 1]!, 0.13, -RT + dz]], weight: w });
      rawColor.push(SRC[l]!);
    });
  });
  for (const st of [1, 2]) {
    const x = STATIONS[st]!.x;
    rawPaths.push({ points: [[x + 0.1, 0.13, -RT], [x + 0.15, 0.55, -RT + 0.45], [x + 0.05, 0.24, BIN_Z]], weight: 0.45 });
    rawColor.push('neg');
  }
  const RAW_MAX = 240;
  const rawFlow = ctx.track(new PathFlow({ paths: rawPaths, count: RAW_MAX, size: 0.11, sizeVariance: 0.2, speed: 0.55, speedVariance: 0.1, fadeEnds: 0.04, theme: ctx.theme, seed: 3 }));
  const tokPaths: FlowPath[] = [-0.11, 0, 0.11].map((dr) => ({
    points: Array.from({ length: 13 }, (_, i) => turn(1, (i / 12) * Math.PI, RT + dr, 0.12)),
  }));
  const TOK_MAX = 210;
  const tokFlow = ctx.track(new PathFlow({ paths: tokPaths, count: TOK_MAX, size: 0.055, sizeVariance: 0.15, speed: 0.7, fadeEnds: 0.03, theme: ctx.theme, seed: 4 }));
  const modelPaths: FlowPath[] = [{ points: [[XS[3]! - 0.15, 0.2, RT], [XS[0]! + 0.1, 0.2, RT]] }];
  const modelFlow = ctx.track(new PathFlow({ paths: modelPaths, count: 4, size: 0.22, sizeVariance: 0, speed: 0.55, speedVariance: 0, fadeEnds: 0.03, theme: ctx.theme, seed: 6 }));
  const fbPaths: FlowPath[] = [{ points: Array.from({ length: 13 }, (_, i) => turn(-1, (i / 12) * Math.PI, RT, 0.14)) }];
  const FB_MAX = 30;
  const fbFlow = ctx.track(new PathFlow({ paths: fbPaths, count: FB_MAX, size: 0.08, sizeVariance: 0.1, speed: 0.4, fadeEnds: 0.05, theme: ctx.theme, seed: 8 }));
  const flows = [rawFlow, tokFlow, modelFlow, fbFlow];
  const setCounts = (tier: QualityTier) => {
    rawFlow.setCount(scaleCount(RAW_MAX, tier, 60));
    tokFlow.setCount(scaleCount(TOK_MAX, tier, 50));
    fbFlow.setCount(scaleCount(FB_MAX, tier, 12));
  };
  setCounts(ctx.tier);
  for (const f of flows) group.add(f.object);

  const glows = ctx.track(new GlowSprites({ count: STATIONS.length, theme: ctx.theme }));
  group.add(glows.object);

  /* ───────── labels ───────── */
  const stLabels: LabelHandle[] = STATIONS.map((s, i) =>
    labels.add({
      text: s.name,
      position: i < 4 ? [s.x, top(i) + 0.42, s.z] : [s.x, 0.02, s.z + 0.62],
      align: i < 4 ? 'above' : 'below',
      priority: 22,
      hotspot: s.hs,
    }),
  );
  // Extra labels: [handle, landscape spec, portrait spec] (the portrait layout mirrors the loop into a U).
  type Spot = { position: V3; align: 'above' | 'below' | 'left' | 'right' };
  const extras: [LabelHandle, Spot, Spot][] = [];
  const extra = (text: string, kind: 'tag' | 'default', land: Spot, port: Spot, when?: (s: number) => boolean, hs?: string) =>
    extras.push([labels.add({ text, ...land, kind, priority: kind === 'tag' ? 9 : 18, ...(hs ? { hotspot: hs } : {}) }, when), land, port]);
  // The two turns are labelled from inside the loop (the outside runs off narrow stages).
  const IN = L + RT - BW / 2 - 0.12;
  extra('token 串流', 'tag', { position: [IN, 0.1, -0.7], align: 'left' }, { position: [IN, 0.1, 0], align: 'above' });
  extra('使用回饋與監控', 'default', { position: [-IN, 0.1, -0.7], align: 'right' }, { position: [-IN, 0.1, 0], align: 'below' }, undefined, 'deployment');
  extra('網頁、書籍、程式碼', 'tag', { position: [XS[0]! - 0.5, 0.15, -RT], align: 'left' }, { position: [XS[0]! - 0.85, 0.15, -RT - 0.3], align: 'right' }, (s) => s !== 7);
  for (const st of [1, 2])
    extra('剔除', 'tag', { position: [STATIONS[st]!.x, 0.2, BIN_Z + 0.2], align: 'below' }, { position: [STATIONS[st]!.x + 0.25, 0.2, BIN_Z], align: 'below' }, (s) => s === 6);
  extra('模型檢查點', 'tag', { position: [(XS[1]! + XS[2]!) / 2, 0.36, RT], align: 'above' }, { position: [(XS[1]! + XS[2]!) / 2, 0.3, RT - 0.3], align: 'right' }, (s) => s === 7);
  extra('基礎模型', 'tag', { position: [(XS[2]! + XS[3]!) / 2, 0.36, RT], align: 'above' }, { position: [(XS[2]! + XS[3]!) / 2, 0.3, RT - 0.3], align: 'right' }, (s) => s === 7);

  /* ───────── palette & focus ───────── */
  const dim = new Float32Array(STATIONS.length);
  const hot = new Float32Array(STATIONS.length);
  const cArch: Color[] = STATIONS.map(() => new Color());
  const cRoof: Color[] = STATIONS.map(() => new Color()); // calmer tint of the stage colour
  const cProp: Color[] = props.map(() => new Color());
  const cIdle = new Color();
  const tmp = new Color();
  let dark = ctx.theme === 'dark';
  const archColor = (p: Palette, g: Station['group'], out: Color) =>
    g === 'data' ? out.copy(p.seg['devtools-data-mlops']) : g === 'model' ? out.copy(p.seg['foundation-models']) : g === 'eval' ? out.copy(p.highlight) : out.copy(p.seg['cloud-neocloud']);
  const applyPalette = (p: Palette) => {
    dark = p.theme === 'dark';
    idle(p, cIdle);
    STATIONS.forEach((s, i) => archColor(p, s.group, cArch[i]!));
    STATIONS.forEach((_, i) => {
      if (dark) cRoof[i]!.copy(cArch[i]!).lerp(hardware(p, tmp), 0.42);
      else cRoof[i]!.copy(cArch[i]!).lerp(p.bg, 0.2);
    });
    props.forEach((pr, i) => pr.color(p, cProp[i]!));
    floor.applyPalette(p);
    rawFlow.recolor((i) => (rawColor[i] === 'neg' ? p.neg : p.chart[rawColor[i] as number]!));
    tokFlow.recolor(() => p.flow);
    modelFlow.recolor(() => p.seg['foundation-models']);
    fbFlow.recolor(() => p.highlight);
    for (const f of flows) f.setTheme(p.theme);
    rawFlow.setSize(dark ? 0.12 : 0.085);
    tokFlow.setSize(dark ? 0.06 : 0.05);
    modelFlow.setSize(dark ? 0.26 : 0.2);
    fbFlow.setSize(dark ? 0.09 : 0.075);
    glows.setTheme(p.theme);
    stLabels.forEach((h, i) => h.set({ swatch: p.css[STATIONS[i]!.group === 'data' ? 'seg-devtools-data-mlops' : STATIONS[i]!.group === 'model' ? 'seg-foundation-models' : STATIONS[i]!.group === 'eval' ? 'scene-highlight' : 'seg-cloud-neocloud'] ?? '' }));
  };
  const draw = () => {
    STATIONS.forEach((s, i) => {
      tmp.copy(cArch[i]!).lerp(cIdle, 0.75 * dim[i]!);
      if (hot[i]! > 0) tmp.lerp(ctx.palette.highlight, 0.3 * hot[i]!);
      bodies.setColorAt(i, tmp);
      tmp.copy(cRoof[i]!).lerp(cIdle, 0.75 * dim[i]!);
      if (hot[i]! > 0) tmp.lerp(ctx.palette.highlight, 0.3 * hot[i]!);
      roofs.setColorAt(i, tmp);
      const a = (1 - dim[i]!) * (dark ? 0.35 : 0.22) + hot[i]! * 0.4;
      glows.set(i, v.set(s.x, top(i) + 0.12, s.z), 1.4 * s.scale, cArch[i]!, a);
    });
    for (const m of [bodies, roofs]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    props.forEach((pr, i) => propMesh.setColorAt(i, tmp.copy(cProp[i]!).lerp(cIdle, 0.7 * dim[pr.st]!)));
    if (propMesh.instanceColor) propMesh.instanceColor.needsUpdate = true;
    const dataDim = dim[0]!;
    const modelDim = dim[4]!;
    rawFlow.setOpacity(1 - 0.75 * dataDim);
    tokFlow.setOpacity(1 - 0.6 * Math.min(dataDim, modelDim));
    modelFlow.setOpacity(1 - 0.75 * modelDim);
    fbFlow.setOpacity(1 - 0.75 * modelDim);
  };
  applyPalette(ctx.palette);

  let dimTween: { cancel(): void } | null = null;
  const focus = (list: readonly number[] | undefined) => {
    dimTween?.cancel();
    const from = Float32Array.from(dim);
    const to = STATIONS.map((_, i) => (list && !list.includes(i) ? 1 : 0));
    dimTween = ctx.tween.run(
      (k) => {
        for (let i = 0; i < dim.length; i++) dim[i] = from[i]! + (to[i]! - from[i]!) * k;
        draw();
      },
      { duration: 600, fade: true },
    );
    stLabels.forEach((h, i) => h.set({ kind: to[i] ? 'muted' : 'default', priority: to[i] ? 6 : 22 }));
  };

  /* ───────── hotspots (invisible proxies) ───────── */
  const proxyMat = ctx.track(new MeshBasicMaterial({ visible: false }));
  const proxyGeo = ctx.track(new RoundedBoxGeometry(1.2, 1.3, 1.0, 1, 0.1));
  const W = (p: V3): V3 => [origin.x + p[0], origin.y + p[1], origin.z + p[2]];
  const HS: { id: string; st: number[]; pose: CameraPose; land?: CameraPose; anchor: V3 }[] = [
    { id: 'data-prep', st: [0, 1, 2, 3], pose: poseAt(origin, [0.1, 5.0, 5.8], [0.1, 0.25, -1.1]), anchor: [0, 0.9, -RT] },
    { id: 'pretraining', st: [4], pose: poseAt(origin, [4.6, 2.6, 4.4], [3.4, 0.5, 1.3]), anchor: [XS[3]!, 1.0, RT] },
    { id: 'post-training', st: [5], pose: poseAt(origin, [2.0, 2.6, 4.4], [1.1, 0.5, 1.3]), anchor: [XS[2]!, 0.9, RT] },
    { id: 'evaluation', st: [6], pose: poseAt(origin, [-0.6, 2.6, 4.4], [-1.1, 0.5, 1.3]), anchor: [XS[1]!, 0.9, RT] },
    { id: 'deployment', st: [7], pose: poseAt(origin, [-4.6, 3.0, 4.6], [-4.0, 0.4, 0.6]), anchor: [XS[0]!, 0.9, RT] },
  ];
  for (const h of HS) {
    h.land = { position: [...(h.pose.position as V3)], target: [...(h.pose.target as V3)] };
    const g = new Group();
    for (const st of h.st) {
      const m = new Mesh(proxyGeo, proxyMat);
      m.position.set(STATIONS[st]!.x, 0.6, STATIONS[st]!.z);
      g.add(m);
    }
    if (h.id === 'deployment') {
      const m = new Mesh(proxyGeo, proxyMat);
      m.position.set(-L - RT, 0.4, 0);
      g.add(m);
    }
    group.add(g);
    env.register(h.id, {
      object: g,
      anchor: W(h.anchor),
      pose: h.pose,
      onHighlight: (on) => {
        for (const st of h.st) {
          const i = st;
          ctx.tween.run(
            (k) => {
              hot[i] = on ? k : 1 - k;
              draw();
            },
            { duration: 220, fade: true },
          );
        }
      },
    });
  }

  /* ───────── zone API ───────── */
  // Landscape: 6 = a high view centred on the data row (sources → tokenizer, reject bins, token
  // turn), the whole loop in frame; 7 = a lower view along the model row, both turns in frame.
  const POSES: Record<number, CameraPose> = {
    6: poseAt(origin, [0.6, 9.4, 4.4], [0.6, 0.1, -0.9]),
    7: poseAt(origin, [0, 4.6, 8.6], [0, 0.2, 0.2]),
  };
  let step = 0;
  let t = 0;
  let portrait = false;
  let narrow = false; // phone-width portrait stage: short station names, tighter label offsets
  const isNarrow = (pt: boolean) => pt && ctx.size.width < 560;
  // Portrait (4:5) poses for the upright loop: whole loop, data column (right), model column (left).
  const PORT: Record<number, CameraPose> = {
    0: poseAt(origin, [0, 14.0, 8.2], [0, 0, 0.8]),
    6: poseAt(origin, [0.9, 8.2, 9.2], [0.8, 0, 0.1]),
    7: poseAt(origin, [-0.9, 8.2, 9.2], [-0.8, 0, 0.3]),
  };
  const layout = (pt: boolean) => {
    portrait = pt;
    narrow = isNarrow(pt);
    // Rotate the loop upright (−90° about y): stations 1–4 run top → bottom on the right, the token
    // turn is at the bottom, 5–8 run back up on the left and the feedback turn closes the loop on top.
    group.rotation.y = pt ? -Math.PI / 2 : 0;
    group.updateMatrixWorld(true);
    stLabels.forEach((h, i) => {
      const s = STATIONS[i]!;
      const text = narrow ? s.name.replace(/（.*）$/, '') : s.name;
      const off = (narrow ? 0.5 : 0.62) * s.scale;
      if (pt) h.set({ text, position: [s.x, 0.35, s.z + (i < 4 ? -off : off)], align: i < 4 ? 'right' : 'left' });
      else h.set({ text, position: i < 4 ? [s.x, top(i) + 0.42, s.z] : [s.x, 0.02, s.z + 0.62], align: i < 4 ? 'above' : 'below' });
    });
    for (const [h, land, port] of extras) h.set(pt ? port : land);
    for (const h of HS) {
      const p = pt ? env.unfit(PORT[h.st[0]! < 4 ? 6 : 7]!) : h.land!;
      h.pose.position = p.position;
      h.pose.target = p.target;
    }
  };
  const setStatic = (on: boolean) => {
    for (const f of flows) f.setReduced(on);
  };
  setStatic(!ctx.animate);
  draw();

  return {
    id: 'pipeline',
    group,
    start(s) {
      step = s;
      labels.sync(group.visible, s);
      focus(STEP_FOCUS[s]);
    },
    update(dt) {
      if (dt > 0) {
        t += dt;
        for (const f of flows) f.update(t);
      }
    },
    setMotion(animate) {
      setStatic(!animate);
    },
    setVisible(on) {
      group.visible = on;
      labels.sync(on, step);
    },
    onPalette(p) {
      applyPalette(p);
      draw();
    },
    onQuality: setCounts,
    pose: (s) => (portrait ? env.unfit(PORT[s] ?? PORT[0]!) : (POSES[s] ?? null)),
    onResize(pt) {
      if (pt !== portrait || isNarrow(pt) !== narrow) layout(pt);
    },
  };
}

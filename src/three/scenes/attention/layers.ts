/**
 * Variant `layers`: a stack of Transformer blocks. Each token rides its own vertical residual
 * stream (gold particles). In every block the stream branches into the multi-head attention slab
 * (violet: the only place where tokens exchange information, shown by small arcs between lanes)
 * and then into a per-token feed-forward network (teal boxes: each token is processed on its own),
 * and each branch is added back at a ⊕ node (residual connection). Thin plates mark the
 * normalisation before each sub-layer. Shallow blocks link neighbours; deep blocks link distant
 * tokens (示意). At the top the output layer turns the last position into next-token
 * probabilities (示意).
 *
 * Steps: 0 總覽 (whole stack), 6 層層堆疊 (close-up of one block, with norm / ⊕ / pattern labels).
 * Reduced motion: static dotted streams; arcs without the travelling highlight.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, Palette, SceneContext, SceneInstance } from '../../core/types';
import { ArcRibbons } from '../../kit/ArcRibbons';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { addFloor, consumePending, metaCard, registerAway, tones } from './common';
import { BLOCK_ARCS, NEXT, PREFIX, pct } from './data';
import { lbl, type Lbl } from './labels';

const L = PREFIX.length;
const CHIP_H = 0.18;
const LZ = 0.8; // residual lanes run in front of the modules
const BLOCK_Y = [0.55, 2.17, 4.3] as const;
const BLOCK_NAMES = ['第 1 層', '第 2 層', '第 N 層'];
const ATT = { lo: 0.08, hi: 0.5 }; // attention slab (relative to block y0)
const ADD1 = 0.63;
const FFN = { lo: 0.77, hi: 1.13 };
const ADD2 = 1.27;
const BLOCK_H = 1.42;
const HEAD_Y = BLOCK_Y[2] + BLOCK_H + 0.26; // output layer plate
const BAR_Y0 = HEAD_Y + 0.6;
const BAR_STEP = 0.26;
const SLAB_D = 0.86;

export const LAYER_POSES: Record<string, CameraPose> = {
  home: { position: [3.9, 5.1, 12.6], target: [0.85, 3.3, 0] },
  /** 層層堆疊: the whole stack from the side, so the residual branches (lane → sub-layer → ⊕) read. */
  block: { position: [7.2, 5.0, 12.2], target: [0.85, 3.35, 0] },
};

const m4 = new Matrix4();
const q = new Quaternion();
const vP = new Vector3();
const vS = new Vector3();

export function buildLayers(ctx: SceneContext, stepTitle: (i: number) => string): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'attention-layers';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const floor = addFloor(ctx, root, 7, 0.6, -0.002);

  const LS = 0.92;
  const xs = Array.from({ length: L }, (_, i) => (i - (L - 1) / 2) * LS);
  const W = (L - 1) * LS + 1.05;
  const xL = -W / 2;
  const xR = W / 2;

  /* ───────── chips ───────── */
  const chipGeo = ctx.track(new RoundedBoxGeometry(LS * 0.8, CHIP_H, 0.56, 3, 0.07));
  const chipMat = ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.06 }));
  const chips = new InstancedMesh(chipGeo, chipMat, L);
  xs.forEach((x, i) => chips.setMatrixAt(i, m4.makeTranslation(x, CHIP_H / 2, LZ)));
  chips.setColorAt(0, new Color());
  root.add(chips);
  ctx.track({ dispose: () => chips.dispose() });

  /* ───────── blocks: norm plates, attention slabs, FFN boxes ───────── */
  const slabGeo = ctx.track(new RoundedBoxGeometry(W, ATT.hi - ATT.lo, SLAB_D, 3, 0.1));
  const attMat = materials.glass('optic', 0.2, { roughness: 0.25 });
  const attEdge = materials.glass('optic', 0.5, { roughness: 0.3 });
  const normGeo = ctx.track(new RoundedBoxGeometry(W - 0.1, 0.03, SLAB_D - 0.06, 2, 0.012));
  const normMat = materials.glass('fg', 0.18);
  const ffnGeo = ctx.track(new RoundedBoxGeometry(LS * 0.54, FFN.hi - FFN.lo, 0.46, 3, 0.07));
  const ffnMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.92 }));
  const ffn = new InstancedMesh(ffnGeo, ffnMat, L * BLOCK_Y.length);
  const nB = BLOCK_Y.length;
  const slabs = new InstancedMesh(slabGeo, attMat, nB);
  slabs.renderOrder = 3;
  const bases = new InstancedMesh(normGeo, attEdge, nB); // a brighter floor so the slab reads in light theme
  const norms = new InstancedMesh(normGeo, normMat, nB * 2);
  norms.renderOrder = 2;
  BLOCK_Y.forEach((y0, b) => {
    slabs.setMatrixAt(b, m4.makeTranslation(0, y0 + (ATT.lo + ATT.hi) / 2, 0));
    bases.setMatrixAt(b, m4.compose(vP.set(0, y0 + ATT.lo + 0.016, 0), q.identity(), vS.set(1, 0.6, 1)));
    norms.setMatrixAt(b * 2, m4.makeTranslation(0, y0 + ATT.lo - 0.05, 0));
    norms.setMatrixAt(b * 2 + 1, m4.makeTranslation(0, y0 + FFN.lo - 0.06, 0));
    xs.forEach((x, i) => ffn.setMatrixAt(b * L + i, m4.makeTranslation(x, y0 + (FFN.lo + FFN.hi) / 2, 0)));
  });
  ffn.setColorAt(0, new Color());
  root.add(slabs, bases, norms, ffn);
  for (const m of [ffn, slabs, bases, norms]) ctx.track({ dispose: () => m.dispose() });

  /* ───────── residual lanes + ⊕ nodes ───────── */
  const laneTop = HEAD_Y - 0.05;
  const gapLo = BLOCK_Y[1] + BLOCK_H + 0.08;
  const gapHi = BLOCK_Y[2] - 0.08;
  const lanePos: number[] = [];
  for (const x of xs) {
    lanePos.push(x, CHIP_H, LZ, x, gapLo, LZ, x, gapHi, LZ, x, laneTop, LZ);
  }
  const laneGeo = ctx.track(new BufferGeometry());
  laneGeo.setAttribute('position', new Float32BufferAttribute(lanePos, 3));
  const laneMat = materials.line('highlight', { transparent: true, opacity: 0.55 });
  const lanes = new LineSegments(laneGeo, laneMat);
  root.add(lanes);
  // dotted "more layers" between block 2 and block N
  const dotGeo = ctx.track(new SphereGeometry(0.035, 10, 8));
  const dotMat = materials.basic('muted');
  const dots = new InstancedMesh(dotGeo, dotMat, L * 3);
  xs.forEach((x, i) => {
    for (let k = 0; k < 3; k++) dots.setMatrixAt(i * 3 + k, m4.makeTranslation(x, gapLo + ((k + 1) * (gapHi - gapLo)) / 4, LZ));
  });
  root.add(dots);
  ctx.track({ dispose: () => dots.dispose() });

  const ringGeo = ctx.track(new TorusGeometry(0.062, 0.011, 8, 28));
  const plusGeo = ctx.track(new BoxGeometry(0.074, 0.012, 0.012));
  const addMat = materials.basic('fg', { transparent: true, opacity: 0.6 });
  const nAdd = L * BLOCK_Y.length * 2;
  const rings = new InstancedMesh(ringGeo, addMat, nAdd);
  const plus = new InstancedMesh(plusGeo, addMat, nAdd * 2);
  const addPts: Vector3[] = [];
  BLOCK_Y.forEach((y0) => xs.forEach((x) => addPts.push(new Vector3(x, y0 + ADD1, LZ), new Vector3(x, y0 + ADD2, LZ))));
  const rotZ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  addPts.forEach((p, i) => {
    rings.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z));
    plus.setMatrixAt(i * 2, m4.compose(p, q.identity(), vS.set(1, 1, 1)));
    plus.setMatrixAt(i * 2 + 1, m4.compose(p, rotZ, vS.set(1, 1, 1)));
  });
  root.add(rings, plus);
  ctx.track({ dispose: () => rings.dispose() });
  ctx.track({ dispose: () => plus.dispose() });

  /* ───────── attention arcs inside each slab ───────── */
  const nArcs = BLOCK_ARCS.reduce((s, a) => s + a.length, 0);
  const arcs = ctx.track(new ArcRibbons({ count: nArcs, segments: 32, flow: 0.45, theme: ctx.theme }));
  arcs.object.material.side = DoubleSide; // see proposals/scene-attention.yaml
  arcs.object.material.forceSinglePass = true;
  root.add(arcs.object);
  const setArcs = (p: Palette) => {
    const list = BLOCK_ARCS.flatMap((blk, b) =>
      blk.map(([j, i, w]) => {
        const d = Math.abs(xs[i]! - xs[j]!);
        return {
          start: [xs[j]!, BLOCK_Y[b]! + ATT.lo + 0.1, -0.08] as const,
          end: [xs[i]!, BLOCK_Y[b]! + ATT.lo + 0.1, -0.08] as const,
          height: 0.05 + 0.05 * d,
          width: 0.028 + 0.05 * w,
          color: p.optic,
          // dark theme blends additively over the violet slab: full alpha burns the long arcs white
          alpha: (0.45 + 0.55 * w) * (p.theme === 'dark' ? 0.7 : 1),
        };
      }),
    );
    arcs.setArcs(list);
  };

  /* ───────── output layer + next-token bars ───────── */
  const headGeo = ctx.track(new RoundedBoxGeometry(W, 0.1, SLAB_D, 2, 0.04));
  const headMat = materials.glass('highlight', 0.22);
  const headPlate = new Mesh(headGeo, headMat);
  headPlate.position.set(0, HEAD_Y, 0.2);
  root.add(headPlate);
  const barGeo = ctx.track(new RoundedBoxGeometry(1, 0.17, 0.17, 2, 0.05));
  const barMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.08 }));
  const bars = new InstancedMesh(barGeo, barMat, NEXT.length);
  const xLast = xs[L - 1]!;
  // Landscape: the bars sit right of the stack. Portrait: shorter bars that start just right of
  // the last lane, so the labels stay inside a 4:5 frame.
  let portrait = ctx.size.aspect < 0.9;
  let barX0 = xR + 0.3;
  let barLen = 2.3;
  const barY = (r: number) => BAR_Y0 - r * BAR_STEP;
  bars.setColorAt(0, new Color());
  root.add(bars);
  ctx.track({ dispose: () => bars.dispose() });
  const stemGeo = ctx.track(new BufferGeometry());
  const stemPos = new Float32BufferAttribute(new Float32Array(6 * 3), 3);
  stemGeo.setAttribute('position', stemPos);
  const stem = new LineSegments(stemGeo, laneMat);
  root.add(stem);

  /* ───────── particles: residual stream + sub-layer branches ───────── */
  type Kind = 'main' | 'att' | 'ffn';
  const kinds: Kind[] = [];
  const paths: FlowPath[] = [];
  xs.forEach((x) => {
    paths.push({ points: [[x, CHIP_H + 0.02, LZ], [x, laneTop, LZ]], weight: 1.4, speed: 1 });
    kinds.push('main');
    BLOCK_Y.forEach((y0) => {
      const branch = (lo: number, mid: number, hi: number, kind: Kind) => {
        paths.push({
          points: [
            [x, y0 + lo, LZ],
            [x, y0 + lo + 0.06, LZ - 0.32],
            [x, y0 + mid, 0.06],
            [x, y0 + hi - 0.06, LZ - 0.32],
            [x, y0 + hi, LZ],
          ],
          weight: 1.6,
          speed: 0.55,
        });
        kinds.push(kind);
      };
      branch(ATT.lo - 0.12, (ATT.lo + ATT.hi) / 2, ADD1, 'att');
      branch(ADD1, (FFN.lo + FFN.hi) / 2, ADD2, 'ffn');
    });
  });
  const FLOW_MAX = 760;
  const flow = ctx.track(
    new PathFlow({ paths, count: FLOW_MAX, size: 0.07, speed: 0.75, speedVariance: 0.2, fadeEnds: 0.05, theme: ctx.theme, seed: 21 }),
  );
  flow.setCount(scaleCount(FLOW_MAX, ctx.tier, 120));
  flow.setReduced(!ctx.animate);
  root.add(flow.object);

  const glows = ctx.track(new GlowSprites({ count: 2, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── labels ───────── */
  const tokL: Lbl[] = PREFIX.map((t, i) =>
    lbl(labels, { text: t, position: [xs[i]!, CHIP_H + 0.02, LZ + 0.1], kind: 'strong', priority: 40, hotspot: 'tokens' }),
  );
  const blockL: Lbl[] = BLOCK_Y.map((y0, b) =>
    lbl(labels, { text: BLOCK_NAMES[b]!, position: [xL - 0.12, y0 + BLOCK_H / 2, 0], align: 'left', kind: 'strong', priority: 36, hotspot: 'transformer-block' }),
  );
  const attL: Lbl[] = BLOCK_Y.map((y0, b) =>
    lbl(labels, { text: '多頭注意力', position: [xR + 0.08, y0 + (ATT.lo + ATT.hi) / 2, 0], align: 'right', priority: b === 0 ? 30 : 14, hotspot: 'transformer-block' }),
  );
  const ffnL: Lbl[] = BLOCK_Y.map((y0, b) =>
    lbl(labels, { text: '前饋網路 FFN', position: [xR + 0.08, y0 + (FFN.lo + FFN.hi) / 2, 0], align: 'right', priority: b === 0 ? 29 : 13, hotspot: 'ffn' }),
  );
  const addL = lbl(labels, { text: '⊕ 殘差相加', position: [xs[0]! - 0.12, BLOCK_Y[0] + ADD1, LZ], align: 'left', kind: 'tag', priority: 24, hotspot: 'residual' });
  const streamL = lbl(labels, { text: '殘差串流', position: [xs[0]! - 0.1, (gapLo + gapHi) / 2, LZ], align: 'left', kind: 'tag', priority: 18, hotspot: 'residual' });
  const normL: Lbl[] = [ATT.lo - 0.05, FFN.lo - 0.06].map((ny) =>
    lbl(labels, { text: '正規化', position: [xL + 0.1, BLOCK_Y[0] + ny, SLAB_D / 2], align: 'left', kind: 'tag', priority: 20, visible: false }),
  );
  const patL: Lbl[] = [
    lbl(labels, { text: '淺層：多看鄰近 Token', position: [xR + 0.08, BLOCK_Y[0] + ATT.lo - 0.02, 0], align: 'right', offset: [0, 10], kind: 'tag', priority: 19, visible: false, hotspot: 'transformer-block' }),
    lbl(labels, { text: '深層：連結遠處語意', position: [xR + 0.08, BLOCK_Y[2] + ATT.lo - 0.02, 0], align: 'right', offset: [0, 10], kind: 'tag', priority: 12, hotspot: 'transformer-block' }),
  ];
  const ffnNoteL = lbl(labels, { text: '每個 Token 各自加工', position: [xR + 0.08, BLOCK_Y[0] + FFN.lo - 0.02, 0], align: 'right', offset: [0, 10], kind: 'tag', priority: 18, visible: false, hotspot: 'ffn' });
  const moreL = lbl(labels, { text: '⋮ 中間還有許多層', position: [xR + 0.08, (gapLo + gapHi) / 2, 0], align: 'right', kind: 'muted', priority: 22 });
  const headL = lbl(labels, { text: '輸出層', position: [xL - 0.12, HEAD_Y, 0.2], align: 'left', kind: 'strong', priority: 34, hotspot: 'next-token' });
  const lastL = lbl(labels, { text: '只用最後一個位置預測下一個 Token', position: [xL - 0.12, HEAD_Y, 0.2], align: 'left', offset: [0, 32], kind: 'tag', priority: 20, hotspot: 'next-token' });
  const barL: Lbl[] = NEXT.map((c, r) =>
    lbl(labels, {
      text: `${c.text} ${pct(c.p)}`,
      position: [0, barY(r), LZ],
      align: 'right',
      offset: [-2, 0],
      kind: r === 0 ? 'strong' : 'default',
      // the runner-up bars rank below the 注意力 / FFN names so low-tier label budgets keep the structure
      priority: r === 0 ? 33 : 22 - r,
      hotspot: 'next-token',
    }),
  );
  const noteL = lbl(labels, { text: '下一個 Token 的機率（示意）', position: [0, barY(0) + 0.14, LZ], align: 'above', offset: [60, 0], kind: 'tag', priority: 21, hotspot: 'next-token' });

  const layoutBars = () => {
    barX0 = portrait ? xLast + 0.28 : xR + 0.3;
    barLen = portrait ? 1.35 : 2.3;
    NEXT.forEach((c, r) => {
      const len = Math.max(0.06, c.p * barLen);
      bars.setMatrixAt(r, m4.compose(vP.set(barX0 + len / 2, barY(r), LZ), q.identity(), vS.set(len, 1, 1)));
      barL[r]!.h.set({ position: [barX0 + len, barY(r), LZ] });
    });
    bars.instanceMatrix.needsUpdate = true;
    bars.computeBoundingSphere();
    const sx = barX0 - 0.06;
    stemPos.array.set([xLast, HEAD_Y + 0.05, LZ, xLast, barY(0), LZ, xLast, barY(0), LZ, sx, barY(0), LZ, sx, barY(0) + 0.12, LZ, sx, barY(NEXT.length - 1) - 0.12, LZ]);
    stemPos.needsUpdate = true;
    stemGeo.computeBoundingSphere();
    noteL.h.set({ position: [sx, barY(0) + 0.14, LZ], offset: portrait ? [20, 0] : [60, 0] });
  };
  layoutBars();

  /* ───────── palette ───────── */
  let lastPalette = ctx.palette;
  const applyPalette = (p: Palette) => {
    const T = tones(p);
    lights.apply(p);
    floor.apply(p);
    const c = new Color();
    for (let i = 0; i < L; i++) chips.setColorAt(i, T.chip);
    for (let i = 0; i < L * BLOCK_Y.length; i++) ffn.setColorAt(i, c.copy(p.flow).lerp(T.chip, T.dark ? 0.15 : 0.1));
    ffnMat.emissive.copy(p.flow).multiplyScalar(T.dark ? 0.22 : 0.04);
    NEXT.forEach((_, r) => bars.setColorAt(r, r === 0 ? p.highlight : c.copy(T.cube).lerp(p.fg, T.dark ? 0.15 : 0.25)));
    barMat.emissive.copy(p.highlight).multiplyScalar(T.dark ? 0.18 : 0);
    for (const m of [chips, ffn, bars]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    attMat.opacity = T.dark ? 0.2 : 0.15;
    attEdge.opacity = T.dark ? 0.5 : 0.22;
    normMat.opacity = T.dark ? 0.16 : 0.09;
    laneMat.opacity = T.dark ? 0.45 : 0.6;
    headMat.opacity = T.dark ? 0.2 : 0.28;
    setArcs(p);
    arcs.setTheme(p.theme);
    flow.recolor((i) => (kinds[i] === 'att' ? p.optic : kinds[i] === 'ffn' ? p.flow : p.highlight));
    flow.setTheme(p.theme);
    flow.setSize(T.dark ? 0.058 : 0.052);
    flow.setOpacity(T.dark ? 0.78 : 0.9);
    glows.setTheme(p.theme);
    glows.set(0, [xLast, HEAD_Y + 0.05, LZ], 1.0, p.highlight, T.dark ? 0.6 : 0.3);
    glows.set(1, [barX0 + NEXT[0]!.p * barLen, barY(0), LZ], 0.9, p.highlight, T.dark ? 0.5 : 0.25);
    lastPalette = p;
    attL.forEach((l) => l.swatch(p.css['scene-optic'] ?? ''));
    ffnL.forEach((l) => l.swatch(p.css['scene-flow'] ?? ''));
  };
  applyPalette(ctx.palette);

  /* ───────── hotspots ───────── */
  hotspots.register('tokens', {
    object: chips,
    anchor: [xs[0]!, CHIP_H, LZ],
    pose: LAYER_POSES['block']!,
    onHighlight: () => {},
    card: (hit) => {
      const i = hit?.instanceId ?? 0;
      return {
        title: `「${PREFIX[i]}」（第 ${i + 1} 個 Token）`,
        body: '每個 Token 沿著自己的殘差串流（金色光點）一路往上：在注意力層和其他 Token 交換資訊，在前饋網路各自加工，再加回串流。',
      };
    },
  });
  hotspots.register('transformer-block', {
    object: slabs,
    anchor: [0, BLOCK_Y[0] + BLOCK_H / 2, 0],
    pose: LAYER_POSES['block']!,
    onHighlight: (on) => ctx.tween.to(attMat, { opacity: on ? 0.42 : ctx.theme === 'dark' ? 0.2 : 0.15 }, { duration: 200, fade: true }),
    card: () => metaCard(ctx, 'transformer-block'),
  });
  hotspots.register('ffn', {
    object: ffn,
    anchor: [xs[L - 1]!, BLOCK_Y[0] + FFN.hi, 0],
    pose: LAYER_POSES['block']!,
    onHighlight: (on) => ctx.tween.to(ffnMat, { opacity: on ? 1 : 0.92 }, { duration: 200, fade: true }),
    card: () => metaCard(ctx, 'ffn'),
  });
  hotspots.register('residual', {
    anchor: [xs[0]!, BLOCK_Y[0] + ADD1, LZ],
    pose: LAYER_POSES['block']!,
    onHighlight: (on) => ctx.tween.to(laneMat, { opacity: on ? 1 : ctx.theme === 'dark' ? 0.45 : 0.6 }, { duration: 200, fade: true }),
    card: () => metaCard(ctx, 'residual'),
  });
  hotspots.register('next-token', {
    object: bars,
    anchor: [barX0 + 0.8, barY(1), LZ],
    pose: LAYER_POSES['home']!,
    onHighlight: () => {},
    card: () => metaCard(ctx, 'next-token'),
  });
  registerAway(ctx, new Set(['tokens', 'transformer-block', 'ffn', 'residual', 'next-token']), [0, BLOCK_Y[1] + 0.7, 0], stepTitle);

  // landscape side view (step 6): ADD1 projects onto 「第 1 層」, so the tag moves up to the ⊕ above the FFN
  let sideView = false;
  const placeAdd = () => addL.h.set({ position: [xs[0]! - 0.12, BLOCK_Y[0] + (sideView && !portrait ? ADD2 : ADD1), LZ] });

  const applyStep = (i: number) => {
    const detail = i === 6;
    // one 正規化 tag names both (identical) plates: the FFN plate sits level with 「第 1 層」
    normL[0]!.vis(detail);
    normL[1]!.vis(false);
    patL[0]!.vis(detail);
    ffnNoteL.vis(detail);
    addL.prio(detail ? 32 : 24);
    sideView = detail;
    placeAdd();
    streamL.vis(true);
    headL.vis(true);
    lastL.vis(!detail);
    moreL.vis(true);
    blockL.forEach((l) => l.vis(true));
    tokL.forEach((l) => l.vis(true));
    barL.forEach((l) => l.vis(true));
    ctx.setPose(detail ? LAYER_POSES['block']! : ctx.homePose);
  };

  return {
    update(_dt, t) {
      flow.update(t);
      arcs.update(t);
    },
    setStep(i) {
      applyStep(i);
      consumePending(ctx);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onQuality(_q, tier) {
      flow.setCount(scaleCount(FLOW_MAX, tier, 120));
    },
    onMotion(animate) {
      flow.setReduced(!animate);
    },
    onResize(size) {
      const next = size.aspect < 0.9;
      if (next === portrait) return;
      portrait = next;
      layoutBars();
      placeAdd();
      applyPalette(lastPalette);
    },
    dispose() {
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

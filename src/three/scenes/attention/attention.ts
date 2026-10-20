/**
 * Variant `attention`: a sentence becomes tokens → embedding columns → Q/K/V columns; the focused
 * token's attention weights are arcs (ArcRibbons) whose width and opacity follow the weight; four
 * heads fan out in their own colours; the KV-cache step moves cached K/V columns into a tray and
 * generates one new token that only computes its own Q/K/V.
 *
 * Steps handled here: 0 總覽, 1 切成 Token, 2 嵌入向量, 3 Q、K、V, 4 注意力權重, 5 多頭注意力, 8 KV 快取
 * (6 and 7 belong to the `layers` / `moe` variants; if they arrive here the overview is shown).
 * Reduced motion: no auto-cycling, no loops, every step shows its final state.
 */
import {
  Color,
  DoubleSide,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, CardContent, Palette, PickHit, SceneContext, SceneInstance } from '../../core/types';
import { ArcRibbons, type Arc } from '../../kit/ArcRibbons';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { addFloor, arcPoints, clamp01, consumePending, lerp, metaCard, registerAway, roundedRect, smooth, tones, type Tones } from './common';
import { DIM, HEAD_DIM, HEAD_SPECS, HEADS, N_TOK, TOKEN_IDS, TOKENS, WEIGHTS, emb, pct, qkvVal } from './data';
import { lbl, type Lbl } from './labels';

/* ───────── layout ───────── */
const CHIP_W = 1.0;
const CHIP_H = 0.2;
const CHIP_D = 0.62;
const CUBE = 0.15;
const PITCH = 0.19;
const Y0 = 0.44;
const colY = (k: number) => Y0 + k * PITCH;
const TOP = colY(DIM - 1) + CUBE / 2;
const AY = TOP + 0.13; // arc anchor height
const CACHE_Z = -1.05;
const STAGE_D = 2.75;
const STAGE_Z = -0.42;
const CPT = DIM * 4; // cubes per token: E + Q + K + V
const FAN = [-0.6, -0.2, 0.2, 0.6]; // head fan tilt (radians) in the multi-head step
const CYCLE = [5, 3, 4, 2] as const; // overview auto-focus order
const KV_PERIOD = 7.6;
/**
 * Arc landing offset at the query: the arcs fan out a little across the top of the query column
 * (by source token, and by head in the multi-head step) instead of meeting in one point, where the
 * dark theme's additive ribbons would sum to a white blot.
 */
const landX = (j: number, f: number, h = 0, multi = 0) => (f > 0 ? (j / f - 0.5) * 0.12 : 0) + (h - 1.5) * 0.045 * multi;
const SPLIT_PERIOD = 5.2;

interface Cfg {
  split: number;
  emb: number;
  qkv: number;
  heads: number;
  cache: number;
  arcs: number;
  multi: number;
  mask: number;
  vflow: number;
  focus: number;
  cycle: boolean;
  /** 0 none, 1 major weights only, 2 all */
  pct: 0 | 1 | 2;
  pos: boolean;
  /** Vocabulary ids under the chips (step 1). */
  ids: boolean;
  sentence: boolean;
  legendQKV: boolean;
  legendHeads: boolean;
  /** Small explanatory tags: 'emb' colour legend, 'qkv' projection, 'softmax' formula. */
  note: '' | 'emb' | 'qkv' | 'softmax';
  /** Title over the focused token (overview). */
  focusTitle: boolean;
  out: boolean;
  kv: boolean;
  splitLoop: boolean;
  pose: CameraPose | null;
}

const BASE: Cfg = {
  split: 1,
  emb: 1,
  qkv: 0,
  heads: 0,
  cache: 0,
  arcs: 1,
  multi: 0,
  mask: 0,
  vflow: 0,
  focus: 5,
  cycle: true,
  pct: 1,
  pos: false,
  ids: false,
  sentence: false,
  legendQKV: false,
  legendHeads: false,
  note: '',
  focusTitle: true,
  out: false,
  kv: false,
  splitLoop: false,
  pose: null,
};

export const ATTN_POSES: Record<string, CameraPose> = {
  home: { position: [2.1, 3.7, 8.9], target: [0.1, 1.42, 0] },
  tokens: { position: [0.4, 3.9, 7.7], target: [0, 0.5, -0.2] },
  emb: { position: [1.5, 3.2, 8.9], target: [0, 1.0, 0] },
  qkv: { position: [2.0, 3.2, 8.7], target: [0.1, 1.05, 0] },
  weights: { position: [0.6, 3.6, 9.1], target: [0, 1.55, 0] },
  heads: { position: [2.4, 5.6, 8.4], target: [0, 1.75, 0] },
  kv: { position: [4.2, 4.5, 8.0], target: [0.35, 1.2, -0.45] },
  /** Portrait KV view: more frontal, so the new token's Q column does not slide over the cache. */
  kvPortrait: { position: [1.5, 4.7, 8.7], target: [0.3, 1.25, -0.45] },
};

/**
 * Portrait stages are tall: the row of tokens fixes the width and leaves sky above it. Lower the
 * camera and its target together (the content rises to the middle of the frame) and back off a
 * little so the stage keeps a margin. The host then scales the distance for the portrait FOV.
 */
const portraitPose = (p: CameraPose, dist = 1.06, lift = 0.6): CameraPose => {
  const [px, py, pz] = p.position as readonly number[] as [number, number, number];
  const [tx, ty, tz] = p.target as readonly number[] as [number, number, number];
  return {
    ...p,
    position: [tx + (px - tx) * dist, ty + (py - ty) * dist - lift, tz + (pz - tz) * dist],
    target: [tx, ty - lift, tz],
  };
};

const STEP_CFG: Record<number, Partial<Cfg>> = {
  0: {},
  1: { emb: 0, arcs: 0, cycle: false, pct: 0, sentence: true, ids: true, splitLoop: true, focusTitle: false, pose: ATTN_POSES['tokens']! },
  2: { arcs: 0, cycle: false, pct: 0, pos: true, note: 'emb', focusTitle: false, pose: ATTN_POSES['emb']! },
  3: { qkv: 1, arcs: 0, cycle: false, pct: 0, legendQKV: true, note: 'qkv', focusTitle: false, pose: ATTN_POSES['qkv']! },
  4: { qkv: 1, mask: 1, vflow: 1, focus: 3, cycle: false, pct: 2, legendQKV: true, note: 'softmax', focusTitle: false, out: true, pose: ATTN_POSES['weights']! },
  5: { qkv: 1, heads: 1, multi: 1, mask: 1, cycle: false, pct: 0, legendHeads: true, focusTitle: false, pose: ATTN_POSES['heads']! },
  8: { qkv: 1, cache: 1, cycle: false, pct: 0, kv: true, legendQKV: true, focusTitle: false, pose: ATTN_POSES['kv']! },
};

type Num = 'split' | 'emb' | 'qkv' | 'heads' | 'cache' | 'arcs' | 'multi' | 'mask' | 'vflow';
const NUMS: readonly Num[] = ['split', 'emb', 'qkv', 'heads', 'cache', 'arcs', 'multi', 'mask', 'vflow'];

const m4 = new Matrix4();
const qI = new Quaternion();
const vPos = new Vector3();
const vScl = new Vector3();
const vA = new Vector3();
const vB = new Vector3();
const tmpC = new Color();
const tmpC2 = new Color();

export function buildAttention(ctx: SceneContext, stepTitle: (i: number) => string): SceneInstance {
  const { scene, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'attention';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const floor = addFloor(ctx, root, 7.5, 0.6, -0.12);

  // Portrait (phones): a tighter row, taller arcs, and the legends move under the stage.
  let portrait = ctx.size.aspect < 0.9;
  const sp = () => (portrait ? 0.84 : 1.32);
  const colDx = () => (portrait ? 0.19 : 0.25);
  const chipScale = () => (portrait ? 0.72 : 1);
  const arcH = (d: number) => (0.2 + 0.19 * d) * (portrait ? 1.35 : 1);
  // portrait arcs come down steeply and nearly on top of each other: fan their landings wider
  const landK = () => (portrait ? 1.6 : 1);

  /* ───────── state ───────── */
  const S: Record<Num, number> = { split: 1, emb: 1, qkv: 0, heads: 0, cache: 0, arcs: 1, multi: 0, mask: 0, vflow: 0 };
  let cfg: Cfg = { ...BASE };
  let focus = 5;
  let arcGrow = 1;
  let kvT = KV_PERIOD; // KV loop clock (final state = end)
  let splitT = SPLIT_PERIOD;
  let cycleT = 0;
  let cycleIdx = 0;
  let holdUntil = 0;
  let clock = 0;

  const xBase = (i: number) => (i - (N_TOK - 1) / 2) * sp();
  /** Effective token x (split animation squeezes the row into one "sentence bar"). */
  const splitEff = () => (cfg.splitLoop && ctx.animate ? smooth(1.3, 2.3, splitT) : S.split);
  const xOf = (i: number) => xBase(i) * lerp((CHIP_W * chipScale() + 0.02) / sp(), 1, splitEff());
  const kvDrop = () => (cfg.kv ? 1 - smooth(0, 0.8, kvT) : 0);
  const kvGrow = () => (cfg.kv ? smooth(0.9, 2.0, kvT) : 1);
  // decode step: new token → its Q/K/V → K/V appended to the cache → Q attends over the whole cache
  const kvSlide = () => (cfg.kv ? smooth(2.2, 3.3, kvT) : 0);
  const kvArc = () => (cfg.kv ? smooth(3.5, 4.6, kvT) : 1);
  const cacheOf = (i: number) => (i === N_TOK - 1 && cfg.kv ? kvSlide() * S.cache : i < N_TOK - 1 ? S.cache : 0);
  const qkvOf = (i: number) => (i === N_TOK - 1 && cfg.kv ? kvGrow() : 1);

  /* ───────── stage platform (the "theatre") ───────── */
  const stageMat = ctx.track(new MeshStandardMaterial({ roughness: 0.62, metalness: 0.02 }));
  const stageGeo = (w: number) => {
    const g = new ExtrudeGeometry(roundedRect(w, STAGE_D, 0.42), { depth: 0.06, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.025, bevelSegments: 3, curveSegments: 8 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, -0.085, STAGE_Z);
    return g;
  };
  const stageW = () => (N_TOK - 1) * sp() + (portrait ? 1.25 : 2.0);
  const stage = new Mesh(stageGeo(stageW()), stageMat);
  ctx.track({ dispose: () => stage.geometry.dispose() });
  root.add(stage);

  /* ───────── chips ───────── */
  const chipGeo = ctx.track(new RoundedBoxGeometry(CHIP_W, CHIP_H, CHIP_D, 3, 0.075));
  const chipMat = ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.06 }));
  const chips = new InstancedMesh(chipGeo, chipMat, N_TOK);
  chips.instanceMatrix.setUsage(DynamicDrawUsage);
  chips.setColorAt(0, new Color());
  chips.frustumCulled = false;
  root.add(chips);
  ctx.track({ dispose: () => chips.dispose() });

  /* ───────── cubes: E, Q, K, V per token ───────── */
  const cubeGeo = ctx.track(new RoundedBoxGeometry(CUBE, CUBE, CUBE, 2, 0.032));
  const cubeMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 }));
  const cubes = new InstancedMesh(cubeGeo, cubeMat, N_TOK * CPT);
  cubes.instanceMatrix.setUsage(DynamicDrawUsage);
  cubes.setColorAt(0, new Color());
  cubes.frustumCulled = false;
  root.add(cubes);
  ctx.track({ dispose: () => cubes.dispose() });

  /* ───────── KV cache tray ───────── */
  const trayGeo = ctx.track(new RoundedBoxGeometry(1, TOP - Y0 + 0.42, 0.62, 3, 0.09));
  const trayMat = ctx.materials.glass('flow', 0.12, { roughness: 0.2 });
  const tray = new Mesh(trayGeo, trayMat);
  tray.renderOrder = 2;
  root.add(tray);
  const trayEdgeMat = ctx.materials.basic('flow', { transparent: true, opacity: 0.5, depthWrite: false });
  const trayBase = new Mesh(ctx.track(new RoundedBoxGeometry(1, 0.05, 0.7, 2, 0.02)), trayEdgeMat);
  root.add(trayBase);

  /* ───────── arcs (one ArcRibbons per head so each head can tilt) ───────── */
  const heads = HEAD_SPECS.map(() => {
    const a = ctx.track(new ArcRibbons({ count: N_TOK, segments: 40, flow: 0.32, theme: ctx.theme }));
    a.object.material.side = DoubleSide; // kit default FrontSide culls left→right ribbons (proposals/scene-attention.yaml)
    a.object.material.forceSinglePass = true;
    root.add(a.object);
    return a;
  });
  const arcSpec: Arc = { start: vA, end: vB, height: 0.3, width: 0.04, color: new Color(), alpha: 1, progress: 1 };

  /* ───────── glows ───────── */
  const glows = ctx.track(new GlowSprites({ count: 3, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── V flow (step 4): values travel along the arcs into the query ───────── */
  let vflow: PathFlow | null = null;
  let vflowKey = '';
  // A few V "packets" per arc: dense streams hid the weight ribbons (light) or burned them white (dark).
  const VFLOW_MAX = 64;
  const rebuildVFlow = () => {
    const key = `${focus}|${portrait}|${ctx.theme}`;
    if (vflow && key === vflowKey) return;
    vflow?.dispose();
    vflow = null;
    vflowKey = key;
    if (focus < 1) return;
    const up = new Vector3(0, 1, 0);
    const paths = [];
    for (let j = 0; j < focus; j++) {
      const w = WEIGHTS[0]![focus]![j]!;
      const s = new Vector3(xBase(j), AY, 0);
      const e = new Vector3(xBase(focus) - colDx() + landX(j, focus) * landK(), AY, 0);
      paths.push({ points: arcPoints(s, e, up, arcH(Math.abs(e.x - s.x)), 14), weight: Math.max(0.04, w), color: ctx.palette.optic });
    }
    vflow = new PathFlow({
      paths,
      count: scaleCount(VFLOW_MAX, ctx.tier, 40),
      size: ctx.theme === 'dark' ? 0.068 : 0.058,
      speed: 1.25,
      speedVariance: 0.1,
      smooth: false,
      byLength: false,
      fadeEnds: 0.08,
      theme: ctx.theme,
      seed: 5,
    });
    vflow.setReduced(!ctx.animate);
    vflow.object.renderOrder = 9;
    root.add(vflow.object);
  };

  /* ───────── anchors for labels / hotspots ───────── */
  const tokAnchor = Array.from({ length: N_TOK }, () => new Object3D());
  const keyAnchor = Array.from({ length: N_TOK }, () => new Object3D());
  const focusAnchor = new Object3D();
  const leftAnchor = new Object3D();
  const rightAnchor = new Object3D();
  const cacheAnchor = new Object3D();
  const maskAnchor = new Object3D();
  /** Portrait legend area, just in front of the stage. */
  const belowAnchor = new Object3D();
  belowAnchor.position.set(0, -0.1, STAGE_Z + STAGE_D / 2 + 0.05);
  root.add(...tokAnchor, ...keyAnchor, focusAnchor, leftAnchor, rightAnchor, cacheAnchor, maskAnchor, belowAnchor);

  /* ───────── labels ───────── */
  const tokL: Lbl[] = TOKENS.map((t, i) =>
    lbl(labels, { text: t, object: tokAnchor[i]!, position: [0, CHIP_H + 0.02, 0.12], kind: 'strong', priority: 40, hotspot: 'tokens' }),
  );
  const posL: Lbl[] = TOKENS.map((_, i) =>
    lbl(labels, { text: `位置 ${i + 1}`, object: tokAnchor[i]!, position: [0, 0, CHIP_D / 2], align: 'below', offset: [0, 2], kind: 'tag', priority: 12, visible: false }),
  );
  const wL: Lbl[] = TOKENS.map((_, i) =>
    lbl(labels, { text: '', object: keyAnchor[i]!, align: 'above', offset: [0, -2], kind: 'default', priority: 22, visible: false, hotspot: 'attention-weights' }),
  );
  const sentenceL = lbl(labels, { text: '台積電為輝達生產 AI 晶片', position: [0, 1.25, 0], kind: 'strong', priority: 50, always: true, visible: false });
  const tokenizerL = lbl(labels, {
    text: '分詞器（Tokenizer）把句子切成 Token，再換成詞彙表裡的編號（示意）',
    position: [0, 0.82, 0],
    kind: 'muted',
    priority: 45,
    visible: false,
  });
  const stageTok = lbl(labels, { text: 'Token', object: leftAnchor, position: [0, CHIP_H / 2, 0], align: 'left', kind: 'strong', priority: 34, hotspot: 'tokens' });
  const stageEmb = lbl(labels, { text: '嵌入向量', object: leftAnchor, position: [0, colY(4), 0], align: 'left', kind: 'strong', priority: 33, hotspot: 'embedding' });
  const stageAttn = lbl(labels, { text: '注意力', object: leftAnchor, position: [0, AY + 0.55, 0], align: 'left', kind: 'strong', priority: 33, hotspot: 'attention-weights' });
  const qkvNames = ['Q 查詢（Query）', 'K 鍵（Key）', 'V 值（Value）'];
  const qkvL: Lbl[] = qkvNames.map((t, m) =>
    lbl(labels, { text: t, object: leftAnchor, position: [0, colY(6 - m * 2.4), 0], align: 'left', kind: 'default', priority: 32, visible: false, hotspot: 'qkv' }),
  );
  const headL: Lbl[] = HEAD_SPECS.map((h, i) =>
    lbl(labels, { text: `頭 ${i + 1}：${h.name}`, object: rightAnchor, position: [0, 0.95 - i * 0.36, 0], align: 'right', kind: 'default', priority: 31, visible: false, hotspot: 'multi-head' }),
  );
  const maskL = lbl(labels, { text: '因果遮罩：還看不到後面的 Token', object: maskAnchor, kind: 'tag', priority: 26, visible: false, hotspot: 'attention-weights' });
  const outL = lbl(labels, { text: '輸出 ＝ Σ（權重 × V）', object: focusAnchor, position: [0, 0.1, 0], align: 'above', offset: [0, -42], kind: 'default', priority: 28, visible: false, hotspot: 'attention-weights' });
  // KV cache title + count sit at the tray's top-left corner (clear of the new token on the right).
  const cacheL = lbl(labels, { text: 'KV 快取', object: cacheAnchor, position: [0, 0, 0], align: 'left', kind: 'strong', priority: 36, visible: false, hotspot: 'kv-cache' });
  const cacheNoteL = lbl(labels, { text: '', object: cacheAnchor, position: [0, 0, 0], align: 'left', offset: [0, 36], kind: 'muted', priority: 30, visible: false, hotspot: 'kv-cache' });
  const newL = lbl(labels, { text: '新產生的 Token：只算自己的 Q、K、V', object: tokAnchor[N_TOK - 1]!, position: [0, 0, CHIP_D / 2], align: 'below', offset: [0, 4], kind: 'tag', priority: 29, visible: false, hotspot: 'kv-cache' });
  const noteL = lbl(labels, { text: '權重與數值皆為示意', object: rightAnchor, position: [0, -AY - 0.05, 0.5], align: 'right', kind: 'tag', priority: 3 });
  const focusL = lbl(labels, { text: '', object: focusAnchor, align: 'above', offset: [0, -40], kind: 'strong', priority: 27, visible: false, hotspot: 'attention-weights' });
  const NOTE_TEXT = { emb: '顏色＝數值：藍為正、紅為負（示意 8 維）', qkv: '同一個向量 × 三個權重矩陣 W_Q、W_K、W_V', softmax: '權重 ＝ softmax（Q·K ÷ √d）' } as const;
  const tagL = lbl(labels, { text: '', object: leftAnchor, position: [0, 0, 0], align: 'left', offset: [0, 0], kind: 'tag', priority: 31, visible: false });
  const QKV_SHORT = ['Q 查詢', 'K 鍵', 'V 值'];

  /** Landscape: legends beside the row. Portrait: a compact legend block under the stage. */
  const layoutLabels = () => {
    const P = portrait;
    qkvL.forEach((l, m) => {
      l.text(P ? QKV_SHORT[m]! : qkvNames[m]!);
      l.h.set(P ? { object: belowAnchor, position: [0, 0, 0], align: 'below', offset: [(m - 1) * 88, 0] } : { object: leftAnchor, position: [0, colY(6 - m * 2.4), 0], align: 'left', offset: [0, 0] });
    });
    headL.forEach((l, i) =>
      l.h.set(
        P
          ? { object: belowAnchor, position: [0, 0, 0], align: 'below', offset: [(i % 2 ? 1 : -1) * 80, Math.floor(i / 2) * 34] }
          : { object: rightAnchor, position: [0, 0.95 - i * 0.36, 0], align: 'right', offset: [0, 0] },
      ),
    );
    noteL.h.set(P ? { object: belowAnchor, position: [0, 0, 0], align: 'below', offset: [0, 102] } : { object: rightAnchor, position: [0, -AY - 0.05, 0.5], align: 'right', offset: [0, 0] });
    // portrait arcs are tall and tightly packed: the output formula joins the softmax formula below the stage
    outL.h.set(P ? { object: belowAnchor, position: [0, 0, 0], align: 'below', offset: [0, 68] } : { object: focusAnchor, position: [0, 0.1, 0], align: 'above', offset: [0, -42] });
    // portrait: no room left of the tray, so the title and count stack above its left corner
    cacheL.align(P ? 'above' : 'left', P ? [0, -32] : [0, 0]);
    cacheNoteL.align(P ? 'above' : 'left', P ? [0, 0] : [0, 36]);
  };
  layoutLabels();

  /* ───────── palette ───────── */
  let T: Tones = tones(ctx.palette);
  const qkvHue = [new Color(), new Color(), new Color()];
  const headHue = HEAD_SPECS.map(() => new Color());
  const cPos = new Color();
  const cNeg = new Color();
  const cHi = new Color();
  const cBg = new Color();
  const applyPalette = (p: Palette) => {
    T = tones(p);
    lights.apply(p);
    floor.apply(p);
    qkvHue[0]!.copy(p.highlight);
    qkvHue[1]!.copy(p.flow);
    qkvHue[2]!.copy(p.optic);
    HEAD_SPECS.forEach((h, i) => headHue[i]!.copy(p.chart[h.chart - 1] ?? p.fg));
    cPos.copy(p.flow);
    cNeg.copy(p.heat);
    cHi.copy(p.highlight);
    cBg.copy(p.bg);
    for (const a of heads) a.setTheme(p.theme);
    glows.setTheme(p.theme);
    chipMat.emissive.copy(T.dark ? p.fg : p.bg).multiplyScalar(T.dark ? 0.04 : 0);
    cubeMat.emissive.copy(p.fg).multiplyScalar(T.dark ? 0.05 : 0);
    trayMat.opacity = T.dark ? 0.1 : 0.16;
    stageMat.color.copy(T.dark ? p.bg.clone().lerp(p.fg, 0.08) : p.bg.clone().lerp(p.fg, 0.035));
    qkvL.forEach((l, m) => l.swatch(p.css[['scene-highlight', 'scene-flow', 'scene-optic'][m]!] ?? ''));
    headL.forEach((l, i) => l.swatch(p.css[`chart-${HEAD_SPECS[i]!.chart}`] ?? ''));
    if (vflow) {
      vflowKey = '';
      rebuildVFlow();
    }
  };

  /* ───────── draw ───────── */
  const valueTint = (out: Color, v: number, hue: Color) => out.copy(T.cube).lerp(hue, 0.3 + 0.7 * Math.abs(v));
  const grow = (p: number, k: number) => {
    const g = clamp01(p * 1.7 - k * 0.09);
    return g * g * (3 - 2 * g);
  };

  const draw = () => {
    const f = focus;
    const cs = chipScale();
    const dx = colDx();
    const dark = T.dark;
    const arcVis = S.arcs > 0.01 || S.multi > 0.01;
    // chips
    for (let i = 0; i < N_TOK; i++) {
      const x = xOf(i);
      const drop = i === N_TOK - 1 ? kvDrop() : 0;
      tokAnchor[i]!.position.set(x, drop * 0.9, 0);
      m4.compose(vPos.set(x, CHIP_H / 2 + drop * 0.9, 0), qI, vScl.set(cs, 1, 1));
      chips.setMatrixAt(i, m4);
      const masked = i > f ? S.mask : 0;
      tmpC.copy(T.chip);
      if (arcVis && i === f) tmpC.lerp(cHi, (dark ? 0.38 : 0.42) * Math.max(S.arcs, S.multi));
      tmpC.lerp(T.chipDim, masked);
      if (cfg.kv && i === N_TOK - 1) tmpC.lerp(cHi, 0.3 * (1 - drop));
      chips.setColorAt(i, tmpC);
      tokL[i]!.kind(masked > 0.5 ? 'muted' : 'strong');
    }
    // cubes
    for (let i = 0; i < N_TOK; i++) {
      const x = xOf(i);
      const masked = i > f ? S.mask : 0;
      const cache = cacheOf(i);
      const qg = qkvOf(i);
      for (let k = 0; k < DIM; k++) {
        // embedding cube
        const idE = i * CPT + k;
        const se = grow(S.emb, k) * (1 - smooth(0, 0.6, S.qkv));
        m4.compose(vPos.set(x, colY(k), 0), qI, vScl.setScalar(Math.max(1e-4, se)));
        cubes.setMatrixAt(idE, m4);
        const v = emb(i, k);
        valueTint(tmpC, v, v >= 0 ? cPos : cNeg).lerp(cBg, 0.5 * masked);
        cubes.setColorAt(idE, tmpC);
        // Q, K, V cubes
        for (let m = 0; m < 3; m++) {
          const id = i * CPT + DIM + m * DIM + k;
          let s = grow(S.qkv, k) * qg;
          let z = 0;
          if (m > 0) z = CACHE_Z * cache;
          else if (!(cfg.kv && i === N_TOK - 1)) s *= 1 - cache; // old queries are not needed any more
          m4.compose(vPos.set(x + (m - 1) * dx, colY(k), z), qI, vScl.setScalar(Math.max(1e-4, s)));
          cubes.setMatrixAt(id, m4);
          const qv = qkvVal(i, m, k);
          valueTint(tmpC, qv, qkvHue[m]!);
          if (S.heads > 0) {
            valueTint(tmpC2, 0.55 + 0.45 * Math.abs(qv), headHue[HEADS - 1 - Math.floor(k / HEAD_DIM)]!); // head 1 on top, like the legend
            tmpC.lerp(tmpC2, S.heads);
          }
          tmpC.lerp(cBg, 0.55 * masked);
          cubes.setColorAt(id, tmpC);
        }
      }
    }
    chips.instanceMatrix.needsUpdate = true;
    cubes.instanceMatrix.needsUpdate = true;
    if (chips.instanceColor) chips.instanceColor.needsUpdate = true;
    if (cubes.instanceColor) cubes.instanceColor.needsUpdate = true;
    chips.boundingSphere = null;
    cubes.boundingSphere = null;

    // tray
    const nCached = N_TOK - 1 + (cfg.kv ? kvSlide() : 0);
    const x0 = xOf(0) - 0.32;
    const x1 = xOf(0) + (nCached - 1) * sp() + dx + 0.32;
    const trayOn = S.cache > 0.01;
    tray.visible = trayBase.visible = trayOn;
    tray.position.set((x0 + x1) / 2, (Y0 + TOP) / 2, CACHE_Z);
    tray.scale.set(Math.max(0.1, x1 - x0), 1, 1);
    trayBase.position.set((x0 + x1) / 2, Y0 - 0.19, CACHE_Z);
    trayBase.scale.set(Math.max(0.1, x1 - x0 + 0.06), 1, 1);
    trayMat.opacity = (dark ? 0.1 : 0.11) * S.cache;
    trayEdgeMat.opacity = (dark ? 0.55 : 0.45) * S.cache;
    if (portrait) cacheAnchor.position.set(x0 + 0.45, TOP + 0.21, CACHE_Z);
    else cacheAnchor.position.set(x0 - 0.04, TOP + 0.12, CACHE_Z);
    if (cfg.kv) cacheNoteL.text(`已存 ${kvSlide() > 0.5 ? N_TOK : N_TOK - 1} 個 Token`);

    // arcs: from each key's K column to the query's Q column (token centres before Q/K/V exist)
    const xf = xOf(f) - dx * S.qkv;
    for (let h = 0; h < HEADS; h++) {
      const a = heads[h]!;
      const alphaH = (h === 0 ? Math.max(S.arcs, S.multi) : S.multi) * (cfg.kv ? kvArc() : 1);
      const tilt = S.multi * FAN[h]!;
      (a.object.material.uniforms['uUp']!.value as Vector3).set(0, Math.cos(tilt), Math.sin(tilt));
      if (alphaH < 0.01 || f < 1) {
        a.object.visible = false;
        continue;
      }
      a.object.visible = true;
      let n = 0;
      // j = f is the token attending to itself: its own K → its own Q (a small hump once Q/K/V
      // exist; skipped while K and Q still share one column). In the cache view the new token's
      // own K already sits in the cache.
      for (let j = 0; j <= f; j++) {
        const w = WEIGHTS[h]![f]![j]!;
        vA.set(xOf(j), AY, CACHE_Z * cacheOf(j));
        vB.set(xf + landX(j, f, h, S.multi) * landK(), AY, 0);
        const d = Math.hypot(vB.x - vA.x, vA.z);
        if (j === f && d < 0.12) continue;
        arcSpec.height = arcH(d);
        // four overlapping fans read better with thinner ribbons
        // short arcs (neighbours, self) are capped so a heavy weight does not fold into a blob
        arcSpec.width = Math.min((dark ? 0.022 : 0.026) + lerp(0.3, 0.16, S.multi) * w, 0.03 + lerp(0.2, 0.065, S.multi) * d);
        arcSpec.color = headHue[h]!;
        // dark theme blends additively: four overlapping heads would burn to white near the query
        arcSpec.alpha = (0.32 + 0.68 * Math.min(1, w * 2.6)) * alphaH * (dark ? lerp(0.85, 0.58, S.multi) * (cfg.kv ? 0.78 : 1) : 0.95);
        arcSpec.progress = arcGrow * (cfg.kv ? kvArc() : 1);
        a.setArc(n++, arcSpec);
      }
      a.object.geometry.instanceCount = n;
    }

    // weight labels
    for (let j = 0; j < N_TOK; j++) {
      keyAnchor[j]!.position.set(xOf(j), AY, CACHE_Z * cacheOf(j));
      const w = WEIGHTS[0]![f]![j] ?? 0;
      const show = S.arcs > 0.5 && S.multi < 0.5 && j <= f && cfg.pct > 0 && (cfg.pct === 2 || w >= 0.1);
      wL[j]!.vis(show);
      if (show) {
        wL[j]!.text(j === f ? `自己 ${pct(w)}` : pct(w));
        // the self weight sits right of its K column so the small self-arc stays visible
        wL[j]!.align(j === f && S.qkv > 0.5 ? 'right' : 'above', j === f && S.qkv > 0.5 ? [6, -2] : [0, -2]);
      }
    }
    focusAnchor.position.set(xf, AY, 0);
    leftAnchor.position.set(xOf(0) - (CHIP_W * cs) / 2 - 0.12, 0, 0);
    rightAnchor.position.set(xOf(N_TOK - 1) + 0.55, AY + 0.15, 0);

    // glows
    const gA = arcVis ? Math.max(S.arcs, S.multi) : 0;
    glows.set(0, vPos.set(xOf(f), CHIP_H + 0.05 + (f === N_TOK - 1 ? kvDrop() * 0.9 : 0), 0), 1.35 * cs, cHi, (dark ? 0.55 : 0.32) * gA);
    glows.set(1, vPos.set(xf, AY, 0), 0.7, cHi, (dark ? 0.5 : 0.4) * gA * (cfg.kv ? kvArc() : 1));
    const newA = cfg.kv ? 1 - smooth(1.6, 3.2, kvT) : 0;
    glows.set(2, vPos.set(xOf(N_TOK - 1), 0.25, 0), 1.6, cHi, (dark ? 0.7 : 0.35) * newA);

    // V flow
    if (vflow) vflow.object.visible = S.vflow > 0.02;
    vflow?.setOpacity(S.vflow * (dark ? 0.8 : 0.9));

    // step 1: the vocabulary ids appear once the sentence has split into tokens
    if (cfg.ids) {
      const on = splitEff() > 0.9;
      posL.forEach((l) => l.vis(on));
    }

    // overview title over the query token
    const titleOn = cfg.focusTitle && S.arcs > 0.5 && S.multi < 0.5 && f >= 1;
    focusL.vis(titleOn);
    if (titleOn) focusL.text(`「${TOKENS[f]}」在注意誰？`);

    // masked label
    const maskOn = S.mask > 0.5 && f < N_TOK - 1;
    maskL.vis(maskOn);
    if (maskOn) maskAnchor.position.set((xOf(f + 1) + xOf(N_TOK - 1)) / 2, AY + 0.4, 0); // above the weight labels
  };

  /* ───────── step application ───────── */
  const stepPose = (): CameraPose => {
    if (!cfg.pose) return ctx.homePose;
    if (!portrait) return cfg.pose;
    if (cfg.kv) return portraitPose(ATTN_POSES['kvPortrait']!, 1, 0.25);
    return portraitPose(cfg.pose, cfg.sentence ? 1.22 : 1.06, cfg.sentence ? 0.35 : 0.6);
  };
  let stepTween: { cancel(): void } | null = null;
  const applyLabels = () => {
    const c = cfg;
    sentenceL.vis(c.sentence);
    tokenizerL.vis(c.sentence);
    posL.forEach((l, i) => {
      l.text(c.ids ? `#${TOKEN_IDS[i]}` : `位置 ${i + 1}`);
      l.vis(c.pos);
    });
    stageEmb.vis(c.emb > 0.5 && c.qkv < 0.5 && !c.sentence && !portrait);
    stageAttn.vis((c.arcs > 0.5 || c.multi > 0.5) && !portrait && !c.kv);
    qkvL.forEach((l) => l.vis(c.legendQKV));
    headL.forEach((l) => l.vis(c.legendHeads));
    outL.vis(c.out);
    cacheL.vis(c.kv);
    cacheNoteL.vis(c.kv);
    newL.vis(c.kv);
    noteL.vis(!c.sentence);
    stageTok.vis(!c.sentence && !portrait);
    tagL.vis(!!c.note);
    if (c.note) {
      tagL.text(NOTE_TEXT[c.note]);
      if (portrait) tagL.h.set({ object: belowAnchor, position: [0, 0, 0], align: 'below', offset: [0, 34] });
      else {
        // emb: under 「嵌入向量」; qkv: above the Q/K/V legend; softmax: under 「注意力」
        const y = c.note === 'emb' ? colY(4) : c.note === 'qkv' ? colY(6) : AY + 0.55;
        tagL.h.set({ object: leftAnchor, align: 'left', position: [0, y, 0], offset: [0, c.note === 'qkv' ? -36 : 36] });
      }
    }
  };

  const setFocus = (i: number, animateArcs = true) => {
    const next = Math.max(0, Math.min(N_TOK - 1, i));
    if (next === focus) return;
    focus = next;
    if (S.vflow > 0 || cfg.vflow > 0) rebuildVFlow();
    if (animateArcs && (S.arcs > 0.01 || S.multi > 0.01)) {
      arcGrow = 0;
      ctx.tween.run((k) => (arcGrow = k), { duration: 650, ease: 'cubicOut' });
    } else arcGrow = 1;
    ctx.invalidate();
  };

  const enterStep = (i: number) => {
    cfg = { ...BASE, ...(STEP_CFG[i] ?? {}) };
    stepTween?.cancel();
    const from = NUMS.map((k) => S[k]);
    const to = NUMS.map((k) => cfg[k]);
    if (cfg.splitLoop) splitT = 0;
    if (i === 1) S.split = ctx.animate ? 0 : 1;
    stepTween = ctx.tween.run(
      (k) => {
        NUMS.forEach((key, n) => {
          if (key === 'split' && cfg.splitLoop) return;
          S[key] = lerp(from[n]!, to[n]!, k);
        });
      },
      { duration: 900, ease: 'cubicInOut' },
    );
    kvT = ctx.animate ? 0 : KV_PERIOD;
    focus = -1;
    setFocus(cfg.focus, false);
    if (cfg.vflow > 0) rebuildVFlow();
    cycleIdx = 0;
    cycleT = 0;
    for (const a of heads) a.object.material.uniforms['uFlow']!.value = cfg.vflow > 0 || cfg.multi > 0 ? 0 : 0.32;
    applyLabels();
    ctx.setPose(stepPose());
  };

  /* ───────── picking & hotspots ───────── */
  const tokenOf = (hit: PickHit | null): number => {
    if (!hit || hit.instanceId === undefined) return -1;
    if (hit.object === chips) return hit.instanceId;
    if (hit.object === cubes) return Math.floor(hit.instanceId / CPT);
    return -1;
  };
  const userFocus = (i: number) => {
    if (i < 0) return;
    holdUntil = clock + 8;
    setFocus(i);
  };
  ctx.picker.add(cubes, { id: 'tokens' });
  ctx.picker.onHover((hit) => {
    if (hit?.id === 'tokens') userFocus(tokenOf(hit));
  });
  ctx.picker.onClick((hit) => {
    if (hit?.id === 'tokens') userFocus(tokenOf(hit));
  });

  const tokenCard = (i: number): CardContent => {
    const t = TOKENS[i]!;
    const showArcs = S.arcs > 0.5 || S.multi > 0.5;
    const c: CardContent = { title: `「${t}」（第 ${i + 1} 個 Token）`, swatch: ctx.palette.css['scene-highlight'] ?? '' };
    if (!showArcs) {
      c.body = S.qkv > 0.5 ? `「${t}」的向量乘上三個權重矩陣，得到 Q（查詢）、K（鍵）、V（值）三個向量（示意 ${DIM} 維）。` : S.emb > 0.5 ? `「${t}」被查表換成一串數字（嵌入向量，示意 ${DIM} 維；實際模型有數千維）。` : `句子先被切成 Token，「${t}」是第 ${i + 1} 個。`;
      return c;
    }
    const top = (h: number) =>
      Array.from({ length: i + 1 }, (_, j) => j)
        .sort((a, b) => (WEIGHTS[h]![i]![b] ?? 0) - (WEIGHTS[h]![i]![a] ?? 0))
        .slice(0, 3)
        .map((j) => `${j === i ? '自己' : `「${TOKENS[j]}」`} ${pct(WEIGHTS[h]![i]![j] ?? 0)}`);
    if (S.multi > 0.5) {
      c.body = `每個注意力頭各看各的重點（示意）：`;
      c.items = HEAD_SPECS.map((h, k) => ({ label: `頭 ${k + 1}　${h.name}`, meta: top(k).slice(0, 2).join('、') }));
    } else {
      c.body = `「${t}」最注意：${top(0).join('、')}（示意權重，加總為 100%）。${i < N_TOK - 1 ? '後面的 Token 被遮罩，看不到。' : ''}`;
    }
    return c;
  };

  hotspots.register('tokens', {
    object: chips,
    anchor: focusAnchor,
    pose: ATTN_POSES['tokens']!,
    onHighlight: () => {},
    card: (hit) => tokenCard(tokenOf(hit) >= 0 ? tokenOf(hit) : focus),
    onSelect: (source) => {
      // List / keyboard: each activation moves the query to the next token.
      if (source === 'list' || source === 'keyboard' || source === 'command') userFocus((focus + 1) % N_TOK);
    },
  });
  hotspots.register('embedding', { anchor: keyAnchor[0]!, pose: ATTN_POSES['emb']!, onHighlight: () => {}, card: () => metaCard(ctx, 'embedding') });
  hotspots.register('qkv', { anchor: focusAnchor, pose: ATTN_POSES['qkv']!, onHighlight: () => {}, card: () => metaCard(ctx, 'qkv') });
  hotspots.register('attention-weights', {
    anchor: focusAnchor,
    pose: ATTN_POSES['weights']!,
    onHighlight: () => {},
    card: () => metaCard(ctx, 'attention-weights'),
  });
  hotspots.register('multi-head', { anchor: rightAnchor, pose: ATTN_POSES['heads']!, onHighlight: () => {}, card: () => metaCard(ctx, 'multi-head') });
  hotspots.register('kv-cache', {
    object: tray,
    anchor: cacheAnchor,
    pose: ATTN_POSES['kv']!,
    onHighlight: (on) => {
      if (S.cache > 0.5) ctx.tween.to(trayMat, { opacity: on ? 0.28 : T.dark ? 0.1 : 0.16 }, { duration: 200, fade: true });
    },
    card: () => metaCard(ctx, 'kv-cache'),
  });
  registerAway(ctx, new Set(['tokens', 'embedding', 'qkv', 'attention-weights', 'multi-head', 'kv-cache']), [0, AY + 0.6, 0], stepTitle);

  applyPalette(ctx.palette);
  enterStep(ctx.step);
  draw();

  return {
    update(dt) {
      clock += dt;
      if (ctx.animate) {
        if (cfg.kv) kvT = (kvT + dt) % KV_PERIOD;
        if (cfg.splitLoop) splitT = (splitT + dt) % SPLIT_PERIOD;
        if (cfg.cycle && clock > holdUntil) {
          cycleT += dt;
          if (cycleT > 3.4) {
            cycleT = 0;
            cycleIdx = (cycleIdx + 1) % CYCLE.length;
            setFocus(CYCLE[cycleIdx]!);
          }
        }
      }
      for (const a of heads) if (a.object.visible) a.update(clock);
      vflow?.update(clock);
      draw();
    },
    setStep(i) {
      enterStep(i);
      consumePending(ctx);
    },
    onPalette(p) {
      applyPalette(p);
      draw();
    },
    onQuality(_q, tier) {
      vflow?.setCount(scaleCount(VFLOW_MAX, tier, 40));
    },
    onMotion(animate) {
      vflow?.setReduced(!animate);
      if (!animate) {
        kvT = KV_PERIOD;
        splitT = SPLIT_PERIOD;
        S.split = 1;
        if (cfg.cycle) setFocus(cfg.focus, false);
      }
      draw();
    },
    onResize(size) {
      const next = size.aspect < 0.9;
      if (next !== portrait) {
        portrait = next;
        stage.geometry.dispose();
        stage.geometry = stageGeo(stageW());
        vflowKey = '';
        if (vflow) rebuildVFlow();
        layoutLabels();
        applyLabels();
        draw();
        // the host has just reset to the home pose; keep the current step's framing instead
        if (cfg.pose) ctx.setPose(stepPose(), { duration: 0 });
      }
    },
    dispose() {
      stepTween?.cancel();
      vflow?.dispose();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

/**
 * embedding-space · rag variant — retrieval-augmented generation as a diorama.
 *
 * Left: the question card and a stack of documents both pass through the same 嵌入模型. Centre:
 * a glass 向量資料庫 holding 48 document chunks (tiles coloured by source document, clustered by
 * topic). The query vector (a gold octahedron) flies in, a search sphere grows until it holds the
 * top-k = 4 chunks (ranked by cosine similarity, space.ts), those chunks are copied into the
 * 上下文視窗 next to the question, and the LLM writes an answer that cites them.
 *
 * Plan per step: 0 總覽 = the whole loop · 4 查詢向量 · 5 相似搜尋 · 6 組成上下文.
 * The indexing stream (documents → model → database) is an ambient PathFlow. Portrait stages
 * stack the pipeline vertically. Reduced motion: each step's final state, flows as dotted streams.
 */
import {
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Line,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Quaternion,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraPose, CardContent, LabelHandle, Palette, QualityTier, SceneContext } from '../../core/types';
import { scaleCount } from '../../core/quality';
import { canvasTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { ANSWER_TEXT, DOCS, QUERY_TEXT, TOP_K, buildRag } from './space';
import {
  LabelFit,
  LabelSet,
  Links,
  clamp01,
  cssToken,
  easeInOut,
  easeOut,
  markColor,
  roundedRect,
  roundedRectOutline,
  smooth,
  type View,
  type ViewApi,
} from './common';

type V3 = [number, number, number];
interface Layout {
  question: V3;
  qScale: number;
  docs: V3;
  embed: V3;
  db: V3;
  dbScale: number;
  context: V3;
  ctxScale: number;
  llm: V3;
  llmScale: number;
  answer: V3;
}
/* Landscape: column 1 = question / 嵌入模型 / documents, then database, context window, LLM. */
const LAND: Layout = {
  question: [-4.3, 2.4, 0.3],
  qScale: 1,
  docs: [-4.3, -1.85, 0.3],
  embed: [-4.3, 0.3, 0.3],
  db: [-0.55, 0.2, 0],
  dbScale: 0.84,
  context: [2.95, 0.15, 0.3],
  ctxScale: 1,
  llm: [5.15, 0.8, 0.3],
  llmScale: 1.08,
  answer: [5.15, -1.25, 0.3],
};
/* Portrait: row 1 = question / 嵌入模型 / documents, database, then context window + LLM. */
const PORT: Layout = {
  question: [-2.2, 4.45, 0.3],
  qScale: 1,
  docs: [2.25, 4.45, 0.3],
  embed: [0.3, 4.45, 0.3],
  db: [0, 0.95, 0],
  dbScale: 0.78,
  context: [-1.3, -3.35, 0.3],
  ctxScale: 0.86,
  llm: [1.6, -2.65, 0.3],
  llmScale: 0.9,
  answer: [1.6, -4.3, 0.3],
};

type Phase = 'embed' | 'search' | 'pull' | 'answer' | 'hold';
const ORDER: Exclude<Phase, 'hold'>[] = ['embed', 'search', 'pull', 'answer'];
const DUR: Record<Phase, number> = { embed: 2.3, search: 2.4, pull: 2.3, answer: 2.0, hold: 3.2 };
const planFor = (step: number): Phase[] =>
  step === 4 ? ['embed', 'hold'] : step === 5 ? ['search', 'hold'] : step === 6 ? ['pull', 'answer', 'hold'] : ['embed', 'search', 'pull', 'answer', 'hold'];

/** Short names for the retrieved chunks (slot labels); the full text lives in the cards. */
const SHORT: Record<string, string> = {
  '1:0': 'CoWoS 並排',
  '0:4': 'HBM 緊鄰 GPU',
  '1:1': '中介層線路',
  '0:0': 'DRAM 堆疊',
};

const ANSWER_SHORT = '答：以 CoWoS 把兩者並排在中介層上［#1–#4］';
const TILE: V3 = [0.36, 0.24, 0.04];
const SLOT_W = 1.42;
const SLOT_H = 0.44;
const SLOT_GAP = 0.6;
const CTX_W = 1.9;
const CTX_H = 3.5;
const Q_W = 2.3;
const Q_H = 0.5;
const EMB = 0.95;
const LLM = 1.2;
const IDX_MAX = 420;
const GEN_MAX = 120;
/** Mini "network" drawn on the front of the two models: dots per column. */
const NET_EMB = [3, 4, 3];
const NET_LLM = [3, 4, 4, 3];

const m4 = new Matrix4();
const q = new Quaternion();
const q2 = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const sc = new Vector3();
const eul = new Euler();
const tmpC = new Color();
const ZERO = new Matrix4().makeScale(0, 0, 0);

export function createRag(ctx: SceneContext, parent: Group, api: ViewApi): View {
  const R = buildRag();
  const NC = R.chunks.length;
  const { materials } = ctx;
  const group = new Group();
  group.name = 'rag';
  parent.add(group);
  const L = new LabelSet(ctx);
  const fit = new LabelFit(ctx);
  const isActive = () => api.active === 'rag';
  let lay: Layout = LAND;
  let portrait = false;
  let compact = false;
  let pal: Palette = ctx.palette;
  const docColor = DOCS.map(() => new Color());
  const W = (p: V3, out = new Vector3()) => out.set(p[0], p[1], p[2]);

  /* ───────── shared tile material: paper with text lines, tinted per instance ───────── */
  const paper = ctx.track(
    canvasTexture(128, 86, (g, w, h) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,0.26)';
      [0.78, 0.9, 0.62, 0.84].forEach((len, i) => g.fillRect(14, 16 + i * 16, (w - 28) * len, 6));
    }),
  );
  const tileMat = ctx.track(new MeshStandardMaterial({ map: paper, roughness: 0.6, metalness: 0 }));
  const tileGeo = ctx.track(new RoundedBoxGeometry(TILE[0], TILE[1], TILE[2], 2, 0.03));

  /* ───────── vector database: glass cylinder, rims, base disc ───────── */
  const db = new Group();
  group.add(db);
  let minY = Infinity;
  let maxY = -Infinity;
  let maxR = 0;
  for (const c of R.chunks) {
    minY = Math.min(minY, c.pos[1]);
    maxY = Math.max(maxY, c.pos[1]);
    maxR = Math.max(maxR, Math.hypot(c.pos[0], c.pos[2]));
  }
  const CYL_R = maxR + 0.38;
  const CYL_Y = (minY + maxY) / 2;
  const CYL_H = maxY - minY + 0.8;
  const cylMat = materials.glass('flow', 0.05, { roughness: 0.2 });
  const cyl = new Mesh(ctx.track(new CylinderGeometry(CYL_R, CYL_R, CYL_H, 72, 1, true)), cylMat);
  cyl.position.y = CYL_Y;
  cyl.renderOrder = 1;
  db.add(cyl);
  const baseMat = materials.basic('flow', { transparent: true, opacity: 0.08, depthWrite: false });
  const base = new Mesh(ctx.track(new CircleGeometry(CYL_R, 72)), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = CYL_Y - CYL_H / 2;
  base.renderOrder = 0;
  db.add(base);
  const ringPts: number[] = [];
  for (const [y, segs] of [
    [CYL_Y - CYL_H / 2, 96],
    [CYL_Y, 96],
    [CYL_Y + CYL_H / 2, 96],
  ] as const) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      ringPts.push(Math.cos(a0) * CYL_R, y, Math.sin(a0) * CYL_R, Math.cos(a1) * CYL_R, y, Math.sin(a1) * CYL_R);
    }
  }
  const ringGeo = ctx.track(new BufferGeometry());
  ringGeo.setAttribute('position', new Float32BufferAttribute(ringPts, 3));
  const ringMat = materials.line('flow', { transparent: true, opacity: 0.5, depthWrite: false });
  const dbRings = new LineSegments(ringGeo, ringMat);
  dbRings.renderOrder = 2;
  db.add(dbRings);

  /* ───────── chunks ───────── */
  const chunks = new InstancedMesh(tileGeo, tileMat, NC);
  chunks.instanceMatrix.setUsage(DynamicDrawUsage);
  chunks.setColorAt(0, tmpC.set(1, 1, 1));
  db.add(chunks);
  ctx.track({ dispose: () => chunks.dispose() });
  const rankOf = new Map(R.top.map((t, r) => [t.i, r]));
  const lit = new Float32Array(NC);
  const chunkQ = R.chunks.map((c) => new Quaternion().setFromEuler(eul.set(c.tilt[0], c.tilt[1], c.tilt[2])));

  const glows = ctx.track(new GlowSprites({ count: NC + 6, theme: ctx.theme }));
  group.add(glows.object);
  const G_Q = NC;
  const G_EMB = NC + 1;
  const G_LLM = NC + 2;
  const G_ANS = NC + 3;
  const G_QCARD = NC + 4;

  /* ───────── query, search sphere, links ───────── */
  const qMat = materials.basic('highlight');
  const query = new Mesh(ctx.track(new OctahedronGeometry(0.15, 0)), qMat);
  query.renderOrder = 6;
  group.add(query);
  const sphereMat = materials.glass('highlight', 0.08, { roughness: 0.1 });
  const sphere = new Mesh(ctx.track(new SphereGeometry(1, 48, 28)), sphereMat);
  sphere.renderOrder = 3;
  group.add(sphere);
  const rimMat = materials.basic('highlight', { transparent: true, opacity: 0.8, depthWrite: false });
  const rim = new Mesh(ctx.track(new TorusGeometry(1, 0.012, 6, 96)), rimMat);
  rim.renderOrder = 4;
  group.add(rim);
  const links = new Links(ctx, TOP_K, { renderOrder: 7 });
  db.add(links.group);
  // The query's route (question → 嵌入模型 → database) as a dashed trail; rebuilt on layout.
  const TRAIL_N = 64;
  const trailGeo = ctx.track(new BufferGeometry());
  trailGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
  const trailMat = materials.bind(
    ctx.track(new LineDashedMaterial({ dashSize: 0.1, gapSize: 0.07, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false })),
    'color',
    'highlight',
  );
  const trail = new Line(trailGeo, trailMat);
  trail.renderOrder = 5;
  trail.frustumCulled = false;
  group.add(trail);
  const R4 = (R.top[TOP_K - 1]?.dist ?? 0.6) + 0.1;

  /* ───────── left: question card, documents, embedding model ───────── */
  const qCard = new Mesh(ctx.track(new RoundedBoxGeometry(Q_W, Q_H, 0.12, 2, 0.1)), materials.standard('highlight', { roughness: 0.42, metalness: 0.05 }));
  group.add(qCard);
  const sheetGeo = ctx.track(new RoundedBoxGeometry(1.0, 0.68, 0.035, 2, 0.04));
  const sheets = new InstancedMesh(sheetGeo, tileMat, DOCS.length);
  sheets.setColorAt(0, tmpC.set(1, 1, 1));
  group.add(sheets);
  ctx.track({ dispose: () => sheets.dispose() });
  const embMat = materials.standard('optic', { roughness: 0.34, metalness: 0.12 });
  const embed = new Mesh(ctx.track(new RoundedBoxGeometry(EMB, EMB, EMB, 3, 0.17)), embMat);
  group.add(embed);

  /* ───────── right: context window, LLM, answer ───────── */
  const ctxGroup = new Group();
  group.add(ctxGroup);
  const ctxGlass = new Mesh(ctx.track(new RoundedBoxGeometry(CTX_W, CTX_H, 0.42, 3, 0.12)), materials.glass('fg', 0.06, { roughness: 0.15 }));
  ctxGlass.renderOrder = 2;
  ctxGroup.add(ctxGlass);
  const ctxEdgeMat = materials.line('fg', { transparent: true, opacity: 0.4, depthWrite: false });
  ctxGroup.add(new LineSegments(ctx.track(roundedRectOutline(CTX_W, CTX_H, 0.12, 0.215)), ctxEdgeMat));
  const slotY = (k: number) => (2 - k) * SLOT_GAP - 0.1;
  const slotMat = materials.basic('muted', { transparent: true, opacity: 0.16, depthWrite: false });
  const slots = new InstancedMesh(ctx.track(new ShapeGeometry(roundedRect(SLOT_W + 0.08, SLOT_H + 0.08, 0.07), 4)), slotMat, TOP_K + 1);
  for (let k = 0; k <= TOP_K; k++) slots.setMatrixAt(k, m4.makeTranslation(0, slotY(k), 0));
  slots.renderOrder = 3;
  ctxGroup.add(slots);
  ctx.track({ dispose: () => slots.dispose() });
  const copies = new InstancedMesh(tileGeo, tileMat, TOP_K + 1);
  copies.instanceMatrix.setUsage(DynamicDrawUsage);
  copies.setColorAt(0, tmpC.set(1, 1, 1));
  copies.renderOrder = 5;
  ctxGroup.add(copies);
  ctx.track({ dispose: () => copies.dispose() });

  const llmMat = materials.standard('seg:foundation-models', { roughness: 0.34, metalness: 0.15 });
  const llm = new Mesh(ctx.track(new RoundedBoxGeometry(LLM, LLM, LLM, 3, 0.2)), llmMat);
  group.add(llm);
  const ansMat = materials.standard('pos', { roughness: 0.42, metalness: 0.05 });
  const answer = new Mesh(ctx.track(new RoundedBoxGeometry(2.5, 0.5, 0.14, 2, 0.12)), ansMat);
  group.add(answer);

  /* ───────── mini networks on the two models (decoration: 1 instanced mesh + 1 line set) ───────── */
  const netDots: { model: 'embed' | 'llm'; x: number; y: number }[] = [];
  const netLines: [number, number][] = [];
  for (const [model, cols, size] of [
    ['embed', NET_EMB, EMB],
    ['llm', NET_LLM, LLM],
  ] as const) {
    const colStart: number[] = [];
    const dx = (size * 0.62) / (cols.length - 1);
    cols.forEach((n, ci) => {
      colStart.push(netDots.length);
      const dy = size * 0.19;
      for (let r = 0; r < n; r++) netDots.push({ model, x: -size * 0.31 + ci * dx, y: (r - (n - 1) / 2) * dy });
    });
    for (let ci = 0; ci + 1 < cols.length; ci++)
      for (let a = 0; a < cols[ci]!; a++) for (let b = 0; b < cols[ci + 1]!; b++) netLines.push([colStart[ci]! + a, colStart[ci + 1]! + b]);
  }
  const dotMat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
  const dots = new InstancedMesh(ctx.track(new IcosahedronGeometry(0.042, 1)), dotMat, netDots.length);
  group.add(dots);
  ctx.track({ dispose: () => dots.dispose() });
  const netGeo = ctx.track(new BufferGeometry());
  netGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(netLines.length * 6), 3));
  const netInk = (p: Palette) => (p.theme === 'dark' ? p.bg.clone().lerp(p.fg, 0.85) : p.bg.clone());
  const netLineMat = materials.line(netInk, { transparent: true, opacity: 0.5, depthWrite: false });
  const net = new LineSegments(netGeo, netLineMat);
  group.add(net);

  /* ───────── flows ───────── */
  let flowIdx: PathFlow | null = null;
  let flowGen: PathFlow | null = null;
  const sheetPos = (i: number, out = new Vector3()) => W(lay.docs, out).add(v1.set(-0.06 * i + 0.15, 0.05 * i - 0.12, -0.07 * i + 0.17));
  const buildFlows = () => {
    flowIdx?.dispose();
    flowGen?.dispose();
    const e = W(lay.embed);
    const idxPaths: FlowPath[] = DOCS.map((doc, i) => {
      const sheet = sheetPos(i);
      const end = db.localToWorld(new Vector3(...doc.centre));
      const midA = sheet.clone().lerp(e, 0.5).add(v1.set(0, 0, 0.25));
      const midB = e.clone().lerp(end, 0.45).add(v1.set(0, 0.15 * (i - 2.5), 0.35));
      return { points: [sheet, midA, e, midB, end], color: docColor[i]!.clone() };
    });
    flowIdx = ctx.track(
      new PathFlow({ paths: idxPaths, count: IDX_MAX, size: 0.06, sizeVariance: 0.3, speed: 0.75, speedVariance: 0.2, fadeEnds: 0.08, theme: pal.theme, seed: 5 }),
    );
    // Context leaves from the window's edge facing the LLM (right in landscape and portrait).
    const c = ctxGroup.localToWorld(new Vector3(CTX_W / 2 - 0.05, slotY(2), 0.1));
    const l = W(lay.llm);
    const a = W(lay.answer);
    const genPaths: FlowPath[] = [
      { points: [c, c.clone().lerp(l, 0.5).add(v1.set(0, 0.2, 0.35)), l], color: [pal.highlight.clone(), pal.highlight.clone()] },
      { points: [l, l.clone().lerp(a, 0.5).add(v1.set(0.3, 0, 0.35)), a], color: [pal.highlight.clone(), pal.pos.clone()] },
    ];
    flowGen = ctx.track(new PathFlow({ paths: genPaths, count: GEN_MAX, size: 0.07, speed: 0.9, fadeEnds: 0.1, theme: pal.theme, seed: 9 }));
    group.add(flowIdx.object, flowGen.object);
    flowIdx.setCount(scaleCount(IDX_MAX, ctx.tier, 60));
    flowGen.setCount(scaleCount(GEN_MAX, ctx.tier, 30));
    flowIdx.setReduced(!ctx.animate);
    flowGen.setReduced(!ctx.animate);
    styleFlows();
  };
  const styleFlows = () => {
    const dark = pal.theme === 'dark';
    flowIdx?.setTheme(pal.theme);
    flowIdx?.recolor((i) => docColor[i]);
    flowIdx?.setSize(dark ? 0.06 : 0.055);
    flowIdx?.setOpacity(dark ? 0.8 : 0.75);
    flowGen?.setTheme(pal.theme);
    flowGen?.recolor((i) => (i === 0 ? [pal.highlight, pal.highlight] : [pal.highlight, pal.pos]));
    flowGen?.setSize(dark ? 0.075 : 0.065);
  };

  /* ───────── labels ───────── */
  let qText = `問：${QUERY_TEXT}`;
  let aText = ANSWER_SHORT;
  const lbl = {
    question: L.add({ text: qText, position: [0, 0, 0], align: 'center', kind: 'strong', priority: 60, always: true }),
    qTag: L.add({ text: '使用者的問題', position: [0, 0, 0], align: 'above', kind: 'tag', priority: 30 }),
    docs: L.add({ text: '文件切成片段', position: [0, 0, 0], align: 'below', kind: 'default', priority: 40 }),
    embed: L.add({ text: '嵌入模型', position: [0, 0, 0], align: 'above', kind: 'strong', priority: 55, hotspot: 'embedding-model' }),
    db: L.add({ text: '向量資料庫', position: [0, 0, 0], align: 'above', kind: 'strong', priority: 58, hotspot: 'vector-db' }),
    context: L.add({ text: '上下文視窗', position: [0, 0, 0], align: 'above', kind: 'strong', priority: 57, hotspot: 'context-window' }),
    llm: L.add({ text: 'LLM', position: [0, 0, 0], align: 'above', kind: 'strong', priority: 56, hotspot: 'rag-answer' }),
    answer: L.add({ text: ANSWER_SHORT, position: [0, 0, 0], align: 'center', kind: 'default', priority: 62, always: true, visible: false, hotspot: 'rag-answer' }),
    ansTag: L.add({ text: '回答附上來源', position: [0, 0, 0], align: 'below', kind: 'tag', priority: 30, visible: false }),
    query: L.add({ text: '查詢向量', position: [0, 0, 0], align: 'right', offset: [10, 0], kind: 'default', priority: 70, visible: false, hotspot: 'query-vector' }),
  };
  const TRAIN = DOCS.findIndex((d) => d.id === 'training');
  const docTags = DOCS.map((d) => {
    const c = new Vector3(...d.centre);
    const out = new Vector3(c.x, 0, c.z).normalize().multiplyScalar(0.5);
    return L.add({ text: d.tag, object: db, position: [c.x + out.x, c.y + 0.5, c.z + out.z], kind: 'tag', priority: 12, swatch: '' });
  });
  const rankLabels: LabelHandle[] = R.top.map((t, r) =>
    L.add({
      text: `#${r + 1} ${t.sim.toFixed(2)}`,
      object: db,
      position: R.chunks[t.i]!.pos,
      align: R.chunks[t.i]!.pos[0] >= R.query.pos[0] ? 'right' : 'left',
      offset: [R.chunks[t.i]!.pos[0] >= R.query.pos[0] ? 14 : -14, 0],
      kind: 'default',
      priority: 80,
      always: true,
      visible: false,
    }),
  );
  const slotText = (k: number) => {
    const c = R.chunks[R.top[k - 1]!.i]!;
    return `#${k} ${SHORT[`${c.doc}:${c.idx}`] ?? ''}`;
  };
  const slotLabels: LabelHandle[] = Array.from({ length: TOP_K + 1 }, (_, k) => {
    return L.add({
      text: k === 0 ? '問題' : slotText(k),
      object: ctxGroup,
      position: [0, slotY(k), 0.25],
      kind: 'default', // on saturated tiles the muted 'tag' ink is too faint in the light theme
      priority: 75,
      always: true,
      visible: false,
    });
  });

  /** In the small (phone) overview the four rank tags would pile up: let the collision grid thin them. */
  const rankAlways = () => rankLabels.forEach((h) => h.set({ always: !(compact && step === 0) }));

  /* ───────── layout ───────── */
  const slotWorld = (k: number, out: Vector3) => ctxGroup.localToWorld(out.set(0, slotY(k), 0.12));
  let queryPath: CatmullRomCurve3 | null = null;
  const pickPts = R.chunks.map(() => ({ position: new Vector3(), id: 'vector-db' as string | null }));
  const layout = (p: boolean) => {
    portrait = p;
    lay = p ? PORT : LAND;
    qCard.position.set(...lay.question);
    qCard.scale.set(lay.qScale, p ? 1.35 : 1, 1);
    embed.position.set(...lay.embed);
    db.position.set(...lay.db);
    db.scale.setScalar(lay.dbScale);
    ctxGroup.position.set(...lay.context);
    ctxGroup.scale.setScalar(lay.ctxScale);
    llm.position.set(...lay.llm);
    llm.scale.setScalar(lay.llmScale);
    answer.position.set(...lay.answer);
    for (let i = 0; i < DOCS.length; i++) {
      const sp = sheetPos(i);
      sheets.setMatrixAt(DOCS.length - 1 - i, m4.makeTranslation(sp.x, sp.y, sp.z));
    }
    sheets.instanceMatrix.needsUpdate = true;
    group.updateMatrixWorld(true);
    // model networks (front faces)
    const pos = netGeo.getAttribute('position') as Float32BufferAttribute;
    const dotWorld = netDots.map((d) => {
      const m = d.model === 'embed' ? embed : llm;
      const size = d.model === 'embed' ? EMB : LLM;
      return m.localToWorld(new Vector3(d.x, d.y, size / 2 + 0.012));
    });
    dotWorld.forEach((w, i) => {
      const k = netDots[i]!.model === 'embed' ? embed.scale.x : llm.scale.x;
      dots.setMatrixAt(i, m4.compose(w, q.identity(), sc.setScalar(k)));
    });
    dots.instanceMatrix.needsUpdate = true;
    netLines.forEach(([a, b], i) => {
      pos.setXYZ(i * 2, dotWorld[a]!.x, dotWorld[a]!.y, dotWorld[a]!.z - 0.004);
      pos.setXYZ(i * 2 + 1, dotWorld[b]!.x, dotWorld[b]!.y, dotWorld[b]!.z - 0.004);
    });
    pos.needsUpdate = true;
    netGeo.computeBoundingSphere();
    // labels
    lbl.question.set({ position: W(lay.question).add(v2.set(0, 0, 0.08)) });
    lbl.qTag.set({ position: W(lay.question).add(v2.set(0, (Q_H / 2) * lay.qScale + 0.04, 0)) });
    lbl.docs.set({ position: W(lay.docs).add(v2.set(0, -0.5, 0)) });
    lbl.embed.set({ position: W(lay.embed).add(v2.set(0, EMB / 2 + 0.08, 0)) });
    lbl.db.set({ position: db.localToWorld(new Vector3(0, CYL_Y + CYL_H / 2 + 0.05, 0)) });
    lbl.context.set({ position: ctxGroup.localToWorld(new Vector3(0, CTX_H / 2 + 0.04, 0)) });
    lbl.llm.set({ position: W(lay.llm).add(v2.set(0, (LLM / 2) * llm.scale.y + 0.08, 0)) });
    lbl.answer.set({ position: W(lay.answer).add(v2.set(0, 0, 0.08)) });
    lbl.ansTag.set({ position: W(lay.answer).add(v2.set(0, -0.3, 0)) });
    buildFlows();
    pickPts.forEach((pp, i) => db.localToWorld(pp.position.set(...R.chunks[i]!.pos)));
    const qEnd = db.localToWorld(new Vector3(...R.query.pos));
    const e = W(lay.embed);
    const qStart = W(lay.question).add(v1.set(0, 0, 0.12));
    queryPath = new CatmullRomCurve3(
      [
        qStart,
        qStart.clone().lerp(e, 0.55).add(v1.set(p ? 0 : 0.35, p ? 0.3 : 0, 0.35)),
        e.clone().add(v1.set(0, 0, 0.1)),
        e.clone().lerp(qEnd, 0.5).add(v1.set(p ? 0.45 : 0, p ? 0 : 0.45, 0.6)),
        qEnd,
      ],
      false,
      'centripetal',
    );
    const tp = trailGeo.getAttribute('position') as Float32BufferAttribute;
    for (let i = 0; i < TRAIL_N; i++) {
      queryPath.getPointAt(i / (TRAIL_N - 1), v1);
      tp.setXYZ(i, v1.x, v1.y, v1.z);
    }
    tp.needsUpdate = true;
    trail.computeLineDistances();
    trailGeo.computeBoundingSphere();
  };

  /* ───────── plan / state ───────── */
  let clock = 0;
  let step = 0;
  let plan: Phase[] = planFor(0);
  let phaseIdx = 0;
  let phaseT = 0;
  const st = { q: 0, s: 0, pull: 0, ans: 0 };
  const KEY: Record<Exclude<Phase, 'hold'>, keyof typeof st> = { embed: 'q', search: 's', pull: 'pull', answer: 'ans' };

  /** State at time t inside plan[pi]: phases before the plan's first (global order) are complete. */
  const computeState = (pi: number, t: number) => {
    const first = ORDER.indexOf(plan[0] === 'hold' ? 'answer' : (plan[0] as Exclude<Phase, 'hold'>));
    st.q = st.s = st.pull = st.ans = 0;
    ORDER.forEach((ph, oi) => {
      if (oi < first) st[KEY[ph]] = 1;
    });
    for (let i = 0; i <= pi && i < plan.length; i++) {
      const ph = plan[i]!;
      if (ph === 'hold') continue;
      st[KEY[ph]] = i < pi ? 1 : clamp01(t / DUR[ph]);
    }
  };

  /* ───────── rank tags: stacked per side so neighbours never cover each other ───────── */
  const rankSide = R.top.map((t) => (R.chunks[t.i]!.pos[0] >= R.query.pos[0] ? 1 : -1));
  const rankPx = R.top.map(() => ({ x: 0, y: 0 }));
  const rankOrder = R.top.map((_, k) => k);
  const rankW = new Vector3();
  const stackRankLabels = () => {
    if (st.s <= 0 || st.pull >= 0.5) return;
    const h = fit.size('#1 0.89', 'default')[1];
    R.top.forEach((t, k) => fit.px(db.localToWorld(rankW.set(...R.chunks[t.i]!.pos)), rankPx[k]!));
    for (const sd of [1, -1]) {
      let last = -Infinity;
      for (const k of rankOrder.filter((k) => rankSide[k] === sd).sort((a, b) => rankPx[a]!.y - rankPx[b]!.y)) {
        const y = Math.max(rankPx[k]!.y, last + h + 2);
        rankLabels[k]!.set({ offset: [sd * 14, Math.round(y - rankPx[k]!.y)] });
        last = y;
      }
    }
  };

  /* ───────── drawing ───────── */
  // Hover highlight for the two models: a stronger halo (scaling would detach the face networks).
  const hl = { embed: 0, llm: 0 };
  const qWorld = new Vector3();
  const qAt = new Vector3();
  const aAt = new Vector3();
  const sphereW = new Vector3();
  const draw = (time: number) => {
    const dark = pal.theme === 'dark';
    // Query flight.
    const qk = easeInOut(st.q);
    if (queryPath) queryPath.getPointAt(qk, qWorld);
    query.position.copy(qWorld);
    query.visible = st.q > 0.001;
    query.rotation.set(0.5, time * 0.8, 0.3);
    query.scale.setScalar(st.q > 0 ? 0.75 + 0.35 * smooth(0.8, 1, st.q) : 0.001);
    glows.set(G_Q, qWorld, dark ? 1.0 : 0.8, pal.highlight, st.q > 0 ? (dark ? 0.8 : 0.55) : 0);
    lbl.query.set({ visible: st.q > 0.95 && st.pull < 0.5, position: qWorld });
    trail.visible = st.q > 0.001 && st.pull < 0.6;
    trail.geometry.setDrawRange(0, Math.max(2, Math.round(TRAIL_N * qk)));
    trailMat.opacity = (dark ? 0.75 : 0.85) * (1 - smooth(0.1, 0.6, st.pull));
    const cardPulse = st.q > 0 && st.q < 0.35 ? Math.sin((st.q / 0.35) * Math.PI) : 0;
    glows.set(G_QCARD, lay.question, 2.0, pal.highlight, cardPulse * (dark ? 0.55 : 0.4));
    const embPulse = Math.max(0, 1 - Math.abs(st.q - 0.5) / 0.18) + (ctx.animate ? 0.12 * (1 + Math.sin(time * 2.2)) : 0.15);
    glows.set(G_EMB, lay.embed, 2.0, pal.optic, Math.min(1, embPulse + hl.embed * 0.8) * (dark ? 0.55 : 0.32));
    // Search sphere.
    const r = st.s * R4;
    sphere.visible = rim.visible = st.s > 0.001;
    db.localToWorld(sphereW.set(...R.query.pos));
    sphere.position.copy(sphereW);
    sphere.scale.setScalar(Math.max(0.001, r * lay.dbScale));
    rim.position.copy(sphereW);
    rim.quaternion.copy(ctx.camera.quaternion);
    rim.scale.setScalar(Math.max(0.001, r * lay.dbScale));
    sphereMat.opacity = (dark ? 0.07 : 0.1) * (1 - 0.5 * st.pull);
    rimMat.opacity = (dark ? 0.75 : 0.85) * (1 - 0.6 * st.pull);
    // Chunks: lit when inside the sphere; the rest fade back while searching.
    for (let i = 0; i < NC; i++) {
      const c = R.chunks[i]!;
      const rank = rankOf.get(i);
      const d = Math.hypot(c.pos[0] - R.query.pos[0], c.pos[1] - R.query.pos[1], c.pos[2] - R.query.pos[2]);
      lit[i] = rank !== undefined ? smooth(d - 0.05, d + 0.08, r) : 0;
      const Li = lit[i]!;
      const dim = st.s > 0.2 && rank === undefined ? (dark ? 0.55 : 0.5) * smooth(0.2, 0.6, st.s) : 0;
      tmpC.copy(docColor[c.doc]!).lerp(pal.bg, dim);
      if (Li > 0) tmpC.lerp(pal.highlight, 0.2 * Li);
      chunks.setColorAt(i, tmpC);
      chunks.setMatrixAt(i, m4.compose(v1.set(c.pos[0], c.pos[1], c.pos[2]), chunkQ[i]!, sc.setScalar(1 + 0.45 * Li)));
      glows.set(i, db.localToWorld(v2.set(c.pos[0], c.pos[1], c.pos[2])), 0.55 + 0.5 * Li, Li > 0 ? pal.highlight : docColor[c.doc]!, (dark ? 0.2 : 0) * (1 - dim) + Li * (dark ? 0.6 : 0.45));
    }
    chunks.instanceMatrix.needsUpdate = true;
    if (chunks.instanceColor) chunks.instanceColor.needsUpdate = true;
    R.top.forEach((t, k) => {
      const Li = lit[t.i]!;
      if (Li <= 0 || st.pull > 0.6) links.hide(k);
      else links.set(k, v1.set(...R.query.pos), v2.set(...R.chunks[t.i]!.pos), { radius: 0.014, color: pal.highlight, progress: Li, trimStart: 0.1, trimEnd: 0.12 });
      rankLabels[k]!.set({ visible: Li > 0.6 && st.pull < 0.5 });
    });
    links.commit();
    stackRankLabels();
    // Copies flying into the context window (local to ctxGroup).
    for (let k = 0; k <= TOP_K; k++) {
      const p = smooth(k * 0.11, k * 0.11 + 0.55, st.pull);
      if (p <= 0) {
        copies.setMatrixAt(k, ZERO);
        slotLabels[k]!.set({ visible: false });
        continue;
      }
      if (k === 0) W(lay.question, v1);
      else db.localToWorld(v1.set(...R.chunks[R.top[k - 1]!.i]!.pos));
      slotWorld(k, v2);
      const e = easeInOut(p);
      v1.lerp(v2, e);
      v1.z += Math.sin(e * Math.PI) * 0.9;
      v1.y += Math.sin(e * Math.PI) * 0.3;
      ctxGroup.worldToLocal(v1);
      const s0x = k === 0 ? (Q_W * lay.qScale) / TILE[0] / lay.ctxScale : lay.dbScale / lay.ctxScale;
      const s0y = k === 0 ? (Q_H * lay.qScale) / TILE[1] / lay.ctxScale : lay.dbScale / lay.ctxScale;
      const sx = s0x + (SLOT_W / TILE[0] - s0x) * e;
      const sy = s0y + (SLOT_H / TILE[1] - s0y) * e;
      if (k === 0) q.identity();
      else q.copy(chunkQ[R.top[k - 1]!.i]!).slerp(q2.identity(), e);
      copies.setMatrixAt(k, m4.compose(v1, q, sc.set(sx, sy, 1)));
      tmpC.copy(k === 0 ? pal.highlight : docColor[R.chunks[R.top[k - 1]!.i]!.doc]!);
      copies.setColorAt(k, tmpC);
      slotLabels[k]!.set({ visible: p > 0.92 });
    }
    copies.instanceMatrix.needsUpdate = true;
    if (copies.instanceColor) copies.instanceColor.needsUpdate = true;
    // Answer.
    const a = st.ans;
    if (flowGen) {
      flowGen.object.visible = a > 0.01;
      flowGen.setOpacity(smooth(0, 0.3, a) * (dark ? 1 : 0.9));
    }
    const llmPulse = smooth(0, 0.5, a) * (1 - 0.4 * smooth(0.7, 1, a));
    glows.set(G_LLM, lay.llm, 2.5, pal.seg['foundation-models'], (dark ? 0.22 : 0.1) + Math.max(llmPulse, hl.llm) * (dark ? 0.6 : 0.4));
    const as = easeOut(smooth(0.45, 1, a));
    answer.scale.setScalar(Math.max(0.001, as));
    answer.visible = as > 0.001;
    glows.set(G_ANS, lay.answer, 2.2, pal.pos, as * (dark ? 0.45 : 0.3));
    lbl.answer.set({ visible: as > 0.7 });
    // Phones: slide the question / answer back inside the stage instead of letting the layer cull them.
    lbl.question.set({ offset: fit.nudge(W(lay.question, qAt).setZ(lay.question[2] + 0.08), qText, 'strong', 'center') });
    if (as > 0.7) lbl.answer.set({ offset: fit.nudge(W(lay.answer, aAt).setZ(lay.answer[2] + 0.08), aText, 'default', compact ? 'below' : 'center') });
    lbl.ansTag.set({ visible: as > 0.7 && !compact });
    // The 模型訓練 tag sits right behind the query point: step aside while searching.
    docTags.forEach((h, i) => h.set({ visible: !compact && (i !== TRAIN || st.s < 0.05) }));
  };

  /* ───────── hotspots ───────── */
  ctx.picker.addPoints(() => (isActive() ? pickPts : []));
  const chunkCard = (i: number): CardContent => {
    const c = R.chunks[i]!;
    const rank = rankOf.get(i);
    const sim = R.ranked.find((x) => x.i === i)?.sim ?? 0;
    return {
      title: `片段：${c.text}`,
      subtitle: `來源 ${DOCS[c.doc]!.title}`,
      swatch: pal.css[cssToken(DOCS[c.doc]!.color)] ?? '',
      body: `與查詢的餘弦相似度 ${sim.toFixed(2)}（示意）${rank !== undefined ? `，排名第 ${rank + 1}，會被放進上下文視窗。` : `，不在前 ${TOP_K} 名，不會被檢索。`}`,
    };
  };
  const inactiveSelect = () => {
    if (isActive()) return false;
    api.goVariant('rag');
    return true;
  };
  const focusPose = (target: Vector3, dist: number): CameraPose => ({ position: [target.x + 0.5, target.y + 1.0, target.z + dist], target: target.clone() });
  const listFocus = (source: string, pose: () => CameraPose) => {
    if (source === 'list' || source === 'command' || source === 'keyboard') ctx.setPose(pose());
  };
  ctx.hotspots.register('vector-db', {
    object: cyl,
    pickable: false,
    anchor: db,
    card: (hit) => (isActive() && hit?.index !== undefined ? chunkCard(hit.index) : null),
    onSelect: (source) => {
      if (inactiveSelect()) return true;
      listFocus(source, () => focusPose(db.getWorldPosition(new Vector3()), 6.8));
      return false;
    },
    onHighlight: (on) => {
      ringMat.opacity = on ? 0.95 : pal.theme === 'dark' ? 0.45 : 0.55;
      cylMat.opacity = on ? 0.1 : 0.05;
      ctx.invalidate();
    },
  });
  ctx.hotspots.register('query-vector', {
    object: query,
    card: () => null,
    onSelect: () => {
      api.goStep(4);
      return true;
    },
  });
  ctx.hotspots.register('top-k', {
    anchor: sphere,
    pickable: false,
    onSelect: () => {
      api.goStep(5);
      return true;
    },
  });
  const lightUp = (key: 'embed' | 'llm') => (on: boolean) => {
    hl[key] = on ? 1 : 0;
    draw(clock);
    ctx.invalidate();
  };
  ctx.hotspots.register('embedding-model', {
    object: embed,
    onHighlight: lightUp('embed'),
    onSelect: (source) => inactiveSelect() || (listFocus(source, () => focusPose(embed.position.clone(), 5.4)), false),
  });
  ctx.hotspots.register('context-window', {
    object: ctxGroup,
    anchor: ctxGlass,
    onSelect: (source) => inactiveSelect() || (listFocus(source, () => focusPose(ctxGroup.position.clone(), 6.2)), false),
  });
  ctx.hotspots.register('rag-answer', {
    object: llm,
    anchor: llm,
    onHighlight: lightUp('llm'),
    card: () =>
      isActive()
        ? {
            title: 'LLM 生成回答（示意）',
            body: ANSWER_TEXT,
            items: R.top.map((t, k) => ({ label: `#${k + 1} ${R.chunks[t.i]!.text}`, meta: DOCS[R.chunks[t.i]!.doc]!.title })),
            href: '/learn/what-is-llm/',
            linkLabel: '閱讀：大型語言模型是什麼 →',
          }
        : null,
    onSelect: (source) => inactiveSelect() || (listFocus(source, () => focusPose(llm.position.clone(), 6.2)), false),
  });

  /* ───────── palette ───────── */
  const palette = (p: Palette) => {
    pal = p;
    const dark = p.theme === 'dark';
    DOCS.forEach((d, i) => markColor(materials.color(d.color as never), p, docColor[i]!));
    for (let i = 0; i < DOCS.length; i++) sheets.setColorAt(DOCS.length - 1 - i, docColor[i]!);
    if (sheets.instanceColor) sheets.instanceColor.needsUpdate = true;
    tileMat.emissive.copy(p.fg).multiplyScalar(dark ? 0.06 : 0);
    glows.setTheme(p.theme);
    ringMat.opacity = dark ? 0.45 : 0.55;
    cylMat.opacity = dark ? 0.045 : 0.06;
    baseMat.opacity = dark ? 0.07 : 0.09;
    slotMat.opacity = dark ? 0.2 : 0.14;
    const ink = netInk(p);
    for (let i = 0; i < netDots.length; i++) dots.setColorAt(i, ink);
    if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    netLineMat.opacity = dark ? 0.35 : 0.55;
    docTags.forEach((h, i) => h.set({ swatch: p.css[cssToken(DOCS[i]!.color)] ?? '' }));
    styleFlows();
  };

  /* ───────── phase machine ───────── */
  const startPlan = () => {
    plan = planFor(step);
    phaseIdx = 0;
    phaseT = 0;
    if (!ctx.animate) {
      phaseIdx = plan.length - 1;
      computeState(phaseIdx, DUR[plan[phaseIdx]!]); // the plan's final state
    } else computeState(0, 0);
  };

  palette(ctx.palette);
  layout(ctx.size.aspect < 0.9);

  return {
    group,
    get floorY() {
      return portrait ? -5.0 : -2.55;
    },
    setActive(on) {
      group.visible = on;
      L.setActive(on);
    },
    start(s) {
      step = s;
      rankAlways();
      startPlan();
      draw(clock);
    },
    update(dt, t) {
      clock = t;
      if (!isActive()) return;
      flowIdx?.update(t);
      flowGen?.update(t);
      if (ctx.animate) {
        phaseT += dt;
        let ph = plan[phaseIdx]!;
        while (phaseT >= DUR[ph]) {
          phaseT -= DUR[ph];
          phaseIdx = (phaseIdx + 1) % plan.length;
          ph = plan[phaseIdx]!;
        }
        computeState(phaseIdx, phaseT);
      }
      draw(t);
    },
    pose(s) {
      const dbW = db.getWorldPosition(new Vector3());
      if (s === 4) {
        // Portrait: the question card is the left end of the top row, so frame the whole row.
        const c = W(lay.embed).lerp(dbW, 0.5).add(v1.set(portrait ? -0.45 : 0.2, portrait ? 0.15 : 0.1, 0));
        return { position: [c.x + 0.5, c.y + 1.6, c.z + (portrait ? 10.6 : 10.4)], target: c };
      }
      if (s === 5) {
        const c = db.localToWorld(new Vector3(...R.query.pos)).add(v1.set(0, portrait ? -0.6 : -0.35, 0));
        return { position: [c.x + 0.8, c.y + (portrait ? 1.5 : 2.2), c.z + (portrait ? 8.6 : 7.2)], target: c };
      }
      if (s === 6) {
        const c = portrait ? dbW.clone().lerp(W(lay.llm), 0.6) : dbW.clone().lerp(W(lay.llm), 0.58).add(v1.set(0, -0.2, 0));
        return { position: [c.x + 0.3, c.y + 1.4, c.z + 9.0], target: c };
      }
      return null;
    },
    layout,
    compact(on) {
      compact = on;
      qText = on ? '問：HBM 和 GPU 怎麼封裝？' : `問：${QUERY_TEXT}`;
      aText = on ? '答：並排在中介層上［#1–#4］' : ANSWER_SHORT;
      lbl.question.set({ text: qText });
      lbl.qTag.set({ visible: !on });
      // Phones: the answer text is wider than its card and would cover the context window's
      // last slot, so it becomes a caption under the card.
      lbl.answer.set({ text: aText, align: on ? 'below' : 'center' });
      slotLabels.forEach((h, k) => h.set({ text: k === 0 ? '問題' : on ? `#${k}` : slotText(k) }));
      rankAlways();
      draw(clock);
    },
    palette,
    motion(animate) {
      flowIdx?.setReduced(!animate);
      flowGen?.setReduced(!animate);
      if (!animate) startPlan();
      draw(clock);
    },
    quality(tier: QualityTier) {
      flowIdx?.setCount(scaleCount(IDX_MAX, tier, 60));
      flowGen?.setCount(scaleCount(GEN_MAX, tier, 30));
    },
  };
}

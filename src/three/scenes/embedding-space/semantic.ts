/**
 * embedding-space · semantic variant — 118 zh-TW words in an illustrative 16-D space, drawn by
 * their first three dims. Clusters get a soft colour nebula and a title; hovering (or tapping) a
 * word links it to its 4 nearest neighbours (cosine similarity, computed for real in space.ts).
 *
 * Steps: 0 總覽 (gentle twinkle) · 1 詞即向量 (a floating panel with one word's 16 numbers,
 * cycling 貓 → 老虎 → 快樂, with 貓 kept as reference ticks and the similarity to 貓) · 2 最近鄰
 * (a close-up of 晶片 / 記憶體 / 城市, cycling GPU → HBM → 台北 with neighbour links) · 3 向量運算 (parallelograms: the same
 * arrow 「女人 − 男人」 re-applied at 國王 lands next to 女王; 「東京 − 日本」 at 台灣 lands at 台北).
 * Reduced motion: each step's final state (step 1 compares 老虎 with 貓, step 2 shows GPU).
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  ShapeGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { CameraPose, CardContent, LabelHandle, LabelSpec, Palette, SceneContext } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { CLUSTERS, DIM, buildSemantic, cosine } from './space';
import {
  LabelFit,
  LabelSet,
  Links,
  clamp01,
  cssToken,
  easeOut,
  markColor,
  roundedRect,
  roundedRectOutline,
  smooth,
  type Align,
  type Box,
  type View,
  type ViewApi,
} from './common';

const K = 4; // neighbours shown
const R_POINT = 0.095;
const VEC_DEMO = ['貓', '老虎', '快樂'] as const; // [0] is the reference word
const NN_DEMO = ['GPU', 'HBM', '台北'] as const; // all inside the step-2 close-up
const CYCLE = 4.6; // seconds per demo word
const ANALOGY_T = 11; // one analogy cycle (both parallelograms, then a hold)
const AN_GAP = 4.2; // the second parallelogram starts this much later

/* Links: 0..3 neighbours · 4..11 analogy (4 per analogy) · 12 panel leader */
const L_NN = 0;
const L_AN = K;
const L_LEAD = K + 8;

/* Vector panel (HUD), in panel units. */
const PW = 2.6;
const PH = 1.3;
const BARS = DIM;
const BAR_STEP = (PW - 0.44) / BARS;
const BAR_W = BAR_STEP * 0.62;
const BAR_H = 0.36;
const ZERO_Y = 0.05;
const barX = (k: number) => -PW / 2 + 0.22 + BAR_STEP * (k + 0.5);

const m4 = new Matrix4();
const q = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const sc = new Vector3();
const tmpC = new Color();
const ZERO = new Matrix4().makeScale(0, 0, 0);

export function createSemantic(ctx: SceneContext, parent: Group, api: ViewApi): View {
  const S = buildSemantic();
  const N = S.words.length;
  const { materials } = ctx;
  const group = new Group();
  group.name = 'semantic';
  parent.add(group);
  const space = new Group(); // rotated −90° about z on portrait stages
  group.add(space);
  const L = new LabelSet(ctx);
  const fit = new LabelFit(ctx);
  const isActive = () => api.active === 'semantic';
  const idx = (w: string) => S.index.get(w) ?? 0;
  const local = (i: number, out = v1) => out.set(S.words[i]!.pos[0], S.words[i]!.pos[1], S.words[i]!.pos[2]);
  const world = (i: number, out = new Vector3()) => local(i, out).applyMatrix4(space.matrixWorld);

  /* ───────── points ───────── */
  const pointMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.06 }));
  const points = new InstancedMesh(ctx.track(new IcosahedronGeometry(R_POINT, 2)), pointMat, N);
  points.instanceMatrix.setUsage(DynamicDrawUsage);
  points.setColorAt(0, tmpC.set(1, 1, 1));
  space.add(points);
  ctx.track({ dispose: () => points.dispose() });

  const G_NEB = N;
  const G_AUX = N + CLUSTERS.length;
  const glows = ctx.track(new GlowSprites({ count: N + CLUSTERS.length + 4, theme: ctx.theme }));
  space.add(glows.object);

  /* ───────── axis triad (front-left, near the floor) ───────── */
  const AX0 = new Vector3(-4.7, -2.9, 2.2);
  const AXL = 0.8;
  const axesGeo = ctx.track(new BufferGeometry());
  axesGeo.setAttribute(
    'position',
    new Float32BufferAttribute(
      [...AX0.toArray(), AX0.x + AXL, AX0.y, AX0.z, ...AX0.toArray(), AX0.x, AX0.y + AXL, AX0.z, ...AX0.toArray(), AX0.x, AX0.y, AX0.z - AXL],
      3,
    ),
  );
  const axesMat = materials.line('fg', { transparent: true, opacity: 0.45, depthWrite: false });
  space.add(new LineSegments(axesGeo, axesMat));
  const axisLabels = ['維度 1', '維度 2', '維度 3'].map((text, a) =>
    L.add({
      text,
      object: space,
      position: [AX0.x + (a === 0 ? AXL : 0), AX0.y + (a === 1 ? AXL : 0), AX0.z - (a === 2 ? AXL : 0)],
      align: a === 1 ? 'above' : 'right',
      offset: [a === 1 ? 0 : 4, 0],
      kind: 'tag',
      priority: 26,
    }),
  );

  /* ───────── links, rings ───────── */
  const links = new Links(ctx, L_LEAD + 1, { renderOrder: 6 });
  space.add(links.group);
  const ringMat = ctx.track(new MeshBasicMaterial({ toneMapped: false, transparent: true, depthWrite: false }));
  const rings = new InstancedMesh(ctx.track(new TorusGeometry(1, 0.06, 8, 64)), ringMat, 4);
  rings.instanceMatrix.setUsage(DynamicDrawUsage);
  rings.setColorAt(0, tmpC.set(1, 1, 1));
  rings.renderOrder = 7;
  rings.frustumCulled = false;
  for (let k = 0; k < 4; k++) rings.setMatrixAt(k, ZERO);
  group.add(rings); // world space: rings face the camera
  ctx.track({ dispose: () => rings.dispose() });

  /* ───────── vector panel (step 1): a camera-locked card ───────── */
  const panel = new Group();
  panel.visible = false;
  group.add(panel);
  const hud = <T extends Mesh | LineSegments | InstancedMesh>(o: T, order: number): T => {
    o.renderOrder = order;
    o.frustumCulled = false;
    const m = o.material as MeshBasicMaterial;
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    panel.add(o);
    return o;
  };
  const panelBgMat = materials.basic('bg', { transparent: true, opacity: 0.97 });
  hud(new Mesh(ctx.track(new ShapeGeometry(roundedRect(PW, PH, 0.13), 6)), panelBgMat), 20);
  const panelLineMat = materials.line('muted', { transparent: true, opacity: 0.6 });
  hud(new LineSegments(ctx.track(roundedRectOutline(PW, PH, 0.13, 0)), panelLineMat), 21);
  const zeroGeo = ctx.track(new BufferGeometry());
  {
    // zero line + a bracket under the first three bars (the plotted dims)
    const x0 = barX(0) - BAR_STEP * 0.4;
    const x2 = barX(2) + BAR_STEP * 0.4;
    const yb = ZERO_Y - BAR_H - 0.07;
    zeroGeo.setAttribute(
      'position',
      new Float32BufferAttribute(
        [-PW / 2 + 0.16, ZERO_Y, 0, PW / 2 - 0.16, ZERO_Y, 0, x0, yb + 0.04, 0, x0, yb, 0, x0, yb, 0, x2, yb, 0, x2, yb, 0, x2, yb + 0.04, 0],
        3,
      ),
    );
  }
  const zeroMat = materials.line('muted', { transparent: true, opacity: 0.9 });
  hud(new LineSegments(zeroGeo, zeroMat), 21);
  const barGeo = ctx.track(new BoxGeometry(1, 1, 1));
  const bars = hud(new InstancedMesh(barGeo, ctx.track(new MeshBasicMaterial({ toneMapped: false })), BARS), 22);
  bars.instanceMatrix.setUsage(DynamicDrawUsage);
  bars.setColorAt(0, tmpC.set(1, 1, 1));
  ctx.track({ dispose: () => bars.dispose() });
  const tickMat = materials.basic('fg');
  const ticks = hud(new InstancedMesh(barGeo, tickMat, BARS), 23);
  ticks.instanceMatrix.setUsage(DynamicDrawUsage);
  ctx.track({ dispose: () => ticks.dispose() });
  const panelTitle = L.add({ text: '', object: panel, position: [0, PH / 2, 0], align: 'above', offset: [0, -2], kind: 'strong', priority: 96, always: true, visible: false });
  const panelDims = L.add({
    text: '前 3 維＝畫面座標',
    object: panel,
    position: [barX(1), ZERO_Y - BAR_H - 0.07, 0],
    align: 'below',
    offset: [0, 1],
    kind: 'tag',
    priority: 94,
    always: true,
    visible: false,
  });
  const panelSim = L.add({ text: '', object: panel, position: [PW / 2 - 0.16, -PH / 2 + 0.06, 0], align: 'left', offset: [0, -10], kind: 'default', priority: 95, always: true, visible: false });
  const panelRef = L.add({ text: '細線＝「貓」', object: panel, position: [PW / 2 - 0.16, PH / 2 - 0.08, 0], align: 'left', offset: [0, 10], kind: 'tag', priority: 93, always: true, visible: false });
  let titleText = '';
  let simVal: number | null = null;
  /** Panel footers; phones get the short forms so the two fit side by side. */
  const panelTexts = () => {
    panelDims.set({ text: compact ? '前 3 維＝座標' : '前 3 維＝畫面座標' });
    panelSim.set({ text: simVal === null ? '先記住「貓」的形狀' : `${compact ? '與「貓」相似度' : '與「貓」的相似度'} ${simVal.toFixed(2)}` });
  };
  let barMax = 0;
  for (const w of S.words) for (let d = 0; d < DIM; d++) barMax = Math.max(barMax, Math.abs(w.vec[d]!));
  const barVal = (x: number) => Math.sign(x) * Math.abs(x / barMax) ** 0.75;
  const refIdx = idx(VEC_DEMO[0]);
  const barShown = new Float32Array(BARS);
  let barFrom = new Float32Array(BARS);
  let barTo = new Float32Array(BARS);
  let barK = 1;

  /* ───────── labels ───────── */
  const wordLabels: LabelHandle[] = S.words.map((w) =>
    L.add({ text: w.text, object: space, position: w.pos, align: 'above', offset: [0, 1], kind: 'tag', priority: 4 + w.rank }),
  );
  const titles = CLUSTERS.map((c, ci) => ({
    ci,
    h: L.add({ text: c.name, position: [0, 0, 0], kind: 'strong', align: 'above', priority: 30, hotspot: c.hotspot }),
  }));

  /* ───────── analogies ───────── */
  const AN = [
    { a: '國王', b: '男人', c: '女人', relFrom: '男人', relTo: '女人', base: '國王', rel: '女人 − 男人', guide: ['男人', '國王'] },
    { a: '東京', b: '日本', c: '台灣', relFrom: '日本', relTo: '東京', base: '台灣', rel: '東京 − 日本', guide: ['日本', '台灣'] },
  ].map((d) => {
    const r = S.analogy(d.a, d.b, d.c);
    return {
      ...d,
      best: r.best,
      sim: r.sim,
      result: new Vector3(r.result[0], r.result[1], r.result[2]),
      iFrom: idx(d.relFrom),
      iTo: idx(d.relTo),
      iBase: idx(d.base),
      iGuide: idx(d.guide[0]!),
    };
  });
  const eqText = AN.map((d) => `${d.a} − ${d.b} + ${d.c} ≈ ${S.words[d.best]!.text}`);
  const simText = AN.map((d) => `相似度 ${d.sim.toFixed(2)}（示意）`);
  const eqLabels = AN.map((_, k) =>
    L.add({
      text: eqText[k]!,
      position: [0, 0, 0],
      kind: 'strong',
      align: k === 0 ? 'right' : 'left',
      offset: [k === 0 ? 18 : -18, 0],
      priority: 92,
      always: true,
      visible: false,
    }),
  );
  const simLabels = AN.map((_, k) =>
    L.add({
      text: simText[k]!,
      position: [0, 0, 0],
      kind: 'tag',
      align: k === 0 ? 'right' : 'left',
      offset: [k === 0 ? 22 : -22, 22],
      priority: 91,
      always: true,
      visible: false,
    }),
  );
  const relLabels = AN.map((d) => L.add({ text: d.rel, position: [0, 0, 0], kind: 'default', align: 'center', priority: 88, always: true, visible: false }));
  const iTaipei = idx('台北');
  const ANALOGY_WORDS = new Set(AN.flatMap((d) => [idx(d.a), idx(d.b), idx(d.c), d.best]));

  /* ───────── state ───────── */
  const nn = S.words.map((_, i) => S.neighbours(i, K));
  const colors: Color[] = CLUSTERS.map(() => new Color());
  let pal: Palette = ctx.palette;
  let step = 0;
  let t0 = 0; // step clock (animation time)
  let clock = 0;
  let hover: number | null = null;
  let pinned: number | null = null;
  const userFocus = () => hover !== null || pinned !== null;
  let hot: number[] = []; // clusters lit by a hotspot highlight
  let focus: number | null = null; // effective focus word
  let focusSince = 0;
  let portrait = false;
  let compact = false;
  const emp = new Float32Array(N).fill(1); // displayed emphasis (0 dim … 1 normal … 2 focus)
  const empT = new Float32Array(N).fill(1);
  const neb = new Float32Array(CLUSTERS.length).fill(1);
  let analogyK = 1; // 0..1 timeline position (static = 1)
  const showLinks = () => focus !== null && step !== 1;

  const demoWord = (list: readonly string[], t: number) => idx(list[Math.floor(Math.max(0, t) / CYCLE) % list.length]!);
  const demoFocus = (): number | null => {
    if (step === 1) return ctx.animate ? demoWord(VEC_DEMO, clock - t0) : idx(VEC_DEMO[1]);
    if (step === 2) return ctx.animate ? demoWord(NN_DEMO, clock - t0) : idx(NN_DEMO[0]);
    return null;
  };

  /* ───────── drawing ───────── */
  const clusterEmp = new Float32Array(CLUSTERS.length);
  const drawPoints = (t: number) => {
    const dark = pal.theme === 'dark';
    clusterEmp.fill(0);
    for (let i = 0; i < N; i++) {
      const w = S.words[i]!;
      const e = emp[i]!;
      clusterEmp[w.cluster] = Math.max(clusterEmp[w.cluster]!, e);
      const dim = clamp01(1 - e);
      const lit = clamp01(e - 1);
      tmpC.copy(colors[w.cluster]!).lerp(pal.bg, dim * (dark ? 0.86 : 0.7));
      points.setColorAt(i, tmpC);
      const s = 1 + 0.6 * lit - 0.2 * dim;
      points.setMatrixAt(i, m4.compose(local(i), q.identity(), sc.setScalar(s)));
      const tw = ctx.animate && step === 0 ? 0.78 + 0.22 * Math.sin(t * 1.6 + i * 2.39) : 1;
      const base = dark ? 0.5 : 0.2;
      glows.set(i, local(i), (dark ? 0.44 : 0.36) * (1 + 0.9 * lit), colors[w.cluster]!, base * tw * (1 - dim) ** 2 + lit * (dark ? 0.5 : 0.42));
    }
    points.instanceMatrix.needsUpdate = true;
    if (points.instanceColor) points.instanceColor.needsUpdate = true;
    CLUSTERS.forEach((c, ci) => {
      const a = (dark ? 0.16 : 0.2) * neb[ci]! * (0.25 + 0.75 * clamp01(clusterEmp[ci]!));
      glows.set(G_NEB + ci, c.centre, ci === 4 ? 3.3 : 2.7, colors[ci]!, a);
    });
  };

  /* Smart neighbour-label placement: labels go to the side away from the focus word, stacked. */
  const proj = (wp: Vector3, out: { x: number; y: number }) => {
    v3.copy(wp).project(ctx.camera);
    out.x = ((v3.x + 1) / 2) * ctx.size.width;
    out.y = ((1 - v3.y) / 2) * ctx.size.height;
  };
  const sp = Array.from({ length: K + 1 }, () => ({ x: 0, y: 0 }));
  const order = Array.from({ length: K }, (_, k) => k);
  const side = new Int8Array(K);
  const offY = new Float32Array(K);
  const placeNeighbourLabels = () => {
    const f = focus;
    if (f === null || !showLinks()) return;
    proj(world(f, v2), sp[K]!);
    const fx = sp[K]!.x;
    for (let k = 0; k < K; k++) {
      proj(world(nn[f]![k]!.i, v2), sp[k]!);
      side[k] = sp[k]!.x >= fx ? 1 : -1;
    }
    for (const sd of [1, -1]) {
      const ids = order.filter((k) => side[k] === sd).sort((a, b) => sp[a]!.y - sp[b]!.y);
      let last = -Infinity;
      for (const k of ids) {
        const y = Math.max(sp[k]!.y, last + 21);
        offY[k] = Math.round(y - sp[k]!.y);
        last = y;
      }
    }
    for (let k = 0; k < K; k++) {
      const n = nn[f]![k]!;
      wordLabels[n.i]!.set({ align: side[k]! > 0 ? 'right' : 'left', offset: [side[k]! > 0 ? 9 : -9, offY[k]!] });
    }
  };

  const drawNeighbours = (now: number) => {
    const f = focus;
    if (f === null || !showLinks()) {
      links.hideAll(L_NN, L_NN + K);
      return;
    }
    for (let k = 0; k < K; k++) {
      const n = nn[f]![k]!;
      const prog = ctx.animate ? easeOut(clamp01((now - focusSince) * 2.4 - k * 0.2)) : 1;
      links.set(L_NN + k, local(f, v2), local(n.i, v3), { radius: 0.02, color: pal.highlight, progress: prog, trimStart: R_POINT * 1.2, trimEnd: R_POINT * 1.2 });
    }
  };

  const applyWordLabels = () => {
    const f = focus;
    const nbr = new Map<number, number>();
    if (f !== null && showLinks()) nn[f]!.forEach((n) => nbr.set(n.i, n.sim));
    S.words.forEach((w, i) => {
      const h = wordLabels[i]!;
      const sw = pal.css[cssToken(CLUSTERS[w.cluster]!.color)] ?? '';
      if (i === f) {
        h.set({ text: w.text, kind: 'strong', align: 'above', offset: [0, -2], priority: 99, always: true, visible: true, swatch: sw });
      } else if (nbr.has(i)) {
        h.set({ text: `${w.text} ${nbr.get(i)!.toFixed(2)}`, kind: 'default', priority: 90, always: true, visible: true, swatch: '' });
      } else {
        const base: Partial<LabelSpec> = { text: w.text, kind: 'tag', align: 'above', offset: [0, 1], always: false, swatch: '' };
        if (step === 1) {
          const demo = (VEC_DEMO as readonly string[]).includes(w.text);
          h.set({ ...base, priority: demo ? 80 : 2, visible: demo || f === null });
        } else if (step === 3) {
          const an = ANALOGY_WORDS.has(i);
          // Phones (4:3): 東京 sits just up-right of 台北, so 台北's label moves to its left side.
          const side = i === iTaipei && compact && !portrait;
          h.set({ ...base, kind: an ? 'default' : 'tag', priority: an ? 70 : 2, always: an, visible: an, align: side ? 'left' : 'above', offset: side ? [-6, 0] : [0, 1] });
        } else {
          const lit = hot.includes(w.cluster);
          h.set({ ...base, priority: 4 + w.rank + (lit ? 20 : 0), visible: f === null || !showLinks() });
        }
      }
    });
  };

  const TITLE_STEP: Record<number, readonly string[]> = { 1: ['animals', 'emotions'], 3: ['people', 'cities', 'countries'] };
  const applyTitles = () => {
    const only = TITLE_STEP[step];
    titles.forEach((t) => {
      const id = CLUSTERS[t.ci]!.id;
      t.h.set({ visible: (!only || only.includes(id)) && !(portrait && step === 3 && id === 'people') });
    });
    axisLabels.forEach((h) => h.set({ visible: step === 0 && !compact }));
  };

  const setTargets = () => {
    const f = focus;
    const nbr = new Set(f !== null && showLinks() ? nn[f]!.map((n) => n.i) : []);
    for (let i = 0; i < N; i++) {
      let e = 1;
      if (f !== null && showLinks()) e = i === f ? 1.9 : nbr.has(i) ? 1.4 : 0.2;
      else if (step === 1) e = i === f ? 2 : (VEC_DEMO as readonly string[]).includes(S.words[i]!.text) ? 1.25 : 0.3;
      else if (step === 3) e = ANALOGY_WORDS.has(i) ? 1.35 : 0.3;
      if (hot.length && f === null) e = hot.includes(S.words[i]!.cluster) ? Math.max(e, 1.3) : Math.min(e, 0.45);
      empT[i] = e;
    }
    if (!ctx.animate) emp.set(empT);
    applyWordLabels();
    applyTitles();
  };

  const setFocus = (i: number | null, now: number) => {
    if (i === focus) return;
    focus = i;
    focusSince = now;
    if (step === 1 && i !== null) {
      barFrom = barShown.slice();
      barTo = Float32Array.from(S.words[i]!.vec, barVal);
      barK = ctx.animate ? 0 : 1;
      if (!ctx.animate) barShown.set(barTo);
      const w = S.words[i]!.text;
      titleText = `「${w}」的嵌入向量（示意 ${DIM} 維）`;
      panelTitle.set({ text: titleText });
      simVal = i === refIdx ? null : cosine(S.words[i]!.vec, S.words[refIdx]!.vec);
      panelTexts();
    }
    setTargets();
  };

  /* ───────── vector panel ───────── */
  const titleAt = new Vector3();
  const placePanel = () => {
    const cam = ctx.camera;
    const D = 6;
    const halfH = D * Math.tan((cam.fov * Math.PI) / 360);
    const halfW = halfH * cam.aspect;
    const perPx = (2 * halfH) / Math.max(1, ctx.size.height); // world units per stage px at depth D
    const narrow = cam.aspect < 0.95;
    // Phones in landscape (4:3 stages under 600 px) get a larger share so the 16 bars stay legible.
    const share = narrow ? 0.84 : compact ? 0.62 : 0.34;
    const s = Math.min(narrow ? 1.35 : compact ? 1.6 : 1.15, (halfW * 2 * share) / PW);
    const x = narrow ? 0 : -halfW + (PW * s) / 2 + Math.max(halfW * (compact ? 0.03 : 0.07), 8 * perPx);
    // Leave room above the card for its title (about 40 px), which the label layer would cull.
    const top = Math.max(halfH * (narrow || compact ? 0 : 0.17), 40 * perPx);
    const y = halfH - (PH * s) / 2 - top;
    panel.position.copy(cam.position).add(v2.set(x, y, -D).applyQuaternion(cam.quaternion));
    panel.quaternion.copy(cam.quaternion);
    panel.scale.setScalar(s);
    panel.updateMatrixWorld(true);
    titleAt.set(0, PH / 2, 0);
    panel.localToWorld(titleAt);
    panelTitle.set({ offset: fit.nudge(titleAt, titleText, 'strong', 'above', [0, -2]) });
  };
  const drawPanel = () => {
    const on = step === 1 && focus !== null && isActive();
    panel.visible = on;
    for (const h of [panelTitle, panelDims, panelSim]) h.set({ visible: on });
    panelRef.set({ visible: on && focus !== refIdx });
    if (!on || focus === null) {
      links.hide(L_LEAD);
      return;
    }
    placePanel();
    const showTicks = focus !== refIdx;
    const ref = S.words[refIdx]!.vec;
    for (let d = 0; d < BARS; d++) {
      const v = barShown[d]!;
      const h = Math.max(0.012, Math.abs(v) * BAR_H);
      const y = ZERO_Y + (v >= 0 ? h / 2 : -h / 2);
      bars.setMatrixAt(d, m4.compose(v2.set(barX(d), y, 0.01), q.identity(), sc.set(BAR_W, h, 0.01)));
      tmpC.copy(v >= 0 ? pal.flow : pal.heat);
      if (d >= 3) tmpC.lerp(pal.bg, 0.3);
      bars.setColorAt(d, tmpC);
      if (showTicks) {
        const r = barVal(ref[d]!);
        ticks.setMatrixAt(d, m4.compose(v2.set(barX(d), ZERO_Y + r * BAR_H, 0.02), q.identity(), sc.set(BAR_STEP * 0.92, 0.016, 0.01)));
      } else ticks.setMatrixAt(d, ZERO);
    }
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    ticks.instanceMatrix.needsUpdate = true;
    // Leader from the panel edge to the word (in `space` local coordinates).
    panel.localToWorld(v2.set(portrait ? 0 : PW / 2, portrait ? -PH / 2 : 0, 0));
    space.worldToLocal(v2);
    tmpC.copy(pal.muted).lerp(pal.bg, 0.25);
    links.set(L_LEAD, v2, local(focus, v3), { radius: 0.0065, color: tmpC, trimEnd: R_POINT * 1.8 });
  };

  /* ───────── analogy parallelograms ───────── */
  /**
   * Equation + similarity sit beside the result ring, on the side that fits the stage (phones:
   * a point near the edge would push a long equation off-screen, and the layer would cull it).
   * Order: preferred side, other side, above, below; else above (or below), slid inside.
   */
  const aPx = { x: 0, y: 0 };
  const ePx = { x: 0, y: 0 };
  const bE: Box = { x: 0, y: 0, w: 0, h: 0 };
  const bS: Box = { x: 0, y: 0, w: 0, h: 0 };
  const camRight = new Vector3();
  /**
   * Side preference per analogy (0 = 國王/女王, 1 = 東京/台北): landscape, portrait, then small
   * landscape stages (phones at 4:3), where beside-the-ring would cover the other parallelogram.
   */
  const SIDES: Align[][] = [
    ['right', 'left', 'below', 'above'],
    ['left', 'above', 'right', 'below'],
    ['right', 'below', 'left', 'above'],
    ['right', 'above', 'left', 'below'],
    ['above', 'right', 'below', 'left'],
    ['above', 'left', 'below', 'right'],
  ];
  const placeEquation = (k: number, at: Vector3, ringR: number) => {
    if (!fit.px(at, aPx)) return;
    camRight.setFromMatrixColumn(ctx.camera.matrixWorld, 0);
    fit.px(v3.copy(at).addScaledVector(camRight, ringR), ePx);
    const r = Math.hypot(ePx.x - aPx.x, ePx.y - aPx.y);
    const [ew, eh] = fit.size(eqText[k]!, 'strong');
    const [sw, sh] = fit.size(simText[k]!, 'tag');
    const order = SIDES[(portrait ? 2 : compact ? 4 : 0) + k]!;
    const at2 = (side: Align): [readonly [number, number], readonly [number, number]] => {
      if (side === 'right' || side === 'left') {
        const sx = side === 'right' ? 1 : -1;
        const gap = Math.max(14, Math.round(r - 4));
        return [
          [sx * gap, -Math.round(sh / 2)],
          [sx * (gap + 4), Math.round(eh / 2) + 1],
        ];
      }
      if (side === 'above') {
        // Clear the ring and the answer word's own label, which sits just above its point.
        const up = Math.max(r, fit.size(S.words[AN[k]!.best]!.text, 'default')[1] + 10);
        return [[0, -Math.round(up + sh + 2)], [0, -Math.round(up)]];
      }
      return [[0, Math.round(r)], [0, Math.round(r + eh + 2)]];
    };
    let chosen: Align | null = null;
    for (const side of order) {
      const [oe, os] = at2(side);
      fit.box(aPx.x, aPx.y, ew, eh, side, oe, bE);
      fit.box(aPx.x, aPx.y, sw, sh, side, os, bS);
      if (fit.inside(bE) && fit.inside(bS)) {
        chosen = side;
        break;
      }
    }
    let dx = 0;
    if (!chosen) {
      // Nothing fits as is: centre it above the ring (below when that leaves the top) and slide.
      chosen = fit.box(aPx.x, aPx.y, ew, eh, 'above', at2('above')[0], bE).y < 4 ? 'below' : 'above';
      dx = fit.slide(fit.box(aPx.x, aPx.y, Math.max(ew, sw), eh, chosen, at2(chosen)[0], bE))[0];
    }
    const [oe, os] = at2(chosen);
    eqLabels[k]!.set({ align: chosen, offset: [oe[0] + dx, oe[1]] });
    simLabels[k]!.set({ align: chosen, offset: [os[0] + dx, os[1]] });
  };

  const anLabels = [...eqLabels, ...simLabels, ...relLabels];
  const aFrom = new Vector3();
  const aTo = new Vector3();
  const aBase = new Vector3();
  const aGuide = new Vector3();
  const aBest = new Vector3();
  const wBest = new Vector3();
  const wRes = new Vector3();
  const guideC = new Color();
  const drawAnalogy = () => {
    const on = step === 3 && isActive();
    if (!on) {
      links.hideAll(L_AN, L_AN + 8);
      for (let k = 0; k < 4; k++) rings.setMatrixAt(k, ZERO);
      rings.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < 4; k++) glows.setAlpha(G_AUX + k, 0);
      for (const h of anLabels) h.set({ visible: false });
      return;
    }
    const T = analogyK * ANALOGY_T;
    const ink = pal.fg;
    guideC.copy(pal.muted).lerp(pal.bg, pal.theme === 'dark' ? 0.15 : 0.1);
    const trim = R_POINT * 1.5;
    AN.forEach((d, k) => {
      const o = k * AN_GAP;
      const pA = smooth(o, o + 1.0, T); // the relation arrow
      const pG = smooth(o + 1.0, o + 1.6, T); // parallelogram guides
      const pB = smooth(o + 1.6, o + 2.7, T); // the same arrow, re-applied at `base`
      const pR = smooth(o + 2.7, o + 3.2, T); // result ring + equation
      const L0 = L_AN + k * 4;
      local(d.iFrom, aFrom);
      local(d.iTo, aTo);
      local(d.iBase, aBase);
      local(d.best, aBest);
      links.set(L0, aFrom, aTo, { radius: 0.024, color: ink, head: 0.2, progress: pA, trimStart: trim, trimEnd: trim });
      links.set(L0 + 1, aBase, d.result, { radius: 0.024, color: ink, head: 0.2, progress: pB, trimStart: trim, trimEnd: trim });
      links.set(L0 + 2, local(d.iGuide, aGuide), aBase, { radius: 0.008, color: guideC, progress: pG, trimStart: trim, trimEnd: trim });
      links.set(L0 + 3, aTo, aBest, { radius: 0.008, color: guideC, progress: pG, trimStart: trim, trimEnd: trim });
      // Rings: around the nearest word (big) and at the computed point (small), facing the camera.
      wBest.copy(aBest).applyMatrix4(space.matrixWorld);
      wRes.copy(d.result).applyMatrix4(space.matrixWorld);
      const rs = easeOut(pR);
      rings.setMatrixAt(k * 2, m4.compose(wBest, ctx.camera.quaternion, sc.setScalar(0.26 * rs)));
      rings.setMatrixAt(k * 2 + 1, m4.compose(wRes, ctx.camera.quaternion, sc.setScalar(0.09 * rs)));
      rings.setColorAt(k * 2, pal.highlight);
      rings.setColorAt(k * 2 + 1, ink);
      glows.set(G_AUX + k, aBest, 1.0, pal.highlight, (pal.theme === 'dark' ? 0.6 : 0.42) * pR);
      eqLabels[k]!.set({ visible: pR > 0.5, position: wBest });
      simLabels[k]!.set({ visible: pR > 0.5, position: wBest });
      if (pR > 0.5) placeEquation(k, wBest, 0.26);
      relLabels[k]!.set({ visible: pA > 0.7, position: aFrom.lerp(aTo, 0.5).applyMatrix4(space.matrixWorld) });
    });
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  };

  /* ───────── layout (portrait rotates the space) ───────── */
  const pickPts: { position: Vector3; id: string | null }[] = S.words.map((w) => ({ position: new Vector3(), id: CLUSTERS[w.cluster]!.hotspot }));
  const layout = (p: boolean) => {
    portrait = p;
    space.rotation.z = p ? -Math.PI / 2 : 0;
    space.updateMatrixWorld(true);
    // Rotated space: dim 1 points down, dim 2 points right.
    axisLabels[0]!.set({ align: p ? 'below' : 'right', offset: p ? [0, 2] : [4, 0] });
    axisLabels[1]!.set({ align: p ? 'right' : 'above', offset: p ? [4, 0] : [0, 0] });
    axisLabels[2]!.set({ align: p ? 'left' : 'right', offset: p ? [-4, 0] : [4, 0] });
    S.words.forEach((_, i) => world(i, pickPts[i]!.position));
    titles.forEach((t) => {
      // The title sits above the cluster's top-most word (screen-up = world +y).
      let top = -Infinity;
      let cx = 0;
      let cz = 0;
      let n = 0;
      S.words.forEach((w, i) => {
        if (w.cluster !== t.ci) return;
        const wp = pickPts[i]!.position;
        top = Math.max(top, wp.y);
        cx += wp.x;
        cz += wp.z;
        n++;
      });
      t.h.set({ position: new Vector3(cx / n, top + 0.24, cz / n) });
    });
  };

  /* ───────── hotspots ───────── */
  const clusterOfHotspot = (id: string) => CLUSTERS.map((c, ci) => (c.hotspot === id ? ci : -1)).filter((x) => x >= 0);
  const wordCard = (i: number): CardContent => {
    const w = S.words[i]!;
    const c = CLUSTERS[w.cluster]!;
    return {
      title: `「${w.text}」`,
      subtitle: `${c.name}聚落・示意向量`,
      swatch: pal.css[cssToken(c.color)] ?? '',
      body: `最相近的 ${K} 個詞（餘弦相似度，越接近 1 越相似）：`,
      items: nn[i]!.map((n) => ({ label: S.words[n.i]!.text, meta: n.sim.toFixed(2) })),
    };
  };
  for (const hs of new Set(CLUSTERS.map((c) => c.hotspot))) {
    const cis = clusterOfHotspot(hs);
    const anchor = new Object3D();
    space.add(anchor);
    anchor.position.copy(cis.reduce((s, ci) => s.add(v1.set(...CLUSTERS[ci]!.centre)), new Vector3()).divideScalar(cis.length));
    ctx.hotspots.register(hs, {
      anchor,
      pickable: false,
      card: (hit) => (isActive() && hit?.index !== undefined ? wordCard(hit.index) : null),
      onHighlight: (on) => {
        if (!isActive()) return;
        hot = on ? cis : [];
        for (let ci = 0; ci < CLUSTERS.length; ci++) neb[ci] = on ? (cis.includes(ci) ? 2.2 : 0.6) : 1;
        setTargets();
        ctx.invalidate();
      },
      onSelect: (source) => {
        if (!isActive()) {
          api.goVariant('semantic');
          return true;
        }
        if (source === 'pointer') return true; // the hover card stays; the click pinned the word
        if (source === 'list' || source === 'command' || source === 'keyboard') {
          const c = anchor.getWorldPosition(new Vector3());
          ctx.setPose({ position: [c.x + 0.8, c.y + 1.4, c.z + 6.6], target: c });
        }
        return false;
      },
    });
  }
  const anAnchor = new Object3D();
  space.add(anAnchor);
  anAnchor.position.set(...S.words[idx('女王')]!.pos);
  ctx.hotspots.register('vector-arithmetic', {
    anchor: anAnchor,
    pickable: false,
    onSelect: () => {
      api.goStep(3); // step 3 forces the semantic variant
      return true;
    },
  });
  ctx.picker.addPoints(() => (isActive() ? pickPts : []));
  const wordAt = (hit: { index?: number; object: unknown } | null) => (hit && hit.index !== undefined && hit.object === ctx.camera ? hit.index : null);
  ctx.picker.onHover((hit) => {
    if (!isActive()) return;
    const i = wordAt(hit);
    if (i === hover) return;
    hover = i;
    setFocus(hover ?? pinned ?? demoFocus(), clock);
    ctx.invalidate();
  });
  // A click / tap pins a word's neighbours (touch has no hover); clicking empty space unpins.
  ctx.picker.onClick((hit) => {
    if (!isActive()) return;
    pinned = wordAt(hit);
    setFocus(hover ?? pinned ?? demoFocus(), clock);
    ctx.invalidate();
  });

  /* ───────── theme ───────── */
  const palette = (p: Palette) => {
    pal = p;
    const dark = p.theme === 'dark';
    CLUSTERS.forEach((c, ci) => markColor(materials.color(c.color as never), p, colors[ci]!));
    glows.setTheme(p.theme);
    axesMat.opacity = dark ? 0.5 : 0.42;
    pointMat.emissive.copy(p.fg).multiplyScalar(dark ? 0.07 : 0);
    ringMat.opacity = dark ? 0.95 : 0.9;
    titles.forEach((t) => t.h.set({ swatch: p.css[cssToken(CLUSTERS[t.ci]!.color)] ?? '' }));
    applyWordLabels();
  };
  palette(ctx.palette);
  layout(ctx.size.aspect < 0.9);

  const redraw = (t: number) => {
    drawPoints(t);
    drawNeighbours(clock);
    drawPanel();
    drawAnalogy();
    placeNeighbourLabels();
    links.commit();
  };

  return {
    group,
    get floorY() {
      return portrait ? -5.35 : -3.05;
    },
    setActive(on) {
      group.visible = on;
      L.setActive(on);
      if (!on) {
        hover = null;
        panel.visible = false;
      }
    },
    start(s) {
      step = s;
      t0 = clock;
      hover = null;
      pinned = null;
      hot = [];
      neb.fill(1);
      focus = null;
      analogyK = ctx.animate ? 0 : 1;
      barShown.fill(0);
      setFocus(demoFocus(), clock);
      setTargets();
      if (!ctx.animate) {
        emp.set(empT);
        barShown.set(barTo);
        barK = 1;
      }
      redraw(clock);
    },
    update(dt, t) {
      clock = t;
      if (!isActive()) return;
      if (ctx.animate) {
        const k = 1 - Math.exp(-dt * 7);
        for (let i = 0; i < N; i++) emp[i]! += (empT[i]! - emp[i]!) * k;
        if ((step === 1 || step === 2) && !userFocus()) {
          const want = demoFocus();
          if (want !== focus) setFocus(want, t);
        }
        if (barK < 1) {
          barK = Math.min(1, barK + dt * 2.2);
          const e = easeOut(barK);
          for (let d = 0; d < BARS; d++) barShown[d] = barFrom[d]! + (barTo[d]! - barFrom[d]!) * e;
        }
        if (step === 3) analogyK = ((t - t0) % ANALOGY_T) / ANALOGY_T;
      }
      redraw(t);
    },
    pose(s): CameraPose | null {
      if (s === 1) {
        const c = world(idx('貓')).lerp(world(idx('快樂')), 0.5);
        if (portrait) return { position: [c.x + 0.3, c.y + 2.6, c.z + 9.0], target: [c.x, c.y + 1.8, c.z] };
        return { position: [c.x - 1.2, c.y + 1.1, c.z + 9.6], target: [c.x - 2.2, c.y + 0.1, c.z] };
      }
      if (s === 2) {
        const c = ['GPU', 'HBM', '台北', '日本'].reduce((acc, w) => acc.add(world(idx(w), v2)), new Vector3()).multiplyScalar(0.25);
        c.add(v1.set(portrait ? 0.1 : -0.3, portrait ? 0.9 : 0.35, 0)); // lean towards GPU, the first demo word
        return { position: [c.x + 0.5, c.y + 1.3, c.z + 7.9], target: c };
      }
      if (s === 3) {
        const a = world(idx('女王'));
        const b = world(idx('台北'));
        const c = a.lerp(b, 0.5).add(v1.set(portrait ? 0 : 0.2, portrait ? 0.2 : -0.25, 0));
        // Small landscape stages (phones, 4:3) keep the 16:9 horizontal extent: dolly in so the
        // two parallelograms and their equations are not lost in the whole word cloud.
        const k = compact && !portrait ? 0.72 : 1;
        return { position: [c.x - 3.0 * k, c.y + 1.4 * k, c.z + 7.8 * k], target: c };
      }
      return null;
    },
    layout,
    compact(on) {
      compact = on;
      applyTitles();
      panelTexts();
    },
    palette,
    motion(animate) {
      if (!animate) {
        analogyK = 1;
        if (step === 1 || step === 2) setFocus(hover ?? pinned ?? demoFocus(), clock);
        setTargets();
        emp.set(empT);
        barShown.set(barTo);
        barK = 1;
      } else t0 = clock;
      redraw(clock);
    },
    quality() {
      /* fixed counts: 118 points stay cheap on every tier */
    },
  };
}

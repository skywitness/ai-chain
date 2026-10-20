/**
 * Variant `moe`: one Mixture-of-Experts Transformer layer. Tokens first pass a shared attention
 * layer; then each token's router scores all 8 experts, keeps the top 2 and sends the token to
 * them (arcs, width = gate weight). Only those 2 experts run for that token (sparse activation);
 * their outputs are mixed with the gate weights. Bars on the experts show how many tokens of a
 * batch each expert receives (示意): without balancing a few experts are overloaded; the
 * load-balancing loss evens them out.
 *
 * Steps: 0 總覽 (all tokens' routes at once), 7 混合專家 (one token at a time, router scores,
 * load bars going from unbalanced to balanced). Reduced motion: static routes, balanced bars.
 */
import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import type { CameraPose, CardContent, Palette, PickHit, SceneContext, SceneInstance } from '../../core/types';
import { ArcRibbons, type Arc } from '../../kit/ArcRibbons';
import { GlowSprites } from '../../kit/GlowSprites';
import { addFloor, consumePending, lerp, metaCard, registerAway, smooth, tones, type Tones } from './common';
import { EXPERTS, LOAD_BALANCED, LOAD_UNBALANCED, N_TOK, ROUTES, TOKENS, TOP_K, pct } from './data';
import { lbl, type Lbl } from './labels';

const CHIP_H = 0.18;
const ROUTER_Y = 1.14;
const EXPERT_Y = 2.6;
const EXPERT_S = 0.66;
const BAR_MAX = 1.25;
const TOKEN_COLORS = [1, 2, 3, 5, 6, 7]; // --chart-N per token
const PER_TOKEN = 2.6; // seconds per routed token (step 7)
const MOE_PERIOD = PER_TOKEN * N_TOK;
const MAX_LOAD = Math.max(...LOAD_UNBALANCED, ...LOAD_BALANCED);
const AVG_LOAD = LOAD_BALANCED.reduce((a, b) => a + b, 0) / EXPERTS;

export const MOE_POSES: Record<string, CameraPose> = {
  home: { position: [0.5, 5.0, 9.6], target: [0, 1.75, 0.3] },
  route: { position: [1.3, 4.6, 9.3], target: [0.05, 1.8, 0.3] },
};

const m4 = new Matrix4();
const qI = new Quaternion();
const vP = new Vector3();
const vS = new Vector3();
const vA = new Vector3();
const vB = new Vector3();
const tmpC = new Color();

export function buildMoe(ctx: SceneContext, stepTitle: (i: number) => string): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'attention-moe';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const floor = addFloor(ctx, root, 7.5, 0.6, -0.002);

  let portrait = ctx.size.aspect < 0.9;
  // Portrait keeps one row of experts (smaller cubes, tighter spacing) so nothing overlaps.
  const tokX = (i: number) => (i - (N_TOK - 1) / 2) * (portrait ? 0.74 : 1.05);
  const chipSX = () => (portrait ? 0.84 : 1);
  const TZ = () => (portrait ? 1.7 : 1.55);
  const ES = () => (portrait ? 0.72 : 1);
  const halfE = () => (EXPERT_S * ES()) / 2;
  const barBase = () => EXPERT_Y + halfE() + 0.06;
  const expPos = (e: number, out: Vector3) => out.set((e - (EXPERTS - 1) / 2) * (portrait ? 0.56 : 0.9), EXPERT_Y, -0.55);

  /* ───────── state ───────── */
  let step7 = false;
  let focus = 5;
  let loopT = 0; // step 7 clock
  let cycleT = 0;
  let holdUntil = 0;
  let clock = 0;
  let balance = 1; // 0 = unbalanced bars, 1 = balanced
  let grow = 1; // arc draw-on for the focused token

  /* ───────── meshes ───────── */
  const chipGeo = ctx.track(new RoundedBoxGeometry(0.82, CHIP_H, 0.56, 3, 0.07));
  const chipMat = ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.06 }));
  const chips = new InstancedMesh(chipGeo, chipMat, N_TOK);
  chips.setColorAt(0, new Color());
  chips.frustumCulled = false;
  const routerGeo = ctx.track(new OctahedronGeometry(0.14, 0));
  const routerMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.2, flatShading: true }));
  const routers = new InstancedMesh(routerGeo, routerMat, N_TOK);
  routers.setColorAt(0, new Color());
  routers.frustumCulled = false;
  const expGeo = ctx.track(new RoundedBoxGeometry(EXPERT_S, EXPERT_S, EXPERT_S, 3, 0.09));
  const expMat = ctx.track(new MeshStandardMaterial({ roughness: 0.36, metalness: 0.1 }));
  const experts = new InstancedMesh(expGeo, expMat, EXPERTS);
  experts.setColorAt(0, new Color());
  experts.frustumCulled = false;
  const barGeo = ctx.track(new RoundedBoxGeometry(0.22, 1, 0.22, 2, 0.035));
  barGeo.translate(0, 0.5, 0);
  const barMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }));
  const bars = new InstancedMesh(barGeo, barMat, EXPERTS);
  bars.setColorAt(0, new Color());
  bars.frustumCulled = false;
  const scoreGeo = ctx.track(new BoxGeometry(0.052, 1, 0.052));
  scoreGeo.translate(0, 0.5, 0);
  const scoreMat = ctx.track(new MeshStandardMaterial({ roughness: 0.5 }));
  const scores = new InstancedMesh(scoreGeo, scoreMat, EXPERTS);
  scores.setColorAt(0, new Color());
  scores.frustumCulled = false;
  root.add(chips, routers, experts, bars, scores);
  for (const m of [chips, routers, experts, bars, scores]) ctx.track({ dispose: () => m.dispose() });

  const attGeo = ctx.track(new RoundedBoxGeometry(1, 0.16, 0.7, 2, 0.06));
  const attMat = materials.glass('optic', 0.22);
  const attSlab = new Mesh(attGeo, attMat);
  root.add(attSlab);
  const avgGeo = ctx.track(new BoxGeometry(1, 0.014, 0.014));
  const avgMat = materials.basic('highlight', { transparent: true, opacity: 0.9 });
  const avgLine = new Mesh(avgGeo, avgMat);
  root.add(avgLine);

  const arcs = ctx.track(new ArcRibbons({ count: N_TOK * TOP_K, segments: 40, flow: 0.4, theme: ctx.theme }));
  arcs.object.material.side = DoubleSide; // see proposals/scene-attention.yaml
  arcs.object.material.forceSinglePass = true;
  root.add(arcs.object);
  const arcSpec: Arc = { start: vA, end: vB, height: 0.4, width: 0.05, color: new Color(), alpha: 1, progress: 1 };
  const glows = ctx.track(new GlowSprites({ count: EXPERTS + 1, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── anchors & labels ───────── */
  const tokA = Array.from({ length: N_TOK }, () => new Object3D());
  const expA = Array.from({ length: EXPERTS }, () => new Object3D());
  const focusA = new Object3D();
  const leftA = new Object3D();
  const barsA = new Object3D();
  const avgA = new Object3D();
  root.add(...tokA, ...expA, focusA, leftA, barsA, avgA);

  const tokL: Lbl[] = TOKENS.map((t, i) => lbl(labels, { text: t, object: tokA[i]!, position: [0, CHIP_H + 0.02, 0.1], kind: 'strong', priority: 40, hotspot: 'tokens' }));
  const expL: Lbl[] = Array.from({ length: EXPERTS }, (_, e) =>
    lbl(labels, { text: `專家 ${e + 1}`, object: expA[e]!, position: [0, 0, EXPERT_S / 2 + 0.02], kind: 'default', priority: 26, hotspot: 'experts' }),
  );
  const attL = lbl(labels, { text: '注意力層（所有 Token 共用）', object: leftA, position: [0, 0.58, 0], align: 'left', kind: 'default', priority: 30 });
  const routerL = lbl(labels, { text: '路由器：為每位專家打分數，取前 2 名', object: leftA, position: [0, ROUTER_Y, 0], align: 'left', kind: 'default', priority: 31, hotspot: 'router' });
  const expTitleL = lbl(labels, { text: '專家（各是一個前饋網路）', object: barsA, position: [0, 0, 0], align: 'left', kind: 'strong', priority: 34, hotspot: 'experts' });
  const loadL = lbl(labels, { text: '', object: barsA, position: [0, 0.75, 0], align: 'left', kind: 'muted', priority: 28, hotspot: 'load-balance' });
  lbl(labels, { text: '平均', object: avgA, align: 'right', kind: 'tag', priority: 20, hotspot: 'load-balance' });
  const mixL = lbl(labels, { text: '', object: focusA, align: 'above', offset: [0, -4], kind: 'default', priority: 35, visible: false, hotspot: 'router' });
  const noteL = lbl(labels, { text: '路由與負載皆為示意', object: avgA, position: [0, -BAR_MAX - 0.1, 0], align: 'right', kind: 'tag', priority: 3 });

  /** Landscape: titles to the left of each row. Portrait: centred on / between the rows. */
  const layoutLabels = () => {
    expL.forEach((l, e) => {
      l.text(portrait ? `${e + 1}` : `專家 ${e + 1}`);
      l.h.set({ position: [0, 0, halfE() + 0.02] });
    });
    if (portrait) {
      attL.h.set({ position: [0, 0.58, 0] });
      attL.align('center', [0, 0]);
      routerL.text('路由器：每個 Token 只送往前 2 名專家');
      routerL.h.set({ position: [0, ROUTER_Y + 0.16, 0] });
      routerL.align('above', [0, -4]);
      expTitleL.h.set({ position: [0, BAR_MAX + 0.12, 0] });
      expTitleL.align('above', [0, 0]);
      loadL.h.set({ position: [0, BAR_MAX + 0.12, 0] });
      loadL.align('above', [0, -42]);
      noteL.vis(false);
    } else {
      attL.h.set({ position: [0, 0.58, 0] });
      attL.align('left', [0, 0]);
      routerL.text('路由器：為每位專家打分數，取前 2 名');
      routerL.h.set({ position: [0, ROUTER_Y, 0] });
      routerL.align('left', [0, 0]);
      expTitleL.h.set({ position: [0, 0, 0] });
      expTitleL.align('left', [0, 0]);
      loadL.h.set({ position: [0, 0.75, 0] });
      loadL.align('left', [0, 0]);
      noteL.vis(true);
    }
  };

  /* ───────── palette ───────── */
  let T: Tones = tones(ctx.palette);
  const tokHue = TOKEN_COLORS.map(() => new Color());
  const cHi = new Color();
  const cExp = new Color();
  const cIdle = new Color();
  const cBar = new Color();
  const applyPalette = (p: Palette) => {
    T = tones(p);
    lights.apply(p);
    floor.apply(p);
    TOKEN_COLORS.forEach((c, i) => tokHue[i]!.copy(p.chart[c - 1] ?? p.fg));
    cHi.copy(p.highlight);
    cExp.copy(p.flow).lerp(T.chip, T.dark ? 0.2 : 0.12);
    cIdle.copy(T.cube).lerp(p.bg, T.dark ? 0.25 : 0.1);
    cBar.copy(p.flow).lerp(T.chip, T.dark ? 0.55 : 0.5);
    routerMat.emissive.copy(p.highlight).multiplyScalar(T.dark ? 0.35 : 0.05);
    arcs.setTheme(p.theme);
    glows.setTheme(p.theme);
    attMat.opacity = T.dark ? 0.2 : 0.13;
    tokL.forEach((l, i) => l.swatch(p.css[`chart-${TOKEN_COLORS[i]}`] ?? ''));
    expTitleL.swatch(p.css['scene-flow'] ?? '');
    routerL.swatch(p.css['scene-highlight'] ?? '');
    attL.swatch(p.css['scene-optic'] ?? '');
  };

  /* ───────── draw ───────── */
  const routedTo = (e: number) => ROUTES.reduce((s, r) => s + (r.top.includes(e) ? 1 : 0), 0);
  const draw = () => {
    const dark = T.dark;
    const tz = TZ();
    const focusMode = step7;
    // chips + routers
    for (let i = 0; i < N_TOK; i++) {
      const x = tokX(i);
      tokA[i]!.position.set(x, 0, tz);
      chips.setMatrixAt(i, m4.compose(vP.set(x, CHIP_H / 2, tz), qI, vS.set(chipSX(), 1, 1)));
      tmpC.copy(T.chip);
      if (i === focus && (focusMode || ctx.animate)) tmpC.lerp(cHi, dark ? 0.3 : 0.2);
      chips.setColorAt(i, tmpC);
      routers.setMatrixAt(i, m4.compose(vP.set(x, ROUTER_Y, tz), qI, vS.setScalar(i === focus && focusMode ? 1.25 : 1)));
      routers.setColorAt(i, tmpC.copy(cHi).lerp(T.chip, focusMode && i !== focus ? 0.55 : 0));
    }
    // experts
    const r = ROUTES[focus]!;
    let tallest = 0;
    for (let e = 0; e < EXPERTS; e++) {
      expPos(e, vP);
      expA[e]!.position.copy(vP);
      experts.setMatrixAt(e, m4.compose(vP, qI, vS.setScalar(ES())));
      const k = r.top.indexOf(e);
      let active = 0;
      if (focusMode) {
        // chosen experts light up in the token's colour; the other six stay idle (sparse activation)
        active = k >= 0 ? grow : 0;
        tmpC.copy(cIdle);
        if (k >= 0) tmpC.lerp(tokHue[focus]!, 0.85 * grow);
      } else {
        active = routedTo(e) > 0 ? 0.55 : 0;
        tmpC.copy(cExp);
      }
      experts.setColorAt(e, tmpC);
      const hue = focusMode ? tokHue[focus]! : cExp;
      glows.set(e, vP, 1.25 * ES(), hue, (dark ? 0.55 : 0.28) * active);
      // step 7: the two chosen experts get the strongest label, the idle six fade back
      expL[e]!.kind(focusMode ? (k >= 0 ? 'strong' : 'muted') : 'default');
      // load bars
      const load = lerp(LOAD_UNBALANCED[e]!, LOAD_BALANCED[e]!, balance);
      const h = Math.max(0.03, (load / MAX_LOAD) * BAR_MAX);
      tallest = Math.max(tallest, h);
      bars.setMatrixAt(e, m4.compose(vS.set(vP.x, barBase(), vP.z), qI, vA.set(ES(), h, ES())));
      const over = load > AVG_LOAD * 1.5 ? smooth(1.5, 2.2, load / AVG_LOAD) : 0;
      bars.setColorAt(e, tmpC.copy(cBar).lerp(ctx.palette.heat, over));
      // router score mini bars for the focused token
      const sx = tokX(focus) + (e - (EXPERTS - 1) / 2) * 0.085;
      const sh = (r.probs[e] ?? 0) * 1.25 * grow;
      scores.setMatrixAt(e, m4.compose(vS.set(sx, ROUTER_Y + 0.2, tz), qI, vA.set(1, Math.max(0.01, sh), 1)));
      scores.setColorAt(e, k >= 0 ? cHi : tmpC.copy(T.cube).lerp(ctx.palette.fg, 0.2));
    }
    scores.visible = focusMode;
    for (const m of [chips, routers, experts, bars, scores]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.boundingSphere = null;
    }
    // arcs
    let n = 0;
    for (let i = 0; i < N_TOK; i++) {
      const ri = ROUTES[i]!;
      const isF = i === focus;
      if (focusMode && !isF) continue;
      for (let k = 0; k < TOP_K; k++) {
        const e = ri.top[k]!;
        vA.set(tokX(i), ROUTER_Y + 0.12, tz);
        expPos(e, vB);
        vB.y -= halfE();
        vB.z += halfE() - 0.05;
        arcSpec.height = 0.32;
        arcSpec.width = 0.03 + 0.09 * ri.gate[k]!;
        arcSpec.color = tokHue[i]!;
        // overview while cycling: the focused token's routes stand out, the rest stay readable
        const dimOthers = !focusMode && ctx.animate ? (isF ? 1 : dark ? 0.42 : 0.55) : 1;
        arcSpec.alpha = (0.45 + 0.55 * ri.gate[k]!) * dimOthers;
        arcSpec.progress = isF ? grow : 1;
        arcs.setArc(n++, arcSpec);
      }
    }
    arcs.object.geometry.instanceCount = n;
    // slab, average line, anchors
    const x0 = tokX(0);
    const xN = tokX(N_TOK - 1);
    attSlab.position.set(0, 0.58, tz);
    attSlab.scale.set(xN - x0 + 1.0, 1, 1);
    leftA.position.set(portrait ? 0 : x0 - 0.55, 0, tz);
    expPos(0, vP);
    const avgH = barBase() + (AVG_LOAD / MAX_LOAD) * BAR_MAX;
    const ex0 = vP.x - halfE() - 0.02;
    expPos(EXPERTS - 1, vB);
    const ex1 = vB.x + halfE() + 0.02;
    avgLine.position.set((ex0 + ex1) / 2, avgH, vP.z);
    avgLine.scale.set(ex1 - ex0, 1, 1);
    avgA.position.set(ex1 + 0.03, avgH, vP.z);
    // portrait: the titles ride just above the tallest bar (not the tallest possible bar)
    if (portrait) barsA.position.set(0, barBase() + tallest - BAR_MAX, vP.z);
    else barsA.position.set(ex0 - 0.1, EXPERT_Y, vP.z + 0.1);
    focusA.position.set(tokX(focus), ROUTER_Y + 0.2 + 1.25 * Math.max(...r.probs) + 0.05, tz);
    glows.set(EXPERTS, vP.set(tokX(focus), ROUTER_Y, tz), 0.8, cHi, (dark ? 0.6 : 0.3) * (focusMode ? 1 : 0));
    // text
    mixL.vis(focusMode && grow > 0.6);
    if (focusMode) mixL.text(`${pct(r.gate[0])} × 專家 ${r.top[0] + 1} ＋ ${pct(r.gate[1])} × 專家 ${r.top[1] + 1}`);
    loadL.text(balance > 0.5 ? '負載（示意）：加入平衡損失後較平均' : '負載（示意）：未平衡，少數專家過載');
  };

  /* ───────── focus / steps ───────── */
  const setFocus = (i: number, anim = true) => {
    if (i === focus) return;
    focus = i;
    if (anim) {
      grow = 0;
      ctx.tween.run((k) => (grow = k), { duration: 700, ease: 'cubicOut' });
    } else grow = 1;
    ctx.invalidate();
  };
  const tokenOf = (hit: PickHit | null) => (hit && hit.instanceId !== undefined && (hit.object === chips || hit.object === routers) ? hit.instanceId : -1);
  const userFocus = (i: number) => {
    if (i < 0) return;
    holdUntil = clock + 8;
    setFocus(i);
  };
  ctx.picker.add(routers, { id: 'router' });
  ctx.picker.onHover((hit) => userFocus(tokenOf(hit)));
  ctx.picker.onClick((hit) => userFocus(tokenOf(hit)));

  const routeText = (i: number) => {
    const r = ROUTES[i]!;
    return `專家 ${r.top[0] + 1}（${pct(r.gate[0])}）＋ 專家 ${r.top[1] + 1}（${pct(r.gate[1])}）`;
  };
  hotspots.register('tokens', {
    object: chips,
    anchor: focusA,
    pose: MOE_POSES['route']!,
    onHighlight: () => {},
    card: (hit): CardContent => {
      const i = tokenOf(hit) >= 0 ? tokenOf(hit) : focus;
      return {
        title: `「${TOKENS[i]}」的路由`,
        swatch: ctx.palette.css[`chart-${TOKEN_COLORS[i]}`] ?? '',
        body: `路由器選出 ${routeText(i)}，只有這 2 位專家為它運算，其餘 ${EXPERTS - TOP_K} 位閒置（示意）。`,
      };
    },
    onSelect: (source) => {
      if (source === 'list' || source === 'keyboard' || source === 'command') userFocus((focus + 1) % N_TOK);
    },
  });
  hotspots.register('router', {
    anchor: focusA,
    pose: MOE_POSES['route']!,
    onHighlight: () => {},
    card: () => metaCard(ctx, 'router', { subtitle: `「${TOKENS[focus]}」→ ${routeText(focus)}` }),
  });
  hotspots.register('experts', {
    object: experts,
    anchor: barsA,
    pose: MOE_POSES['home']!,
    onHighlight: () => {},
    card: (hit) => {
      if (hit?.object === experts && hit.instanceId !== undefined) {
        const e = hit.instanceId;
        const who = ROUTES.map((r, i) => (r.top.includes(e) ? `「${TOKENS[i]}」` : '')).filter(Boolean);
        return {
          title: `專家 ${e + 1}`,
          body: `一個獨立的前饋網路（FFN）。這句話中${who.length ? `由 ${who.join('、')} 使用` : '沒有 Token 選到它，這一步閒置'}（示意）。`,
          ...(metaCard(ctx, 'experts').href ? { href: metaCard(ctx, 'experts').href! } : {}),
        };
      }
      return metaCard(ctx, 'experts');
    },
  });
  hotspots.register('load-balance', {
    object: bars,
    anchor: avgA,
    pose: MOE_POSES['home']!,
    onHighlight: () => {},
    card: () => metaCard(ctx, 'load-balance'),
  });
  registerAway(ctx, new Set(['tokens', 'router', 'experts', 'load-balance']), [0, ROUTER_Y + 0.6, 0.5], stepTitle);

  const applyStep = (i: number) => {
    step7 = i === 7;
    loopT = 0;
    cycleT = 0;
    balance = step7 && ctx.animate ? 0 : 1;
    focus = -1;
    setFocus(5, false);
    attL.vis(true);
    routerL.vis(true);
    ctx.setPose(step7 ? MOE_POSES['route']! : ctx.homePose);
  };

  applyPalette(ctx.palette);
  layoutLabels();

  return {
    update(dt) {
      clock += dt;
      if (ctx.animate) {
        if (step7) {
          loopT = (loopT + dt) % (MOE_PERIOD * 2);
          const tok = Math.floor((loopT % MOE_PERIOD) / PER_TOKEN);
          if (clock > holdUntil && tok !== focus) setFocus(tok);
          // first pass unbalanced, second pass balanced
          balance = smooth(MOE_PERIOD - 1.5, MOE_PERIOD + 0.5, loopT) * (1 - smooth(MOE_PERIOD * 2 - 1, MOE_PERIOD * 2, loopT));
        } else if (clock > holdUntil) {
          cycleT += dt;
          if (cycleT > 2.8) {
            cycleT = 0;
            setFocus((focus + 1) % N_TOK);
          }
        }
      }
      arcs.update(clock);
      draw();
    },
    setStep(i) {
      applyStep(i);
      draw();
      consumePending(ctx);
    },
    onPalette(p) {
      applyPalette(p);
      draw();
    },
    onMotion(animate) {
      if (!animate) {
        balance = 1;
        grow = 1;
      }
      draw();
    },
    onResize(size) {
      const next = size.aspect < 0.9;
      if (next !== portrait) {
        portrait = next;
        layoutLabels();
        draw();
      }
    },
    dispose() {
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

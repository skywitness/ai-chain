/**
 * cowos — variant `soic`: micro-bump joint vs SoIC hybrid bonding, side by side.
 *
 * Left: a bottom die (face up) with copper pads, a top die (face down) carrying copper pillars with
 * solder caps; bonded, a gap remains and is filled with underfill. Right: both dies carry a thin
 * dielectric bonding layer with flush copper pads at a quarter of the pitch (16× the pads in the
 * same area, 示意); bonded, the faces touch — no bumps, no gap. The slider separates the top dies
 * (拆解 0 = bonded). Top dies are drawn as translucent silicon so their pad faces stay visible.
 * Portrait stages place the two demonstrators front/back instead of left/right.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type MeshStandardMaterial,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import type { CameraPose, CardContent, LabelHandle, Palette, SceneContext, SceneInstance, Vec3Like } from '../../core/types';
import { PathFlow } from '../../kit/PathFlow';
import { Heat, buildFloor, dampRim, partColors, pickProxy, setMatrix, smooth } from './common';
import { CARDS, switchVariant, takePending } from './content';
import { createPanel } from './ui';

const BOT = { w: 3.7, h: 0.34, d: 3.0 };
const TOP = { w: 2.9, h: 0.3, d: 2.3 };
const P = 0.34; // micro-bump pitch (示意)
const NX = 8;
const NZ = 6;
const SUB = 4; // hybrid-bond pitch = P / SUB
const PILLAR = { r: 0.075, h: 0.1 };
const CAP = { r: 0.082, h: 0.072 };
const PAD = { r: 0.088, h: 0.016 };
const DIEL = 0.03;
const LIFT = 1.55;
const DEFAULT_E = 0.45;
/** Step 接合之後: bonded, seen low from the front so the stand-off gap (or its absence) reads. */
const POSE_BONDED: CameraPose = { position: [0, 2.7, 9.8], target: [0, 0.55, 0.2] };
/** The same step on portrait stages, as it should end up (see `unfit`). */
const POSE_BONDED_PORTRAIT: CameraPose = { position: [0, 4.3, 10.8], target: [0, 0.5, 0.5] };
const SEP = 2.2; // demonstrator offset from the centre (x in landscape, z in portrait)

const GAP_A = PAD.h + PILLAR.h + CAP.h; // bonded micro-bump stand-off
const GAP_B = DIEL; // bottom bonding layer only (the top die's layer sits on it)

export function buildSoic(ctx: SceneContext): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'cowos-soic';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const heat = new Heat(ctx);
  const C = (k: keyof ReturnType<typeof partColors>) => (p: Palette) => partColors(p)[k];
  const track = <T extends { dispose(): void }>(m: T) => ctx.track(m);
  const inst = (geo: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, n: number) => {
    const m = new InstancedMesh(geo, mat, n);
    track({ dispose: () => m.dispose() });
    return m;
  };

  const floor = buildFloor(ctx, 8, 0.5, 12, 7);
  root.add(floor.group);

  const unitBox = track(new BoxGeometry(1, 1, 1));
  const botGeo = track(new RoundedBoxGeometry(BOT.w, BOT.h, BOT.d, 2, 0.04));
  const topGeo = track(new RoundedBoxGeometry(TOP.w, TOP.h, TOP.d, 2, 0.035));
  const botMat = materials.standard(C('silicon'), { roughness: 0.36, metalness: 0.3 });
  const topMatA = materials.standard(C('logic'), { roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.5, depthWrite: false });
  const topMatB = materials.standard(C('logic'), { roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.5, depthWrite: false });
  const copperMat = materials.standard(C('copper'), { roughness: 0.28, metalness: 0.62 });
  const copperMatB = materials.standard(C('copper'), { roughness: 0.28, metalness: 0.62 });
  const solderMat = materials.standard(C('solder'), { roughness: 0.34, metalness: 0.3 });
  const dielMat = materials.standard(C('dielectric'), { roughness: 0.2, metalness: 0.05, transparent: true, opacity: 0.45, depthWrite: false });
  const fillMat = materials.glass('muted', 0, { roughness: 0.5 });

  // Joint grid (cell centres, shared by both sides).
  const cells: [number, number][] = [];
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) cells.push([(i - (NX - 1) / 2) * P, (j - (NZ - 1) / 2) * P]);
  const fine: [number, number][] = [];
  for (const [cx, cz] of cells)
    for (let k = 0; k < SUB; k++) for (let l = 0; l < SUB; l++) fine.push([cx + (k - (SUB - 1) / 2) * (P / SUB), cz + (l - (SUB - 1) / 2) * (P / SUB)]);

  /* ───── demonstrator A: micro-bumps ───── */
  const A = new Group();
  A.name = 'micro-bump-joint';
  const botA = new Mesh(botGeo, botMat);
  botA.position.y = BOT.h / 2;
  const padsA = inst(track(new CylinderGeometry(PAD.r, PAD.r, PAD.h, 12)), copperMat, cells.length);
  cells.forEach(([x, z], i) => setMatrix(padsA, i, x, BOT.h + PAD.h / 2, z, 1, 1, 1));
  const topA = new Group();
  const topAMesh = new Mesh(topGeo, topMatA);
  topAMesh.position.y = TOP.h / 2;
  topAMesh.renderOrder = 4;
  const pillars = inst(track(new CylinderGeometry(PILLAR.r, PILLAR.r, PILLAR.h, 12)), copperMat, cells.length);
  const caps = inst(track(new SphereGeometry(CAP.r, 12, 8)), solderMat, cells.length);
  cells.forEach(([x, z], i) => {
    setMatrix(pillars, i, x, -PILLAR.h / 2, z, 1, 1, 1);
    setMatrix(caps, i, x, -PILLAR.h - CAP.h / 2 + 0.004, z, 1, CAP.h / (2 * CAP.r), 1);
  });
  topA.add(topAMesh, pillars, caps);
  const fill = new Mesh(unitBox, fillMat);
  fill.scale.set(TOP.w - 0.02, GAP_A - 0.004, TOP.d - 0.02);
  fill.position.y = BOT.h + GAP_A / 2;
  fill.renderOrder = 3;
  A.add(botA, padsA, topA, fill);

  /* ───── demonstrator B: hybrid bonding ───── */
  const B = new Group();
  B.name = 'hybrid-bond';
  const botB = new Mesh(botGeo, botMat);
  botB.position.y = BOT.h / 2;
  const dielBot = new Mesh(unitBox, dielMat);
  dielBot.scale.set(TOP.w, DIEL, TOP.d);
  dielBot.position.y = BOT.h + DIEL / 2;
  dielBot.renderOrder = 3;
  const padW = (P / SUB) * 0.56;
  const padsB = inst(unitBox, copperMatB, fine.length * 2);
  fine.forEach(([x, z], i) => setMatrix(padsB, i, x, BOT.h + DIEL / 2 + 0.001, z, padW, DIEL + 0.004, padW));
  const topB = new Group();
  const topBMesh = new Mesh(topGeo, topMatB);
  topBMesh.position.y = TOP.h / 2;
  topBMesh.renderOrder = 4;
  const dielTop = new Mesh(unitBox, dielMat);
  dielTop.scale.set(TOP.w, DIEL, TOP.d);
  dielTop.position.y = -DIEL / 2;
  dielTop.renderOrder = 3;
  topB.add(topBMesh, dielTop);
  B.add(botB, dielBot, padsB, topB);
  // Top-face pads live in B's space (instances fine.length..), re-placed with the lift.

  // Bonded seam for B: a thin frame around the interface (a filled plate would hide the Cu pads).
  const seamMat = materials.basic('highlight', { transparent: true, opacity: 0, depthWrite: false });
  const seam = inst(unitBox, seamMat, 4);
  {
    const t = 0.035;
    const w = TOP.w + 0.03;
    const d = TOP.d + 0.03;
    setMatrix(seam, 0, 0, 0, -d / 2, w, 0.008, t);
    setMatrix(seam, 1, 0, 0, d / 2, w, 0.008, t);
    setMatrix(seam, 2, -w / 2, 0, 0, t, 0.008, d - t);
    setMatrix(seam, 3, w / 2, 0, 0, t, 0.008, d - t);
    seam.computeBoundingSphere();
  }
  seam.renderOrder = 6;
  B.add(seam);

  root.add(A, B);

  /* ───── dimension marks (pitch): a bar with end ticks per side, thin boxes so they read at 1× DPR ───── */
  const dimMat = materials.basic('highlight', { depthTest: false, transparent: true });
  const dims = inst(unitBox, dimMat, 6);
  dims.renderOrder = 8;
  dims.frustumCulled = false;
  root.add(dims);
  const zFront = cells[NZ - 1]![1];
  const writeDim = (slot: number, g: Group, x0: number, x1: number, z: number, y: number) => {
    const gx = g.position.x;
    const gz = g.position.z;
    const t = 0.018;
    setMatrix(dims, slot * 3, gx + (x0 + x1) / 2, y, gz + z, x1 - x0, t, t);
    setMatrix(dims, slot * 3 + 1, gx + x0, y, gz + z, t, 0.16, t);
    setMatrix(dims, slot * 3 + 2, gx + x1, y, gz + z, t, 0.16, t);
  };

  /* ───── flows: signals crossing the joint ───── */
  const flowXZ = cells.filter(([, z]) => Math.abs(z - cells[2]![1]) < 1e-6 || Math.abs(z - cells[3]![1]) < 1e-6).filter((_, i) => i % 2 === 0);
  const mkFlow = (seed: number) =>
    track(
      new PathFlow({
        paths: flowXZ.map(([x, z]) => ({ points: [[x, 0, z], [x, 1, z]] })),
        count: flowXZ.length * 4,
        size: 0.07,
        sizeVariance: 0.2,
        speed: 0.42,
        speedVariance: 0.12,
        smooth: false,
        fadeEnds: 0.18,
        theme: ctx.theme,
        seed,
      }),
    );
  const flowA = mkFlow(21);
  const flowB = mkFlow(22);
  const flowAG = new Group();
  const flowBG = new Group();
  flowAG.add(flowA.object);
  flowBG.add(flowB.object);
  A.add(flowAG);
  B.add(flowBG);

  /* ───── pick proxies ───── */
  const proxyMat = track(new MeshBasicMaterial());
  const mkProxy = (g: Group) => {
    const m = pickProxy(new Mesh(unitBox, proxyMat));
    m.scale.set(BOT.w, 1, BOT.d);
    m.position.y = 0.5;
    g.add(m);
    return m;
  };
  const proxyA = mkProxy(A);
  const proxyB = mkProxy(B);

  /* ───── labels ───── */
  const L: Record<string, LabelHandle> = {
    titleA: labels.add({ text: '微凸塊接合', object: topA, position: [0, TOP.h, -TOP.d / 2], align: 'above', offset: [0, -6], priority: 30, kind: 'strong', hotspot: 'micro-bumps' }),
    titleB: labels.add({ text: 'SoIC 混合鍵合', object: topB, position: [0, TOP.h, -TOP.d / 2], align: 'above', offset: [0, -6], priority: 30, kind: 'strong', hotspot: 'hybrid-bonding' }),
    bump: labels.add({ text: '銅柱＋焊錫凸塊', object: A, position: [-TOP.w / 2, BOT.h + GAP_A, 0], align: 'left', offset: [-6, 0], priority: 22, hotspot: 'micro-bumps' }),
    fill: labels.add({ text: '底部填充膠', object: A, position: [-TOP.w / 2, BOT.h + GAP_A, 0], align: 'left', offset: [-6, 36], priority: 21, hotspot: 'micro-bumps', visible: false }),
    pads: labels.add({ text: '銅墊＋介電層，直接鍵合', object: B, position: [TOP.w / 2, BOT.h + DIEL, 0], align: 'right', offset: [6, 0], priority: 22, hotspot: 'hybrid-bonding' }),
    pitchA: labels.add({ text: '間距 P（數十 µm）', object: A, position: [0, BOT.h, BOT.d / 2], align: 'below', offset: [0, 8], priority: 26, hotspot: 'micro-bumps' }),
    pitchB: labels.add({ text: '間距 P/4 → 同面積接點 ×16（示意）', object: B, position: [0, BOT.h, BOT.d / 2], align: 'below', offset: [0, 8], priority: 26, hotspot: 'hybrid-bonding' }),
    // Each demonstrator's labels sit on its outer side (A left, B right), so none reads as the other's.
    gapB: labels.add({ text: '無凸塊、無間隙', object: B, position: [TOP.w / 2, BOT.h + DIEL, 0], align: 'right', offset: [6, 36], priority: 20, hotspot: 'hybrid-bonding', visible: false }),
  };
  labels.setMax(14);

  /**
   * ctx.setPose scales a pose's distance by |portrait home| / |home| on portrait stages; undo that so
   * an explicit portrait pose ends up exactly where it is written.
   */
  const unfit = (p: CameraPose): CameraPose => {
    const cam = ctx.meta.camera;
    if (!cam.portrait?.position) return p;
    const v = (a: Vec3Like) => (a instanceof Vector3 ? a.clone() : new Vector3(a[0], a[1], a[2]));
    const k = v(cam.position).distanceTo(v(cam.target)) / v(cam.portrait.position).distanceTo(v(cam.portrait.target ?? cam.target));
    const t = v(p.target);
    return { ...p, position: v(p.position).sub(t).multiplyScalar(k).add(t) };
  };
  const bondedPose = () => (portrait ? unfit(POSE_BONDED_PORTRAIT) : POSE_BONDED);

  /* ───── state / layout ───── */
  let explode = DEFAULT_E;
  let portrait = ctx.size.portrait;
  let bondedStep = false;
  let padsShown = '銅墊＋介電層，直接鍵合';

  const layout = () => {
    if (portrait) {
      A.position.set(0, 0, -SEP - 0.05);
      B.position.set(0, 0, SEP + 0.05);
    } else {
      A.position.set(-SEP, 0, 0);
      B.position.set(SEP, 0, 0);
    }
    // Portrait: the pitch labels would fall between the two demonstrators, so the titles carry them.
    L.titleA!.set({ text: portrait ? '微凸塊接合・間距 P' : '微凸塊接合' });
    // Portrait: B is the front demonstrator, so its title goes under its front edge (unambiguous).
    L.titleB!.set(
      portrait
        ? { text: 'SoIC 混合鍵合・間距 P/4', object: B, position: [0, 0, BOT.d / 2], align: 'below', offset: [0, 6] }
        : { text: 'SoIC 混合鍵合', object: topB, position: [0, TOP.h, -TOP.d / 2], align: 'above', offset: [0, -6] },
    );
    // Portrait: B is large in the front, so a label beside its right edge would leave the stage.
    // The pads label moves under the bonded seam's front edge; 無凸塊、無間隙 takes the side slot.
    L.pads!.set(
      portrait
        ? { position: [0, BOT.h + DIEL, TOP.d / 2], align: 'below', offset: [0, 2] }
        : { position: [TOP.w / 2, BOT.h + DIEL, 0], align: 'right', offset: [6, 0] },
    );
    L.gapB!.set({ offset: portrait ? [6, 0] : [6, 36] });
    L.pitchA!.set({ visible: !portrait });
    L.pitchB!.set({ visible: !portrait });
    A.updateMatrixWorld(true);
    B.updateMatrixWorld(true);
  };

  const apply = () => {
    const lift = explode * LIFT;
    const yA = BOT.h + GAP_A + lift;
    const yB = BOT.h + GAP_B + DIEL + lift;
    topA.position.y = yA;
    topB.position.y = yB;
    // Top-face pads of B follow the lifted top die.
    fine.forEach(([x, z], i) => setMatrix(padsB, fine.length + i, x, yB - DIEL / 2 - 0.001, z, padW, DIEL + 0.004, padW));
    padsB.instanceMatrix.needsUpdate = true;
    padsB.computeBoundingSphere();
    const bonded = 1 - smooth(0.02, 0.14, explode);
    fillMat.opacity = bonded * (ctx.theme === 'dark' ? 0.32 : 0.4);
    fill.visible = bonded > 0.01;
    seamMat.opacity = bonded * 0.9;
    seam.position.y = BOT.h + DIEL;
    seam.visible = bonded > 0.01;
    L.fill!.set({ visible: bonded > 0.5 });
    // Portrait: no free slot beside the front demonstrator, so the pads label carries 無間隙 itself.
    L.gapB!.set({ visible: bonded > 0.5 && !portrait });
    const padsText = portrait && bonded > 0.5 ? '銅墊直接鍵合：無凸塊、無間隙' : '銅墊＋介電層，直接鍵合';
    if (padsText !== padsShown) {
      padsShown = padsText;
      L.pads!.set({ text: padsText });
    }
    // Signal paths span from inside the bottom die to inside the top die.
    flowAG.position.y = BOT.h - 0.14;
    flowAG.scale.y = yA - BOT.h + 0.28;
    flowBG.position.y = BOT.h - 0.14;
    flowBG.scale.y = yB - DIEL - BOT.h + 0.28;
    flowAG.updateMatrixWorld(true);
    flowBG.updateMatrixWorld(true);
    // Pitch dimension marks on the bottom faces (front row).
    const x0 = cells[0]![0];
    writeDim(0, A, x0, x0 + P, zFront + P * 0.62, BOT.h + 0.08);
    const fx = fine[0]![0];
    writeDim(1, B, fx, fx + P / SUB, zFront + P * 0.62, BOT.h + DIEL + 0.08);
    dims.instanceMatrix.needsUpdate = true;
    panel.setValue(explode);
    ctx.invalidate();
  };

  // Camera tweens do not cancel each other: keep ours so a newer move (or a resize) replaces it.
  let camTween: { cancel(): void } | null = null;
  const moveCamera = (pose: CameraPose, opts?: { duration: number }) => {
    camTween?.cancel();
    camTween = ctx.setPose(pose, opts);
  };
  let tw: { cancel(): void } | null = null;
  const animateTo = (to: number) => {
    tw?.cancel();
    const from = explode;
    tw = ctx.tween.run(
      (k) => {
        explode = from + (to - from) * k;
        apply();
      },
      { duration: 900, ease: 'cubicInOut' },
    );
  };

  const panel = createPanel({
    stage: ctx.stage,
    signal: ctx.signal,
    label: '分開',
    aria: '上層晶粒分開程度（0 為完成接合）',
    groupLabel: '晶粒接合控制',
    valueText: (x) => (x < 0.03 ? '已接合' : `分開 ${Math.round(x * 100)}%`),
    value: explode,
    onInput: (x) => {
      tw?.cancel();
      explode = x;
      apply();
    },
  });

  /* ───── palette ───── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    dampRim(lights);
    floor.apply(p);
    for (const f of [flowA, flowB]) {
      f.recolor(() => p.flow);
      f.setTheme(p.theme);
      f.setSize(dark ? 0.08 : 0.075);
    }
    topMatA.opacity = topMatB.opacity = dark ? 0.46 : 0.52;
    dielMat.opacity = dark ? 0.4 : 0.5;
    heat.apply();
    apply();
  };

  /* ───── hotspots ───── */
  const cardFor = (id: string): CardContent | null => {
    const c = CARDS[id];
    if (!c) return null;
    const out: CardContent = { title: c.title, body: c.body };
    if (c.subtitle) out.subtitle = c.subtitle;
    if (c.items) out.items = c.items;
    if (c.href) out.href = c.href;
    if (c.linkLabel) out.linkLabel = c.linkLabel;
    if (c.swatch) out.swatch = ctx.palette.css[c.swatch] ?? '';
    return out;
  };
  heat.add('micro-bumps', [copperMat, solderMat, topMatA]);
  heat.add('hybrid-bonding', [copperMatB, dielMat, topMatB]);
  hotspots.register('micro-bumps', { object: proxyA, anchor: A, card: () => cardFor('micro-bumps'), onHighlight: (on) => heat.set('micro-bumps', on) });
  hotspots.register('hybrid-bonding', { object: proxyB, anchor: B, card: () => cardFor('hybrid-bonding'), onHighlight: (on) => heat.set('hybrid-bonding', on) });
  // Package parts live in the `cowos` variant: picking them from the list switches over and focuses.
  for (const id of ['logic-die', 'hbm-stack', 'interposer', 'tsv', 'lsi-bridge', 'c4-bumps', 'substrate', 'reticle-limit'])
    hotspots.register(id, {
      card: () => cardFor(id),
      onSelect: () => {
        switchVariant(ctx, 'cowos', id);
        return true;
      },
    });

  layout();
  applyPalette(ctx.palette);
  flowA.setReduced(!ctx.animate);
  flowB.setReduced(!ctx.animate);
  const pending = takePending();
  let pendingTimer = 0;

  return {
    update(_dt, t) {
      flowA.update(t);
      flowB.update(t);
    },
    setStep(_i, step) {
      bondedStep = step?.id === 'bonded';
      animateTo(bondedStep ? 0 : DEFAULT_E);
      moveCamera(bondedStep ? bondedPose() : ctx.homePose);
      if (pending && !pendingTimer)
        pendingTimer = window.setTimeout(() => {
          hotspots.focus(pending, 'command');
          hotspots.select(pending, 'command');
        }, 0);
    },
    onMotion(animate) {
      flowA.setReduced(!animate);
      flowB.setReduced(!animate);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onResize(size) {
      const next = size.portrait;
      if (next !== portrait) {
        portrait = next;
        layout();
        apply();
        moveCamera(bondedStep ? bondedPose() : ctx.homePose, { duration: 0 });
      }
    },
    dispose() {
      clearTimeout(pendingTimer);
      tw?.cancel();
      camTween?.cancel();
      heat.dispose();
      panel.remove();
      root.removeFromParent();
    },
  };
}

/**
 * neural-net — 神經網路如何學習 (variants: forward, backprop).
 *
 * A real 4-6-6-3 MLP (mlp.ts) trained live on a tiny synthetic dataset. Neurons are spheres
 * whose brightness is the activation; weights are instanced cylinders whose thickness and colour
 * encode magnitude and sign. Forward pulses (PathFlow, 'once' mode) travel left → right; in the
 * backprop variant the error travels right → left, edges glow with their gradient and the
 * weights visibly update.
 *
 * Steps: 總覽 → 前向傳播 → 計算誤差 → 反向傳播 → 更新權重 (steps 2–4 switch to `backprop`).
 * Reduced motion: no pulses; each step shows its final state instantly.
 */
import {
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose, type LabelHandle, type Palette, type SceneContext } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { CLASSES, FEATURES, MLP, makeSample, type Grads, type Pass, type Sample } from './mlp';

const SIZES = [4, 6, 6, 3] as const;
const LAYER_X = [-3.3, -1.1, 1.1, 3.3];
const SPACING = 0.78;
const EDGE_T = 0.6; // seconds per edge layer
const LAYER_NAMES = ['輸入層', '隱藏層 1', '隱藏層 2', '輸出層'];
const HOTSPOT_OF_LAYER = ['input-layer', 'hidden-layers', 'hidden-layers', 'output-layer'];

type Phase = 'forward' | 'hold' | 'loss' | 'backward' | 'update';
const DUR: Record<Phase, number> = { forward: 3 * EDGE_T, hold: 1.2, loss: 1.1, backward: 3 * EDGE_T, update: 1.2 };
const PHASE_LABEL: Record<Phase, string> = {
  forward: '前向傳播',
  hold: '產生預測',
  loss: '計算誤差',
  backward: '反向傳播',
  update: '更新權重',
};

function planFor(variant: string, step: number): Phase[] {
  if (step === 1) return ['forward', 'hold'];
  if (step === 2) return ['forward', 'loss', 'hold'];
  if (step === 3) return ['loss', 'backward', 'hold'];
  if (step === 4) return ['update', 'hold'];
  return variant === 'backprop' ? ['forward', 'loss', 'backward', 'update'] : ['forward', 'hold'];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

interface Edge {
  l: number;
  i: number;
  j: number;
  a: Vector3;
  b: Vector3;
}

function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export default defineScene({
  json,
  meta: {
    camera: {
      position: [1.1, 1.0, 10.6],
      target: [0.15, -0.05, 0],
      fov: 36,
      minDistance: 5.5,
      maxDistance: 17,
      minPolar: 0.95,
      maxPolar: 2.05,
      minAzimuth: -1.15,
      maxAzimuth: 1.15,
      portrait: { position: [0.9, 0.6, 14.2], target: [0.35, -0.15, 0] },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 30, tris: 60_000 },
  },

  create(ctx: SceneContext) {
    const { scene, materials, labels, hotspots, rng } = ctx;
    const root = new Group();
    root.name = 'neural-net';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);

    /* ───────── network & layout ───────── */
    const mlp = new MLP(SIZES, rng);
    let portrait = ctx.size.aspect < 0.9;
    const nodePos: Vector3[][] = SIZES.map((n, l) =>
      Array.from({ length: n }, (_, i) => {
        const y = ((n - 1) / 2 - i) * SPACING;
        return new Vector3(LAYER_X[l]!, y, -0.11 * y * y);
      }),
    );
    const nodeIndex: number[][] = [];
    let k = 0;
    for (let l = 0; l < SIZES.length; l++) nodeIndex.push(Array.from({ length: SIZES[l]! }, () => k++));
    const nodeCount = k;
    const layerOfNode: number[] = [];
    const idxInLayer: number[] = [];
    nodeIndex.forEach((ids, l) => ids.forEach((id, i) => ((layerOfNode[id] = l), (idxInLayer[id] = i))));

    const edges: Edge[] = [];
    for (let l = 0; l < SIZES.length - 1; l++)
      for (let j = 0; j < SIZES[l + 1]!; j++)
        for (let i = 0; i < SIZES[l]!; i++) edges.push({ l, i, j, a: nodePos[l]![i]!, b: nodePos[l + 1]![j]! });

    /* ───────── layer panels (hotspot objects) ───────── */
    const panels: Mesh<ShapeGeometry, MeshStandardMaterial>[] = [];
    const panelGroups: Record<string, Group> = {};
    SIZES.forEach((n, l) => {
      const h = (n - 1) * SPACING + 1.15;
      const geo = ctx.track(new ShapeGeometry(roundedRect(1.15, h, 0.32), 6));
      const m = new Mesh(geo, materials.glass('fg', 0.05));
      m.position.set(LAYER_X[l]!, 0, -0.3);
      m.renderOrder = -1;
      panels.push(m);
      const hs = HOTSPOT_OF_LAYER[l]!;
      if (!panelGroups[hs]) {
        panelGroups[hs] = new Group();
        root.add(panelGroups[hs]);
      }
      panelGroups[hs].add(m);
    });

    /* ───────── neurons ───────── */
    const sphere = ctx.track(new SphereGeometry(0.2, 32, 20));
    const neuronMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.05 }));
    const neurons = new InstancedMesh(sphere, neuronMat, nodeCount);
    neurons.instanceMatrix.setUsage(DynamicDrawUsage);
    const m4 = new Matrix4();
    nodeIndex.forEach((ids, l) => ids.forEach((id, i) => neurons.setMatrixAt(id, m4.makeTranslation(nodePos[l]![i]!))));
    neurons.setColorAt(0, new Color());
    root.add(neurons);
    ctx.track({ dispose: () => neurons.dispose() });

    const glows = ctx.track(new GlowSprites({ count: nodeCount, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── edges ───────── */
    const cyl = ctx.track(new CylinderGeometry(1, 1, 1, 10, 1, true));
    const edgeMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, toneMapped: false, depthWrite: false }));
    const edgeMesh = new InstancedMesh(cyl, edgeMat, edges.length);
    edgeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    edgeMesh.setColorAt(0, new Color());
    edgeMesh.renderOrder = 1;
    root.add(edgeMesh);
    ctx.track({ dispose: () => edgeMesh.dispose() });

    /* ───────── target ring (correct answer) ───────── */
    const ringMat = materials.basic('pos', { transparent: true, opacity: 0, depthWrite: false });
    const ring = new Mesh(ctx.track(new TorusGeometry(0.33, 0.028, 10, 56)), ringMat);
    ring.renderOrder = 3;
    root.add(ring);

    /* ───────── pulses ───────── */
    const flowPaths = (dir: 1 | -1): FlowPath[] =>
      edges.map((e) => {
        const len = e.a.distanceTo(e.b);
        return {
          points: dir === 1 ? [e.a, e.b] : [e.b, e.a],
          speed: len / EDGE_T,
          offset: dir === 1 ? -e.l : -(SIZES.length - 2 - e.l),
        };
      });
    const flowOpts = { count: edges.length * 3, size: 0.15, sizeVariance: 0.1, speed: 1, speedVariance: 0, smooth: false, mode: 'once' as const, onceOffsets: [0, -0.05, -0.1], fadeEnds: 0.12, byLength: false, theme: ctx.theme };
    const fwd = ctx.track(new PathFlow({ ...flowOpts, paths: flowPaths(1) }));
    const bwd = ctx.track(new PathFlow({ ...flowOpts, paths: flowPaths(-1) }));
    root.add(fwd.object, bwd.object);

    /* ───────── state ───────── */
    let sample: Sample = makeSample(rng, 0);
    let pass: Pass = mlp.forward(sample.x, sample.y);
    let grads: Grads = mlp.backward(pass, sample.y);
    let wOld = mlp.flatWeights();
    let wNew = wOld;
    let wDisp = wOld.slice();
    let gradMag: number[] = edges.map(() => 0);
    let updates = 0;
    let avgLoss = pass.loss;
    let classCursor = 0;
    const lit = SIZES.map(() => 0); // per-layer reveal 0..1
    let errShow = 0;
    let gradShow: number[] = [0, 0, 0]; // per edge layer
    let flowsOn = { f: false, b: false };

    const newCycle = () => {
      classCursor = (classCursor + 1) % 3;
      sample = makeSample(rng, classCursor);
      pass = mlp.forward(sample.x, sample.y);
      grads = mlp.backward(pass, sample.y);
      const flat = grads.w.flatMap((W) => W.flatMap((r) => r));
      const max = Math.max(1e-6, ...flat.map(Math.abs));
      gradMag = flat.map((g) => Math.abs(g) / max);
      wOld = mlp.flatWeights();
      wNew = wOld;
      wDisp = wOld.slice();
    };

    const train = () => {
      // Mini-batch: the shown sample plus five more, so the loss falls visibly but smoothly.
      const batch: Grads[] = [grads];
      for (let b = 0; b < 5; b++) {
        const s = makeSample(rng);
        batch.push(mlp.backward(mlp.forward(s.x, s.y), s.y));
      }
      wOld = mlp.flatWeights();
      mlp.step(batch, 0.55);
      wNew = mlp.flatWeights();
      updates++;
      const after = mlp.forward(sample.x, sample.y).loss;
      avgLoss = avgLoss * 0.7 + after * 0.3;
    };

    /* ───────── labels ───────── */
    const top = ((6 - 1) / 2) * SPACING;
    const titleLabels: LabelHandle[] = SIZES.map((_, l) =>
      labels.add({
        text: LAYER_NAMES[l]!,
        position: [LAYER_X[l]!, top + 0.85, -0.2],
        object: root,
        kind: 'strong',
        priority: 30,
        hotspot: HOTSPOT_OF_LAYER[l]!,
      }),
    );
    const featureLabels = FEATURES.map((f, i) =>
      labels.add({ text: f, position: nodePos[0]![i]!, object: root, align: 'left', offset: [-14, 0], priority: 12, hotspot: 'input-layer' }),
    );
    const outLabels = CLASSES.map((c, j) =>
      labels.add({ text: c, position: nodePos[3]![j]!, object: root, align: 'right', offset: [14, 0], priority: 14, hotspot: 'output-layer' }),
    );
    const phaseLabel = labels.add({ text: '', position: [0, -top - 0.62, 0], object: root, kind: 'strong', priority: 40, always: true });
    const lossLabel = labels.add({ text: '', position: [LAYER_X[3]!, -top - 0.55, 0], object: root, kind: 'muted', priority: 16 });
    const sampleLabel = labels.add({ text: '', position: [LAYER_X[0]!, -top - 0.55, 0], object: root, kind: 'muted', priority: 15 });
    labels.setMax(20);

    /* ───────── colours ───────── */
    const cBase = new Color();
    const cAct = new Color();
    const cPos = new Color();
    const cNeg = new Color();
    const cWeak = new Color();
    const cGrad = new Color();
    const cErr = new Color();
    const cOk = new Color();
    const tmpC = new Color();
    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      cBase.copy(p.bg).lerp(p.fg, dark ? 0.2 : 0.16).lerp(p.muted, 0.35);
      cAct.copy(p.highlight);
      cPos.copy(p.flow);
      cNeg.copy(p.heat);
      cWeak.copy(p.grid).lerp(p.muted, dark ? 0.25 : 0.15);
      cGrad.copy(p.optic);
      cErr.copy(p.heat);
      cOk.copy(p.pos);
      fwd.recolor(() => p.flow);
      bwd.recolor(() => p.optic);
      for (const f of [fwd, bwd]) {
        f.setTheme(p.theme);
        f.setSize(dark ? 0.15 : 0.095);
        f.setOpacity(dark ? 1 : 0.8);
      }
      glows.setTheme(p.theme);
      lights.apply(p);
      for (const pm of panels) pm.material.opacity = 0;
    };
    applyPalette(ctx.palette);

    /* ───────── visuals ───────── */
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const dir = new Vector3();
    const mid = new Vector3();
    const sc = new Vector3();
    let maxW = 1.2;

    const drawEdges = () => {
      maxW = Math.max(0.6, ...wDisp.map(Math.abs)) * 0.85;
      edges.forEach((e, idx) => {
        const w = wDisp[idx] ?? 0;
        const m = Math.min(1, Math.abs(w) / maxW);
        const g = (gradShow[e.l] ?? 0) * (gradMag[idx] ?? 0);
        const r = 0.006 + 0.03 * m * m + 0.022 * g;
        dir.subVectors(e.b, e.a);
        const len = dir.length();
        mid.addVectors(e.a, e.b).multiplyScalar(0.5);
        q.setFromUnitVectors(up, dir.normalize());
        edgeMesh.setMatrixAt(idx, m4.compose(mid, q, sc.set(r, len, r)));
        tmpC.copy(cWeak).lerp(w >= 0 ? cPos : cNeg, 0.3 + 0.7 * m);
        if (g > 0.001) tmpC.lerp(cGrad, Math.min(1, g * 1.2));
        edgeMesh.setColorAt(idx, tmpC);
      });
      edgeMesh.instanceMatrix.needsUpdate = true;
      if (edgeMesh.instanceColor) edgeMesh.instanceColor.needsUpdate = true;
    };

    const actNorm = (l: number, i: number) => {
      const a = pass.acts[l]?.[i] ?? 0;
      if (l === 0 || l === SIZES.length - 1) return Math.min(1, Math.max(0, a));
      const max = Math.max(0.3, ...(pass.acts[l] ?? [0]));
      return Math.min(1, a / max);
    };

    const drawNeurons = () => {
      const dark = ctx.theme === 'dark';
      for (let id = 0; id < nodeCount; id++) {
        const l = layerOfNode[id]!;
        const i = idxInLayer[id]!;
        const a = actNorm(l, i) * (lit[l] ?? 0);
        tmpC.copy(cBase).lerp(cAct, a);
        let glowC = cAct;
        let glowA = a * (dark ? 0.85 : 0.5);
        if (l === SIZES.length - 1 && errShow > 0) {
          const target = i === sample.y ? 1 : 0;
          const err = Math.abs((pass.probs[i] ?? 0) - target);
          glowC = i === sample.y ? cOk : cErr;
          glowA = Math.max(glowA * (1 - errShow), err * errShow * (dark ? 0.95 : 0.65));
          if (i !== sample.y) tmpC.lerp(cErr, err * errShow * 0.6);
        }
        neurons.setColorAt(id, tmpC);
        const p = nodePos[l]![i]!;
        glows.set(id, p, 0.75 + 0.75 * Math.max(a, glowA), glowC, glowA);
        neurons.setMatrixAt(id, m4.compose(p, q.identity(), sc.setScalar(1 + 0.12 * a)));
      }
      neurons.instanceMatrix.needsUpdate = true;
      if (neurons.instanceColor) neurons.instanceColor.needsUpdate = true;
      ring.position.copy(nodePos[3]![sample.y]!);
      ringMat.opacity = errShow;
      ring.visible = errShow > 0.01;
    };

    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const drawLabels = (phase: Phase) => {
      featureLabels.forEach((h, i) => h.set({ text: `${FEATURES[i]} ${(sample.x[i] ?? 0).toFixed(2)}` }));
      const outLit = (lit[3] ?? 0) > 0.5;
      outLabels.forEach((h, j) => {
        const base = CLASSES[j]!;
        const mark = errShow > 0.5 && j === sample.y ? '（正解）' : '';
        h.set({ text: outLit ? `${base} ${pct(pass.probs[j] ?? 0)}${mark}` : base });
      });
      // While holding, keep naming the phase that just finished (e.g. 反向傳播 at the end of step 3).
      const shown = phase === 'hold' ? ([...plan].reverse().find((p) => p !== 'hold' && p !== 'forward') ?? 'hold') : phase;
      phaseLabel.set({ text: PHASE_LABEL[shown] + (shown === 'update' ? `・第 ${updates} 次` : '') });
      sampleLabel.set({ text: `樣本：${CLASSES[sample.y]}` });
      const showLoss = errShow > 0.5 || phase === 'backward' || phase === 'update';
      lossLabel.set({
        text: showLoss ? `誤差 ${pass.loss.toFixed(2)}${updates ? `・平均 ${avgLoss.toFixed(2)}` : ''}` : '',
      });
    };

    /* ───────── phase machine ───────── */
    let plan: Phase[] = planFor(ctx.variant, ctx.step);
    let phaseIdx = 0;
    let phaseT = 0;

    const resetVisuals = (phase: Phase) => {
      // State at the start of a phase.
      if (phase === 'forward') {
        lit.fill(0);
        lit[0] = 1;
        errShow = 0;
        gradShow = [0, 0, 0];
      } else if (phase === 'loss') {
        lit.fill(1);
        gradShow = [0, 0, 0];
      } else if (phase === 'backward') {
        lit.fill(1);
        errShow = 1;
        gradShow = [0, 0, 0];
      } else if (phase === 'update') {
        lit.fill(1);
        errShow = 0;
        gradShow = [1, 1, 1];
        train();
      }
    };

    const enter = (phase: Phase) => {
      resetVisuals(phase);
      flowsOn = { f: phase === 'forward' && ctx.animate, b: phase === 'backward' && ctx.animate };
      fwd.object.visible = flowsOn.f;
      bwd.object.visible = flowsOn.b;
    };

    const apply = (phase: Phase, t: number) => {
      const k = Math.min(1, t / DUR[phase]);
      switch (phase) {
        case 'forward':
          fwd.setTime(t);
          for (let l = 1; l < SIZES.length; l++) lit[l] = smooth(l * EDGE_T - 0.12, l * EDGE_T + 0.12, t);
          break;
        case 'loss':
          errShow = smooth(0, 0.6, t);
          break;
        case 'backward':
          bwd.setTime(t);
          for (let l = 0; l < 3; l++) {
            const order = 2 - l; // output-side edge layer first
            gradShow[l] = smooth(order * EDGE_T, (order + 1) * EDGE_T, t);
          }
          break;
        case 'update': {
          const e = ease(Math.min(1, k * 1.15));
          wDisp = wOld.map((w, i) => w + ((wNew[i] ?? w) - w) * e);
          gradShow = [1 - e, 1 - e, 1 - e];
          break;
        }
        default:
      }
      drawEdges();
      drawNeurons();
      drawLabels(phase);
    };

    /** Reduced motion / paused-at-step: jump straight to the final state of the step's plan. */
    const showStatic = () => {
      for (const ph of plan) {
        enter(ph);
        apply(ph, DUR[ph]);
      }
      fwd.object.visible = bwd.object.visible = false;
      phaseIdx = plan.length - 1;
      phaseT = DUR[plan[phaseIdx]!];
    };

    const startPlan = () => {
      plan = planFor(ctx.variant, ctx.step);
      phaseIdx = 0;
      phaseT = 0;
      newCycle();
      if (!ctx.animate) {
        showStatic();
        return;
      }
      enter(plan[0]!);
      apply(plan[0]!, 0);
    };
    startPlan();

    /* ───────── hotspots ───────── */
    const panelOf = (id: string) => panels.filter((_, l) => HOTSPOT_OF_LAYER[l] === id);
    const center = (id: string) => {
      const ls = SIZES.map((_, l) => l).filter((l) => HOTSPOT_OF_LAYER[l] === id);
      const x = ls.reduce((s, l) => s + LAYER_X[l]!, 0) / ls.length;
      return new Vector3(x, 0, 0);
    };
    const poseFor = (id: string): CameraPose => {
      const c = center(id);
      return { position: [c.x * 0.75 + 0.8, 0.9, 7.8], target: [c.x * 0.75, -0.1, 0] };
    };
    const neuronCard = (id: number) => {
      const l = layerOfNode[id]!;
      const i = idxInLayer[id]!;
      const a = pass.acts[l]?.[i] ?? 0;
      if (l === 0)
        return { title: `輸入：${FEATURES[i]}`, body: `特徵值 ${a.toFixed(2)}。輸入層只負責把數值交給下一層。` };
      if (l === SIZES.length - 1)
        return {
          title: `輸出：${CLASSES[i]}`,
          body: `網路認為是「${CLASSES[i]}」的機率為 ${pct(pass.probs[i] ?? 0)}。${i === sample.y ? '這是正確答案。' : ''}`,
        };
      return { title: `${LAYER_NAMES[l]}・第 ${i + 1} 個神經元`, body: `啟動值 ${a.toFixed(2)}＝ReLU（加權總和＋偏差）。越亮代表越活躍。` };
    };
    for (const id of ['input-layer', 'hidden-layers', 'output-layer']) {
      const own = panelOf(id);
      hotspots.register(id, {
        object: panelGroups[id]!,
        pose: poseFor(id),
        onHighlight: (on) => {
          for (const pm of own) {
            ctx.tween.to(pm.material, { opacity: on ? (ctx.theme === 'dark' ? 0.09 : 0.12) : 0 }, { duration: 200, fade: true });
          }
        },
        card: (hit) => {
          if (hit?.object === neurons && hit.instanceId !== undefined) return neuronCard(hit.instanceId);
          return null;
        },
      });
    }
    ctx.picker.add(neurons, {
      id: (h) => (h.instanceId !== undefined ? (HOTSPOT_OF_LAYER[layerOfNode[h.instanceId] ?? 0] ?? null) : null),
    });

    /* ───────── portrait layout ───────── */
    const layout = () => {
      root.rotation.z = portrait ? -Math.PI / 2 : 0;
      root.updateMatrixWorld(true);
      featureLabels.forEach((h) => h.set({ align: portrait ? 'above' : 'left', offset: portrait ? [0, -6] : [-14, 0] }));
      outLabels.forEach((h) => h.set({ align: portrait ? 'below' : 'right', offset: portrait ? [0, 6] : [14, 0] }));
      titleLabels.forEach((h, l) => h.set({ position: portrait ? [LAYER_X[l]!, top + 0.85, 0.4] : [LAYER_X[l]!, top + 0.85, -0.2] }));
    };
    layout();

    return {
      update(dt) {
        if (!ctx.animate) return;
        phaseT += dt;
        let phase = plan[phaseIdx]!;
        while (phaseT >= DUR[phase]) {
          phaseT -= DUR[phase];
          phaseIdx++;
          if (phaseIdx >= plan.length) {
            phaseIdx = 0;
            newCycle();
          }
          phase = plan[phaseIdx]!;
          enter(phase);
        }
        apply(phase, phaseT);
      },
      setStep() {
        startPlan();
        // Loss / backprop steps lean toward the output layer (landscape layout only).
        const lean = (ctx.step === 2 || ctx.step === 3) && !portrait;
        ctx.setPose(lean ? { position: [1.9, 0.9, 9.7], target: [0.75, -0.1, 0] } : ctx.homePose);
      },
      setVariant() {
        startPlan();
      },
      onMotion(animate) {
        if (!animate) showStatic();
        else {
          const ph = plan[phaseIdx]!;
          enter(ph);
          apply(ph, phaseT);
        }
      },
      onPalette(p) {
        applyPalette(p);
        apply(plan[phaseIdx]!, phaseT);
      },
      onResize(size) {
        const next = size.aspect < 0.9;
        if (next !== portrait) {
          portrait = next;
          layout();
        }
      },
      dispose() {
        root.removeFromParent();
      },
    };
  },
});

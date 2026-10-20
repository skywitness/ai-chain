/**
 * Inference zone: a small continuous-batching simulation on one serving GPU (示意).
 *
 * Users (front row) send requests (cubes in their colour) into a queue; the scheduler admits a
 * request whenever one of the 4 batch slots is free. Iterations are either a PREFILL (the oldest
 * newly admitted prompt, all its tokens in parallel: its KV cells appear at once, the compute gauge
 * peaks, the first token is emitted; never two prefills in a row while others decode) or a DECODE
 * step (weights and every KV row are read — the sweep — then each running request appends one KV
 * cell and emits one token that flies back to its user).
 * Finished requests free their KV row. The panel behind the GPU is the content of HBM: model
 * weights (left) and the KV cache, one row per batch slot, one cell per token.
 */
import {
  BufferGeometry,
  CapsuleGeometry,
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
  Quaternion,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraPose, LabelHandle, Palette, QualityTier } from '../../core/types';
import { scaleCount } from '../../core/quality';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  LabelSet,
  approach,
  bezier,
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

const SLOTS = 4;
const COLS = 12;
const USERS = 5;
const USER_X0 = [-3.2, -1.6, 0, 1.6, 3.2];
const USER_Z = 2.3;
const USER_S = 0.85;
const GPU_Z = -0.15;
const SCHED = new Vector3(-1.72, 0, GPU_Z);
const DIE_TOP = new Vector3(0, 0.3, GPU_Z);
const PANEL = { z: -1.62, x0: -2.4, x1: 2.4, y0: 0.4, y1: 2.55 };
const ROW_Y = [2.06, 1.6, 1.14, 0.68];
const COL_X0 = -1.2;
const COL_DX = 0.28;
const MARK_X = -1.5;
const W_X = -1.98;
const GAUGE_X = [1.8, 2.2];
const GAUGE_Z = 0.62;
const GAUGE_H = 1.0;
const EMPTY_S = 0.8; // empty KV slot: scale (x, y) …
const EMPTY_D = 0.5; // … and depth relative to a cached token's cell
const PREFILL_T = 0.95;
const TOKEN_T = 0.95;

type RState = 'travel' | 'queue' | 'admit' | 'wait' | 'run' | 'off';
interface Req {
  user: number;
  prompt: number;
  out: number;
  gen: number;
  slot: number;
  /** Admission order (FIFO prefill). */
  seq: number;
  st: RState;
  t: number;
  pos: Vector3;
  a: Vector3;
  b: Vector3;
  c: Vector3;
}
interface Tok {
  on: boolean;
  user: number;
  t: number;
  pos: Vector3;
  b: Vector3;
  c: Vector3;
}

const qSpot = (k: number, out: Vector3) => out.set(-2.36 - 0.36 * k, 0.17, GPU_Z);
const cellX = (c: number) => COL_X0 + c * COL_DX;

export function buildInference(env: ZoneEnv): Zone {
  const { ctx, origin } = env;
  const { materials, rng } = ctx;
  const group = new Group();
  group.name = 'zone-inference';
  group.position.copy(origin);
  env.parent.add(group);
  const labels = new LabelSet(ctx, group);
  const USER_X = [...USER_X0]; // portrait stages pull the row together (onResize)
  const m4 = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();
  const sc = new Vector3();

  /* ───────── floor ───────── */
  const floor = makeFloor(ctx, 6.8, 0.7, -0.01);
  group.add(floor.group);

  /* ───────── users ───────── */
  const reqGroup = new Group();
  group.add(reqGroup);
  const userMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 }));
  const bodies = new InstancedMesh(ctx.track(new CapsuleGeometry(0.13, 0.2, 4, 14)), userMat, USERS);
  const heads = new InstancedMesh(ctx.track(new SphereGeometry(0.115, 20, 14)), userMat, USERS);
  const bases = new InstancedMesh(ctx.track(new CylinderGeometry(0.27, 0.29, 0.035, 32)), userMat, USERS);
  const placeUsers = () => {
    sc.setScalar(USER_S);
    USER_X.forEach((x, j) => {
      bodies.setMatrixAt(j, m4.compose(v.set(x, 0.27 * USER_S, USER_Z), q, sc));
      heads.setMatrixAt(j, m4.compose(v.set(x, 0.58 * USER_S, USER_Z), q, sc));
      bases.setMatrixAt(j, m4.compose(v.set(x, 0.018, USER_Z), q, sc));
    });
    for (const m of [bodies, heads, bases]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  };
  placeUsers();
  for (const m of [bodies, heads, bases]) {
    m.setColorAt(0, new Color());
    reqGroup.add(m);
    ctx.track({ dispose: () => m.dispose() });
  }

  /* ───────── queue lane + scheduler ───────── */
  const laneMat = materials.glass((p) => (p.theme === 'dark' ? p.muted : p.fg), 0.1);
  const laneGeo = ctx.track(new ShapeGeometry(roundedRect(1.95, 0.42, 0.18), 4));
  laneGeo.rotateX(-Math.PI / 2);
  const lane = new Mesh(laneGeo, laneMat);
  lane.position.set(-2.95, 0.012, GPU_Z);
  reqGroup.add(lane);
  const schedMat = materials.standard((p) => hardware(p), { roughness: 0.5, metalness: 0.3 });
  const sched = new Mesh(ctx.track(new RoundedBoxGeometry(0.56, 0.3, 0.6, 2, 0.06)), schedMat);
  sched.position.set(SCHED.x, 0.15, SCHED.z);
  const lampMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const lamp = new Mesh(ctx.track(new CylinderGeometry(0.17, 0.17, 0.03, 28)), lampMat);
  lamp.position.set(SCHED.x, 0.31, SCHED.z);
  reqGroup.add(sched, lamp);

  /* ───────── GPU package ───────── */
  const gpuGroup = new Group();
  group.add(gpuGroup);
  const sub = new Mesh(ctx.track(new RoundedBoxGeometry(2.5, 0.12, 1.75, 2, 0.04)), materials.standard((p) => hardware(p), { roughness: 0.55, metalness: 0.3 }));
  sub.position.set(0, 0.06, GPU_Z);
  const dieMat = materials.standard('seg:ai-accelerators', { roughness: 0.3, metalness: 0.45 });
  const die = new Mesh(ctx.track(new RoundedBoxGeometry(0.95, 0.09, 0.95, 2, 0.025)), dieMat);
  die.position.set(0, 0.165, GPU_Z);
  const hbmMat = materials.standard('seg:memory-storage', { roughness: 0.38, metalness: 0.35 });
  const hbms = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.36, 0.2, 0.4, 2, 0.025)), hbmMat, 6);
  const hbmPos: Vector3[] = [];
  [-1, 1].forEach((sx) =>
    [-0.5, 0, 0.5].forEach((dz) => {
      const p = new Vector3(sx * 0.83, 0.22, GPU_Z + dz);
      hbms.setMatrixAt(hbmPos.length, m4.makeTranslation(p.x, p.y, p.z));
      hbmPos.push(p);
    }),
  );
  gpuGroup.add(sub, die, hbms);
  ctx.track({ dispose: () => hbms.dispose() });

  /* ───────── HBM content panel (weights + KV cache) ───────── */
  const kvGroup = new Group();
  group.add(kvGroup);
  const panelShape = roundedRect(PANEL.x1 - PANEL.x0, PANEL.y1 - PANEL.y0, 0.16);
  const panelMat = materials.glass((p) => (p.theme === 'dark' ? p.muted : p.fg), 0.07, { roughness: 0.5 });
  const panel = new Mesh(ctx.track(new ShapeGeometry(panelShape, 6)), panelMat);
  panel.position.set((PANEL.x0 + PANEL.x1) / 2, (PANEL.y0 + PANEL.y1) / 2, PANEL.z - 0.05);
  panel.renderOrder = 1;
  const edge = new LineLoop(
    ctx.track(new BufferGeometry().setFromPoints(panelShape.getPoints(6).map((p) => new Vector3(p.x, p.y, 0)))),
    materials.line('seg:memory-storage', { transparent: true, opacity: 0.6 }),
  );
  edge.position.copy(panel.position);
  kvGroup.add(panel, edge);
  // Leader lines: the panel is "what is inside HBM".
  const leadPos: number[] = [];
  for (const sx of [-1, 1]) leadPos.push(sx * 1.1, PANEL.y0, PANEL.z, sx * 0.83, 0.33, GPU_Z - 0.5);
  const leadGeo = ctx.track(new BufferGeometry());
  leadGeo.setAttribute('position', new Float32BufferAttribute(leadPos, 3));
  group.add(new LineSegments(leadGeo, materials.line('seg:memory-storage', { transparent: true, opacity: 0.45 })));

  const cellMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.05 }));
  const NCELL = SLOTS * COLS + SLOTS;
  const cells = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.22, 0.3, 0.07, 2, 0.025)), cellMat, NCELL);
  cells.instanceMatrix.setUsage(DynamicDrawUsage);
  cells.setColorAt(0, new Color());
  kvGroup.add(cells);
  ctx.track({ dispose: () => cells.dispose() });
  const wMat = materials.standard('seg:foundation-models', { roughness: 0.45, metalness: 0.15 });
  const weights = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.62, 0.15, 0.08, 2, 0.025)), wMat, 8);
  for (let i = 0; i < 8; i++) weights.setMatrixAt(i, m4.makeTranslation(W_X, 0.66 + i * 0.2, PANEL.z));
  kvGroup.add(weights);
  ctx.track({ dispose: () => weights.dispose() });

  /* ───────── gauges (compute vs bandwidth, 示意) ───────── */
  const gaugeGroup = new Group();
  group.add(gaugeGroup);
  const frameMat = materials.glass((p) => (p.theme === 'dark' ? p.muted : p.fg), 0.12);
  const frames = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.26, GAUGE_H + 0.06, 0.26, 2, 0.04)), frameMat, 2);
  const fillMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1 }));
  const fills = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.18, 1, 0.18, 1, 0.03)), fillMat, 2);
  fills.instanceMatrix.setUsage(DynamicDrawUsage);
  fills.setColorAt(0, new Color());
  GAUGE_X.forEach((x, i) => frames.setMatrixAt(i, m4.makeTranslation(x, GAUGE_H / 2 + 0.03, GAUGE_Z)));
  frames.renderOrder = 2;
  gaugeGroup.add(fills, frames);
  for (const m of [frames, fills]) ctx.track({ dispose: () => m.dispose() });

  /* ───────── moving things ───────── */
  const packetMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.1 }));
  const packets = new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.2, 0.2, 0.2, 2, 0.04)), packetMat, 8);
  packets.instanceMatrix.setUsage(DynamicDrawUsage);
  packets.setColorAt(0, new Color());
  packets.frustumCulled = false;
  const tokMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const MAXTOK = 28;
  const tokens = new InstancedMesh(ctx.track(new SphereGeometry(0.065, 14, 10)), tokMat, MAXTOK);
  tokens.instanceMatrix.setUsage(DynamicDrawUsage);
  tokens.setColorAt(0, new Color());
  tokens.frustumCulled = false;
  group.add(packets, tokens);
  for (const m of [packets, tokens]) ctx.track({ dispose: () => m.dispose() });

  // HBM → compute traffic (loop flow; brightness follows the bandwidth gauge).
  const memPaths: FlowPath[] = hbmPos.map((p) => ({
    points: [new Vector3(p.x, 0.34, p.z), new Vector3(p.x * 0.7, 0.4, GPU_Z + (p.z - GPU_Z) * 0.75), new Vector3(Math.sign(p.x) * 0.36, 0.23, GPU_Z + (p.z - GPU_Z) * 0.55)],
  }));
  const MEM_MAX = 120;
  const memFlow = ctx.track(new PathFlow({ paths: memPaths, count: MEM_MAX, size: 0.06, speed: 0.55, speedVariance: 0.2, fadeEnds: 0.15, theme: ctx.theme, seed: 5 }));
  memFlow.setCount(scaleCount(MEM_MAX, ctx.tier, 30));
  group.add(memFlow.object);

  const glows = ctx.track(new GlowSprites({ count: 1 + USERS, theme: ctx.theme }));
  group.add(glows.object);

  /* ───────── labels ───────── */
  const phaseLabel = labels.add({ text: '', position: [0, 0, 2.95], align: 'below', kind: 'strong', priority: 40, always: true });
  const subLabel = labels.add({ text: '', position: [0, 0, 2.95], align: 'below', offset: [0, 31], kind: 'muted', priority: 32, always: true });
  const userLabel = labels.add({ text: '使用者', position: [USER_X[0]! - 0.3, 0.35, USER_Z], align: 'left', priority: 20, hotspot: 'request-batching' });
  labels.add({ text: '請求佇列', position: [-3.0, 0.02, GPU_Z + 0.24], align: 'below', kind: 'default', priority: 16, hotspot: 'request-batching' });
  labels.add({ text: '排程器', position: [SCHED.x, 0.36, SCHED.z], align: 'above', priority: 22, hotspot: 'request-batching' });
  labels.add({ text: '推論 GPU', position: [0.3, 0.06, GPU_Z + 0.9], align: 'below', priority: 21, hotspot: 'serving-gpu' });
  const tokLabel = labels.add({ text: 'token 逐一串流回使用者', position: [USER_X[USERS - 1]! + 0.4, 0.4, USER_Z], align: 'right', kind: 'tag', priority: 12, hotspot: 'prefill-decode' });
  labels.add({ text: 'HBM', position: [-0.83, 0.34, GPU_Z + 0.5], align: 'below', offset: [0, 6], kind: 'tag', priority: 8, hotspot: 'serving-gpu' }, (s) => s >= 4);
  labels.add({ text: '模型權重', position: [W_X, PANEL.y1 - 0.12, PANEL.z], align: 'above', priority: 19, hotspot: 'serving-gpu' });
  labels.add({ text: 'KV Cache（每格＝1 個 token）', position: [(cellX(0) + cellX(COLS - 1)) / 2, PANEL.y1 - 0.12, PANEL.z], align: 'above', priority: 23, hotspot: 'kv-cache' });
  labels.add({ text: '使用率（示意）', position: [(GAUGE_X[0]! + GAUGE_X[1]!) / 2, GAUGE_H + 0.12, GAUGE_Z], align: 'above', kind: 'muted', priority: 14, hotspot: 'prefill-decode' });
  let portrait = ctx.size.portrait;
  // On portrait stages the two gauges are closer than two tags are wide: one shared tag instead
  // (its two words land under their gauges).
  ['運算', '頻寬'].forEach((text, i) =>
    labels.add({ text, position: [GAUGE_X[i]!, 0, GAUGE_Z + 0.14], align: 'below', kind: 'tag', priority: 12, hotspot: 'prefill-decode' }, () => !portrait),
  );
  labels.add({ text: '運算 頻寬', position: [(GAUGE_X[0]! + GAUGE_X[1]!) / 2, 0, GAUGE_Z + 0.14], align: 'below', kind: 'tag', priority: 12, hotspot: 'prefill-decode' }, () => portrait);
  // Row captions of the KV step sit right of the panel: landscape only (a 4:5 frame has no room).
  const rowLabels: LabelHandle[] = ROW_Y.map((y) =>
    labels.add({ text: '', position: [PANEL.x1 - 0.02, y, PANEL.z], align: 'right', kind: 'tag', priority: 10, hotspot: 'kv-cache' }, (s) => s === 5 && !portrait),
  );

  /* ───────── simulation state ───────── */
  const reqs: Req[] = Array.from({ length: USERS }, (_, j) => ({ user: j, prompt: 0, out: 0, gen: 0, slot: -1, seq: 0, st: 'off', t: 0, pos: new Vector3(), a: new Vector3(), b: new Vector3(), c: new Vector3() }));
  const toks: Tok[] = Array.from({ length: MAXTOK }, () => ({ on: false, user: 0, t: 0, pos: new Vector3(), b: new Vector3(), c: new Vector3() }));
  const queue: Req[] = [];
  const cool = USER_X.map((_, j) => 0.2 + j * 0.45 + rng() * 0.4);
  const kind = new Uint8Array(SLOTS * COLS); // 0 empty, 1 prompt, 2 output
  const born = new Float32Array(SLOTS * COLS);
  const rowUser = new Int8Array(SLOTS).fill(-1);
  const rowFree = new Float32Array(SLOTS).fill(-1); // time the row started freeing (-1 = not)
  const flash = new Float32Array(USERS);
  let now = 0;
  let admitFlash = 0;
  let itKind: 0 | 1 | 2 = 0; // none / prefill / decode
  let itT = 0;
  let itDur = 0.6;
  let prefillFilled = false;
  let lastPrefill = false;
  let admitted = 0;
  const batch: Req[] = [];
  let decodeT = 0.6;
  let gCompute = 0.05;
  let gBand = 0.05;
  let step = 3;
  let isStatic = false;
  const hot = { req: 0, gpu: 0, gauge: 0, kv: 0 };

  const userHead = (j: number, out: Vector3) => out.set(USER_X[j]!, 0.6 * USER_S, USER_Z);
  /** Caption of one KV-cache row (batch slot) for the KV step. */
  const rowText = (s: number): string => {
    for (const r of reqs) {
      if (r.slot !== s) continue;
      if (r.st === 'admit') return '剛排入批次';
      if (r.st === 'wait') return itKind === 1 && batch.includes(r) ? 'Prefill 中' : '等待 Prefill';
      // The newest token's Key/Value are cached by the next decode step, hence gen − 1.
      if (r.st === 'run') return r.gen > 1 ? `提示 ${r.prompt}＋輸出 ${r.gen - 1} 格` : `提示 ${r.prompt} 格`;
    }
    return rowFree[s]! >= 0 ? '完成，釋放中' : '空位';
  };
  const inSlot = (s: number): Req | null => {
    for (const r of reqs) if (r.slot === s && (r.st === 'run' || r.st === 'wait')) return r;
    return null;
  };

  const spawn = (j: number) => {
    const r = reqs[j]!;
    r.prompt = 2 + Math.floor(rng() * 3);
    r.out = 3 + Math.floor(rng() * 7); // prompt + out − 1 ≤ COLS KV cells
    r.gen = 0;
    r.slot = -1;
    r.st = 'travel';
    r.t = 0;
    r.a.set(USER_X[j]!, 0.36, USER_Z - 0.15);
    qSpot(Math.min(5, queue.length + reqs.filter((x) => x.st === 'travel').length - 1), r.c);
    r.b.set((r.a.x + r.c.x) / 2, 1.1, (r.a.z + r.c.z) / 2 + 0.4);
    r.pos.copy(r.a);
  };

  const emitToken = (r: Req) => {
    const tk = toks.find((x) => !x.on);
    if (!tk) return;
    tk.on = true;
    tk.user = r.user;
    tk.t = 0;
    userHead(r.user, tk.c);
    tk.b.set((DIE_TOP.x + tk.c.x) / 2, 2.25, (DIE_TOP.z + tk.c.z) / 2 + 0.3);
    tk.pos.copy(DIE_TOP);
  };

  const freeSlot = () => {
    for (let s = 0; s < SLOTS; s++) if (rowUser[s] === -1 && rowFree[s]! < 0) return s;
    return -1;
  };

  const sim = (dt: number) => {
    now += dt;
    // Users send a new request when they have none outstanding.
    for (let j = 0; j < USERS; j++) {
      if (reqs[j]!.st !== 'off') continue;
      cool[j]! -= dt;
      if (cool[j]! <= 0) spawn(j);
    }
    // Requests on their way to the queue / GPU.
    for (const r of reqs) {
      if (r.st === 'travel') {
        r.t = Math.min(1, r.t + dt / 1.1);
        bezier(r.a, r.b, r.c, r.t, r.pos);
        if (r.t >= 1) {
          r.st = 'queue';
          queue.push(r);
        }
      } else if (r.st === 'admit') {
        r.t = Math.min(1, r.t + dt / 0.75);
        bezier(r.a, r.b, r.c, r.t, r.pos);
        if (r.t >= 1) r.st = 'wait';
      }
    }
    queue.forEach((r, k) => {
      qSpot(k, v);
      r.pos.x = approach(r.pos.x, v.x, dt, 8);
      r.pos.y = approach(r.pos.y, v.y, dt, 8);
      r.pos.z = approach(r.pos.z, v.z, dt, 8);
    });
    // Admission: the queue head takes any free batch slot (continuous batching).
    const head = queue[0];
    if (head && head.pos.distanceToSquared(qSpot(0, v)) < 0.09) {
      const s = freeSlot();
      if (s >= 0) {
        queue.shift();
        head.slot = s;
        head.seq = ++admitted;
        rowUser[s] = head.user;
        head.st = 'admit';
        head.t = 0;
        head.a.copy(head.pos);
        head.c.copy(DIE_TOP);
        head.b.set(SCHED.x + 0.3, 1.0, SCHED.z);
        admitFlash = 1;
      }
    }
    // Freed rows fade out.
    for (let s = 0; s < SLOTS; s++) {
      if (rowFree[s]! >= 0 && now - rowFree[s]! > 0.55) {
        rowFree[s] = -1;
        rowUser[s] = -1;
        kind.fill(0, s * COLS, (s + 1) * COLS);
      }
    }
    // Iterations.
    if (itKind === 0) {
      // Scheduler: prefill one newly admitted prompt (FIFO), but never twice in a row while other
      // requests are decoding (a per-step token budget, as real servers use); otherwise one decode
      // step for every running request.
      batch.length = 0;
      let first: Req | null = null;
      let decoding = false;
      for (const r of reqs) {
        if (r.st === 'wait' && (!first || r.seq < first.seq)) first = r;
        if (r.st === 'run') decoding = true;
      }
      if (first && (!lastPrefill || !decoding)) {
        batch.push(first);
        itKind = 1;
        itDur = PREFILL_T;
        prefillFilled = false;
        lastPrefill = true;
      } else if (decoding) {
        for (const r of reqs) if (r.st === 'run') batch.push(r);
        itKind = 2;
        itDur = decodeT;
        lastPrefill = false;
      }
      itT = 0;
    } else {
      itT += dt;
      if (itKind === 1 && !prefillFilled && itT > itDur * 0.35) {
        prefillFilled = true;
        for (const r of batch) {
          for (let c = 0; c < r.prompt; c++) {
            kind[r.slot * COLS + c] = 1;
            born[r.slot * COLS + c] = now + c * 0.03;
          }
        }
      }
      if (itT >= itDur) {
        for (const r of batch) {
          if (itKind === 1) {
            r.gen = 1;
            r.st = 'run';
            emitToken(r);
          } else {
            const col = r.prompt + r.gen - 1;
            if (col < COLS) {
              kind[r.slot * COLS + col] = 2;
              born[r.slot * COLS + col] = now;
            }
            r.gen++;
            emitToken(r);
          }
          if (r.gen >= r.out) {
            rowFree[r.slot] = now;
            r.st = 'off';
            r.slot = -1;
            cool[r.user] = 0.25 + rng() * 0.8;
          }
        }
        itKind = 0;
      }
    }
    // Gauges (示意): prefill is compute-bound, decode is bandwidth-bound.
    let running = 0;
    for (const r of reqs) if (r.st === 'run' || r.st === 'wait') running++;
    const tc = itKind === 1 ? 0.93 : itKind === 2 ? 0.14 + 0.1 * running : 0.04;
    const tb = itKind === 1 ? 0.42 : itKind === 2 ? 0.9 : 0.04;
    gCompute = approach(gCompute, tc, dt, 7);
    gBand = approach(gBand, tb, dt, 7);
    // Tokens.
    for (const tk of toks) {
      if (!tk.on) continue;
      tk.t += dt / TOKEN_T;
      if (tk.t >= 1) {
        tk.on = false;
        flash[tk.user] = 1;
        continue;
      }
      bezier(DIE_TOP, tk.b, tk.c, tk.t, tk.pos);
    }
    for (let j = 0; j < USERS; j++) flash[j] = Math.max(0, flash[j]! - dt * 2.2);
    admitFlash = Math.max(0, admitFlash - dt * 1.8);
  };

  /**
   * Advance the simulation (fixed steps) until a busy decode sweep is half way (≥ 3 requests in the
   * batch with some output already cached, a token in flight): a good, deterministic still frame.
   */
  const settle = (minT: number) => {
    let t = 0;
    while (t < 40) {
      sim(1 / 30);
      t += 1 / 30;
      if (t <= minT || itKind !== 2 || itT < itDur * 0.5 || !toks.some((x) => x.on && x.t > 0.3)) continue;
      // A busy batch whose KV rows already differ in length (the cache visibly grows per token).
      let busy = 0;
      let lo = COLS;
      let hi = 0;
      for (const r of reqs) {
        if (r.st !== 'run') continue;
        busy++;
        lo = Math.min(lo, r.gen);
        hi = Math.max(hi, r.gen);
      }
      if ((busy >= 3 && hi >= 4 && hi - lo >= 2) || t > 30) break;
    }
  };

  /* ───────── palette ───────── */
  const cUser: Color[] = Array.from({ length: USERS }, () => new Color());
  const cUserSoft: Color[] = Array.from({ length: USERS }, () => new Color());
  const cEmpty = new Color();
  const cSlot = new Color(); // an empty KV cell (quieter than cEmpty on the light theme)
  const cRead = new Color(); // HBM read traffic (same colour as the HBM → compute flow)
  const cHi = new Color();
  const cBody = new Color();
  const cCompute = new Color();
  const cBand = new Color();
  const cDie = new Color();
  const cW = new Color();
  const tmp = new Color();
  let dark = ctx.theme === 'dark';
  const applyPalette = (p: Palette) => {
    dark = p.theme === 'dark';
    cUser.forEach((c, j) => c.copy(p.chart[j % p.chart.length]!));
    cUserSoft.forEach((c, j) => c.copy(cUser[j]!).lerp(p.bg, dark ? 0.58 : 0.6));
    idle(p, cEmpty);
    if (!dark) cEmpty.lerp(p.bg, 0.35);
    cSlot.copy(cEmpty);
    if (!dark) cSlot.lerp(p.bg, 0.4);
    cRead.copy(p.flow);
    cHi.copy(p.highlight);
    cBody.copy(p.fg).lerp(p.bg, dark ? 0.35 : 0.6);
    cCompute.copy(p.seg['ai-accelerators']);
    cBand.copy(p.seg['memory-storage']);
    cDie.copy(p.seg['ai-accelerators']);
    cW.copy(p.seg['foundation-models']);
    floor.applyPalette(p);
    memFlow.recolor(() => p.flow);
    memFlow.setTheme(p.theme);
    memFlow.setSize(dark ? 0.07 : 0.055);
    glows.setTheme(p.theme);
    for (let j = 0; j < USERS; j++) {
      bodies.setColorAt(j, cUser[j]!);
      heads.setColorAt(j, cBody);
      bases.setColorAt(j, cUserSoft[j]!);
    }
    for (const m of [bodies, heads, bases]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    fills.setColorAt(0, cCompute);
    fills.setColorAt(1, cBand);
    if (fills.instanceColor) fills.instanceColor.needsUpdate = true;
  };
  applyPalette(ctx.palette);

  /* ───────── drawing ───────── */
  const draw = () => {
    // Packets.
    let n = 0;
    for (const r of reqs) {
      if (r.st !== 'travel' && r.st !== 'queue' && r.st !== 'admit') continue;
      const s = r.st === 'admit' ? 1 - smooth(0.75, 1, r.t) * 0.7 : 1;
      packets.setMatrixAt(n, m4.compose(r.pos, q.identity(), sc.setScalar(s)));
      packets.setColorAt(n, cUser[r.user]!);
      n++;
    }
    packets.count = n;
    packets.instanceMatrix.needsUpdate = true;
    if (packets.instanceColor) packets.instanceColor.needsUpdate = true;
    // Tokens.
    n = 0;
    for (const tk of toks) {
      if (!tk.on) continue;
      const s = 0.6 + 0.4 * smooth(0, 0.15, tk.t);
      tokens.setMatrixAt(n, m4.compose(tk.pos, q.identity(), sc.setScalar(s)));
      tokens.setColorAt(n, cUser[tk.user]!);
      n++;
    }
    tokens.count = n;
    tokens.instanceMatrix.needsUpdate = true;
    if (tokens.instanceColor) tokens.instanceColor.needsUpdate = true;

    // KV cells: colour by kind, pop-in, decode read sweep, freeing fade.
    const sweep = itKind === 2 ? (itT / itDur) * (COLS + 3) - 2 : -99;
    const pre = itKind === 1 ? Math.sin(Math.PI * Math.min(1, itT / itDur)) : 0;
    let preRows = 0; // bit mask of the rows being prefilled (only their prompt cells light up)
    if (itKind === 1) for (const r of batch) if (r.slot >= 0) preRows |= 1 << r.slot;
    for (let s = 0; s < SLOTS; s++) {
      const u = rowUser[s]!;
      const fade = rowFree[s]! >= 0 ? smooth(0, 0.5, now - rowFree[s]!) : 0;
      for (let c = 0; c < COLS; c++) {
        const i = s * COLS + c;
        const k = kind[i]!;
        // Empty slots are smaller and flatter, so the cached tokens stand out on both themes.
        let scale = EMPTY_S;
        let depth = EMPTY_D;
        if (k === 0 || u < 0) tmp.copy(cSlot);
        else {
          tmp.copy(k === 1 ? cUserSoft[u]! : cUser[u]!);
          const age = now - born[i]!;
          const grow = age < 0 ? 0 : smooth(0, 0.22, age);
          // Decode reads every cached Key/Value: the sweep pops the cell forward in the read colour
          // (the colour of the HBM → compute traffic), never in a user's colour.
          const read = Math.exp(-((c - sweep) ** 2) / 1.6);
          scale = EMPTY_S + (1 - EMPTY_S) * grow;
          depth = EMPTY_D + (1 - EMPTY_D) * grow + 0.9 * read;
          tmp.lerp(cRead, 0.5 * read + (k === 1 && preRows & (1 << s) ? 0.3 * pre : 0));
          if (fade > 0) {
            tmp.lerp(cSlot, fade);
            scale += (EMPTY_S - scale) * fade;
            depth += (EMPTY_D - depth) * fade;
          }
        }
        if (hot.kv > 0) tmp.lerp(cHi, 0.12 * hot.kv);
        cells.setColorAt(i, tmp);
        v.set(cellX(c), ROW_Y[s]!, PANEL.z);
        cells.setMatrixAt(i, m4.compose(v, q.identity(), sc.set(scale, scale, depth)));
      }
      // Row marker (which user occupies the slot).
      const mi = SLOTS * COLS + s;
      cells.setColorAt(mi, u >= 0 ? tmp.copy(cUser[u]!).lerp(cEmpty, fade) : cEmpty);
      v.set(MARK_X, ROW_Y[s]!, PANEL.z);
      cells.setMatrixAt(mi, m4.compose(v, q.identity(), sc.set(0.6, 0.45, 1)));
    }
    cells.instanceMatrix.needsUpdate = true;
    if (cells.instanceColor) cells.instanceColor.needsUpdate = true;

    // Weights: read every iteration.
    const wRead = itKind === 2 ? Math.exp(-((sweep + 1.5) ** 2) / 2.5) : itKind === 1 ? pre * 0.6 : 0;
    wMat.emissive.copy(cW).multiplyScalar((dark ? 0.15 : 0.03) + wRead * (dark ? 0.6 : 0.35) + 0.15 * hot.gpu);
    // Die: compute load.
    dieMat.emissive.copy(cDie).multiplyScalar((dark ? 0.2 : 0.04) + gCompute * (dark ? 0.9 : 0.4) + 0.2 * hot.gpu);
    glows.set(0, DIE_TOP, 1.9 + 0.8 * gCompute, cDie, (0.15 + 0.65 * gCompute) * (dark ? 0.9 : 0.55));
    for (let j = 0; j < USERS; j++) glows.set(1 + j, userHead(j, v), 0.9, cUser[j]!, flash[j]! * (dark ? 0.9 : 0.6));

    // Scheduler lamp flashes when it admits a request into the batch.
    lampMat.color.copy(cEmpty).lerp(cHi, 0.35 + 0.65 * admitFlash + 0.3 * hot.req);
    // Gauges.
    for (let i = 0; i < 2; i++) {
      const h = Math.max(0.02, (i === 0 ? gCompute : gBand) * GAUGE_H);
      v.set(GAUGE_X[i]!, 0.03 + h / 2, GAUGE_Z);
      fills.setMatrixAt(i, m4.compose(v, q.identity(), sc.set(1, h, 1)));
    }
    fills.instanceMatrix.needsUpdate = true;
    frameMat.opacity = (dark ? 0.2 : 0.14) + 0.1 * hot.gauge;
    memFlow.setOpacity(0.25 + 0.75 * gBand);
    laneMat.opacity = (dark ? 0.1 : 0.08) + 0.08 * hot.req;
    panelMat.opacity = (dark ? 0.07 : 0.06) + 0.06 * hot.kv;

    // Text (a request holds its batch slot from admission until it finishes).
    let running = 0;
    for (const r of reqs) if (r.slot >= 0) running++;
    phaseLabel.set({
      text:
        itKind === 1
          ? 'Prefill：一次平行處理整段提示詞（運算受限）'
          : itKind === 2
            ? 'Decode：每步替每個請求產生 1 個 token（頻寬受限）'
            : '排程器：等待新的請求',
    });
    subLabel.set({ text: `批次中 ${running}／${SLOTS} 個請求，佇列 ${queue.length} 個` });
    if (step === 5) for (let s = 0; s < SLOTS; s++) rowLabels[s]!.set({ text: rowText(s) });
  };

  /* ───────── hotspots ───────── */
  const W = (p: V3): V3 => [origin.x + p[0], origin.y + p[1], origin.z + p[2]];
  const hotTween = (key: keyof typeof hot) => (on: boolean) => {
    ctx.tween.to(hot, { [key]: on ? 1 : 0 } as Partial<Record<keyof typeof hot, number>>, { duration: 220, fade: true });
  };
  env.register('request-batching', {
    object: reqGroup,
    anchor: W([-0.8, 0.6, 1.4]),
    pose: poseAt(origin, [-0.6, 3.2, 6.4], [-0.6, 0.4, 1.5]),
    onHighlight: hotTween('req'),
    card: (hit) => {
      if (hit?.instanceId === undefined || (hit.object !== bodies && hit.object !== heads && hit.object !== bases)) return null;
      const r = reqs[hit.instanceId]!;
      const where: Record<RState, string> = {
        off: '正在閱讀上一個回答，稍後會再提問。',
        travel: '剛送出提示詞，正前往佇列。',
        queue: '請求在佇列中等待空出的批次位置。',
        admit: '排程器剛把請求送進 GPU。',
        wait: '請求已進入 GPU，等待 Prefill。',
        run: `正在 Decode，已收到 ${r.gen}／${r.out} 個 token（示意）。`,
      };
      return { title: `使用者 ${hit.instanceId + 1}`, body: where[r.st] };
    },
  });
  env.register('serving-gpu', {
    object: gpuGroup,
    anchor: W([0, 0.4, GPU_Z]),
    pose: poseAt(origin, [1.4, 2.6, 3.4], [0, 0.3, -0.3]),
    onHighlight: hotTween('gpu'),
  });
  env.register('prefill-decode', {
    object: gaugeGroup,
    anchor: W([2.0, 1.0, GAUGE_Z]),
    pose: poseAt(origin, [2.6, 2.6, 4.6], [1.2, 0.6, 0.2]),
    onHighlight: hotTween('gauge'),
  });
  env.register('kv-cache', {
    object: kvGroup,
    anchor: W([1.2, 1.6, PANEL.z]),
    pose: poseAt(origin, [0.4, 2.9, 3.2], [0.1, 1.45, PANEL.z]),
    onHighlight: hotTween('kv'),
    card: (hit) => {
      if (hit?.object !== cells || hit.instanceId === undefined) return null;
      const s = hit.instanceId < SLOTS * COLS ? Math.floor(hit.instanceId / COLS) : hit.instanceId - SLOTS * COLS;
      const r = inSlot(s);
      if (!r) return { title: `批次位置 ${s + 1}：${rowText(s)}`, body: '這一列目前沒有正在產生 token 的請求。請求完成後 KV Cache 會被釋放，空出的位置立刻交給佇列中的下一個請求。' };
      const kv = r.st === 'run' ? r.prompt + r.gen - 1 : 0;
      return {
        title: `批次位置 ${s + 1}：使用者 ${r.user + 1} 的請求`,
        body: `提示詞 ${r.prompt} 個 token、已輸出 ${r.gen} 個；KV Cache 目前存了 ${kv} 個 token 的 Key 與 Value（示意）。`,
      };
    },
  });

  /* ───────── zone API ───────── */
  const POSES: Record<number, CameraPose> = {
    4: poseAt(origin, [1.3, 5.3, 8.3], [0.3, 0.75, 0.75]),
    5: poseAt(origin, [0.55, 3.55, 5.75], [0.25, 1.05, -0.85]),
  };
  // Portrait (4:5) poses: the narrow frame needs the whole row of users / the whole KV panel.
  const PORT: Record<number, CameraPose> = {
    4: poseAt(origin, [0.5, 7.2, 9.7], [0.15, 0.7, 0.85]),
    5: poseAt(origin, [0.5, 5.0, 10.0], [0.3, 0.5, -0.6]),
  };
  const setStatic = (on: boolean) => {
    isStatic = on;
    memFlow.setReduced(on);
  };
  // Pre-warm so the first frame (and posters) already shows a busy, deterministic state.
  settle(12);
  setStatic(!ctx.animate);

  return {
    id: 'inference',
    group,
    start(s) {
      step = s;
      decodeT = s === 4 ? 0.85 : 0.6;
      labels.sync(group.visible, s);
      if (isStatic) settle(0);
      draw();
    },
    update(dt) {
      if (dt > 0 && !isStatic) {
        sim(Math.min(dt, 0.1));
        memFlow.update(now);
      }
      draw();
    },
    setMotion(animate) {
      setStatic(!animate);
      if (!animate) settle(0);
      draw();
    },
    setVisible(on) {
      group.visible = on;
      labels.sync(on, step);
    },
    onPalette(p) {
      applyPalette(p);
      draw();
    },
    onQuality(tier: QualityTier) {
      memFlow.setCount(scaleCount(MEM_MAX, tier, 30));
    },
    pose: (s) => (portrait && PORT[s] ? env.unfit(PORT[s]) : (POSES[s] ?? null)),
    onResize(pt) {
      if (pt !== portrait) {
        portrait = pt;
        labels.sync();
      }
      // Portrait stages: pull the user row together so the diorama fits a 4:5 frame.
      const k = pt ? 0.6 : 1;
      if (USER_X[0] === USER_X0[0]! * k) return;
      USER_X0.forEach((x, j) => (USER_X[j] = x * k));
      placeUsers();
      userLabel.set({ position: pt ? [USER_X[0]!, 0.75, USER_Z] : [USER_X[0]! - 0.3, 0.35, USER_Z], align: pt ? 'above' : 'left' });
      tokLabel.set({ position: pt ? [USER_X[USERS - 1]!, 0, USER_Z + 0.25] : [USER_X[USERS - 1]! + 0.4, 0.4, USER_Z], align: pt ? 'below' : 'right', text: pt ? 'token 串流' : 'token 逐一串流回使用者' });
      draw();
    },
  };
}

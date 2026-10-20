/**
 * network / scale-up — an NVLink domain inside one rack, drawn as an exploded tray stack.
 *
 * Top and bottom: compute trays (GPUs with HBM, CPUs, one scale-out NIC per GPU at the front).
 * Middle: NVLink switch trays (two switch chips each), as in rack-scale NVLink systems. Behind the
 * trays, the copper spine: every GPU has one cable to EVERY switch chip, so any two GPUs are one
 * switch hop apart. Dense packet streams (PathFlow) run GPU → switch chip → GPU; sparse streams
 * leave through the NICs over fibre to a scale-out switch and on to the next rack, drawn ghosted
 * (glass + outlines): another NVLink domain, reachable only over the scale-out network.
 *
 * Steps: 總覽 / NVLink 網域 (closer, bandwidth contrast) / 全互連 (one GPU's six links lit, a
 * fan-out from that GPU through every switch chip to every other GPU, seen from the side so the
 * spine reads; the rack posts and top cap fade out of the way).
 * Reduced motion: static dotted streams; the 全互連 links stay highlighted.
 */
import { BoxGeometry, CatmullRomCurve3, Color, Group, Mesh, MeshStandardMaterial, TubeGeometry, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneContext } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { addFloor, commit, freeze, hotspotCard, instanced, orbitPose, placeAt, Polylines, rounded, stepIdOf, v3, type Built } from './common';

/* ───────────────────────── layout ───────────────────────── */

const TW = 2.5; // tray width (x)
const TD = 1.5; // tray depth (z)
const TT = 0.05; // tray thickness
const GAP = 0.42;
const KINDS = ['c', 'c', 'c', 's', 's', 's', 'c', 'c', 'c'] as const; // top → bottom
const Y0 = 0.42;
const trayY = (t: number) => Y0 + (KINDS.length - 1 - t) * GAP;
const TRAY_TOP = TT / 2;
const COMPUTE = [0, 1, 2, 6, 7, 8];
const SWITCH = [3, 4, 5];
const GPU_X = [-0.84, -0.28, 0.28, 0.84];
const GPU_Z = 0.14;
const CPU_X = [-0.56, 0.56];
const CPU_Z = -0.4;
const NIC_Z = 0.55;
const SW_X = [-0.58, 0.58];
const SW_Z = -0.06;
const BACK_Z = -TD / 2;
const SPINE_Z = -TD / 2 - 0.2;
const TOP = trayY(0) + 0.3;
const RACK_X = TW / 2 + 0.12;
const RACK_Z0 = SPINE_Z - 0.2;
const RACK_Z1 = TD / 2 + 0.16;
const NG = COMPUTE.length * GPU_X.length; // 24 GPUs (示意)
const NS = SWITCH.length * SW_X.length; // 6 switch chips (示意)
const SO = v3(-RACK_X - 1.3, trayY(4), 0.15); // scale-out switch, left of the rack at mid height
const SO_W = 0.95;
const EXIT_N = 4; // fibres leaving the switch towards the next rack
const EXIT_PARTS = 6; // each drawn as pieces with falling alpha (fades towards the next rack)
const FAN_GPU = 3; // compute tray 0, rightmost GPU: the「這顆 GPU」of step 全互連
/** The next rack (another NVLink domain), ghosted: same footprint as ours, further left. */
const GH = { x: -6.5, z: (RACK_Z0 + RACK_Z1) / 2, w: 2 * RACK_X + 0.12, d: RACK_Z1 - RACK_Z0 + 0.12, h: TOP + 0.1 };
const GH_TRAYS = [0, 2, 6, 8]; // compute trays of the next rack that the exit fibres reach

const gpuPos = (g: number) => {
  const ci = Math.floor(g / 4);
  const col = g % 4;
  return v3(GPU_X[col]!, trayY(COMPUTE[ci]!) + TRAY_TOP + 0.03, GPU_Z);
};
const swPos = (k: number) => v3(SW_X[k % 2]!, trayY(SWITCH[Math.floor(k / 2)]!) + TRAY_TOP + 0.04, SW_Z);

/** Chip body colour: the segment hue, lifted a little on the light theme so lit chips don't go muddy. */
const chipColor = (seg: 'ai-accelerators' | 'networking-optics') => (p: Palette) =>
  p.theme === 'dark' ? p.seg[seg].clone() : p.seg[seg].clone().lerp(p.bg, 0.18);

/** Cable from GPU g to switch chip k: tray trace → rear connector → spine run → switch tray → chip. */
function cable(g: number, k: number): Vector3[] {
  const ci = Math.floor(g / 4);
  const col = g % 4;
  const yC = trayY(COMPUTE[ci]!) + TRAY_TOP + 0.012;
  const yS = trayY(SWITCH[Math.floor(k / 2)]!) + TRAY_TOP + 0.012;
  const xCol = GPU_X[col]! + (k - 2.5) * 0.042;
  const zRun = SPINE_Z - 0.035 * (ci % 3);
  const sw = SW_X[k % 2]!;
  return rounded(
    [
      v3(GPU_X[col]! + (k - 2.5) * 0.03, yC, GPU_Z - 0.17),
      v3(xCol, yC, BACK_Z + 0.08),
      v3(xCol, yC, zRun),
      v3(xCol, yS, zRun),
      v3(xCol, yS, BACK_Z + 0.08),
      v3(sw + (xCol - sw) * 0.3, yS, SW_Z - 0.26),
    ],
    0.07,
    4,
  );
}

/** Packet route GPU a → switch k → GPU b (one switch hop). */
function route(a: number, k: number, b: number): Vector3[] {
  const s = swPos(k);
  const there = cable(a, k);
  const back = cable(b, k).reverse();
  return [...there, v3(s.x, s.y + 0.03, s.z), ...back];
}

/** Scale-out route: GPU → NIC → front port → along the tray front → down/up the rack's left corner → switch. */
function nicRoute(g: number): Vector3[] {
  const ci = Math.floor(g / 4);
  const col = g % 4;
  const y = trayY(COMPUTE[ci]!) + TRAY_TOP + 0.03;
  const zf = TD / 2 + 0.1 + 0.035 * (3 - col);
  const sideX = -RACK_X - 0.14 - 0.035 * col;
  const ys = SO.y + (col - 1.5) * 0.035;
  return rounded(
    [
      v3(GPU_X[col]!, y + 0.01, GPU_Z + 0.16),
      v3(GPU_X[col]!, y, NIC_Z),
      v3(GPU_X[col]!, y, zf),
      v3(sideX, y, zf),
      v3(sideX, ys, zf),
      v3(SO.x + SO_W / 2 + 0.25, ys, SO.z + 0.12),
      v3(SO.x + SO_W / 2 - 0.05, ys, SO.z + 0.06),
    ],
    0.12,
    4,
  );
}

/** Switch → a compute tray of the next rack, entering through its near side (+X face). */
function exitRoute(n: number): Vector3[] {
  const ys = SO.y + (n - 1.5) * 0.035;
  const x0 = SO.x - SO_W / 2;
  const z = SO.z + (n - 1.5) * 0.06;
  const ty = trayY(GH_TRAYS[n]!) + 0.03;
  const xr = GH.x + GH.w / 2;
  const ze = GH.z + GH.d / 2 - 0.3 - 0.08 * n;
  return rounded(
    [v3(x0 + 0.05, ys, z), v3(x0 - 0.3, ys, z + 0.05), v3(xr + 0.55, ty + (ys - ty) * 0.35, ze + 0.25), v3(xr + 0.12, ty, ze), v3(xr - 0.25, ty, ze)],
    0.3,
    6,
  );
}

/** Split a polyline into `n` consecutive pieces (to fade it out piece by piece). */
function pieces(pts: readonly Vector3[], n: number): Vector3[][] {
  const out: Vector3[][] = [];
  const per = (pts.length - 1) / n;
  for (let i = 0; i < n; i++) {
    const a = Math.round(i * per);
    const b = Math.round((i + 1) * per);
    out.push(pts.slice(a, b + 1).map((q) => q.clone()));
  }
  return out;
}

const POSES: Record<string, CameraPose> = {
  'nvlink-domain': orbitPose([-0.55, 2.05, -0.15], 9.9, 38, 13),
  'all-to-all': orbitPose([0.1, 2.15, -0.45], 8.8, 108, 20),
  gpu: orbitPose([0.4, 3.3, 0.1], 5.0, 40, 24),
  'nvlink-switch': orbitPose([0, 2.05, -0.1], 5.4, 48, 20),
  'copper-spine': orbitPose([0, 2.05, -0.8], 7.6, 128, 14),
  nic: orbitPose([-1.4, 2.6, 0.4], 6.6, 22, 14),
};

/* ───────────────────────── builder ───────────────────────── */

export function build(ctx: SceneContext): Built {
  const { materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'network-scale-up';
  ctx.scene.add(root);
  const lights = addStudioLights(ctx.scene, ctx.palette);
  const floor = addFloor(ctx, root, { w: 17, d: 10, step: 0.5, y: 0, cx: -1.4, glow: [9, 6] });
  const dk = (p: Palette) => p.theme === 'dark';

  /* ───────── rack frame ───────── */
  const metal = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.2 : 0.28), { metalness: 0.35, roughness: 0.45 });
  const postMat = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.2 : 0.28), { metalness: 0.35, roughness: 0.45, transparent: true });
  const postGeo = ctx.track(new BoxGeometry(0.06, TOP, 0.06));
  // Cutaway: the post nearest the camera (front-right) is left out so the trays stay visible.
  const posts = instanced(ctx, postGeo, postMat, 3);
  [
    [-RACK_X, RACK_Z0],
    [RACK_X, RACK_Z0],
    [-RACK_X, RACK_Z1],
  ].forEach(([x, z], i) => placeAt(posts, i, v3(x!, TOP / 2 + 0.04, z!)));
  commit(posts);
  const capGeo = ctx.track(new RoundedBoxGeometry(2 * RACK_X + 0.12, 0.06, RACK_Z1 - RACK_Z0 + 0.12, 2, 0.025));
  const floorCap = new Mesh(capGeo, metal);
  floorCap.position.set(0, 0.04, (RACK_Z0 + RACK_Z1) / 2);
  // The top cap fades out in step 全互連: from that camera it would hide「這顆 GPU」on the top tray.
  const topCap = new Mesh(capGeo, postMat);
  topCap.position.set(0, TOP + 0.04, (RACK_Z0 + RACK_Z1) / 2);
  root.add(posts, floorCap, topCap);

  /* ───────── trays (solid boards; compute and switch tinted by segment) ───────── */
  const plateGeo = ctx.track(new RoundedBoxGeometry(TW, TT, TD, 2, 0.02));
  const board = (seg: 'servers-systems' | 'networking-optics', k: number) =>
    materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.1 : 0.07).lerp(p.seg[seg], dk(p) ? k : k * 0.7), { metalness: 0.15, roughness: 0.65 });
  const cPlates = instanced(ctx, plateGeo, board('servers-systems', 0.2), COMPUTE.length);
  COMPUTE.forEach((t, i) => placeAt(cPlates, i, v3(0, trayY(t), 0)));
  commit(cPlates);
  const sPlates = instanced(ctx, plateGeo, board('networking-optics', 0.3), SWITCH.length);
  SWITCH.forEach((t, i) => placeAt(sPlates, i, v3(0, trayY(t), 0)));
  commit(sPlates);
  root.add(cPlates, sPlates);

  // Tray top outlines (one draw call), tinted by tray kind.
  const outlines = new Polylines(
    ctx,
    KINDS.map((_, t) => {
      const y = trayY(t) + TRAY_TOP + 0.002;
      const x = TW / 2 - 0.01;
      const z = TD / 2 - 0.01;
      return [v3(-x, y, -z), v3(x, y, -z), v3(x, y, z), v3(-x, y, z), v3(-x, y, -z)];
    }),
  );
  outlines.object.renderOrder = 3;
  root.add(outlines.object);

  // Rear cable connectors (one per GPU column and tray) and front port cages (one per NIC).
  const connMat = materials.standard((p) => p.power.clone().lerp(p.bg, dk(p) ? 0.3 : 0.15), { metalness: 0.6, roughness: 0.35 });
  const conns = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.3, 0.05, 0.06, 1, 0.012)), connMat, KINDS.length * GPU_X.length);
  KINDS.forEach((_, t) => GPU_X.forEach((x, c) => placeAt(conns, t * 4 + c, v3(x, trayY(t) + TRAY_TOP + 0.025, BACK_Z + 0.05))));
  commit(conns);
  const cageMat = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.08 : 0.55), { metalness: 0.3, roughness: 0.5 });
  const cages = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.16, 0.05, 0.07, 1, 0.01)), cageMat, NG);
  for (let g = 0; g < NG; g++) {
    const p = gpuPos(g);
    placeAt(cages, g, v3(p.x, trayY(COMPUTE[Math.floor(g / 4)]!) + TRAY_TOP + 0.025, TD / 2 - 0.05));
  }
  commit(cages);
  root.add(conns, cages);

  /* ───────── chips ───────── */
  const gpuMat = materials.standard(chipColor('ai-accelerators'), { metalness: 0.25, roughness: 0.42 });
  materials.bind(gpuMat, 'emissive', 'seg:ai-accelerators', (c, p) => c.multiplyScalar(dk(p) ? 0.3 : 0.05));
  const gpuGeo = ctx.track(new RoundedBoxGeometry(0.42, 0.05, 0.38, 2, 0.016));
  const gpus = instanced(ctx, gpuGeo, gpuMat, NG, true);
  const dieMat = materials.standard((p) => p.seg['ai-accelerators'].clone().lerp(p.fg, dk(p) ? 0.55 : 0.35), { metalness: 0.65, roughness: 0.22 });
  const dies = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.2, 0.03, 0.2, 1, 0.008)), dieMat, NG);
  const hbmMat = materials.standard((p) => p.muted.clone().lerp(p.fg, dk(p) ? 0.35 : 0.2), { metalness: 0.6, roughness: 0.3 });
  const hbm = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.06, 0.04, 0.09, 1, 0.008)), hbmMat, NG * 4);
  for (let g = 0; g < NG; g++) {
    const p = gpuPos(g);
    placeAt(gpus, g, p);
    placeAt(dies, g, v3(p.x, p.y + 0.035, p.z));
    [-1, 1].forEach((sx, a) => [-1, 1].forEach((sz, b) => placeAt(hbm, g * 4 + a * 2 + b, v3(p.x + sx * 0.145, p.y + 0.04, p.z + sz * 0.07))));
  }
  commit(gpus);
  commit(dies);
  commit(hbm);

  const cpus = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.28, 0.045, 0.24, 1, 0.012)), materials.standard('muted', { metalness: 0.45, roughness: 0.4 }), COMPUTE.length * 2);
  COMPUTE.forEach((t, ci) => CPU_X.forEach((x, j) => placeAt(cpus, ci * 2 + j, v3(x, trayY(t) + TRAY_TOP + 0.025, CPU_Z))));
  commit(cpus);

  const nicMat = materials.standard((p) => p.seg['networking-optics'].clone().lerp(p.fg, dk(p) ? 0.3 : 0.15), { metalness: 0.4, roughness: 0.4 });
  const nics = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.2, 0.04, 0.14, 1, 0.012)), nicMat, NG);
  for (let g = 0; g < NG; g++) {
    const p = gpuPos(g);
    placeAt(nics, g, v3(p.x, trayY(COMPUTE[Math.floor(g / 4)]!) + TRAY_TOP + 0.02, NIC_Z - 0.08));
  }
  commit(nics);

  const swMat = materials.standard(chipColor('networking-optics'), { metalness: 0.3, roughness: 0.38 });
  materials.bind(swMat, 'emissive', 'seg:networking-optics', (c, p) => c.multiplyScalar(dk(p) ? 0.35 : 0.06));
  const sws = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.56, 0.07, 0.5, 2, 0.02)), swMat, NS, true);
  const swDieMat = materials.standard((p) => p.seg['networking-optics'].clone().lerp(p.fg, dk(p) ? 0.55 : 0.35), { metalness: 0.65, roughness: 0.22 });
  const swDies = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.28, 0.03, 0.26, 1, 0.008)), swDieMat, NS);
  for (let k = 0; k < NS; k++) {
    const p = swPos(k);
    placeAt(sws, k, p);
    placeAt(swDies, k, v3(p.x, p.y + 0.045, p.z));
  }
  commit(sws);
  commit(swDies);
  root.add(gpus, dies, hbm, cpus, nics, sws, swDies);

  /* ───────── copper spine (every GPU ↔ every switch chip) ───────── */
  const cableIdx = (g: number, k: number) => g * NS + k;
  const cablePts: Vector3[][] = [];
  for (let g = 0; g < NG; g++) for (let k = 0; k < NS; k++) cablePts.push(cable(g, k));
  const cables = new Polylines(ctx, cablePts);
  cables.object.renderOrder = 4;
  root.add(cables.object);
  // 「這顆 GPU」's six links as thin tubes, so they read through the particles in step 全互連.
  const fanTubeGeo = ctx.track(
    mergeGeometries(Array.from({ length: NS }, (_, k) => new TubeGeometry(new CatmullRomCurve3(cable(FAN_GPU, k), false, 'centripetal'), 96, 0.014, 6, false))),
  );
  const fanTubeMat = materials.basic('highlight', { transparent: true, opacity: 0, depthWrite: false });
  const fanTubes = new Mesh(fanTubeGeo, fanTubeMat);
  fanTubes.renderOrder = 6;
  fanTubes.visible = false;
  root.add(fanTubes);
  const spineH = trayY(0) - trayY(KINDS.length - 1) + 0.3;
  const spineProxy = new Mesh(ctx.track(new BoxGeometry(TW, spineH, 0.3)), ctx.track(new MeshStandardMaterial({ visible: false })));
  spineProxy.position.set(0, (trayY(0) + trayY(KINDS.length - 1)) / 2, SPINE_Z - 0.035);
  root.add(spineProxy);

  /* ───────── scale-out exit: fibres, a switch, the next rack ───────── */
  const nicLines: Vector3[][] = [];
  const nicPaths: FlowPath[] = [];
  for (let g = 0; g < NG; g++) {
    const pts = nicRoute(g);
    nicLines.push(pts);
    nicPaths.push({ points: pts });
  }
  const exitPts = Array.from({ length: EXIT_N }, (_, n) => exitRoute(n));
  const fibres = new Polylines(ctx, [...nicLines, ...exitPts.flatMap((l) => pieces(l, EXIT_PARTS))]);
  fibres.object.renderOrder = 4;
  root.add(fibres.object);
  const soSwitch = new Mesh(ctx.track(new RoundedBoxGeometry(SO_W, 0.16, 0.5, 2, 0.03)), swMat);
  soSwitch.position.copy(SO);
  const soPanel = new Mesh(ctx.track(new BoxGeometry(SO_W * 0.8, 0.05, 0.02)), cageMat);
  soPanel.position.set(SO.x, SO.y, SO.z + 0.26);
  root.add(soSwitch, soPanel);

  /* ───────── domain boundary ───────── */
  const bx = RACK_X + 0.08;
  const bz0 = RACK_Z0 - 0.08;
  const bz1 = RACK_Z1 + 0.06;
  const by = TOP + 0.16;
  const boundary = new Polylines(ctx, [
    [v3(-bx, 0.01, bz1), v3(bx, 0.01, bz1), v3(bx, 0.01, bz0), v3(-bx, 0.01, bz0), v3(-bx, 0.01, bz1)],
    [v3(-bx, by, bz1), v3(bx, by, bz1), v3(bx, by, bz0), v3(-bx, by, bz0), v3(-bx, by, bz1)],
    [v3(-bx, 0.01, bz1), v3(-bx, by, bz1)],
    [v3(bx, 0.01, bz1), v3(bx, by, bz1)],
    [v3(bx, 0.01, bz0), v3(bx, by, bz0)],
    [v3(-bx, 0.01, bz0), v3(-bx, by, bz0)],
  ]);
  boundary.object.renderOrder = 5;
  root.add(boundary.object);

  /* ───────── the next rack: another NVLink domain, ghosted (glass + outlines) ───────── */
  const ghostMat = materials.glass('fg', 0.04, { roughness: 0.5 });
  const ghost = new Mesh(ctx.track(new BoxGeometry(GH.w, GH.h, GH.d)), ghostMat);
  ghost.position.set(GH.x, GH.h / 2, GH.z);
  ghost.renderOrder = 1;
  root.add(ghost);
  const gx0 = GH.x - GH.w / 2;
  const gx1 = GH.x + GH.w / 2;
  const gz0 = GH.z - GH.d / 2;
  const gz1 = GH.z + GH.d / 2;
  const ghostLines = new Polylines(ctx, [
    // Frame: base and top rectangles, four posts.
    ...[0.01, GH.h].map((y) => [v3(gx0, y, gz1), v3(gx1, y, gz1), v3(gx1, y, gz0), v3(gx0, y, gz0), v3(gx0, y, gz1)]),
    ...[
      [gx0, gz1],
      [gx1, gz1],
      [gx1, gz0],
      [gx0, gz0],
    ].map(([x, z]) => [v3(x!, 0.01, z!), v3(x!, GH.h, z!)]),
    // Its trays, seen on the front and the near side: the same compute / switch / compute stack.
    ...KINDS.map((_, t) => [v3(gx0 + 0.12, trayY(t), gz1 - 0.02), v3(gx1 - 0.02, trayY(t), gz1 - 0.02), v3(gx1 - 0.02, trayY(t), gz0 + 0.12)]),
  ]);
  ghostLines.object.renderOrder = 5;
  root.add(ghostLines.object);
  const GHOST_FRAME = 6; // the first six polylines are the frame, then one per tray

  /* ───────── packet flows ───────── */
  const flowRoutes: FlowPath[] = [];
  const rng = ctx.rng;
  for (let a = 0; a < NG; a++) {
    for (let n = 0; n < 2; n++) {
      let b = rng.int(NG);
      if (b === a) b = (b + 7) % NG;
      flowRoutes.push({ points: route(a, rng.int(NS), b) });
    }
  }
  const FLOW_MAX = 2200;
  const flowOpts = { smooth: false, samples: 128, sizeVariance: 0.25, speedVariance: 0.12, fadeEnds: 0.04, theme: ctx.theme };
  const flow = ctx.track(new PathFlow({ ...flowOpts, paths: flowRoutes, count: FLOW_MAX, size: 0.06, speed: 1.2, seed: 3 }));
  const FAN_MAX = 1100;
  const fanRoutes: FlowPath[] = [];
  const fanSplit: number[] = []; // control-point index of the switch chip on each fan route
  for (let b = 0; b < NG; b++) {
    if (b === FAN_GPU) continue;
    fanSplit.push(cable(FAN_GPU, b % NS).length);
    fanRoutes.push({ points: route(FAN_GPU, b % NS, b) });
  }
  /** Gold out of「這顆 GPU」up to the switch chip, flow colour from the switch chip to every other GPU. */
  const fanColors = (i: number, p: Palette): Color[] => {
    const n = fanRoutes[i]!.points.length;
    const split = fanSplit[i] ?? 0;
    return Array.from({ length: n }, (_, j) => (j <= split ? p.highlight : p.flow));
  };
  const fan = ctx.track(new PathFlow({ ...flowOpts, paths: fanRoutes, count: FAN_MAX, size: 0.065, speed: 1.05, seed: 5 }));
  const NIC_MAX = 170;
  const nicFlow = ctx.track(new PathFlow({ ...flowOpts, paths: nicPaths, count: NIC_MAX, size: 0.06, speed: 1.0, seed: 9 }));
  const EXIT_MAX = 64;
  const exitFlow = ctx.track(new PathFlow({ ...flowOpts, paths: exitPts.map((points) => ({ points })), count: EXIT_MAX, size: 0.06, speed: 1.0, fadeEnds: 0.08, seed: 11 }));
  root.add(flow.object, fan.object, nicFlow.object, exitFlow.object);

  const glows = ctx.track(new GlowSprites({ count: NG + NS + 1, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── labels ───────── */
  const lx = RACK_X + 0.12;
  labels.add({ text: 'NVLink 網域（示意）', position: [0.3, by + 0.06, (bz0 + bz1) / 2], kind: 'strong', priority: 40, always: true, align: 'above' });
  const trayLabels: LabelHandle[] = [
    labels.add({ text: '運算托盤', position: [lx, trayY(1), TD / 2], align: 'right', priority: 20 }),
    labels.add({ text: 'NVLink 交換托盤', position: [lx, trayY(4), TD / 2], align: 'right', priority: 24, hotspot: 'nvlink-switch' }),
    labels.add({ text: '運算托盤', position: [lx, trayY(7), TD / 2], align: 'right', priority: 20 }),
  ];
  const gpuLabel = labels.add({ text: 'GPU', position: gpuPos(2).add(v3(0, 0.06, 0.1)), align: 'above', offset: [0, -4], priority: 26, hotspot: 'gpu' });
  const swLabel = labels.add({ text: 'NVLink 交換晶片', position: swPos(3).add(v3(0.1, 0.06, 0.2)), align: 'above', offset: [0, -4], priority: 26, hotspot: 'nvlink-switch' });
  // At the rack's back-right corner, between the tray labels, so it clears the GPU label up top.
  const spineLabel = labels.add({ text: '銅纜背板', position: [TW / 2 - 0.05, trayY(6), SPINE_Z - 0.05], align: 'right', offset: [8, 0], priority: 22, hotspot: 'copper-spine' });
  const nicLabel = labels.add({ text: '網卡', position: [GPU_X[0]!, trayY(1) + 0.05, NIC_Z], align: 'below', offset: [0, 6], priority: 16, hotspot: 'nic' });
  const soLabel = labels.add({ text: 'Scale-out 交換器', position: [SO.x, SO.y + 0.12, SO.z], align: 'above', priority: 18, hotspot: 'nic' });
  const exitLabel = labels.add({ text: '其他機櫃（另一個 NVLink 網域）', position: [GH.x, GH.h + 0.05, GH.z], align: 'above', kind: 'muted', priority: 12 });
  // Beside the chip, towards the tray front (screen-left from that step's side camera), so it
  // never hides the GPU it names nor meets the domain title above the rack; never culled.
  const fanLabel = labels.add({ text: '這顆 GPU', position: gpuPos(FAN_GPU).add(v3(0, 0.06, 0.12)), align: 'left', offset: [-4, 0], kind: 'strong', priority: 34, always: true, visible: false });
  const note = labels.add({ text: '', position: [0, -0.05, RACK_Z1 + 0.5], align: 'below', kind: 'muted', priority: 30, always: true, visible: false });
  /** Where the step note sits: [landscape, portrait]. Portrait stages keep it under the rack. */
  const NOTE_AT: Record<string, [{ at: [number, number, number]; align: 'below' | 'right' }, { at: [number, number, number]; align: 'below' | 'right' }]> = {
    'nvlink-domain': [
      { at: [SO.x - 0.3, 0.02, RACK_Z1 + 0.7], align: 'below' },
      { at: [0, 0.02, RACK_Z1], align: 'below' },
    ],
    'all-to-all': [
      { at: [0.2, 0.45, SPINE_Z - 0.9], align: 'right' },
      // Under the rack's near (+X) bottom edge, clear of the trays seen from the side.
      { at: [RACK_X + 0.2, 0, (RACK_Z0 + RACK_Z1) / 2], align: 'below' },
    ],
  };
  /** Step notes: [full, short]; a label wider than the stage is hidden, so phones get the short one. */
  const NOTE_TEXT: Record<string, [string, string]> = {
    'nvlink-domain': ['光點越密＝頻寬越高：機櫃內 NVLink ≫ 網卡（示意）', '光點越密＝頻寬越高：NVLink ≫ 網卡'],
    'all-to-all': ['每顆 GPU 都有一條線連到每顆交換晶片：任兩顆 GPU 只隔一跳', '每顆 GPU 連到每顆交換晶片：只隔一跳'],
  };
  const placeNote = () => {
    // Small landscape stages (phones at 4:3) have no room beside the rack either.
    const n = NOTE_AT[sid]?.[ctx.size.aspect < 1 || ctx.size.width < 640 ? 1 : 0];
    const t = NOTE_TEXT[sid];
    if (n) note.set({ position: n.at, align: n.align });
    if (t) note.set({ text: t[ctx.size.width < 560 ? 1 : 0] });
  };
  labels.setMax(16);

  /* ───────── palette ───────── */
  const cCopper = new Color();
  const tmp = new Color();
  let fanK = 0; // 0..1 how far the「全互連」focus is applied
  let domK = 0; // 0..1 the「NVLink 網域」emphasis
  let hotSpine = 0;
  let hotNic = 0;

  const paintLines = () => {
    const p = ctx.palette;
    const dark = dk(p);
    cCopper.copy(p.power).lerp(p.bg, dark ? 0.15 : 0.05);
    const base = (dark ? 0.32 : 0.42) + 0.35 * hotSpine;
    for (let g = 0; g < NG; g++)
      for (let k = 0; k < NS; k++) {
        const mine = g === FAN_GPU;
        const a = mine ? base + (1 - base) * fanK : base * (1 - 0.7 * fanK);
        cables.set(cableIdx(g, k), mine ? tmp.copy(cCopper).lerp(p.highlight, fanK) : cCopper, a);
      }
    cables.commit();
    const fa = ((dark ? 0.38 : 0.5) + 0.4 * hotNic + 0.15 * domK) * (1 - 0.75 * fanK);
    for (let i = 0; i < fibres.count; i++) {
      const piece = i - NG;
      fibres.set(i, p.optic, piece < 0 ? fa : fa * (1 - 0.55 * (piece % EXIT_PARTS) / EXIT_PARTS));
    }
    fibres.commit();
    // The next rack: a faint frame, its trays tinted like ours; out of the way in step 全互連.
    const ga = (dark ? 0.42 : 0.5) * (1 - fanK);
    for (let i = 0; i < ghostLines.count; i++) {
      const t = i - GHOST_FRAME;
      const c = t < 0 ? p.muted : KINDS[t] === 's' ? p.seg['networking-optics'] : p.seg['servers-systems'];
      ghostLines.set(i, c, t < 0 ? ga : ga * 0.8);
    }
    ghostLines.commit();
    ghostMat.opacity = (dark ? 0.05 : 0.03) * (1 - fanK);
    KINDS.forEach((k, t) => outlines.set(t, k === 's' ? p.seg['networking-optics'] : p.seg['servers-systems'], dark ? 0.6 : 0.75));
    outlines.commit();
    for (let i = 0; i < boundary.count; i++) boundary.set(i, p.highlight, (dark ? 0.5 : 0.7) + 0.3 * domK);
    boundary.commit();
  };

  let gpuHot = 0;
  let swHot = 0;
  const paintGlows = () => {
    const p = ctx.palette;
    const dark = dk(p);
    for (let g = 0; g < NG; g++) {
      const focus = g === FAN_GPU ? fanK : 0;
      const a = (dark ? 0.26 : 0.1) * (1 - 0.6 * fanK) + 0.45 * gpuHot + 0.75 * focus;
      glows.set(g, gpuPos(g).add(v3(0, 0.05, 0)), 0.62 + 0.4 * focus, g === FAN_GPU && fanK > 0 ? p.highlight : p.seg['ai-accelerators'], a);
    }
    for (let k = 0; k < NS; k++) {
      const a = (dark ? 0.3 : 0.14) + 0.3 * fanK + 0.45 * swHot;
      glows.set(NG + k, swPos(k).add(v3(0, 0.06, 0)), 0.85 + 0.2 * fanK, p.seg['networking-optics'], a);
    }
    glows.set(NG + NS, SO, 1.3, p.seg['networking-optics'], ((dark ? 0.35 : 0.16) + 0.3 * hotNic) * (1 - fanK));
  };

  const applyPalette = (p: Palette) => {
    const dark = dk(p);
    lights.apply(p);
    floor.apply(p);
    flow.recolor(() => p.flow);
    fan.recolor((i) => fanColors(i, p));
    nicFlow.recolor(() => p.optic);
    exitFlow.recolor(() => p.optic);
    for (const f of [flow, fan, nicFlow, exitFlow]) f.setTheme(p.theme);
    // NVLink packets a little larger than the NIC packets: denser AND bolder reads as more bandwidth.
    flow.setSize(dark ? 0.062 : 0.056);
    fan.setSize(dark ? 0.066 : 0.058);
    nicFlow.setSize(dark ? 0.054 : 0.046);
    exitFlow.setSize(dark ? 0.054 : 0.046);
    glows.setTheme(p.theme);
    paintLines();
    paintGlows();
    gpuLabel.set({ swatch: p.css['seg-ai-accelerators'] ?? '' });
    swLabel.set({ swatch: p.css['seg-networking-optics'] ?? '' });
    trayLabels[0]!.set({ swatch: p.css['seg-servers-systems'] ?? '' });
    trayLabels[1]!.set({ swatch: p.css['seg-networking-optics'] ?? '' });
    trayLabels[2]!.set({ swatch: p.css['seg-servers-systems'] ?? '' });
    spineLabel.set({ swatch: p.css['scene-power'] ?? '' });
    nicLabel.set({ swatch: p.css['scene-optic'] ?? '' });
    soLabel.set({ swatch: p.css['seg-networking-optics'] ?? '' });
  };
  applyPalette(ctx.palette);

  const setCounts = () => {
    flow.setCount(scaleCount(FLOW_MAX, ctx.tier, 300));
    fan.setCount(scaleCount(FAN_MAX, ctx.tier, 200));
    nicFlow.setCount(scaleCount(NIC_MAX, ctx.tier, 48));
    exitFlow.setCount(scaleCount(EXIT_MAX, ctx.tier, 16));
  };
  setCounts();
  const setReduced = (r: boolean) => {
    for (const f of [flow, fan, nicFlow, exitFlow]) f.setReduced(r);
  };
  setReduced(!ctx.animate);

  /* ───────── hotspots ───────── */
  const glowTween = (set: (v: number) => void, from: number, to: number) =>
    ctx.tween.run(
      (k) => {
        set(from + (to - from) * k);
        paintGlows();
        paintLines();
      },
      { duration: 220, fade: true },
    );
  hotspots.register('gpu', {
    object: gpus,
    anchor: gpuPos(2).add(v3(0, 0.1, 0)),
    pose: POSES['gpu']!,
    card: (hit) => {
      const g = hit?.instanceId;
      if (g === undefined) return hotspotCard(ctx, 'gpu');
      return hotspotCard(ctx, 'gpu', { subtitle: `第 ${Math.floor(g / 4) + 1} 個運算托盤・第 ${(g % 4) + 1} 顆（示意）` });
    },
    onHighlight: (on) => glowTween((v) => (gpuHot = v), gpuHot, on ? 1 : 0),
  });
  hotspots.register('nvlink-switch', {
    object: sws,
    anchor: swPos(3).add(v3(0, 0.1, 0)),
    pose: POSES['nvlink-switch']!,
    card: () => hotspotCard(ctx, 'nvlink-switch'),
    onHighlight: (on) => glowTween((v) => (swHot = v), swHot, on ? 1 : 0),
  });
  hotspots.register('copper-spine', {
    object: spineProxy,
    anchor: [0, trayY(2), SPINE_Z],
    pose: POSES['copper-spine']!,
    card: () => hotspotCard(ctx, 'copper-spine'),
    onHighlight: (on) => glowTween((v) => (hotSpine = v), hotSpine, on ? 1 : 0),
  });
  hotspots.register('nic', {
    object: nics,
    anchor: [GPU_X[0]!, trayY(1), NIC_Z],
    pose: POSES['nic']!,
    card: () => hotspotCard(ctx, 'nic'),
    onHighlight: (on) => glowTween((v) => (hotNic = v), hotNic, on ? 1 : 0),
  });
  ctx.picker.add(soSwitch, { id: 'nic', recursive: false });

  /* ───────── steps ───────── */
  let sid = stepIdOf(ctx, ctx.step);
  const fanOn = () => sid === 'all-to-all';
  let stepTween: { cancel(): void } | null = null;
  const showStep = (i: number) => {
    sid = stepIdOf(ctx, i);
    const on = fanOn();
    const dom = sid === 'nvlink-domain';
    flow.object.visible = !on;
    nicFlow.object.visible = !on;
    exitFlow.object.visible = !on;
    fan.object.visible = on;
    fanLabel.set({ visible: on });
    gpuLabel.set({ visible: !on });
    exitLabel.set({ visible: !on });
    note.set({ visible: on || dom });
    placeNote();
    soLabel.set({ visible: !on });
    // Seen from the side in 全互連, the NIC label would sit on the GPUs of the second tray.
    nicLabel.set({ priority: dom ? 24 : 16, visible: !on });
    stepTween?.cancel();
    const from = fanK;
    const fromD = domK;
    stepTween = ctx.tween.run(
      (k) => {
        fanK = from + ((on ? 1 : 0) - from) * k;
        domK = fromD + ((dom ? 1 : 0) - fromD) * k;
        fanTubeMat.opacity = 0.9 * fanK;
        fanTubes.visible = fanK > 0.01;
        postMat.opacity = 1 - 0.85 * fanK;
        postMat.depthWrite = fanK < 0.5;
        paintLines();
        paintGlows();
      },
      { duration: 500, fade: true },
    );
    ctx.setPose(POSES[sid] ?? ctx.homePose);
  };

  freeze(root);
  // Flows and glows animate in the shader; their object matrices never change.

  return {
    anchor: [0, 2.2, 0.6],
    update(_dt, t) {
      flow.update(t);
      fan.update(t);
      nicFlow.update(t);
      exitFlow.update(t);
    },
    setStep(i) {
      showStep(i);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onQuality() {
      setCounts();
    },
    onMotion(animate) {
      setReduced(!animate);
    },
    onResize() {
      placeNote();
    },
    dispose() {
      stepTween?.cancel();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

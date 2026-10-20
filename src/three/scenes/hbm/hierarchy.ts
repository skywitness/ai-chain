/**
 * hbm / variant "hierarchy" — the memory-hierarchy tower under a GPU compute block. Six tiers top →
 * bottom: registers, SRAM caches, HBM, DDR/LPDDR, SSD, HDD. Three log-scale encodings, all
 * order-of-magnitude illustrations (示意, no product figures):
 *   - slab width     = capacity (wider = more);
 *   - left bars      = access latency (a dot travels each bar out and back: longer = slower);
 *   - right pipes    = bandwidth (particle density and speed grow with bandwidth).
 * Step 「記憶體牆」 dims everything except HBM and DDR (same latency class, very different
 * bandwidth) and shows weights + KV cache streaming from HBM into the GPU for every token.
 * Three layouts: landscape; a compact one for narrow landscape stages (phones at 4:3), and a
 * narrower, taller one for portrait stages. Reduced motion: static dotted streams.
 */
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, CardContent, LabelHandle, Palette, SceneCameraSpec, SceneContext, SceneInstance } from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { buildFloorGrid, fadeToBg } from './shared';
import { crossLink, HOTSPOT_TEXT, LINKS, resumeFocus, STACK_PART_STEP } from './links';

/* ───────────────────────── tiers (log10 values: 數量級示意) ───────────────────────── */

interface Tier {
  id: string;
  name: string;
  /** Shorter name for the compact (narrow landscape) layout. */
  short?: string;
  where: string;
  /** log10 bytes */
  cap: number;
  /** log10 bytes per second */
  bw: number;
  /** log10 seconds */
  lat: number;
  capText: string;
  bwText: string;
  latText: string;
}
const TIERS: readonly Tier[] = [
  { id: 'registers', name: '暫存器', where: 'GPU 晶片內', cap: 7.4, bw: 14.6, lat: -9.4, capText: '數十 MB', bwText: '數百 TB/s', latText: '< 1 ns' },
  { id: 'sram', name: 'SRAM 快取', short: 'SRAM', where: 'GPU 晶片內（L1／L2）', cap: 8.0, bw: 13.5, lat: -7.6, capText: '約百 MB', bwText: '數十 TB/s', latText: '數十 ns 級' },
  { id: 'hbm-stack', name: 'HBM', where: '封裝內，緊鄰 GPU', cap: 11.4, bw: 12.75, lat: -6.8, capText: '數百 GB', bwText: '數 TB/s 以上', latText: '約百 ns 級' },
  { id: 'ddr', name: 'DDR／LPDDR', short: 'DDR', where: 'CPU 端主記憶體', cap: 11.9, bw: 11.6, lat: -6.8, capText: '數百 GB～TB', bwText: '數百 GB/s', latText: '約百 ns 級' },
  { id: 'ssd', name: 'SSD', where: '伺服器內的快閃儲存', cap: 13.5, bw: 10.4, lat: -4.3, capText: '數十 TB', bwText: '數十 GB/s', latText: '數十 µs' },
  { id: 'hdd', name: 'HDD', where: '儲存伺服器', cap: 15.3, bw: 8.4, lat: -2.3, capText: 'PB 級', bwText: '數百 MB/s', latText: '數 ms' },
];
const HBM_I = 2;
const DDR_I = 3;
const LAT = { min: -10, max: -2 }; // 0.1 ns … 10 ms
const BW = { min: 8, max: 15 }; // 100 MB/s … 1 PB/s
const CAP = { min: 7, max: 16 };
const LAT_TICKS: readonly [number, string][] = [
  [-9, '1 ns'],
  [-6, '1 µs'],
  [-3, '1 ms'],
];
const BW_TICKS: readonly [number, string][] = [
  [9, '1 GB/s'],
  [12, '1 TB/s'],
  [15, '1 PB/s'],
];

interface Lay {
  row: number;
  top: number;
  xb: number;
  barMax: number;
  wMin: number;
  wMax: number;
}
const LAND: Lay = { row: 0.86, top: 4.5, xb: 2.8, barMax: 3.2, wMin: 0.9, wMax: 4.5 };
/**
 * Narrow stages share one arrangement: tier label = short name + capacity on the slab, latency and
 * bandwidth values beside their bars, the column headings flanking the GPU block, no axis ticks.
 * Portrait (phones, 4:5) gives it tall rows in a compact world scale (the host's portrait pose);
 * compact (narrow landscape stages, e.g. phones at 4:3) squeezes the rows under its own pose
 * (COMP_POSE).
 */
const PORT: Lay = { row: 1.3, top: 6.5, xb: 1.3, barMax: 0.89, wMin: 0.38, wMax: 1.65 };
const COMP: Lay = { row: 1.0, top: 5.0, xb: 2.0, barMax: 1.5, wMin: 0.55, wMax: 2.5 };
const COMP_POSE: CameraPose = { position: [0.4, 3.35, 11.3], target: [0, 2.55, 0] };
type Mode = 'land' | 'comp' | 'port';
const LAYOUTS: Record<Mode, Lay> = { land: LAND, comp: COMP, port: PORT };
const modeFor = (s: { width: number; aspect: number }): Mode => (s.aspect < 0.9 ? 'port' : s.width < 560 ? 'comp' : 'land');

export const HIER_CAMERA: SceneCameraSpec = {
  position: [1.0, 3.7, 14.2],
  target: [0, 2.45, 0],
  fov: 34,
  minDistance: 5,
  maxDistance: 26,
  minPolar: 0.7,
  maxPolar: 1.75,
  minAzimuth: -0.95,
  maxAzimuth: 0.95,
  // Same distance as the main pose (ctx.setPose scales portrait poses by that ratio); the wider
  // FOV leaves a margin above the GPU block and below the scale note.
  portrait: { position: [0.5, 4.25, 14.1], target: [0, 3.6, 0], fov: 39.5 },
};

const norm = (v: number, r: { min: number; max: number }) => Math.min(1, Math.max(0, (v - r.min) / (r.max - r.min)));

const tierColor = (i: number, p: Palette, out: Color): Color => {
  switch (i) {
    case 0:
      return out.copy(p.seg['ai-accelerators']).lerp(p.fg, 0.22);
    case 1:
      return out.copy(p.seg['ai-accelerators']);
    case 2:
      return out.copy(p.seg['memory-storage']);
    case 3:
      return out.copy(p.seg['memory-storage']).lerp(p.muted, 0.5);
    // The far tiers (storage) are toned down so the eye stays on the memory tiers near the GPU.
    case 4:
      return out.copy(p.seg['servers-systems']).lerp(p.muted, 0.22);
    default:
      return out.copy(p.seg['datacenter-infra']).lerp(p.muted, 0.45);
  }
};

const m4 = new Matrix4();
const v3 = new Vector3();
const s3 = new Vector3();
const qX = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
const qI = new Quaternion();

export function createHierarchyScene(ctx: SceneContext): SceneInstance {
  const { scene, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'hbm-hierarchy';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  let mode: Mode = modeFor(ctx.size);
  let L = LAYOUTS[mode];
  let step = 0;
  const dim = TIERS.map(() => 0);
  const hot = TIERS.map(() => 0);
  let wallK = 0; // step 「記憶體牆」 extras (0..1)

  const yOf = (i: number) => L.top - i * L.row;
  const wOf = (t: Tier) => L.wMin + norm(t.cap, CAP) * (L.wMax - L.wMin);
  const dOf = (t: Tier) => 0.62 + 0.24 * (wOf(t) / L.wMax) * 3;
  const latLen = (t: Tier) => Math.max(0.08, norm(t.lat, LAT) * L.barMax);
  const bwLen = (t: Tier) => Math.max(0.08, norm(t.bw, BW) * L.barMax);
  const bottomY = () => yOf(TIERS.length - 1);
  // (Compact rows are tight: the GPU row sits a little higher to keep its labels clear.)
  const gpuY = () => L.top + L.row * (mode === 'comp' ? 1.12 : 0.95);

  /* ───────── floor ───────── */
  const grid = buildFloorGrid(9, 0.6);
  const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const floor = new LineSegments(ctx.track(grid.geometry), gridMat);
  root.add(floor);
  const shadowMat = ctx.track(
    new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }),
  );
  const shadow = new Mesh(ctx.track(new PlaneGeometry(13, 7)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  root.add(shadow);

  /* ───────── decade grid (vertical lines behind the bars) ───────── */
  const tickGeo = ctx.track(new BufferGeometry());
  const tickMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const ticks = new LineSegments(tickGeo, tickMat);
  root.add(ticks);

  /* ───────── tiers: slabs (one mesh each), latency bars, bandwidth pipes ───────── */
  const slabMats = TIERS.map(() => ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.15 })));
  const slabs = TIERS.map((_, i) => {
    const m = new Mesh(undefined, slabMats[i]!);
    root.add(m);
    return m;
  });
  const barMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }));
  const bars = new InstancedMesh(ctx.track(new BoxGeometry(1, 1, 1)), barMat, TIERS.length);
  bars.setColorAt(0, new Color());
  root.add(bars);
  ctx.track({ dispose: () => bars.dispose() });
  const pipeMat = ctx.track(
    new MeshStandardMaterial({ transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.2, metalness: 0.05 }),
  );
  const pipes = new InstancedMesh(ctx.track(new CylinderGeometry(1, 1, 1, 28, 1, true)), pipeMat, TIERS.length);
  pipes.setColorAt(0, new Color());
  pipes.renderOrder = 4;
  root.add(pipes);
  ctx.track({ dispose: () => pipes.dispose() });
  const pipeR = (t: Tier) => 0.07 + 0.075 * norm(t.bw, BW);

  /* ───────── GPU compute block ───────── */
  const gpuMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 }));
  const gpu = new Mesh(ctx.track(new RoundedBoxGeometry(1.25, 0.26, 1.0, 3, 0.06)), gpuMat);
  root.add(gpu);
  const glows = ctx.track(new GlowSprites({ count: 2, theme: ctx.theme }));
  root.add(glows.object);

  /* ───────── flows ───────── */
  interface FlowSet {
    flow: PathFlow;
    max: number;
  }
  let bwFlow: FlowSet | null = null;
  let pingFlow: FlowSet | null = null;
  let wallFlow: FlowSet | null = null;
  const bwTier: number[] = [];
  const allFlows = () => [bwFlow, pingFlow, wallFlow].filter((f): f is FlowSet => !!f);
  const makeFlow = (paths: FlowPath[], max: number, opts: Partial<ConstructorParameters<typeof PathFlow>[0]>): FlowSet => {
    const flow = new PathFlow({ paths, count: max, theme: ctx.theme, smooth: false, ...opts });
    flow.setCount(scaleCount(max, ctx.tier, Math.min(max, 12)));
    flow.setReduced(!ctx.animate);
    root.add(flow.object);
    return { flow, max };
  };

  /* ───────── labels ───────── */
  const nameLabels: LabelHandle[] = TIERS.map((t) =>
    labels.add({ text: `${t.name}・${t.capText}`, align: 'center', priority: 32, hotspot: t.id }),
  );
  const latLabels = TIERS.map((t) => labels.add({ text: t.latText, align: 'left', kind: 'tag', priority: 22, hotspot: t.id }));
  const bwLabels = TIERS.map((t) => labels.add({ text: t.bwText, align: 'right', kind: 'tag', priority: 22, hotspot: t.id }));
  const hLat = labels.add({ text: '← 存取延遲（越短越快）', align: 'above', kind: 'strong', priority: 36 });
  const hBw = labels.add({ text: '頻寬（越長越多）→', align: 'above', kind: 'strong', priority: 36 });
  const hCap = labels.add({ text: '平台寬度＝容量・皆為對數刻度、數量級示意', align: 'below', kind: 'muted', priority: 30 });
  const gpuLabel = labels.add({ text: 'GPU 運算核心', align: 'right', kind: 'strong', priority: 34, hotspot: 'gpu' });
  const tickLabels = [...LAT_TICKS, ...BW_TICKS].map(([, text]) => labels.add({ text, align: 'below', kind: 'tag', priority: 8 }));
  const wallLat = labels.add({ text: 'HBM 與 DDR 延遲相近', align: 'above', kind: 'strong', priority: 38 });
  const wallBw = labels.add({ text: 'HBM 頻寬高出一截', align: 'above', kind: 'strong', priority: 38 });
  const wallFlowLabel = labels.add({ text: '權重＋KV Cache：每個 Token 都要讀一遍', align: 'right', kind: 'default', priority: 39 });
  /** Short texts (index 1) for the portrait and compact layouts. */
  const LAT_HEAD = ['← 存取延遲（越短越快）', '← 延遲（越短越快）'] as const;
  const BW_HEAD = ['頻寬（越長越多）→', '頻寬（越長越多）→'] as const;
  const CAP_NOTE = ['平台寬度＝容量・皆為對數刻度、數量級示意', '平台寬度＝容量・對數刻度示意'] as const;
  const WALL_FLOW = ['權重＋KV Cache：每個 Token 都要讀一遍', '權重＋KV Cache'] as const;
  const WALL_BW = 'HBM 頻寬高出一截';
  const WALL_LAT = ['HBM 與 DDR 延遲相近', '延遲相近'] as const;

  /* ───────── layout ───────── */
  const build = () => {
    L = LAYOUTS[mode];
    const port = mode === 'port';
    const land = mode === 'land';
    const fy = bottomY() - 0.55;
    const fs = port ? 0.7 : mode === 'comp' ? 0.8 : 1;
    floor.position.y = fy;
    floor.scale.set(fs, 1, 1);
    shadow.position.y = fy + 0.005;
    shadow.scale.set(port ? 0.62 : fs, 1, 1);

    TIERS.forEach((t, i) => {
      const y = yOf(i);
      const w = wOf(t);
      const d = dOf(t);
      slabs[i]!.geometry?.dispose();
      slabs[i]!.geometry = ctx.track(new RoundedBoxGeometry(w, 0.36, d, 3, 0.06));
      slabs[i]!.position.set(0, y, 0);
      const ll = latLen(t);
      bars.setMatrixAt(i, m4.compose(v3.set(-L.xb - ll / 2, y, 0), qI, s3.set(ll, 0.2, 0.34)));
      const bl = bwLen(t);
      const r = pipeR(t);
      pipes.setMatrixAt(i, m4.compose(v3.set(L.xb + bl / 2, y, 0), qX, s3.set(r, bl, r)));
      // Portrait rows are tall: the label sits above its slab so the slab width (capacity) shows.
      nameLabels[i]!.set({
        text: `${land ? t.name : (t.short ?? t.name)}・${t.capText}`,
        position: [0, port ? y + 0.18 : y, d / 2 + 0.02],
        align: port ? 'above' : 'center',
        offset: port ? [0, 4] : [0, 0],
      });
      latLabels[i]!.set({ position: [-L.xb - ll - 0.06, y, 0] });
      bwLabels[i]!.set({ position: [L.xb + bl + 0.06, y, 0] });
    });
    bars.instanceMatrix.needsUpdate = true;
    pipes.instanceMatrix.needsUpdate = true;
    bars.boundingSphere = null;
    pipes.boundingSphere = null;

    gpu.position.set(0, gpuY(), 0);
    const top = L.top + L.row * 0.62;
    const by = bottomY() - (mode === 'comp' ? 0.5 : 0.3);
    const pi = land ? 0 : 1;
    const zFront = dOf(TIERS[TIERS.length - 1]!) / 2;
    if (land) {
      // Column headings above the bars; the GPU label sits above the block, clear of both.
      hLat.set({ text: LAT_HEAD[0], kind: 'strong', position: [-L.xb - L.barMax / 2, top, 0], align: 'above', offset: [0, 0] });
      hBw.set({ text: BW_HEAD[0], kind: 'strong', position: [L.xb + L.barMax / 2, top, 0], align: 'above', offset: [0, 0] });
      gpuLabel.set({ text: 'GPU 運算核心', kind: 'strong', position: [0, gpuY() + 0.13, 0.2], align: 'above', offset: [0, 2] });
    } else {
      // Narrow stages: the headings flank the GPU block (a short label sits on the block itself).
      // (Pixel offsets keep them clear of the GPU label at any stage size.)
      hLat.set({ text: LAT_HEAD[1], kind: 'default', position: [0, gpuY(), 0.5], align: 'left', offset: [-36, 0] });
      hBw.set({ text: BW_HEAD[1], kind: 'default', position: [0, gpuY(), 0.5], align: 'right', offset: [36, 0] });
      gpuLabel.set({ text: 'GPU', kind: 'default', position: [0, gpuY(), 0.52], align: 'center', offset: [0, 0] });
    }
    hCap.set({ text: CAP_NOTE[pi], position: [0, by, zFront] });
    for (const tl of tickLabels) tl.set({ visible: land });
    [...LAT_TICKS.map(([v]) => -L.xb - norm(v, LAT) * L.barMax), ...BW_TICKS.map(([v]) => L.xb + norm(v, BW) * L.barMax)].forEach(
      (x, k) => tickLabels[k]!.set({ position: [x, by + 0.05, -0.3] }),
    );
    // 「記憶體牆」 callouts above the HBM bar and pipe (the SRAM row above is dimmed then, so its
    // values are hidden). Narrow stages centre them in their columns on the dimmed SRAM row.
    const hb = TIERS[HBM_I]!;
    if (!land) {
      const lift: [number, number] = [0, port ? -8 : -4]; // clear of the HBM label below
      wallLat.set({ text: WALL_LAT[1], position: [-L.xb - L.barMax / 2, yOf(1), 0], align: 'center', offset: lift });
      wallBw.set({ text: WALL_BW, position: [L.xb + L.barMax / 2, yOf(1), 0], align: 'center', offset: lift });
    } else {
      // (Lifted a few px so HBM's own values beside the bars keep their place.)
      wallLat.set({ text: WALL_LAT[0], position: [-L.xb - latLen(hb) / 2, yOf(HBM_I) + 0.14, 0], align: 'above', offset: [0, -5] });
      wallBw.set({ text: WALL_BW, position: [L.xb + bwLen(hb) * 0.5, yOf(HBM_I) + 0.2, 0], align: 'above', offset: [0, -5] });
    }

    // Decade grid lines.
    const pos: number[] = [];
    const col: number[] = [];
    const y0 = bottomY() - 0.32;
    const y1 = L.top + L.row * 0.45;
    const addLine = (x: number, major: boolean) => {
      pos.push(x, y0, -0.32, x, y1, -0.32);
      const a = major ? 1 : 0.45;
      col.push(1, 1, 1, a, 1, 1, 1, a * 0.25);
    };
    for (let v = LAT.min; v <= LAT.max; v++) addLine(-L.xb - norm(v, LAT) * L.barMax, LAT_TICKS.some(([t]) => t === v));
    for (let v = BW.min; v <= BW.max; v++) addLine(L.xb + norm(v, BW) * L.barMax, BW_TICKS.some(([t]) => t === v));
    // Baselines.
    pos.push(-L.xb, y0, -0.32, -L.xb, y1, -0.32, L.xb, y0, -0.32, L.xb, y1, -0.32);
    col.push(1, 1, 1, 1, 1, 1, 1, 0.3, 1, 1, 1, 1, 1, 1, 1, 0.3);
    tickGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    tickGeo.setAttribute('color', new Float32BufferAttribute(col, 4));
    tickGeo.computeBoundingSphere();
    tickBase = col.slice();

    // Flows (rebuilt with the layout).
    for (const f of allFlows()) f.flow.dispose();
    const bwPaths: FlowPath[] = [];
    bwTier.length = 0;
    TIERS.forEach((t, i) => {
      const y = yOf(i);
      const bl = bwLen(t);
      const r = pipeR(t) * 0.45;
      const k = norm(t.bw, BW);
      for (const [dy, dz] of [
        [0, 0],
        [r, r * 0.4],
        [-r, -r * 0.4],
      ] as const) {
        bwPaths.push({ points: [[L.xb + bl, y + dy, dz], [L.xb + 0.02, y + dy, dz]], weight: 0.15 + 2.2 * k * k, speed: 0.25 + 1.6 * k });
        bwTier.push(i);
      }
    });
    bwFlow = makeFlow(bwPaths, 520, { size: 0.06, sizeVariance: 0.3, speed: 0.75, speedVariance: 0.15, fadeEnds: 0.1, seed: 21 });
    const pingPaths: FlowPath[] = TIERS.map((t, i) => {
      const y = yOf(i);
      const a: [number, number, number] = [-L.xb - 0.03, y, 0.2];
      const b: [number, number, number] = [-L.xb - latLen(t) + 0.03, y, 0.2];
      return { points: [a, b, a] };
    });
    pingFlow = makeFlow(pingPaths, TIERS.length, { size: 0.15, sizeVariance: 0, speed: 1.1, speedVariance: 0, fadeEnds: 0.02, byLength: false, seed: 4 });
    pingFlow.flow.setCount(TIERS.length);
    const yH = yOf(HBM_I) + 0.18;
    const zH = dOf(hb) / 2 + 0.14;
    const wallPaths: FlowPath[] = [-0.24, 0, 0.24].map((x) => ({
      points: [
        [x, yH, zH],
        [x * 0.8, yH + 0.4, zH + 0.05],
        [x * 0.6, gpuY() - 0.5, 0.75],
        [x * 0.5, gpuY() - 0.12, 0.45],
      ],
    }));
    wallFlow = makeFlow(wallPaths, 150, { size: 0.07, sizeVariance: 0.3, speed: 0.9, speedVariance: 0.2, fadeEnds: 0.12, seed: 8, smooth: true });
    // On the (dimmed) registers row, leaving the space above HBM to the callouts.
    wallFlowLabel.set({ text: WALL_FLOW[pi], position: [0.35, yOf(0), dOf(TIERS[0]!) / 2 + 0.3] });
    applyLook();
  };
  let tickBase: number[] = [];

  /* ───────── colours ───────── */
  const cT = new Color();
  const cA = new Color();
  const cE = new Color();
  const applyLook = () => {
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    TIERS.forEach((_, i) => {
      tierColor(i, p, cT);
      const base = cA.copy(cT).lerp(p.bg, dark ? 0.12 : 0.04);
      // The self-glow fades with the tier (otherwise dimmed tiers keep shining on dark).
      const glow = ((dark ? 0.16 : 0.03) + hot[i]! * (dark ? 0.3 : 0.18)) * (1 - 0.9 * dim[i]!);
      fadeToBg(slabMats[i]!, base, p, dim[i]! * 0.85, cE.copy(cT).multiplyScalar(glow));
      bars.setColorAt(i, cA.copy(cT).lerp(p.bg, (dark ? 0.3 : 0.38) + dim[i]! * 0.5).lerp(p.highlight, hot[i]! * 0.3));
      pipes.setColorAt(i, cA.copy(cT).lerp(p.bg, dim[i]! * 0.7));
      const muted = dim[i]! > 0.5;
      // Dimmed tiers drop their names: their rows host the 「記憶體牆」 callouts and flow label.
      nameLabels[i]!.set({ kind: muted ? 'muted' : 'default', swatch: muted ? '' : cT.getStyle(), visible: !muted });
      latLabels[i]!.set({ visible: !muted });
      bwLabels[i]!.set({ visible: !muted });
    });
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    if (pipes.instanceColor) pipes.instanceColor.needsUpdate = true;
    pipeMat.opacity = dark ? 0.3 : 0.32;
    barMat.color.setRGB(1, 1, 1);
    fadeToBg(gpuMat, cA.copy(p.seg['ai-accelerators']).lerp(p.bg, dark ? 0.15 : 0.05), p, 0, cT.copy(p.seg['ai-accelerators']).multiplyScalar(dark ? 0.35 : 0.08));
    glows.set(0, gpu.position, 2.2, p.seg['ai-accelerators'], dark ? 0.45 : 0.22);
    glows.set(1, [0, yOf(HBM_I), 0], 3.6, p.seg['memory-storage'], wallK * (dark ? 0.32 : 0.18));
    // Flows.
    bwFlow?.flow.recolor((k) => {
      const i = bwTier[k] ?? 0;
      return tierColor(i, p, new Color()).lerp(p.fg, dark ? 0.25 : 0).lerp(p.bg, dim[i]! * 0.8);
    });
    pingFlow?.flow.recolor((i) => cA.copy(p.highlight).lerp(p.bg, dim[i]! * 0.8).clone());
    wallFlow?.flow.recolor(() => p.seg['memory-storage'].clone().lerp(p.fg, dark ? 0.3 : 0));
    for (const f of allFlows()) f.flow.setTheme(p.theme);
    bwFlow?.flow.setSize(dark ? 0.065 : 0.05);
    pingFlow?.flow.setSize(dark ? 0.17 : 0.13);
    wallFlow?.flow.setSize(dark ? 0.08 : 0.065);
    wallFlow?.flow.setOpacity(wallK);
    if (wallFlow) wallFlow.flow.object.visible = wallK > 0.01;
    // Ticks.
    const tc = cA.copy(p.fg).lerp(p.bg, dark ? 0.72 : 0.7);
    const attr = tickGeo.getAttribute('color') as Float32BufferAttribute | undefined;
    if (attr) {
      for (let k = 0; k < attr.count; k++) attr.setXYZW(k, tc.r, tc.g, tc.b, (tickBase[k * 4 + 3] ?? 0) * (dark ? 0.75 : 0.9));
      attr.needsUpdate = true;
    }
    grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.08 : 0.04), dark ? 0.5 : 0.7);
    shadowMat.color.copy(dark ? p.flow : p.fg);
    shadowMat.opacity = dark ? 0.06 : 0.07;
    wallLat.set({ visible: wallK > 0.5 });
    wallBw.set({ visible: wallK > 0.5 });
    // (Compact rows leave no room for it above the callouts; the step caption says the same.)
    wallFlowLabel.set({ visible: wallK > 0.5 && mode !== 'comp' });
    gpuLabel.set({ swatch: p.css['seg-ai-accelerators'] ?? '' });
    ctx.invalidate();
  };

  const applyPalette = (p: Palette) => {
    lights.apply(p);
    glows.setTheme(p.theme);
    applyLook();
  };

  /* ───────── hotspots ───────── */
  const cardFor = (i: number): CardContent => {
    const t = TIERS[i]!;
    const txt = HOTSPOT_TEXT.get(t.id);
    const c: CardContent = {
      title: t.id === 'hbm-stack' ? 'HBM（高頻寬記憶體）' : (txt?.label ?? t.name),
      subtitle: t.where,
      swatch: tierColor(i, ctx.palette, new Color()).getStyle(),
      items: [
        { label: '存取延遲', meta: `${t.latText}（示意）` },
        { label: '頻寬', meta: `${t.bwText}（示意）` },
        { label: '容量', meta: `${t.capText}（示意）` },
      ],
    };
    const body =
      t.id === 'hbm-stack'
        ? '和 DDR 同樣是 DRAM，延遲相近；勝在緊貼 GPU、介面極寬，頻寬高出一截，是 AI 晶片最主要的工作記憶體。'
        : txt?.detail;
    if (body) c.body = body;
    const link = LINKS[t.id];
    if (link) {
      c.href = link[0];
      c.linkLabel = link[1];
    }
    return c;
  };
  const hotTw = new Map<number, { cancel(): void }>();
  TIERS.forEach((t, i) => {
    const y = () => yOf(i);
    hotspots.register(t.id, {
      object: slabs[i]!,
      anchor: slabs[i]!,
      pose: { position: [0.6, y() + 1.0, 8.6], target: [0, y(), 0] },
      card: () => cardFor(i),
      onHighlight: (on) => {
        hotTw.get(i)?.cancel();
        const from = hot[i]!;
        hotTw.set(
          i,
          ctx.tween.run(
            (k) => {
              hot[i] = from + ((on ? 1 : 0) - from) * k;
              applyLook();
            },
            { duration: 200, fade: true },
          ),
        );
      },
    });
  });
  const tierOf = ({ instanceId }: { instanceId?: number }) => (instanceId !== undefined ? (TIERS[instanceId]?.id ?? null) : null);
  ctx.picker.add(bars, { id: tierOf });
  ctx.picker.add(pipes, { id: tierOf });
  hotspots.register('gpu', {
    object: gpu,
    anchor: gpu,
    card: () => {
      const txt = HOTSPOT_TEXT.get('gpu');
      const c: CardContent = { title: txt?.label ?? 'GPU', swatch: ctx.palette.css['seg-ai-accelerators'] ?? '' };
      c.body = '運算核心從上方的暫存器與 SRAM 取資料最快；資料一旦要從 HBM 以下的層級搬上來，就得等待更久、能搬的量也更少。';
      const link = LINKS['gpu'];
      if (link) {
        c.href = link[0];
        c.linkLabel = link[1];
      }
      return c;
    },
  });
  for (const [id, s] of Object.entries(STACK_PART_STEP)) if (id !== 'gpu') crossLink(ctx, id, Math.max(1, s === 0 ? 4 : s));

  /* ───────── steps ───────── */
  let dimTween: { cancel(): void } | null = null;
  // A gentle move-in: HBM's bandwidth value at the pipe end must stay on stage at ~700 px wide.
  const wallPose = (): CameraPose => ({ position: [0.4, yOf(HBM_I) + 1.07, 13.2], target: [0.15, (yOf(HBM_I) + yOf(DDR_I)) / 2 + 0.45, 0] });
  const goStep = (i: number) => {
    step = i;
    const wall = step === 6;
    dimTween?.cancel();
    const from = dim.slice();
    const wFrom = wallK;
    dimTween = ctx.tween.run(
      (k) => {
        TIERS.forEach((_, j) => {
          const to = wall && j !== HBM_I && j !== DDR_I ? 1 : 0;
          dim[j] = from[j]! + (to - from[j]!) * k;
        });
        wallK = wFrom + ((wall ? 1 : 0) - wFrom) * k;
        applyLook();
      },
      { duration: 700, fade: true },
    );
    ctx.setPose(poseFor(), first ? { duration: 0 } : undefined);
    first = false;
  };
  /**
   * Landscape moves in on the HBM / DDR pair for 「記憶體牆」; portrait and compact already frame
   * the whole (narrow) tower, and the dimming carries the focus there.
   */
  const poseFor = (): CameraPose => (mode === 'comp' ? COMP_POSE : step === 6 && mode === 'land' ? wallPose() : ctx.homePose);
  let first = true; // the first step is applied as a cut (no fly-in on load)

  build();
  applyPalette(ctx.palette);
  labels.setMax(ctx.quality === 'low' ? 16 : 34);
  resumeFocus(ctx);

  return {
    update(_dt, t) {
      for (const f of allFlows()) f.flow.update(t);
    },
    setStep(i) {
      goStep(i);
    },
    onMotion(animate) {
      for (const f of allFlows()) f.flow.setReduced(!animate);
    },
    onQuality(_q, tier) {
      for (const f of [bwFlow, wallFlow]) f?.flow.setCount(scaleCount(f.max, tier, 12));
      labels.setMax(tier.maxLabels <= 12 ? 16 : 34);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onResize(size) {
      const next = modeFor(size);
      if (next === mode) return;
      mode = next;
      build();
      ctx.setPose(poseFor());
    },
    dispose() {
      dimTween?.cancel();
      hotTw.forEach((tw) => tw.cancel());
      for (const f of allFlows()) f.flow.dispose();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

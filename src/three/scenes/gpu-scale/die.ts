/**
 * gpu-scale · variant `die` — 晶粒內部: a GPU compute die opened up (schematic units, 示意).
 *
 * Two identical compute dies sit side by side on the interposer (the second one mirrored, dimmed),
 * each with four HBM stacks on its long edges. The hero die's floorplan: 8 GPCs × 10 SMs, each SM
 * with 4 Tensor Cores and an L1 strip; the L2 cache in two partitions across the middle with a
 * crossbar; HBM PHYs under the stacks; NVLink SerDes on the outer edge; the die-to-die interface
 * on the inner edge. Step `sm` lifts a magnified SM above its tile (4 processing blocks: warp
 * scheduler, register file, CUDA cores, Tensor Core; shared L1). Step `hbm-io` explodes one HBM
 * stack into a base die + 8 DRAM dies threaded by TSVs.
 * Reduced motion: flows become static dotted streams; the lifted / exploded parts cut to place.
 */
import { BoxGeometry, CylinderGeometry, Float32BufferAttribute, Group, BufferGeometry, LineSegments, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneInstance, Tween } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  Highlighter,
  Inst,
  T,
  crossHotspots,
  face,
  floor,
  hotspot,
  mat,
  placeLabels,
  rb,
  stepCamera,
  v3,
  zoomPose,
  type Align,
  type Ctx,
  type InstItem,
  type PlacedLabel,
  type PortraitPlace,
  type Tone,
} from './kit';

/* ───────────────────────── layout (die units) ───────────────────────── */

const DIE = { w: 3.8, d: 3.0, y0: 0.12, h: 0.18 };
const TOP = DIE.y0 + DIE.h; // die surface
const SIB = 4.0; // sibling die centre x (mirrored: x' = SIB - x)
const GPC_X = [-1.17, -0.39, 0.39, 1.17];
const GPC_Z = [-0.8, 0.8];
const SM = { w: 0.33, d: 0.17, h: 0.03 };
const HBM = { xs: [-0.95, 0.95], z: 2.32, w: 1.5, d: 1.12, slice: 0.026, gap: 0.004, layers: 9 };
const HERO_SM = { x: -0.39 - 0.18, z: 0.8 + 0.4 }; // the SM that is magnified
const MAG = { x: -0.62, y: 1.85, z: 0.35 }; // magnified SM, floating behind and above its tile
const HERO_HBM = { x: -0.95, z: -HBM.z }; // the stack that explodes
const EXPLODE_GAP = 0.14;

const LEVEL: Record<string, number> = { overview: 0, die: 1, sm: 2, 'hbm-io': 3 };
const POSES: readonly CameraPose[] = [
  { position: [3.9, 8.69, 9.0], target: [2.3, 0.0, 1.0] },
  { position: [0.25, 5.4, 4.2], target: [0.05, 0.2, 0.15] },
  // Looking down into the magnified SM (so the CUDA cores and register files behind the Tensor
  // Cores stay visible) with its tile on the die below.
  { position: [-0.5, 4.7, 3.85], target: [-0.62, 1.2, 0.45] },
  { position: [-2.6, 3.3, 3.9], target: [-0.25, 0.65, -0.95] },
];
/** Portrait (4:5): seen from the NVLink edge, so the two dies stack vertically. */
const PORTRAIT: readonly (CameraPose | null)[] = [
  null,
  { position: [-3.3, 5.0, 0.35], target: [0.05, 0.2, 0.15] },
  { position: [-0.4, 4.74, 3.8], target: [-0.6, 1.35, 0.65] },
  zoomPose({ position: [-2.6, 2.9, 3.9], target: [-0.35, 0.2, -1.0] }, 1.32),
];

export const DIE_CAMERA = {
  ...POSES[0]!,
  fov: 36,
  near: 0.05,
  far: 80,
  minDistance: 2,
  maxDistance: 18,
  minPolar: 0.1,
  maxPolar: 1.35,
  portrait: { position: [-6.08, 10.69, 0.76] as [number, number, number], target: [1.7, 0.0, -0.1] as [number, number, number], fov: 44 },
};

/* ───────────────────────── build ───────────────────────── */

export function buildDie(ctx: Ctx): SceneInstance {
  const { scene, materials, labels } = ctx;
  const root = new Group();
  root.name = 'gpu-scale-die';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const hl = new Highlighter(ctx);
  const fl = floor(ctx, 9, 0.5, -0.32);
  root.add(...fl.group);

  const unit = ctx.track(new BoxGeometry(1, 1, 1));
  const instMat = () => ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.18 }));
  /** Sibling tones are pushed toward the background so the hero die reads first. */
  const dim =
    (t: Tone, k = 0.45): Tone =>
    (p) =>
      t(p).lerp(p.bg, k);

  /* ───────── substrate, interposer, dies ───────── */
  const subMat = materials.standard(T.substrate, { roughness: 0.75, metalness: 0.05 });
  const sub = new Mesh(ctx.track(rb(10.2, 0.3, 7.6, 0.08, SIB / 2, -0.17, 0, 2)), subMat);
  const intMat = materials.standard(T.silicon, { roughness: 0.32, metalness: 0.35 });
  const inter = new Mesh(ctx.track(rb(9.0, DIE.y0, 6.4, 0.03, SIB / 2, DIE.y0 / 2, 0, 1)), intMat);
  const dieMat = materials.standard((p) => T.gpu(p).lerp(T.silicon(p), 0.62), { roughness: 0.3, metalness: 0.3 });
  const heroDie = new Mesh(ctx.track(rb(DIE.w, DIE.h, DIE.d, 0.025, 0, DIE.y0 + DIE.h / 2, 0, 1)), dieMat);
  const sibMat = materials.standard((p) => T.gpu(p).lerp(T.silicon(p), 0.62).lerp(p.bg, 0.4), { roughness: 0.3, metalness: 0.3 });
  const sibDie = new Mesh(ctx.track(rb(DIE.w, DIE.h, DIE.d, 0.025, SIB, DIE.y0 + DIE.h / 2, 0, 1)), sibMat);
  for (const m of [sub, inter, heroDie, sibDie]) root.add(m);
  hl.addMats('gpu-package', [subMat, intMat]);

  /* ───────── floorplan blocks (hero + mirrored sibling) ───────── */
  const blocks: InstItem[] = [];
  const both = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tone: Tone, id: string | null) => {
    blocks.push({ m: mat(x, y, z, sx, sy, sz), tone, id });
    blocks.push({ m: mat(SIB - x, y, z, sx, sy, sz), tone: dim(tone), id });
  };
  const smTone = (p: Palette) => T.gpu(p).lerp(T.silicon(p), p.theme === 'dark' ? 0.5 : 0.62);
  const tcTone = (p: Palette) => T.gpu(p).lerp(p.fg, p.theme === 'dark' ? 0.08 : 0);
  const l1Tone = (p: Palette) => T.sram(p).lerp(T.silicon(p), 0.35);
  const smCentres: Vector3[] = [];
  for (const gx of GPC_X)
    for (const gz of GPC_Z) {
      both(gx, TOP + 0.006, gz, 0.72, 0.012, 1.02, face(T.gpu, 0.25), 'sm-array'); // GPC plate
      for (const dx of [-0.18, 0.18])
        for (const dz of [-0.4, -0.2, 0, 0.2, 0.4]) {
          const x = gx + dx;
          const z = gz + dz;
          smCentres.push(v3(x, TOP + 0.012 + SM.h, z));
          both(x, TOP + 0.012 + SM.h / 2, z, SM.w, SM.h, SM.d, smTone, 'sm-array');
          for (const tx of [-0.12, -0.04, 0.04, 0.12]) both(x + tx, TOP + 0.012 + SM.h + 0.016, z + 0.025, 0.066, 0.032, 0.08, tcTone, 'tensor-core');
          both(x, TOP + 0.012 + SM.h + 0.008, z - 0.058, 0.3, 0.016, 0.035, l1Tone, 'sm-array'); // L1 / shared memory (part of the SM)
        }
    }
  // L2 partitions: SRAM banks + crossbar.
  for (const side of [-1, 1])
    for (let i = 0; i < 8; i++) for (const bz of [-0.1, 0.1]) both(side * (0.15 + i * 0.18 + 0.08), TOP + 0.03, bz, 0.16, 0.06, 0.17, T.sram, 'l2-cache');
  both(0, TOP + 0.02, 0, 0.16, 0.04, 0.42, (p) => T.sram(p).lerp(p.fg, 0.3), 'l2-cache');
  // HBM PHYs on the long edges, NVLink SerDes on the outer edge, die-to-die interface on the inner edge.
  for (const hx of HBM.xs) for (const sz of [-1, 1]) both(hx, TOP + 0.02, sz * 1.41, 1.2, 0.04, 0.12, (p) => T.hbm(p).lerp(T.silicon(p), 0.3), 'hbm');
  for (let i = 0; i < 9; i++) both(-1.73, TOP + 0.025, -1.2 + i * 0.3, 0.24, 0.05, 0.22, T.nvswitch, 'nvlink-io');
  for (let i = 0; i < 14; i++) both(1.76, TOP + 0.02, -1.3 + i * 0.2, 0.18, 0.04, 0.15, (p) => T.flow(p).lerp(T.nvswitch(p), 0.4), 'nvlink-io');
  const floorplan = new Inst(ctx, unit, instMat(), blocks);
  root.add(floorplan.mesh);

  /* ───────── HBM stacks (base die + 8 DRAM dies, 示意) ───────── */
  const stacks: { x: number; z: number; hero: boolean }[] = [];
  for (const cx of [0, SIB]) for (const hx of HBM.xs) for (const sz of [-1, 1]) stacks.push({ x: cx + (cx ? -hx : hx), z: sz * HBM.z, hero: cx === 0 });
  const heroStack = stacks.find((s) => s.hero && s.x === HERO_HBM.x && s.z === HERO_HBM.z)!;
  const slices: InstItem[] = [];
  const sliceRef: { stack: (typeof stacks)[number]; l: number }[] = [];
  for (const s of stacks)
    for (let l = 0; l < HBM.layers; l++) {
      const base = l === 0;
      const tone: Tone = base ? (p) => T.hbm(p).lerp(T.silicon(p), 0.6) : (p) => T.hbm(p).lerp(p.fg, p.theme === 'dark' ? 0.05 : 0.1 * (l % 2));
      slices.push({ m: mat(0, 0, 0), tone: s.hero ? tone : dim(tone), id: 'hbm' });
      sliceRef.push({ stack: s, l });
    }
  const hbm = new Inst(ctx, unit, instMat(), slices);
  root.add(hbm.mesh);
  // TSV columns (copper) through the exploded hero stack.
  const tsvCols: [number, number][] = [];
  for (const ix of [-0.45, -0.15, 0.15, 0.45]) for (const iz of [-0.3, 0, 0.3]) tsvCols.push([heroStack.x + ix, heroStack.z + iz]);
  const tsvGeo = ctx.track(new CylinderGeometry(0.014, 0.014, 1, 6, 1));
  const tsv = new Inst(
    ctx,
    tsvGeo,
    instMat(),
    tsvCols.map(() => ({ m: mat(0, 0, 0), tone: T.power, id: 'hbm' })),
  );
  root.add(tsv.mesh);
  let hbmK = 0;
  const sliceY = (l: number, k: number) => DIE.y0 + l * (HBM.slice + HBM.gap + EXPLODE_GAP * k) + HBM.slice / 2;
  const placeHbm = () => {
    slices.forEach((it, i) => {
      const { stack, l } = sliceRef[i]!;
      const k = stack === heroStack ? hbmK : 0;
      const w = l === 0 ? HBM.w : HBM.w - 0.06;
      it.m = mat(stack.x, sliceY(l, k), stack.z, w, l === 0 ? HBM.slice * 1.3 : HBM.slice, l === 0 ? HBM.d : HBM.d - 0.06);
    });
    hbm.setMatrices();
    const top = sliceY(HBM.layers - 1, hbmK) + HBM.slice / 2;
    tsv.items.forEach((it, i) => (it.m = mat(tsvCols[i]![0], (DIE.y0 + top) / 2, tsvCols[i]![1], 1, top - DIE.y0, 1)));
    tsv.setMatrices();
    tsv.mesh.visible = hbmK > 0.02;
    ctx.invalidate();
  };
  placeHbm();

  /* ───────── magnified SM ───────── */
  const mag = new Group();
  mag.position.set(MAG.x, MAG.y, MAG.z);
  root.add(mag);
  const magBaseMat = materials.standard(smTone, { roughness: 0.35, metalness: 0.2 });
  const magBase = new Mesh(ctx.track(rb(2.0, 0.06, 1.12, 0.03, 0, 0, 0, 2)), magBaseMat);
  mag.add(magBase);
  const parts: InstItem[] = [];
  const BX = [-0.72, -0.24, 0.24, 0.72];
  const tcPos: Vector3[] = [];
  const pTone = {
    sched: (p: Palette) => T.muted(p).lerp(p.fg, 0.25),
    reg: (p: Palette) => T.cpu(p).lerp(T.silicon(p), 0.3),
    core: (p: Palette) => T.gpu(p).lerp(p.bg, p.theme === 'dark' ? 0.2 : 0.05).lerp(T.silicon(p), 0.45),
  };
  for (const bxc of BX) {
    parts.push({ m: mat(bxc, 0.055, -0.08, 0.44, 0.05, 0.84), tone: (p) => T.silicon(p).lerp(p.bg, 0.15), id: 'sm-array' });
    parts.push({ m: mat(bxc, 0.11, -0.43, 0.4, 0.06, 0.07), tone: pTone.sched, id: 'sm-array' });
    parts.push({ m: mat(bxc, 0.13, -0.3, 0.4, 0.1, 0.13), tone: pTone.reg, id: 'sm-array' });
    for (const cx of [-0.15, -0.05, 0.05, 0.15]) for (const cz of [-0.17, -0.08]) parts.push({ m: mat(bxc + cx, 0.12, cz, 0.07, 0.07, 0.065), tone: pTone.core, id: 'sm-array' });
    // Tensor Core kept low so the CUDA cores and register file behind it stay visible.
    parts.push({ m: mat(bxc, 0.12, 0.12, 0.36, 0.08, 0.24), tone: tcTone, id: 'tensor-core' });
    tcPos.push(v3(bxc, 0.2, 0.12));
  }
  parts.push({ m: mat(0, 0.1, 0.45, 1.86, 0.08, 0.16), tone: l1Tone, id: 'sm-array' });
  const magParts = new Inst(ctx, unit, instMat(), parts);
  mag.add(magParts.mesh);
  // Leader lines from the real SM tile corners to the magnified base.
  const leadGeo = ctx.track(new BufferGeometry());
  const lead = new LineSegments(leadGeo, materials.line('muted', { transparent: true, opacity: 0.7 }));
  root.add(lead);
  let magK = 0;
  const placeMag = () => {
    const s = 0.12 + 0.88 * magK;
    mag.scale.setScalar(s * 1);
    mag.position.set(
      HERO_SM.x + (MAG.x - HERO_SM.x) * magK,
      TOP + SM.h + (MAG.y - TOP - SM.h) * magK,
      HERO_SM.z + (MAG.z - HERO_SM.z) * magK,
    );
    mag.visible = magK > 0.01;
    lead.visible = magK > 0.5;
    mag.updateMatrixWorld(true);
    const pos: number[] = [];
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      pos.push(HERO_SM.x + (sx * SM.w) / 2, TOP + 0.012 + SM.h, HERO_SM.z + (sz * SM.d) / 2);
      const q = v3((sx * 2.0) / 2, -0.03, (sz * 1.12) / 2).applyMatrix4(mag.matrixWorld);
      pos.push(q.x, q.y, q.z);
    }
    leadGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    leadGeo.computeBoundingSphere();
    ctx.invalidate();
  };
  placeMag();

  hl.addInst(floorplan, hbm, tsv, magParts);
  hl.addMats('sm-array', [magBaseMat]);

  /* ───────── glows (Tensor Cores in the magnified SM) ───────── */
  const glows = ctx.track(new GlowSprites({ count: 4, theme: ctx.theme }));
  mag.add(glows.object);
  const paintGlows = (p: Palette, t: number) => {
    const dark = p.theme === 'dark';
    tcPos.forEach((q, i) => {
      const a = ctx.animate ? 0.55 + 0.45 * Math.max(0, Math.sin(t * 3 - i * 0.8)) : 0.8;
      glows.set(i, q, dark ? 0.62 : 0.42, p.seg['ai-accelerators'], a * (dark ? 0.75 : 0.45));
    });
  };

  /* ───────── flows ───────── */
  const flows: PathFlow[] = [];
  const MAXES = [520, 360, 260, 160];
  const mk = (paths: FlowPath[], i: number, size: number, speed: number, smooth: boolean, seed: number, parent = root) => {
    const f = ctx.track(new PathFlow({ paths, count: scaleCount(MAXES[i]!, ctx.tier, 16), size, speed, speedVariance: 0.2, smooth, fadeEnds: 0.07, theme: ctx.theme, seed }));
    f.object.renderOrder = 8;
    parent.add(f.object);
    flows.push(f);
    return f;
  };
  const FY = TOP + 0.09;
  // 0: HBM → PHY → L2 → SMs
  const dataPaths: FlowPath[] = [];
  for (const hx of HBM.xs)
    for (const sz of [-1, 1]) {
      const l2 = v3(hx * 0.75, FY, sz * 0.12);
      dataPaths.push({ points: [v3(hx, sliceY(HBM.layers - 1, 0) + 0.04, sz * HBM.z), v3(hx, FY, sz * 1.41), v3(hx * 0.85, FY, sz * 0.9), l2], weight: 1.3 });
    }
  smCentres.forEach((c, i) => {
    if (i % 3) return;
    const sz = Math.sign(c.z);
    dataPaths.push({ points: [v3(c.x * 0.85, FY, sz * 0.15), v3(c.x, FY, sz * 0.32), v3(c.x, FY, c.z)] });
  });
  const dataFlow = mk(dataPaths, 0, 0.045, 0.9, true, 31);
  // 1: I/O — NVLink off the outer edge, die-to-die across the seam.
  const ioPaths: FlowPath[] = [];
  for (let i = 0; i < 9; i += 2) {
    const z = -1.2 + i * 0.3;
    const pts = [v3(-1.2, FY, z * 0.6), v3(-1.73, FY, z), v3(-2.4, FY - 0.05, z * 1.15), v3(-3.6, FY - 0.08, z * 1.3)];
    ioPaths.push({ points: i % 4 ? pts.reverse() : pts, weight: 1.4 });
  }
  for (let i = 0; i < 7; i++) {
    const z = -1.2 + i * 0.4;
    const pts = [v3(1.25, FY, z * 0.4), v3(1.76, FY, z), v3(SIB - 1.76, FY, z), v3(SIB - 1.25, FY, z * 0.4)];
    ioPaths.push({ points: i % 2 ? pts.reverse() : pts, speed: 1.5 });
  }
  const ioFlow = mk(ioPaths, 1, 0.05, 1.0, true, 33);
  // 2: TSVs in the exploded hero stack (built for the exploded layout), then into the PHY.
  const topY = sliceY(HBM.layers - 1, 1);
  const tsvPaths: FlowPath[] = tsvCols
    .filter((_, i) => i % 2 === 0)
    .map(([x, z], i) => {
      const pts = [v3(x, topY, z), v3(x, DIE.y0 + 0.02, z), v3(heroStack.x + (x - heroStack.x) * 0.5, TOP + 0.05, -1.45), v3(heroStack.x * 0.75, FY, -0.15)];
      return { points: i % 2 ? pts : pts, speed: 1 };
    });
  const tsvFlow = mk(tsvPaths, 2, 0.04, 0.8, false, 35);
  // 3: inside the magnified SM — L1 / registers → Tensor Cores (in mag-local units).
  const smPaths: FlowPath[] = [];
  for (const bxc of BX) {
    smPaths.push({ points: [v3(bxc * 0.6, 0.15, 0.42), v3(bxc, 0.19, 0.3), v3(bxc, 0.19, 0.16)] });
    smPaths.push({ points: [v3(bxc, 0.2, -0.3), v3(bxc, 0.2, -0.06), v3(bxc, 0.19, 0.08)] });
  }
  const smFlow = mk(smPaths, 3, 0.036, 0.35, true, 37, mag);
  /** Flows shown per level: 0 HBM → L2 → SMs, 1 NVLink + die-to-die, 2 TSVs, 3 inside the SM. */
  const FLOW_LEVELS: readonly (readonly number[])[] = [[0, 1], [0, 1], [3], [1, 2]];

  /* ───────── labels ───────── */
  interface Lab extends PlacedLabel {
    levels: readonly number[];
  }
  const labs: Lab[] = [];
  const swatches: [LabelHandle, Tone][] = [];
  const lab = (
    levels: readonly number[],
    text: string,
    pos: Vector3,
    o: { align?: Align; kind?: 'default' | 'strong' | 'muted'; priority?: number; hotspot?: string; swatch?: Tone; object?: Group; port?: PortraitPlace } = {},
  ) => {
    const align = o.align ?? 'above';
    const h = labels.add({ text, position: pos, align, kind: o.kind ?? 'default', priority: o.priority ?? 14, ...(o.hotspot ? { hotspot: o.hotspot } : {}), ...(o.object ? { object: o.object } : {}) });
    labs.push({ h, levels, land: { pos, align, text }, port: o.port });
    if (o.swatch) swatches.push([h, o.swatch]);
    return h;
  };
  // overview
  lab([0], 'GPU 運算晶粒', v3(0, TOP + 0.1, DIE.d / 2), { align: 'below', kind: 'strong', priority: 30, hotspot: 'sm-array', swatch: T.gpu });
  lab([0], '另一顆運算晶粒', v3(SIB, TOP + 0.1, DIE.d / 2), { align: 'below', priority: 20, hotspot: 'nvlink-io', swatch: T.gpu });
  lab([0, 1], 'HBM 堆疊', v3(HBM.xs[1]!, sliceY(HBM.layers - 1, 0) + 0.05, HBM.z + HBM.d / 2), { align: 'below', priority: 22, hotspot: 'hbm', swatch: T.hbm });
  lab([0], 'SM 陣列', v3(GPC_X[1]!, TOP + 0.08, -0.8), { priority: 24, hotspot: 'sm-array', swatch: T.gpu });
  lab([0, 1], 'L2 快取', v3(0.95, TOP + 0.1, 0), { align: 'right', priority: 24, hotspot: 'l2-cache', swatch: T.sram });
  lab([0], 'NVLink I/O', v3(-1.9, TOP + 0.05, 0.2), { align: 'left', priority: 20, hotspot: 'nvlink-io', swatch: T.nvswitch });
  lab([0], '晶粒互連', v3(SIB / 2, TOP + 0.05, -1.4), { align: 'above', priority: 18, hotspot: 'nvlink-io', swatch: T.flow });
  lab([0], '中介層', v3(-2.2, DIE.y0 + 0.01, 2.2), { align: 'center', priority: 14, hotspot: 'gpu-package', swatch: T.silicon });
  // floorplan
  // Phones look along the die from its NVLink edge: these two labels sit on GPC plates instead of beside them.
  lab([1], 'GPC（SM 群組）', v3(GPC_X[0]!, TOP + 0.05, -1.32), { align: 'above', priority: 26, hotspot: 'sm-array', swatch: T.gpu, port: { pos: v3(GPC_X[0]!, TOP + 0.05, -0.8), align: 'center' } });
  lab([1], 'SM', v3(GPC_X[2]! - 0.18, TOP + 0.08, 0.8), { align: 'above', priority: 24, hotspot: 'sm-array', swatch: T.gpu });
  lab([1], 'Tensor Core（每 SM 4 個）', v3(GPC_X[3]! + 0.18, TOP + 0.1, 0.8 + 0.425), {
    align: 'right',
    priority: 22,
    hotspot: 'tensor-core',
    swatch: T.gpu,
    port: { pos: v3(GPC_X[1]!, TOP + 0.1, -0.8), align: 'center' },
  });
  lab([1], 'HBM 實體層', v3(HBM.xs[0]!, TOP + 0.05, 1.41), { align: 'below', priority: 22, hotspot: 'hbm', swatch: T.hbm });
  lab([1], 'NVLink SerDes', v3(-1.85, TOP + 0.05, 0.6), { align: 'left', priority: 22, hotspot: 'nvlink-io', swatch: T.nvswitch });
  lab([1], '晶粒互連（D2D）', v3(1.86, TOP + 0.05, -0.9), { align: 'right', priority: 20, hotspot: 'nvlink-io', swatch: T.flow });
  // SM
  const ML = (x: number, y: number, z: number) => v3(MAG.x + x, MAG.y + y, MAG.z + z);
  lab([2], '1 個 SM（放大）', ML(-0.5, -0.06, 0.6), { align: 'below', kind: 'strong', priority: 30, hotspot: 'sm-array', swatch: T.gpu });
  // On phones the side labels would leave the stage: the Tensor Core label sits on the 4th block instead.
  lab([2], 'Tensor Core ×4', ML(0.92, 0.16, 0.12), { align: 'right', priority: 28, hotspot: 'tensor-core', swatch: T.gpu, port: { pos: ML(0.72, 0.2, 0.14), align: 'center' } });
  lab([2], 'CUDA 核心', ML(-0.72, 0.17, -0.12), { align: 'left', priority: 22, hotspot: 'sm-array', swatch: pTone.core });
  lab([2], '暫存器檔案', ML(-1.0, 0.18, -0.3), { align: 'left', priority: 20, hotspot: 'sm-array', swatch: pTone.reg });
  lab([2], 'Warp 排程器', ML(0.95, 0.14, -0.43), { align: 'right', priority: 18, hotspot: 'sm-array', swatch: pTone.sched });
  lab([2], 'L1 快取／共享記憶體', ML(0.55, 0.06, 0.56), { align: 'below', priority: 22, hotspot: 'sm-array', swatch: l1Tone });
  lab([2], '晶粒上的原位置', v3(HERO_SM.x, TOP + 0.05, HERO_SM.z + 0.1), { align: 'below', kind: 'muted', priority: 12 });
  // HBM + I/O
  const hs = heroStack;
  lab([3], 'DRAM 晶粒 ×8（示意）', v3(hs.x, sliceY(HBM.layers - 1, 1) + 0.04, hs.z), { align: 'above', priority: 28, hotspot: 'hbm', swatch: T.hbm });
  lab([3], '基底晶粒（邏輯）', v3(hs.x - HBM.w / 2, sliceY(0, 1), hs.z), {
    align: 'left',
    priority: 24,
    hotspot: 'hbm',
    swatch: (p) => T.hbm(p).lerp(T.silicon(p), 0.6),
    port: { pos: v3(hs.x - HBM.w / 2 + 0.1, sliceY(0, 1), hs.z + HBM.d / 2), align: 'below' },
  });
  lab([3], 'TSV 矽穿孔', v3(hs.x + 0.5, sliceY(4, 1), hs.z + HBM.d / 2), { align: 'right', priority: 26, hotspot: 'hbm', swatch: T.power });
  lab([3], 'HBM 實體層', v3(HBM.xs[0]!, TOP + 0.05, -1.41), { align: 'right', priority: 20, hotspot: 'hbm', swatch: T.hbm });
  lab([3], 'NVLink → 交換晶片', v3(-2.5, FY, -0.3), { align: 'above', priority: 24, hotspot: 'nvlink-io', swatch: T.nvswitch, port: { pos: v3(-2.0, FY, 0.4) } });
  lab([3], '晶粒互連（D2D）', v3(SIB / 2, TOP + 0.05, 0.2), { align: 'above', priority: 20, hotspot: 'nvlink-io', swatch: T.flow });
  lab([3], 'L2 快取', v3(0.6, TOP + 0.1, 0), { align: 'above', priority: 18, hotspot: 'l2-cache', swatch: T.sram });
  labels.setMax(ctx.quality === 'low' ? 12 : 22);
  placeLabels(labs, ctx.size.portrait);

  /* ───────── hotspots ───────── */
  const own = ['sm-array', 'tensor-core', 'l2-cache', 'hbm', 'nvlink-io', 'gpu-package'];
  for (const inst of [floorplan, hbm, tsv, magParts]) ctx.picker.add(inst.mesh, { id: inst.idAt });
  ctx.picker.add(magBase, { id: 'sm-array' });
  hotspot(ctx, hl, 'sm-array', { anchor: v3(GPC_X[1]!, TOP, -0.8), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'tensor-core', { anchor: ML(0, 0.2, 0.12), pose: POSES[2]!, pickable: false });
  hotspot(ctx, hl, 'l2-cache', { anchor: v3(0.6, TOP, 0), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'hbm', { anchor: v3(hs.x, 0.5, hs.z), pose: POSES[3]!, pickable: false });
  hotspot(ctx, hl, 'nvlink-io', { anchor: v3(-1.75, TOP, 0), pose: POSES[3]!, pickable: false });
  hotspot(ctx, hl, 'gpu-package', { object: inter, anchor: v3(-2.4, DIE.y0, 2.6), pose: POSES[0]! });
  ctx.picker.add(sub, { id: 'gpu-package' });
  crossHotspots(ctx, own, v3(-1.75, TOP, 0)); // tray / rack parts are reached through NVLink

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    fl.apply(p);
    glows.setTheme(p.theme);
    dataFlow.recolor((i) => (i < 4 ? [p.seg['memory-storage'], p.flow, p.flow, p.flow] : p.flow));
    ioFlow.recolor((i) => (i < 5 ? p.seg['networking-optics'].clone().lerp(p.fg, dark ? 0.25 : 0) : p.flow));
    tsvFlow.recolor(() => [p.seg['memory-storage'], p.flow, p.flow, p.flow]);
    smFlow.recolor(() => p.flow);
    const sizes = [0.045, 0.05, 0.045, 0.036];
    flows.forEach((f, i) => {
      f.setTheme(p.theme);
      f.setSize(sizes[i]! * (dark ? 1 : 0.8));
      f.setOpacity(dark ? 1 : 0.9);
    });
    for (const [h, tone] of swatches) h.set({ swatch: `#${tone(p).getHexString()}` });
    hl.apply();
    paintGlows(p, 0);
  };
  applyPalette(ctx.palette);

  /* ───────── steps ───────── */
  let level = 0;
  let tw: Tween | null = null;
  const showLevel = (lv: number) => {
    level = lv;
    flows.forEach((f, i) => (f.object.visible = FLOW_LEVELS[lv]!.includes(i) && (i !== 2 || hbmK > 0.98) && (i !== 3 || magK > 0.98)));
    for (const l of labs) l.h.set({ visible: l.levels.includes(lv) });
    glows.object.visible = lv === 2;
    ctx.invalidate();
  };
  const animateParts = (lv: number) => {
    tw?.cancel();
    const m0 = magK;
    const h0 = hbmK;
    const m1 = lv === 2 ? 1 : 0;
    const h1 = lv === 3 ? 1 : 0;
    tw = ctx.tween.run(
      (k) => {
        magK = m0 + (m1 - m0) * k;
        hbmK = h0 + (h1 - h0) * k;
        placeMag();
        placeHbm();
        if (k >= 1) showLevel(level);
      },
      { duration: 1000, ease: 'cubicInOut', delay: 150 },
    );
  };
  for (const f of flows) f.setReduced(!ctx.animate);
  const cam = stepCamera(ctx, POSES, PORTRAIT);

  return {
    update(_dt, t) {
      for (const f of flows) if (f.object.visible) f.update(t);
      if (ctx.animate && level === 2) paintGlows(ctx.palette, t);
    },
    setStep(_i, step) {
      const lv = LEVEL[step?.id ?? 'overview'] ?? 0;
      showLevel(lv);
      animateParts(lv);
      cam.go(lv);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onQuality(_q, tier) {
      flows.forEach((f, i) => f.setCount(scaleCount(MAXES[i]!, tier, 16)));
      labels.setMax(tier.maxLabels < 20 ? 12 : 22);
    },
    onResize(size) {
      placeLabels(labs, size.portrait);
      cam.resize(size);
    },
    onMotion(animate) {
      for (const f of flows) f.setReduced(!animate);
      paintGlows(ctx.palette, 0);
    },
    dispose() {
      tw?.cancel();
      root.removeFromParent();
    },
  };
}


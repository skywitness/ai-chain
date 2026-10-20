/**
 * gpu-scale · variant `chip` — 從晶片到叢集, one continuous world at true relative scale (metres).
 *
 * Two back-to-back rows of cabinets (CDU · 4 × NVL72 · network rack) share a hot aisle. The hero
 * NVL72 rack is rolled out of the front row into the cold aisle (so its sides and rear spine show
 * through the side glass), and one compute tray is pulled out on full-extension slide rails with
 * the lid off: two superchip boards (1 CPU + 2 GPUs each) under cold plates and coolant hoses.
 * Steps zoom package → board → tray → rack → pod; on the package step the hero GPU's cold plate
 * lifts to show 2 compute dies and 8 HBM stacks on the interposer; on the rack step the hero rack's
 * tray bodies turn into an X-ray cutaway (half of it on the overview) so the rear NVLink spine,
 * busbar, manifolds and NVLink traffic read through them; on the pod step the rack rolls back into
 * its row. Each level has its own PathFlow (HBM traffic, NVLink-C2C, coolant, rack
 * NVLink, scale-out optics) that is only drawn on its step.
 * Reduced motion: static dotted flows, cuts between poses, LEDs steady.
 */
import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, type BufferGeometry, type Vector3 } from 'three';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneInstance, Tween } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  Highlighter,
  Inst,
  T,
  bx,
  crossHotspots,
  cyl,
  face,
  floor,
  frontAtlas,
  frontPlate,
  hotspot,
  mat,
  merge,
  paintRamp,
  placeLabels,
  rampTube,
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
import { DEPTH, FRONT_Z, KIND_FRONT, KIND_TONE, RACK, REAR, SLOTS, TRAY_W, U, frameGeometry, slotY, trayItems, type Kind, type RackPlace } from './rack.model';

/* ───────────────────────── layout ───────────────────────── */

const COLS = [-1.55, -0.93, -0.31, 0.31, 0.93, 1.55];
const COL_KIND = ['cdu', 'nvl', 'nvl', 'nvl', 'nvl', 'net'] as const;
const ROW_Z = 1.1;
const HERO_COL = 2;
const HERO_SLOT = 6;
const PULL = 0.9; // full-extension rails: the whole tray is out of the rack
const ROLL = 1.35; // the hero rack rolled out of its row into the cold aisle
const TRAY_D = DEPTH.compute;
const TRAY_Y = 2.34; // overhead cable trays

/** Hero tray origin (centre of its floor pan), rack at rest in its row. */
const HX = COLS[HERO_COL]!;
const HY = slotY(HERO_SLOT) - U / 2 + 0.002;
const HZ = ROW_Z + FRONT_Z - TRAY_D / 2 + PULL;
const tw = (x: number, y: number, z: number) => v3(HX + x, HY + y, HZ + z);

const BOARD_X = [-0.105, 0.105];
const GPU_DX = 0.05;
const GPU_Z = -0.2;
const CPU_Z = 0.12;
const PCB_Y = 0.006;
const HERO_GPU = { x: BOARD_X[0]! + GPU_DX, z: GPU_Z };
/** Package stack heights (exaggerated ×2–3 for legibility, 示意). */
const PK = { sub: 0.004, int: 0.0012, die: 0.0022, hbm: 0.0034, layers: 9 };
const PK_Y = PCB_Y + 0.001;
const PLATE_Y = PK_Y + PK.sub + PK.int + PK.hbm + 0.0012;

const LEVEL: Record<string, number> = { overview: 0, package: 1, superchip: 2, tray: 3, rack: 4, pod: 5 };

const P = (x: number, y: number, z: number): [number, number, number] => [x, y, z + ROLL];
const hp = tw(HERO_GPU.x, PK_Y + PK.sub + PK.int, HERO_GPU.z);
/** Board centre (superchip step): board 0, nudged toward board 1 so both stay in frame. */
const BC = P(HX - 0.105 + 0.03, HY + 0.01, HZ - 0.06);
const POSES: readonly CameraPose[] = [
  { position: [2.75, 2.85, 5.85], target: [0.12, 1.02, 1.45] },
  { position: P(hp.x + 0.06, hp.y + 0.118, hp.z + 0.098), target: P(hp.x + 0.002, hp.y + 0.002, hp.z - 0.004) },
  // From the left side, so the board's long axis (GPUs at the back, CPU at the front) runs across 16:9.
  { position: [BC[0] - 0.42, BC[1] + 0.46, BC[2] + 0.14], target: BC },
  { position: P(HX + 0.6, HY + 0.7, HZ + 0.82), target: P(HX, HY + 0.02, HZ - 0.03) },
  { position: P(HX + 2.45, 1.85, ROW_Z + 2.55), target: P(HX + 0.05, 1.08, ROW_Z) },
  { position: [3.27, 3.7, 5.43], target: [0.05, 0.85, 0.1] },
];
/** Portrait (4:5) framings: closer overviews, the board seen from the front, the rack centred. */
const PORTRAIT: readonly (CameraPose | null)[] = [
  null,
  zoomPose(POSES[1]!, 1.47),
  zoomPose({ position: [BC[0] + 0.03, BC[1] + 0.66, BC[2] + 0.44], target: [BC[0], BC[1], BC[2] + 0.03] }, 1.1),
  zoomPose(POSES[3]!, 1.47),
  { position: P(HX + 1.75, 1.75, ROW_Z + 2.75), target: P(HX + 0.12, 1.1, ROW_Z) },
  zoomPose(POSES[5]!, 1.2),
];

export const CHIP_CAMERA = {
  ...POSES[0]!,
  fov: 38,
  near: 0.006,
  far: 60,
  minDistance: 0.09,
  maxDistance: 13,
  minPolar: 0.12,
  maxPolar: 1.48,
  portrait: { position: [2.3, 4.45, 6.95] as [number, number, number], target: [-0.05, 1.15, 1.4] as [number, number, number], fov: 44 },
};

/* ───────────────────────── build ───────────────────────── */

interface Cab {
  kind: (typeof COL_KIND)[number];
  m: Matrix4;
  x: number;
  z: number;
  front: 1 | -1;
}

export function buildChip(ctx: Ctx): SceneInstance {
  const { scene, materials, labels } = ctx;
  const root = new Group();
  root.name = 'gpu-scale-chip';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const hl = new Highlighter(ctx);
  const fl = floor(ctx, 8, 0.6);
  root.add(...fl.group);
  const rig = new Group(); // the hero rack + tray (rolls in and out)
  rig.name = 'hero-rig';
  root.add(rig);
  const statics: Object3D[] = [];
  const add = <O extends Object3D>(o: O, parent: Object3D = root): O => {
    parent.add(o);
    statics.push(o);
    return o;
  };
  /** An anchor that follows the rig (rest-position coordinates). */
  const anchor = (p: Vector3): Object3D => {
    const o = new Object3D();
    o.position.copy(p);
    rig.add(o);
    return o;
  };

  const cabs: Cab[] = [];
  for (const row of [1, -1] as const)
    COLS.forEach((x, i) => cabs.push({ kind: COL_KIND[i]!, x, z: row * ROW_Z, front: row, m: mat(x, 0, row * ROW_Z, 1, 1, 1, row === 1 ? 0 : Math.PI) }));
  const hero = cabs[HERO_COL]!;
  const nvl = cabs.filter((c) => c.kind === 'nvl');
  const rk = (x: number, y: number, z: number) => v3(x, y, z).applyMatrix4(hero.m);

  const unit = ctx.track(new BoxGeometry(1, 1, 1));
  const instMat = () => ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }));
  const frameGeo = merge(ctx, frameGeometry());
  const glassGeo = ctx.track(new PlaneGeometry(RACK.d - 0.04, RACK.h - 0.2));
  glassGeo.rotateY(Math.PI / 2);
  const glassMat = materials.glass('fg', 0.06, { roughness: 0.15 });
  const atlas = frontAtlas(ctx);
  const frontMat = ctx.track(new MeshStandardMaterial({ map: atlas, roughness: 0.6, metalness: 0.2 }));
  const pipeGeo = ctx.track(cyl(REAR.manifolds.r, 1, 0, 0, 0, 'y', 12));
  const frontGeo = new Map<string, BufferGeometry>();
  const plate = (k: Kind | 'net', units: number) => {
    const key = `${k}${units}`;
    if (!frontGeo.has(key)) frontGeo.set(key, frontPlate(ctx, k === 'net' ? 'net' : KIND_FRONT[k], TRAY_W + 0.02, units * U - 0.004));
    return frontGeo.get(key)!;
  };
  const insts: Inst[] = [];
  const keep = (i: Inst, parent: Object3D) => {
    insts.push(i);
    add(i.mesh, parent);
    return i;
  };

  /** Frames, side glass, trays, fronts and rear spine for a set of rack cabinets. */
  const makeRacks = (list: readonly Cab[], parent: Object3D, skip?: ReadonlySet<number>, bodyMat: MeshStandardMaterial = instMat()) => {
    keep(new Inst(ctx, frameGeo, instMat(), list.map((c) => ({ m: c.m, tone: T.cabinet, id: c.kind === 'net' ? 'ai-pod' : 'nvl72-rack' }))), parent);
    const glass = new InstancedMesh(glassGeo, glassMat, list.length * 2);
    list.forEach((c, i) => [-1, 1].forEach((sx, k) => glass.setMatrixAt(i * 2 + k, c.m.clone().multiply(mat(sx * (RACK.w / 2 - 0.005), 0.1 + (RACK.h - 0.2) / 2, 0)))));
    glass.renderOrder = 6;
    ctx.track({ dispose: () => glass.dispose() });
    add(glass, parent);
    const racks = list.filter((c) => c.kind === 'nvl');
    const trays = trayItems(racks.map((c): RackPlace => ({ m: c.m, ...(skip ? { skip } : {}) })));
    const netFronts: InstItem[] = [];
    for (const c of list.filter((k) => k.kind === 'net'))
      for (let s = 4; s <= 31; s += 3) {
        const y = slotY(s, 2);
        trays.bodies.push({ m: c.m.clone().multiply(mat(0, y, FRONT_Z - 0.3, TRAY_W, 2 * U - 0.004, 0.6)), tone: T.chassis, id: 'ai-pod' });
        netFronts.push({ m: c.m.clone().multiply(mat(0, y, FRONT_Z + 0.002)), tone: face(T.optic, 0.55), id: 'ai-pod' });
        trays.leds.push({ pos: v3(TRAY_W / 2 - 0.035, y + 0.012, FRONT_Z + 0.008).applyMatrix4(c.m), kind: 'switch' });
      }
    const bodies = keep(new Inst(ctx, unit, bodyMat, trays.bodies), parent);
    for (const k of ['compute', 'switch', 'power', 'mgmt', 'blank'] as const)
      if (trays.fronts[k].length) keep(new Inst(ctx, plate(k, SLOTS.find((s) => s.kind === k)!.units), frontMat, trays.fronts[k]), parent);
    if (netFronts.length) keep(new Inst(ctx, plate('net', 2), frontMat, netFronts), parent);
    if (racks.length) {
      const span = (from: number, to: number) => {
        const a = slotY(from) + U / 2;
        const b = slotY(to) - U / 2;
        return { mid: (a + b) / 2, len: a - b };
      };
      const rear: InstItem[] = [];
      const pipes: InstItem[] = [];
      for (const c of racks) {
        const bb = span(REAR.busbar.from, REAR.busbar.to);
        rear.push({ m: c.m.clone().multiply(mat(REAR.busbar.x, bb.mid, REAR.busbar.z, REAR.busbar.w, bb.len, REAR.busbar.d)), tone: T.power, id: 'power' });
        const cc = span(REAR.cartridges.from, REAR.cartridges.to);
        for (const x of REAR.cartridges.xs)
          rear.push({ m: c.m.clone().multiply(mat(x, cc.mid, REAR.cartridges.z, REAR.cartridges.w, cc.len, REAR.cartridges.d)), tone: face(T.nvswitch, 0.45), id: 'cable-spine' });
        const mm = span(REAR.manifolds.from, REAR.manifolds.to);
        REAR.manifolds.xs.forEach((x, i) => pipes.push({ m: c.m.clone().multiply(mat(x, mm.mid, REAR.manifolds.z, 1, mm.len, 1)), tone: i ? T.heat : T.coolant, id: 'liquid-cooling' }));
      }
      keep(new Inst(ctx, unit, instMat(), rear), parent);
      keep(new Inst(ctx, pipeGeo, instMat(), pipes), parent);
    }
    return { leds: trays.leds, bodies };
  };
  const rowLeds = makeRacks(
    cabs.filter((c) => c !== hero && c.kind !== 'cdu'),
    root,
  ).leds;
  // The hero rack's tray bodies can turn into an X-ray cutaway (rack step) so the rear NVLink spine,
  // busbar and manifolds read through them. Transparent from the start: only opacity changes.
  const heroBodyMat = ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25, transparent: true }));
  const heroRack = makeRacks([hero], rig, new Set([HERO_SLOT]), heroBodyMat);
  const heroLeds = heroRack.leds;
  heroRack.bodies.mesh.renderOrder = 5;

  // CDU cabinets (in-row coolant distribution units).
  const cduGeo = merge(ctx, [
    rb(RACK.w - 0.02, RACK.h - 0.04, RACK.d - 0.04, 0.03, 0, RACK.h / 2, 0),
    bx(0.36, 0.22, 0.01, 0, 1.55, RACK.d / 2 - 0.01),
    bx(0.46, 0.7, 0.01, 0, 0.75, RACK.d / 2 - 0.01),
  ]);
  keep(new Inst(ctx, cduGeo, instMat(), cabs.filter((c) => c.kind === 'cdu').map((c) => ({ m: c.m, tone: face(T.coolant, 0.32), id: 'liquid-cooling' }))), root);

  // Hot-aisle coolant pipes (supply / return) from each CDU along its row, with risers to the manifolds.
  const pipeRun = (row: 1 | -1, k: 0 | 1) => {
    const z = row * (ROW_Z - RACK.d / 2 - 0.08 - k * 0.07);
    const y = 0.07 + k * 0.035;
    const g = [cyl(0.022, 2.62, (COLS[0]! + COLS[4]!) / 2 + 0.05, y, z, 'x', 10)];
    const zm = row * (ROW_Z + REAR.manifolds.z);
    const top = slotY(REAR.manifolds.to) - U / 2;
    for (const x of COLS.slice(1, 5)) {
      const mx = x + (k ? 0.25 : -0.25) * row;
      g.push(cyl(0.016, top - y, mx, (top + y) / 2, z), cyl(0.016, Math.abs(zm - z), mx, top, (zm + z) / 2, 'z'));
    }
    return g;
  };
  const supplyMat = materials.standard('coolant', { roughness: 0.4, metalness: 0.2 });
  const retMat = materials.standard('heat', { roughness: 0.4, metalness: 0.2 });
  const supply = add(new Mesh(merge(ctx, [...pipeRun(1, 0), ...pipeRun(-1, 0)]), supplyMat));
  const ret = add(new Mesh(merge(ctx, [...pipeRun(1, 1), ...pipeRun(-1, 1)]), retMat));
  hl.addMats('liquid-cooling', [supplyMat, retMat]);

  // Overhead cable trays: one ladder per row and a bridge across the hot aisle at the network racks.
  const ladders: BufferGeometry[] = [];
  for (const row of [1, -1]) {
    const z = row * ROW_Z;
    const x0 = COLS[1]! - 0.3;
    const x1 = COLS[5]! + 0.2;
    ladders.push(bx(x1 - x0, 0.012, 0.03, (x0 + x1) / 2, TRAY_Y, z - 0.15), bx(x1 - x0, 0.012, 0.03, (x0 + x1) / 2, TRAY_Y, z + 0.15));
    for (let x = x0 + 0.1; x < x1; x += 0.2) ladders.push(bx(0.02, 0.008, 0.3, x, TRAY_Y - 0.004, z));
    for (const x of COLS.slice(1)) ladders.push(bx(0.012, TRAY_Y - RACK.h, 0.012, x - 0.2, (TRAY_Y + RACK.h) / 2, z), bx(0.012, TRAY_Y - RACK.h, 0.012, x + 0.2, (TRAY_Y + RACK.h) / 2, z));
  }
  ladders.push(bx(0.03, 0.012, ROW_Z * 2, COLS[5]! - 0.15, TRAY_Y, 0), bx(0.03, 0.012, ROW_Z * 2, COLS[5]! + 0.15, TRAY_Y, 0));
  for (let z = -ROW_Z + 0.1; z < ROW_Z; z += 0.2) ladders.push(bx(0.3, 0.008, 0.02, COLS[5]!, TRAY_Y - 0.004, z));
  const ladderMat = materials.standard((p) => T.metal(p).lerp(p.optic, 0.15), { roughness: 0.5, metalness: 0.3 });
  const ladder = add(new Mesh(merge(ctx, ladders), ladderMat));
  hl.addMats('ai-pod', [ladderMat]);

  /* ───────── hero tray ───────── */
  const heroG = new Group();
  heroG.position.set(HX, HY, HZ);
  rig.add(heroG);
  const chassisMat = materials.standard(T.chassis, { roughness: 0.5, metalness: 0.35 });
  const chassis = add(
    new Mesh(
      merge(ctx, [
        bx(TRAY_W, 0.003, TRAY_D, 0, 0.0015, 0),
        bx(0.003, 0.04, TRAY_D, -TRAY_W / 2 + 0.0015, 0.02, 0),
        bx(0.003, 0.04, TRAY_D, TRAY_W / 2 - 0.0015, 0.02, 0),
        bx(TRAY_W, 0.04, 0.004, 0, 0.02, -TRAY_D / 2 + 0.002),
        bx(TRAY_W + 0.02, U - 0.004, 0.012, 0, U / 2 - 0.002, TRAY_D / 2 - 0.006),
        bx(TRAY_W - 0.02, 0.003, 0.004, 0, 0.03, 0.27),
      ]),
      chassisMat,
    ),
    heroG,
  );
  const heroFrontMat = materials.standard(KIND_TONE.compute, { map: atlas, roughness: 0.6, metalness: 0.2 });
  const heroFront = add(new Mesh(plate('compute', 1), heroFrontMat), heroG);
  heroFront.position.set(0, U / 2 - 0.002, TRAY_D / 2 + 0.0005);
  hl.addMats('compute-tray', [chassisMat, heroFrontMat]);

  // Full-extension slide rails: outer member in the rack, middle member, inner member on the tray.
  const railMat = materials.standard(T.metal, { roughness: 0.3, metalness: 0.6 });
  const rackFront = TRAY_D / 2 - PULL; // rack front plane in tray-local z
  const rails = add(
    new Mesh(
      merge(
        ctx,
        [-1, 1].flatMap((sx) => [
          bx(0.008, 0.024, 0.7, sx * (TRAY_W / 2 + 0.009), 0.02, rackFront - 0.35),
          bx(0.007, 0.02, 0.62, sx * (TRAY_W / 2 + 0.006), 0.02, rackFront + 0.02),
          bx(0.006, 0.016, TRAY_D * 0.92, sx * (TRAY_W / 2 + 0.002), 0.02, -0.02),
        ]),
      ),
      railMat,
    ),
    heroG,
  );
  hl.addMats('rack-integration', [railMat]);

  // Boards (PCB), CPU and GPU packages, LPDDR5X, cold plates.
  const pcbMat = materials.standard(T.pcb, { roughness: 0.75, metalness: 0.05 });
  const boards = add(new Mesh(merge(ctx, BOARD_X.map((x) => rb(0.2, 0.0018, 0.64, 0.004, x, PCB_Y - 0.0009, -0.05, 1))), pcbMat), heroG);
  add(new Mesh(merge(ctx, BOARD_X.flatMap((x) => [-0.3, 0, 0.24].flatMap((z) => [cyl(0.003, 0.004, x - 0.09, 0.004, z), cyl(0.003, 0.004, x + 0.09, 0.004, z)]))), chassisMat), heroG);
  const subMat = materials.standard(T.substrate, { roughness: 0.7, metalness: 0.05 });
  const gpuSubs: BufferGeometry[] = [];
  const cpuParts: BufferGeometry[] = [];
  const memParts: BufferGeometry[] = [];
  for (const b of BOARD_X) {
    for (const dx of [-GPU_DX, GPU_DX]) gpuSubs.push(rb(0.072, PK.sub, 0.068, 0.002, b + dx, PK_Y + PK.sub / 2, GPU_Z, 1));
    cpuParts.push(rb(0.05, 0.004, 0.05, 0.002, b, PK_Y + 0.002, CPU_Z, 1));
    for (const sx of [-1, 1]) for (const dz of [-0.027, -0.009, 0.009, 0.027]) memParts.push(rb(0.012, 0.0022, 0.016, 0.001, b + sx * 0.046, PK_Y + 0.0011, CPU_Z + dz, 1));
  }
  const gpuSubMesh = add(new Mesh(merge(ctx, gpuSubs), subMat), heroG);
  const cpuMat = materials.standard((p) => T.cpu(p).lerp(T.chassis(p), 0.35), { roughness: 0.5, metalness: 0.2 });
  const cpuMesh = add(new Mesh(merge(ctx, cpuParts), cpuMat), heroG);
  const memMat = materials.standard((p) => T.cpu(p).lerp(p.fg, p.theme === 'dark' ? 0.25 : 0.45), { roughness: 0.55, metalness: 0.1 });
  const memMesh = add(new Mesh(merge(ctx, memParts), memMat), heroG);
  hl.addMats('superchip', [pcbMat, cpuMat, memMat]);

  const plateMat = materials.standard(T.metal, { roughness: 0.28, metalness: 0.65 });
  const plateGeo = (w: number, d: number, x: number, z: number, y: number) => [
    rb(w, 0.011, d, 0.003, x, y + 0.0055, z, 1),
    cyl(0.0045, 0.008, x - w * 0.22, y + 0.014, z - d * 0.25),
    cyl(0.0045, 0.008, x + w * 0.22, y + 0.014, z - d * 0.25),
  ];
  const plates: BufferGeometry[] = [];
  for (const b of BOARD_X) {
    plates.push(...plateGeo(0.062, 0.062, b, CPU_Z, PK_Y + 0.0045));
    for (const dx of [-GPU_DX, GPU_DX]) if (b + dx !== HERO_GPU.x) plates.push(...plateGeo(0.084, 0.078, b + dx, GPU_Z, PLATE_Y));
  }
  const plateMesh = add(new Mesh(merge(ctx, plates), plateMat), heroG);
  const heroPlateMat = materials.standard(T.metal, { roughness: 0.28, metalness: 0.65 });
  const heroPlate = new Mesh(merge(ctx, plateGeo(0.084, 0.078, 0, 0, 0)), heroPlateMat);
  heroPlate.position.set(HERO_GPU.x, PLATE_Y, HERO_GPU.z);
  heroG.add(heroPlate);
  hl.addMats('liquid-cooling', [plateMat, heroPlateMat]);

  // The hero GPU package: interposer, 2 compute dies, 8 HBM stacks (9 slices: base die + 8 DRAM dies).
  const pkg = new Group();
  pkg.position.set(HERO_GPU.x, PK_Y + PK.sub, HERO_GPU.z);
  heroG.add(pkg);
  const interMat = materials.standard(T.silicon, { roughness: 0.3, metalness: 0.4 });
  pkg.add(new Mesh(ctx.track(rb(0.058, PK.int, 0.052, 0.0006, 0, PK.int / 2, 0, 1)), interMat));
  const dieMat = materials.standard((p) => T.gpu(p).lerp(T.silicon(p), 0.25), { roughness: 0.25, metalness: 0.35 });
  pkg.add(new Mesh(merge(ctx, [-1, 1].map((s) => rb(0.0238, PK.die, 0.027, 0.0004, s * 0.0127, PK.int + PK.die / 2, 0, 1))), dieMat));
  const sliceH = PK.hbm / PK.layers;
  const hbmSlices: InstItem[] = [];
  for (const sx of [-1, 1])
    for (const ix of [0.0066, 0.019])
      for (const sz of [-1, 1])
        for (let l = 0; l < PK.layers; l++)
          hbmSlices.push({
            m: mat(sx * ix, PK.int + sliceH * (l + 0.5), sz * 0.0185, 0.0108, sliceH * 0.82, 0.0092),
            tone: l === 0 ? (p) => T.hbm(p).lerp(T.silicon(p), 0.55) : T.hbm,
            id: 'hbm',
          });
  const hbm = new Inst(ctx, unit, instMat(), hbmSlices);
  insts.push(hbm);
  pkg.add(hbm.mesh);
  hl.addMats('gpu-package', [interMat, dieMat, subMat]);

  // NIC / DPU cards at the front; rear connectors (NVLink, busbar clip, quick disconnects).
  const ioItems: InstItem[] = [-0.175, -0.105, -0.035, 0.035, 0.105, 0.175].map((x, i) => ({
    m: mat(x, 0.012, 0.355, 0.056, 0.012, 0.1),
    tone: i === 0 || i === 5 ? face(T.muted, 0.4) : face(T.nvswitch, 0.5),
    id: 'compute-tray',
  }));
  for (const x of [-0.155, -0.055, 0.055, 0.155]) ioItems.push({ m: mat(x, 0.016, -TRAY_D / 2 + 0.016, 0.058, 0.024, 0.022), tone: T.nvswitch, id: 'cable-spine' });
  ioItems.push({ m: mat(0, 0.016, -TRAY_D / 2 + 0.016, 0.04, 0.02, 0.024), tone: T.power, id: 'power' });
  for (const b of BOARD_X)
    for (const [dx, tone] of [
      [-0.012, T.coolant],
      [0.012, T.heat],
    ] as const)
      ioItems.push({ m: mat(b + dx, 0.012, -TRAY_D / 2 + 0.014, 0.011, 0.011, 0.02), tone, id: 'liquid-cooling' });
  keep(new Inst(ctx, unit, instMat(), ioItems), heroG);

  // Coolant hoses: supply (rear QD) → GPU → GPU → CPU → return (rear QD), coloured cold → hot.
  const HOSE_Y = PLATE_Y + 0.019;
  const loops = BOARD_X.map((b) => [
    v3(b - 0.012, 0.012, -TRAY_D / 2 + 0.03),
    v3(b - 0.02, HOSE_Y, -0.33),
    v3(b - GPU_DX - 0.018, HOSE_Y, GPU_Z - 0.02),
    v3(b - GPU_DX + 0.018, HOSE_Y, GPU_Z - 0.02),
    v3(b + GPU_DX - 0.018, HOSE_Y, GPU_Z - 0.02),
    v3(b + GPU_DX + 0.018, HOSE_Y, GPU_Z - 0.02),
    v3(b + 0.055, HOSE_Y, -0.06),
    v3(b + 0.014, PK_Y + 0.02, CPU_Z - 0.016),
    v3(b - 0.014, PK_Y + 0.02, CPU_Z - 0.016),
    v3(b - 0.06, HOSE_Y, 0.02),
    v3(b - 0.03, HOSE_Y, -0.12),
    v3(b + 0.004, HOSE_Y, -0.3),
    v3(b + 0.012, 0.012, -TRAY_D / 2 + 0.03),
  ]);
  const hoseGeo = merge(
    ctx,
    loops.map((pts) => rampTube(pts, 0.0035, 96, 6).geo),
  );
  const hoseMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.05, transparent: true, opacity: 0.6, depthWrite: false }));
  const hoseMesh = add(new Mesh(hoseGeo, hoseMat), heroG);
  hoseMesh.renderOrder = 4;
  hl.addMats('liquid-cooling', [hoseMat]);
  const cool = (p: Palette) => [p.coolant, p.coolant, p.coolant.clone().lerp(p.heat, 0.45), p.coolant.clone().lerp(p.heat, 0.7), p.heat, p.heat];
  const paintHoses = (p: Palette) => {
    const tmp = rampTube(loops[0]!, 0.0035, 96, 6).geo;
    paintRamp(tmp, cool(p), 96, 6);
    const src = tmp.getAttribute('color').array as Float32Array;
    const dst = hoseGeo.getAttribute('color');
    (dst.array as Float32Array).set(src, 0);
    (dst.array as Float32Array).set(src, src.length);
    dst.needsUpdate = true;
    tmp.dispose();
  };
  hl.addInst(...insts);

  for (const o of statics) {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  }

  /* ───────── LEDs ───────── */
  const ledSets = [
    { leds: rowLeds, glows: ctx.track(new GlowSprites({ count: rowLeds.length, theme: ctx.theme })), parent: root },
    { leds: heroLeds, glows: ctx.track(new GlowSprites({ count: heroLeds.length, theme: ctx.theme })), parent: rig },
  ];
  for (const s of ledSets) s.parent.add(s.glows.object);
  const phase = [...rowLeds, ...heroLeds].map(() => ctx.rng() * Math.PI * 2);
  const ledCol = new Color();
  const paintLeds = (p: Palette, t: number) => {
    const dark = p.theme === 'dark';
    let k = 0;
    for (const s of ledSets)
      s.leds.forEach((l, i) => {
        ledCol.copy(l.kind === 'switch' ? p.flow : l.kind === 'power' ? p.power : p.pos);
        const a = ctx.animate ? 0.55 + 0.45 * Math.sin(t * (0.8 + (k % 7) * 0.35) + phase[k]!) : 0.85;
        s.glows.set(i, l.pos, dark ? 0.032 : 0.016, ledCol, (dark ? 0.9 : 0.85) * a);
        k++;
      });
  };

  /* ───────── flows ───────── */
  const flows: PathFlow[] = [];
  const MAXES = [260, 420, 260, 900, 520];
  const SIZES = [0.0013, 0.0042, 0.0055, 0.016, 0.035];
  const mkFlow = (paths: FlowPath[], i: number, speed: number, smooth: boolean, parent: Object3D) => {
    const f = ctx.track(new PathFlow({ paths, count: scaleCount(MAXES[i]!, ctx.tier, 20), size: SIZES[i]!, speed, speedVariance: 0.2, smooth, fadeEnds: 0.08, theme: ctx.theme, seed: 3 + i * 2 }));
    f.object.renderOrder = 8;
    parent.add(f.object);
    flows.push(f);
    return f;
  };

  // 0 package: HBM → nearest die edge, and across the die-to-die seam.
  const pk0 = tw(HERO_GPU.x, PK_Y + PK.sub + PK.int + PK.die + 0.0006, HERO_GPU.z);
  const pkgPaths: FlowPath[] = [];
  for (const sx of [-1, 1])
    for (const ix of [0.0066, 0.019])
      for (const sz of [-1, 1]) pkgPaths.push({ points: [pk0.clone().add(v3(sx * ix, 0.0012, sz * 0.0185)), pk0.clone().add(v3(sx * ix * 0.95, 0, sz * 0.0105)), pk0.clone().add(v3(sx * 0.0127, 0, sz * 0.002))] });
  for (const dz of [-0.008, 0, 0.008]) pkgPaths.push({ points: dz ? [pk0.clone().add(v3(-0.009, 0, dz)), pk0.clone().add(v3(0.009, 0, dz))] : [pk0.clone().add(v3(0.009, 0, 0)), pk0.clone().add(v3(-0.009, 0, 0))], speed: 1.4 });
  const pkgFlow = mkFlow(pkgPaths, 0, 0.012, true, rig);

  // 1 board: NVLink-C2C between the CPU and both GPUs on the PCB, then GPU → rear NVLink connectors.
  const brdPaths: FlowPath[] = [];
  for (const b of BOARD_X)
    for (const dx of [-GPU_DX, GPU_DX]) {
      const c2c = [tw(b, PCB_Y + 0.003, CPU_Z - 0.03), tw(b + dx * 0.6, PCB_Y + 0.003, -0.06), tw(b + dx, PCB_Y + 0.003, GPU_Z + 0.04)];
      brdPaths.push({ points: c2c }, { points: [...c2c].reverse() });
      brdPaths.push({ points: [tw(b + dx, PCB_Y + 0.003, GPU_Z - 0.04), tw(b + dx * 1.1, PCB_Y + 0.003, -0.33), tw(b + dx * 1.1, 0.016, -TRAY_D / 2 + 0.03)], speed: 1.2 });
    }
  const brdFlow = mkFlow(brdPaths, 1, 0.06, true, rig);

  // 2 tray: coolant along the hoses.
  const trayFlow = mkFlow(
    loops.map((pts) => ({ points: pts.map((q) => q.clone().add(heroG.position)), color: cool(ctx.palette) })),
    2,
    0.09,
    true,
    rig,
  );

  // 3 rack: NVLink — every compute tray → cable cartridge → switch trays (sampled), hero rack only.
  const rackPaths: FlowPath[] = [];
  const switchSlots = SLOTS.filter((s) => s.kind === 'switch');
  SLOTS.filter((s) => s.kind === 'compute' && s.slot !== HERO_SLOT).forEach((c, i) => {
    for (let j = 0; j < 3; j++) {
      const s = switchSlots[(i * 2 + j * 3) % switchSlots.length]!;
      const cx = REAR.cartridges.xs[(i + j) % 4]!;
      const pts = [
        rk(cx * 0.8, slotY(c.slot), FRONT_Z - DEPTH.compute + 0.01),
        rk(cx, slotY(c.slot), REAR.cartridges.z + 0.02),
        rk(cx, slotY(s.slot), REAR.cartridges.z + 0.02),
        rk(cx * 0.6, slotY(s.slot), FRONT_Z - DEPTH.switch + 0.01),
      ];
      rackPaths.push({ points: j % 2 ? pts.reverse() : pts });
    }
  });
  const rackFlow = mkFlow(rackPaths, 3, 0.55, false, rig);

  // 4 pod: scale-out optics — every NVL72 rack top → ladder → network rack; plus the aisle bridge.
  const podPaths: FlowPath[] = [];
  for (const c of nvl) {
    const net = cabs.find((k) => k.kind === 'net' && k.front === c.front)!;
    const up = [v3(c.x, RACK.h + 0.01, c.z), v3(c.x, TRAY_Y + 0.02, c.z), v3(net.x - 0.02, TRAY_Y + 0.02, c.z), v3(net.x, RACK.h + 0.01, c.z)];
    podPaths.push({ points: up }, { points: [...up].reverse() });
  }
  for (const dir of [1, -1]) podPaths.push({ points: [v3(COLS[5]!, TRAY_Y + 0.02, dir * ROW_Z), v3(COLS[5]!, TRAY_Y + 0.02, -dir * ROW_Z)], weight: 1.5 });
  const podFlow = mkFlow(podPaths, 4, 0.7, false, root);

  const FLOW_LEVELS: readonly (readonly number[])[] = [[1], [2], [0, 3], [0, 4], [5]];
  const recolorFlows = (p: Palette) => {
    const dark = p.theme === 'dark';
    pkgFlow.recolor(() => [p.seg['memory-storage'], p.flow]);
    brdFlow.recolor(() => p.flow);
    trayFlow.recolor(() => cool(p));
    rackFlow.recolor(() => p.flow);
    podFlow.recolor(() => p.optic);
    flows.forEach((f, i) => {
      f.setTheme(p.theme);
      f.setSize(SIZES[i]! * (dark ? 1 : 0.8));
      f.setOpacity(dark ? 1 : 0.92);
    });
  };

  /* ───────── labels ───────── */
  interface Lab extends PlacedLabel {
    levels: readonly number[];
  }
  const labs: Lab[] = [];
  const swatches: [LabelHandle, Tone][] = [];
  type LabOpts = { align?: Align; kind?: 'default' | 'strong' | 'muted'; priority?: number; hotspot?: string; swatch?: Tone; world?: boolean; port?: PortraitPlace };
  /** Labels follow the hero rig unless `world` is set. */
  const lab = (levels: readonly number[], text: string, pos: Vector3, o: LabOpts = {}) => {
    const align = o.align ?? 'above';
    const h = labels.add({
      text,
      position: pos,
      ...(o.world ? {} : { object: rig }),
      align,
      kind: o.kind ?? 'default',
      priority: o.priority ?? 12,
      ...(o.hotspot ? { hotspot: o.hotspot } : {}),
    });
    labs.push({ h, levels, land: { pos, align, text }, port: o.port });
    if (o.swatch) swatches.push([h, o.swatch]);
    return h;
  };
  const gy = (from: number, to: number) => (slotY(from) + slotY(to)) / 2;
  const pkW = (x: number, y: number, z: number) => tw(HERO_GPU.x + x, PK_Y + PK.sub + y, HERO_GPU.z + z);
  const bL = BOARD_X[0]!;
  // overview
  lab([0], 'NVL72 機櫃（72 顆 GPU）', rk(0, RACK.h + 0.03, 0.2), { kind: 'strong', priority: 30, hotspot: 'nvl72-rack' });
  lab([0], '運算托盤（抽出）', tw(TRAY_W / 2 + 0.01, U / 2, TRAY_D / 2), { align: 'right', priority: 24, hotspot: 'compute-tray', swatch: T.compute });
  lab([0], 'GPU ×4・CPU ×2', tw(-0.08, 0.04, -0.1), { align: 'left', priority: 20, hotspot: 'superchip', swatch: T.gpu });
  lab([0, 5], '叢集：多座機櫃以網路相連', v3(COLS[3]!, TRAY_Y + 0.08, -ROW_Z), { priority: 22, hotspot: 'ai-pod', swatch: T.optic, world: true });
  lab([0, 5], 'CDU', v3(COLS[0]!, RACK.h + 0.02, ROW_Z + 0.35), { priority: 16, hotspot: 'liquid-cooling', swatch: T.coolant, world: true });
  // package
  lab([1], '運算晶粒 ×2', pkW(-0.0127, PK.int + PK.die, 0.004), { align: 'left', priority: 30, hotspot: 'gpu-package', swatch: T.gpu });
  lab([1], 'HBM 堆疊 ×8', pkW(0.019, PK.int + PK.hbm, -0.0185), { align: 'right', priority: 28, hotspot: 'hbm', swatch: T.hbm });
  lab([1], '中介層（CoWoS）', pkW(0.029, PK.int * 0.5, 0.02), { align: 'right', priority: 22, hotspot: 'gpu-package', swatch: T.silicon });
  lab([1], '封裝載板', pkW(-0.034, -PK.sub * 0.5, 0.033), {
    align: 'left',
    priority: 20,
    hotspot: 'gpu-package',
    swatch: T.substrate,
    port: { pos: pkW(0, -PK.sub * 0.5, 0.034), align: 'below' },
  });
  lab([1], '晶粒間互連', pkW(0, PK.int + PK.die, 0.012), { align: 'below', priority: 18, hotspot: 'nvlink-io' });
  lab([1], '相鄰 GPU（已裝冷板）', tw(BOARD_X[0]! - GPU_DX, PLATE_Y + 0.012, GPU_Z), { align: 'above', priority: 16, hotspot: 'liquid-cooling', swatch: T.metal });
  // board
  lab([2], 'GPU', tw(bL - GPU_DX, PLATE_Y + 0.013, GPU_Z), { priority: 26, hotspot: 'gpu-package', swatch: T.gpu });
  lab([2], 'GPU', tw(bL + GPU_DX, PLATE_Y + 0.013, GPU_Z), { priority: 26, hotspot: 'gpu-package', swatch: T.gpu });
  lab([2], 'CPU', tw(bL, PK_Y + 0.02, CPU_Z), { priority: 26, hotspot: 'superchip', swatch: T.cpu });
  lab([2], 'NVLink-C2C', tw(bL + 0.02, PCB_Y + 0.004, -0.04), { align: 'right', priority: 22, hotspot: 'superchip', swatch: T.flow });
  // Phones see the board from its front edge: the title moves onto the board, the memory label under the chips.
  lab([2], 'LPDDR5X 記憶體', tw(bL - 0.052, PK_Y + 0.003, CPU_Z + 0.03), {
    align: 'left',
    priority: 18,
    hotspot: 'superchip',
    swatch: (p) => T.cpu(p).lerp(p.fg, 0.35),
    port: { pos: tw(bL - 0.046, PK_Y + 0.003, CPU_Z + 0.035), align: 'below' },
  });
  lab([2], '超級晶片主機板', tw(bL, PCB_Y, 0.27), { align: 'below', kind: 'strong', priority: 30, hotspot: 'superchip', swatch: T.pcb, port: { pos: tw(bL, PCB_Y, 0.245), align: 'center' } });
  lab([2], '冷板', tw(bL + GPU_DX + 0.04, PLATE_Y + 0.008, GPU_Z + 0.03), { align: 'right', priority: 16, hotspot: 'liquid-cooling', swatch: T.metal });
  // tray
  lab([3], '運算托盤（1U）', tw(0, 0, TRAY_D / 2), { align: 'below', kind: 'strong', priority: 30, hotspot: 'compute-tray', swatch: T.compute });
  lab([3], 'GPU ×4', tw(0.105, PLATE_Y + 0.02, GPU_Z), { priority: 24, hotspot: 'gpu-package', swatch: T.gpu });
  lab([3], 'CPU ×2', tw(0.105, PK_Y + 0.02, CPU_Z), { priority: 24, hotspot: 'superchip', swatch: T.cpu });
  lab([3], '冷板＋液冷管', tw(-0.21, HOSE_Y, -0.06), { align: 'left', priority: 22, hotspot: 'liquid-cooling', swatch: T.coolant });
  lab([3], '網路卡（scale-out）', tw(0.21, 0.02, 0.36), { align: 'right', priority: 20, hotspot: 'compute-tray', swatch: T.nvswitch });
  lab([3], 'NVLink・電源・冷卻液接頭', tw(0, 0.035, -TRAY_D / 2), { align: 'above', priority: 20, hotspot: 'cable-spine', swatch: T.nvswitch });
  lab([3], '滑軌', tw(-TRAY_W / 2 - 0.01, 0.02, rackFront + 0.1), { align: 'left', priority: 14, hotspot: 'rack-integration', swatch: T.metal });
  // rack
  const L = -RACK.w / 2 - 0.02;
  // On phones there is no room left of the rack: the group labels sit on the tray fronts instead.
  const onFront = (y: number): PortraitPlace => ({ pos: rk(-TRAY_W / 2 + 0.01, y, FRONT_Z + 0.012), align: 'right' });
  lab([4], 'NVL72 機櫃', rk(0, RACK.h + 0.03, 0.2), { kind: 'strong', priority: 30, hotspot: 'nvl72-rack' });
  lab([4], '電源架', rk(L, gy(1, 3), FRONT_Z), { align: 'left', priority: 22, hotspot: 'power', swatch: T.power, port: onFront(gy(1, 3)) });
  lab([4], '運算托盤 ×10', rk(L, gy(4, 13), FRONT_Z), { align: 'left', priority: 26, hotspot: 'compute-tray', swatch: T.compute, port: onFront(gy(4, 13)) });
  lab([4], 'NVLink 交換托盤 ×9', rk(L, gy(14, 22), FRONT_Z), { align: 'left', priority: 26, hotspot: 'nvlink-switch', swatch: T.nvswitch, port: onFront(gy(14, 22)) });
  lab([4], '運算托盤 ×8', rk(L, gy(23, 30), FRONT_Z), { align: 'left', priority: 26, hotspot: 'compute-tray', swatch: T.compute, port: onFront(gy(23, 30)) });
  lab([4], '電源架', rk(L, gy(31, 33), FRONT_Z), { align: 'left', priority: 22, hotspot: 'power', swatch: T.power, port: onFront(gy(31, 33)) });
  lab([4], 'NVLink 線纜匣', rk(RACK.w / 2, gy(9, 11), REAR.cartridges.z), { align: 'right', priority: 22, hotspot: 'cable-spine', swatch: T.flow });
  lab([4], '匯流排', rk(RACK.w / 2, gy(17, 18), REAR.busbar.z), { align: 'right', priority: 18, hotspot: 'power', swatch: T.power });
  lab([4], '液冷分歧管', rk(RACK.w / 2, gy(26, 28), REAR.manifolds.z), { align: 'right', priority: 18, hotspot: 'liquid-cooling', swatch: T.coolant });
  // pod
  lab([5], 'NVL72 機櫃 ×8（示意）', v3((COLS[1]! + COLS[4]!) / 2, RACK.h + 0.05, ROW_Z + 0.45), { kind: 'strong', priority: 30, hotspot: 'nvl72-rack', swatch: T.compute, world: true });
  lab([5], '網路機櫃', v3(COLS[5]!, RACK.h + 0.03, ROW_Z + 0.45), { priority: 18, hotspot: 'ai-pod', swatch: T.optic, world: true });
  labels.setMax(ctx.quality === 'low' ? 12 : 22);
  placeLabels(labs, ctx.size.portrait);

  /* ───────── hotspots ───────── */
  const own = ['gpu-package', 'hbm', 'superchip', 'compute-tray', 'nvlink-switch', 'nvl72-rack', 'ai-pod', 'power', 'liquid-cooling', 'cable-spine', 'rack-integration'];
  const A = (p: Vector3) => anchor(p);
  ctx.picker.add(pkg, { id: (h) => (h.object === hbm.mesh ? 'hbm' : 'gpu-package') });
  ctx.picker.add(gpuSubMesh, { id: 'gpu-package' });
  hotspot(ctx, hl, 'gpu-package', { anchor: A(tw(HERO_GPU.x, PK_Y + 0.01, HERO_GPU.z)), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'hbm', { anchor: A(pkW(0.019, PK.int + PK.hbm, -0.0185)), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'superchip', { object: boards, anchor: A(tw(bL, PK_Y + 0.02, CPU_Z)), pose: POSES[2]! });
  ctx.picker.add(cpuMesh, { id: 'superchip' });
  ctx.picker.add(memMesh, { id: 'superchip' });
  hotspot(ctx, hl, 'compute-tray', { object: chassis, anchor: A(tw(0, U, 0.2)), pose: POSES[3]! });
  ctx.picker.add(heroFront, { id: 'compute-tray' });
  hotspot(ctx, hl, 'liquid-cooling', { object: plateMesh, anchor: A(tw(-0.2, HOSE_Y, -0.06)), pose: POSES[3]! });
  for (const o of [heroPlate, hoseMesh, supply, ret]) ctx.picker.add(o, { id: 'liquid-cooling' });
  hotspot(ctx, hl, 'rack-integration', { object: rails, anchor: A(tw(-TRAY_W / 2, 0.02, rackFront + 0.1)), pose: POSES[3]! });
  hotspot(ctx, hl, 'nvl72-rack', { anchor: A(rk(0, RACK.h * 0.6, 0.4)), pose: POSES[4]!, pickable: false });
  hotspot(ctx, hl, 'nvlink-switch', { anchor: A(rk(0, gy(14, 22), FRONT_Z)), pose: POSES[4]!, pickable: false });
  hotspot(ctx, hl, 'power', { anchor: A(rk(0, gy(1, 3), FRONT_Z)), pose: POSES[4]!, pickable: false });
  hotspot(ctx, hl, 'cable-spine', { anchor: A(rk(0.15, gy(14, 18), REAR.cartridges.z)), pose: POSES[4]!, pickable: false });
  hotspot(ctx, hl, 'ai-pod', { object: ladder, anchor: v3(COLS[5]!, TRAY_Y, 0), pose: POSES[5]! });
  for (const inst of insts) if (inst !== hbm) ctx.picker.add(inst.mesh, { id: inst.idAt });
  crossHotspots(ctx, own, A(tw(HERO_GPU.x, PLATE_Y, HERO_GPU.z))); // die-level parts live inside the GPU

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    lights.apply(p);
    fl.apply(p);
    for (const s of ledSets) s.glows.setTheme(p.theme);
    recolorFlows(p);
    paintHoses(p);
    glassMat.opacity = p.theme === 'dark' ? 0.07 : 0.1;
    for (const [h, tone] of swatches) h.set({ swatch: `#${tone(p).getHexString()}` });
    hl.apply();
    paintLeds(p, 0);
  };

  /* ───────── steps ───────── */
  let level = 0;
  let anim: Tween | null = null;
  let liftK = 0;
  let rollK = 1;
  let xrayK = 0;
  const apply = () => {
    heroPlate.position.set(HERO_GPU.x, PLATE_Y + 0.05 * liftK, HERO_GPU.z - 0.07 * liftK);
    rig.position.z = ROLL * rollK;
    heroBodyMat.opacity = 1 - 0.74 * xrayK;
    heroBodyMat.depthWrite = xrayK < 0.02;
    ctx.invalidate();
  };
  const showLevel = (lv: number) => {
    level = lv;
    flows.forEach((f, i) => (f.object.visible = FLOW_LEVELS[i]!.includes(lv)));
    for (const l of labs) l.h.set({ visible: l.levels.includes(lv) });
    hoseMesh.visible = lv !== 1; // the hoses ride on the cold plates; hide them while one is lifted
    anim?.cancel();
    const l0 = liftK;
    const r0 = rollK;
    const x0 = xrayK;
    const l1 = lv === 1 ? 1 : 0;
    const r1 = lv === 5 ? 0 : 1;
    const x1 = lv === 4 ? 1 : lv === 0 ? 0.5 : 0; // rack step: X-ray; overview: a hint of it
    anim = ctx.tween.run(
      (k) => {
        liftK = l0 + (l1 - l0) * k;
        rollK = r0 + (r1 - r0) * k;
        xrayK = x0 + (x1 - x0) * k;
        apply();
      },
      { duration: 1000, ease: 'cubicInOut', delay: l1 || r1 < r0 ? 250 : 0 },
    );
  };

  applyPalette(ctx.palette);
  for (const f of flows) f.setReduced(!ctx.animate);
  apply();
  const cam = stepCamera(ctx, POSES, PORTRAIT);

  return {
    update(_dt, t) {
      for (const f of flows) if (f.object.visible) f.update(t);
      if (ctx.animate && level !== 1 && level !== 2) paintLeds(ctx.palette, t);
    },
    setStep(_i, step) {
      const lv = LEVEL[step?.id ?? 'overview'] ?? 0;
      showLevel(lv);
      cam.go(lv);
    },
    onPalette(p) {
      applyPalette(p);
    },
    onQuality(_q, tier) {
      flows.forEach((f, i) => f.setCount(scaleCount(MAXES[i]!, tier, 20)));
      labels.setMax(tier.maxLabels < 20 ? 12 : 22);
    },
    onResize(size) {
      placeLabels(labs, size.portrait);
      cam.resize(size);
    },
    onMotion(animate) {
      for (const f of flows) f.setReduced(!animate);
      paintLeds(ctx.palette, 0);
    },
    dispose() {
      anim?.cancel();
      root.removeFromParent();
    },
  };
}


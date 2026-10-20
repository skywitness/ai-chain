/**
 * gpu-scale · variant `rack` — 機櫃拆解: one NVL72-style rack exploded by function.
 *
 * The tray stack is pulled apart into its five groups (power + management, 10 compute trays,
 * 9 NVLink switch trays, 8 compute trays, power); the frame with its slide rails moves to the left;
 * the rear spine (4 NVLink cable cartridges, the busbar, supply / return manifolds) moves back, and
 * an in-row CDU feeds the manifolds through hoses. Flows: NVLink (cyan), DC power (amber), coolant
 * (blue out, red back). The last step adds illustrative supplier-role labels (示意).
 * The explode animates on entry; under reduced motion it starts exploded.
 */
import { BoxGeometry, CatmullRomCurve3, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, TubeGeometry, Vector3 } from 'three';
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
import { DEPTH, FRONT_Z, KIND_FRONT, KIND_HOTSPOT, KIND_TONE, RACK, REAR, SLOTS, TRAY_W, U, frameGeometry, slotY, trayItems, type Kind, type Slot } from './rack.model';

/* ───────────────────────── layout ───────────────────────── */

/** Exploded offsets (metres at explode = 1). */
const GROUP_DY = [0.5, 0.36, 0.2, 0.06, -0.08, 0];
const BASE_DY = -0.18;
const FRAME_DX = -1.1;
const REAR_DZ = -0.55;
const PULL_SLOT = 4;
const PULL = 0.3;
const CDU = { x: 1.05, z: -0.95, w: 0.5, h: 1.3, d: 0.75 };

const LEVEL: Record<string, number> = { overview: 0, 'rack-explode': 1, 'power-cooling': 2, 'supply-chain': 3 };
const POSES: readonly CameraPose[] = [
  { position: [2.6, 2.2, 3.25], target: [0.05, 1.22, -0.32] },
  { position: [2.06, 2.0, 3.05], target: [-0.05, 1.12, -0.25] },
  { position: [-2.05, 2.15, -3.55], target: [0.2, 1.15, -0.8] },
  { position: [2.85, 2.5, 3.6], target: [0.05, 1.2, -0.35] },
];

/** Portrait framings (4:5): the exploded rack is wider than tall, so portrait views sit a little
 * farther back than the landscape ones but crop the facility-water pipe. */
const PORTRAIT_K = 1.39;
const PORTRAIT: readonly (CameraPose | null)[] = [
  null,
  zoomPose(POSES[1]!, PORTRAIT_K),
  zoomPose(POSES[2]!, PORTRAIT_K),
  // Supplier roles: the whole assembly (frame … CDU) in view, so every role label has a place.
  { position: [4.05, 3.05, 5.25], target: [0.0, 1.05, -0.35] },
];

export const RACK_CAMERA = {
  ...POSES[0]!,
  fov: 38,
  near: 0.02,
  far: 60,
  minDistance: 1.0,
  maxDistance: 10,
  minPolar: 0.15,
  maxPolar: 1.5,
  portrait: { position: [3.47, 2.95, 4.75] as [number, number, number], target: [0.0, 1.1, -0.35] as [number, number, number] },
};

const ALIASES = { 'nvl72-rack': ['compute-tray', 'nvlink-switch', 'power', 'rack-integration', 'cable-spine'] } as const;

/* ───────────────────────── build ───────────────────────── */

export function buildRack(ctx: Ctx): SceneInstance {
  const { scene, materials, labels } = ctx;
  const root = new Group();
  root.name = 'gpu-scale-rack';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const hl = new Highlighter(ctx, ALIASES);
  const fl = floor(ctx, 5.5, 0.5);
  root.add(...fl.group);

  let explode = ctx.animate ? 0 : 1;
  const offsetOf = (s: Slot, e = explode) => v3(0, (BASE_DY + GROUP_DY[s.group]!) * e, s.slot === PULL_SLOT ? PULL * e : 0);
  /** Exploded y of a slot edge: top (edge = -1) or bottom (edge = 1). */
  const yAt = (slot: number, edge: -1 | 1, e = explode) => {
    const s = SLOTS.find((x) => x.slot === slot)!;
    return slotY(slot) + (edge * -U) / 2 + offsetOf(s, e).y;
  };

  const unit = ctx.track(new BoxGeometry(1, 1, 1));
  const instMat = () => ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }));
  const atlas = frontAtlas(ctx);
  const frontMat = ctx.track(new MeshStandardMaterial({ map: atlas, roughness: 0.6, metalness: 0.2 }));

  /* ───────── trays (exploded stack, no blank panel) ───────── */
  const ident = mat(0, 0, 0);
  const skip = new Set([SLOTS.find((s) => s.kind === 'blank')!.slot]);
  const build = () => trayItems([{ m: ident, skip, offset: (s) => offsetOf(s) }]);
  let items = build();
  const bodies = new Inst(ctx, unit, instMat(), items.bodies);
  root.add(bodies.mesh);
  const kinds: Kind[] = ['compute', 'switch', 'power', 'mgmt'];
  const fronts = kinds.map((k) => {
    const inst = new Inst(ctx, frontPlate(ctx, KIND_FRONT[k], TRAY_W + 0.02, U - 0.004), frontMat, items.fronts[k]);
    root.add(inst.mesh);
    return inst;
  });
  // Rear faces (seen in the back view): NVLink connectors, busbar clip and coolant quick-disconnects
  // on compute / switch trays; AC inlets and the busbar clip on power shelves.
  const rearPlate = (row: 'rear' | 'rear-power') => {
    const g = frontPlate(ctx, row, TRAY_W - 0.004, U - 0.006);
    g.rotateY(Math.PI);
    return g;
  };
  const backSlots = (ks: readonly Kind[]) => SLOTS.filter((s) => ks.includes(s.kind));
  const backAt = (s: Slot) => {
    const o = offsetOf(s);
    return mat(o.x, slotY(s.slot) + o.y, FRONT_Z - DEPTH[s.kind] - 0.0015 + o.z);
  };
  const backs = [
    { slots: backSlots(['compute', 'switch']), row: 'rear' as const },
    { slots: backSlots(['power']), row: 'rear-power' as const },
  ].map(({ slots, row }) => {
    const inst = new Inst(
      ctx,
      rearPlate(row),
      frontMat,
      slots.map((s) => ({ m: backAt(s), tone: KIND_TONE[s.kind], id: KIND_HOTSPOT[s.kind] })),
    );
    root.add(inst.mesh);
    return { inst, slots };
  });

  // Slide rails on the pulled-out tray (inner member moves, outer member stays with the rack).
  const railMat = materials.standard(T.metal, { roughness: 0.3, metalness: 0.6 });
  const rails = new Mesh(
    merge(ctx, [-1, 1].flatMap((sx) => [bx(0.008, 0.022, 0.78, sx * (TRAY_W / 2 + 0.008), 0, -0.02), bx(0.006, 0.016, 0.72, sx * (TRAY_W / 2 + 0.003), 0, 0.1)])),
    railMat,
  );
  root.add(rails);

  /* ───────── frame (moved aside) ───────── */
  const frameMat = materials.standard(T.cabinet, { roughness: 0.5, metalness: 0.35 });
  const frame = new Mesh(merge(ctx, frameGeometry()), frameMat);
  root.add(frame);
  const glassMat = materials.glass('fg', 0.06, { roughness: 0.15 });
  const glassGeo = merge(ctx, [-1, 1].map((sx) => bx(0.004, RACK.h - 0.2, RACK.d - 0.04, sx * (RACK.w / 2 - 0.004), 0.1 + (RACK.h - 0.2) / 2, 0)));
  const frameGlass = new Mesh(glassGeo, glassMat);
  frameGlass.renderOrder = 6;
  frame.add(frameGlass);

  /* ───────── rear spine (pulled back) ───────── */
  const rearItems: InstItem[] = [
    { m: mat(0, 0, 0), tone: T.power, id: 'power' },
    ...REAR.cartridges.xs.map(() => ({ m: mat(0, 0, 0), tone: face(T.nvswitch, 0.45), id: 'cable-spine' })),
  ];
  const rear = new Inst(ctx, unit, instMat(), rearItems);
  root.add(rear.mesh);
  const pipeGeo = ctx.track(new CylinderGeometry(REAR.manifolds.r, REAR.manifolds.r, 1, 12, 1));
  const pipeItems: InstItem[] = REAR.manifolds.xs.map((_, i) => ({ m: mat(0, 0, 0), tone: i ? T.heat : T.coolant, id: 'liquid-cooling' }));
  // Quick-disconnect stubs on the manifolds, one pair per compute tray.
  const computeSlots = SLOTS.filter((s) => s.kind === 'compute');
  const qdGeo = ctx.track(cyl(0.008, 1, 0, 0, 0, 'z', 8));
  const qdItems: InstItem[] = computeSlots.flatMap(() => REAR.manifolds.xs.map((_, i) => ({ m: mat(0, 0, 0), tone: i ? T.heat : T.coolant, id: 'liquid-cooling' })));
  const pipes = new Inst(ctx, pipeGeo, instMat(), pipeItems);
  const qds = new Inst(ctx, qdGeo, instMat(), qdItems);
  root.add(pipes.mesh, qds.mesh);

  const span = (from: number, to: number) => {
    const a = yAt(from, -1);
    const b = yAt(to, 1);
    return { mid: (a + b) / 2, len: Math.max(0.01, a - b) };
  };
  const placeRear = () => {
    const dz = REAR_DZ * explode;
    const bb = span(REAR.busbar.from, REAR.busbar.to);
    rearItems[0]!.m = mat(REAR.busbar.x, bb.mid, REAR.busbar.z + dz, REAR.busbar.w, bb.len, REAR.busbar.d);
    const cc = span(REAR.cartridges.from, REAR.cartridges.to);
    REAR.cartridges.xs.forEach((x, i) => (rearItems[i + 1]!.m = mat(x, cc.mid, REAR.cartridges.z + dz, REAR.cartridges.w, cc.len, REAR.cartridges.d)));
    const mm = span(REAR.manifolds.from, REAR.manifolds.to);
    REAR.manifolds.xs.forEach((x, i) => (pipeItems[i]!.m = mat(x, mm.mid, REAR.manifolds.z + dz, 1, mm.len, 1)));
    computeSlots.forEach((s, k) =>
      REAR.manifolds.xs.forEach((x, i) => (qdItems[k * 2 + i]!.m = mat(x * 0.86, slotY(s.slot) + offsetOf(s).y, REAR.manifolds.z + dz + 0.04, 1, 1, 0.08))),
    );
    rear.setMatrices();
    pipes.setMatrices();
    qds.setMatrices();
  };

  /* ───────── CDU + hoses + facility water ───────── */
  const cduMat = materials.standard(face(T.coolant, 0.32), { roughness: 0.45, metalness: 0.25 });
  // Cabinet with a door seam, a recessed control panel and louvred intake (CDU-local, front = +z).
  const fz = CDU.d / 2;
  const cduParts = [
    rb(CDU.w, CDU.h, CDU.d, 0.03, 0, CDU.h / 2, 0),
    bx(0.006, CDU.h - 0.12, 0.012, 0, CDU.h / 2, fz),
    bx(0.012, 0.16, 0.02, -0.035, CDU.h * 0.55, fz + 0.004),
    bx(0.012, 0.16, 0.02, 0.035, CDU.h * 0.55, fz + 0.004),
  ];
  for (let i = 0; i < 9; i++) for (const sx of [-1, 1]) cduParts.push(bx(0.2, 0.014, 0.016, sx * 0.118, 0.14 + i * 0.045, fz + 0.002));
  const cdu = new Mesh(merge(ctx, cduParts), cduMat);
  cdu.position.set(CDU.x, 0, CDU.z);
  cdu.rotation.y = -0.5;
  root.add(cdu);
  const panelMat = materials.standard((p) => (p.theme === 'dark' ? p.bg.clone().lerp(p.fg, 0.08) : p.fg.clone().lerp(p.bg, 0.12)), { roughness: 0.25, metalness: 0.1 });
  const panel = new Mesh(merge(ctx, [bx(0.2, 0.12, 0.012, -0.12, CDU.h - 0.2, fz + 0.004), bx(0.08, 0.12, 0.012, 0.12, CDU.h - 0.2, fz + 0.004)]), panelMat);
  cdu.add(panel);
  // Facility-water pipes leave through the CDU roof (to the plant: cooling towers / chillers).
  const FW = { x: [0.1, 0.19], y: 2.2, z: -0.18, back: -1.05 };
  const facility = new Mesh(
    merge(
      ctx,
      FW.x.flatMap((x) => [
        cyl(0.026, FW.y - CDU.h, x, (FW.y + CDU.h) / 2, FW.z),
        cyl(0.034, 0.05, x, CDU.h + 0.025, FW.z),
        cyl(0.026, FW.z - FW.back, x, FW.y, (FW.z + FW.back) / 2, 'z'),
        cyl(0.03, 0.06, x, FW.y, FW.z, 'x'),
      ]),
    ),
    materials.standard((p) => T.metal(p).lerp(p.coolant, 0.28), { roughness: 0.4, metalness: 0.35 }),
  );
  cdu.add(facility);
  cdu.updateMatrixWorld(true);
  const cduW = (x: number, y: number, z: number) => cdu.localToWorld(v3(x, y, z));
  const mBottom = (e = 1) => yAt(REAR.manifolds.to, 1, e);
  const manZ = REAR.manifolds.z + REAR_DZ;
  const cduPort = (k: number) => v3(CDU.x - 0.22 + k * 0.08, 0.95 - k * 0.12, CDU.z + 0.12);
  const hosePts = (i: number) => {
    const mx = REAR.manifolds.xs[i]!;
    const p0 = cduPort(i);
    const end = v3(mx, mBottom() - 0.02, manZ);
    return [p0, v3(p0.x - 0.25, p0.y - 0.35, p0.z - 0.08 - i * 0.05), v3(mx + 0.25, 0.12 + i * 0.05, manZ - 0.12 - i * 0.04), v3(mx, 0.14 + i * 0.05, manZ), end];
  };
  const hoseMats = [materials.standard('coolant', { roughness: 0.35, metalness: 0.1 }), materials.standard('heat', { roughness: 0.35, metalness: 0.1 })];
  const hoses = [0, 1].map((i) => {
    const g = ctx.track(new TubeGeometry(new CatmullRomCurve3(hosePts(i), false, 'centripetal'), 64, 0.02, 8, false));
    const m = new Mesh(g, hoseMats[i]!);
    root.add(m);
    return m;
  });
  hl.addMats('liquid-cooling', [cduMat, ...hoseMats]);
  hl.addMats('rack-integration', [frameMat, railMat]);
  hl.addInst(bodies, ...fronts, ...backs.map((b) => b.inst), rear, pipes, qds);

  /* ───────── LEDs ───────── */
  const glows = ctx.track(new GlowSprites({ count: items.leds.length + 2, theme: ctx.theme }));
  root.add(glows.object);
  const ledCol = new Color();
  const phase = items.leds.map(() => ctx.rng() * Math.PI * 2);
  const paintLeds = (p: Palette, t: number) => {
    const dark = p.theme === 'dark';
    items.leds.forEach((l, i) => {
      ledCol.copy(l.kind === 'switch' ? p.flow : l.kind === 'power' ? p.power : p.pos);
      const a = ctx.animate ? 0.6 + 0.4 * Math.sin(t * (1 + (i % 5) * 0.6) + phase[i]!) : 0.85;
      glows.set(i, l.pos, dark ? 0.034 : 0.018, ledCol, a * (dark ? 0.9 : 0.85));
    });
  };

  /* ───────── explode ───────── */
  const placeAll = () => {
    items = build();
    bodies.items.forEach((it, i) => (it.m = items.bodies[i]!.m));
    bodies.setMatrices();
    kinds.forEach((k, j) => {
      fronts[j]!.items.forEach((it, i) => (it.m = items.fronts[k][i]!.m));
      fronts[j]!.setMatrices();
    });
    for (const b of backs) {
      b.inst.items.forEach((it, i) => (it.m = backAt(b.slots[i]!)));
      b.inst.setMatrices();
    }
    const ps = SLOTS.find((s) => s.slot === PULL_SLOT)!;
    const o = offsetOf(ps);
    rails.position.set(0, slotY(PULL_SLOT) + o.y, FRONT_Z - DEPTH.compute / 2 + o.z * 0.5);
    frame.position.x = FRAME_DX * explode;
    placeRear();
    const done = explode > 0.98;
    for (const h of hoses) h.visible = done;
    paintLeds(ctx.palette, 0);
    ctx.invalidate();
  };
  placeAll();

  /* ───────── flows (built for the exploded layout) ───────── */
  const flows: PathFlow[] = [];
  const MAXES = [700, 520, 620];
  const mkFlow = (paths: FlowPath[], max: number, size: number, speed: number, smooth: boolean, seed: number) => {
    const f = ctx.track(new PathFlow({ paths, count: scaleCount(max, ctx.tier, 20), size, speed, speedVariance: 0.2, smooth, fadeEnds: 0.06, theme: ctx.theme, seed }));
    f.object.renderOrder = 8;
    root.add(f.object);
    flows.push(f);
    return f;
  };
  const yS = (s: Slot) => slotY(s.slot) + offsetOf(s, 1).y;
  const rearZ = (k: Kind, s: Slot) => FRONT_Z - DEPTH[k] + offsetOf(s, 1).z + 0.01;
  const switches = SLOTS.filter((s) => s.kind === 'switch');
  // NVLink: compute tray → cable cartridge → switch tray.
  const nvPaths: FlowPath[] = [];
  computeSlots.forEach((c, i) => {
    for (let j = 0; j < 3; j++) {
      const s = switches[(i * 2 + j * 3) % switches.length]!;
      const cx = REAR.cartridges.xs[(i + j) % 4]!;
      const cz = REAR.cartridges.z + REAR_DZ + 0.03;
      const pts = [v3(cx * 0.8, yS(c), rearZ('compute', c)), v3(cx, yS(c), cz), v3(cx, yS(s), cz), v3(cx * 0.6, yS(s), rearZ('switch', s))];
      nvPaths.push({ points: j % 2 ? pts.reverse() : pts });
    }
  });
  const nvFlow = mkFlow(nvPaths, MAXES[0]!, 0.016, 0.6, false, 21);
  // DC power: power shelves → busbar → every tray.
  const bz = REAR.busbar.z + REAR_DZ + 0.012;
  const pwPaths: FlowPath[] = [];
  const shelves = SLOTS.filter((s) => s.kind === 'power');
  SLOTS.filter((s) => s.kind === 'compute' || s.kind === 'switch').forEach((t, i) => {
    const sh = shelves[t.group <= 1 ? i % 3 : 3 + (i % 3)]!;
    pwPaths.push({ points: [v3(0, yS(sh), rearZ('power', sh)), v3(0, yS(sh), bz), v3(0, yS(t), bz), v3(0.02, yS(t), rearZ(t.kind, t))] });
  });
  const pwFlow = mkFlow(pwPaths, MAXES[1]!, 0.014, 0.55, false, 23);
  // Coolant: CDU → supply hose → supply manifold → trays → return manifold → return hose → CDU.
  const clPaths: FlowPath[] = [];
  const [sx, rx] = REAR.manifolds.xs;
  const mz = manZ + 0.005;
  computeSlots.forEach((c, i) => {
    if (i % 2) return;
    const y = yS(c);
    const tz = rearZ('compute', c);
    clPaths.push({
      points: [...hosePts(0), v3(sx!, y, mz), v3(sx! * 0.86, y, mz + 0.04), v3(-0.012, y, tz), v3(0.012, y + 0.004, tz), v3(rx! * 0.86, y, mz + 0.04), v3(rx!, y, mz), ...hosePts(1).reverse()],
    });
  });
  const clFlow = mkFlow(clPaths, MAXES[2]!, 0.018, 0.5, false, 25);
  const coolRamp = (p: Palette) => Array.from({ length: 16 }, (_, i) => (i < 8 ? p.coolant : p.heat)); // one colour per control point
  const FLOW_LEVELS: readonly (readonly number[])[] = [[1], [0, 2], [0, 2]];

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
    o: { align?: Align; kind?: 'default' | 'strong' | 'muted'; priority?: number; hotspot?: string; swatch?: Tone; port?: PortraitPlace } = {},
  ) => {
    const align = o.align ?? 'right';
    const h = labels.add({ text, position: pos, align, kind: o.kind ?? 'default', priority: o.priority ?? 14, ...(o.hotspot ? { hotspot: o.hotspot } : {}) });
    labs.push({ h, levels, land: { pos, align, text }, port: o.port });
    if (o.swatch) swatches.push([h, o.swatch]);
    return h;
  };
  const gMid = (from: number, to: number) => (yAt(from, -1, 1) + yAt(to, 1, 1)) / 2;
  const R = TRAY_W / 2 + 0.03;
  const FZ = FRONT_Z;
  lab([0, 1], '管理交換器', v3(R, gMid(0, 0), FZ), { priority: 12, kind: 'muted' });
  lab([0, 1], '電源架 ×3（示意）', v3(R, gMid(1, 3), FZ), { priority: 24, hotspot: 'power', swatch: T.power });
  lab([0, 1], '運算托盤 ×10', v3(R, gMid(4, 13), FZ), { priority: 28, hotspot: 'compute-tray', swatch: T.compute });
  lab([0, 1], 'NVLink 交換托盤 ×9', v3(R, gMid(14, 22), FZ), { priority: 28, hotspot: 'nvlink-switch', swatch: T.nvswitch });
  lab([0, 1], '運算托盤 ×8', v3(R, gMid(23, 30), FZ), { priority: 28, hotspot: 'compute-tray', swatch: T.compute });
  lab([0, 1], '電源架 ×3（示意）', v3(R, gMid(31, 33), FZ), { priority: 24, hotspot: 'power', swatch: T.power });
  lab([0, 1], '機櫃框架', v3(FRAME_DX + 0.16, RACK.h + 0.04, 0.3), { align: 'above', priority: 22, hotspot: 'rack-integration', swatch: T.cabinet });
  lab([0, 1], '滑軌', v3(-TRAY_W / 2 - 0.02, slotY(PULL_SLOT) + offsetOf(SLOTS[PULL_SLOT]!, 1).y, FZ + PULL - 0.1), { align: 'left', priority: 18, hotspot: 'rack-integration', swatch: T.metal });
  lab([1], 'NVLink 線纜匣', v3(REAR.cartridges.xs[0]!, gMid(4, 4) + 0.05, REAR.cartridges.z + REAR_DZ), {
    align: 'above',
    priority: 24,
    hotspot: 'cable-spine',
    swatch: T.flow,
    port: { pos: v3(0, 1.2, REAR.cartridges.z + REAR_DZ), align: 'center' }, // phones: on the cartridges, between the tray labels
  });
  lab([0], 'CDU', v3(CDU.x, CDU.h + 0.04, CDU.z), { align: 'above', priority: 20, hotspot: 'liquid-cooling', swatch: T.coolant });
  // back view
  lab([2], '電源架：交流 → 直流', v3(-0.24, gMid(1, 3), FRONT_Z - DEPTH.power), { align: 'left', priority: 26, hotspot: 'power', swatch: T.power });
  lab([2], '電源架', v3(-0.24, gMid(31, 33), FRONT_Z - DEPTH.power), { align: 'left', priority: 22, hotspot: 'power', swatch: T.power });
  lab([2], '匯流排（直流）', v3(REAR.busbar.x, gMid(12, 12), REAR.busbar.z + REAR_DZ - 0.02), { align: 'left', priority: 24, hotspot: 'power', swatch: T.power });
  lab([2], '分歧管：供水', v3(REAR.manifolds.xs[0]!, gMid(20, 20), manZ), { align: 'right', priority: 24, hotspot: 'liquid-cooling', swatch: T.coolant });
  lab([2], '分歧管：回水', v3(REAR.manifolds.xs[1]!, gMid(8, 8), manZ), { align: 'left', priority: 24, hotspot: 'liquid-cooling', swatch: T.heat });
  // On the CDU body (not above it), so it never crowds the busbar / manifold labels at roof height.
  lab([2], 'CDU', v3(CDU.x, CDU.h * 0.6, CDU.z), { align: 'center', priority: 26, hotspot: 'liquid-cooling', swatch: T.coolant });
  lab([2], '設施水迴路', cduW(0.145, FW.y + 0.04, FW.z), { align: 'above', priority: 16, hotspot: 'liquid-cooling', kind: 'muted' });
  lab([2], '盲插快接頭', v3(0, gMid(27, 27), FRONT_Z - DEPTH.compute), { align: 'below', priority: 14, hotspot: 'liquid-cooling' });
  // supply-chain roles (示意)
  // Phones: the frame and CDU sit at the stage edges, so their role labels move onto the parts and shorten.
  const pullY = slotY(PULL_SLOT) + offsetOf(SLOTS[PULL_SLOT]!, 1).y;
  lab([3], '整櫃組裝・測試：ODM（示意）', v3(FRAME_DX + 0.16, RACK.h + 0.04, 0.3), {
    align: 'above',
    priority: 30,
    hotspot: 'rack-integration',
    swatch: T.cabinet,
    port: { pos: v3(FRAME_DX + 0.1, 0.35, 0.3), align: 'center', text: '整櫃組裝 ODM（示意）' },
  });
  lab([3], '滑軌（示意）', v3(-TRAY_W / 2 - 0.02, pullY, FZ + PULL - 0.1), {
    align: 'left',
    priority: 22,
    hotspot: 'rack-integration',
    swatch: T.metal,
    port: { pos: v3(-TRAY_W / 2, pullY + 0.03, FZ + PULL), align: 'above' },
  });
  lab([3], '電源：電源架・匯流排（示意）', v3(R, gMid(1, 3), FZ), { priority: 26, hotspot: 'power', swatch: T.power });
  lab([3], '主機板・GPU 模組（示意）', v3(R, gMid(4, 13), FZ), { priority: 24, hotspot: 'compute-tray', swatch: T.compute, port: { text: '主機板・GPU（示意）' } });
  lab([3], '交換晶片・網通（示意）', v3(R, gMid(14, 22), FZ), { priority: 24, hotspot: 'nvlink-switch', swatch: T.nvswitch });
  // On the cable cartridges themselves (a side label read as naming the manifold next to them).
  const cartZ = REAR.cartridges.z + REAR_DZ;
  lab([3], '線纜・連接器（示意）', v3(0.13, 1.0, cartZ), {
    align: 'center',
    priority: 22,
    hotspot: 'cable-spine',
    swatch: T.flow,
    port: { pos: v3(0.13, yAt(REAR.cartridges.to, 1, 1), cartZ), align: 'below' },
  });
  lab([3], '散熱：冷板・分歧管・CDU（示意）', v3(CDU.x, CDU.h + 0.04, CDU.z), {
    align: 'above',
    priority: 26,
    hotspot: 'liquid-cooling',
    swatch: T.coolant,
    port: { pos: v3(CDU.x, 0, CDU.z), align: 'below', text: '散熱・CDU（示意）' },
  });
  labels.setMax(ctx.quality === 'low' ? 12 : 22);
  placeLabels(labs, ctx.size.portrait);

  /* ───────── hotspots ───────── */
  const own = ['compute-tray', 'nvlink-switch', 'power', 'liquid-cooling', 'cable-spine', 'rack-integration', 'nvl72-rack'];
  for (const inst of [bodies, ...fronts, ...backs.map((b) => b.inst), rear, pipes, qds]) ctx.picker.add(inst.mesh, { id: inst.idAt });
  hotspot(ctx, hl, 'compute-tray', { anchor: v3(0, gMid(4, 13), FZ), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'nvlink-switch', { anchor: v3(0, gMid(14, 22), FZ), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'power', { anchor: v3(0, gMid(1, 3), 0), pose: POSES[2]!, pickable: false });
  hotspot(ctx, hl, 'cable-spine', { anchor: v3(0, gMid(14, 22), REAR.cartridges.z + REAR_DZ), pose: POSES[1]!, pickable: false });
  hotspot(ctx, hl, 'liquid-cooling', { object: cdu, anchor: v3(CDU.x, CDU.h, CDU.z), pose: POSES[2]! });
  for (const h of hoses) ctx.picker.add(h, { id: 'liquid-cooling' });
  hotspot(ctx, hl, 'rack-integration', { object: frame, anchor: v3(FRAME_DX, RACK.h * 0.6, 0), pose: POSES[3]! });
  ctx.picker.add(rails, { id: 'rack-integration' });
  hotspot(ctx, hl, 'nvl72-rack', { anchor: v3(0, gMid(0, 0) + 0.1, 0), pose: POSES[0]!, pickable: false });
  crossHotspots(ctx, own, v3(0, gMid(4, 13), FZ)); // package / die parts live in the compute trays

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    fl.apply(p);
    glows.setTheme(p.theme);
    nvFlow.recolor(() => p.flow);
    pwFlow.recolor(() => p.power);
    clFlow.recolor(() => coolRamp(p));
    const sizes = [0.016, 0.014, 0.02];
    flows.forEach((f, i) => {
      f.setTheme(p.theme);
      f.setSize(sizes[i]! * (dark ? 1 : 0.8));
      f.setOpacity(dark ? 1 : 0.9);
    });
    glassMat.opacity = dark ? 0.07 : 0.09;
    for (const [h, tone] of swatches) h.set({ swatch: `#${tone(p).getHexString()}` });
    hl.apply();
    paintLeds(p, 0);
  };
  applyPalette(ctx.palette);

  /* ───────── steps ───────── */
  let level = 0;
  let boom: Tween | null = null;
  const showFlows = () => {
    flows.forEach((f, i) => (f.object.visible = explode > 0.98 && FLOW_LEVELS[i]!.includes(level)));
    ctx.invalidate();
  };
  const showLevel = (lv: number) => {
    level = lv;
    for (const l of labs) l.h.set({ visible: l.levels.includes(lv) && explode > 0.98 });
    showFlows();
  };
  const runExplode = () => {
    if (explode >= 1) return;
    boom?.cancel();
    const from = explode;
    boom = ctx.tween.run(
      (k) => {
        explode = from + (1 - from) * k;
        placeAll();
        if (explode > 0.98) showLevel(level);
      },
      { duration: 1500, delay: 350, ease: 'cubicInOut' },
    );
  };
  for (const f of flows) f.setReduced(!ctx.animate);
  const cam = stepCamera(ctx, POSES, PORTRAIT);

  return {
    update(_dt, t) {
      for (const f of flows) if (f.object.visible) f.update(t);
      if (ctx.animate) paintLeds(ctx.palette, t);
    },
    setStep(_i, step) {
      const lv = LEVEL[step?.id ?? 'overview'] ?? 0;
      showLevel(lv);
      runExplode();
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
      if (!animate && explode < 1) {
        boom?.cancel();
        explode = 1;
        placeAll();
        showLevel(level);
      }
      paintLeds(ctx.palette, 0);
    },
    dispose() {
      boom?.cancel();
      root.removeFromParent();
    },
  };
}

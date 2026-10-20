/**
 * network / scale-out — servers → leaf → spine, a two-tier leaf-spine (Clos) fabric.
 *
 * 8 GPU servers × 4 GPUs (示意), each GPU with its own NIC; 4 leaf and 4 spine switches, every
 * leaf wired to every spine.
 *  - 總覽 / 葉脊架構: top-of-rack wiring (each leaf serves two servers); packets cross racks via
 *    leaf → spine → leaf. 葉脊架構 highlights one 3-hop path.
 *  - 軌道最佳化: the server→leaf links morph to rail-optimised wiring (GPU n of every server →
 *    leaf n), recoloured by rail; a ring All-Reduce plays on every rail (Reduce-Scatter then
 *    All-Gather, N−1 steps each), one switch hop per step.
 *  - 壅塞熱點: cross-rail elephant flows need the spine; two of them hash onto the same uplink
 *    (heat, a growing queue), then adaptive routing moves one to an idle spine and it cools.
 * Portrait stages use a 2 × 4 server layout. Reduced motion: dotted static streams, the ring and
 * the congestion show their end state (the hotspot plus the idle alternative path).
 */
import { BoxGeometry, Color, CylinderGeometry, Group, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneContext } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  addFloor,
  clamp01,
  commit,
  easeInOut,
  hotspotCard,
  instanced,
  orbitPose,
  placeAt,
  placeLink,
  Polylines,
  rounded,
  smooth,
  stepIdOf,
  v3,
  type Built,
} from './common';

/* ───────────────────────── constants ───────────────────────── */

const NSV = 8; // servers
const NR = 4; // GPUs (= rails) per server
const NL = 4; // leaves
const NP = 4; // spines
const SV_W = 1.0;
const SV_H = 0.34;
const SV_D = 0.9;
const Y_SV = 0.2;
const Y_LEAF = 2.0;
const Y_SPINE = 3.7;
const LEAF = { w: 1.56, h: 0.18, d: 0.5 };
const SPN = { w: 1.3, h: 0.18, d: 0.5 };
/** Rail colours: --chart-1, -3, -5, -7 (blue, green, pink, lavender). */
const RAIL_CHART = [1, 3, 5, 7] as const;
const HOP_T = 0.8; // s per ring step
const RING_STEPS = 2 * (NSV - 1);
const RING_HOLD = 1.8;
const JAM_T = 9; // s per congestion cycle
const HOT = { leaf: 0, spine: 1, alt: 2 };
const EXAMPLE = { si: 1, sr: 1, di: 6, dr: 2, k: 2 };

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

interface Layout {
  portrait: boolean;
  sv: Vector3[];
  leaf: Vector3[];
  spine: Vector3[];
}
function makeLayout(portrait: boolean): Layout {
  if (!portrait)
    return {
      portrait,
      sv: range(NSV).map((i) => v3((i - 3.5) * 1.18, Y_SV, 0)),
      leaf: range(NL).map((j) => v3((j - 1.5) * 2.36, Y_LEAF, 0)),
      spine: range(NP).map((k) => v3((k - 1.5) * 1.75, Y_SPINE, -0.4)),
    };
  return {
    portrait,
    sv: range(NSV).map((i) => v3(((i % 4) - 1.5) * 1.18, Y_SV, i < 4 ? 0.85 : -0.85)),
    leaf: range(NL).map((j) => v3(j % 2 === 0 ? -1.18 : 1.18, Y_LEAF, j < 2 ? 0.85 : -0.85)),
    spine: range(NP).map((k) => v3((k - 1.5) * 1.42, Y_SPINE, 0)),
  };
}

const POSES: Record<'land' | 'port', Record<string, CameraPose>> = {
  land: {
    'leaf-spine': orbitPose([0, 1.9, 0], 12.2, -6, 15),
    'rail-optimized': orbitPose([0, 1.85, 0.2], 12.0, 4, 24),
    congestion: orbitPose([-0.6, 2.2, 0], 11.0, 14, 13),
    'leaf-switch': orbitPose([0, 2.0, 0], 8.4, 8, 14),
    'spine-switch': orbitPose([0, 3.5, -0.4], 8.4, 8, 8),
    rail: orbitPose([0, 1.2, 0.2], 9.6, 6, 22),
  },
  port: {
    'leaf-spine': orbitPose([0, 1.9, 0], 12.6, -10, 22),
    'rail-optimized': orbitPose([0, 1.6, 0], 12.6, 10, 30),
    congestion: orbitPose([0.1, 2.2, 0.2], 12.4, 16, 18),
    'leaf-switch': orbitPose([0, 2.0, 0], 10, 14, 20),
    'spine-switch': orbitPose([0, 3.4, 0], 10, 14, 14),
    rail: orbitPose([0, 1.3, 0], 11, 12, 28),
  },
};

/* ───────────────────────── builder ───────────────────────── */

export function build(ctx: SceneContext): Built {
  const { materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'network-scale-out';
  ctx.scene.add(root);
  const lights = addStudioLights(ctx.scene, ctx.palette);
  const floor = addFloor(ctx, root, { w: 16, d: 9, step: 0.5, y: 0, glow: [12, 5] });
  let L = makeLayout(ctx.size.aspect < 1);

  /* ───────── positions ───────── */
  const gpuP = (i: number, r: number) => L.sv[i]!.clone().add(v3((r - 1.5) * 0.22, -0.035, 0.13));
  const nicP = (i: number, r: number) => L.sv[i]!.clone().add(v3((r - 1.5) * 0.22, SV_H / 2 - 0.05, -0.2));
  const nicTop = (i: number, r: number) => L.sv[i]!.clone().add(v3((r - 1.5) * 0.22, SV_H / 2 + 0.01, -0.2));
  const torLeaf = (i: number) => Math.floor(i / 2);
  const torSlot = (i: number, r: number) => (i % 2) * NR + r;
  const leafDown = (j: number, slot: number) => L.leaf[j]!.clone().add(v3((slot - 3.5) * 0.17, -LEAF.h / 2, 0.05));
  const leafUp = (j: number, k: number) => L.leaf[j]!.clone().add(v3((k - 1.5) * 0.32, LEAF.h / 2, -0.05));
  const spineDown = (k: number, j: number) => L.spine[k]!.clone().add(v3((j - 1.5) * 0.26, -SPN.h / 2, 0));
  const leafOf = (rail: boolean, i: number, r: number) => (rail ? r : torLeaf(i));
  const slotOf = (rail: boolean, i: number, r: number) => (rail ? i : torSlot(i, r));
  const lift = (p: Vector3, dy: number) => p.clone().add(v3(0, dy, 0));

  /** GPU (si, sr) → GPU (di, dr), through spine k when the leaves differ. */
  const route = (rail: boolean, si: number, sr: number, di: number, dr: number, k: number): Vector3[] => {
    const ls = leafOf(rail, si, sr);
    const ld = leafOf(rail, di, dr);
    const pts = [gpuP(si, sr), nicP(si, sr), nicTop(si, sr), leafDown(ls, slotOf(rail, si, sr)), lift(leafDown(ls, slotOf(rail, si, sr)), 0.06)];
    if (ls !== ld) {
      pts.push(lift(leafUp(ls, k), -0.06), leafUp(ls, k), spineDown(k, ls), lift(spineDown(k, ls), 0.06));
      pts.push(lift(spineDown(k, ld), 0.06), spineDown(k, ld), leafUp(ld, k), lift(leafUp(ld, k), -0.06));
    }
    pts.push(lift(leafDown(ld, slotOf(rail, di, dr)), 0.06), leafDown(ld, slotOf(rail, di, dr)), nicTop(di, dr), nicP(di, dr), gpuP(di, dr));
    return rounded(pts, 0.05, 3);
  };
  /** One ring step on rail r: GPU (i, r) → leaf r → GPU (i+1, r). */
  const hop = (i: number, r: number) => route(true, i, r, (i + 1) % NSV, r, 0);

  /* ───────── servers ───────── */
  const housingGeo = ctx.track(new RoundedBoxGeometry(SV_W, SV_H, SV_D, 2, 0.04));
  const housings = instanced(ctx, housingGeo, materials.glass('seg:servers-systems', 0.16, { roughness: 0.35 }), NSV);
  housings.renderOrder = 2;
  const metal = materials.standard((p) => p.bg.clone().lerp(p.fg, p.theme === 'dark' ? 0.2 : 0.24), { metalness: 0.3, roughness: 0.45 });
  const bases = instanced(ctx, ctx.track(new RoundedBoxGeometry(SV_W + 0.04, 0.04, SV_D + 0.04, 1, 0.015)), metal, NSV);
  const gpuMat = materials.standard((p) => (p.theme === 'dark' ? p.seg['ai-accelerators'].clone() : p.seg['ai-accelerators'].clone().lerp(p.bg, 0.2)), {
    metalness: 0.25,
    roughness: 0.42,
  });
  materials.bind(gpuMat, 'emissive', 'seg:ai-accelerators', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.3 : 0.05));
  const gpus = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.17, 0.05, 0.24, 1, 0.012)), gpuMat, NSV * NR, true);
  const nicMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.45 }));
  const nics = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.14, 0.04, 0.11, 1, 0.01)), nicMat, NSV * NR, true);
  root.add(housings, bases, gpus, nics);

  /* ───────── switches ───────── */
  const swMat = materials.standard((p) => (p.theme === 'dark' ? p.seg['networking-optics'].clone() : p.seg['networking-optics'].clone().lerp(p.bg, 0.22)), {
    metalness: 0.3,
    roughness: 0.38,
  });
  materials.bind(swMat, 'emissive', 'seg:networking-optics', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.32 : 0.05));
  const leaves = instanced(ctx, ctx.track(new RoundedBoxGeometry(LEAF.w, LEAF.h, LEAF.d, 2, 0.035)), swMat, NL);
  const spines = instanced(ctx, ctx.track(new RoundedBoxGeometry(SPN.w, SPN.h, SPN.d, 2, 0.035)), swMat, NP);
  const panelMat = materials.standard((p) => p.bg.clone().lerp(p.fg, p.theme === 'dark' ? 0.55 : 0.75), { metalness: 0.5, roughness: 0.3 });
  const panels = instanced(ctx, ctx.track(new BoxGeometry(1, 0.05, 0.02)), panelMat, NL + NP);
  root.add(leaves, spines, panels);

  /* ───────── links ───────── */
  const linkGeo = ctx.track(new CylinderGeometry(1, 1, 1, 8, 1, true));
  const linkMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const down = instanced(ctx, linkGeo, linkMat, NSV * NR, true);
  const up = instanced(ctx, linkGeo, linkMat, NL * NP, true);
  root.add(down, up);
  const HOT_U = HOT.leaf * NP + HOT.spine;
  const ALT_U = HOT.leaf * NP + HOT.alt;

  // Server outlines (crisp top edges) — rebuilt with the layout.
  let outlines: Polylines | null = null;

  /* ───────── congestion queue ───────── */
  const queueMat = materials.standard('heat', { metalness: 0.1, roughness: 0.5 });
  materials.bind(queueMat, 'emissive', 'heat', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.5 : 0.15));
  const queue = instanced(ctx, ctx.track(new RoundedBoxGeometry(0.11, 0.075, 0.11, 1, 0.015)), queueMat, 6);
  queue.count = 0;
  root.add(queue);

  const glows = ctx.track(new GlowSprites({ count: NSV * NR + 4, theme: ctx.theme }));
  root.add(glows.object);
  const G_HOT = NSV * NR;
  const G_ALT = G_HOT + 1;

  /* ───────── state ───────── */
  let sid = stepIdOf(ctx, ctx.step);
  let morph = 0; // 0 = top-of-rack, 1 = rail-optimised
  let ringStep = 0;
  let ringT = 0;
  let jamT = 0;
  let hotK = 0;
  let fixK = 0;
  let exK = 0;
  let leafHot = 0;
  let spineHot = 0;
  let railHot = 0;
  let jamHot = 0;
  const mode = () => (sid === 'rail-optimized' ? 'rail' : sid === 'congestion' ? 'jam' : 'tor');

  /* ───────── flows (rebuilt with the layout) ───────── */
  interface Flows {
    tor: PathFlow;
    ex: PathFlow;
    ring: PathFlow;
    rail: PathFlow;
    f13: PathFlow;
    f2hot: PathFlow;
    f2fix: PathFlow;
  }
  let F: Flows | null = null;
  const TOR_MAX = 1100;
  const RAIL_MAX = 700;
  const EL_MAX = 560;
  const exRoute = () => route(false, EXAMPLE.si, EXAMPLE.sr, EXAMPLE.di, EXAMPLE.dr, EXAMPLE.k);
  /**
   * The elephant flows ride just in front of their links (every step camera looks from +z): the
   * congested uplink thickens past the particle radius and would otherwise swallow its packets.
   */
  const FWD = v3(0, 0, 0.055);
  const front = (pts: Vector3[]) => pts.map((q) => q.add(FWD));
  const elephants = (alt: boolean) => ({
    f1: front(route(true, 0, 0, 5, 2, HOT.spine)),
    f2: front(route(true, 3, 0, 6, 3, alt ? HOT.alt : HOT.spine)),
    f3: front(route(true, 2, 1, 7, 0, 3)),
  });
  const makeFlows = () => {
    if (F) for (const f of Object.values(F)) f.dispose();
    const rng = ctx.rng;
    const torPaths: FlowPath[] = [];
    for (let n = 0; n < 36; n++) {
      const si = rng.int(NSV);
      let di = rng.int(NSV);
      if (di === si) di = (di + 3) % NSV;
      torPaths.push({ points: route(false, si, rng.int(NR), di, rng.int(NR), rng.int(NP)) });
    }
    const hops: FlowPath[] = [];
    for (let r = 0; r < NR; r++) for (let i = 0; i < NSV; i++) hops.push({ points: hop(i, r) });
    const lens = hops.map((h) => {
      let s = 0;
      for (let q = 1; q < h.points.length; q++) s += (h.points[q] as Vector3).distanceTo(h.points[q - 1] as Vector3);
      return s;
    });
    const base = { smooth: false, samples: 96, theme: ctx.theme, fadeEnds: 0.04 };
    const e0 = elephants(false);
    const e1 = elephants(true);
    F = {
      tor: new PathFlow({ ...base, paths: torPaths, count: TOR_MAX, size: 0.05, speed: 1.0, speedVariance: 0.15, seed: 21 }),
      ex: new PathFlow({ ...base, paths: [{ points: exRoute() }], count: 70, size: 0.07, speed: 1.0, speedVariance: 0.05, seed: 22 }),
      ring: new PathFlow({
        ...base,
        paths: hops.map((h, i) => ({ ...h, speed: (lens[i] ?? 1) / HOP_T })),
        count: hops.length * 6,
        size: 0.075,
        speed: 1,
        speedVariance: 0,
        sizeVariance: 0.1,
        mode: 'once',
        onceOffsets: [0, -0.025, -0.05, -0.075, -0.1, -0.125],
        byLength: false,
        fadeEnds: 0.08,
      }),
      rail: new PathFlow({ ...base, paths: hops, count: RAIL_MAX, size: 0.045, speed: 0.8, seed: 23 }),
      f13: new PathFlow({ ...base, paths: [{ points: e0.f1 }, { points: e0.f3 }], count: EL_MAX, size: 0.06, speed: 0.9, speedVariance: 0.08, seed: 24 }),
      f2hot: new PathFlow({ ...base, paths: [{ points: e0.f2 }], count: EL_MAX / 2, size: 0.06, speed: 0.9, speedVariance: 0.08, seed: 25 }),
      f2fix: new PathFlow({ ...base, paths: [{ points: e1.f2 }], count: EL_MAX / 2, size: 0.06, speed: 0.9, speedVariance: 0.08, seed: 25 }),
    };
    for (const f of Object.values(F)) {
      ctx.track(f);
      root.add(f.object);
    }
    setCounts();
    paintFlows(ctx.palette);
    setReduced(!ctx.animate);
  };
  const setCounts = () => {
    if (!F) return;
    F.tor.setCount(scaleCount(TOR_MAX, ctx.tier, 250));
    F.rail.setCount(scaleCount(RAIL_MAX, ctx.tier, 120));
    F.f13.setCount(scaleCount(EL_MAX, ctx.tier, 160));
    F.f2hot.setCount(scaleCount(EL_MAX / 2, ctx.tier, 80));
    F.f2fix.setCount(scaleCount(EL_MAX / 2, ctx.tier, 80));
  };
  const setReduced = (r: boolean) => {
    if (F) for (const f of Object.values(F)) f.setReduced(r);
  };
  const railColor = (r: number, p: Palette) => p.chart[(RAIL_CHART[r] ?? 1) - 1] ?? p.flow;
  const paintFlows = (p: Palette) => {
    if (!F) return;
    const dark = p.theme === 'dark';
    F.tor.recolor(() => p.flow);
    F.ex.recolor(() => p.highlight);
    F.ring.recolor((i) => railColor(Math.floor(i / NSV), p));
    F.rail.recolor((i) => railColor(Math.floor(i / NSV), p));
    F.f13.recolor(() => p.flow);
    F.f2hot.recolor(() => p.flow);
    F.f2fix.recolor(() => p.flow);
    for (const f of Object.values(F)) f.setTheme(p.theme);
    F.tor.setSize(dark ? 0.085 : 0.062);
    F.ex.setSize(dark ? 0.11 : 0.095);
    F.ring.setSize(dark ? 0.15 : 0.115);
    F.rail.setSize(dark ? 0.06 : 0.055);
    F.rail.setOpacity(dark ? 0.45 : 0.4);
    for (const f of [F.f13, F.f2hot, F.f2fix]) f.setSize(dark ? 0.09 : 0.07);
  };

  /* ───────── placement ───────── */
  const tmpM = new Matrix4();
  const WHITE_BOOST = new Color(1.6, 1.6, 1.6);
  const place = () => {
    for (let i = 0; i < NSV; i++) {
      placeAt(housings, i, L.sv[i]!);
      placeAt(bases, i, L.sv[i]!.clone().add(v3(0, -SV_H / 2 - 0.02, 0)));
      for (let r = 0; r < NR; r++) {
        placeAt(gpus, i * NR + r, gpuP(i, r));
        placeAt(nics, i * NR + r, nicP(i, r));
      }
    }
    for (let j = 0; j < NL; j++) {
      placeAt(leaves, j, L.leaf[j]!);
      panels.setMatrixAt(j, tmpM.makeScale(LEAF.w * 0.8, 1, 1).setPosition(L.leaf[j]!.x, L.leaf[j]!.y, L.leaf[j]!.z + LEAF.d / 2 + 0.01));
    }
    for (let k = 0; k < NP; k++) {
      placeAt(spines, k, L.spine[k]!);
      panels.setMatrixAt(NL + k, tmpM.makeScale(SPN.w * 0.8, 1, 1).setPosition(L.spine[k]!.x, L.spine[k]!.y, L.spine[k]!.z + SPN.d / 2 + 0.01));
    }
    for (const m of [housings, bases, gpus, nics, leaves, spines, panels]) commit(m);
    for (let j = 0; j < NL; j++) for (let k = 0; k < NP; k++) placeLink(up, j * NP + k, leafUp(j, k), spineDown(k, j), linkR(j * NP + k));
    commit(up);
    for (let n = 0; n < 6; n++) placeAt(queue, n, leafUp(HOT.leaf, HOT.spine).add(v3(-0.16, 0.05 + n * 0.09, 0.16)));
    commit(queue);
    queue.count = Math.round(6 * hotK);
    placeDown();
    if (outlines) {
      outlines.object.removeFromParent();
      outlines.object.geometry.dispose();
    }
    outlines = new Polylines(
      ctx,
      L.sv.map((c) => {
        const x = SV_W / 2;
        const y = c.y + SV_H / 2;
        const z = SV_D / 2;
        return [v3(c.x - x, y, c.z - z), v3(c.x + x, y, c.z - z), v3(c.x + x, y, c.z + z), v3(c.x - x, y, c.z + z), v3(c.x - x, y, c.z - z)];
      }),
    );
    outlines.object.renderOrder = 3;
    root.add(outlines.object);
  };
  const linkR = (u: number) => 0.016 + (u === HOT_U ? 0.022 * hotK : 0) + (u === ALT_U ? 0.008 * fixK : 0);
  const A = new Vector3();
  const B = new Vector3();
  const placeDown = () => {
    const m = easeInOut(clamp01(morph));
    for (let i = 0; i < NSV; i++)
      for (let r = 0; r < NR; r++) {
        A.copy(leafDown(torLeaf(i), torSlot(i, r)));
        B.copy(leafDown(r, i));
        placeLink(down, i * NR + r, nicTop(i, r), A.lerp(B, m), 0.011);
      }
    commit(down);
  };

  /* ───────── paint ───────── */
  const cLink = new Color();
  const cUp = new Color();
  const tmp = new Color();
  const exDown = new Set([EXAMPLE.si * NR + EXAMPLE.sr, EXAMPLE.di * NR + EXAMPLE.dr]);
  const exUp = new Set([torLeaf(EXAMPLE.si) * NP + EXAMPLE.k, torLeaf(EXAMPLE.di) * NP + EXAMPLE.k]);
  const paint = () => {
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    const m = clamp01(morph);
    cLink.copy(p.fg).lerp(p.bg, dark ? 0.5 : 0.55);
    cUp.copy(p.seg['networking-optics']).lerp(p.fg, dark ? 0.25 : 0.1).lerp(p.bg, dark ? 0.25 : 0.3);
    for (let i = 0; i < NSV; i++)
      for (let r = 0; r < NR; r++) {
        const d = i * NR + r;
        tmp.copy(cLink).lerp(railColor(r, p), m);
        if (exDown.has(d)) tmp.lerp(p.highlight, exK);
        down.setColorAt(d, tmp);
        nics.setColorAt(d, tmp.copy(p.muted).lerp(p.fg, 0.3).lerp(railColor(r, p), 0.25 + 0.75 * m * (0.6 + 0.4 * railHot)));
      }
    for (let u = 0; u < NL * NP; u++) {
      tmp.copy(cUp);
      if (exUp.has(u)) tmp.lerp(p.highlight, exK);
      if (u === HOT_U) tmp.lerp(p.heat, hotK);
      if (u === ALT_U) tmp.lerp(p.pos, fixK);
      up.setColorAt(u, tmp);
      if (u === HOT_U || u === ALT_U) placeLink(up, u, leafUp(Math.floor(u / NP), u % NP), spineDown(u % NP, Math.floor(u / NP)), linkR(u));
    }
    commit(down);
    commit(up);
    commit(nics);
    queue.count = Math.round(6 * hotK);
    // GPU glows: All-Reduce progress on the rail step; a faint ambient glow otherwise.
    const prog = mode() === 'rail' ? (ctx.animate ? clamp01((ringStep + ringT / HOP_T) / RING_STEPS) : 1) : 0;
    for (let g = 0; g < NSV * NR; g++) {
      const a = (dark ? 0.18 : 0.08) + (dark ? 0.55 : 0.4) * prog + 0.4 * railHot * (mode() !== 'tor' ? 1 : 0);
      const c = mode() === 'tor' ? p.seg['ai-accelerators'] : railColor(g % NR, p);
      glows.set(g, gpuP(Math.floor(g / NR), g % NR).add(v3(0, 0.05, 0)), 0.4 + 0.25 * prog, c, a);
      gpus.setColorAt(g, tmp.setScalar(1).lerp(WHITE_BOOST, 0.25 * prog));
    }
    commit(gpus);
    const hu = leafUp(HOT.leaf, HOT.spine).lerp(spineDown(HOT.spine, HOT.leaf), 0.35);
    glows.set(G_HOT, hu, 0.9 + 0.5 * hotK + 0.4 * jamHot, p.heat, (dark ? 0.8 : 0.55) * Math.max(hotK, 0.6 * jamHot));
    const au = leafUp(HOT.leaf, HOT.alt).lerp(spineDown(HOT.alt, HOT.leaf), 0.5);
    glows.set(G_ALT, au, 0.8, p.pos, (dark ? 0.6 : 0.4) * fixK);
    for (let n = G_ALT + 1; n < NSV * NR + 4; n++) glows.set(n, [0, 0, 0], 0.01, p.bg, 0);
    // Switch emphasis when hovered.
    for (let j = 0; j < NL; j++) leaves.setColorAt(j, tmp.setScalar(1 + 0.35 * leafHot));
    for (let k = 0; k < NP; k++) spines.setColorAt(k, tmp.setScalar(1 + 0.35 * spineHot));
    commit(leaves);
    commit(spines);
  };

  /* ───────── labels ───────── */
  const tierLabels: LabelHandle[] = [
    labels.add({ text: '脊交換器（Spine）', position: [0, 0, 0], align: 'left', kind: 'strong', priority: 30, hotspot: 'spine-switch' }),
    labels.add({ text: '葉交換器（Leaf）', position: [0, 0, 0], align: 'left', kind: 'strong', priority: 30, hotspot: 'leaf-switch' }),
    labels.add({ text: 'GPU 伺服器', position: [0, 0, 0], align: 'left', kind: 'strong', priority: 30 }),
  ];
  const railTags = range(NL).map((j) =>
    labels.add({ text: `軌道 ${j + 1}`, position: [0, 0, 0], align: 'center', kind: 'tag', priority: 22, visible: false, hotspot: 'rail' }),
  );
  const hopTags = ['第 1 跳：葉', '第 2 跳：脊', '第 3 跳：葉'].map((text) =>
    labels.add({ text, position: [0, 0, 0], align: 'above', offset: [0, -6], priority: 32, visible: false }),
  );
  const hotLabel = labels.add({ text: '壅塞熱點', position: [0, 0, 0], align: 'left', offset: [-12, 0], kind: 'strong', priority: 34, visible: false, hotspot: 'congestion' });
  const altLabel = labels.add({ text: '改走空閒路徑', position: [0, 0, 0], align: 'right', offset: [12, 0], priority: 33, visible: false });
  const note = labels.add({ text: '', position: [0, -0.2, 1.2], align: 'below', kind: 'muted', priority: 40, always: true, visible: false });
  labels.setMax(18);

  const placeLabels = () => {
    const sx = Math.min(...L.sv.map((c) => c.x)) - SV_W / 2 - 0.15;
    const lx = Math.min(...L.leaf.map((c) => c.x)) - LEAF.w / 2 - 0.15;
    const px = Math.min(...L.spine.map((c) => c.x)) - SPN.w / 2 - 0.15;
    if (L.portrait) {
      // Narrow stage: no room at the sides (labels must stay inside the stage at 320–400 px), so
      // the spine title sits above its row, the leaf title in the gap between the two front
      // leaves, and the server title on the floor in front of the front row.
      tierLabels[0]!.set({ position: [0, Y_SPINE + SPN.h / 2 + 0.08, 0], align: 'above' });
      tierLabels[1]!.set({ position: [0, Y_LEAF, 0.85 + LEAF.d / 2], align: 'center' });
      tierLabels[2]!.set({ position: [0, Y_SV - SV_H / 2, 0.85 + SV_D / 2 + 0.05], align: 'below' });
    } else if (ctx.size.width < 640) {
      // Small landscape stage (a phone at 4:3): titles left of the rows would leave the stage, so
      // they go above the spine row, between the two middle leaves and under the server row.
      tierLabels[0]!.set({ position: [0, Y_SPINE + SPN.h / 2 + 0.08, L.spine[0]!.z], align: 'above' });
      tierLabels[1]!.set({ position: [0, Y_LEAF, LEAF.d / 2], align: 'center' });
      tierLabels[2]!.set({ position: [0, Y_SV - SV_H / 2, SV_D / 2 + 0.05], align: 'below' });
    } else {
      tierLabels[0]!.set({ position: [px, Y_SPINE, L.spine[0]!.z], align: 'left' });
      tierLabels[1]!.set({ position: [lx, Y_LEAF, 0], align: 'left' });
      tierLabels[2]!.set({ position: [sx, Y_SV, 0], align: 'left' });
    }
    railTags.forEach((h, j) => h.set({ position: L.leaf[j]!.clone().add(v3(0, 0, LEAF.d / 2 + 0.03)) }));
    hopTags[0]!.set({ position: L.leaf[torLeaf(EXAMPLE.si)]!.clone().add(v3(0, LEAF.h / 2, 0)) });
    hopTags[1]!.set({ position: L.spine[EXAMPLE.k]!.clone().add(v3(0, SPN.h / 2, 0)) });
    hopTags[2]!.set({ position: L.leaf[torLeaf(EXAMPLE.di)]!.clone().add(v3(0, LEAF.h / 2, 0)) });
    hotLabel.set({ position: leafUp(HOT.leaf, HOT.spine).lerp(spineDown(HOT.spine, HOT.leaf), 0.45) });
    altLabel.set({ position: leafUp(HOT.leaf, HOT.alt).lerp(spineDown(HOT.alt, HOT.leaf), 0.5) });
    note.set({ position: [0, -0.15, L.portrait ? 2.5 : 0.9] });
  };

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    lights.apply(p);
    floor.apply(p);
    glows.setTheme(p.theme);
    paintFlows(p);
    if (outlines) {
      for (let i = 0; i < outlines.count; i++) outlines.set(i, p.seg['servers-systems'], p.theme === 'dark' ? 0.55 : 0.7);
      outlines.commit();
    }
    railTags.forEach((h, j) => h.set({ swatch: p.css[`chart-${RAIL_CHART[j] ?? 1}`] ?? '' }));
    tierLabels[0]!.set({ swatch: p.css['seg-networking-optics'] ?? '' });
    tierLabels[1]!.set({ swatch: p.css['seg-networking-optics'] ?? '' });
    tierLabels[2]!.set({ swatch: p.css['seg-ai-accelerators'] ?? '' });
    hotLabel.set({ swatch: p.css['scene-heat'] ?? '' });
    altLabel.set({ swatch: p.css['c-pos'] ?? '' });
    hopTags.forEach((h) => h.set({ swatch: p.css['scene-highlight'] ?? '' }));
    paint();
  };

  /* ───────── layout (re)build ───────── */
  const relayout = () => {
    place();
    makeFlows();
    placeLabels();
    applyPalette(ctx.palette);
    registerHotspots();
    applyMode(false);
  };

  /* ───────── hotspots ───────── */
  const stepIndex = (id: string) => ctx.json.steps?.findIndex((s) => s.id === id) ?? -1;
  const goStep = (id: string) => {
    const i = stepIndex(id);
    if (i >= 0 && i !== ctx.step) ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index: i } }));
  };
  const hotTween = (set: (v: number) => void, from: number, to: number) =>
    ctx.tween.run(
      (k) => {
        set(from + (to - from) * k);
        paint();
      },
      { duration: 220, fade: true },
    );
  const poses = () => POSES[L.portrait ? 'port' : 'land'];
  let unpick: (() => void)[] = [];
  const registerHotspots = () => {
    for (const u of unpick) u();
    unpick = [];
    hotspots.register('leaf-switch', {
      object: leaves,
      anchor: L.leaf[1]!.clone().add(v3(0, 0.2, 0)),
      pose: poses()['leaf-switch']!,
      card: (hit) =>
        hotspotCard(ctx, 'leaf-switch', hit?.instanceId !== undefined ? { subtitle: mode() === 'tor' ? `葉交換器 ${hit.instanceId + 1}：連接伺服器 ${hit.instanceId * 2 + 1}、${hit.instanceId * 2 + 2}` : `葉交換器 ${hit.instanceId + 1}＝軌道 ${hit.instanceId + 1}` } : {}),
      onHighlight: (on) => hotTween((v) => (leafHot = v), leafHot, on ? 1 : 0),
    });
    hotspots.register('spine-switch', {
      object: spines,
      anchor: L.spine[1]!.clone().add(v3(0, 0.2, 0)),
      pose: poses()['spine-switch']!,
      card: () => hotspotCard(ctx, 'spine-switch'),
      onHighlight: (on) => hotTween((v) => (spineHot = v), spineHot, on ? 1 : 0),
    });
    hotspots.register('rail', {
      object: nics,
      anchor: L.leaf[0]!.clone().lerp(L.sv[0]!, 0.5),
      pose: poses()['rail']!,
      card: (hit) =>
        hotspotCard(ctx, 'rail', hit?.object === nics && hit.instanceId !== undefined ? { subtitle: `伺服器 ${Math.floor(hit.instanceId / NR) + 1} 的第 ${(hit.instanceId % NR) + 1} 號網卡 → 軌道 ${(hit.instanceId % NR) + 1}` } : {}),
      onHighlight: (on) => hotTween((v) => (railHot = v), railHot, on ? 1 : 0),
    });
    unpick.push(ctx.picker.add(down, { id: 'rail' }));
    hotspots.register('all-reduce', {
      object: gpus,
      anchor: L.leaf[1]!.clone().lerp(L.sv[3]!, 0.5),
      pose: poses()['rail-optimized']!,
      card: (hit) =>
        hotspotCard(
          ctx,
          'all-reduce',
          hit?.instanceId !== undefined ? { subtitle: `伺服器 ${Math.floor(hit.instanceId / NR) + 1}・第 ${(hit.instanceId % NR) + 1} 號 GPU（軌道 ${(hit.instanceId % NR) + 1}）` } : {},
        ),
      onHighlight: (on) => hotTween((v) => (railHot = v), railHot, on ? 1 : 0),
      onSelect: (source) => {
        if (source !== 'pointer' && source !== 'touch') goStep('rail-optimized');
      },
    });
    hotspots.register('congestion', {
      anchor: leafUp(HOT.leaf, HOT.spine).lerp(spineDown(HOT.spine, HOT.leaf), 0.45),
      pose: poses()['congestion']!,
      card: () => hotspotCard(ctx, 'congestion'),
      onHighlight: (on) => hotTween((v) => (jamHot = v), jamHot, on ? 1 : 0),
      onSelect: (source) => {
        if (source !== 'pointer' && source !== 'touch') goStep('congestion');
      },
    });
    unpick.push(ctx.picker.add(up, { id: ({ instanceId }) => (instanceId === HOT_U ? 'congestion' : 'spine-switch') }));
  };

  /* ───────── modes / steps ───────── */
  let morphTween: { cancel(): void } | null = null;
  let exTween: { cancel(): void } | null = null;
  const RING_TEXT = (s: number) =>
    s < NSV - 1 ? `All-Reduce：Reduce-Scatter 第 ${s + 1}／${NSV - 1} 步` : s < RING_STEPS ? `All-Reduce：All-Gather 第 ${s - NSV + 2}／${NSV - 1} 步` : '梯度同步完成 → 各 GPU 更新權重';
  const applyJam = () => {
    // 0–4.5 s: ECMP collision builds; 4.5–9 s: adaptive routing moves flow 2 to the idle spine.
    const t = jamT;
    hotK = t < JAM_T / 2 ? smooth(0.2, 2.0, t) : 1 - smooth(JAM_T / 2 + 0.2, JAM_T / 2 + 1.8, t);
    fixK = t < JAM_T / 2 ? 0 : smooth(JAM_T / 2, JAM_T / 2 + 0.7, t);
    if (t > JAM_T - 0.6) fixK *= 1 - smooth(JAM_T - 0.6, JAM_T, t);
    if (F) {
      F.f2hot.setOpacity(1 - fixK);
      F.f2fix.setOpacity(fixK);
    }
    note.set({ text: fixK > 0.5 ? '適應性路由：把其中一條流量改派到空閒的脊交換器' : 'ECMP 雜湊碰撞：兩條大流量擠進同一條上行鏈路' });
    hotLabel.set({ visible: hotK > 0.3 });
    altLabel.set({ visible: fixK > 0.3 });
  };
  const applyMode = (animateMorph: boolean) => {
    const md = mode();
    const target = md === 'tor' ? 0 : 1;
    morphTween?.cancel();
    if (animateMorph && morph !== target) {
      const from = morph;
      morphTween = ctx.tween.run(
        (k) => {
          morph = from + (target - from) * k;
          placeDown();
          paint();
        },
        { duration: 1300, ease: 'cubicInOut' },
      );
    } else {
      morph = target;
      placeDown();
    }
    const exOn = sid === 'leaf-spine';
    exTween?.cancel();
    const exFrom = exK;
    exTween = ctx.tween.run(
      (k) => {
        exK = exFrom + ((exOn ? 1 : 0) - exFrom) * k;
        paint();
      },
      { duration: 400, fade: true },
    );
    if (F) {
      F.tor.object.visible = md === 'tor';
      F.ex.object.visible = exOn;
      F.ring.object.visible = md === 'rail';
      F.rail.object.visible = md === 'jam';
      F.f13.object.visible = F.f2hot.object.visible = F.f2fix.object.visible = md === 'jam';
    }
    railTags.forEach((h) => h.set({ visible: md !== 'tor' }));
    hopTags.forEach((h) => h.set({ visible: exOn }));
    ringStep = 0;
    ringT = 0;
    jamT = 0;
    if (md === 'jam') {
      if (ctx.animate) applyJam();
      else {
        hotK = 1;
        fixK = 1;
        if (F) {
          F.f2hot.setOpacity(1);
          F.f2fix.setOpacity(0);
        }
        hotLabel.set({ visible: true });
        altLabel.set({ visible: true });
        note.set({ text: 'ECMP 雜湊碰撞形成熱點；適應性路由會改走空閒的脊交換器' });
      }
    } else {
      hotK = fixK = 0;
      hotLabel.set({ visible: false });
      altLabel.set({ visible: false });
    }
    if (md === 'rail') {
      note.set({ text: ctx.animate ? RING_TEXT(0) : 'All-Reduce：沿每條軌道環狀傳遞（Reduce-Scatter → All-Gather）' });
      if (F) {
        F.ring.setReduced(!ctx.animate);
        if (ctx.animate) F.ring.setTime(0);
      }
    }
    note.set({ visible: md !== 'tor' || exOn, ...(exOn ? { text: '任兩台伺服器之間：葉 → 脊 → 葉，最多三台交換器' } : {}) });
    paint();
  };
  const showStep = (i: number) => {
    sid = stepIdOf(ctx, i);
    applyMode(true);
    const pose = poses()[sid];
    ctx.setPose(pose ?? ctx.homePose);
  };

  relayout();

  return {
    anchor: [0, 2, 0.4],
    update(dt, t) {
      if (!F) return;
      F.tor.update(t);
      F.ex.update(t);
      F.rail.update(t);
      F.f13.update(t);
      F.f2hot.update(t);
      F.f2fix.update(t);
      if (!ctx.animate) return;
      const md = mode();
      if (md === 'rail') {
        ringT += dt;
        const dur = ringStep < RING_STEPS ? HOP_T : RING_HOLD;
        if (ringT >= dur) {
          ringT -= dur;
          ringStep = (ringStep + 1) % (RING_STEPS + 1);
          note.set({ text: RING_TEXT(ringStep) });
        }
        F.ring.object.visible = ringStep < RING_STEPS;
        F.ring.setTime(ringT);
        paint();
      } else if (md === 'jam') {
        jamT = (jamT + dt) % JAM_T;
        applyJam();
        paint();
      }
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
      applyMode(false);
    },
    onResize(size) {
      const portrait = size.aspect < 1;
      if (portrait !== L.portrait) {
        L = makeLayout(portrait);
        relayout();
        ctx.setPose(poses()[sid] ?? ctx.homePose, { duration: 0 });
      } else placeLabels(); // the small-landscape title placement depends on the stage width
    },
    dispose() {
      morphTween?.cancel();
      exTween?.cancel();
      for (const u of unpick) u();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}


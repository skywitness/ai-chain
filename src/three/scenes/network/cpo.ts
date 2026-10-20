/**
 * network / cpo — where the signal turns into light: copper DAC vs pluggable optics vs CPO.
 *
 * Three bays, each a cut-away slice of a switch (ASIC at the back, front panel at the front):
 *  ① 銅纜 DAC: PCB traces → front-panel cage → passive copper cable → a neighbour a few metres
 *     away. Electrical all the way (flow-colour particles).
 *  ② 可插拔光模組 (drawn half pulled out so its parts are visible): PCB traces → module edge →
 *     DSP → laser (E/O) → fibre connector → fibre to a spool (long reach). Particles turn
 *     optic-coloured at the laser.
 *  ③ CPO: eight optical engines on the ASIC package (two per side), E/O within millimetres; fibres
 *     routed around the package edge to the front-panel connectors; an external laser source (ELS)
 *     at the panel feeding continuous light to every engine (thin lines, inbound optic particles).
 * Behind the bays a comparison card shows, per bay, energy per bit (heat colour, the pluggable bar
 * split into its DSP share — what LPO removes) and reach (chart colour). Heights are 示意 only.
 * Portrait stages stack the bays (each rotated so its front panel faces right) and turn the card.
 * Reduced motion: static dotted streams.
 */
import { CatmullRomCurve3, Color, Group, Mesh, TorusGeometry, TubeGeometry, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneContext } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import { addFloor, commit, hotspotCard, instanced, orbitPose, placeAt, Polylines, rounded, stepIdOf, v3, type Built } from './common';

const BOARD = { w: 2.3, d: 2.6 };
const PANEL_Z = BOARD.d / 2;
const Y_TOP = 0.06; // board top
const SPACING = 2.85;
const PORT_GAP = 3.3;
/** Portrait: the x of the screen's centre line (between the card at the left and the spools). */
const PORT_X = -0.75;

/* Comparison card (bay-local z; the card itself follows the middle bay's transform). */
const BAR_Z = -2.2;
const CARD_Z = BAR_Z - 0.42;
const CARD_H = 2.25;
const BAR_W = 0.34;
const BAR_DX = 0.24; // power bar at −DX, reach bar at +DX
/** 示意: relative heights only (no figures). Energy per bit: DAC < CPO < pluggable; reach: DAC short. */
const POWER_H = [0.36, 1.85, 0.72];
const DSP_SHARE = 0.78; // top part of the pluggable power bar: the DSP's share (LPO removes it)
const REACH_H = [0.28, 1.5, 1.5];

type Kind = 'dac' | 'pluggable' | 'cpo';
const KINDS: readonly Kind[] = ['dac', 'pluggable', 'cpo'];
const TITLES: Record<Kind, string> = { dac: '① 銅纜 DAC', pluggable: '② 可插拔光模組', cpo: '③ CPO 共同封裝光學' };
const BAR_TEXT: Record<Kind, string> = { dac: '省電・距離短', pluggable: '耗電・距離長', cpo: '省電・距離長' };
const HOTSPOT_OF: Record<Kind, string> = { dac: 'dac', pluggable: 'pluggable', cpo: 'cpo-engine' };

const LAND: Record<string, CameraPose> = {
  'copper-optics': orbitPose([-1.55, 0.45, 0.75], 9.4, -14, 34),
  cpo: orbitPose([1.3, 0.5, 0.5], 10.4, 16, 36),
  dac: orbitPose([-SPACING + 0.2, 0.3, 1.3], 5.2, 12, 34),
  pluggable: orbitPose([0, 0.3, 1.5], 4.2, 18, 30),
  'cpo-engine': orbitPose([SPACING, 0.2, -0.2], 4.0, 8, 52),
  'laser-source': orbitPose([SPACING, 0.25, 1.0], 4.0, 24, 34),
  'power-per-bit': orbitPose([0, 1.0, BAR_Z], 7.8, 0, 14),
};
const PORT: Record<string, CameraPose> = {
  'copper-optics': orbitPose([-0.8, 0.3, -2.1], 11.0, 0, 56),
  cpo: orbitPose([-0.7, 0.4, 2.85], 8.4, 0, 52),
  dac: orbitPose([-0.2, 0.3, -PORT_GAP], 5.8, 0, 48),
  pluggable: orbitPose([0.2, 0.3, 0.1], 5.4, 0, 46),
  'cpo-engine': orbitPose([-1.3, 0.2, PORT_GAP], 4.6, 0, 60),
  'laser-source': orbitPose([0.2, 0.25, PORT_GAP], 4.6, 20, 42),
  'power-per-bit': orbitPose([-3.1, 0.9, 0], 9.0, 70, 26),
};

/* ───────────────────────── builder ───────────────────────── */

export function build(ctx: SceneContext): Built {
  const { materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'network-cpo';
  ctx.scene.add(root);
  const lights = addStudioLights(ctx.scene, ctx.palette);
  const floor = addFloor(ctx, root, { w: 15, d: 11, step: 0.5, y: 0, cz: 0.4, glow: [10, 7] });
  let portrait = ctx.size.aspect < 1;

  /* ───────── shared materials / geometry ───────── */
  const dk = (p: Palette) => p.theme === 'dark';
  const boardMat = materials.standard((p) => p.bg.clone().lerp(p.seg['servers-systems'], dk(p) ? 0.2 : 0.1).lerp(p.fg, dk(p) ? 0.07 : 0.05), {
    metalness: 0.1,
    roughness: 0.72,
  });
  const metal = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.24 : 0.3), { metalness: 0.35, roughness: 0.42 });
  const substrateMat = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.3 : 0.4).lerp(p.pos, 0.14), { metalness: 0.2, roughness: 0.55 });
  const dieMat = materials.standard((p) => (dk(p) ? p.seg['networking-optics'].clone() : p.seg['networking-optics'].clone().lerp(p.bg, 0.15)), {
    metalness: 0.45,
    roughness: 0.3,
  });
  materials.bind(dieMat, 'emissive', 'seg:networking-optics', (c, p) => c.multiplyScalar(dk(p) ? 0.3 : 0.05));
  const copperMat = materials.standard((p) => p.power.clone().lerp(p.bg, 0.12), { metalness: 0.65, roughness: 0.3 });
  const darkMat = materials.standard((p) => p.bg.clone().lerp(p.fg, dk(p) ? 0.1 : 0.6), { metalness: 0.2, roughness: 0.6 });
  const opticMat = materials.standard('optic', { metalness: 0.2, roughness: 0.35 });
  materials.bind(opticMat, 'emissive', 'optic', (c, p) => c.multiplyScalar(dk(p) ? 0.55 : 0.18));
  // Fibres a little lighter than the optic particles, so the light pulses read on top of them.
  const fibreMat = materials.standard((p) => p.optic.clone().lerp(p.bg, dk(p) ? 0.35 : 0.42), { metalness: 0.1, roughness: 0.4 });
  materials.bind(fibreMat, 'emissive', 'optic', (c, p) => c.multiplyScalar(dk(p) ? 0.18 : 0.04));
  const heatMat = materials.standard((p) => (dk(p) ? p.heat.clone() : p.heat.clone().lerp(p.bg, 0.1)), { metalness: 0.1, roughness: 0.5 });
  materials.bind(heatMat, 'emissive', 'heat', (c, p) => c.multiplyScalar(dk(p) ? 0.22 : 0.04));
  const reachMat = materials.standard((p) => (dk(p) ? p.chart[0]!.clone() : p.chart[0]!.clone().lerp(p.bg, 0.1)), { metalness: 0.1, roughness: 0.5 });
  materials.bind(reachMat, 'emissive', 'chart:1', (c, p) => c.multiplyScalar(dk(p) ? 0.22 : 0.04));
  const dspShareMat = materials.glass('heat', 0.28, { roughness: 0.5 });
  const moduleGlass = materials.glass('fg', 0.12, { roughness: 0.3 });
  // The card: a faint dark pane on the dark theme, a pale paper-like pane on the light theme.
  const cardGlass = materials.glass((p) => (dk(p) ? p.fg.clone() : p.bg.clone().lerp(p.fg, -0.8)), 0.045, { roughness: 0.5 });
  const GLOWS = 16;
  const glows = ctx.track(new GlowSprites({ count: GLOWS, theme: ctx.theme }));
  root.add(glows.object);

  const box = (w: number, h: number, d: number, r = 0.015, seg = 1) => ctx.track(new RoundedBoxGeometry(w, h, d, seg, r));
  const mesh = (geo: BufferGeometry, mat: Material, x: number, y: number, z: number, parent: Group, rotY = 0) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    parent.add(m);
    return m;
  };
  const tube = (pts: Vector3[], r: number, segs = 64) => new TubeGeometry(new CatmullRomCurve3(pts, false, 'centripetal'), segs, r, 6, false);
  const spoolGeo = (() => {
    const rings = [0, 1, 2].map((n) => {
      const t = new TorusGeometry(0.3 - n * 0.035, 0.016, 6, 48);
      t.rotateX(Math.PI / 2);
      t.translate(0, 0.02 + n * 0.012, 0);
      return t;
    });
    return ctx.track(mergeGeometries(rings));
  })();

  const boardGeo = box(BOARD.w, 0.06, BOARD.d, 0.03, 2);
  const panelGeo = box(BOARD.w, 0.44, 0.06, 0.015);
  const subGeo = box(0.95, 0.05, 0.95, 0.02);
  const dieGeo = box(0.5, 0.05, 0.5, 0.015);
  const connGeo = box(0.2, 0.1, 0.07, 0.01);

  /* ───────── bays ───────── */
  interface Bay {
    kind: Kind;
    group: Group;
    flow: PathFlow;
    flowMax: number;
    colors: (p: Palette) => Color[][];
    glowAt: { local: Vector3; size: number; color: 'optic' | 'heat' | 'flow' }[];
    /** Pickable parts and the hotspot each one opens. */
    pick: [Object3D, string][];
  }
  const bays: Bay[] = [];
  const polylines: { kind: Kind; pl: Polylines; laser: number }[] = [];

  /** PCB traces from the die's front edge to the front-panel cage (8 lanes). */
  const pcbTraces = (zDie: number, zEnd: number): Vector3[][] =>
    Array.from({ length: 8 }, (_, l) => {
      const x0 = (l - 3.5) * 0.055;
      const x1 = (l - 3.5) * 0.03;
      return rounded([v3(x0, Y_TOP + 0.004, zDie), v3(x0, Y_TOP + 0.004, zDie + 0.45), v3(x1, Y_TOP + 0.004, zDie + 0.85), v3(x1, Y_TOP + 0.004, zEnd)], 0.12, 5);
    });

  const buildBay = (kind: Kind, index: number): Bay => {
    const g = new Group();
    g.name = `bay-${kind}`;
    root.add(g);
    mesh(boardGeo, boardMat, 0, 0.03, 0, g);
    mesh(panelGeo, metal, 0, 0.28, PANEL_Z, g);
    const pick: [Object3D, string][] = [];
    const glowAt: Bay['glowAt'] = [];
    const flowPaths: { points: Vector3[]; weight?: number; speed?: number }[] = [];
    let colorFn: (p: Palette) => Color[][] = () => [];
    let lines: Vector3[][] = [];
    let laserLines = 0;

    if (kind === 'dac' || kind === 'pluggable') {
      const zc = -0.55;
      mesh(subGeo, substrateMat, 0, Y_TOP + 0.025, zc, g);
      const die = mesh(dieGeo, dieMat, 0, Y_TOP + 0.075, zc, g);
      pick.push([die, kind]);
      lines = pcbTraces(zc + 0.26, PANEL_Z - 0.08);
      mesh(box(0.5, 0.24, 0.08, 0.01), darkMat, 0, 0.2, PANEL_Z + 0.005, g); // cage opening
      glowAt.push({ local: v3(0, Y_TOP + 0.1, zc), size: 1.0, color: 'flow' });
    }

    if (kind === 'dac') {
      const plug = mesh(box(0.4, 0.15, 0.55, 0.02), copperMat, 0, 0.2, PANEL_Z + 0.2, g);
      const cablePts = [v3(0, 0.2, PANEL_Z + 0.46), v3(0, 0.2, PANEL_Z + 0.85), v3(0.08, 0.1, PANEL_Z + 1.25), v3(0.45, 0.06, PANEL_Z + 1.5), v3(0.85, 0.08, PANEL_Z + 1.45), v3(1.05, 0.16, PANEL_Z + 1.32)];
      const cable = mesh(ctx.track(tube(cablePts, 0.045)), copperMat, 0, 0, 0, g);
      const nb = mesh(box(0.62, 0.3, 0.46, 0.03), metal, 1.25, 0.15, PANEL_Z + 1.18, g, -0.5);
      pick.push([plug, 'dac'], [cable, 'dac'], [nb, 'dac']);
      // Packets ride just above the (opaque) cable.
      const ride = rounded(cablePts, 0.1, 3).map((q) => q.clone().add(v3(0, 0.05, 0)));
      for (const tr of lines) flowPaths.push({ points: [...tr, v3(0, 0.29, PANEL_Z + 0.2), ...ride, v3(1.25, 0.32, PANEL_Z + 1.18)] });
      colorFn = (p) => flowPaths.map(() => [p.flow]);
    }

    if (kind === 'pluggable') {
      // Drawn half pulled out of its cage so the DSP and the laser are visible.
      const zm = PANEL_Z + 0.3;
      const housing = mesh(box(0.42, 0.18, 1.0, 0.03, 2), moduleGlass, 0, 0.2, zm, g);
      housing.renderOrder = 3;
      mesh(box(0.36, 0.02, 0.92, 0.008), boardMat, 0, 0.13, zm, g);
      const zDsp = PANEL_Z + 0.1;
      const zLaser = PANEL_Z + 0.46;
      const zConn = PANEL_Z + 0.76;
      const dsp = mesh(box(0.17, 0.04, 0.17, 0.01), heatMat, 0, 0.16, zDsp, g);
      const laser = mesh(box(0.08, 0.04, 0.09, 0.01), opticMat, 0.08, 0.16, zLaser, g);
      mesh(box(0.07, 0.035, 0.07, 0.01), metal, -0.09, 0.16, zLaser, g); // photodiode (receive side)
      mesh(box(0.3, 0.1, 0.06, 0.01), darkMat, 0, 0.2, zConn, g); // fibre connector
      const fibrePts = [v3(0.04, 0.2, zConn + 0.04), v3(0.04, 0.2, zConn + 0.35), v3(0.1, 0.08, zConn + 0.8), v3(0.2, 0.04, zConn + 1.15)];
      const fibre = mesh(ctx.track(tube(fibrePts, 0.018)), fibreMat, 0, 0, 0, g);
      const spool = mesh(spoolGeo, fibreMat, 0.2, 0, zConn + 1.45, g);
      pick.push([housing, 'pluggable'], [dsp, 'pluggable'], [laser, 'pluggable'], [fibre, 'pluggable'], [spool, 'pluggable']);
      glowAt.push({ local: v3(0.08, 0.2, zLaser), size: 0.7, color: 'optic' }, { local: v3(0, 0.2, zDsp), size: 0.55, color: 'heat' });
      const tail = [v3(0, 0.16, zDsp), v3(0.08, 0.17, zLaser), v3(0.04, 0.2, zConn), ...rounded(fibrePts, 0.1, 3), v3(0.2, 0.05, zConn + 1.25), v3(0.2, 0.05, zConn + 1.45)];
      for (const tr of lines) flowPaths.push({ points: [...tr, v3(0, 0.14, PANEL_Z - 0.15), ...tail] });
      colorFn = (p) =>
        flowPaths.map(({ points }) => {
          const iLaser = points.length - tail.length + 1; // control point at the laser
          return points.map((_, j) => (j < iLaser ? p.flow : p.optic));
        });
    }

    if (kind === 'cpo') {
      const zc = -0.4;
      mesh(box(1.5, 0.05, 1.5, 0.025), substrateMat, 0, Y_TOP + 0.025, zc, g);
      const die = mesh(dieGeo, dieMat, 0, Y_TOP + 0.075, zc, g);
      // Eight optical engines around the die: two per side.
      const oes = instanced(ctx, box(0.3, 0.05, 0.2, 0.012), opticMat, 8);
      const R = 0.56;
      const oe: { p: Vector3; out: Vector3 }[] = [];
      for (const s of [-1, 1]) {
        oe.push({ p: v3(s * 0.2, Y_TOP + 0.075, zc + R), out: v3(0, 0, 1) }); // front
        oe.push({ p: v3(s * R, Y_TOP + 0.075, zc + 0.2), out: v3(s, 0, 0) }); // side, front half
        oe.push({ p: v3(s * R, Y_TOP + 0.075, zc - 0.2), out: v3(s, 0, 0) }); // side, back half
        oe.push({ p: v3(s * 0.2, Y_TOP + 0.075, zc - R), out: v3(0, 0, -1) }); // back
      }
      oe.forEach((e, i) => placeAt(oes, i, e.p, 1, e.out.x !== 0 ? Math.PI / 2 : 0));
      commit(oes);
      g.add(oes);
      pick.push([oes, 'cpo-engine'], [die, 'cpo-engine']);

      // Front-panel layout: outer fibre connectors, inner fibre connectors, the ELS in the middle.
      const zIn = PANEL_Z - 0.06;
      const zRun = PANEL_Z - 0.42;
      const yB = Y_TOP + 0.045; // fibre centre height on the board
      /** Data fibre from engine i to its front-panel connector, routed around the package edge. */
      const fibreRoute = (i: number): Vector3[] => {
        const e = oe[i]!;
        const s = e.p.x < 0 ? -1 : 1;
        const slot = i % 4; // 0 front, 1 side-front, 2 side-back, 3 back
        const top = e.p.clone().addScaledVector(e.out, 0.02).setY(0.18);
        if (slot === 0)
          return [top, v3(s * 0.2, 0.13, zc + R + 0.24), v3(s * 0.34, yB, zc + R + 0.6), v3(s * 0.38, yB, zRun), v3(s * 0.38, 0.2, zIn)];
        const lane = s * (slot === 1 ? 0.9 : slot === 2 ? 0.95 : 1.0);
        const cx = s * (slot === 1 ? 0.76 : slot === 2 ? 0.8 : 0.84);
        const head =
          slot === 3
            ? [top, v3(s * 0.22, 0.13, zc - R - 0.2), v3(s * 0.5, yB, zc - R - 0.3), v3(lane, yB, zc - R - 0.3)]
            : [top, v3(s * (R + 0.24), 0.13, e.p.z), v3(lane, yB, e.p.z)];
        return [...head, v3(lane, yB, zRun - 0.1), v3(cx, yB, zRun + 0.1), v3(cx, 0.2, zIn)];
      };
      const fibres = oe.map((_, i) => rounded(fibreRoute(i), 0.14, 5));
      const fMesh = mesh(ctx.track(mergeGeometries(fibres.map((f) => tube(f, 0.012, 96)))), fibreMat, 0, 0, 0, g);
      const conX = [-0.8, -0.38, 0.38, 0.8];
      conX.forEach((x) => mesh(connGeo, darkMat, x, 0.2, PANEL_Z + 0.02, g));
      // Out-going fibres from the four connectors, gathered onto a spool in front of the panel.
      const zSpool = PANEL_Z + 1.5;
      const outPts = conX.map((x) => [v3(x, 0.2, PANEL_Z + 0.06), v3(x, 0.19, PANEL_Z + 0.42), v3(x * 0.45, 0.08, PANEL_Z + 0.92), v3(x * 0.12, 0.04, zSpool - 0.3)]);
      const oMesh = mesh(ctx.track(mergeGeometries(outPts.map((f) => tube(f, 0.016, 40)))), fibreMat, 0, 0, 0, g);
      const spool = mesh(spoolGeo, fibreMat, 0, 0, zSpool, g);
      // External laser source: a pluggable module at the panel feeding continuous light.
      const els = mesh(box(0.32, 0.17, 0.62, 0.03, 2), moduleGlass, 0, 0.2, PANEL_Z + 0.05, g);
      els.renderOrder = 3;
      const elsLaser = mesh(box(0.14, 0.05, 0.12, 0.012), opticMat, 0, 0.16, PANEL_Z + 0.16, g);
      pick.push([fMesh, 'cpo-engine'], [oMesh, 'cpo-engine'], [spool, 'cpo-engine'], [els, 'laser-source'], [elsLaser, 'laser-source']);

      // Laser feeds (thin lines): ELS → every engine, inside the data-fibre lanes.
      const elsP = v3(0, 0.15, PANEL_Z - 0.3);
      const feed = (i: number): Vector3[] => {
        const e = oe[i]!;
        const s = e.p.x < 0 ? -1 : 1;
        const slot = i % 4;
        const end = e.p.clone().addScaledVector(e.out, -0.06).setY(0.165);
        if (slot === 0) return [elsP, v3(s * 0.06, yB + 0.01, zRun - 0.1), v3(s * 0.12, 0.12, zc + R + 0.3), end];
        const lane = s * 0.85;
        const mid = [elsP, v3(s * 0.24, yB + 0.01, zRun - 0.25), v3(lane, yB + 0.01, zRun - 0.45)];
        if (slot === 3) return [...mid, v3(lane, yB + 0.01, zc - R - 0.22), v3(s * 0.32, 0.13, zc - R - 0.22), end];
        return [...mid, v3(lane, yB + 0.01, e.p.z + (slot === 1 ? 0.06 : -0.06)), v3(s * (R + 0.2), 0.13, e.p.z + (slot === 1 ? 0.06 : -0.06)), end];
      };
      const feeds = oe.map((_, i) => rounded(feed(i), 0.12, 4));
      lines = [...feeds];
      laserLines = feeds.length;
      // Micro-traces die → engine (millimetres on the package).
      for (const e of oe) {
        const a = v3(0, Y_TOP + 0.052, zc).add(v3(e.p.x * 0.45, 0, (e.p.z - zc) * 0.45));
        lines.push([a, e.p.clone().addScaledVector(e.out, -0.12).setY(Y_TOP + 0.052)]);
      }
      glowAt.push({ local: v3(0, Y_TOP + 0.1, zc), size: 1.0, color: 'flow' });
      oe.forEach((e) => glowAt.push({ local: e.p.clone().add(v3(0, 0.05, 0)), size: 0.42, color: 'optic' }));
      glowAt.push({ local: v3(0, 0.2, PANEL_Z + 0.16), size: 0.6, color: 'optic' });

      // Data: die edge → engine (electrical, millimetres) → fibre → connector → out-going fibre → spool.
      const dataStart = flowPaths.length;
      oe.forEach((e, i) => {
        const start = v3(0, Y_TOP + 0.09, zc).add(v3(e.p.x * 0.45, 0, (e.p.z - zc) * 0.45));
        const conn = conX.indexOf(i % 4 === 0 ? (e.p.x < 0 ? -0.38 : 0.38) : e.p.x < 0 ? -0.8 : 0.8);
        flowPaths.push({ points: [start, e.p.clone().add(v3(0, 0.04, 0)), ...fibres[i]!, ...outPts[conn]!, v3(0, 0.04, zSpool)] });
      });
      // Continuous laser light: ELS → engines (fainter, slower).
      feeds.forEach((f) => flowPaths.push({ points: f, weight: 0.45, speed: 0.7 }));
      colorFn = (p) => flowPaths.map(({ points }, i) => (i >= dataStart + oe.length ? [p.optic] : points.map((_, j) => (j < 2 ? p.flow : p.optic))));
    }

    // Copper traces / laser feeds (one draw call per bay).
    const pl = new Polylines(ctx, lines);
    pl.object.renderOrder = 4;
    g.add(pl.object);
    polylines.push({ kind, pl, laser: laserLines });

    const count = kind === 'cpo' ? 760 : kind === 'pluggable' ? 600 : 420;
    const flow = ctx.track(
      new PathFlow({
        paths: flowPaths,
        count,
        size: 0.05,
        speed: 0.75,
        speedVariance: 0.1,
        smooth: false,
        samples: 128,
        fadeEnds: 0.03,
        theme: ctx.theme,
        seed: 31 + index,
      }),
    );
    g.add(flow.object);
    return { kind, group: g, flow, flowMax: count, colors: colorFn, glowAt, pick };
  };
  KINDS.forEach((k, i) => bays.push(buildBay(k, i)));

  /* ───────── comparison card (follows the middle bay's transform) ───────── */
  const card = new Group();
  card.name = 'power-card';
  root.add(card);
  const plinth = mesh(box(1, 0.06, 0.82, 0.025), metal, 0, 0.03, BAR_Z, card);
  const back = mesh(box(1, CARD_H, 0.03, 0.012), cardGlass, 0, 0.06 + CARD_H / 2, CARD_Z, card);
  back.renderOrder = 1;
  const barGeo = box(BAR_W, 1, BAR_W, 0.02);
  const powerBars = instanced(ctx, barGeo, heatMat, 3);
  const reachBars = instanced(ctx, barGeo, reachMat, 3);
  const dspBar = new Mesh(barGeo, dspShareMat);
  dspBar.renderOrder = 3;
  root.add(powerBars, reachBars, dspBar);
  let cardOutline: Polylines | null = null; // rebuilt per layout (outline + 3 gridlines)

  /* ───────── layout ───────── */
  const M = new Vector3();
  const world = (b: Bay, local: Vector3) => local.clone().applyMatrix4(b.group.matrixWorld);
  const cardLen = () => (portrait ? 2 * PORT_GAP + BOARD.w + 0.5 : 2 * SPACING + BOARD.w + 0.5);
  const layout = () => {
    bays.forEach((b, i) => {
      if (portrait) {
        b.group.position.set(-0.9, 0, (i - 1) * PORT_GAP);
        b.group.rotation.y = Math.PI / 2;
      } else {
        b.group.position.set((i - 1) * SPACING, 0, 0);
        b.group.rotation.y = 0;
      }
      b.group.updateMatrixWorld(true);
    });
    const mid = bays[1]!.group;
    card.position.copy(mid.position);
    card.rotation.y = mid.rotation.y;
    const len = cardLen();
    plinth.scale.x = len;
    back.scale.x = len;
    card.updateMatrixWorld(true);
    // Card outline + gridlines (local to the card).
    if (cardOutline) {
      cardOutline.object.removeFromParent();
      cardOutline.object.geometry.dispose();
    }
    const h0 = 0.06;
    const x = len / 2;
    const z = CARD_Z + 0.02;
    cardOutline = new Polylines(ctx, [
      [v3(-x, h0, z), v3(-x, h0 + CARD_H, z), v3(x, h0 + CARD_H, z), v3(x, h0, z)],
      ...[0.5, 1.0, 1.5].map((y) => [v3(-x + 0.08, h0 + y, z), v3(x - 0.08, h0 + y, z)]),
    ]);
    cardOutline.object.renderOrder = 2;
    card.add(cardOutline.object);
    cardOutline.object.updateMatrixWorld(true);
    // Bars stand on the card, in front of their bay.
    // Landscape: power | reach side by side along the card; portrait: across the card's depth, so
    // they still stand side by side on screen (power on the left).
    const [pX, pZ, rX, rZ] = portrait ? [0, BAR_Z - BAR_DX, 0, BAR_Z + BAR_DX] : [-BAR_DX, BAR_Z, BAR_DX, BAR_Z];
    bays.forEach((b, i) => {
      const ph = b.kind === 'pluggable' ? POWER_H[i]! - DSP_SHARE : POWER_H[i]!;
      M.set(pX, ph / 2 + 0.06, pZ).applyMatrix4(b.group.matrixWorld);
      powerBars.setMatrixAt(i, powerBars.matrix.clone().makeRotationY(b.group.rotation.y).scale(v3(1, ph, 1)).setPosition(M));
      const rh = REACH_H[i]!;
      M.set(rX, rh / 2 + 0.06, rZ).applyMatrix4(b.group.matrixWorld);
      reachBars.setMatrixAt(i, reachBars.matrix.clone().makeRotationY(b.group.rotation.y).scale(v3(1, rh, 1)).setPosition(M));
      if (b.kind === 'pluggable') {
        dspBar.position.set(pX, POWER_H[i]! - DSP_SHARE / 2 + 0.06, pZ).applyMatrix4(b.group.matrixWorld);
        dspBar.rotation.y = b.group.rotation.y;
        dspBar.scale.set(1.0, DSP_SHARE, 1.0);
      }
    });
    commit(powerBars);
    commit(reachBars);
    if (labelsReady) placeLabels();
  };

  /* ───────── labels ───────── */
  let labelsReady = false;
  const bayOf = (k: Kind) => bays.find((b) => b.kind === k)!;
  const titleLabels = bays.map((b) =>
    labels.add({ text: TITLES[b.kind], object: b.group, position: [0, 0.52, PANEL_Z], align: 'above', kind: 'strong', priority: 36, hotspot: HOTSPOT_OF[b.kind] }),
  );
  const barLabels = bays.map((b, i) =>
    labels.add({ text: BAR_TEXT[b.kind], object: b.group, position: [0, Math.max(POWER_H[i]!, REACH_H[i]!) + 0.12, BAR_Z], align: 'above', kind: 'tag', priority: 22, hotspot: 'power-per-bit' }),
  );
  // The card's two captions are its legend (bar colours): never culled, stacked in pixels.
  const cardPower = labels.add({ text: '每位元功耗（示意）', position: [0, 0, 0], align: 'right', priority: 26, always: true, hotspot: 'power-per-bit' });
  const cardReach = labels.add({ text: '傳輸距離（示意）', position: [0, 0, 0], align: 'right', priority: 25, always: true, hotspot: 'power-per-bit' });
  const FORMULA = '功耗（W）＝ 每位元能耗（pJ/bit）× 頻寬（Tb/s）';
  const FORMULA_SHORT = '功耗（W）＝ pJ/bit × Tb/s';
  const formula = labels.add({ text: FORMULA, position: [0, 0, 0], align: 'above', kind: 'default', priority: 30, always: true, visible: false });
  const dspTag = labels.add({ text: 'DSP 耗電（LPO 省去）', object: bayOf('pluggable').group, position: [0, 0, 0], align: 'left', offset: [-6, 0], kind: 'tag', priority: 14 });
  const P = PANEL_Z;
  const compLabels: LabelHandle[] = [
    labels.add({ text: '交換晶片', object: bayOf('dac').group, position: [-0.27, 0.14, -0.55], align: 'left', offset: [-8, 0], priority: 22 }),
    labels.add({ text: '銅線走線', object: bayOf('dac').group, position: [0.14, 0.07, 0.55], align: 'right', offset: [8, 0], kind: 'tag', priority: 12 }),
    labels.add({ text: '數公尺內', object: bayOf('dac').group, position: [1.25, 0.32, P + 1.18], align: 'above', kind: 'muted', priority: 18, hotspot: 'dac' }),
    labels.add({ text: 'DSP', object: bayOf('pluggable').group, position: [-0.12, 0.2, P + 0.1], align: 'left', offset: [-8, 0], kind: 'tag', priority: 16, hotspot: 'pluggable' }),
    labels.add({ text: '雷射：電→光', object: bayOf('pluggable').group, position: [0.14, 0.2, P + 0.46], align: 'right', offset: [10, 0], priority: 28, hotspot: 'pluggable' }),
    labels.add({ text: '光纖：數百公尺以上', object: bayOf('pluggable').group, position: [0.2, 0.06, P + 2.21], align: 'below', offset: [0, 12], kind: 'muted', priority: 18 }),
    labels.add({ text: '光引擎：電→光', object: bayOf('cpo').group, position: [0.68, 0.16, -0.2], align: 'right', offset: [10, 0], priority: 30, hotspot: 'cpo-engine' }),
    labels.add({ text: '外部雷射光源', object: bayOf('cpo').group, position: [-0.17, 0.22, P + 0.3], align: 'left', offset: [-8, 0], priority: 26, hotspot: 'laser-source' }),
  ];
  const COMP_BAY: readonly Kind[] = ['dac', 'dac', 'dac', 'pluggable', 'pluggable', 'pluggable', 'cpo', 'cpo'];
  const legend = [
    labels.add({ text: '電訊號', position: [0, 0, 0], align: 'center', kind: 'tag', priority: 26, always: true }),
    labels.add({ text: '光訊號', position: [0, 0, 0], align: 'center', kind: 'tag', priority: 26, always: true }),
  ];
  const cardCorner = (u: number, y: number) => {
    const len = cardLen();
    return v3(u * (len / 2 - 0.12), y, CARD_Z + 0.04).applyMatrix4(card.matrixWorld);
  };
  const placeLabels = () => {
    // Both captions share one anchor and are stacked in pixels, so they never collide (the card is
    // foreshortened from the high step cameras). They extend rightwards from the anchor: in portrait
    // the anchor (the card's far end, top-left of the screen) sits near the stage's left edge, and a
    // label crossing an edge is hidden. Landscape: the card's top-left corner.
    const capAt = portrait ? cardCorner(1, CARD_H - 0.12) : cardCorner(-1, CARD_H - 0.45);
    cardPower.set({ position: capAt, align: 'right', offset: [0, -14] });
    cardReach.set({ position: capAt, align: 'right', offset: [0, 14] });
    // Between the pluggable and CPO bars, near the top of the card.
    const yDsp = POWER_H[1]! - DSP_SHARE / 2 + 0.06;
    dspTag.set({ position: portrait ? [0, yDsp, BAR_Z - BAR_DX - BAR_W / 2] : [-BAR_DX - BAR_W / 2, yDsp, BAR_Z] });
    // The full formula does not fit a phone-width stage (a label wider than the stage is hidden).
    formula.set({ text: ctx.size.width < 560 ? FORMULA_SHORT : FORMULA });
    // Portrait: the CPO bay's part labels move off its package (the bay is seen from above, panel
    // to the right, bay title above the panel): the engine label under the lower engine pair, the
    // laser label under the ELS.
    compLabels[6]!.set(portrait ? { position: [-0.62, 0.16, -0.4], align: 'below', offset: [0, 0] } : { position: [0.68, 0.16, -0.2], align: 'right', offset: [10, 0] });
    compLabels[7]!.set(portrait ? { align: 'below', offset: [0, 4] } : { align: 'left', offset: [-8, 0] });
    // The DAC die label: left of the die in landscape; above it in portrait (left is the bar card).
    compLabels[0]!.set(portrait ? { align: 'above', offset: [0, 0] } : { align: 'left', offset: [-8, 0] });
    // The pluggable's laser label: right of the module in landscape; under it in portrait, where the
    // module points at the stage's right edge (a label past the edge is hidden).
    compLabels[4]!.set(portrait ? { align: 'below', offset: [22, 4] } : { align: 'right', offset: [10, 0] });
    if (portrait) {
      // Narrow stage: the formula becomes a caption under the CPO bay, above the legend; the
      // legend pair sits side by side around one anchor (pixel offsets, so it never overlaps).
      formula.set({ position: [PORT_X, 0.02, PORT_GAP + 2.05] });
      legend[0]!.set({ position: [PORT_X, 0.02, PORT_GAP + 2.65], align: 'left', offset: [4, 0] });
      legend[1]!.set({ position: [PORT_X, 0.02, PORT_GAP + 2.65], align: 'right', offset: [-4, 0] });
    } else {
      formula.set({ position: v3(0, CARD_H + 0.12, CARD_Z + 0.05).applyMatrix4(bays[2]!.group.matrixWorld) });
      // On the floor between the DAC's neighbour and the pluggable's fibre spool, where every
      // landscape step camera sees it; stacked in pixels (above / below).
      legend[0]!.set({ position: [-1.15, 0.02, PANEL_Z + 2.1], align: 'above', offset: [0, 0] });
      legend[1]!.set({ position: [-1.15, 0.02, PANEL_Z + 2.1], align: 'below', offset: [0, 0] });
    }
  };
  layout();
  labelsReady = true;
  placeLabels();
  labels.setMax(24);

  /* ───────── palette ───────── */
  let hot: Partial<Record<string, number>> = {};
  let dim: Partial<Record<Kind, number>> = {};
  const paintGlows = () => {
    const p = ctx.palette;
    const dark = dk(p);
    let n = 0;
    for (const b of bays) {
      const boost = (b.kind === 'cpo' ? (hot['cpo-engine'] ?? 0) + (hot['laser-source'] ?? 0) : 0) + (b.kind === 'pluggable' ? (hot['pluggable'] ?? 0) : 0) + (b.kind === 'dac' ? (hot['dac'] ?? 0) : 0);
      const fade = 1 - 0.6 * (dim[b.kind] ?? 0);
      for (const gA of b.glowAt) {
        const c = gA.color === 'optic' ? p.optic : gA.color === 'heat' ? p.heat : p.seg['networking-optics'];
        const a = ((gA.color === 'flow' ? (dark ? 0.35 : 0.18) : dark ? 0.75 : 0.45) + 0.5 * boost) * fade;
        if (n < GLOWS) glows.set(n++, world(b, gA.local), gA.size, c, a);
      }
    }
    for (; n < GLOWS; n++) glows.set(n, [0, 0, 0], 0.01, p.bg, 0);
  };
  const paintLines = () => {
    const p = ctx.palette;
    const dark = dk(p);
    for (const { kind, pl, laser } of polylines) {
      const fade = 1 - 0.5 * (dim[kind] ?? 0);
      for (let i = 0; i < pl.count; i++) {
        const isLaser = i < laser;
        pl.set(i, isLaser ? p.optic : p.power, (isLaser ? (dark ? 0.6 : 0.7) : dark ? 0.6 : 0.75) * fade);
      }
      pl.commit();
    }
    if (cardOutline) {
      for (let i = 0; i < cardOutline.count; i++) cardOutline.set(i, i === 0 ? p.muted : p.grid, i === 0 ? (dark ? 0.45 : 0.6) : dark ? 0.5 : 0.9);
      cardOutline.commit();
    }
  };
  const applyPalette = (p: Palette) => {
    const dark = dk(p);
    lights.apply(p);
    floor.apply(p);
    glows.setTheme(p.theme);
    for (const b of bays) {
      const cols = b.colors(p);
      b.flow.recolor((i) => cols[i] ?? p.flow);
      b.flow.setTheme(p.theme);
      b.flow.setSize(dark ? 0.05 : 0.044);
    }
    paintLines();
    cardGlass.opacity = dark ? 0.045 : 0.42;
    legend[0]!.set({ swatch: p.css['scene-flow'] ?? '' });
    legend[1]!.set({ swatch: p.css['scene-optic'] ?? '' });
    cardPower.set({ swatch: p.css['scene-heat'] ?? '' });
    cardReach.set({ swatch: p.css['chart-1'] ?? '' });
    dspTag.set({ swatch: p.css['scene-heat'] ?? '' });
    compLabels[4]!.set({ swatch: p.css['scene-optic'] ?? '' });
    compLabels[6]!.set({ swatch: p.css['scene-optic'] ?? '' });
    compLabels[7]!.set({ swatch: p.css['scene-optic'] ?? '' });
    compLabels[0]!.set({ swatch: p.css['seg-networking-optics'] ?? '' });
    paintGlows();
  };
  applyPalette(ctx.palette);

  const setCounts = () => bays.forEach((b) => b.flow.setCount(scaleCount(b.flowMax, ctx.tier, 80)));
  setCounts();
  const setReduced = (r: boolean) => bays.forEach((b) => b.flow.setReduced(r));
  setReduced(!ctx.animate);

  /* ───────── hotspots ───────── */
  const poses = () => (portrait ? PORT : LAND);
  const hotTween = (id: string, on: boolean) => {
    const from = hot[id] ?? 0;
    ctx.tween.run(
      (k) => {
        hot = { ...hot, [id]: from + ((on ? 1 : 0) - from) * k };
        paintGlows();
      },
      { duration: 200, fade: true },
    );
  };
  const register = () => {
    const dac = bayOf('dac');
    const plug = bayOf('pluggable');
    const cpo = bayOf('cpo');
    hotspots.register('dac', {
      anchor: world(dac, v3(0.4, 0.3, PANEL_Z + 0.9)),
      pose: poses()['dac']!,
      card: () => hotspotCard(ctx, 'dac'),
      onHighlight: (on) => hotTween('dac', on),
    });
    hotspots.register('pluggable', {
      anchor: world(plug, v3(0, 0.3, PANEL_Z + 0.3)),
      pose: poses()['pluggable']!,
      card: () => hotspotCard(ctx, 'pluggable'),
      onHighlight: (on) => hotTween('pluggable', on),
    });
    hotspots.register('cpo-engine', {
      anchor: world(cpo, v3(0, 0.2, -0.4)),
      pose: poses()['cpo-engine']!,
      card: () => hotspotCard(ctx, 'cpo-engine'),
      onHighlight: (on) => hotTween('cpo-engine', on),
    });
    hotspots.register('laser-source', {
      anchor: world(cpo, v3(0, 0.3, PANEL_Z + 0.1)),
      pose: poses()['laser-source']!,
      card: () => hotspotCard(ctx, 'laser-source'),
      onHighlight: (on) => hotTween('laser-source', on),
    });
    hotspots.register('power-per-bit', {
      anchor: world(plug, v3(0, 1.4, BAR_Z)),
      pose: poses()['power-per-bit']!,
      card: () => hotspotCard(ctx, 'power-per-bit'),
      onHighlight: (on) => hotTween('power-per-bit', on),
    });
  };
  register();
  // Pick individual meshes (a whole group would also hit its lines, whose ray threshold is wide).
  for (const b of bays) for (const [o, id] of b.pick) ctx.picker.add(o, { id, recursive: false });
  for (const o of [powerBars, reachBars, dspBar, back]) ctx.picker.add(o, { id: 'power-per-bit', recursive: false });

  /* ───────── steps ───────── */
  let sid = stepIdOf(ctx, ctx.step);
  /**
   * The formula label belongs to step CPO. A small landscape stage (a phone at 4:3) has no free
   * row for it next to the card captions, so there it stays in the step caption only.
   */
  const showFormula = () => formula.set({ visible: sid === 'cpo' && (portrait || ctx.size.width >= 560) });
  let dimTween: { cancel(): void } | null = null;
  const showStep = (i: number) => {
    sid = stepIdOf(ctx, i);
    const focus: Kind[] = sid === 'copper-optics' ? ['dac', 'pluggable'] : sid === 'cpo' ? ['cpo'] : [];
    const from = { ...dim };
    dimTween?.cancel();
    dimTween = ctx.tween.run(
      (k) => {
        for (const b of bays) {
          const to = focus.length && !focus.includes(b.kind) ? 1 : 0;
          const d = (from[b.kind] ?? 0) + (to - (from[b.kind] ?? 0)) * k;
          dim = { ...dim, [b.kind]: d };
          b.flow.setOpacity(1 - 0.65 * d);
        }
        paintGlows();
        paintLines();
      },
      { duration: 400, fade: true },
    );
    titleLabels.forEach((h, k) => h.set({ kind: !focus.length || focus.includes(KINDS[k]!) ? 'strong' : 'muted' }));
    // Part labels of a dimmed bay would only crowd the frame edges.
    compLabels.forEach((h, k) => h.set({ visible: !focus.length || focus.includes(COMP_BAY[k]!) }));
    showFormula();
    barLabels.forEach((h) => h.set({ priority: sid === 'cpo' ? 30 : 22 }));
    ctx.setPose(poses()[sid] ?? ctx.homePose);
  };

  return {
    anchor: [0, 0.6, 0.6],
    update(_dt, t) {
      for (const b of bays) b.flow.update(t);
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
    onResize(size) {
      const next = size.aspect < 1;
      if (next !== portrait) {
        portrait = next;
        layout();
        paintLines();
        paintGlows();
        register();
        ctx.setPose(poses()[sid] ?? ctx.homePose, { duration: 0 });
      } else placeLabels(); // the formula text depends on the stage width
      showFormula();
    },
    dispose() {
      dimTween?.cancel();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

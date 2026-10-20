/**
 * power-chain — from the grid to the GPU.
 *
 *  AC lane (z = −1.2, today's mainstream): grid (pylon) → substation (HV→MV) → MV switchgear
 *  (+ backup generator) → dry-type transformer (MV→LV) → UPS (AC→DC→AC) + batteries → busway →
 *  rack power shelf (AC→DC) → server board: VRM (DC→DC) → GPU.
 *  800 V DC lane (z = +1.5): MV switchgear → solid-state transformer / rectifier (MV AC→800 V DC)
 *  → 800 V DC busway → rack DC-DC shelf → the same board.
 *  Energy particles thin out at every conversion (illustrative) and the loss rises as heat.
 *  Portrait stages turn the layout −90° so the chain runs from the top (grid) to the bottom (GPU).
 */
import type { CameraPose, LabelHandle, LabelSpec } from '../../core/types';
import type { FlowDef, Kit, V3, View } from './kit';

const ZA = -1.5; // AC lane
const ZD = 2.0; // DC lane
const BX = 7.55; // board centre x
const BZ = 0.1;
const S = 1.35; // the server board is drawn enlarged (a "zoom-in" of one compute tray)
/** Board-local → scene coordinates (board-local units are unscaled). */
const bp = (x: number, y: number, z: number): V3 => [BX + x * S, y * S, BZ + z * S];
const bs = (w: number, h: number, d: number): V3 => [w * S, h * S, d * S];

export function powerChain(k: Kit, portrait: boolean) {
  const G = 'grid', AC = 'ac', DC = 'dc', B = 'board';

  /* ───────── grid & substation ───────── */
  k.box(G, 'slab', [7.0, 0.08, 3.6], [-6.4, -0.04, ZA - 0.5], { r: 0.04 });
  // lattice transmission tower: 4 tapering legs, horizontal girdles, X-bracing on every face
  {
    const x0 = -8.8, h = 3.0, wb = 0.36, wt = 0.09;
    const ys = [0, 0.75, 1.4, 1.95, 2.45, h];
    const hw = (y: number) => wb + ((wt - wb) * y) / h;
    const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    const at = (c: (typeof C)[number], y: number): V3 => [x0 + c[0] * hw(y), y, ZA + c[1] * hw(y)];
    for (const c of C) k.rod(G, 'steel', at(c, 0), at(c, h), 0.024);
    for (let i = 0; i < ys.length; i++)
      for (let j = 0; j < 4; j++) {
        const a = C[j]!, b = C[(j + 1) % 4]!;
        if (i > 0) k.rod(G, 'steel', at(a, ys[i]!), at(b, ys[i]!), 0.013);
        if (i < ys.length - 1) {
          k.rod(G, 'steel', at(a, ys[i]!), at(b, ys[i + 1]!), 0.009);
          k.rod(G, 'steel', at(b, ys[i]!), at(a, ys[i + 1]!), 0.009);
        }
      }
    for (const [y, w] of [[2.55, 1.5], [2.15, 1.1]] as const) k.box(G, 'steel', [0.07, 0.06, w], [x0, y, ZA], { hs: 'substation:grid' });
    k.block(G, 'steel', [0.9, 0.04, 0.9], [x0, 0, ZA]);
  }
  const ph = [-0.55, 0, 0.55];
  const seg: number[] = [];
  for (const dz of ph) seg.push(-10.2, 2.5, ZA + dz, -8.8, 2.5, ZA + dz, -8.8, 2.5, ZA + dz, -7.0, 2.2, ZA + dz * 0.8, -7.0, 2.2, ZA + dz * 0.8, -5.72, 1.38, ZA + dz * 0.45);
  k.lines(G, 'lineP', seg);
  for (const dz of [-0.75, 0.75]) k.block(G, 'steel', [0.08, 2.3, 0.08], [-7.0, 0, ZA + dz]);
  k.box(G, 'steel', [0.08, 0.08, 1.6], [-7.0, 2.3, ZA]);
  k.block(G, 'steel', [1.0, 0.9, 0.75], [-6.0, 0, ZA], { r: 0.03, hs: 'substation' });
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) k.box(G, 'metal', [0.05, 0.7, 0.28], [-6.24 + i * 0.12, 0.45, ZA + s * 0.52], { hs: 'substation' });
  k.cyl(G, 'steel', 0.11, 0.6, [-6.25, 1.06, ZA], { axis: 'x' });
  for (const dz of ph) {
    k.cyl(G, 'metal', 0.05, 0.42, [-5.72, 1.12, ZA + dz * 0.45], { seg: 10, hs: 'substation' });
    k.cyl(G, 'power', 0.03, 0.08, [-5.72, 1.36, ZA + dz * 0.45], { seg: 8 });
  }
  k.frame(G, 'edge', [2.4, 0.45, 2.0], [-6.25, 0, ZA], false);

  /* ───────── MV switchgear + generator ───────── */
  for (let i = 0; i < 4; i++) {
    const x = -4.43 + i * 0.42;
    k.block(G, 'metal', [0.4, 1.6, 0.7], [x, 0, ZA], { r: 0.02, hs: 'switchgear' });
    k.box(G, 'dark', [0.3, 0.8, 0.02], [x, 0.85, ZA + 0.355]);
    k.box(G, 'ledP', [0.24, 0.03, 0.01], [x, 1.42, ZA + 0.36]);
  }
  k.block(G, 'steel', [1.5, 0.8, 0.7], [-3.8, 0, ZA - 2.2], { r: 0.04, hs: 'generator' });
  k.box(G, 'dark', [0.02, 0.5, 0.5], [-3.04, 0.42, ZA - 2.2]);
  k.cyl(G, 'dark', 0.06, 0.4, [-4.3, 1.0, ZA - 2.2], { seg: 10 });
  const dash: number[] = [];
  for (let z = ZA - 1.8; z < ZA - 0.4; z += 0.22) dash.push(-3.8, 0.12, z, -3.8, 0.12, Math.min(z + 0.12, ZA - 0.36));
  k.lines(G, 'lineP', dash);

  /* ───────── AC lane ───────── */
  // dry-type transformer: three coils between yokes
  k.box(AC, 'steel', [1.0, 0.12, 0.42], [-1.5, 0.06, ZA], { hs: 'transformer' });
  k.box(AC, 'steel', [1.0, 0.12, 0.42], [-1.5, 1.24, ZA], { hs: 'transformer' });
  for (const dx of [-0.33, 0, 0.33]) k.cyl(AC, 'power', 0.15, 1.06, [-1.5 + dx, 0.65, ZA], { seg: 20, hs: 'transformer' });
  k.frame(AC, 'edge', [1.2, 1.4, 0.7], [-1.5, 0, ZA]);
  // UPS + battery cabinets
  for (const x of [0.5, 1.07]) {
    k.block(AC, 'metal', [0.55, 1.6, 0.7], [x, 0, ZA], { r: 0.025, hs: 'ups' });
    k.box(AC, 'led', [0.22, 0.13, 0.01], [x, 1.25, ZA + 0.355]);
  }
  for (const x of [0.32, 0.79, 1.26]) {
    k.block(AC, 'dark', [0.45, 1.3, 0.6], [x, 0, ZA - 1.0], { r: 0.02, hs: 'ups' });
    k.box(AC, 'ledOk', [0.3, 0.025, 0.01], [x, 1.18, ZA - 0.695]);
  }
  // busway + supports + tap-off
  k.box(AC, 'bus', [0.08, 0.6, 0.08], [1.25, 1.9, ZA], { hs: 'busway' });
  k.box(AC, 'bus', [3.2, 0.1, 0.12], [2.8, 2.25, ZA], { r: 0.02, hs: 'busway' });
  for (const x of [2.2, 3.5]) k.block(AC, 'steel', [0.04, 2.2, 0.04], [x, 0, ZA - 0.12]);
  k.box(AC, 'steel', [0.2, 0.16, 0.2], [4.4, 2.12, ZA], { hs: 'busway' });
  // racks (AC: power shelves; DC: DC-DC shelf)
  const rack = (z: string, zc: number, hs: string, shelf: 'ledP' | 'led', shelfHs: string) => {
    k.block(z, 'dark', [0.62, 2.0, 1.0], [4.4, 0, zc], { r: 0.02, hs });
    const fz = zc + 0.505;
    for (let j = 0; j < 7; j++) {
      const y = 0.45 + j * 0.17;
      k.box(z, 'steel', [0.52, 0.11, 0.02], [4.4, y, fz]);
      k.box(z, 'led', [0.04, 0.02, 0.01], [4.58, y, fz + 0.012]);
    }
    for (const y of [0.22, 1.78]) {
      k.box(z, 'metal', [0.56, 0.17, 0.03], [4.4, y, fz], { hs: shelfHs });
      k.box(z, shelf, [0.4, 0.025, 0.01], [4.4, y + 0.04, fz + 0.018]);
    }
    k.box(z, 'bus', [0.06, 1.8, 0.06], [4.4, 1.0, zc - 0.53]);
  };
  rack(AC, ZA, 'racks:ac', 'ledP', 'psu');

  /* ───────── DC lane ───────── */
  k.box(DC, 'slab', [7.4, 0.04, 1.7], [1.2, -0.02, ZD], { r: 0.02 });
  k.frame(DC, 'lineP', [7.4, 0.001, 1.7], [1.2, 0.002, ZD], false);
  k.block(DC, 'metal', [1.0, 1.15, 0.75], [-1.3, 0, ZD], { r: 0.03, hs: 'sst' });
  for (let i = 0; i < 6; i++) k.box(DC, 'steel', [0.04, 0.16, 0.6], [-1.65 + i * 0.14, 1.23, ZD], { hs: 'sst' });
  k.box(DC, 'dark', [0.5, 0.4, 0.02], [-1.42, 0.7, ZD + 0.38]);
  k.box(DC, 'accent', [0.3, 0.1, 0.01], [-1.42, 0.78, ZD + 0.392]);
  k.box(DC, 'bus', [0.08, 0.85, 0.08], [-0.72, 1.6, ZD], { hs: 'dc800' });
  k.box(DC, 'bus', [5.2, 0.1, 0.12], [1.85, 2.08, ZD], { r: 0.02, hs: 'dc800' });
  for (const x of [0.6, 2.4]) k.block(DC, 'steel', [0.04, 2.04, 0.04], [x, 0, ZD - 0.12]);
  k.box(DC, 'steel', [0.2, 0.14, 0.2], [4.4, 2.03, ZD]);
  // battery storage tied straight to the 800 V DC bus (no UPS double conversion)
  for (const x of [1.25, 1.72]) {
    k.block(DC, 'dark', [0.44, 1.2, 0.62], [x, 0, ZD], { r: 0.02, hs: 'bess' });
    k.box(DC, 'ledOk', [0.3, 0.025, 0.01], [x, 1.08, ZD + 0.315]);
    for (let j = 0; j < 4; j++) k.box(DC, 'steel', [0.36, 0.015, 0.01], [x, 0.25 + j * 0.2, ZD + 0.315]);
  }
  k.box(DC, 'bus', [0.06, 0.85, 0.06], [1.5, 1.6, ZD], { hs: 'bess' });
  k.box(DC, 'bus', [0.56, 0.05, 0.06], [1.5, 1.2, ZD]);
  rack(DC, ZD, 'racks:dc', 'led', 'dc800');
  const mvDc = k.pipe(DC, 'pipeP', [[-3.17, 0.1, ZA + 0.36], [-2.6, 0.1, ZA + 0.36], [-2.6, 0.1, ZD], [-1.8, 0.1, ZD]], 0.045);

  /* ───────── cables (AC) ───────── */
  k.pipe(G, 'pipeP', [[-5.5, 0.1, ZA], [-4.63, 0.1, ZA]], 0.045);
  k.pipe(AC, 'pipeP', [[-2.97, 0.1, ZA], [-2.1, 0.1, ZA]], 0.045);
  k.pipe(AC, 'pipeP', [[-0.9, 0.1, ZA], [0.22, 0.1, ZA]], 0.045);
  const toBoard = (z: string, zc: number) => {
    const side = zc < 0 ? -1 : 1;
    return k.pipe(z, 'pipeP', [[4.72, 0.35, zc - side * 0.3], [5.55, 0.35, zc - side * 0.3], [5.55, 0.35, BZ + side * 0.2], bp(-0.95, 0.56, side * 0.15)], 0.045, { fillet: 0.3 });
  };
  const acB = toBoard(AC, ZA);
  const dcB = toBoard(DC, ZD);

  /* ───────── server board (enlarged): VRM + GPU ───────── */
  k.block(B, 'steel', bs(2.1, 0.45, 1.75), bp(0, 0, 0), { r: 0.05 });
  k.box(B, 'pcb', bs(1.95, 0.05, 1.6), bp(0, 0.47, 0), { r: 0.015 });
  k.box(B, 'power', bs(0.14, 0.1, 0.45), bp(-0.9, 0.55, 0), { hs: 'vrm' });
  for (let c = 0; c < 2; c++)
    for (let r = 0; r < 5; r++) {
      k.box(B, 'steel', bs(0.14, 0.12, 0.14), bp(-0.58 + c * 0.2, 0.56, -0.5 + r * 0.25), { r: 0.015, hs: 'vrm' });
      k.cyl(B, 'dark', 0.035 * S, 0.09 * S, bp(-0.27, 0.54, -0.5 + r * 0.25), { seg: 10, hs: 'vrm' });
    }
  k.box(B, 'dark', bs(0.66, 0.05, 0.66), bp(0.3, 0.52, 0), { hs: 'chip' });
  k.box(B, 'chip', bs(0.32, 0.05, 0.32), bp(0.3, 0.57, 0), { hs: 'chip' });
  for (const [dx, dz] of [[-0.24, -0.17], [-0.24, 0.17], [0.24, -0.17], [0.24, 0.17]] as const)
    k.box(B, 'dark', bs(0.1, 0.07, 0.16), bp(0.3 + dx, 0.58, dz), { hs: 'chip' });
  // "zoom" outline from the racks to the board
  k.lines(B, 'edge', [4.7, 1.6, ZA + 0.5, ...bp(-1.05, 0.46, -0.875), 4.7, 1.6, ZD - 0.5, ...bp(-1.05, 0.46, 0.875)]);

  k.floor(-0.9, 0.1, 10.5, -0.06);
  k.build();

  /* ───────── flows ───────── */
  const P: 'power' = 'power';
  const feed: FlowDef[] = ph.map((dz) => ({ pts: [[-10.2, 2.5, ZA + dz], [-8.8, 2.5, ZA + dz], [-7.0, 2.2, ZA + dz * 0.8], [-5.72, 1.38, ZA + dz * 0.45]], tone: P, w: 0.5 }));
  feed.push({ pts: [[-6.0, 0.5, ZA], [-5.5, 0.1, ZA], [-4.63, 0.1, ZA], [-4.43, 0.5, ZA]], tone: P, w: 1.4 });
  k.flow('feed', feed, { count: 260, min: 50, size: [0.085, 0.07], speed: 1.0, zone: G, seed: 41 });
  const ac: FlowDef[] = [
    { pts: [[-3.6, 0.5, ZA], [-2.97, 0.1, ZA], [-2.1, 0.1, ZA], [-1.5, 0.55, ZA]], tone: P, w: 1.0 },
    { pts: [[-1.5, 0.55, ZA], [-0.9, 0.1, ZA], [0.22, 0.1, ZA], [0.8, 0.7, ZA]], tone: P, w: 0.9 },
    // (extra points keep the smoothed path straight along the busway)
    { pts: [[0.8, 0.7, ZA], [1.25, 1.6, ZA], [1.25, 2.34, ZA], [1.6, 2.34, ZA], [3.9, 2.34, ZA], [4.3, 2.34, ZA], [4.4, 2.0, ZA], [4.4, 1.78, ZA]], tone: P, w: 0.78 },
    { pts: [[4.4, 1.78, ZA], [4.4, 0.6, ZA], ...acB], tone: P, w: 0.68 },
  ];
  k.flow('ac', ac, { count: 420, min: 70, size: [0.085, 0.07], speed: 0.9, zone: AC, seed: 42 });
  const dc: FlowDef[] = [
    { pts: [[-3.4, 0.5, ZA], ...mvDc, [-1.3, 0.55, ZD]], tone: P, w: 1.0 },
    { pts: [[-1.3, 0.55, ZD], [-0.72, 1.15, ZD], [-0.72, 2.16, ZD], [-0.4, 2.16, ZD], [3.9, 2.16, ZD], [4.3, 2.16, ZD], [4.4, 1.95, ZD], [4.4, 1.78, ZD]], tone: P, w: 0.95 },
    { pts: [[4.4, 1.78, ZD], [4.4, 0.6, ZD], ...dcB], tone: P, w: 0.9 },
  ];
  k.flow('dc', dc, { count: 360, min: 60, size: [0.085, 0.07], speed: 0.9, zone: DC, seed: 43 });
  const chip: FlowDef[] = [];
  for (let r = 0; r < 5; r++) {
    const z = -0.5 + r * 0.25;
    chip.push({ pts: [bp(-0.9, 0.62, 0), bp(-0.58, 0.66, z), bp(-0.27, 0.64, z), bp(0.05, 0.62, z * 0.3), bp(0.3, 0.62, 0)], tone: P, w: 0.6 });
  }
  k.flow('chip', chip, { count: 120, min: 30, size: [0.06, 0.05], speed: 0.5, zone: B, seed: 44 });
  const puff = (x: number, y: number, z: number, n: number): FlowDef[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const dx = Math.cos(a) * 0.14;
      const dz = Math.sin(a) * 0.14;
      return { pts: [[x + dx, y, z + dz], [x + dx * 1.4, y + 0.45, z + dz * 1.4], [x + dx * 2, y + 0.95, z + dz * 2]] as V3[], tone: ['heat', 'heat', 'muted'] as const, offset: i / n };
    });
  const lossOpt = { size: [0.08, 0.065] as const, speed: 0.32, fade: 0.25, op: 0.85, sv: 0.3 };
  k.flow('lossGrid', puff(-6.0, 1.0, ZA, 3), { ...lossOpt, count: 36, min: 10, zone: G, seed: 45 });
  k.flow('lossAc', [...puff(-1.5, 1.35, ZA, 3), ...puff(0.8, 1.7, ZA, 5), ...puff(4.4, 2.1, ZA + 0.45, 3)], { ...lossOpt, count: 140, min: 30, zone: AC, seed: 46 });
  k.flow('lossDc', [...puff(-1.3, 1.35, ZD, 3), ...puff(4.4, 2.1, ZD + 0.45, 3)], { ...lossOpt, count: 80, min: 20, zone: DC, seed: 47 });
  k.flow('lossB', puff(...bp(-0.48, 0.7, 0), 3), { ...lossOpt, count: 36, min: 10, zone: B, seed: 48 });

  /* ───────── labels ───────── */
  // Labels whose placement depends on the orientation: on portrait stages the layout is turned
  // −90° and the lanes run top → bottom, so "below the lane" would run into the next piece of
  // equipment. There the tags move beside their lane (AC lane: right, DC lane: left).
  // In the portrait guided steps the active lane's equipment labels also move to its inner side
  // (toward the dimmed lane), leaving the outer side to the voltage / conversion tags (`step`).
  type Spec = Partial<LabelSpec>;
  const orient: { h: LabelHandle; land: Spec; port: Spec; step?: Partial<Record<number, Spec>> | undefined }[] = [];
  const L = (t: string, p: V3, o: Parameters<Kit['label']>[2], port?: Spec, step?: Partial<Record<number, Spec>>) => {
    const h = k.label(t, p, o);
    const land: Spec = { position: p, align: o?.align ?? 'center', offset: o?.offset ?? [0, 0] };
    if (port || step) orient.push({ h, land, port: port ?? land, step });
    return h;
  };
  const inner = (position: V3, side: 'left' | 'right'): Spec => ({ position, align: side, offset: [side === 'left' ? -4 : 4, 0] });
  L('交流供電（現行）', [-8.8, 0, ZA + 1.1], { align: 'below', kind: 'strong', priority: 34, zone: AC, swatch: 'power', short: '交流供電' }, { position: [-7.4, 0, ZA - 1.3], align: 'right', offset: [6, 0] });
  L('800 V 直流（新一代）', [-3.5, 0, ZD + 0.85], { align: 'below', kind: 'strong', priority: 34, zone: DC, swatch: 'power', short: '800 V 直流' }, { position: [-3.0, 0, ZD + 0.5], align: 'left', offset: [-6, 0] });
  L('電網', [-8.8, 3.0, ZA], { align: 'above', priority: 22, hotspot: 'substation', zone: G });
  L('變電站', [-6.0, 1.55, ZA], { align: 'above', priority: 22, hotspot: 'substation', zone: G });
  L('中壓開關設備', [-3.8, 1.65, ZA], { align: 'above', priority: 22, hotspot: 'switchgear', zone: G, short: '中壓開關' }, undefined, { 6: inner([-3.8, 0.9, ZA + 0.4], 'left') });
  L('備用發電機', [-3.35, 1.2, ZA - 2.2], { align: 'above', offset: [24, -4], priority: 14, hotspot: 'generator', zone: G, short: '發電機' }, { position: [-3.8, 0.8, ZA - 2.6], align: 'right', offset: [4, 0] });
  L('變壓器', [-1.5, 1.45, ZA], { align: 'above', priority: 22, hotspot: 'transformer', zone: AC }, undefined, { 6: inner([-1.5, 0.7, ZA + 0.4], 'left') });
  L('UPS 與電池', [0.8, 1.7, ZA], { align: 'above', priority: 22, hotspot: 'ups', zone: AC, short: 'UPS' }, undefined, { 6: inner([0.8, 0.8, ZA + 0.4], 'left') });
  L('匯流排槽', [2.8, 2.35, ZA], { align: 'above', priority: 18, hotspot: 'busway', zone: AC }, undefined, { 6: inner([2.8, 2.25, ZA + 0.1], 'left') });
  L('機櫃電源架', [4.4, 2.3, ZA], { align: 'right', offset: [14, -6], priority: 22, hotspot: 'psu', zone: AC, short: '電源架' }, undefined, { 6: inner([4.4, 1.6, ZA + 0.55], 'left') });
  // The DC lane is the near one in landscape, so its equipment labels reach up into the AC lane:
  // they show in this variant's overview and the 800 V step, not over the AC chain in step 6.
  const dcOnly = ['dc', 'all'];
  L('固態變壓器（SST）', [-1.3, 1.4, ZD], { align: 'above', priority: 22, hotspot: 'sst', zone: DC, short: 'SST', groups: dcOnly }, undefined, { 7: inner([-1.3, 0.7, ZD - 0.4], 'right') });
  L('800 V 直流匯流排', [3.05, 2.18, ZD], { align: 'above', priority: 18, hotspot: 'dc800', zone: DC, short: '800 V 匯流排', groups: dcOnly }, undefined, { 7: inner([3.05, 2.1, ZD - 0.1], 'right') });
  L('直流側儲能', [1.5, 0.0, ZD + 0.35], { align: 'below', offset: [0, 4], priority: 17, hotspot: 'bess', zone: DC, short: '儲能', groups: dcOnly }, undefined, { 7: inner([1.5, 0.6, ZD + 0.35], 'left') }); // (the bus label takes its inner side)
  L('機櫃 DC-DC', [4.4, 2.15, ZD], { align: 'right', offset: [14, -6], priority: 20, hotspot: 'dc800', zone: DC, groups: dcOnly }, undefined, { 7: inner([4.4, 1.6, ZD - 0.55], 'right') });
  L('電壓調節器 VRM', bp(-0.43, 0.48, 0.82), { align: 'below', offset: [0, 4], priority: 22, hotspot: 'vrm', zone: B, short: 'VRM' });
  L('GPU', bp(0.3, 0.65, 0), { align: 'above', offset: [0, -8], priority: 24, hotspot: 'chip', zone: B, swatch: 'highlight' });
  // Voltages on the cables (power swatch) and the conversion at each piece of equipment (heat
  // swatch). Below the DC lane, the voltage tags sit one row lower than the conversion tags so the
  // two rows interleave instead of colliding. The AC lane is the far one in landscape: anything
  // "below" it would land on the DC lane, so its tags sit on the cables and on the equipment
  // fronts (`land`). The 800 V bus is named by its own label.
  type Side = 'ac' | 'dc' | null;
  const tag = (
    t: string,
    p: V3,
    groups: string[],
    zone: string,
    side: Side,
    align: 'above' | 'below' = 'below',
    sw: 'power' | 'heat' = 'power',
    pOff?: readonly [number, number],
    land?: V3,
    landOff: readonly [number, number] = [0, 0],
  ) => {
    const port: Partial<LabelSpec> | undefined =
      side === 'ac'
        ? { position: [p[0], p[1], ZA - 1.15], align: 'right', offset: pOff ?? [4, 0] }
        : side === 'dc'
          ? { position: [p[0], p[1], ZD + 1.0], align: 'left', offset: pOff ?? [-4, 0] }
          : undefined;
    const la = land ? 'center' : align;
    return L(t, land ?? p, { align: la, kind: 'tag', priority: sw === 'heat' ? 10 : 9, groups, zone, swatch: sw, offset: sw === 'power' && la === 'below' ? [0, 16] : landOff }, port);
  };
  tag('高壓交流', [-7.9, 2.4, ZA], ['ac', 'dc'], G, null, 'above');
  tag('中壓交流', [-5.05, 0.1, ZA + 0.3], ['ac'], G, 'ac', 'below', 'power', undefined, [-5.07, 0.1, ZA], [16, 8]);
  tag('低壓交流', [-0.8, 0.1, ZA + 0.3], ['ac'], AC, 'ac', 'below', 'power', [14, 0], [-0.62, 0.1, ZA], [-36, 18]);
  L('低壓直流', [5.55, 0.35, BZ - 0.6], { align: 'below', offset: [0, 16], kind: 'tag', priority: 9, groups: ['ac', 'dc'], zone: B, swatch: 'power' }, { position: [5.55, 0.35, BZ - 0.6], align: 'left', offset: [-6, 0] });
  L('1 V 以下', bp(0.64, 0.6, 0.12), { align: 'right', kind: 'tag', priority: 9, groups: ['ac', 'dc'], zone: B, swatch: 'power' });
  L('中壓交流', [-2.6, 0.1, 0.5], { align: 'left', offset: [-8, 0], kind: 'tag', priority: 9, groups: ['dc'], zone: DC, swatch: 'power' }, { position: [-2.6, 0.1, 0.5], align: 'above', offset: [0, -4] });
  L('降壓', [-6.0, 0.45, ZA + 0.4], { align: 'center', kind: 'tag', priority: 10, groups: ['ac', 'dc'], zone: G, swatch: 'heat' }, { position: [-6.0, 0.25, ZA + 0.5], align: 'left', offset: [-4, 0] });
  tag('降壓', [-1.5, 0.15, ZA + 0.4], ['ac'], AC, 'ac', 'below', 'heat', undefined, [-1.5, 0.62, ZA + 0.2]);
  tag('AC→DC→AC', [0.8, 0.15, ZA + 0.4], ['ac'], AC, 'ac', 'below', 'heat', [4, -12], [0.785, 0.8, ZA + 0.36]);
  tag('AC→DC', [4.4, 0.1, ZA + 0.55], ['ac'], AC, 'ac', 'below', 'heat', undefined, [4.4, 1.0, ZA + 0.52]);
  tag('AC→DC', [-0.95, 0.1, ZD + 0.4], ['dc'], DC, 'dc', 'below', 'heat');
  tag('DC→DC', [4.4, 0.1, ZD + 0.55], ['dc'], DC, 'dc', 'below', 'heat');
  tag('DC→DC', bp(-0.43, 0.72, -0.72), ['ac', 'dc'], B, null, 'above', 'heat');
  L('損耗變成熱', [0.8, 2.45, ZA], { align: 'above', kind: 'tag', priority: 10, groups: ['ac'], zone: AC, swatch: 'heat', short: '損耗→熱' }, { position: [0.8, 1.9, ZA + 0.6], align: 'left', offset: [-4, 0] });

  /* ───────── layout & steps ───────── */
  const POSE: Record<number, CameraPose> = {
    // the home viewing direction, re-aimed at the AC lane (back) or the DC lane (front)
    6: { position: [8.7, 10.9, 13.1], target: [0.8, 0.8, -0.6] },
    7: { position: [8.7, 10.7, 14.6], target: [0.8, 0.6, 0.9] },
  };
  const toWorld = (p: CameraPose) => k.worldPose(p, 0.98);
  let step = -1;
  const placeLabels = () => {
    for (const o of orient) o.h.set(portrait ? (o.step?.[step] ?? o.port) : o.land);
  };
  const layout = (port: boolean) => {
    k.root.rotation.y = port ? -Math.PI / 2 : 0;
    k.root.updateMatrixWorld(true);
    portrait = port;
    placeLabels();
    return true;
  };
  layout(portrait);
  return {
    layout,
    view(i: number): View {
      step = i;
      placeLabels();
      if (step === 6)
        return { pose: toWorld(POSE[6]!), dim: { [DC]: 0.85 }, flows: ['feed', 'ac', 'chip', 'lossGrid', 'lossAc', 'lossB'], labels: ['ac'] };
      if (step === 7)
        return { pose: toWorld(POSE[7]!), dim: { [AC]: 0.8 }, flows: ['feed', 'dc', 'chip', 'lossGrid', 'lossDc', 'lossB'], labels: ['dc'] };
      return { pose: null, labels: ['all'] };
    },
  };
}

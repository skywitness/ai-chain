/**
 * liquid — three cooling approaches side by side, each a lane from the rack (front) to the
 * cooling tower (back), plus illustrative PUE bars in front.
 *
 *  air:       raised-floor plenum → perforated tile → rack (front→back) → hot return → CRAH coil
 *             → chilled water → chiller (evaporator | condenser) → condenser water → cooling tower.
 *  direct:    open-frame rack with one tray pulled out: cold plates on the GPUs, tubes to the rear
 *             manifolds → CDU (pumps + plate heat exchanger) → facility water → cooling tower.
 *  immersion: servers standing in a tank of dielectric fluid; warm fluid rises and returns through
 *             the CDU's heat exchanger → facility water → cooling tower.
 */
import type { CameraPose } from '../../core/types';
import type { FlowDef, Kit, MatKey, V3, View } from './kit';

const LX = [-3.75, 0, 3.75] as const;
const ZONES = ['air', 'dlc', 'imm'] as const;
const TZ = -4.75; // cooling towers
const RF = 0.32; // raised floor height (air lane)

export function liquid(k: Kit, portrait: boolean) {
  const [A, D, I] = ZONES;
  const U = 'pue';

  /* ───────── shared per lane: plinth, cooling tower, facility-water vent ───────── */
  ZONES.forEach((z, i) => {
    const x = LX[i]!;
    k.box(z, 'slab', [3.3, 0.16, 9.1], [x, -0.08, -1.0], { r: 0.06 });
    k.block(z, 'metal', [1.4, 1.1, 1.1], [x, 0, TZ], { r: 0.04, hs: `cooling-tower:${i}` });
    k.box(z, 'coolant', [1.42, 0.1, 1.12], [x, 0.06, TZ]);
    k.cyl(z, 'steel', 0.42, 0.3, [x, 1.25, TZ], { seg: 24, open: true });
    k.fan([x, 1.3, TZ], 0.74, 'y', 1.2 + i * 0.15);
    const lv: number[] = [];
    for (let j = 0; j < 5; j++) lv.push(x - 0.62, 0.25 + j * 0.15, TZ + 0.555, x + 0.62, 0.25 + j * 0.15, TZ + 0.555);
    k.lines(z, 'edge', lv);
  });

  /* ───────── air lane ───────── */
  const xa = LX[0];
  // raised floor: glass plate, pedestals, perforated tile
  k.box(A, 'glass', [2.6, 0.03, 4.1], [xa, RF - 0.015, 0.5]);
  k.frame(A, 'edge', [2.6, 0.001, 4.1], [xa, RF, 0.5], false);
  for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 6; iz++) k.block(A, 'steel', [0.04, RF - 0.03, 0.04], [xa - 1.2 + ix * 0.8, 0, -1.45 + iz * 0.78]);
  k.box(A, 'tintC', [0.8, 0.012, 0.55], [xa + 0.2, RF + 0.006, 2.15], { hs: 'cold-aisle' });
  k.frame(A, 'lineC', [0.8, 0.001, 0.55], [xa + 0.2, RF + 0.012, 2.15], false);
  // rack (front faces +z)
  k.block(A, 'dark', [0.8, 1.9, 0.95], [xa + 0.2, RF, 1.25], { r: 0.02, hs: 'racks:a' });
  for (let j = 0; j < 8; j++) {
    const y = RF + 0.2 + j * 0.21;
    k.box(A, 'steel', [0.7, 0.13, 0.02], [xa + 0.2, y, 1.735]);
    for (const dx of [-0.2, 0, 0.2]) k.cyl(A, 'dark', 0.045, 0.02, [xa + 0.2 + dx, y, 1.75], { axis: 'z', seg: 12 });
    k.box(A, 'led', [0.04, 0.02, 0.01], [xa + 0.5, y + 0.04, 1.748]);
  }
  k.box(A, 'accent', [0.8, 0.02, 0.02], [xa + 0.2, RF + 1.89, 1.73]);
  // CRAH (return grille + coil on top front, fans under the floor)
  k.block(A, 'metal', [1.3, 2.0, 0.75], [xa + 0.2, RF, -1.0], { r: 0.03, hs: 'crah' });
  k.box(A, 'coolant', [1.15, 0.5, 0.02], [xa + 0.2, RF + 1.55, -0.62]);
  k.box(A, 'dark', [0.5, 0.35, 0.02], [xa + 0.2, RF + 0.75, -0.62]);
  for (const dx of [-0.3, 0.3]) k.fan([xa + 0.2 + dx, 0.16, -0.58], 0.24, 'z', dx > 0 ? 1.6 : -1.6);
  // chiller (right of the CRAH so it shows): evaporator (front, cold) + condenser (back, warm) + compressor
  const chx = xa + 0.5;
  k.box(A, 'steel', [1.75, 0.1, 0.85], [chx, 0.05, -2.95], { hs: 'chiller' });
  for (const [z, band] of [[-2.75, 'coolant'], [-3.15, 'heat']] as const) {
    k.cyl(A, 'metal', 0.19, 1.5, [chx, 0.3, z], { axis: 'x', hs: 'chiller' });
    for (const e of [-0.74, 0.74]) k.cyl(A, band as MatKey, 0.2, 0.07, [chx + e, 0.3, z], { axis: 'x' });
  }
  k.block(A, 'steel', [0.5, 0.32, 0.42], [chx - 0.2, 0.48, -2.95], { r: 0.04, hs: 'chiller' });
  // chilled water (CRAH coil ↔ evaporator) and condenser water (condenser ↔ tower)
  const cs = k.pipe(A, 'pipeC', [[chx + 0.75, 0.24, -2.75], [xa + 1.45, 0.24, -2.75], [xa + 1.45, 0.24, -1.15], [xa + 1.45, RF + 1.1, -1.15], [xa + 0.86, RF + 1.1, -1.15]], 0.045);
  const cr = k.pipe(A, 'pipeH', [[xa + 0.86, RF + 1.55, -0.85], [xa + 1.58, RF + 1.55, -0.85], [xa + 1.58, 0.4, -0.85], [xa + 1.58, 0.4, -2.75], [chx + 0.75, 0.4, -2.75]], 0.045);
  const ts = k.pipe(A, 'pipeH', [[chx - 0.75, 0.24, -3.15], [xa - 1.2, 0.24, -3.15], [xa - 1.2, 0.24, TZ], [xa - 1.2, 1.0, TZ], [xa - 0.7, 1.0, TZ]], 0.045);
  const tr = k.pipe(A, 'pipeC', [[xa - 0.7, 0.18, TZ + 0.3], [xa - 1.36, 0.18, TZ + 0.3], [xa - 1.36, 0.4, -3.15], [chx - 0.75, 0.4, -3.15]], 0.045);

  /* ───────── direct-to-chip lane ───────── */
  const xd = LX[1];
  const rx = xd + 0.2;
  for (const [px, pz] of [[-0.38, -0.48], [0.38, -0.48], [-0.38, 0.48], [0.38, 0.48]] as const) k.block(D, 'dark', [0.05, 1.95, 0.05], [rx + px, 0, 1.05 + pz], { hs: 'racks:d' });
  for (const y of [0.025, 1.925]) k.box(D, 'dark', [0.8, 0.05, 1.0], [rx, y, 1.05], { hs: 'racks:d' });
  for (let j = 0; j < 9; j++) {
    if (j > 2 && j < 6) continue;
    const y = 0.18 + j * 0.19;
    k.box(D, 'dark', [0.7, 0.08, 0.95], [rx, y, 1.05]);
    k.box(D, 'steel', [0.7, 0.07, 0.02], [rx, y, 1.535]);
    k.box(D, j === 7 ? 'ledOk' : 'led', [0.04, 0.02, 0.01], [rx + 0.28, y + 0.01, 1.548]);
  }
  k.box(D, 'accent', [0.8, 0.02, 0.02], [rx, 1.9, 1.56]);
  // the pulled-out tray: PCB, GPUs under cold plates, other parts
  const ty = 0.94;
  k.box(D, 'steel', [0.7, 0.04, 0.95], [rx, ty, 2.0], { hs: 'cold-plate' });
  k.box(D, 'pcb', [0.62, 0.016, 0.85], [rx, ty + 0.028, 2.0], { hs: 'cold-plate' });
  for (const dx of [-0.15, 0.15]) {
    k.box(D, 'coolant', [0.2, 0.06, 0.22], [rx + dx, ty + 0.065, 2.12], { r: 0.012, hs: 'cold-plate' });
    k.box(D, 'dark', [0.16, 0.04, 0.08], [rx + dx, ty + 0.055, 1.83]);
  }
  for (const dx of [-0.24, -0.08, 0.08, 0.24]) k.box(D, 'dark', [0.08, 0.03, 0.12], [rx + dx, ty + 0.05, 2.38]);
  // rear manifolds + tray tubes
  const m0: V3 = [rx - 0.33, 0.15, 0.5];
  const m1: V3 = [rx + 0.33, 0.15, 0.5];
  const sup = k.pipe(D, 'pipeC', [[rx - 0.3, 0.15, -0.82], [m0[0], 0.15, 0.5], [m0[0], 1.85, 0.5]], 0.035, { hs: 'cold-plate' });
  const ret = k.pipe(D, 'pipeH', [[m1[0], 1.85, 0.5], [m1[0], 0.12, 0.5], [rx + 0.3, 0.12, -0.82]], 0.035, { hs: 'cold-plate' });
  const yt = ty + 0.07;
  const t1 = k.pipe(D, 'pipeC', [[m0[0], ty, 0.5], [m0[0] + 0.02, yt, 0.62], [m0[0] + 0.02, yt, 2.12], [rx - 0.25, yt, 2.12]], 0.02, { fillet: 0.08 });
  k.pipe(D, 'pipeC', [[rx - 0.05, yt, 2.12], [rx + 0.05, yt, 2.12]], 0.02);
  const t2 = k.pipe(D, 'pipeH', [[rx + 0.25, yt, 2.12], [m1[0] - 0.02, yt, 2.12], [m1[0] - 0.02, yt, 0.62], [m1[0], ty, 0.5]], 0.02, { fillet: 0.08 });
  // CDU + plate heat exchanger
  const cdu = (z: string, x: number, h: number, hs: string) => {
    k.block(z, 'metal', [0.9, h, 0.65], [x, 0, -1.15], { r: 0.03, hs });
    k.box(z, 'coolant', [0.91, 0.1, 0.66], [x, h - 0.08, -1.15]);
    k.box(z, 'dark', [0.45, 0.5, 0.02], [x - 0.1, h * 0.62, -0.82]);
    k.box(z, 'led', [0.25, 0.12, 0.01], [x - 0.1, h * 0.62 + 0.12, -0.808]);
    for (let p = 0; p < 7; p++) k.box(z, 'steel', [0.025, 0.55, 0.42], [x + 0.53 + p * 0.035, 0.45, -1.15], { hs });
    for (const e of [0.495, 0.775]) k.box(z, 'coolant', [0.045, 0.66, 0.5], [x + e, 0.45, -1.15], { hs });
  };
  cdu(D, rx, 1.75, 'cdu:d');
  // facility water (heat exchanger ↔ tower), drawn for both liquid lanes
  const fws = (z: string, x: number, cx: number) => [
    k.pipe(z, 'pipeH', [[cx + 0.8, 0.62, -1.0], [x + 1.25, 0.62, -1.0], [x + 1.25, 0.62, TZ], [x + 1.25, 1.0, TZ], [x + 0.7, 1.0, TZ]], 0.045),
    k.pipe(z, 'pipeC', [[x + 0.7, 0.18, TZ + 0.3], [x + 1.42, 0.18, TZ + 0.3], [x + 1.42, 0.3, -1.3], [cx + 0.8, 0.3, -1.3]], 0.045),
  ];
  const fwsD = fws(D, xd, rx);

  /* ───────── immersion lane ───────── */
  const xi = LX[2];
  const tz = 1.15;
  k.block(I, 'dark', [1.8, 0.1, 1.15], [xi, 0, tz], { r: 0.02, hs: 'immersion' });
  k.block(I, 'glass', [1.8, 0.85, 0.03], [xi, 0.1, tz + 0.56]);
  k.block(I, 'glass', [1.8, 0.85, 0.03], [xi, 0.1, tz - 0.56]);
  for (const s of [-1, 1]) k.block(I, 'glass', [0.03, 0.85, 1.15], [xi + s * 0.885, 0.1, tz]);
  k.frame(I, 'edge', [1.8, 0.85, 1.15], [xi, 0.1, tz]);
  k.block(I, 'glassC', [1.74, 0.68, 1.09], [xi, 0.1, tz], { hs: 'immersion' });
  k.frame(I, 'lineC', [1.74, 0.001, 1.09], [xi, 0.78, tz], false);
  for (let j = 0; j < 9; j++) {
    const x = xi - 0.72 + j * 0.18;
    k.block(I, 'dark', [0.05, 0.82, 0.9], [x, 0.12, tz], { hs: 'immersion' });
    k.box(I, 'steel', [0.07, 0.05, 0.32], [x, 0.97, tz]);
    k.box(I, 'led', [0.012, 0.03, 0.05], [x + 0.03, 0.9, tz + 0.38]);
  }
  cdu(I, xi - 0.1, 1.3, 'cdu:i');
  const fwsI = fws(I, xi, xi - 0.1);
  k.pipe(I, 'pipeC', [[xi - 0.35, 0.18, -0.82], [xi - 0.35, 0.18, tz - 0.62]], 0.045);
  k.pipe(I, 'pipeH', [[xi + 0.45, 0.72, tz - 0.62], [xi + 0.45, 0.72, 0.3], [xi + 0.2, 0.72, -0.82]], 0.045);

  /* ───────── PUE card (illustrative): one board in front of the lanes, a stacked bar per lane ───────── */
  // Bar = total facility power: IT (height IT = "1"), then cooling and distribution/other stacked
  // above the dashed "PUE = 1" line, so everything above the line is overhead (PUE − 1).
  // Heights are 示意 (ordering only, no industry figures).
  const COOL = [0.42, 0.14, 0.06];
  const OTHER = [0.14, 0.1, 0.08];
  const IT = 1.0; // height of "1"
  const BY = 0.035; // top of the bar plinths
  const PZ = 4.4;
  const BW = 0.38;
  const bx = (i: number) => LX[i]! - 0.55;
  const top = (i: number) => BY + IT * (1 + COOL[i]! + OTHER[i]!);
  k.box(U, 'card', [11.3, 0.12, 1.05], [0, -0.06, PZ], { r: 0.05 });
  k.frame(U, 'edge', [11.3, 0.001, 1.05], [0, 0.001, PZ], false);
  for (let i = 0; i < 3; i++) {
    const x = bx(i);
    k.block(U, 'steel', [0.62, BY, 0.62], [x, 0, PZ], { r: 0.01 });
    k.block(U, 'itBar', [BW, IT, BW], [x, BY, PZ], { r: 0.012, hs: `pue:${i}` });
    k.block(U, 'coolant', [BW, COOL[i]! * IT, BW], [x, BY + IT, PZ], { r: 0.012, hs: `pue:${i}` });
    k.block(U, 'power', [BW, OTHER[i]! * IT, BW], [x, BY + IT * (1 + COOL[i]!), PZ], { r: 0.012, hs: `pue:${i}` });
  }
  // dashed "PUE = 1" line along the front faces of the bars
  const dash: number[] = [];
  const yl = BY + IT;
  const zl = PZ + BW / 2 + 0.012;
  for (let x = -5.45; x < 5.4; x += 0.2) dash.push(x, yl, zl, Math.min(x + 0.12, 5.45), yl, zl);
  k.lines(U, 'ink', dash);

  k.floor(0, -1.0, 10, -0.17);
  k.build();

  /* ───────── flows ───────── */
  const C: 'coolant' = 'coolant';
  const Hh: 'heat' = 'heat';
  const air: FlowDef[] = [];
  for (let j = 0; j < 10; j++) {
    const dx = -0.3 + (j % 5) * 0.15;
    const dy = (j % 4) * 0.36;
    const x = xa + 0.2 + dx;
    air.push({
      pts: [[x, RF + 0.35, -1.0], [x, 0.16, -0.55], [x, 0.16, 1.95], [x, RF + 0.18, 2.2], [x, RF + 0.35 + dy, 2.0], [x, RF + 0.3 + dy, 1.76], [x, RF + 0.35 + dy, 0.74], [x, RF + 1.0 + dy * 0.5, 0.45], [x, RF + 2.2, 0.15], [x, RF + 2.2, -0.75], [x, RF + 1.85, -0.98]],
      tone: [C, C, C, C, C, C, Hh, Hh, Hh, Hh, Hh],
      offset: j * 0.1,
    });
  }
  k.flow('air', air, { count: 520, min: 90, size: [0.07, 0.055], speed: 0.6, zone: A, seed: 21 });
  k.flow('wA', [
    { pts: cs, tone: C },
    { pts: cr, tone: Hh },
    { pts: ts, tone: Hh },
    { pts: tr, tone: C },
  ], { count: 260, min: 50, size: [0.065, 0.05], speed: 0.55, zone: A, seed: 22 });

  const tcs: FlowDef[] = [];
  for (let j = 0; j < 3; j++)
    tcs.push({
      pts: [[rx - 0.3, 0.15, -0.82], [m0[0], 0.15, 0.5], ...t1, [rx - 0.15, yt, 2.12], [rx + 0.15, yt, 2.12], ...t2, [m1[0], 0.12, 0.5], [rx + 0.3, 0.12, -0.82]],
      tone: [C, C, ...t1.map(() => C), C, Hh, ...t2.map(() => Hh), Hh, Hh],
      offset: j / 3,
    });
  tcs.push({ pts: [...sup.slice(0, -1), [m0[0], 1.75, 0.5]], tone: C, w: 0.5 });
  tcs.push({ pts: [[m1[0], 1.75, 0.5], ...ret.slice(1)], tone: Hh, w: 0.5 });
  k.flow('tcs', tcs, { count: 320, min: 60, size: [0.06, 0.05], speed: 0.45, zone: D, seed: 23 });
  k.flow('wD', [
    { pts: fwsD[0]!, tone: Hh },
    { pts: fwsD[1]!, tone: C },
  ], { count: 200, min: 40, size: [0.065, 0.05], speed: 0.55, zone: D, seed: 24 });

  const imm: FlowDef[] = [];
  for (let j = 0; j < 8; j++) {
    const gx = xi - 0.63 + j * 0.18;
    imm.push({
      pts: [[xi - 0.35, 0.18, -0.82], [xi - 0.35, 0.18, tz - 0.6], [gx, 0.16, tz - 0.25], [gx, 0.2, tz + 0.2], [gx, 0.6, tz + 0.15], [gx, 0.74, tz - 0.25], [xi + 0.45, 0.72, tz - 0.6], [xi + 0.45, 0.72, 0.3], [xi + 0.2, 0.72, -0.82]],
      tone: [C, C, C, C, Hh, Hh, Hh, Hh, Hh],
      offset: j / 8,
    });
  }
  k.flow('imm', imm, { count: 560, min: 90, size: [0.065, 0.052], speed: 0.35, zone: I, seed: 25 });
  k.flow('wI', [
    { pts: fwsI[0]!, tone: Hh },
    { pts: fwsI[1]!, tone: C },
  ], { count: 200, min: 40, size: [0.065, 0.05], speed: 0.55, zone: I, seed: 26 });
  // warm exhaust above the three cooling towers (one flow for all lanes)
  const vent: FlowDef[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 5; j++) {
      const a = (j / 5) * Math.PI * 2;
      const x = LX[i]! + Math.cos(a) * 0.2;
      const zz = TZ + Math.sin(a) * 0.2;
      vent.push({ pts: [[x, 1.42, zz], [x + 0.05, 2.0, zz - 0.1], [x + 0.2, 2.7, zz - 0.25]], tone: [Hh, 'muted', 'muted'] });
    }
  k.flow('vents', vent, { count: 180, min: 42, size: [0.12, 0.09], speed: 0.3, seed: 30, fade: 0.3, op: 0.5 });

  /* ───────── labels ───────── */
  const L = (t: string, p: V3, o: Parameters<Kit['label']>[2]) => k.label(t, p, o);
  // Lane titles sit under the PUE card, under their lane's bar (they name the bars too, so they
  // belong to the card's zone: kept in the PUE step, dropped on phones in the loop close-up).
  const TZL = PZ + 0.6;
  const titles = [
    L('氣冷', [bx(0), 0, TZL], { align: 'below', kind: 'strong', priority: 34, zone: U }),
    L('直接液冷', [bx(1), 0, TZL], { align: 'below', kind: 'strong', priority: 34, zone: U }),
    L('浸沒式冷卻', [bx(2), 0, TZL], { align: 'below', kind: 'strong', priority: 34, zone: U, short: '浸沒式' }),
  ];
  L('機櫃', [xa + 0.2, RF + 1.95, 1.25], { align: 'above', priority: 16, hotspot: 'racks', zone: A, groups: ['lanes'] });
  L('高架地板', [xa - 1.3, RF, 0.1], { align: 'left', kind: 'tag', priority: 8, zone: A, swatch: 'coolant', groups: ['lanes'] });
  L('空調箱（CRAH）', [xa + 0.2, RF + 2.05, -1.0], { align: 'above', priority: 18, hotspot: 'crah', zone: A, groups: ['lanes'], short: '空調箱' });
  L('冰水主機', [chx + 0.2, 0.1, -2.5], { align: 'below', priority: 18, hotspot: 'chiller', zone: A, groups: ['lanes'] });
  L('冷卻水塔', [xa, 1.45, TZ], { align: 'above', priority: 17, hotspot: 'cooling-tower', zone: A, groups: ['lanes'] });
  L('水冷板', [rx, ty + 0.12, 2.2], { align: 'right', offset: [16, 0], priority: 22, hotspot: 'cold-plate', zone: D, swatch: 'coolant', groups: ['lanes'] });
  L('CDU', [rx, 1.8, -1.15], { align: 'above', priority: 20, hotspot: 'cdu', zone: D, groups: ['lanes'] });
  L('浸沒槽', [xi, 1.0, tz + 0.55], { align: 'right', offset: [40, 0], priority: 20, hotspot: 'immersion', zone: I, swatch: 'coolant', groups: ['lanes'] });
  L('CDU', [xi - 0.1, 1.35, -1.15], { align: 'above', priority: 12, hotspot: 'cdu', zone: I, groups: ['lanes'] });
  L('① 晶片→水冷板', [rx, ty + 0.12, 2.2], { align: 'right', offset: [16, 0], priority: 30, hotspot: 'cold-plate', zone: D, swatch: 'heat', groups: ['loop'] });
  L('② 分歧管', [m0[0], 1.6, 0.5], { align: 'left', offset: [-10, 0], priority: 28, hotspot: 'cold-plate', zone: D, swatch: 'coolant', groups: ['loop'] });
  L('③ CDU 熱交換', [rx + 0.65, 0.85, -1.15], { align: 'right', offset: [12, 0], priority: 28, hotspot: 'cdu', zone: D, groups: ['loop'] });
  const fw = L('④ 設施冷卻水', [xd + 1.33, 0.62, -2.9], { align: 'right', offset: [10, 0], priority: 26, zone: D, swatch: 'coolant', groups: ['loop'] });
  L('⑤ 冷卻水塔', [xd, 1.45, TZ], { align: 'above', priority: 26, hotspot: 'cooling-tower', zone: D, groups: ['loop'] });
  L('熱排到大氣', [xd + 0.25, 2.6, TZ - 0.2], { align: 'above', offset: [0, -6], kind: 'tag', priority: 10, zone: D, swatch: 'heat', groups: ['loop'] });
  const pueTitle = L('PUE（示意）', [-5.65, 0.05, PZ], { align: 'left', offset: [-6, 0], kind: 'strong', priority: 26, hotspot: 'pue', zone: U, groups: ['lanes'] });
  const heading = L('PUE＝設施總用電 ÷ IT 用電', [bx(1), top(0) + 0.42, PZ], { align: 'above', kind: 'strong', priority: 32, hotspot: 'pue', zone: U, groups: ['pue'], short: 'PUE＝總用電 ÷ IT 用電' });
  const verdict = ['PUE 較高', 'PUE 較低', '更接近 1'];
  verdict.forEach((t, i) => L(t, [bx(i), top(i) + 0.04, PZ], { align: 'above', kind: 'tag', priority: 24 - i, zone: U, groups: ['pue'] }));
  L('PUE＝1', [(bx(1) + bx(2)) / 2, yl, zl], { align: 'below', offset: [0, -2], kind: 'tag', priority: 22, zone: U, groups: ['pue'] });
  // Legend at the air-cooling bar's segment heights: on its left (landscape), or on its right
  // (portrait, where the narrow stage has no room left of the first bar). On phones the segments
  // are only a few pixels tall, so the three tags stack as a column right of the bar, around the
  // dashed line: overhead above it, IT below it (the legend outranks the verdict tags there).
  const legendY = [BY + IT / 2, BY + IT * (1 + COOL[0]! / 2), BY + IT * (1 + COOL[0]! + OTHER[0]! / 2) + 0.03];
  const legend = [
    L('IT 設備用電（＝1）', [0, legendY[0]!, PZ], { kind: 'tag', priority: 25, zone: U, swatch: 'seg:ai-accelerators', groups: ['pue'], short: 'IT 用電＝1' }),
    L('冷卻用電', [0, legendY[1]!, PZ], { kind: 'tag', priority: 25, zone: U, swatch: 'coolant', groups: ['pue'] }),
    L('配電損耗等', [0, legendY[2]!, PZ], { kind: 'tag', priority: 24, zone: U, swatch: 'power', groups: ['pue'] }),
  ];
  // portrait offsets fan the three tags apart: the orange segment is thin, and its tag sits just
  // under the 「PUE 較高」 tag above the bar
  const LEGEND_OFF_P = [[8, 3], [8, 5], [10, -2]] as const;
  const LEGEND_OFF_C = [[24, 26], [24, -14], [24, -42]] as const;
  const placeLegend = (port: boolean, compact: boolean) => {
    heading.set({ offset: compact ? [0, -26] : [0, 0] }); // clear of the legend column's top tag
    legend.forEach((h, i) =>
      compact
        ? h.set({ position: [bx(0) + BW / 2 + 0.04, yl, PZ], align: 'right', offset: LEGEND_OFF_C[i]! })
        : h.set({ position: [bx(0) + (port ? 1 : -1) * (BW / 2 + 0.04), legendY[i]!, PZ], align: port ? 'right' : 'left', offset: port ? LEGEND_OFF_P[i]! : [0, 0] }),
    );
  };

  /* ───────── steps ───────── */
  const LOOP: CameraPose = { position: [2.5, 7.4, 9.3], target: [0.25, 0.65, -1.3] };
  // Phones in landscape: a steeper view of the same lane spreads rack → CDU → tower up the screen,
  // so the five numbered labels get a row each (and the PUE card drops out of the frame).
  const LOOP_C: CameraPose = { position: [2.2, 10.5, 6.6], target: [0.2, 0.5, -1.4] };
  const PUE: CameraPose = { position: [-0.5, 5.5, PZ + 8.7], target: [-0.5, 1.0, PZ - 0.45] };
  // Portrait: the lanes are turned −90° (rack on the left, tower on the right, lanes stacked
  // top → bottom) and the PUE card becomes a column at the left; step 5 looks at it from the side
  // (the landscape view turned with the layout), so the bars still stand side by side. Authored
  // for the 4:5 stage and applied exactly (k.exact).
  const PUE_P: CameraPose = { position: [-17.5, 13.0, -0.55], target: [-1.0, 1.2, -0.55] };
  const layout = (port: boolean) => {
    portrait = port;
    k.root.rotation.y = port ? -Math.PI / 2 : 0;
    k.root.updateMatrixWorld(true);
    titles.forEach((h) => h.set({ offset: port ? [0, 6] : [0, 0] }));
    pueTitle.set({ align: port ? 'above' : 'left', offset: port ? [0, -4] : [-6, 0] });
    return true;
  };
  layout(portrait);
  return {
    layout,
    view(step: number): View {
      placeLegend(portrait, k.compact);
      // ④ beside the facility-water pipes; on the turned (portrait) layout ③ shares its row, so ④
      // drops under the pipes instead.
      fw.set(portrait ? { position: [xd + 1.42, 0.3, -2.9], align: 'below', offset: [0, 8] } : { position: [xd + 1.33, 0.62, -2.9], align: 'right', offset: [10, k.compact ? -5 : 0] });
      if (step === 4) return { pose: k.compact && !portrait ? LOOP_C : k.worldPose(LOOP, 1.1), dim: { [A]: 0.9, [I]: 0.9, [U]: 0.9 }, labels: ['loop'] };
      if (step === 5) return { pose: portrait ? k.exact(PUE_P) : PUE, dim: { [A]: 0.85, [D]: 0.85, [I]: 0.85 }, labels: ['pue'] };
      return { pose: null, labels: ['lanes'] };
    },
  };
}

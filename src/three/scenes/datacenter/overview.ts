/**
 * overview — a cutaway AI data hall (front) with its support spaces (back) and outdoor yard.
 *
 *  Hall: 4 rack rows (rows run toward the camera), cold aisles open to the room, hot aisles
 *  contained (glass roof + end doors); a fan wall (CRAH) along the back supplies cold air and takes
 *  the hot return from above; row-end CDUs for liquid cooling; overhead busways feed every rack.
 *  Behind: electrical room (MV switchgear, transformers, UPS, batteries) and cooling plant
 *  (chillers, pumps). Yard: substation, backup generators, cooling towers.
 *  Flows: air (cold → hot loop); power (substation → UPS) + powerHall (UPS → busways); water
 *  (risers, chiller ↔ towers) + waterHall (headers → row-end CDUs). Step 2 hides the hall parts.
 */
import type { CameraPose } from '../../core/types';
import type { FlowDef, Kit, V3, View } from './kit';

const RW = 0.5; // rack width (along z)
const RD = 0.9; // rack depth (along x)
const RH = 1.75;
const N = 8;
const Z0 = -0.6;
const Z1 = Z0 + N * RW;
const ZM = (Z0 + Z1) / 2;
/** Rows: centre x, front direction (±x), cold aisle centre, hot aisle centre. */
const ROWS = [
  { x: -2.65, f: -1, c: -3.55, h: -1.8 },
  { x: -0.95, f: 1, c: 0.2, h: -1.8 },
  { x: 0.95, f: -1, c: -0.2, h: 1.8 },
  { x: 2.65, f: 1, c: 3.55, h: 1.8 },
] as const;
const FAN_Z = -1.72;
const FAN_H = 2.0;
const FAN_FRONT = FAN_Z + 0.225;

export function overview(k: Kit) {
  const H = 'hall', E = 'elec', P = 'plant', Y = 'yard', S = 'shell';

  /* ───────── building shell ───────── */
  k.box(S, 'slab', [9.2, 0.2, 10.4], [0, -0.1, -0.85], { r: 0.06 });
  k.box(S, 'floor', [9.2, 0.12, 3.3], [0, -0.1, -7.75], { r: 0.05 });
  const wall = (len: number, at: V3, alongX: boolean, h = 2.7) => {
    const s: V3 = alongX ? [len, 0.32, 0.1] : [0.1, 0.32, len];
    k.block(S, 'slab', s, at);
    const g: V3 = alongX ? [len, h - 0.32, 0.03] : [0.03, h - 0.32, len];
    k.block(S, 'glass', g, [at[0], 0.32, at[2]]);
    const [x, , z] = at;
    k.lines(S, 'edge', alongX ? [x - len / 2, h, z, x + len / 2, h, z] : [x, h, z - len / 2, x, h, z + len / 2]);
  };
  wall(9.2, [0, 0, -6.0], true);
  wall(10.4, [-4.55, 0, -0.85], false);
  wall(9.1, [0, 0, -2.2], true, 2.45);
  wall(3.8, [0, 0, -4.1], false, 2.45);
  k.lines(S, 'edge', [-4.6, 0.001, 4.25, 4.6, 0.001, 4.25, 4.6, 0.001, 4.25, 4.6, 0.001, -6.05]);

  /* ───────── hall: racks ───────── */
  ROWS.forEach((r, ri) => {
    const fx = r.x + (r.f * RD) / 2;
    for (let i = 0; i < N; i++) {
      const z = Z0 + RW * (i + 0.5);
      k.block(H, 'dark', [RD, RH, RW - 0.025], [r.x, 0, z], { r: 0.02, hs: `racks:${ri}` });
      for (let j = 0; j < 7; j++) {
        const y = 0.28 + j * 0.2;
        k.box(H, 'steel', [0.02, 0.11, 0.4], [fx + r.f * 0.01, y, z]);
        k.box(H, (i + j) % 5 === 0 ? 'ledOk' : 'led', [0.012, 0.022, 0.05], [fx + r.f * 0.024, y, z + 0.13]);
      }
      // tap-off box under the busway
      k.box(H, 'steel', [0.13, 0.08, 0.14], [r.x, 1.96, z]);
    }
    k.box(H, 'accent', [0.025, 0.025, N * RW], [fx + r.f * 0.01, RH - 0.02, ZM]);
    // overhead busway + hanger to the trunk
    k.box(H, 'bus', [0.1, 0.07, N * RW + 0.2], [r.x, 2.05, ZM], { r: 0.015, hs: `busway:${ri}` });
    k.box(H, 'bus', [0.05, 0.45, 0.05], [r.x, 2.28, -0.4], { hs: `busway:${ri}` });
    // row-end CDU (liquid cooling for the row)
    k.block(H, 'metal', [RD, RH, 0.5], [r.x, 0, -0.88], { r: 0.03, hs: `cdu:${ri}` });
    k.box(H, 'coolant', [RD + 0.01, 0.12, 0.51], [r.x, RH - 0.1, -0.88], { hs: `cdu:${ri}` });
    k.box(H, 'dark', [0.02, 0.5, 0.3], [r.x + 0.46, 1.05, -0.88]);
  });
  // cold / hot aisle floor tints and hot-aisle containment
  for (const c of [-3.55, 0, 3.55]) k.box(H, 'tintC', [c === 0 ? 1.0 : 0.9, 0.004, N * RW + 0.5], [c, 0.004, ZM + 0.25], { hs: `cold-aisle:${c}` });
  for (const h of [-1.8, 1.8]) {
    k.box(H, 'tintH', [0.8, 0.004, N * RW], [h, 0.004, ZM]);
    k.box(H, 'glassH', [0.8, 0.02, N * RW], [h, RH + 0.03, ZM], { hs: `hot-aisle:${h}` });
    k.box(H, 'glassH', [0.8, RH, 0.02], [h, RH / 2, Z1 + 0.01], { hs: `hot-aisle:${h}` });
    k.box(H, 'glassH', [0.8, RH, 0.02], [h, RH / 2, Z0 - 0.01]);
    k.frame(H, 'lineH', [0.8, RH + 0.04, N * RW + 0.02], [h, 0, ZM]);
  }
  // busway trunk from the electrical room
  k.box(H, 'bus', [5.4, 0.07, 0.09], [0, 2.5, -0.4], { r: 0.015, hs: 'busway:t' });
  k.box(H, 'bus', [0.09, 0.07, 2.5], [-1.15, 2.5, -1.65], { r: 0.015, hs: 'busway:t' });

  /* ───────── hall: fan wall (CRAH) ───────── */
  for (let u = 0; u < 6; u++) {
    const x = -3.5 + u * 1.4;
    k.block(H, 'metal', [1.36, FAN_H, 0.45], [x, 0, FAN_Z], { r: 0.03, hs: `crah:${u}` });
    k.box(H, 'coolant', [1.2, 0.4, 0.02], [x, 1.58, FAN_FRONT + 0.005]);
    for (const dx of [-0.32, 0.32]) {
      k.cyl(H, 'dark', 0.25, 0.04, [x + dx, 0.62, FAN_FRONT + 0.01], { axis: 'z', seg: 24 });
      k.fan([x + dx, 0.62, FAN_FRONT + 0.04], 0.44, 'z', u % 2 ? 1 : -1);
    }
  }

  /* ───────── electrical room ───────── */
  for (let i = 0; i < 5; i++) {
    const x = -3.9 + i * 0.52;
    k.block(E, 'metal', [0.5, 1.7, 0.7], [x, 0, -5.45], { r: 0.025, hs: 'switchgear' });
    k.box(E, 'dark', [0.4, 0.9, 0.02], [x, 0.95, -5.09]);
    k.box(E, 'ledP', [0.3, 0.03, 0.01], [x, 1.55, -5.085]);
  }
  for (const x of [-3.4, -2.1]) {
    k.box(E, 'steel', [1.0, 0.12, 0.42], [x, 0.06, -4.05], { hs: 'transformer' });
    k.box(E, 'steel', [1.0, 0.12, 0.42], [x, 1.22, -4.05], { hs: 'transformer' });
    for (const dx of [-0.33, 0, 0.33]) k.cyl(E, 'power', 0.15, 1.04, [x + dx, 0.64, -4.05], { seg: 20, hs: 'transformer' });
  }
  for (let i = 0; i < 4; i++) {
    const x = -3.95 + i * 0.46;
    k.block(E, 'dark', [0.42, 1.3, 0.6], [x, 0, -2.85], { r: 0.02, hs: 'ups' });
    k.box(E, 'ledOk', [0.3, 0.025, 0.01], [x, 1.18, -2.545]);
  }
  for (const x of [-1.75, -1.15]) {
    k.block(E, 'metal', [0.56, 1.6, 0.7], [x, 0, -2.9], { r: 0.025, hs: 'ups' });
    k.box(E, 'led', [0.2, 0.12, 0.01], [x, 1.25, -2.545]);
  }
  k.box(E, 'bus', [0.08, 0.9, 0.08], [-1.15, 2.05, -2.9], { hs: 'busway:t' });

  /* ───────── cooling plant ───────── */
  for (const z of [-3.15, -4.65]) {
    k.box(P, 'steel', [2.5, 0.1, 0.95], [2.35, 0.05, z], { hs: 'chiller' });
    k.cyl(P, 'metal', 0.23, 2.2, [2.35, 0.36, z + 0.22], { axis: 'x', hs: 'chiller' });
    k.cyl(P, 'metal', 0.23, 2.2, [2.35, 0.36, z - 0.22], { axis: 'x', hs: 'chiller' });
    for (const x of [1.3, 3.4]) {
      k.cyl(P, 'coolant', 0.245, 0.08, [x, 0.36, z + 0.22], { axis: 'x' });
      k.cyl(P, 'heat', 0.245, 0.08, [x, 0.36, z - 0.22], { axis: 'x' });
    }
    k.block(P, 'steel', [0.75, 0.42, 0.5], [2.0, 0.6, z], { r: 0.04, hs: 'chiller' });
    k.block(P, 'metal', [0.3, 1.0, 0.5], [3.75, 0, z], { r: 0.02 });
  }
  for (let i = 0; i < 3; i++) {
    const z = -2.75 - i * 0.55;
    k.cyl(P, 'coolant', 0.15, 0.3, [0.75, 0.24, z], { axis: 'x' });
    k.cyl(P, 'steel', 0.12, 0.34, [0.45, 0.24, z], { axis: 'x' });
  }

  /* ───────── water: headers, CDU drops, risers, condenser loop ───────── */
  const flowsW: FlowDef[] = []; // plant + yard (chilled-water risers, condenser loops)
  const flowsWH: FlowDef[] = []; // hall (headers → row-end CDUs and back)
  k.pipe(H, 'pipeC', [[-4.2, 2.17, -1.62], [4.2, 2.17, -1.62]], 0.05);
  k.pipe(H, 'pipeH', [[-4.2, 2.33, -1.85], [4.2, 2.33, -1.85]], 0.05);
  const supRise = k.pipe(P, 'pipeC', [[0.9, 0.24, -2.75], [1.05, 0.24, -2.75], [1.05, 2.17, -2.75], [1.05, 2.17, -1.62]], 0.05);
  const retRise = k.pipe(P, 'pipeH', [[1.35, 2.33, -1.85], [1.35, 2.33, -2.6], [1.35, 0.36, -2.6], [1.35, 0.36, -2.93]], 0.05);
  for (const r of ROWS) {
    const s = k.pipe(H, 'pipeC', [[r.x - 0.14, 2.17, -1.62], [r.x - 0.14, 2.17, -0.88], [r.x - 0.14, 1.76, -0.88]], 0.035);
    const h = k.pipe(H, 'pipeH', [[r.x + 0.14, 1.76, -0.88], [r.x + 0.14, 2.33, -0.88], [r.x + 0.14, 2.33, -1.85]], 0.035);
    flowsWH.push({ pts: [...supRise, [r.x - 0.14, 2.17, -1.62] as V3, ...s.slice(1)], tone: 'coolant' });
    flowsWH.push({ pts: [...h, [1.35, 2.33, -1.85] as V3, ...retRise.slice(1)], tone: 'heat' });
  }
  flowsW.push({ pts: supRise, tone: 'coolant', w: 0.6 }, { pts: retRise, tone: 'heat', w: 0.6 });
  const cond: V3[] = [[3.5, 0.36, -3.37], [4.25, 0.36, -3.37], [4.25, 0.36, -7.15], [4.25, 1.0, -7.15]];
  k.pipe(P, 'pipeH', [...cond, [1.5, 1.0, -7.15]], 0.05);
  k.pipe(P, 'pipeC', [[1.5, 0.22, -7.2], [4.4, 0.22, -7.2], [4.4, 0.22, -2.93], [3.5, 0.36, -2.93]], 0.05);
  for (const x of [1.6, 2.7, 3.8]) {
    flowsW.push({ pts: [...cond, [x, 1.0, -7.15], [x, 1.0, -7.6]], tone: ['heat', 'heat', 'heat', 'heat', 'heat', 'coolant'] });
    flowsW.push({ pts: [[x, 0.22, -7.6], [x, 0.22, -7.2], [4.4, 0.22, -7.2], [4.4, 0.22, -2.93], [3.5, 0.36, -2.93]], tone: 'coolant' });
  }

  /* ───────── yard ───────── */
  // substation
  k.box(Y, 'slab', [2.5, 0.08, 2.4], [-3.2, -0.0, -7.85], { r: 0.03 });
  k.block(Y, 'steel', [1.05, 0.95, 0.75], [-3.3, 0, -7.85], { r: 0.03, hs: 'substation' });
  for (let i = 0; i < 5; i++)
    for (const s of [-1, 1]) k.box(Y, 'metal', [0.05, 0.72, 0.5], [-3.3 + s * (0.58 + i * 0.06), 0.45, -7.85], { hs: 'substation' });
  k.cyl(Y, 'steel', 0.12, 0.62, [-3.55, 1.1, -7.85], { axis: 'z' });
  for (const z of [-8.07, -7.85, -7.63]) {
    k.cyl(Y, 'metal', 0.06, 0.42, [-3.05, 1.16, z], { seg: 10 });
    k.cyl(Y, 'power', 0.03, 0.1, [-3.05, 1.42, z], { seg: 8 });
  }
  for (const z of [-8.65, -7.05]) k.block(Y, 'steel', [0.09, 2.4, 0.09], [-4.25, 0, z]);
  k.box(Y, 'steel', [0.09, 0.09, 1.7], [-4.25, 2.4, -7.85]);
  k.frame(Y, 'edge', [2.4, 0.5, 2.3], [-3.2, 0, -7.85], false);
  const seg: number[] = [];
  for (const z of [-8.3, -7.85, -7.4]) seg.push(-6.2, 2.3, z, -4.25, 2.35, z, -4.25, 2.35, z, -3.05, 1.47, z + (-7.85 - z) * 0.5);
  k.lines(Y, 'lineP', seg);
  // generators + their standby feed (dashed) into the MV switchgear
  for (const z of [-7.35, -8.4]) {
    k.block(Y, 'steel', [1.6, 0.85, 0.75], [-0.75, 0, z], { r: 0.04, hs: 'generator' });
    k.box(Y, 'dark', [0.02, 0.5, 0.5], [0.06, 0.45, z]);
    k.cyl(Y, 'dark', 0.06, 0.45, [-1.35, 1.07, z], { seg: 10 });
  }
  k.dashed(Y, 'lineP', [[-1.6, 0.06, -8.4], [-2.0, 0.06, -8.4], [-2.0, 0.06, -5.85]]);
  k.dashed(Y, 'lineP', [[-1.6, 0.06, -7.35], [-1.95, 0.06, -7.35]]);
  // cooling towers
  for (const x of [1.6, 2.7, 3.8]) {
    k.block(Y, 'metal', [1.0, 1.1, 1.0], [x, 0, -7.85], { r: 0.04, hs: 'cooling-tower' });
    k.box(Y, 'coolant', [1.02, 0.1, 1.02], [x, 0.06, -7.85]);
    k.cyl(Y, 'steel', 0.38, 0.3, [x, 1.25, -7.85], { seg: 24, open: true });
    k.fan([x, 1.3, -7.85], 0.66, 'y', 1.3);
    const lv: number[] = [];
    for (let j = 0; j < 5; j++) lv.push(x - 0.45, 0.25 + j * 0.15, -7.345, x + 0.45, 0.25 + j * 0.15, -7.345);
    k.lines(Y, 'edge', lv);
  }

  k.floor(0, -1.6, 11, -0.21);
  k.build();

  /* ───────── flows ───────── */
  const air: FlowDef[] = [];
  ROWS.forEach((r, ri) => {
    const fx = r.x + (r.f * RD) / 2;
    const bx = r.x - (r.f * RD) / 2;
    for (let i = 0; i < N; i++) {
      const z = Z0 + RW * (i + 0.5);
      const y = 0.55 + 0.18 * ((i + ri) % 4);
      air.push({
        pts: [
          [r.c, 0.42, FAN_FRONT + 0.1],
          [r.c, 0.42, z - 0.35],
          [fx + r.f * 0.16, y, z],
          [bx - r.f * 0.14, y + 0.08, z],
          [r.h + r.f * 0.08, y + 0.5, z],
          [r.h, RH + 0.32, z - 0.12],
          [r.h, 2.2, z - 0.6],
          [r.h, 2.2, -0.85],
          [r.h, 1.62, FAN_FRONT + 0.02],
        ],
        tone: ['coolant', 'coolant', 'coolant', 'heat', 'heat', 'heat', 'heat', 'heat', 'heat'],
        offset: ((i * 0.37 + ri * 0.21) % 1),
      });
    }
  });
  k.flow('air', air, { count: 1700, min: 260, size: [0.075, 0.06], speed: 0.75, zone: H, seed: 3 });

  const ups: V3 = [-1.15, 1.6, -2.9];
  const powerHall: FlowDef[] = [];
  const power: FlowDef[] = [
    {
      pts: [[-3.05, 1.45, -7.85], [-3.05, 0.6, -7.2], [-2.9, 0.06, -6.3], [-2.9, 0.06, -5.9], [-2.9, 0.75, -5.45], [-2.9, 0.08, -4.6], [-2.1, 0.08, -4.6], [-2.1, 0.6, -4.05], [-2.1, 0.06, -3.5], [-1.45, 0.06, -3.5], [-1.45, 0.8, -2.9]],
      tone: 'power',
      w: 1.2,
    },
  ];
  for (const r of ROWS)
    powerHall.push({
      pts: [ups, [-1.15, 2.6, -2.9], [-1.15, 2.6, -0.4], [r.x, 2.6, -0.4], [r.x, 2.16, -0.4], [r.x, 2.16, Z0], [r.x, 2.16, Z1 + 0.05]],
      tone: 'power',
    });
  k.flow('power', power, { count: 200, min: 40, size: [0.08, 0.065], speed: 1.1, zone: E, seed: 9 });
  k.flow('powerHall', powerHall, { count: 360, min: 60, size: [0.08, 0.065], speed: 1.1, zone: E, seed: 10 });
  k.flow('water', flowsW, { count: 420, min: 70, size: [0.07, 0.055], speed: 0.7, zone: P, seed: 13 });
  k.flow('waterHall', flowsWH, { count: 560, min: 90, size: [0.07, 0.055], speed: 0.7, zone: P, seed: 14 });

  /* ───────── labels ───────── */
  const L = (t: string, p: V3, o: Parameters<Kit['label']>[2]) => k.label(t, p, o);
  // (not in the aisle step: there the 冷通道 label sits right above it and is the one that matters)
  L('資料大廳', [0.0, 0.0, 4.35], { align: 'below', kind: 'strong', priority: 32, zone: H, swatch: 'flow', groups: ['ov', 'support'] });
  // Zone titles: over the rooms (overview, aisles, and the portrait support view) or beside the
  // building's back corners (landscape support view, where the rooms fill the frame).
  L('電氣室', [-2.4, 2.75, -4.3], { align: 'above', kind: 'strong', priority: 31, zone: E, swatch: 'power', groups: ['ov', 'aisle'] });
  L('冷卻設備區', [2.4, 1.25, -3.9], { align: 'above', kind: 'strong', priority: 31, zone: P, swatch: 'coolant', groups: ['ov', 'aisle'] });
  L('電氣室', [-2.6, 2.45, -2.2], { align: 'below', offset: [0, 6], kind: 'strong', priority: 31, zone: E, swatch: 'power', groups: ['supportP'] });
  L('冷卻設備區', [2.6, 2.45, -2.2], { align: 'below', offset: [0, 6], kind: 'strong', priority: 31, zone: P, swatch: 'coolant', groups: ['supportP'] });
  L('電氣室', [-4.55, 2.7, -6.0], { align: 'left', offset: [-6, 0], kind: 'strong', priority: 31, zone: E, swatch: 'power', groups: ['supportL'] });
  L('冷卻設備區', [4.6, 2.7, -6.0], { align: 'right', offset: [6, 0], kind: 'strong', priority: 31, zone: P, swatch: 'coolant', groups: ['supportL'] });
  L('AI 機櫃列', [-2.65, RH + 0.1, Z1], { align: 'above', priority: 24, hotspot: 'racks', zone: H, groups: ['ov', 'aisle'] });
  L('冷通道', [0.0, 0.05, Z1 + 0.4], { align: 'below', priority: 22, hotspot: 'cold-aisle', zone: H, swatch: 'coolant', groups: ['ov', 'aisle'] });
  L('熱通道封閉', [1.8, RH + 0.05, Z1], { align: 'right', offset: [10, 0], priority: 22, hotspot: 'hot-aisle', zone: H, swatch: 'heat', groups: ['ov', 'aisle'], short: '熱通道' });
  L('空調牆（CRAH）', [-3.5, FAN_H + 0.05, FAN_Z], { align: 'above', priority: 20, hotspot: 'crah', zone: H, groups: ['ov', 'aisle'], short: '空調牆' });
  L('CDU', [-2.65, RH + 0.05, -0.88], { align: 'left', offset: [-8, 0], priority: 16, hotspot: 'cdu', zone: H, groups: ['aisle'] });
  L('匯流排槽', [-0.95, 2.1, Z1 + 0.1], { align: 'above', priority: 14, hotspot: 'busway', zone: H, swatch: 'power', groups: ['aisle'] });
  L('中壓開關設備', [-2.85, 1.75, -5.45], { align: 'above', priority: 18, hotspot: 'switchgear', zone: E, groups: ['support'], short: '中壓開關' });
  L('變壓器', [-2.75, 1.3, -4.05], { align: 'above', priority: 17, hotspot: 'transformer', zone: E, groups: ['support'] });
  L('UPS 與電池', [-1.45, 1.65, -2.9], { align: 'above', priority: 19, hotspot: 'ups', zone: E, groups: ['support'] });
  L('冰水主機', [2.35, 0.9, -3.9], { align: 'above', priority: 18, hotspot: 'chiller', zone: P, groups: ['support'] });
  L('冷卻水塔', [2.7, 1.45, -7.85], { align: 'above', priority: 18, hotspot: 'cooling-tower', zone: Y, groups: ['ov', 'support'] });
  L('變電站', [-3.3, 2.5, -7.85], { align: 'above', priority: 17, hotspot: 'substation', zone: Y, groups: ['ov', 'support'] });
  L('備用發電機', [-0.75, 0.95, -7.85], { align: 'above', priority: 15, hotspot: 'generator', zone: Y, groups: ['support'], short: '發電機' });
  L('冷空氣', [3.55, 0.5, 2.2], { align: 'above', kind: 'tag', priority: 8, zone: H, swatch: 'coolant', groups: ['aisle'] });
  L('熱空氣回風', [1.8, 2.45, -0.9], { align: 'above', kind: 'tag', priority: 8, zone: H, swatch: 'heat', groups: ['aisle'] });

  /* ───────── steps ───────── */
  // Landscape poses go through the host's portrait fit; the portrait ones are authored for a 4:5
  // stage and land exactly (k.exact), since the hall and the support rooms are wider than tall.
  const POSES: Record<number, CameraPose> = {
    1: { position: [7.6, 6.6, 12.2], target: [-0.1, 0.6, 0.6] },
    2: { position: [3.3, 12.6, 1.9], target: [-0.1, 0.45, -5.8] },
  };
  const POSES_P: Record<number, CameraPose> = {
    1: { position: [4.3, 10.9, 12.9], target: [-0.25, 0.5, 0.75] },
    2: { position: [2.6, 15.6, 3.4], target: [0.0, 0.4, -5.6] },
  };
  const pose = (step: number, portrait: boolean) => (portrait ? k.exact(POSES_P[step]!) : POSES[step]!);
  return {
    view(step: number, portrait: boolean): View {
      if (step === 1) return { pose: pose(1, portrait), dim: { [E]: 0.85, [P]: 0.85, [Y]: 0.9 }, flows: ['air'], labels: ['aisle'] };
      if (step === 2)
        return { pose: pose(2, portrait), dim: { [H]: 0.85 }, flows: ['power', 'water'], labels: ['support', portrait || k.compact ? 'supportP' : 'supportL'] };
      return { pose: null, labels: ['ov'] };
    },
  };
}

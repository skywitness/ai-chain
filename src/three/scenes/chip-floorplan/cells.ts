/**
 * Standard-cell inset (the 「放大到標準單元」 zoom): a small, illustrative block of placed and routed
 * logic, generated deterministically.
 *
 * Physical-design facts it encodes:
 *  - standard cells share one height and sit in rows; neighbouring rows are flipped so they share
 *    the VDD / VSS rails that run along the row boundaries;
 *  - cell widths are multiples of the placement site; flip-flops are wide, inverters narrow;
 *  - the synthesised netlist has logic gates, flip-flops and buffers only — clock buffers are added
 *    by clock-tree synthesis (CTS) and filler / tap / decap cells after placement;
 *  - routing uses alternating preferred directions per metal layer (M2 horizontal, M3 vertical)
 *    joined by vias; the clock is distributed by a trunk-and-branch ("fishbone") tree.
 * Local frame: the plate's top at y = 0, rows run along x, x ∈ ±PLATE_W/2, z ∈ ±PLATE_D/2.
 */
import type { Rng } from '../../core/types';

export type CellKind = 'inv' | 'nand' | 'nor' | 'aoi' | 'dff' | 'buf' | 'clk' | 'fill' | 'tap' | 'decap';
export type CellCat = 'logic' | 'ff' | 'buf' | 'phys';

export const CAT_OF: Readonly<Record<CellKind, CellCat>> = {
  inv: 'logic',
  nand: 'logic',
  nor: 'logic',
  aoi: 'logic',
  dff: 'ff',
  buf: 'buf',
  clk: 'buf',
  fill: 'phys',
  tap: 'phys',
  decap: 'phys',
};

export const CELL_NAME: Readonly<Record<CellKind, [string, string]>> = {
  inv: ['INV（反相器）', '把 0 變 1、1 變 0，是最小的邏輯閘。'],
  nand: ['NAND2（反及閘）', '兩個輸入都為 1 時輸出 0；任何邏輯都能只用 NAND 組成。'],
  nor: ['NOR2（反或閘）', '任一輸入為 1 時輸出 0。'],
  aoi: ['AOI21（及或反複合閘）', '把「及、或、反」合成一個元件，比分開用三個閘更小、更快。'],
  dff: ['DFF（D 型正反器）', '在時脈邊緣把資料存起來的暫存元件，是 RTL 裡「暫存器」的實體。'],
  buf: ['BUF（緩衝器）', '加強訊號驅動力，讓訊號能推得更遠、更多負載。'],
  clk: ['CLKBUF（時脈緩衝器）', '時脈樹合成（CTS）時插入，讓時脈同時抵達每個正反器。'],
  fill: ['FILL（填充單元）', '擺放完成後補滿空隙，讓每一列的井區與電源軌連續。'],
  tap: ['TAP（井接觸單元）', '週期性放置，把基板與井區接到電源，避免閂鎖效應。'],
  decap: ['DECAP（去耦電容）', '就近儲存電荷，抵銷電流瞬間變化造成的電壓抖動。'],
};

export const PLATE_W = 4.7;
export const PLATE_D = 2.8;
export const ROWS = 10;
export const ROW_H = 0.24;
export const SITE = 0.05;
const X0 = -2.2;
const X1 = 2.2;
const Z0 = -(ROWS * ROW_H) / 2;

export const rowZ = (r: number) => Z0 + (r + 0.5) * ROW_H;
export const railZ = (r: number) => Z0 + r * ROW_H;

export const Y_M2 = 0.11;
export const Y_M3 = 0.145;
export const Y_CLK = 0.18;

export interface Cell {
  kind: CellKind;
  row: number;
  x: number;
  w: number;
  h: number;
  /** Position in the unplaced "netlist cloud" (synthesis step). */
  cloud: [number, number, number];
  delay: number;
}

export interface Net {
  from: number;
  to: number;
  /** Routed polyline (plate-local) for signal pulses. */
  path: [number, number, number][];
}

export interface Wire {
  kind: 'm2' | 'm3' | 'via' | 'clk';
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** 0..1 reveal order during routing / CTS. */
  order: number;
}

export interface CellBlock {
  cells: Cell[];
  nets: Net[];
  wires: Wire[];
}

const WIDTH: Readonly<Record<CellKind, [number, number]>> = {
  inv: [2, 2],
  nand: [3, 3],
  nor: [3, 4],
  aoi: [5, 6],
  dff: [9, 10],
  buf: [3, 4],
  clk: [4, 4],
  fill: [1, 2],
  tap: [1, 1],
  decap: [4, 5],
};
const HEIGHT: Readonly<Record<CellKind, number>> = {
  inv: 0.045,
  nand: 0.05,
  nor: 0.05,
  aoi: 0.056,
  dff: 0.072,
  buf: 0.054,
  clk: 0.062,
  fill: 0.016,
  tap: 0.026,
  decap: 0.022,
};

export function buildCells(rng: Rng): CellBlock {
  const cells: Cell[] = [];
  const pool: [CellKind, number][] = [
    ['inv', 14],
    ['nand', 18],
    ['nor', 11],
    ['aoi', 9],
    ['dff', 11],
    ['buf', 7],
    ['fill', 9],
    ['decap', 4],
  ];
  const total = pool.reduce((s, [, w]) => s + w, 0);
  const pick = (): CellKind => {
    let r = rng() * total;
    for (const [k, w] of pool) if ((r -= w) < 0) return k;
    return 'nand';
  };
  for (let row = 0; row < ROWS; row++) {
    let x = X0;
    let nextTap = X0 + (row % 2 ? 0.55 : 0.05);
    let clkPlaced = false;
    while (x < X1 - 0.05) {
      let kind: CellKind = pick();
      if (x >= nextTap) {
        kind = 'tap';
        nextTap += 1.1;
      } else if (!clkPlaced && row % 2 === 0 && x > -0.25) {
        kind = 'clk';
        clkPlaced = true;
      }
      const [a, b] = WIDTH[kind];
      let w = (a + rng.int(b - a + 1)) * SITE;
      if (x + w > X1) w = Math.max(SITE, Math.floor((X1 - x) / SITE) * SITE);
      if (w < SITE * 2 && kind !== 'tap' && kind !== 'fill') kind = 'fill';
      cells.push({
        kind,
        row,
        x: x + w / 2,
        w,
        h: HEIGHT[kind],
        // Kept low and inside the plate so the tilted inset does not push cells past its far edge.
        cloud: [rng.range(-2.05, 2.05), rng.range(0.2, 0.5), rng.range(-1.05, 1.1)],
        delay: (row / ROWS) * 0.55 + rng() * 0.25,
      });
      x += w;
    }
  }

  /* nets: each logic / FF / buffer output drives one nearby input (placement keeps nets short) */
  const nets: Net[] = [];
  const wires: Wire[] = [];
  const signal = cells.map((c, i) => [c, i] as const).filter(([c]) => c.kind !== 'clk' && CAT_OF[c.kind] !== 'phys');
  let trackUse = 0;
  for (const [c, i] of signal) {
    if (rng() > 0.5) continue;
    const cand = signal.filter(([o, j]) => j !== i && Math.abs(o.row - c.row) <= 2 && Math.abs(o.x - c.x) < 0.95 && Math.abs(o.x - c.x) > 0.12);
    if (!cand.length) continue;
    const [o, j] = cand[rng.int(cand.length)]!;
    const xs = c.x + c.w / 2 - SITE * 0.6;
    const xt = o.x - o.w / 2 + SITE * 0.6;
    const t = (trackUse++ % 3) - 1;
    const zt = rowZ(c.row) + t * 0.06;
    const zSink = rowZ(o.row) + ((trackUse % 3) - 1) * 0.05;
    const order = (xs + 2.2) / 4.4;
    // M2 (horizontal) from the driver pin, then M3 (vertical) down to the sink row.
    wires.push({ kind: 'via', x: xs, y: (c.h + Y_M2) / 2, z: zt, w: 0.032, h: Y_M2 - c.h, d: 0.032, order });
    wires.push({ kind: 'm2', x: (xs + xt) / 2, y: Y_M2, z: zt, w: Math.abs(xt - xs) + 0.02, h: 0.01, d: 0.018, order });
    if (o.row !== c.row) {
      wires.push({ kind: 'via', x: xt, y: (Y_M2 + Y_M3) / 2, z: zt, w: 0.034, h: Y_M3 - Y_M2, d: 0.034, order });
      wires.push({ kind: 'm3', x: xt, y: Y_M3, z: (zt + zSink) / 2, w: 0.02, h: 0.01, d: Math.abs(zSink - zt) + 0.02, order });
      wires.push({ kind: 'via', x: xt, y: (o.h + Y_M3) / 2, z: zSink, w: 0.032, h: Y_M3 - o.h, d: 0.032, order });
    } else {
      wires.push({ kind: 'via', x: xt, y: (o.h + Y_M2) / 2, z: zt, w: 0.032, h: Y_M2 - o.h, d: 0.032, order });
    }
    const path: [number, number, number][] =
      o.row !== c.row
        ? [
            [xs, Y_M2 + 0.01, zt],
            [xt, Y_M2 + 0.01, zt],
            [xt, Y_M3 + 0.01, zt],
            [xt, Y_M3 + 0.01, zSink],
          ]
        : [
            [xs, Y_M2 + 0.01, zt],
            [xt, Y_M2 + 0.01, zt],
          ];
    nets.push({ from: i, to: j, path });
    if (nets.length >= 76) break;
  }

  /* clock tree: a trunk on an upper layer, branches along rows with flip-flops, stubs to each FF */
  const zTop = rowZ(0) - 0.05;
  const zBot = rowZ(ROWS - 1) + 0.05;
  wires.push({ kind: 'clk', x: 0, y: Y_CLK, z: (zTop + zBot) / 2, w: 0.032, h: 0.012, d: zBot - zTop, order: 0 });
  for (let row = 0; row < ROWS; row++) {
    const ffs = cells.filter((c) => c.row === row && (c.kind === 'dff' || c.kind === 'clk'));
    if (!ffs.length) continue;
    const zb = rowZ(row) + 0.085;
    const xa = Math.min(0, ...ffs.map((c) => c.x));
    const xb = Math.max(0, ...ffs.map((c) => c.x));
    wires.push({ kind: 'clk', x: (xa + xb) / 2, y: Y_CLK - 0.01, z: zb, w: xb - xa + 0.02, h: 0.008, d: 0.018, order: 0.2 + 0.5 * (row / ROWS) });
    for (const f of ffs) {
      wires.push({ kind: 'clk', x: f.x, y: (f.h + Y_CLK) / 2, z: zb, w: 0.018, h: Y_CLK - f.h, d: 0.018, order: 0.5 + 0.5 * Math.abs(f.x) / 2.2 });
    }
  }
  return { cells, nets, wires };
}

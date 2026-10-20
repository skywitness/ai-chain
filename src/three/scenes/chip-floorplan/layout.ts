/**
 * chip-floorplan layout: a generic large AI accelerator die, drawn as a "city" (illustrative,
 * not any specific product). World units, y up, the die top at y = 0, the camera looks from +z.
 *
 *   ┌──────────────── HBM PHY ×3 + memory controllers (north long edge) ───────────────┐
 *   │ SerDes │  compute (SM clusters)  │ L2 │  compute (SM clusters)  │ SerDes / PCIe  │
 *   │  ×6    │  2 × 4 clusters × 6 SM  │band│  2 × 4 clusters × 6 SM  │ CPU / clock    │
 *   └──────────────── HBM PHY ×3 + memory controllers (south long edge) ───────────────┘
 *
 * This mirrors the usual arrangement of big GPUs/ASICs: HBM PHYs on the long edges (facing the
 * HBM stacks beside the die on the interposer), a central L2 / crossbar splitting the die into two
 * halves, I/O (SerDes, PCIe/CXL) and the management complex on the short edges, and a NoC mesh
 * in the streets between compute clusters. Counts are illustrative (「示意」).
 */

export type BlockType = 'compute' | 'l2' | 'noc' | 'hbm' | 'serdes' | 'pcie' | 'cpu' | 'clock';
export type Paint = 'compute' | 'tensor' | 'sram' | 'rf' | 'sched' | 'noc' | 'hbm' | 'serdes' | 'pcie' | 'cpu' | 'clock';
export type Sourcing = 'custom' | 'licensed' | 'mixed';

export const BLOCK_TYPES: readonly BlockType[] = ['compute', 'l2', 'noc', 'hbm', 'serdes', 'pcie', 'cpu', 'clock'];

export const HOTSPOT_OF: Readonly<Record<BlockType, string>> = {
  compute: 'compute-cores',
  l2: 'l2-cache',
  noc: 'noc',
  hbm: 'hbm-phy',
  serdes: 'serdes',
  pcie: 'pcie-cxl',
  cpu: 'cpu-complex',
  clock: 'clock-sensors',
};

/** Typical sourcing of each block in AI accelerators (step 「規格與 IP」). */
export const SOURCING: Readonly<Record<BlockType, Sourcing>> = {
  compute: 'custom',
  l2: 'mixed',
  noc: 'mixed',
  hbm: 'licensed',
  serdes: 'licensed',
  pcie: 'licensed',
  cpu: 'licensed',
  clock: 'licensed',
};
export const SOURCING_TEXT: Readonly<Record<Sourcing, string>> = {
  custom: '多為自研',
  licensed: '多為授權 IP',
  mixed: '自研或授權',
};

export interface Part {
  type: BlockType;
  paint: Paint;
  /** + lightens, − darkens the paint colour. */
  tone: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Bottom height above the die top (default 0). */
  y0: number;
  /** Rounded "building" (true) or flat detail box (false). */
  rounded: boolean;
  /** SM index for compute parts. */
  sm?: number;
  /** Instance number within its block type (cards). */
  idx: number;
}

/* ───────── die ───────── */
export const DIE_W = 8.0;
export const DIE_D = 6.4;
export const DIE_T = 0.16;
export const INTERPOSER = { w: 9.0, d: 10.2, t: 0.1 };
/** Ghost HBM stacks beside the die (on the interposer). */
export const HBM_STACK = { w: 2.0, d: 1.15, h: 0.26, gap: 0.2 };

/* ───────── compute grid ───────── */
export const TILE = 0.36;
const TILE_GAP = 0.05;
const CL_COLS = 3;
const CL_ROWS = 2;
const CL_W = CL_COLS * TILE + (CL_COLS - 1) * TILE_GAP; // 1.18
const CL_D = CL_ROWS * TILE + (CL_ROWS - 1) * TILE_GAP; // 0.77
const HALF_X0 = 0.645; // inner edge of a compute half
const ST_X = 0.2; // street between cluster columns
const ST_Z = 0.24; // street between cluster rows
const ROW_Z0 = -1.9; // north edge of the first cluster row
export const SM_BASE_H = 0.12;

export const CLUSTER_X: readonly number[] = [HALF_X0 + CL_W / 2, HALF_X0 + CL_W + ST_X + CL_W / 2];
export const CLUSTER_Z: readonly number[] = [0, 1, 2, 3].map((r) => ROW_Z0 + r * (CL_D + ST_Z) + CL_D / 2);

/** NoC mesh lines (street centres). */
export const NOC_X: readonly number[] = [-3.31, -1.925, -0.545, 0.545, 1.925, 3.31];
export const NOC_Z: readonly number[] = [-2.14, -1.01, 0, 1.01, 2.14];

export const HBM_X: readonly number[] = [-2.55, 0, 2.55];
const HBM_W = 2.25;
export const HBM_PHY_Z = 2.9;
const HBM_PHY_D = 0.36;
export const HBM_CTL_Z = 2.47;
const HBM_CTL_D = 0.22;

export const IO_X = 3.685; // centre of the short-edge I/O columns
const IO_W = 0.5;

export interface SmInfo {
  x: number;
  z: number;
  side: -1 | 1;
  cluster: number;
}

export interface Layout {
  parts: Part[];
  sms: SmInfo[];
  /** The SM that is lifted / exploded / zoomed into (east half, front, next to the L2). */
  sel: number;
  routers: [number, number][];
  links: { a: [number, number]; b: [number, number] }[];
  l2Rows: number[];
  sensors: [number, number][];
}

export function buildLayout(): Layout {
  const parts: Part[] = [];
  const count: Partial<Record<BlockType, number>> = {};
  const add = (p: Omit<Part, 'idx' | 'y0' | 'tone'> & { y0?: number; tone?: number; idx?: number }) => {
    const idx = p.idx ?? (count[p.type] = (count[p.type] ?? 0) + 1) - 1;
    parts.push({ y0: 0, tone: 0, ...p, idx });
  };

  /* compute: 2 halves × 2 cluster columns × 4 cluster rows × (3 × 2) SMs */
  const sms: SmInfo[] = [];
  let cluster = 0;
  for (const side of [-1, 1] as const) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        const cx = side * CLUSTER_X[c]!;
        const cz = CLUSTER_Z[r]!;
        for (let j = 0; j < CL_ROWS; j++) {
          for (let i = 0; i < CL_COLS; i++) {
            const x = cx + (i - (CL_COLS - 1) / 2) * (TILE + TILE_GAP);
            const z = cz + (j - (CL_ROWS - 1) / 2) * (TILE + TILE_GAP);
            sms.push({ x, z, side, cluster });
          }
        }
        cluster++;
      }
    }
  }
  // Selected SM: east half, inner cluster column, third cluster row, front row, middle column.
  let sel = 0;
  let best = Infinity;
  sms.forEach((s, i) => {
    const d = Math.hypot(s.x - 1.235, s.z - 0.71);
    if (d < best) {
      best = d;
      sel = i;
    }
  });

  sms.forEach((s, sm) => {
    add({ type: 'compute', paint: 'compute', tone: -0.18, x: s.x, z: s.z, w: TILE, d: TILE, h: SM_BASE_H, rounded: true, sm, idx: sm });
    // Four processing blocks (sub-partitions): tensor core, register file, scheduler.
    for (let q = 0; q < 4; q++) {
      const u = (q % 2 === 0 ? -1 : 1) * 0.085;
      const v = q < 2 ? -0.112 : 0.012;
      const y0 = SM_BASE_H;
      add({ type: 'compute', paint: 'tensor', tone: 0.12, x: s.x + u - 0.02, z: s.z + v, w: 0.09, d: 0.095, h: 0.075, y0, rounded: false, sm, idx: sm });
      add({ type: 'compute', paint: 'rf', tone: 0.3, x: s.x + u + 0.048, z: s.z + v + 0.012, w: 0.042, d: 0.07, h: 0.03, y0, rounded: false, sm, idx: sm });
      add({ type: 'compute', paint: 'sched', tone: 0.15, x: s.x + u + 0.048, z: s.z + v - 0.036, w: 0.042, d: 0.022, h: 0.02, y0, rounded: false, sm, idx: sm });
    }
    add({ type: 'compute', paint: 'sram', tone: 0.12, x: s.x, z: s.z + 0.122, w: 0.31, d: 0.07, h: 0.035, y0: SM_BASE_H, rounded: false, sm, idx: sm });
  });

  /* L2: two partitions of SRAM macros in a central band, crossbar in the middle */
  const l2Rows: number[] = [];
  const L2_ROWS = 6;
  const pitch = (1.98 - 0.22) / L2_ROWS;
  for (const zs of [-1, 1]) {
    for (let r = 0; r < L2_ROWS; r++) {
      const z = zs * (0.22 + pitch * (r + 0.5));
      l2Rows.push(z);
      for (const xs of [-1, 1]) {
        const x = xs * 0.215;
        add({ type: 'l2', paint: 'sram', tone: -0.12, x, z, w: 0.37, d: pitch - 0.05, h: 0.085, rounded: true });
        const idx = (count.l2 ?? 1) - 1;
        // Bit-cell arrays either side of the row decoder spine.
        for (const a of [-1, 1]) add({ type: 'l2', paint: 'sram', tone: 0.28, x: x + a * 0.088, z: z - 0.012, w: 0.15, d: pitch - 0.1, h: 0.018, y0: 0.085, rounded: false, idx });
      }
    }
  }
  l2Rows.sort((a, b) => a - b);
  add({ type: 'noc', paint: 'noc', tone: -0.05, x: 0, z: 0, w: 0.86, d: 0.26, h: 0.1, rounded: true });

  /* NoC routers and links (the "streets") */
  const routers: [number, number][] = [];
  for (const x of NOC_X) for (const z of NOC_Z) routers.push([x, z]);
  const links: Layout['links'] = [];
  for (const side of [-1, 1]) {
    const xs = NOC_X.filter((x) => Math.sign(x) === side).sort((a, b) => a - b);
    for (const z of NOC_Z) for (let i = 0; i < xs.length - 1; i++) links.push({ a: [xs[i]!, z], b: [xs[i + 1]!, z] });
    for (const x of xs) for (let i = 0; i < NOC_Z.length - 1; i++) links.push({ a: [x, NOC_Z[i]!], b: [x, NOC_Z[i + 1]!] });
  }
  // Across the L2 band: the crossbar row and the two edge streets.
  for (const z of [NOC_Z[0]!, 0, NOC_Z[4]!]) links.push({ a: [-0.545, z], b: [0.545, z] });
  routers.forEach(([x, z]) => add({ type: 'noc', paint: 'noc', tone: 0.05, x, z, w: 0.13, d: 0.13, h: 0.075, rounded: true }));
  for (const l of links) {
    const horiz = l.a[1] === l.b[1];
    const len = horiz ? Math.abs(l.b[0] - l.a[0]) : Math.abs(l.b[1] - l.a[1]);
    add({
      type: 'noc',
      paint: 'noc',
      tone: -0.25,
      x: (l.a[0] + l.b[0]) / 2,
      z: (l.a[1] + l.b[1]) / 2,
      w: horiz ? len : 0.05,
      d: horiz ? 0.05 : len,
      h: 0.012,
      rounded: false,
      idx: 0,
    });
  }

  /* HBM PHYs + memory controllers on both long edges */
  for (const zs of [-1, 1]) {
    for (const x of HBM_X) {
      add({ type: 'hbm', paint: 'hbm', tone: -0.12, x, z: zs * HBM_PHY_Z, w: HBM_W, d: HBM_PHY_D, h: 0.06, rounded: true });
      const idx = (count.hbm ?? 1) - 1;
      // DQ lanes / bump fields toward the die edge.
      for (let k = 0; k < 14; k++) {
        add({ type: 'hbm', paint: 'hbm', tone: 0.3, x: x + (k - 6.5) * 0.15, z: zs * (HBM_PHY_Z + 0.03), w: 0.075, d: HBM_PHY_D - 0.12, h: 0.022, y0: 0.06, rounded: false, idx });
      }
      add({ type: 'hbm', paint: 'hbm', tone: -0.05, x, z: zs * HBM_CTL_Z, w: HBM_W - 0.35, d: HBM_CTL_D, h: 0.1, rounded: true, idx });
    }
  }

  /* west edge: SerDes ×6 */
  const serdes = (x: number, z: number) => {
    add({ type: 'serdes', paint: 'serdes', tone: -0.12, x, z, w: IO_W - 0.06, d: 0.66, h: 0.085, rounded: true });
    const idx = (count.serdes ?? 1) - 1;
    for (let k = 0; k < 4; k++) add({ type: 'serdes', paint: 'serdes', tone: 0.32, x: x + 0.04, z: z + (k - 1.5) * 0.14, w: IO_W - 0.2, d: 0.06, h: 0.02, y0: 0.085, rounded: false, idx });
  };
  for (let k = 0; k < 6; k++) serdes(-IO_X, -2.3 + 0.37 + k * 0.746);
  /* east edge: SerDes ×3, PCIe/CXL, CPU complex, clock + sensors */
  for (let k = 0; k < 3; k++) serdes(IO_X, -2.3 + 0.37 + k * 0.746);
  add({ type: 'pcie', paint: 'pcie', tone: -0.2, x: IO_X - 0.11, z: 0.47, w: 0.26, d: 0.9, h: 0.11, rounded: true });
  add({ type: 'pcie', paint: 'pcie', tone: 0.05, x: IO_X + 0.14, z: 0.47, w: 0.2, d: 0.9, h: 0.075, rounded: true });
  for (let k = 0; k < 4; k++) add({ type: 'pcie', paint: 'pcie', tone: 0.35, x: IO_X + 0.14, z: 0.47 + (k - 1.5) * 0.2, w: 0.14, d: 0.07, h: 0.02, y0: 0.075, rounded: false, idx: 1 });
  add({ type: 'cpu', paint: 'cpu', tone: -0.3, x: IO_X, z: 1.5, w: IO_W, d: 0.84, h: 0.06, rounded: true });
  for (let k = 0; k < 4; k++)
    add({ type: 'cpu', paint: 'cpu', tone: 0.1, x: IO_X + (k % 2 === 0 ? -0.11 : 0.11), z: 1.3 + (k < 2 ? 0 : 0.21), w: 0.17, d: 0.17, h: 0.08, y0: 0.06, rounded: true, idx: 0 });
  add({ type: 'cpu', paint: 'sram', tone: 0.15, x: IO_X, z: 1.77, w: 0.4, d: 0.16, h: 0.04, y0: 0.06, rounded: false, idx: 0 });
  add({ type: 'clock', paint: 'clock', tone: -0.1, x: IO_X - 0.08, z: 2.14, w: 0.3, d: 0.22, h: 0.09, rounded: true });
  add({ type: 'clock', paint: 'clock', tone: 0.15, x: IO_X + 0.16, z: 2.14, w: 0.13, d: 0.13, h: 0.06, rounded: true });
  // Distributed thermal / voltage sensors at a few street corners.
  const sensors: [number, number][] = [
    [-1.925, -1.01],
    [1.925, 1.01],
    [-1.925, 1.01],
    [1.925, -1.01],
  ];
  for (const [x, z] of sensors) add({ type: 'clock', paint: 'clock', tone: 0.2, x: x + 0.13, z: z + 0.13, w: 0.07, d: 0.07, h: 0.05, rounded: true });

  return { parts, sms, sel, routers, links, l2Rows, sensors };
}

/* ───────── NoC packet routes (dimension-ordered: along one street, then the other) ───────── */

export type RouteKind = 'req' | 'mem' | 'io';
export interface Route {
  kind: RouteKind;
  points: [number, number, number][];
}

const PY = 0.05;
const P = (x: number, z: number): [number, number, number] => [x, PY, z];

export function buildRoutes(l2Rows: readonly number[]): Route[] {
  const routes: Route[] = [];
  const nearestRow = (z: number) => l2Rows.reduce((b, r) => (Math.abs(r - z) < Math.abs(b - z) ? r : b), l2Rows[0]!);
  // SM clusters ⇄ L2 slices (requests and responses).
  let k = 0;
  for (const side of [-1, 1]) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) {
        const cx = side * CLUSTER_X[c]!;
        const street = r === 0 ? -1.01 : r === 3 ? 1.01 : 0;
        const inner = side * 0.545;
        const zL2 = nearestRow(CLUSTER_Z[r]! + (k % 3 - 1) * 0.3);
        const pts = [P(cx, street), P(inner, street), P(inner, zL2), P(side * 0.215, zL2)];
        routes.push({ kind: 'req', points: k % 2 === 0 ? pts : [...pts].reverse() });
        k++;
      }
    }
  }
  // L2 ⇄ memory controllers / HBM PHYs along the edge streets.
  for (const side of [-1, 1]) {
    for (const zs of [-1, 1]) {
      for (const hx of HBM_X) {
        if (hx !== 0 && Math.sign(hx) !== side) continue;
        const zL2 = nearestRow(zs * 1.2);
        const inner = side * 0.545;
        const x = hx === 0 ? side * 0.3 : hx;
        const pts = [P(side * 0.215, zL2), P(inner, zL2), P(inner, zs * 2.14), P(x, zs * 2.14), P(x, zs * 2.4)];
        routes.push({ kind: 'mem', points: pts });
        routes.push({ kind: 'mem', points: [...pts].reverse() });
      }
    }
  }
  // SerDes (west and east) → L2 through the mesh; PCIe → crossbar.
  for (const z of [-1.56, 0.68, 1.43]) {
    const street = NOC_Z.reduce((b, s) => (Math.abs(s - z) < Math.abs(b - z) ? s : b), 0);
    routes.push({ kind: 'io', points: [P(-IO_X + 0.1, z), P(-3.31, z), P(-3.31, street), P(-0.545, street), P(-0.545, nearestRow(street + 0.4)), P(-0.215, nearestRow(street + 0.4))] });
  }
  routes.push({ kind: 'io', points: [P(IO_X - 0.1, -1.56), P(3.31, -1.56), P(3.31, -1.01), P(0.545, -1.01), P(0.545, -0.6), P(0.215, nearestRow(-0.6))] });
  routes.push({ kind: 'io', points: [P(IO_X - 0.25, 0.47), P(3.31, 0.47), P(3.31, 0), P(0.545, 0), P(0, 0)] });
  routes.push({ kind: 'io', points: [P(0, 0), P(-0.545, 0), P(-1.925, 0), P(-3.31, 0), P(-3.31, -0.2), P(-IO_X + 0.1, -0.2)] });
  return routes;
}

/* ───────── power-delivery network (top metal straps + bumps) ───────── */

export const PDN_Y = 0.42;
export const PDN_PITCH = 0.7;
export interface Pdn {
  straps: { x: number; z: number; w: number; d: number; vdd: boolean }[];
  bumps: { x: number; z: number; vdd: boolean }[];
  drops: [number, number, number][][];
}

export function buildPdn(): Pdn {
  const straps: Pdn['straps'] = [];
  const bumps: Pdn['bumps'] = [];
  const drops: [number, number, number][][] = [];
  const nx = 11;
  const nz = 9;
  const xs = Array.from({ length: nx }, (_, i) => (i - (nx - 1) / 2) * PDN_PITCH);
  const zs = Array.from({ length: nz }, (_, i) => (i - (nz - 1) / 2) * PDN_PITCH);
  xs.forEach((x, i) => straps.push({ x, z: 0, w: 0.03, d: DIE_D - 0.3, vdd: i % 2 === 0 }));
  zs.forEach((z, j) => straps.push({ x: 0, z, w: DIE_W - 0.3, d: 0.03, vdd: j % 2 === 0 }));
  xs.forEach((x, i) =>
    zs.forEach((z, j) => {
      const vdd = i % 2 === 0 && j % 2 === 0;
      const vss = i % 2 === 1 && j % 2 === 1;
      if (!vdd && !vss) return;
      bumps.push({ x, z, vdd });
      if (vdd) {
        // Current path: bump → top strap → along the strap → down the via stack into the blocks.
        for (const dir of [-1, 1]) {
          const ex = x + dir * PDN_PITCH * 0.5;
          if (Math.abs(ex) > DIE_W / 2 - 0.3) continue;
          drops.push([
            [x, PDN_Y + 0.22, z],
            [x, PDN_Y + 0.01, z],
            [ex, PDN_Y + 0.01, z],
            [ex, 0.2, z],
          ]);
        }
      }
    }),
  );
  return { straps, bumps, drops };
}

/** Illustrative IR-drop / power-density map over the die (0..1), for the signoff step. */
export function irDrop(x: number, z: number): number {
  const blob = (cx: number, cz: number, r: number) => Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (r * r));
  return Math.min(1, 0.95 * blob(-1.9, -0.55, 1.15) + 0.8 * blob(1.75, 1.05, 1.0) + 0.35 * blob(2.2, -1.6, 0.8));
}

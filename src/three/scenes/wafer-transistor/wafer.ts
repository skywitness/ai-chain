/**
 * Variant `wafer`: a "powers of ten" zoom told with technical-drawing callouts.
 *
 *  Level 0 (step 0, 總覽): a 300 mm wafer (1 unit = 50 mm) with a notch, a grid of identical dies
 *    (one shared floorplan texture), partial edge dies, random defects (示意) and an ambient
 *    wafer-sort probe that marks dies good / bad (yield).
 *  Level 1 (step 1, 晶粒): one die lifts out of the wafer and grows ×6 into a 3D floorplan:
 *    compute cores, SRAM banks, HBM PHY and SerDes I/O (示意 layout).
 *  Level 2 (step 2, 金屬層): a tiny square of one core grows into an exploded interconnect stack:
 *    silicon + transistors (FEOL), eight copper layers with alternating routing directions that get
 *    thicker and sparser upwards, vias and bumps (BEOL). Power particles fall from the bumps through
 *    via stacks; signal particles run along the lower layers.
 *
 * Stage shapes: wide stages put the die and the stack to the right of the wafer; portrait stages
 * stack them upwards; compact 4:3 stages (phones at the default height) keep the wide layout but
 * frame each level tighter (COMPACT poses), with shorter label texts and the overview labels above,
 * on and below the wafer.
 *
 * Reduced motion: no probe sweep (every die is shown already sorted), reveals and the explode are
 * cuts, flows are static dotted streams.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineDashedMaterial,
  MeshBasicMaterial,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Quaternion,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector3,
  type CanvasTexture,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CardContent, CameraPose, Palette, SceneContext } from '../../core/types';
import { canvasTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { scaleCount } from '../../core/quality';
import {
  BoxSet,
  LabelSet,
  Lines,
  STEP,
  calloutPoints,
  exactPose,
  contactShadow,
  homePoseShifted,
  isCompact,
  ease,
  lerp,
  silicon,
  tintShadow,
  worldCorners,
  type Aabb,
  type View,
} from './common';
import { cardFor } from './text';

/* ───────────────────────── geometry constants ───────────────────────── */

const R = 3; // wafer radius (1 unit = 50 mm → 300 mm diameter)
const WAFER_T = 0.06;
const DIE_W = 0.52; // die size on the wafer (示意)
const DIE_D = 0.42;
const SCRIBE = 0.035;
const PX = DIE_W + SCRIBE;
const PZ = DIE_D + SCRIBE;
const EDGE = 0.1; // edge exclusion
const BIG = 6; // die magnification for level 1
const BW = DIE_W * BIG;
const BD = DIE_D * BIG;
const BASE_T = 0.08;
const STACK = 2.4; // stack footprint (level 2)
const MARK = 0.2; // marker square on the big die (local units)
const MARK_UV: [number, number] = [0.318, 0.255]; // marker centre on the die (u, v) — inside a core

const Q0 = new Quaternion();

const LAYOUT = {
  landscape: { die: new Vector3(5.3, 1.25, -1.0), stack: new Vector3(10.1, 0.9, -0.9), tilt: 0.38 },
  portrait: { die: new Vector3(0.5, 3.3, -3.6), stack: new Vector3(0.6, 7.2, -6.6), tilt: 0.55 },
};

const POSES: Record<'landscape' | 'portrait', readonly CameraPose[]> = {
  landscape: [
    { position: [0.4, 6.4, 7.6], target: [0.3, -0.3, 0.3] },
    { position: [5.0, 5.5, 7.1], target: [4.0, 0.75, -0.5] },
    { position: [10.2, 6.4, 10.0], target: [8.6, 2.1, -0.8] },
  ],
  portrait: [
    { position: [0.3, 9.6, 8.6], target: [0.2, -0.5, 0.4] },
    { position: [0.9, 8.6, 9.6], target: [0.4, 2.0, -1.5] },
    { position: [2.97, 14.0, 8.92], target: [0.23, 8.3, -6.63] },
  ],
};

/**
 * Compact 4:3 stages (phones at the default height): the landscape layout framed tighter, so the
 * labels (relatively large on a ~360 px stage) fit beside each level: the wafer centred with its
 * title above and the legend below, then the die and the stack each filling the stage.
 */
const COMPACT: readonly CameraPose[] = [
  { position: [0.12, 4.45, 6.54], target: [0.02, -0.63, 1.0] },
  { position: [5.26, 3.86, 3.65], target: [4.68, 1.05, -0.85] },
  { position: [11.34, 5.78, 6.66], target: [10.22, 2.72, -0.9] },
];

/* ───────────────────────── die floorplan (示意) ───────────────────────── */

type Cat = 'core' | 'tensor' | 'sram' | 'phy' | 'io';
interface Block {
  cat: Cat;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function floorplan(): Block[] {
  const b: Block[] = [];
  b.push(
    { cat: 'phy', u0: 0.022, v0: 0.11, u1: 0.088, v1: 0.89 },
    { cat: 'phy', u0: 0.912, v0: 0.11, u1: 0.978, v1: 0.89 },
  );
  b.push(
    { cat: 'io', u0: 0.13, v0: 0.028, u1: 0.87, v1: 0.074 },
    { cat: 'io', u0: 0.13, v0: 0.926, u1: 0.87, v1: 0.972 },
  );
  for (let i = 0; i < 4; i++)
    b.push({
      cat: 'sram',
      u0: 0.13 + i * 0.185 + 0.006,
      v0: 0.452,
      u1: 0.13 + (i + 1) * 0.185 - 0.006,
      v1: 0.548,
    });
  const cols = 8;
  const rows = 3;
  for (const [va, vb] of [
    [0.095, 0.43],
    [0.57, 0.905],
  ] as const) {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const u0 = 0.13 + c * (0.74 / cols);
        const u1 = u0 + 0.74 / cols;
        const v0 = va + r * ((vb - va) / rows);
        const v1 = v0 + (vb - va) / rows;
        b.push({ cat: 'core', u0: u0 + 0.007, v0: v0 + 0.011, u1: u1 - 0.007, v1: v1 - 0.011 });
        // the matrix / tensor unit takes most of each core
        b.push({ cat: 'tensor', u0: u0 + 0.02, v0: v0 + 0.03, u1: u0 + 0.6 * (u1 - u0), v1: v1 - 0.03 });
      }
  }
  return b;
}

const BLOCK_H: Record<Cat, number> = { core: 0.06, tensor: 0.1, sram: 0.07, phy: 0.05, io: 0.045 };

function catColor(p: Palette, cat: Cat, out = new Color()): Color {
  switch (cat) {
    case 'core':
      return out.copy(p.seg['ai-accelerators']);
    case 'tensor':
      return out.copy(p.seg['ai-accelerators']).lerp(p.fg, p.theme === 'dark' ? 0.32 : 0.22);
    case 'sram':
      return out.copy(p.seg['memory-storage']);
    case 'phy':
      return out.copy(p.seg['datacenter-infra']);
    default:
      return out.copy(p.seg['networking-optics']);
  }
}

/* ───────────────────────── metal stack (示意) ───────────────────────── */

interface Layer {
  dir: 'x' | 'z';
  pitch: number;
  w: number;
  t: number;
  breaks: boolean;
}
// Pitches all divide 0.8, so power via stacks at x, z ∈ {−0.8, 0, 0.8} land on a wire in every layer.
const LAYERS: readonly Layer[] = [
  { dir: 'x', pitch: 0.16, w: 0.06, t: 0.05, breaks: true },
  { dir: 'z', pitch: 0.16, w: 0.06, t: 0.05, breaks: true },
  { dir: 'x', pitch: 0.2, w: 0.08, t: 0.06, breaks: true },
  { dir: 'z', pitch: 0.2, w: 0.08, t: 0.065, breaks: false },
  { dir: 'x', pitch: 0.4, w: 0.13, t: 0.09, breaks: false },
  { dir: 'z', pitch: 0.4, w: 0.15, t: 0.1, breaks: false },
  { dir: 'x', pitch: 0.8, w: 0.3, t: 0.16, breaks: false },
  { dir: 'z', pitch: 0.8, w: 0.34, t: 0.2, breaks: false },
];
const FEOL_TOP = 0.2;
const COMPACT_GAP = 0.05;
const EXPLODE_GAP = 0.3;
const COLS = [-0.8, 0, 0.8];

function layerBase(l: number, e: number): number {
  let y = FEOL_TOP + COMPACT_GAP + EXPLODE_GAP * e;
  for (let i = 0; i < l; i++) y += (LAYERS[i]?.t ?? 0) + COMPACT_GAP + EXPLODE_GAP * e;
  return y;
}
const stackTop = (e: number) => layerBase(LAYERS.length - 1, e) + (LAYERS[LAYERS.length - 1]?.t ?? 0);

interface Wire {
  l: number;
  a: number; // along-axis start
  b: number; // along-axis end
  c: number; // cross-axis centre
}
interface Via {
  l: number; // connects layer l (or FEOL when l = -1) to layer l + 1
  x: number;
  z: number;
  power: boolean;
}

/* ───────────────────────── builder ───────────────────────── */

export function buildWafer(ctx: SceneContext, root: Group): View {
  const { materials, rng } = ctx;
  const p0 = ctx.palette;
  let portrait = ctx.size.portrait;
  let compact = isCompact(ctx.size); // 4:3 phone stage: overview labels stacked like portrait
  const stacked = () => portrait || compact;
  const layout = () => (portrait ? LAYOUT.portrait : LAYOUT.landscape);

  const world = new Group();
  world.name = 'wafer-variant';
  root.add(world);
  const labels = new LabelSet(ctx);

  /* ───────── wafer disc ───────── */
  const shape = new Shape();
  const NOTCH_A = 0.032;
  const seg = 180;
  for (let i = 0; i <= seg; i++) {
    // start just right of the notch (front, +z) and go around
    const a = Math.PI / 2 + NOTCH_A + (i / seg) * (Math.PI * 2 - 2 * NOTCH_A);
    const x = Math.cos(a) * R;
    const y = Math.sin(a) * R;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.lineTo(0, R - 0.085);
  shape.closePath();
  const waferGeo = ctx.track(
    new ExtrudeGeometry(shape, {
      depth: WAFER_T - 0.016,
      bevelEnabled: true,
      bevelThickness: 0.008,
      bevelSize: 0.012,
      bevelSegments: 2,
      curveSegments: 4,
    }),
  );
  waferGeo.rotateX(Math.PI / 2); // shape y → +z, extrusion goes down
  waferGeo.translate(0, -0.008, 0);
  const high = ctx.quality === 'high';
  const waferMat = high
    ? ctx.track(
        new MeshPhysicalMaterial({
          metalness: 0.55,
          roughness: 0.2,
          iridescence: 0.85,
          iridescenceIOR: 1.7,
          iridescenceThicknessRange: [220, 640],
          clearcoat: 0.3,
          clearcoatRoughness: 0.2,
        }),
      )
    : ctx.track(new MeshStandardMaterial({ metalness: 0.5, roughness: 0.24 }));
  materials.bind(waferMat, 'color', (p) => silicon(p).lerp(p.bg, 0.12));
  const wafer = new Mesh(waferGeo, waferMat);
  wafer.name = 'wafer';
  world.add(wafer);
  const shadow = contactShadow(ctx, 9.5, 9.5);
  shadow.position.y = -0.32;
  world.add(shadow);

  /* ───────── floorplan texture (shared by every die) ───────── */
  const blocks = floorplan();
  const TW = 512;
  const TH = Math.round((TW * DIE_D) / DIE_W);
  const drawFloorplan = (g: CanvasRenderingContext2D, w: number, h: number, p: Palette) => {
    const dark = p.theme === 'dark';
    g.clearRect(0, 0, w, h);
    g.fillStyle = silicon(p, new Color())
      .lerp(p.bg, dark ? 0.2 : 0.05)
      .getStyle();
    g.fillRect(0, 0, w, h);
    // NoC: a faint mesh between the cores
    g.strokeStyle = new Color()
      .copy(p.flow)
      .lerp(p.bg, dark ? 0.45 : 0.3)
      .getStyle();
    g.lineWidth = 2;
    g.globalAlpha = 0.8;
    for (let c = 0; c <= 8; c++) {
      const x = (0.13 + (c * 0.74) / 8) * w;
      g.beginPath();
      g.moveTo(x, 0.09 * h);
      g.lineTo(x, 0.91 * h);
      g.stroke();
    }
    g.globalAlpha = 1;
    const tmp = new Color();
    for (const b of blocks) {
      const c = catColor(p, b.cat, tmp);
      if (!dark) c.lerp(p.bg, 0.12);
      g.fillStyle = c.getStyle();
      const x = b.u0 * w;
      const y = b.v0 * h;
      const bw = (b.u1 - b.u0) * w;
      const bh = (b.v1 - b.v0) * h;
      g.fillRect(x, y, bw, bh);
      // fine "standard-cell rows" texture inside logic blocks, bit-cell grid inside SRAM
      g.fillStyle = p.bg.getStyle();
      g.globalAlpha = dark ? 0.3 : 0.25;
      if (b.cat === 'core' || b.cat === 'tensor')
        for (let yy = y + 2; yy < y + bh - 1; yy += 4) g.fillRect(x + 1, yy, bw - 2, 1);
      if (b.cat === 'sram')
        for (let xx = x + 3; xx < x + bw - 1; xx += 6)
          for (let yy = y + 3; yy < y + bh - 1; yy += 6) g.fillRect(xx, yy, 3, 3);
      if (b.cat === 'phy' || b.cat === 'io') {
        const vertical = bh > bw;
        for (let k = 0; k < (vertical ? bh : bw); k += 9)
          vertical ? g.fillRect(x + 2, y + k, bw - 4, 4) : g.fillRect(x + k, y + 2, 4, bh - 4);
      }
      g.globalAlpha = 1;
    }
    // seal ring
    g.strokeStyle = new Color().copy(p.fg).lerp(p.bg, 0.55).getStyle();
    g.lineWidth = 3;
    g.strokeRect(3, 3, w - 6, h - 6);
  };
  const floorTex: CanvasTexture = ctx.track(canvasTexture(TW, TH, (g, w, h) => drawFloorplan(g, w, h, p0)));
  const redrawTexture = (p: Palette) => {
    const g = (floorTex.image as HTMLCanvasElement).getContext('2d');
    if (g) drawFloorplan(g, TW, TH, p);
    floorTex.needsUpdate = true;
  };

  /* ───────── dies on the wafer ───────── */
  interface DieCell {
    x: number;
    z: number;
    r: number;
    bad: boolean;
  }
  const full: DieCell[] = [];
  const partialPos: number[] = [];
  const partialUv: number[] = [];
  const nx = Math.ceil(R / PX) + 1;
  const nz = Math.ceil(R / PZ) + 1;
  const inside = (x: number, z: number, rr: number) => x * x + z * z <= rr * rr;
  const circle: [number, number][] = Array.from({ length: 96 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    return [Math.cos(a) * (R - 0.03), Math.sin(a) * (R - 0.03)];
  });
  for (let iz = -nz; iz <= nz; iz++)
    for (let ix = -nx; ix <= nx; ix++) {
      const x = ix * PX + PX / 2 - PX / 2; // die centres on the grid (one die centred at the origin)
      const z = iz * PZ;
      const x0 = x - DIE_W / 2;
      const x1 = x + DIE_W / 2;
      const z0 = z - DIE_D / 2;
      const z1 = z + DIE_D / 2;
      const corners: [number, number][] = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ];
      const allIn = corners.every(([cx, cz]) => inside(cx, cz, R - EDGE));
      const anyIn = corners.some(([cx, cz]) => inside(cx, cz, R - 0.03)) || inside(x, z, R);
      if (allIn) full.push({ x, z, r: Math.hypot(x, z), bad: false });
      else if (anyIn) {
        // partial die: the die rectangle clipped by the wafer circle (Sutherland–Hodgman on a 96-gon)
        let poly = corners;
        for (let i = 0; i < circle.length && poly.length; i++) {
          const a = circle[i]!;
          const b = circle[(i + 1) % circle.length]!;
          const side = (q: [number, number]) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
          const out: [number, number][] = [];
          for (let k = 0; k < poly.length; k++) {
            const cur = poly[k]!;
            const prev = poly[(k + poly.length - 1) % poly.length]!;
            const sc = side(cur);
            const sp = side(prev);
            if (sc >= 0) {
              if (sp < 0) out.push(cut(prev, cur, sp, sc));
              out.push(cur);
            } else if (sp >= 0) out.push(cut(prev, cur, sp, sc));
          }
          poly = out;
        }
        if (poly.length >= 3) {
          for (let k = 1; k < poly.length - 1; k++)
            for (const q of [poly[0]!, poly[k + 1]!, poly[k]!]) {
              partialPos.push(q[0], 0.003, q[1]);
              partialUv.push((q[0] - x0) / DIE_W, 1 - (q[1] - z0) / DIE_D);
            }
        }
      }
    }
  function cut(a: [number, number], b: [number, number], sa: number, sb: number): [number, number] {
    const t = sa / (sa - sb);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Defects (示意): seeded random points; a die that contains one fails wafer sort.
  const defects: [number, number][] = [];
  for (let i = 0; i < 11; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * (R - 0.25);
    defects.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  for (const d of full)
    d.bad = defects.some(([x, z]) => Math.abs(x - d.x) <= DIE_W / 2 && Math.abs(z - d.z) <= DIE_D / 2);

  // Serpentine probe order (row by row, alternating direction) = wafer-sort order.
  const order = full
    .map((d, i) => ({ d, i }))
    .sort((a, b) =>
      Math.abs(a.d.z - b.d.z) > 1e-3
        ? a.d.z - b.d.z
        : (Math.round(a.d.z / PZ) % 2 ? -1 : 1) * (a.d.x - b.d.x),
    )
    .map((o) => o.i);
  const rank = new Array<number>(full.length);
  order.forEach((di, k) => (rank[di] = k));

  // The die we zoom into: a good die right of centre.
  const pickIdx = full
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !d.bad)
    .sort((a, b) => Math.hypot(a.d.x - 1.3, a.d.z + 0.2) - Math.hypot(b.d.x - 1.3, b.d.z + 0.2))[0]!.i;
  const picked = full[pickIdx]!;

  const quad = ctx.track(new PlaneGeometry(1, 1));
  quad.rotateX(-Math.PI / 2);
  const dieMat = ctx.track(new MeshStandardMaterial({ map: floorTex, roughness: 0.32, metalness: 0.25 }));
  const dies = new InstancedMesh(quad, dieMat, full.length);
  const m4 = new Matrix4();
  full.forEach((d, i) => dies.setMatrixAt(i, m4.makeScale(DIE_W, 1, DIE_D).setPosition(d.x, 0.003, d.z)));
  dies.setColorAt(0, new Color());
  dies.instanceColor?.setUsage(DynamicDrawUsage);
  dies.computeBoundingSphere();
  dies.name = 'dies';
  world.add(dies);
  ctx.track({ dispose: () => dies.dispose() });

  // Wafer-sort map: a translucent green / red film over every die once the probe has tested it.
  const sortMat = ctx.track(
    new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, opacity: 0.5 }),
  );
  const sortMesh = new InstancedMesh(quad, sortMat, full.length);
  sortMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const sortShown = full.map(() => false);
  const sortMatrix = (i: number, on: boolean) => {
    const d = full[i]!;
    sortMesh.setMatrixAt(
      i,
      on ? m4.makeScale(DIE_W - 0.02, 1, DIE_D - 0.02).setPosition(d.x, 0.007, d.z) : m4.makeScale(0, 0, 0),
    );
  };
  full.forEach((_, i) => sortMatrix(i, false));
  sortMesh.setColorAt(0, new Color());
  sortMesh.computeBoundingSphere();
  sortMesh.renderOrder = 1;
  sortMesh.name = 'wafer-sort';
  world.add(sortMesh);
  ctx.track({ dispose: () => sortMesh.dispose() });

  const partialGeo = ctx.track(new BufferGeometry());
  partialGeo.setAttribute('position', new Float32BufferAttribute(partialPos, 3));
  partialGeo.setAttribute('uv', new Float32BufferAttribute(partialUv, 2));
  partialGeo.computeVertexNormals();
  const partialMat = ctx.track(
    new MeshStandardMaterial({
      map: floorTex,
      roughness: 0.45,
      metalness: 0.15,
      transparent: true,
      opacity: 0.55,
    }),
  );
  materials.bind(partialMat, 'color', (p) => p.muted.clone().lerp(p.bg, p.theme === 'dark' ? 0.1 : 0.45));
  const partials = new Mesh(partialGeo, partialMat);
  world.add(partials);

  // Defect markers: tiny dark discs + halos.
  const defectGeo = ctx.track(new CylinderGeometry(0.035, 0.035, 0.012, 14));
  const defectMat = materials.standard('neg', { roughness: 0.5, metalness: 0 });
  const defectMesh = new InstancedMesh(defectGeo, defectMat, defects.length);
  defects.forEach(([x, z], i) => defectMesh.setMatrixAt(i, m4.makeTranslation(x, 0.012, z)));
  defectMesh.computeBoundingSphere();
  world.add(defectMesh);
  ctx.track({ dispose: () => defectMesh.dispose() });
  const glows = ctx.track(new GlowSprites({ count: defects.length + 2, theme: ctx.theme }));
  world.add(glows.object);

  // Scale bar: 100 mm = 2 units, in front of the wafer (front-left on wide stages, centred under the
  // notch on portrait stages).
  const barMat = materials.line('muted', { transparent: true, opacity: 0.9 });
  const bar = new Lines(ctx, barMat, 3);
  const barAt = () =>
    compact ? { bx: -2.95, bz: R - 0.06 } : portrait ? { bx: -1, bz: R + 0.78 } : { bx: -2.7, bz: R + 0.22 };
  const layoutBar = () => {
    const { bx, bz } = barAt();
    bar.set([
      [bx, 0, bz],
      [bx + 2, 0, bz],
      [bx, 0, bz - 0.08],
      [bx, 0, bz + 0.08],
      [bx + 2, 0, bz - 0.08],
      [bx + 2, 0, bz + 0.08],
    ]);
  };
  layoutBar();
  world.add(bar.object);

  /* ───────── level 1: the big die ───────── */
  const dieGroup = new Group();
  dieGroup.name = 'die-level';
  world.add(dieGroup);
  const baseGeo = ctx.track(new BoxGeometry(BW, BASE_T, BD));
  const baseMat = ctx.track(new MeshStandardMaterial({ map: floorTex, roughness: 0.35, metalness: 0.2 }));
  const base = new Mesh(baseGeo, baseMat);
  dieGroup.add(base);
  const rbox = ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.12));
  const blockMat = ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.12 }));
  const blockSet = new BoxSet(ctx, blockMat, blocks.length, rbox);
  const blockAabb = (b: Block): Aabb => {
    const h = BLOCK_H[b.cat];
    return [
      (b.u0 - 0.5) * BW,
      BASE_T / 2,
      (b.v0 - 0.5) * BD,
      (b.u1 - 0.5) * BW,
      BASE_T / 2 + h,
      (b.v1 - 0.5) * BD,
    ];
  };
  blocks.forEach((b, i) => blockSet.set(i, blockAabb(b)));
  blockSet.flush();
  dieGroup.add(blockSet.mesh);
  const markCenter = new Vector3(
    (MARK_UV[0] - 0.5) * BW,
    BASE_T / 2 + BLOCK_H.tensor + 0.004,
    (MARK_UV[1] - 0.5) * BD,
  );
  const markLines = new Lines(ctx, materials.line('highlight', { transparent: true, opacity: 1 }), 4);
  const mh = MARK / 2;
  const mc = markCenter;
  markLines.set([
    [mc.x - mh, mc.y, mc.z - mh],
    [mc.x + mh, mc.y, mc.z - mh],
    [mc.x + mh, mc.y, mc.z - mh],
    [mc.x + mh, mc.y, mc.z + mh],
    [mc.x + mh, mc.y, mc.z + mh],
    [mc.x - mh, mc.y, mc.z + mh],
    [mc.x - mh, mc.y, mc.z + mh],
    [mc.x - mh, mc.y, mc.z - mh],
  ]);
  dieGroup.add(markLines.object);
  const markAnchor = new Group();
  markAnchor.position.copy(markCenter);
  dieGroup.add(markAnchor);

  /* ───────── level 2: the interconnect stack ───────── */
  const stackGroup = new Group();
  stackGroup.name = 'stack-level';
  world.add(stackGroup);
  const S = STACK / 2;
  const subMat = materials.standard((p) => silicon(p), { roughness: 0.55, metalness: 0.15 });
  const substrate = new Mesh(ctx.track(new BoxGeometry(STACK, 0.42, STACK)), subMat);
  substrate.position.y = -0.21;
  stackGroup.add(substrate);
  // FEOL: fins along x, gates along z (a tiny FinFET / GAA array)
  const feolMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 }));
  const fins = Array.from({ length: 6 }, (_, i) => -1.0 + i * 0.4);
  const gates = Array.from({ length: 8 }, (_, j) => -1.05 + j * 0.3);
  const feol = new BoxSet(ctx, feolMat, fins.length + gates.length);
  fins.forEach((z, i) => feol.set(i, [-S + 0.06, 0, z - 0.035, S - 0.06, 0.12, z + 0.035]));
  gates.forEach((x, j) =>
    feol.set(fins.length + j, [x - 0.045, 0, -S + 0.08, x + 0.045, FEOL_TOP, S - 0.08]),
  );
  feol.flush();
  stackGroup.add(feol.mesh);

  // BEOL wires
  const wires: Wire[] = [];
  LAYERS.forEach((L, l) => {
    const n = Math.floor((S - L.w) / L.pitch);
    for (let k = -n; k <= n; k++) {
      const c = k * L.pitch;
      if (!L.breaks) {
        wires.push({ l, a: -S + 0.04, b: S - 0.04, c });
        continue;
      }
      // local wires: 1–3 segments with gaps that never fall on a power column
      let a = -S + 0.04;
      while (a < S - 0.2) {
        let b = Math.min(S - 0.04, a + 0.5 + rng() * 1.3);
        if (COLS.some((cc) => Math.abs(b - cc) < 0.2)) b = Math.min(S - 0.04, b + 0.3);
        wires.push({ l, a, b, c });
        a = b + 0.12 + rng() * 0.12;
        if (COLS.some((cc) => a - 0.2 < cc && cc < a + 0.05)) a += 0.25;
      }
    }
  });
  const vias: Via[] = [];
  for (const x of COLS)
    for (const z of COLS)
      if (Math.abs(x) + Math.abs(z) > 0 && Math.abs(x * z) > 0)
        for (let l = -1; l < LAYERS.length - 1; l++) vias.push({ l, x, z, power: true });
  for (let l = 0; l < LAYERS.length - 1; l++) {
    const A = LAYERS[l]!;
    const B = LAYERS[l + 1]!;
    const count = Math.max(2, 9 - l);
    for (let k = 0; k < count; k++) {
      const ca = Math.round(((rng() * 2 - 1) * (S - 0.25)) / A.pitch) * A.pitch;
      const cb = Math.round(((rng() * 2 - 1) * (S - 0.25)) / B.pitch) * B.pitch;
      const [x, z] = A.dir === 'x' ? [cb, ca] : [ca, cb];
      vias.push({ l, x, z, power: false });
    }
  }
  for (let k = 0; k < 8; k++)
    vias.push({
      l: -1,
      x: gates[(k * 3) % gates.length]!,
      z: Math.round((rng() * 2 - 1) * 5) * 0.16,
      power: false,
    });

  const wireMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.55 }));
  const wireSet = new BoxSet(ctx, wireMat, wires.length);
  stackGroup.add(wireSet.mesh);
  const viaGeo = ctx.track(new CylinderGeometry(0.5, 0.5, 1, 10));
  const viaMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }));
  const viaMesh = new InstancedMesh(viaGeo, viaMat, vias.length);
  viaMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  viaMesh.setColorAt(0, new Color());
  stackGroup.add(viaMesh);
  ctx.track({ dispose: () => viaMesh.dispose() });
  const bumpGeo = ctx.track(new SphereGeometry(0.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2));
  const bumpMat = materials.standard((p) => p.fg.clone().lerp(p.bg, p.theme === 'dark' ? 0.25 : 0.45), {
    roughness: 0.25,
    metalness: 0.6,
  });
  const bumpPos = COLS.flatMap((x) => COLS.map((z) => [x, z] as const));
  const bumps = new InstancedMesh(bumpGeo, bumpMat, bumpPos.length);
  stackGroup.add(bumps);
  ctx.track({ dispose: () => bumps.dispose() });

  let explode = 0;
  const vScale = new Vector3();
  const vPos = new Vector3();
  const layoutStack = (e: number) => {
    wires.forEach((w, i) => {
      const L = LAYERS[w.l]!;
      const y0 = layerBase(w.l, e);
      const box: Aabb =
        L.dir === 'x'
          ? [w.a, y0, w.c - L.w / 2, w.b, y0 + L.t, w.c + L.w / 2]
          : [w.c - L.w / 2, y0, w.a, w.c + L.w / 2, y0 + L.t, w.b];
      wireSet.set(i, box);
    });
    wireSet.flush();
    vias.forEach((v, i) => {
      const y0 = v.l < 0 ? FEOL_TOP : layerBase(v.l, e) + LAYERS[v.l]!.t;
      const y1 = layerBase(v.l + 1, e);
      const r = v.l < 0 ? 0.045 : Math.min(LAYERS[v.l]!.w, LAYERS[v.l + 1]!.w) * 0.62;
      viaMesh.setMatrixAt(
        i,
        m4.compose(vPos.set(v.x, (y0 + y1) / 2, v.z), Q0, vScale.set(r, Math.max(1e-4, y1 - y0), r)),
      );
    });
    viaMesh.instanceMatrix.needsUpdate = true;
    viaMesh.computeBoundingSphere();
    const top = stackTop(e);
    bumpPos.forEach(([x, z], i) => bumps.setMatrixAt(i, m4.makeTranslation(x, top, z)));
    bumps.instanceMatrix.needsUpdate = true;
    bumps.computeBoundingSphere();
  };
  layoutStack(0);

  // Flows on the exploded stack: power falls from the bumps through via stacks; signals run along M1/M2.
  const top1 = stackTop(1);
  const powerPaths: FlowPath[] = bumpPos
    .filter(([x, z]) => Math.abs(x * z) > 0)
    .map(([x, z]) => ({
      points: [
        [x, top1 + 0.12, z],
        [x, layerBase(4, 1), z],
        [x, FEOL_TOP + 0.02, z],
      ],
    }));
  const sigPaths: FlowPath[] = [
    [0.16, -0.48, 0.96, 1],
    [-0.32, 0.64, -0.96, 1],
    [0.48, 0.32, -0.48, 2],
  ].map(([x0, z0, x1, l]) => {
    const yL = layerBase(l!, 1) + LAYERS[l!]!.t + 0.03;
    const y1 = layerBase(1, 1) + LAYERS[1]!.t + 0.03;
    return {
      points: [
        [x0!, FEOL_TOP, z0!],
        [x0!, y1, z0!],
        [x0!, yL, z0!],
        [x1!, yL, z0!],
        [x1!, FEOL_TOP, z0!],
      ] as [number, number, number][],
    };
  });
  const PMAX = 160;
  const SMAX = 120;
  const powerFlow = ctx.track(
    new PathFlow({
      paths: powerPaths,
      count: scaleCount(PMAX, ctx.tier, 24),
      size: 0.11,
      speed: 0.9,
      smooth: false,
      theme: ctx.theme,
      seed: 3,
    }),
  );
  const sigFlow = ctx.track(
    new PathFlow({
      paths: sigPaths,
      count: scaleCount(SMAX, ctx.tier, 18),
      size: 0.09,
      speed: 0.8,
      smooth: false,
      theme: ctx.theme,
      seed: 5,
    }),
  );
  for (const f of [powerFlow, sigFlow]) {
    f.object.material.depthTest = false;
    f.setReduced(!ctx.animate);
    f.object.visible = false;
    stackGroup.add(f.object);
  }

  /* ───────── callouts ───────── */
  const dashMat = ctx.track(
    new LineDashedMaterial({ dashSize: 0.14, gapSize: 0.09, transparent: true, toneMapped: false }),
  );
  materials.bind(dashMat, 'color', 'highlight');
  const call1 = new Lines(ctx, dashMat, 8);
  const call2 = new Lines(ctx, dashMat, 8);
  world.add(call1.object, call2.object);
  const pickOutline = new Lines(ctx, materials.line('highlight'), 4);
  {
    const x0 = picked.x - DIE_W / 2 - 0.012;
    const x1 = picked.x + DIE_W / 2 + 0.012;
    const z0 = picked.z - DIE_D / 2 - 0.012;
    const z1 = picked.z + DIE_D / 2 + 0.012;
    const y = 0.006;
    pickOutline.set([
      [x0, y, z0],
      [x1, y, z0],
      [x1, y, z0],
      [x1, y, z1],
      [x1, y, z1],
      [x0, y, z1],
      [x0, y, z1],
      [x0, y, z0],
    ]);
  }
  world.add(pickOutline.object);

  /* ───────── reveal state ───────── */
  let r1 = 0;
  let r2 = 0;
  let hotDie = 0;
  const srcDie = new Vector3(picked.x, 0.004, picked.z);
  const tmpV = new Vector3();
  const applyReveal = () => {
    const L = layout();
    const k1 = ease(r1);
    dieGroup.visible = r1 > 0.002;
    dieGroup.position.lerpVectors(srcDie, L.die, k1);
    dieGroup.rotation.set(L.tilt * k1, 0, 0);
    dieGroup.scale.setScalar(lerp(1 / BIG, 1, k1));
    dieGroup.updateMatrixWorld(true);
    call1.object.visible = r1 > 0.02;
    pickOutline.object.visible = r1 > 0.02 || r2 > 0;
    if (call1.object.visible) {
      const hx = DIE_W / 2;
      const hz = DIE_D / 2;
      const a: [number, number, number][] = [
        [picked.x - hx, 0.006, picked.z - hz],
        [picked.x + hx, 0.006, picked.z - hz],
        [picked.x + hx, 0.006, picked.z + hz],
        [picked.x - hx, 0.006, picked.z + hz],
      ];
      const b = worldCorners(dieGroup, BW / 2, BD / 2, -BASE_T / 2);
      call1.set(calloutPoints(a, b));
      call1.object.computeLineDistances();
    }
    const k2 = ease(r2);
    stackGroup.visible = r2 > 0.002;
    markLines.object.visible = r2 > 0.02;
    call2.object.visible = r2 > 0.02;
    const src = markAnchor.getWorldPosition(tmpV);
    const s0 = (MARK / STACK) * dieGroup.scale.x;
    stackGroup.position.lerpVectors(src, L.stack, k2);
    stackGroup.scale.setScalar(lerp(s0, 1, k2));
    stackGroup.updateMatrixWorld(true);
    if (call2.object.visible) {
      const a = worldCorners(markAnchor, MARK / 2, MARK / 2, 0);
      const b = worldCorners(stackGroup, S, S, -0.42);
      call2.set(calloutPoints(a, b));
      call2.object.computeLineDistances();
    }
    glows.setAlpha(defects.length + 1, Math.max(r1, hotDie) * (ctx.theme === 'dark' ? 0.7 : 0.45));
    const flowsOn = r2 > 0.98 && explode > 0.98;
    powerFlow.object.visible = sigFlow.object.visible = flowsOn;
  };

  /* ───────── probe sweep (wafer sort) ───────── */
  let probe = ctx.animate ? 0 : full.length + 1;
  let fade = ctx.animate ? 0 : 1; // 1 → marks visible; fades to 0 before the next sweep
  const RATE = 13; // dies per second
  const HOLD = 3.2;
  const dieBase: Color[] = full.map(() => new Color());
  const cGood = new Color();
  const cBad = new Color();
  let sortAlpha = 0.5;
  const cProbe = new Color();
  const probePos = new Vector3(); // scratch (paintDies runs every frame)
  const tmpC = new Color();
  const paintDies = () => {
    const pr = Math.floor(probe);
    let moved = false;
    full.forEach((d, i) => {
      tmpC.copy(dieBase[i]!);
      const tested = rank[i]! < pr && fade > 0.001;
      if (tested && d.bad) tmpC.lerp(cBad, 0.35 * fade);
      if (rank[i] === pr && probe < full.length) tmpC.lerp(cProbe, 0.55);
      dies.setColorAt(i, tmpC);
      if (tested !== sortShown[i]) {
        sortShown[i] = tested;
        sortMatrix(i, tested);
        moved = true;
      }
    });
    if (dies.instanceColor) dies.instanceColor.needsUpdate = true;
    if (moved) sortMesh.instanceMatrix.needsUpdate = true;
    sortMat.opacity = sortAlpha * fade;
    const cur = order[Math.min(order.length - 1, Math.max(0, pr))]!;
    const on = probe < full.length && ctx.animate;
    const d = full[cur]!;
    glows.set(
      defects.length,
      probePos.set(d.x, 0.05, d.z),
      0.9,
      cProbe,
      on ? (ctx.theme === 'dark' ? 0.9 : 0.55) : 0,
    );
  };

  /* ───────── palette ───────── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    redrawTexture(p);
    tintShadow(shadow, p, 1.4);
    cGood.copy(p.pos);
    cBad.copy(p.neg);
    cProbe.copy(p.highlight);
    sortAlpha = dark ? 0.42 : 0.5;
    full.forEach((d, i) => sortMesh.setColorAt(i, d.bad ? p.neg : p.pos));
    if (sortMesh.instanceColor) sortMesh.instanceColor.needsUpdate = true;
    const a = p.chart[5] ?? p.flow;
    const b = p.chart[4] ?? p.optic;
    full.forEach((d, i) => {
      // a gentle iridescent drift across the wafer
      const t = d.r / R;
      dieBase[i]!.setRGB(1, 1, 1)
        .lerp(a, 0.1 * t)
        .lerp(b, 0.1 * (1 - t));
      if (!dark) dieBase[i]!.multiplyScalar(0.97);
    });
    blocks.forEach((bl, i) => blockSet.color(i, catColor(p, bl.cat, tmpC)));
    const copper = tmpC.copy(p.power).lerp(p.heat, 0.4);
    wires.forEach((w, i) => {
      const c = copper.clone().lerp(p.fg, dark ? 0.12 + 0.02 * (7 - w.l) : 0.04);
      if (!dark) c.lerp(p.bg, 0.05 * (7 - w.l));
      wireSet.color(i, c);
    });
    vias.forEach((v, i) =>
      viaMesh.setColorAt(i, v.power ? p.power : copper.clone().lerp(p.fg, dark ? 0.35 : 0.15)),
    );
    if (viaMesh.instanceColor) viaMesh.instanceColor.needsUpdate = true;
    fins.forEach((_, i) => feol.color(i, silicon(p, new Color()).lerp(p.fg, dark ? 0.35 : 0.1)));
    gates.forEach((_, j) => feol.color(fins.length + j, p.chart[1] ?? p.power));
    glows.setTheme(p.theme);
    defects.forEach(([x, z], i) => glows.set(i, [x, 0.03, z], dark ? 0.36 : 0.26, p.neg, dark ? 0.75 : 0.55));
    const sel = defects.length + 1;
    glows.set(sel, [picked.x, 0.04, picked.z], 1.0, p.highlight, 0);
    powerFlow.recolor(() => p.power);
    sigFlow.recolor(() => p.flow);
    for (const f of [powerFlow, sigFlow]) {
      f.setTheme(p.theme);
      f.setSize(dark ? 0.11 : 0.08);
    }
    paintDies();
  };

  /* ───────── labels ───────── */
  const strongly = (s: number) => s === STEP.overview;
  const waferTitle = labels.add(
    { text: '晶圓・直徑 300 mm', kind: 'strong', priority: 30, hotspot: 'wafer' },
    strongly,
  );
  const barLabel = labels.add({ text: '100 mm', align: 'below', kind: 'tag', priority: 8 }, strongly);
  const aDie = full.reduce(
    (best, d) => (Math.hypot(d.x + 1.6, d.z + 1.4) < Math.hypot(best.x + 1.6, best.z + 1.4) ? d : best),
    full[0]!,
  );
  const dieLabel = labels.add(
    { text: '晶粒（die）', position: [aDie.x, 0.02, aDie.z], align: 'above', priority: 22, hotspot: 'die' },
    strongly,
  );
  const firstDefect = defects.reduce((best, d) => (d[0] - d[1] > best[0] - best[1] ? d : best), defects[0]!);
  labels.add(
    {
      text: '缺陷（示意）',
      position: [firstDefect[0], 0.03, firstDefect[1]],
      align: 'right',
      kind: 'tag',
      priority: 14,
      hotspot: 'yield',
    },
    strongly,
  );
  const edgeLabel = labels.add({ text: '邊緣不完整晶粒', kind: 'tag', priority: 10 }, strongly);
  labels.add(
    { text: '缺口（notch）', position: [0, 0, R + 0.02], align: 'below', kind: 'tag', priority: 6 },
    strongly,
  );
  const sortLabel = labels.add(
    { text: '晶圓測試：綠＝良品、紅＝不良', kind: 'muted', priority: 16, hotspot: 'yield' },
    strongly,
  );
  /** Overview labels that move to the free space of the stage shape (beside vs above / below). */
  const layoutOverviewLabels = () => {
    const { bx, bz } = barAt();
    barLabel.set({ position: [bx + 1, 0, bz + 0.05] });
    dieLabel.set({ align: compact ? 'center' : 'above' });
    if (compact) {
      // 4:3 phone stage: title on top, legend at the bottom, the rest sits on the wafer itself
      waferTitle.set({ position: [0, 0, -R + 0.3], align: 'above' });
      edgeLabel.set({ position: [-R * 0.86, 0, 0.62], align: 'center' });
      sortLabel.set({ position: [0, 0, R + 0.85], align: 'below' });
    } else if (portrait) {
      waferTitle.set({ position: [0, 0, -R - 0.05], align: 'above' });
      edgeLabel.set({ position: [R * 0.74, 0, -R * 0.66], align: 'above' });
      sortLabel.set({ position: [0, 0, R + 1.3], align: 'below' });
    } else {
      waferTitle.set({ position: [-R * 0.72, 0, R * 0.74], align: 'left' });
      edgeLabel.set({ position: [R * 0.97, 0, -0.2], align: 'right' });
      sortLabel.set({ position: [R * 0.55, 0, R * 0.9], align: 'right' });
    }
  };
  layoutOverviewLabels();
  labels.add(
    {
      text: '放大這顆',
      position: [picked.x, 0.02, picked.z - DIE_D / 2],
      align: 'above',
      kind: 'tag',
      priority: 12,
      hotspot: 'die',
    },
    (s) => s === STEP.die,
  );
  // level 1
  const atDie = (s: number) => s === STEP.die;
  const blockLabel = (
    cat: Cat,
    text: string,
    align: 'center' | 'above' | 'below' | 'left' | 'right',
    pr: number,
    nth = 0,
  ) => {
    const b = blocks.filter((x) => x.cat === cat)[nth]!;
    const bb = blockAabb(b);
    labels.add(
      {
        text,
        object: dieGroup,
        position: [(bb[0] + bb[3]) / 2, bb[4], (bb[2] + bb[5]) / 2],
        align,
        priority: pr,
        hotspot: 'floorplan',
      },
      atDie,
    );
  };
  labels.add(
    {
      text: '一顆晶粒（放大）',
      object: dieGroup,
      position: [0, BASE_T, -BD / 2 - 0.1],
      align: 'above',
      kind: 'strong',
      priority: 30,
      hotspot: 'floorplan',
    },
    atDie,
  );
  blockLabel('core', '運算核心', 'center', 20, 3);
  blockLabel('sram', 'SRAM 快取', 'center', 18, 2);
  blockLabel('phy', 'HBM 介面（PHY）', 'left', 18, 0);
  blockLabel('io', '高速 I/O（SerDes）', 'below', 16, 1);
  const dieScale = labels.add(
    {
      text: '尺度：毫米級（示意）',
      object: dieGroup,
      position: [BW / 2, 0, BD / 2],
      align: 'right',
      kind: 'tag',
      priority: 6,
    },
    atDie,
  );
  /** Narrow stages have no room beside the die: the scale note goes under the I/O label. */
  const layoutDieLabels = () =>
    dieScale.set(
      stacked()
        ? { position: [BW * 0.12, 0, BD / 2], align: 'below', offset: [0, 30] }
        : { position: [BW / 2, 0, BD / 2], align: 'right', offset: [0, 0] },
    );
  layoutDieLabels();
  // level 2
  const atStack = (s: number) => s === STEP.metal;
  const sideX = S + 0.12;
  const lyr = (l: number) => layerBase(l, 1) + (LAYERS[l]?.t ?? 0) / 2;
  labels.add(
    {
      text: '金屬導線層（BEOL）',
      object: stackGroup,
      position: [0, stackTop(1) + 0.32, -S],
      align: 'above',
      kind: 'strong',
      priority: 30,
      hotspot: 'beol',
    },
    atStack,
  );
  const bumpLabel = labels.add(
    {
      text: '凸塊（bump）',
      object: stackGroup,
      position: [-S - 0.05, stackTop(1) + 0.1, 0.8],
      align: 'left',
      priority: 18,
      hotspot: 'bump',
    },
    atStack,
  );
  // (shorter wording on narrow portrait stages; the 金屬導線層 card carries the full explanation)
  const globalLabel = labels.add(
    {
      text: '',
      object: stackGroup,
      position: [sideX, lyr(7), 0],
      align: 'right',
      priority: 17,
      hotspot: 'beol',
    },
    atStack,
  );
  labels.add(
    {
      text: '中間層導線',
      object: stackGroup,
      position: [sideX, lyr(4), 0],
      align: 'right',
      priority: 14,
      hotspot: 'beol',
    },
    atStack,
  );
  const localLabel = labels.add(
    {
      text: '',
      object: stackGroup,
      position: [sideX, lyr(1), 0],
      align: 'right',
      priority: 15,
      hotspot: 'beol',
    },
    atStack,
  );
  const layoutStackLabels = () => {
    globalLabel.set({ text: stacked() ? '全域導線・粗' : '全域導線：粗，供電與時脈' });
    localLabel.set({ text: stacked() ? '局部導線・細密' : '局部導線：最細最密' });
    // narrow stages: the right-hand column is full, so the power tag moves to the left power stack
    powerLabel.set(
      stacked()
        ? { position: [-0.8, layerBase(3, 1), 0.8], align: 'left' }
        : { position: [0.8, stackTop(1) - 0.45, 0.8], align: 'right' },
    );
    signalLabel.set({ position: [-0.96, stacked() ? layerBase(0, 1) : layerBase(1, 1) + 0.1, 0.64] });
    // the smallest phones (320 px): drop the English terms so the side columns still fit
    const tiny = ctx.size.width < 320;
    bumpLabel.set({ text: tiny ? '凸塊' : '凸塊（bump）' });
    feolLabel.set({ text: tiny ? '電晶體層' : '電晶體層（FEOL）' });
  };
  labels.add(
    {
      text: '通孔（via）',
      object: stackGroup,
      position: [-0.8, lyr(5) + 0.12, 0.8],
      align: 'left',
      kind: 'tag',
      priority: 12,
      hotspot: 'beol',
    },
    atStack,
  );
  const feolLabel = labels.add(
    {
      text: '電晶體層（FEOL）',
      object: stackGroup,
      position: [sideX, 0.1, 0.3],
      align: 'right',
      priority: 19,
      hotspot: 'feol',
    },
    atStack,
  );
  labels.add(
    {
      text: '矽基板',
      object: stackGroup,
      position: [-S, -0.25, S],
      align: 'left',
      kind: 'tag',
      priority: 8,
      hotspot: 'feol',
    },
    atStack,
  );
  labels.add(
    {
      text: '奈米到微米級・未依比例',
      object: stackGroup,
      position: [0.3, -0.42, S],
      align: 'below',
      kind: 'tag',
      priority: 5,
    },
    atStack,
  );
  const powerLabel = labels.add(
    {
      text: '電源',
      object: stackGroup,
      position: [0.8, stackTop(1) - 0.45, 0.8],
      align: 'right',
      kind: 'tag',
      priority: 9,
      swatch: p0.css['scene-power'] ?? '',
    },
    atStack,
  );
  const signalLabel = labels.add(
    {
      text: '訊號',
      object: stackGroup,
      position: [-0.96, layerBase(1, 1) + 0.1, 0.64],
      align: 'left',
      kind: 'tag',
      priority: 9,
      swatch: p0.css['scene-flow'] ?? '',
    },
    atStack,
  );
  layoutStackLabels();

  /* ───────── hotspots ───────── */
  const glowOn = (mats: MeshStandardMaterial[], on: boolean) => {
    for (const m of mats) {
      const target = on ? (ctx.theme === 'dark' ? 0.32 : 0.14) : 0;
      m.emissive.copy(ctx.palette.highlight);
      ctx.tween.to(m, { emissiveIntensity: target }, { duration: 200, fade: true });
    }
  };
  for (const m of [waferMat, blockMat, wireMat, viaMat, feolMat, subMat, bumpMat, defectMat, baseMat])
    m.emissiveIntensity = 0;
  const dieCard = (i: number): CardContent => {
    const d = full[i]!;
    const tested = rank[i]! < Math.floor(probe);
    const base = cardFor('die');
    return {
      ...base,
      subtitle: tested ? (d.bad ? '晶圓測試：不良（落在缺陷上）' : '晶圓測試：良品') : '尚未測試',
    };
  };
  const reg = (id: string, spec: Parameters<typeof ctx.hotspots.register>[1]) =>
    ctx.hotspots.register(id, spec);
  reg('wafer', {
    object: wafer,
    anchor: [-R * 0.7, 0, R * 0.7],
    card: () => cardFor('wafer'),
    onHighlight: (on) => glowOn([waferMat as MeshStandardMaterial], on),
  });
  reg('die', {
    object: dies,
    anchor: [picked.x, 0.02, picked.z],
    card: (hit) => (hit?.instanceId !== undefined ? dieCard(hit.instanceId) : cardFor('die')),
    onHighlight: (on) => {
      hotDie = on ? 1 : 0;
      applyReveal();
    },
  });
  reg('yield', {
    object: defectMesh,
    anchor: [firstDefect[0], 0.03, firstDefect[1]],
    card: () => cardFor('yield'),
    onHighlight: (on) => glowOn([defectMat], on),
  });
  const catCard = (cat: Cat): CardContent => cardFor(`block-${cat === 'tensor' ? 'core' : cat}`);
  reg('floorplan', {
    object: blockSet.mesh,
    anchor: dieGroup,
    card: (hit) =>
      hit?.instanceId !== undefined ? catCard(blocks[hit.instanceId]!.cat) : cardFor('floorplan'),
    onHighlight: (on) => glowOn([blockMat], on),
    onSelect: (src) => goTo(STEP.die, src),
  });
  reg('feol', {
    object: feol.mesh,
    anchor: stackGroup,
    card: () => cardFor('feol'),
    onHighlight: (on) => glowOn([feolMat, subMat], on),
    onSelect: (src) => goTo(STEP.metal, src),
  });
  reg('beol', {
    object: wireSet.mesh,
    anchor: stackGroup,
    card: () => cardFor('beol'),
    onHighlight: (on) => glowOn([wireMat, viaMat], on),
    onSelect: (src) => goTo(STEP.metal, src),
  });
  reg('bump', {
    object: bumps,
    anchor: stackGroup,
    card: () => cardFor('bump'),
    onHighlight: (on) => glowOn([bumpMat], on),
    onSelect: (src) => goTo(STEP.metal, src),
  });
  ctx.picker.add(viaMesh, { id: 'beol' });
  ctx.picker.add(substrate, { id: 'feol' });
  function goTo(step: number, src: string): boolean {
    if (src === 'pointer' || src === 'touch') return false;
    if (ctx.step !== step && !(step === STEP.die && ctx.step === STEP.metal))
      ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index: step } }));
    return false;
  }

  /* ───────── steps ───────── */
  let tw: { cancel(): void } | null = null;
  let twE: { cancel(): void } | null = null;
  const go = (step: number) => {
    const t1 = step >= STEP.die ? 1 : 0;
    const t2 = step >= STEP.metal ? 1 : 0;
    const a1 = r1;
    const a2 = r2;
    tw?.cancel();
    twE?.cancel();
    if (t2 === 0) {
      explode = 0;
      layoutStack(0);
    }
    tw = ctx.tween.run(
      (k) => {
        r1 = lerp(a1, t1, k);
        r2 = lerp(a2, t2, k);
        applyReveal();
      },
      {
        duration: 1000,
        ease: 'linear',
        onComplete: () => {
          if (t2 === 1 && explode < 1) {
            const e0 = explode;
            twE = ctx.tween.run(
              (k) => {
                explode = lerp(e0, 1, k);
                layoutStack(explode);
                applyReveal();
              },
              { duration: 900 },
            );
          }
        },
      },
    );
    labels.show(step);
    const pose = POSES[portrait ? 'portrait' : 'landscape'][step] ?? null;
    const compactPose = compact ? COMPACT[step] : undefined;
    if (compactPose) ctx.setPose(compactPose);
    else ctx.setPose(step === STEP.overview || !pose ? homePoseShifted(ctx) : exactPose(ctx, pose));
  };

  applyPalette(ctx.palette);
  applyReveal();

  return {
    setStep(i) {
      go(i <= STEP.metal ? i : STEP.overview);
    },
    update(dt, t) {
      if (!ctx.animate) return;
      // wafer sort sweep: test → hold → fade → restart
      if (probe < full.length) {
        probe += dt * RATE;
        fade = 1;
      } else {
        probe += dt;
        if (probe > full.length + HOLD) fade = Math.max(0, fade - dt * 1.6);
        if (fade <= 0) probe = 0;
      }
      paintDies();
      powerFlow.update(t);
      sigFlow.update(t);
    },
    onPalette(p) {
      applyPalette(p);
      applyReveal();
    },
    onMotion(animate) {
      powerFlow.setReduced(!animate);
      sigFlow.setReduced(!animate);
      if (!animate) {
        probe = full.length + 1;
        fade = 1;
      }
      paintDies();
    },
    onQuality(scale) {
      powerFlow.setCount(Math.max(24, Math.round(PMAX * scale)));
      sigFlow.setCount(Math.max(18, Math.round(SMAX * scale)));
      if (scale < 1 && waferMat instanceof MeshPhysicalMaterial) waferMat.iridescence = 0;
    },
    onResize(size) {
      const nextCompact = isCompact(size);
      const changed = size.portrait !== portrait || nextCompact !== compact;
      portrait = size.portrait;
      compact = nextCompact;
      layoutStackLabels(); // (also depends on the width alone)
      if (!changed) return;
      layoutBar();
      layoutOverviewLabels();
      layoutDieLabels();
      go(ctx.step <= STEP.metal ? ctx.step : STEP.overview);
    },
    dispose() {
      tw?.cancel();
      twE?.cancel();
      labels.dispose();
      world.removeFromParent();
    },
  };
}

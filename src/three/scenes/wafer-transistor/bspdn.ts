/**
 * Variant `bspdn`: front-side vs backside power delivery, side by side (示意 cross-sections).
 *
 *  Left  「傳統：正面供電」: thick silicon, a row of transistors, six front metal layers in which
 *        power (amber) and signal (cyan) wires share the routing tracks; power enters through the
 *        top bumps and falls through via stacks to the M0 power rails (long path → IR drop, drawn
 *        as particles that dim on the way down).
 *  Right 「背面供電（BSPDN）」: the same front stack carries signals only; the wafer is bonded
 *        face-down to a carrier wafer, the original silicon is thinned, and a coarse backside
 *        power network with its own bumps feeds the transistors through backside contacts
 *        (nano-TSV / direct contacts). Power particles take the short route from below.
 *
 * On entry the right block starts identical to the left one and its power wires slide through the
 * transistor layer to the back (a cut under reduced motion). Same `BoxSet` approach as the
 * transistor variant: every wire is an Aabb with an A (front) and a B (back) pose. Wide stages
 * place the blocks side by side; portrait stages stack them (each block follows an offset, and the
 * labels, flows and shadows hang off one anchor group per block).
 */
import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { LabelHandle, LabelSpec, Palette, SceneContext } from '../../core/types';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { scaleCount } from '../../core/quality';
import {
  BoxSet,
  Hud,
  LabelSet,
  STEP,
  contactShadow,
  ease,
  homePoseShifted,
  isCompact,
  lerp,
  lerpBox,
  silicon,
  tintShadow,
  type Aabb,
  type View,
} from './common';
import { cardFor } from './text';

const XOFF = 1.95; // landscape: block centres at x = ±XOFF
const PORTRAIT_Y = [2.92, -2.17]; // portrait: blocks stacked (front-side on top, BSPDN below)
const HW = 1.4; // block half-width (x)
const HD = 0.7; // block half-depth (z)
const TR_TOP = 0.16;
const FY = [0.26, 0.5, 0.74, 1.0, 1.3, 1.66];
const FT = [0.06, 0.07, 0.08, 0.1, 0.16, 0.22];
const FDIR: ('x' | 'z')[] = ['x', 'z', 'x', 'z', 'x', 'z'];
const FRONT_TOP = (FY[5] ?? 0) + (FT[5] ?? 0);
const SIG_W = [0.07, 0.07, 0.08, 0.1, 0.14, 0.2];
const POW_W = [0.1, 0.1, 0.12, 0.15, 0.22, 0.28];
const PZ = 0.56; // power track z (x-layers)
const PXS = [-0.9, 0.9]; // power columns x (z-layers)
const THIN = -0.12; // thinned silicon bottom
const BM: { y0: number; y1: number; dir: 'x' | 'z'; at: number[]; w: number }[] = [
  { y0: -0.3, y1: -0.2, dir: 'x', at: [-PZ, PZ], w: 0.16 },
  { y0: -0.6, y1: -0.44, dir: 'z', at: [-0.9, 0, 0.9], w: 0.24 },
  { y0: -0.98, y1: -0.76, dir: 'x', at: [-0.45, 0, 0.45], w: 0.3 },
];
const TSV_X = [-1.05, -0.35, 0.35, 1.05];
const TR_X = Array.from({ length: 8 }, (_, i) => -1.225 + i * 0.35);

type Kind = 'sig' | 'pow' | 'via' | 'tsv';
interface Part {
  kind: Kind;
  a: Aabb | null; // front-side (conventional) pose
  b: Aabb | null; // backside pose
}

const xWire = (y0: number, t: number, z: number, w: number, x0 = -HW + 0.08, x1 = HW - 0.08): Aabb => [
  x0,
  y0,
  z - w / 2,
  x1,
  y0 + t,
  z + w / 2,
];
const zWire = (y0: number, t: number, x: number, w: number): Aabb => [
  x - w / 2,
  y0,
  -HD + 0.06,
  x + w / 2,
  y0 + t,
  HD - 0.06,
];
const pillar = (x: number, z: number, y0: number, y1: number, w = 0.07): Aabb => [
  x - w / 2,
  y0,
  z - w / 2,
  x + w / 2,
  y1,
  z + w / 2,
];
const collapse = (b: Aabb, y: number): Aabb => {
  const cx = (b[0] + b[3]) / 2;
  const cz = (b[2] + b[5]) / 2;
  return [cx, y, cz, cx, y, cz];
};

/** Wires of one block. Power parts carry both poses; signal parts stay on the front. */
function blockParts(): Part[] {
  const parts: Part[] = [];
  const front: Aabb[][] = [];
  const sigTracks = [
    [-0.28, 0, 0.28],
    [-1.15, -0.6, -0.3, 0.3, 0.6, 1.15],
    [-0.28, 0, 0.28],
    [-0.45, 0.45, 1.15],
    [0],
    [],
  ];
  FY.forEach((y, l) => {
    const t = FT[l]!;
    const dir = FDIR[l]!;
    for (const c of sigTracks[l]!)
      parts.push({
        kind: 'sig',
        a: dir === 'x' ? xWire(y, t, c, SIG_W[l]!) : zWire(y, t, c, SIG_W[l]!),
        b: null,
      });
    const pc = dir === 'x' ? [-PZ, PZ] : l === 5 ? [-0.9, 0, 0.9] : PXS;
    front.push(pc.map((c) => (dir === 'x' ? xWire(y, t, c, POW_W[l]!) : zWire(y, t, c, POW_W[l]!))));
  });
  for (const p of parts) p.b = p.a;
  // power via stacks at (±0.9, ±PZ), plus M0 → transistor contacts
  const vias: Aabb[] = [];
  for (const x of PXS)
    for (const z of [-PZ, PZ])
      for (let l = 0; l < FY.length - 1; l++) vias.push(pillar(x, z, FY[l]! + FT[l]!, FY[l + 1]!, 0.08));
  const contacts = TSV_X.flatMap((x) => [-PZ, PZ].map((z) => pillar(x, z, TR_TOP - 0.04, FY[0]!, 0.06)));
  // backside network (B poses)
  const back: Aabb[][] = BM.map((m) =>
    m.at.map((c) => (m.dir === 'x' ? xWire(m.y0, m.y1 - m.y0, c, m.w) : zWire(m.y0, m.y1 - m.y0, c, m.w))),
  );
  const backVias: Aabb[] = [];
  for (const x of [-0.9, 0.9])
    for (const z of [-PZ, PZ]) backVias.push(pillar(x, z, BM[1]!.y1, BM[0]!.y0, 0.1));
  for (const x of [-0.9, 0, 0.9])
    for (const z of [-0.45, 0, 0.45])
      if (x !== 0 || z === 0) backVias.push(pillar(x, z, BM[2]!.y1, BM[1]!.y0, 0.12));
  const tsvs = TSV_X.flatMap((x) => [-PZ, PZ].map((z) => pillar(x, z, BM[0]!.y1, TR_TOP - 0.04, 0.06)));
  // The power network flips to the back: M0 rails → BM0, thick top grid → BM1 / BM2 (the coarse
  // backside layers next to the bumps); intermediate straps are no longer needed and sink away.
  const pair = (fl: Aabb[] | undefined, bl: Aabb[] | undefined) => {
    const f = fl ?? [];
    const b = bl ?? [];
    for (let i = 0; i < Math.max(f.length, b.length); i++)
      parts.push({ kind: 'pow', a: f[i] ?? null, b: b[i] ?? null });
  };
  pair(front[0], back[0]);
  pair(front[5], back[1]);
  pair(front[4], back[2]);
  for (const l of [1, 2, 3]) pair(front[l], []);
  const m = Math.max(vias.length, backVias.length);
  for (let i = 0; i < m; i++) parts.push({ kind: 'via', a: vias[i] ?? null, b: backVias[i] ?? null });
  contacts.forEach((c, i) => parts.push({ kind: 'tsv', a: c, b: tsvs[i] ?? null }));
  return parts;
}

export function buildBspdn(ctx: SceneContext, root: Group): View {
  const { materials } = ctx;
  const world = new Group();
  world.name = 'bspdn-variant';
  root.add(world);
  const labels = new LabelSet(ctx);
  const hud = new Hud(ctx);

  // Block offsets: [0] = conventional (front-side power), [1] = backside power.
  let portrait = ctx.size.portrait;
  const offs = [new Vector3(), new Vector3()] as const;
  const blocks = [new Group(), new Group()] as const;
  world.add(blocks[0], blocks[1]);
  const placeBlocks = () => {
    offs[0].set(portrait ? 0 : -XOFF, portrait ? PORTRAIT_Y[0]! : 0, 0);
    offs[1].set(portrait ? 0 : XOFF, portrait ? PORTRAIT_Y[1]! : 0, 0);
    blocks.forEach((g, i) => {
      g.position.copy(offs[i]!);
      g.updateMatrixWorld(true);
    });
  };
  placeBlocks();
  const anchorAt = (side: 0 | 1, x: number, y: number, z: number) => {
    const o = new Object3D();
    o.position.set(x, y, z);
    blocks[side].add(o);
    return o;
  };

  const parts = blockParts();
  const metalMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }));
  const metal = new BoxSet(ctx, metalMat, parts.length * 2);
  const siMat = ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 }));
  const si = new BoxSet(ctx, siMat, 4);
  const trMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 }));
  const tr = new BoxSet(ctx, trMat, TR_X.length * 4);
  const dielMat = materials.glass('fg', 0.07, { roughness: 0.2 });
  const diel = new BoxSet(ctx, dielMat, 3);
  diel.mesh.renderOrder = 3;
  world.add(metal.mesh, si.mesh, tr.mesh, diel.mesh);
  const bumpGeo = ctx.track(new SphereGeometry(0.17, 18, 12));
  const bumpMat = materials.standard((p) => p.fg.clone().lerp(p.bg, p.theme === 'dark' ? 0.28 : 0.45), {
    roughness: 0.25,
    metalness: 0.6,
  });
  const bumps = new InstancedMesh(bumpGeo, bumpMat, 9);
  world.add(bumps);
  ctx.track({ dispose: () => bumps.dispose() });
  const shadows = blocks.map((g) => {
    const s = contactShadow(ctx, 4.4, 2.6);
    s.position.set(0, -1.25, 0);
    g.add(s);
    return s;
  });

  let k = 1; // right block morph: 0 = front-side, 1 = backside
  const shift = (b: Aabb, side: 0 | 1, out: Aabb): Aabb => {
    const o = offs[side];
    out[0] = b[0] + o.x;
    out[1] = b[1] + o.y;
    out[2] = b[2] + o.z;
    out[3] = b[3] + o.x;
    out[4] = b[4] + o.y;
    out[5] = b[5] + o.z;
    return out;
  };
  const tmpS: Aabb = [0, 0, 0, 0, 0, 0];
  /** Box in block-local coordinates → world (through the block offset). */
  const at = (side: 0 | 1, b: Aabb): Aabb => shift(b, side, tmpS);
  const tmpA: Aabb = [0, 0, 0, 0, 0, 0];
  const tmpB: Aabb = [0, 0, 0, 0, 0, 0];
  const tmpO: Aabb = [0, 0, 0, 0, 0, 0];
  const Z: Aabb = [0, 0, 0, 0, 0, 0];
  const m4 = new Matrix4();
  const q = new Quaternion();
  const qDown = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI);
  const vS = new Vector3();
  const vP = new Vector3();
  const layout = () => {
    const n = parts.length;
    parts.forEach((p, i) => {
      // left block: front-side pose only
      metal.set(i, p.a ? shift(p.a, 0, tmpO) : Z);
      // right block: staggered morph (top layers first), collapsed ends
      const a = p.a ?? (p.b ? collapse(p.b, p.kind === 'tsv' ? TR_TOP : THIN) : null);
      const b = p.b ?? (p.a ? collapse(p.a, THIN) : null);
      if (!a || !b) {
        metal.set(n + i, Z);
        return;
      }
      const delay = p.kind === 'sig' ? 0 : Math.min(0.45, Math.max(0, (a[4] - 0.2) / 4));
      const e = ease(Math.min(1, Math.max(0, (k - 0.45 + delay) / 0.55)));
      lerpBox(shift(a, 1, tmpA), shift(b, 1, tmpB), p.kind === 'sig' ? 1 : e, tmpO);
      metal.set(n + i, tmpO);
    });
    metal.flush();
    // silicon: left substrate, right substrate thinning, carrier wafer arriving from above
    const kk = ease(Math.min(1, k / 0.5));
    si.set(0, at(0, [-HW, -1.05, -HD, HW, 0, HD]));
    si.set(1, at(1, [-HW, lerp(-1.05, THIN, kk), -HD, HW, 0, HD]));
    // the carrier wafer arrives from above and bonds onto the front-side stack (after the front
    // bumps are gone: the finished BSPDN chip connects to the package from the back)
    const kc = ease(Math.min(1, Math.max(0, (k - 0.15) / 0.5)));
    const cy0 = FRONT_TOP + 0.03 + (1 - kc) * 1.2;
    si.set(2, kc > 0.01 ? at(1, [-HW, cy0, -HD, HW, cy0 + 0.42 * kc, HD]) : Z);
    si.flush();
    diel.set(0, at(0, [-HW, TR_TOP, -HD, HW, FRONT_TOP + 0.02, HD]));
    diel.set(1, at(1, [-HW, TR_TOP, -HD, HW, FRONT_TOP + 0.02, HD]));
    const kb = ease(Math.min(1, Math.max(0, (k - 0.5) / 0.5)));
    diel.set(2, kb > 0.01 ? at(1, [-HW, lerp(THIN, -1.0, kb), -HD, HW, THIN, HD]) : Z);
    diel.flush();
    // bumps: front (left 3 + right 3 fading) and back (right 3 growing)
    const fs = 1 - ease(Math.min(1, Math.max(0, (k - 0.05) / 0.35)));
    [-0.9, 0, 0.9].forEach((x, i) => {
      bumps.setMatrixAt(i, m4.compose(vP.set(x, FRONT_TOP, 0).add(offs[0]), q, vS.set(1, 1, 1)));
      bumps.setMatrixAt(
        3 + i,
        m4.compose(vP.set(x, FRONT_TOP, 0).add(offs[1]), q, vS.setScalar(Math.max(1e-3, fs))),
      );
      bumps.setMatrixAt(
        6 + i,
        m4.compose(vP.set(x, -1.0, 0.45).add(offs[1]), qDown, vS.setScalar(Math.max(1e-3, kb))),
      );
    });
    bumps.instanceMatrix.needsUpdate = true;
    bumps.computeBoundingSphere();
    const flowsOn = k > 0.99;
    rightPow.object.visible = flowsOn;
    rightSig.object.visible = flowsOn;
  };

  // transistor rows (both blocks): body + gate stripe
  const layoutTransistors = () => {
    TR_X.forEach((x, i) => {
      for (const s of [0, 1] as const) {
        const base = (s * TR_X.length + i) * 2;
        tr.set(base, at(s, [x - 0.13, 0, -HD + 0.08, x + 0.13, 0.11, HD - 0.08]));
        tr.set(base + 1, at(s, [x - 0.045, 0, -HD + 0.04, x + 0.045, TR_TOP, HD - 0.04]));
      }
    });
    tr.flush();
  };
  layoutTransistors();

  /* ───────── flows ───────── */
  const powLeft: FlowPath[] = [];
  const powRight: FlowPath[] = [];
  for (const x of PXS)
    for (const z of [-PZ, PZ]) {
      const xt = x + (x < 0 ? -0.15 : 0.15) * (z < 0 ? 1 : -1);
      const yTop = (FY[5] ?? 0) + (FT[5] ?? 0) / 2;
      powLeft.push({
        points: [
          [x, FRONT_TOP + 0.16, 0],
          [x, yTop, 0],
          [x, yTop, z],
          [x, (FY[0] ?? 0) + 0.03, z],
          [xt, (FY[0] ?? 0) + 0.03, z],
          [xt, 0.08, z],
        ],
      });
      const tsv = TSV_X.reduce((best, t) => (Math.abs(t - x) < Math.abs(best - x) ? t : best), TSV_X[0]!);
      powRight.push({
        points: [
          [x, -1.12, 0.45],
          [x, -0.87, 0.45],
          [x, -0.52, 0.45],
          [x, -0.52, z],
          [x, -0.25, z],
          [tsv, -0.25, z],
          [tsv, 0.08, z],
        ],
      });
    }
  const sigPaths = (): FlowPath[] =>
    [
      [-1.225, 0.525, -0.28],
      [-0.525, 0.875, 0],
      [0.175, 1.225, 0.28],
    ].map(([x0, x1, z]) => {
      const y = (FY[2] ?? 0) + (FT[2] ?? 0) / 2;
      return {
        points: [
          [x0!, 0.13, z!],
          [x0!, y, z!],
          [x1!, y, z!],
          [x1!, 0.13, z!],
        ] as [number, number, number][],
      };
    });
  const PMAX = 150;
  const SMAX = 90;
  const mk = (paths: FlowPath[], max: number, size: number, seed: number) =>
    ctx.track(
      new PathFlow({
        paths,
        count: scaleCount(max, ctx.tier, 16),
        size,
        speed: 0.7,
        speedVariance: 0.2,
        smooth: false,
        fadeEnds: 0.05,
        theme: ctx.theme,
        seed,
      }),
    );
  const leftPow = mk(powLeft, PMAX, 0.1, 21);
  const rightPow = mk(powRight, PMAX, 0.1, 22);
  const leftSig = mk(sigPaths(), SMAX, 0.08, 23);
  const rightSig = mk(sigPaths(), SMAX, 0.08, 24);
  const allFlows = [leftPow, rightPow, leftSig, rightSig];
  allFlows.forEach((f, i) => {
    f.object.material.depthTest = false;
    f.setReduced(!ctx.animate);
    blocks[i % 2 === 0 ? 0 : 1].add(f.object);
  });

  /* ───────── labels ───────── */
  const [bL, bR] = blocks;
  labels.add({
    text: '傳統：正面供電',
    object: bL,
    position: [0, FRONT_TOP + 0.75, 0],
    align: 'above',
    kind: 'strong',
    priority: 40,
    always: true,
  });
  labels.add({
    text: '背面供電（BSPDN）',
    object: bR,
    position: [0, FRONT_TOP + 0.75, 0],
    align: 'above',
    kind: 'strong',
    priority: 40,
    always: true,
  });
  const L = -HW - 0.05;
  const Rr = HW + 0.05;
  /** Long side labels: dropped on narrow stages (phones), where the summaries below carry the point. */
  const long: LabelHandle[] = [];
  const side = (spec: LabelSpec, isLong = false) => {
    const h = labels.add(spec);
    if (isLong) long.push(h);
    return h;
  };
  side(
    {
      text: '凸塊：電源從上方進入',
      object: bL,
      position: [L, FRONT_TOP + 0.1, HD],
      align: 'left',
      priority: 22,
      hotspot: 'power-network',
    },
    true,
  );
  side(
    {
      text: '電源＋訊號擠在同一疊',
      object: bL,
      position: [L, 1.0, HD],
      align: 'left',
      priority: 24,
      hotspot: 'signal-wires',
    },
    true,
  );
  side({ text: '電晶體層', object: bL, position: [L, 0.08, HD], align: 'left', priority: 20 });
  side({ text: '矽基板', object: bL, position: [L, -0.6, HD], align: 'left', kind: 'tag', priority: 12 });
  const sumL = side({
    text: '路徑長，壓降大',
    object: bL,
    position: [0, -1.05, HD],
    align: 'below',
    kind: 'muted',
    priority: 26,
    hotspot: 'power-network',
  });
  const carrier = side({
    text: '載體晶圓',
    object: bR,
    position: [Rr, FRONT_TOP + 0.24, HD],
    align: 'right',
    priority: 20,
    hotspot: 'carrier-wafer',
  });
  side(
    {
      text: '正面：只走訊號',
      object: bR,
      position: [Rr, 1.0, HD],
      align: 'right',
      priority: 24,
      hotspot: 'signal-wires',
    },
    true,
  );
  side({
    text: '電晶體層',
    object: bR,
    position: [Rr, 0.1, HD],
    align: 'right',
    offset: [0, -11],
    priority: 20,
  });
  side({
    text: '背面接點',
    object: bR,
    position: [Rr, -0.14, HD],
    align: 'right',
    offset: [0, 11],
    priority: 21,
    hotspot: 'backside-contact',
  });
  side(
    {
      text: '背面電源網路',
      object: bR,
      position: [Rr, -0.6, HD],
      align: 'right',
      priority: 23,
      hotspot: 'power-network',
    },
    true,
  );
  side(
    {
      text: '凸塊：電源從背面進入',
      object: bR,
      position: [Rr, -1.05, HD],
      align: 'right',
      priority: 18,
      hotspot: 'power-network',
    },
    true,
  );
  side({
    text: '路徑短，壓降小',
    object: bR,
    position: [0, -1.3, HD],
    align: 'below',
    kind: 'muted',
    priority: 26,
    hotspot: 'power-network',
  });
  const legendP = hud.add({ text: '電源', align: 'left', kind: 'tag', priority: 30 }, 0.5, 0, -6, 22);
  const legendS = hud.add({ text: '訊號', align: 'right', kind: 'tag', priority: 30 }, 0.5, 0, 6, 22);
  /**
   * Stage-shape dependent text: the colour legend sits top centre (wide), bottom centre (compact
   * 4:3: the titles take the top) or top left (portrait: the first title is centred at the top);
   * narrow stages hide the long side labels (the block titles and the summaries carry the point).
   */
  const placeLegend = () => {
    const { width } = ctx.size;
    const narrow = width < 600;
    if (portrait) {
      legendP.set({ align: 'right' });
      hud.move(legendP, 0, 0, 2, 22);
      hud.move(legendS, 0, 0, 62, 22);
    } else {
      legendP.set({ align: 'left' });
      const bottom = isCompact(ctx.size);
      hud.move(legendP, 0.5, bottom ? 1 : 0, -6, bottom ? -16 : 22);
      hud.move(legendS, 0.5, bottom ? 1 : 0, 6, bottom ? -16 : 22);
    }
    for (const h of long) h.set({ visible: !narrow });
    // compact 4:3 phones have no room right of the blocks: name the carrier wafer on the slab itself
    carrier.set(
      isCompact(ctx.size)
        ? { position: [0, FRONT_TOP + 0.26, HD], align: 'center' }
        : { position: [Rr, FRONT_TOP + 0.24, HD], align: 'right' },
    );
    // (a phone portrait has no room between the first block and the second title: beside it instead;
    // the block titles already say where the power runs, so the summaries stay short and parallel)
    sumL.set(
      narrow && portrait
        ? { position: [Rr, -0.45, HD], align: 'right' }
        : { position: [0, -1.05, HD], align: 'below' },
    );
  };
  placeLegend();

  /* ───────── palette ───────── */
  const cSig = new Color();
  const cPow = new Color();
  const cVia = new Color();
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    for (const s of shadows) tintShadow(s, p, 1.2);
    cSig.copy(p.flow).lerp(p.bg, dark ? 0.12 : 0.05);
    cPow.copy(p.power);
    cVia.copy(p.power).lerp(p.fg, dark ? 0.2 : 0.1);
    const n = parts.length;
    parts.forEach((pt, i) => {
      const c = pt.kind === 'sig' ? cSig : pt.kind === 'pow' ? cPow : cVia;
      metal.color(i, c);
      metal.color(n + i, c);
    });
    const siC = silicon(p);
    si.color(0, siC);
    si.color(1, siC);
    si.color(2, silicon(p).lerp(p.muted, 0.35).lerp(p.bg, 0.15));
    TR_X.forEach((_, i) =>
      [0, 1].forEach((s) => {
        const base = (s * TR_X.length + i) * 2;
        tr.color(base, silicon(p).lerp(p.fg, dark ? 0.35 : 0.15));
        tr.color(base + 1, p.muted.clone().lerp(p.fg, dark ? 0.25 : 0.5));
      }),
    );
    // IR drop: the left (front-side) power particles dim toward the transistors
    const drop = p.power
      .clone()
      .lerp(p.heat, 0.45)
      .lerp(p.bg, dark ? 0.45 : 0.3);
    leftPow.recolor(() => [p.power, p.power, p.power, p.power.clone().lerp(drop, 0.5), drop, drop]);
    rightPow.recolor(() => p.power);
    leftSig.recolor(() => p.flow);
    rightSig.recolor(() => p.flow);
    for (const f of allFlows) {
      f.setTheme(p.theme);
      f.setSize(dark ? 0.1 : 0.075);
    }
    legendP.set({ swatch: p.css['scene-power'] ?? '' });
    legendS.set({ swatch: p.css['scene-flow'] ?? '' });
  };

  /* ───────── hotspots ───────── */
  const glowOn = (mat: MeshStandardMaterial, on: boolean) => {
    mat.emissive.copy(ctx.palette.highlight);
    ctx.tween.to(
      mat,
      { emissiveIntensity: on ? (ctx.theme === 'dark' ? 0.3 : 0.14) : 0 },
      { duration: 200, fade: true },
    );
  };
  for (const m of [metalMat, siMat, bumpMat]) m.emissiveIntensity = 0;
  ctx.hotspots.register('signal-wires', {
    object: metal.mesh,
    anchor: anchorAt(1, 0, 1.0, HD),
    card: () => cardFor('signal-wires'),
    onHighlight: (on) => glowOn(metalMat, on),
    pickable: false,
  });
  ctx.hotspots.register('power-network', {
    object: bumps,
    anchor: anchorAt(1, 0, -0.6, HD),
    card: () => cardFor('power-network'),
    onHighlight: (on) => glowOn(bumpMat, on),
  });
  ctx.hotspots.register('backside-contact', {
    anchor: anchorAt(1, 0, -0.1, HD),
    card: () => cardFor('backside-contact'),
  });
  ctx.hotspots.register('carrier-wafer', {
    object: si.mesh,
    pickable: false,
    anchor: anchorAt(1, 0, FRONT_TOP + 0.24, 0),
    card: () => cardFor('carrier-wafer'),
    onHighlight: (on) => glowOn(siMat, on),
  });
  ctx.picker.add(si.mesh, { id: ({ instanceId }) => (instanceId === 2 ? 'carrier-wafer' : null) });
  const n = parts.length;
  ctx.picker.add(metal.mesh, {
    id: ({ instanceId }) => {
      if (instanceId === undefined) return null;
      const p = parts[instanceId % n]!;
      if (p.kind === 'sig') return 'signal-wires';
      if (p.kind === 'tsv' && instanceId >= n) return 'backside-contact';
      return 'power-network';
    },
  });

  /* ───────── steps ───────── */
  let tw: { cancel(): void } | null = null;
  const go = (i: number) => {
    labels.show(i);
    placeLegend();
    tw?.cancel();
    if (i === STEP.bspdn) {
      k = 0;
      layout();
      tw = ctx.tween.run(
        (e) => {
          k = e;
          layout();
        },
        { duration: 2600, delay: 500, ease: 'linear' },
      );
    } else {
      k = 1;
      layout();
    }
    ctx.setPose(homePoseShifted(ctx));
  };

  applyPalette(ctx.palette);
  layout();

  return {
    setStep(i) {
      go(i === STEP.bspdn ? i : STEP.overview);
    },
    update(_dt, t) {
      hud.update();
      for (const f of allFlows) f.update(t);
    },
    onResize(size) {
      const next = size.portrait;
      const flipped = next !== portrait;
      portrait = next;
      placeLegend();
      if (!flipped) return;
      placeBlocks();
      layoutTransistors();
      layout();
      ctx.setPose(homePoseShifted(ctx));
    },
    onPalette: applyPalette,
    onMotion(animate) {
      for (const f of allFlows) f.setReduced(!animate);
    },
    onQuality(scale) {
      leftPow.setCount(Math.max(16, Math.round(PMAX * scale)));
      rightPow.setCount(Math.max(16, Math.round(PMAX * scale)));
      leftSig.setCount(Math.max(16, Math.round(SMAX * scale)));
      rightSig.setCount(Math.max(16, Math.round(SMAX * scale)));
    },
    dispose() {
      tw?.cancel();
      labels.dispose();
      hud.dispose();
      world.removeFromParent();
    },
  };
}

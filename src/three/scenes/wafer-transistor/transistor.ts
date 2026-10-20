/**
 * Variant `transistor`: one transistor that morphs planar → FinFET → GAA nanosheet → CFET.
 *
 * Axes: the channel runs along x (source at −x, drain at +x), the gate runs along z, y is up.
 * Every part is an axis-aligned box in a small pool (channel slices / sheets, high-k sleeves,
 * gate pieces that tile the gate around the channel "holes", source/drain epi, oxide), and each
 * architecture is a list of target boxes for the pool, so a morph is a plain lerp: the planar
 * channel rises into a fin, the fin splits into nanosheets, the sheets double into an n-over-p
 * stack. The whole device is sliced at the gate centre (x = 0) and the drain half (a translucent
 * "glass" solid with an outline) slides away diagonally (+x, −z) so it never hides the cut face,
 * which shows how the gate wraps the channel: 1 side → 3 sides → 4 sides. Dashed exploded-view
 * guides join the two cut faces; leader lines name the channel and the high-k layer on the cut.
 *
 * Particles are electrons (n) / holes (p) moving source → drain through the channel (drawn
 * "x-ray" through the glass drain half). Step 3 toggles the gate voltage (switch on / off); step 6
 * alternates the shared CFET gate between high (top nFET conducts) and low (bottom pFET conducts).
 * The overview tours the four architectures from planar on, the camera easing to each one's pose
 * until the reader orbits (poses fitted offline, landscape and portrait). Reduced motion: no tour
 * (GAA), gate held on, static flows.
 *
 * Phones (< 600 px): S / D names move below / onto the epi, nFET / pFET are named on the source epi
 * and the high-k name is shortened; compact 4:3 stages also get a one-row heading and a 10 % closer
 * framing. A leader line is drawn only while the label layer has actually placed its label.
 */
import {
  Color,
  FrontSide,
  Group,
  InstancedMesh,
  LineDashedMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CameraPose, CardContent, Palette, SceneContext } from '../../core/types';
import { PathFlow } from '../../kit/PathFlow';
import { scaleCount } from '../../core/quality';
import {
  BoxSet,
  Hud,
  LabelSet,
  Lines,
  STEP,
  ZERO,
  contactShadow,
  exactPose,
  isCompact,
  lerp,
  lerpBox,
  silicon,
  tintShadow,
  type Aabb,
  type View,
} from './common';
import { cardFor } from './text';

/* ───────────────────────── geometry ───────────────────────── */

const GX = 0.3; // gate half-length (x)
const GZ = 0.92; // gate half-width (z)
const M = 0.035; // high-k thickness
const SDX = 0.55; // inner edge of source / drain
const SDX1 = 1.75; // outer edge
const STI = 0.3;
// How far the (ghosted) drain half slides away once the device is sliced open: along +x and back
// (−z), so that from the default viewpoint it never covers the cut face (a shorter slide on
// portrait stages, which are width-limited).
const SLIDE = { landscape: [1.05, -0.72], portrait: [0.85, -0.55] } as const;
const GHOST = 0.12; // drain-half opacity once the device is sliced open
const LABEL_Z = -GZ - 0.32; // where the cut-face leader lines end (right of the cut face)
const CUT_EPS = 0.006; // the channel's cut face sits just proud of the high-k sleeve (no z-fighting)
const T = 0.13; // nanosheet thickness
const SW = 0.5; // nanosheet half-width
const FW = 0.13; // fin half-width

type Kind = 'planar' | 'finfet' | 'gaa' | 'cfet';
const KINDS: readonly Kind[] = ['planar', 'finfet', 'gaa', 'cfet'];
const NAME: Record<Kind, string> = { planar: '平面式', finfet: 'FinFET', gaa: 'GAA 奈米片', cfet: 'CFET' };
const TITLE: Record<Kind, string> = {
  planar: '平面式電晶體',
  finfet: 'FinFET（鰭式）',
  gaa: 'GAA 奈米片（環繞式閘極）',
  cfet: 'CFET（互補式堆疊）',
};
const WRAP: Record<Kind, string> = {
  planar: '閘極包覆通道：1 面（只有上方）',
  finfet: '閘極包覆通道：3 面（左、右、上）',
  gaa: '閘極包覆通道：4 面（全環繞）',
  cfet: 'nFET 疊在 pFET 上，共用閘極',
};
/** One-row heading for compact 4:3 stages (phones at the default height), which have no room for two. */
const HEADING: Record<Kind, string> = {
  planar: '平面式：閘極包覆 1 面',
  finfet: 'FinFET：閘極包覆 3 面',
  gaa: 'GAA 奈米片：閘極包覆 4 面',
  cfet: 'CFET：nFET 疊在 pFET 上',
};
/**
 * Camera pose per architecture, fitted offline so the sliced device (both halves) fills the stage
 * between the title row and the timeline (azimuth ≈ 52°, elevation ≈ 22°; portrait ≈ 50° / 24°).
 * The CFET pose (the tallest device) doubles as the home pose in index.ts.
 */
const POSES: Record<'landscape' | 'portrait', Record<Kind, CameraPose>> = {
  landscape: {
    planar: { position: [4.81, 2.63, 5.04], target: [0.72, -0.06, -0.2] },
    finfet: { position: [5.31, 3.38, 5.7], target: [0.61, 0.3, -0.31] },
    gaa: { position: [5.47, 3.55, 5.91], target: [0.59, 0.36, -0.32] },
    cfet: { position: [6.1, 4.26, 6.77], target: [0.52, 0.59, -0.38] },
  },
  portrait: {
    planar: { position: [8.29, 5.34, 8.97], target: [0.63, 0.04, -0.16] },
    finfet: { position: [8.4, 5.82, 9.1], target: [0.54, 0.37, -0.27] },
    gaa: { position: [8.42, 5.88, 9.12], target: [0.52, 0.42, -0.29] },
    cfet: { position: [8.48, 6.16, 9.19], target: [0.47, 0.61, -0.35] },
  },
};
const STEP_KIND: Record<number, Kind> = {
  [STEP.planar]: 'planar',
  [STEP.finfet]: 'finfet',
  [STEP.gaa]: 'gaa',
  [STEP.cfet]: 'cfet',
};

interface Flow {
  y: number;
  z: number;
  type: 'n' | 'p';
  x0: number;
}
interface Arch {
  ch: Aabb[]; // 0–3 sheets / fin slices, 4 = sub-fin
  hk: Aabb[]; // high-k sleeves (gate region only)
  gate: Aabb[]; // wallL, wallR, gap0 … gap4 (gap k = below sheet k; gap4 = above the top)
  sd: Aabb[]; // src-bottom, drn-bottom, src-top, drn-top
  sdType: ('n' | 'p')[];
  ox: Aabb[]; // STI slab, middle dielectric src, middle dielectric drn
  flows: Flow[];
  top: number; // gate top (labels)
}

const sym = (b: Aabb): Aabb => [-b[3], b[1], b[2], -b[0], b[4], b[5]];
const flat = (x0: number, x1: number, y: number, z0: number, z1: number): Aabb => [x0, y, z0, x1, y, z1];

function sheetsArch(kind: 'gaa' | 'cfet'): Arch {
  const yc = kind === 'gaa' ? [0.56, 0.84, 1.12] : [0.52, 0.8, 1.32, 1.6];
  const ch: Aabb[] = [];
  const hk: Aabb[] = [];
  for (let i = 0; i < 4; i++) {
    const y = yc[i];
    if (y === undefined) {
      const yt = (yc[yc.length - 1] ?? 1) + T / 2;
      ch.push(flat(-1.45, 1.45, yt, -SW, SW));
      hk.push(flat(-GX, GX, yt + M, -SW - M, SW + M));
    } else {
      ch.push([-1.45, y - T / 2, -SW, 1.45, y + T / 2, SW]);
      hk.push([-GX, y - T / 2 - M, -SW - M, GX, y + T / 2 + M, SW + M]);
    }
  }
  ch.push([-SDX1, 0, -SW, SDX1, STI, SW]);
  hk.push(flat(-GX, GX, STI, -SW, SW));
  const top = (yc[yc.length - 1] ?? 1) + T / 2 + M + 0.2;
  const zi = SW + M;
  const gate: Aabb[] = [
    [-GX, STI, -GZ, GX, top, -zi],
    [-GX, STI, zi, GX, top, GZ],
  ];
  let prev = STI;
  for (let k = 0; k < 4; k++) {
    const y = yc[k];
    if (y === undefined) {
      gate.push(flat(-GX, GX, prev, -zi, zi));
      continue;
    }
    gate.push([-GX, prev, -zi, GX, y - T / 2 - M, zi]);
    prev = y + T / 2 + M;
  }
  gate.push([-GX, prev, -zi, GX, top, zi]);
  const flows: Flow[] = yc.map((y, i) => ({ y, z: 0, type: kind === 'cfet' && i < 2 ? 'p' : 'n', x0: 1.3 }));
  if (kind === 'gaa') {
    const sd: Aabb = [-SDX1, STI, -0.62, -SDX, 1.3, 0.62];
    return {
      ch,
      hk,
      gate,
      sd: [sd, sym(sd), flat(-SDX1, -SDX, 1.3, -0.62, 0.62), flat(SDX, SDX1, 1.3, -0.62, 0.62)],
      sdType: ['n', 'n', 'n', 'n'],
      ox: [
        [-1.9, 0, -1.1, 1.9, STI, 1.1],
        flat(-SDX1, -SDX, 1.3, -0.62, 0.62),
        flat(SDX, SDX1, 1.3, -0.62, 0.62),
      ],
      flows,
      top,
    };
  }
  const bot: Aabb = [-SDX1, STI, -0.62, -SDX, 0.98, 0.62];
  const topSd: Aabb = [-SDX1, 1.14, -0.62, -SDX, 1.82, 0.62];
  const mdi: Aabb = [-SDX1 + 0.02, 0.98, -0.6, -SDX - 0.02, 1.14, 0.6];
  return {
    ch,
    hk,
    gate,
    sd: [bot, sym(bot), topSd, sym(topSd)],
    sdType: ['p', 'p', 'n', 'n'],
    ox: [[-1.9, 0, -1.1, 1.9, STI, 1.1], mdi, sym(mdi)],
    flows,
    top,
  };
}

function finArch(): Arch {
  const ys = [STI, STI + 0.7 / 3, STI + 1.4 / 3, 1.0];
  const ch: Aabb[] = [];
  const hk: Aabb[] = [];
  for (let i = 0; i < 3; i++) {
    ch.push([-SDX1, ys[i]!, -FW, SDX1, ys[i + 1]!, FW]);
    hk.push([-GX, ys[i]!, -FW - M, GX, ys[i + 1]! + (i === 2 ? M : 0), FW + M]);
  }
  ch.push(flat(-SDX1, SDX1, 1.0, -FW, FW));
  hk.push(flat(-GX, GX, 1.0 + M, -FW - M, FW + M));
  ch.push([-SDX1, 0, -FW, SDX1, STI, FW]);
  hk.push(flat(-GX, GX, STI, -FW, FW));
  const top = 1.0 + M + 0.26;
  const zi = FW + M;
  const gate: Aabb[] = [
    [-GX, STI, -GZ, GX, top, -zi],
    [-GX, STI, zi, GX, top, GZ],
    flat(-GX, GX, STI, -zi, zi),
    flat(-GX, GX, ys[1]!, -zi, zi),
    flat(-GX, GX, ys[2]!, -zi, zi),
    flat(-GX, GX, 1.0 + M, -zi, zi),
    [-GX, 1.0 + M, -zi, GX, top, zi],
  ];
  const sd: Aabb = [-SDX1, STI, -0.36, -SDX, 1.12, 0.36];
  return {
    ch,
    hk,
    gate,
    sd: [sd, sym(sd), flat(-SDX1, -SDX, 1.12, -0.36, 0.36), flat(SDX, SDX1, 1.12, -0.36, 0.36)],
    sdType: ['n', 'n', 'n', 'n'],
    ox: [
      [-1.9, 0, -1.1, 1.9, STI, 1.1],
      flat(-SDX1, -SDX, 1.12, -0.36, 0.36),
      flat(SDX, SDX1, 1.12, -0.36, 0.36),
    ],
    flows: [
      { y: 0.5, z: 0, type: 'n', x0: 1.3 },
      { y: 0.82, z: 0, type: 'n', x0: 1.3 },
    ],
    top,
  };
}

function planarArch(): Arch {
  const y0 = -0.06;
  const y1 = 0.012;
  const ys = [y0, y0 + (y1 - y0) / 3, y0 + (2 * (y1 - y0)) / 3, y1];
  const ch: Aabb[] = [];
  const hk: Aabb[] = [];
  const CZ = 0.62;
  for (let i = 0; i < 3; i++) {
    ch.push([-SDX, ys[i]!, -CZ, SDX, ys[i + 1]!, CZ]);
    hk.push(i === 2 ? [-GX, y1, -CZ, GX, y1 + M, CZ] : flat(-GX, GX, y1, -CZ, CZ));
  }
  ch.push(flat(-SDX, SDX, y1, -CZ, CZ));
  hk.push(flat(-GX, GX, y1 + M, -CZ, CZ));
  ch.push(flat(-SDX, SDX, y0, -FW, FW));
  hk.push(flat(-GX, GX, y1, -FW, FW));
  const g0 = y1 + M;
  const top = 0.44;
  const gate: Aabb[] = [
    [-GX, g0, -GZ, GX, top, -CZ],
    [-GX, g0, CZ, GX, top, GZ],
    flat(-GX, GX, g0, -CZ, CZ),
    flat(-GX, GX, g0, -CZ, CZ),
    flat(-GX, GX, g0, -CZ, CZ),
    flat(-GX, GX, g0, -CZ, CZ),
    [-GX, g0, -CZ, GX, top, CZ],
  ];
  const sd: Aabb = [-SDX1, -0.3, -CZ, -SDX, y1, CZ];
  return {
    ch,
    hk,
    gate,
    sd: [sd, sym(sd), flat(-SDX1, -SDX, y1, -CZ, CZ), flat(SDX, SDX1, y1, -CZ, CZ)],
    sdType: ['n', 'n', 'n', 'n'],
    ox: [flat(-1.9, 1.9, 0, -1.1, 1.1), flat(-SDX1, -SDX, y1, -CZ, CZ), flat(SDX, SDX1, y1, -CZ, CZ)],
    flows: [{ y: -0.022, z: 0, type: 'n', x0: 1.2 }],
    top,
  };
}

const ARCH: Record<Kind, Arch> = {
  planar: planarArch(),
  finfet: finArch(),
  gaa: sheetsArch('gaa'),
  cfet: sheetsArch('cfet'),
};
const SUB: Aabb = [-1.9, -0.36, -1.1, 1.9, 0, 1.1];

/* ───────────────────────── builder ───────────────────────── */

export function buildTransistor(ctx: SceneContext, root: Group): View {
  const { materials } = ctx;
  const world = new Group();
  world.name = 'transistor-variant';
  root.add(world);
  const labels = new LabelSet(ctx);
  let portrait = ctx.size.portrait;
  let compactStage = isCompact(ctx.size);
  let [slideX, slideZ] = SLIDE[portrait ? 'portrait' : 'landscape'];

  const rbox = ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.06));
  const subMat = materials.standard((p) => silicon(p).lerp(p.bg, 0.18), { roughness: 0.6, metalness: 0.1 });
  const chMat = ctx.track(new MeshStandardMaterial({ roughness: 0.38, metalness: 0.15 }));
  const hkMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.05 }));
  const gateMat = ctx.track(new MeshStandardMaterial({ roughness: 0.32, metalness: 0.45 }));
  const sdMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }));
  // FrontSide: the slab's bottom face would z-fight with the substrate top it sits on.
  const oxMat = materials.glass('fg', 0.14, { roughness: 0.2, side: FrontSide });
  /** Source half (solid) + drain half (ghosted once the device is sliced open). */
  interface Half2 {
    a: BoxSet;
    b: BoxSet;
    ma: MeshStandardMaterial;
    mb: MeshStandardMaterial;
    glass: boolean;
    ghost: number;
  }
  // The ghosted drain half is drawn as a translucent *solid*: a depth-only pre-pass of all its
  // opaque parts (renderOrder 3) means the colour pass (renderOrder 4) only keeps the front-most
  // surfaces, instead of every inner box adding to a muddy stack of layers.
  // (pushed back a hair so the colour pass never z-fights with its own pre-pass)
  const depthOnly = ctx.track(
    new MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    }),
  );
  const prepass: InstancedMesh[] = [];
  const pairOf = (mat: MeshStandardMaterial, cap: number, geo?: RoundedBoxGeometry, ghost = GHOST): Half2 => {
    const mb = ctx.track(mat.clone());
    mb.transparent = true;
    const h: Half2 = {
      a: new BoxSet(ctx, mat, cap, geo),
      b: new BoxSet(ctx, mb, cap, geo),
      ma: mat,
      mb,
      glass: mat.transparent,
      ghost,
    };
    h.b.mesh.renderOrder = 4;
    if (!mat.transparent) {
      const pre = new InstancedMesh(h.b.mesh.geometry, depthOnly, cap);
      pre.instanceMatrix = h.b.mesh.instanceMatrix; // shares the drain half's boxes
      pre.renderOrder = 3;
      pre.frustumCulled = false;
      pre.raycast = () => {}; // never pickable
      ctx.track({ dispose: () => pre.dispose() });
      prepass.push(pre);
    }
    return h;
  };
  const sub = pairOf(subMat, 1, undefined, GHOST * 0.55);
  const ch = pairOf(chMat, 5);
  const hk = pairOf(hkMat, 5, undefined, GHOST * 0.6);
  const gate = pairOf(gateMat, 7, undefined, GHOST * 0.6);
  const sd = pairOf(sdMat, 4, rbox);
  const ox = pairOf(oxMat, 3);
  ox.a.mesh.renderOrder = 2;
  const pairs = [sub, ch, hk, gate, sd, ox];
  const device = new Group();
  for (const h of pairs) device.add(h.a.mesh, h.b.mesh);
  device.add(...prepass);
  world.add(device);
  const ghostMaterials = () => {
    for (const h of pairs) {
      h.mb.color.copy(h.ma.color);
      h.mb.emissive.copy(h.ma.emissive);
      h.mb.emissiveIntensity = h.ma.emissiveIntensity;
      // translucent parts read darker than the page on a dark stage: give the ghost a bit more body there
      const ghost = h.ghost * (ctx.theme === 'dark' ? 1.6 : 1);
      h.mb.opacity = h.glass ? h.ma.opacity * lerp(1, 0.5, cut) : lerp(1, ghost, cut);
      h.mb.depthWrite = !h.glass && cut < 0.5;
    }
  };
  const shadow = contactShadow(ctx, 6.5, 4.4);
  shadow.position.set(0.35, -0.64, 0);
  world.add(shadow);

  // Technical-drawing outline of the removed drain half: substrate, gate, drain epi and channels.
  const outlineMat = materials.line((p) => p.fg.clone().lerp(p.bg, p.theme === 'dark' ? 0.35 : 0.45), {
    transparent: true,
    opacity: 0.8,
  });
  const outline = new Lines(ctx, outlineMat, 12 * 12);
  outline.object.renderOrder = 5;
  world.add(outline.object);
  const edgePts: [number, number, number][] = [];
  const pushBox = (b: Aabb) => {
    if (b[3] - b[0] < 1e-3 || b[4] - b[1] < 1e-3 || b[5] - b[2] < 1e-3) return;
    const xs = [b[0], b[3]];
    const ys = [b[1], b[4]];
    const zs = [b[2], b[5]];
    for (const y of ys) for (const z of zs) edgePts.push([xs[0]!, y, z], [xs[1]!, y, z]);
    for (const x of xs) for (const z of zs) edgePts.push([x, ys[0]!, z], [x, ys[1]!, z]);
    for (const x of xs) for (const y of ys) edgePts.push([x, y, zs[0]!], [x, y, zs[1]!]);
  };
  const tmpBox: Aabb = [...ZERO];
  /** Drain-half part of a device box, shifted by the cut. */
  const drainBox = (b: Aabb): Aabb => {
    const dx = slideX * cut;
    const dz = slideZ * cut;
    tmpBox[0] = Math.max(0, b[0]) + dx;
    tmpBox[1] = b[1];
    tmpBox[2] = b[2] + dz;
    tmpBox[3] = b[3] + dx;
    tmpBox[4] = b[4];
    tmpBox[5] = b[5] + dz;
    if (b[3] <= 0) tmpBox[3] = tmpBox[0];
    return tmpBox;
  };
  // Exploded-view guides: dashed lines from the corners of the gate's cut face to the same corners
  // on the drain half (technical-drawing convention: "this piece was cut from here").
  const guideMat = ctx.track(
    new LineDashedMaterial({
      dashSize: 0.07,
      gapSize: 0.05,
      transparent: true,
      opacity: 0.75,
      toneMapped: false,
    }),
  );
  materials.bind(guideMat, 'color', 'muted');
  const guides = new Lines(ctx, guideMat, 4);
  world.add(guides.object);
  // Leader lines from the cut face to the 通道 / high-k labels (labels sit right of the cut face).
  const leaderMat = materials.line((p) => p.fg.clone().lerp(p.bg, 0.3), { transparent: true, opacity: 0.95 });
  const leaders = new Lines(ctx, leaderMat, 4);
  leaders.object.renderOrder = 7;
  world.add(leaders.object);
  const gateBottom = () => {
    let gy0 = Infinity;
    for (const g of cur.gate) if (g[4] - g[1] > 1e-3) gy0 = Math.min(gy0, g[1]);
    return gy0;
  };
  const layoutOutline = () => {
    const on = cut > 0.02;
    outline.object.visible = on;
    guides.object.visible = on;
    if (!on) return;
    edgePts.length = 0;
    pushBox(drainBox(SUB));
    // the gate as one block (its pieces tile the space around the channels)
    const gy0 = gateBottom();
    pushBox(drainBox([-GX, gy0, -GZ, GX, cur.top, GZ]));
    pushBox(drainBox(cur.sd[1]!));
    pushBox(drainBox(cur.sd[3]!));
    for (let i = 0; i < 4; i++) pushBox(drainBox(cur.ch[i]!));
    outline.set(edgePts);
    const dx = slideX * cut;
    const dz = slideZ * cut;
    const x0 = 0.004;
    const corners: [number, number][] = [
      [gy0, -GZ],
      [cur.top, -GZ],
      [cur.top, GZ],
      [gy0, GZ],
    ];
    guides.set(
      corners.flatMap(([y, z]) => [
        [x0, y, z] as [number, number, number],
        [dx - 0.004, y, z + dz] as [number, number, number],
      ]),
    );
    guides.object.computeLineDistances();
  };

  /* ───────── state ───────── */
  const cur: Arch = structuredClone(ARCH.gaa);
  let kind: Kind = 'gaa';
  let cut = 0;
  const half: Aabb = [...ZERO];
  const put = (h: Half2, i: number, b: Aabb, eps = 0) => {
    // source half: x ≤ 0; drain half: x ≥ 0, shifted by the cut
    const dx = slideX * cut;
    const dz = slideZ * cut;
    half[1] = b[1];
    half[2] = b[2];
    half[4] = b[4];
    half[5] = b[5];
    if (b[0] < 0) {
      half[0] = b[0];
      half[3] = Math.min(0, b[3]) + (b[3] > 0 ? eps : 0);
      h.a.set(i, half);
    } else h.a.set(i, ZERO);
    if (b[3] > 0) {
      half[0] = Math.max(0, b[0]) + dx - (b[0] < 0 ? eps : 0);
      half[3] = b[3] + dx;
      half[2] = b[2] + dz;
      half[5] = b[5] + dz;
      h.b.set(i, half);
    } else h.b.set(i, ZERO);
  };
  const layoutDevice = () => {
    put(sub, 0, SUB);
    cur.ch.forEach((b, i) => put(ch, i, b, CUT_EPS));
    cur.hk.forEach((b, i) => put(hk, i, b));
    cur.gate.forEach((b, i) => put(gate, i, b));
    cur.sd.forEach((b, i) => put(sd, i, b));
    cur.ox.forEach((b, i) => put(ox, i, b));
    for (const h of pairs) {
      h.a.flush();
      h.b.flush();
    }
    ghostMaterials();
    layoutOutline();
    for (const f of flows) f.drn.object.position.set(slideX * cut, 0, slideZ * cut);
    placeLabels();
  };

  /* ───────── carriers (one PathFlow per half and carrier type) ───────── */
  interface FlowSet {
    kind: Kind;
    type: 'n' | 'p';
    src: PathFlow;
    drn: PathFlow;
    level: number;
  }
  const flows: FlowSet[] = [];
  const FMAX = 14; // carriers per channel path (discrete dots, not a beam)
  for (const k of KINDS) {
    for (const type of ['n', 'p'] as const) {
      const fl = ARCH[k].flows.filter((f) => f.type === type);
      if (!fl.length) continue;
      const mk = (a: number, b: number) =>
        ctx.track(
          new PathFlow({
            paths: fl.map((f) => ({
              points: [
                [a * f.x0, f.y, f.z] as [number, number, number],
                [b * f.x0, f.y, f.z] as [number, number, number],
              ],
            })),
            count: scaleCount(FMAX * fl.length, ctx.tier, 12),
            size: 0.06,
            speed: 0.55,
            speedVariance: 0.06,
            smooth: false,
            fadeEnds: 0.12,
            theme: ctx.theme,
            seed: 9,
          }),
        );
      const set: FlowSet = { kind: k, type, src: mk(-1, 0), drn: mk(0, 1), level: 0 };
      // Source-half carriers are depth-tested (hidden inside the solid half, so the cut face stays
      // clean); drain-half carriers draw over the ghost, where they leave the channel.
      set.src.object.material.depthTest = true;
      set.drn.object.material.depthTest = false;
      for (const f of [set.src, set.drn]) {
        f.object.renderOrder = 6;
        f.setReduced(!ctx.animate);
        f.object.visible = false;
        world.add(f.object);
      }
      flows.push(set);
    }
  }
  const chBase = new Color();
  const chTint = new Color();
  const cCarrierN = new Color();
  const cCarrierP = new Color();
  /** Conducting channels glow faintly in their carrier colour (colour + motion + the state line). */
  let lastN = 0;
  let lastP = 0;
  const tintChannels = (n: number, p: number) => {
    lastN = n;
    lastP = p;
    for (let i = 0; i < 5; i++) {
      const level = i === 4 ? 0 : kind === 'cfet' ? (i < 2 ? p : n) : n;
      chTint.copy(chBase).lerp(kind === 'cfet' && i < 2 ? cCarrierP : cCarrierN, 0.5 * level);
      ch.a.color(i, chTint);
      ch.b.color(i, chTint);
    }
  };
  const setFlowLevels = (n: number, p: number) => {
    for (const f of flows) {
      f.level = f.kind === kind ? (f.type === 'n' ? n : p) : 0;
      const vis = f.level > 0.02;
      f.src.object.visible = f.drn.object.visible = vis;
      f.src.setOpacity(f.level);
      f.drn.setOpacity(f.level);
    }
    tintChannels(n, p);
  };

  /* ───────── labels ───────── */
  const hud = new Hud(ctx);
  const L = {
    title: hud.add({ text: '', align: 'center', kind: 'strong', priority: 40 }, 0.5, 0, 0, 30),
    wrap: hud.add({ text: '', align: 'center', kind: 'muted', priority: 38 }, 0.5, 0, 0, 58),
    gate: labels.add({
      text: '閘極（gate）',
      position: [0, 0, 0],
      align: 'above',
      priority: 30,
      hotspot: 'gate',
    }),
    src: labels.add({
      text: '源極（S）',
      position: [0, 0, 0],
      align: 'left',
      priority: 28,
      hotspot: 'source-drain',
    }),
    drn: labels.add({
      text: '汲極（D）',
      position: [0, 0, 0],
      align: 'right',
      priority: 28,
      hotspot: 'source-drain',
    }),
    ch: labels.add({
      text: '通道',
      position: [0, 0, 0],
      align: 'right',
      offset: [0, 0],
      priority: 26,
      hotspot: 'channel',
    }),
    hk: labels.add({
      text: '閘極介電層（high-k）',
      position: [0, 0, 0],
      align: 'right',
      offset: [0, 0],
      kind: 'tag',
      priority: 18,
      hotspot: 'gate-dielectric',
    }),
    sti: labels.add({
      text: '隔離氧化層（STI）',
      position: [0, 0, 0],
      align: 'left',
      kind: 'tag',
      priority: 8,
    }),
    subs: labels.add({
      text: '矽基板',
      position: [-1.9, -0.4, 1.1],
      align: 'left',
      kind: 'tag',
      priority: 7,
    }),
    state: hud.add({ text: '', align: 'center', kind: 'default', priority: 36 }, 0.5, 1, 0, -64),
    nfet: labels.add({ text: '上層 nFET', position: [0, 0, 0], align: 'right', kind: 'tag', priority: 24 }),
    pfet: labels.add({ text: '下層 pFET', position: [0, 0, 0], align: 'right', kind: 'tag', priority: 24 }),
  };
  // The evolution as a row of chips along the bottom of the stage (screen-anchored).
  const timeline = KINDS.map((k, i) =>
    hud.add(
      { text: `${i + 1} ${NAME[k]}`, align: 'center', kind: 'muted', priority: 20 - i },
      0.5,
      1,
      0,
      -28,
    ),
  );
  const layoutTimeline = () => {
    const w = ctx.size.width;
    const narrow = w < 520;
    hud.move(L.title, 0.5, 0, 0, isCompact(ctx.size) ? 20 : 30);
    hud.move(L.state, 0.5, 1, 0, isCompact(ctx.size) ? -58 : -64);
    const span = Math.min(w - 40, 600);
    timeline.forEach((h, i) => {
      h.set({ text: `${i + 1} ${narrow && KINDS[i] === 'gaa' ? 'GAA' : NAME[KINDS[i]!]}` });
      hud.move(h, 0.5, 1, (i - 1.5) * (span / 4), -28);
    });
  };
  layoutTimeline();
  labels.show(0);
  let gateOn = 1;
  let cfetHigh = true;
  const leaderPts: [number, number, number][] = [];
  const shownPts: [number, number, number][] = [];
  /** Bitmask of the cut-face labels placed by the label layer (1 = 通道, 2 = high-k); -1 = re-check. */
  let leadersShown = -1;
  /** Draw a leader line only while its label is actually placed (narrow stages may cull one). */
  const syncLeaders = () => {
    const mask = (L.ch.shown ? 1 : 0) | (L.hk.shown ? 2 : 0);
    if (mask === leadersShown || leaderPts.length < 4) return;
    leadersShown = mask;
    shownPts.length = 0;
    if (mask & 1) shownPts.push(leaderPts[0]!, leaderPts[1]!);
    if (mask & 2) shownPts.push(leaderPts[2]!, leaderPts[3]!);
    leaders.set(shownPts);
    ctx.invalidate();
  };
  // (labels are laid out after each frame: with no frames coming, catch up once the burst ends)
  let leaderTimer = 0;
  const syncLeadersLater = () => {
    window.clearTimeout(leaderTimer);
    leaderTimer = window.setTimeout(syncLeaders, 160);
  };
  const placeLabels = () => {
    const dx = slideX * cut;
    const dz = slideZ * cut;
    const sdTop = Math.max(cur.sd[0]![4], cur.sd[2]![4]);
    const narrow = ctx.size.width < 600;
    const compact = isCompact(ctx.size);
    // (4:3 phones: the gate name moves toward the front of the gate, clear of the cut-face labels)
    L.gate.set({ position: compact ? [-GX, cur.top, GZ * 0.45] : [-GX * 0.5, cur.top, -GZ * 0.4] });
    if (narrow) {
      // phones: the tops are crowded (gate, cut-face leaders), so S / D hang below the epi
      // (on a 4:3 stage the state line sits under the drain: there D is named on the ghosted epi)
      const s0 = cur.sd[0]!;
      const d0 = cur.sd[1]!;
      L.src.set({ position: [-(SDX + SDX1) / 2, s0[1], s0[5]], align: 'below' });
      L.drn.set(
        compact
          ? {
              position: [(SDX + SDX1) / 2 + dx, lerp(d0[1], sdTop, 0.12), d0[5] + dz],
              align: 'center',
            }
          : { position: [(SDX + SDX1) / 2 + dx, d0[1], d0[5] + dz], align: 'below' },
      );
    } else if (portrait) {
      // width-limited stage: S / D names sit on top of the epi blocks instead of beside them
      L.src.set({ position: [-(SDX + SDX1) / 2, sdTop, 0], align: 'above' });
      L.drn.set({ position: [(SDX + SDX1) / 2 + dx, sdTop, dz], align: 'above' });
    } else {
      // beside the outer edge of the epi; planar S / D are doped wells in the substrate, so their
      // names point at the outer edge of the well's top surface instead
      const ys = kind === 'planar' ? sdTop : (cur.sd[0]![1] + sdTop) / 2;
      const yd = kind === 'planar' ? sdTop : (cur.sd[1]![1] + sdTop) / 2;
      L.src.set({ position: [-SDX1, ys, 0.62], align: 'left' });
      L.drn.set({ position: [SDX1 + dx, yd, 0.62 + dz], align: 'right' });
    }
    // Leader lines on the cut face (x = 0): from the right edge of the top channel and from the
    // right side of the lowest high-k sleeve out to labels right of the gate.
    const XL = 0.012;
    const c = cur.ch[kind === 'cfet' ? 3 : 2]!;
    const h = cur.hk[kind === 'planar' ? 2 : 0]!;
    const yc = (c[1] + c[4]) / 2;
    const yh = (h[1] + h[4]) / 2;
    // keep the two labels apart (the planar channel and its gate oxide are only a hair apart)
    const mid = (yc + yh) / 2;
    const gap = Math.max(Math.abs(yc - yh), narrow ? 0.75 : 0.4) / 2;
    const ycL = yc >= yh ? mid + gap : mid - gap;
    const yhL = yc >= yh ? mid - gap : mid + gap;
    leaderPts.length = 0;
    leaderPts.push([XL, yc, c[2]], [XL, ycL, LABEL_Z], [XL, yh, h[2] + M / 2], [XL, yhL, LABEL_Z]);
    leaders.object.visible = cut > 0.5;
    L.ch.set({ position: [XL, ycL, LABEL_Z], visible: cut > 0.5 });
    L.hk.set({
      position: [XL, yhL, LABEL_Z],
      visible: cut > 0.5,
      text: narrow ? 'high-k 介電層' : '閘極介電層（high-k）',
    });
    L.sti.set({ position: [-1.9, STI * 0.6, 1.1], visible: kind !== 'planar' });
    const t = cur.sd[2]!;
    const b = cur.sd[0]!;
    if (narrow) {
      // no room right of the drain on a phone: name the n / p layers on the solid source epi
      const sx = -(SDX + SDX1) / 2;
      L.nfet.set({ position: [sx, (t[1] + t[4]) / 2, t[5]], align: 'center', visible: kind === 'cfet' });
      L.pfet.set({ position: [sx, (b[1] + b[4]) / 2, b[5]], align: 'center', visible: kind === 'cfet' });
    } else {
      L.nfet.set({
        position: [SDX1 + dx, (t[1] + t[4]) / 2, 0.3 + dz],
        align: 'right',
        visible: kind === 'cfet',
      });
      L.pfet.set({
        position: [SDX1 + dx, (b[1] + b[4]) / 2, 0.3 + dz],
        align: 'right',
        visible: kind === 'cfet',
      });
    }
    leadersShown = -1; // re-check which leader lines have a visible label
  };
  const applyText = () => {
    const compact = isCompact(ctx.size);
    L.title.set({ text: compact ? HEADING[kind] : TITLE[kind] });
    L.wrap.set({ text: WRAP[kind], visible: !compact });
    timeline.forEach((h, i) => h.set({ kind: KINDS[i] === kind ? 'strong' : 'muted' }));
    L.drn.set({ text: '汲極（D）' });
    L.src.set({ text: '源極（S）' });
  };

  /* ───────── colours ───────── */
  const cN = new Color();
  const cP = new Color();
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    tintShadow(shadow, p, 1.3);
    chBase
      .copy(p.fg)
      .lerp(p.flow, 0.22)
      .lerp(p.bg, dark ? 0.3 : 0.38);
    chMat.color.setRGB(1, 1, 1);
    cCarrierN.copy(p.flow);
    cCarrierP.copy(p.chart[4] ?? p.optic);
    hkMat.color.copy(p.chart[2] ?? p.pos);
    gateMat.color.copy(p.chart[1] ?? p.power);
    cN.copy(p.chart[0] ?? p.accent);
    cP.copy(p.chart[4] ?? p.optic);
    sdMat.color.setRGB(1, 1, 1);
    cur.sdType.forEach((t, i) => {
      sd.a.color(i, t === 'n' ? cN : cP);
      sd.b.color(i, t === 'n' ? cN : cP);
    });
    for (const f of flows) {
      const c = f.type === 'n' ? p.flow : (p.chart[4] ?? p.optic);
      for (const pf of [f.src, f.drn]) {
        pf.recolor(() => c);
        pf.setTheme(p.theme);
        pf.setSize(dark ? 0.062 : 0.052);
      }
    }
    tintChannels(lastN, lastP);
    L.nfet.set({ swatch: p.css['chart-1'] ?? '' });
    L.pfet.set({ swatch: p.css['chart-5'] ?? '' });
    applyGate();
    ghostMaterials();
  };
  const applyGate = () => {
    const dark = ctx.theme === 'dark';
    const glow = kind === 'planar' ? gateOn : kind === 'cfet' ? (cfetHigh ? 1 : 0.25) : 0.6;
    gateMat.emissive.copy(gateMat.color);
    gateMat.emissiveIntensity = (dark ? 0.32 : 0.12) * glow + hot.gate;
    gate.mb.emissive.copy(gateMat.emissive);
    gate.mb.emissiveIntensity = gateMat.emissiveIntensity;
  };

  /* ───────── morph ───────── */
  let morphTw: { cancel(): void } | null = null;
  const morphTo = (k: Kind, instant = false) => {
    morphTw?.cancel();
    const from: Arch = structuredClone(cur);
    const to = ARCH[k];
    const prevKind = kind;
    kind = k;
    cur.sdType = to.sdType.slice();
    applyPalette(ctx.palette);
    applyText();
    setFlowLevels(0, 0);
    const step = (e: number) => {
      from.ch.forEach((b, i) => lerpBox(b, to.ch[i]!, e, cur.ch[i]!));
      from.hk.forEach((b, i) => lerpBox(b, to.hk[i]!, e, cur.hk[i]!));
      from.gate.forEach((b, i) => lerpBox(b, to.gate[i]!, e, cur.gate[i]!));
      from.sd.forEach((b, i) => lerpBox(b, to.sd[i]!, e, cur.sd[i]!));
      from.ox.forEach((b, i) => lerpBox(b, to.ox[i]!, e, cur.ox[i]!));
      cur.top = lerp(from.top, to.top, e);
      layoutDevice();
    };
    if (instant || prevKind === k) {
      step(1);
      settle();
      return;
    }
    morphTw = ctx.tween.run(step, { duration: 1100, onComplete: settle });
  };
  const settle = () => {
    refreshState();
  };
  /** Flows / gate state for the current step and time. */
  const refreshState = () => {
    if (kind === 'planar') setFlowLevels(gateOn, 0);
    else if (kind === 'cfet') setFlowLevels(cfetHigh ? 1 : 0, cfetHigh ? 0 : 1);
    else setFlowLevels(1, 0);
    applyGate();
    if (kind === 'planar' && ctx.step === STEP.planar)
      L.state.set({
        text: gateOn > 0.5 ? '閘極電壓：開 → 導通（1）' : '閘極電壓：關 → 截止（0）',
        visible: true,
      });
    else if (kind === 'cfet' && ctx.step === STEP.cfet)
      L.state.set({
        text: cfetHigh ? '閘極高電位 → 上層 nFET 導通' : '閘極低電位 → 下層 pFET 導通',
        visible: true,
      });
    else L.state.set({ visible: false });
  };

  /* ───────── hotspots ───────── */
  const hot = { gate: 0 };
  const glowOn = (h: Half2, on: boolean) => {
    for (const mat of [h.ma, h.mb]) {
      mat.emissive.copy(ctx.palette.highlight);
      ctx.tween.to(
        mat,
        { emissiveIntensity: on ? (ctx.theme === 'dark' ? 0.35 : 0.16) : 0 },
        { duration: 200, fade: true },
      );
    }
  };
  const partCard = (id: string): CardContent => {
    const c = cardFor(id);
    const k = cardFor(kind);
    return {
      ...c,
      subtitle: `目前：${NAME[kind]}・${WRAP[kind]}`,
      ...(k.href ? { href: k.href, linkLabel: `名詞解釋：${NAME[kind]} →` } : {}),
    };
  };
  ctx.hotspots.register('gate', {
    object: gate.a.mesh,
    anchor: new Vector3(0, 1.2, 0),
    card: () => partCard('gate'),
    onHighlight: (on) =>
      ctx.tween.run(
        (e) => {
          hot.gate = (on ? e : 1 - e) * (ctx.theme === 'dark' ? 0.3 : 0.15);
          applyGate();
        },
        { duration: 200, fade: true },
      ),
  });
  ctx.hotspots.register('channel', {
    object: ch.a.mesh,
    anchor: new Vector3(-0.42, 0.6, 0.5),
    card: () => partCard('channel'),
    onHighlight: (on) => glowOn(ch, on),
  });
  ctx.hotspots.register('source-drain', {
    object: sd.a.mesh,
    anchor: new Vector3(-1.15, 0.8, 0.6),
    card: () => partCard('source-drain'),
    onHighlight: (on) => glowOn(sd, on),
  });
  ctx.hotspots.register('gate-dielectric', {
    object: hk.a.mesh,
    anchor: new Vector3(0, 0.7, 0.55),
    card: () => partCard('gate-dielectric'),
    onHighlight: (on) => glowOn(hk, on),
  });
  ctx.picker.add(gate.b.mesh, { id: 'gate' });
  ctx.picker.add(ch.b.mesh, { id: 'channel' });
  ctx.picker.add(sd.b.mesh, { id: 'source-drain' });
  for (const m of [chMat, sdMat, hkMat]) m.emissiveIntensity = 0;

  /* ───────── steps & ambient ───────── */
  let cycleT = 0;
  let phaseT = 0;
  const CYCLE = 4.2;
  // The animated overview frames each architecture as it appears (the camera eases along with the
  // morph) until the reader takes the camera; the home / reset pose stays the CFET framing.
  let follow = true;
  const stopFollow = () => {
    follow = false;
  };
  ctx.controls?.addEventListener('start', stopFollow);
  /** Pose for an architecture on this stage shape (compact 4:3 phones: 10 % closer, labels are relatively big). */
  const shapePose = (k: Kind): CameraPose => {
    const pose = POSES[portrait ? 'portrait' : 'landscape'][k];
    if (portrait || !isCompact(ctx.size)) return exactPose(ctx, pose);
    const [px, py, pz] = pose.position as [number, number, number];
    const [tx, ty, tz] = pose.target as [number, number, number];
    const f = 0.9;
    const dy = k === 'planar' ? -0.23 : 0; // (the flat planar device sits low under the heading)
    return {
      position: [tx + (px - tx) * f, ty + (py - ty) * f + dy, tz + (pz - tz) * f],
      target: [tx, ty + dy, tz],
    };
  };
  const go = (i: number) => {
    const k = STEP_KIND[i];
    follow = true;
    cycleT = 0;
    phaseT = 0;
    gateOn = 1;
    cfetHigh = true;
    if (k) morphTo(k);
    else if (!ctx.animate) morphTo('gaa');
    else morphTo(kind);
    for (const h of timeline) h.set({ visible: true });
    refreshState();
    // The overview tours all four, framed for whichever is showing; a static overview (reduced
    // motion) shows GAA and is framed for it.
    ctx.setPose(shapePose(k ?? kind));
  };

  applyPalette(ctx.palette);
  // The animated overview tours the architectures in historical order, starting from planar; a
  // static one (reduced motion) shows today's GAA.
  morphTo(ctx.animate && !STEP_KIND[ctx.step] ? 'planar' : 'gaa', true);
  layoutDevice();
  // Slice the device open once (a cut under reduced motion).
  const cutTw = ctx.tween.run(
    (e) => {
      cut = e;
      layoutDevice();
    },
    { duration: 900, delay: 350 },
  );

  return {
    setStep(i) {
      go(STEP_KIND[i] ? i : STEP.overview);
    },
    update(dt, t) {
      hud.update();
      syncLeaders();
      syncLeadersLater();
      for (const f of flows) {
        if (f.level <= 0) continue;
        f.src.update(t);
        f.drn.update(t + 0.37);
      }
      if (!ctx.animate) return;
      const step = ctx.step;
      if (step === STEP.overview || !STEP_KIND[step]) {
        cycleT += dt;
        if (cycleT > CYCLE) {
          cycleT = 0;
          const next = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length]!;
          morphTo(next);
          if (follow) ctx.setPose(shapePose(next), { duration: 1100 });
        }
      } else if (kind === 'planar' && step === STEP.planar) {
        phaseT = (phaseT + dt) % 4.4;
        const target = phaseT < 2.6 ? 1 : 0;
        gateOn += (target - gateOn) * Math.min(1, dt * 6);
        refreshState();
      } else if (kind === 'cfet' && step === STEP.cfet) {
        phaseT = (phaseT + dt) % 5.2;
        const high = phaseT < 2.6;
        if (high !== cfetHigh) {
          cfetHigh = high;
          refreshState();
        }
      }
    },
    onPalette: applyPalette,
    onResize(size) {
      layoutTimeline();
      applyText();
      placeLabels();
      const next = size.portrait;
      const nextCompact = isCompact(size);
      if (next === portrait && nextCompact === compactStage) return;
      compactStage = nextCompact;
      if (next !== portrait) {
        portrait = next;
        [slideX, slideZ] = SLIDE[portrait ? 'portrait' : 'landscape'];
        layoutDevice();
      }
      ctx.setPose(shapePose(STEP_KIND[ctx.step] ?? kind));
    },
    onMotion(animate) {
      for (const f of flows) {
        f.src.setReduced(!animate);
        f.drn.setReduced(!animate);
      }
      if (!animate) {
        gateOn = 1;
        cfetHigh = true;
        refreshState();
      }
    },
    onQuality(scale) {
      for (const f of flows) {
        const n = Math.max(
          12,
          Math.round(FMAX * ARCH[f.kind].flows.filter((x) => x.type === f.type).length * scale),
        );
        f.src.setCount(n);
        f.drn.setCount(n);
      }
    },
    dispose() {
      window.clearTimeout(leaderTimer);
      ctx.controls?.removeEventListener('start', stopFollow);
      morphTw?.cancel();
      cutTw.cancel();
      labels.dispose();
      hud.dispose();
      world.removeFromParent();
    },
  };
}

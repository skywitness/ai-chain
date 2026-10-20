/**
 * cowos — variant `cowos`: a generic (unbranded) CoWoS package as an exploded diorama.
 *
 * Bottom → top (ExplodedStack layers): ABF substrate + BGA balls + stiffener/capacitors → C4 bumps →
 * interposer (CoWoS-S: silicon with TSVs and fine RDL wiring | CoWoS-L: organic RDL with embedded
 * LSI bridges and through-interposer copper vias) → micro-bumps → two reticle-sized logic dies and
 * 8 HBM stacks (base die + 12 DRAM dies, TSVs). Lateral scale ≈ 1 unit : 10 mm; thicknesses are
 * exaggerated (示意). Data (cyan) flows GPU ⇄ HBM on the interposer; power (amber) rises from
 * the substrate through C4 / TSV / µbump into the dies.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
  MeshStandardMaterial,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, CardContent, LabelHandle, Palette, SceneContext, SceneInstance } from '../../core/types';
import { ExplodedStack } from '../../kit/ExplodedStack';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  Heat,
  buildFloor,
  dampRim,
  floorplanTexture,
  joinGrids,
  orderedGrid,
  partColors,
  pickProxy,
  placeGrid,
  setMatrix,
  smooth,
  tierCount,
} from './common';
import { CARDS, switchVariant, takePending } from './content';
import { createPanel } from './ui';

/* ───────────────────────── layout (1 unit ≈ 10 mm; heights exaggerated) ───────────────────────── */

const DIE = { w: 3.3, d: 2.6, h: 0.22, x: 1.7 }; // ≈ one 26 × 33 mm reticle field each
const HBM = { w: 1.1, d: 0.95, dx: 0.82, z: 1.875, base: 0.034, layers: 12 };
const INT = { w: 7.1, d: 5.1, h: 0.12, rdl: 0.014 };
const SUB = { w: 9.4, d: 7.2, h: 0.32 }; // h = sum of SUB_LAYERS
const BGA = { r: 0.1, pitch: 0.36, h: 0.17 };
const C4 = { r: 0.058, pitch: 0.24, h: 0.09 };
const UB = { r: 0.024, pitch: 0.09, h: 0.04 };
const GAP = 1.0;
const HBM_GAP = 0.055;
const HBM_LIFT = 0.95; // the focus stack is pulled up out of the package in the HBM step
const LABEL_X = 5.25; // landscape: layer-name column on the +X side
const LABEL_Z = 4.15; // portrait: the column moves to the −Z side (screen right once turned)
/** Portrait stages turn every pose 75° about the target, so the package's long side runs up the screen. */
const PORTRAIT_TURN = (75 * Math.PI) / 180;

const Y_SUB = BGA.h;
const Y_C4 = Y_SUB + SUB.h;
const Y_INT = Y_C4 + C4.h;
const Y_UB = Y_INT + INT.h + INT.rdl;
const Y_DIE = Y_UB + UB.h;

/** HBM stack centres: two per die edge, front and back. Index 7 = front-right (the focus stack). */
const HBM_XZ: [number, number][] = [];
for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (const dx of [-HBM.dx, HBM.dx]) HBM_XZ.push([sx * DIE.x + dx, sz * HBM.z]);
const FOCUS_HBM = HBM_XZ.length - 1;

type Mode = 'S' | 'L';

interface StepSpec {
  explode: number;
  pose: CameraPose | null;
  /** Explicit portrait pose (default: `pose` turned about its target). Scaled by the host like any pose. */
  portrait?: CameraPose;
  mode?: Mode;
  reticle?: boolean;
  hbm?: number;
  flows?: number;
  /** 0..1: see-through interposer (TSVs / bridges visible). */
  xray?: number;
  /** Show the layer-name column with leader lines (default: when exploded past half). */
  leaders?: boolean;
  /** 0..1: fade the die / HBM layer so the interposer below reads through it. */
  ghost?: number;
}
const arr = (v: CameraPose['position']): [number, number, number] => (v instanceof Vector3 ? [v.x, v.y, v.z] : [v[0], v[1], v[2]]);
/** Rotate a pose about its target's vertical axis (portrait orientation). */
function turn(p: CameraPose): CameraPose {
  const t = arr(p.target);
  const q = arr(p.position);
  const dx = q[0] - t[0];
  const dz = q[2] - t[2];
  const c = Math.cos(PORTRAIT_TURN);
  const s = Math.sin(PORTRAIT_TURN);
  return { ...p, position: [t[0] + dx * c + dz * s, q[1], t[2] - dx * s + dz * c] };
}
/** Move a pose's camera k× its distance from the target. */
function away(p: CameraPose, k: number): CameraPose {
  const t = arr(p.target);
  const q = arr(p.position);
  return { ...p, position: [t[0] + (q[0] - t[0]) * k, t[1] + (q[1] - t[1]) * k, t[2] + (q[2] - t[2]) * k] };
}

const POSE_LAYERS: CameraPose = { position: [8.6, 6.4, 14.4], target: [1.3, 2.35, 0] };
/** The interposer from above at full explode, the die layer ghosted: wiring on top, TSVs through it. */
const POSE_INTERPOSER: CameraPose = { position: [4.6, 9.6, 8.7], target: [0.55, 2.75, 0.35] };
const POSE_HBM: CameraPose = { position: [6.3, 4.6, 8.1], target: [2.25, 2.85, 1.6] };
const POSE_RETICLE: CameraPose = { position: [0.7, 12.6, 5.9], target: [0.3, 0.55, 0.35] };
/** Per-step state, keyed by the meta.json step id (the tour order lives in meta.json). */
const STEPS: Record<string, StepSpec> = {
  overview: { explode: 0.3, pose: null, flows: 0.7 },
  // Portrait: the target shifts to −Z (screen right) so the label column fits beside the stack.
  layers: { explode: 1, pose: POSE_LAYERS, portrait: { position: [19.05, 7.15, -5.15], target: [0.3, 2.35, -1.25] }, flows: 0.8 },
  interposer: { explode: 1, pose: POSE_INTERPOSER, mode: 'S', flows: 1, xray: 1, leaders: false, ghost: 1 },
  // The focus stack sits on the front row, so this step stays frontal in portrait too.
  hbm: { explode: 0.35, pose: POSE_HBM, portrait: POSE_HBM, hbm: 1, flows: 0.6 },
  // Portrait: the whole substrate fits the narrow frame only from a little further away.
  'reticle-limit': { explode: 0, pose: POSE_RETICLE, portrait: away(turn(POSE_RETICLE), 1.1), reticle: true, flows: 0.4 },
  'cowos-l': { explode: 1, pose: POSE_INTERPOSER, mode: 'L', flows: 1, xray: 1, leaders: false, ghost: 1 },
};
const OVERVIEW = STEPS['overview']!;

/* ───────────────────────── builder ───────────────────────── */

export function buildPackage(ctx: SceneContext): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'cowos';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  const heat = new Heat(ctx);
  const C = (k: keyof ReturnType<typeof partColors>) => (p: Palette) => partColors(p)[k];

  const floor = buildFloor(ctx, 9.5, 0.6, 15, 12);
  root.add(floor.group);

  const unitBox = ctx.track(new BoxGeometry(1, 1, 1));
  const track = <T extends { dispose(): void }>(m: T) => ctx.track(m);
  const inst = (geo: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, n: number) => {
    const m = new InstancedMesh(geo, mat, Math.max(1, n));
    track({ dispose: () => m.dispose() });
    return m;
  };

  /* ───── layer 0: substrate (ABF build-up stack), BGA balls, stiffener, capacitors ───── */
  const subG = new Group();
  subG.name = 'substrate';
  subG.position.y = Y_SUB;
  // Bottom → top (a 2-2-2 build-up, 示意): solder mask, Cu, ABF, Cu, ABF, Cu, glass-fibre core, Cu, ABF,
  // Cu, ABF, Cu, solder mask. Outer Cu layers carry the pads; the core carries plated through-holes.
  const SUB_LAYERS: ['mask' | 'abf' | 'copper' | 'core', number][] = [
    ['mask', 0.02], ['copper', 0.01], ['abf', 0.03], ['copper', 0.01], ['abf', 0.03], ['copper', 0.01], ['core', 0.1],
    ['copper', 0.01], ['abf', 0.03], ['copper', 0.01], ['abf', 0.03], ['copper', 0.01], ['mask', 0.02],
  ];
  // Instance colours carry the layer colours (white base colour).
  const subMat = ctx.track(new MeshStandardMaterial({ roughness: 0.62, metalness: 0.08, transparent: true }));
  const subMesh = inst(unitBox, subMat, SUB_LAYERS.length);
  {
    let y = 0;
    SUB_LAYERS.forEach(([, h], i) => {
      const inset = SUB_LAYERS[i]![0] === 'copper' ? 0.012 : 0;
      setMatrix(subMesh, i, 0, y + h / 2, 0, SUB.w - inset, h, SUB.d - inset);
      y += h;
    });
  }
  const paintSubstrate = (p: Palette) => {
    const pc = partColors(p);
    SUB_LAYERS.forEach(([k], i) => subMesh.setColorAt(i, pc[k]));
    if (subMesh.instanceColor) subMesh.instanceColor.needsUpdate = true;
  };
  subG.add(subMesh);
  // While ghosted, one neutral slab stands in for the 13 build-up layers (translucent layers compound).
  const subGhostMat = materials.standard(C('mask'), { roughness: 0.7, metalness: 0, transparent: true, opacity: 0, depthWrite: false });
  const subGhost = new Mesh(unitBox, subGhostMat);
  subGhost.scale.set(SUB.w, SUB.h, SUB.d);
  subGhost.position.y = SUB.h / 2;
  subGhost.visible = false;
  subG.add(subGhost);

  const bgaMat = materials.standard(C('solder'), { roughness: 0.34, metalness: 0.3, transparent: true });
  const bgaGrid = orderedGrid(-SUB.w / 2 + 0.3, SUB.w / 2 - 0.3, -SUB.d / 2 + 0.3, SUB.d / 2 - 0.3, BGA.pitch);
  const bga = inst(track(new SphereGeometry(BGA.r, 10, 6)), bgaMat, bgaGrid.pts.length);
  placeGrid(bga, bgaGrid, -BGA.h / 2, 1, 0.85);
  subG.add(bga);

  const ringMat = materials.standard(C('metal'), { roughness: 0.48, metalness: 0.35, transparent: true });
  const ring = inst(unitBox, ringMat, 4);
  {
    const t = 0.3;
    const h = 0.08;
    const ix = SUB.w / 2 - 0.12 - t / 2;
    const iz = SUB.d / 2 - 0.12 - t / 2;
    setMatrix(ring, 0, 0, SUB.h + h / 2, -iz, SUB.w - 0.24, h, t);
    setMatrix(ring, 1, 0, SUB.h + h / 2, iz, SUB.w - 0.24, h, t);
    setMatrix(ring, 2, -ix, SUB.h + h / 2, 0, t, h, SUB.d - 0.24 - 2 * t);
    setMatrix(ring, 3, ix, SUB.h + h / 2, 0, t, h, SUB.d - 0.24 - 2 * t);
  }
  subG.add(ring);

  const capMat = materials.standard(C('core'), { roughness: 0.5, metalness: 0.2, transparent: true });
  const caps: [number, number, boolean][] = [];
  for (let i = 0; i < 9; i++) {
    const z = -2.2 + i * 0.55;
    caps.push([-3.92, z, false], [3.92, z, false]);
  }
  for (let i = 0; i < 12; i++) {
    const x = -3.3 + i * 0.6;
    caps.push([x, -2.86, true], [x, 2.86, true]);
  }
  const capMesh = inst(unitBox, capMat, caps.length);
  caps.forEach(([x, z, rot], i) => setMatrix(capMesh, i, x, SUB.h + 0.045, z, rot ? 0.2 : 0.11, 0.09, rot ? 0.11 : 0.2));
  subG.add(capMesh);

  /* ───── layer 1: C4 bumps ───── */
  const c4G = new Group();
  c4G.name = 'c4';
  c4G.position.y = Y_C4;
  const c4Grid = orderedGrid(-INT.w / 2 + 0.16, INT.w / 2 - 0.16, -INT.d / 2 + 0.16, INT.d / 2 - 0.16, C4.pitch);
  const c4Mat = materials.standard(C('solder'), { roughness: 0.34, metalness: 0.3, transparent: true });
  const c4 = inst(track(new SphereGeometry(C4.r, 8, 5)), c4Mat, c4Grid.pts.length);
  placeGrid(c4, c4Grid, C4.h / 2, 1, (C4.h / (2 * C4.r)) * 1.0);
  c4G.add(c4);
  const c4Proxy = pickProxy(new Mesh(unitBox, track(new MeshBasicMaterial())));
  c4Proxy.scale.set(INT.w, C4.h, INT.d);
  c4Proxy.position.y = C4.h / 2;
  c4G.add(c4Proxy);

  /* ───── layer 2: interposer ───── */
  const intG = new Group();
  intG.name = 'interposer';
  intG.position.y = Y_INT;
  const slabGeo = track(new RoundedBoxGeometry(INT.w, INT.h, INT.d, 2, 0.03));
  const siMat = materials.standard(C('silicon'), { roughness: 0.48, metalness: 0.24, transparent: true, opacity: 0.8 });
  const orgMat = materials.standard(C('organic'), { roughness: 0.55, metalness: 0.05, transparent: true, opacity: 0.62 });
  const siSlab = new Mesh(slabGeo, siMat);
  const orgSlab = new Mesh(slabGeo, orgMat);
  for (const s of [siSlab, orgSlab]) {
    s.position.y = INT.h / 2;
    s.renderOrder = 2;
  }
  const slabs = new Group();
  slabs.add(siSlab, orgSlab);
  intG.add(slabs);
  // Thin top dielectric (RDL / BEOL) layer.
  const rdlMat = materials.standard(C('siliconDeep'), { roughness: 0.4, metalness: 0.15, transparent: true });
  // CoWoS-L: the whole interposer is organic RDL, so its top layer takes the organic tint too.
  const rdlMatL = materials.standard(
    (p: Palette) => {
      const pc = partColors(p);
      return pc.organic.lerp(pc.siliconDeep, p.theme === 'dark' ? 0.5 : 0.2);
    },
    { roughness: 0.6, metalness: 0.02, transparent: true },
  );
  const rdl = new Mesh(unitBox, rdlMat);
  rdl.scale.set(INT.w - 0.06, INT.rdl, INT.d - 0.06);
  rdl.position.y = INT.h + INT.rdl / 2 - 0.002;
  intG.add(rdl);

  // TSVs (S) / through-interposer vias (L) on the C4 grid.
  const copperMat = materials.standard(C('copper'), { roughness: 0.3, metalness: 0.6 });
  const tsv = inst(track(new CylinderGeometry(0.022, 0.022, INT.h, 6, 1, true)), copperMat, c4Grid.pts.length);
  tsv.instanceMatrix.setUsage(DynamicDrawUsage);
  intG.add(tsv);

  // LSI bridges (CoWoS-L): under the die–die seam and every die–HBM edge.
  const lsiSpec: [number, number, number, number][] = [
    [0, -0.62, 0.62, 0.95],
    [0, 0.62, 0.62, 0.95],
  ];
  for (const [hx, hz] of HBM_XZ) lsiSpec.push([hx, Math.sign(hz) * 1.35, 0.92, 0.5]);
  const lsiMat = materials.standard(C('lsi'), { roughness: 0.3, metalness: 0.35 });
  const lsi = inst(unitBox, lsiMat, lsiSpec.length);
  lsiSpec.forEach(([x, z, w, d], i) => setMatrix(lsi, i, x, INT.h * 0.62, z, w, INT.h * 0.42, d));
  intG.add(lsi);
  const inBridge = (x: number, z: number) => lsiSpec.some(([bx, bz, w, d]) => Math.abs(x - bx) < w / 2 + 0.03 && Math.abs(z - bz) < d / 2 + 0.03);

  // RDL traces: GPU ⇄ HBM bundles and the die-to-die link, plus footprint outlines.
  const tracePts: [number, number, number, number][] = [];
  for (const [hx, hz] of HBM_XZ) {
    const s = Math.sign(hz);
    for (let k = 0; k < 9; k++) {
      const x = hx - 0.4 + k * 0.1;
      tracePts.push([x, s * 0.95, x, s * 1.7]);
    }
  }
  for (let k = 0; k < 14; k++) {
    const z = -0.97 + k * 0.149;
    tracePts.push([-0.42, z, 0.42, z]);
  }
  const traceMat = materials.basic(C('copper'));
  const traceMesh = inst(unitBox, traceMat, tracePts.length);
  tracePts.forEach(([x0, z0, x1, z1], i) => {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    setMatrix(traceMesh, i, (x0 + x1) / 2, INT.h + INT.rdl + 0.002, (z0 + z1) / 2, alongX ? Math.abs(x1 - x0) : 0.026, 0.004, alongX ? 0.026 : Math.abs(z1 - z0));
  });
  intG.add(traceMesh);

  const outlinePos: number[] = [];
  const rect = (cx: number, cz: number, w: number, d: number, y: number) => {
    const a: [number, number][] = [
      [cx - w / 2, cz - d / 2],
      [cx + w / 2, cz - d / 2],
      [cx + w / 2, cz + d / 2],
      [cx - w / 2, cz + d / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const p = a[i]!;
      const q = a[(i + 1) % 4]!;
      outlinePos.push(p[0], y, p[1], q[0], y, q[1]);
    }
  };
  const yTop = INT.h + INT.rdl + 0.003;
  rect(-DIE.x, 0, DIE.w, DIE.d, yTop);
  rect(DIE.x, 0, DIE.w, DIE.d, yTop);
  for (const [hx, hz] of HBM_XZ) rect(hx, hz, HBM.w, HBM.d, yTop);
  const outlineGeo = track(new BufferGeometry());
  outlineGeo.setAttribute('position', new Float32BufferAttribute(outlinePos, 3));
  const outlineMat = materials.line('fg', { transparent: true, opacity: 0.35 });
  const outlines = new LineSegments(outlineGeo, outlineMat);
  intG.add(outlines);

  /* ───── layer 3: micro-bumps ───── */
  const ubG = new Group();
  ubG.name = 'micro-bumps';
  ubG.position.y = Y_UB;
  const ubGrid = joinGrids([
    orderedGrid(-DIE.x - DIE.w / 2 + 0.1, -DIE.x + DIE.w / 2 - 0.1, -DIE.d / 2 + 0.1, DIE.d / 2 - 0.1, UB.pitch),
    orderedGrid(DIE.x - DIE.w / 2 + 0.1, DIE.x + DIE.w / 2 - 0.1, -DIE.d / 2 + 0.1, DIE.d / 2 - 0.1, UB.pitch),
    ...HBM_XZ.map(([hx, hz]) => orderedGrid(hx - HBM.w / 2 + 0.1, hx + HBM.w / 2 - 0.1, hz - 0.2, hz + 0.2, UB.pitch)),
  ]);
  const ubMat = materials.standard(C('solder'), { roughness: 0.34, metalness: 0.3, transparent: true });
  const ub = inst(track(new CylinderGeometry(UB.r, UB.r, UB.h, 6, 1)), ubMat, ubGrid.pts.length);
  placeGrid(ub, ubGrid, UB.h / 2);
  ubG.add(ub);
  const ubProxy = pickProxy(new Mesh(unitBox, track(new MeshBasicMaterial())));
  ubProxy.scale.set(INT.w - 0.3, UB.h * 2, INT.d - 0.5);
  ubProxy.position.y = UB.h / 2;
  ubG.add(ubProxy);

  /* ───── layer 4: logic dies + HBM stacks ───── */
  const dieG = new Group();
  dieG.name = 'dies';
  dieG.position.y = Y_DIE;
  const dieGeo = track(new RoundedBoxGeometry(DIE.w, DIE.h, DIE.d, 2, 0.035));
  const logicMat = materials.standard(C('logic'), { roughness: 0.54, metalness: 0.18, map: track(floorplanTexture()), transparent: true });
  const logic = new Group();
  logic.name = 'logic-dies';
  for (const sx of [-1, 1]) {
    const m = new Mesh(dieGeo, logicMat);
    m.position.set(sx * DIE.x, DIE.h / 2, 0);
    if (sx > 0) m.rotation.y = Math.PI; // die-to-die strip faces the seam on both dies
    logic.add(m);
  }
  dieG.add(logic);

  const hbmLayers = HBM.layers + 1;
  const hbmMat = ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.16, transparent: true }));
  const hbm = inst(unitBox, hbmMat, HBM_XZ.length * hbmLayers);
  hbm.instanceMatrix.setUsage(DynamicDrawUsage);
  dieG.add(hbm);
  // While the die layer is ghosted, one translucent block per stack stands in for the 13 layers
  // (stacked translucent layers would compound back to opaque).
  const hbmGhostMat = materials.standard(C('hbm'), { roughness: 0.55, metalness: 0.1, transparent: true, opacity: 0, depthWrite: false });
  const hbmGhost = inst(unitBox, hbmGhostMat, HBM_XZ.length);
  HBM_XZ.forEach(([hx, hz], i) => setMatrix(hbmGhost, i, hx, DIE.h / 2, hz, HBM.w, DIE.h, HBM.d));
  hbmGhost.computeBoundingSphere();
  hbmGhost.visible = false;
  dieG.add(hbmGhost);
  const dramH = (DIE.h - HBM.base) / HBM.layers;
  const hbmTsvMat = materials.standard(C('copper'), { roughness: 0.3, metalness: 0.6, transparent: true });
  const hbmTsv = inst(track(new CylinderGeometry(0.016, 0.016, 1, 6, 1, true)), hbmTsvMat, HBM_XZ.length * 10);
  hbmTsv.instanceMatrix.setUsage(DynamicDrawUsage);
  dieG.add(hbmTsv);
  const paintHbm = (p: Palette) => {
    const pc = partColors(p);
    const alt = pc.hbm.clone().lerp(p.bg, p.theme === 'dark' ? 0.3 : 0.2);
    for (let s = 0; s < HBM_XZ.length; s++)
      for (let k = 0; k < hbmLayers; k++) hbm.setColorAt(s * hbmLayers + k, k === 0 ? pc.hbmBase : k % 2 ? alt : pc.hbm);
    if (hbm.instanceColor) hbm.instanceColor.needsUpdate = true;
  };

  /* ───── reticle overlay (step 光罩極限) ───── */
  const retG = new Group();
  retG.position.y = DIE.h + 0.014;
  const retFillMat = materials.basic('highlight', { transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide });
  const retFill = new Mesh(track(new PlaneGeometry(DIE.w + 0.06, DIE.d + 0.06)), retFillMat);
  retFill.rotation.x = -Math.PI / 2;
  retFill.position.x = DIE.x;
  // The reticle field as a solid ribbon frame (a 1 px line is too faint to be "the solid frame").
  const retEdgeMat = materials.basic('highlight', { transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide });
  const retEdgeGeo = track(new BufferGeometry());
  {
    const t = 0.07;
    const ox = (DIE.w + 0.06) / 2 + t / 2;
    const oz = (DIE.d + 0.06) / 2 + t / 2;
    const ix = ox - t;
    const iz = oz - t;
    const outer: [number, number][] = [[-ox, -oz], [ox, -oz], [ox, oz], [-ox, oz]];
    const inner: [number, number][] = [[-ix, -iz], [ix, -iz], [ix, iz], [-ix, iz]];
    const pos: number[] = [];
    for (const [x, z] of [...outer, ...inner]) pos.push(DIE.x + x, 0.002, z);
    const idx: number[] = [];
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      idx.push(k, n, 4 + n, k, 4 + n, 4 + k);
    }
    retEdgeGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    retEdgeGeo.setIndex(idx);
  }
  const retEdge = new Mesh(retEdgeGeo, retEdgeMat);
  // Stitched exposure fields: drawn over the dies too (no depth test), so all four fields read.
  const tileMat = track(new LineDashedMaterial({ dashSize: 0.16, gapSize: 0.1, transparent: true, opacity: 0, toneMapped: false, depthTest: false }));
  materials.bind(tileMat, 'color', 'fg');
  const tileGeo = track(new BufferGeometry());
  {
    const fw = DIE.w;
    const fd = DIE.d;
    const seg: number[] = [];
    for (const x of [-fw, 0, fw]) seg.push(x, 0, -fd, x, 0, fd);
    for (const z of [-fd, 0, fd]) seg.push(-fw, 0, z, fw, 0, z);
    tileGeo.setAttribute('position', new Float32BufferAttribute(seg, 3));
  }
  const tiles = new LineSegments(tileGeo, tileMat);
  tiles.computeLineDistances();
  // The interposer outline, drawn on the interposer's top face.
  const intEdgeMat = materials.line('highlight', { transparent: true, opacity: 0 });
  const intEdgeGeo = track(new BufferGeometry());
  {
    const w = INT.w / 2;
    const d = INT.d / 2;
    intEdgeGeo.setAttribute(
      'position',
      new Float32BufferAttribute([-w, 0, -d, w, 0, -d, w, 0, -d, w, 0, d, w, 0, d, -w, 0, d, -w, 0, d, -w, 0, -d], 3),
    );
  }
  const intEdge = new LineSegments(intEdgeGeo, intEdgeMat);
  tiles.renderOrder = 19;
  for (const o of [retFill, retEdge]) o.renderOrder = 20;
  retG.add(retFill, tiles, retEdge);
  retG.visible = false;
  dieG.add(retG);
  const retIntG = new Group();
  retIntG.position.y = INT.h + INT.rdl + 0.006;
  retIntG.add(intEdge);
  retIntG.visible = false;
  intG.add(retIntG);

  /* ───── stack ───── */
  const stack = ctx.track(
    new ExplodedStack({
      layers: [
        { object: subG, label: 'ABF 載板' },
        { object: c4G, label: 'C4 凸塊' },
        { object: intG, label: '中介層' },
        { object: ubG, label: '微凸塊' },
        { object: dieG, label: '晶粒與 HBM' },
      ],
      gap: GAP,
      axis: 'y',
    }),
  );
  root.add(stack.group);

  /* ───── flows: data on the interposer, power through the stack ───── */
  const dataPaths: FlowPath[] = [];
  const yFlow = INT.h + INT.rdl + 0.035;
  for (const [hx, hz] of HBM_XZ) {
    const s = Math.sign(hz);
    for (const [lane, dir] of [[-0.25, 1], [-0.08, -1], [0.08, 1], [0.25, -1]] as const) {
      const a: [number, number, number] = [hx + lane, yFlow, s * 0.75];
      const b: [number, number, number] = [hx + lane, yFlow, s * 1.72];
      dataPaths.push({ points: dir > 0 ? [a, b] : [b, a] });
    }
  }
  for (const [z, dir] of [[-0.7, 1], [-0.25, -1], [0.25, 1], [0.7, -1]] as const) {
    const a: [number, number, number] = [-0.75, yFlow, z];
    const b: [number, number, number] = [0.75, yFlow, z];
    dataPaths.push({ points: dir > 0 ? [a, b] : [b, a], weight: 1.4 });
  }
  const DATA_MAX = 560;
  const data = ctx.track(
    new PathFlow({ paths: dataPaths, count: DATA_MAX, size: 0.07, sizeVariance: 0.25, speed: 0.42, speedVariance: 0.2, smooth: false, fadeEnds: 0.12, theme: ctx.theme, seed: 3 }),
  );
  intG.add(data.object);

  // Power columns: unit-height paths (y 0 → 1), stretched each frame from the substrate top to the die bottom.
  const powerXZ: [number, number][] = [];
  const quarter = c4Grid.pts.slice(0, c4Grid.quarter);
  const nearest = (x: number, z: number) => quarter.reduce((b, p) => (Math.hypot(p[0] - x, p[1] - z) < Math.hypot(b[0] - x, b[1] - z) ? p : b), quarter[0]!);
  for (const x of [-2.75, -1.7, -0.65, 0.65, 1.7, 2.75]) for (const z of [-0.8, 0.8]) powerXZ.push(nearest(x, z));
  const powerPaths: FlowPath[] = powerXZ.map(([x, z]) => ({ points: [[x, 0, z], [x, 1, z]] }));
  const POWER_MAX = 240;
  const power = ctx.track(
    new PathFlow({ paths: powerPaths, count: POWER_MAX, size: 0.09, sizeVariance: 0.2, speed: 0.5, speedVariance: 0.15, smooth: false, fadeEnds: 0.1, theme: ctx.theme, seed: 5 }),
  );
  const powerG = new Group();
  powerG.add(power.object);
  root.add(powerG);

  /* ───── labels ───── */
  const leaderPos = new Float32Array(5 * 6);
  const leaderGeo = track(new BufferGeometry());
  leaderGeo.setAttribute('position', new BufferAttribute(leaderPos, 3));
  const leaderMat = materials.line('fg', { transparent: true, opacity: 0 });
  const leaders = new LineSegments(leaderGeo, leaderMat);
  leaders.frustumCulled = false;
  root.add(leaders);
  const EDGE_X = [SUB.w / 2, INT.w / 2 - 0.16, INT.w / 2, DIE.x + DIE.w / 2 - 0.1, DIE.x + DIE.w / 2];
  const EDGE_Z = [SUB.d / 2, INT.d / 2 - 0.16, INT.d / 2, HBM.z + 0.2, HBM.z + HBM.d / 2];
  const LAYER_MID = [SUB.h / 2, C4.h / 2, INT.h / 2, UB.h / 2, DIE.h / 2];
  const LAYER_HOT = ['substrate', 'c4-bumps', 'interposer', 'micro-bumps', 'logic-die'];
  const layerText = (i: number) =>
    [
      'ABF 載板＋BGA 錫球',
      'C4 凸塊',
      mode === 'S' ? '矽中介層（TSV＋細線路）' : 'RDL 中介層＋LSI 矽橋',
      '微凸塊（µbump）',
      'GPU 晶粒＋HBM 堆疊',
    ][i]!;
  let mode: Mode = 'S';
  const layerLabels: LabelHandle[] = stack.layers.map((l, i) =>
    labels.add({
      text: layerText(i),
      object: l.object,
      position: [LABEL_X, LAYER_MID[i]!, 0],
      align: 'right',
      offset: [2, 0],
      priority: 22 - i * 0.1,
      hotspot: LAYER_HOT[i]!,
      visible: false,
    }),
  );
  const objLabels = {
    gpu: labels.add({ text: 'GPU 邏輯晶粒 ×2', object: dieG, position: [-DIE.x, DIE.h + 0.04, -0.2], align: 'above', priority: 26, hotspot: 'logic-die', kind: 'strong' }),
    hbm: labels.add({ text: 'HBM ×8', object: dieG, position: [HBM_XZ[3]![0], DIE.h + 0.04, HBM_XZ[3]![1]], align: 'above', priority: 25, hotspot: 'hbm-stack', kind: 'strong' }),
    inter: labels.add({ text: '中介層', object: intG, position: [-INT.w / 2 + 0.9, INT.h / 2, INT.d / 2], align: 'below', offset: [0, 4], priority: 18, hotspot: 'interposer' }),
    sub: labels.add({ text: 'ABF 載板', object: subG, position: [-SUB.w / 2 + 1.4, SUB.h / 2, SUB.d / 2], align: 'below', offset: [0, 6], priority: 17, hotspot: 'substrate' }),
  };
  const stepLabels = {
    field: labels.add({ text: '1 個曝光場 ≈ 1 顆晶粒（約 26 × 33 mm）', object: dieG, position: [DIE.x, DIE.h + 0.02, -DIE.d / 2 - 0.05], align: 'above', priority: 40, hotspot: 'reticle-limit', visible: false, kind: 'strong' }),
    tiles: labels.add({ text: '中介層 ≈ 4 個曝光場拼接（示意）', object: intG, position: [-DIE.x, INT.h, INT.d / 2], align: 'below', offset: [0, 6], priority: 39, hotspot: 'reticle-limit', visible: false }),
    wires: labels.add({ text: '細線路：GPU ⇄ HBM（青＝資料）', object: intG, position: [HBM_XZ[7]![0], yTop, 1.25], align: 'right', offset: [18, 8], priority: 30, hotspot: 'interposer', visible: false }),
    tsv: labels.add({ text: 'TSV 矽穿孔（琥珀＝電力）', object: intG, position: [INT.w / 2 - 0.3, INT.h / 2, INT.d / 2 - 0.2], align: 'below', offset: [0, 10], priority: 29, hotspot: 'tsv', visible: false }),
    lsi: labels.add({ text: 'LSI 局部矽橋', object: intG, position: [HBM_XZ[7]![0], INT.h, 1.35], align: 'right', offset: [16, 6], priority: 31, hotspot: 'lsi-bridge', visible: false, kind: 'strong' }),
    tiv: labels.add({ text: 'TIV 銅柱（取代 TSV）', object: intG, position: [INT.w / 2 - 0.3, INT.h / 2, INT.d / 2 - 0.2], align: 'below', offset: [0, 10], priority: 28, hotspot: 'tsv', visible: false }),
    base: labels.add({ text: '基底晶粒（邏輯）', object: dieG, position: [HBM_XZ[FOCUS_HBM]![0] + HBM.w / 2, HBM.base / 2, HBM_XZ[FOCUS_HBM]![1]], align: 'right', offset: [8, 6], priority: 34, hotspot: 'hbm-stack', visible: false }),
    dram: labels.add({ text: 'DRAM 晶粒 ×12（示意）', object: dieG, position: [HBM_XZ[FOCUS_HBM]![0] + HBM.w / 2, 0.5, HBM_XZ[FOCUS_HBM]![1]], align: 'right', offset: [8, 0], priority: 35, hotspot: 'hbm-stack', visible: false, kind: 'strong' }),
    hbmTsv: labels.add({ text: 'TSV＋微凸塊垂直串接', object: dieG, position: [HBM_XZ[FOCUS_HBM]![0] - HBM.w / 2, 0.62, HBM_XZ[FOCUS_HBM]![1]], align: 'left', offset: [-8, 0], priority: 33, hotspot: 'tsv', visible: false }),
  };
  labels.setMax(18);
  let portrait = ctx.size.portrait;
  const [fhx, fhz] = HBM_XZ[FOCUS_HBM]!;
  /** Anchors that depend on the stage orientation (labels sit on the side that faces screen-right). */
  const placeOriented = () => {
    // Portrait: the label sits on top of its leader's end (half the width beside the stack).
    layerLabels.forEach((h, i) =>
      h.set(portrait ? { position: [0, LAYER_MID[i]!, -LABEL_Z], align: 'above', offset: [-4, -3] } : { position: [LABEL_X, LAYER_MID[i]!, 0], align: 'right', offset: [2, 0] }),
    );
    objLabels.inter.set({ position: portrait ? [INT.w / 2, INT.h / 2, INT.d / 2 - 0.9] : [-INT.w / 2 + 0.9, INT.h / 2, INT.d / 2] });
    objLabels.sub.set({ position: portrait ? [SUB.w / 2, SUB.h / 2, SUB.d / 2 - 1.4] : [-SUB.w / 2 + 1.4, SUB.h / 2, SUB.d / 2] });
    // Reticle step. Portrait turns −X up the screen: anchors beside a die edge would push these long
    // labels off a narrow stage, so they sit under the near die and over the far end of the interposer.
    stepLabels.field.set(
      portrait
        ? { position: [DIE.x + DIE.w / 2 + 0.05, DIE.h + 0.02, 0], align: 'below', offset: [0, 4] }
        : { position: [DIE.x, DIE.h + 0.02, -DIE.d / 2 - 0.05], align: 'above', offset: [0, 0] },
    );
    stepLabels.tiles.set(
      portrait
        ? { position: [-INT.w / 2, INT.h, 0], align: 'above', offset: [0, -4] }
        : { position: [-DIE.x, INT.h, INT.d / 2], align: 'below', offset: [0, 6] },
    );
  };
  /** HBM-step labels on the ±X sides of the focus stack (the step is frontal in both orientations). */
  const hbmSide = (right: boolean, y: number): [number, number, number] => [fhx + (right ? HBM.w / 2 : -HBM.w / 2), y, fhz];

  /* ───── state ───── */
  let explode = OVERVIEW.explode;
  let hbmE = 0;
  let reticle = 0;
  let flowBoost = OVERVIEW.flows ?? 0.7;
  let xray = 0;
  let leadK = 1;
  let ghost = 0;
  const DIMMED = [ringMat, capMat, c4Mat, ubMat];
  let stepId = 'overview';

  const placeTsv = () => {
    c4Grid.pts.forEach(([x, z], i) => {
      const s = mode === 'L' && inBridge(x, z) ? 0 : 1;
      setMatrix(tsv, i, x, INT.h / 2, z, s, s, s);
    });
    // Drawn on the double-pitch subset at every tier: enough to read as vias, not a forest (示意).
    tsv.count = c4Grid.quarter;
    tsv.instanceMatrix.needsUpdate = true;
    tsv.computeBoundingSphere();
  };

  const placeHbm = () => {
    let rod = 0;
    HBM_XZ.forEach(([hx, hz], s) => {
      const g = s === FOCUS_HBM ? hbmE * HBM_GAP : 0;
      const lift = s === FOCUS_HBM ? hbmE * HBM_LIFT : 0;
      let y = lift;
      for (let k = 0; k < hbmLayers; k++) {
        const h = k === 0 ? HBM.base : dramH;
        const yy = y + k * g;
        setMatrix(hbm, s * hbmLayers + k, hx, yy + h / 2, hz, HBM.w - (k === 0 ? 0 : 0.04), h * (k === 0 ? 1 : 0.92), HBM.d - (k === 0 ? 0 : 0.04));
        y += h;
      }
      const topBottom = HBM.base + dramH * (HBM.layers - 1) + (HBM.layers - 1) * g;
      for (let r = 0; r < 10; r++) {
        const x = hx - 0.32 + (r % 5) * 0.16;
        const z = hz + (r < 5 ? -0.07 : 0.07);
        setMatrix(hbmTsv, rod++, x, lift + topBottom / 2 + 0.003, z, 1, topBottom - 0.006, 1);
      }
    });
    hbm.instanceMatrix.needsUpdate = true;
    hbmTsv.instanceMatrix.needsUpdate = true;
    hbm.computeBoundingSphere();
    hbmTsv.computeBoundingSphere();
  };

  const tierCounts = () => {
    bga.count = tierCount(bgaGrid, ctx.tier);
    c4.count = tierCount(c4Grid, ctx.tier);
    ub.count = tierCount(ubGrid, ctx.tier);
    placeTsv();
    data.setCount(scaleCount(DATA_MAX, ctx.tier, 80));
    power.setCount(scaleCount(POWER_MAX, ctx.tier, 24));
  };

  const applyExplode = () => {
    stack.set(explode);
    // Leader lines from each layer's edge to the label column (+X in landscape, −Z in portrait).
    stack.layers.forEach((l, i) => {
      const y = l.object.position.y + LAYER_MID[i]!;
      if (portrait) leaderPos.set([0, y, -EDGE_Z[i]! - 0.04, 0, y, -LABEL_Z + 0.05], i * 6);
      else leaderPos.set([EDGE_X[i]! + 0.04, y, 0, LABEL_X - 0.05, y, 0], i * 6);
    });
    leaderGeo.getAttribute('position').needsUpdate = true;
    const lab = smooth(0.38, 0.62, explode) * leadK;
    leaderMat.opacity = lab * (ctx.theme === 'dark' ? 0.45 : 0.5);
    leaders.visible = lab > 0.01;
    layerLabels.forEach((h) => h.set({ visible: lab > 0.5 }));
    const bare = explode < 0.5 && reticle < 0.5;
    objLabels.inter.set({ visible: bare });
    objLabels.sub.set({ visible: bare });
    // Power columns span substrate top → die bottom.
    const y0 = subG.position.y + SUB.h;
    const y1 = dieG.position.y;
    powerG.position.y = y0;
    powerG.scale.y = Math.max(0.01, y1 - y0);
    powerG.updateMatrixWorld(true);
    const pv = smooth(0.15, 0.5, explode);
    power.object.visible = pv > 0.01;
    power.setOpacity(pv * (ctx.theme === 'dark' ? 0.95 : 0.9));
    data.setOpacity(flowBoost * (ctx.theme === 'dark' ? 1 : 0.92));
    const dark = ctx.theme === 'dark';
    siMat.opacity = (dark ? 0.82 : 0.86) + ((dark ? 0.4 : 0.42) - (dark ? 0.82 : 0.86)) * xray;
    orgMat.opacity = (dark ? 0.62 : 0.68) + (0.42 - (dark ? 0.62 : 0.68)) * xray;
    rdlMat.opacity = 1 - 0.62 * xray;
    rdlMatL.opacity = 1 - (dark ? 0.66 : 0.55) * xray;
    // Ghosted die layer: translucent, no depth writes, so the interposer reads through it. Light
    // backgrounds show a tint more strongly, so the ghosts are fainter there.
    const g = 1 - (dark ? 0.86 : 0.9) * ghost;
    logicMat.opacity = g;
    hbmMat.opacity = hbmTsvMat.opacity = 1 - smooth(0, 0.6, ghost);
    hbm.visible = hbmTsv.visible = ghost < 0.6;
    hbmGhostMat.opacity = smooth(0.3, 1, ghost) * (dark ? 0.16 : 0.11);
    hbmGhost.visible = ghost > 0.3;
    subMat.opacity = 1 - smooth(0, 0.6, ghost);
    subMesh.visible = bga.visible = ghost < 0.6;
    bgaMat.opacity = subMat.opacity;
    subGhostMat.opacity = smooth(0.3, 1, ghost) * (dark ? 0.16 : 0.12);
    subGhost.visible = ghost > 0.3;
    applyObjLabels();
    // Context layers above and below the interposer dim too (step focus).
    const dim = 1 - (dark ? 0.88 : 0.86) * ghost;
    for (const m of DIMMED) m.opacity = dim;
    const solid = ghost < 0.02;
    if (logicMat.depthWrite !== solid) for (const m of [logicMat, hbmMat, hbmTsvMat, subMat, bgaMat, ...DIMMED]) m.depthWrite = solid;
    panel.setValue(explode);
    ctx.invalidate();
  };

  const applyReticle = () => {
    retG.visible = retIntG.visible = reticle > 0.01;
    retFillMat.opacity = reticle * (ctx.theme === 'dark' ? 0.13 : 0.14);
    retEdgeMat.opacity = reticle;
    tileMat.opacity = reticle * 0.8;
    intEdgeMat.opacity = reticle * 0.75;
    stepLabels.field.set({ visible: reticle > 0.5 });
    stepLabels.tiles.set({ visible: reticle > 0.5 });
    applyObjLabels();
    ctx.invalidate();
  };

  /** GPU / HBM name tags: hidden while the reticle overlay or the ghosted (interposer) view is up. */
  const applyObjLabels = () => {
    const on = reticle < 0.5 && ghost < 0.5;
    objLabels.gpu.set({ visible: on });
    objLabels.hbm.set({ visible: on });
  };

  const applyMode = () => {
    siSlab.visible = mode === 'S';
    orgSlab.visible = mode === 'L';
    lsi.visible = mode === 'L';
    rdl.material = mode === 'S' ? rdlMat : rdlMatL;
    placeTsv();
    layerLabels[2]!.set({ text: layerText(2) });
    const deep = stepId === 'interposer' || stepId === 'cowos-l';
    stepLabels.tsv.set({ visible: deep && mode === 'S' });
    stepLabels.tiv.set({ visible: deep && mode === 'L' });
    stepLabels.lsi.set({ visible: mode === 'L' && (deep || explode > 0.5) });
    stepLabels.wires.set({ visible: deep });
    panel.setToggle(mode);
    ctx.invalidate();
  };

  const applyHbmLabels = () => {
    const on = hbmE > 0.5;
    stepLabels.base.set({ visible: on });
    stepLabels.dram.set({ visible: on });
    stepLabels.hbmTsv.set({ visible: on });
    const lift = hbmE * HBM_LIFT;
    const mid = lift + HBM.base + (dramH * HBM.layers) / 2 + 6.5 * hbmE * HBM_GAP;
    stepLabels.base.set({ position: hbmSide(true, lift + HBM.base / 2) });
    // Portrait: beside the stack there is no room for this label, so it sits over the top die.
    const top = lift + HBM.base + dramH * HBM.layers + (HBM.layers - 1) * hbmE * HBM_GAP;
    stepLabels.dram.set(
      portrait ? { position: [fhx, top, fhz], align: 'above', offset: [0, -2] } : { position: hbmSide(true, mid), align: 'right', offset: [8, 0] },
    );
    stepLabels.hbmTsv.set({ position: hbmSide(false, mid) });
  };

  /* ───── tweens ───── */
  let explodeTween: { cancel(): void } | null = null;
  const tweenNum = (from: number, to: number, set: (x: number) => void, duration = 900) =>
    ctx.tween.run((k) => set(from + (to - from) * k), { duration, ease: 'cubicInOut' });
  const animateExplode = (to: number) => {
    explodeTween?.cancel();
    const from = explode;
    explodeTween = tweenNum(from, to, (x) => {
      explode = x;
      applyExplode();
    });
  };
  let hbmTween: { cancel(): void } | null = null;
  const animateHbm = (to: number) => {
    hbmTween?.cancel();
    const from = hbmE;
    hbmTween = tweenNum(from, to, (x) => {
      hbmE = x;
      placeHbm();
      applyHbmLabels();
      ctx.invalidate();
    }, 800);
  };
  let retTween: { cancel(): void } | null = null;
  const animateReticle = (to: number) => {
    retTween?.cancel();
    const from = reticle;
    retTween = ctx.tween.run((k) => {
      reticle = from + (to - from) * k;
      applyReticle();
    }, { duration: 450, fade: true });
  };
  let flowTween: { cancel(): void } | null = null;
  const animateLook = (flows: number, see: number, lead: number, ghostTo: number) => {
    flowTween?.cancel();
    const f0 = flowBoost;
    const x0 = xray;
    const l0 = leadK;
    const g0 = ghost;
    flowTween = ctx.tween.run((k) => {
      flowBoost = f0 + (flows - f0) * k;
      xray = x0 + (see - x0) * k;
      leadK = l0 + (lead - l0) * k;
      ghost = g0 + (ghostTo - g0) * k;
      applyExplode();
    }, { duration: 600, fade: true });
  };

  const setMode = (m: Mode) => {
    if (m === mode) return;
    mode = m;
    applyMode();
    ctx.announce(m === 'S' ? '已切換為 CoWoS-S：整片矽中介層' : '已切換為 CoWoS-L：RDL 中介層加局部矽橋');
  };

  /* ───── panel ───── */
  const panel = createPanel({
    stage: ctx.stage,
    signal: ctx.signal,
    label: '拆解',
    aria: '封裝拆解程度',
    valueText: (x) => (x < 0.05 ? '組合' : x > 0.95 ? '完全拆解' : `拆解 ${Math.round(x * 100)}%`),
    value: explode,
    onInput: (x) => {
      explodeTween?.cancel();
      explode = x;
      applyExplode();
      if (stepId !== 'reticle-limit' && reticle > 0) animateReticle(0);
    },
    toggle: {
      aria: '中介層類型',
      options: [
        { id: 'S', label: 'CoWoS-S' },
        { id: 'L', label: 'CoWoS-L' },
      ],
      value: mode,
      onChange: (id) => setMode(id === 'L' ? 'L' : 'S'),
    },
  });

  /* ───── palette ───── */
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    dampRim(lights);
    floor.apply(p);
    paintSubstrate(p);
    paintHbm(p);
    data.recolor(() => p.flow);
    data.setTheme(p.theme);
    data.setSize(dark ? 0.075 : 0.06);
    power.recolor(() => p.power);
    power.setTheme(p.theme);
    power.setSize(dark ? 0.085 : 0.08);
    outlineMat.opacity = dark ? 0.3 : 0.4;
    lsiMat.emissive.copy(p.optic).multiplyScalar(dark ? 0.25 : 0.06);
    // Unlit traces: muted toward the interposer so the cyan data flow on them stays the subject.
    const pc = partColors(p);
    traceMat.color.copy(pc.copper).lerp(pc.siliconDeep, dark ? 0.22 : 0.12);
    heat.apply();
    for (const h of [objLabels.gpu]) h.set({ swatch: p.css['seg-ai-accelerators'] ?? '' });
    objLabels.hbm.set({ swatch: p.css['seg-memory-storage'] ?? '' });
    applyExplode();
    applyReticle();
  };

  /* ───── hotspots ───── */
  const cardFor = (id: string): CardContent | null => {
    const c = CARDS[id];
    if (!c) return null;
    const body = id === 'interposer' ? (mode === 'S' ? c.bodyS ?? c.body : c.bodyL ?? c.body) : c.body;
    const out: CardContent = { title: c.title, body };
    if (c.subtitle) out.subtitle = c.subtitle;
    if (c.items) out.items = c.items;
    if (c.href) out.href = c.href;
    if (c.linkLabel) out.linkLabel = c.linkLabel;
    if (c.swatch) out.swatch = ctx.palette.css[c.swatch] ?? '';
    return out;
  };
  const hbmFocus = HBM_XZ[FOCUS_HBM]!;
  const reg = (id: string, spec: Parameters<typeof hotspots.register>[1]) => hotspots.register(id, { card: () => cardFor(id), ...spec });

  heat.add('logic-die', [logicMat]);
  heat.add('hbm-stack', [hbmMat, hbmGhostMat]);
  heat.add('micro-bumps', [ubMat]);
  heat.add('interposer', [siMat, orgMat, rdlMat, rdlMatL]);
  heat.add('tsv', [copperMat, hbmTsvMat]);
  heat.add('lsi-bridge', [lsiMat]);
  heat.add('c4-bumps', [c4Mat]);
  heat.add('substrate', [subMat, bgaMat, subGhostMat]);

  reg('logic-die', { object: logic, onHighlight: (on) => heat.set('logic-die', on), pose: { position: [3.4, 6.6, 7.8], target: [0, 1.6, 0] } });
  reg('hbm-stack', { object: hbm, onHighlight: (on) => heat.set('hbm-stack', on), pose: { position: [5.6, 4.6, 7.4], target: [hbmFocus[0], 2.2, hbmFocus[1]] } });
  ctx.picker.add(hbmGhost, { id: 'hbm-stack' }); // the ghost blocks stand in for the stacks while ghosted
  reg('micro-bumps', { object: ubProxy, onHighlight: (on) => heat.set('micro-bumps', on), pose: POSE_LAYERS });
  reg('interposer', { object: slabs, onHighlight: (on) => heat.set('interposer', on), pose: POSE_INTERPOSER });
  reg('tsv', { object: tsv, anchor: intG, onHighlight: (on) => heat.set('tsv', on), pose: POSE_INTERPOSER });
  reg('lsi-bridge', {
    object: lsi,
    onHighlight: (on) => heat.set('lsi-bridge', on),
    onSelect: () => {
      if (mode !== 'L') setMode('L');
      if (explode < 0.6) animateExplode(0.82);
    },
    pose: POSE_INTERPOSER,
  });
  reg('c4-bumps', { object: c4Proxy, onHighlight: (on) => heat.set('c4-bumps', on), pose: POSE_LAYERS });
  reg('substrate', { object: subMesh, onHighlight: (on) => heat.set('substrate', on), pose: POSE_LAYERS });
  ctx.picker.add(subGhost, { id: 'substrate' });
  reg('reticle-limit', {
    anchor: new Vector3(DIE.x, Y_DIE + DIE.h, 0),
    onHighlight: (on) => {
      if (stepId !== 'reticle-limit') animateReticle(on ? 1 : 0);
    },
    pose: POSE_RETICLE,
  });
  reg('hybrid-bonding', {
    onSelect: () => {
      switchVariant(ctx, 'soic', 'hybrid-bonding');
      return true;
    },
  });

  /* ───── steps ───── */
  // Camera tweens do not cancel each other: keep ours so a newer move (or a resize) replaces it.
  let camTween: { cancel(): void } | null = null;
  const moveCamera = (pose: CameraPose, opts?: { duration: number }) => {
    camTween?.cancel();
    camTween = ctx.setPose(pose, opts);
  };
  const poseFor = (s: StepSpec): CameraPose => (s.pose ? (portrait ? (s.portrait ?? turn(s.pose)) : s.pose) : ctx.homePose);
  const showStep = (id: string) => {
    stepId = id;
    const s = STEPS[id] ?? OVERVIEW;
    if (s.mode) {
      mode = s.mode;
    }
    applyMode();
    animateExplode(s.explode);
    animateHbm(s.hbm ?? 0);
    animateReticle(s.reticle ? 1 : 0);
    animateLook(s.flows ?? 0.7, s.xray ?? 0, s.leaders === false ? 0 : 1, s.ghost ?? 0);
    moveCamera(poseFor(s));
  };

  /* ───── initial state ───── */
  placeOriented();
  applyMode();
  placeHbm();
  tierCounts();
  applyPalette(ctx.palette);
  data.setReduced(!ctx.animate);
  power.setReduced(!ctx.animate);

  const pending = takePending();
  let pendingTimer = 0;

  return {
    update(_dt, t) {
      data.update(t);
      power.update(t);
    },
    setStep(_i, step) {
      showStep(step?.id ?? 'overview');
      if (pending && !pendingTimer)
        pendingTimer = window.setTimeout(() => {
          hotspots.focus(pending, 'command');
          hotspots.select(pending, 'command');
        }, 0);
    },
    onMotion(animate) {
      data.setReduced(!animate);
      power.setReduced(!animate);
    },
    onQuality() {
      tierCounts();
      ctx.invalidate();
    },
    onPalette(p) {
      applyPalette(p);
    },
    onResize(size) {
      if (size.portrait === portrait) return;
      portrait = size.portrait;
      placeOriented();
      applyExplode();
      applyHbmLabels();
      // Re-frame the current step for the new orientation (this also stops a camera move still
      // heading for the old orientation's pose, which would otherwise override the host's reset).
      moveCamera(poseFor(STEPS[stepId] ?? OVERVIEW), { duration: 0 });
    },
    dispose() {
      clearTimeout(pendingTimer);
      for (const t of [explodeTween, hbmTween, retTween, flowTween, camTween]) t?.cancel();
      heat.dispose();
      panel.remove();
      root.removeFromParent();
    },
  };
}

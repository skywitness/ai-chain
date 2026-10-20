/**
 * euv-litho — EUV 微影光路 (variants: euv, high-na).
 *
 * A cut-away "technical diorama" of an EUV scanner inside its vacuum chamber, laid out in the
 * order the light travels (optics.ts): tin droplets + CO₂ pre-pulse / main pulse → 13.5 nm plasma
 * → collector → intermediate focus → field / pupil facet mirrors → fold mirror → reflective
 * reticle on the reticle stage → 6-mirror projection optics → wafer on the wafer stage.
 * Light is drawn as translucent beam tubes between mirror footprints with crisp marginal rays, and
 * light pulses (PathFlow, 'once' mode) leave the plasma in sync with each droplet hit. The reticle
 * and wafer stages scan in sync at the reduction ratio (4×, High-NA 8×; directions are 示意).
 *
 *  - euv:     NA 0.33 unobscured projection, full exposure field.
 *  - high-na: NA 0.55 anamorphic projection (bigger mirrors, M5/M6 with central holes), half
 *             fields, and a comparison plinth in front: NA 0.33 vs 0.55 light cones, line widths
 *             and field sizes (示意). The plinth shows in the overview and steps 5–6 only.
 * Steps: 總覽 → 光源 → 反射鏡 (Mo/Si multilayer inset) → 光罩 → 投影 → 解析度 (Rayleigh card) →
 * 變形光學 (the last two switch to high-na). Reduced motion: droplets, pulses and stages freeze
 * in a representative static state (dotted static rays); every step shows its final state.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferAttribute,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type SceneContext,
  type Vec3Like,
} from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import {
  AXIS,
  CATCHER,
  COLLECTOR,
  DROP_DIR,
  GENERATOR,
  IF_POS,
  LASER_BOX,
  LASER_EXIT,
  NA,
  PLASMA,
  RETICLE,
  RETICLE_SIZE,
  SCAN_MAG,
  TURN,
  WAFER,
  WAFER_R,
  buildBeams,
  buildTrain,
  rayPath,
  type BeamSegment,
  type OpticEl,
  type Variant,
} from './optics';
import {
  COUPON,
  box,
  boxEdges,
  collectorGeometry,
  couponTexture,
  floorGrid,
  mergeStatic,
  mirrorFace,
  mirrorSubstrate,
  orientFace,
  placeY,
  reticleTexture,
  rod,
  waferTexture,
} from './parts';
import { InfoPanel, type PanelContent } from './panel';

/* ───────────────────────── camera ───────────────────────── */

const D2R = Math.PI / 180;
function orbit(target: readonly [number, number, number], az: number, el: number, dist: number): CameraPose {
  const [x, y, z] = target;
  return {
    position: [x + dist * Math.sin(az * D2R) * Math.cos(el * D2R), y + dist * Math.sin(el * D2R), z + dist * Math.cos(az * D2R) * Math.cos(el * D2R)],
    target: [x, y, z],
  };
}

const HOME: Record<Variant, CameraPose> = {
  euv: orbit([-0.65, 0.15, 0], 20, 12, 14.0),
  'high-na': orbit([-0.65, 0.1, 0.6], 18, 15, 14.4),
};
/* Portrait (4:5) poses: the whole tool, from the CO₂ laser to the vacuum pump, fits the width;
   High-NA looks down a little more to show the comparison plinth. */
const PORTRAIT: Record<Variant, CameraPose> = {
  euv: { ...orbit([-0.75, 0.2, 0.1], 26, 26, 15.9), fov: 44 },
  'high-na': { ...orbit([-0.7, 0.0, 0.5], 24, 28, 16.5), fov: 44 },
};
const CLAMPS = { fov: 34, minDistance: 2.4, maxDistance: 30, minPolar: 0.25, maxPolar: 1.8, minAzimuth: -1.35, maxAzimuth: 1.35 };

/** Step poses (landscape; the host rescales them on portrait stages). null = home. */
const STEP_POSES: readonly (CameraPose | null)[] = [
  null,
  orbit([-3.65, 0.05, 0], 22, 9, 8.1), // 光源: droplets, laser, plasma, collector, IF
  orbit([-1.0, 0.75, 0], 16, 9, 12.6), // 反射鏡: every multilayer mirror + the Mo/Si inset
  orbit([0.85, 2.4, 0], 26, -11, 6.0), // 光罩 (from below: the pattern faces down)
  orbit([1.85, 0.5, 0], 18, 8, 10.8), // 投影
  orbit([-1.4, -1.75, 1.75], 10, 20, 6.6), // 解析度
  orbit([-1.25, -2.0, 2.15], 6, 27, 4.9), // 變形光學
];
/** Step poses for portrait stages (fov 44 at 4:5). null = the portrait home pose. */
const PORTRAIT_STEPS: readonly (CameraPose | null)[] = [
  null,
  orbit([-4.3, -0.5, 0.1], 22, 12, 9.8), // 光源
  null, // 反射鏡: the whole tool
  orbit([0.95, 2.68, 0], 26, -11, 6.7), // 光罩
  orbit([2.25, 0.45, 0], 18, 10, 11.2), // 投影
  orbit([-1.25, -1.5, 2.0], 8, 34, 7.2), // 解析度 (the Rayleigh card sits above)
  orbit([-1.25, -1.6, 2.15], 6, 34, 7.2), // 變形光學
];
/**
 * Phone-width landscape stages (4:3, width < 560 px): the step card covers the top third, so the
 * comparison plinth is framed lower (target raised) and a little wider. Other steps: STEP_POSES.
 */
const COMPACT_STEPS: Readonly<Record<number, CameraPose>> = {
  5: orbit([-1.4, -1.34, 1.75], 10, 20, 5.8), // 解析度
  6: orbit([-1.25, -1.08, 2.15], 6, 27, 5.0), // 變形光學
};

/* ───────────────────────── timing ───────────────────────── */

const T_PULSE = 1.4; // seconds between droplet hits (real sources: tens of thousands per second)
const TRAVEL = 7.5; // seconds for a light pulse from plasma to wafer (示意)
const T_ARRIVE = 0.62 * T_PULSE; // droplet reaches the focus, pre-pulse
const DROP_SPACING = 0.32;
const DROP_SPEED = DROP_SPACING / T_PULSE;
const DROP_PATH = GENERATOR.distanceTo(PLASMA);
const N_DROPS = 5;
const SCAN_PERIOD = 7;
const SCAN_AMP = 0.26;
const RAYS = [-1, -0.5, 0.5, 1];
const TAIL = 3;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: Color, b: Color, k: number) => a.clone().lerp(b, k);
const isDark = (p: Palette) => p.theme === 'dark';

/* Palette-derived tones (no hex colours in scenes). */
const TONE = {
  structure: (p: Palette) => mix(p.bg, p.fg, isDark(p) ? 0.2 : 0.1),
  frame: (p: Palette) => mix(p.bg, p.fg, isDark(p) ? 0.34 : 0.3),
  substrate: (p: Palette) => mix(p.bg, p.fg, isDark(p) ? 0.4 : 0.36),
  coating: (p: Palette) => (isDark(p) ? mix(p.optic, p.fg, 0.42) : mix(p.optic, p.bg, 0.62)),
  tin: (p: Palette) => mix(p.fg, p.bg, isDark(p) ? 0.15 : 0.35),
  wafer: (p: Palette) => (isDark(p) ? mix(p.bg, p.fg, 0.5).lerp(p.optic, 0.18) : mix(p.fg, p.bg, 0.4).lerp(p.optic, 0.14)),
  reticle: (p: Palette) => (isDark(p) ? mix(p.bg, p.fg, 0.78) : mix(p.fg, p.bg, 0.86)),
  coupon: (p: Palette) => (isDark(p) ? mix(p.bg, p.fg, 0.8) : mix(p.fg, p.bg, 0.9)),
  accent: (p: Palette) => p.seg['semi-equipment-materials'].clone(),
};

/* Which beam segments a step emphasises (by the id of the element a segment starts at). */
const STEP_SEGMENTS: readonly (readonly string[] | null)[] = [
  null,
  ['plasma', 'collector'],
  null,
  ['fold', 'reticle'],
  ['reticle', 'm1', 'm2', 'm3', 'm4', 'image', 'm5', 'm6'],
  ['image', 'm5', 'm6'],
  ['image', 'm5', 'm6'],
];

const CHAMBER = { min: new Vector3(-5.3, -2.62, -1.25), max: new Vector3(3.85, 3.75, 1.25) };
/** Glass housing around the projection optics. */
const HOUSING: Record<Variant, { min: Vector3; max: Vector3 }> = {
  euv: { min: new Vector3(0.28, -1.5, -0.78), max: new Vector3(3.45, 2.5, 0.78) },
  'high-na': { min: new Vector3(0.48, -1.82, -1.42), max: new Vector3(3.55, 2.72, 1.42) },
};
const FLOOR_Y = -2.62;
const INSET = { y: -2.48, z: 2.15, xa: -2.1, xb: -0.4, h: 1.05 };
const ML = new Vector3(-4.15, 2.3, 0.3); // multilayer inset centre (empty upper-left of the chamber)
const ML_W = 1.2; // inset width (x)

/* ───────────────────────── scene ───────────────────────── */

export default defineScene({
  json,
  meta: {
    camera: { ...HOME.euv, ...CLAMPS, portrait: PORTRAIT.euv },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 64, tris: 48_000 },
    variants: {
      'high-na': { camera: { ...HOME['high-na'], ...CLAMPS, portrait: PORTRAIT['high-na'] } },
    },
  },

  create(ctx: SceneContext) {
    const { scene, materials, labels, hotspots, tween } = ctx;
    const root = new Group();
    root.name = 'euv-litho';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const variantOf = (v: string): Variant => (v === 'high-na' ? 'high-na' : 'euv');
    let variant = variantOf(ctx.variant);
    let step = ctx.step;
    const add = <T extends Object3D>(o: T, parent: Object3D = root): T => {
      parent.add(o);
      return o;
    };
    const statik = (o: Object3D) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
      return o;
    };

    /* ───────── materials ───────── */
    const hlMat = (ref: (p: Palette) => Color, params: ConstructorParameters<typeof MeshStandardMaterial>[0] = {}) => {
      const m = materials.standard(ref, { roughness: 0.5, metalness: 0.2, ...params });
      materials.bind(m, 'emissive', 'highlight');
      m.emissiveIntensity = 0;
      return m;
    };
    const mat = {
      structure: materials.standard(TONE.structure, { roughness: 0.62, metalness: 0.15 }),
      frame: materials.standard(TONE.frame, { roughness: 0.5, metalness: 0.35 }),
      accent: materials.standard(TONE.accent, { roughness: 0.5, metalness: 0.2 }),
      illumSub: hlMat(TONE.substrate),
      illumCoat: hlMat(TONE.coating, { roughness: 0.25, metalness: 0.45 }),
      collSub: hlMat(TONE.substrate),
      collCoat: hlMat(TONE.coating, { roughness: 0.25, metalness: 0.45, side: DoubleSide }),
      pobSub: hlMat(TONE.substrate),
      pobCoat: hlMat(TONE.coating, { roughness: 0.25, metalness: 0.45, side: DoubleSide }),
      source: hlMat(TONE.frame, { metalness: 0.4 }),
      tin: materials.standard(TONE.tin, { roughness: 0.3, metalness: 0.7 }),
      laser: hlMat(TONE.structure, { roughness: 0.45 }),
      reticleStage: hlMat(TONE.structure),
      waferStage: hlMat(TONE.structure),
      pump: hlMat(TONE.frame, { metalness: 0.45 }),
      plinth: hlMat(TONE.structure, { transparent: true }),
    };
    const chamberMat = materials.glass('fg', 0.035, { roughness: 0.1 });
    const chamberEdge = materials.line('fg', { transparent: true, opacity: 0.2, depthWrite: false });
    const vesselMat = materials.glass('optic', 0.05, { roughness: 0.15 });
    const housingMat = materials.glass('fg', 0.03, { roughness: 0.1 });
    const housingEdge = materials.line('fg', { transparent: true, opacity: 0.14, depthWrite: false });
    const laserBeamMat = materials.basic('heat', { transparent: true, opacity: 0.2, depthWrite: false });
    const slitMat = materials.basic('optic', { transparent: true, opacity: 0.95, depthWrite: false, side: DoubleSide });
    const reticleTex = ctx.track(reticleTexture(ctx.rng));
    const reticleFaceMat = materials.basic(TONE.reticle, { map: reticleTex });
    const waferTex = { full: ctx.track(waferTexture(false)), half: ctx.track(waferTexture(true)) };
    const waferMat = materials.standard(TONE.wafer, { map: waferTex.full, roughness: 0.32, metalness: 0.35 });
    materials.bind(waferMat, 'emissive', 'highlight');
    waferMat.emissiveIntensity = 0;
    const beamMat = ctx.track(new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
    const rayMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));

    /* ───────── floor, chamber ───────── */
    const grid = floorGrid(9.5, 4.8, 0.6);
    const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const gridLines = statik(add(new LineSegments(ctx.track(grid.geometry), gridMat)));
    gridLines.position.set(-0.9, FLOOR_Y - 0.004, 0.6);
    statik(gridLines);
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = add(new Mesh(ctx.track(new PlaneGeometry(14, 6)), shadowMat));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(-0.8, FLOOR_Y - 0.002, 0.2);
    statik(shadow);

    const csize = CHAMBER.max.clone().sub(CHAMBER.min);
    const ccen = CHAMBER.max.clone().add(CHAMBER.min).multiplyScalar(0.5);
    const chamber = add(new Mesh(ctx.track(new RoundedBoxGeometry(csize.x, csize.y, csize.z, 3, 0.18)), chamberMat));
    chamber.position.copy(ccen);
    chamber.renderOrder = 8;
    statik(chamber);
    const cedgeGeo = ctx.track(new BufferGeometry());
    cedgeGeo.setAttribute('position', boxEdges(CHAMBER.min, CHAMBER.max));
    statik(add(new LineSegments(cedgeGeo, chamberEdge)));

    /* ───────── static structure (merged) ───────── */
    const sGeos: BufferGeometry[] = [];
    const fGeos: BufferGeometry[] = [];
    // floor plinth of the tool + reticle-stage frame + wafer-stage base
    sGeos.push(box(csize.x - 0.2, 0.1, csize.z - 0.2, [ccen.x, FLOOR_Y + 0.05, ccen.z], 0.04));
    fGeos.push(box(3.1, 0.06, 1.15, [RETICLE.x + 0.15, 3.48, 0], 0.02));
    for (const z of [-0.42, 0.42]) fGeos.push(box(2.9, 0.06, 0.07, [RETICLE.x + 0.15, 3.41, z], 0.02));
    fGeos.push(box(2.8, 0.1, 2.0, [WAFER.x, FLOOR_Y + 0.15, 0], 0.03));
    for (const z of [-0.65, 0.65]) fGeos.push(box(2.8, 0.06, 0.08, [WAFER.x, FLOOR_Y + 0.23, z], 0.015));
    // laser stand
    sGeos.push(box(1.0, LASER_EXIT.y - FLOOR_Y - LASER_BOX.h / 2, 0.5, [LASER_BOX.x, (LASER_EXIT.y - LASER_BOX.h / 2 + FLOOR_Y) / 2, 0], 0.02));
    // chamber window for the CO₂ beam
    const win = new TorusGeometry(0.075, 0.018, 8, 24);
    win.rotateY(Math.PI / 2);
    win.translate(CHAMBER.min.x, LASER_EXIT.y, 0);
    fGeos.push(win);
    // turning-mirror mount
    fGeos.push(rod(TURN.clone().addScaledVector(AXIS, -0.05), TURN.clone().add(new Vector3(0, FLOOR_Y + 0.1 - TURN.y, 0)), 0.03, 8));
    statik(add(new Mesh(ctx.track(mergeStatic(sGeos)), mat.structure)));
    statik(add(new Mesh(ctx.track(mergeStatic(fGeos)), mat.frame)));

    /* ───────── shared optics (upstream of the projection optics) ───────── */
    const trains: Record<Variant, OpticEl[]> = { euv: buildTrain('euv'), 'high-na': buildTrain('high-na') };
    const el = (v: Variant, id: string) => trains[v].find((e) => e.id === id)!;
    const up = (id: string) => el('euv', id);

    // source vessel (glass frustum from behind the collector to the IF)
    const vStart = COLLECTOR.clone().addScaledVector(AXIS, -0.32);
    const vLen = vStart.distanceTo(IF_POS);
    const vessel = add(new Mesh(ctx.track(placeY(new CylinderGeometry(0.11, 0.98, vLen, 40, 1, true), AXIS, vStart.clone().addScaledVector(AXIS, vLen / 2))), vesselMat));
    vessel.renderOrder = 7;
    statik(vessel);

    // collector
    const coll = collectorGeometry(COLLECTOR, AXIS, up('collector').size ?? 0.72, up('collector').hole ?? 0.13);
    const collFace = statik(add(new Mesh(ctx.track(coll.face), mat.collCoat)));
    const collBack = statik(add(new Mesh(ctx.track(coll.back), mat.collSub)));

    // droplet generator, catcher (source hotspot)
    const sourceGroup = add(new Group());
    const srcGeos = [
      rod(GENERATOR.clone().addScaledVector(DROP_DIR, 0.02), GENERATOR.clone().addScaledVector(DROP_DIR, 0.42), 0.075, 16),
      rod(GENERATOR.clone().addScaledVector(DROP_DIR, -0.05), GENERATOR.clone().addScaledVector(DROP_DIR, 0.02), 0.03, 12),
      rod(CATCHER.clone().addScaledVector(DROP_DIR, -0.02), CATCHER.clone().addScaledVector(DROP_DIR, -0.32), 0.09, 16),
    ];
    statik(add(new Mesh(ctx.track(mergeStatic(srcGeos)), mat.source), sourceGroup));
    const plasmaProxy = add(new Mesh(ctx.track(new SphereGeometry(0.22, 12, 8)), ctx.track(new MeshBasicMaterial({ visible: false }))), sourceGroup);
    plasmaProxy.position.copy(PLASMA);
    statik(plasmaProxy);
    const plasmaMat = materials.basic('highlight', { transparent: true, depthWrite: false });
    const plasmaBall = add(new Mesh(ctx.track(new SphereGeometry(0.06, 16, 12)), plasmaMat), sourceGroup);
    plasmaBall.position.copy(PLASMA);
    plasmaBall.renderOrder = 12;
    const drops = add(new InstancedMesh(ctx.track(new SphereGeometry(0.042, 18, 12)), mat.tin, N_DROPS), sourceGroup);
    drops.frustumCulled = false;
    ctx.track({ dispose: () => drops.dispose() });

    // CO₂ drive laser + beam transport
    const laserGroup = add(new Group());
    statik(add(new Mesh(ctx.track(mergeStatic([
      box(LASER_BOX.w, LASER_BOX.h, LASER_BOX.d, [LASER_BOX.x, LASER_EXIT.y, 0], 0.06),
      rod(new Vector3(LASER_BOX.x + LASER_BOX.w / 2 - 0.02, LASER_EXIT.y, 0), LASER_EXIT, 0.06, 16),
    ])), mat.laser), laserGroup));
    const stripe = statik(add(new Mesh(ctx.track(box(LASER_BOX.w * 0.7, 0.05, 0.02, [LASER_BOX.x - 0.05, LASER_EXIT.y + 0.08, LASER_BOX.d / 2 + 0.005], 0.01)), mat.accent), laserGroup));
    stripe.renderOrder = 1;
    const turnEl: OpticEl = { id: 'turn', pos: TURN.clone(), r: 0.04, size: 0.1, mirror: true, n: AXIS.clone().sub(new Vector3(1, 0, 0)).normalize(), t: new Vector3() };
    statik(add(new Mesh(ctx.track(mirrorSubstrate(turnEl, 0.04)), mat.frame), laserGroup));
    const turnFace = add(new Mesh(ctx.track(mirrorFace(turnEl)), mat.illumCoat), laserGroup);
    orientFace(turnFace, turnEl);
    statik(turnFace);
    const laserBeam = statik(add(new Mesh(ctx.track(mergeStatic([rod(LASER_EXIT, TURN, 0.03, 10, true), rod(TURN, PLASMA, 0.03, 10, true)])), laserBeamMat), laserGroup));
    laserBeam.renderOrder = 9;

    // illuminator: field facet mirror (slender facets), pupil facet mirror (round facets), fold mirror
    const illumGroup = add(new Group());
    const ffm = up('ffm');
    const pfm = up('pfm');
    const fold = up('fold');
    const plateGeos: BufferGeometry[] = [];
    {
      const g = new RoundedBoxGeometry(0.98, 0.06, 0.72, 2, 0.025);
      const qn = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), ffm.n);
      g.applyMatrix4(new Matrix4().compose(ffm.pos.clone().addScaledVector(ffm.n, -0.035), qn, new Vector3(1, 1, 1)));
      plateGeos.push(g);
    }
    plateGeos.push(mirrorSubstrate({ ...pfm, size: 0.38 }, 0.06));
    plateGeos.push(mirrorSubstrate(fold, 0.07));
    statik(add(new Mesh(ctx.track(mergeStatic(plateGeos)), mat.illumSub), illumGroup));
    const facetM = new Matrix4();
    const ffmFacets = add(new InstancedMesh(ctx.track(new RoundedBoxGeometry(0.075, 0.025, 0.2, 1, 0.008)), mat.illumCoat, 10 * 3), illumGroup);
    {
      const qn = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), ffm.n);
      const tx = new Vector3(1, 0, 0).applyQuaternion(qn);
      const tz = new Vector3(0, 0, 1).applyQuaternion(qn);
      let k = 0;
      for (let i = 0; i < 10; i++)
        for (let j = 0; j < 3; j++) {
          const p = ffm.pos.clone().addScaledVector(tx, (i - 4.5) * 0.088).addScaledVector(tz, (j - 1) * 0.22).addScaledVector(ffm.n, 0.006);
          const tilt = new Quaternion().setFromAxisAngle(tz, ((i * 7 + j * 3) % 5 - 2) * 0.03);
          ffmFacets.setMatrixAt(k++, facetM.compose(p, tilt.multiply(qn), new Vector3(1, 1, 1)));
        }
    }
    const pfmSlots: Vector3[] = [];
    for (let i = -4; i <= 4; i++)
      for (let j = -4; j <= 4; j++) {
        const x = (i + (j % 2 ? 0.5 : 0)) * 0.085;
        const z = j * 0.074;
        if (Math.hypot(x, z) < 0.33) pfmSlots.push(new Vector3(x, 0, z));
      }
    const pfmFacets = add(new InstancedMesh(ctx.track(new CylinderGeometry(0.036, 0.036, 0.024, 8)), mat.illumCoat, pfmSlots.length), illumGroup);
    {
      const qn = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), pfm.n);
      pfmSlots.forEach((s, k) => {
        const p = s.clone().applyQuaternion(qn).add(pfm.pos).addScaledVector(pfm.n, 0.008);
        pfmFacets.setMatrixAt(k, facetM.compose(p, qn, new Vector3(1, 1, 1)));
      });
    }
    for (const im of [ffmFacets, pfmFacets]) {
      im.computeBoundingSphere();
      ctx.track({ dispose: () => im.dispose() });
    }
    const foldFace = add(new Mesh(ctx.track(mirrorFace(fold)), mat.illumCoat), illumGroup);
    orientFace(foldFace, fold);
    statik(foldFace);

    /* ───────── reticle stage (moves) ───────── */
    const reticleStage = add(new Group());
    const rs = RETICLE_SIZE;
    const rStageGeo = mergeStatic([
      box(1.34, 0.2, 1.05, [RETICLE.x, RETICLE.y + 0.06 + 0.05 + 0.1, 0], 0.05),
      box(0.92, 0.05, 0.9, [RETICLE.x, RETICLE.y + 0.06 + 0.025, 0], 0.015),
    ]);
    statik(add(new Mesh(ctx.track(rStageGeo), mat.reticleStage), reticleStage));
    statik(add(new Mesh(ctx.track(box(rs, 0.058, rs, [RETICLE.x, RETICLE.y + 0.03, 0], 0.008)), mat.frame), reticleStage));
    statik(add(new Mesh(ctx.track(box(0.5, 0.035, 0.025, [RETICLE.x - 0.3, RETICLE.y + 0.19, 0.53], 0.008)), mat.accent), reticleStage));
    const rFace = add(new Mesh(ctx.track(new PlaneGeometry(rs * 0.98, rs * 0.98)), reticleFaceMat), reticleStage);
    rFace.rotation.x = Math.PI / 2; // faces down
    rFace.position.set(RETICLE.x, RETICLE.y - 0.0015, 0);
    statik(rFace);

    /* ───────── wafer stage (moves) ───────── */
    const waferStage = add(new Group());
    const waferTop = WAFER.y;
    statik(add(new Mesh(ctx.track(mergeStatic([
      box(1.95, 0.25, 1.75, [WAFER.x, waferTop - 0.185, 0], 0.06),
      new CylinderGeometry(WAFER_R + 0.06, WAFER_R + 0.09, 0.05, 64).translate(WAFER.x, waferTop - 0.037, 0),
    ])), mat.waferStage), waferStage));
    statik(add(new Mesh(ctx.track(box(0.6, 0.04, 0.025, [WAFER.x - 0.55, waferTop - 0.18, 0.885], 0.01)), mat.accent), waferStage));
    const waferBody = add(new Mesh(ctx.track(new CylinderGeometry(WAFER_R, WAFER_R, 0.012, 64, 1, true)), mat.frame), waferStage);
    waferBody.position.set(WAFER.x, waferTop - 0.006, 0);
    statik(waferBody);
    const waferDisc = add(new Mesh(ctx.track(new PlaneGeometry(WAFER_R * 2, WAFER_R * 2)), waferMat), waferStage);
    waferMat.transparent = true;
    waferMat.alphaTest = 0.5;
    waferDisc.rotation.x = -Math.PI / 2;
    waferDisc.position.set(WAFER.x, waferTop + 0.001, 0);
    statik(waferDisc);

    /* ───────── exposure slits (fixed in space) + IF ring ───────── */
    const slitGeos: BufferGeometry[] = [];
    {
      const R = 0.51;
      const g = new RingGeometry(R - 0.011, R + 0.011, 24, 1, -0.138, 0.276);
      g.rotateX(-Math.PI / 2);
      g.translate(WAFER.x - R, waferTop + 0.004, 0);
      slitGeos.push(g);
      const R2 = 2.04;
      const g2 = new RingGeometry(R2 - 0.03, R2 + 0.03, 32, 1, -0.135, 0.27);
      g2.rotateX(Math.PI / 2);
      g2.translate(RETICLE.x - R2, RETICLE.y - 0.004, 0);
      slitGeos.push(g2);
      const ring = new TorusGeometry(0.12, 0.012, 8, 40);
      placeY(ring.rotateX(Math.PI / 2), AXIS, IF_POS);
      slitGeos.push(ring);
    }
    const slits = statik(add(new Mesh(ctx.track(mergeStatic(slitGeos)), slitMat)));
    slits.renderOrder = 11;

    /* ───────── vacuum pump (vacuum hotspot) ───────── */
    const pumpGroup = add(new Group());
    statik(add(new Mesh(ctx.track(mergeStatic([
      rod(new Vector3(CHAMBER.max.x, -1.75, 0.35), new Vector3(CHAMBER.max.x + 0.16, -1.75, 0.35), 0.16, 20),
      rod(new Vector3(CHAMBER.max.x + 0.16, -1.75, 0.35), new Vector3(CHAMBER.max.x + 0.55, -1.75, 0.35), 0.23, 24),
      rod(new Vector3(CHAMBER.max.x + 0.55, -1.75, 0.35), new Vector3(CHAMBER.max.x + 0.6, -1.75, 0.35), 0.17, 24),
    ])), mat.pump), pumpGroup));

    /* ───────── per-variant projection optics, beams and pulses ───────── */
    interface OpticsSet {
      v: Variant;
      els: OpticEl[];
      group: Group;
      faces: Mesh[];
      beams: Mesh;
      rays: LineSegments;
      segments: BeamSegment[];
      flow: PathFlow;
      emph: number[];
    }
    const pobIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const buildSet = (v: Variant): OpticsSet => {
      const els = trains[v];
      const group = add(new Group());
      const subs: BufferGeometry[] = [];
      const faces: Mesh[] = [];
      for (const id of pobIds) {
        const e = els.find((x) => x.id === id)!;
        const big = (e.size ?? 0.3) > 0.5;
        subs.push(mirrorSubstrate(e, big ? 0.12 : 0.085));
        const f = add(new Mesh(ctx.track(mirrorFace(e)), mat.pobCoat), group);
        orientFace(f, e);
        f.userData['mirror'] = id.toUpperCase();
        statik(f);
        faces.push(f);
      }
      statik(add(new Mesh(ctx.track(mergeStatic(subs)), mat.pobSub), group));
      // housing (glass) around the projection optics
      const hb = HOUSING[v];
      const hs = hb.max.clone().sub(hb.min);
      const housing = add(new Mesh(ctx.track(new RoundedBoxGeometry(hs.x, hs.y, hs.z, 2, 0.12)), housingMat), group);
      housing.position.copy(hb.max.clone().add(hb.min).multiplyScalar(0.5));
      housing.renderOrder = 6;
      statik(housing);
      const heGeo = ctx.track(new BufferGeometry());
      heGeo.setAttribute('position', boxEdges(hb.min, hb.max));
      statik(add(new LineSegments(heGeo, housingEdge), group));

      const b = buildBeams(els);
      const beams = add(new Mesh(ctx.track(b.tubes), beamMat));
      beams.renderOrder = 9;
      statik(beams);
      const rays = add(new LineSegments(ctx.track(b.lines), rayMat));
      rays.renderOrder = 10;
      statik(rays);

      // light pulses: every ray shares one parametric speed, so all pulses reach the wafer together
      const paths = RAYS.map((f) => rayPath(els, f));
      const lens = paths.map((pts) => pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]!) : 0), 0));
      const lref = lens[1] ?? 20;
      const K = Math.ceil(TRAVEL / T_PULSE) + 1;
      const offs: number[] = [];
      for (let j = 0; j < K; j++) for (let i = 0; i < TAIL; i++) offs.push((j * T_PULSE) / TRAVEL - i * 0.0065);
      const flowPaths: FlowPath[] = paths.map((points, i) => ({ points, speed: (lens[i] ?? lref) / lref }));
      const flow = ctx.track(
        new PathFlow({
          paths: flowPaths,
          count: RAYS.length * K * TAIL,
          size: 0.085,
          sizeVariance: 0,
          speed: lref / TRAVEL,
          speedVariance: 0,
          smooth: false,
          samples: 256,
          mode: 'once',
          onceOffsets: offs,
          fadeEnds: 0.012,
          byLength: false,
          theme: ctx.theme,
        }),
      );
      add(flow.object);
      return { v, els, group, faces, beams, rays, segments: b.segments, flow, emph: b.segments.map(() => 1) };
    };
    const sets: Record<Variant, OpticsSet> = { euv: buildSet('euv'), 'high-na': buildSet('high-na') };

    /* ───────── NA comparison plinth (high-na) ───────── */
    const inset = add(new Group());
    statik(add(new Mesh(ctx.track(box(3.55, 0.12, 1.4, [(INSET.xa + INSET.xb) / 2, INSET.y - 0.06, INSET.z], 0.04)), mat.plinth), inset));
    const couponMats = [
      materials.basic(TONE.coupon, { map: ctx.track(couponTexture(false, 14)), transparent: true }),
      materials.basic(TONE.coupon, { map: ctx.track(couponTexture(true, 14 * (NA.euv / NA['high-na']))), transparent: true }),
    ];
    const coupons = [INSET.xa, INSET.xb].map((x, i) => {
      const m = add(new Mesh(ctx.track(new PlaneGeometry(COUPON.w, COUPON.d)), couponMats[i]!), inset);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, INSET.y + 0.003, INSET.z);
      return statik(m);
    });
    const coneMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
    const coneGeos: BufferGeometry[] = [];
    const insetLine: number[] = [];
    const insetTheta = [NA.euv, NA['high-na']].map((na) => Math.asin(na));
    [INSET.xa, INSET.xb].forEach((x, i) => {
      const th = insetTheta[i]!;
      const rad = INSET.h * Math.tan(th);
      const apexY = INSET.y + 0.006;
      const g = new ConeGeometry(rad, INSET.h, 48, 1, true);
      g.rotateX(Math.PI);
      g.translate(x, apexY + INSET.h / 2, INSET.z);
      coneGeos.push(g);
      const L = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => insetLine.push(ax, ay, az, bx, by, bz);
      L(x, apexY, INSET.z, x, apexY + INSET.h * 1.08, INSET.z);
      const r0 = 0.36;
      for (let k = 0; k < 14; k++) {
        const a0 = (th * k) / 14;
        const a1 = (th * (k + 1)) / 14;
        L(x + Math.sin(a0) * r0, apexY + Math.cos(a0) * r0, INSET.z + 0.001, x + Math.sin(a1) * r0, apexY + Math.cos(a1) * r0, INSET.z + 0.001);
      }
      for (let k = 0; k < 48; k++) {
        const a0 = (k / 48) * Math.PI * 2;
        const a1 = ((k + 1) / 48) * Math.PI * 2;
        L(x + Math.cos(a0) * rad, apexY + INSET.h, INSET.z + Math.sin(a0) * rad, x + Math.cos(a1) * rad, apexY + INSET.h, INSET.z + Math.sin(a1) * rad);
      }
    });
    const cones = statik(add(new Mesh(ctx.track(mergeStatic(coneGeos)), coneMat), inset));
    cones.renderOrder = 9;
    const insetLineGeo = ctx.track(new BufferGeometry());
    insetLineGeo.setAttribute('position', new Float32BufferAttribute(insetLine, 3));
    const insetLineMat = materials.line('fg', { transparent: true, opacity: 0.45, depthWrite: false });
    const coneLines = statik(add(new LineSegments(insetLineGeo, insetLineMat), inset));

    /* Anamorphic frustums (變形光學 step): the same mask image field above both coupons, with its
       corners joined to the printed field — ÷4 in both directions for EUV, ÷4 across the slit and
       ÷8 along the scan for High-NA, which is why High-NA prints a half field. */
    const FZ = COUPON.d * COUPON.field; // slit direction (26 mm)
    const FX = [(FZ * 33) / 26, (FZ * 16.5) / 26]; // scan direction: full / half field
    const MK = { x: FX[0]! * 1.6, z: FZ * 1.6, y: INSET.y + 1.0 }; // mask field, drawn smaller than 4× (示意)
    const frust = add(new Group(), inset);
    const frustMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
    const frustLineMat = materials.line('optic', { transparent: true, opacity: 0.9, depthWrite: false });
    const maskMat = materials.basic(TONE.reticle, { map: reticleTex, transparent: true, side: DoubleSide, depthWrite: false });
    {
      const tri: number[] = [];
      const seg: number[] = [];
      const y0 = INSET.y + 0.008;
      [INSET.xa, INSET.xb].forEach((x, i) => {
        const fx = FX[i]! / 2;
        const top = [
          [x - MK.x / 2, MK.y, INSET.z - MK.z / 2],
          [x + MK.x / 2, MK.y, INSET.z - MK.z / 2],
          [x + MK.x / 2, MK.y, INSET.z + MK.z / 2],
          [x - MK.x / 2, MK.y, INSET.z + MK.z / 2],
        ] as const;
        const bot = [
          [x - fx, y0, INSET.z - FZ / 2],
          [x + fx, y0, INSET.z - FZ / 2],
          [x + fx, y0, INSET.z + FZ / 2],
          [x - fx, y0, INSET.z + FZ / 2],
        ] as const;
        for (let k = 0; k < 4; k++) {
          const a = top[k]!;
          const b = top[(k + 1) % 4]!;
          const c = bot[(k + 1) % 4]!;
          const d = bot[k]!;
          tri.push(...a, ...b, ...c, ...a, ...c, ...d);
          seg.push(...a, ...d, ...a, ...b, ...d, ...c);
        }
        const plane = add(new Mesh(ctx.track(new PlaneGeometry(MK.x, MK.z)), maskMat), frust);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(x, MK.y, INSET.z);
        plane.renderOrder = 10;
        statik(plane);
      });
      const fg = ctx.track(new BufferGeometry());
      fg.setAttribute('position', new Float32BufferAttribute(tri, 3));
      fg.computeVertexNormals();
      const faces = statik(add(new Mesh(fg, frustMat), frust));
      faces.renderOrder = 9;
      const lg = ctx.track(new BufferGeometry());
      lg.setAttribute('position', new Float32BufferAttribute(seg, 3));
      const lines = statik(add(new LineSegments(lg, frustLineMat), frust));
      lines.renderOrder = 11;
    }

    /* ───────── Mo/Si multilayer inset (反射鏡 step) ───────── */
    // A magnified cross-section of any EUV mirror: alternating Mo (thinner) and Si layers on a
    // substrate; the incoming ray is partly reflected at every interface and the reflections add up.
    const mlGroup = add(new Group());
    const ML_PAIRS = 5;
    const ML_T = 0.05; // half a period (示意; the real period is about 7 nm)
    const ML_MO = 0.8; // Mo takes about 40 % of each period
    const mlMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.3, transparent: true }));
    const ml = add(new InstancedMesh(ctx.track(new RoundedBoxGeometry(ML_W, ML_T, 0.6, 1, 0.006)), mlMat, ML_PAIRS * 2 + 1), mlGroup);
    const mlBase = ML.y - (ML_PAIRS * 2 * ML_T) / 2;
    const mlTop = mlBase + ML_PAIRS * 2 * ML_T;
    {
      let y = mlBase;
      for (let i = 0; i < ML_PAIRS * 2; i++) {
        const k = i % 2 ? 2 - ML_MO : ML_MO; // even = Mo, odd = Si
        ml.setMatrixAt(i, facetM.compose(new Vector3(ML.x, y + (k * ML_T) / 2, ML.z), new Quaternion(), new Vector3(1, k, 1)));
        y += k * ML_T;
      }
    }
    ml.setMatrixAt(ML_PAIRS * 2, facetM.compose(new Vector3(ML.x, mlBase - 2 * ML_T - 0.004, ML.z), new Quaternion(), new Vector3(1, 4, 1)));
    ml.setColorAt(0, new Color());
    ml.computeBoundingSphere();
    ctx.track({ dispose: () => ml.dispose() });
    const mlLineGeo = ctx.track(new BufferGeometry());
    const mlLineMat = materials.line('optic', { transparent: true, opacity: 0.95, depthTest: false });
    const mlLines = add(new LineSegments(mlLineGeo, mlLineMat), mlGroup);
    mlLines.renderOrder = 12;
    const leaderMat = materials.line('fg', { transparent: true, opacity: 0.4, depthWrite: false });
    const leaderGeo = ctx.track(new BufferGeometry());
    add(new LineSegments(leaderGeo, leaderMat), mlGroup);
    {
      const pts: number[] = [];
      const z = ML.z + 0.31;
      const hit = new Vector3(ML.x - 0.3, mlTop, z);
      const dx = 0.05; // the transmitted ray steps right by this much per period (refraction 示意)
      pts.push(hit.x - 0.46, hit.y + 0.46, z, hit.x, hit.y, z); // incoming
      pts.push(hit.x, hit.y, z, hit.x + 4.5 * dx, mlTop - 9 * ML_T, z); // transmitted, inside the stack
      for (let k = 0; k < 5; k++) {
        const y = mlTop - k * 2 * ML_T;
        const x = hit.x + k * dx;
        const len = 0.48 - k * 0.05;
        pts.push(x, y, z, x + len, y + len, z); // partial reflections, in phase
      }
      mlLineGeo.setAttribute('position', new Float32BufferAttribute(pts, 3));
      mlLineGeo.computeBoundingSphere();
      // leader to the field facet mirror (one of the multilayer mirrors it magnifies)
      const tip = ffm.pos.clone().addScaledVector(ffm.t, ffm.t.x < 0 ? 0.47 : -0.47);
      leaderGeo.setAttribute('position', new Float32BufferAttribute([ML.x + ML_W / 2 + 0.02, ML.y - 0.05, ML.z, tip.x, tip.y + 0.04, tip.z], 3));
      leaderGeo.computeBoundingSphere();
    }

    /* ───────── glows ───────── */
    // halo before core: on the light theme (normal blending) the core must be drawn over the halo
    const G = { halo: 0, core: 1, ifp: 2, pre: 3, wslit: 4, rslit: 5, apexA: 6, apexB: 7 };
    const glows = ctx.track(new GlowSprites({ count: 8, theme: ctx.theme }));
    add(glows.object);

    /* ───────── labels ───────── */
    type Align = NonNullable<LabelSpec['align']>;
    type Kind = NonNullable<LabelSpec['kind']>;
    interface LDef {
      h: LabelHandle;
      text: string;
      steps: readonly number[];
      v?: Variant;
      hs?: string;
      /** Phone-width stages: a shorter text, or hidden (false) in these steps. */
      short?: string;
      hideCompact?: readonly number[];
      /** Phone-width stages: another anchor (and alignment) that keeps the label on the stage. */
      land?: { at: Vec3Like; align: Align };
      compact?: { at: Vec3Like; align: Align };
    }
    const ldefs: LDef[] = [];
    const L = (
      text: string,
      at: Vec3Like,
      o: {
        align?: Align;
        kind?: Kind;
        prio?: number;
        steps: readonly number[];
        v?: Variant;
        hotspot?: string;
        obj?: Object3D;
        offset?: readonly [number, number];
        short?: string;
        hideCompact?: readonly number[];
        compact?: { at: Vec3Like; align?: Align };
      },
    ) => {
      const align = o.align ?? 'above';
      const spec: LabelSpec = { text, position: at, align, kind: o.kind ?? 'default', priority: o.prio ?? 10, visible: false };
      if (o.hotspot) spec.hotspot = o.hotspot;
      if (o.obj) spec.object = o.obj;
      if (o.offset) spec.offset = o.offset;
      const h = labels.add(spec);
      const d: LDef = { h, text, steps: o.steps };
      if (o.v) d.v = o.v;
      if (o.short) d.short = o.short;
      if (o.hideCompact) d.hideCompact = o.hideCompact;
      if (o.compact) {
        d.land = { at, align };
        d.compact = { at: o.compact.at, align: o.compact.align ?? align };
      }
      if (o.hotspot) d.hs = o.hotspot;
      ldefs.push(d);
      return h;
    };
    const at = (vec: Vector3, dx = 0, dy = 0, dz = 0): [number, number, number] => [vec.x + dx, vec.y + dy, vec.z + dz];
    const m6 = (v: Variant) => el(v, 'm6').pos;

    // overview: the light path in order
    /* Titles 1–3 move on phone-width stages (layoutLabels): a left-aligned title would leave the
       stage, and 2 / 3 would collide with 6 / 4. */
    const T1 = { land: at(GENERATOR, -0.25, 0.3), compact: at(GENERATOR, 0.05, 0.32) };
    const T2 = { land: at(COLLECTOR, 0.3, -0.75), compact: at(COLLECTOR, -0.5, -0.72) };
    const T3 = { land: at(ffm.pos, 0, 0.32), compact: at(ffm.pos, -0.52, 0.04) };
    const t1 = L('1　錫電漿光源', T1.land, { align: 'left', kind: 'strong', prio: 30, steps: [0], hotspot: 'droplet-source', short: '1　光源' });
    const t2 = L('2　集光鏡', T2.land, { align: 'below', kind: 'strong', prio: 28, steps: [0], hotspot: 'collector' });
    const t3 = L('3　照明系統', T3.land, { align: 'above', kind: 'strong', prio: 28, steps: [0], hotspot: 'illuminator', short: '3　照明' });
    L('4　反射式光罩', at(RETICLE, 0, 0.45), { align: 'above', kind: 'strong', prio: 30, steps: [0], hotspot: 'reticle', short: '4　光罩' });
    const projTitles: [LabelHandle, Vec3Like][] = [
      [L('5　投影光學・NA 0.33', at(m6('euv'), 1.2, 1.2), { align: 'right', kind: 'strong', prio: 28, steps: [0, 2], v: 'euv', hotspot: 'projection', short: '5　投影' }), at(m6('euv'), 1.2, 1.2)],
      [L('5　投影光學・NA 0.55', at(m6('high-na'), 1.3, 1.25), { align: 'right', kind: 'strong', prio: 28, steps: [0, 2], v: 'high-na', hotspot: 'projection', short: '5　投影' }), at(m6('high-na'), 1.3, 1.25)],
    ];
    L('6　晶圓', at(WAFER, -0.85, -0.35), { align: 'left', kind: 'strong', prio: 28, steps: [0], hotspot: 'wafer-stage' });
    L('CO₂ 驅動雷射', at(new Vector3(LASER_BOX.x, LASER_EXIT.y, 0), 0, 0.3), { align: 'above', prio: 20, steps: [0, 1], hotspot: 'co2-laser', hideCompact: [0] });
    L('真空腔體', at(CHAMBER.min, 0.25, csize.y - 0.12, csize.z), { align: 'right', kind: 'tag', prio: 6, steps: [0, 2], hotspot: 'vacuum', hideCompact: [0, 2] });
    L('中間焦點 IF', at(IF_POS, 0.12, -0.05), { align: 'right', kind: 'tag', prio: 14, steps: [0, 1], hideCompact: [0] });

    // 光源
    L('錫滴產生器', at(GENERATOR, -0.3, 0.25), { align: 'left', prio: 22, steps: [1], hotspot: 'droplet-source' });
    L('電漿：13.5 nm 極紫外光', at(PLASMA, 0.18, 0.12), { align: 'right', kind: 'strong', prio: 30, steps: [1], hotspot: 'droplet-source' });
    L('預脈衝打扁 → 主脈衝加熱', at(LASER_EXIT.clone().lerp(TURN, 0.32), 0, -0.06), { align: 'below', kind: 'tag', prio: 18, steps: [1] });
    L('集光鏡（橢球面多層膜鏡）', at(COLLECTOR, 0.2, -0.78), { align: 'below', prio: 24, steps: [1, 2], hotspot: 'collector', short: '集光鏡' });
    L('錫滴收集器', at(CATCHER, 0.2, -0.18), { align: 'right', kind: 'muted', prio: 12, steps: [1] });
    const slowNote = L('動畫已大幅放慢（示意）', at(GENERATOR, -0.2, 0.75), { align: 'above', kind: 'tag', prio: 8, steps: [1] });

    // 反射鏡
    // Phone widths: the multilayer title shifts left so 場琢面鏡 fits beside it; the fold-mirror
    // and M1–M6 labels are dropped in this step (they would land on, or next to, the pupil facet
    // mirror and read as its name).
    L('場琢面鏡', at(ffm.pos, 0, 0.3), { align: 'above', prio: 22, steps: [2], hotspot: 'illuminator' });
    L('瞳琢面鏡', at(pfm.pos, 0, -0.3), { align: 'below', prio: 22, steps: [2], hotspot: 'illuminator' });
    L('折返鏡', at(fold.pos, -0.28, -0.05), { align: 'left', kind: 'muted', prio: 16, steps: [2], hideCompact: [2] });
    L('鉬／矽多層膜（放大示意）', at(ML, 0, 0.84), { align: 'above', kind: 'strong', prio: 26, steps: [2], hotspot: 'multilayer', short: '鉬／矽多層膜', compact: { at: at(ML, -0.85, 0.84) } });
    L('每面鏡子約只反射七成光', at(ML, 0, -0.5), { align: 'below', kind: 'tag', prio: 14, steps: [2], short: '約只反射七成光', compact: { at: at(ML, -0.85, -0.5) } });
    L('深色：鉬 Mo（較薄）', at(ML, -ML_W / 2 - 0.04, 0.19), { align: 'left', kind: 'tag', prio: 13, steps: [2], hideCompact: [2] });
    L('淺色：矽 Si', at(ML, -ML_W / 2 - 0.04, -0.19), { align: 'left', kind: 'tag', prio: 13, steps: [2], hideCompact: [2] });
    L('各界面的反射同相加強', at(ML, 0.22, 0.62, 0.31), { align: 'right', kind: 'tag', prio: 12, steps: [2], hideCompact: [2] });

    // 光罩 (labels follow the moving stage where they describe it)
    L('反射式光罩（圖形面朝下）', at(RETICLE, -0.45, -0.05), { align: 'left', kind: 'strong', prio: 30, steps: [3], hotspot: 'reticle', short: '反射式光罩' });
    L('光罩載台 ⇄ 掃描', at(RETICLE, 0.7, 0.2), { align: 'right', prio: 24, steps: [3], obj: reticleStage, hotspot: 'reticle' });
    L('曝光狹縫', at(RETICLE, 0, -0.03, -0.36), { align: 'below', kind: 'tag', prio: 16, steps: [3] });
    L('斜射角約 6°（圖中放大）', at(fold.pos.clone().lerp(RETICLE, 0.55), -0.15, 0), { align: 'left', kind: 'tag', prio: 14, steps: [3] });
    L('往投影光學', at(el('euv', 'm1').pos.clone().lerp(RETICLE, 0.5), 0.15, 0), { align: 'right', kind: 'muted', prio: 12, steps: [3] });

    // 投影
    // Only the EUV mirrors are numbered: the High-NA mirror layout is schematic (示意).
    const SIDE: Record<string, 1 | -1> = { m1: 1, m2: 1, m3: 1, m4: -1, m5: -1, m6: 1 };
    let m4Label: LabelHandle | null = null;
    const m4Land = at(el('euv', 'm4').pos, -(Math.abs(el('euv', 'm4').t.x) * (el('euv', 'm4').size ?? 0.3) + 0.06), 0);
    for (const id of pobIds) {
      const e = el('euv', id);
      const dx = SIDE[id] ?? 1;
      const reach = Math.abs(e.t.x) * (e.size ?? 0.3) + 0.06;
      const h = L(id.toUpperCase(), at(e.pos, dx * reach, 0), { align: dx < 0 ? 'left' : 'right', kind: 'tag', prio: 20, steps: [2, 4], v: 'euv', hotspot: 'projection', hideCompact: [2] });
      if (id === 'm4') m4Label = h;
    }
    // Step titles: on phone widths a shorter text in the free space above M2 (the long one would
    // run off the stage and be culled).
    L('投影光學：6 面鏡、縮小 4 倍', at(el('euv', 'm3').pos, 0.55, 0.45), { align: 'right', kind: 'strong', prio: 30, steps: [4], v: 'euv', hotspot: 'projection', short: '6 面鏡・縮小 4 倍', compact: { at: at(el('euv', 'm2').pos, 0.1, 0.85), align: 'right' } });
    L('投影光學：變形 4×／8×（鏡組示意）', at(el('high-na', 'm3').pos, 0.55, 0.5), { align: 'right', kind: 'strong', prio: 30, steps: [4], v: 'high-na', hotspot: 'projection', short: '變形 4×／8×（示意）', compact: { at: at(el('high-na', 'm3').pos, 0.3, -0.3), align: 'right' } });
    L('鏡面大得多', at(el('high-na', 'm2').pos, 0.4, 0.2), { align: 'right', kind: 'tag', prio: 16, steps: [4], v: 'high-na' });
    L('光錐半角 θ：NA = sin θ', at(WAFER, 0.62, 0.6), { align: 'right', kind: 'tag', prio: 18, steps: [4] });
    L('晶圓（塗光阻）', at(WAFER, -0.6, 0.02, 0.6), { align: 'left', prio: 24, steps: [4], hotspot: 'wafer-stage', obj: waferStage });
    L('晶圓載台 ⇄ 同步掃描', at(WAFER, 0.9, -0.45, 0.5), { align: 'right', prio: 20, steps: [3, 4], hotspot: 'wafer-stage', obj: waferStage });
    L('末段鏡中央開孔（中央遮蔽）', at(m6('high-na'), -1.5, -0.06), { align: 'left', kind: 'tag', prio: 18, steps: [4], v: 'high-na', short: '末段鏡中央開孔', compact: { at: at(m6('high-na'), -1.0, 0.08), align: 'above' } });

    // 解析度 / 變形光學 (comparison plinth)
    L('EUV　NA 0.33', at(new Vector3(INSET.xa, INSET.y + INSET.h + 0.06, INSET.z)), { align: 'above', kind: 'strong', prio: 32, steps: [0, 5], v: 'high-na', hotspot: 'na-compare', offset: [-14, -8], hideCompact: [0] });
    L('High-NA　NA 0.55', at(new Vector3(INSET.xb, INSET.y + INSET.h + 0.06, INSET.z)), { align: 'above', kind: 'strong', prio: 32, steps: [0, 5], v: 'high-na', hotspot: 'na-compare', offset: [10, 0], hideCompact: [0] });
    const fieldA = L('EUV：光罩 ÷4、÷4', at(new Vector3(INSET.xa, MK.y + 0.02, INSET.z - MK.z / 2)), { align: 'above', kind: 'strong', prio: 32, steps: [6], v: 'high-na', hotspot: 'half-field', short: 'EUV ÷4、÷4' });
    const fieldB = L('High-NA：狹縫 ÷4、掃描 ÷8', at(new Vector3(INSET.xb, MK.y + 0.02, INSET.z - MK.z / 2)), { align: 'above', kind: 'strong', prio: 32, steps: [6], v: 'high-na', hotspot: 'half-field', short: 'High-NA ÷4、÷8' });
    L('同一尺寸的光罩（縮小繪製）', at(new Vector3((INSET.xa + INSET.xb) / 2, MK.y, INSET.z)), { align: 'center', kind: 'tag', prio: 20, steps: [6], v: 'high-na', hideCompact: [6] });
    L('θ ≈ 19°', at(new Vector3(INSET.xa + 0.12, INSET.y + 0.5, INSET.z)), { align: 'right', kind: 'tag', prio: 20, steps: [5], v: 'high-na' });
    L('θ ≈ 33°', at(new Vector3(INSET.xb + 0.22, INSET.y + 0.46, INSET.z)), { align: 'right', kind: 'tag', prio: 20, steps: [5], v: 'high-na' });
    L('線寬較粗', at(new Vector3(INSET.xa, INSET.y, INSET.z + 0.5)), { align: 'below', kind: 'muted', prio: 16, steps: [5], v: 'high-na' });
    L('線寬縮小約 40%（示意）', at(new Vector3(INSET.xb, INSET.y, INSET.z + 0.5)), { align: 'below', kind: 'muted', prio: 16, steps: [5], v: 'high-na' });
    const sizeA = L('全場 26 × 33 mm', at(new Vector3(INSET.xa, INSET.y, INSET.z + 0.48)), { align: 'below', prio: 24, steps: [6], v: 'high-na', hotspot: 'half-field' });
    const sizeB = L('半場 26 × 16.5 mm', at(new Vector3(INSET.xb, INSET.y, INSET.z + 0.48)), { align: 'below', prio: 24, steps: [6], v: 'high-na', hotspot: 'half-field' });
    L('掃描方向 ⟷', at(new Vector3(INSET.xb + 0.62, INSET.y + 0.01, INSET.z + 0.2)), { align: 'right', kind: 'tag', prio: 14, steps: [6], v: 'high-na' });
    L('High-NA：NA 0.55', at(WAFER, 1.35, 0.9), { align: 'right', kind: 'tag', prio: 14, steps: [5], v: 'high-na' });

    /** Phone-width stages: shorter labels, fewer of them. */
    const isCompact = () => ctx.size.width < 560;
    const labelMax = () => (isCompact() ? 12 : ctx.size.portrait ? 16 : 22);
    labels.setMax(labelMax());

    /* ───────── info panel (Rayleigh card) ───────── */
    const panel = new InfoPanel(ctx.stage, ctx.signal);
    const PANELS: Record<number, PanelContent> = {
      5: {
        title: '雷利準則（Rayleigh criterion）',
        formula: 'CD = k₁ × λ ／ NA',
        rows: [
          { k: 'CD', v: '能印出的最小線寬（半間距）' },
          { k: 'λ', v: '光的波長：EUV 為 13.5 nm' },
          { k: 'NA', v: '數值孔徑 = sin θ，光錐越張開越大' },
          { k: 'k₁', v: '製程因子，視光罩、光阻與照明技巧而定' },
        ],
        note: 'k₁ 取 0.3（示意）：NA 0.33 約 12 nm，NA 0.55 約 7 nm。',
      },
      6: {
        title: '變形（anamorphic）投影',
        formula: '狹縫 ÷4　·　掃描 ÷8',
        rows: [
          { k: '狹縫方向', v: '縮小 4 倍：曝光場寬仍為 26 mm' },
          { k: '掃描方向', v: '縮小 8 倍：曝光場長 33 → 16.5 mm' },
          { k: '代價', v: '單次只印半場，大晶粒需兩次曝光拼接' },
        ],
        note: '光罩仍是標準 6 吋；在掃描方向上，光罩載台的速度是晶圓載台的 8 倍。',
      },
    };
    const showPanel = () =>
      panel.show(PANELS[step] ?? null, { narrow: ctx.size.width < 560 || ctx.size.portrait, compact: ctx.size.width < 560, reduced: !ctx.animate });

    /* ───────── colours ───────── */
    const cOptic = new Color();
    const cCore = new Color();
    const cHeat = new Color();
    const cIF = new Color();
    const tubeAlpha = { base: 0.2 };
    const lineAlpha = { base: 0.6 };
    const writeBeams = (s: OpticsSet) => {
      const tc = s.beams.geometry.getAttribute('color') as BufferAttribute;
      const lc = s.rays.geometry.getAttribute('color') as BufferAttribute;
      s.segments.forEach((seg, i) => {
        const fall = 0.94 ** seg.bounces;
        const e = s.emph[i] ?? 1;
        const a = tubeAlpha.base * fall * (0.22 + 0.78 * e);
        for (let k = seg.start; k < seg.start + seg.count; k++) tc.setXYZW(k, cOptic.r, cOptic.g, cOptic.b, a);
        const la = lineAlpha.base * fall * (0.2 + 0.8 * e);
        for (let k = seg.lStart; k < seg.lStart + seg.lCount; k++) lc.setXYZW(k, cOptic.r, cOptic.g, cOptic.b, la);
      });
      tc.needsUpdate = true;
      lc.needsUpdate = true;
    };

    const applyPalette = (p: Palette) => {
      const dark = isDark(p);
      lights.apply(p);
      grid.recolor(mix(p.grid, p.fg, dark ? 0.1 : 0.05), dark ? 0.6 : 0.8);
      shadowMat.color.copy(dark ? p.optic : p.fg);
      shadowMat.opacity = dark ? 0.07 : 0.08;
      cOptic.copy(p.optic);
      if (dark) cOptic.lerp(p.fg, 0.12);
      cCore.copy(dark ? mix(p.fg, p.optic, 0.25) : mix(p.highlight, p.optic, 0.2));
      cHeat.copy(p.heat);
      cIF.copy(p.optic);
      tubeAlpha.base = dark ? 0.16 : 0.13;
      lineAlpha.base = dark ? 0.55 : 0.65;
      beamMat.blending = dark ? AdditiveBlending : NormalBlending;
      beamMat.needsUpdate = true;
      rayMat.blending = dark ? AdditiveBlending : NormalBlending;
      rayMat.needsUpdate = true;
      coneMat.color.copy(p.optic);
      frustMat.color.copy(p.optic);
      for (const m of [coneMat, frustMat]) {
        m.blending = dark ? AdditiveBlending : NormalBlending;
        m.needsUpdate = true;
      }
      chamberMat.opacity = dark ? 0.035 : 0.022;
      housingMat.opacity = dark ? 0.03 : 0.022;
      slitMat.blending = dark ? AdditiveBlending : NormalBlending;
      laserBeamMat.blending = dark ? AdditiveBlending : NormalBlending;
      slitMat.needsUpdate = laserBeamMat.needsUpdate = true;
      for (const s of [sets.euv, sets['high-na']]) {
        writeBeams(s);
        s.flow.recolor(() => cOptic);
        s.flow.setTheme(p.theme);
        s.flow.setSize(dark ? 0.085 : 0.055);
      }
      glows.setTheme(p.theme);
      // multilayer: Mo darker, Si lighter
      const mo = dark ? mix(p.bg, p.fg, 0.22) : mix(p.fg, p.bg, 0.2);
      const si = dark ? mix(p.fg, p.optic, 0.35) : mix(p.bg, p.optic, 0.22);
      for (let i = 0; i < ML_PAIRS * 2; i++) ml.setColorAt(i, i % 2 ? si : mo);
      ml.setColorAt(ML_PAIRS * 2, TONE.substrate(p));
      if (ml.instanceColor) ml.instanceColor.needsUpdate = true;
      paintInset();
    };

    /* ───────── animation state ───────── */
    let plasmaK = 0.5;
    let preK = 0;
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), AXIS);
    const pv = new Vector3();
    const sv = new Vector3();
    const m4 = new Matrix4();
    const ZERO = new Vector3(0, 0, 0);

    const GP = {
      wslit: new Vector3(WAFER.x, WAFER.y + 0.02, 0),
      rslit: new Vector3(RETICLE.x, RETICLE.y - 0.02, 0),
      apexA: new Vector3(INSET.xa, INSET.y + 0.02, INSET.z),
      apexB: new Vector3(INSET.xb, INSET.y + 0.02, INSET.z),
    };
    const applyGlows = () => {
      const dark = ctx.theme === 'dark';
      // Light theme: normal-blended glows are faint (the kit caps their centre alpha), so the
      // plasma gets more alpha there to read as a hot point rather than a grey bead.
      glows.set(G.core, PLASMA, (dark ? 0.3 : 0.34) + (dark ? 0.35 : 0.4) * plasmaK, cCore, dark ? 0.55 + 0.45 * plasmaK : 1.3 + 0.7 * plasmaK);
      glows.set(G.halo, PLASMA, 0.9 + 0.9 * plasmaK, cOptic, dark ? 0.25 + 0.55 * plasmaK : 0.6 + 0.6 * plasmaK);
      plasmaBall.scale.setScalar((dark ? 0.5 : 0.75) + 0.9 * plasmaK);
      plasmaMat.opacity = (dark ? 0.35 : 0.55) + (dark ? 0.65 : 0.45) * plasmaK;
      glows.set(G.ifp, IF_POS, 0.42, cIF, dark ? 0.5 : 0.35);
      glows.set(G.pre, PLASMA, 0.42, cHeat, preK * (dark ? 0.9 : 0.6));
      const slitOn = step === 3 || step === 4 ? 1 : 0.55;
      glows.set(G.wslit, GP.wslit, 0.5, cOptic, (dark ? 0.7 : 0.6) * slitOn);
      glows.set(G.rslit, GP.rslit, 0.7, cOptic, (dark ? 0.6 : 0.55) * slitOn);
      const insetOn = insetVis * coneVis;
      glows.set(G.apexA, GP.apexA, 0.3, cOptic, (dark ? 0.8 : 0.5) * insetOn);
      glows.set(G.apexB, GP.apexB, 0.3, cOptic, (dark ? 0.8 : 0.5) * insetOn);
    };

    /** Droplets, pulses and the plasma at animation time t. */
    const animateSource = (t: number) => {
      const since = t - T_ARRIVE;
      const m0 = Math.floor(since / T_PULSE);
      const e = since - m0 * T_PULSE; // time since the latest droplet reached the focus
      const atFocus = e < T_PULSE - T_ARRIVE;
      // slot 0: the droplet at the focus (pre-pulse flattens it into a pancake)
      if (atFocus) {
        const k = smooth(0, 0.28, e);
        drops.setMatrixAt(0, m4.compose(PLASMA, q, sv.set(1 + 1.4 * k, 1 - 0.7 * k, 1 + 1.4 * k)));
      } else drops.setMatrixAt(0, m4.compose(PLASMA, q, ZERO));
      for (let k = 1; k < N_DROPS; k++) {
        const d = DROP_SPEED * (k * T_PULSE - e);
        if (d > DROP_PATH || d < 0) drops.setMatrixAt(k, m4.compose(GENERATOR, q, ZERO));
        else drops.setMatrixAt(k, m4.compose(pv.copy(PLASMA).addScaledVector(DROP_DIR, d), q, sv.set(1, 1, 1)));
      }
      drops.instanceMatrix.needsUpdate = true;
      const tau = ((t % T_PULSE) + T_PULSE) % T_PULSE; // time since the last main pulse
      plasmaK = Math.exp(-tau / 0.3); // the flash lingers a little so it reads at this slowed pace
      preK = e < 0.12 ? 1 - e / 0.12 : 0;
      laserBeamMat.opacity = 0.3 + 0.4 * preK + 0.7 * Math.max(0, 1 - tau / 0.12);
      sets[variant].flow.setTime(tau);
      applyGlows();
    };

    const animateStages = (t: number) => {
      const s = Math.sin((t / SCAN_PERIOD) * Math.PI * 2);
      reticleStage.position.x = SCAN_AMP * s;
      waferStage.position.x = -(SCAN_AMP / SCAN_MAG[variant]) * s;
    };

    const showStatic = () => {
      // a representative frozen moment: one pancake at the focus, two droplets on their way
      drops.setMatrixAt(0, m4.compose(PLASMA, q, sv.set(2.2, 0.35, 2.2)));
      for (let k = 1; k < N_DROPS; k++) {
        const d = DROP_SPACING * k - 0.12;
        if (d > DROP_PATH) drops.setMatrixAt(k, m4.compose(GENERATOR, q, ZERO));
        else drops.setMatrixAt(k, m4.compose(pv.copy(PLASMA).addScaledVector(DROP_DIR, d), q, sv.set(1, 1, 1)));
      }
      drops.instanceMatrix.needsUpdate = true;
      plasmaK = 0.55;
      preK = 0;
      laserBeamMat.opacity = 0.45;
      reticleStage.position.x = 0;
      waferStage.position.x = 0;
      applyGlows();
    };

    /* ───────── visibility: variant, step, insets ───────── */
    let insetVis = 0;
    let coneVis = 1;
    let frustVis = 0;
    let mlVis = 0;
    let insetHot = false;
    let naHot = false;
    let halfHot = false;
    let mlHot = false;
    const fades: { cancel(): void }[] = [];
    const paintInset = () => {
      const k = insetVis;
      const dark = ctx.theme === 'dark';
      inset.visible = k > 0.01;
      cones.visible = coneLines.visible = coneVis > 0.01;
      frust.visible = frustVis > 0.01;
      coneMat.opacity = (dark ? 0.13 : 0.12) * k * coneVis;
      insetLineMat.opacity = 0.45 * k * coneVis;
      frustMat.opacity = (dark ? 0.1 : 0.085) * k * frustVis;
      frustLineMat.opacity = 0.85 * k * frustVis;
      maskMat.opacity = 0.94 * k * frustVis;
      for (const m of couponMats) m.opacity = k;
      mat.plinth.opacity = k;
      applyGlows();
    };
    const setInset = (k: number) => {
      insetVis = k;
      paintInset();
    };
    const setCone = (k: number) => {
      coneVis = k;
      paintInset();
    };
    const setFrust = (k: number) => {
      frustVis = k;
      paintInset();
    };
    const setMl = (k: number) => {
      mlVis = k;
      mlGroup.visible = k > 0.01;
      mlMat.opacity = k;
      mlLineMat.opacity = 0.95 * k;
      leaderMat.opacity = 0.4 * k;
    };
    const fadeTo = (getter: () => number, setter: (k: number) => void, to: number) => {
      const from = getter();
      if (Math.abs(from - to) < 1e-3) return;
      fades.push(tween.run((k) => setter(from + (to - from) * k), { duration: 380, fade: true }));
    };
    /**
     * The comparison plinth belongs to the High-NA overview and the 解析度 / 變形光學 steps. In the
     * close-ups of steps 1–4 it would only be a clipped, unlabelled shape at the frame edge, so it
     * fades out there (focusing one of its hotspots still shows it).
     */
    const insetWanted = () => (variant === 'high-na' && (step === 0 || step >= 5)) || insetHot;
    const refreshInsets = () => {
      const half = (step === 6 && !naHot) || halfHot;
      fadeTo(() => insetVis, setInset, insetWanted() ? 1 : 0);
      fadeTo(() => coneVis, setCone, half ? 0 : 1);
      fadeTo(() => frustVis, setFrust, half ? 1 : 0);
      fadeTo(() => mlVis, setMl, step === 2 || mlHot ? 1 : 0);
      applyLabels();
    };

    let emphTween: { cancel(): void } | null = null;
    const applyEmphasis = () => {
      emphTween?.cancel();
      const s = sets[variant];
      const want = STEP_SEGMENTS[step] ?? null;
      const from = s.emph.slice();
      const to = s.segments.map((seg) => (!want ? 1 : want.includes(s.els[seg.from]?.id ?? '') ? 1 : 0));
      emphTween = tween.run(
        (k) => {
          s.emph = from.map((f, i) => f + ((to[i] ?? 1) - f) * k);
          writeBeams(s);
        },
        { duration: 450, fade: true },
      );
    };

    const applyLabels = () => {
      // The comparison plinth's labels also follow it when its hotspots are focused (the plinth
      // shows temporarily in the euv variant, or switches cones ↔ frustums in high-na).
      const compact = isCompact();
      const shown = (d: LDef) => d.steps.includes(step) && (!d.v || d.v === variant) && !(compact && d.hideCompact?.includes(step)) && (d.h !== slowNote || ctx.animate);
      for (const d of ldefs)
        d.h.set({
          text: compact && d.short ? d.short : d.text,
          visible: shown(d) || (naHot && d.hs === 'na-compare') || (halfHot && d.hs === 'half-field'),
        });
    };

    const applyVariant = () => {
      for (const v of ['euv', 'high-na'] as const) {
        const s = sets[v];
        const on = v === variant;
        s.group.visible = s.beams.visible = s.rays.visible = s.flow.object.visible = on;
      }
      waferMat.map = variant === 'high-na' ? waferTex.half : waferTex.full;
      waferMat.needsUpdate = true;
      registerInsetHotspots();
    };

    const applyStep = () => {
      applyLabels();
      applyEmphasis();
      refreshInsets();
      showPanel();
      // mirrors step: let the coatings catch a little highlight
      const glow = step === 2 ? (ctx.theme === 'dark' ? 0.12 : 0.08) : 0;
      for (const m of [mat.illumCoat, mat.collCoat, mat.pobCoat]) if (!hot.has(m)) m.emissiveIntensity = glow;
      applyGlows();
    };

    /* ───────── hotspots ───────── */
    const hot = new Set<MeshStandardMaterial>();
    const hlTweens = new Map<string, { cancel(): void }>();
    const highlighter = (id: string, mats: MeshStandardMaterial[], extra?: (on: boolean) => void) => (on: boolean) => {
      hlTweens.get(id)?.cancel();
      const from = mats.map((m) => m.emissiveIntensity);
      const base = step === 2 && (mats.includes(mat.illumCoat) || mats.includes(mat.pobCoat) || mats.includes(mat.collCoat)) ? 0.1 : 0;
      for (const m of mats) (on ? hot.add(m) : hot.delete(m));
      hlTweens.set(
        id,
        tween.run(
          (k) => mats.forEach((m, i) => (m.emissiveIntensity = (from[i] ?? 0) + ((on ? 0.38 : base) - (from[i] ?? 0)) * k)),
          { duration: 200, ease: 'cubicOut', fade: true },
        ),
      );
      extra?.(on);
    };
    const hs = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const card = (id: string, href: string, linkLabel: string, extra?: string) => (): CardContent => {
      const h = hs.get(id);
      const c: CardContent = { title: h?.label ?? id, href, linkLabel, swatch: ctx.palette.css['seg-semi-equipment-materials'] ?? '' };
      const body = [h?.detail, extra].filter(Boolean).join('');
      if (body) c.body = body;
      return c;
    };
    const SEG = '/chain/semi-equipment-materials/';
    const GL = (slug: string) => `/glossary/#${slug}`;

    hotspots.register('droplet-source', {
      object: sourceGroup,
      anchor: PLASMA,
      card: card('droplet-source', GL('euv'), '名詞解釋：EUV →'),
      onHighlight: highlighter('droplet-source', [mat.source]),
      pose: STEP_POSES[1]!,
    });
    hotspots.register('co2-laser', {
      object: laserGroup,
      anchor: [LASER_BOX.x, LASER_EXIT.y, 0],
      card: card('co2-laser', SEG, '半導體設備與材料 →'),
      onHighlight: highlighter('co2-laser', [mat.laser]),
      pose: orbit([-5.0, -1.2, 0], 26, 10, 5.6),
    });
    hotspots.register('collector', {
      object: add(new Group()),
      anchor: COLLECTOR,
      card: card('collector', GL('euv'), '名詞解釋：EUV →'),
      onHighlight: highlighter('collector', [mat.collCoat, mat.collSub]),
      pose: STEP_POSES[1]!,
    });
    ctx.picker.add(collFace, { id: 'collector' });
    ctx.picker.add(collBack, { id: 'collector' });
    hotspots.register('illuminator', {
      object: illumGroup,
      anchor: pfm.pos.clone().lerp(ffm.pos, 0.5),
      card: card('illuminator', GL('lithography'), '名詞解釋：微影 →'),
      onHighlight: highlighter('illuminator', [mat.illumCoat, mat.illumSub]),
      pose: orbit([-0.6, 1.6, 0], 18, 4, 6.4),
    });
    hotspots.register('reticle', {
      object: reticleStage,
      anchor: RETICLE,
      card: card('reticle', GL('photomask'), '名詞解釋：光罩 →'),
      onHighlight: highlighter('reticle', [mat.reticleStage]),
      pose: STEP_POSES[3]!,
    });
    const projCard = (hitObj: Object3D | undefined): CardContent => {
      const base = card('projection', SEG, '半導體設備與材料 →')();
      const name = hitObj?.userData['mirror'] as string | undefined;
      if (!name) return base;
      const coat = '所有鏡面都鍍有鉬／矽多層膜。';
      if (variant === 'high-na') {
        const last = name === 'M5' || name === 'M6';
        return {
          ...base,
          title: '投影鏡（High-NA，配置示意）',
          body: last
            ? `靠近晶圓的末段大鏡子中央開孔（中央遮蔽）：光從孔中穿過，再由大鏡面以大角度會聚到晶圓上，形成 NA 0.55 的寬光錐。${coat}`
            : `前段鏡組逐步轉折光路、修正像差，並在兩個方向做不同倍率的縮小（變形光學）；鏡面比一般 EUV 大得多。${coat}`,
        };
      }
      const role: Record<string, string> = {
        M1: '第一面投影鏡，接住從光罩反射下來的光。',
        M2: '前段鏡組之一，逐步轉折光路並修正像差。',
        M3: '前段鏡組之一，逐步轉折光路並修正像差。',
        M4: '前段鏡組的最後一面，把光送往 M5。',
        M5: '把光送往最大的 M6。',
        M6: '最大的一面鏡子，決定照到晶圓的光錐張角，NA 0.33。',
      };
      return { ...base, title: `投影鏡 ${name}（EUV）`, body: `${role[name] ?? ''}${coat}` };
    };
    hotspots.register('projection', {
      object: add(new Group()),
      anchor: [1.9, 0.4, 0],
      card: (hit) => projCard(hit?.object),
      onHighlight: highlighter('projection', [mat.pobCoat, mat.pobSub]),
      pose: STEP_POSES[4]!,
    });
    for (const s of [sets.euv, sets['high-na']]) for (const f of s.faces) ctx.picker.add(f, { id: 'projection' });
    hotspots.register('wafer-stage', {
      object: waferStage,
      anchor: WAFER,
      card: card('wafer-stage', GL('photoresist'), '名詞解釋：光阻 →'),
      onHighlight: highlighter('wafer-stage', [mat.waferStage, waferMat]),
      pose: orbit([1.95, -1.6, 0.3], 22, 18, 5.2),
    });
    hotspots.register('vacuum', {
      object: pumpGroup,
      anchor: [CHAMBER.max.x + 0.3, -1.75, 0.35],
      card: card('vacuum', SEG, '半導體設備與材料 →'),
      onHighlight: highlighter('vacuum', [mat.pump]),
      pose: HOME.euv,
    });
    hotspots.register('multilayer', {
      object: mlGroup,
      anchor: ML,
      card: card('multilayer', SEG, '半導體設備與材料 →'),
      onHighlight: (on) => {
        mlHot = on;
        refreshInsets();
      },
      pose: orbit([ML.x + 0.75, ML.y + 0.2, ML.z], 16, 6, 5.4),
    });
    let unInset: (() => void)[] = [];
    function registerInsetHotspots() {
      for (const u of unInset) u();
      const note = variant === 'high-na' ? '' : '（比較台屬於 High-NA 變體，選取時會暫時顯示。）';      unInset = [
        hotspots.register('na-compare', {
          object: cones,
          anchor: [(INSET.xa + INSET.xb) / 2, INSET.y + 0.7, INSET.z],
          card: card('na-compare', GL('high-na-euv'), '名詞解釋：High-NA EUV →', note),
          onHighlight: (on) => {
            insetHot = naHot = on;
            refreshInsets();
          },
          pose: STEP_POSES[5]!,
        }),
        hotspots.register('half-field', {
          object: inset,
          anchor: [(INSET.xa + INSET.xb) / 2, INSET.y, INSET.z],
          pickable: false,
          card: card('half-field', GL('reticle-limit'), '名詞解釋：光罩尺寸極限 →', note),
          onHighlight: (on) => {
            insetHot = halfHot = on;
            refreshInsets();
          },
          pose: STEP_POSES[6]!,
        }),
      ];
      for (const c of coupons) unInset.push(ctx.picker.add(c, { id: 'half-field' }));
    }

    /* ───────── initial state ───────── */
    applyPalette(ctx.palette);
    applyVariant();
    insetVis = insetWanted() ? 1 : 0;
    coneVis = step === 6 ? 0 : 1;
    frustVis = step === 6 ? 1 : 0;
    paintInset();
    setMl(step === 2 ? 1 : 0);
    applyLabels();
    for (const s of [sets.euv, sets['high-na']]) s.flow.setReduced(!ctx.animate);
    if (ctx.animate) {
      animateSource(0);
      animateStages(0);
    } else showStatic();

    /**
     * Portrait stages use their own step poses. ctx.setPose scales a pose's distance by
     * |portrait home| / |landscape home| on portrait stages, so divide that ratio out first.
     */
    const poseFor = (i: number): CameraPose => {
      if (!ctx.size.portrait) return (i > 0 ? (isCompact() ? COMPACT_STEPS[i] : undefined) ?? STEP_POSES[i] : null) ?? ctx.homePose;
      const p = i > 0 ? PORTRAIT_STEPS[i] : null;
      if (!p) return ctx.homePose;
      const cam = ctx.meta.camera;
      const v3 = (a: Vec3Like) => (a instanceof Vector3 ? a.clone() : new Vector3(a[0], a[1], a[2]));
      const dist = (a: Vec3Like, b: Vec3Like) => v3(a).distanceTo(v3(b));
      const k = cam.portrait?.position ? dist(cam.portrait.position, cam.portrait.target ?? cam.target) / dist(cam.position, cam.target) : 1;
      const t = p.target as readonly number[];
      const q0 = p.position as readonly number[];
      return { ...p, position: [t[0]! + (q0[0]! - t[0]!) / k, t[1]! + (q0[1]! - t[1]!) / k, t[2]! + (q0[2]! - t[2]!) / k] };
    };
    /** Camera moves cancel the previous one (two camera tweens would fight over the camera). */
    let camTween: { cancel(): void } | null = null;
    const goPose = (p: CameraPose) => {
      camTween?.cancel();
      camTween = ctx.setPose(p);
    };
    /**
     * Portrait and phone-width stages: the projection-optics title moves from the right edge to
     * above the housing; on phone widths titles 1–3 move clear of the stage edge and of 4 / 6.
     */
    let portrait = ctx.size.portrait;
    let compactNow = isCompact();
    const layoutLabels = () => {
      const narrow = portrait || compactNow;
      projTitles.forEach(([h, land], i) => {
        const hb = HOUSING[i ? 'high-na' : 'euv'];
        // phone widths: a little lower and further right, clear of 「4　光罩」
        const p: Vec3Like = compactNow ? [hb.max.x - 0.08, hb.max.y - 0.26, hb.max.z] : [hb.max.x - 0.45, hb.max.y + 0.05, hb.max.z];
        h.set(narrow ? { position: p, align: 'above' } : { position: land, align: 'right' });
      });
      t1.set(compactNow ? { position: T1.compact, align: 'above' } : { position: T1.land, align: 'left' });
      t2.set({ position: compactNow ? T2.compact : T2.land });
      t3.set(compactNow ? { position: T3.compact, align: 'left' } : { position: T3.land, align: 'above' });
      // 變形光學 on phone widths: the paired labels are spread apart so both fit
      const spread = compactNow ? 18 : 0;
      fieldA.set({ offset: [-spread, 0] });
      fieldB.set({ offset: [spread, 0] });
      sizeA.set({ offset: [-spread, 0] });
      sizeB.set({ offset: [spread, 0] });
      // Portrait: M4's left side is taken by the 瞳琢面鏡 label, so it moves above the mirror.
      m4Label?.set(portrait ? { position: at(el('euv', 'm4').pos, -0.05, 0.16), align: 'above' } : { position: m4Land, align: 'left' });
      for (const d of ldefs) {
        const p = compactNow ? d.compact : d.land;
        if (p) d.h.set({ position: p.at, align: p.align });
      }
    };
    layoutLabels();

    return {
      update(_dt, t) {
        if (!ctx.animate) return;
        animateSource(t);
        animateStages(t);
      },
      setStep(i) {
        step = i;
        applyStep();
        goPose(poseFor(i));
      },
      setVariant(v) {
        variant = variantOf(v);
        applyVariant();
        for (const s of [sets.euv, sets['high-na']]) s.emph = s.segments.map(() => 1);
        applyStep();
        if (!ctx.animate) showStatic();
        goPose(poseFor(step));
        return true;
      },
      onMotion(animate) {
        for (const s of [sets.euv, sets['high-na']]) s.flow.setReduced(!animate);
        if (!animate) showStatic();
        showPanel();
        applyLabels(); // 「動畫已大幅放慢」 only while something moves
      },
      onPalette(p) {
        applyPalette(p);
        applyStep();
      },
      onResize(size) {
        labels.setMax(labelMax());
        let repose = false;
        if (isCompact() !== compactNow) {
          compactNow = isCompact();
          applyLabels();
          layoutLabels();
          repose = !size.portrait && COMPACT_STEPS[step] !== undefined;
        }
        showPanel();
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          layoutLabels();
          camTween?.cancel(); // a tween started for the old stage shape would undo the host's reset
          camTween = null;
          repose = step > 0;
        }
        if (repose) goPose(poseFor(step));
      },
      dispose() {
        emphTween?.cancel();
        camTween?.cancel();
        for (const f of fades) f.cancel();
        hlTweens.forEach((t) => t.cancel());
        root.removeFromParent();
      },
    };
  },
});

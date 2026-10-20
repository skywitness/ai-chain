/**
 * physical-ai — the procedural humanoid rig (no skinning): rigid links built from rounded boxes,
 * capsules and cylinders, posed by hand-written forward kinematics plus an analytic 2-link IK for
 * the right arm, and a keyframed pick-and-place task (alternating A → B, B → A).
 *
 * Units are metres; the robot faces +z and its right arm is on −x (viewer's left when it faces you).
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PartsBuilder, RoleGeometry, clamp01, easeInOut, lerp } from './common';

/* ───────────────────────── dimensions ───────────────────────── */

export const L1 = 0.32; // upper arm
export const L2 = 0.3; // forearm
export const HAND = 0.135; // wrist pitch axis → grasp point
export const SHOULDER: readonly [number, number, number] = [-0.235, 0.42, 0]; // in the waist (torso) frame
export const WAIST_Y = 1.0;
export const TABLE_Y = 0.78;
export const CUBE = 0.075;
export const TRAY_FLOOR = 0.012;

/** Pick and place spots on the table (robot-local). A = loose cube spot, B = inside the tray. */
export const SPOT_A = new Vector3(-0.31, TABLE_Y, 0.31);
export const SPOT_B = new Vector3(0.0, TABLE_Y + TRAY_FLOOR, 0.3);
export const HOME_W = new Vector3(-0.27, 1.02, 0.2); // relaxed wrist position

const rb = (w: number, h: number, d: number, r = 0.02, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999);
const cyl = (r: number, h: number, seg = 16) => new CylinderGeometry(r, r, h, seg, 1);
const capsule = (r: number, len: number) => new CapsuleGeometry(r, len, 4, 10);

/* ───────────────────────── rig ───────────────────────── */

export interface Link {
  name: string;
  node: Object3D;
  /** Absent on a kinematic twin (buildRig(null)). */
  geo?: RoleGeometry;
  mesh?: Mesh;
}

export interface Rig {
  root: Group;
  waist: Group;
  head: Group;
  shoulderYaw: Group;
  shoulderPitch: Group;
  elbow: Group;
  wristPitch: Group;
  wristRoll: Group;
  fingerL: Group;
  fingerR: Group;
  links: Link[];
  /** Anchors (empties) that follow the links. */
  at: {
    headCam: Object3D;
    wristCam: Object3D;
    ft: Object3D;
    grasp: Object3D;
    tipL: Object3D;
    tipR: Object3D;
    chest: Object3D;
    imu: Object3D;
    shoulder: Object3D;
    elbow: Object3D;
    wrist: Object3D;
    hip: Object3D;
    knee: Object3D;
    leftShoulder: Object3D;
    leftElbow: Object3D;
  };
  /** Joint motor rings (world matrices are read every frame): [node, axis]. */
  motors: { node: Object3D; axis: 'x' | 'y' | 'z'; r: number; arm: boolean }[];
}

/** Build the link geometries. `withMeshes = false` builds an empty kinematic twin (for ghosts). */
export function buildRig(material: Material | null): Rig {
  const root = new Group();
  root.name = 'humanoid';
  const links: Link[] = [];
  const empty = (parent: Object3D, p: readonly [number, number, number]) => {
    const o = new Object3D();
    o.position.set(p[0], p[1], p[2]);
    parent.add(o);
    return o;
  };
  const link = (name: string, node: Object3D, b: PartsBuilder) => {
    if (!material) {
      links.push({ name, node });
      return;
    }
    const geo = b.build();
    const mesh = new Mesh(geo.geometry, material);
    mesh.name = name;
    node.add(mesh);
    links.push({ name, node, geo, mesh });
  };
  const motors: Rig['motors'] = [];

  /* lower body (static) */
  const lower = new PartsBuilder();
  for (const s of [-1, 1]) {
    const x = 0.1 * s;
    lower.add(rb(0.1, 0.06, 0.22, 0.025), 'dark', [x, 0.03, 0.035]);
    lower.add(rb(0.11, 0.36, 0.12, 0.04), 'shell', [x, 0.29, 0]);
    lower.add(cyl(0.05, 0.13), 'dark', [x, 0.49, 0], [0, 0, Math.PI / 2]);
    lower.add(rb(0.13, 0.36, 0.14, 0.045), 'shell', [x, 0.69, 0]);
    lower.add(rb(0.035, 0.24, 0.03, 0.012), 'accent', [x + 0.055 * s, 0.69, 0.0]);
    lower.add(cyl(0.055, 0.14), 'dark', [x, 0.88, 0], [0, 0, Math.PI / 2]);
  }
  lower.add(rb(0.32, 0.12, 0.18, 0.05), 'dark', [0, 0.92, 0]);
  const lowerNode = new Group();
  root.add(lowerNode);
  link('lower', lowerNode, lower);
  motors.push({ node: empty(root, [0.1, 0.49, 0]), axis: 'x', r: 0.058, arm: false });
  motors.push({ node: empty(root, [-0.1, 0.49, 0]), axis: 'x', r: 0.058, arm: false });
  motors.push({ node: empty(root, [0.1, 0.88, 0]), axis: 'x', r: 0.062, arm: false });
  motors.push({ node: empty(root, [-0.1, 0.88, 0]), axis: 'x', r: 0.062, arm: false });

  /* waist → torso (+ static left arm, neck) */
  const waist = new Group();
  waist.position.set(0, WAIST_Y, 0);
  root.add(waist);
  const torso = new PartsBuilder();
  torso.add(cyl(0.085, 0.09), 'dark', [0, 0.03, 0]);
  torso.add(rb(0.36, 0.3, 0.2, 0.06, 3), 'shell', [0, 0.25, 0]);
  torso.add(rb(0.4, 0.12, 0.22, 0.05, 3), 'shell', [0, 0.38, 0]);
  torso.add(rb(0.2, 0.15, 0.03, 0.012), 'dark', [0, 0.27, 0.098]);
  torso.add(rb(0.13, 0.024, 0.012, 0.005), 'compute', [0, 0.29, 0.115]);
  torso.add(rb(0.13, 0.012, 0.012, 0.004), 'compute', [0, 0.25, 0.115]);
  torso.add(rb(0.05, 0.13, 0.02, 0.008), 'accent', [-0.15, 0.3, 0.095]);
  torso.add(rb(0.05, 0.13, 0.02, 0.008), 'accent', [0.15, 0.3, 0.095]);
  torso.add(rb(0.26, 0.24, 0.08, 0.03), 'dark', [0, 0.27, -0.12]); // backpack (battery + compute)
  torso.add(cyl(0.04, 0.08), 'dark', [0, 0.48, 0]);
  // left arm, relaxed (static): shoulder → elbow → forearm pointing forward → gripper
  const ls = [0.235, 0.42, 0] as const;
  const lsV = new Vector3(...ls);
  const le = new Vector3(0.262, 0.42 - L1 + 0.01, 0.05);
  const fd = new Vector3(0.02, -0.3, 0.95).normalize();
  const lw = le.clone().addScaledVector(fd, L2);
  torso.add(new SphereGeometry(0.064, 16, 12), 'dark', ls);
  torso.addAlong(capsule(0.047, L1 - 0.1), 'shell', lsV, le);
  torso.add(cyl(0.047, 0.11), 'dark', [le.x, le.y, le.z], [0, 0, Math.PI / 2]);
  torso.addAlong(capsule(0.042, L2 - 0.1), 'shell', le, lw);
  const hq = new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), fd);
  const hp = (y: number, x = 0) => lw.clone().add(new Vector3(x, y, 0).applyQuaternion(hq));
  torso.addQ(cyl(0.036, 0.07, 14).rotateZ(Math.PI / 2), 'dark', lw, hq);
  torso.addQ(rb(0.16, 0.045, 0.05, 0.014), 'dark', hp(-0.072), hq);
  torso.addQ(rb(0.016, 0.07, 0.034, 0.006), 'dark', hp(-0.125, -0.066), hq);
  torso.addQ(rb(0.016, 0.07, 0.034, 0.006), 'dark', hp(-0.125, 0.066), hq);
  link('torso', waist, torso);
  const chest = empty(waist, [0, 0.28, 0.12]);
  const imu = empty(waist, [0, 0.16, 0.0]);
  const leftShoulder = empty(waist, ls);
  const leftElbow = empty(waist, [le.x, le.y, le.z]);
  motors.push({ node: leftShoulder, axis: 'x', r: 0.066, arm: true });
  motors.push({ node: leftElbow, axis: 'x', r: 0.05, arm: true });
  motors.push({ node: empty(waist, [0, 0.03, 0]), axis: 'y', r: 0.09, arm: false });

  /* head (yaw + pitch about the neck) */
  const head = new Group();
  head.position.set(0, 0.52, 0);
  waist.add(head);
  const hb = new PartsBuilder();
  hb.add(rb(0.2, 0.22, 0.21, 0.07, 3), 'shell', [0, 0.11, 0]);
  hb.add(rb(0.17, 0.085, 0.03, 0.03, 3), 'dark', [0, 0.115, 0.098]);
  hb.add(cyl(0.017, 0.02, 14), 'sensor', [-0.042, 0.115, 0.113], [Math.PI / 2, 0, 0]);
  hb.add(cyl(0.017, 0.02, 14), 'sensor', [0.042, 0.115, 0.113], [Math.PI / 2, 0, 0]);
  hb.add(rb(0.03, 0.06, 0.06, 0.012), 'accent', [-0.103, 0.11, 0]);
  hb.add(rb(0.03, 0.06, 0.06, 0.012), 'accent', [0.103, 0.11, 0]);
  link('head', head, hb);
  const headCam = empty(head, [0, 0.115, 0.12]);

  /* right arm */
  const shoulderYaw = new Group();
  shoulderYaw.position.set(...SHOULDER);
  waist.add(shoulderYaw);
  const shoulderPitch = new Group();
  shoulderYaw.add(shoulderPitch);
  const ua = new PartsBuilder();
  ua.add(new SphereGeometry(0.064, 16, 12), 'dark', [0, 0, 0]);
  ua.add(capsule(0.047, L1 - 0.1), 'shell', [0, -L1 / 2, 0]);
  ua.add(rb(0.02, 0.14, 0.03, 0.008), 'accent', [-0.045, -L1 / 2, 0]);
  link('upper-arm', shoulderPitch, ua);
  motors.push({ node: shoulderPitch, axis: 'x', r: 0.068, arm: true });

  const elbow = new Group();
  elbow.position.set(0, -L1, 0);
  shoulderPitch.add(elbow);
  const fa = new PartsBuilder();
  fa.add(cyl(0.047, 0.11), 'dark', [0, 0, 0], [0, 0, Math.PI / 2]);
  fa.add(capsule(0.042, L2 - 0.1), 'shell', [0, -L2 / 2, 0]);
  fa.add(rb(0.03, 0.03, 0.04, 0.008), 'dark', [0, -L2 + 0.06, 0.045]);
  fa.add(cyl(0.011, 0.012, 12), 'sensor', [0, -L2 + 0.05, 0.068], [Math.PI / 2 + 0.6, 0, 0]);
  link('forearm', elbow, fa);
  motors.push({ node: elbow, axis: 'x', r: 0.052, arm: true });
  const wristCam = empty(elbow, [0, -L2 + 0.05, 0.075]);

  const wristPitch = new Group();
  wristPitch.position.set(0, -L2, 0);
  elbow.add(wristPitch);
  const wristRoll = new Group();
  wristPitch.add(wristRoll);
  const hd = new PartsBuilder();
  hd.add(cyl(0.036, 0.07, 14), 'dark', [0, 0, 0], [0, 0, Math.PI / 2]);
  hd.add(cyl(0.04, 0.022, 18), 'sensor', [0, -0.035, 0]); // 6-axis force/torque sensor
  hd.add(rb(0.16, 0.045, 0.05, 0.014), 'dark', [0, -0.072, 0]);
  link('hand', wristRoll, hd);
  motors.push({ node: wristPitch, axis: 'x', r: 0.042, arm: true });
  const ft = empty(wristRoll, [0, -0.035, 0]);
  const grasp = empty(wristRoll, [0, -HAND, 0]);

  const finger = (sx: number) => {
    const g = new Group();
    g.position.set(sx * 0.03, -0.095, 0);
    wristRoll.add(g);
    const fb = new PartsBuilder();
    fb.add(rb(0.016, 0.07, 0.034, 0.006), 'dark', [0, -0.03, 0]);
    fb.add(rb(0.006, 0.03, 0.028, 0.0025), 'sensor', [-sx * 0.0095, -0.05, 0]); // tactile pad
    link(sx < 0 ? 'finger-l' : 'finger-r', g, fb);
    return g;
  };
  const fingerL = finger(-1);
  const fingerR = finger(1);
  const tipL = empty(fingerL, [0.008, -0.05, 0]);
  const tipR = empty(fingerR, [-0.008, -0.05, 0]);

  return {
    root,
    waist,
    head,
    shoulderYaw,
    shoulderPitch,
    elbow,
    wristPitch,
    wristRoll,
    fingerL,
    fingerR,
    links,
    motors,
    at: {
      headCam,
      wristCam,
      ft,
      grasp,
      tipL,
      tipR,
      chest,
      imu,
      shoulder: shoulderYaw,
      elbow,
      wrist: wristPitch,
      hip: motors[3]!.node,
      knee: motors[1]!.node,
      leftShoulder,
      leftElbow,
    },
  };
}

/* ───────────────────────── table, tray, cube ───────────────────────── */

export function buildTable(): PartsBuilder {
  const b = new PartsBuilder();
  b.add(rb(1.1, 0.04, 0.56, 0.015), 'table', [0, TABLE_Y - 0.02, 0.4]);
  for (const x of [-0.5, 0.5]) for (const z of [0.17, 0.63]) b.add(cyl(0.018, TABLE_Y - 0.04, 8), 'tableLeg', [x, (TABLE_Y - 0.04) / 2, z]);
  // tray (blue): floor + 4 low walls around SPOT_B
  const tx = SPOT_B.x;
  const tz = SPOT_B.z;
  const TW = 0.25;
  const TD = 0.21;
  const WH = 0.04;
  b.add(new BoxGeometry(TW, TRAY_FLOOR, TD), 'tray', [tx, TABLE_Y + TRAY_FLOOR / 2, tz]);
  b.add(new BoxGeometry(TW, WH, 0.012), 'tray', [tx, TABLE_Y + WH / 2, tz - TD / 2 + 0.006]);
  b.add(new BoxGeometry(TW, WH, 0.012), 'tray', [tx, TABLE_Y + WH / 2, tz + TD / 2 - 0.006]);
  b.add(new BoxGeometry(0.012, WH, TD), 'tray', [tx - TW / 2 + 0.006, TABLE_Y + WH / 2, tz]);
  b.add(new BoxGeometry(0.012, WH, TD), 'tray', [tx + TW / 2 - 0.006, TABLE_Y + WH / 2, tz]);
  // target mark for spot A (a thin square outline)
  const MK = 0.14;
  for (const [w, d, x, z] of [
    [MK, 0.01, 0, -MK / 2],
    [MK, 0.01, 0, MK / 2],
    [0.01, MK, -MK / 2, 0],
    [0.01, MK, MK / 2, 0],
  ] as const)
    b.add(new BoxGeometry(w, 0.002, d), 'mark', [SPOT_A.x + x, TABLE_Y + 0.001, SPOT_A.z + z]);
  return b;
}

export function cubeGeometry() {
  return new RoundedBoxGeometry(CUBE, CUBE, CUBE, 2, 0.008);
}

/* ───────────────────────── task timeline ───────────────────────── */

export type TaskPhase = 'approach' | 'descend' | 'grasp' | 'lift' | 'transport' | 'lower' | 'release' | 'retreat' | 'return' | 'rest';
const PHASES: readonly [TaskPhase, number][] = [
  ['approach', 1.5],
  ['descend', 0.9],
  ['grasp', 0.6],
  ['lift', 0.8],
  ['transport', 1.6],
  ['lower', 0.9],
  ['release', 0.6],
  ['retreat', 0.7],
  ['return', 1.4],
  ['rest', 0.9],
];
export const TASK_PERIOD = PHASES.reduce((s, [, d]) => s + d, 0);
export const PHASE_NAME: Record<TaskPhase, string> = {
  approach: '接近方塊',
  descend: '對準下降',
  grasp: '夾取',
  lift: '提起',
  transport: '搬運',
  lower: '放下',
  release: '鬆開',
  retreat: '退開',
  return: '回到待命',
  rest: '待命',
};

export interface TaskPose {
  /** Wrist pitch-axis target (robot-local). */
  wrist: Vector3;
  /** Gripper opening 0 (closed on the cube) … 1 (open). */
  open: number;
  /** Cube is in the hand. */
  carry: boolean;
  /** Contact force 0..1 (drives the F/T + tactile glow). */
  force: number;
  /** Forward lean of the waist (rad). */
  lean: number;
  phase: TaskPhase;
  /** Index of the cycle (even: A → B, odd: B → A). */
  cycle: number;
  /** Where the cube rests when not carried (robot-local, cube bottom centre). */
  rest: Vector3;
}

const HOVER = 0.13;
const above = (spot: Vector3, out: Vector3, h = HOVER) => out.set(spot.x, spot.y + CUBE / 2 + HAND + h, spot.z);
const at = (spot: Vector3, out: Vector3) => above(spot, out, 0);
const tA = new Vector3();
const tB = new Vector3();

/** Pose of the task at time `t` (seconds, any value; the task repeats every TASK_PERIOD). */
export function taskPose(t: number, out: TaskPose): TaskPose {
  const cycle = Math.floor(t / TASK_PERIOD);
  let u = t - cycle * TASK_PERIOD;
  const src = cycle % 2 === 0 ? SPOT_A : SPOT_B;
  const dst = cycle % 2 === 0 ? SPOT_B : SPOT_A;
  let phase: TaskPhase = 'rest';
  let k = 0;
  for (const [p, d] of PHASES) {
    if (u <= d) {
      phase = p;
      k = clamp01(u / d);
      break;
    }
    u -= d;
  }
  const e = easeInOut(k);
  const w = out.wrist;
  out.open = 1;
  out.carry = false;
  out.force = 0;
  out.rest.copy(src);
  switch (phase) {
    case 'approach':
      w.copy(HOME_W).lerp(above(src, tA), e);
      w.y += Math.sin(Math.PI * e) * 0.04;
      break;
    case 'descend':
      w.copy(above(src, tA)).lerp(at(src, tB), e);
      break;
    case 'grasp':
      w.copy(at(src, tA));
      out.open = 1 - e;
      out.force = smoothK(k, 0.55, 1);
      break;
    case 'lift':
      w.copy(at(src, tA)).lerp(above(src, tB), e);
      out.open = 0;
      out.carry = true;
      out.force = 1;
      break;
    case 'transport':
      w.copy(above(src, tA)).lerp(above(dst, tB), e);
      w.y += Math.sin(Math.PI * e) * 0.06;
      out.open = 0;
      out.carry = true;
      out.force = 1;
      break;
    case 'lower':
      w.copy(above(dst, tA)).lerp(at(dst, tB), e);
      out.open = 0;
      out.carry = true;
      out.force = 1;
      break;
    case 'release':
      w.copy(at(dst, tA));
      out.open = e;
      out.force = 1 - smoothK(k, 0, 0.45);
      out.rest.copy(dst);
      out.carry = false;
      break;
    case 'retreat':
      w.copy(at(dst, tA)).lerp(above(dst, tB), e);
      out.rest.copy(dst);
      break;
    case 'return':
      w.copy(above(dst, tA)).lerp(HOME_W, e);
      w.y += Math.sin(Math.PI * e) * 0.03;
      out.rest.copy(dst);
      break;
    default:
      w.copy(HOME_W);
      out.rest.copy(dst);
  }
  // Lean in a little when the hand is low and far forward.
  const reach = clamp01((1.08 - w.y) / 0.16) * clamp01((w.z - 0.12) / 0.2);
  out.lean = 0.02 + 0.13 * reach;
  out.phase = phase;
  out.cycle = cycle;
  return out;
}
const smoothK = (k: number, a: number, b: number) => {
  const x = clamp01((k - a) / (b - a));
  return x * x * (3 - 2 * x);
};

export const newTaskPose = (): TaskPose => ({
  wrist: new Vector3(),
  open: 1,
  carry: false,
  force: 0,
  lean: 0,
  phase: 'rest',
  cycle: 0,
  rest: new Vector3(),
});

/* ───────────────────────── IK + pose application ───────────────────────── */

const tw = new Vector3();
const look = new Vector3();

/**
 * Pose the rig for a task pose: waist lean, right-arm IK (shoulder yaw + pitch, elbow, wrist pitch
 * keeps the gripper vertical, wrist roll keeps the fingers aligned with the table), gripper opening,
 * and the head looking at `gaze` (robot-local).
 */
export function applyPose(rig: Rig, pose: TaskPose, gaze: Vector3): void {
  rig.waist.rotation.x = pose.lean;
  rig.root.updateMatrixWorld(true);
  // Target in the shoulder's parent (waist) frame, relative to the shoulder.
  tw.copy(pose.wrist);
  rig.root.localToWorld(tw);
  rig.waist.worldToLocal(tw);
  tw.sub(rig.shoulderYaw.position);
  const yaw = Math.atan2(tw.x, tw.z);
  const h = Math.hypot(tw.x, tw.z);
  const v = tw.y;
  const D = Math.min(L1 + L2 - 1e-3, Math.max(0.08, Math.hypot(h, v)));
  const beta = Math.atan2(h, -v); // from straight down toward forward
  const gamma = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D))));
  const eps = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2))));
  const alpha = beta - gamma;
  const bend = Math.PI - eps;
  rig.shoulderYaw.rotation.y = yaw;
  rig.shoulderPitch.rotation.x = -alpha;
  rig.elbow.rotation.x = -bend;
  // Hand vertical in the waist frame, then undo the lean so it is vertical in the world.
  rig.wristPitch.rotation.x = alpha + bend - pose.lean;
  rig.wristRoll.rotation.y = -yaw;
  const o = lerp(0.05, 0.07, pose.open);
  rig.fingerL.position.x = -o;
  rig.fingerR.position.x = o;
  // Head: look at the gaze point.
  look.copy(gaze);
  rig.root.localToWorld(look);
  rig.waist.worldToLocal(look);
  look.sub(rig.head.position);
  look.y -= 0.115;
  rig.head.rotation.order = 'YXZ';
  rig.head.rotation.y = Math.max(-0.7, Math.min(0.7, Math.atan2(look.x, look.z)));
  // The head nods down far enough for the (down-tilted) stereo cameras to see the work area.
  rig.head.rotation.x = Math.max(-0.1, Math.min(0.92, Math.atan2(-look.y, Math.hypot(look.x, look.z)))) - 0.05;
  rig.root.updateMatrixWorld(true);
}

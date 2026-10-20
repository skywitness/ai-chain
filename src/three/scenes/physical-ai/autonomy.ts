/**
 * physical-ai · autonomy variant — a stylised street (right-hand traffic, two lanes each way).
 * The ego robotaxi's roof LiDAR sweeps a point cloud ray-cast once against the street (lidar.ts);
 * camera frustums and a front radar fan show the other sensors; detected road users get
 * class-coloured 3D boxes and dashed predicted motions; the pink ribbon is the planned lane change
 * around a stopped truck, with waypoints that bunch up (slow down) before the crosswalk.
 * The floating end-to-end card contrasts a modular stack with one trainable network.
 *
 * Steps (autonomy): 0 總覽 (when the reader picks this variant) · 5 自駕感知 · 6 預測與規劃 · 7 端到端模型.
 * Reduced motion: the full static point cloud (no sweep), static flows, the final card state.
 */
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineSegments,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  BoxGeometry,
  CapsuleGeometry,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import type { CameraPose, LabelHandle, Palette, SceneContext, SceneInstance } from '../../core/types';
import { canvasTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { PartsBuilder, crossHotspots, easeInOut, fitPortrait, frustumFaces, frustumSegments, hotspotCard, roundedRect, smooth } from './common';
import { castCloud, lowerBound, type BoxObs, type SphereObs } from './lidar';

/* ───────────────────────── street layout (metres; ego faces −z) ───────────────────────── */

const ROAD = 7; // half width (4 lanes × 3.5 m)
const WALK = 10; // sidewalk outer edge
const TILE: readonly [number, number, number, number] = [-16, 16, -33, 9]; // minX maxX minZ maxZ
const EGO = new Vector3(5.25, 0, 0);
const LIDAR_H = 2.02;
const CROSS_Z = -24; // crosswalk centre
const STOP_Z = -21.6;

type Cls = 'car' | 'truck' | 'ped' | 'bike';
interface Agent {
  id: string;
  cls: Cls;
  pos: [number, number, number];
  /** Box size (x, y, z) and heading sign along z (+1 = towards +z). */
  size: [number, number, number];
  dir: 1 | -1 | 0;
  /** Predicted displacement (world) for the dashed path, or null (static). */
  pred: [number, number] | null;
  label: string;
}
const AGENTS: readonly Agent[] = [
  { id: 'truck', cls: 'truck', pos: [5.25, 0, -15], size: [2.6, 3.4, 8.2], dir: -1, pred: null, label: '貨車（靜止）' },
  { id: 'oncoming', cls: 'car', pos: [-1.75, 0, -17], size: [2.0, 1.6, 4.7], dir: 1, pred: [0, 11], label: '車輛' },
  { id: 'follow', cls: 'car', pos: [1.75, 0, 6.2], size: [2.0, 1.6, 4.7], dir: -1, pred: [0, -6], label: '車輛' },
  { id: 'bike', cls: 'bike', pos: [-5.7, 0, -7.5], size: [0.8, 1.8, 1.9], dir: 1, pred: [0, 5], label: '自行車' },
  { id: 'ped1', cls: 'ped', pos: [8.1, 0.15, CROSS_Z], size: [0.75, 1.85, 0.75], dir: 0, pred: [-6.5, 0], label: '行人' },
  { id: 'ped2', cls: 'ped', pos: [-8.4, 0.15, -2.5], size: [0.75, 1.85, 0.75], dir: 0, pred: [0, 3.2], label: '行人' },
];
const CLS_CHART: Record<Cls, number> = { car: 0, truck: 0, ped: 1, bike: 2 };

/**
 * Planned ego path (x, z) and a speed profile: cruise, then brake to a stop before the crosswalk.
 * The lane change is complete (corridor and car body clear of the truck) before the truck's rear.
 */
const PLAN: readonly [number, number][] = [
  [5.25, -2.5],
  [5.25, -4.0],
  [4.45, -6.2],
  [2.55, -8.6],
  [1.75, -10.4],
  [1.75, -15],
  [1.75, -18.5],
  [1.75, STOP_Z + 0.4],
];

/** Step poses (landscape: a side-on diorama view, the street running left → right). */
const POSES: Record<number, CameraPose> = {
  5: { position: [16, 10.5, 9.5], target: [3, 0.8, -4.2] },
  // a near-bird's-eye view (as planners are drawn) so the tall truck does not lean over the next lane
  6: { position: [9.5, 33, -9.8], target: [1.6, 0, -11.6] },
  7: { position: [21, 18.5, 18], target: [-1, 2.8, -8.8] },
};
/** Portrait poses (authored for 4:5; `fitPortrait` undoes the host's portrait distance scaling). */
const POSES_PORT: Record<number, CameraPose> = {
  5: { position: [11.5, 13, 12.5], target: [3.4, 0.8, -4.8] },
  6: { position: [3.5, 37, 7], target: [1.5, 0, -12] },
  7: { position: [10, 23, 20], target: [0.3, 5.2, -13] },
};

/**
 * Step 7 on small landscape stages (phones show inline scenes at 4:3, about 355 px wide): a closer
 * view of the card so the four module names fit; the street and the flows rise from below.
 */
const POSE_7_SMALL: CameraPose = { position: [7.8, 13.6, 2.2], target: [-4, 5, -12] };
const SMALL_W = 640;

/** Focus per step: [cloud, sensors, boxes, plan, card]. */
const FOCUS: Record<number, readonly number[]> = {
  0: [0.8, 0.35, 0.85, 0.85, 0.8],
  5: [1, 1, 1, 0, 0], // the card is hidden: it would only peek in at the top edge
  6: [0.35, 0.1, 1, 1, 0],
  7: [0.45, 0.25, 0.5, 0.85, 1],
};

const m4 = new Matrix4();
const q = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const sc = new Vector3();

const rb = (w: number, h: number, d: number, r = 0.1) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2) * 0.99);

export function create(ctx: SceneContext): SceneInstance {
  const { scene, materials, labels, hotspots } = ctx;
  const root = new Group();
  root.name = 'physical-ai-autonomy';
  scene.add(root);
  const lights = addStudioLights(scene, ctx.palette);
  let portrait = ctx.size.portrait;
  const step = () => (ctx.step >= 5 ? ctx.step : 0);

  /* ───────── static world: one vertex-coloured mesh ───────── */
  const world = new PartsBuilder();
  const boxes: BoxObs[] = [];
  const spheres: SphereObs[] = [];
  const [x0, x1, z0, z1] = TILE;
  const tw = x1 - x0;
  const td = z1 - z0;
  const tcx = (x0 + x1) / 2;
  const tcz = (z0 + z1) / 2;
  world.add(new BoxGeometry(tw, 0.6, td), 'base', [tcx, -0.3, tcz]);
  world.add(new BoxGeometry(ROAD * 2, 0.02, td), 'asphalt', [0, 0.0, tcz]);
  for (const s of [-1, 1]) {
    // sidewalk + curb (obstacle for the lidar too)
    world.add(new BoxGeometry(WALK - ROAD, 0.15, td), 'walk', [s * (ROAD + WALK) / 2, 0.075, tcz]);
    boxes.push({ min: [s < 0 ? -WALK : ROAD, 0, z0], max: [s < 0 ? -ROAD : WALK, 0.15, z1], cls: 1 });
    world.add(new BoxGeometry(0.18, 0.16, td), 'curb', [s * (ROAD + 0.09), 0.08, tcz]);
    world.add(new BoxGeometry(x1 - WALK, 0.04, td), 'lot', [s * (WALK + x1) / 2, 0.02, tcz]);
    // edge line
    world.add(new BoxGeometry(0.14, 0.012, td), 'mark', [s * (ROAD - 0.25), 0.012, tcz]);
    // lane dashes
    for (let z = z1 - 1.5; z > z0 + 1; z -= 6) {
      if (Math.abs(z - CROSS_Z) < 3.2) continue;
      world.add(new BoxGeometry(0.14, 0.012, 3), 'mark', [s * 3.5, 0.012, z]);
    }
    // Trees (trunk + canopy) and lamp posts on the far (−x) sidewalk. The near (+x) side, between
    // the camera and the ego lane, is a cut-away: only low planters, so nothing hides the street.
    for (const z of s > 0 ? [-31] : [5.5, -4.5, -15.5, -30]) {
      const x = s * 8.9;
      world.add(new CylinderGeometry(0.14, 0.18, 2.6, 8), 'trunk', [x, 1.45, z]);
      world.add(new IcosahedronGeometry(1.45, 1), 'tree', [x, 3.55, z], [0, s, 0], [1, 0.9, 1]);
      boxes.push({ min: [x - 0.18, 0, z - 0.18], max: [x + 0.18, 2.6, z + 0.18], cls: 3 });
      spheres.push({ c: [x, 3.55, z], r: 1.35, cls: 3 });
    }
    if (s > 0) {
      for (const z of [-3.5, -10.5, -17.5]) {
        world.add(rb(1.1, 0.45, 2.4, 0.08), 'curb', [8.9, 0.15 + 0.225, z]);
        world.add(new IcosahedronGeometry(0.62, 1), 'tree', [8.9, 0.86, z - 0.5], [0, 0.4, 0], [1, 0.62, 1]);
        world.add(new IcosahedronGeometry(0.5, 1), 'tree', [8.9, 0.8, z + 0.6], [0, 1.1, 0], [1, 0.6, 1]);
        boxes.push({ min: [8.35, 0, z - 1.2], max: [9.45, 1.15, z + 1.2], cls: 3 });
      }
    }
    for (const z of s > 0 ? [-23] : [-0.5, -19]) {
      const x = s * 7.55;
      world.add(new CylinderGeometry(0.07, 0.09, 5.2, 8), 'lamp', [x, 2.75, z]);
      world.add(new BoxGeometry(1.3, 0.1, 0.22), 'lamp', [x - s * 0.6, 5.3, z]);
      boxes.push({ min: [x - 0.1, 0, z - 0.1], max: [x + 0.1, 5.3, z + 0.1], cls: 4 });
    }
  }
  // double yellow centre line
  world.add(new BoxGeometry(0.12, 0.012, td), 'yellow', [-0.12, 0.012, tcz]);
  world.add(new BoxGeometry(0.12, 0.012, td), 'yellow', [0.12, 0.012, tcz]);
  // crosswalk stripes + stop line
  for (let x = -ROAD + 0.6; x < ROAD - 0.3; x += 1.1) world.add(new BoxGeometry(0.6, 0.014, 3.6), 'mark', [x + 0.3, 0.014, CROSS_Z]);
  world.add(new BoxGeometry(ROAD - 0.3, 0.014, 0.35), 'mark', [ROAD / 2, 0.014, STOP_Z]);
  // buildings
  // A backdrop row on the far (−x) side; on the camera (+x) side only one block beyond the crosswalk.
  const bldg: readonly [number, number, number, number][] = [
    // side, zFrom, zTo, height
    [1, -27.2, -32.6, 7.5],
    [-1, 8.6, 0.5, 4.6],
    [-1, -1, -11.5, 6.4],
    [-1, -13, -21.2, 5.4],
    [-1, -27.2, -32.6, 8.6],
  ];
  for (const [s, za, zb, h] of bldg) {
    const xa = s > 0 ? 10.7 : -15.6;
    const xb = s > 0 ? 15.6 : -10.7;
    const cx = (xa + xb) / 2;
    const cz = (za + zb) / 2;
    const d = Math.abs(za - zb);
    world.add(rb(xb - xa, h, d, 0.25), 'bldg', [cx, h / 2, cz]);
    world.add(rb(xb - xa - 0.8, 0.25, d - 0.8, 0.1), 'roof', [cx, h + 0.12, cz]);
    // window bands on the street-facing side
    for (let y = 2.2; y < h - 1; y += 2.6) world.add(new BoxGeometry(0.06, 1.0, d - 1.4), 'window', [s > 0 ? xa - 0.02 : xb + 0.02, y, cz]);
    boxes.push({ min: [xa, 0, Math.min(za, zb)], max: [xb, h, Math.max(za, zb)], cls: 2 });
  }
  const worldGeo = world.build();
  ctx.track(worldGeo.geometry);
  const vMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.04 }));
  const worldMesh = new Mesh(worldGeo.geometry, vMat);
  worldMesh.matrixAutoUpdate = false;
  root.add(worldMesh);

  /* ───────── vehicles & road users ───────── */
  const carBody = new PartsBuilder()
    .add(rb(1.9, 0.72, 4.6, 0.22), 'body', [0, 0.66, 0])
    .add(rb(1.66, 0.5, 2.4, 0.2), 'glass', [0, 1.25, 0.25])
    .add(rb(1.7, 0.1, 2.05, 0.05), 'body', [0, 1.52, 0.3])
    .add(new BoxGeometry(1.5, 0.12, 0.05), 'lightF', [0, 0.82, -2.3])
    .add(new BoxGeometry(1.5, 0.12, 0.05), 'lightR', [0, 0.85, 2.3]);
  const carGeo = carBody.build();
  ctx.track(carGeo.geometry);
  const ego = new PartsBuilder()
    .add(rb(1.92, 0.74, 4.7, 0.24), 'ego', [0, 0.66, 0])
    .add(rb(1.68, 0.52, 2.45, 0.2), 'glass', [0, 1.26, 0.25])
    .add(rb(1.72, 0.1, 2.1, 0.05), 'ego', [0, 1.54, 0.3])
    .add(rb(1.2, 0.1, 1.2, 0.04), 'rack', [0, 1.63, 0.15])
    .add(new CylinderGeometry(0.3, 0.32, 0.12, 20), 'rack', [0, 1.73, 0.15])
    .add(new BoxGeometry(0.16, 0.12, 0.08), 'sensor', [0, 1.5, -0.95]) // front camera
    .add(new BoxGeometry(0.06, 0.1, 0.12), 'sensor', [-0.97, 1.32, -0.55])
    .add(new BoxGeometry(0.06, 0.1, 0.12), 'sensor', [0.97, 1.32, -0.55])
    .add(new BoxGeometry(0.4, 0.14, 0.05), 'radar', [0, 0.55, -2.36])
    .add(new BoxGeometry(1.5, 0.12, 0.05), 'lightF', [0, 0.82, -2.36])
    .add(new BoxGeometry(1.5, 0.12, 0.05), 'lightR', [0, 0.85, 2.36]);
  const egoGeo = ego.build();
  ctx.track(egoGeo.geometry);
  const egoMesh = new Mesh(egoGeo.geometry, vMat);
  egoMesh.position.copy(EGO);
  root.add(egoMesh);
  const puckGeo = new PartsBuilder()
    .add(new CylinderGeometry(0.24, 0.24, 0.26, 24), 'puck', [0, 0, 0])
    .add(new CylinderGeometry(0.245, 0.245, 0.07, 24), 'sensor', [0, 0.02, 0])
    .build();
  ctx.track(puckGeo.geometry);
  const puck = new Mesh(puckGeo.geometry, vMat);
  puck.position.set(EGO.x, LIDAR_H - 0.1, EGO.z + 0.15);
  root.add(puck);

  const cars = AGENTS.filter((a) => a.cls === 'car');
  const carMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }));
  const carMesh = new InstancedMesh(carGeo.geometry, carMat, cars.length);
  cars.forEach((a, i) => carMesh.setMatrixAt(i, m4.compose(v1.set(...a.pos), q.setFromAxisAngle(v2.set(0, 1, 0), a.dir > 0 ? Math.PI : 0), sc.set(1, 1, 1))));
  root.add(carMesh);
  ctx.track({ dispose: () => carMesh.dispose() });

  const truck = AGENTS.find((a) => a.cls === 'truck')!;
  const truckGeo = new PartsBuilder()
    .add(rb(2.35, 2.3, 2.1, 0.25), 'cab', [0, 1.5, -2.9])
    .add(rb(2.1, 0.7, 1.0, 0.15), 'glass', [0, 2.1, -3.45])
    .add(rb(2.5, 2.9, 5.6, 0.12), 'cargo', [0, 1.95, 1.0])
    .add(new BoxGeometry(2.0, 0.4, 7.6), 'chassis', [0, 0.55, -0.2])
    .build();
  ctx.track(truckGeo.geometry);
  const truckMesh = new Mesh(truckGeo.geometry, vMat);
  truckMesh.position.set(...truck.pos);
  root.add(truckMesh);

  const wheelSpots: Vector3[] = [];
  const addWheels = (c: Vector3, flip: boolean, len: number, w: number) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) wheelSpots.push(new Vector3(c.x + sx * w, 0.36, c.z + sz * len * (flip ? -1 : 1)));
  };
  addWheels(EGO, false, 1.45, 0.9);
  for (const a of cars) addWheels(new Vector3(...a.pos), a.dir > 0, 1.45, 0.9);
  addWheels(new Vector3(truck.pos[0], 0, truck.pos[2] - 0.6), false, 2.7, 1.05);
  const wheelGeo = ctx.track(new CylinderGeometry(0.36, 0.36, 0.26, 16));
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = materials.standard((p) => p.bg.clone().lerp(p.fg, p.theme === 'dark' ? 0.08 : 0.75), { roughness: 0.8, metalness: 0.05 });
  const wheels = new InstancedMesh(wheelGeo, wheelMat, wheelSpots.length);
  wheelSpots.forEach((w, i) => wheels.setMatrixAt(i, m4.makeTranslation(w.x, w.y, w.z)));
  root.add(wheels);
  ctx.track({ dispose: () => wheels.dispose() });

  // pedestrians (instanced) and a cyclist
  const peds = AGENTS.filter((a) => a.cls === 'ped');
  const pedGeo = new PartsBuilder()
    .add(new CapsuleGeometry(0.2, 0.75, 4, 10), 'ped', [0, 0.78, 0])
    .add(new SphereGeometry(0.13, 12, 10), 'skin', [0, 1.58, 0])
    .add(new CapsuleGeometry(0.08, 0.55, 3, 6), 'ped', [0.1, 0.32, 0])
    .add(new CapsuleGeometry(0.08, 0.55, 3, 6), 'ped', [-0.1, 0.32, 0])
    .build();
  ctx.track(pedGeo.geometry);
  const pedMesh = new InstancedMesh(pedGeo.geometry, vMat, peds.length);
  peds.forEach((a, i) => pedMesh.setMatrixAt(i, m4.makeTranslation(a.pos[0], a.pos[1], a.pos[2])));
  root.add(pedMesh);
  ctx.track({ dispose: () => pedMesh.dispose() });
  const bike = AGENTS.find((a) => a.cls === 'bike')!;
  const bikeGeo = new PartsBuilder()
    .add(new TorusGeometry(0.34, 0.04, 6, 20), 'tire', [0, 0.36, -0.55], [0, Math.PI / 2, 0])
    .add(new TorusGeometry(0.34, 0.04, 6, 20), 'tire', [0, 0.36, 0.55], [0, Math.PI / 2, 0])
    .add(new CylinderGeometry(0.03, 0.03, 1.1, 6), 'frame', [0, 0.62, 0], [Math.PI / 2 - 0.2, 0, 0])
    .add(new CapsuleGeometry(0.17, 0.5, 4, 8), 'ped', [0, 1.15, 0.1], [-0.35, 0, 0])
    .add(new SphereGeometry(0.13, 10, 8), 'skin', [0, 1.65, -0.08])
    .build();
  ctx.track(bikeGeo.geometry);
  const bikeMesh = new Mesh(bikeGeo.geometry, vMat);
  bikeMesh.position.set(...bike.pos);
  bikeMesh.rotation.y = Math.PI;
  root.add(bikeMesh);

  /* ───────── LiDAR point cloud (cast once) ───────── */
  const tierBeams = ctx.quality === 'high' ? 32 : ctx.quality === 'medium' ? 24 : 16;
  const tierAz = ctx.quality === 'high' ? 900 : ctx.quality === 'medium' ? 600 : 500;
  const beams = Array.from({ length: tierBeams }, (_, i) => ((-21 + (25 * i) / (tierBeams - 1)) * Math.PI) / 180);
  const agentBoxes: BoxObs[] = [];
  AGENTS.forEach((a, i) => {
    const [sx, sy, sz] = a.size;
    const lift = a.cls === 'ped' ? 0.15 : 0;
    agentBoxes.push({ min: [a.pos[0] - sx / 2 + 0.12, lift, a.pos[2] - sz / 2 + 0.15], max: [a.pos[0] + sx / 2 - 0.12, lift + sy - 0.08, a.pos[2] + sz / 2 - 0.15], cls: 10 + i });
  });
  const lidarOrigin = [EGO.x, LIDAR_H, EGO.z + 0.15] as const;
  const cloud = castCloud(
    {
      origin: lidarOrigin,
      beams,
      azSteps: tierAz,
      maxRange: 42,
      ground: TILE,
      groundCls: 0,
      boxes: [...boxes, ...agentBoxes],
      spheres,
      noise: 0.025,
    },
    ctx.rng,
  );
  // Append the first 40° again (azimuth + 2π) so a sweep window never wraps.
  const WIN = (38 * Math.PI) / 180;
  const extra = lowerBound(cloud.az, cloud.count, WIN);
  const N = cloud.count + extra;
  const cPos = new Float32Array(N * 3);
  cPos.set(cloud.positions);
  cPos.set(cloud.positions.subarray(0, extra * 3), cloud.count * 3);
  const azAll = new Float32Array(N);
  azAll.set(cloud.az);
  for (let i = 0; i < extra; i++) azAll[cloud.count + i] = cloud.az[i]! + Math.PI * 2;
  const clsAll = new Uint8Array(N);
  clsAll.set(cloud.cls);
  clsAll.set(cloud.cls.subarray(0, extra), cloud.count);
  const posAttr = new Float32BufferAttribute(cPos, 3);
  const colAttr = new Float32BufferAttribute(new Float32Array(N * 3), 3);
  const cloudGeo = ctx.track(new BufferGeometry());
  cloudGeo.setAttribute('position', posAttr);
  cloudGeo.setAttribute('color', colAttr);
  cloudGeo.setDrawRange(0, cloud.count);
  cloudGeo.computeBoundingSphere();
  const sweepGeo = ctx.track(new BufferGeometry());
  sweepGeo.setAttribute('position', posAttr);
  sweepGeo.setAttribute('color', colAttr);
  sweepGeo.boundingSphere = cloudGeo.boundingSphere;
  const dotTex = ctx.track(
    canvasTexture(32, 32, (g, w) => {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.beginPath();
      g.arc(w / 2, w / 2, w / 2 - 2, 0, Math.PI * 2);
      g.fill();
    }),
  );
  const cloudMat = ctx.track(new PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, map: dotTex, alphaTest: 0.2, toneMapped: false }));
  const sweepMat = ctx.track(new PointsMaterial({ size: 0.2, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, map: dotTex, alphaTest: 0.2, toneMapped: false }));
  const cloudPts = new Points(cloudGeo, cloudMat);
  const sweepPts = new Points(sweepGeo, sweepMat);
  cloudPts.renderOrder = 3;
  sweepPts.renderOrder = 4;
  root.add(cloudPts, sweepPts);

  /* ───────── camera frustums & radar ───────── */
  const cams: { pos: [number, number, number]; yaw: number; hfov: number; far: number }[] = [
    { pos: [0, 1.52, -1.0], yaw: 0, hfov: 0.9, far: 6.5 },
    { pos: [-0.98, 1.32, -0.55], yaw: 1.15, hfov: 1.0, far: 3 },
    { pos: [0.98, 1.32, -0.55], yaw: -1.15, hfov: 1.0, far: 3 },
    { pos: [0, 1.4, 2.3], yaw: Math.PI, hfov: 1.0, far: 2.6 },
  ];
  const frPos: number[] = [];
  const frFill = new PartsBuilder();
  for (const c of cams) {
    m4.compose(v1.set(EGO.x + c.pos[0], c.pos[1], EGO.z + c.pos[2]), q.setFromAxisAngle(v2.set(0, 1, 0), c.yaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.1)), sc.set(1, 1, 1));
    const segs = frustumSegments(c.hfov, 1.9, 0.05, c.far, false);
    for (let i = 0; i < segs.length; i += 3) {
      v1.set(segs[i]!, segs[i + 1]!, segs[i + 2]!).applyMatrix4(m4);
      frPos.push(v1.x, v1.y, v1.z);
    }
    const faces = frustumFaces(c.hfov, 1.9, c.far);
    faces.applyMatrix4(m4);
    frFill.add(faces, 'f');
  }
  const frGeo = ctx.track(new BufferGeometry());
  frGeo.setAttribute('position', new Float32BufferAttribute(frPos, 3));
  const frMat = materials.line('highlight', { transparent: true, opacity: 0.8, depthWrite: false });
  const frLines = new LineSegments(frGeo, frMat);
  frLines.renderOrder = 5;
  root.add(frLines);
  const frFillGeo = frFill.build();
  ctx.track(frFillGeo.geometry);
  const frFillMat = materials.glass('highlight', 0.05);
  const frFillMesh = new Mesh(frFillGeo.geometry, frFillMat);
  frFillMesh.renderOrder = 4;
  root.add(frFillMesh);
  const frontCamEnd = new Group();
  frontCamEnd.position.set(EGO.x + 3.7, 1.0, EGO.z - 1.8); // end of the front-right camera's view
  root.add(frontCamEnd);

  // Front radar: a narrower, longer-range fan than the cameras (kept inside the street).
  const RAD_R = 16;
  const RAD_A = 0.3;
  const radarGeo = ctx.track(new CircleGeometry(RAD_R, 36, Math.PI / 2 - RAD_A, RAD_A * 2));
  radarGeo.rotateX(-Math.PI / 2);
  const radarMat = materials.basic('coolant', { transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false });
  const radar = new Mesh(radarGeo, radarMat);
  radar.position.set(EGO.x, 0.07, EGO.z - 2.4); // drawn as a footprint on the road
  radar.renderOrder = 4;
  root.add(radar);
  const arcPos: number[] = [];
  for (const r of [5.5, 11, RAD_R]) {
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a0 = -RAD_A + (2 * RAD_A * i) / n;
      const a1 = -RAD_A + (2 * RAD_A * (i + 1)) / n;
      arcPos.push(Math.sin(a0) * r, 0.01, -Math.cos(a0) * r, Math.sin(a1) * r, 0.01, -Math.cos(a1) * r);
    }
  }
  for (const a of [-RAD_A, RAD_A]) arcPos.push(0, 0.01, 0, Math.sin(a) * RAD_R, 0.01, -Math.cos(a) * RAD_R);
  const arcGeo = ctx.track(new BufferGeometry());
  arcGeo.setAttribute('position', new Float32BufferAttribute(arcPos, 3));
  const arcMat = materials.line('coolant', { transparent: true, opacity: 0.6, depthWrite: false });
  const arcs = new LineSegments(arcGeo, arcMat);
  arcs.position.copy(radar.position);
  arcs.renderOrder = 5;
  root.add(arcs);
  const radarTip = new Group();
  radarTip.position.set(EGO.x + 0.9, 0.6, EGO.z - 6.2);
  root.add(radarTip);

  /* ───────── detection boxes ───────── */
  const boxPos: number[] = [];
  const boxSegOwner: number[] = [];
  const corners = (a: Agent) => {
    const [sx, sy, sz] = a.size;
    const [cx, , cz] = a.pos;
    const y0 = a.pos[1];
    const xs = [cx - sx / 2, cx + sx / 2];
    const ys = [y0, y0 + sy];
    const zs = [cz - sz / 2, cz + sz / 2];
    const p = (i: number, j: number, k: number) => [xs[i]!, ys[j]!, zs[k]!] as const;
    const e: [readonly [number, number, number], readonly [number, number, number]][] = [];
    for (const j of [0, 1]) for (const k of [0, 1]) e.push([p(0, j, k), p(1, j, k)]);
    for (const i of [0, 1]) for (const k of [0, 1]) e.push([p(i, 0, k), p(i, 1, k)]);
    for (const i of [0, 1]) for (const j of [0, 1]) e.push([p(i, j, 0), p(i, j, 1)]);
    // heading tick on the top face
    if (a.dir !== 0) {
      const fz = a.dir > 0 ? zs[1]! : zs[0]!;
      e.push([[cx, ys[1]!, cz], [cx, ys[1]!, fz]]);
    }
    return e;
  };
  AGENTS.forEach((a, i) => {
    for (const [p0, p1] of corners(a)) {
      boxPos.push(...p0, ...p1);
      boxSegOwner.push(i, i);
    }
  });
  const boxGeo = ctx.track(new BufferGeometry());
  boxGeo.setAttribute('position', new Float32BufferAttribute(boxPos, 3));
  boxGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((boxPos.length / 3) * 4), 4));
  const boxMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const boxLines = new LineSegments(boxGeo, boxMat);
  boxLines.renderOrder = 6;
  root.add(boxLines);
  const boxFillGeo = ctx.track(new BoxGeometry(1, 1, 1));
  const boxFillMat = ctx.track(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false }));
  const boxFill = new InstancedMesh(boxFillGeo, boxFillMat, AGENTS.length);
  boxFill.setColorAt(0, new Color());
  AGENTS.forEach((a, i) => boxFill.setMatrixAt(i, m4.compose(v1.set(a.pos[0], a.pos[1] + a.size[1] / 2, a.pos[2]), q.identity(), sc.set(...a.size))));
  boxFill.renderOrder = 5;
  root.add(boxFill);
  ctx.track({ dispose: () => boxFill.dispose() });
  const agentAz = AGENTS.map((a) => {
    let az = Math.atan2(a.pos[2] - lidarOrigin[2], a.pos[0] - lidarOrigin[0]);
    if (az < 0) az += Math.PI * 2;
    return az;
  });

  /* ───────── predicted motions (dashed, with arrowheads) ───────── */
  const predPos: number[] = [];
  const predOwner: number[] = [];
  AGENTS.forEach((a, i) => {
    if (!a.pred) return;
    const front = a.dir === 0 ? 0 : (a.size[2] / 2) * a.dir;
    const sx = a.pos[0];
    const sz = a.pos[2] + front;
    const [dx, dz] = a.pred;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const y = (a.cls === 'ped' ? 0.2 : 0.06) + 0.02;
    for (let t = 0.3; t < len - 0.6; t += 0.7) {
      const t1 = Math.min(len - 0.6, t + 0.4);
      predPos.push(sx + ux * t, y, sz + uz * t, sx + ux * t1, y, sz + uz * t1);
      predOwner.push(i, i);
    }
    const tx = sx + ux * len;
    const tz = sz + uz * len;
    for (const s of [-1, 1]) {
      predPos.push(tx, y, tz, tx - ux * 0.7 + -uz * 0.45 * s, y, tz - uz * 0.7 + ux * 0.45 * s);
      predOwner.push(i, i);
    }
  });
  const predGeo = ctx.track(new BufferGeometry());
  predGeo.setAttribute('position', new Float32BufferAttribute(predPos, 3));
  predGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((predPos.length / 3) * 4), 4));
  const predMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const predLines = new LineSegments(predGeo, predMat);
  predLines.renderOrder = 6;
  root.add(predLines);

  /* ───────── planned trajectory: ribbon + waypoints + flow ───────── */
  const planPts = PLAN.map(([x, z]) => new Vector3(x, 0.05, z));
  // Arc-length sampled centreline (Catmull-Rom through PLAN).
  const center: Vector3[] = [];
  {
    const tmp: Vector3[] = [];
    const cr = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number, out: Vector3) => {
      const t2 = t * t;
      const t3 = t2 * t;
      out.set(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.05,
        0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      );
      return out;
    };
    for (let i = 0; i < planPts.length - 1; i++) {
      const p0 = planPts[Math.max(0, i - 1)]!;
      const p1 = planPts[i]!;
      const p2 = planPts[i + 1]!;
      const p3 = planPts[Math.min(planPts.length - 1, i + 2)]!;
      for (let k = 0; k < 12; k++) tmp.push(cr(p0, p1, p2, p3, k / 12, new Vector3()));
    }
    tmp.push(planPts[planPts.length - 1]!.clone());
    center.push(...tmp);
  }
  const cum: number[] = [0];
  for (let i = 1; i < center.length; i++) cum.push(cum[i - 1]! + center[i]!.distanceTo(center[i - 1]!));
  const total = cum[cum.length - 1]!;
  const atS = (s: number, out: Vector3, dir?: Vector3) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < s) i++;
    const k = (s - cum[i - 1]!) / Math.max(1e-6, cum[i]! - cum[i - 1]!);
    out.copy(center[i - 1]!).lerp(center[i]!, Math.min(1, Math.max(0, k)));
    if (dir) dir.subVectors(center[i]!, center[i - 1]!).normalize();
    return out;
  };
  const RW = 1.0; // half width of the corridor
  const ribPos: number[] = [];
  const ribAlpha: number[] = [];
  const RS = 90;
  const dir = new Vector3();
  for (let i = 0; i <= RS; i++) {
    const s = (i / RS) * total;
    atS(s, v1, dir);
    const nx = -dir.z;
    const nz = dir.x;
    ribPos.push(v1.x + nx * RW, 0.04, v1.z + nz * RW, v1.x - nx * RW, 0.04, v1.z - nz * RW);
    const a = smooth(0, 0.06, i / RS) * (1 - 0.55 * smooth(0.75, 1, i / RS));
    ribAlpha.push(a, a);
  }
  const ribIdx: number[] = [];
  for (let i = 0; i < RS; i++) {
    const a = i * 2;
    ribIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const ribGeo = ctx.track(new BufferGeometry());
  ribGeo.setAttribute('position', new Float32BufferAttribute(ribPos, 3));
  ribGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((ribPos.length / 3) * 4), 4));
  ribGeo.setIndex(ribIdx);
  const ribMat = ctx.track(new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
  const ribbon = new Mesh(ribGeo, ribMat);
  ribbon.renderOrder = 3;
  root.add(ribbon);
  // waypoints at equal TIME steps: cruise, then brake to rest before the stop line
  const WP = 13;
  const sBrake = total * 0.55;
  const v0 = 1;
  const tCruise = sBrake / v0;
  const tBrake = (2 * (total - sBrake)) / v0;
  const T = tCruise + tBrake;
  const sAt = (t: number) => (t <= tCruise ? v0 * t : sBrake + v0 * (t - tCruise) - (v0 / (2 * tBrake)) * (t - tCruise) ** 2);
  const chev = new Shape();
  chev.moveTo(0, -0.45);
  chev.lineTo(0.55, 0.15);
  chev.lineTo(0.55, 0.42);
  chev.lineTo(0, -0.15);
  chev.lineTo(-0.55, 0.42);
  chev.lineTo(-0.55, 0.15);
  chev.closePath();
  const chevGeo = ctx.track(new ShapeGeometry(chev));
  chevGeo.rotateX(-Math.PI / 2);
  const chevMat = materials.basic('seg:physical-ai', { transparent: true, opacity: 0.95, depthWrite: false });
  const chevrons = new InstancedMesh(chevGeo, chevMat, WP);
  for (let i = 0; i < WP; i++) {
    const s = sAt(((i + 0.6) / WP) * T * 0.985);
    atS(s, v1, dir);
    // the chevron's apex is local +z: turn it to point along the direction of travel
    q.setFromAxisAngle(v2.set(0, 1, 0), Math.atan2(dir.x, dir.z));
    chevrons.setMatrixAt(i, m4.compose(v1.setY(0.06), q, sc.set(0.9, 0.9, 0.9)));
  }
  chevrons.renderOrder = 6;
  root.add(chevrons);
  ctx.track({ dispose: () => chevrons.dispose() });
  const planEnd = new Group();
  atS(total, planEnd.position);
  root.add(planEnd);
  const planMid = new Group();
  atS(total * 0.3, planMid.position);
  root.add(planMid);

  /* ───────── end-to-end card ───────── */
  // A floating glass card that faces the overview camera. By default it shows only the end-to-end
  // row (sensor input → one network → trajectory); step 7 expands it upward to reveal the modular
  // stack (感知 → 預測 → 規劃 → 控制) for comparison, with a pulse walking from module to module.
  const card = new Group();
  card.name = 'e2e';
  root.add(card);
  const CW = 9.2;
  const CH = 4.6;
  const MOD_X = [-3.45, -1.15, 1.15, 3.45] as const;
  const MOD_W = 1.45;
  const MOD_Y = 0.95;
  const E2E_Y = -0.9;
  const E2E_W = 6.6;
  const PORT_X = E2E_W / 2 + 0.62;
  const COMPACT = 0.5; // compact card height (fraction of CH), centred on the e2e row
  const frame = new Group();
  card.add(frame);
  const cardShape = roundedRect(CW, CH, 0.45);
  const cardGeo = ctx.track(new ExtrudeGeometry(cardShape, { depth: 0.12, bevelEnabled: false, curveSegments: 6 }));
  cardGeo.translate(0, 0, -0.06);
  // A frosted panel (not clear glass) so the card reads over the buildings behind it.
  const cardMat = materials.glass((p) => p.bg.clone().lerp(p.optic, p.theme === 'dark' ? 0.16 : 0.08), 0.8, { roughness: 0.6, metalness: 0 });
  const cardMesh = new Mesh(cardGeo, cardMat);
  cardMesh.renderOrder = 7;
  frame.add(cardMesh);
  const cardEdgePos: number[] = [];
  const cpts = cardShape.getPoints(8);
  for (let i = 0; i < cpts.length; i++) {
    const a = cpts[i]!;
    const b = cpts[(i + 1) % cpts.length]!;
    cardEdgePos.push(a.x, a.y, 0.07, b.x, b.y, 0.07);
  }
  const cardEdgeGeo = ctx.track(new BufferGeometry());
  cardEdgeGeo.setAttribute('position', new Float32BufferAttribute(cardEdgePos, 3));
  const cardEdgeMat = materials.line('optic', { transparent: true, opacity: 0.85 });
  const cardEdge = new LineSegments(cardEdgeGeo, cardEdgeMat);
  cardEdge.renderOrder = 8;
  frame.add(cardEdge);
  // arrows: between the modular blocks (step 7) and into / out of the network (always)
  const arrowSegs = (xa: number, xb: number, y: number, out: number[]) => {
    out.push(xa, y, 0.2, xb, y, 0.2, xb, y, 0.2, xb - 0.18, y + 0.14, 0.2, xb, y, 0.2, xb - 0.18, y - 0.14, 0.2);
  };
  const modArrowPos: number[] = [];
  for (let i = 0; i < 3; i++) arrowSegs(MOD_X[i]! + MOD_W / 2 + 0.06, MOD_X[i + 1]! - MOD_W / 2 - 0.06, MOD_Y, modArrowPos);
  const portArrowPos: number[] = [];
  arrowSegs(-CW / 2 + 0.3, -E2E_W / 2 - 0.08, E2E_Y, portArrowPos);
  arrowSegs(E2E_W / 2 + 0.08, CW / 2 - 0.3, E2E_Y, portArrowPos);
  const arrowMat = materials.line('fg', { transparent: true, opacity: 0.7 });
  const mkLines = (pos: number[]) => {
    const g = ctx.track(new BufferGeometry());
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    const l = new LineSegments(g, arrowMat);
    l.renderOrder = 8;
    card.add(l);
    return l;
  };
  const modArrows = mkLines(modArrowPos);
  mkLines(portArrowPos);
  const blockGeo = ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.12));
  const blockMat = ctx.track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1 }));
  const blocks = new InstancedMesh(blockGeo, blockMat, 5);
  blocks.instanceMatrix.setUsage(DynamicDrawUsage);
  blocks.setColorAt(0, new Color());
  blocks.renderOrder = 9;
  card.add(blocks);
  ctx.track({ dispose: () => blocks.dispose() });
  const cardIn = new Group();
  cardIn.position.set(-PORT_X, E2E_Y, 0.45);
  card.add(cardIn);
  const cardOut = new Group();
  cardOut.position.set(PORT_X, E2E_Y, 0.45);
  card.add(cardOut);
  /** 0 = compact (e2e row only), 1 = expanded with the modular row. */
  let reveal = 0;
  /** Which modular block the step-7 pulse is on (fractional; −1 = none). */
  let pulse = -1;
  const LAYOUT_CARD: Record<'land' | 'port', { pos: [number, number, number]; cam: [number, number, number]; scale: number }> = {
    land: { pos: [-6.5, 6.2, -15], cam: [21.5, 18.8, 13.8], scale: 1.45 },
    // larger and nearer on portrait stages, so the four module names fit at phone width
    port: { pos: [-1.8, 8.6, -23], cam: [13, 30, 18], scale: 1.8 },
  };
  const applyLayout = () => {
    const l = LAYOUT_CARD[portrait ? 'port' : 'land'];
    card.position.set(...l.pos);
    const dx = l.cam[0] - l.pos[0];
    const dy = l.cam[1] - l.pos[1];
    const dz = l.cam[2] - l.pos[2];
    card.rotation.order = 'YXZ';
    card.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)) * 0.55, Math.atan2(dx, dz), 0);
    card.scale.setScalar(l.scale);
    card.updateMatrixWorld(true);
  };
  applyLayout();

  /* ───────── flows: sensors → card → plan; plan particles ───────── */
  const flowPaths = (): FlowPath[] => {
    card.updateMatrixWorld(true);
    const inW = cardIn.getWorldPosition(new Vector3());
    const outW = cardOut.getWorldPosition(new Vector3());
    const through = (x: number) => card.localToWorld(new Vector3(x, E2E_Y, 0.45));
    const lid = new Vector3(EGO.x, LIDAR_H + 0.2, EGO.z + 0.15);
    const camF = new Vector3(EGO.x, 1.6, EGO.z - 1.0);
    const rad = new Vector3(EGO.x, 0.6, EGO.z - 2.4);
    const land = atS(total * 0.5, new Vector3()).setY(0.3);
    const up = (a: Vector3, b: Vector3, h: number) => a.clone().lerp(b, 0.5).add(new Vector3(0, h, 0));
    return [
      { points: [lid, up(lid, inW, 2.2), inW] },
      { points: [camF, up(camF, inW, 1.6), inW] },
      { points: [rad, up(rad, inW, 1.0), inW] },
      { points: [inW, through(-E2E_W / 4), through(E2E_W / 4), outW, up(outW, land, 1.2), land], weight: 1.4 },
    ];
  };
  const FLOW_MAX = 300;
  const makeSensorFlow = () => {
    const f = ctx.track(new PathFlow({ paths: flowPaths(), count: FLOW_MAX, size: 0.22, speed: 3.2, speedVariance: 0.2, fadeEnds: 0.05, theme: ctx.theme, seed: 9 }));
    f.setCount(scaleCount(FLOW_MAX, ctx.tier, 60));
    f.setReduced(!ctx.animate);
    f.object.renderOrder = 10;
    root.add(f.object);
    return f;
  };
  let sensorFlow = makeSensorFlow();
  const planPath: FlowPath[] = [{ points: center.filter((_, i) => i % 3 === 0).map((p) => p.clone().setY(0.16)) }];
  const PLAN_MAX = 60;
  const planFlow = ctx.track(new PathFlow({ paths: planPath, count: PLAN_MAX, size: 0.26, speed: 2.4, speedVariance: 0.1, fadeEnds: 0.08, theme: ctx.theme, seed: 3 }));
  planFlow.setCount(scaleCount(PLAN_MAX, ctx.tier, 18));
  planFlow.setReduced(!ctx.animate);
  root.add(planFlow.object);

  /* ───────── glows (hazard lights, lidar) ───────── */
  const glows = ctx.track(new GlowSprites({ count: 4, theme: ctx.theme }));
  root.add(glows.object);
  const hazards = [new Vector3(truck.pos[0] - 1.1, 1.0, truck.pos[2] + 3.85), new Vector3(truck.pos[0] + 1.1, 1.0, truck.pos[2] + 3.85)];

  /* ───────── proxies & hotspots ───────── */
  const proxyMat = ctx.track(new MeshBasicMaterial({ visible: false }));
  const proxy = (geo: BufferGeometry, pos: readonly [number, number, number], parent: Object3D = root) => {
    const m = new Mesh(ctx.track(geo), proxyMat);
    m.position.set(...pos);
    parent.add(m);
    return m;
  };
  const pLidar = proxy(new SphereGeometry(0.9, 10, 8), [EGO.x, LIDAR_H, EGO.z + 0.15]);
  const pCard = proxy(new BoxGeometry(CW, CH, 0.4), [0, 0, 0], frame);
  const cardFor = (id: string, extra: { label: string; href: string }[] = []) => () => hotspotCard(ctx, id, extra);
  const poseFor = (i: number) =>
    portrait ? fitPortrait(ctx, POSES_PORT[i]!) : i === 7 && ctx.size.width < SMALL_W ? POSE_7_SMALL : POSES[i]!;
  hotspots.register('lidar', { object: pLidar, card: cardFor('lidar'), pose: poseFor(5) });
  hotspots.register('car-cameras', { object: frFillMesh, card: cardFor('car-cameras'), pose: poseFor(5) });
  hotspots.register('radar', { object: radar, card: cardFor('radar'), pose: poseFor(5) });
  hotspots.register('detections', { object: boxFill, card: cardFor('detections', [{ label: 'SAE 自駕等級', href: '/glossary/#sae-autonomy-levels' }]), pose: poseFor(6) });
  ctx.picker.add(predLines, { id: 'trajectory' });
  hotspots.register('trajectory', {
    object: ribbon,
    anchor: planMid,
    card: cardFor('trajectory', [{ label: 'Robotaxi', href: '/glossary/#robotaxi' }]),
    pose: poseFor(6),
  });
  hotspots.register('e2e-model', { object: pCard, card: cardFor('e2e-model', [{ label: '世界模型', href: '/glossary/#world-model' }]), pose: poseFor(7) });
  crossHotspots(ctx, ['head-cameras', 'wrist-sensors', 'gripper', 'edge-computer', 'vla-model', 'action-chunk', 'joint-actuators', 'sim-twin']);

  /* ───────── labels ───────── */
  labels.setMax(22);
  interface Lbl {
    h: LabelHandle;
    steps: readonly number[];
    /** Extra condition (e.g. the card is expanded); re-checked by syncLabels(). */
    gate?: () => boolean;
    shown?: boolean;
  }
  const L: Lbl[] = [];
  const lbl = (steps: readonly number[], spec: Parameters<typeof labels.add>[0], gate?: () => boolean) => {
    const h = labels.add(spec);
    L.push({ h, steps, ...(gate ? { gate } : {}) });
    return h;
  };
  /** Show the labels of the current step (LabelHandle.set invalidates, so only on a change). */
  const syncLabels = () => {
    const s = step();
    for (const l of L) {
      const v = l.steps.includes(s) && (l.gate ? l.gate() : true);
      if (v !== l.shown) {
        l.shown = v;
        l.h.set({ visible: v });
      }
    }
  };
  const lidarLbl = lbl([0, 5], { text: '光達點雲', position: [EGO.x, LIDAR_H + 0.5, EGO.z], align: 'above', kind: 'strong', priority: 30, hotspot: 'lidar' });
  const camLbl = lbl([0, 5], { text: '環景相機', object: frontCamEnd, align: 'right', priority: 22, hotspot: 'car-cameras' });
  const radarLbl = lbl([0, 5], { text: '毫米波雷達', object: radarTip, align: 'right', priority: 20, hotspot: 'radar' });
  lbl([5], { text: '旋轉掃描', position: [EGO.x + 0.45, LIDAR_H - 0.1, EGO.z + 0.15], align: 'right', kind: 'tag', priority: 12, hotspot: 'lidar' });
  lbl([5, 6], { text: '自車', position: [EGO.x, 0.2, EGO.z + 2.6], align: 'below', kind: 'tag', priority: 14 });
  const clsLbl = AGENTS.map((a) =>
    lbl([0, 5, 6], { text: a.label, position: [a.pos[0], a.pos[1] + a.size[1] + 0.2, a.pos[2]], align: 'above', kind: 'tag', priority: 16, hotspot: 'detections' }),
  );
  const planLbl = lbl([0, 6, 7], { text: '規劃軌跡', object: planMid, position: [-1.4, 0.2, 0], align: 'left', kind: 'strong', priority: 28, hotspot: 'trajectory' });
  lbl([6], { text: '變換車道繞過貨車', object: planMid, position: [-1.4, 0.2, 0], align: 'below', offset: [0, 18], kind: 'tag', priority: 15, hotspot: 'trajectory' });
  lbl([6], { text: '減速：箭頭越密越慢', object: planEnd, position: [-1.2, 0.2, 1.4], align: 'left', kind: 'muted', priority: 18, hotspot: 'trajectory' });
  lbl([6], { text: '停止線', position: [ROAD / 2 + 1.6, 0.1, STOP_Z], align: 'right', kind: 'tag', priority: 10 });
  lbl([6], { text: '預測：穿越斑馬線', position: [2.5, 0.3, CROSS_Z - 0.4], align: 'above', kind: 'muted', priority: 17, hotspot: 'trajectory' });
  lbl([6], { text: '預測：直行', position: [-1.75, 0.2, -5.6], align: 'left', kind: 'muted', priority: 14, hotspot: 'trajectory' });
  const titleY = () => E2E_Y + (0 - E2E_Y) * reveal + (CH / 2) * (COMPACT + (1 - COMPACT) * reveal) + 0.2;
  const cardTitle = lbl([0, 7], { text: '端到端模型', object: card, position: [0, titleY(), 0], align: 'above', kind: 'strong', priority: 32, hotspot: 'e2e-model' });
  lbl([0, 7], { text: '感測器輸入', object: card, position: [-PORT_X, E2E_Y - 0.62, 0.3], align: 'below', kind: 'tag', priority: 13, hotspot: 'e2e-model' });
  lbl([0, 7], { text: '輸出軌跡', object: card, position: [PORT_X, E2E_Y - 0.62, 0.3], align: 'below', kind: 'tag', priority: 13, hotspot: 'e2e-model' });
  lbl([0, 7], { text: '單一神經網路', object: card, position: [0, E2E_Y, 0.6], align: 'center', kind: 'default', priority: 24, hotspot: 'e2e-model' });
  const modNames = ['感知', '預測', '規劃', '控制'];
  const revealed = () => reveal > 0.6;
  const modLbls = MOD_X.map((x, i) =>
    lbl([7], { text: modNames[i]!, object: card, position: [x, MOD_Y, 0.5], align: 'center', kind: 'default', priority: 22, hotspot: 'e2e-model' }, revealed),
  );
  // shortened on portrait and small stages, where the card spans most of the width
  const shortRow = () => portrait || ctx.size.width < SMALL_W;
  const modularLbl = lbl([7], { text: shortRow() ? '模組化' : '傳統：模組化', object: card, position: [-CW / 2 - 0.1, MOD_Y, 0.2], align: 'left', kind: 'muted', priority: 21 }, revealed);
  lbl([7], { text: '端到端', object: card, position: [-CW / 2 - 0.1, E2E_Y, 0.2], align: 'left', kind: 'muted', priority: 21 }, revealed);
  /** Small stages: the module names switch to the compact tag style so all four fit side by side. */
  let modCompact: boolean | null = null;
  let rowShort = shortRow();
  const fitModLabels = () => {
    const compact = portrait ? ctx.size.width < 380 : ctx.size.width < 880;
    if (compact !== modCompact) {
      modCompact = compact;
      for (const h of modLbls) h.set({ kind: compact ? 'tag' : 'default' });
    }
    if (shortRow() !== rowShort) {
      rowShort = shortRow();
      modularLbl.set({ text: rowShort ? '模組化' : '傳統：模組化' });
    }
  };
  fitModLabels();

  /* ───────── palette ───────── */
  const roles: Record<string, Color> = {};
  const clsC: Color[] = [new Color(), new Color(), new Color()];
  const cBg = new Color();
  const tmpC = new Color();
  const focus = [...(FOCUS[step()] ?? FOCUS[0]!)];
  const applyPalette = (p: Palette) => {
    const dark = p.theme === 'dark';
    lights.apply(p);
    cBg.copy(p.bg);
    const mix = (a: Color, b: Color, k: number) => a.clone().lerp(b, k);
    roles['base'] = dark ? mix(p.bg, p.fg, 0.08) : mix(p.bg, p.fg, 0.16);
    roles['asphalt'] = dark ? mix(p.bg, p.fg, 0.1) : mix(p.bg, p.fg, 0.24);
    roles['walk'] = dark ? mix(p.bg, p.fg, 0.2) : mix(p.bg, p.muted, 0.22);
    roles['curb'] = dark ? mix(p.bg, p.fg, 0.28) : mix(p.bg, p.fg, 0.3);
    roles['lot'] = dark ? mix(p.bg, p.fg, 0.06) : mix(p.bg, p.muted, 0.12);
    roles['mark'] = dark ? mix(p.bg, p.fg, 0.62) : mix(p.bg, p.fg, 0.02).multiplyScalar(1.06);
    roles['yellow'] = mix(p.power, p.bg, dark ? 0.15 : 0);
    roles['trunk'] = mix(p.muted, p.bg, 0.2);
    roles['tree'] = mix(p.seg['foundation-models'], p.bg, dark ? 0.45 : 0.15);
    roles['lamp'] = dark ? mix(p.bg, p.fg, 0.35) : mix(p.fg, p.bg, 0.45);
    roles['bldg'] = dark ? mix(p.bg, p.fg, 0.15) : mix(p.bg, p.fg, 0.04).multiplyScalar(1.04);
    roles['roof'] = dark ? mix(p.bg, p.fg, 0.22) : mix(p.bg, p.muted, 0.3);
    roles['window'] = dark ? mix(p.bg, p.flow, 0.18) : mix(p.bg, p.coolant, 0.35);
    roles['body'] = dark ? mix(p.bg, p.fg, 0.42) : mix(p.bg, p.fg, 0.1).multiplyScalar(1.03);
    roles['glass'] = dark ? mix(p.bg, p.fg, 0.05) : mix(p.fg, p.bg, 0.25);
    roles['lightF'] = p.highlight.clone();
    roles['lightR'] = p.heat.clone();
    roles['ego'] = p.seg['physical-ai'].clone();
    roles['rack'] = dark ? mix(p.bg, p.fg, 0.12) : mix(p.fg, p.bg, 0.3);
    roles['sensor'] = p.flow.clone();
    roles['radar'] = p.coolant.clone();
    roles['puck'] = dark ? mix(p.bg, p.fg, 0.2) : mix(p.fg, p.bg, 0.35);
    roles['cab'] = dark ? mix(p.bg, p.fg, 0.5) : mix(p.bg, p.fg, 0.08).multiplyScalar(1.04);
    roles['cargo'] = dark ? mix(p.bg, p.fg, 0.32) : mix(p.bg, p.muted, 0.35);
    roles['chassis'] = dark ? mix(p.bg, p.fg, 0.1) : mix(p.fg, p.bg, 0.4);
    roles['ped'] = dark ? mix(p.bg, p.fg, 0.55) : mix(p.fg, p.bg, 0.35);
    roles['skin'] = dark ? mix(p.bg, p.fg, 0.7) : mix(p.muted, p.bg, 0.2);
    roles['tire'] = dark ? mix(p.bg, p.fg, 0.4) : mix(p.fg, p.bg, 0.2);
    roles['frame'] = p.chart[2]!.clone();
    roles['f'] = p.highlight.clone();
    for (const g of [worldGeo, egoGeo, puckGeo, truckGeo, pedGeo, bikeGeo, carGeo]) g.recolor(roles);
    cars.forEach((_, i) => carMesh.setColorAt(i, tmpC.setRGB(1, 1, 1)));
    if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
    clsC[0]!.copy(p.chart[0]!);
    clsC[1]!.copy(p.chart[1]!);
    clsC[2]!.copy(p.chart[2]!);
    // cloud colours: by class (objects take their detection colour), else by height
    const ca = colAttr.array as Float32Array;
    const low = dark ? mix(p.flow, p.bg, 0.3) : mix(p.flow, p.fg, 0.15);
    const high = dark ? mix(p.flow, p.fg, 0.55) : mix(p.coolant, p.fg, 0.25);
    for (let i = 0; i < N; i++) {
      const c = clsAll[i]!;
      if (c >= 10) {
        const a = AGENTS[c - 10]!;
        tmpC.copy(clsC[CLS_CHART[a.cls]]!);
        if (dark) tmpC.lerp(p.fg, 0.2);
      } else if (c === 0) tmpC.copy(low);
      else tmpC.copy(low).lerp(high, Math.min(1, cPos[i * 3 + 1]! / 6) * 0.8 + 0.2);
      ca[i * 3] = tmpC.r;
      ca[i * 3 + 1] = tmpC.g;
      ca[i * 3 + 2] = tmpC.b;
    }
    colAttr.needsUpdate = true;
    // boxes & predictions
    const bc = boxGeo.getAttribute('color') as Float32BufferAttribute;
    for (let i = 0; i < boxSegOwner.length; i++) {
      const c = clsC[CLS_CHART[AGENTS[boxSegOwner[i]!]!.cls]]!;
      bc.setXYZW(i, c.r, c.g, c.b, 1);
    }
    bc.needsUpdate = true;
    AGENTS.forEach((a, i) => boxFill.setColorAt(i, clsC[CLS_CHART[a.cls]]!));
    if (boxFill.instanceColor) boxFill.instanceColor.needsUpdate = true;
    const pc = predGeo.getAttribute('color') as Float32BufferAttribute;
    for (let i = 0; i < predOwner.length; i++) {
      const c = clsC[CLS_CHART[AGENTS[predOwner[i]!]!.cls]]!;
      pc.setXYZW(i, c.r, c.g, c.b, 1);
    }
    pc.needsUpdate = true;
    const rose = p.seg['physical-ai'];
    const rc = ribGeo.getAttribute('color') as Float32BufferAttribute;
    for (let i = 0; i < ribAlpha.length; i++) rc.setXYZW(i, rose.r, rose.g, rose.b, ribAlpha[i]! * (dark ? 0.36 : 0.32));
    rc.needsUpdate = true;
    sensorFlow.recolor((i) => (i < 3 ? [p.flow, p.highlight, p.coolant][i]! : [p.optic, p.optic, p.optic, rose, rose, rose]));
    sensorFlow.setTheme(p.theme);
    sensorFlow.setSize(dark ? 0.24 : 0.2);
    planFlow.recolor(() => p.seg['physical-ai']);
    planFlow.setTheme(p.theme);
    planFlow.setSize(dark ? 0.3 : 0.24);
    glows.setTheme(p.theme);
    cloudMat.size = dark ? 0.17 : 0.15;
    sweepMat.size = dark ? 0.28 : 0.24;
    lidarLbl.set({ swatch: p.css['scene-flow'] ?? '' });
    camLbl.set({ swatch: p.css['scene-highlight'] ?? '' });
    radarLbl.set({ swatch: p.css['scene-coolant'] ?? '' });
    planLbl.set({ swatch: p.css['seg-physical-ai'] ?? '' });
    cardTitle.set({ swatch: p.css['scene-optic'] ?? '' });
    AGENTS.forEach((a, i) => clsLbl[i]!.set({ swatch: p.css[`chart-${CLS_CHART[a.cls] + 1}`] ?? '' }));
    paintBlocks();
  };

  /** Card frame (compact ↔ expanded) and the title position. Called when `reveal` changes. */
  const paintCard = () => {
    frame.position.y = E2E_Y * (1 - reveal);
    frame.scale.y = COMPACT + (1 - COMPACT) * reveal;
    modArrows.visible = reveal > 0.5;
    cardTitle.set({ position: [0, titleY(), 0] });
    syncLabels();
    paintBlocks();
  };

  /** Block transforms and colours: the modular row pops in with `reveal`; `pulse` lights one module. */
  const paintBlocks = () => {
    const p = ctx.palette;
    const dark = p.theme === 'dark';
    blocks.setMatrixAt(4, m4.compose(v1.set(0, E2E_Y, 0.15), q.identity(), sc.set(E2E_W, 1.05, 0.42)));
    blocks.setColorAt(4, tmpC.copy(p.optic).lerp(p.bg, dark ? 0.1 : 0));
    const k = easeInOut(Math.min(1, Math.max(0, (reveal - 0.25) / 0.75)));
    MOD_X.forEach((x, i) => {
      const s = k < 0.01 ? 0 : k;
      blocks.setMatrixAt(i, m4.compose(v1.set(x, MOD_Y, 0.15), q.identity(), sc.set(MOD_W * s, 0.8 * s, 0.32 * s)));
      const lit = pulse < 0 ? 0 : Math.max(0, 1 - Math.abs(pulse - i) * 1.6);
      tmpC.copy(dark ? p.bg : p.bg).lerp(p.fg, dark ? 0.5 : 0.2).lerp(p.optic, 0.15 + 0.6 * lit);
      blocks.setColorAt(i, tmpC);
    });
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  };

  /* ───────── layout ───────── */
  const rebuildFlows = () => {
    root.remove(sensorFlow.object);
    sensorFlow.dispose();
    sensorFlow = makeSensorFlow();
    applyPalette(ctx.palette);
    applyFocus();
  };

  /* ───────── focus & animation ───────── */
  let sweepA = 0.6;
  const applyFocus = () => {
    const [fc, fs, fb, fp, fk] = focus as [number, number, number, number, number];
    const dark = ctx.theme === 'dark';
    cloudMat.opacity = (ctx.animate ? (dark ? 0.5 : 0.55) : dark ? 0.85 : 0.85) * (0.25 + 0.75 * fc);
    sweepMat.opacity = fc;
    sweepPts.visible = ctx.animate && fc > 0.05;
    frMat.opacity = (dark ? 0.5 : 0.6) * fs;
    frFillMat.opacity = (dark ? 0.05 : 0.045) * fs;
    frLines.visible = frFillMesh.visible = fs > 0.03;
    radarMat.opacity = (dark ? 0.16 : 0.2) * fs;
    arcMat.opacity = 0.8 * fs;
    radar.visible = arcs.visible = fs > 0.03;
    boxMat.opacity = 0.95 * fb;
    boxFillMat.opacity = (dark ? 0.1 : 0.12) * fb;
    predMat.opacity = 0.95 * Math.max(0, fp * 1.2 - 0.2) * fb;
    ribMat.opacity = 0.08 + 0.92 * fp;
    chevMat.opacity = 0.95 * fp;
    planFlow.setOpacity(fp);
    const fo = fk;
    sensorFlow.setOpacity(fo);
    sensorFlow.object.visible = fo > 0.3;
    card.visible = fk > 0.02; // hidden in the top-down planning view
    cardMat.opacity = (dark ? 0.78 : 0.82) * (0.55 + 0.45 * fk);
    cardEdgeMat.opacity = 0.85 * (0.4 + 0.6 * fk);
    blockMat.opacity = 0.96;
  };
  const updateSweep = (t: number) => {
    if (!sweepPts.visible) return;
    sweepA = (t * 2.1) % (Math.PI * 2);
    const i0 = lowerBound(azAll, N, sweepA);
    const i1 = lowerBound(azAll, N, sweepA + WIN);
    sweepGeo.setDrawRange(i0, Math.max(0, i1 - i0));
    puck.rotation.y = -(sweepA + WIN);
    // boxes flash as the sweep passes over their object
    const bc = boxGeo.getAttribute('color') as Float32BufferAttribute;
    let dirty = false;
    AGENTS.forEach((_, ai) => {
      let d = sweepA + WIN - agentAz[ai]!;
      d = ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const flash = d < 1.2 ? 1 - d / 1.2 : 0;
      const a = 0.55 + 0.45 * flash;
      for (let i = 0; i < boxSegOwner.length; i++) {
        if (boxSegOwner[i] !== ai) continue;
        if (bc.getW(i) !== a) {
          bc.setW(i, a);
          dirty = true;
        }
      }
    });
    if (dirty) bc.needsUpdate = true;
  };
  const updateHazard = (t: number) => {
    const on = ctx.animate ? (Math.sin(t * 5) > 0 ? 1 : 0.15) : 1;
    const dark = ctx.theme === 'dark';
    hazards.forEach((h, i) => glows.set(i, h, dark ? 1.1 : 0.8, ctx.palette.power, on * (dark ? 0.9 : 0.7)));
    glows.set(2, v1.set(EGO.x, LIDAR_H + 0.05, EGO.z + 0.15), 1.3, ctx.palette.flow, (dark ? 0.6 : 0.35) * focus[0]!);
    glows.set(3, planEnd.position, 1.4, ctx.palette.seg['physical-ai'], (dark ? 0.5 : 0.35) * focus[3]!);
  };

  let focusTween: { cancel(): void } | null = null;
  let revealTween: { cancel(): void } | null = null;
  const setFocus = (i: number, instant: boolean) => {
    focusTween?.cancel();
    const from = [...focus];
    const to = FOCUS[i] ?? FOCUS[0]!;
    const apply = (k: number) => {
      for (let j = 0; j < focus.length; j++) focus[j] = from[j]! + (to[j]! - from[j]!) * k;
      applyFocus();
    };
    if (instant) apply(1);
    else focusTween = ctx.tween.run(apply, { duration: 650, ease: 'cubicInOut', fade: true });
  };
  /** Expand the card (step 7) or fold it back to the end-to-end row. */
  const setReveal = (i: number, instant: boolean) => {
    revealTween?.cancel();
    const to = i === 7 ? 1 : 0;
    if (!ctx.animate) pulse = -1;
    if (instant || !ctx.animate || reveal === to) {
      reveal = to;
      paintCard();
      return;
    }
    const from = reveal;
    revealTween = ctx.tween.run(
      (k) => {
        reveal = from + (to - from) * k;
        paintCard();
      },
      { duration: 900, ease: 'cubicInOut' },
    );
  };
  /** Step-7 pulse through the modular stack: 感知 → 預測 → 規劃 → 控制, then a pause. */
  const updatePulse = (t: number) => {
    if (step() !== 7 || reveal < 0.99 || !ctx.animate) {
      if (pulse !== -1) {
        pulse = -1;
        paintBlocks();
      }
      return;
    }
    const u = (t * 0.9) % 5.5;
    pulse = u < 4.4 ? u - 0.2 : -1;
    paintBlocks();
  };

  applyPalette(ctx.palette);
  setFocus(step(), true);
  setReveal(step(), true);
  syncLabels();
  updateHazard(0);
  updateSweep(0);

  return {
    update(_dt, t) {
      updateSweep(t);
      updateHazard(t);
      updatePulse(t);
      sensorFlow.update(t);
      planFlow.update(t);
    },
    setStep(i) {
      const s = i >= 5 ? i : 0;
      setFocus(s, false);
      setReveal(s, false);
      syncLabels();
      ctx.setPose(s > 0 ? poseFor(s) : ctx.homePose);
    },
    onMotion(animate) {
      sensorFlow.setReduced(!animate);
      planFlow.setReduced(!animate);
      applyFocus();
      if (!animate) {
        pulse = -1;
        paintBlocks();
      }
      updateHazard(0);
    },
    onQuality(_q, tier) {
      sensorFlow.setCount(scaleCount(FLOW_MAX, tier, 60));
      planFlow.setCount(scaleCount(PLAN_MAX, tier, 18));
    },
    onPalette(p) {
      applyPalette(p);
      applyFocus();
      updateHazard(0);
    },
    onResize(size) {
      const next = size.portrait;
      if (next !== portrait) {
        portrait = next;
        applyLayout();
        rebuildFlows();
      }
      fitModLabels();
    },
    dispose() {
      focusTween?.cancel();
      revealTween?.cancel();
      root.removeFromParent();
      lights.group.removeFromParent();
    },
  };
}

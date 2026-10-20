/**
 * agent-loop: builders for the static diorama (floor, core, loop track, guardrail, MCP servers,
 * long-term memory store, context tray). Everything is procedural; repeated parts are instanced
 * and decorative parts merged so the whole scene stays around 30 draw calls.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneContext } from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import {
  BRAIN_R,
  BRAIN_Y,
  COLLAR_Y,
  DEG,
  GATE,
  GUARD_H,
  MEMORY_PHI,
  MEMORY_R,
  R_COLLAR,
  R_FLOOR,
  R_GUARD,
  serverR,
  R_TRACK,
  SERVER,
  SERVER_TOP,
  SHELL_R,
  TOOLS,
  TRAY,
  TRAY_W,
  polar,
  stationPhi,
} from './layout';

/* ───────────────────────── geometry helpers ───────────────────────── */

interface Part {
  geo: BufferGeometry;
  m: Matrix4;
  /** Group id for later per-group recolouring (vertex colours). */
  g?: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _e = new Object3D();

/** Matrix from position, Euler (radians) and uniform/non-uniform scale. */
function mat(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): Matrix4 {
  _e.position.set(x, y, z);
  _e.rotation.set(rx, ry, rz);
  _e.scale.set(sx, sy, sz);
  _e.updateMatrix();
  return _e.matrix.clone();
}

/** Merge parts into one non-indexed geometry (positions + normals, optional vertex colours). */
export function mergeParts(parts: readonly Part[], withColor = false): { geometry: BufferGeometry; ranges: Map<number, [number, number][]> } {
  const pos: number[] = [];
  const nor: number[] = [];
  const ranges = new Map<number, [number, number][]>();
  const nm = new Matrix3();
  const v = new Vector3();
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    nm.getNormalMatrix(p.m);
    const start = pos.length / 3;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(p.m);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
    }
    const id = p.g ?? 0;
    const list = ranges.get(id) ?? [];
    list.push([start, P.count]);
    ranges.set(id, list);
    if (g !== p.geo) g.dispose();
  }
  for (const p of parts) p.geo.dispose();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  if (withColor) geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  geometry.computeBoundingSphere();
  return { geometry, ranges };
}

/** Recolour the vertex ranges of one merge group. */
export function paintGroup(geometry: BufferGeometry, ranges: Map<number, [number, number][]>, id: number, c: Color): void {
  const attr = geometry.getAttribute('color') as Float32BufferAttribute | undefined;
  if (!attr) return;
  for (const [start, count] of ranges.get(id) ?? []) for (let i = start; i < start + count; i++) attr.setXYZ(i, c.r, c.g, c.b);
  attr.needsUpdate = true;
}

/**
 * Facet normals baked into the geometry (PolyhedronGeometry is non-indexed), so a faceted look
 * does not need `flatShading` (one shader program fewer to compile at mount).
 */
function facetted(g: BufferGeometry): BufferGeometry {
  g.computeVertexNormals();
  return g;
}

function instanced(geo: BufferGeometry, mat: MeshStandardMaterial | MeshBasicMaterial, count: number, ctx: SceneContext): InstancedMesh {
  const m = new InstancedMesh(geo, mat, count);
  m.setColorAt(0, new Color());
  ctx.track({ dispose: () => m.dispose() });
  return m;
}

/* ───────────────────────── floor ───────────────────────── */

export function buildFloor(ctx: SceneContext) {
  const group = new Group();
  // The floor is drawn first and writes no depth: every other part stands on or above it (the
  // camera never goes below the floor), and camera-facing halos near the floor (the task token,
  // the stations, the gate flashes) are then not sliced by the floor plane in a hard edge.
  const discMat = ctx.track(new MeshStandardMaterial({ roughness: 0.92, metalness: 0, depthWrite: false }));
  const disc = new Mesh(ctx.track(new CylinderGeometry(R_FLOOR, R_FLOOR + 0.08, 0.14, 128, 1)), discMat);
  disc.position.y = -0.07;
  disc.renderOrder = -1;
  group.add(disc);

  // Polar grid: concentric rings + spokes, alpha fading toward the rim.
  const pos: number[] = [];
  const fade: number[] = [];
  const push = (x: number, z: number) => {
    pos.push(x, 0.003, z);
    const r = Math.hypot(x, z) / R_FLOOR;
    fade.push(Math.max(0, 1 - r * r) ** 1.4);
  };
  for (let r = 0.9; r < R_FLOOR; r += 0.9) {
    const n = Math.round(r * 40);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      push(r * Math.sin(a0), r * Math.cos(a0));
      push(r * Math.sin(a1), r * Math.cos(a1));
    }
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    for (let s = 0; s < 10; s++) {
      const r0 = 0.9 + ((R_FLOOR - 0.9) * s) / 10;
      const r1 = 0.9 + ((R_FLOOR - 0.9) * (s + 1)) / 10;
      push(r0 * Math.sin(a), r0 * Math.cos(a));
      push(r1 * Math.sin(a), r1 * Math.cos(a));
    }
  }
  const gridGeo = ctx.track(new BufferGeometry());
  gridGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  gridGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const grid = new LineSegments(gridGeo, gridMat);
  group.add(grid);

  const shadowMat = ctx.track(new MeshBasicMaterial({ map: ctx.track(radialTexture(128)), transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(4.2, 4.2)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.006;
  group.add(shadow);

  return {
    group,
    discMat,
    shadowMat,
    recolorGrid(c: Color, alpha: number) {
      const attr = gridGeo.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}

/* ───────────────────────── core: pedestal, brain, MCP collar ───────────────────────── */

export function buildCore(ctx: SceneContext) {
  const group = new Group();
  const pedestalMat = ctx.track(new MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 }));
  const pedestal = new Mesh(ctx.track(new CylinderGeometry(0.5, 0.64, 0.5, 64)), pedestalMat);
  pedestal.position.y = 0.25;
  group.add(pedestal);

  const brain = new Group();
  brain.position.set(0, BRAIN_Y, 0);
  group.add(brain);
  const coreMat = ctx.track(new MeshStandardMaterial({ roughness: 0.32, metalness: 0.18 }));
  const core = new Mesh(ctx.track(facetted(new IcosahedronGeometry(BRAIN_R, 2))), coreMat);
  brain.add(core);
  const wireMat = ctx.track(new LineBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
  const ico = new IcosahedronGeometry(0.5, 1);
  const wire = new LineSegments(ctx.track(new EdgesGeometry(ico)), wireMat);
  ico.dispose();
  brain.add(wire);
  const shellMat = ctx.materials.glass('accent', 0.1, { roughness: 0.15, metalness: 0.1 });
  const shell = new Mesh(ctx.track(new SphereGeometry(SHELL_R, 48, 32)), shellMat);
  shell.renderOrder = 4;
  brain.add(shell);

  const collarMat = ctx.materials.basic('flow');
  const collar = new Mesh(ctx.track(new TorusGeometry(R_COLLAR, 0.032, 10, 96)), collarMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = COLLAR_Y;
  group.add(collar);
  const portMat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
  const ports = instanced(ctx.track(new RoundedBoxGeometry(0.15, 0.11, 0.1, 2, 0.025)), portMat, TOOLS.length, ctx);
  TOOLS.forEach((t, i) => {
    polar(R_COLLAR + 0.01, t.phi, COLLAR_Y, _p);
    ports.setMatrixAt(i, _m.compose(_p, _q.setFromAxisAngle(_s.set(0, 1, 0), t.phi * DEG), _s.set(1, 1, 1)));
  });
  group.add(ports);

  return { group, pedestal, pedestalMat, brain, core, coreMat, wire, wireMat, shell, collar, ports };
}

/* ───────────────────────── loop track ───────────────────────── */

export function buildTrack(ctx: SceneContext) {
  const group = new Group();
  const trackMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.3 }));
  const track = new Mesh(ctx.track(new TorusGeometry(R_TRACK, 0.03, 8, 180)), trackMat);
  track.rotation.x = Math.PI / 2;
  track.position.y = 0.035;
  group.add(track);

  const stationMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 }));
  const stations = instanced(ctx.track(new CylinderGeometry(0.2, 0.22, 0.08, 40)), stationMat, 4, ctx);
  for (let i = 0; i < 4; i++) stations.setMatrixAt(i, _m.makeTranslation(polar(R_TRACK, stationPhi(i), 0.045, _p)));
  group.add(stations);

  // Flat chevrons pointing along the loop direction (decreasing φ), two between each pair of stations.
  const shape = new Shape();
  shape.moveTo(-0.11, -0.09);
  shape.lineTo(0.0, 0.0);
  shape.lineTo(-0.11, 0.09);
  shape.lineTo(-0.07, 0.0);
  shape.closePath();
  const chevGeo = ctx.track(new ExtrudeGeometry(shape, { depth: 0.018, bevelEnabled: false }));
  chevGeo.rotateX(-Math.PI / 2); // shape x → world x, shape y → world -z
  const chevrons = instanced(chevGeo, trackMat, 8, ctx);
  let c = 0;
  for (let i = 0; i < 4; i++) {
    for (const f of [0.36, 0.64]) {
      const phi = stationPhi(i) - 90 * f;
      polar(R_TRACK, phi, 0.03, _p);
      // Direction of travel (decreasing φ) = (-cos φ, 0, sin φ). Rotate local +x onto it.
      const a = phi * DEG;
      const yaw = Math.atan2(-Math.sin(a), -Math.cos(a));
      chevrons.setMatrixAt(c++, _m.compose(_p, _q.setFromAxisAngle(_s.set(0, 1, 0), yaw), _s.set(1, 1, 1)));
    }
  }
  group.add(chevrons);

  const tokenMat = ctx.track(new MeshStandardMaterial({ roughness: 0.25, metalness: 0.1 }));
  const token = new Mesh(ctx.track(new SphereGeometry(0.105, 28, 18)), tokenMat);
  group.add(token);

  return { group, track, trackMat, stations, stationMat, chevrons, token, tokenMat };
}

/* ───────────────────────── guardrail ring + gates ───────────────────────── */

export function buildGuard(ctx: SceneContext) {
  const group = new Group();
  const bandMat = ctx.track(
    new MeshStandardMaterial({ transparent: true, opacity: 0.12, depthWrite: false, roughness: 0.2, metalness: 0.1, side: DoubleSide }),
  );
  const band = new Mesh(ctx.track(new CylinderGeometry(R_GUARD, R_GUARD, GUARD_H, 180, 1, true)), bandMat);
  band.position.y = GUARD_H / 2;
  band.renderOrder = 3;
  group.add(band);

  // Top and bottom rails plus short vertical ribs: a light "fence".
  const pos: number[] = [];
  const n = 180;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    for (const y of [0.004, GUARD_H]) pos.push(R_GUARD * Math.sin(a0), y, R_GUARD * Math.cos(a0), R_GUARD * Math.sin(a1), y, R_GUARD * Math.cos(a1));
    if (i % 3 === 0) pos.push(R_GUARD * Math.sin(a0), 0.004, R_GUARD * Math.cos(a0), R_GUARD * Math.sin(a0), GUARD_H, R_GUARD * Math.cos(a0));
  }
  const railGeo = ctx.track(new BufferGeometry());
  railGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const railMat = ctx.track(new LineBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
  const rails = new LineSegments(railGeo, railMat);
  group.add(rails);

  // Checkpoint: a slim post from the floor through the band, carrying a vertical ring (plus a fine
  // inner ring) that faces the radial direction (local z), so radial arcs pass through its centre.
  const { geometry: gateGeo } = mergeParts([
    { geo: new CylinderGeometry(0.07, 0.085, 0.04, 20), m: mat(0, 0.02, 0) },
    { geo: new CylinderGeometry(0.022, 0.028, GATE.cy - GATE.r, 10), m: mat(0, (GATE.cy - GATE.r) / 2, 0) },
    { geo: new TorusGeometry(GATE.r, GATE.tube, 10, 56), m: mat(0, GATE.cy, 0) },
    { geo: new TorusGeometry(GATE.r - 0.05, 0.008, 6, 56), m: mat(0, GATE.cy, 0) },
    { geo: new BoxGeometry(0.1, 0.05, 0.06), m: mat(0, GUARD_H, 0) },
  ]);
  ctx.track(gateGeo);
  const gateMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.2 }));
  const gates = instanced(gateGeo, gateMat, TOOLS.length, ctx);
  TOOLS.forEach((t, i) => gates.setMatrixAt(i, _m.compose(polar(R_GUARD, t.phi, 0, _p), _q.setFromAxisAngle(_s.set(0, 1, 0), t.phi * DEG), _s.set(1, 1, 1))));
  group.add(gates);

  return { group, band, bandMat, rails, railMat, gates, gateMat };
}

/* ───────────────────────── MCP servers ───────────────────────── */

/** Monochrome emblem for each tool, built around the origin (y up, facing +z). */
function emblemParts(index: number): Part[] {
  const out: Part[] = [];
  const add = (geo: BufferGeometry, m: Matrix4) => out.push({ geo, m });
  switch (TOOLS[index]?.id) {
    case 'tool-search': {
      add(new TorusGeometry(0.13, 0.032, 10, 36), mat(-0.04, 0.24, 0));
      add(new CylinderGeometry(0.03, 0.03, 0.17, 10), mat(0.1, 0.085, 0, 0, 0, Math.PI / 4));
      break;
    }
    case 'tool-code': {
      // "</>"
      const arm = (x: number, y: number, rz: number) => add(new BoxGeometry(0.13, 0.034, 0.05), mat(x, y, 0, 0, 0, rz));
      arm(-0.155, 0.215, Math.PI / 6);
      arm(-0.155, 0.145, -Math.PI / 6);
      arm(0.155, 0.215, -Math.PI / 6);
      arm(0.155, 0.145, Math.PI / 6);
      add(new BoxGeometry(0.034, 0.3, 0.05), mat(0, 0.18, 0, 0, 0, -0.35));
      break;
    }
    case 'tool-database': {
      for (let i = 0; i < 3; i++) add(new CylinderGeometry(0.15, 0.15, 0.075, 32), mat(0, 0.05 + i * 0.1, 0));
      break;
    }
    case 'tool-browser': {
      // A window frame with a title bar, on a small stand.
      add(new BoxGeometry(0.44, 0.03, 0.035), mat(0, 0.1, 0));
      add(new BoxGeometry(0.44, 0.07, 0.035), mat(0, 0.355, 0));
      add(new BoxGeometry(0.03, 0.29, 0.035), mat(-0.205, 0.245, 0));
      add(new BoxGeometry(0.03, 0.29, 0.035), mat(0.205, 0.245, 0));
      add(new BoxGeometry(0.05, 0.08, 0.03), mat(0, 0.045, 0));
      add(new BoxGeometry(0.2, 0.02, 0.1), mat(0, 0.01, 0));
      // Cursor arrow inside the window (computer use).
      add(new CylinderGeometry(0, 0.05, 0.11, 3), mat(0.03, 0.215, 0.01, 0, 0, Math.PI * 0.2, 1, 1, 0.4));
      break;
    }
    case 'tool-files': {
      add(new BoxGeometry(0.38, 0.25, 0.03), mat(0, 0.155, -0.03));
      add(new BoxGeometry(0.14, 0.05, 0.03), mat(-0.12, 0.29, -0.03));
      add(new BoxGeometry(0.32, 0.2, 0.025), mat(0.01, 0.2, -0.005, 0, 0, 0.0));
      add(new BoxGeometry(0.38, 0.2, 0.03), mat(0, 0.12, 0.025, -0.18, 0, 0));
      break;
    }
    default:
  }
  return out;
}

export function buildServers(ctx: SceneContext) {
  const group = new Group();
  const n = TOOLS.length;
  const padMat = ctx.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.15 }));
  const pads = instanced(ctx.track(new CylinderGeometry(0.52, 0.57, SERVER.padY, 6)), padMat, n, ctx);
  const bodyMat = ctx.track(new MeshStandardMaterial({ roughness: 0.42, metalness: 0.25 }));
  const bodies = instanced(ctx.track(new RoundedBoxGeometry(SERVER.w, SERVER.h, SERVER.d, 3, 0.07)), bodyMat, n, ctx);
  const ledMat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
  const leds = instanced(ctx.track(new BoxGeometry(0.42, 0.045, 0.02)), ledMat, n * 4, ctx);
  const up = new Vector3(0, 1, 0);
  const parts: Part[] = [];
  const proxies: Mesh[] = [];
  const proxyGeo = ctx.track(new BoxGeometry(1.0, 1.55, 1.0));
  const proxyMat = ctx.track(new MeshBasicMaterial());
  proxyMat.visible = false;
  TOOLS.forEach((t, i) => {
    const yaw = t.phi * DEG;
    polar(serverR(t.phi), t.phi, SERVER.padY / 2, _p);
    pads.setMatrixAt(i, _m.compose(_p, _q.setFromAxisAngle(up, yaw + Math.PI / 6), _s.set(1, 1, 1)));
    polar(serverR(t.phi), t.phi, SERVER.padY + SERVER.h / 2, _p);
    bodies.setMatrixAt(i, _m.compose(_p, _q.setFromAxisAngle(up, yaw), _s.set(1, 1, 1)));
    // Two status strips on the inward face (toward the agent) and two on the outward face.
    for (let r = 0; r < 4; r++) {
      const side = r < 2 ? -1 : 1;
      polar(serverR(t.phi) + side * (SERVER.d / 2 + 0.006), t.phi, SERVER.padY + 0.5 + (r % 2) * 0.1, _p);
      leds.setMatrixAt(i * 4 + r, _m.compose(_p, _q.setFromAxisAngle(up, yaw), _s.set(1, 1, 1)));
    }
    // Emblem on top, facing the default camera (+z).
    polar(serverR(t.phi), t.phi, SERVER_TOP + 0.02, _p);
    const base = mat(_p.x, _p.y, _p.z);
    for (const part of emblemParts(i)) parts.push({ geo: part.geo, m: base.clone().multiply(part.m), g: i });
    const proxy = new Mesh(proxyGeo, proxyMat);
    proxy.position.copy(polar(serverR(t.phi), t.phi, 0.78));
    proxy.rotation.y = yaw;
    proxy.name = t.id;
    proxies.push(proxy);
    group.add(proxy);
  });
  const { geometry: emblemGeo, ranges } = mergeParts(parts, true);
  ctx.track(emblemGeo);
  const emblemMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.2 }));
  const emblems = new Mesh(emblemGeo, emblemMat);
  group.add(pads, bodies, leds, emblems);
  return { group, pads, padMat, bodies, bodyMat, leds, emblems, emblemGeo, emblemRanges: ranges, proxies };
}

/* ───────────────────────── long-term memory store ───────────────────────── */

export function buildMemoryStore(ctx: SceneContext) {
  const group = new Group();
  polar(MEMORY_R, MEMORY_PHI, 0, group.position);
  // A plinth and five thin platters (a "record store"), inside a glass sleeve.
  const parts: Part[] = [{ geo: new CylinderGeometry(0.36, 0.4, 0.06, 48), m: mat(0, 0.03, 0) }];
  for (let i = 0; i < 5; i++) parts.push({ geo: new CylinderGeometry(0.25, 0.25, 0.045, 48), m: mat(0, 0.11 + i * 0.085, 0) });
  parts.push({ geo: new CylinderGeometry(0.05, 0.05, 0.42, 16), m: mat(0, 0.27, 0) });
  const { geometry } = mergeParts(parts);
  ctx.track(geometry);
  const diskMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.3 }));
  const disks = new Mesh(geometry, diskMat);
  group.add(disks);
  const glassMat = ctx.materials.glass('seg:memory-storage', 0.1, { roughness: 0.2 });
  const glass = new Mesh(ctx.track(new CylinderGeometry(0.31, 0.31, 0.5, 48, 1, true)), glassMat);
  glass.position.y = 0.31;
  glass.renderOrder = 4;
  group.add(glass);
  const capMat = ctx.materials.line('seg:memory-storage', { transparent: true, opacity: 0.8 });
  const capPts: number[] = [];
  for (let i = 0; i < 48; i++) {
    const a0 = (i / 48) * Math.PI * 2;
    const a1 = ((i + 1) / 48) * Math.PI * 2;
    for (const y of [0.06, 0.56]) capPts.push(0.31 * Math.sin(a0), y, 0.31 * Math.cos(a0), 0.31 * Math.sin(a1), y, 0.31 * Math.cos(a1));
  }
  const capGeo = ctx.track(new BufferGeometry());
  capGeo.setAttribute('position', new Float32BufferAttribute(capPts, 3));
  const caps = new LineSegments(capGeo, capMat);
  group.add(caps);
  return { group, disks, diskMat, glass, glassMat, capMat };
}

/* ───────────────────────── context tray (上下文視窗) ───────────────────────── */

export const TRAY_CAPACITY = 20;

export function buildTray(ctx: SceneContext) {
  const group = new Group();
  group.position.set(0, TRAY.y, TRAY.z);
  const glassMat = ctx.materials.glass('fg', 0.06, { roughness: 0.15 });
  const glass = new Mesh(ctx.track(new RoundedBoxGeometry(TRAY_W + 0.16, 0.28, 0.28, 2, 0.06)), glassMat);
  glass.renderOrder = 4;
  group.add(glass);

  // Frame edges, slot ticks and the tether down to the brain.
  const pos: number[] = [];
  const hw = TRAY_W / 2 + 0.08;
  const h = 0.14;
  const d = 0.14;
  for (const y of [-h, h]) for (const z of [-d, d]) pos.push(-hw, y, z, hw, y, z);
  for (const x of [-hw, hw]) for (const y of [-h, h]) pos.push(x, y, -d, x, y, d);
  for (const x of [-hw, hw]) for (const z of [-d, d]) pos.push(x, -h, z, x, h, z);
  for (let i = 1; i < TRAY.slots; i++) {
    const x = -TRAY_W / 2 + i * TRAY.pitch;
    pos.push(x, -h, d, x, -h + 0.035, d);
  }
  pos.push(0, -h, 0, 0, BRAIN_Y + SHELL_R + 0.04 - TRAY.y, -TRAY.z);
  const tetherEnd = pos.length / 3 - 1;
  const frameGeo = ctx.track(new BufferGeometry());
  frameGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const frameMat = ctx.track(new LineBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }));
  const frame = new LineSegments(frameGeo, frameMat);
  group.add(frame);

  const blockMat = ctx.track(new MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }));
  const blocks = instanced(ctx.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.2)), blockMat, TRAY_CAPACITY, ctx);
  blocks.count = 0;
  blocks.frustumCulled = false;
  group.add(blocks);

  /** Float the tray at height `y` (portrait stages lift it into the free band above the diorama). */
  const setY = (y: number) => {
    group.position.y = y;
    const attr = frameGeo.getAttribute('position') as Float32BufferAttribute;
    attr.setY(tetherEnd, BRAIN_Y + SHELL_R + 0.04 - y);
    attr.needsUpdate = true;
    frameGeo.computeBoundingSphere();
  };

  return { group, glass, glassMat, frame, frameMat, blocks, blockMat, setY };
}

/* ───────────────────────── misc ───────────────────────── */

export function buildThreat(ctx: SceneContext) {
  const mat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.2 }));
  const mesh = new Mesh(ctx.track(facetted(new IcosahedronGeometry(0.135, 0))), mat);
  mesh.visible = false;
  mesh.name = 'prompt-injection';
  return { mesh, mat };
}

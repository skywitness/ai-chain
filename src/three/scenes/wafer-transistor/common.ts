/**
 * Shared helpers for the wafer-transistor scene (scene-private).
 *
 * Everything that is drawn as many axis-aligned boxes (die blocks, metal wires, transistor parts)
 * goes through `BoxSet`: one InstancedMesh of a unit box per material, with per-instance colours.
 * Boxes are described by their min/max corners (`Aabb`), which makes "morph" tweens a plain lerp.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Vector3,
  type WebGLRenderTarget,
  type Material,
  type Object3D,
} from 'three';
import type {
  CameraPose,
  LabelHandle,
  LabelSpec,
  Palette,
  SceneContext,
  StageSize,
  Vec3Like,
} from '../../core/types';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';

/** Global step indices (meta.json `steps`). */
export const STEP = {
  overview: 0,
  die: 1,
  metal: 2,
  planar: 3,
  finfet: 4,
  gaa: 5,
  cfet: 6,
  bspdn: 7,
} as const;

/** What a variant builder returns (index.ts forwards the SceneInstance hooks to it). */
export interface View {
  /** `i` is the global step index; steps that belong to another variant arrive as 0. */
  setStep(i: number): void;
  update?(dt: number, t: number): void;
  onPalette?(p: Palette): void;
  onMotion?(animate: boolean): void;
  onQuality?(scale: number): void;
  onResize?(size: StageSize): void;
  dispose?(): void;
}

/** Axis-aligned box as [x0, y0, z0, x1, y1, z1]. */
export type Aabb = [number, number, number, number, number, number];
export const ZERO: Aabb = [0, 0, 0, 0, 0, 0];

/** A narrow landscape stage (phones show the default `normal` height as 4:3). */
export const isCompact = (size: StageSize) => !size.portrait && size.aspect < 1.5;

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export function lerpBox(a: Aabb, b: Aabb, k: number, out: Aabb): Aabb {
  for (let i = 0; i < 6; i++) out[i] = lerp(a[i]!, b[i]!, k);
  return out;
}

/** Box from a centre and a size. */
export const cbox = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Aabb => [
  cx - sx / 2,
  cy - sy / 2,
  cz - sz / 2,
  cx + sx / 2,
  cy + sy / 2,
  cz + sz / 2,
];

const M4 = new Matrix4();
const EPS = 1e-5;
const FLAT = 2e-3;

/** Many axis-aligned boxes in one draw call (unit box geometry scaled per instance). */
export class BoxSet {
  readonly mesh: InstancedMesh;
  readonly boxes: Aabb[];
  private dirty = false;

  constructor(ctx: SceneContext, material: Material, capacity: number, geometry?: BufferGeometry) {
    const geo = geometry ?? ctx.track(new BoxGeometry(1, 1, 1));
    this.mesh = new InstancedMesh(geo, material, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, new Color(1, 1, 1));
    for (let i = 1; i < capacity; i++) this.mesh.setColorAt(i, new Color(1, 1, 1));
    this.boxes = Array.from({ length: capacity }, () => [...ZERO] as Aabb);
    this.mesh.count = capacity;
    ctx.track({ dispose: () => this.mesh.dispose() });
    for (let i = 0; i < capacity; i++) this.set(i, ZERO);
    this.flush();
  }

  set(i: number, b: Aabb): void {
    const t = this.boxes[i];
    if (!t) return;
    for (let k = 0; k < 6; k++) t[k] = b[k]!;
    const sx = b[3] - b[0];
    const sy = b[4] - b[1];
    const sz = b[5] - b[2];
    // A (nearly) flat box is a placeholder for a part that does not exist in this pose: hide it
    // entirely, or its faces would z-fight with whatever surface it lies on.
    if (sx < FLAT || sy < FLAT || sz < FLAT)
      M4.makeScale(EPS, EPS, EPS).setPosition((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    else M4.makeScale(sx, sy, sz).setPosition((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    this.mesh.setMatrixAt(i, M4);
    this.dirty = true;
  }

  color(i: number, c: Color): void {
    this.mesh.setColorAt(i, c);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.computeBoundingBox();
    this.dirty = false;
  }
}

/** Line segments whose endpoints are rewritten in place (callouts, outlines). */
export class Lines {
  readonly object: LineSegments;
  private readonly pos: Float32BufferAttribute;

  constructor(ctx: SceneContext, material: LineBasicMaterial, maxSegments: number) {
    const g = ctx.track(new BufferGeometry());
    this.pos = new Float32BufferAttribute(new Float32Array(maxSegments * 6), 3);
    this.pos.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setDrawRange(0, 0);
    this.object = new LineSegments(g, material);
    this.object.frustumCulled = false;
  }

  /** Flat list of [x,y,z] pairs (two per segment). */
  set(points: readonly (readonly [number, number, number])[]): void {
    const a = this.pos.array as Float32Array;
    const n = Math.min(points.length, a.length / 3);
    for (let i = 0; i < n; i++) {
      const p = points[i]!;
      a[i * 3] = p[0];
      a[i * 3 + 1] = p[1];
      a[i * 3 + 2] = p[2];
    }
    this.pos.needsUpdate = true;
    this.object.geometry.setDrawRange(0, n - (n % 2));
  }
}

/** A soft contact shadow / glow disc lying on the XZ plane. */
export function contactShadow(
  ctx: SceneContext,
  w: number,
  d: number,
): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const tex = ctx.track(radialTexture(128));
  const mat = ctx.track(
    new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  const m = new Mesh(ctx.track(new PlaneGeometry(w, d)), mat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -2;
  return m;
}
export function tintShadow(m: Mesh<PlaneGeometry, MeshBasicMaterial>, p: Palette, strength = 1): void {
  const dark = p.theme === 'dark';
  m.material.color.copy(dark ? p.flow : p.fg);
  m.material.opacity = (dark ? 0.07 : 0.1) * strength;
}

/** Labels that belong to a set of steps; `show(step)` toggles them. */
export class LabelSet {
  private items: { h: LabelHandle; when: (step: number) => boolean }[] = [];
  constructor(private readonly ctx: SceneContext) {}

  add(spec: LabelSpec, when: (step: number) => boolean = () => true): LabelHandle {
    const h = this.ctx.labels.add({ ...spec, visible: false });
    this.items.push({ h, when });
    return h;
  }

  show(step: number): void {
    for (const it of this.items) it.h.set({ visible: it.when(step) });
  }

  hideAll(): void {
    for (const it of this.items) it.h.set({ visible: false });
  }

  dispose(): void {
    for (const it of this.items) it.h.remove();
    this.items = [];
  }
}

const HUD_V = new Vector3();

/** World point under stage pixel (px, py), `depth` units in front of the camera. */
export function screenPoint(ctx: SceneContext, px: number, py: number, depth: number, out: Vector3): Vector3 {
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const t = Math.tan((cam.fov * Math.PI) / 360);
  const w = Math.max(1, ctx.size.width);
  const h = Math.max(1, ctx.size.height);
  out.set(((2 * px) / w - 1) * t * cam.aspect * depth, (1 - (2 * py) / h) * t * depth, -depth);
  return out.applyMatrix4(cam.matrixWorld);
}

/**
 * Screen-anchored labels (titles, legends, a timeline row) built on the LabelLayer: each label is
 * re-placed at a fixed stage position whenever the camera moves. `update()` only touches a label
 * when its world point changed, so a still camera requests no frames (reduced motion stays idle).
 */
export class Hud {
  private items: { h: LabelHandle; fx: number; fy: number; dx: number; dy: number; last: Vector3 }[] = [];
  constructor(
    private readonly ctx: SceneContext,
    private readonly depth = 3,
  ) {}

  /** `fx`, `fy`: fraction of the stage (0…1); `dx`, `dy`: extra px. */
  add(spec: LabelSpec, fx: number, fy: number, dx = 0, dy = 0): LabelHandle {
    const h = this.ctx.labels.add({ ...spec, always: true });
    this.items.push({ h, fx, fy, dx, dy, last: new Vector3(Number.NaN, 0, 0) });
    return h;
  }

  move(h: LabelHandle, fx: number, fy: number, dx = 0, dy = 0): void {
    const it = this.items.find((x) => x.h === h);
    if (!it) return;
    Object.assign(it, { fx, fy, dx, dy });
    it.last.x = Number.NaN;
  }

  update(): void {
    const { width, height } = this.ctx.size;
    for (const it of this.items) {
      screenPoint(this.ctx, it.fx * width + it.dx, it.fy * height + it.dy, this.depth, HUD_V);
      if (!Number.isNaN(it.last.x) && HUD_V.distanceToSquared(it.last) < 1e-9) continue;
      it.last.copy(HUD_V);
      it.h.set({ position: [HUD_V.x, HUD_V.y, HUD_V.z] });
    }
  }

  dispose(): void {
    for (const it of this.items) it.h.remove();
    this.items = [];
  }
}

/** Colour helpers (all theme-aware: computed from the palette, never hex). */
export const mix = (a: Color, b: Color, k: number, out = new Color()) => out.copy(a).lerp(b, k);

/** Silicon grey for substrates and wafers. */
export const silicon = (p: Palette, out = new Color()) =>
  out
    .copy(p.bg)
    .lerp(p.fg, p.theme === 'dark' ? 0.3 : 0.42)
    .lerp(p.muted, 0.25);

/** World-space corners of a local rectangle on an object's XZ plane (at height y). */
export function worldCorners(obj: Object3D, hx: number, hz: number, y: number): [number, number, number][] {
  obj.updateWorldMatrix(true, false);
  const e = obj.matrixWorld.elements;
  const corner = (x: number, z: number): [number, number, number] => [
    e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
    e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
    e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
  ];
  return [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)];
}

/** Callout: 4 connector lines + both outlines between two rectangles' corners. */
export function calloutPoints(
  a: [number, number, number][],
  b: [number, number, number][],
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i < 4; i++) pts.push(a[i]!, b[i]!);
  for (let i = 0; i < 4; i++) pts.push(a[i]!, a[(i + 1) % 4]!);
  return pts;
}

/**
 * ctx.setPose scales a pose's distance by |portrait| / |landscape| on portrait stages. Use this to
 * pass a pose that was authored for the portrait layout as-is (it pre-divides that factor).
 */
export function exactPose(ctx: SceneContext, pose: CameraPose): CameraPose {
  const cam = ctx.meta.camera;
  if (!ctx.size.portrait || !cam.portrait?.position) return pose;
  const v3 = (p: Vec3Like) => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2]));
  const main = v3(cam.position).distanceTo(v3(cam.target));
  const port = v3(cam.portrait.position).distanceTo(v3(cam.portrait.target ?? cam.target));
  const k = main > 0 ? port / main : 1;
  const t = v3(pose.target);
  const p = v3(pose.position).sub(t).divideScalar(k).add(t);
  return { ...pose, position: [p.x, p.y, p.z] };
}

/**
 * The current home pose, moved by (dx, dy, dz) and ready for ctx.setPose on any stage shape.
 * (ctx.setPose(ctx.homePose) would scale the already-portrait home pose a second time.)
 */
export function homePoseShifted(ctx: SceneContext, dx = 0, dy = 0, dz = 0): CameraPose {
  const h = ctx.homePose;
  const p = h.position instanceof Vector3 ? h.position : new Vector3(...h.position);
  const t = h.target instanceof Vector3 ? h.target : new Vector3(...h.target);
  return exactPose(ctx, { position: [p.x + dx, p.y + dy, p.z + dz], target: [t.x + dx, t.y + dy, t.z + dz] });
}

/**
 * A tiny procedural studio environment (equirect canvas → PMREM) so metals, copper and the wafer
 * pick up soft reflections. The PMREM is built with a private PMREMGenerator that is disposed right
 * away (the renderer's own cache would keep its blur planes and ping-pong target alive across
 * remounts, which the host's leak check reports); only the cube-UV render target is kept and it is
 * replaced on a theme change.
 */
export function studioEnvironment(
  ctx: SceneContext,
  intensity = 0.55,
): { apply(p: Palette): void; dispose(): void } {
  let rt: WebGLRenderTarget | null = null;
  const apply = (p: Palette) => {
    const dark = p.theme === 'dark';
    const sky = new Color().copy(p.bg).lerp(p.fg, dark ? 0.32 : 0.12);
    const floor = new Color().copy(p.bg).lerp(p.fg, dark ? 0.04 : 0.28);
    const next = canvasTexture(256, 128, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, sky.getStyle());
      grd.addColorStop(
        0.5,
        new Color()
          .copy(p.bg)
          .lerp(p.fg, dark ? 0.12 : 0.06)
          .getStyle(),
      );
      grd.addColorStop(1, floor.getStyle());
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      // two soft boxes (the palette's lightest ink) and a cool rim strip
      const light = (dark ? p.fg : p.bg)
        .clone()
        .lerp(p.fg, dark ? 0 : 0.02)
        .getStyle();
      g.filter = 'blur(6px)';
      g.fillStyle = light;
      g.globalAlpha = 0.95;
      g.fillRect(w * 0.12, h * 0.1, w * 0.18, h * 0.22);
      g.globalAlpha = 0.7;
      g.fillRect(w * 0.58, h * 0.14, w * 0.14, h * 0.16);
      g.fillStyle = new Color().copy(p.flow).lerp(p.fg, 0.5).getStyle();
      g.globalAlpha = 0.5;
      g.fillRect(0, h * 0.42, w, h * 0.04);
      g.globalAlpha = 1;
      g.filter = 'none';
    });
    next.mapping = EquirectangularReflectionMapping;
    const gen = new PMREMGenerator(ctx.renderer);
    const out = gen.fromEquirectangular(next);
    gen.dispose();
    next.dispose();
    ctx.scene.environment = out.texture;
    ctx.scene.environmentIntensity = intensity * (dark ? 0.9 : 1);
    rt?.dispose();
    rt = out;
  };
  apply(ctx.palette);
  return {
    apply,
    dispose() {
      ctx.scene.environment = null;
      rt?.dispose();
      rt = null;
    },
  };
}

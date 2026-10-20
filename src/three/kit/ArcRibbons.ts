/**
 * ArcRibbons: many camera-facing arc ribbons in ONE draw call (scenes3d.md A15).
 * Each instance has start, end, height, width, colour, alpha and a draw-on progress (0..1).
 *  - mode 'planar': quadratic Bézier lifted along `up` by `height` (attention arcs, tool calls).
 *  - mode 'globe': great-circle between two points on a sphere of `radius`, raised by
 *    height·sin(πt) (flight-path style arcs).
 * Optional travelling highlight (`flow` > 0) shows direction; it freezes with `update()` not called.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { ThemeName, Vec3Like } from '../core/types';

const VERT = /* glsl */ `
uniform float uGlobe;
uniform float uRadius;
uniform vec3 uUp;
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aHeight;
attribute float aWidth;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aProgress;
varying float vT;
varying float vSide;
varying vec3 vColor;
varying float vAlpha;
vec3 arcPoint(float t) {
  if (uGlobe > 0.5) {
    vec3 a = normalize(aStart);
    vec3 b = normalize(aEnd);
    float d = clamp(dot(a, b), -0.9999, 0.9999);
    float om = acos(d);
    vec3 p = (sin((1.0 - t) * om) * a + sin(t * om) * b) / sin(om);
    return normalize(p) * (uRadius + aHeight * sin(3.14159265 * t));
  }
  vec3 mid = (aStart + aEnd) * 0.5 + uUp * aHeight * 2.0;
  return mix(mix(aStart, mid, t), mix(mid, aEnd, t), t);
}
void main() {
  float t = position.x * aProgress;
  vec4 p0 = modelViewMatrix * vec4(arcPoint(t), 1.0);
  vec4 p1 = modelViewMatrix * vec4(arcPoint(min(t + 0.01, 1.0)), 1.0);
  vec4 pm = modelViewMatrix * vec4(arcPoint(max(t - 0.01, 0.0)), 1.0);
  vec2 dir = p1.xy - pm.xy;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  p0.xy += nrm * position.y * aWidth * 0.5;
  gl_Position = projectionMatrix * p0;
  vT = position.x; vSide = position.y; vColor = aColor; vAlpha = aAlpha * step(0.0001, aProgress);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uOpacity;
uniform float uLight;
varying float vT;
varying float vSide;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float ends = smoothstep(0.0, 0.04, vT) * smoothstep(1.0, 0.96, vT);
  float a = edge * ends * vAlpha * uOpacity;
  vec3 col = vColor;
  if (uFlow > 0.0) {
    float h = fract(vT - uTime * uFlow);
    float pulse = smoothstep(0.82, 1.0, h) * (1.0 - smoothstep(0.995, 1.0, h));
    col = mix(col, uLight > 0.5 ? col * 0.55 : vec3(1.0), pulse * 0.8);
    a = min(1.0, a * (0.75 + pulse * 0.6));
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export interface Arc {
  start: Vec3Like;
  end: Vec3Like;
  /** Lift (planar: Bézier apex ≈ height; globe: altitude at the midpoint). */
  height?: number;
  /** Ribbon width in world units. */
  width?: number;
  color?: Color;
  alpha?: number;
  /** Draw-on progress 0..1 (default 1). */
  progress?: number;
}

export interface ArcRibbonsOptions {
  /** Capacity (max arcs). */
  count: number;
  mode?: 'planar' | 'globe';
  /** Globe radius (mode 'globe'). */
  radius?: number;
  /** Lift direction (mode 'planar'). Default +Y. */
  up?: Vec3Like;
  /** Segments along each ribbon. Default 32. */
  segments?: number;
  /** Travelling highlight speed in ribbons per second (0 = off). */
  flow?: number;
  opacity?: number;
  theme?: ThemeName;
}

const v3 = (v: Vec3Like): Vector3 => (v instanceof Vector3 ? v : new Vector3(v[0], v[1], v[2]));

export class ArcRibbons {
  readonly object: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly attrs: Record<'aStart' | 'aEnd' | 'aHeight' | 'aWidth' | 'aColor' | 'aAlpha' | 'aProgress', InstancedBufferAttribute>;
  private used = 0;

  constructor(opts: ArcRibbonsOptions) {
    const n = Math.max(1, opts.count);
    this.capacity = n;
    const seg = Math.max(2, opts.segments ?? 32);
    const g = new InstancedBufferGeometry();
    const pos = new Float32Array((seg + 1) * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      pos.set([t, -1, 0, t, 1, 0], i * 6);
      if (i < seg) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mk = (size: number, fill = 0) => new InstancedBufferAttribute(new Float32Array(n * size).fill(fill), size);
    this.attrs = {
      aStart: mk(3),
      aEnd: mk(3),
      aHeight: mk(1),
      aWidth: mk(1, 0.02),
      aColor: mk(3, 1),
      aAlpha: mk(1, 1),
      aProgress: mk(1, 1),
    };
    for (const [k, a] of Object.entries(this.attrs)) g.setAttribute(k, a);
    g.instanceCount = 0;
    const m = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uGlobe: { value: opts.mode === 'globe' ? 1 : 0 },
        uRadius: { value: opts.radius ?? 1 },
        uUp: { value: opts.up ? v3(opts.up).clone().normalize() : new Vector3(0, 1, 0) },
        uTime: { value: 0 },
        uFlow: { value: opts.flow ?? 0 },
        uOpacity: { value: opts.opacity ?? 1 },
        uLight: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.object = new Mesh(g, m);
    this.object.frustumCulled = false;
    this.object.renderOrder = 8;
    this.object.name = 'ArcRibbons';
    this.setTheme(opts.theme ?? 'dark');
  }

  /** Replace all arcs. */
  setArcs(arcs: readonly Arc[]): void {
    this.used = Math.min(arcs.length, this.capacity);
    for (let i = 0; i < this.used; i++) this.setArc(i, arcs[i]!);
    this.object.geometry.instanceCount = this.used;
  }

  setArc(i: number, a: Arc): void {
    if (i < 0 || i >= this.capacity) return;
    const s = v3(a.start);
    const e = v3(a.end);
    const A = this.attrs;
    A.aStart.setXYZ(i, s.x, s.y, s.z);
    A.aEnd.setXYZ(i, e.x, e.y, e.z);
    A.aHeight.setX(i, a.height ?? 0.5);
    A.aWidth.setX(i, a.width ?? 0.02);
    const c = a.color ?? new Color(1, 1, 1);
    A.aColor.setXYZ(i, c.r, c.g, c.b);
    A.aAlpha.setX(i, a.alpha ?? 1);
    A.aProgress.setX(i, a.progress ?? 1);
    for (const x of Object.values(A)) x.needsUpdate = true;
    if (i >= this.used) {
      this.used = i + 1;
      this.object.geometry.instanceCount = this.used;
    }
  }

  setProgress(i: number, p: number): void {
    this.attrs.aProgress.setX(i, Math.max(0, Math.min(1, p)));
    this.attrs.aProgress.needsUpdate = true;
  }

  setAlpha(i: number, a: number): void {
    this.attrs.aAlpha.setX(i, a);
    this.attrs.aAlpha.needsUpdate = true;
  }

  setColor(i: number, c: Color): void {
    this.attrs.aColor.setXYZ(i, c.r, c.g, c.b);
    this.attrs.aColor.needsUpdate = true;
  }

  setWidth(i: number, w: number): void {
    this.attrs.aWidth.setX(i, w);
    this.attrs.aWidth.needsUpdate = true;
  }

  /** Advance the travelling highlight (animation clock, seconds). */
  update(t: number): void {
    this.object.material.uniforms['uTime']!.value = t;
  }

  setTheme(theme: ThemeName): void {
    const m = this.object.material;
    m.blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
    m.uniforms['uLight']!.value = theme === 'dark' ? 0 : 1;
    m.needsUpdate = true;
  }

  setOpacity(o: number): void {
    this.object.material.uniforms['uOpacity']!.value = o;
  }

  get count(): number {
    return this.used;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object.removeFromParent();
  }
}

/**
 * PathFlow: instanced particle flows along many paths in ONE draw call (scenes3d.md A15).
 *
 * Each path is resampled by arc length into `samples` points and packed into an RGBA32F
 * DataTexture (samples × pathCount); per-sample colours go into a second texture. Each particle
 * is an instanced billboard quad with (aPath, aOffset, aSpeed, aSize); the vertex shader computes
 * t = fract(uTime·aSpeed + aOffset), does two texelFetch calls and lerps.
 *
 * Modes: 'loop' (continuous flow) and 'once' (t = uTime·aSpeed + aOffset, hidden outside 0..1:
 * drive uTime yourself for pulses / waves). Reduced motion: `setReduced(true)` lays particles out
 * evenly along each path (static dotted streams) and freezes time.
 *
 * Blending follows the theme: additive glow on dark, normal (solid dots) on light.
 */
import {
  AdditiveBlending,
  CatmullRomCurve3,
  Color,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  NormalBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { ThemeName, Vec3Like } from '../core/types';
import { quadAttributes, seeded } from './shared';

export interface FlowPath {
  /** Control points (≥ 2). Smoothed with a centripetal Catmull-Rom unless `smooth: false`. */
  points: readonly Vec3Like[];
  /** One colour, or one colour per control point (interpolated along the path). */
  color?: Color | readonly Color[];
  /** Relative particle density on this path (default 1). */
  weight?: number;
  /** Speed multiplier for this path (default 1). */
  speed?: number;
  /** Phase offset in path lengths ('once' mode: −1 starts one path-duration later). */
  offset?: number;
}

export interface PathFlowOptions {
  paths: readonly FlowPath[];
  /** Total particles (already scaled for the quality tier by the caller). */
  count: number;
  /** Particle diameter in world units. Default 0.08. */
  size?: number;
  /** Size jitter 0..1. Default 0.35. */
  sizeVariance?: number;
  /** World units per second. Default 0.9. */
  speed?: number;
  /** Speed jitter 0..1. Default 0.15. */
  speedVariance?: number;
  smooth?: boolean;
  samples?: number;
  mode?: 'loop' | 'once';
  /** Fade-in / fade-out fraction at both ends of each path. Default 0.06. */
  fadeEnds?: number;
  opacity?: number;
  theme?: ThemeName;
  /** Distribute particles proportionally to path length (default true). */
  byLength?: boolean;
  seed?: number;
  /** For 'once' mode: explicit per-particle offsets per path (e.g. [0, -0.04, -0.08] for comets). */
  onceOffsets?: readonly number[];
}

const VERT = /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uCol;
uniform float uTime;
uniform float uSamples;
uniform float uFade;
uniform float uSize;
uniform float uOnce;
attribute float aPath;
attribute float aOffset;
attribute float aSpeed;
attribute float aSize;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float t = uTime * aSpeed + aOffset;
  if (uOnce > 0.5) {
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; vUv = uv; vColor = vec3(0.0); return; }
  } else {
    t = fract(t);
  }
  float f = t * (uSamples - 1.0);
  int i0 = int(floor(f));
  int last = int(uSamples) - 1;
  int i1 = min(i0 + 1, last);
  float k = f - floor(f);
  int row = int(aPath + 0.5);
  vec3 p = mix(texelFetch(uPos, ivec2(i0, row), 0).xyz, texelFetch(uPos, ivec2(i1, row), 0).xyz, k);
  vColor = mix(texelFetch(uCol, ivec2(i0, row), 0).rgb, texelFetch(uCol, ivec2(i1, row), 0).rgb, k);
  vAlpha = uFade > 0.0 ? smoothstep(0.0, uFade, t) * smoothstep(1.0, 1.0 - uFade, t) : 1.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += position.xy * uSize * aSize;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uGlow;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a;
  vec3 col = vColor;
  if (uGlow > 0.5) {
    float core = 1.0 - smoothstep(0.0, 0.45, r);
    float halo = 1.0 - smoothstep(0.2, 1.0, r);
    a = (core * 0.9 + halo * 0.55) * vAlpha * uOpacity;
    col = mix(vColor, vec3(1.0), core * 0.3);
  } else {
    a = (1.0 - smoothstep(0.62, 0.9, r)) * vAlpha * uOpacity;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class PathFlow {
  readonly object: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly pathCount: number;
  readonly lengths: number[];
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly posTex: DataTexture;
  private readonly colTex: DataTexture;
  private readonly offsets: Float32Array;
  private readonly staticOffsets: Float32Array;
  private readonly max: number;
  private reduced = false;
  private frozenAt = 0;
  private readonly tParams: Float32Array;
  private readonly samples: number;
  private readonly ctrlCounts: number[];

  constructor(opts: PathFlowOptions) {
    const samples = Math.max(2, opts.samples ?? 64);
    const paths = opts.paths.filter((p) => p.points.length >= 2);
    const n = Math.max(1, paths.length);
    this.pathCount = paths.length;
    const pos = new Float32Array(samples * n * 4);
    const col = new Float32Array(samples * n * 4);
    this.samples = samples;
    this.tParams = new Float32Array(samples * n);
    this.ctrlCounts = paths.map((p) => p.points.length);
    this.lengths = [];
    const v = new Vector3();
    const c = new Color();
    paths.forEach((path, row) => {
      const pts = path.points.map((p) => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2])));
      const curve = opts.smooth === false || pts.length < 3 ? null : new CatmullRomCurve3(pts, false, 'centripetal');
      const segLen: number[] = [];
      let total = 0;
      if (!curve) {
        for (let i = 1; i < pts.length; i++) {
          const l = pts[i]!.distanceTo(pts[i - 1]!);
          segLen.push(l);
          total += l;
        }
      } else total = curve.getLength();
      this.lengths.push(Math.max(total, 1e-4));
      const colors = path.color;
      for (let s = 0; s < samples; s++) {
        const u = s / (samples - 1);
        let tParam: number;
        if (curve) {
          curve.getPointAt(u, v);
          tParam = curve.getUtoTmapping(u, 0) * (pts.length - 1);
        } else {
          let d = u * total;
          let i = 0;
          while (i < segLen.length - 1 && d > (segLen[i] ?? 0)) d -= segLen[i++] ?? 0;
          const l = segLen[i] || 1;
          v.lerpVectors(pts[i]!, pts[i + 1]!, Math.min(1, d / l));
          tParam = i + Math.min(1, d / l);
        }
        this.tParams[row * samples + s] = tParam;
        const o = (row * samples + s) * 4;
        pos[o] = v.x;
        pos[o + 1] = v.y;
        pos[o + 2] = v.z;
        pos[o + 3] = u;
        if (Array.isArray(colors) && colors.length) {
          const arr = colors as readonly Color[];
          const i0 = Math.min(arr.length - 1, Math.floor(tParam));
          const i1 = Math.min(arr.length - 1, i0 + 1);
          c.copy(arr[i0]!).lerp(arr[i1]!, tParam - i0);
        } else if (colors instanceof Color) c.copy(colors);
        else c.setRGB(1, 1, 1);
        col[o] = c.r;
        col[o + 1] = c.g;
        col[o + 2] = c.b;
        col[o + 3] = 1;
      }
    });

    this.posTex = new DataTexture(pos, samples, n, RGBAFormat, FloatType);
    this.colTex = new DataTexture(col, samples, n, RGBAFormat, FloatType);
    for (const t of [this.posTex, this.colTex]) {
      t.minFilter = t.magFilter = NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
    }

    // Allocate particles to paths.
    const rnd = seeded(opts.seed ?? 7);
    const count = Math.max(0, Math.floor(opts.count));
    this.max = count;
    const weights = paths.map((p, i) => (p.weight ?? 1) * (opts.byLength === false ? 1 : this.lengths[i]!));
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    const per = weights.map((w) => Math.floor((w / wsum) * count));
    let left = count - per.reduce((a, b) => a + b, 0);
    for (let i = 0; left > 0 && per.length; i = (i + 1) % per.length, left--) per[i] = (per[i] ?? 0) + 1;

    const aPath = new Float32Array(count);
    const aOffset = new Float32Array(count);
    const aSpeed = new Float32Array(count);
    const aSize = new Float32Array(count);
    this.offsets = aOffset;
    this.staticOffsets = new Float32Array(count);
    const speed = opts.speed ?? 0.9;
    const sv = opts.speedVariance ?? 0.15;
    const zv = opts.sizeVariance ?? 0.35;
    const once = opts.mode === 'once';
    let k = 0;
    per.forEach((m, row) => {
      const path = paths[row]!;
      for (let j = 0; j < m && k < count; j++, k++) {
        aPath[k] = row;
        const even = m > 0 ? j / m : 0;
        if (once) {
          const offs = opts.onceOffsets;
          aOffset[k] = (path.offset ?? 0) + (offs?.length ? (offs[j % offs.length] ?? 0) : -j * 0.06);
        } else aOffset[k] = (((even + (path.offset ?? 0) + (rnd() - 0.5) * (0.8 / Math.max(1, m))) % 1) + 1) % 1;
        this.staticOffsets[k] = once ? Math.min(1, Math.max(0, (j + 0.5) / m)) : even;
        aSpeed[k] = ((speed * (path.speed ?? 1)) / this.lengths[row]!) * (1 + (rnd() - 0.5) * 2 * sv);
        aSize[k] = 1 + (rnd() - 0.5) * 2 * zv;
      }
    });

    // Interleave paths (seeded shuffle) so any prefix (setCount) samples every path.
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      for (const arr of [aPath, aOffset, aSpeed, aSize, this.staticOffsets]) {
        const t = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = t;
      }
    }

    const g = new InstancedBufferGeometry();
    quadAttributes(g);
    g.setAttribute('aPath', new InstancedBufferAttribute(aPath, 1));
    g.setAttribute('aOffset', new InstancedBufferAttribute(aOffset, 1));
    g.setAttribute('aSpeed', new InstancedBufferAttribute(aSpeed, 1));
    g.setAttribute('aSize', new InstancedBufferAttribute(aSize, 1));
    g.instanceCount = count;
    this.geometry = g;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPos: { value: this.posTex },
        uCol: { value: this.colTex },
        uTime: { value: 0 },
        uSamples: { value: samples },
        uFade: { value: opts.fadeEnds ?? 0.06 },
        uSize: { value: opts.size ?? 0.08 },
        uOnce: { value: once ? 1 : 0 },
        uOpacity: { value: opts.opacity ?? 1 },
        uGlow: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.object = new Mesh(g, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.name = 'PathFlow';
    this.setTheme(opts.theme ?? 'dark');
  }

  /** Advance to animation time `t` (seconds). Ignored while reduced. */
  update(t: number): void {
    if (!this.reduced) this.material.uniforms['uTime']!.value = t;
  }

  /** Set the raw time uniform (for 'once' mode choreography), even while reduced. */
  setTime(t: number): void {
    this.material.uniforms['uTime']!.value = t;
  }

  /** Reduced motion: evenly spaced static dots along every path. */
  setReduced(on: boolean): void {
    if (on === this.reduced) return;
    this.reduced = on;
    const attr = this.geometry.getAttribute('aOffset') as InstancedBufferAttribute;
    const u = this.material.uniforms['uTime']!;
    if (on) {
      this.frozenAt = u.value as number;
      (attr.array as Float32Array).set(this.staticOffsets);
      u.value = 0;
    } else {
      (attr.array as Float32Array).set(this.offsets);
      u.value = this.frozenAt;
    }
    attr.needsUpdate = true;
  }

  get isReduced(): boolean {
    return this.reduced;
  }

  /**
   * Rewrite path colours (theme changes): `colors(i)` returns one colour or one per control point
   * of path i (same convention as FlowPath.color).
   */
  recolor(colors: (pathIndex: number) => Color | readonly Color[] | undefined): void {
    const data = this.colTex.image.data as Float32Array;
    const c = new Color();
    for (let row = 0; row < this.pathCount; row++) {
      const spec = colors(row);
      const nCtrl = this.ctrlCounts[row] ?? 2;
      for (let s = 0; s < this.samples; s++) {
        const tp = this.tParams[row * this.samples + s] ?? 0;
        if (Array.isArray(spec) && spec.length) {
          const arr = spec as readonly Color[];
          const i0 = Math.min(arr.length - 1, Math.floor(Math.min(tp, nCtrl - 1)));
          const i1 = Math.min(arr.length - 1, i0 + 1);
          c.copy(arr[i0]!).lerp(arr[i1]!, tp - i0);
        } else if (spec instanceof Color) c.copy(spec);
        else c.setRGB(1, 1, 1);
        const o = (row * this.samples + s) * 4;
        data[o] = c.r;
        data[o + 1] = c.g;
        data[o + 2] = c.b;
      }
    }
    this.colTex.needsUpdate = true;
  }

  setTheme(theme: ThemeName): void {
    const dark = theme === 'dark';
    this.material.blending = dark ? AdditiveBlending : NormalBlending;
    this.material.uniforms['uGlow']!.value = dark ? 1 : 0;
    this.material.needsUpdate = true;
  }

  setOpacity(o: number): void {
    this.material.uniforms['uOpacity']!.value = o;
  }

  setSize(s: number): void {
    this.material.uniforms['uSize']!.value = s;
  }

  /** Show only the first `n` particles (quality changes). */
  setCount(n: number): void {
    this.geometry.instanceCount = Math.max(0, Math.min(this.max, Math.floor(n)));
  }

  get count(): number {
    return this.max;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.posTex.dispose();
    this.colTex.dispose();
    this.object.removeFromParent();
  }
}

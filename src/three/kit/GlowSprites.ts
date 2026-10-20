/**
 * GlowSprites: instanced camera-facing halos (fake bloom, scenes3d.md A14/A15) in one draw call.
 * The radial falloff is computed in the fragment shader, so no texture is needed.
 * Dark theme: additive glow. Light theme: normal blending with a soft tinted disc so halos read
 * as gentle "highlights" instead of disappearing into a light background.
 */
import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { ThemeName, Vec3Like } from '../core/types';
import { quadAttributes } from './shared';

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute float aScale;
attribute vec3 aColor;
attribute float aAlpha;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  mv.xy += position.xy * aScale;
  gl_Position = projectionMatrix * mv;
  vUv = uv; vColor = aColor; vAlpha = aAlpha;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uLight;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = uLight > 0.5 ? pow(1.0 - r, 2.2) * 0.55 : pow(1.0 - r, 2.0) * (0.75 + 0.25 * (1.0 - smoothstep(0.0, 0.25, r)));
  a *= vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

export interface GlowSpritesOptions {
  /** Capacity (max instances). */
  count: number;
  opacity?: number;
  theme?: ThemeName;
}

export class GlowSprites {
  readonly object: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly pos: InstancedBufferAttribute;
  private readonly scale: InstancedBufferAttribute;
  private readonly color: InstancedBufferAttribute;
  private readonly alpha: InstancedBufferAttribute;
  readonly capacity: number;

  constructor(opts: GlowSpritesOptions) {
    const n = Math.max(1, opts.count);
    this.capacity = n;
    const g = new InstancedBufferGeometry();
    quadAttributes(g);
    this.pos = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.scale = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.color = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    this.alpha = new InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    g.setAttribute('aPos', this.pos);
    g.setAttribute('aScale', this.scale);
    g.setAttribute('aColor', this.color);
    g.setAttribute('aAlpha', this.alpha);
    g.instanceCount = n;
    const m = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uOpacity: { value: opts.opacity ?? 1 }, uLight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.object = new Mesh(g, m);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.object.name = 'GlowSprites';
    this.setTheme(opts.theme ?? 'dark');
  }

  /** Set one halo. `size` is the diameter in world units. */
  set(i: number, position: Vec3Like, size: number, color: Color, alpha = 1): void {
    if (i < 0 || i >= this.capacity) return;
    const p = position instanceof Vector3 ? position : new Vector3(position[0], position[1], position[2]);
    this.pos.setXYZ(i, p.x, p.y, p.z);
    this.scale.setX(i, size);
    this.color.setXYZ(i, color.r, color.g, color.b);
    this.alpha.setX(i, alpha);
    this.pos.needsUpdate = this.scale.needsUpdate = this.color.needsUpdate = this.alpha.needsUpdate = true;
  }

  setAlpha(i: number, alpha: number): void {
    this.alpha.setX(i, alpha);
    this.alpha.needsUpdate = true;
  }

  setSize(i: number, size: number): void {
    this.scale.setX(i, size);
    this.scale.needsUpdate = true;
  }

  setColor(i: number, color: Color): void {
    this.color.setXYZ(i, color.r, color.g, color.b);
    this.color.needsUpdate = true;
  }

  /** Number of halos drawn (≤ capacity). */
  setCount(n: number): void {
    this.object.geometry.instanceCount = Math.max(0, Math.min(this.capacity, n));
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

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object.removeFromParent();
  }
}

/**
 * WebGLRenderer factory (scenes3d.md A3). WebGL 2 only (three r163+). The canvas clears transparent
 * so the stage's CSS background (the --scene-bg token) shows through and theme switches are free.
 */
import { NeutralToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Quality } from './types';
import { TIERS } from './quality';

export function createRenderer(canvas: HTMLCanvasElement, quality: Quality): WebGLRenderer {
  const tier = TIERS[quality];
  const renderer = new WebGLRenderer({
    canvas,
    antialias: tier.antialias,
    alpha: true,
    premultipliedAlpha: true,
    powerPreference: 'default',
    stencil: false,
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dprCap));
  renderer.toneMapping = NeutralToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  renderer.shadowMap.enabled = false;
  return renderer;
}

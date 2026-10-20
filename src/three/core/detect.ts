/**
 * WebGL 2 capability probe and static quality detection. Runs once per page on a throwaway canvas
 * (before any renderer exists, because `antialias` must be chosen at context creation).
 * Deliberately three-free: it ships in the tiny <ai-scene> element chunk.
 */
import type { Quality } from './types';

export interface Probe {
  ok: boolean;
  renderer: string;
  software: boolean;
  maxTexture: number;
}

let cached: Probe | null = null;

export function probeWebGL(): Probe {
  if (cached) return cached;
  const fail: Probe = { ok: false, renderer: '', software: false, maxTexture: 0 };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (!gl) return (cached = fail);
    let renderer = String(gl.getParameter(gl.RENDERER) ?? '');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? renderer);
    const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cached = {
      ok: true,
      renderer,
      software: /SwiftShader|llvmpipe|Software|Basic Render/i.test(renderer),
      maxTexture,
    };
  } catch {
    cached = fail;
  }
  return cached;
}

/** Static tier from the probe plus device hints (scenes3d.md A8). */
export function detectQuality(p: Probe = probeWebGL()): Quality | 'off' {
  if (!p.ok) return 'off';
  if (p.software) return 'low';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency || 8;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const shortSide = Math.min(screen.width, screen.height);
  const r = p.renderer;
  if (coarse && shortSide < 820) {
    if (mem <= 4 || cores < 8 || /Mali-G[0-6]\d?\b|Adreno \(TM\) [3-6]\d\d|Adreno [3-6]\d\d|PowerVR/i.test(r)) return 'low';
    return 'medium';
  }
  if (/iPhone|iPad/.test(navigator.userAgent)) return 'medium';
  if (/Intel.*(HD|UHD) Graphics/i.test(r) || cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}

const KEY = 'ai-scene-quality';

/** Reader / test override: ?quality= (or ?tier=), then localStorage. Returns null for 自動. */
export function qualityOverride(): Quality | 'off' | null {
  let v: string | null = null;
  try {
    const q = new URLSearchParams(location.search);
    v = q.get('quality') ?? q.get('tier');
  } catch {
    /* ignore */
  }
  if (!v) {
    try {
      v = localStorage.getItem(KEY);
    } catch {
      /* storage blocked */
    }
  }
  if (v === 'mid') v = 'medium';
  return v === 'high' || v === 'medium' || v === 'low' || v === 'off' ? v : null;
}

export function saveQualityOverride(v: Quality | 'off' | null): void {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

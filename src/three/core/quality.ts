/**
 * Quality tiers (scenes3d.md A8) and the adaptive governor for continuous scenes.
 */
import type { Quality, QualityTier } from './types';

export const TIERS: Readonly<Record<Quality, QualityTier>> = {
  high: { dprCap: 2, antialias: true, maxLabels: 40, particles: 1, calls: 150, tris: 500_000, fpsCap: 0 },
  medium: { dprCap: 1.5, antialias: true, maxLabels: 24, particles: 0.45, calls: 100, tris: 200_000, fpsCap: 0 },
  low: { dprCap: 1, antialias: false, maxLabels: 12, particles: 0.15, calls: 60, tris: 80_000, fpsCap: 30 },
};

export const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high'];

export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITY_ORDER.indexOf(q);
  return i > 0 ? (QUALITY_ORDER[i - 1] ?? null) : null;
}
export function higherQuality(q: Quality): Quality | null {
  const i = QUALITY_ORDER.indexOf(q);
  return i < QUALITY_ORDER.length - 1 ? (QUALITY_ORDER[i + 1] ?? null) : null;
}

/** Scale a high-tier count to the tier (never below `min`). */
export function scaleCount(n: number, tier: QualityTier, min = 1): number {
  return Math.max(min, Math.round(n * tier.particles));
}

/**
 * Adaptive governor. Feed it real frame intervals (ms). It ignores the first 2 s, then:
 *  - median of the last 120 frames > 22 ms → step down (DPR −0.25 to a floor of 1, then tier down);
 *  - median < 12 ms for 5 s → step up once (DPR first), at most once per 10 s.
 * MSAA is never changed (it is fixed at context creation).
 */
export class Governor {
  private samples: number[] = [];
  private start = performance.now();
  private goodSince = 0;
  private lastUp = 0;
  private lastDown = 0;

  constructor(
    private readonly hooks: {
      getDpr(): number;
      setDpr(v: number): void;
      maxDpr(): number;
      stepTier(dir: -1 | 1): boolean;
    },
  ) {}

  reset(): void {
    this.samples.length = 0;
    this.start = performance.now();
    this.goodSince = 0;
  }

  sample(frameMs: number): void {
    const now = performance.now();
    if (now - this.start < 2000 || frameMs <= 0 || frameMs > 250) return;
    this.samples.push(frameMs);
    if (this.samples.length < 120) return;
    if (this.samples.length > 120) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[60] ?? 16;
    if (median > 22 && now - this.lastDown > 2000) {
      this.lastDown = now;
      this.samples.length = 0;
      this.goodSince = 0;
      const dpr = this.hooks.getDpr();
      if (dpr > 1.01) this.hooks.setDpr(Math.max(1, dpr - 0.25));
      else this.hooks.stepTier(-1);
      return;
    }
    if (median < 12) {
      if (!this.goodSince) this.goodSince = now;
      if (now - this.goodSince > 5000 && now - this.lastUp > 10000) {
        this.lastUp = now;
        this.goodSince = 0;
        const dpr = this.hooks.getDpr();
        const max = this.hooks.maxDpr();
        if (dpr < max - 0.01) this.hooks.setDpr(Math.min(max, dpr + 0.25));
        else this.hooks.stepTier(1);
      }
    } else {
      this.goodSince = 0;
    }
  }
}

/** Seeded RNG (mulberry32) so posters, screenshots and tests are deterministic. */
import type { Rng } from './types';

/** FNV-1a hash of a string to a 32-bit seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: number | string = 1): Rng {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed) >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  let spare: number | null = null;
  next.range = (min, max) => min + (max - min) * next();
  next.int = (n) => Math.floor(next() * n);
  next.pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('rng.pick: empty array');
    return items[Math.floor(next() * items.length)] as T;
  };
  next.normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
  return next;
}

/**
 * Source keys the SpaceX sections cite by name (Basics, Drivers, Volume). They are already in the page's default
 * list today (model sourceKeys, events, driver points); listing them here keeps the citations valid if a data
 * update drops one from the defaults. Keys missing from the bundle are left out.
 */
import type { FcBundle } from '../../../lib/forecast-data';

const CITED = ['sec-424b4', 'sec-8k-ipo', 'pr-q3-2026', 'sec-fwp-google', 'tr-q2-2026', 'tr-q3-2026'];

export function sourceKeys(b: FcBundle): string[] {
  return CITED.filter((k) => b.sourceByKey.has(k));
}

/**
 * Source keys the Anthropic sections cite (Basics, Drivers, Volume) beyond the page defaults: the run-rate definition
 * (sec-fwp-ipo-site), and driver points the sections plot from before FC_META.historyFrom (customer counts and the
 * cloud-marketplace share of 2023–2024, the 2024 count of million-dollar customers). Most are already in the default
 * list today (model sourceKeys, events, driver points); listing them keeps the citations valid if a data update drops
 * one. Keys missing from the bundle are left out.
 */
import type { FcBundle } from '../../../lib/forecast-data';

const CITED = ['sec-fwp-eea', 'sec-fwp-japan', 'sec-fwp-ipo-site', 'sec-submissions'];
const PLOTTED = ['customers-100k', 'csp-marketplace-share-year', 'customers-1m', 'claude-code-run-rate', 'contractual-obligations'];

export function sourceKeys(b: FcBundle): string[] {
  const keys = new Set(CITED);
  for (const s of b.drivers?.series ?? []) if (PLOTTED.includes(s.id)) for (const p of s.points) keys.add(p.src);
  return [...keys].filter((k) => b.sourceByKey.has(k));
}

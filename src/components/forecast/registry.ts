/**
 * Registry of the company-specific sections of the /forecast/<id>/ pages (src/pages/forecast/[company].astro).
 *
 * Contract — a company adds files to src/components/forecast/<id>/ (<id> = FC_META id, e.g. tsmc); nothing else to
 * register, the glob below picks them up at build time and a missing file renders nothing (the page falls back to
 * the generic content):
 *
 *   Basics.astro     body of 「一分鐘看懂」 (#basics). The page renders the H2 (FC_META.basicsTitle); the slot renders
 *                    the content under it (prose, key figures, FlowSteps…). Replaces the generic summary.
 *   Drivers.astro    top of 「驅動因子」 (#drivers), under the page's H2 and lede: the most telling charts of
 *                    <id>-drivers.yaml and the model's derived series (h3 and below). The generic tables of every
 *                    driver series move into a closed 「全部驅動因子」 disclosure below it.
 *   Volume.astro     top of 「數量與營收」 (#volume), under the page's H2: replaces the generic quarterly revenue and
 *                    margin charts; the generic table of the model's derived series follows in a disclosure.
 *   Method.astro     extra content in 「模型怎麼做」 (#method), after the candidate cards and before the parameters.
 *   Backtest.astro   extra content at the end of 「回測」 (#backtest).
 *   Scenarios.astro  extra content at the end of 「情境預測」 (#scenarios).
 *   sources.ts       optional: `export function sourceKeys(b: FcBundle): string[]` — source keys a section cites
 *                    beyond the page defaults (pageSourceKeys: the model's keys, inputs from FC_META.historyFrom,
 *                    driver points from historyFrom on); they are added to the page's numbered source list.
 *
 * Every slot gets one prop, `b: FcBundle` (src/lib/forecast-data.ts: b.inputs, b.drivers, b.model, b.meta,
 * b.sourceByKey), uses headings h3 and below, cites with <FcCite k> (src/components/memory/forecast/FcCite.astro)
 * and may reuse the shared components of src/components/memory/forecast/ and src/components/forecast/.
 */
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import type { FcBundle, FcCompany } from '../../lib/forecast-data';

export const SLOT_NAMES = ['Basics', 'Drivers', 'Volume', 'Method', 'Backtest', 'Scenarios'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

const slotModules = import.meta.glob<{ default: AstroComponentFactory }>('./*/{Basics,Drivers,Volume,Method,Backtest,Scenarios}.astro', {
  eager: true,
});
const sourceModules = import.meta.glob<{ sourceKeys?: (b: FcBundle) => string[] }>('./*/sources.ts', { eager: true });

/** The company's component for a slot, or undefined (empty default). */
export function companySection(company: FcCompany, slot: SlotName): AstroComponentFactory | undefined {
  return slotModules[`./${company}/${slot}.astro`]?.default;
}

/** Extra source keys a company's sections cite (src/components/forecast/<id>/sources.ts), [] by default. */
export function companySourceKeys(b: FcBundle): string[] {
  const fn = sourceModules[`./${b.company}/sources.ts`]?.sourceKeys;
  if (typeof fn !== 'function') return [];
  try {
    return fn(b).filter((k) => typeof k === 'string' && k.length > 0);
  } catch (e) {
    console.warn(`[forecast] ${b.company}/sources.ts: ${(e as Error).message}`);
    return [];
  }
}

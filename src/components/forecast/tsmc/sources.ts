/**
 * Extra source keys of the 台積電 sections (src/components/forecast/registry.ts): the dilution statements, guidance
 * ranges and capex budgets they cite, including points before FC_META.historyFrom that the page defaults leave out.
 */
import type { FcBundle } from '../../../lib/forecast-data';
import { sectionKeys } from './tsmc-data';

export function sourceKeys(b: FcBundle): string[] {
  return sectionKeys(b);
}

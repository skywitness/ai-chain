/**
 * Extra source keys of the 輝達 sections (src/components/forecast/registry.ts): the keys named in the quarter notes
 * for the market-platform revenue, the data-center split, supply commitments and provisions (rev-*, tenq-*, cfo-*),
 * the TrendForce contract prices behind the model's memory price index, and the annual driver points (capex outlook,
 * CoWoS, AI clouds) the sections cite. Keys missing from the bundle are left out.
 */
import type { FcBundle } from '../../../lib/forecast-data';
import { sectionKeys } from './nv-data';

export function sourceKeys(b: FcBundle): string[] {
  return sectionKeys(b);
}

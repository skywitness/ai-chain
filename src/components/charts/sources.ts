/**
 * Resolve the `source` prop of the simple MDX charts (BarChart, LineChart).
 *
 * Accepted: a URL, a citation key (matched against `sources` passed in, or against the page's
 * registered sources — see pageSources), a Source-like object, or an array of these. Unresolved keys fall back to a plain pointer to
 * the page's reference list (never a broken link).
 */
import { pageState } from '../content/page-state';
import type { ChartSourceLink, SourceLike } from './types';

export type SourceInput = string | SourceLike | Array<string | SourceLike> | null | undefined;

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function resolveSources(source: SourceInput, available: ReadonlyArray<SourceLike> = []): ChartSourceLink[] {
  if (!source) return [];
  const list = Array.isArray(source) ? source : [source];
  const out: ChartSourceLink[] = [];
  for (const s of list) {
    if (!s) continue;
    if (typeof s === 'string') {
      if (/^https?:\/\//.test(s)) {
        out.push({ title: host(s), url: s });
        continue;
      }
      const hit = available.find((a) => a.key === s);
      if (hit) out.push({ title: hit.title, url: hit.url, publisher: hit.publisher });
      else if (!out.some((o) => o.title === '見本頁參考資料')) out.push({ title: '見本頁參考資料' });
      continue;
    }
    out.push({ title: s.title, url: s.url, publisher: s.publisher });
  }
  return out;
}

/**
 * The page's registered sources: layouts call registerSources(Astro, data.sources) from
 * src/components/content/page-state.ts (design system) before the MDX body renders, so <Cite k>
 * and these charts resolve the same keys.
 */
export function pageSources(astro: { locals?: unknown; request?: Request }): SourceLike[] {
  try {
    return [...pageState(astro).sources.entries()].map(([key, src]) => ({ key, title: src.title, publisher: src.publisher, url: src.url }));
  } catch {
    return [];
  }
}

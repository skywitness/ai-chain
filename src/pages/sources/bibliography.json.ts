// /sources/bibliography.json: the aggregated bibliography behind /sources/ 「參考文獻總覽」.
// Prerendered at build time. The page lists publishers server-side and loads this file the first
// time a publisher group is opened, so the HTML stays small while the list keeps growing.
// Owner: pages-reference agent.
import type { APIRoute } from 'astro';
import { getBibliography, PAGE_KIND_LABELS, SOURCE_TYPE_LABELS } from '../../components/reference/reference-data';
import { DATA_DATE } from '../../lib/seo';

export const prerender = true;

/** [title, url, typeLabel, lang, published, accessed, citedBy: [kindLabel, label, href][]] */
export type BibRow = [string, string, string, string, string, string, Array<[string, string, string]>];
export interface BibPayload {
  v: 1;
  date: string;
  groups: Record<string, BibRow[]>;
}

export const GET: APIRoute = async () => {
  const bib = await getBibliography();
  const payload: BibPayload = { v: 1, date: DATA_DATE, groups: {} };
  for (const g of bib.groups) {
    payload.groups[g.anchor] = g.entries.map((e) => [
      e.title,
      e.url,
      SOURCE_TYPE_LABELS[e.type] ?? e.type,
      e.lang,
      e.published ?? '',
      e.accessed ?? '',
      e.citedBy.map((c) => [PAGE_KIND_LABELS[c.kind], c.label, c.href] as [string, string, string]),
    ]);
  }
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

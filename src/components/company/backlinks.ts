// 「本站提及此公司的頁面」: which learn / segment / trend / model / company entries reference a
// company, through frontmatter relations or <CompanyChip id> in the MDX body. Built once per build
// (cached; refreshed after a few seconds in dev). Owner: pages-companies.
import { getCurriculumArticle, levelMeta, safeCollection, segmentMeta } from '../../lib/collections';
import { companyHref, learnHref, modelHref, segmentHref, trendHref } from '../../lib/paths';

export type BacklinkKind = 'learn' | 'segment' | 'trend' | 'model' | 'company';
export interface Backlink {
  kind: BacklinkKind;
  id: string;
  title: string;
  href: string;
  /** short context, e.g. 「入門」 or 「精選公司」 */
  note?: string | undefined;
  /** referenced in the body text (not only in metadata) */
  inBody: boolean;
}

export const BACKLINK_GROUPS: ReadonlyArray<{ kind: BacklinkKind; label: string }> = [
  { kind: 'learn', label: '學習文章' },
  { kind: 'segment', label: '產業鏈環節' },
  { kind: 'trend', label: '未來趨勢' },
  { kind: 'model', label: '大模型' },
  { kind: 'company', label: '其他公司檔案' },
];

const CHIP_RE = /<CompanyChip\b[^>]*?\bid\s*=\s*["']([a-z0-9-]+)["']/g;
/** plain Markdown / HTML links to a profile: [台積電](/companies/tsmc/) */
const LINK_RE = /[("']\/companies\/([a-z0-9-]+)\/?[)"'#]/g;
const idOf = (r: unknown): string | undefined =>
  typeof r === 'string' ? r : r && typeof r === 'object' && 'id' in r ? String((r as { id: unknown }).id) : undefined;

function bodyIds(body: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!body) return out;
  for (const m of body.matchAll(CHIP_RE)) if (m[1]) out.add(m[1]);
  for (const m of body.matchAll(LINK_RE)) if (m[1]) out.add(m[1]);
  return out;
}

type Index = Map<string, Backlink[]>;
let cache: { at: number; index: Promise<Index> } | null = null;

async function build(): Promise<Index> {
  const index: Index = new Map();
  const add = (companyId: string, link: Backlink) => {
    const list = index.get(companyId) ?? [];
    const prev = list.find((l) => l.kind === link.kind && l.id === link.id);
    if (prev) prev.inBody ||= link.inBody;
    else list.push(link);
    index.set(companyId, list);
  };
  const collect = (meta: Iterable<unknown>, body: string | undefined, make: (inBody: boolean) => Omit<Backlink, 'inBody'>, self?: string) => {
    const inBody = bodyIds(body);
    const all = new Set<string>(inBody);
    for (const r of meta) {
      const id = idOf(r);
      if (id) all.add(id);
    }
    for (const id of all) if (id !== self) add(id, { ...make(inBody.has(id)), inBody: inBody.has(id) });
  };

  const [learn, segments, trends, models, companies] = await Promise.all([
    safeCollection('learn'),
    safeCollection('segments'),
    safeCollection('trends'),
    safeCollection('models'),
    safeCollection('companies'),
  ]);

  for (const e of learn) {
    const d = e.data;
    const level = getCurriculumArticle(e.id)?.level ?? d.level;
    collect(d.relatedCompanies, e.body, () => ({
      kind: 'learn',
      id: e.id,
      title: d.title,
      href: learnHref(e.id),
      note: levelMeta(level).label,
    }));
  }
  for (const e of segments) {
    const d = e.data;
    collect(d.featuredCompanies, e.body, () => ({
      kind: 'segment',
      id: e.id,
      title: d.title,
      href: segmentHref(e.id),
      note: segmentMeta(e.id)?.short,
    }));
  }
  for (const e of trends) {
    const d = e.data;
    collect(d.relatedCompanies, e.body, () => ({ kind: 'trend', id: e.id, title: d.title, href: trendHref(e.id) }));
  }
  for (const e of models) {
    const d = e.data;
    collect(d.lab ? [d.lab] : [], e.body, () => ({
      kind: 'model',
      id: e.id,
      title: d.title,
      href: modelHref(e.id),
      note: d.labName,
    }));
  }
  for (const e of companies) {
    const d = e.data;
    const meta: unknown[] = [...d.competitors, ...d.relationships.map((r) => r.company)];
    if (d.parent) meta.push(d.parent);
    collect(
      meta,
      e.body,
      () => ({ kind: 'company', id: e.id, title: d.nameZh, href: companyHref(e.id), note: d.name !== d.nameZh ? d.name : undefined }),
      e.id,
    );
  }
  for (const list of index.values()) list.sort((a, b) => Number(b.inBody) - Number(a.inBody) || a.title.localeCompare(b.title, 'zh-Hant'));
  return index;
}

/** Pages on this site that reference `companyId` (empty array when none). */
export async function getBacklinks(companyId: string): Promise<Backlink[]> {
  const now = Date.now();
  if (!cache || (import.meta.env.DEV && now - cache.at > 5000)) cache = { at: now, index: build() };
  try {
    return (await cache.index).get(companyId) ?? [];
  } catch (err) {
    console.warn(`[backlinks] ${(err as Error).message}`);
    return [];
  }
}

// Scene data builder for `roadmap-tunnel` (docs/SCENES.md, data shape `trends`):
//   { id, title, category, milestones: [{ date, label, status }], href }[]
// `href` is site-relative WITHOUT the base path; the scene host adds the base when navigating.
// Owner: pages-trends-taiwan.

export type TrendSceneCategory = 'hardware' | 'software' | 'market' | 'policy';
export type TrendSceneStatus = 'done' | 'expected' | 'speculative';

export interface TrendSceneMilestone {
  date: string; // YYYY | YYYY-MM | YYYY-MM-DD
  label: string;
  status: TrendSceneStatus;
}

export interface TrendSceneDatum {
  id: string;
  title: string;
  category: TrendSceneCategory;
  milestones: TrendSceneMilestone[];
  href: string;
}

/** Minimal input: anything with the trend fields (TrendView from components/trend/trend-meta.ts fits). */
export interface TrendSceneInput {
  id: string;
  title: string;
  category: TrendSceneCategory;
  milestones: ReadonlyArray<{ date: string; label: string; status: TrendSceneStatus }>;
  path?: string | undefined;
}

export interface TrendSceneOptions {
  /** Below this many milestones in total, return undefined so the scene shows its illustrative fixture. */
  minMilestones?: number;
  /** Keep milestones from this year on (the tunnel starts at 2024). */
  fromYear?: number;
  /** …and up to this year (the tunnel ends at 2031). */
  toYear?: number;
}

/** The scene's own date check (YYYY | YYYY-MM | YYYY-MM-DD with valid month/day); one bad date would
 *  make its type guard reject the whole payload, so such milestones are dropped here. */
const DATE_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;
const STATUSES: ReadonlySet<string> = new Set(['done', 'expected', 'speculative']);

/**
 * Build the roadmap-tunnel payload from trend views. Trends without milestones are left out.
 * Returns undefined when there is too little real data yet (the scene then renders its fixture, marked 「示意資料」).
 */
export function buildTrendsSceneData(
  trends: readonly TrendSceneInput[],
  opts: TrendSceneOptions = {},
): TrendSceneDatum[] | undefined {
  const { minMilestones = 6, fromYear = 2024, toYear = 2031 } = opts;
  const out: TrendSceneDatum[] = [];
  let total = 0;
  for (const t of trends) {
    const milestones = t.milestones
      .filter((m) => {
        const d = String(m.date);
        const y = Number(d.slice(0, 4));
        return DATE_RE.test(d) && STATUSES.has(m.status) && y >= fromYear && y <= toYear && !!m.label;
      })
      .map((m) => ({ date: String(m.date), label: m.label, status: m.status }));
    if (!milestones.length) continue;
    total += milestones.length;
    out.push({
      id: t.id,
      title: t.title,
      category: t.category,
      milestones,
      href: t.path ?? `/trends/${t.id}/`,
    });
  }
  return total >= minMilestones ? out : undefined;
}

// Per-page render state shared by content components (Term first-occurrence tracking, Cite numbering,
// unique ids). Stored on Astro.locals (a fresh object per rendered page), with a WeakMap keyed by the
// Request as a fallback. Owner: design-system agent.
import type { SourceT } from '../../schemas/common';

export interface PageState {
  /** glossary ids whose first (interactive) occurrence has been rendered */
  terms: Set<string>;
  /** source key → 1-based number, from the page's registered sources list */
  sourceNumbers: Map<string, number>;
  /** source key → source object (for Cite tooltips) */
  sources: Map<string, SourceT>;
  /** fallback numbering for keys cited before/without registration */
  citeOrder: Map<string, number>;
  /** keys that already rendered an id="cite-<key>" anchor */
  citeAnchors: Set<string>;
  /** prefix → counter for unique ids */
  counters: Map<string, number>;
}

type AstroLike = { locals?: unknown; request?: Request };

const KEY = '__acaPageState';
const byRequest = new WeakMap<object, PageState>();

function fresh(): PageState {
  return {
    terms: new Set(),
    sourceNumbers: new Map(),
    sources: new Map(),
    citeOrder: new Map(),
    citeAnchors: new Set(),
    counters: new Map(),
  };
}

export function pageState(astro: AstroLike): PageState {
  const locals = astro.locals as Record<string, unknown> | undefined;
  if (locals && typeof locals === 'object') {
    let s = locals[KEY] as PageState | undefined;
    if (!s) {
      s = fresh();
      locals[KEY] = s;
    }
    return s;
  }
  const req = astro.request as object | undefined;
  if (req) {
    let s = byRequest.get(req);
    if (!s) {
      s = fresh();
      byRequest.set(req, s);
    }
    return s;
  }
  return fresh();
}

/** Deterministic unique id per page: uid(Astro, 'tc-hbm') → 'tc-hbm-1', 'tc-hbm-2', … */
export function uid(astro: AstroLike, prefix: string): string {
  const s = pageState(astro);
  const n = (s.counters.get(prefix) ?? 0) + 1;
  s.counters.set(prefix, n);
  return `${prefix}-${n}`;
}

/** The anchor id a Cite links to and SourcesList renders: 'src-<key>'. */
export const sourceAnchor = (key: string): string => `src-${key}`;

/**
 * Register the page's sources so <Cite k> numbers match the SourcesList order.
 * Layouts call this from their frontmatter (before the MDX body renders). Sources without a `key`
 * still take a number so the list and the citations stay aligned.
 */
export function registerSources(astro: AstroLike, sources: readonly SourceT[] | undefined): void {
  if (!sources?.length) return;
  const s = pageState(astro);
  if (s.sourceNumbers.size) return; // first registration wins
  sources.forEach((src, i) => {
    if (src.key) {
      s.sourceNumbers.set(src.key, i + 1);
      s.sources.set(src.key, src);
    }
  });
}

/** Number to show for a citation key: the registered position, else the order of first citation. */
export function citeNumber(astro: AstroLike, key: string): { n: number; registered: boolean } {
  const s = pageState(astro);
  const reg = s.sourceNumbers.get(key);
  if (reg) return { n: reg, registered: true };
  let n = s.citeOrder.get(key);
  if (!n) {
    n = s.citeOrder.size + 1;
    s.citeOrder.set(key, n);
  }
  return { n, registered: false };
}

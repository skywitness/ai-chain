/**
 * Reduced motion: `prefers-reduced-motion: reduce`, the site toggle `html[data-motion="reduce"]`,
 * or `?motion=reduce` (tests / sandbox). `html[data-motion="full"]` forces motion on.
 */
export function prefersReducedMotion(): boolean {
  const html = document.documentElement;
  const site = html.dataset['motion'];
  if (site === 'reduce') return true;
  if (site === 'full') return false;
  try {
    const q = new URLSearchParams(location.search).get('motion');
    if (q === 'reduce') return true;
    if (q === 'full') return false;
  } catch {
    /* ignore */
  }
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Calls `cb(reduced)` whenever the preference changes. Returns an unsubscribe function. */
export function watchReducedMotion(cb: (reduced: boolean) => void, signal?: AbortSignal): () => void {
  let last = prefersReducedMotion();
  const check = () => {
    const now = prefersReducedMotion();
    if (now !== last) {
      last = now;
      cb(now);
    }
  };
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', check);
  const mo = new MutationObserver(check);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  const off = () => {
    mq.removeEventListener('change', check);
    mo.disconnect();
  };
  signal?.addEventListener('abort', off, { once: true });
  return off;
}

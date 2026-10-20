// Client-side filter, search, sort and paging for server-rendered directory lists (owner: pages-companies).
// Used by /companies/ (src/components/company/CompanyDirectory.astro); budget ≤ 3 KB gz.
//
// Markup contract:
//   <div data-filter-root data-page-size="60">
//     <form data-filter-form>  q (search) · seg · region · tier · listed · tw (checkbox) · sort · view (radio)
//     <p data-filter-count aria-live="polite">  ← 「符合 42／710 家」
//     <ul data-filter-list>  <li data-segs data-region data-tier data-listed data-q data-rank> …
//     <div data-filter-more hidden>  ← paging: [data-filter-shown] status, [data-filter-next] and [data-filter-all] buttons
//     <div data-filter-empty hidden>  ← shown when nothing matches
//   </div>
// Every control is optional except the list. `data-rank` holds one sort position per value of the
// `sort` select, in option order. State is mirrored to the URL (?q=&seg=…) with replaceState and
// restored on load. Without JS the full list stays visible; with JS only the first `data-page-size`
// matches are listed until the reader asks for more (any filter or sort change starts over).

type Item = { el: HTMLElement; d: DOMStringMap; q: string; segs: string[]; rank: number[] };

const norm = (s: string) => s.normalize('NFKC').toLowerCase().trim();

function setup(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('[data-filter-form]');
  const list = root.querySelector<HTMLElement>('[data-filter-list]');
  if (!form || !list) return;
  const $ = (sel: string) => root.querySelector<HTMLElement>(sel);
  const count = $('[data-filter-count]');
  const empty = $('[data-filter-empty]');
  const more = $('[data-filter-more]');
  const shownEl = $('[data-filter-shown]');
  const nextBtn = $('[data-filter-next]');
  const sortSel = form.elements.namedItem('sort') as HTMLSelectElement | null;
  const sorts = sortSel ? Array.from(sortSel.options, (o) => o.value) : [''];
  let order: Item[] = Array.from(list.children as HTMLCollectionOf<HTMLElement>, (el) => ({
    el,
    d: el.dataset,
    q: el.dataset['q'] ?? '',
    segs: (el.dataset['segs'] ?? '').split(' '),
    rank: (el.dataset['rank'] ?? '').split(' ').map(Number),
  }));
  const total = order.length;
  const page = Number(root.dataset['pageSize']) || Infinity;
  const defaults = new Map<string, string>();
  for (const [k, v] of new FormData(form)) defaults.set(k, String(v));
  let sorted = 0;
  let timer = 0;
  let limit = page;
  let lastKey = '';

  // restore state from the URL
  new URLSearchParams(location.search).forEach((v, k) => {
    const el = form.elements.namedItem(k) as (HTMLInputElement & RadioNodeList) | HTMLSelectElement | null;
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = v === '1' || v === 'on';
    else if (el instanceof HTMLSelectElement) {
      if (Array.from(el.options).some((o) => o.value === v)) el.value = v;
    } else (el as { value: string }).value = v;
  });

  /** re-filter, re-sort and re-page; returns the first item that became visible (for focus) */
  const apply = (): Item | undefined => {
    const fd = new FormData(form);
    const get = (k: string) => String(fd.get(k) ?? '');
    const terms = norm(get('q')).split(/\s+/).filter(Boolean);
    const seg = get('seg');
    const region = get('region');
    const tier = get('tier');
    const listed = get('listed');
    const tw = !!fd.get('tw');
    const k = Math.max(0, sorts.indexOf(get('sort')));
    const key = [terms.join(' '), seg, region, tier, listed, tw, k].join('|');
    if (key !== lastKey) {
      lastKey = key;
      limit = page;
    }
    if (k !== sorted) {
      sorted = k;
      order = order.slice().sort((a, b) => (a.rank[k] ?? 0) - (b.rank[k] ?? 0));
      list.append(...order.map((i) => i.el));
    }
    let n = 0;
    let firstNew: Item | undefined;
    for (const it of order) {
      const d = it.d;
      const ok =
        (!seg || it.segs.includes(seg)) &&
        (!region || d['region'] === region) &&
        (!tw || d['region'] === 'TW') &&
        (!tier || d['tier'] === tier) &&
        (!listed || d['listed'] === listed) &&
        terms.every((t) => it.q.includes(t));
      const show = ok && n < limit;
      if (ok) n++;
      if (it.el.hidden === show) {
        if (show && !firstNew) firstNew = it;
        it.el.hidden = !show;
      }
    }
    const shown = Math.min(n, limit);
    if (count) count.textContent = `符合 ${n}／${total} 家`;
    if (empty) empty.hidden = n > 0;
    if (more) more.hidden = shown >= n;
    if (shownEl) shownEl.textContent = `已列出 ${shown}／${n} 家`;
    if (nextBtn) nextBtn.textContent = `再顯示 ${Math.min(page, n - shown)} 家`;
    root.dataset['view'] = get('view') || 'grid';

    const p = new URLSearchParams();
    fd.forEach((v, key) => {
      const s = String(v).trim();
      if (s && defaults.get(key) !== s) p.set(key, s);
    });
    const qs = p.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    return firstNew;
  };

  /** show more items, then move focus to the first new card so keyboard users keep their place */
  const grow = (to: number): void => {
    limit = to;
    apply()?.el.querySelector<HTMLElement>('a')?.focus();
  };

  form.addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = window.setTimeout(apply, (e.target as HTMLElement).matches('input[type=search],input[type=text]') ? 160 : 0);
  });
  form.addEventListener('change', () => apply());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    apply();
  });
  form.addEventListener('reset', () => setTimeout(apply));
  root.querySelectorAll<HTMLElement>('[data-filter-reset]').forEach((b) =>
    b.addEventListener('click', () => {
      form.reset();
      setTimeout(apply);
    }),
  );
  nextBtn?.addEventListener('click', () => grow(limit + page));
  $('[data-filter-all]')?.addEventListener('click', () => grow(Infinity));
  root.classList.add('is-enhanced');
  apply();
}

document.querySelectorAll<HTMLElement>('[data-filter-root]').forEach(setup);

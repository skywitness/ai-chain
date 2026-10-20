// /models/compare/ — progressive enhancement for the model comparison.
// The page server-renders a preset comparison (works without JS). This script fills the four
// version pickers from the embedded JSON, reads ?m=a,b,c, re-renders the table with the shared
// renderer (components/model/compare-core.ts) and keeps the URL in sync. Owner: pages-models.
import {
  MAX_SELECTED,
  MIN_SELECTED,
  renderCompareTable,
  resolveSelection,
  type CompareData,
  type CompareVersion,
} from '../components/model/compare-core';

function readData(root: HTMLElement): CompareData | null {
  const el = root.querySelector<HTMLScriptElement>('script[data-compare-json]');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as CompareData;
  } catch {
    return null;
  }
}

function urlTokens(): string[] {
  try {
    const m = new URLSearchParams(window.location.search).get('m');
    return m ? m.split(',').map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeUrl(keys: readonly string[]): void {
  try {
    const url = new URL(window.location.href);
    url.search = keys.length ? `?m=${keys.map(encodeURIComponent).join(',')}` : '';
    history.replaceState(history.state, '', url);
  } catch {
    /* ignore (sandboxed iframes, file:) */
  }
}

function optionLabel(v: CompareVersion): string {
  const tags: string[] = [];
  if (v.flagship) tags.push('旗艦');
  if (v.status === '已下架' || v.status === '停止更新') tags.push(v.status);
  return tags.length ? `${v.name}（${tags.join('・')}）` : v.name;
}

function fillSelect(select: HTMLSelectElement, versions: CompareVersion[], slot: number): void {
  const doc = select.ownerDocument;
  select.textContent = '';
  const none = doc.createElement('option');
  none.value = '';
  none.textContent = slot < MIN_SELECTED ? '（請選擇版本）' : '（不選）';
  select.append(none);
  let group: HTMLOptGroupElement | null = null;
  let current = '';
  for (const v of versions) {
    if (v.familyTitle !== current) {
      current = v.familyTitle;
      group = doc.createElement('optgroup');
      group.label = `${v.familyTitle}（${v.kind}）`;
      select.append(group);
    }
    const o = doc.createElement('option');
    o.value = v.key;
    o.textContent = optionLabel(v);
    (group ?? select).append(o);
  }
}

function init(root: HTMLElement): void {
  const data = readData(root);
  const out = root.querySelector<HTMLElement>('[data-compare-out]');
  const form = root.querySelector<HTMLFormElement>('form[data-compare-form]');
  if (!data || !out || !form) return;
  const selects = Array.from(form.querySelectorAll<HTMLSelectElement>('select[data-slot]')).slice(0, MAX_SELECTED);
  const live = root.querySelector<HTMLElement>('[data-compare-live]');
  const presets = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-preset]'));
  selects.forEach((s, i) => fillSelect(s, data.versions, i));

  const render = (sel: CompareVersion[], sync: boolean) => {
    selects.forEach((s, i) => {
      s.value = sel[i]?.key ?? '';
    });
    out.innerHTML =
      sel.length < MIN_SELECTED
        ? `<p class="cmp__empty">請至少選擇兩個版本來比較（目前 ${sel.length} 個）。</p>${sel.length ? renderCompareTable(sel, data.benches, data.strengths) : ''}`
        : renderCompareTable(sel, data.benches, data.strengths);
    const keys = sel.map((v) => v.key);
    for (const b of presets) b.setAttribute('aria-pressed', String(b.dataset['preset'] === keys.join(',')));
    if (sync) {
      writeUrl(keys);
      if (live) live.textContent = `已更新比較表：${sel.map((v) => v.name).join('、') || '尚未選擇'}。`;
    }
  };

  const fromSelects = () => resolveSelection(selects.map((s) => s.value), data.versions);

  form.addEventListener('change', () => render(fromSelects(), true));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    render(fromSelects(), true);
  });
  for (const b of presets) {
    b.addEventListener('click', () => render(resolveSelection((b.dataset['preset'] ?? '').split(','), data.versions), true));
  }
  root.querySelector<HTMLButtonElement>('[data-compare-clear]')?.addEventListener('click', () => {
    selects.forEach((s) => (s.value = ''));
    render([], true);
    selects[0]?.focus();
  });

  const fromUrl = resolveSelection(urlTokens(), data.versions);
  const initial = fromUrl.length ? fromUrl : resolveSelection(data.defaults, data.versions);
  render(initial, false);
  root.classList.add('is-enhanced');
}

document.querySelectorAll<HTMLElement>('[data-compare-root]').forEach(init);

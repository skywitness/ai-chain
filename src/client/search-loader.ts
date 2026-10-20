// Lazy loader for the Pagefind Component UI. Owner: design-system agent.
//
// Nothing is downloaded until the first search: a click on any [data-search-trigger] button or
// Ctrl/⌘+K injects /pagefind/pagefind-component-ui.{css,js} (resolved with the base path), then opens a
// <pagefind-modal>. Pagefind only exists after `npm run build` (pagefind --site dist), so in dev a
// notice dialog explains 「搜尋需於建置後使用」.
import { withBase } from '../lib/paths';

type PagefindModal = HTMLElement & { open?: () => void; close?: () => void; dialogEl?: HTMLDialogElement | null };

/* ───────── Chinese search tuning (architecture §7.1) ─────────
 * Pagefind segments Chinese twice, differently: the index with jieba (a Simplified-Chinese
 * dictionary, so most Traditional names end up as single characters, e.g. 台／積／電) and the
 * query in the browser with Intl.Segmenter (ICU, e.g. 艾／司／摩爾). Pagefind needs every query
 * word to start an indexed word, so a mismatch returns nothing. Two small corrections:
 *  1. termSimilarity 4 (default 1): prefer whole-token matches, so 「台積電」 ranks the 台積電 page
 *     above pages that merely contain 台灣…、…電力.
 *  2. A Chinese query that finds nothing is retried with its trailing ICU words dropped
 *     (「三星電子」 → 「三星」), then with its characters split (「艾司摩爾」 → 「艾 司 摩 爾」).
 * Measured on the 401 company names written in Han characters (top 3 / zero results):
 * 332 / 31 before → 369 / 0 after. Both go through the Component UI instance; anything unexpected
 * leaves Pagefind untouched. */
type PagefindResult = { results: unknown[] } | null;
type PagefindSearch = (term: string | null, options?: unknown) => Promise<PagefindResult>;
type PagefindApi = { search?: PagefindSearch };
type PagefindComponents = { configureInstance?: (name: string, options: Record<string, unknown>) => object | undefined };

const RANKING = { termSimilarity: 4 };
const HAN = /\p{Script=Han}/u;
const HAN_PAIR = /(\p{Script=Han})(?=\p{Script=Han})/gu;
const MAX_RETRIES = 4;

/** Fallback queries for a Chinese query without results, most specific first. */
function fallbackTerms(term: string): string[] {
  const out: string[] = [];
  try {
    const words = [...new Intl.Segmenter('zh-TW', { granularity: 'word' }).segment(term)]
      .filter((s) => s.isWordLike)
      .map((s) => s.segment);
    for (let n = words.length - 1; n >= 1 && out.length < MAX_RETRIES - 1; n--) out.push(words.slice(0, n).join(' '));
  } catch {
    /* no Intl.Segmenter: only the character split below */
  }
  const split = term.replace(HAN_PAIR, '$1 ');
  if (split !== term) out.push(split);
  return [...new Set(out)].filter((t) => t && t !== term);
}

function withHanFallback(api: unknown): unknown {
  const pf = api as PagefindApi | null;
  const search = pf?.search;
  if (!pf || typeof search !== 'function') return api;
  const run: PagefindSearch = (term, options) => search.call(pf, term, options);
  pf.search = async (term, options) => {
    const first = await run(term, options);
    if (!term || !first || first.results.length > 0 || !HAN.test(term)) return first;
    for (const alt of fallbackTerms(term)) {
      const r = await run(alt, options);
      if (r && r.results.length > 0) return r;
    }
    return first;
  };
  return api;
}

function tuneSearch(): void {
  try {
    const pc = (window as Window & { PagefindComponents?: PagefindComponents }).PagefindComponents;
    // bundlePath explicitly: otherwise the UI derives it from document.currentScript and falls back
    // to '/pagefind/', which is wrong under a base path (GitHub Pages).
    const inst = pc?.configureInstance?.('default', { bundlePath: withBase('/pagefind/'), ranking: RANKING });
    if (!inst || !Object.prototype.hasOwnProperty.call(inst, '__pagefind__')) return;
    let api = withHanFallback((inst as Record<string, unknown>)['__pagefind__'] ?? null);
    Object.defineProperty(inst, '__pagefind__', {
      configurable: true,
      enumerable: true,
      get: () => api,
      set: (v: unknown) => {
        api = withHanFallback(v);
      },
    });
  } catch (err) {
    console.warn('[search] tuning skipped', err);
  }
}

const DEV_MESSAGE = '搜尋需於建置後使用。請執行 npm run build 後以 npm run preview 預覽，即可使用全站搜尋。';
const ERROR_MESSAGE = '搜尋功能暫時無法載入，請重新整理頁面後再試一次。';

let loading: Promise<void> | null = null;
let modal: PagefindModal | null = null;
let lastTrigger: HTMLElement | null = null;

function isMac(): boolean {
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

function showNotice(message: string): void {
  const dialog = document.getElementById('search-notice') as HTMLDialogElement | null;
  if (!dialog) {
    window.alert(message);
    return;
  }
  const msg = dialog.querySelector('[data-search-notice-message]');
  if (msg) msg.textContent = message;
  if (!dialog.open) dialog.showModal();
}

function loadAssets(): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    if (!document.querySelector('link[data-pagefind-css]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = withBase('/pagefind/pagefind-component-ui.css');
      css.dataset['pagefindCss'] = '';
      document.head.append(css);
    }
    const script = document.createElement('script');
    // A classic script (the bundle is an IIFE): document.currentScript is then set while it runs,
    // which the UI uses to resolve the bundle path under a base path. type=module made it null.
    script.src = withBase('/pagefind/pagefind-component-ui.js');
    script.onload = () => {
      customElements
        .whenDefined('pagefind-modal')
        .then(() => {
          tuneSearch(); // before the first component creates the 'default' instance
          resolve();
        })
        .catch(reject);
    };
    script.onerror = () => reject(new Error('pagefind-component-ui.js failed to load'));
    document.head.append(script);
  }).catch((err: unknown) => {
    loading = null; // allow a retry on the next attempt
    throw err;
  });
  return loading;
}

function ensureModal(): PagefindModal {
  if (modal?.isConnected) return modal;
  modal = document.createElement('pagefind-modal') as PagefindModal;
  modal.setAttribute('reset-on-close', '');
  document.body.append(modal);
  modal.addEventListener('close', () => lastTrigger?.focus(), true);
  return modal;
}

export async function openSearch(trigger?: HTMLElement | null): Promise<void> {
  lastTrigger = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (import.meta.env.DEV) {
    showNotice(DEV_MESSAGE);
    return;
  }
  const triggers = document.querySelectorAll<HTMLElement>('[data-search-trigger]');
  triggers.forEach((t) => t.setAttribute('aria-busy', 'true'));
  try {
    await loadAssets();
    const m = ensureModal();
    // init() runs synchronously on connect; wait one frame for safety before opening.
    await new Promise((r) => requestAnimationFrame(r));
    if (typeof m.open === 'function') m.open();
    else m.dialogEl?.showModal();
  } catch (err) {
    console.warn('[search]', err);
    showNotice(ERROR_MESSAGE);
  } finally {
    triggers.forEach((t) => t.removeAttribute('aria-busy'));
  }
}

function init(): void {
  if (isMac()) {
    document.querySelectorAll<HTMLElement>('[data-search-kbd]').forEach((k) => {
      k.textContent = '⌘ K';
    });
    document.querySelectorAll<HTMLElement>('[data-search-trigger]').forEach((b) => {
      b.setAttribute('aria-keyshortcuts', 'Meta+K');
    });
  }

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const trigger = el?.closest<HTMLElement>('[data-search-trigger]');
    if (trigger) {
      e.preventDefault();
      void openSearch(trigger);
      return;
    }
    const close = el?.closest<HTMLElement>('[data-search-notice-close]');
    if (close) (close.closest('dialog') as HTMLDialogElement | null)?.close();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      // Leave the shortcut alone while a search dialog is already open.
      if (modal?.dialogEl?.open) return;
      e.preventDefault();
      void openSearch(document.querySelector<HTMLElement>('[data-search-trigger]'));
    }
  });

  // Light-dismiss for the notice dialog (click on the backdrop).
  const notice = document.getElementById('search-notice') as HTMLDialogElement | null;
  notice?.addEventListener('click', (e) => {
    if (e.target === notice) notice.close();
  });
  notice?.addEventListener('close', () => lastTrigger?.focus());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

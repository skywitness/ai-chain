// Page health probes: console errors, uncaught exceptions, failed same-origin requests, horizontal overflow.
import type { Page, Request, Response } from '@playwright/test';

export interface ProblemLog {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface TrackOptions {
  /** Origin whose requests must not fail (defaults to the origin of the first navigation). */
  origin?: string;
  /** Extra console-error patterns to ignore (QA_IGNORE_CONSOLE env adds one more, as a regex string). */
  ignoreConsole?: RegExp[];
  /** URLs (exact) whose HTTP error status is expected, e.g. the 404 page's own document. */
  expectedErrorUrls?: string[];
}

export interface ProblemTracker {
  readonly log: ProblemLog;
  /** All problems as one flat, human-readable list. */
  all(): string[];
  /** Stop listening. */
  dispose(): void;
}

function envIgnore(): RegExp[] {
  const raw = process.env['QA_IGNORE_CONSOLE'];
  return raw ? [new RegExp(raw)] : [];
}

/** Start collecting console errors, page errors and failed same-origin requests on `page`. */
export function trackProblems(page: Page, opts: TrackOptions = {}): ProblemTracker {
  const log: ProblemLog = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  const ignore = [...(opts.ignoreConsole ?? []), ...envIgnore()];
  const expected = new Set(opts.expectedErrorUrls ?? []);
  let origin = opts.origin ? new URL(opts.origin).origin : '';
  const sameOrigin = (url: string) => {
    try {
      const u = new URL(url);
      if (!origin) return false;
      return u.origin === origin;
    } catch {
      return false;
    }
  };

  const onFrameNavigated = (frame: import('@playwright/test').Frame) => {
    if (!origin && frame === page.mainFrame()) {
      try {
        origin = new URL(frame.url()).origin;
      } catch {
        /* about:blank */
      }
    }
  };
  const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignore.some((re) => re.test(text))) return;
    // Resource-load failures are reported (with the URL) by the response listener instead.
    if (/^Failed to load resource:/.test(text)) {
      const url = msg.location().url;
      if (url && expected.has(url)) return;
      if (url && sameOrigin(url)) return;
    }
    const loc = msg.location();
    log.consoleErrors.push(loc.url ? `${text}  (${loc.url}:${loc.lineNumber + 1})` : text);
  };
  const onPageError = (err: Error) => {
    const firstFrame = (err.stack ?? '').split('\n').find((l) => /^\s+at /.test(l))?.trim();
    log.pageErrors.push(firstFrame ? `${err.message}  ${firstFrame}` : err.message);
  };
  const onRequestFailed = (req: Request) => {
    const url = req.url();
    if (!sameOrigin(url)) return;
    const text = req.failure()?.errorText ?? 'failed';
    // Cancelled by navigation/teardown or an aborted prefetch — not a broken resource.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(text)) return;
    log.failedRequests.push(`${req.method()} ${url} — ${text}`);
  };
  const onResponse = (res: Response) => {
    const url = res.url();
    if (!sameOrigin(url) || res.status() < 400 || expected.has(url)) return;
    log.failedRequests.push(`${res.request().method()} ${url} — HTTP ${res.status()}`);
  };

  page.on('framenavigated', onFrameNavigated);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  return {
    log,
    all: () => [
      ...log.pageErrors.map((e) => `pageerror: ${e}`),
      ...log.consoleErrors.map((e) => `console.error: ${e}`),
      ...log.failedRequests.map((e) => `request: ${e}`),
    ],
    dispose() {
      page.off('framenavigated', onFrameNavigated);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

export interface OverflowReport {
  /** Layout viewport width (documentElement.clientWidth). */
  viewportWidth: number;
  /** Widest scrollable extent of the page. */
  scrollWidth: number;
  /** scrollWidth − viewportWidth (≤ 0 means no horizontal page scroll). */
  overflowPx: number;
  /** Outermost elements that stick out past the right (or left) edge, worst first (only when overflowing). */
  offenders: { selector: string; left: number; right: number; width: number }[];
}

/** Measure horizontal page overflow at the current viewport size. */
export async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    const sw = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const overflowPx = sw - vw;
    const offenders: { selector: string; left: number; right: number; width: number }[] = [];
    if (overflowPx > 0) {
      const describe = (el: Element) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += `#${el.id}`;
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) s += `.${cls.join('.')}`;
        const parent = el.parentElement;
        const ptag = parent && parent !== document.body ? parent.tagName.toLowerCase() + (parent.id ? `#${parent.id}` : '') : '';
        return ptag ? `${ptag} > ${s}` : s;
      };
      const clipsX = (el: Element) => {
        const ox = getComputedStyle(el).overflowX;
        return ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll';
      };
      const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 8000);
      const sticking = new Set<Element>();
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 1 || r.left < -1) {
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed') continue;
          // Ignore content that an ancestor clips or scrolls (e.g. a wide table in its own scroll container).
          let a = el.parentElement;
          let clipped = false;
          while (a && a !== document.body) {
            if (clipsX(a)) {
              clipped = true;
              break;
            }
            a = a.parentElement;
          }
          if (!clipped) sticking.add(el);
        }
      }
      for (const el of sticking) {
        if (el.parentElement && sticking.has(el.parentElement)) continue; // report the outermost only
        const r = el.getBoundingClientRect();
        offenders.push({ selector: describe(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
      }
      offenders.sort((x, y) => y.right - x.right);
    }
    return { viewportWidth: vw, scrollWidth: sw, overflowPx, offenders: offenders.slice(0, 8) };
  });
}

/** One-line description of an overflow report for assertion messages. */
export function describeOverflow(r: OverflowReport): string {
  if (r.overflowPx <= 0) return `no overflow (${r.scrollWidth}px ≤ ${r.viewportWidth}px)`;
  const who = r.offenders.length ? `; offenders: ${r.offenders.map((o) => `${o.selector} [${o.left}…${o.right}]`).join(', ')}` : '';
  return `page is ${r.scrollWidth}px wide at a ${r.viewportWidth}px viewport (+${r.overflowPx}px)${who}`;
}

/**
 * A persistent text card pinned to a corner of the stage (e.g. the Rayleigh criterion in the
 * 解析度 step). Local stand-in for a kit capability proposed in proposals/scene-euv-litho.yaml.
 * Built with DOM APIs only (no innerHTML), styled with the site's .scene-card tokens, aria-hidden
 * (the step caption and the scene description carry the same text).
 */
export interface PanelRow {
  k: string;
  v: string;
}
export interface PanelContent {
  title: string;
  /** A prominent formula / headline line. */
  formula?: string;
  rows?: PanelRow[];
  note?: string;
}

export class InfoPanel {
  readonly el: HTMLDivElement;
  private key = '';

  constructor(stage: HTMLElement, signal: AbortSignal) {
    const el = document.createElement('div');
    el.className = 'scene-card euv-panel';
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
    const s = el.style;
    s.transform = 'none';
    s.top = '10px';
    s.left = '10px';
    s.zIndex = '4';
    s.transition = 'opacity 220ms ease';
    stage.appendChild(el);
    this.el = el;
    signal.addEventListener('abort', () => el.remove(), { once: true });
  }

  show(c: PanelContent | null, opts: { narrow: boolean; compact?: boolean; reduced: boolean }): void {
    const el = this.el;
    el.style.transition = opts.reduced ? 'none' : 'opacity 220ms ease';
    el.style.maxWidth = opts.narrow ? 'calc(100% - 20px)' : 'min(24rem, 44%)';
    el.style.fontSize = opts.narrow ? '12px' : '';
    el.style.padding = opts.narrow ? '8px 10px' : '';
    if (!c) {
      el.style.opacity = '0';
      el.hidden = true;
      this.key = '';
      return;
    }
    const key = JSON.stringify(c) + (opts.narrow ? '|narrow' : '') + (opts.compact ? '|compact' : '');
    const fresh = el.hidden || !this.key.startsWith(JSON.stringify(c));
    if (key !== this.key) {
      this.key = key;
      el.textContent = '';
      el.appendChild(text('p', 'scene-card-title', c.title));
      if (c.formula) {
        const f = text('p', '', c.formula);
        f.style.fontSize = opts.narrow ? '15px' : 'var(--fs-l, 1.2rem)';
        f.style.fontWeight = '600';
        f.style.letterSpacing = '0.02em';
        f.style.fontVariantNumeric = 'tabular-nums';
        el.appendChild(f);
      }
      // Compact (phone-width) stages keep the title, formula and note; the step caption carries the rest.
      if (c.rows?.length && !opts.compact) {
        const dl = document.createElement('dl');
        dl.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0 0';
        for (const r of c.rows) {
          const dt = text('dt', '', r.k);
          dt.style.fontWeight = '600';
          dt.style.whiteSpace = 'nowrap';
          const dd = text('dd', 'scene-card-body', r.v);
          dd.style.margin = '0';
          dl.append(dt, dd);
        }
        el.appendChild(dl);
      }
      if (c.note) el.appendChild(text('p', 'scene-card-sub', c.note));
    }
    el.hidden = false;
    if (fresh) {
      el.style.opacity = '0';
      void el.offsetWidth; // restart the fade only for new content (not on every resize)
    }
    el.style.opacity = '1';
  }
}

function text(tag: string, cls: string, t: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = t;
  return e;
}

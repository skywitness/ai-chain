/**
 * The info card shown on hover / select. One element per stage, built with DOM APIs (never
 * innerHTML), clamped inside the stage. Hover cards ignore the pointer; selected (touch, list,
 * keyboard) cards are interactive and carry the 「前往」 link.
 */
import type { CardApi, CardContent, Vec3Like } from './types';

export class CardImpl implements CardApi {
  readonly el: HTMLElement;
  private shown = false;

  constructor(
    private readonly stage: HTMLElement,
    private readonly env: {
      project(w: Vec3Like): { x: number; y: number } | null;
      href(p: string): string;
    },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'scene-card';
    this.el.hidden = true;
    stage.appendChild(this.el);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(c: CardContent, at: Vec3Like | { x: number; y: number }, opts: { interactive?: boolean; hint?: boolean } = {}): void {
    const el = this.el;
    el.textContent = '';
    const h = document.createElement('p');
    h.className = 'scene-card-title';
    if (c.swatch) {
      const i = document.createElement('i');
      i.className = 'scene-card-swatch';
      i.style.background = c.swatch;
      h.appendChild(i);
    }
    h.appendChild(document.createTextNode(c.title));
    el.appendChild(h);
    if (c.subtitle) el.appendChild(textEl('p', 'scene-card-sub', c.subtitle));
    if (c.body) el.appendChild(textEl('p', 'scene-card-body', c.body));
    if (c.items?.length) {
      const ul = document.createElement('ul');
      ul.className = 'scene-card-items';
      for (const it of c.items) {
        const li = document.createElement('li');
        if (it.href && opts.interactive) {
          const a = document.createElement('a');
          a.href = this.env.href(it.href);
          a.textContent = it.label;
          li.appendChild(a);
        } else li.appendChild(textEl('span', '', it.label));
        if (it.meta) li.appendChild(textEl('span', 'scene-card-meta', it.meta));
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
    if (c.href) {
      if (opts.interactive) {
        const a = document.createElement('a');
        a.className = 'scene-card-link';
        a.href = this.env.href(c.href);
        a.textContent = c.linkLabel ?? '前往了解 →';
        el.appendChild(a);
      } else if (opts.hint !== false) {
        const verb = (c.linkLabel ?? '前往了解').replace(/\s*→\s*$/, '');
        el.appendChild(textEl('p', 'scene-card-hint', `點擊${verb}`));
      }
    }
    el.classList.toggle('is-interactive', !!opts.interactive);
    el.hidden = false;
    this.shown = true;

    const p = Array.isArray(at) || (at as { isVector3?: boolean }).isVector3 ? this.env.project(at as Vec3Like) : (at as { x: number; y: number });
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    let x = (p?.x ?? sw / 2) + 16;
    let y = (p?.y ?? sh / 2) + 12;
    if (x + w > sw - 8) x = (p?.x ?? sw / 2) - w - 16;
    if (y + hh > sh - 8) y = sh - hh - 8;
    x = Math.max(8, Math.min(x, sw - w - 8));
    y = Math.max(8, y);
    el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.hidden = true;
    this.el.classList.remove('is-interactive');
  }

  destroy(): void {
    this.el.remove();
  }
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.textContent = text;
  return e;
}

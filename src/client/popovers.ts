// Progressive enhancement for native popovers (glossary Term cards and any other trigger that opts in).
// Owner: design-system agent.
//
// Markup contract (rendered by src/components/content/Term.astro):
//   <button type="button" popovertarget="tc-hbm-1" data-hover-popover>HBM</button>
//   <span popover id="tc-hbm-1" data-popover-card>…</span>
//
// Without JS the native Popover API already gives click/Enter to open, Esc and light dismiss.
// This module adds:
//   1. hover intent on fine pointers (open after a short delay, close when the pointer leaves);
//   2. JS positioning next to the trigger when CSS anchor positioning is unsupported (≥ 640px;
//      below that the CSS bottom-sheet layout is used).

const OPEN_DELAY = 220;
const CLOSE_DELAY = 260;
const GAP = 8;
const MARGIN = 8;

const supportsAnchor =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('anchor-name: --a');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const wide = matchMedia('(min-width: 640px)');

type CardState = { openTimer?: number; closeTimer?: number; byHover: boolean };
const state = new WeakMap<HTMLElement, CardState>();

function cardFor(trigger: Element): HTMLElement | null {
  const id = trigger.getAttribute('popovertarget');
  return id ? document.getElementById(id) : null;
}
function triggerFor(card: HTMLElement): HTMLElement | null {
  return card.id ? document.querySelector<HTMLElement>(`[popovertarget="${CSS.escape(card.id)}"]`) : null;
}
function st(card: HTMLElement): CardState {
  let s = state.get(card);
  if (!s) {
    s = { byHover: false };
    state.set(card, s);
  }
  return s;
}
function isOpen(card: HTMLElement): boolean {
  try {
    return card.matches(':popover-open');
  } catch {
    return false;
  }
}
function clearTimers(s: CardState): void {
  if (s.openTimer) window.clearTimeout(s.openTimer);
  if (s.closeTimer) window.clearTimeout(s.closeTimer);
  delete s.openTimer;
  delete s.closeTimer;
}

function position(card: HTMLElement): void {
  if (supportsAnchor || !wide.matches) {
    card.style.removeProperty('inset');
    card.style.removeProperty('top');
    card.style.removeProperty('left');
    card.style.removeProperty('margin');
    return;
  }
  const trigger = triggerFor(card);
  if (!trigger) return;
  const r = trigger.getBoundingClientRect();
  card.style.margin = '0';
  card.style.inset = 'auto';
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let top = r.bottom + GAP;
  if (top + h > vh - MARGIN && r.top - GAP - h > MARGIN) top = r.top - GAP - h;
  const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, MARGIN), vw - w - MARGIN);
  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

function show(card: HTMLElement, byHover: boolean): void {
  const s = st(card);
  clearTimers(s);
  if (isOpen(card)) return;
  s.byHover = byHover;
  try {
    card.showPopover();
  } catch {
    /* already open or detached */
  }
}
function hide(card: HTMLElement): void {
  const s = st(card);
  clearTimers(s);
  if (!isOpen(card)) return;
  try {
    card.hidePopover();
  } catch {
    /* ignore */
  }
}

function hoverTarget(e: Event): { trigger: HTMLElement | null; card: HTMLElement | null } {
  const el = e.target instanceof Element ? e.target : null;
  const trigger = el?.closest<HTMLElement>('[data-hover-popover][popovertarget]') ?? null;
  const card = el?.closest<HTMLElement>('[data-popover-card]') ?? null;
  return { trigger, card };
}

document.addEventListener('pointerover', (e) => {
  if (!finePointer.matches || (e as PointerEvent).pointerType !== 'mouse') return;
  const { trigger, card } = hoverTarget(e);
  if (trigger) {
    const c = cardFor(trigger);
    if (!c) return;
    const s = st(c);
    if (s.closeTimer) window.clearTimeout(s.closeTimer);
    delete s.closeTimer;
    if (!isOpen(c) && !s.openTimer) s.openTimer = window.setTimeout(() => show(c, true), OPEN_DELAY);
  } else if (card) {
    const s = st(card);
    if (s.closeTimer) window.clearTimeout(s.closeTimer);
    delete s.closeTimer;
  }
});

document.addEventListener('pointerout', (e) => {
  if ((e as PointerEvent).pointerType !== 'mouse') return;
  const { trigger, card } = hoverTarget(e);
  const c = trigger ? cardFor(trigger) : card;
  if (!c) return;
  const s = st(c);
  const to = (e as PointerEvent).relatedTarget;
  // Moving between the trigger and its card keeps it open.
  if (to instanceof Node && (c.contains(to) || (trigger ?? triggerFor(c))?.contains(to))) return;
  if (s.openTimer) {
    window.clearTimeout(s.openTimer);
    delete s.openTimer;
  }
  if (isOpen(c) && s.byHover && !s.closeTimer) s.closeTimer = window.setTimeout(() => hide(c), CLOSE_DELAY);
});

// A click on a hover-opened trigger "pins" the card instead of toggling it closed.
document.addEventListener(
  'click',
  (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const trigger = el?.closest<HTMLElement>('[data-hover-popover][popovertarget]');
    if (!trigger) return;
    const c = cardFor(trigger);
    if (!c) return;
    const s = st(c);
    clearTimers(s);
    if (isOpen(c) && s.byHover) {
      e.preventDefault();
      s.byHover = false;
    }
  },
  true,
);

// `toggle` does not bubble, but capture listeners on document still see it.
document.addEventListener(
  'toggle',
  (e) => {
    const card = e.target;
    if (!(card instanceof HTMLElement) || !card.hasAttribute('data-popover-card')) return;
    const opening = (e as ToggleEvent).newState === 'open';
    if (opening) position(card);
    else st(card).byHover = false;
  },
  true,
);

// Keep JS-positioned cards attached to their trigger while scrolling/resizing.
let raf = 0;
function repositionOpen(): void {
  if (supportsAnchor) return;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    document.querySelectorAll<HTMLElement>('[data-popover-card]').forEach((c) => {
      if (isOpen(c)) position(c);
    });
  });
}
window.addEventListener('scroll', repositionOpen, { passive: true });
window.addEventListener('resize', repositionOpen, { passive: true });

export {};

/**
 * One delegated tooltip for every build-time chart on the page (~1.5 KB minified).
 * Marks carry data-tip="title\nlabel\tvalue\nlabel\tvalue". Text is inserted with
 * textContent only. Pointer only (mouse hover, touch tap); keyboard users read the data table.
 * Esc dismisses (WCAG 1.4.13). The script is idempotent if included more than once.
 */
const KEY = '__chTip';
const w = window as unknown as Record<string, unknown>;

if (!w[KEY]) {
  w[KEY] = 1;
  let box: HTMLDivElement | null = null;
  let cur: Element | null = null;

  const el = () => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'ch-tip';
      box.hidden = true;
      box.setAttribute('aria-hidden', 'true');
      document.body.append(box);
    }
    return box;
  };

  const hide = () => {
    cur?.classList.remove('is-hot');
    cur = null;
    if (box) box.hidden = true;
  };

  const place = (x: number, y: number) => {
    const b = el();
    const { innerWidth: vw, innerHeight: vh } = window;
    const r = b.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
    if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 14);
    b.style.translate = `${Math.round(left)}px ${Math.round(top)}px`;
  };

  const show = (t: Element, x: number, y: number) => {
    if (t !== cur) {
      cur?.classList.remove('is-hot');
      cur = t;
      t.classList.add('is-hot');
      const b = el();
      const lines = (t.getAttribute('data-tip') || '').split('\n');
      b.replaceChildren(
        ...lines.map((line, i) => {
          const p = document.createElement('p');
          const [label, value] = line.split('\t');
          if (i && value !== undefined) {
            const v = document.createElement('b');
            v.textContent = value;
            const l = document.createElement('span');
            l.textContent = label ?? '';
            p.append(v, l);
          } else p.textContent = line;
          return p;
        }),
      );
      b.hidden = false;
    }
    place(x, y);
  };

  const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const t = target(e);
    if (t) show(t, e.clientX, e.clientY);
    else if (cur) hide();
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    const t = target(e);
    if (t && t !== cur) show(t, e.clientX, e.clientY);
    else hide();
  });
  document.documentElement.addEventListener('pointerleave', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('blur', hide);
}

export {};

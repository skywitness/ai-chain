/**
 * cowos — the in-stage control panel: an explode slider (拆解 0–100%) and an optional segmented
 * toggle (CoWoS-S / CoWoS-L). Real form controls (keyboard + screen readers), styled only with the
 * site's CSS tokens. It lives in ctx.stage above the labels and is removed on dispose.
 *
 * Kit proposal: proposals/scene-cowos.yaml (a shared `StageControls` helper).
 */

export interface PanelOptions {
  stage: HTMLElement;
  signal: AbortSignal;
  /** Slider caption, e.g. 「拆解」. */
  label: string;
  /** Accessible name of the slider. */
  aria: string;
  /** Accessible name of the whole control group (default 「封裝拆解控制」). */
  groupLabel?: string;
  /** Text for aria-valuetext / the readout, from the 0..1 value. */
  valueText: (v: number) => string;
  value: number;
  onInput: (v: number) => void;
  toggle?: {
    aria: string;
    options: { id: string; label: string }[];
    value: string;
    onChange: (id: string) => void;
  };
}

export interface Panel {
  setValue(v: number): void;
  setToggle(id: string): void;
  remove(): void;
}

const css = (el: HTMLElement, s: string) => {
  el.style.cssText = s;
  return el;
};

export function createPanel(o: PanelOptions): Panel {
  const root = css(
    document.createElement('div'),
    [
      'position:absolute',
      'left:var(--space-3,12px)',
      'bottom:var(--space-3,12px)',
      'z-index:4',
      'display:flex',
      'flex-wrap:wrap',
      'align-items:center',
      'gap:6px 10px',
      'max-width:calc(100% - 2 * var(--space-3,12px))',
      'padding:5px 10px 5px 12px',
      'border-radius:var(--radius-m,10px)',
      'border:1px solid var(--c-border)',
      'background:color-mix(in srgb, var(--c-bg-elev) 90%, transparent)',
      '-webkit-backdrop-filter:blur(4px)',
      'backdrop-filter:blur(4px)',
      'color:var(--c-fg)',
      'font-family:var(--font-sans)',
      'font-size:var(--fs-xs,12px)',
      'line-height:1.3',
      'box-shadow:var(--shadow-1, none)',
      'user-select:none',
      'touch-action:manipulation',
    ].join(';'),
  );
  root.className = 'cowos-controls';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', o.groupLabel ?? '封裝拆解控制');
  // Narrow stages (phones): one compact row, the readout moves to aria-valuetext only.
  const style = document.createElement('style');
  style.textContent = [
    '@container scene (max-width: 480px) {',
    '.cowos-controls{gap:4px 8px!important;padding:3px 8px!important;left:8px!important;bottom:8px!important}',
    '.cowos-controls .cw-out{display:none}',
    '.cowos-controls .cw-range{width:72px!important}',
    '.cowos-controls .cw-seg button{padding:0 8px!important}',
    '}',
  ].join('');
  root.appendChild(style);

  const lab = css(document.createElement('label'), 'display:inline-flex;align-items:center;gap:8px;font-weight:var(--fw-semibold,600);white-space:nowrap');
  const cap = document.createElement('span');
  cap.textContent = o.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.setAttribute('aria-label', o.aria);
  input.className = 'cw-range';
  css(input, 'width:clamp(84px, 18cqi, 150px);min-height:28px;margin:0;accent-color:var(--c-accent);cursor:pointer');
  const out = css(document.createElement('span'), 'min-width:3.2em;font-variant-numeric:tabular-nums;color:var(--c-fg-muted);font-weight:400');
  out.className = 'cw-out';
  out.setAttribute('aria-hidden', 'true');
  lab.append(cap, input, out);
  root.appendChild(lab);

  const setValue = (v: number) => {
    const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
    if (input.value !== String(pct)) input.value = String(pct);
    out.textContent = `${pct}%`;
    input.setAttribute('aria-valuetext', o.valueText(pct / 100));
  };
  setValue(o.value);
  input.addEventListener(
    'input',
    () => {
      const v = Number(input.value) / 100;
      setValue(v);
      o.onInput(v);
    },
    { signal: o.signal },
  );

  const buttons: HTMLButtonElement[] = [];
  const paint = (id: string) => {
    for (const b of buttons) {
      const on = b.dataset['id'] === id;
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? 'var(--c-accent)' : 'transparent';
      b.style.color = on ? 'var(--c-accent-fg)' : 'var(--c-fg)';
    }
  };
  if (o.toggle) {
    const t = o.toggle;
    const grp = css(
      document.createElement('div'),
      'display:inline-flex;padding:2px;gap:2px;border-radius:var(--radius-pill,999px);border:1px solid var(--c-border);background:color-mix(in srgb, var(--c-bg) 60%, transparent)',
    );
    grp.className = 'cw-seg';
    grp.setAttribute('role', 'group');
    grp.setAttribute('aria-label', t.aria);
    for (const opt of t.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset['id'] = opt.id;
      b.textContent = opt.label;
      css(
        b,
        'min-height:28px;padding:0 10px;border:0;border-radius:var(--radius-pill,999px);font:inherit;font-weight:var(--fw-semibold,600);cursor:pointer;white-space:nowrap;transition:background .15s ease,color .15s ease',
      );
      b.addEventListener('click', () => {
        paint(opt.id);
        t.onChange(opt.id);
      }, { signal: o.signal });
      buttons.push(b);
      grp.appendChild(b);
    }
    paint(t.value);
    root.appendChild(grp);
  }

  // Keep pointer/keyboard interaction on the panel from reaching the stage behind it.
  for (const ev of ['pointerdown', 'wheel', 'keydown'] as const)
    root.addEventListener(ev, (e) => e.stopPropagation(), { signal: o.signal, passive: ev !== 'keydown' });

  o.stage.appendChild(root);
  return {
    setValue,
    setToggle: paint,
    remove: () => root.remove(),
  };
}

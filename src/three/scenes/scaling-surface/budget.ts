/**
 * The 「訓練預算 C」 slider: a native <input type="range"> overlaid on the stage (bottom-left).
 *
 * The engine has no scene-UI API yet (see proposals/scene-scaling-surface.yaml), so this control is
 * scene-private: theme-aware through CSS tokens only (no hex), keyboard and screen-reader friendly
 * (label, aria-valuetext, <output>), outside `.scene-view` so its keys never orbit the camera, and
 * removed on dispose.
 */

export interface BudgetControl {
  readonly el: HTMLElement;
  set(value: number): void;
  show(on: boolean): void;
  /** stretch: span the stage width (portrait / phone stages); compact: one row with a short visible label. */
  setLayout(stretch: boolean, compact: boolean): void;
  dispose(): void;
}

export interface BudgetOptions {
  stage: HTMLElement;
  signal: AbortSignal;
  min: number;
  max: number;
  step: number;
  value: number;
  label: string;
  /** Visible label on compact stages (contained in `label`, which stays the accessible name). */
  shortLabel: string;
  format(v: number): { text: string; spoken: string };
  onInput(v: number): void;
}

let uid = 0;

export function createBudgetControl(o: BudgetOptions): BudgetControl {
  const id = `ss-budget-${++uid}`;
  const wrap = document.createElement('div');
  wrap.className = 'ss-budget';
  wrap.style.cssText = [
    'position:absolute',
    'left:12px',
    'bottom:12px',
    'z-index:4',
    'display:flex',
    'align-items:center',
    'flex-wrap:nowrap',
    'gap:4px 10px',
    'box-sizing:border-box',
    'max-width:calc(100% - 24px)',
    'padding:6px 14px 7px',
    'border-radius:16px',
    'background:color-mix(in srgb, var(--scene-bg) 86%, transparent)',
    'border:1px solid color-mix(in srgb, var(--scene-fg) 16%, transparent)',
    'box-shadow:0 1px 3px color-mix(in srgb, var(--scene-fg) 10%, transparent)',
    'color:var(--scene-fg)',
    'font-family:var(--font-sans, system-ui, sans-serif)',
    'font-size:13px',
    'line-height:1.35',
    '-webkit-backdrop-filter:blur(4px)',
    'backdrop-filter:blur(4px)',
    'transition:opacity 200ms ease',
  ].join(';');

  const label = document.createElement('label');
  label.htmlFor = id;
  const labelText = document.createElement('span');
  labelText.textContent = o.label;
  label.append(labelText);
  label.style.cssText = 'font-weight:var(--fw-semibold, 600);white-space:nowrap';

  const sw = document.createElement('i');
  sw.setAttribute('aria-hidden', 'true');
  sw.style.cssText =
    'display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:6px;vertical-align:-1px;background:var(--scene-optic)';
  label.prepend(sw);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.setAttribute('aria-label', o.label);
  input.style.cssText = 'flex:1 1 140px;min-width:110px;max-width:240px;margin:0;accent-color:var(--scene-optic);cursor:pointer';

  const out = document.createElement('output');
  out.htmlFor.add(id);
  out.style.cssText = 'font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--c-fg-muted, var(--scene-fg))';

  wrap.append(label, input, out);
  o.stage.appendChild(wrap);

  const render = (v: number) => {
    const f = o.format(v);
    out.textContent = `≈ ${f.text} FLOP`;
    input.setAttribute('aria-valuetext', `約 ${f.spoken}次浮點運算`);
  };
  const set = (v: number) => {
    input.value = String(v);
    render(v);
  };
  set(o.value);

  input.addEventListener(
    'input',
    () => {
      const v = Number(input.value);
      render(v);
      o.onInput(v);
    },
    { signal: o.signal },
  );
  // Keep pointer gestures on the control from reaching page-level handlers.
  for (const t of ['pointerdown', 'wheel', 'touchstart'] as const)
    wrap.addEventListener(t, (e) => e.stopPropagation(), { signal: o.signal, passive: true });

  return {
    el: wrap,
    set,
    show(on) {
      wrap.style.display = on ? 'flex' : 'none';
    },
    setLayout(stretch, compact) {
      labelText.textContent = compact ? o.shortLabel : o.label;
      wrap.style.right = stretch ? '12px' : '';
      wrap.style.flexWrap = stretch && !compact ? 'wrap' : 'nowrap';
      wrap.style.padding = compact ? '5px 12px 6px' : '6px 14px 7px';
      wrap.style.gap = compact ? '4px 8px' : '4px 10px';
      input.style.maxWidth = stretch ? 'none' : '240px';
      input.style.minWidth = compact ? '64px' : '110px';
      input.style.flexBasis = compact && !stretch ? '96px' : '140px';
    },
    dispose() {
      wrap.remove();
    },
  };
}

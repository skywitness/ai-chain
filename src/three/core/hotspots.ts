/**
 * HotspotRegistry (scenes3d.md A12): links 3D objects with the server-rendered hotspot list
 * (`[data-hotspot]` buttons/links inside <ai-scene>).
 *  - Hover / focus a list item → highlight the object (and its labels), set aria-current.
 *  - Click a list button → select: camera focus (if a pose is registered), card, announcement.
 *  - Hover in 3D → highlight + card + aria-current on the list item.
 *  - Click in 3D → navigate when the hotspot has an href (Ctrl/⌘ = new tab), else open the card.
 *    On touch, the first tap opens an interactive card that carries the link instead.
 * Events: `scene:hotspot` { id, action: 'hover' | 'leave' | 'select', source }.
 */
import { Box3, Vector3, type Object3D } from 'three';
import type { CardContent, HotspotRegistry, HotspotSource, HotspotSpec, PickHit, Picker, CameraPose, Tween } from './types';
import type { CardImpl } from './card';
import type { LabelLayerImpl } from './labels';
import { toVec3 } from './tween';

export interface HotspotText {
  label: string;
  detail?: string;
  href?: string;
}

interface Entry {
  spec: HotspotSpec;
  unpick: (() => void) | null;
  baseScale: Vector3 | null;
  scaleTween: Tween | null;
}

export interface HotspotEnv {
  root: HTMLElement;
  signal: AbortSignal;
  picker: Picker;
  card: CardImpl;
  labels: LabelLayerImpl;
  /** Static text from meta.json + Scene3D `hotspots` prop. */
  text: Map<string, HotspotText>;
  announce(t: string): void;
  emit(type: string, detail?: unknown): void;
  navigate(href: string, opts?: { newTab?: boolean }): void;
  setPose(p: CameraPose): void;
  invalidate(): void;
  scaleTo(obj: Object3D, to: Vector3): Tween;
}

export class HotspotRegistryImpl implements HotspotRegistry {
  private entries = new Map<string, Entry>();
  private _hovered: string | null = null;
  private _selected: string | null = null;
  private hoverSource: HotspotSource = 'pointer';

  constructor(private readonly env: HotspotEnv) {
    const { picker, signal, root } = env;
    picker.onHover((hit, e) => this.onPointerHover(hit, e));
    picker.onClick((hit, e) => this.onPointerClick(hit, e));

    // Wire the HTML list.
    const items = root.querySelectorAll<HTMLElement>('[data-hotspot]');
    for (const el of items) {
      const id = el.dataset['hotspot'] ?? '';
      el.addEventListener('pointerenter', () => this.highlight(id, 'list'), { signal });
      el.addEventListener('pointerleave', () => this._hovered === id && this.hoverSource === 'list' && this.highlight(null, 'list'), {
        signal,
      });
      el.addEventListener('focus', () => this.highlight(id, 'keyboard'), { signal });
      el.addEventListener('blur', () => this._hovered === id && this.highlight(null, 'keyboard'), { signal });
      if (el.tagName === 'BUTTON') {
        el.addEventListener(
          'click',
          (e) => {
            e.preventDefault();
            this.focus(id, 'list');
            this.select(id, 'list');
          },
          { signal },
        );
      }
    }
  }

  get hovered(): string | null {
    return this._hovered;
  }
  get selected(): string | null {
    return this._selected;
  }

  ids(): string[] {
    return [...new Set([...this.env.text.keys(), ...this.entries.keys()])];
  }

  register(id: string, spec: HotspotSpec): () => void {
    this.unregister(id);
    const entry: Entry = { spec, unpick: null, baseScale: null, scaleTween: null };
    if (spec.object && spec.pickable !== false) entry.unpick = this.env.picker.add(spec.object, { id });
    this.entries.set(id, entry);
    return () => this.unregister(id);
  }

  private unregister(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.unpick?.();
    e.scaleTween?.cancel();
    if (e.baseScale && e.spec.object) e.spec.object.scale.copy(e.baseScale);
    this.entries.delete(id);
  }

  private text(id: string): HotspotText {
    const e = this.entries.get(id)?.spec;
    const t = this.env.text.get(id);
    const out: HotspotText = { label: e?.label ?? t?.label ?? id };
    const detail = e?.detail ?? t?.detail;
    const href = e?.href ?? t?.href;
    if (detail) out.detail = detail;
    if (href) out.href = href;
    return out;
  }

  private content(id: string, hit: PickHit | null): CardContent {
    const custom = this.entries.get(id)?.spec.card?.(hit);
    if (custom) return custom;
    const t = this.text(id);
    const c: CardContent = { title: t.label };
    if (t.detail) c.body = t.detail;
    if (t.href) c.href = t.href;
    return c;
  }

  anchor(id: string): Vector3 | null {
    const s = this.entries.get(id)?.spec;
    if (!s) return null;
    const a = s.anchor;
    if (a) {
      if ((a as Object3D).isObject3D) return (a as Object3D).getWorldPosition(new Vector3());
      return toVec3(a as [number, number, number]);
    }
    if (s.object) return new Box3().setFromObject(s.object).getCenter(new Vector3());
    return null;
  }

  highlight(id: string | null, source: HotspotSource = 'command'): void {
    if (id === this._hovered) return;
    const prev = this._hovered;
    if (prev) this.setLit(prev, false);
    this._hovered = id;
    this.hoverSource = source;
    if (id) this.setLit(id, true);
    this.env.labels.setHot(id);
    for (const el of this.env.root.querySelectorAll<HTMLElement>('[data-hotspot]')) {
      if (id && el.dataset['hotspot'] === id) el.setAttribute('aria-current', 'true');
      else el.removeAttribute('aria-current');
    }
    if (id && (source === 'list' || source === 'keyboard' || source === 'command')) {
      const a = this.anchor(id);
      if (a) this.env.card.show(this.content(id, null), a, { hint: false });
    } else if (!id && source !== 'pointer' && !this._selected) {
      this.env.card.hide();
    }
    this.env.emit('hotspot', { id: id ?? prev, action: id ? 'hover' : 'leave', source });
    this.env.invalidate();
  }

  private setLit(id: string, on: boolean): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.spec.onHighlight) {
      e.spec.onHighlight(on);
      return;
    }
    const obj = e.spec.object;
    if (!obj) return;
    if (!e.baseScale) e.baseScale = obj.scale.clone();
    e.scaleTween?.cancel();
    e.scaleTween = this.env.scaleTo(obj, on ? e.baseScale.clone().multiplyScalar(1.06) : e.baseScale);
  }

  select(id: string, source: HotspotSource = 'command'): void {
    this._selected = id;
    const spec = this.entries.get(id)?.spec;
    const t = this.text(id);
    this.env.emit('hotspot', { id, action: 'select', source });
    if (spec?.onSelect?.(source) === true) return;
    if (t.href && source === 'pointer') {
      this.env.navigate(t.href);
      return;
    }
    const a = this.anchor(id);
    this.env.card.show(this.content(id, null), a ?? { x: this.env.root.clientWidth / 2, y: 40 }, { interactive: true });
    this.env.announce(`已選取：${t.label}${t.detail ? `。${t.detail}` : ''}`);
    this.env.invalidate();
  }

  focus(id: string | null, source: HotspotSource = 'command'): void {
    this.highlight(id, source);
    if (!id) return;
    const pose = this.entries.get(id)?.spec.pose;
    if (pose) this.env.setPose(pose);
  }

  /** Esc / background click: clear selection and card. */
  clear(): void {
    this._selected = null;
    this.env.card.hide();
    this.highlight(null, 'command');
  }

  private onPointerHover(hit: PickHit | null, e: PointerEvent): void {
    const id = hit?.id ?? null;
    if (id && this.entries.has(id)) {
      this.highlight(id, 'pointer');
      const r = (e.target as HTMLElement).getBoundingClientRect();
      if (!this._selected) this.env.card.show(this.content(id, hit), { x: e.clientX - r.left, y: e.clientY - r.top });
    } else if (this.hoverSource === 'pointer' || !id) {
      if (this._hovered && this.hoverSource === 'pointer') this.highlight(null, 'pointer');
      if (!this._selected) this.env.card.hide();
    }
  }

  private onPointerClick(hit: PickHit | null, e: PointerEvent): void {
    const id = hit?.id ?? null;
    if (!id || !this.entries.has(id)) {
      this.clear();
      return;
    }
    const touch = e.pointerType !== 'mouse';
    const t = this.text(id);
    if (!touch && t.href && (e.ctrlKey || e.metaKey)) {
      this.env.navigate(t.href, { newTab: true });
      return;
    }
    if (touch) {
      this.highlight(id, 'touch');
      this._selected = id;
      const spec = this.entries.get(id)?.spec;
      this.env.emit('hotspot', { id, action: 'select', source: 'touch' });
      if (spec?.onSelect?.('touch') === true) return;
      const r = (e.target as HTMLElement).getBoundingClientRect();
      this.env.card.show(this.content(id, hit), { x: e.clientX - r.left, y: e.clientY - r.top }, { interactive: true });
      this.env.announce(`已選取：${t.label}`);
      return;
    }
    this.select(id, 'pointer');
  }
}

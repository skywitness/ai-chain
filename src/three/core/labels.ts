/**
 * LabelLayer: pooled, projected DOM labels (scenes3d.md A13) instead of CSS2DRenderer.
 *  - A pool of absolutely positioned elements moved with translate3d().
 *  - After each rendered frame, candidates are projected, culled (behind camera, off-screen,
 *    occluder callback), sorted by priority (then depth) and placed greedily on a collision grid.
 *  - Text stays in the DOM (crisp zh-TW in the page font). The layer is aria-hidden: the hotspot
 *    list and the 場景文字說明 carry the same information for assistive technology.
 */
import { Vector3, type Object3D, type PerspectiveCamera } from 'three';
import type { LabelHandle, LabelLayer, LabelSpec } from './types';
import { toVec3 } from './tween';

interface Item {
  spec: LabelSpec;
  local: Vector3;
  el: HTMLElement | null;
  shown: boolean;
  removed: boolean;
  release: number;
}

const CELL = 4;
const tmp = new Vector3();

export class LabelLayerImpl implements LabelLayer {
  private items: Item[] = [];
  private pool: HTMLElement[] = [];
  private sizes = new Map<string, [number, number]>();
  private measurer: HTMLElement;
  private occluder: ((w: Vector3, c: PerspectiveCamera) => boolean) | null = null;
  private grid = new Uint8Array(0);
  private cols = 0;
  private rows = 0;
  private hot: string | null = null;
  private max: number;
  private override: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    max: number,
    private readonly invalidate: () => void,
  ) {
    this.max = max;
    this.measurer = document.createElement('div');
    this.measurer.className = 'scene-label';
    this.measurer.style.cssText = 'visibility:hidden;transform:none;left:-9999px;top:0';
    container.appendChild(this.measurer);
  }

  get count(): number {
    return this.items.length;
  }

  setTierMax(n: number): void {
    this.max = n;
    this.invalidate();
  }

  setMax(n: number): void {
    this.override = n;
    this.invalidate();
  }

  setOccluder(fn: ((w: Vector3, c: PerspectiveCamera) => boolean) | null): void {
    this.occluder = fn;
    this.invalidate();
  }

  /** Light up labels bound to this hotspot id (and always show them). */
  setHot(id: string | null): void {
    if (this.hot === id) return;
    this.hot = id;
    for (const it of this.items) if (it.el) it.el.classList.toggle('is-hot', !!id && it.spec.hotspot === id);
    this.invalidate();
  }

  add(spec: LabelSpec): LabelHandle {
    const it: Item = {
      spec: { ...spec },
      local: spec.position ? toVec3(spec.position) : new Vector3(),
      el: null,
      shown: false,
      removed: false,
      release: 0,
    };
    this.items.push(it);
    this.invalidate();
    const self = this;
    return {
      set(patch) {
        if (it.removed) return;
        const textChanged = patch.text !== undefined && patch.text !== it.spec.text;
        Object.assign(it.spec, patch);
        if (patch.position) toVec3(patch.position, it.local);
        if (it.el && (textChanged || patch.swatch !== undefined || patch.kind !== undefined)) self.render(it, it.el);
        self.invalidate();
      },
      remove() {
        if (it.removed) return;
        it.removed = true;
        self.items = self.items.filter((x) => x !== it);
        self.releaseEl(it, true);
        self.invalidate();
      },
      get shown() {
        return it.shown;
      },
    };
  }

  clear(): void {
    for (const it of this.items) {
      it.removed = true;
      this.releaseEl(it, true);
    }
    this.items = [];
  }

  private key(spec: LabelSpec): string {
    return `${spec.kind ?? 'default'}|${spec.swatch ? 1 : 0}|${spec.text}`;
  }

  private size(spec: LabelSpec): [number, number] {
    const k = this.key(spec);
    let s = this.sizes.get(k);
    if (!s) {
      this.render({ spec } as Item, this.measurer);
      s = [Math.ceil(this.measurer.offsetWidth), Math.ceil(this.measurer.offsetHeight)];
      if (this.sizes.size > 2000) this.sizes.clear();
      this.sizes.set(k, s);
    }
    return s;
  }

  private render(it: Pick<Item, 'spec'>, el: HTMLElement): void {
    const s = it.spec;
    el.dataset['kind'] = s.kind ?? 'default';
    el.textContent = '';
    if (s.swatch) {
      const i = document.createElement('i');
      i.className = 'scene-label-swatch';
      i.style.background = s.swatch;
      el.appendChild(i);
    }
    el.appendChild(document.createTextNode(s.text));
  }

  private acquire(it: Item): HTMLElement {
    if (it.el) {
      if (it.release) {
        clearTimeout(it.release);
        it.release = 0;
      }
      return it.el;
    }
    const el = this.pool.pop() ?? document.createElement('div');
    el.className = 'scene-label';
    el.style.display = '';
    this.render(it, el);
    el.classList.toggle('is-hot', !!this.hot && it.spec.hotspot === this.hot);
    if (!el.parentNode) this.container.appendChild(el);
    it.el = el;
    return el;
  }

  private releaseEl(it: Item, now: boolean): void {
    const el = it.el;
    if (!el) return;
    el.removeAttribute('data-on');
    if (it.release) clearTimeout(it.release);
    const done = () => {
      it.release = 0;
      if (it.shown && !it.removed) return;
      el.style.display = 'none';
      el.classList.remove('is-hot');
      if (it.el === el) it.el = null;
      this.pool.push(el);
    };
    if (now) done();
    else it.release = window.setTimeout(done, 240);
  }

  /** Layout pass; the host calls it after every rendered frame. */
  update(camera: PerspectiveCamera, width: number, height: number): void {
    if (!this.items.length || width <= 0 || height <= 0) return;
    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.grid = new Uint8Array(cols * rows);
    } else this.grid.fill(0);

    const cands: { it: Item; x: number; y: number; z: number; p: number }[] = [];
    for (const it of this.items) {
      const s = it.spec;
      if (s.visible === false || !s.text) {
        this.hide(it);
        continue;
      }
      const obj: Object3D | undefined = s.object;
      if (obj) tmp.copy(it.local).applyMatrix4(obj.matrixWorld);
      else tmp.copy(it.local);
      if (this.occluder?.(tmp, camera)) {
        this.hide(it);
        continue;
      }
      tmp.project(camera);
      if (tmp.z > 1 || tmp.z < -1 || Math.abs(tmp.x) > 1.15 || Math.abs(tmp.y) > 1.15) {
        this.hide(it);
        continue;
      }
      const hot = !!this.hot && s.hotspot === this.hot;
      cands.push({
        it,
        x: ((tmp.x + 1) / 2) * width,
        y: ((1 - tmp.y) / 2) * height,
        z: tmp.z,
        p: (s.priority ?? 0) + (hot ? 1000 : 0) + (s.always ? 500 : 0),
      });
    }
    cands.sort((a, b) => b.p - a.p || a.z - b.z);

    const budget = this.override ?? this.max;
    let placed = 0;
    for (const c of cands) {
      const s = c.it.spec;
      const [w, h] = this.size(s);
      const [ox, oy] = s.offset ?? [0, 0];
      let x = c.x - w / 2;
      let y = c.y - h / 2;
      switch (s.align) {
        case 'above':
          y = c.y - h - 8;
          break;
        case 'below':
          y = c.y + 8;
          break;
        case 'left':
          x = c.x - w - 10;
          break;
        case 'right':
          x = c.x + 10;
          break;
        default:
      }
      x = Math.round(x + ox);
      y = Math.round(y + oy);
      const inside = x >= -2 && y >= -2 && x + w <= width + 2 && y + h <= height + 2;
      const hot = !!this.hot && s.hotspot === this.hot;
      if (!inside || (placed >= budget && !hot) || (!s.always && !hot && this.collides(x, y, w, h))) {
        this.hide(c.it);
        continue;
      }
      this.mark(x, y, w, h);
      placed++;
      const el = this.acquire(c.it);
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      if (!c.it.shown) {
        c.it.shown = true;
        el.setAttribute('data-on', '');
      }
    }
  }

  private hide(it: Item): void {
    if (!it.shown) return;
    it.shown = false;
    this.releaseEl(it, false);
  }

  private cells(x: number, y: number, w: number, h: number): [number, number, number, number] {
    const pad = 2;
    return [
      Math.max(0, Math.floor((x - pad) / CELL)),
      Math.max(0, Math.floor((y - pad) / CELL)),
      Math.min(this.cols - 1, Math.floor((x + w + pad) / CELL)),
      Math.min(this.rows - 1, Math.floor((y + h + pad) / CELL)),
    ];
  }

  private collides(x: number, y: number, w: number, h: number): boolean {
    const [x0, y0, x1, y1] = this.cells(x, y, w, h);
    for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) if (this.grid[r * this.cols + c]) return true;
    return false;
  }

  private mark(x: number, y: number, w: number, h: number): void {
    const [x0, y0, x1, y1] = this.cells(x, y, w, h);
    for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) this.grid[r * this.cols + c] = 1;
  }

  destroy(): void {
    this.clear();
    for (const el of this.pool) el.remove();
    this.pool = [];
    this.measurer.remove();
  }
}

/**
 * Picking (scenes3d.md A12).
 *  - Pointer state machine: pointerdown → pointerup within 6 px and 400 ms is a click.
 *  - Hover only for mouse pointers, processed at most once per rendered frame.
 *  - RaycastPicker over registered objects (use invisible proxy meshes for complex parts;
 *    InstancedMesh hits carry instanceId).
 *  - ScreenSpacePicker for markers / points: nearest projected point within 18 px (28 px touch).
 */
import { Raycaster, Vector2, Vector3, type Intersection, type Object3D, type PerspectiveCamera } from 'three';
import type { PickHit, Picker, PickOptions, ScreenPoint } from './types';

interface Target {
  object: Object3D;
  opts: PickOptions;
}
interface PointSet {
  get: () => readonly ScreenPoint[];
  cull: ((w: Vector3) => boolean) | undefined;
}

const ndc = new Vector2();
const tmp = new Vector3();

export class PickerImpl implements Picker {
  private targets: Target[] = [];
  private points: PointSet[] = [];
  private hoverCbs = new Set<(h: PickHit | null, e: PointerEvent) => void>();
  private clickCbs = new Set<(h: PickHit | null, e: PointerEvent) => void>();
  private readonly ray = new Raycaster();
  private down: { x: number; y: number; t: number; id: number } | null = null;
  private pending: PointerEvent | null = null;
  private lastHoverKey = '';
  private dragging = false;
  enabled = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: PerspectiveCamera,
    env: { signal: AbortSignal; invalidate(): void },
  ) {
    const { signal } = env;
    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) this.dragging = true;
        if (e.buttons) return;
        this.pending = e;
        env.invalidate();
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerleave',
      (e) => {
        this.pending = null;
        this.emitHover(null, e);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        this.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
        this.dragging = false;
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerup',
      (e) => {
        const d = this.down;
        this.down = null;
        this.dragging = false;
        if (!d || d.id !== e.pointerId || !this.enabled) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 400) return;
        const hit = this.pick(e.clientX, e.clientY, e.pointerType !== 'mouse');
        for (const cb of this.clickCbs) cb(hit, e);
        env.invalidate();
      },
      { signal },
    );
    canvas.addEventListener('pointercancel', () => (this.down = null), { signal });
  }

  add(object: Object3D, opts: PickOptions = {}): () => void {
    const t: Target = { object, opts };
    this.targets.push(t);
    return () => {
      this.targets = this.targets.filter((x) => x !== t);
    };
  }

  addPoints(points: () => readonly ScreenPoint[], opts: { cull?: (w: Vector3) => boolean } = {}): () => void {
    const s: PointSet = { get: points, cull: opts.cull };
    this.points.push(s);
    return () => {
      this.points = this.points.filter((x) => x !== s);
    };
  }

  onHover(cb: (h: PickHit | null, e: PointerEvent) => void): () => void {
    this.hoverCbs.add(cb);
    return () => this.hoverCbs.delete(cb);
  }

  onClick(cb: (h: PickHit | null, e: PointerEvent) => void): () => void {
    this.clickCbs.add(cb);
    return () => this.clickCbs.delete(cb);
  }

  /** Host: run the deferred hover pick once per frame. */
  processHover(): void {
    const e = this.pending;
    if (!e || !this.enabled || this.dragging) return;
    this.pending = null;
    this.emitHover(this.pick(e.clientX, e.clientY, false), e);
  }

  private emitHover(hit: PickHit | null, e: PointerEvent): void {
    const key = hit ? `${hit.id}|${hit.object.id}|${hit.instanceId ?? hit.index ?? ''}` : '';
    if (key === this.lastHoverKey) return;
    this.lastHoverKey = key;
    this.canvas.style.cursor = hit ? 'pointer' : '';
    for (const cb of this.hoverCbs) cb(hit, e);
  }

  pick(clientX: number, clientY: number, touch = false): PickHit | null {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(ndc, this.camera);

    let best: { inter: Intersection; target: Target } | null = null;
    for (const t of this.targets) {
      if (!t.object.visible) continue;
      const hits = this.ray.intersectObject(t.object, t.opts.recursive ?? true);
      const h = hits.find((x) => visibleChain(x.object));
      if (h && (!best || h.distance < best.inter.distance)) best = { inter: h, target: t };
    }
    if (best) {
      const { inter, target } = best;
      const idOpt = target.opts.id;
      const base = { object: inter.object, ...(inter.instanceId !== undefined ? { instanceId: inter.instanceId } : {}) };
      const id = typeof idOpt === 'function' ? idOpt(base) : (idOpt ?? null);
      return { ...base, point: inter.point.clone(), id };
    }

    // Screen-space points.
    const px = clientX - r.left;
    const py = clientY - r.top;
    const radius = touch ? 28 : 18;
    let bestD = radius * radius;
    let found: PickHit | null = null;
    for (const set of this.points) {
      const pts = set.get();
      pts.forEach((p, index) => {
        if (set.cull?.(p.position)) return;
        tmp.copy(p.position).project(this.camera);
        if (tmp.z > 1 || tmp.z < -1) return;
        const sx = ((tmp.x + 1) / 2) * r.width;
        const sy = ((1 - tmp.y) / 2) * r.height;
        const d = (sx - px) ** 2 + (sy - py) ** 2;
        if (d < bestD) {
          bestD = d;
          found = { object: this.camera, point: p.position.clone(), id: p.id, index };
        }
      });
    }
    return found;
  }
}

function visibleChain(o: Object3D | null): boolean {
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

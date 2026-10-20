/**
 * SceneHost: the lifecycle state machine behind one <ai-scene> element.
 *
 *   poster → loading → running ⇄ paused → disposed
 *   any → error | contextlost (poster shown again; context restore remounts)
 *
 * Owns the renderer, camera, controls, loop, observers and the per-scene services (labels,
 * picker, hotspots, card, tween, materials, bag). The scene module only builds content.
 * At most two live WebGL contexts per page: a third mount evicts the least recently visible host.
 */
import { PerspectiveCamera, Scene, Vector3, type Object3D } from 'three';
import { CardImpl } from './card';
import { ControlsManager } from './controls';
import { DisposableBag, deepDispose } from './dispose';
import { HotspotRegistryImpl, type HotspotText } from './hotspots';
import { LabelLayerImpl } from './labels';
import { Loop } from './loop';
import { MaterialRegistry } from './materials';
import { prefersReducedMotion, watchReducedMotion } from './motion';
import { PickerImpl } from './picking';
import { Governor, TIERS, higherQuality, lowerQuality } from './quality';
import { createRenderer } from './renderer';
import { createRng } from './rng';
import { readPalette, watchTheme } from './theme';
import { TweenEngine, toVec3 } from './tween';
import type {
  CameraPose,
  Disposable,
  HostState,
  Palette,
  Quality,
  SceneCommand,
  SceneContext,
  SceneInstance,
  SceneMeta,
  SceneModule,
  SceneStats,
  StageSize,
  TweenOptions,
  Vec3Like,
} from './types';
import type { WebGLRenderer } from 'three';

/** What the host needs from the <ai-scene> element (implemented in element.ts). */
export interface HostBridge {
  readonly el: HTMLElement;
  /** Current step index (the element owns step UI so it also works without WebGL). */
  readonly step: number;
  setState(s: HostState, message?: string): void;
  /** Update step UI (aria-current, caption) after the host changed step. */
  stepUI(i: number): void;
  /**
   * The host was disposed to free a WebGL context: return to the poster and re-arm loading
   * (on scroll-back, or by click when it was evicted while visible).
   */
  evicted(visible: boolean): void;
  /** The WebGL context was lost and the host disposed: show the poster, then remount (limited retries). */
  contextLost(): void;
}

export interface HostOptions {
  variant: string;
  quality: Quality;
  /** Quality was forced (URL / user): the adaptive governor stays off. */
  forced: boolean;
  seed: string;
}

const live = new Set<SceneHost>();
const REF_ASPECT = 16 / 9;
const PORTRAIT_REF = 4 / 5;

interface SceneScope {
  ac: AbortController;
  bag: DisposableBag;
  scene: Scene;
  labels: LabelLayerImpl;
  picker: PickerImpl;
  hotspots: HotspotRegistryImpl;
  card: CardImpl;
  tween: TweenEngine;
  materials: MaterialRegistry;
  instance: SceneInstance | null;
}

export class SceneHost {
  state: HostState = 'loading';
  private readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly view: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: WebGLRenderer | null = null;
  private camera = new PerspectiveCamera(40, 16 / 9, 0.1, 200);
  private controls: ControlsManager | null = null;
  private loop: Loop;
  private governor: Governor | null = null;
  private hostAc = new AbortController();
  private s: SceneScope | null = null;
  private palette!: Palette;
  private quality: Quality;
  private variant: string;
  private stepIndex = 0;
  private data: unknown = null;
  private isFixture = false;
  private reduced = prefersReducedMotion();
  private userPaused = false;
  private optIn = false;
  private visible = true;
  private docVisible = !document.hidden;
  private lastVisible = performance.now();
  private size: StageSize = { width: 1, height: 1, aspect: 1, portrait: false };
  private baseFov = 40;
  private animT = 0;
  private frames = 0;
  private calls = 0;
  private tris = 0;
  private lastFrameAt = 0;
  private interacted = false;
  private immersive = false;
  private hintTimer = 0;
  private disposed = false;
  private contextLost = false;

  constructor(
    private readonly bridge: HostBridge,
    private readonly mod: SceneModule<unknown>,
    private readonly opts: HostOptions,
  ) {
    this.el = bridge.el;
    this.stage = this.el.querySelector<HTMLElement>('.scene-stage') ?? this.el;
    this.view = this.el.querySelector<HTMLElement>('.scene-view') ?? this.stage;
    this.quality = opts.quality;
    this.variant = mod.json.variants.includes(opts.variant) ? opts.variant : mod.json.defaultVariant;
    this.loop = new Loop((dt, now) => this.frame(dt, now));
  }

  /* ───────────── derived state ───────────── */

  private get meta(): SceneMeta {
    const m = this.mod.meta;
    const o = m.variants?.[this.variant];
    return o ? { ...m, ...o, camera: { ...m.camera, ...(o.camera ?? {}) } } : m;
  }

  private get animate(): boolean {
    return !this.userPaused && (!this.reduced || this.optIn);
  }

  private get loopMode(): 'continuous' | 'demand' {
    const want = this.meta.loop ?? (this.mod.json.loop === 'continuous' ? 'continuous' : 'demand');
    return want === 'continuous' && this.animate ? 'continuous' : 'demand';
  }

  /* ───────────── mount ───────────── */

  async mount(): Promise<void> {
    this.bridge.setState('loading');
    this.stepIndex = this.bridge.step;
    // A deep-linked step that requires a variant starts in that variant.
    const initial = this.mod.json.steps?.[this.stepIndex];
    if (initial?.variant && this.mod.json.variants.includes(initial.variant)) this.variant = initial.variant;
    this.el.dataset['variant'] = this.variant;
    try {
      makeRoom(this);
      live.add(this);
      const canvas = document.createElement('canvas');
      canvas.className = 'scene-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      this.view.prepend(canvas);
      this.canvas = canvas;
      const renderer = createRenderer(canvas, this.quality);
      this.renderer = renderer;
      const { signal } = this.hostAc;
      canvas.addEventListener('webglcontextlost', (e) => this.onContextLost(e), { signal });

      this.palette = readPalette(this.el);
      this.measure();
      renderer.setSize(this.size.width, this.size.height, false);

      const { data, isFixture } = await this.resolveData();
      this.data = data;
      this.isFixture = isFixture;
      this.el.toggleAttribute('data-fixture', isFixture);
      if (this.disposed) return;

      this.controls = new ControlsManager(this.camera, canvas, this.meta, {
        signal,
        invalidate: () => this.invalidate(),
        hint: () => this.showHint(),
        focusEl: this.view,
      });
      this.applyCamera(this.meta);
      this.controls.setAutoRotateAllowed(this.animate);
      this.wireHost();

      await this.createScene();
      if (this.disposed) return;

      try {
        // Precompile shaders. compileAsync needs KHR_parallel_shader_compile (and warns without it).
        if (renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(this.s!.scene, this.camera);
        else renderer.compile(this.s!.scene, this.camera);
      } catch {
        /* precompiling is an optimisation only */
      }
      if (this.disposed) return;
      this.applyLoopMode();
      this.setupGovernor();
      this.loop.start();
      this.frame(0, performance.now());
      this.setState(this.visible && this.docVisible ? 'running' : 'paused');
      if (this.state === 'paused') this.loop.stop();
      this.syncToolbar();
      this.el.dispatchEvent(
        new CustomEvent('scene:ready', { bubbles: true, detail: { id: this.mod.json.id, variant: this.variant } }),
      );
    } catch (err) {
      console.error(`[scene ${this.mod.json.id}] mount failed`, err);
      this.dispose('error');
      this.bridge.setState('error', '3D 場景載入失敗，以下為靜態示意圖。');
    }
  }

  private async resolveData(): Promise<{ data: unknown; isFixture: boolean }> {
    let raw: unknown;
    const script = this.el.querySelector('script[data-scene-data]');
    if (script?.textContent?.trim()) {
      try {
        raw = JSON.parse(script.textContent);
      } catch {
        console.warn(`[scene ${this.mod.json.id}] invalid JSON in data script`);
      }
    }
    const { guard, fixture } = this.mod;
    if (!guard) return { data: raw ?? null, isFixture: false };
    if (raw != null && guard(raw)) return { data: raw, isFixture: false };
    if (raw != null) console.warn(`[scene ${this.mod.json.id}] page data failed the type guard; using the fixture`);
    if (fixture) {
      const f = (await fixture()).default;
      if (guard(f)) return { data: f, isFixture: true };
    }
    return { data: null, isFixture: false };
  }

  private async createScene(): Promise<void> {
    const ac = new AbortController();
    const bag = new DisposableBag();
    const scene = new Scene();
    const tier = TIERS[this.quality];
    const labelsEl = this.stage.querySelector<HTMLElement>('.scene-labels') ?? this.makeOverlay('scene-labels');
    const labels = new LabelLayerImpl(labelsEl, tier.maxLabels, () => this.invalidate());
    const picker = new PickerImpl(this.canvas!, this.camera, { signal: ac.signal, invalidate: () => this.invalidate() });
    const card = new CardImpl(this.stage, { project: (w) => this.project(w), href: (p) => this.href(p) });
    const tween = new TweenEngine({
      reduced: () => !this.animate && this.reduced,
      invalidate: () => this.invalidate(),
      camera: this.camera,
      controls: this.controls?.controls ?? null,
      setFov: (deg) => {
        this.baseFov = deg;
        this.fitFov();
      },
      getFov: () => this.baseFov,
    });
    const materials = new MaterialRegistry(this.palette);
    const text = new Map<string, HotspotText>();
    for (const h of this.mod.json.hotspots ?? []) text.set(h.id, compact({ label: h.label, detail: h.detail, href: h.href }));
    for (const li of this.el.querySelectorAll<HTMLElement>('[data-hotspot]')) {
      const id = li.dataset['hotspot'] ?? '';
      const prev = text.get(id);
      text.set(
        id,
        compact({
          label: li.dataset['label'] ?? prev?.label ?? li.textContent?.trim() ?? id,
          detail: li.dataset['detail'] ?? prev?.detail,
          href: li.dataset['href'] ?? prev?.href,
        }),
      );
    }
    const hotspots = new HotspotRegistryImpl({
      root: this.el,
      signal: ac.signal,
      picker,
      card,
      labels,
      text,
      announce: (t) => this.announce(t),
      emit: (t, d) => this.emit(t, d),
      navigate: (h, o) => this.navigate(h, o),
      setPose: (p) => {
        this.interacted = true;
        this.s?.tween.camera(this.fitPose(p));
      },
      invalidate: () => this.invalidate(),
      scaleTo: (obj: Object3D, to: Vector3) => tween.vec3(obj.scale, to, { duration: 220, ease: 'cubicOut', fade: true }),
    });
    bag.track(materials);
    this.s = { ac, bag, scene, labels, picker, hotspots, card, tween, materials, instance: null };

    const ctx = this.buildContext(this.s);
    this.s.instance = await this.mod.create(ctx as SceneContext<unknown>);
    if (this.disposed) return;
    const steps = this.mod.json.steps ?? [];
    if (steps.length) {
      this.stepIndex = Math.max(0, Math.min(this.stepIndex, steps.length - 1));
      this.s.instance.setStep?.(this.stepIndex, steps[this.stepIndex]);
    }
  }

  private buildContext(s: SceneScope): SceneContext<unknown> {
    const host = this;
    const rng = createRng(`${this.mod.json.id}:${this.opts.seed}`);
    return {
      id: this.mod.json.id,
      root: this.el,
      stage: this.stage,
      canvas: this.canvas!,
      json: this.mod.json,
      get meta() {
        return host.meta;
      },
      renderer: this.renderer!,
      scene: s.scene,
      camera: this.camera,
      controls: this.controls?.controls ?? null,
      get variant() {
        return host.variant;
      },
      get step() {
        return host.stepIndex;
      },
      data: this.data,
      isFixture: this.isFixture,
      get quality() {
        return host.quality;
      },
      get tier() {
        return TIERS[host.quality];
      },
      get reducedMotion() {
        return host.reduced;
      },
      get animate() {
        return host.animate;
      },
      get palette() {
        return host.palette;
      },
      get theme() {
        return host.palette.theme;
      },
      get size() {
        return host.size;
      },
      base: baseUrl(),
      signal: s.ac.signal,
      labels: s.labels,
      picker: s.picker,
      hotspots: s.hotspots,
      tween: s.tween,
      materials: s.materials,
      card: s.card,
      rng,
      invalidate: () => this.invalidate(),
      track: <T extends Disposable>(o: T) => s.bag.track(o),
      href: (p: string) => this.href(p),
      navigate: (p: string, o?: { newTab?: boolean }) => this.navigate(p, o),
      emit: (t: string, d?: unknown) => this.emit(t, d),
      announce: (t: string) => this.announce(t),
      setPose: (p: CameraPose, o?: TweenOptions) => s.tween.camera(this.fitPose(p), o),
      get homePose() {
        return host.homePose();
      },
      project: (w: Vec3Like) => this.project(w),
    };
  }

  /* ───────────── host wiring ───────────── */

  private wireHost(): void {
    const { signal } = this.hostAc;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          this.visible = e.isIntersecting;
          if (e.isIntersecting) this.lastVisible = performance.now();
        }
        this.updateRunState();
      },
      { threshold: 0 },
    );
    io.observe(this.stage);
    signal.addEventListener('abort', () => io.disconnect(), { once: true });

    document.addEventListener(
      'visibilitychange',
      () => {
        this.docVisible = !document.hidden;
        this.updateRunState();
      },
      { signal },
    );

    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.onResize();
      });
    });
    ro.observe(this.stage);
    signal.addEventListener('abort', () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    });

    watchTheme(() => this.onTheme(), signal);
    watchReducedMotion((r) => {
      this.reduced = r;
      this.optIn = false;
      this.onMotionChange();
    }, signal);

    this.view.addEventListener('keydown', (e) => this.onKey(e), { signal });
    this.view.addEventListener('pointerdown', () => (this.interacted = true), { signal });
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange(), { signal });
  }

  private updateRunState(): void {
    if (this.disposed || !this.renderer || (this.state !== 'running' && this.state !== 'paused')) return;
    const run = (this.visible || this.immersive) && this.docVisible;
    if (run && this.state === 'paused') {
      this.setState('running');
      this.loop.start();
    } else if (!run && this.state === 'running') {
      this.setState('paused');
      this.loop.stop();
    }
  }

  private setState(s: HostState): void {
    this.state = s;
    this.bridge.setState(s);
  }

  /* ───────────── frame ───────────── */

  private frame(dt: number, now: number): boolean {
    const r = this.renderer;
    const s = this.s;
    if (!r || !s || this.disposed) return false;
    const adt = this.animate ? dt : 0;
    this.animT += adt;
    const tweening = s.tween.tick(now);
    const moving = this.controls?.update(dt) ?? false;
    s.picker.processHover();
    const more = s.instance?.update?.(adt, this.animT) === true;
    r.render(s.scene, this.camera);
    this.frames++;
    this.calls = r.info.render.calls;
    this.tris = r.info.render.triangles;
    s.labels.update(this.camera, this.size.width, this.size.height);
    if (this.governor && this.loopMode === 'continuous' && this.lastFrameAt) this.governor.sample(now - this.lastFrameAt);
    this.lastFrameAt = now;
    return tweening || moving || more;
  }

  invalidate(): void {
    this.loop.invalidate();
  }

  private applyLoopMode(): void {
    this.loop.mode = this.loopMode;
    this.loop.fpsCap = TIERS[this.quality].fpsCap;
    this.lastFrameAt = 0;
    this.invalidate();
  }

  private setupGovernor(): void {
    if (this.opts.forced) return;
    this.governor = new Governor({
      getDpr: () => this.renderer?.getPixelRatio() ?? 1,
      setDpr: (v) => {
        this.renderer?.setPixelRatio(v);
        this.renderer?.setSize(this.size.width, this.size.height, false);
      },
      maxDpr: () => Math.min(window.devicePixelRatio || 1, TIERS[this.quality].dprCap),
      stepTier: (dir) => {
        const next = dir < 0 ? lowerQuality(this.quality) : higherQuality(this.quality);
        if (!next) return false;
        this.setQuality(next);
        return true;
      },
    });
  }

  private setQuality(q: Quality): void {
    this.quality = q;
    const tier = TIERS[q];
    this.s?.labels.setTierMax(tier.maxLabels);
    this.s?.instance?.onQuality?.(q, tier);
    this.loop.fpsCap = tier.fpsCap;
    this.invalidate();
  }

  /* ───────────── camera / size ───────────── */

  private measure(): void {
    const w = Math.max(1, Math.round(this.stage.clientWidth));
    const h = Math.max(1, Math.round(this.stage.clientHeight));
    this.size = { width: w, height: h, aspect: w / h, portrait: w / h < 1 };
  }

  private applyCamera(meta: SceneMeta): void {
    const cam = meta.camera;
    const pose = this.size.portrait && cam.portrait ? { ...cam, ...cam.portrait } : cam;
    this.baseFov = pose.fov ?? 40;
    this.camera.near = cam.near ?? 0.1;
    this.camera.far = cam.far ?? 200;
    toVec3(pose.position, this.camera.position);
    const target = toVec3(pose.target);
    this.camera.lookAt(target);
    this.camera.aspect = this.size.aspect;
    this.fitFov();
    const c = this.controls?.controls;
    if (c) {
      c.target.copy(target);
      this.controls?.configure(meta);
      c.update();
      c.saveState();
    }
  }

  /**
   * Keep the horizontal extent on narrow stages. The vertical FOV is specified at 16:9 for the
   * main pose and at 4:5 for a `camera.portrait` pose.
   */
  private fitFov(): void {
    const a = this.size.aspect;
    let fov = this.baseFov;
    const ref = this.size.portrait && this.meta.camera.portrait ? PORTRAIT_REF : REF_ASPECT;
    if (a < ref) {
      const h = 2 * Math.atan(Math.tan((fov * Math.PI) / 360) * ref);
      fov = (2 * Math.atan(Math.tan(h / 2) / a) * 180) / Math.PI;
    }
    this.camera.fov = Math.min(fov, 78);
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    if (!this.renderer || this.disposed) return;
    const wasPortrait = this.size.portrait;
    this.measure();
    this.renderer.setSize(this.size.width, this.size.height, false);
    if (wasPortrait !== this.size.portrait && !this.interacted && this.meta.camera.portrait) this.applyCamera(this.meta);
    else this.fitFov();
    this.s?.instance?.onResize?.(this.size);
    this.invalidate();
  }

  /** The default pose for the current variant and stage shape (portrait pose when it applies). */
  homePose(): CameraPose {
    const cam = this.meta.camera;
    const pose = this.size.portrait && cam.portrait ? { ...cam, ...cam.portrait } : cam;
    return { position: pose.position, target: pose.target, fov: pose.fov ?? 40 };
  }

  /**
   * Adapt a scene-supplied pose to the stage: on portrait stages (when the scene defines a
   * portrait pose) the camera distance is scaled by |portrait| / |main| so the subject still fits.
   */
  fitPose(p: CameraPose): CameraPose {
    const cam = this.meta.camera;
    if (!this.size.portrait || !cam.portrait?.position) return p;
    const main = toVec3(cam.position).distanceTo(toVec3(cam.target));
    const port = toVec3(cam.portrait.position).distanceTo(toVec3(cam.portrait.target ?? cam.target));
    const k = main > 0 ? port / main : 1;
    const t = toVec3(p.target);
    const pos = toVec3(p.position).sub(t).multiplyScalar(k).add(t);
    return { ...p, position: pos };
  }

  resetView(): void {
    this.interacted = false;
    this.s?.hotspots.clear();
    this.s?.tween.camera(this.homePose());
    this.announce('已重設視角');
  }

  project(w: Vec3Like): { x: number; y: number } | null {
    const v = toVec3(w).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * this.size.width, y: ((1 - v.y) / 2) * this.size.height };
  }

  /* ───────────── theme / motion ───────────── */

  private onTheme(): void {
    if (!this.s || this.disposed) return;
    const p = readPalette(this.el);
    this.palette = p;
    this.s.materials.apply(p);
    this.s.instance?.onPalette?.(p);
    this.invalidate();
  }

  private onMotionChange(): void {
    if (!this.s) return;
    this.controls?.setAutoRotateAllowed(this.animate);
    this.s.instance?.onMotion?.(this.animate);
    this.applyLoopMode();
    this.syncToolbar();
  }

  toggleMotion(force?: boolean): void {
    const next = force ?? !this.animate;
    if (next) {
      this.userPaused = false;
      if (this.reduced) this.optIn = true;
    } else this.userPaused = true;
    this.onMotionChange();
    this.announce(next ? '動畫播放中' : '動畫已暫停');
  }

  /* ───────────── steps / variants ───────────── */

  async setStep(i: number): Promise<void> {
    const steps = this.mod.json.steps ?? [];
    if (!steps.length || !this.s) return;
    const idx = Math.max(0, Math.min(i, steps.length - 1));
    const step = steps[idx];
    this.stepIndex = idx;
    if (step?.variant && step.variant !== this.variant) await this.setVariant(step.variant, true);
    this.s?.instance?.setStep?.(idx, step);
    this.bridge.stepUI(idx);
    this.emit('step', { index: idx, id: step?.id, title: step?.title });
    this.invalidate();
  }

  async setVariant(v: string, fromStep = false): Promise<void> {
    if (!this.mod.json.variants.includes(v) || v === this.variant || !this.s) return;
    this.variant = v;
    this.el.dataset['variant'] = v;
    const handled = this.s.instance?.setVariant?.(v);
    if (handled === undefined || handled === false) {
      if (!this.s.instance?.setVariant || handled === false) await this.remountScene();
    }
    this.controls?.configure(this.meta);
    this.applyLoopMode();
    this.emit('variant', { variant: v });
    if (!fromStep) {
      const steps = this.mod.json.steps ?? [];
      const cur = steps[this.stepIndex];
      if (cur?.variant && cur.variant !== v) {
        const first = steps.findIndex((s) => !s.variant || s.variant === v);
        if (first >= 0) await this.setStep(first);
      }
    }
    this.invalidate();
  }

  private async remountScene(): Promise<void> {
    this.disposeScene();
    this.applyCamera(this.meta);
    await this.createScene();
    this.invalidate();
  }

  command(c: SceneCommand): void {
    if (!this.s) return;
    switch (c.type) {
      case 'focus':
        this.s.hotspots.focus(c.id, 'command');
        break;
      case 'select':
        this.s.hotspots.select(c.id, 'command');
        break;
      case 'step':
        void this.setStep(c.index);
        break;
      case 'variant':
        void this.setVariant(c.variant);
        break;
      case 'reset':
        this.resetView();
        break;
      case 'play':
        this.toggleMotion(true);
        break;
      case 'pause':
        this.toggleMotion(false);
        break;
      default:
    }
  }

  /* ───────────── keyboard / fullscreen / toolbar ───────────── */

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.view) return;
    const steps = this.mod.json.steps ?? [];
    let handled = this.controls?.keyboard(e) ?? false;
    if (!handled) {
      handled = true;
      switch (e.key) {
        case '0':
        case 'Home':
          this.resetView();
          break;
        case 'PageDown':
          if (steps.length) void this.setStep(this.stepIndex + 1);
          else handled = false;
          break;
        case 'PageUp':
          if (steps.length) void this.setStep(this.stepIndex - 1);
          else handled = false;
          break;
        case 'Escape':
          if (this.immersive || document.fullscreenElement === this.el) this.toggleFullscreen(false);
          else if (this.s?.card.visible) this.s.hotspots.clear();
          else handled = false;
          break;
        case 'Enter':
          if (this.s?.hotspots.hovered) this.s.hotspots.select(this.s.hotspots.hovered, 'keyboard');
          else handled = false;
          break;
        default:
          handled = false;
      }
    } else this.interacted = true;
    if (handled) e.preventDefault();
  }

  toggleFullscreen(force?: boolean): void {
    const on = force ?? !(document.fullscreenElement === this.el || this.immersive);
    if (on) {
      if (this.el.requestFullscreen && document.fullscreenEnabled) {
        this.el.requestFullscreen().catch(() => this.setImmersive(true));
      } else this.setImmersive(true);
      this.view.focus({ preventScroll: true });
    } else if (document.fullscreenElement === this.el) {
      void document.exitFullscreen().catch(() => {});
    } else this.setImmersive(false);
  }

  private setImmersive(on: boolean): void {
    this.immersive = on;
    this.el.classList.toggle('is-immersive', on);
    document.documentElement.classList.toggle('scene-immersive-open', on);
    this.controls?.setImmersive(on);
    this.syncToolbar();
    this.updateRunState();
    this.invalidate();
  }

  private onFullscreenChange(): void {
    const on = document.fullscreenElement === this.el;
    if (on !== this.immersive) {
      this.immersive = on;
      this.el.classList.toggle('is-fullscreen', on);
      this.controls?.setImmersive(on);
      this.syncToolbar();
      this.updateRunState();
    }
  }

  private syncToolbar(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-cmd="reset"],[data-cmd="fullscreen"],[data-cmd="motion"]'))
      b.disabled = false;
    const motion = this.el.querySelector<HTMLElement>('[data-cmd="motion"]');
    if (motion) {
      motion.dataset['playing'] = String(this.animate);
      const lbl = motion.querySelector('.scene-btn-label');
      if (lbl) lbl.textContent = this.animate ? '暫停動畫' : '播放動畫';
    }
    const fs = this.el.querySelector<HTMLElement>('[data-cmd="fullscreen"]');
    if (fs) {
      fs.dataset['active'] = String(this.immersive);
      const lbl = fs.querySelector('.scene-btn-label');
      if (lbl) lbl.textContent = this.immersive ? '離開全螢幕' : '全螢幕互動';
    }
  }

  private showHint(): void {
    const hint = this.stage.querySelector<HTMLElement>('.scene-hint');
    if (!hint) return;
    hint.dataset['show'] = '';
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => delete hint.dataset['show'], 1500);
  }

  private makeOverlay(cls: string): HTMLElement {
    const d = document.createElement('div');
    d.className = cls;
    d.setAttribute('aria-hidden', 'true');
    this.stage.appendChild(d);
    return d;
  }

  /* ───────────── helpers exposed through ctx ───────────── */

  private href(path: string): string {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path)) return path;
    const base = baseUrl();
    if (base !== '/' && path.startsWith(base)) return path;
    return base.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
  }

  private navigate(path: string, o: { newTab?: boolean } = {}): void {
    const href = this.href(path);
    const ev = new CustomEvent('scene:navigate', { bubbles: true, cancelable: true, detail: { href } });
    if (!this.el.dispatchEvent(ev)) return;
    if (o.newTab) window.open(href, '_blank', 'noopener');
    else location.assign(href);
  }

  private emit(type: string, detail?: unknown): void {
    this.el.dispatchEvent(new CustomEvent(`scene:${type}`, { bubbles: true, detail }));
  }

  private announce(text: string): void {
    const live = this.el.querySelector<HTMLElement>('.scene-live');
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => (live.textContent = text), 30);
  }

  /* ───────────── stats ───────────── */

  stats(): SceneStats {
    const mem = this.renderer?.info.memory;
    return {
      frames: this.frames,
      drawCalls: this.calls,
      triangles: this.tris,
      quality: this.quality,
      state: this.state,
      variant: this.variant,
      step: this.stepIndex,
      geometries: mem?.geometries ?? 0,
      textures: mem?.textures ?? 0,
      animate: this.animate,
      loop: this.loopMode,
      budget: this.mod.meta.budget,
      fixture: this.isFixture,
    };
  }

  get lastSeen(): number {
    return this.visible ? performance.now() : this.lastVisible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /* ───────────── teardown ───────────── */

  /**
   * Context loss: tear everything down while the context is lost (GL calls are no-ops then, so no
   * cross-context warnings), show the poster and let the element mount a fresh canvas + context.
   */
  private onContextLost(e: Event): void {
    e.preventDefault();
    this.loop.stop();
    this.contextLost = true;
    this.setState('contextlost');
    this.dispose('contextlost');
  }

  private disposeScene(): void {
    const s = this.s;
    if (!s) return;
    this.s = null;
    s.ac.abort();
    s.tween.cancelAll();
    try {
      s.instance?.dispose?.();
    } catch (err) {
      console.warn('[scene] instance.dispose failed', err);
    }
    s.bag.dispose();
    deepDispose(s.scene);
    s.scene.clear();
    s.labels.destroy();
    s.card.destroy();
    if (import.meta.env.DEV && this.renderer && !this.contextLost) {
      // three keeps one shared DFG lookup texture for PBR materials alive, hence `textures > 1`.
      const m = this.renderer.info.memory;
      if (m.geometries || m.textures > 1)
        console.warn(`[scene ${this.mod.json.id}] leak check: ${m.geometries} geometries, ${m.textures} textures left after dispose`);
    }
  }

  dispose(reason: 'disconnect' | 'evict' | 'error' | 'contextlost' = 'disconnect'): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    this.loop.dispose();
    this.hostAc.abort();
    clearTimeout(this.hintTimer);
    if (this.immersive) {
      this.el.classList.remove('is-immersive', 'is-fullscreen');
      document.documentElement.classList.remove('scene-immersive-open');
    }
    this.disposeScene();
    this.controls?.dispose();
    const r = this.renderer;
    if (r) {
      r.renderLists.dispose();
      r.dispose();
      if (!this.contextLost) r.forceContextLoss();
    }
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
    this.state = 'disposed';
    if (reason === 'evict') this.bridge.evicted(this.visible);
    if (reason === 'contextlost') this.bridge.contextLost();
  }
}

/** Keep at most two live contexts: evict the least recently visible host. */
function makeRoom(incoming: SceneHost): void {
  if (live.size < 2) return;
  const victims = [...live].filter((h) => h !== incoming).sort((a, b) => a.lastSeen - b.lastSeen);
  const v = victims.find((h) => !h.isVisible) ?? victims[0];
  v?.dispose('evict');
}

function baseUrl(): string {
  const b = import.meta.env.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

function compact(o: { label: string; detail?: string | undefined; href?: string | undefined }): HotspotText {
  const r: HotspotText = { label: o.label };
  if (o.detail) r.detail = o.detail;
  if (o.href) r.href = o.href;
  return r;
}

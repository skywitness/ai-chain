/**
 * <ai-scene> custom element. This is the ONLY always-loaded 3D code on a page (keep it tiny):
 * it decides when to load, shows the fallback, owns the step UI (so captions work without WebGL)
 * and routes toolbar clicks / scene:command events. three.js, the engine (host.ts) and the scene
 * chunk are imported lazily when loading starts.
 *
 * Attributes (rendered by Scene3D.astro): data-id, data-variant, data-step, data-autoload
 * (visible | idle | click), data-url-overrides (sandbox: honour ?variant= & ?step=).
 */
import { detectQuality, probeWebGL, qualityOverride } from './detect';
import { registerTestHandle } from './testhooks';
import type { HostBridge, SceneHost } from './host';
import type { HostState, SceneCommand, SceneModule, SceneStats } from './types';

const loaders = import.meta.glob<{ default: SceneModule<unknown> }>('/src/three/scenes/*/index.ts');

const MSG = {
  nogl: '您的瀏覽器未啟用 WebGL 2，以下為靜態示意圖。',
  off: '已關閉 3D 互動，以下為靜態示意圖。',
  missing: '此 3D 場景尚未完成，以下為示意圖。',
  error: '3D 場景載入失敗，以下為靜態示意圖。',
};

function param(k: string): string | null {
  try {
    return new URLSearchParams(location.search).get(k);
  } catch {
    return null;
  }
}

class AiScene extends HTMLElement implements HostBridge {
  host: SceneHost | null = null;
  state: HostState = 'poster';
  step = 0;
  private io: IntersectionObserver | null = null;
  private loading: Promise<void> | null = null;
  private queue: SceneCommand[] = [];
  private ac: AbortController | null = null;
  private unreg: (() => void) | null = null;

  get el(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    this.ac = new AbortController();
    const { signal } = this.ac;
    const ds = this.dataset;
    if (ds['urlOverrides'] !== undefined) {
      const v = param('variant');
      const s = param('step');
      if (v) ds['variant'] = v;
      if (s) ds['step'] = s;
    }
    this.stepUI(Number(ds['step']) || 0);
    this.addEventListener('click', (e) => this.onClick(e), { signal });
    this.addEventListener('scene:command', (e) => this.command((e as CustomEvent<SceneCommand>).detail), { signal });
    this.unreg = registerTestHandle({
      id: ds['id'] ?? '',
      el: this,
      stats: () => this.stats,
      command: (c) => this.command(c),
    });
    const p = probeWebGL();
    const q = qualityOverride();
    if (!p.ok || q === 'off' || !this.loader()) {
      this.setState('fallback', !p.ok ? MSG.nogl : q === 'off' ? MSG.off : MSG.missing);
      return;
    }
    this.arm();
  }

  disconnectedCallback(): void {
    this.ac?.abort();
    this.io?.disconnect();
    this.host?.dispose();
    this.host = null;
    this.unreg?.();
  }

  private loader(): (() => Promise<{ default: SceneModule<unknown> }>) | undefined {
    return loaders[`/src/three/scenes/${this.dataset['id']}/index.ts`];
  }

  /**
   * Arm the loading trigger. After an eviction `mode` is forced: 'visible' with no margin (reload
   * when the reader scrolls back) or 'click' when it was evicted while on screen (no ping-pong).
   */
  private arm(forced?: 'visible' | 'click'): void {
    let mode = forced ?? this.dataset['autoload'] ?? 'visible';
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) mode = 'click';
    if (probeWebGL().software && import.meta.env.PROD && !navigator.webdriver) mode = 'click';
    this.dataset['armed'] = mode;
    this.setState('poster');
    if (mode === 'click') return;
    if (mode === 'idle') {
      const go = () =>
        'requestIdleCallback' in window
          ? requestIdleCallback(() => void this.load(), { timeout: 2000 })
          : setTimeout(() => void this.load(), 200);
      if (document.readyState === 'complete') go();
      else if (this.ac) addEventListener('load', go, { once: true, signal: this.ac.signal });
      return;
    }
    this.io?.disconnect();
    this.io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          this.io?.disconnect();
          void this.load();
        }
      },
      { rootMargin: forced ? '0px' : '200px' },
    );
    this.io.observe(this);
  }

  load(): Promise<void> {
    if (this.host) return Promise.resolve();
    if (this.loading) return this.loading;
    const loader = this.loader();
    if (!loader) return Promise.resolve();
    this.setState('loading');
    this.loading = (async () => {
      try {
        const [{ SceneHost }, mod] = await Promise.all([import('./host'), loader()]);
        if (!this.isConnected) return;
        const forced = qualityOverride();
        const auto = detectQuality();
        const quality = forced && forced !== 'off' ? forced : auto === 'off' ? 'low' : auto;
        const host = new SceneHost(this, mod.default, {
          variant: this.dataset['variant'] ?? '',
          quality,
          forced: !!forced,
          seed: param('seed') ?? '1',
        });
        this.host = host;
        await host.mount();
        if (this.host !== host || host.state === 'disposed') return;
        for (const c of this.queue.splice(0)) host.command(c);
      } catch (err) {
        console.error('[ai-scene] load failed', err);
        this.host = null;
        this.setState('error', MSG.error);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  setState(s: HostState, message?: string): void {
    this.state = s;
    this.dataset['state'] = s;
    const st = this.querySelector('.scene-status');
    if (st) st.textContent = message ?? (s === 'loading' ? '3D 場景載入中…' : '');
    this.dispatchEvent(new CustomEvent('scene:state', { bubbles: true, detail: { state: s } }));
  }

  stepUI(i: number): void {
    const btns = this.querySelectorAll<HTMLElement>('[data-cmd="step"]');
    const n = btns.length;
    this.step = n ? Math.max(0, Math.min(i, n - 1)) : 0;
    this.dataset['step'] = String(this.step);
    btns.forEach((b, k) => {
      if (k === this.step) {
        b.setAttribute('aria-current', 'step');
        const list = b.closest('ol');
        if (list && list.scrollWidth > list.clientWidth) {
          const li = b.parentElement as HTMLElement;
          list.scrollLeft = li.offsetLeft - (list.clientWidth - li.offsetWidth) / 2;
        }
        const cap = this.querySelector('.scene-stepcap');
        if (cap) cap.textContent = b.dataset['caption'] ?? '';
        const t = this.querySelector('.scene-steptitle');
        if (t) t.textContent = `${k + 1}／${n}　${b.dataset['title'] ?? ''}`;
      } else b.removeAttribute('aria-current');
    });
    const prev = this.querySelector<HTMLButtonElement>('[data-cmd="prev"]');
    const next = this.querySelector<HTMLButtonElement>('[data-cmd="next"]');
    if (prev) prev.disabled = this.step <= 0;
    if (next) next.disabled = this.step >= n - 1;
  }

  private goStep(i: number): void {
    if (this.host) void this.host.setStep(i);
    else {
      this.stepUI(i);
      this.dispatchEvent(new CustomEvent('scene:step', { bubbles: true, detail: { index: this.step } }));
    }
  }

  evicted(visible: boolean): void {
    this.host = null;
    this.arm(visible ? 'click' : 'visible');
  }

  private losses: number[] = [];
  contextLost(): void {
    this.host = null;
    const now = Date.now();
    this.losses = this.losses.filter((t) => now - t < 60_000);
    this.losses.push(now);
    // Remount after a short pause; after repeated losses wait for the reader to click.
    if (this.losses.length > 2) {
      this.dataset['armed'] = 'click';
      this.setState('error', MSG.error);
    } else setTimeout(() => this.isConnected && this.arm('visible'), 400);
  }

  command(c: SceneCommand): void {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'step') return this.goStep(c.index);
    if (c.type === 'load') return void this.load();
    if (this.host) return this.host.command(c);
    if (c.type === 'variant') this.dataset['variant'] = c.variant;
    else this.queue.push(c);
  }

  private onClick(e: Event): void {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-cmd]');
    if (!b || !this.contains(b)) return;
    const h = this.host;
    switch (b.dataset['cmd']) {
      case 'prev':
        return this.goStep(this.step - 1);
      case 'next':
        return this.goStep(this.step + 1);
      case 'step':
        return this.goStep(Number(b.dataset['index']) || 0);
      case 'load':
      case 'retry':
        return void this.load();
      case 'reset':
        return h?.resetView();
      case 'fullscreen':
        return h?.toggleFullscreen();
      case 'motion':
        return h?.toggleMotion();
      default:
    }
  }

  get stats(): SceneStats {
    return (
      this.host?.stats() ?? {
        frames: 0,
        drawCalls: 0,
        triangles: 0,
        quality: null,
        state: this.state,
        variant: this.dataset['variant'] ?? '',
        step: this.step,
        geometries: 0,
        textures: 0,
        animate: false,
        loop: 'demand',
        budget: null,
        fixture: this.hasAttribute('data-fixture'),
      }
    );
  }
}

if (!customElements.get('ai-scene')) customElements.define('ai-scene', AiScene);

declare global {
  interface HTMLElementTagNameMap {
    'ai-scene': AiScene;
  }
}

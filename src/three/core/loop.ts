/**
 * Render loop: render-on-demand (`invalidate()`) plus a continuous mode for ambient flows.
 * Uses requestAnimationFrame directly (no XR) and THREE.Timer (r183+) for deltas; the timer is
 * connected to the document so hidden tabs do not produce huge deltas. The low tier caps
 * continuous loops at 30 fps by accumulating the delta.
 */
import { Timer } from 'three';

export type LoopMode = 'continuous' | 'demand';

export class Loop {
  mode: LoopMode = 'demand';
  /** fps cap for continuous mode (0 = display rate). */
  fpsCap = 0;
  private raf = 0;
  private needs = true;
  private running = false;
  private acc = 0;
  private readonly timer = new Timer();

  /**
   * @param frame called once per rendered frame with the real delta (s, clamped to 0.1) and the rAF
   *   timestamp. Return true to request another frame in demand mode.
   */
  constructor(private readonly frame: (dt: number, now: number) => boolean) {
    this.timer.connect(document);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.acc = 0;
    this.timer.reset();
    this.needs = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  invalidate(): void {
    this.needs = true;
    if (this.running) this.schedule();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (ts: number): void => {
    this.raf = 0;
    if (!this.running) return;
    this.timer.update(ts);
    let dt = Math.min(0.1, this.timer.getDelta());
    if (this.mode === 'continuous' && this.fpsCap > 0 && !this.needs) {
      this.acc += dt;
      if (this.acc < 1 / this.fpsCap - 0.002) {
        this.schedule();
        return;
      }
      dt = Math.min(0.1, this.acc);
      this.acc = 0;
    }
    this.needs = false;
    const more = this.frame(dt, ts);
    if (this.mode === 'continuous' || more || this.needs) this.schedule();
  };

  dispose(): void {
    this.stop();
    this.timer.dispose();
  }
}

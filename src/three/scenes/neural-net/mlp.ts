/**
 * A tiny, real multilayer perceptron (ReLU hidden layers, softmax output, cross-entropy loss,
 * mini-batch SGD) used to drive the neural-net scene. Deterministic through the injected RNG.
 */
import type { Rng } from '../../core/types';

export interface Sample {
  x: number[];
  /** class index */
  y: number;
}

export interface Pass {
  /** activations per layer (layer 0 = inputs) */
  acts: number[][];
  /** softmax probabilities */
  probs: number[];
  loss: number;
}

export interface Grads {
  /** dL/dW per weight layer: [layer][to][from] */
  w: number[][][];
  b: number[][];
}

export class MLP {
  /** weights[l][j][i]: from neuron i in layer l to neuron j in layer l+1 */
  w: number[][][];
  b: number[][];

  constructor(
    readonly sizes: readonly number[],
    private readonly rng: Rng,
  ) {
    this.w = [];
    this.b = [];
    this.init();
  }

  init(): void {
    this.w = [];
    this.b = [];
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const nin = this.sizes[l]!;
      const nout = this.sizes[l + 1]!;
      const scale = Math.sqrt(2 / nin) * 0.9;
      this.w.push(Array.from({ length: nout }, () => Array.from({ length: nin }, () => this.rng.normal() * scale)));
      this.b.push(Array.from({ length: nout }, () => 0.05));
    }
  }

  forward(x: readonly number[], y: number): Pass {
    const acts: number[][] = [[...x]];
    let a = [...x];
    const L = this.w.length;
    let probs: number[] = [];
    for (let l = 0; l < L; l++) {
      const W = this.w[l]!;
      const z = W.map((row, j) => row.reduce((s, wij, i) => s + wij * (a[i] ?? 0), this.b[l]![j] ?? 0));
      if (l === L - 1) {
        const m = Math.max(...z);
        const e = z.map((v) => Math.exp(v - m));
        const sum = e.reduce((s, v) => s + v, 0);
        probs = e.map((v) => v / sum);
        a = probs;
      } else a = z.map((v) => Math.max(0, v));
      acts.push(a);
    }
    return { acts, probs, loss: -Math.log(Math.max(1e-9, probs[y] ?? 1e-9)) };
  }

  backward(p: Pass, y: number): Grads {
    const L = this.w.length;
    const gw: number[][][] = new Array(L);
    const gb: number[][] = new Array(L);
    // softmax + cross-entropy: dL/dz = p - onehot
    let delta = p.probs.map((v, j) => v - (j === y ? 1 : 0));
    for (let l = L - 1; l >= 0; l--) {
      const aPrev = p.acts[l]!;
      gw[l] = delta.map((d) => aPrev.map((a) => d * a));
      gb[l] = [...delta];
      if (l > 0) {
        const W = this.w[l]!;
        const next = aPrev.map((_, i) => W.reduce((s, row, j) => s + (row[i] ?? 0) * (delta[j] ?? 0), 0));
        delta = next.map((v, i) => ((aPrev[i] ?? 0) > 0 ? v : 0));
      }
    }
    return { w: gw, b: gb };
  }

  /** Apply averaged gradients. */
  step(grads: readonly Grads[], lr: number): void {
    const n = grads.length || 1;
    for (let l = 0; l < this.w.length; l++) {
      const W = this.w[l]!;
      for (let j = 0; j < W.length; j++) {
        const row = W[j]!;
        for (let i = 0; i < row.length; i++) {
          let g = 0;
          for (const gr of grads) g += gr.w[l]![j]![i] ?? 0;
          row[i] = (row[i] ?? 0) - (lr * g) / n;
        }
        let gbs = 0;
        for (const gr of grads) gbs += gr.b[l]![j] ?? 0;
        this.b[l]![j] = (this.b[l]![j] ?? 0) - (lr * gbs) / n;
      }
    }
  }

  /** Flat copy of the weights in edge order (layer, to, from). */
  flatWeights(): number[] {
    return this.w.flatMap((W) => W.flatMap((row) => row));
  }
}

/** Synthetic, illustrative dataset: 4 features → 貓／狗／鳥. */
export const FEATURES = ['耳朵尖', '體型大', '有羽毛', '叫聲高'] as const;
export const CLASSES = ['貓', '狗', '鳥'] as const;
const PROTOTYPES = [
  [0.88, 0.32, 0.05, 0.72],
  [0.35, 0.8, 0.05, 0.3],
  [0.12, 0.12, 0.95, 0.86],
];

export function makeSample(rng: Rng, y?: number): Sample {
  const cls = y ?? rng.int(3);
  const p = PROTOTYPES[cls]!;
  return { x: p.map((v) => Math.min(1, Math.max(0, v + rng.normal() * 0.09))), y: cls };
}

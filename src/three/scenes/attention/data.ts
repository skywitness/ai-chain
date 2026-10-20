/**
 * Illustrative ("示意") numbers for the attention scene. Nothing here is measured from a real model:
 * the attention rows are hand-designed so that each head shows a pattern that real models are
 * known to learn (semantic links, previous-token, subject/object, broad context), then normalised
 * with a softmax over the causal window. Embeddings and Q/K/V values are deterministic
 * pseudo-random numbers used only for colour.
 */

/** The demo sentence, split the way a tokenizer might (示意: real tokenizers often split finer). */
export const TOKENS = ['台積電', '為', '輝達', '生產', 'AI', '晶片'] as const;
export const N_TOK = TOKENS.length;
/** Vocabulary ids the tokenizer might assign (示意: made-up numbers, only to show "token → id"). */
export const TOKEN_IDS = [48213, 5410, 77102, 9351, 15836, 30927] as const;

/** Embedding width shown (示意; real models use thousands of dimensions). */
export const DIM = 8;
export const HEADS = 4;
/** Dimensions per head = DIM / HEADS. */
export const HEAD_DIM = DIM / HEADS;

export interface HeadSpec {
  name: string;
  short: string;
  /** Chart colour index (1-based, --chart-N). */
  chart: number;
  /** Affinity rows (j ≤ i only); normalised with a softmax of log-affinities below. */
  rows: readonly (readonly number[])[];
}

export const HEAD_SPECS: readonly HeadSpec[] = [
  {
    name: '語意關聯',
    short: '語意',
    chart: 2,
    rows: [[1], [0.6, 0.4], [0.45, 0.15, 0.4], [0.5, 0.05, 0.25, 0.2], [0.1, 0.03, 0.32, 0.25, 0.3], [0.15, 0.03, 0.12, 0.3, 0.32, 0.08]],
  },
  {
    name: '前一個 Token',
    short: '前一個',
    chart: 1,
    rows: [[1], [0.8, 0.2], [0.06, 0.8, 0.14], [0.04, 0.06, 0.78, 0.12], [0.03, 0.03, 0.06, 0.76, 0.12], [0.02, 0.02, 0.04, 0.06, 0.76, 0.1]],
  },
  {
    name: '主詞與對象',
    short: '主詞',
    chart: 3,
    rows: [[1], [0.7, 0.3], [0.62, 0.08, 0.3], [0.55, 0.05, 0.3, 0.1], [0.3, 0.04, 0.42, 0.14, 0.1], [0.44, 0.04, 0.34, 0.08, 0.05, 0.05]],
  },
  {
    name: '整句脈絡',
    short: '脈絡',
    chart: 5,
    rows: [[1], [1.3, 0.6], [1.3, 0.6, 1.3], [1.3, 0.6, 1.3, 1], [1.3, 0.6, 1.3, 1, 1.3], [1.3, 0.6, 1.3, 1, 1.3, 1.3]],
  },
];

/** softmax over the causal window: weights[h][i][j] for j ≤ i (zero for j > i, the mask). */
export const WEIGHTS: readonly (readonly (readonly number[])[])[] = HEAD_SPECS.map((h) =>
  h.rows.map((row, i) => {
    const scores = Array.from({ length: N_TOK }, (_, j) => (j <= i ? Math.log(row[j] ?? 1e-6) : -Infinity));
    const m = Math.max(...scores);
    const e = scores.map((s) => (Number.isFinite(s) ? Math.exp(s - m) : 0));
    const sum = e.reduce((a, b) => a + b, 0) || 1;
    return e.map((v) => v / sum);
  }),
);

/** Deterministic pseudo-random value in [-1, 1] (no Math.random, stable across variants). */
export function hashVal(a: number, b: number, c = 0): number {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7 + 0.5) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Embedding value of token i, dimension k (示意). */
export const emb = (i: number, k: number): number => hashVal(i + 1, k + 1, 1);
/** Q / K / V value (m = 0 Q, 1 K, 2 V) of token i, dimension k (示意). */
export const qkvVal = (i: number, m: number, k: number): number => hashVal(i + 1, k + 1, 2 + m);

/* ───────────── layers variant ───────────── */

/** The layers / MoE variants feed this prefix; the model predicts the next token. */
export const PREFIX = ['台積電', '為', '輝達', '生產', 'AI'] as const;
/** Next-token candidates with illustrative probabilities (示意). */
export const NEXT: readonly { text: string; p: number }[] = [
  { text: '晶片', p: 0.62 },
  { text: '伺服器', p: 0.14 },
  { text: '模型', p: 0.08 },
  { text: '產品', p: 0.05 },
];

/** Attention arcs inside each shown block: [from j, to i, weight]. Shallow = local, deep = long range (示意). */
export const BLOCK_ARCS: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [0, 1, 0.8],
    [1, 2, 0.8],
    [2, 3, 0.75],
    [3, 4, 0.8],
  ],
  [
    [0, 2, 0.55],
    [1, 2, 0.5],
    [2, 3, 0.6],
    [0, 3, 0.45],
    [3, 4, 0.55],
  ],
  [
    [0, 3, 0.85],
    [2, 4, 0.7],
    [0, 4, 0.55],
    [2, 3, 0.4],
  ],
];

/* ───────────── MoE variant ───────────── */

export const EXPERTS = 8;
export const TOP_K = 2;

/** Router scores per token (top two by design; the rest small), normalised to probabilities like a softmax output (示意). */
const ROUTE_TOP: readonly (readonly [number, number, number, number])[] = [
  // [expert a, score a, expert b, score b]
  [2, 0.55, 5, 0.25],
  [0, 0.5, 4, 0.22],
  [2, 0.45, 6, 0.3],
  [1, 0.5, 7, 0.25],
  [6, 0.5, 3, 0.26],
  [5, 0.48, 2, 0.27],
];

export interface Route {
  /** Router probabilities over all experts (softmax). */
  probs: number[];
  /** Chosen experts (top-2, best first). */
  top: [number, number];
  /** Gate weights after renormalising over the top-2 (sum = 1). */
  gate: [number, number];
}

export const ROUTES: readonly Route[] = ROUTE_TOP.map(([a, sa, b, sb], i) => {
  const raw = Array.from({ length: EXPERTS }, (_, e) => (e === a ? sa : e === b ? sb : 0.02 + 0.04 * Math.abs(hashVal(i + 3, e + 1, 9))));
  const sum = raw.reduce((x, y) => x + y, 0);
  const probs = raw.map((v) => v / sum);
  const ga = probs[a] ?? 0;
  const gb = probs[b] ?? 0;
  return { probs, top: [a, b], gate: [ga / (ga + gb), gb / (ga + gb)] };
});

/**
 * Token slots per expert in an illustrative batch of 64 tokens × top-2 = 128 slots, before vs after
 * the load-balancing loss (示意). Both rows sum to 128: balancing moves work, it does not add any.
 */
export const LOAD_UNBALANCED: readonly number[] = [6, 5, 46, 4, 9, 36, 14, 8];
export const LOAD_BALANCED: readonly number[] = [15, 17, 18, 14, 16, 17, 15, 16];

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

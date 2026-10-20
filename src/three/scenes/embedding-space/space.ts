/**
 * embedding-space — the illustrative (示意) vector data behind both variants.
 *
 * Nothing here comes from a real model. Every word / chunk gets a 16-D vector built
 * deterministically from a hand-designed layout:
 *   dims 0–2  = the 3D position drawn on screen (the "projection" is simply these three dims),
 *   dims 3–15 = a topic code plus the amplified in-cluster offset, mixed by a fixed orthogonal
 *               matrix (so the numbers look dense, like real embeddings), plus a little noise.
 * Relations are built as constant offsets (gender, royalty, age, "capital of"), so vector
 * arithmetic genuinely works in 16-D and survives the linear projection to 3D. Nearest
 * neighbours and similarities are computed for real (cosine on mean-centred vectors).
 */

export const DIM = 16;
/** Hidden dims (DIM minus the three drawn ones). */
const H = DIM - 3;
/** How strongly the on-screen offset inside a cluster shows up in the hidden dims. */
const SPREAD = 3.2;
const RAG_SPREAD = 1.2;
type V3 = readonly [number, number, number];

/** mulberry32 — a private copy so the layout never depends on the page ?seed=. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** A fixed orthogonal n×n matrix (Gram–Schmidt on seeded noise). */
function orthogonal(n: number, seed: number): number[][] {
  const r = mulberry(seed);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v = Array.from({ length: n }, () => gauss(r));
    for (const u of rows) {
      const d = v.reduce((s, x, k) => s + x * u[k]!, 0);
      for (let k = 0; k < n; k++) v[k]! -= d * u[k]!;
    }
    const len = Math.hypot(...v);
    rows.push(v.map((x) => x / len));
  }
  return rows;
}

/**
 * Vector layout: dims 0–2 = the 3D position; dims 3–15 = mix · (topic code ⊕ noise) plus the
 * offset from the cluster centre, amplified by `spread` along the cluster's own three hidden
 * directions (`frame`). Words that sit close together on screen are therefore close in 16-D too,
 * relations (being linear) survive exactly, and different clusters do not leak into each other.
 */
function buildVector(
  pos: V3,
  code: readonly number[],
  offset: V3,
  mix: number[][],
  frame: number[][],
  noise: () => number,
  sigma: number,
  spread: number,
): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = pos[0];
  v[1] = pos[1];
  v[2] = pos[2];
  const h = new Array<number>(H).fill(0);
  for (let k = 0; k < H; k++) h[k] = (code[k] ?? 0) + noise() * sigma;
  for (let i = 0; i < H; i++) {
    let s = 0;
    for (let k = 0; k < H; k++) s += mix[i]![k]! * h[k]!;
    for (let a = 0; a < 3; a++) s += spread * frame[a]![i]! * offset[a]!;
    v[3 + i] = s;
  }
  return v;
}

/** Three orthonormal hidden directions for one cluster. */
const frameFor = (seed: number) => orthogonal(H, seed).slice(0, 3);

/** Cosine similarity of two (already centred) vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < DIM; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / Math.sqrt(na * nb || 1);
}

function centre(vs: Float32Array[]): void {
  const m = new Float32Array(DIM);
  for (const v of vs) for (let i = 0; i < DIM; i++) m[i]! += v[i]! / vs.length;
  for (const v of vs) for (let i = 0; i < DIM; i++) v[i]! -= m[i]!;
}

/* ═════════════════════════ semantic variant: words ═════════════════════════ */

export interface Cluster {
  id: string;
  /** zh-TW cluster title (3D label + card). */
  name: string;
  /** Hotspot id (meta.json). */
  hotspot: string;
  /** Palette ref resolved by the scene. */
  color: `seg:${string}` | `chart:${number}`;
  centre: V3;
}

export const CLUSTERS: readonly Cluster[] = [
  { id: 'chips', name: '晶片', hotspot: 'cluster-chips', color: 'seg:ai-accelerators', centre: [-4.1, 0.95, -0.35] },
  { id: 'memory', name: '記憶體', hotspot: 'cluster-memory', color: 'seg:memory-storage', centre: [-3.25, -1.3, 0.95] },
  { id: 'cities', name: '城市', hotspot: 'cluster-geo', color: 'chart:1', centre: [-0.7, 1.2, -1.75] },
  { id: 'countries', name: '國家', hotspot: 'cluster-geo', color: 'seg:datacenter-infra', centre: [-0.85, -1.85, -1.15] },
  { id: 'people', name: '人物', hotspot: 'cluster-people', color: 'chart:4', centre: [0.75, -0.75, 1.75] },
  { id: 'emotions', name: '情緒', hotspot: 'cluster-emotions', color: 'chart:8', centre: [3.15, 1.4, -0.8] },
  { id: 'animals', name: '動物', hotspot: 'cluster-animals', color: 'seg:foundation-models', centre: [3.7, -1.25, 0.6] },
  { id: 'food', name: '食物', hotspot: 'cluster-food', color: 'seg:devtools-data-mlops', centre: [1.15, 2.35, 0.35] },
];

/** Topic codes (9-D, before mixing). Related topics share a little of each other's code. */
const CODE: Record<string, number[]> = {
  chips: [1.6, 0.55, 0, 0, 0, 0, 0, 0, 0],
  memory: [0.55, 1.6, 0, 0, 0, 0, 0, 0, 0],
  cities: [0, 0, 1.6, 0.6, 0, 0, 0, 0.15, 0],
  countries: [0, 0, 0.6, 1.6, 0, 0, 0, 0, 0],
  people: [0, 0, 0, 0, 1.6, 0.35, 0.15, 0, 0],
  emotions: [0, 0, 0, 0, 0.35, 1.6, 0, 0, 0],
  animals: [0, 0, 0, 0, 0.15, 0, 1.6, 0.25, 0],
  food: [0, 0, 0.15, 0, 0, 0.1, 0.25, 1.6, 0],
};

export interface Word {
  text: string;
  cluster: number;
  /** 3D position (= dims 0–2). */
  pos: V3;
  /** Centred 16-D vector. */
  vec: Float32Array;
  /** Label priority hint (higher = shown first). */
  rank: number;
}

const add = (...vs: V3[]): V3 => [vs.reduce((s, v) => s + v[0], 0), vs.reduce((s, v) => s + v[1], 0), vs.reduce((s, v) => s + v[2], 0)];

/* Relation offsets (3D part; the topic code is shared inside a cluster). */
const G: V3 = [1.0, 0.05, 0.1]; // male → female
const R: V3 = [0.1, 1.3, -0.15]; // person → royalty
const A: V3 = [-0.3, -0.2, 0.75]; // adult → child
const F: V3 = [0.45, -0.55, -0.6]; // person → parent role
const MAN: V3 = [0.15, -1.15, 1.45];
const CAP: V3 = [0.15, 3.05, -0.6]; // country → capital

const COUNTRY: Record<string, V3> = {
  台灣: [-0.45, -1.85, -0.75],
  日本: [0.05, -1.7, -1.25],
  韓國: [-0.2, -1.5, -1.65],
  美國: [-1.55, -1.75, -0.85],
  法國: [-1.3, -2.1, -1.6],
  英國: [-1.75, -1.95, -1.25],
  德國: [-0.95, -2.3, -1.95],
  義大利: [-0.7, -2.35, -1.2],
};
const CAPITAL: Record<string, string> = {
  台灣: '台北',
  日本: '東京',
  韓國: '首爾',
  美國: '華盛頓',
  法國: '巴黎',
  英國: '倫敦',
  德國: '柏林',
  義大利: '羅馬',
};
/** Other cities: [name, country, small offset from the capital]. */
const OTHER_CITIES: [string, string, V3][] = [
  ['新竹', '台灣', [0.12, -0.36, 0.22]],
  ['台中', '台灣', [0.3, -0.18, 0.38]],
  ['高雄', '台灣', [-0.08, -0.48, 0.42]],
  ['大阪', '日本', [0.32, -0.3, 0.1]],
  ['京都', '日本', [0.36, -0.08, -0.22]],
  ['橫濱', '日本', [0.12, -0.42, -0.2]],
  ['紐約', '美國', [-0.3, -0.32, 0.12]],
  ['舊金山', '美國', [-0.12, -0.4, 0.38]],
  ['洛杉磯', '美國', [-0.38, -0.12, 0.42]],
  ['釜山', '韓國', [0.26, -0.34, -0.12]],
];

/** Free-form clusters: [word, offset from the cluster centre]. */
const FREE: Record<string, [string, V3][]> = {
  chips: [
    ['晶片', [0, 0, 0.3]],
    ['半導體', [0.18, 0.28, 0.08]],
    ['處理器', [-0.3, -0.2, 0.45]],
    ['GPU', [-0.48, -0.02, 0.62]],
    ['CPU', [-0.6, -0.32, 0.3]],
    ['NPU', [-0.78, 0.05, 0.55]],
    ['加速器', [-0.32, 0.2, 0.78]],
    ['電晶體', [0.38, 0.52, -0.1]],
    ['晶圓', [0.5, 0.2, -0.42]],
    ['晶粒', [0.18, -0.08, -0.28]],
    ['製程', [0.7, 0.45, -0.2]],
    ['微影', [0.8, 0.72, -0.48]],
    ['EUV', [1.0, 0.62, -0.7]],
    ['光罩', [0.62, 0.92, -0.62]],
    ['封裝', [0.38, -0.48, 0.05]],
    ['代工', [0.8, -0.02, -0.12]],
    ['矽', [0.26, 0.8, 0.15]],
  ],
  memory: [
    ['記憶體', [0, 0, 0]],
    ['DRAM', [0.28, 0.12, 0.25]],
    ['HBM', [0.16, 0.38, 0.4]],
    ['SRAM', [-0.28, 0.26, 0.15]],
    ['快取', [-0.45, 0.36, -0.05]],
    ['暫存器', [-0.62, 0.15, -0.22]],
    ['NAND', [0.42, -0.32, -0.12]],
    ['快閃記憶體', [0.3, -0.48, 0.18]],
    ['固態硬碟', [0.55, -0.52, -0.32]],
    ['硬碟', [0.72, -0.36, -0.48]],
    ['儲存', [0.48, -0.1, -0.42]],
    ['容量', [0.1, -0.48, -0.38]],
    ['頻寬', [-0.18, -0.26, 0.48]],
    ['延遲', [-0.4, -0.3, 0.32]],
    ['位元', [-0.2, -0.55, 0.05]],
  ],
  emotions: [
    ['快樂', [-0.48, 0.3, 0.2]],
    ['開心', [-0.36, 0.4, 0.38]],
    ['喜悅', [-0.6, 0.12, 0.02]],
    ['興奮', [-0.22, 0.65, 0.1]],
    ['感動', [-0.66, -0.08, 0.38]],
    ['平靜', [-0.32, -0.45, 0.22]],
    ['驚訝', [0.02, 0.8, -0.2]],
    ['悲傷', [0.48, -0.32, -0.1]],
    ['難過', [0.58, -0.18, 0.12]],
    ['失望', [0.36, -0.55, 0.28]],
    ['寂寞', [0.64, -0.58, -0.28]],
    ['憤怒', [0.55, 0.45, -0.22]],
    ['生氣', [0.42, 0.58, 0.02]],
    ['害怕', [0.2, 0.2, -0.55]],
    ['焦慮', [0.26, -0.02, -0.66]],
    ['緊張', [0.06, 0.12, -0.8]],
  ],
  animals: [
    ['貓', [-0.38, 0.28, 0.25]],
    ['老虎', [-0.6, 0.45, 0.02]],
    ['獅子', [-0.5, 0.66, -0.36]],
    ['狗', [-0.1, 0.06, 0.48]],
    ['狼', [-0.2, 0.3, 0.85]],
    ['熊', [-0.2, 0.72, 0.12]],
    ['兔子', [0.12, -0.45, 0.58]],
    ['猴子', [0.2, 0.48, -0.38]],
    ['大象', [0.55, 0.36, -0.52]],
    ['馬', [0.46, -0.1, 0.12]],
    ['牛', [0.62, -0.32, -0.15]],
    ['羊', [0.4, -0.38, 0.32]],
    ['鳥', [0.02, 0.92, 0.3]],
    ['企鵝', [0.75, -0.72, 0.15]],
    ['魚', [0.88, -0.55, 0.52]],
    ['鯨魚', [1.02, -0.42, 0.22]],
  ],
  food: [
    ['牛肉麵', [-0.45, 0.0, 0.3]],
    ['滷肉飯', [-0.36, -0.22, 0.5]],
    ['小籠包', [-0.62, 0.2, 0.1]],
    ['水餃', [-0.78, 0.02, 0.42]],
    ['臭豆腐', [-0.58, -0.28, 0.32]],
    ['珍珠奶茶', [0.0, -0.36, 0.58]],
    ['拉麵', [-0.15, 0.36, -0.22]],
    ['壽司', [0.05, 0.52, -0.38]],
    ['披薩', [0.52, 0.28, -0.12]],
    ['漢堡', [0.62, 0.06, 0.1]],
    ['麵包', [0.46, -0.2, -0.32]],
    ['蛋糕', [0.3, -0.42, -0.16]],
    ['咖啡', [0.16, -0.6, 0.12]],
    ['茶', [-0.06, -0.62, 0.32]],
    ['芒果', [0.8, -0.25, 0.42]],
    ['香蕉', [0.88, 0.0, 0.2]],
  ],
};

/** Words shown first when labels compete (the rest appear as you zoom or hover). */
const RANK: Record<string, number> = {
  GPU: 9, 晶片: 8, 晶圓: 6, 電晶體: 5, 封裝: 4,
  HBM: 9, DRAM: 7, 記憶體: 8, 快取: 5, 固態硬碟: 4,
  台北: 9, 東京: 8, 巴黎: 6, 紐約: 6, 高雄: 5, 首爾: 5,
  台灣: 9, 日本: 8, 美國: 6, 法國: 5,
  國王: 9, 女王: 9, 男人: 8, 女人: 8, 王子: 5, 公主: 5,
  快樂: 9, 悲傷: 8, 憤怒: 7, 平靜: 5,
  貓: 9, 狗: 8, 老虎: 7, 鯨魚: 5, 鳥: 5,
  牛肉麵: 9, 珍珠奶茶: 8, 壽司: 6, 咖啡: 6, 披薩: 5,
};

export interface SemanticSpace {
  words: Word[];
  index: Map<string, number>;
  /** k nearest neighbours of word i (by cosine), excluding itself. */
  neighbours(i: number, k: number): { i: number; sim: number }[];
  /** a − b + c, and the nearest word to it (excluding a, b, c). */
  analogy(a: string, b: string, c: string): { result: Float32Array; best: number; sim: number };
}

/**
 * Per-word noise (hidden dims) for the relation clusters: enough that analogies land near, not
 * exactly on, the answer (real embeddings are imperfect too). People use a tighter in-cluster
 * spread so the relation offsets never push a word towards another topic.
 */
const GEO_SIGMA = 0.2;
const PEOPLE_SIGMA = 0.2;
const PEOPLE_SPREAD = 1.6;

export function buildSemantic(): SemanticSpace {
  const mix = orthogonal(H, 20261006);
  const frames = Object.fromEntries(CLUSTERS.map((c, i) => [c.id, frameFor(101 + i * 17)]));
  const noise = mulberry(7);
  const words: Word[] = [];
  const push = (text: string, cluster: string, pos: V3, sigma = 0.06, spread = SPREAD) => {
    const ci = CLUSTERS.findIndex((c) => c.id === cluster);
    const jitter: V3 = [gauss(noise) * 0.035, gauss(noise) * 0.035, gauss(noise) * 0.035];
    const p = add(pos, jitter);
    const c = CLUSTERS[ci]!.centre;
    const off: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const fr = frames[cluster === 'cities' ? 'countries' : cluster]!; // geography shares one frame
    words.push({ text, cluster: ci, pos: p, vec: buildVector(p, CODE[cluster]!, off, mix, fr, () => gauss(noise), sigma, spread), rank: RANK[text] ?? 0 });
  };
  for (const id of ['chips', 'memory'] as const) for (const [w, o] of FREE[id]!) push(w, id, add(CLUSTERS.find((c) => c.id === id)!.centre, o));
  // Geography: capital = country + CAP (the same offset everywhere).
  for (const [c, p] of Object.entries(COUNTRY)) push(c, 'countries', p, GEO_SIGMA);
  for (const [c, p] of Object.entries(COUNTRY)) push(CAPITAL[c]!, 'cities', add(p, CAP), GEO_SIGMA);
  for (const [w, c, o] of OTHER_CITIES) push(w, 'cities', add(COUNTRY[c]!, CAP, o), GEO_SIGMA);
  // People: a little "cube" of relations (gender × royalty × age, plus parent roles).
  const people: [string, V3][] = [
    ['男人', MAN],
    ['女人', add(MAN, G)],
    ['國王', add(MAN, R)],
    ['女王', add(MAN, G, R)],
    ['男孩', add(MAN, A)],
    ['女孩', add(MAN, A, G)],
    ['王子', add(MAN, A, R)],
    ['公主', add(MAN, A, G, R)],
    ['父親', add(MAN, F)],
    ['母親', add(MAN, F, G)],
    ['兒子', add(MAN, F, A)],
    ['女兒', add(MAN, F, A, G)],
  ];
  for (const [w, p] of people) push(w, 'people', p, PEOPLE_SIGMA, PEOPLE_SPREAD);
  for (const id of ['emotions', 'animals', 'food'] as const) for (const [w, o] of FREE[id]!) push(w, id, add(CLUSTERS.find((c) => c.id === id)!.centre, o));

  const raw = words.map((w) => w.vec);
  const mean = new Float32Array(DIM);
  for (const v of raw) for (let i = 0; i < DIM; i++) mean[i]! += v[i]! / raw.length;
  centre(raw);
  const index = new Map(words.map((w, i) => [w.text, i]));

  const nearest = (q: ArrayLike<number>, k: number, skip: Set<number>) => {
    const out: { i: number; sim: number }[] = [];
    words.forEach((w, i) => {
      if (skip.has(i)) return;
      out.push({ i, sim: cosine(q, w.vec) });
    });
    out.sort((a, b) => b.sim - a.sim);
    return out.slice(0, k);
  };

  return {
    words,
    index,
    neighbours: (i, k) => nearest(words[i]!.vec, k, new Set([i])),
    analogy(a, b, c) {
      const ia = index.get(a)!;
      const ib = index.get(b)!;
      const ic = index.get(c)!;
      const r = new Float32Array(DIM);
      for (let d = 0; d < DIM; d++) r[d] = words[ia]!.vec[d]! - words[ib]!.vec[d]! + words[ic]!.vec[d]!;
      const top = nearest(r, 1, new Set([ia, ib, ic]))[0]!;
      // Back to display coordinates: the projection is dims 0–2 plus the mean that was removed.
      const result = new Float32Array(DIM);
      for (let d = 0; d < DIM; d++) result[d] = r[d]! + mean[d]!;
      return { result, best: top.i, sim: top.sim };
    },
  };
}

/* ═════════════════════════ rag variant: document chunks ═════════════════════════ */

export interface Doc {
  id: string;
  title: string;
  /** Short topic tag for the 3D label. */
  tag: string;
  color: `seg:${string}`;
  centre: V3;
  chunks: string[];
}

export const DOCS: readonly Doc[] = [
  {
    id: 'hbm',
    title: '《HBM 技術筆記》',
    tag: 'HBM',
    color: 'seg:memory-storage',
    centre: [-0.95, 0.55, 0.15],
    chunks: [
      'HBM 由多層 DRAM 晶粒垂直堆疊而成',
      '堆疊的晶粒之間以矽穿孔（TSV）上下連通',
      '最底層的基底晶粒負責對外介面與控制',
      'HBM 以極寬的資料介面換取高頻寬',
      'HBM 緊鄰 GPU 擺放，縮短訊號傳輸距離',
      '堆疊層數越多，單顆 HBM 的容量越大',
      '堆疊越高，散熱與良率的挑戰越大',
      'HBM 每傳輸一個位元的能耗較低',
    ],
  },
  {
    id: 'packaging',
    title: '《先進封裝入門》',
    tag: '先進封裝',
    color: 'seg:foundry-packaging',
    centre: [0.95, 0.6, 0.05],
    chunks: [
      'CoWoS 把 GPU 與 HBM 並排放在矽中介層上',
      '矽中介層內的細密線路連接 GPU 與 HBM',
      '中介層再接合到封裝載板，連到電路板',
      '2.5D 封裝讓晶粒之間的距離大幅縮短',
      'SoIC 以混合鍵合把晶粒直接垂直接合',
      '微凸塊把晶粒焊接在中介層上',
      '中介層面積越大，可並排的 HBM 越多',
      '先進封裝產能是 AI 晶片供應的關鍵環節',
    ],
  },
  {
    id: 'euv',
    title: '《EUV 微影原理》',
    tag: 'EUV 微影',
    color: 'seg:semi-equipment-materials',
    centre: [1.25, -0.95, -0.35],
    chunks: [
      '高功率 CO₂ 雷射擊打錫滴，產生電漿',
      '電漿放出波長 13.5 nm 的極紫外光',
      '集光鏡收集光線，送進照明系統',
      'EUV 會被空氣吸收，光路必須在真空中',
      'EUV 光罩是反射式的，以多層膜反射光線',
      '投影反射鏡組把圖案縮小投影到晶圓上',
      'High-NA 提高數值孔徑，解析度更高',
      '晶圓台高速移動，逐區掃描曝光',
    ],
  },
  {
    id: 'cooling',
    title: '《資料中心散熱》',
    tag: '散熱',
    color: 'seg:datacenter-infra',
    centre: [-1.3, -0.85, -0.35],
    chunks: [
      '冷板式液冷直接帶走晶片產生的熱',
      '冷熱通道隔離可以提升氣冷效率',
      '冷卻液分配單元（CDU）調節液體循環',
      '浸沒式冷卻把伺服器浸在絕緣液體中',
      '高功率機櫃越來越依賴液冷',
      'PUE 衡量資料中心的能源使用效率',
      '冷卻塔與冰水主機把熱排到戶外',
      '熱交換器隔開機櫃與設施兩個水迴路',
    ],
  },
  {
    id: 'training',
    title: '《模型訓練入門》',
    tag: '模型訓練',
    color: 'seg:devtools-data-mlops',
    centre: [0.15, -0.35, -1.35],
    chunks: [
      '訓練以反向傳播計算梯度、更新權重',
      '大型模型以大量 GPU 平行訓練',
      '資料平行把每個批次切給不同的 GPU',
      '梯度在 GPU 之間以 all-reduce 同步',
      '學習率決定每次更新的步伐大小',
      '檢查點定期保存模型狀態，以防中斷',
      '訓練資料需要清洗、去重與過濾',
      '損失函數衡量預測與正確答案的差距',
    ],
  },
  {
    id: 'network',
    title: '《AI 網路與光通訊》',
    tag: '網路',
    color: 'seg:networking-optics',
    centre: [-0.05, -1.25, 0.95],
    chunks: [
      'NVLink 在機櫃內高速連接多顆 GPU',
      '葉脊架構串連資料中心內的大量伺服器',
      '光收發模組把電訊號轉成光訊號',
      '共同封裝光學（CPO）把光引擎移近交換晶片',
      'InfiniBand 與乙太網路都用於 AI 叢集',
      'RDMA 讓資料繞過 CPU 直接搬移',
      '銅線適合短距離，光纖適合長距離傳輸',
      '網路頻寬不足會讓 GPU 閒置等待',
    ],
  },
];

export const QUERY_TEXT = 'HBM 和 GPU 怎麼封裝在一起？';
export const ANSWER_TEXT =
  'GPU 與 HBM 以 CoWoS 並排放在矽中介層上，透過中介層內的細密線路相連；HBM 本身由多層 DRAM 晶粒以 TSV 堆疊而成。';
export const TOP_K = 4;

/** The query vector's 3D position inside the database cloud (local coordinates). */
const QUERY_POS: V3 = [0.0, 0.62, 0.78];
/** Hand-placed answers: [doc index, chunk index, position]. Everything else keeps its distance. */
const PLACED: [number, number, V3][] = [
  [1, 0, [0.25, 0.71, 0.75]],
  [0, 4, [-0.35, 0.51, 0.82]],
  [1, 1, [0.43, 0.37, 0.56]],
  [0, 0, [-0.57, 0.92, 0.46]],
];

export interface Chunk {
  doc: number;
  idx: number;
  text: string;
  pos: V3;
  vec: Float32Array;
  /** Small tilt so the cloud reads as loose paper slips. */
  tilt: V3;
}

export interface RagSpace {
  chunks: Chunk[];
  query: { pos: V3; vec: Float32Array };
  /** Top-k chunks by cosine similarity to the query, best first. */
  top: { i: number; sim: number; dist: number }[];
  /** Every chunk, ranked the same way. */
  ranked: { i: number; sim: number; dist: number }[];
}

export function buildRag(): RagSpace {
  const mix = orthogonal(H, 1306);
  const frame = frameFor(77); // one shared frame: chunk offsets are absolute positions in the cloud
  const r = mulberry(31);
  const codeOf = (d: number) => Array.from({ length: 9 }, (_, k) => (k === d ? 1.5 : 0));
  const chunks: Chunk[] = [];
  const minGap = 0.36;
  const far = 1.0; // non-answers stay clearly outside the search radius
  const placed = new Map(PLACED.map(([d, c, p]) => [`${d}:${c}`, p]));
  const taken: V3[] = PLACED.map((p) => p[2]);
  DOCS.forEach((doc, d) => {
    doc.chunks.forEach((text, idx) => {
      let p = placed.get(`${d}:${idx}`);
      if (!p) {
        for (let tries = 0; tries < 400; tries++) {
          const a = r() * Math.PI * 2;
          const u = r() * 2 - 1;
          const rad = 0.28 + 0.42 * Math.sqrt(r());
          const s = Math.sqrt(1 - u * u);
          const c: V3 = [doc.centre[0] + Math.cos(a) * s * rad * 1.15, doc.centre[1] + u * rad * 0.85, doc.centre[2] + Math.sin(a) * s * rad];
          const dq = Math.hypot(c[0] - QUERY_POS[0], c[1] - QUERY_POS[1], c[2] - QUERY_POS[2]);
          if (dq < far) continue;
          if (taken.some((t) => Math.hypot(t[0] - c[0], t[1] - c[1], t[2] - c[2]) < minGap)) continue;
          p = c;
          break;
        }
        p ??= doc.centre;
        taken.push(p);
      }
      const tilt: V3 = [(r() - 0.5) * 0.5, (r() - 0.5) * 0.7, (r() - 0.5) * 0.4];
      chunks.push({ doc: d, idx, text, pos: p, vec: buildVector(p, codeOf(d), p, mix, frame, () => gauss(r), 0.05, RAG_SPREAD), tilt });
    });
  });
  // The question mixes the two topics it asks about.
  const qCode = codeOf(0).map((v, k) => (v + codeOf(1)[k]!) * 0.5);
  const qVec = buildVector(QUERY_POS, qCode, QUERY_POS, mix, frame, () => 0, 0, RAG_SPREAD);
  const all = [...chunks.map((c) => c.vec), qVec];
  centre(all);
  const ranked = chunks
    .map((c, i) => ({
      i,
      sim: cosine(qVec, c.vec),
      dist: Math.hypot(c.pos[0] - QUERY_POS[0], c.pos[1] - QUERY_POS[1], c.pos[2] - QUERY_POS[2]),
    }))
    .sort((a, b) => b.sim - a.sim);
  return { chunks, query: { pos: QUERY_POS, vec: qVec }, top: ranked.slice(0, TOP_K), ranked };
}

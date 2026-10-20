/**
 * Card text for hover / select cards. Hotspot texts come from meta.json (one source of truth for
 * the HTML 「場景重點」 list and the 3D cards); per-part extras (die blocks, transistor
 * architectures) are defined here. Glossary links point at /glossary/#<term>; the items link the
 * related chain chapter and the curriculum lessons this scene illustrates.
 */
import type { CardContent } from '../../core/types';
import json from './meta.json';

interface Extra {
  title: string;
  body: string;
  glossary?: string;
}

/** Related chain chapters shown as card links (site-relative, the card adds the base). */
const CHAIN: Record<string, { label: string; href: string }> = {
  wafer: { label: '產業鏈：晶圓代工與封裝', href: '/chain/foundry-packaging/' },
  die: { label: '產業鏈：晶圓代工與封裝', href: '/chain/foundry-packaging/' },
  yield: { label: '延伸：小晶片（chiplet）', href: '/glossary/#chiplet' },
  floorplan: { label: '產業鏈：AI 晶片', href: '/chain/ai-accelerators/' },
  'block-core': { label: '產業鏈：AI 晶片', href: '/chain/ai-accelerators/' },
  'block-phy': { label: '產業鏈：記憶體', href: '/chain/memory-storage/' },
  'block-io': { label: '產業鏈：網路與光通訊', href: '/chain/networking-optics/' },
  feol: { label: '產業鏈：半導體設備與材料', href: '/chain/semi-equipment-materials/' },
  bump: { label: '產業鏈：晶圓代工與封裝', href: '/chain/foundry-packaging/' },
  gate: { label: '延伸：製程節點', href: '/glossary/#process-node' },
  'power-network': { label: '產業鏈：晶圓代工與封裝', href: '/chain/foundry-packaging/' },
};

/** The curriculum lessons this scene illustrates (learn 107 / 211 / 306). */
const HOW_MADE = { label: '學習：晶片是怎麼做出來的？', href: '/learn/how-chips-are-made/' };
const NODES = { label: '學習：製程節點代表什麼', href: '/learn/semiconductor-process-nodes/' };
const EVOLUTION = { label: '學習：電晶體演進與背面供電', href: '/learn/transistor-evolution/' };
const LEARN: Record<string, { label: string; href: string }[]> = {
  wafer: [HOW_MADE],
  die: [HOW_MADE],
  yield: [HOW_MADE],
  floorplan: [HOW_MADE],
  'block-core': [HOW_MADE],
  'block-sram': [HOW_MADE],
  'block-phy': [HOW_MADE],
  'block-io': [HOW_MADE],
  feol: [HOW_MADE, NODES],
  beol: [HOW_MADE],
  bump: [HOW_MADE],
  gate: [NODES, EVOLUTION],
  channel: [EVOLUTION],
  'source-drain': [EVOLUTION],
  'gate-dielectric': [EVOLUTION],
  planar: [EVOLUTION],
  finfet: [EVOLUTION],
  gaa: [EVOLUTION],
  cfet: [EVOLUTION],
  'signal-wires': [EVOLUTION],
  'power-network': [EVOLUTION],
  'backside-contact': [EVOLUTION],
  'carrier-wafer': [EVOLUTION],
};

const EXTRA: Record<string, Extra> = {
  'block-core': {
    title: '運算核心',
    body: '成排重複的運算單元，每個核心裡最大的一塊是做矩陣乘法的單元（示意），AI 運算主要在這裡進行。',
    glossary: 'ai-accelerator',
  },
  'block-sram': {
    title: 'SRAM 快取',
    body: '做在晶粒上的高速記憶體，存放核心馬上要用的資料。速度最快，但每個位元占的面積大，容量有限。',
    glossary: 'sram',
  },
  'block-phy': {
    title: 'HBM 介面（PHY）',
    body: '沿著晶粒左右兩側邊緣排列的實體層電路，透過先進封裝裡的大量細線連到旁邊的 HBM 記憶體堆疊。',
    glossary: 'hbm',
  },
  'block-io': {
    title: '高速 I/O（SerDes）',
    body: '把平行資料轉成高速序列訊號的介面，用來連接其他晶片、交換器與網路。',
    glossary: 'serdes',
  },
  planar: {
    title: '平面式電晶體',
    body: '閘極只從上方一面控制矽表面的通道。通道縮短後，閘極越來越難把電流完全關掉，漏電成為微縮瓶頸。',
    glossary: 'transistor',
  },
  finfet: {
    title: 'FinFET',
    body: '通道立成鰭片，閘極從左、右、上三面包覆，比平面式更能抑制漏電，是 2010 年代以來先進製程的主流結構。',
    glossary: 'finfet',
  },
  gaa: {
    title: 'GAA 奈米片',
    body: '通道是數片水平堆疊的奈米片，閘極從四面完整包覆每一片；片寬可調整，在效能與功耗間取得平衡。',
    glossary: 'gaa',
  },
  cfet: {
    title: 'CFET',
    body: '把 nFET 疊在 pFET 上方、共用同一個閘極，同樣面積放進一對互補電晶體，仍在研發階段。',
    glossary: 'cfet',
  },
};

const HS = new Map(
  (json.hotspots ?? []).map((h) => [
    h.id,
    h as { id: string; label: string; detail?: string; glossary?: string },
  ]),
);

/** Card for a hotspot id (meta.json) or a per-part extra key. */
export function cardFor(id: string): CardContent {
  const e = EXTRA[id];
  const h = HS.get(id);
  const c: CardContent = { title: e?.title ?? h?.label ?? id };
  const body = e?.body ?? h?.detail;
  if (body) c.body = body;
  const g = e?.glossary ?? h?.glossary;
  if (g) {
    c.href = `/glossary/#${g}`;
    c.linkLabel = '名詞解釋 →';
  }
  const items = [CHAIN[id], ...(LEARN[id] ?? [])].filter((x) => !!x);
  if (items.length) c.items = items.map((x) => ({ label: x.label, href: x.href }));
  return c;
}

export const hotspotLabel = (id: string): string => HS.get(id)?.label ?? id;

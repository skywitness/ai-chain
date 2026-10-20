/**
 * cowos — hotspot card text (zh-TW) shared by both variants, plus a tiny hand-off so a hotspot
 * picked from the HTML list while the other variant is mounted can switch variant and then focus.
 * Bodies match meta.json `detail`; cards add companies and a link. No industry figures here:
 * quantities are qualitative or marked 「示意」.
 */
import type { CardItem, SceneContext } from '../../core/types';
import json from './meta.json';

export interface CardText {
  title: string;
  subtitle?: string;
  body: string;
  bodyS?: string;
  bodyL?: string;
  items?: CardItem[];
  href?: string;
  linkLabel?: string;
  /** CSS token name for the title swatch, e.g. 'seg-memory-storage'. */
  swatch?: string;
}

const detail = (id: string) => json.hotspots.find((h) => h.id === id)?.detail ?? '';
const co = (id: string, label: string, meta: string): CardItem => ({ label, meta, href: `/companies/${id}/` });

export const CARDS: Record<string, CardText> = {
  'logic-die': {
    title: '邏輯晶粒（GPU）',
    subtitle: 'Logic die・接近光罩極限',
    body: detail('logic-die'),
    items: [co('tsmc', '台積電（TSMC）', '晶圓製造與 CoWoS'), co('nvidia', '輝達（NVIDIA）', 'GPU 設計（例）')],
    href: '/chain/ai-accelerators/',
    linkLabel: 'AI 晶片環節 →',
    swatch: 'seg-ai-accelerators',
  },
  'hbm-stack': {
    title: 'HBM 記憶體堆疊',
    subtitle: 'High Bandwidth Memory',
    body: detail('hbm-stack'),
    items: [co('sk-hynix', 'SK 海力士', 'HBM'), co('samsung-electronics', '三星電子', 'HBM'), co('micron', '美光', 'HBM')],
    href: '/chain/memory-storage/',
    linkLabel: '記憶體環節 →',
    swatch: 'seg-memory-storage',
  },
  'micro-bumps': {
    title: '微凸塊（µbump）',
    subtitle: 'Micro-bump・銅柱＋焊錫',
    body: detail('micro-bumps'),
    href: '/glossary/#hybrid-bonding',
    linkLabel: '對照：混合鍵合 →',
  },
  interposer: {
    title: '中介層',
    subtitle: 'Interposer',
    body: detail('interposer'),
    bodyS:
      'CoWoS-S：整片矽中介層，用晶圓製程做出極細的銅線路，讓 GPU 與 HBM 以數千條連線並排溝通，再以矽穿孔（TSV）把電源與訊號往下導到 C4 凸塊。面積越大越貴、良率越難顧。',
    bodyL:
      'CoWoS-L：主體改用有機的重布線層（RDL）中介層，只在 GPU 與 GPU、GPU 與 HBM 的交界處嵌入局部矽互連（LSI）承接最密的連線，垂直方向改用銅柱（TIV）導通，因此能做出更大的封裝。',
    items: [co('tsmc', '台積電（TSMC）', 'CoWoS 中介層與晶片接合')],
    href: '/glossary/#interposer',
    linkLabel: '名詞：中介層 →',
    swatch: 'seg-foundry-packaging',
  },
  tsv: {
    title: '矽穿孔（TSV）',
    subtitle: 'Through-Silicon Via',
    body: detail('tsv'),
    href: '/glossary/#tsv',
    linkLabel: '名詞：TSV →',
  },
  'lsi-bridge': {
    title: 'LSI 局部矽橋',
    subtitle: 'CoWoS-L・Local Silicon Interconnect',
    body: detail('lsi-bridge'),
    href: '/glossary/#cowos-l',
    linkLabel: '名詞：CoWoS-L →',
    swatch: 'seg-foundry-packaging',
  },
  'c4-bumps': {
    title: 'C4 凸塊',
    subtitle: 'Controlled Collapse Chip Connection',
    body: detail('c4-bumps'),
    items: [co('ase', '日月光投控', '封測（後段）'), co('amkor', '艾克爾（Amkor）', '封測（後段）')],
    href: '/chain/foundry-packaging/',
    linkLabel: '代工封裝環節 →',
  },
  substrate: {
    title: 'ABF 載板與 BGA 錫球',
    subtitle: 'ABF substrate・FC-BGA',
    body: detail('substrate'),
    items: [co('ibiden', '揖斐電（Ibiden）', 'ABF 載板'), co('unimicron', '欣興', 'ABF 載板')],
    href: '/glossary/#abf',
    linkLabel: '名詞：ABF →',
  },
  'reticle-limit': {
    title: '光罩極限',
    subtitle: 'Reticle limit',
    body: detail('reticle-limit'),
    href: '/glossary/#reticle-limit',
    linkLabel: '名詞：光罩尺寸極限 →',
  },
  'hybrid-bonding': {
    title: 'SoIC 混合鍵合',
    subtitle: 'Hybrid bonding・Cu–Cu',
    body: detail('hybrid-bonding'),
    items: [co('tsmc', '台積電（TSMC）', 'SoIC')],
    // The planned deep lesson (/learn/advanced-packaging-deep/) does not exist yet; link a live page.
    href: '/chain/foundry-packaging/',
    linkLabel: '代工封裝環節 →',
    swatch: 'seg-foundry-packaging',
  },
};

/* ───── cross-variant hand-off ───── */

let pending: string | null = null;

/** Read (and clear) a hotspot to focus right after a variant switch. */
export function takePending(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Switch the scene to `variant` through the public command API, then focus `hotspot` there. */
export function switchVariant(ctx: SceneContext, variant: string, hotspot: string): void {
  pending = hotspot;
  ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'variant', variant } }));
}

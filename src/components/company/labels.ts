// zh-TW labels for company-profile enums (owner: pages-companies).
import { REGION_LABELS, TIER_LABELS } from '../../lib/collections';

export { REGION_LABELS, TIER_LABELS };

export const OWNERSHIP_LABELS: Record<string, string> = {
  listed: '上市公司',
  private: '未上市公司',
  subsidiary: '子公司',
  'state-owned': '國營事業',
  nonprofit: '非營利組織',
};

export const STATUS_LABELS: Record<string, string> = {
  active: '營運中',
  acquired: '已被收購',
  merged: '已合併',
  defunct: '已停止營運',
};

export const PROFILE_LABELS: Record<string, string> = { full: '完整檔案', compact: '精簡檔案' };

export const STAGE_LABELS: Record<string, string> = { startup: '新創', scaleup: '成長期', mature: '成熟期' };

export const PRODUCT_STATUS: Record<string, { label: string; tone: 'pos' | 'info' | 'warn' | 'neutral' }> = {
  shipping: { label: '出貨中', tone: 'pos' },
  sampling: { label: '送樣中', tone: 'info' },
  announced: { label: '已發表', tone: 'info' },
  roadmap: { label: '藍圖規劃', tone: 'warn' },
  eol: { label: '停產', tone: 'neutral' },
};

export const MATURITY_LABELS: Record<string, { label: string; step: number }> = {
  research: { label: '研究階段', step: 1 },
  pilot: { label: '試產／驗證', step: 2 },
  production: { label: '量產', step: 3 },
  mature: { label: '成熟', step: 4 },
};

export const TIMELINE_KIND: Record<string, string> = {
  founding: '成立',
  ipo: '上市',
  product: '產品',
  deal: '合約',
  funding: '募資',
  acquisition: '併購',
  policy: '政策',
  milestone: '里程碑',
  leadership: '人事',
  earnings: '財報',
  other: '其他',
};

export const RELATION_LABELS: Record<string, string> = {
  supplier: '供應商',
  customer: '客戶',
  partner: '合作夥伴',
  investor: '投資人',
  investee: '投資對象',
  competitor: '競爭者',
};
export const RELATION_ORDER = ['supplier', 'customer', 'partner', 'investor', 'investee', 'competitor'] as const;

export const COUNTRY_LABELS: Record<string, string> = {
  TW: '台灣', US: '美國', CN: '中國', HK: '香港', JP: '日本', KR: '韓國', NL: '荷蘭', DE: '德國',
  FR: '法國', GB: '英國', UK: '英國', CH: '瑞士', SE: '瑞典', DK: '丹麥', NO: '挪威', FI: '芬蘭',
  IE: '愛爾蘭', IT: '義大利', ES: '西班牙', BE: '比利時', AT: '奧地利', LU: '盧森堡', IL: '以色列',
  IN: '印度', CA: '加拿大', SG: '新加坡', MY: '馬來西亞', TH: '泰國', VN: '越南', ID: '印尼',
  PH: '菲律賓', AU: '澳洲', NZ: '紐西蘭', SA: '沙烏地阿拉伯', AE: '阿聯', QA: '卡達', BR: '巴西',
  MX: '墨西哥', PL: '波蘭', CZ: '捷克', HU: '匈牙利', IS: '冰島', PT: '葡萄牙', GR: '希臘',
  TR: '土耳其', ZA: '南非', KY: '開曼群島', BM: '百慕達', RU: '俄羅斯', UA: '烏克蘭', EE: '愛沙尼亞',
};
export function countryLabel(code: string): string {
  return COUNTRY_LABELS[code] ?? code;
}

export const EXCHANGE_LABELS: Record<string, string> = {
  TWSE: '台灣證交所',
  TPEx: '櫃買中心',
  NASDAQ: '那斯達克',
  NYSE: '紐約證交所',
  TSE: '東京證交所',
  KRX: '韓國證交所',
  KOSDAQ: '韓國 KOSDAQ',
  HKEX: '港交所',
  SSE: '上海證交所',
  SZSE: '深圳證交所',
  STAR: '上海科創板',
  'BSE-CN': '北京證交所',
  Euronext: '泛歐交易所',
  LSE: '倫敦證交所',
  XETRA: '德國 XETRA',
  SIX: '瑞士證交所',
  OMX: '北歐 Nasdaq',
  BIT: '義大利證交所',
  TASE: '特拉維夫證交所',
  NSE: '印度國家證交所',
  TSX: '多倫多證交所',
  ASX: '澳洲證交所',
  SGX: '新加坡交易所',
  Tadawul: '沙烏地證交所',
  OTC: '美國場外市場',
  other: '其他交易所',
};

/** 「2026 年 7 月」 for YYYY-MM, 「2026 年 7 月 16 日」 for full dates, 「2026 年」 for years. */
export function partialDateZh(d: string): string {
  const [y, m, day] = d.split('-');
  if (day) return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
  if (m) return `${y} 年 ${Number(m)} 月`;
  return `${y} 年`;
}

/** Hostname without www, for external links: tsmc.com */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

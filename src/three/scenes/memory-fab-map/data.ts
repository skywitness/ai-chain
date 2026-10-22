/**
 * memory-fab-map data: the page payload (docs/SCENES.md → custom（memory-fab-map）)
 * `{ asOf, fabs: [{ id, company, companyName, href, name, city, country, lat, lon, products, status,
 * capacityKwpm?, capacityStatus?, addKwpm?, capex?, timeline?, note? }] }`, its type guard, and the
 * normalisation the scene draws from.
 *
 *  - Product family (colour) = the fab's first listed product folded into four families:
 *    DRAM, HBM 與 HBM 封裝, NAND, HDD／SSD／其他. A filter shows every fab that makes the family
 *    (HBM wafers are DRAM, so the DRAM filter also shows HBM DRAM fabs) and re-tints it.
 *  - Status folds into what the column looks like: operating = solid; expanding = solid + a
 *    translucent extension (addKwpm); construction / planned = a hatched hollow ghost; delayed =
 *    ghost + a dashed warning ring.
 *  - Country names and company home countries below are geography, not industry statistics; every
 *    number shown comes from the data.
 */

export type Product = 'dram' | 'hbm' | 'hbm-packaging' | 'nand' | 'hdd' | 'ssd' | 'other';
export type FabStatus = 'operating' | 'expanding' | 'construction' | 'planned' | 'delayed';
export type CapacityStatus = 'actual' | 'estimate' | 'forecast';
export type Family = 'dram' | 'hbm' | 'nand' | 'other';

export interface FabDatum {
  id: string;
  company: string;
  companyName: string;
  href: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  products: Product[];
  status: FabStatus;
  capacityKwpm?: number | null;
  capacityStatus?: CapacityStatus | null;
  addKwpm?: number | null;
  capex?: string | null;
  timeline?: string | null;
  note?: string | null;
}
export interface MemoryFabData {
  asOf?: string;
  fabs: FabDatum[];
}

const PRODUCTS: readonly string[] = ['dram', 'hbm', 'hbm-packaging', 'nand', 'hdd', 'ssd', 'other'];
const STATUSES: readonly string[] = ['operating', 'expanding', 'construction', 'planned', 'delayed'];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const optNum = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';

export function isMemoryFabData(d: unknown): d is MemoryFabData {
  if (!isObj(d) || !Array.isArray(d['fabs']) || d['fabs'].length === 0) return false;
  return d['fabs'].every(
    (f) =>
      isObj(f) &&
      typeof f['id'] === 'string' &&
      typeof f['name'] === 'string' &&
      typeof f['company'] === 'string' &&
      optStr(f['companyName']) &&
      optStr(f['href']) &&
      optStr(f['city']) &&
      optStr(f['country']) &&
      Number.isFinite(f['lat']) &&
      Number.isFinite(f['lon']) &&
      Math.abs(f['lat'] as number) <= 90 &&
      Math.abs(f['lon'] as number) <= 180 &&
      Array.isArray(f['products']) &&
      f['products'].length > 0 &&
      f['products'].every((p) => typeof p === 'string' && PRODUCTS.includes(p)) &&
      typeof f['status'] === 'string' &&
      STATUSES.includes(f['status']) &&
      optNum(f['capacityKwpm']) &&
      optNum(f['addKwpm']) &&
      optStr(f['capacityStatus']) &&
      optStr(f['capex']) &&
      optStr(f['timeline']) &&
      optStr(f['note']),
  );
}

/* ───────── product families ───────── */

export interface FamilyInfo {
  label: string;
  /** Chip text (short). */
  chip: string;
  /** CSS token (without --) for swatches; the scene resolves the same token for 3D colours. */
  token: string;
  hotspot: string;
}
export const FAMILY_ORDER: readonly Family[] = ['dram', 'hbm', 'nand', 'other'];
export const FAMILY_INFO: Record<Family, FamilyInfo> = {
  dram: { label: 'DRAM', chip: 'DRAM', token: 'chart-1', hotspot: 'family-dram' },
  hbm: { label: 'HBM 與 HBM 封裝', chip: 'HBM', token: 'seg-memory-storage', hotspot: 'family-hbm' },
  nand: { label: 'NAND Flash', chip: 'NAND', token: 'chart-3', hotspot: 'family-nand' },
  other: { label: 'HDD、SSD 與其他', chip: 'HDD 與其他', token: 'chart-4', hotspot: 'family-other' },
};
export const familyOf = (p: Product): Family =>
  p === 'dram' ? 'dram' : p === 'hbm' || p === 'hbm-packaging' ? 'hbm' : p === 'nand' ? 'nand' : 'other';
export const PRODUCT_LABEL: Record<Product, string> = {
  dram: 'DRAM',
  hbm: 'HBM（DRAM 晶圓）',
  'hbm-packaging': 'HBM 堆疊與封裝',
  nand: 'NAND Flash',
  hdd: 'HDD',
  ssd: 'SSD',
  other: '其他',
};

/* ───────── status ───────── */

export type StatusFilter = 'all' | 'existing' | 'growth';
export interface StatusInfo {
  label: string;
  /** Has capacity in production today (a solid part). */
  existing: boolean;
  /** Part of the expansion pipeline (an extension or a ghost). */
  growth: boolean;
  note: string;
}
export const STATUS_INFO: Record<FabStatus, StatusInfo> = {
  operating: { label: '營運中', existing: true, growth: false, note: '已量產的廠區。' },
  expanding: { label: '擴產中', existing: true, growth: true, note: '已量產，並在擴充產能（半透明段）。' },
  construction: { label: '興建中', existing: false, growth: true, note: '新廠興建中，尚未量產。' },
  planned: { label: '規劃中', existing: false, growth: true, note: '已宣布、尚未動工或尚未完工。' },
  delayed: { label: '延後', existing: false, growth: true, note: '動工或量產時程已延後。' },
};
export const CAP_STATUS: Record<CapacityStatus, string> = { actual: '', estimate: '估計', forecast: '預測' };

/* ───────── geography ───────── */

export const COUNTRY_NAME: Record<string, string> = {
  KR: '韓國',
  TW: '台灣',
  JP: '日本',
  CN: '中國',
  US: '美國',
  SG: '新加坡',
  MY: '馬來西亞',
  TH: '泰國',
  PH: '菲律賓',
  VN: '越南',
  IN: '印度',
  IL: '以色列',
  IE: '愛爾蘭',
  DE: '德國',
  FR: '法國',
  IT: '義大利',
  GB: '英國',
  MX: '墨西哥',
  BR: '巴西',
};
export const countryName = (c: string) => COUNTRY_NAME[c] ?? c;

/** Company headquarters country (roster ids): splits 中國自主 from foreign-owned fabs in China. */
const HOME: Record<string, string> = {
  'sk-hynix': 'KR',
  'samsung-electronics': 'KR',
  micron: 'US',
  kioxia: 'JP',
  sandisk: 'US',
  'western-digital': 'US',
  seagate: 'US',
  solidigm: 'US',
  toshiba: 'JP',
  cxmt: 'CN',
  ymtc: 'CN',
  gigadevice: 'CN',
  longsys: 'CN',
  'nanya-tech': 'TW',
  winbond: 'TW',
  macronix: 'TW',
};
export const homeOf = (company: string, fallback: string) => HOME[company] ?? fallback;

/**
 * Reference cities shown (muted) in close-ups, for orientation only. Cities right next to a fab
 * cluster (首爾, 台北) are left out: the spread fan covers them and their name would read as a fab.
 */
export const REF_CITIES: readonly { name: string; lat: number; lon: number }[] = [
  { name: '東京', lat: 35.68, lon: 139.69 },
  { name: '上海', lat: 31.23, lon: 121.47 },
  { name: '北京', lat: 39.9, lon: 116.4 },
  { name: '大阪', lat: 34.69, lon: 135.5 },
  { name: '釜山', lat: 35.18, lon: 129.08 },
  { name: '芝加哥', lat: 41.88, lon: -87.63 },
  { name: '紐約', lat: 40.71, lon: -74.0 },
  { name: '西雅圖', lat: 47.61, lon: -122.33 },
];

/* ───────── normalised fab ───────── */

export interface Fab {
  index: number;
  id: string;
  company: string;
  companyName: string;
  href: string;
  name: string;
  /** Short map label: the name, prefixed with the city when the name has no CJK (「利川 M14」). */
  short: string;
  city: string;
  country: string;
  domestic: boolean;
  lat: number;
  lon: number;
  products: Product[];
  families: Set<Family>;
  /** A wafer fab (DRAM, HBM DRAM or NAND lines); packaging, test and HDD plants have no wafer starts. */
  wafer: boolean;
  primary: Family;
  status: FabStatus;
  /** Current monthly capacity (thousand 12-inch wafers per month), if known. */
  cap: number | null;
  capStatus: CapacityStatus | null;
  add: number | null;
  capex: string | null;
  timeline: string | null;
  note: string | null;
}

const CJK = /[㐀-鿿]/;
export function normalise(d: MemoryFabData | null): Fab[] {
  const list = d?.fabs ?? [];
  return list.map((f, index) => {
    const products = f.products.filter((p) => PRODUCTS.includes(p));
    const country = (f.country || '').toUpperCase();
    const city = f.city || '';
    const name = f.name || f.id;
    const short = CJK.test(name) || !city ? name : `${city} ${name}`;
    const cap = typeof f.capacityKwpm === 'number' && f.capacityKwpm > 0 ? f.capacityKwpm : null;
    const add = typeof f.addKwpm === 'number' && f.addKwpm > 0 ? f.addKwpm : null;
    return {
      index,
      id: f.id,
      company: f.company,
      companyName: f.companyName || f.company,
      href: f.href || `/companies/${f.company}/`,
      name,
      short,
      city,
      country,
      domestic: homeOf(f.company, country) === country,
      lat: f.lat,
      lon: f.lon,
      products,
      families: new Set(products.map(familyOf)),
      wafer: products.some((p) => p === 'dram' || p === 'hbm' || p === 'nand'),
      primary: familyOf(products[0] ?? 'other'),
      status: f.status,
      cap: STATUS_INFO[f.status].existing ? cap : null,
      capStatus: f.capacityStatus ?? null,
      // A new fab's planned capacity may come as capacityKwpm (no current output) or as addKwpm.
      add: STATUS_INFO[f.status].existing ? add : (add ?? cap),
      capex: f.capex || null,
      timeline: f.timeline || null,
      note: f.note || null,
    };
  });
}

/* ───────── formatting ───────── */

const nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
/** 「150 千片/月」 */
export const fmtK = (v: number) => `${nf.format(v)} 千片/月`;
export const fmtNum = (v: number) => nf.format(v);

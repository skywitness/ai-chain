/**
 * cloud-globe data: the page payload `{ campuses: [{ name, lat, lon, operator, mw, status }] }`
 * (docs/SCENES.md), its type guard, and the normalisation the scene draws from.
 *
 *  - Operator type (超大規模雲／新雲／主權 AI／AI 實驗室／託管與開發商) is derived from the `operator`
 *    string: the known keyword that appears FIRST wins (the longest one on a tie), so "G42／OpenAI"
 *    is sovereign, "OpenAI／Oracle" is lab-led and 「軟銀集團」 is not 「軟銀（日本電信）」. Pages pass
 *    the roster's Chinese names (微軟、亞馬遜、甲骨文…), demos may pass English ones.
 *  - Campuses named Stargate (OpenAI's programme) count as lab-led whoever builds them, unless the
 *    operator is a sovereign partner (Stargate UAE stays 主權 AI).
 *  - An optional `type` field overrides the derived type.
 *  - `status` accepts English or zh-TW wording and folds into operating / construction / planned.
 *  - An optional `mwNow` (power already online, MW) sets the solid share of the pillar; without it
 *    the share is the status default (示意) — see proposals/scene-cloud-globe.yaml → campus-mw-now.
 *  - HQ and city coordinates below are geography, not industry statistics.
 */

export type CampusType = 'hyperscaler' | 'neocloud' | 'sovereign' | 'lab' | 'colo' | 'other';
export type CampusStatus = 'operating' | 'construction' | 'planned';
export type Shape = 'round' | 'square' | 'triangle' | 'hex' | 'diamond' | 'pentagon';

export interface CampusDatum {
  name: string;
  lat: number;
  lon: number;
  operator?: string;
  mw?: number | null;
  /** Power already online (MW), optional. */
  mwNow?: number | null;
  status?: string;
  type?: string;
}
export interface CloudData {
  campuses: CampusDatum[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

export function isCloudData(d: unknown): d is CloudData {
  if (!isObj(d) || !Array.isArray(d['campuses']) || d['campuses'].length === 0) return false;
  const okCampus = (c: unknown) =>
    isObj(c) &&
    typeof c['name'] === 'string' &&
    Number.isFinite(c['lat']) &&
    Number.isFinite(c['lon']) &&
    Math.abs(c['lat'] as number) <= 90 &&
    Math.abs(c['lon'] as number) <= 180 &&
    (c['operator'] === undefined || typeof c['operator'] === 'string') &&
    (c['mw'] === undefined || c['mw'] === null || Number.isFinite(c['mw'])) &&
    (c['mwNow'] === undefined || c['mwNow'] === null || Number.isFinite(c['mwNow'])) &&
    (c['status'] === undefined || typeof c['status'] === 'string');
  return d['campuses'].every(okCampus);
}

/* ───────── operators ───────── */

interface OperatorInfo {
  keys: readonly string[];
  type: CampusType;
  short: string;
  /** Headquarters [lat, lon] (for the ownership arcs). */
  hq?: readonly [number, number];
}

const OPERATORS: readonly OperatorInfo[] = [
  { keys: ['Microsoft', '微軟', 'Azure'], type: 'hyperscaler', short: '微軟', hq: [47.64, -122.13] },
  { keys: ['Amazon', 'AWS', '亞馬遜'], type: 'hyperscaler', short: '亞馬遜', hq: [47.62, -122.34] },
  { keys: ['Google', 'Alphabet', '谷歌'], type: 'hyperscaler', short: 'Google', hq: [37.42, -122.08] },
  { keys: ['Meta'], type: 'hyperscaler', short: 'Meta', hq: [37.48, -122.15] },
  { keys: ['Oracle', '甲骨文'], type: 'hyperscaler', short: '甲骨文', hq: [30.24, -97.72] },
  { keys: ['Alibaba', '阿里'], type: 'hyperscaler', short: '阿里雲', hq: [30.27, 120.15] },
  { keys: ['Tencent', '騰訊'], type: 'hyperscaler', short: '騰訊雲', hq: [22.54, 113.93] },
  { keys: ['Baidu', '百度'], type: 'hyperscaler', short: '百度', hq: [40.05, 116.3] },
  { keys: ['Huawei', '華為'], type: 'hyperscaler', short: '華為雲', hq: [22.65, 114.06] },
  { keys: ['ByteDance', '字節', '火山引擎', 'Volcano Engine'], type: 'hyperscaler', short: '字節跳動', hq: [39.98, 116.31] },
  { keys: ['CoreWeave'], type: 'neocloud', short: 'CoreWeave', hq: [40.79, -74.31] },
  { keys: ['Nebius'], type: 'neocloud', short: 'Nebius', hq: [52.37, 4.9] },
  { keys: ['Crusoe'], type: 'neocloud', short: 'Crusoe', hq: [39.74, -104.99] },
  { keys: ['Lambda'], type: 'neocloud', short: 'Lambda' },
  { keys: ['Nscale'], type: 'neocloud', short: 'Nscale', hq: [51.51, -0.13] },
  { keys: ['Fluidstack'], type: 'neocloud', short: 'Fluidstack' },
  { keys: ['Together AI'], type: 'neocloud', short: 'Together AI', hq: [37.77, -122.42] },
  { keys: ['IREN'], type: 'neocloud', short: 'IREN', hq: [-33.87, 151.21] },
  { keys: ['Firmus'], type: 'neocloud', short: 'Firmus' },
  { keys: ['OpenAI', 'Stargate', '星際之門'], type: 'lab', short: 'OpenAI' },
  { keys: ['xAI', 'SpaceX'], type: 'lab', short: 'xAI' },
  { keys: ['Anthropic'], type: 'lab', short: 'Anthropic' },
  { keys: ['Humain'], type: 'sovereign', short: 'Humain' },
  { keys: ['G42', 'Core42', 'Khazna', 'MGX'], type: 'sovereign', short: 'G42' },
  { keys: ['Mistral'], type: 'sovereign', short: 'Mistral' },
  { keys: ['Telekom', '德國電信'], type: 'sovereign', short: '德國電信' },
  { keys: ['SoftBank Corp', '軟銀', '軟銀（日本電信）'], type: 'sovereign', short: '軟銀' },
  { keys: ['SK Telecom', 'SK 電訊', 'SKT'], type: 'sovereign', short: 'SK 電訊' },
  { keys: ['Sakura', '櫻花'], type: 'sovereign', short: '櫻花網路' },
  { keys: ['Reliance', 'Jio', '信實'], type: 'sovereign', short: 'Reliance' },
  { keys: ['Yotta', 'IndiaAI'], type: 'sovereign', short: 'Yotta' },
  { keys: ['NCHC', '國網', '國科會'], type: 'sovereign', short: '國網中心' },
  { keys: ['Chunghwa', '中華電信'], type: 'sovereign', short: '中華電信' },
  { keys: ['EuroHPC', 'Gigafactory', '主權'], type: 'sovereign', short: '主權 AI' },
  { keys: ['QTS'], type: 'colo', short: 'QTS' },
  { keys: ['Equinix', '易昆尼克斯'], type: 'colo', short: 'Equinix' },
  { keys: ['Digital Realty'], type: 'colo', short: 'Digital Realty' },
  { keys: ['DayOne'], type: 'colo', short: 'DayOne' },
  { keys: ['VNET', '世紀互聯'], type: 'colo', short: '世紀互聯' },
  { keys: ['GDS', '萬國數據'], type: 'colo', short: '萬國數據' },
  { keys: ['Applied Digital'], type: 'colo', short: 'Applied Digital' },
  { keys: ['Vantage'], type: 'colo', short: 'Vantage' },
  { keys: ['Aligned Data'], type: 'colo', short: 'Aligned' },
  { keys: ['CyrusOne'], type: 'colo', short: 'CyrusOne' },
  { keys: ['AirTrunk'], type: 'colo', short: 'AirTrunk' },
  { keys: ['Princeton Digital'], type: 'colo', short: 'PDG' },
  { keys: ['Chindata', '秦淮'], type: 'colo', short: '秦淮數據' },
  { keys: ['SoftBank Group', '軟銀集團', 'SB Energy'], type: 'colo', short: '軟銀集團' },
];

/** The operator whose keyword appears first in `text` (longest keyword on a tie; Latin case-insensitive). */
export function matchOperator(text: string): OperatorInfo | null {
  const hay = text.toLowerCase();
  let best: OperatorInfo | null = null;
  let at = Infinity;
  let len = 0;
  for (const op of OPERATORS)
    for (const k of op.keys) {
      const i = hay.indexOf(k.toLowerCase());
      if (i >= 0 && (i < at || (i === at && k.length > len))) {
        at = i;
        len = k.length;
        best = op;
      }
    }
  return best;
}

const TYPE_IDS: readonly CampusType[] = ['hyperscaler', 'neocloud', 'sovereign', 'lab', 'colo', 'other'];

/* ───────── display tables ───────── */

export interface TypeInfo {
  label: string;
  shapeName: string;
  shape: Shape;
  /** Hotspot id in meta.json. */
  hotspot: string;
  href: string;
  linkLabel: string;
}
export const TYPE_INFO: Record<CampusType, TypeInfo> = {
  hyperscaler: { label: '超大規模雲', shapeName: '圓柱', shape: 'round', hotspot: 'hyperscaler', href: '/glossary/#hyperscaler', linkLabel: '認識超大規模雲 →' },
  neocloud: { label: '新雲', shapeName: '方柱', shape: 'square', hotspot: 'neocloud', href: '/glossary/#neocloud', linkLabel: '認識新雲 →' },
  sovereign: { label: '主權 AI', shapeName: '三角柱', shape: 'triangle', hotspot: 'sovereign', href: '/glossary/#sovereign-ai', linkLabel: '認識主權 AI →' },
  lab: { label: 'AI 實驗室', shapeName: '六角柱', shape: 'hex', hotspot: 'ai-lab', href: '/chain/foundation-models/', linkLabel: '認識基礎模型實驗室 →' },
  colo: { label: '託管與開發商', shapeName: '菱形柱', shape: 'diamond', hotspot: 'colo', href: '/glossary/#colocation', linkLabel: '認識主機代管 →' },
  other: { label: '其他業者', shapeName: '五角柱', shape: 'pentagon', hotspot: 'ai-campus', href: '/chain/datacenter-infra/', linkLabel: '認識資料中心 →' },
};
export const TYPE_ORDER: readonly CampusType[] = TYPE_IDS;

export interface StatusInfo {
  label: string;
  note: string;
  /** Share drawn solid when the data has no `mwNow` (示意); the rest is a translucent "ghost". */
  fill: number;
  /** CSS token (also the palette key used in 3D). */
  token: 'c-pos' | 'scene-power' | 'scene-optic';
}
export const STATUS_INFO: Record<CampusStatus, StatusInfo> = {
  operating: { label: '營運中', note: '已有算力上線運轉，可能仍在分期擴建。', fill: 1, token: 'c-pos' },
  construction: { label: '興建中', note: '已動工，機房與電力分期上線；柱子半透明的部分代表尚未上線。', fill: 0.45, token: 'scene-power' },
  planned: { label: '規劃中', note: '已宣布或簽約，仍待動工、併網或取得許可。', fill: 0, token: 'scene-optic' },
};
export const STATUS_ORDER: readonly CampusStatus[] = ['operating', 'construction', 'planned'];

export function normStatus(s: string | undefined): CampusStatus {
  const t = (s ?? '').toLowerCase();
  if (/operat|online|live|active|running|營運|運轉|啟用|上線/.test(t)) return 'operating';
  if (/construct|build|progress|興建|建設|施工|擴建/.test(t)) return 'construction';
  return 'planned';
}

/* ───────── normalised campus ───────── */

export interface Campus {
  index: number;
  name: string;
  /** Short name for 3D labels (no parenthetical place, no trailing 「園區」). */
  short: string;
  lat: number;
  lon: number;
  operator: string;
  operatorShort: string;
  mw: number | null;
  /** Power already online (MW) when the data says so, else null. */
  mwNow: number | null;
  status: CampusStatus;
  type: CampusType;
  hq: readonly [number, number] | null;
  /** Programme the campus belongs to (e.g. OpenAI's Stargate), when the name says so. */
  project: string | null;
}

const STARGATE = /stargate|星際之門/i;

export function normalise(d: CloudData): Campus[] {
  return d.campuses.map((c, index) => {
    const operator = (c.operator ?? '').trim() || '未公開';
    const op = matchOperator(operator);
    const forced = TYPE_IDS.find((t) => t === c.type);
    const stargate = STARGATE.test(`${c.name} ${operator}`);
    const derived: CampusType = op?.type ?? 'other';
    const type: CampusType = forced ?? (stargate && derived !== 'sovereign' ? 'lab' : derived);
    const bare = c.name.replace(/[（(][^）)]*[）)]/g, '').trim() || c.name;
    // 3D labels stay short: drop a trailing 「園區／資料中心／算力／中心」 (the card keeps the full name).
    const short = bare.replace(/\s*(?:AI\s*)?(?:資料中心|園區|算力|中心)$/, '').trim() || bare;
    const mw = typeof c.mw === 'number' && c.mw > 0 ? c.mw : null;
    const mwNow = typeof c.mwNow === 'number' && c.mwNow >= 0 ? (mw ? Math.min(c.mwNow, mw) : c.mwNow) : null;
    return {
      index,
      name: c.name,
      short,
      lat: c.lat,
      lon: c.lon,
      operator,
      operatorShort: op?.short ?? operator,
      mw,
      mwNow,
      status: normStatus(c.status),
      type,
      hq: op?.hq ?? null,
      project: stargate ? 'OpenAI Stargate 計畫' : null,
    };
  });
}

/* ───────── formatting ───────── */

const nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 });
export function fmtMW(mw: number): string {
  return mw >= 1000 ? `${nf.format(mw / 1000)} GW` : `${nf.format(Math.round(mw))} MW`;
}
export function fmtLatLon(lat: number, lon: number): string {
  const a = `${lat >= 0 ? '北緯' : '南緯'} ${Math.abs(lat).toFixed(1)}°`;
  const b = `${lon >= 0 ? '東經' : '西經'} ${Math.abs(lon).toFixed(1)}°`;
  return `${a}、${b}`;
}

/* ───────── geography (not statistics) ───────── */

export interface Place {
  name: string;
  lat: number;
  lon: number;
  tw?: boolean;
}
/**
 * Where requests come from in the 「租用算力」 step (illustrative): Asia-Pacific cities, so every
 * route to a North American campus crosses the visible North Pacific instead of the far side.
 */
export const USER_CITIES: readonly Place[] = [
  { name: '台北', lat: 25.03, lon: 121.56, tw: true },
  { name: '東京', lat: 35.68, lon: 139.69 },
  { name: '首爾', lat: 37.57, lon: 126.98 },
];
/** Orientation tags. */
export const REGIONS: readonly Place[] = [
  { name: '北美', lat: 55, lon: -104 },
  { name: '南美', lat: -14, lon: -58 },
  { name: '歐洲', lat: 53, lon: 18 },
  { name: '非洲', lat: 4, lon: 21 },
  { name: '中東', lat: 31, lon: 44 },
  { name: '南亞', lat: 23, lon: 79 },
  { name: '東亞', lat: 39, lon: 106 },
  { name: '大洋洲', lat: -25, lon: 134 },
];
export const TAIWAN: Place = { name: '台灣', lat: 23.7, lon: 120.95, tw: true };

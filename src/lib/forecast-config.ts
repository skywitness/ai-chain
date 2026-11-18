/**
 * Per-company configuration of the financial-model pages (財報模型). One entry per company in
 * FORECAST_COMPANIES (src/schemas/forecast.ts); a page is built only when the company's files exist
 * (hasForecast in src/lib/forecast-data.ts), so an entry can be written before its model.
 *
 *   topic 'memory'   → files in src/data/memory/forecast/, page /memory/<id>/ (群聯、美光; src/pages/memory/[company].astro)
 *   topic 'forecast' → files in src/data/forecast/ (+ optional <id>-drivers.yaml), page /forecast/<id>/
 *                      (src/pages/forecast/[company].astro; company sections in src/components/forecast/<id>/)
 *
 * The phison and micron entries reproduce the wording of their pages exactly; change them only together with
 * those pages. Text fields are zh-TW (docs/STYLE-zh-TW.md) and must not read as investment advice.
 */
import type { ForecastCompany } from '../schemas/forecast';
import { SEGMENT_IDS, type SegmentId } from '../schemas/common';

export type FcCompany = ForecastCompany;
export type FcTopic = 'memory' | 'forecast';

export interface FcMeta {
  id: FcCompany;
  topic: FcTopic;
  /** site path of the page: '/memory/phison/', '/forecast/tsmc/' */
  path: string;
  /** primary chain segment (hub order and the Pagefind 環節 filter); `order` breaks ties inside a segment */
  segment: SegmentId;
  order: number;
  /** 「群聯」 */
  name: string;
  /** first mention: 「群聯電子（Phison，8299）」 */
  nameFull: string;
  /** page title without the site suffix and H1 */
  title: string;
  h1: string;
  /** one-line promise under the H1 */
  promise: string;
  kicker: string;
  /** one or two sentences for the link cards (hub, /memory/, /companies/<id>/) */
  blurb: string;
  currency: 'TWD' | 'USD';
  epsUnit: '元' | '美元';
  /**
   * forecast quarters on the 預測摘要 cards (the first n of the base scenario), followed by every full-year forecast;
   * the latest reported quarter gets its own card first when the model checks a past forecast against it
   * (summaryPeriodsOf)
   */
  summaryQuarters: number;
  /** first quarter shown in the long-history charts and driver tables */
  historyFrom: string;
  /** market-prices.yaml series the page plots and cites (memory prices; usually none outside the memory topic) */
  priceSeries: readonly string[];
  /** labels of the targets, with their accounting basis */
  gmLabel: string;
  epsLabel: string;
  oiLabel: string;
  niLabel: string;
  /** the model targets non-GAAP gross margin and EPS (美光); default GAAP／TIFRS */
  nonGaap?: boolean | undefined;
  /** fiscal quarters 「FY2027Q1」: the calendar month the fiscal year starts in (美光 9, NVIDIA 2) */
  fyStartMonth?: number | undefined;
  /** what the one-step backtest takes as known, and the matching labels of the robustness variants */
  backtest: {
    /** 「當季實際的合約價與月營收」 (TrainTestBar) */
    known: string;
    /** shorter form in the backtest chart subtitles (default: known) */
    knownShort?: string | undefined;
    /** 「價格已知時」: what the one-step test measures */
    when: string;
    /** metric variant *ExAnte: 「事前：改用季初預測價、不知當季月營收」 */
    exAnte: string;
    /** the *-ex-ante candidate as a backtest line, and its short column label */
    exAnteLine: string;
    exAnteShort: string;
    /** metric variant *Dynamic, {from} = the end of the training window */
    dynamic: string;
  };
  /** backtest errors named on the link cards (default 營收 and 毛利率; 群聯 only 毛利率) */
  headline?: ReadonlyArray<'revenue' | 'grossMargin' | 'eps'> | undefined;
  /** the inputs the hero notice names: 「公開財報、TrendForce 合約價與假設的價格路徑」 */
  noticeInputs: string;
  /** /forecast/ pages: H2 of 一分鐘看懂, lede of 驅動因子, start of the meta description */
  basicsTitle?: string | undefined;
  driversLede?: string | undefined;
  descLead?: string | undefined;
  /** /forecast/ pages: basis of the company's own guidance shown next to the model (「（非 GAAP 毛利率與 EPS）」) */
  guidanceBasis?: string | undefined;
}

const MEMORY_BACKTEST = {
  exAnte: '事前：改用季初預測價、不知當季月營收',
  exAnteLine: '同一模型改用季初預測價',
  exAnteShort: '季初預測價',
  when: '價格已知時',
};
const DRIVER_BACKTEST = {
  exAnte: '事前：驅動因子也要事前預測',
  exAnteLine: '同一模型改用事前推估的驅動因子',
  exAnteShort: '事前推估',
  when: '驅動因子已知時',
  dynamic: '連續預測：從 {from} 出發往後推、不用新財報',
};

export const FC_META: Record<FcCompany, FcMeta> = {
  phison: {
    id: 'phison',
    topic: 'memory',
    path: '/memory/phison/',
    segment: 'memory-storage',
    order: 1,
    name: '群聯',
    nameFull: '群聯電子（Phison，8299）',
    title: '群聯財報模型',
    h1: '群聯財報模型：用 NAND 價格推估成本、毛利與獲利',
    promise: '把 NAND Flash 合約價、群聯的進貨與庫存天數串起來，看「低價買進、高價賣出」如何推高毛利率，以及這個效果何時淡化。',
    kicker: '記憶體與儲存 · 財報模型 · NAND 控制晶片與模組',
    blurb: '用 NAND 合約價推估群聯的進貨成本，對照庫存何時賣出，說明低價庫存如何推高毛利率、何時淡化。',
    currency: 'TWD',
    epsUnit: '元',
    summaryQuarters: 1,
    historyFrom: '2019Q1',
    priceSeries: ['nand-contract-qoq'],
    gmLabel: '毛利率',
    epsLabel: 'EPS（基本）',
    oiLabel: '營業利益',
    niLabel: '淨利（歸屬母公司）',
    backtest: {
      ...MEMORY_BACKTEST,
      known: '當季實際的合約價與月營收',
      dynamic: '連續預測：從 {from} 出發推 6 季、不用新財報',
    },
    headline: ['grossMargin'],
    noticeInputs: '公開財報、TrendForce 合約價與假設的價格路徑',
  },
  micron: {
    id: 'micron',
    topic: 'memory',
    path: '/memory/micron/',
    segment: 'memory-storage',
    order: 2,
    name: '美光',
    nameFull: '美光（Micron Technology）',
    title: '美光財報模型',
    h1: '美光財報模型：價格、生產成本與獲利',
    promise: '把 DRAM、NAND 合約價換算成美光的售價，再拆解每位元成本、折舊與 HBM，看價格與成本如何決定美光的毛利率與獲利。',
    kicker: '記憶體與儲存 · 財報模型 · DRAM、HBM 與 NAND 原廠',
    blurb: '把 DRAM、NAND 合約價換算成美光售價，再拆解每位元成本、折舊與 HBM，並和美光自己的財測比較。',
    currency: 'USD',
    epsUnit: '美元',
    summaryQuarters: 2,
    historyFrom: 'FY2019Q1',
    priceSeries: ['dram-contract-qoq', 'dram-incl-hbm-contract-qoq', 'nand-contract-qoq'],
    gmLabel: '毛利率（非 GAAP）',
    epsLabel: 'EPS（非 GAAP）',
    oiLabel: '營業利益（GAAP）',
    niLabel: '淨利（GAAP）',
    nonGaap: true,
    fyStartMonth: 9,
    backtest: {
      ...MEMORY_BACKTEST,
      known: '當季實際的合約價與美光公布的位元出貨',
      knownShort: '當季實際的合約價與位元出貨',
      dynamic: '連續預測：從 {from} 出發推 8 季、不用實際值重設',
    },
    noticeInputs: '公開財報、TrendForce 合約價與假設的價格路徑',
    guidanceBasis: '（非 GAAP 毛利率與 EPS）',
  },
  tsmc: {
    id: 'tsmc',
    topic: 'forecast',
    path: '/forecast/tsmc/',
    segment: 'foundry-packaging',
    order: 1,
    name: '台積電',
    nameFull: '台積電（TSMC，2330）',
    title: '台積電財報模型',
    h1: '台積電財報模型：製程組合、匯率與毛利率',
    promise: '把美元營收、製程與平台組合、匯率和新製程稀釋串起來，看台積電的營收與毛利率怎麼跟著 AI 需求變動，並和公司自己的財測比較。',
    kicker: '晶圓代工與先進封裝 · 財報模型 · 先進製程與 CoWoS',
    blurb: '用製程與平台組合、匯率、折舊與新製程稀釋拆解台積電的營收與毛利率，並和台積電每季的財測比較。',
    currency: 'TWD',
    epsUnit: '元',
    summaryQuarters: 2,
    historyFrom: '2019Q1',
    priceSeries: [],
    gmLabel: '毛利率',
    epsLabel: 'EPS（稀釋）',
    oiLabel: '營業利益',
    niLabel: '淨利（歸屬母公司）',
    backtest: { ...DRIVER_BACKTEST, known: '當季實際的匯率與驅動因子' },
    noticeInputs: '公開財報、法說會財測與假設的情境',
    basicsTitle: '台積電怎麼賺錢，為什麼要看製程組合與匯率',
    driversLede: '台積電每季公布製程別與平台別的營收比重、晶圓出貨與匯率；下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計與財測另外標示。',
    descLead: '以製程與平台組合、匯率與新製程稀釋拆解台積電的營收與毛利率',
  },
  mediatek: {
    id: 'mediatek',
    topic: 'forecast',
    path: '/forecast/mediatek/',
    segment: 'ai-accelerators',
    order: 2,
    name: '聯發科',
    nameFull: '聯發科（MediaTek，2454）',
    title: '聯發科財報模型',
    h1: '聯發科財報模型：財測、手機晶片與資料中心 ASIC',
    promise: '從聯發科自己的財測出發，對照過去財測與實際的落差、匯率與手機出貨，看營收與毛利率怎麼變動，以及資料中心 ASIC 放量對毛利率的影響。',
    kicker: 'AI 晶片與加速器 · 財報模型 · 手機晶片與 ASIC',
    blurb: '以聯發科的季度財測為起點，加上歷史偏差與匯率，並用手機出貨與產品線拆解檢驗；2027 年加入資料中心 ASIC 的情境。',
    currency: 'TWD',
    epsUnit: '元',
    summaryQuarters: 1,
    historyFrom: '2019Q1',
    priceSeries: [],
    gmLabel: '毛利率',
    epsLabel: 'EPS（基本）',
    oiLabel: '營業利益',
    niLabel: '淨利（歸屬母公司）',
    backtest: {
      ...DRIVER_BACKTEST,
      known: '季初公布的財測與當季實際匯率',
      when: '財測與匯率已知時',
      exAnte: '事前：匯率改用財測假設、營業費用改用財測推算',
      exAnteLine: '同一模型改用財測的匯率假設',
      exAnteShort: '財測匯率',
    },
    noticeInputs: '公開財報、法說會財測與假設的情境',
    basicsTitle: '聯發科怎麼賺錢，為什麼財測是最好的起點',
    driversLede: '聯發科每季公布產品線營收比重與下一季財測；手機出貨是研究機構的估計。下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計與財測另外標示。',
    descLead: '以聯發科的財測、歷史偏差與匯率推估營收與毛利率，並以手機出貨與產品線拆解對照',
  },
  nvidia: {
    id: 'nvidia',
    topic: 'forecast',
    path: '/forecast/nvidia/',
    segment: 'ai-accelerators',
    order: 1,
    name: '輝達',
    nameFull: '輝達（NVIDIA）',
    title: '輝達財報模型',
    h1: '輝達財報模型：資料中心需求、雲端資本支出與毛利率',
    promise: '把雲端業者的資本支出、資料中心營收與毛利率串起來，看輝達的營收與獲利怎麼跟著 AI 基礎設施投資變動，並和公司自己的財測比較。',
    kicker: 'AI 晶片與加速器 · 財報模型 · GPU 與資料中心',
    blurb: '把資料中心營收看成五大雲端業者資本支出的一個比例，毛利率從扣除存貨提列前的核心毛利率推算，並和輝達每季的財測比較。',
    currency: 'USD',
    epsUnit: '美元',
    summaryQuarters: 2,
    historyFrom: 'FY2020Q1',
    priceSeries: [],
    gmLabel: '毛利率（GAAP）',
    epsLabel: 'EPS（GAAP 稀釋）',
    oiLabel: '營業利益（GAAP）',
    niLabel: '淨利（GAAP）',
    fyStartMonth: 2,
    // Checked 2026-11-18 against nvidia-inputs.yaml／nvidia-model.json: fiscal year ends late January (fyStartMonth 2,
    // FY2027Q3 = 2026-07-27…10-25); eps is GAAP diluted; the model targets GAAP gross margin; the one-step backtest
    // takes the quarter's actual hyperscaler capex and provisions as known (capex-share); forecasts FY2027Q4–FY2028Q4.
    backtest: {
      ...DRIVER_BACKTEST,
      known: '當季實際的雲端業者資本支出與存貨提列',
      knownShort: '當季實際的資本支出與提列',
      when: '資本支出與提列已知時',
      exAnte: '事前：資本支出與提列也要事前推估',
      exAnteLine: '同一模型改用事前推估的資本支出與提列',
    },
    noticeInputs: '公開財報、雲端業者資本支出、法說會財測與假設的情境',
    basicsTitle: '輝達怎麼賺錢，為什麼要看雲端業者的資本支出',
    driversLede: '輝達的資料中心營收跟著雲端業者與 AI 雲的投資走，毛利率則看產品轉換、記憶體成本與存貨提列；下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計、預測與財測另外標示。',
    descLead: '以五大雲端業者資本支出、資料中心營收占比與核心毛利率推估輝達的營收與毛利率',
  },
  spacex: {
    id: 'spacex',
    topic: 'forecast',
    path: '/forecast/spacex/',
    segment: 'foundation-models',
    order: 1,
    name: 'SpaceX',
    nameFull: 'SpaceX（Space Exploration Technologies，SPCX）',
    title: 'SpaceX 財報模型',
    h1: 'SpaceX 財報模型：Starlink、發射與 AI 算力',
    promise: '把 Starlink 用戶與每用戶營收、客戶發射次數，以及 AI 部門的額定算力與每瓦營收串起來，看三個部門如何決定 SpaceX 的營收與毛利率。',
    kicker: '基礎模型 · 財報模型 · 發射、Starlink 與 AI 算力',
    blurb: '把營收拆成 Starlink 用戶 × 每用戶營收、客戶發射 × 每次營收與 AI 算力 × 每瓦營收；上市後只有 7 季財報，回測樣本很少。',
    currency: 'USD',
    epsUnit: '美元',
    summaryQuarters: 2,
    historyFrom: '2025Q1',
    priceSeries: [],
    gmLabel: '毛利率',
    epsLabel: 'EPS（GAAP 稀釋）',
    oiLabel: '營業利益（GAAP）',
    niLabel: '淨利（GAAP）',
    backtest: { ...DRIVER_BACKTEST, known: '當季實際的 Starlink 用戶、發射次數與額定算力' },
    noticeInputs: '公開財報、公司說法與假設的情境',
    basicsTitle: 'SpaceX 怎麼賺錢，為什麼要看用戶、發射與算力',
    driversLede: 'SpaceX 在財報與法說會公布 Starlink 用戶、發射次數、額定算力與未完成合約；下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計與財測另外標示。',
    descLead: '以 Starlink 用戶、客戶發射與 AI 額定算力拆解 SpaceX 三個部門的營收與毛利率',
  },
  tesla: {
    id: 'tesla',
    topic: 'forecast',
    path: '/forecast/tesla/',
    segment: 'physical-ai',
    order: 1,
    name: '特斯拉',
    nameFull: '特斯拉（Tesla）',
    title: '特斯拉財報模型',
    h1: '特斯拉財報模型：交車、每輛車單價與汽車毛利率',
    promise: '把交車量、每輛車售價與成本、監管積分和儲能部署串起來，看特斯拉的營收與毛利率怎麼隨交車與價格變動，以及營業費用如何影響獲利。',
    kicker: '實體 AI · 財報模型 · 電動車與儲能',
    blurb: '用交車量 × 每輛車售價與成本、監管積分與儲能部署拆解特斯拉的營收與毛利率；特斯拉不提供財務財測，只能和天真模型與分析師共識比較。',
    currency: 'USD',
    epsUnit: '美元',
    summaryQuarters: 1,
    historyFrom: '2019Q1',
    priceSeries: [],
    gmLabel: '毛利率',
    epsLabel: 'EPS（GAAP 稀釋）',
    oiLabel: '營業利益',
    niLabel: '淨利（歸屬普通股股東）',
    backtest: { ...DRIVER_BACKTEST, known: '當季實際的交車與儲能部署' },
    noticeInputs: '公開財報、交車與部署報告和假設的情境',
    basicsTitle: '特斯拉怎麼賺錢，為什麼要看交車與單車毛利',
    driversLede: '特斯拉每季先公布生產、交車與儲能部署，幾週後才公布財報；下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計與分析師共識另外標示。',
    descLead: '以交車量、每輛車售價與成本、監管積分和儲能部署拆解特斯拉的營收與毛利率',
  },
  // Checked 2026-11-18 against the 2026-11-10 preliminary prospectus (SEC FWPs): quarters start 2025Q1; gross margin =
  // revenue − functional cost of revenue (Note 8). Not trading yet on 2026-11-18: drop 「預計」 from nameFull once ANT lists.
  anthropic: {
    id: 'anthropic',
    topic: 'forecast',
    path: '/forecast/anthropic/',
    segment: 'foundation-models',
    order: 2,
    name: 'Anthropic',
    nameFull: 'Anthropic（Anthropic, PBC，預計以代號 ANT 掛牌）',
    title: 'Anthropic 財報模型',
    h1: 'Anthropic 財報模型：年化營收、算力費用與毛利率',
    promise: '把公司說過的年化營收、招股書揭露的算力與基礎設施費用和服務客戶的銷貨成本串起來，看 Anthropic 的營收、毛利率與營業損益怎麼隨年化營收、算力承諾與算力效率變動。',
    kicker: '基礎模型 · 財報模型 · 年化營收與算力成本',
    blurb: '用年化營收換算當季營收，毛利率看銷貨成本占算力費用的比例，訓練算力則計入研發費用；招股書只揭露 2025 年起的 7 季財報，回測樣本很少，又代入了季中與季末的年化營收，2027 年依算力承諾與算力效率的假設推估。',
    currency: 'USD',
    epsUnit: '美元',
    summaryQuarters: 2,
    historyFrom: '2025Q1',
    priceSeries: [],
    gmLabel: '毛利率',
    epsLabel: 'EPS（GAAP 稀釋；本模型不預測）',
    oiLabel: '營業損益（GAAP）',
    niLabel: '淨損益（GAAP）',
    backtest: {
      ...DRIVER_BACKTEST,
      known: '財報公開前公布的年化營收與當季實際的算力費用',
      knownShort: '財報公開前公布的年化營收與實際算力費用',
      exAnte: '事前：只用季初的年化營收，算力費用延續上一季成長',
      exAnteLine: '同一模型只用季初的年化營收',
      exAnteShort: '只用季初年化營收',
    },
    noticeInputs: '招股書財報、公司說法與假設的情境',
    basicsTitle: 'Anthropic 怎麼賺錢，為什麼要看年化營收與算力成本',
    driversLede: 'Anthropic 上市前只在募資與合作公告中揭露年化營收，招股書才首次公開 2025 年起的季度財報、算力費用、客戶數與合約承諾；下方先用圖表說明最重要的幾項，模型用到的全部序列依類別收在本段最後，估計另外標示。',
    descLead: '以年化營收、算力與基礎設施費用和銷貨成本拆解 Anthropic 的營收與毛利率',
  },
};

/** Companies of a topic (all when omitted) in chain order: segment order bottom → top, then `order`. */
export function fcCompaniesOf(topic?: FcTopic): FcCompany[] {
  const rank = (c: FcCompany) => SEGMENT_IDS.indexOf(FC_META[c].segment) * 100 + FC_META[c].order;
  return (Object.keys(FC_META) as FcCompany[]).filter((c) => !topic || FC_META[c].topic === topic).sort((a, b) => rank(a) - rank(b));
}

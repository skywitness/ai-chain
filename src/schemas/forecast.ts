// 記憶體專題的財報模型子頁（/memory/phison/、/memory/micron/）的資料格式。
// 檔案（src/data/memory/forecast/）：
//   market-prices.yaml   NAND／DRAM 合約價與現貨價序列（兩家模型共用的輸入）       → marketPrices
//   phison-inputs.yaml   群聯的季財報、月營收、年報產銷量值與進貨、事件              → companyInputs
//   micron-inputs.yaml   美光的季財報（會計季度）、DRAM／NAND 拆分、位元與 ASP、財測 → companyInputs
//   phison-model.json    scripts/models/phison.ts 產生的模型結果（不要手改）         → modelOutput
//   micron-model.json    scripts/models/micron.ts 產生的模型結果（不要手改）         → modelOutput
// 驗證：npx tsx scripts/check-forecast.ts（schema、來源 key、期間連續性、模型輸出是否可由輸入重算）。
import { z } from 'astro/zod';
import { Editorial, IsoDate, Source } from './common';

const SrcKey = z.string().min(1); // key into the file's `sources` map
/** actual＝公司公布；estimate＝第三方或推算；forecast＝對未來的預測；guidance＝公司財測 */
const Status = z.enum(['actual', 'estimate', 'forecast', 'guidance']);
/** 日曆季度「2025Q3」（群聯）或會計季度「FY2026Q4」（美光）；年度「2025」「FY2026」；月「2026-09」 */
export const QuarterId = z.string().regex(/^(FY)?\d{4}Q[1-4]$/, '2025Q3 or FY2026Q4');
const YearId = z.string().regex(/^(FY)?\d{4}$/);
const MonthId = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/* ───────────── market prices (shared input) ───────────── */

export const marketPrices = z.strictObject({
  asOf: IsoDate,
  series: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), // 「nand-contract-qoq」「nand-wafer-512g-tlc」
        name: z.string().min(2), // zh
        product: z.enum(['nand', 'dram', 'ssd', 'hbm']),
        kind: z.enum(['qoq-change', 'yoy-change', 'level', 'index']),
        unit: z.string().min(1), // 「%」「美元／片」「指數（2019Q1=100）」
        frequency: z.enum(['quarter', 'month', 'week']),
        definition: z.string().min(4), // 涵蓋哪些產品、加權方式、合約價或現貨價
        points: z
          .array(
            z.strictObject({
              period: z.string().min(4), // 2025Q3 / 2026-09 / 2026-W38
              value: z.number(),
              low: z.number().optional(), // 區間的下緣與上緣（例如「季增 3–8%」）
              high: z.number().optional(),
              status: Status.default('actual'),
              src: SrcKey,
              note: z.string().optional(),
            }),
          )
          .min(4),
        note: z.string().optional(),
      }),
    )
    .min(1),
  sources: z.record(z.string(), Source),
  lastVerified: IsoDate,
  editorial: Editorial,
});

/* ───────────── company inputs ───────────── */

const Guidance = z.strictObject({
  revenue: z.number().optional(), // 中值，百萬
  revenueLow: z.number().optional(),
  revenueHigh: z.number().optional(),
  grossMargin: z.number().optional(), // %，中值
  eps: z.number().optional(), // 中值
  basis: z.enum(['GAAP', 'non-GAAP', 'TIFRS']).optional(),
  issued: IsoDate.optional(),
  src: SrcKey,
});

export const companyInputs = z.strictObject({
  company: z.enum(['phison', 'micron']), // roster id
  currency: z.enum(['TWD', 'USD']),
  amountUnit: z.literal('million'), // 所有金額欄位的單位
  periodNote: z.string().min(10), // 期間定義（日曆季度，或美光 52/53 週會計年度）
  asOf: IsoDate,
  quarters: z
    .array(
      z.strictObject({
        period: QuarterId,
        start: IsoDate,
        end: IsoDate,
        status: Status.default('actual'),
        revenue: z.number().positive(),
        grossProfit: z.number().optional(),
        operatingExpenses: z.number().optional(),
        operatingIncome: z.number().optional(),
        nonOperating: z.number().optional(), // 業外收支（群聯的投資損益、匯兌等）
        pretaxIncome: z.number().optional(),
        netIncome: z.number().optional(), // 歸屬母公司
        eps: z.number().optional(), // 基本每股盈餘（元／美元）
        epsNonGaap: z.number().optional(),
        grossMarginNonGaap: z.number().optional(), // %
        sharesDiluted: z.number().optional(), // 百萬股
        inventory: z.number().optional(), // 期末存貨淨額
        inventoryWritedown: z.number().optional(), // 存貨跌價損失（正值）或回升利益（負值）
        depreciation: z.number().optional(), // 折舊攤銷
        capex: z.number().optional(),
        // 美光：產品別、位元與平均售價的季變化（%；公司以區間描述時取中值，原文寫在 note）
        dramRevenue: z.number().optional(),
        nandRevenue: z.number().optional(),
        hbmRevenue: z.number().optional(),
        dramBitQoq: z.number().optional(),
        dramAspQoq: z.number().optional(),
        nandBitQoq: z.number().optional(),
        nandAspQoq: z.number().optional(),
        underutilization: z.number().optional(), // 稼動率不足費用（計入銷貨成本）
        guidance: Guidance.optional(), // 公司在上一季法說對本季的財測
        extra: z.record(z.string(), z.number()).optional(), // 其他數值欄位（中文鍵名，說明寫在 note）
        note: z.string().optional(),
        src: SrcKey,
      }),
    )
    .min(8),
  monthly: z
    .array(z.strictObject({ period: MonthId, revenue: z.number().positive(), src: SrcKey, note: z.string().optional() }))
    .default([]),
  annual: z
    .array(
      z.strictObject({
        year: YearId,
        // 年報「產銷量值表」：銷售量與銷售值（依產品別）
        sales: z
          .array(z.strictObject({ product: z.string(), units: z.number().optional(), unitLabel: z.string().optional(), value: z.number(), note: z.string().optional() }))
          .default([]),
        // 年報「主要供應商進貨」：金額（百萬）與占進貨淨額比重
        purchases: z
          .array(z.strictObject({ supplier: z.string(), amount: z.number().optional(), share: z.number().min(0).max(100).optional(), note: z.string().optional() }))
          .default([]),
        totalPurchases: z.number().optional(),
        extra: z.record(z.string(), z.number()).optional(),
        note: z.string().optional(),
        src: SrcKey,
      }),
    )
    .default([]),
  events: z
    .array(z.strictObject({ date: IsoDate, title: z.string().min(2), detail: z.string().min(4), src: SrcKey }))
    .default([]), // 法說會說法、新聞稿、減產、合約價談判等，供模型解讀與頁面時間軸使用
  sources: z.record(z.string(), Source),
  lastVerified: IsoDate,
  editorial: Editorial,
});

/* ───────────── model output (generated by scripts/models/*.ts) ───────────── */

const Metrics = z.strictObject({ mape: z.number().nonnegative().optional(), mae: z.number().nonnegative().optional(), bias: z.number().optional(), n: z.number().int().nonnegative() });
const Forecast = z.strictObject({
  period: z.string().min(4), // 2026Q3、2027、FY2027Q1、FY2027
  revenue: z.number(),
  grossMargin: z.number(), // %
  operatingIncome: z.number().optional(),
  netIncome: z.number().optional(),
  eps: z.number().optional(),
  known: z.array(z.string()).default([]), // 已公布、直接採用的欄位（例如群聯 2026Q3 營收由月營收得知）
  note: z.string().optional(),
});

export const modelOutput = z.strictObject({
  company: z.enum(['phison', 'micron']),
  generatedBy: z.string(), // 「scripts/models/phison.ts」
  generatedOn: IsoDate,
  asOf: IsoDate, // 輸入資料的截至日
  currency: z.enum(['TWD', 'USD']),
  amountUnit: z.literal('million'),
  periodLabel: z.string(), // 「日曆季度」「美光會計季度（約 9 月至隔年 8 月）」
  train: z.strictObject({ from: z.string(), to: z.string() }),
  test: z.strictObject({ from: z.string(), to: z.string() }),
  summary: z.string().min(40).max(800), // zh：選了哪個模型、回測誤差、主要結論
  candidates: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        name: z.string(), // zh
        description: z.string().min(10), // zh：做法與直覺
        equations: z.array(z.string()).default([]), // 純文字公式，例如「毛利率_t = a + b × (售價指數_t ÷ 成本指數_t−k)」
        metrics: z.record(z.string(), Metrics), // 依目標：revenue、grossMargin、operatingIncome、eps
        selected: z.boolean().default(false),
        note: z.string().optional(),
      }),
    )
    .min(2),
  parameters: z.array(z.strictObject({ name: z.string(), value: z.number(), unit: z.string().optional(), note: z.string().optional() })).default([]),
  derived: z
    .array(
      z.strictObject({
        id: z.string(), // 「purchase-cost-index」「cost-per-bit」
        name: z.string(),
        unit: z.string(),
        points: z.array(z.strictObject({ period: z.string(), value: z.number(), status: Status.default('estimate') })),
        note: z.string().optional(),
      }),
    )
    .default([]), // 模型推算出的中間序列（推估購入成本、每位元成本…），頁面畫圖用
  backtest: z
    .array(
      z.strictObject({
        period: z.string(),
        metric: z.string(), // revenue / grossMargin / operatingIncome / netIncome / eps
        actual: z.number(),
        predicted: z.number(),
        candidate: z.string(), // candidates[].id
        benchmark: z.number().optional(), // 公司財測或天真模型的數字（對照用）
        benchmarkLabel: z.string().optional(),
      }),
    )
    .min(4),
  scenarios: z
    .array(
      z.strictObject({
        id: z.enum(['bear', 'base', 'bull']),
        name: z.string(), // 「保守」「基準」「樂觀」
        assumptions: z.array(z.strictObject({ name: z.string(), value: z.string(), src: SrcKey.optional() })).min(1),
        forecasts: z.array(Forecast).min(2),
      }),
    )
    .length(3),
  sensitivities: z.array(z.strictObject({ driver: z.string(), change: z.string(), effect: z.string() })).default([]),
  limitations: z.array(z.string()).min(2),
  sourceKeys: z.array(z.string()).default([]), // 引用到的 inputs／market-prices 來源 key
});

export type MarketPrices = z.output<typeof marketPrices>;
export type CompanyInputs = z.output<typeof companyInputs>;
export type ModelOutput = z.output<typeof modelOutput>;

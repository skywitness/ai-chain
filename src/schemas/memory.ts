// 記憶體與儲存專題（/memory/）的資料格式。
// 檔案：src/data/memory/{hbm,dram,nand,storage}.yaml（各類市場資料）與 src/data/memory/fabs.yaml（全球晶圓廠與擴產）。
// 由 scripts/check-memory.ts 驗證（schema、公司 id 是否在名冊中、來源 key 是否存在）。
import { z } from 'astro/zod';
import { Editorial, IsoDate, PartialDate, Source } from './common';

const Status = z.enum(['actual', 'estimate', 'forecast']);
const SrcKey = z.string().min(1); // key into the file's `sources` map

/** 一個帶來源的數據點 */
const Metric = z.strictObject({
  label: z.string().min(2), // zh 說明，例如「DRAM 位元供給年增率」
  period: z.string().min(4), // 「2026」「2026 Q2」「2026-09」
  value: z.number(),
  unit: z.string().min(1), // 「%」「十億美元」「千片/月」「EB」「Gb」
  status: Status.default('actual'),
  note: z.string().optional(),
  src: SrcKey,
});

const Share = z.strictObject({
  company: z.string().min(1), // roster id；非名冊公司用 "other" 或名冊外名稱時填 name
  name: z.string().min(1), // 顯示名稱（zh）
  share: z.number().min(0).max(100),
});

export const memoryMarket = z.strictObject({
  category: z.enum(['hbm', 'dram', 'nand', 'storage']),
  title: z.string(), // 「HBM 高頻寬記憶體」
  asOf: IsoDate,
  summary: z.string().min(60).max(600), // 2–5 句 zh 摘要
  keyPoints: z.array(z.string().max(120)).min(3).max(8),
  marketSize: z
    .array(z.strictObject({ year: z.number().int(), value: z.number().positive(), unit: z.enum(['million', 'billion']), currency: z.literal('USD'), status: Status, definition: z.string(), src: SrcKey }))
    .default([]),
  supply: z.array(Metric).default([]), // 位元供給、晶圓產能、良率、TSV 產能…
  demand: z.array(Metric).default([]), // 位元需求、每顆加速器 HBM 容量、AI 伺服器出貨…
  demandMix: z
    .array(z.strictObject({ period: z.string(), basis: z.enum(['bit', 'revenue', 'unit']), items: z.array(z.strictObject({ name: z.string(), share: z.number().min(0).max(100) })).min(2), status: Status.default('actual'), src: SrcKey }))
    .default([]), // 依應用別的需求結構
  balance: z
    .array(z.strictObject({ period: z.string(), state: z.enum(['shortage', 'tight', 'balanced', 'oversupply']), sufficiencyRatio: z.number().optional(), note: z.string(), status: Status.default('actual'), src: SrcKey }))
    .default([]), // 供需狀態（短缺／吃緊／平衡／過剩）
  marketShare: z
    .array(z.strictObject({ period: z.string(), basis: z.enum(['revenue', 'bit', 'capacity', 'unit']), label: z.string().optional(), items: z.array(Share).min(2), src: SrcKey }))
    .default([]),
  prices: z
    .array(z.strictObject({ series: z.string(), unit: z.string(), kind: z.enum(['level', 'qoq-change']), points: z.array(z.strictObject({ period: z.string(), value: z.number(), status: Status.default('actual') })).min(2), note: z.string().optional(), src: SrcKey }))
    .default([]),
  capacity: z
    .array(z.strictObject({ company: z.string(), metric: z.string(), value: z.number(), unit: z.string(), period: z.string(), status: Status.default('actual'), note: z.string().optional(), src: SrcKey }))
    .default([]), // 各廠產能現況
  expansions: z
    .array(z.strictObject({ company: z.string(), project: z.string(), fab: z.string().optional(), product: z.string(), addCapacity: z.string().optional(), capex: z.string().optional(), stage: z.enum(['announced', 'construction', 'equipping', 'ramping', 'operating', 'delayed', 'cancelled']), start: PartialDate.optional(), production: PartialDate.optional(), note: z.string().optional(), src: SrcKey }))
    .default([]),
  technology: z
    .array(z.strictObject({ name: z.string(), detail: z.string(), status: z.enum(['research', 'sampling', 'ramping', 'volume', 'roadmap']), timing: z.string().optional(), src: SrcKey }))
    .default([]),
  sources: z.record(z.string(), Source),
  lastVerified: IsoDate,
  editorial: Editorial,
});

export const memoryFabs = z.strictObject({
  asOf: IsoDate,
  fabs: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        company: z.string(), // roster id
        name: z.string(), // 「M15X」「平澤 P4」
        city: z.string(), // zh
        country: z.string().length(2),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        products: z.array(z.enum(['dram', 'hbm', 'hbm-packaging', 'nand', 'hdd', 'ssd', 'other'])).min(1),
        status: z.enum(['operating', 'expanding', 'construction', 'planned', 'delayed']),
        capacityKwpm: z.number().positive().optional(), // 現有月產能（千片 12 吋晶圓／月）
        capacityStatus: Status.optional(),
        addKwpm: z.number().positive().optional(), // 擴產新增月產能
        capex: z.string().optional(), // 「約 20 兆韓元」
        timeline: z.string().optional(), // 「2025 動工、2027 量產」
        note: z.string().optional(),
        src: SrcKey,
      }),
    )
    .min(10),
  sources: z.record(z.string(), Source),
  lastVerified: IsoDate,
  editorial: Editorial,
});

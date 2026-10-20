// Shared primitives for every content collection.
// FROZEN CONTRACT: changes go through proposals/ (see docs/OWNERSHIP.md).
import { z } from 'astro/zod';

/** 14 環節（由下而上）。順序即產業鏈順序。 */
export const SEGMENT_IDS = [
  'energy-power',
  'semi-equipment-materials',
  'foundry-packaging',
  'memory-storage',
  'eda-ip-design',
  'ai-accelerators',
  'networking-optics',
  'servers-systems',
  'datacenter-infra',
  'cloud-neocloud',
  'foundation-models',
  'devtools-data-mlops',
  'apps-agents',
  'physical-ai',
] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

/** 5 層 */
export const LAYER_IDS = ['foundation', 'silicon', 'systems', 'cloud-models', 'applications'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** 23 個 3D 場景。每個場景一個資料夾：src/three/scenes/<id>/ */
export const SCENE_IDS = [
  'chain-panorama',
  'learn-mountain',
  'neural-net',
  'embedding-space',
  'attention',
  'train-infer',
  'scaling-surface',
  'euv-litho',
  'wafer-transistor',
  'cowos',
  'hbm',
  'chip-floorplan',
  'gpu-scale',
  'network',
  'datacenter',
  'energy',
  'cloud-globe',
  'model-galaxy',
  'agent-loop',
  'physical-ai',
  'company-globe',
  'roadmap-tunnel',
  'taiwan-map',
] as const;
export type SceneId = (typeof SCENE_IDS)[number];
export const SceneIdSchema = z.enum(SCENE_IDS);
export const SceneRef = z.strictObject({ id: SceneIdSchema, variant: z.string().optional() });

export const GLOSSARY_CATEGORIES = [
  'ai-basics',
  'llm',
  'training',
  'inference',
  'hardware',
  'semiconductor',
  'packaging',
  'memory',
  'networking',
  'datacenter',
  'energy',
  'cloud-business',
  'policy',
  'robotics',
] as const;

export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case ASCII only');

/** YYYY-MM-DD. YAML may coerce dates into Date objects, so accept those too. */
export const IsoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.iso.date(),
);

/** YYYY | YYYY-MM | YYYY-MM-DD */
export const PartialDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? String(v) : v),
  z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/, 'YYYY | YYYY-MM | YYYY-MM-DD'),
);

export const Level = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const CURRENCIES = [
  'USD', 'TWD', 'JPY', 'KRW', 'EUR', 'CNY', 'HKD', 'GBP', 'CHF', 'CAD', 'SEK', 'DKK', 'NOK',
  'ILS', 'INR', 'SGD', 'AUD', 'SAR', 'AED', 'BRL',
] as const;
export const Currency = z.enum(CURRENCIES);

/** EU = 歐洲（含瑞士、北歐）；ME = 中東；SEA = 東南亞；CN 含香港 */
export const Region = z.enum(['TW', 'US', 'CN', 'JP', 'KR', 'EU', 'UK', 'IL', 'IN', 'CA', 'ME', 'SEA', 'OTHER']);

export const Editorial = z.strictObject({
  status: z.enum(['stub', 'draft', 'researched', 'fact-checked']),
  author: z.string().min(1), // agent id
  checkedBy: z.string().optional(), // must differ from author when status = fact-checked
  checkedOn: IsoDate.optional(),
  notes: z.string().optional(),
});

export const SourceType = z.enum([
  'filing', 'annual-report', 'ir-presentation', 'earnings-call', 'press-release', 'monthly-revenue',
  'company-site', 'paper', 'docs', 'standard', 'government', 'dataset', 'leaderboard', 'news',
  'analyst', 'book', 'other',
]);

export const Source = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(), // for <Cite k="…"/> in MDX bodies
  registry: z.string().optional(), // id in the `sources` collection
  title: z.string().min(2),
  publisher: z.string().min(2),
  url: z.url(),
  type: SourceType,
  lang: z.enum(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'de', 'fr', 'other']).default('en'),
  published: IsoDate.optional(),
  accessed: IsoDate,
  archiveUrl: z.url().optional(),
  note: z.string().optional(),
});
export type SourceT = z.infer<typeof Source>;

export const DatedValue = z.strictObject({
  label: z.string().min(2), // 「全球 EUV 曝光機市占」
  value: z.string().min(1), // "≈100%"
  asOf: IsoDate,
  source: Source,
  note: z.string().optional(),
});

export const EXCHANGES = [
  'NASDAQ', 'NYSE', 'TWSE', 'TPEx', 'TSE', 'KRX', 'KOSDAQ', 'HKEX', 'SSE', 'SZSE', 'STAR', 'BSE-CN',
  'Euronext', 'LSE', 'XETRA', 'SIX', 'OMX', 'BIT', 'TASE', 'NSE', 'TSX', 'ASX', 'SGX', 'Tadawul',
  'OTC', 'other',
] as const;

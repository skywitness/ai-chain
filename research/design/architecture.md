# AI 產業鏈全景: Architecture and Multi-Agent Build Design

**Snapshot date:** 2026-10-06. I checked package versions with `npm view` today and read the current Astro 7, MDX, content-collection, Fonts and Pagefind docs.

**Working site name:** 「AI 產業鏈全景」 (AI Chain Atlas). Page `<title>` pattern: `{頁面標題}｜AI 產業鏈全景`.

---

## 0. Key decisions at a glance

| Area | Decision |
|---|---|
| Framework | Astro 7.3.x, fully static output. No UI framework (no React or Svelte). Interactivity comes from small vanilla TS modules and custom elements. |
| 3D | three.js r186 `WebGLRenderer` with render-on-demand. Each scene is loaded lazily as its own chunk inside an `<ai-scene>` custom element. Scenes are found automatically through `import.meta.glob`, so there is no shared registry file. |
| Content | Content Layer collections defined in `src/content.config.ts`. Prose uses MDX with YAML frontmatter. Numbers live in JSON. Small dictionary entries live in YAML. **One file per entity.** |
| Schemas | Zod 4 from `astro/zod`. Schemas are written as a factory over `reference()`, so standalone scripts can validate single files without running `astro build`. |
| Styling | Plain modern CSS: cascade layers, custom-property tokens, `light-dark()`, container queries, and Astro scoped styles. No Tailwind. |
| Charts | SVG rendered at build time by Astro components using `d3-scale`, `d3-shape` and `d3-format` in frontmatter only. The client gets one shared tooltip script of about 1.5 KB. Every chart has a data table. |
| Search | Pagefind 1.5.2 run after the build. Its extended build segments Chinese automatically for `lang="zh-…"`. The Component UI modal loads on first use. |
| Navigation | CSS cross-document view transitions (`@view-transition { navigation: auto; }`), with zero JS. Do **not** use `<ClientRouter />`: real page loads keep the WebGL lifecycle simple. |
| Fonts | System CJK font stack only (PingFang TC, Noto Sans TC, Microsoft JhengHei). No web-font download. |
| Deploy | Static `dist/`. Cloudflare Pages / Workers static assets is recommended. GitHub Pages and Vercel are supported through `BASE_PATH`. |

---

## 1. Stack and exact versions

Runtime: **Node 24.19** (Astro 7 requires `>=22.12.0`) and **npm 11.17**. Do **not** upgrade to npm 12 during the build.

| Package | Version (pin) | Why |
|---|---|---|
| `astro` | `^7.3.6` | Released 2026-06-22. Rust `.astro` compiler, Vite 8 with Rolldown, and Sätteri as the default Markdown/MDX processor (Rust; GFM, heading IDs, math built in). Builds are 15–61% faster, which matters for about 450 pages. Notes: the stricter compiler rejects unclosed tags; `compressHTML` now defaults to `'jsx'`, so write `{' '}` where a space between inline elements is needed in `.astro` templates; `src/fetch.ts` is a reserved filename. |
| `@astrojs/mdx` | `^8.0.3` | MDX for articles, segments, trends, models and company bodies. It uses the same Sätteri pipeline, so do not add remark/rehype plugins. Set `optimize: true`. |
| `@astrojs/sitemap` | `^3.7.4` | Sitemap. Exclude `/dev/`. |
| `@astrojs/check` | `^0.9.10` | `astro check`. |
| `typescript` | **`~6.0.3`** | **Do not use TS 7.0.2** (the native port, now `latest`). The `@astrojs/check` peer range is `^5 \|\| ^6`. |
| Zod | from **`astro/zod`** (bundles Zod 4.6) | Do not install `zod` separately. A second copy breaks `instanceof` and types. |
| `three` | **`0.186.1` exact** | r186. Pin exactly because three.js has breaking changes every release. Use `WebGLRenderer` (widest support, works with SwiftShader in CI). Do not use `three/webgpu`: the bundle is bigger and there is no need for it. |
| `@types/three` | `0.186.0` exact | Matches r186. |
| `pagefind` | `^1.5.2` | Extended build with automatic CJK segmentation for `zh-` pages, new Component UI, Web Worker search and smaller indexes. |
| `d3-scale` 4.0.2, `d3-shape` 3.2.0, `d3-array` 3.2.4, `d3-format` 3.1.2 | dev/build-only | Used only in `.astro` frontmatter, so zero client bytes. |
| `temml` | `^0.13.5` | Converts LaTeX to MathML at build time for the L3 formulas (Rayleigh criterion, scaling laws). Browsers render it natively, with no KaTeX CSS or fonts. |
| `topojson-client` 3.1.0, `world-atlas` 2.0.2 | dev-only | Build-time generation of the globe dot cloud and the Taiwan outline. |
| `yaml` 2.9.1, `tsx` 4.23.x, `tinyglobby` 0.2.17 | dev | Scripts. |
| `opencc-js` | `^1.4.2` | Detects Simplified characters (s→tw diff) in `check-zh`. |
| `@playwright/test` | `^1.63.0` | Smoke, WebGL, screenshot and axe tests. |
| `@axe-core/playwright` | `^4.13.0` | Accessibility checks per template. |
| `linkinator` | `^8.1.0` | Internal link checker over `dist/`. |
| `@lhci/cli` | `^0.15.1` | Lighthouse budgets. |
| `sharp` | `^0.35.5` (Astro dependency) | Pixel-variance checks on canvas screenshots, plus poster processing. |
| `prettier` 3.9.9 + `prettier-plugin-astro` 1.1.0; `stylelint` 17.16 (optional) | dev | Formatting. A stylelint rule forbids raw hex colours outside `tokens.css`. |

**Not used, and why:**
- Tailwind: utility classes would leak into MDX authored by about 50 agents. Scoped Astro styles plus tokens give each component file clear ownership.
- React/Svelte islands: three.js is imperative anyway, and content pages should ship nearly no JS.
- A chart library (ECharts or Chart.js, 100–300 KB): every chart here is static data known at build time.
- `@astrojs/markdown-remark`: not needed.
- `astro-pagefind`: the plain CLI after the build has fewer moving parts.

**`astro.config.mjs` (sketch)**
```js
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://example.org',
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'always',
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  integrations: [mdx({ optimize: true }), sitemap({ filter: (u) => !u.includes('/dev/') })],
});
```
`tsconfig.json` extends `astro/tsconfigs/strictest` and adds the aliases `@lib/*`, `@schemas/*`, `@components/*`, `@three/*`, `@data/*`.

**`package.json` scripts**
```
dev            astro dev
build          astro build && pagefind --site dist
preview        astro preview
check          astro check
validate       tsx scripts/validate-data.ts            (all files, real cross-refs)
validate:files tsx scripts/validate-data.ts --only     (given paths, refs checked against registries)
lint:zh        tsx scripts/check-zh.ts [paths]
lint:content   tsx scripts/check-content-rules.ts [paths]
gen:geo        tsx scripts/gen-geo.ts
fx             tsx scripts/fetch-fx.ts
coverage       tsx scripts/report-coverage.ts
links          tsx scripts/check-links.ts
test:e2e       playwright test
test:scene     playwright test tests/scenes --grep
shots          tsx scripts/capture-screenshots.ts
posters        tsx scripts/capture-posters.ts
lhci           lhci autorun
verify         check → validate → lint:zh → lint:content → build → links → test:e2e
```

---

## 2. Directory structure and ownership

Owner tags:
- `[P0]` scaffold or architect agent (frozen after Phase 0)
- `[DS]` design-system agent
- `[3D]` 3D-core agent
- `[CH]` charts and finance-lib agent
- `[PG-x]` page-family agent
- `[CT-x]` content agents, one file per entity
- `[SC-id]` scene agent
- `[QA]` QA agent
- `[INT]` integrator (the only role that merges proposals and edits frozen files between waves)

```
C:\dev2
├─ astro.config.mjs  package.json  tsconfig.json  .prettierrc  .gitignore     [P0, frozen]
├─ playwright.config.ts  lighthouserc.json                                    [QA]
├─ docs/
│  ├─ STYLE-zh-TW.md        terminology, punctuation, citation rules           [P0]
│  ├─ CONTENT-GUIDE.md      per-collection templates + DoD                     [P0]
│  ├─ SCENE-CONTRACT.md     scene API, budgets, a11y                           [3D]
│  └─ OWNERSHIP.md          this ownership table                               [P0]
├─ proposals/<agent>-<yyyymmddhhmm>.yaml   one file per change request (new company/term/dep/kit helper) [any agent writes own; INT merges]
├─ public/
│  ├─ favicon.svg  robots.txt  _headers (CF/Netlify)  .nojekyll                [P0]
│  └─ og/<section>.png      static OG images per section                       [DS]
├─ scripts/
│  ├─ validate-data.ts  check-zh.ts  check-content-rules.ts  report-coverage.ts [P0, then QA]
│  ├─ fetch-fx.ts                                                               [CH]
│  ├─ gen-geo.ts            globe dots + Taiwan outline → src/data/geo/*        [3D]
│  ├─ check-links.ts  capture-screenshots.ts  capture-posters.ts                [QA]
│  └─ new-entity.ts         scaffolds a file from template (company/learn/…)    [P0]
├─ src/
│  ├─ content.config.ts     defineCollection × N, imports makeSchemas()         [P0, frozen]
│  ├─ schemas/              common.ts refs.ts learn.ts segment.ts company.ts financials.ts
│  │                        model.ts trend.ts glossary.ts source.ts page.ts scene.ts index.ts   [P0, frozen]
│  ├─ content/
│  │  ├─ learn/<slug>.mdx              [CT-learn]  (38)
│  │  ├─ segments/<segment-id>.mdx     [CT-seg]    (14)
│  │  ├─ companies/<slug>.mdx          [CT-co]     (~330; body optional for compact)
│  │  ├─ financials/<slug>.json        [CT-co]     (same agent as the company file)
│  │  ├─ models/<family>.mdx           [CT-model]  (~26)
│  │  ├─ trends/<slug>.mdx             [CT-trend]  (~25)
│  │  ├─ glossary/<term-id>.yaml       [CT-gloss]  (~220)
│  │  ├─ sources/<publisher-id>.yaml   [CT-src]    curated registry (~60)
│  │  └─ pages/{home,chain,taiwan,methodology,about,models-intro,learn-intro}.mdx  [PG-x owner of that route]
│  ├─ data/
│  │  ├─ roster.yaml           company id registry (id, nameZh, primarySegment, tier, profile)  [P0→INT]
│  │  ├─ glossary-index.yaml   term id registry                                                 [P0→INT]
│  │  ├─ curriculum.yaml       learn slug registry + order + prereqs                            [P0, frozen]
│  │  ├─ models-index.yaml  trends-index.yaml  scenes-index.yaml                                [P0→INT]
│  │  ├─ benchmarks.yaml       benchmark definitions                                            [CT-model lead]
│  │  ├─ fx/usd-rates.json     period-average FX                                                [CH]
│  │  ├─ taiwan/sites.yaml     science parks / fabs / clusters (lat/lon)                        [CT-taiwan]
│  │  └─ geo/                  generated (globe-dots.json, taiwan.json, cities.json)            [3D, generated]
│  ├─ lib/                     build-time helpers                                                [P0 stubs → owners]
│  │  ├─ paths.ts (withBase, routes)  format.ts (zh money units, dates)  graph.ts (knowledge graph)
│  │  ├─ fiscal.ts  fx.ts  financial-metrics.ts (TTM/YoY/QoQ)                                    [CH]
│  │  ├─ collections.ts (typed getters, sorting, related())  seo.ts  search.ts                   [P0→INT]
│  ├─ layouts/ BaseLayout.astro ArticleLayout.astro ProfileLayout.astro                          [DS]
│  ├─ styles/ tokens.css base.css prose.css layout.css utilities.css                             [DS]
│  ├─ components/
│  │  ├─ ui/       Badge Button Card Tabs Disclosure Breadcrumbs Tag Icon Stat DataAsOf          [DS]
│  │  ├─ layout/   Header Footer ThemeToggle SearchButton SkipLink TOC                           [DS]
│  │  ├─ content/  Term Cite Callout KeyTakeaways DeepDive LevelSection Figure MathTeX
│  │  │            CompanyChip ModelChip SegmentChip LearnLink PrereqBox NextSteps SourcesList    [DS] (stub APIs fixed in P0)
│  │  ├─ charts/   ChartFrame RevenueBars MonthlyRevenue SegmentMix Sparkline MultiLine
│  │  │            DotPlot Heatmap MarginLadder DataTable  chart-tooltip.ts                       [CH]
│  │  ├─ diagrams/<diagram-id>.astro   static explanatory SVG, one file per diagram              [CT-learn/CT-seg author who needs it]
│  │  ├─ company/  model/  learn/  trend/  taiwan/   page-family components                      [PG-x]
│  │  └─ scene/Scene3D.astro                                                                      [3D]
│  ├─ three/
│  │  ├─ core/   element.ts engine.ts loader.ts controls.ts labels.ts picking.ts hotspots.ts
│  │  │          theme.ts quality.ts motion.ts fallback.ts tween.ts types.ts                      [3D]
│  │  ├─ kit/    flow-particles.ts die.ts rack.ts globe.ts arcs.ts extrude-geo.ts exploded.ts
│  │  │          heat-field.ts camera-tour.ts grid-text.ts                                        [3D; additions via proposal]
│  │  └─ scenes/<scene-id>/{index.ts, meta.json, *.ts}                                          [SC-<id>] (23 folders)
│  ├─ client/    theme-init.ts popovers.ts filters.ts compare.ts progress.ts search-loader.ts    [DS / PG-x]
│  └─ pages/     (routes, §4)                                                                     [PG-x]
│     └─ dev/scenes/[id].astro   scene sandbox; getStaticPaths returns [] in PROD                [3D]
│     └─ dev/[page].astro        /dev/charts/, /dev/components/ (_charts, _components); [] in PROD  [DS / CH]
├─ src/assets/scene-posters/<scene-id>.webp   committed, regenerated by `npm run posters`         [QA]
└─ tests/  e2e/*.spec.ts  scenes/*.spec.ts  a11y/*.spec.ts  helpers/                             [QA]
```

**Boundary rules**

1. A content or scene agent writes **only** the files on its assignment list. All paths derive from ids.
2. Registries under `src/data/*-index.yaml` and `roster.yaml`, plus `src/schemas/**`, `content.config.ts` and `package.json`, are frozen after Phase 0. Changes go through `proposals/`.
3. Scenes are discovered with `import.meta.glob('/src/three/scenes/*/index.ts')`, and scene metadata with `import.meta.glob('/src/three/scenes/*/meta.json', { eager: true })`. Adding a scene therefore never touches a shared file.
4. Content never contains raw internal links. Authors use `<LearnLink>`, `<CompanyChip>` and similar components so the base path always works. A lint rule enforces this.

---

## 3. Content collections

### 3.1 Format per collection

| Collection | Format | Loader | Why |
|---|---|---|---|
| `learn` | MDX + YAML frontmatter | `glob('*.mdx')` | Long prose that embeds components (Term, Scene3D, charts, diagrams, DeepDive). |
| `segments` | MDX + YAML frontmatter | `glob` | Structured metrics plus a narrative split into levels (`<LevelSection level={1..3}>`). |
| `companies` | MDX + YAML frontmatter | `glob` | Structured profile in frontmatter. Optional body (required for `profile: full`) for analysis with cross-link chips. YAML is readable, allows comments and handles multi-line zh text. |
| `financials` | **JSON** | `glob('*.json')` | Numeric and tabular. May be machine-written or bulk-updated. Kept separate so fact-checkers can edit numbers without touching prose. No YAML type coercion traps (tickers, dates, `NO`). |
| `models` | MDX + YAML frontmatter | `glob` | Versions, pricing and benchmarks in frontmatter. Body holds the 特性分析 prose. |
| `trends` | MDX + YAML frontmatter | `glob` | Narrative with structured signals and counterpoints. |
| `glossary` | **YAML**, one term per file | `glob('*.yaml')` | Short, dictionary-shaped and easy to hand-edit. Separate files mean parallel agents never collide. |
| `sources` | **YAML**, one publisher/registry per file | `glob` | Curated list of primary sources (IR sites, MOPS, SEC EDGAR, standards bodies). Most citations are inline objects that follow the shared `Source` shape. |
| `pages` | MDX | `glob` | Singleton intros (home, chain, taiwan, methodology, about). |
| scene meta | JSON (not a collection) | `import.meta.glob` | Validated by a script. |

**YAML hygiene (written into the style guide):**
- Quote all tickers (`"2330"`), periods, dates and anything that looks like a number or boolean.
- Dates are `YYYY-MM-DD` strings. The `IsoDate` preprocessor also accepts a `Date` object because the YAML parser may coerce it.

### 3.2 Schema factory

Scripts must validate a single file **without** the `astro:content` virtual module, so every schema is built from a passed-in `ref`.

```ts
// src/schemas/refs.ts
import type { z } from 'astro/zod';
export type CollectionName =
  | 'learn' | 'segments' | 'companies' | 'financials' | 'models'
  | 'trends' | 'glossary' | 'sources' | 'pages';
// Astro's reference() at build time; a registry-checking stub in scripts.
export type Ref = (c: CollectionName) => z.ZodType<{ collection: string; id: string }, string>;
```
```ts
// src/content.config.ts
import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { makeSchemas, type Ref } from '@schemas/index';
const S = makeSchemas(reference as unknown as Ref);
const g = (dir: string, pattern: string) => glob({ base: `./src/content/${dir}`, pattern });
export const collections = {
  learn:      defineCollection({ loader: g('learn', '*.mdx'),       schema: S.learn }),
  segments:   defineCollection({ loader: g('segments', '*.mdx'),    schema: S.segment }),
  companies:  defineCollection({ loader: g('companies', '*.mdx'),   schema: S.company }),
  financials: defineCollection({ loader: g('financials', '*.json'), schema: S.financials }),
  models:     defineCollection({ loader: g('models', '*.mdx'),      schema: S.model }),
  trends:     defineCollection({ loader: g('trends', '*.mdx'),      schema: S.trend }),
  glossary:   defineCollection({ loader: g('glossary', '*.yaml'),   schema: S.glossary }),
  sources:    defineCollection({ loader: g('sources', '*.yaml'),    schema: S.sourceRegistry }),
  pages:      defineCollection({ loader: g('pages', '*.mdx'),       schema: S.page }),
};
```
In `scripts/validate-data.ts`, `ref = (c) => z.string().transform(id => ({ collection: c, id }))`. Afterwards every id is checked against the registry YAML (`--only` mode) or against the files on disk (full mode).

### 3.3 Common schemas

```ts
// src/schemas/common.ts
import { z } from 'astro/zod';

export const SEGMENT_IDS = [
  'energy-power', 'semi-equipment-materials', 'foundry-packaging', 'memory-storage',
  'eda-ip-design', 'ai-accelerators', 'networking-optics', 'servers-systems',
  'datacenter-infra', 'cloud-neocloud', 'foundation-models', 'devtools-data-mlops',
  'apps-agents', 'physical-ai',
] as const;

export const SCENE_IDS = [
  'chain-panorama', 'learn-mountain', 'company-globe', 'model-space', 'trend-roadmap', 'taiwan-map',
  'concept-neural-net', 'concept-embedding-space', 'concept-scaling-surface',
  ...SEGMENT_IDS.map((s) => `seg-${s}` as const),
] as const;
export const SceneId = z.enum(SCENE_IDS as unknown as [string, ...string[]]);

export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case ASCII only');
export const IsoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.iso.date(),
);
export const PartialDate = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/);
export const Level = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const Currency = z.enum(['USD','TWD','JPY','KRW','EUR','CNY','HKD','GBP','CHF','CAD','SEK','DKK','ILS','INR','SGD','AUD']);
export const Region = z.enum(['TW','US','CN','JP','KR','EU','UK','IL','IN','CA','ME','SEA','OTHER']);

export const Editorial = z.strictObject({
  status: z.enum(['stub', 'draft', 'researched', 'fact-checked']),
  author: z.string(),                 // agent id
  checkedBy: z.string().optional(),   // must differ from author when status = fact-checked
  checkedOn: IsoDate.optional(),
});

export const SourceType = z.enum([
  'filing','annual-report','ir-presentation','earnings-call','press-release','monthly-revenue',
  'company-site','paper','docs','standard','government','dataset','leaderboard','news','analyst','book','other',
]);

export const Source = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(), // for <Cite k="…"/> in MDX bodies
  registry: z.string().optional(),     // id in `sources` collection (checked by validator)
  title: z.string().min(2),
  publisher: z.string().min(2),
  url: z.url(),
  type: SourceType,
  lang: z.enum(['zh-TW','zh-CN','en','ja','ko','de','fr','other']).default('en'),
  published: IsoDate.optional(),
  accessed: IsoDate,
  archiveUrl: z.url().optional(),
  note: z.string().optional(),
});

export const DatedValue = z.strictObject({
  label: z.string(),            // zh label e.g. 「全球 EUV 曝光機市占」
  value: z.string(),            // display string e.g. "≈100%" (numbers with units)
  asOf: IsoDate,
  source: Source,
});
```

### 3.4 Collection schemas (inside `makeSchemas(ref)`)

```ts
// learn
const learn = z.strictObject({
  title: z.string().min(4).max(40),
  subtitle: z.string().max(60).optional(),
  description: z.string().min(40).max(160),             // meta description (zh)
  level: Level,
  order: z.number().int().min(101).max(399),            // 1xx/2xx/3xx = level
  track: z.enum(['foundations', 'models', 'hardware', 'infra-business', 'society']),
  prerequisites: z.array(ref('learn')).default([]),
  next: z.array(ref('learn')).max(3).default([]),        // explicit override; else computed
  relatedSegments: z.array(ref('segments')).default([]),
  relatedCompanies: z.array(ref('companies')).default([]),
  relatedModels: z.array(ref('models')).default([]),
  relatedTrends: z.array(ref('trends')).default([]),
  glossary: z.array(ref('glossary')).default([]),        // must list every <Term id> used in body
  scenes: z.array(z.strictObject({ id: SceneId, variant: z.string().optional() })).default([]),
  keyTakeaways: z.array(z.string().max(80)).min(3).max(6),
  estimatedMinutes: z.number().int().min(3).max(45),
  sources: z.array(Source).min(3),
  updated: IsoDate,
  lastVerified: IsoDate,
  editorial: Editorial,
}).superRefine((d, ctx) => {
  if (Math.floor(d.order / 100) !== d.level)
    ctx.addIssue({ code: 'custom', path: ['order'], message: 'order hundreds digit must equal level' });
});

// segments
const segment = z.strictObject({
  title: z.string(),                                  // 「晶圓代工與先進封裝」
  titleEn: z.string(),
  order: z.number().int().min(1).max(14),
  layer: z.enum(['foundation', 'silicon', 'systems', 'cloud-models', 'applications']),
  tagline: z.string().max(60),
  description: z.string().min(40).max(160),
  upstream: z.array(ref('segments')),
  downstream: z.array(ref('segments')),
  scene: SceneId,
  scope: z.strictObject({ includes: z.array(z.string()).min(2), excludes: z.array(z.string()).default([]) }),
  concentration: z.enum(['monopoly', 'oligopoly', 'competitive', 'fragmented']),
  bottleneck: z.strictObject({ level: z.number().int().min(1).max(5), note: z.string() }),
  keyMetrics: z.array(DatedValue).default([]),
  marketSize: z.array(z.strictObject({
    year: z.number().int(), value: z.number().positive(), unit: z.enum(['million', 'billion']),
    currency: Currency, status: z.enum(['actual', 'estimate', 'forecast']), definition: z.string(), source: Source,
  })).default([]),
  featuredCompanies: z.array(ref('companies')).min(3).max(12),
  taiwanRole: z.string().min(20),
  relatedLearn: z.array(ref('learn')).default([]),
  relatedTrends: z.array(ref('trends')).default([]),
  glossary: z.array(ref('glossary')).default([]),
  sources: z.array(Source).min(3),
  lastVerified: IsoDate,
  editorial: Editorial,
});

// companies
const Listing = z.strictObject({
  exchange: z.enum(['NASDAQ','NYSE','TWSE','TPEx','TSE','KRX','KOSDAQ','HKEX','SSE','SZSE','STAR',
                    'Euronext','LSE','XETRA','SIX','TASE','NSE','OTC','other']),
  ticker: z.string().min(1),                 // ALWAYS quoted in YAML
  primary: z.boolean().default(true),
  adr: z.boolean().default(false),
});
const Product = z.strictObject({
  name: z.string(), nameZh: z.string().optional(),
  category: z.string(),                      // 「GPU」「HBM」「乙太網路交換器」…
  segment: ref('segments').optional(),
  launched: PartialDate.optional(),
  status: z.enum(['shipping', 'sampling', 'announced', 'roadmap', 'eol']),
  description: z.string().min(10),
  specs: z.array(z.strictObject({ label: z.string(), value: z.string() })).default([]),
  source: Source.optional(),
});
const Technology = z.strictObject({
  name: z.string(), description: z.string().min(10),
  maturity: z.enum(['research', 'pilot', 'production', 'mature']),
  glossary: z.array(ref('glossary')).default([]),
  source: Source.optional(),
});
const TimelineEvent = z.strictObject({
  date: PartialDate, title: z.string(), detail: z.string().optional(),
  kind: z.enum(['founding','ipo','product','deal','funding','acquisition','policy','milestone','leadership','other']),
  source: Source.optional(),
});
const Relationship = z.strictObject({
  company: ref('companies'),
  type: z.enum(['supplier', 'customer', 'partner', 'investor', 'investee', 'competitor']),
  note: z.string().optional(), source: Source.optional(),
});
const Unit = z.strictObject({          // business units without their own file: AWS, Google Cloud, DeepMind, Waymo, TPU…
  id: Slug, name: z.string(), nameZh: z.string(), segment: ref('segments'), description: z.string(),
});
const Funding = z.strictObject({
  date: PartialDate, round: z.string(),
  amountUsdM: z.number().positive().optional(), valuationUsdM: z.number().positive().optional(),
  investors: z.array(z.string()).default([]), source: Source,
});
const company = z.strictObject({
  name: z.string(),                          // 'TSMC'
  nameZh: z.string(),                        // '台積電'
  legalName: z.string(),
  aliases: z.array(z.string()).default([]),  // English/Chinese variants, tickers (search)
  website: z.url(),
  hq: z.strictObject({
    city: z.string(), cityZh: z.string(), country: z.string().length(2),
    lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
  }),
  region: Region,
  founded: z.number().int().min(1800).max(2026),
  employees: z.strictObject({ value: z.number().int().positive(), asOf: IsoDate, source: Source }).optional(),
  ownership: z.enum(['listed', 'private', 'subsidiary', 'state-owned', 'nonprofit']),
  listings: z.array(Listing).default([]),
  parent: ref('companies').optional(),
  primarySegment: ref('segments'),
  segments: z.array(ref('segments')).min(1),
  units: z.array(Unit).default([]),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),  // 1 = global leader, 2 = major, 3 = niche/startup
  stage: z.enum(['startup', 'scaleup', 'mature']),
  profile: z.enum(['full', 'compact']),
  summary: z.string().min(60).max(400),
  chainRole: z.string().min(20),             // 在產業鏈中的角色
  moat: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  products: z.array(Product).default([]),
  technologies: z.array(Technology).default([]),
  keyMetrics: z.array(DatedValue).default([]),
  competitors: z.array(ref('companies')).default([]),
  relationships: z.array(Relationship).default([]),
  funding: z.array(Funding).default([]),
  timeline: z.array(TimelineEvent).default([]),
  models: z.array(ref('models')).default([]),
  hasFinancials: z.boolean(),                // must match existence of financials/<slug>.json
  sources: z.array(Source).min(1),
  lastVerified: IsoDate,
  editorial: Editorial,
}).superRefine((c, ctx) => {
  const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (c.ownership === 'listed' && c.listings.length === 0) add('listings', 'listed company needs ≥1 listing');
  if (!c.segments.some((s) => s.id === c.primarySegment.id)) add('segments', 'segments must include primarySegment');
  if (c.ownership === 'subsidiary' && !c.parent) add('parent', 'subsidiary needs parent');
  if (c.profile === 'full') {
    if (c.products.length < 3) add('products', 'full profile needs ≥3 products');
    if (c.technologies.length < 2) add('technologies', 'full profile needs ≥2 technologies');
    if (c.timeline.length < 5) add('timeline', 'full profile needs ≥5 timeline events');
    if (c.sources.length < 4) add('sources', 'full profile needs ≥4 sources');
    if (c.ownership === 'listed' && !c.hasFinancials) add('hasFinancials', 'listed full profile needs financials');
  }
  if (c.ownership === 'private' && c.stage !== 'mature' && c.funding.length === 0)
    add('funding', 'private startup should list funding (or explain in summary)');
});

// financials (JSON)
const PeriodLabel = z.string().regex(/^(FY\d{4}(-Q[1-4]|-H[12])?|\d{4}-(0[1-9]|1[0-2]))$/); // FY2027-Q2 | FY2025 | 2026-08
const FinPoint = z.strictObject({
  period: PeriodLabel,
  start: IsoDate, end: IsoDate,
  value: z.number().finite(),
  status: z.enum(['reported', 'restated', 'preliminary', 'estimate', 'guidance']).default('reported'),
  estimateBasis: z.string().optional(),
  src: z.string(),                       // key into financials.sources
  note: z.string().optional(),
}).refine((p) => p.start < p.end, 'start must precede end')
  .refine((p) => p.status !== 'estimate' || !!p.estimateBasis, 'estimate requires estimateBasis');
const Series = z.strictObject({
  metric: z.enum(['revenue','gross-margin','operating-margin','operating-income','net-income',
                  'capex','rnd','free-cash-flow','arr','rpo','backlog']),
  periodType: z.enum(['quarter', 'half', 'year', 'month']),
  unit: z.enum(['thousand', 'million', 'billion', 'percent']),
  currency: Currency.optional(),                 // required unless unit = percent
  basis: z.enum(['GAAP', 'non-GAAP', 'IFRS', 'TIFRS', 'J-GAAP', 'K-IFRS', 'estimate']).default('GAAP'),
  label: z.string().optional(),
  points: z.array(FinPoint).min(1),
});
const MixSnapshot = z.strictObject({
  group: z.enum(['business-segment', 'platform', 'product', 'node', 'region', 'customer']),
  groupZh: z.string(),
  period: PeriodLabel, periodType: z.enum(['quarter', 'half', 'year']),
  basis: z.enum(['value', 'share']),
  unit: z.enum(['million', 'billion', 'percent']),
  currency: Currency.optional(),
  items: z.array(z.strictObject({ name: z.string(), nameZh: z.string(), value: z.number() })).min(2),
  src: z.string(),
});
const financials = z.strictObject({
  company: ref('companies'),
  reportingCurrency: Currency,
  accountingStandard: z.enum(['US-GAAP','IFRS','TIFRS','J-GAAP','K-IFRS','CAS','HKFRS','none']),
  fiscalYear: z.strictObject({
    endMonth: z.number().int().min(1).max(12),
    naming: z.enum(['end-year', 'start-year']),   // NVIDIA FY2027 ends Jan-2027 = end-year
    description: z.string(),                       // 「會計年度結束於每年一月最後一個星期日」
  }),
  series: z.array(Series).min(1),
  mix: z.array(MixSnapshot).default([]),
  guidance: z.array(z.strictObject({
    forPeriod: PeriodLabel, metric: z.literal('revenue'),
    low: z.number(), high: z.number(), unit: z.enum(['million', 'billion']), currency: Currency,
    issued: IsoDate, src: z.string(),
  })).default([]),
  sources: z.record(z.string(), Source),
  lastVerified: IsoDate,
  editorial: Editorial,
}).superRefine((f, ctx) => {
  for (const s of f.series) {
    if (s.unit !== 'percent' && !s.currency) ctx.addIssue({ code: 'custom', path: ['series'], message: `${s.metric}: currency required` });
    for (const p of s.points) if (!(p.src in f.sources)) ctx.addIssue({ code: 'custom', path: ['series'], message: `unknown src ${p.src}` });
  }
});

// models
const ModelVersion = z.strictObject({
  id: Slug, name: z.string(),
  released: IsoDate,
  status: z.enum(['announced', 'preview', 'ga', 'deprecated', 'retired']),
  tier: z.enum(['flagship', 'mid', 'small', 'reasoning', 'specialized']),
  weights: z.enum(['closed', 'open-weights', 'open-source']),   // open-source = weights + code + data/recipe
  license: z.string(),                                           // 'proprietary' | 'Apache-2.0' | 'MIT' | …
  architecture: z.enum(['dense', 'moe', 'hybrid', 'unknown']).default('unknown'),
  params: z.strictObject({
    totalB: z.number().positive().optional(), activeB: z.number().positive().optional(),
    disclosed: z.boolean(),
  }).optional(),
  modalitiesIn: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
  modalitiesOut: z.array(z.enum(['text', 'image', 'audio', 'video'])).min(1),
  contextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  knowledgeCutoff: PartialDate.optional(),
  reasoning: z.enum(['none', 'hybrid', 'always']).default('none'),
  availability: z.array(z.enum(['api', 'chat-app', 'cloud-marketplace', 'self-host', 'on-device'])).min(1),
  pricing: z.array(z.strictObject({
    asOf: IsoDate, inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative(),
    cachedInputPerMTok: z.number().nonnegative().optional(), currency: z.literal('USD'),
    tierNote: z.string().optional(), source: Source,
  })).default([]),
  benchmarks: z.array(z.strictObject({
    benchmark: z.string(),               // id in src/data/benchmarks.yaml
    score: z.number(), setting: z.string().optional(),     // 'pass@1, no tools'
    reportedBy: z.enum(['lab', 'third-party', 'leaderboard']),
    date: IsoDate, source: Source,
  })).default([]),
  notes: z.string().optional(),
});
const model = z.strictObject({
  title: z.string(),                       // 「Claude 系列」
  family: z.string(),
  lab: ref('companies').optional(),        // optional for non-company labs (e.g. TAIDE)
  labName: z.string(),
  labUnit: z.string().optional(),          // 'google-deepmind' (matches company.units[].id)
  origin: z.enum(['US', 'CN', 'EU', 'TW', 'KR', 'JP', 'IL', 'CA', 'ME', 'other']),
  summary: z.string().min(60).max(400),
  strengths: z.array(z.string()).min(2),
  weaknesses: z.array(z.string()).min(1),
  bestFor: z.array(z.string()).min(1),
  positioning: z.strictObject({            // 3D scatter coordinates
    capability: z.number().min(0).max(100),   // composite index (computed if method=computed)
    costIndex: z.number().min(0).max(100),    // log-scaled blended $/MTok → 0..100
    openness: z.number().min(0).max(1),       // 0 closed … 1 fully open
    method: z.enum(['computed', 'editorial']),
    asOf: IsoDate, note: z.string(),
  }),
  versions: z.array(ModelVersion).min(1),
  flagshipVersion: z.string(),
  relatedLearn: z.array(ref('learn')).default([]),
  glossary: z.array(ref('glossary')).default([]),
  sources: z.array(Source).min(3),
  lastVerified: IsoDate,
  editorial: Editorial,
}).superRefine((m, ctx) => {
  if (!m.versions.some((v) => v.id === m.flagshipVersion))
    ctx.addIssue({ code: 'custom', path: ['flagshipVersion'], message: 'must match versions[].id' });
});

// trends
const trend = z.strictObject({
  title: z.string(), description: z.string().min(40).max(160),
  category: z.enum(['hardware', 'software', 'market', 'policy']),
  horizon: z.enum(['near', 'mid', 'long']),                 // 2026–27 / 2028–30 / 2030+
  horizonYears: z.tuple([z.number().int(), z.number().int()]),
  confidence: z.enum(['high', 'medium', 'low']),
  confidenceRationale: z.string().min(20),
  impact: z.enum(['high', 'medium', 'low']),
  signals: z.array(z.strictObject({ text: z.string(), date: IsoDate.optional(), source: Source.optional() })).min(2),
  counterpoints: z.array(z.string()).min(1),
  relatedSegments: z.array(ref('segments')).min(1),
  relatedCompanies: z.array(ref('companies')).default([]),
  relatedModels: z.array(ref('models')).default([]),
  relatedLearn: z.array(ref('learn')).default([]),
  glossary: z.array(ref('glossary')).default([]),
  sources: z.array(Source).min(3),
  published: IsoDate, lastVerified: IsoDate,
  editorial: Editorial,
});

// glossary (YAML)
const glossary = z.strictObject({
  term: z.string(),                  // display, e.g. 'HBM'
  zh: z.string(),                    // 「高頻寬記憶體」
  en: z.string(),                    // 'High Bandwidth Memory'
  aliases: z.array(z.string()).default([]),
  category: z.enum(['ai-basics','llm','training','inference','hardware','semiconductor','packaging',
                    'memory','networking','datacenter','energy','cloud-business','policy','robotics']),
  level: Level,
  short: z.string().max(80),         // hover card
  definition: z.string().min(40).max(600),
  example: z.string().optional(),
  related: z.array(ref('glossary')).default([]),
  learnMore: z.array(ref('learn')).default([]),
  segments: z.array(ref('segments')).default([]),
  sources: z.array(Source).default([]),
  editorial: Editorial,
});

// curated sources registry (YAML)
const sourceRegistry = z.strictObject({
  name: z.string(), nameZh: z.string().optional(),
  kind: z.enum(['company-ir','regulator','exchange','government','standards-body','research-lab',
                'academic','media','analyst','dataset','leaderboard']),
  homepage: z.url(),
  reliability: z.enum(['primary', 'secondary', 'tertiary']),
  usage: z.string(),                 // how this site uses it
  notes: z.string().optional(),
});

// singleton pages
const page = z.strictObject({
  title: z.string(), description: z.string().max(160),
  updated: IsoDate, sources: z.array(Source).default([]), editorial: Editorial,
});

// scene meta.json (validated by script, not a collection)
const sceneMeta = z.strictObject({
  id: SceneId, title: z.string(),
  description: z.string().min(80),            // full text alternative (zh)
  variants: z.array(z.string()).min(1), defaultVariant: z.string(),
  steps: z.array(z.strictObject({ id: Slug, title: z.string(), caption: z.string(), variant: z.string().optional() })).default([]),
  hotspots: z.array(z.strictObject({
    id: Slug, label: z.string(), detail: z.string().optional(),
    glossary: z.string().optional(), href: z.string().optional(),
  })).default([]),
  data: z.enum(['none', 'segments', 'companies', 'models', 'trends', 'taiwan', 'curriculum']),
  budgetKB: z.number().int().max(80),          // gz budget of the scene chunk
});
```

---

## 4. Routes, templates, 3D embedding and cross-linking

### 4.1 Route table (zh-TW titles)

| Route | `<title>` | Template / key UI | 3D |
|---|---|---|---|
| `/` | AI 產業鏈全景｜從電力到智慧應用 | H1 hero text (the LCP element) above a full-bleed scene. Three entry cards: 入門／進階／深入, each opening its first article. A 14-segment strip coloured by layer. 「關鍵數字」 tiles, computed from data and cited. Hyperscaler capex MultiLine. Featured trends. Taiwan callout. Models callout. | `chain-panorama` variant `hero`, autoload `idle` |
| `/learn/` | 學習路徑：由淺入深看懂 AI | Mountain scene. Accessible 2D SVG learning-path DAG. Three level columns. Track filter (基礎／模型／硬體／基礎設施與商業／社會). Per-viewer ✓ read marks (localStorage in try/catch). No quizzes. | `learn-mountain` |
| `/learn/[slug]/` | `{title}｜學習路徑` | ArticleLayout: level badge, minutes, track. PrereqBox 「建議先讀」. Sticky TOC from `render().headings`. MDX body. KeyTakeaways 「重點整理」. DeepDive 「深入一點」 disclosure. Sources with `<Cite>` back-links. Related chips. **NextSteps**. Prev/next in path. | In-body `<Scene3D>`. The first is autoload `visible`; any later ones are click-to-load. |
| `/chain/` | 產業鏈總覽：五層十四環節 | Panorama in explore mode with a side panel synced to the scene through `scene:hotspot` events. Five layer explainers. Segment table (tagline, concentration, bottleneck 1–5, top companies, Taiwan role). **MarginLadder** chart: median gross margin of tier-1 listed companies per segment, shows the profit pools. Money-flow diagram. | `chain-panorama` variant `explore` |
| `/chain/[segment]/` | `{segment title}｜產業鏈` | Hero plus segment scene with guided steps. Body sections `<LevelSection level=1/2/3>`: 「這一環在做什麼」 → 「關鍵技術」 → 「深入議題」. Key metrics. Market-size chart (estimates hatched). Key players: tier-1 cards with sparkline, then a compact list grouped by tier. Units listed separately (e.g. AWS Trainium). Upstream and downstream segment nav. Taiwan players. Related learn and trends. | `seg-<id>` |
| `/companies/` | 公司資料庫：AI 產業鏈 300+ 家企業 | Collapsible globe. Filter bar: 環節 / 地區 / 層級 (一線・二線・三線與新創) / 上市與否; text search (name, aliases, tickers; NFKC + lowercase); sort (名稱 / 近四季營收 USD / YoY / 成立年份). Grid or list toggle. All cards are rendered server-side with `data-*` attributes; JS (~3 KB) toggles `hidden` and syncs URL params. Works without JS. Counter 「顯示 42／318 家」. | `company-globe` |
| `/companies/[slug]/` | `{nameZh}（{name}）：產品、技术與營收` *(write as 產品、技術與營收)* | ProfileLayout. Header (zh/en name, ticker chips, HQ, founded, employees, tier/profile badges, `lastVerified`). Summary. 「在產業鏈中的位置」 mini-chain SVG with segments highlighted. Products table. Technologies (glossary-linked). **營收表現**: quarterly RevenueBars with YoY line in native currency, toggle Q / annual / monthly (TW), USD note, estimate styling. SegmentMix stacked bars. Margins line. Guidance range. Key metrics. Competitors. Supplier/customer relationships. Funding (private). Timeline. MDX analysis body (full profiles). Sources. Compact profiles show summary, products, last 3 FY revenue and timeline only. | none (mini globe pin is static SVG) |
| `/models/` | 大模型特性分析：各家模型一次看懂 | 3D scatter with release-date slider (frontier over time). Lab/origin/open filters. Flagship comparison table. 「如何解讀評測」 intro from `pages/models-intro.mdx`. Family cards grouped by origin (美國／中國／歐洲／台灣／其他). 2D DotPlot fallback. | `model-space` |
| `/models/[slug]/` | `{family}：特性、版本與評測` | Lab chip. Summary. Strengths and weaknesses. Best-for. Version timeline. Spec table (context, modalities, params if disclosed, license). Pricing-history MultiLine. Benchmark DotPlot with dated sources and a "different dates" warning. 特性分析 body. | none |
| `/models/compare/` | 模型並排比較 | Select 2–4 versions via `?m=a,b,c`. Side-by-side spec, price and benchmark table, with a ⚠ when snapshot dates are more than 90 days apart. Strengths. No-JS default: preset flagship comparison. | none |
| `/trends/` | 未來趨勢：硬體、軟體、市場與政策 | Roadmap ribbon scene with four lanes over 2026→2031. Filters by category, horizon and confidence. Cards with confidence and impact badges. | `trend-roadmap` |
| `/trends/[slug]/` | `{title}｜未來趨勢` | 「觀察指標」 signals list, drivers, 「反方觀點」 counterpoints, affected segments, companies and models, sources. | optional segment scene variant |
| `/taiwan/` | 台灣 AI 供應鏈：從晶圓到伺服器 | Taiwan extruded map with science-park and cluster towers and supply arcs to the world. Segment × Taiwan-company matrix. **Monthly revenue Heatmap** (about 45 TW companies × 24 months, colour = YoY). AI-server division-of-labour diagram (chip, board, L6, L10, L11 rack). Policy and risks. | `taiwan-map` |
| `/glossary/` | 名詞解釋：AI 與半導體術語 | Grouped by category with level badges. Client filter. Anchor per term (`#hbm`). Each entry has related terms and backlinks ("出現在…"). | none |
| `/sources/` | 資料來源與研究方法 | Methodology from `pages/methodology.mdx`: fiscal normalisation, FX, estimate policy. Curated registry. Aggregated bibliography grouped by publisher, listing which pages cite each. **Data-freshness table** flagging entries with `lastVerified` older than 180 days. | none |
| `/about/` | 關於本站 | Purpose, editorial process, update cadence, disclaimer 「本站內容僅供教育參考，不構成投資建議」. | none |
| `/404` | 找不到頁面 | Search box and section links. | none |
| `/dev/scenes/[id]/` | (dev only) | Scene sandbox with variant/step/quality/theme toggles and a stats overlay. | all |

Every route has `data-pagefind-body` only on its main content. Listing pages (`/companies/`, `/glossary/` grid) are excluded so search hits point to entity pages.

### 4.2 The 3D system

**Scene catalogue (23).** Each scene has guided steps that go 由淺入深 (step 1 is the overview, later steps add detail).

| id | Theme | Variants used by articles |
|---|---|---|
| `chain-panorama` | Five stacked translucent layers holding 14 segment nodes. Particle flows: electrons → wafers → chips → racks → tokens → apps. Hover shows a card with top companies; click navigates. | `hero`, `explore` |
| `seg-energy-power` | Grid → substation → 1 GW campus. Power-flow lines. Mix toggle: gas / nuclear-SMR / solar+storage. | `grid`, `onsite` |
| `seg-semi-equipment-materials` | EUV light path: tin droplet + CO₂ laser → collector → reticle → mirrors → wafer stage. High-NA anamorphic toggle. | `euv`, `high-na` |
| `seg-foundry-packaging` | Transistor morph planar → FinFET → GAA nanosheet → CFET. Backside power. CoWoS / SoIC exploded view. | `transistor`, `bspdn`, `cowos` |
| `seg-memory-storage` | HBM stack: DRAM dies, TSVs, base die, bandwidth flow. Memory-hierarchy tower (latency vs capacity). | `hbm`, `hierarchy` |
| `seg-eda-ip-design` | Die floorplan "city" (cores, NoC, SerDes, HBM PHY). Hover shows IP block type. Zoom to standard cells. | `floorplan` |
| `seg-ai-accelerators` | GPU die exploded (SMs, tensor cores, L2, HBM). Systolic-array matmul animation. | `gpu-die`, `systolic` |
| `seg-networking-optics` | Rack NVLink domain vs leaf-spine scale-out with packet flows. CPO optical engine close-up. | `scale-up`, `scale-out`, `cpo` |
| `seg-servers-systems` | Rack-scale system exploded: compute trays, switch trays, power shelves, liquid manifold, with ODM labels. | `rack` |
| `seg-datacenter-infra` | Campus fly-through. Heat-flow comparison: air vs direct-to-chip vs immersion. PUE slider. Power chain. | `air`, `liquid`, `power-chain` |
| `seg-cloud-neocloud` | Globe of AI regions and campuses. Capex bars rise per hyperscaler. Token requests flowing in. | `globe` |
| `seg-foundation-models` | Tokens as cubes through Transformer layers with attention arcs. MoE router. | `attention`, `moe`, `layers` |
| `seg-devtools-data-mlops` | Data conveyor: crawl → filter → dedupe → tokenize → train → eval → deploy. RAG nearest-neighbour vector space. | `pipeline`, `rag` |
| `seg-apps-agents` | Agent loop: planner ↔ MCP tool satellites ↔ memory, animated tool calls. | `loop` |
| `seg-physical-ai` | Simple humanoid or arm rig plus a lidar point-cloud street. Sim-to-real toggle. | `robot`, `autonomy` |
| `learn-mountain` | Three terraces (L1/L2/L3). Article nodes. Prerequisite paths. Click opens the article. | — |
| `company-globe` | Dotted globe. HQ points sized by TTM revenue in USD and coloured by layer. City clustering (e.g. 新竹). Relationship arcs toggle. | — |
| `model-space` | 3D scatter: capability × cost (log) × openness, coloured by lab. Time slider. | — |
| `trend-roadmap` | Four-lane ribbon tunnel, 2026→2031. | — |
| `taiwan-map` | Extruded Taiwan with park and cluster towers and export arcs. | — |
| `concept-neural-net` | Interactive small MLP: weights as edge thickness, activations lighting up. | — |
| `concept-embedding-space` | Word or 詞 points drifting into semantic clusters; vector-arithmetic demo. | — |
| `concept-scaling-surface` | Loss surface over (params, tokens) with the compute-optimal ridge. | — |

**`Scene3D.astro` API:**
```astro
<Scene3D id="seg-foundry-packaging" variant="cowos" height="tall"
         autoload="visible" data={payload} caption="CoWoS 2.5D 封裝爆炸圖" />
```

What it renders:
- A `<figure class="scene">` whose aspect ratio is reserved, so CLS is 0.
- The poster `<Image>` from `src/assets/scene-posters/<id>.webp`, with a generic placeholder if it is missing.
- A `<figcaption>`.
- An `<ai-scene data-id data-variant data-autoload>` element, plus `<script type="application/json">` holding `data`.
- 「導覽」 step buttons (上一步／下一步) and an HTML hotspot list. These are keyboard and screen-reader equivalents of every 3D interaction.
- 「全螢幕」 and 「暫停動畫」 buttons.
- A `<details>` 「場景文字說明」 that holds `meta.description`.

The only always-loaded code is a single bundled Astro `<script>` (about 3 KB gz) that defines `<ai-scene>`. Astro deduplicates it across instances.

**Lifecycle (`core/element.ts`, `loader.ts`, `engine.ts`):**

1. Check WebGL2 first. If context creation fails, set `data-state="fallback"` and keep the poster.
2. Loading triggers:
   - `autoload="visible"`: IntersectionObserver with `rootMargin: 200px`.
   - `"idle"`: after `load` plus `requestIdleCallback` (2 s timeout). Used on the home hero so LCP stays the H1.
   - `"click"`: a 「載入互動 3D」 button.
3. Then `Promise.all([import('three'), sceneLoaders[id]()])`. `three` becomes one shared, cached chunk; each scene is its own chunk. Do not use `manualChunks`.
4. The engine creates a `WebGLRenderer({ antialias: quality !== 'low', alpha: true, powerPreference: 'high-performance' })`.
   - DPR is clamped to `min(devicePixelRatio, quality === 'high' ? 2 : 1.5)`.
   - Resizing uses ResizeObserver.
   - Rendering is **render-on-demand**: `invalidate()` requests a frame and `setAnimating(true)` runs the continuous loop.
   - The loop pauses when the element is offscreen or `document.hidden` is true.
   - An adaptive FPS monitor drops a quality step when the average frame time stays above 22 ms for 2 s.
5. At most **two live WebGL contexts per page**. When a third starts, the context farthest offscreen is disposed (`dispose()` + `forceContextLoss()`) and goes back to its poster.
6. `pagehide` disposes everything. The core traverses the scene and disposes geometries, materials and textures as a safety net.
7. `prefers-reduced-motion` turns off auto-rotate, particles and camera tours. The scene renders a static frame and only changes on user input.
8. Touch: page scroll is never hijacked. The canvas uses `touch-action: pan-y` until a tap activates 「互動模式」, which then enables OrbitControls with two-finger rotate. Esc or the 「離開」 button deactivates it.
9. Text uses HTML labels (`CSS2DRenderer` from `three/addons`) so zh-TW renders crisply in system fonts and can be selected and read aloud. There are no SDF CJK font atlases.
10. Theme: `core/theme.ts` reads CSS tokens (`--scene-*`, `--layer-*`) and re-applies them on `data-theme` change via a MutationObserver.
11. Events: the element dispatches `scene:ready`, `scene:hotspot` (`detail.id`) and `scene:step`, and listens for `scene:command` (`focus`, `step`, `variant`). Page panels such as the `/chain/` side panel stay in sync with the scene this way.
12. Test hook: `element.stats` returns `{ frames, drawCalls, triangles, quality, state }`. `data-state` takes the values `loading | ready | fallback | error`.

**Scene contract (`src/three/core/types.ts`):**
```ts
import type * as THREE from 'three';
export type Quality = 'low' | 'medium' | 'high';
export interface SceneContext {
  root: HTMLElement; renderer: THREE.WebGLRenderer; scene: THREE.Scene;
  camera: THREE.PerspectiveCamera; controls: import('three/addons/controls/OrbitControls.js').OrbitControls;
  labels: LabelLayer; theme: ThemeTokens & { onChange(cb: () => void): () => void };
  quality: Quality; reducedMotion: boolean; variant: string; data: unknown; base: string;
  invalidate(): void; setAnimating(on: boolean): void;
  hotspots: { register(id: string, obj: THREE.Object3D): void; highlight(id: string | null): void };
  emit(type: 'hotspot' | 'step' | 'navigate', detail?: unknown): void;
}
export interface SceneHandle {
  update?(dt: number, t: number): void;
  setVariant?(v: string): void; goToStep?(i: number): void; focus?(hotspotId: string | null): void;
  dispose(): void;
}
export type SceneSetup = (ctx: SceneContext) => SceneHandle | Promise<SceneHandle>;
// src/three/scenes/<id>/index.ts:  export default (async (ctx) => {...}) satisfies SceneSetup;
```

**Scene rules:**
- Procedural geometry only. GLTF needs a proposal and must stay under 500 KB.
- No post-processing composer; fake glow with additive sprites.
- No shadows. Use baked gradients or matcaps.
- Use `InstancedMesh` for anything that has more than 50 copies.
- Scene data is validated inside the scene with a small type guard.
- Never fetch at runtime, except the pre-generated `src/data/geo/*` assets imported as JSON modules.

### 4.3 Cross-linking

- **`<Term id="hbm">HBM</Term>`** renders a `<button class="term" popovertarget="tc-hbm-N">` styled with a dotted underline, plus a `<span popover id=… role="tooltip">` card holding `short`, zh/en names, a level badge and a link 「完整解釋 →」 to `/glossary/#hbm`.
  - The native Popover API gives tap or Enter to open, Esc and light-dismiss for free, with zero JS.
  - A ~1 KB script adds hover-intent opening on fine pointers.
  - Positioning uses CSS anchor positioning where supported and falls back to a bottom sheet under 640 px.
  - Use `<span popover>`, **never `<div>`**, inside prose so the HTML stays valid under the strict compiler.
  - Only the first occurrence in an article is interactive. Later ones are plain text.
- **`<CompanyChip id>`**, **`<ModelChip id>`** and **`<SegmentChip id>`** are links with popover preview cards. A company card shows name, segment, latest TTM revenue and YoY. Everything is computed at build time.
- **Knowledge graph (`lib/graph.ts`).** Built once per build from all collections. Nodes are segment, company (and units), model, learn, trend and term. Edges come from `primarySegment`/`segments`, `relatedX`, `model.lab`, `competitors`, `relationships` and `glossary`. It drives:
  - the "Related" blocks,
  - company backlinks (「本站提及此公司的文章」),
  - glossary backlinks,
  - the panorama data (top 3 companies per segment by TTM USD revenue, excluding estimates),
  - the Taiwan matrix.
- **NextSteps (learn).**
  1. `next[]` if set.
  2. Otherwise, the next `order` article in the same track.
  3. The lowest-order article at level + 1 whose prerequisites include this one (「準備好進階了嗎？」).
  4. One related segment page.
  5. One related trend.

  Prev/next in the global path appear at the bottom.
- **Segment pages** link upstream and downstream segments with arrow cards. **Company pages** highlight their segments on the mini-chain.

---

## 5. Curriculum (由淺入深)

The global path is ordered by `order`. `scripts/validate-data.ts` checks that every prerequisite has a lower `order` and that the graph is acyclic.

Body length targets, in Chinese characters: L1 2,000–3,000; L2 3,000–5,000; L3 4,000–7,000.

Template for every article:
1. 一句話解釋
2. 生活化比喻
3. 原理
4. `DeepDive` 深入一點
5. 產業鏈連結, with company and segment chips
6. 重點整理
7. Sources

### Level 1 · 入門 (10)

| order | slug | 標題 | Outline | Prereqs | Track / scene |
|---|---|---|---|---|---|
| 101 | `what-is-ai` | 什麼是 AI？人工智慧、機器學習與深度學習 | From writing rules to learning from data. How AI ⊃ ML ⊃ DL, with everyday examples. Why generative AI took off after 2022. | — | foundations |
| 102 | `ai-supply-chain-map` | 一張圖看懂 AI 產業鏈 | Five layers and 14 segments, from electricity to applications. Who pays whom, and where the bottlenecks are. | (101) | infra-business · `chain-panorama` |
| 103 | `how-machines-learn` | 機器如何學習：資料、模型、訓練與推論 | Loss functions and gradient descent (the "walking downhill" analogy). Training, validation and test sets. Overfitting. Training vs inference. | 101 | foundations |
| 104 | `neural-networks-101` | 神經網路入門：神經元、權重與層 | Activation functions. Forward and backward passes at an intuitive level. Why depth helps. What "parameter count" means. | 103 | foundations · `concept-neural-net` |
| 105 | `what-is-llm` | 大型語言模型是什麼：從「預測下一個字」開始 | Tokens, probability distributions, sampling and temperature. Where hallucinations come from. A chatbot = model + post-training + product. | 104 | models |
| 106 | `why-gpus` | 為什麼 AI 需要 GPU？ | Matrix multiplication and parallelism. CPU vs GPU. Memory bandwidth. A first look at the CUDA ecosystem. | 104 | hardware · `seg-ai-accelerators:gpu-die` |
| 107 | `how-chips-are-made` | 晶片是怎麼做出來的？ | Design → mask → wafer fab (lithography, etch, deposition) → packaging and test. Why fabs cost so much. The foundry model and TSMC. | 102 | hardware |
| 108 | `data-centers-101` | 資料中心入門：AI 工廠長什麼樣子 | Racks, servers, switches, power and cooling. How big an MW and a GW are. Why AI is driving electricity demand up. | 106 | infra-business · `seg-datacenter-infra` |
| 109 | `cloud-and-ai-business` | 雲端與 AI 的商業模式 | IaaS, PaaS and SaaS. GPU rental. Per-token API pricing and subscriptions. How money flows along the chain. | 105 | infra-business |
| 110 | `ai-apps-and-agents-101` | AI 能做什麼？從聊天機器人到 Agent 與機器人 | Writing, coding, search, image and video generation. What agents are. Robots and autonomous driving. Limits, risks and responsible use. | 105 | models |

### Level 2 · 進階 (14)

| order | slug | 標題 | Outline | Prereqs | Track / scene |
|---|---|---|---|---|---|
| 201 | `tokens-and-embeddings` | Token 與嵌入向量：模型如何讀懂文字 | BPE tokenization and how efficiently Chinese tokenizes. Embedding space and semantic distance. Positional information. | 105 | models · `concept-embedding-space` |
| 202 | `transformer-and-attention` | Transformer 與注意力機制 | Q/K/V and multi-head attention. FFN, residual connections and normalization. Why training parallelizes. A first look at the KV cache. | 201, 104 | models · `seg-foundation-models:attention` |
| 203 | `pretraining-to-chat` | 從預訓練到對話助理：SFT、RLHF 與對齊 | Pretraining data and objectives. Instruction tuning. Preference learning (RLHF and DPO, conceptually). System prompts and safety behaviour. | 202 | models |
| 204 | `reasoning-models` | 推理模型：讓 AI 先想再答 | Chain of thought. Test-time compute. RLVR (reinforcement learning from verifiable rewards) as a concept. Thinking budgets and the cost trade-off. | 203 | models |
| 205 | `multimodal-models` | 多模態模型：看、聽、說、畫 | Vision encoders (ViT) vs natively multimodal models. Diffusion vs autoregressive generation. Video and speech models. | 202 | models |
| 206 | `rag-and-vector-search` | RAG 與向量檢索：讓模型查資料 | Chunking, embeddings and vector databases. Hybrid retrieval and reranking. Long context vs RAG. Evaluating retrieval. | 201 | models · `seg-devtools-data-mlops:rag` |
| 207 | `agents-and-mcp` | AI Agent 與 MCP：讓模型使用工具 | Tool calling. The plan → act → observe loop. MCP architecture (hosts, clients, servers). Computer-use agents. Permissions and prompt injection. | 203, 206 | models · `seg-apps-agents` |
| 208 | `open-vs-closed-models` | 開放權重 vs 封閉模型 | The licence spectrum. Cost, privacy and customisation trade-offs. US vs China open-weights ecosystems. Fine-tuning and distillation. | 203 | models |
| 209 | `gpu-architecture` | GPU 與 AI 加速器架構 | SMs and Tensor Cores. FP16 → FP8 → FP4. GPU vs TPU vs custom ASIC. CUDA and the software moat. | 106 | hardware · `seg-ai-accelerators:systolic` |
| 210 | `training-vs-inference-economics` | 訓練與推論的經濟學 | One-off training cost vs ongoing inference cost. MFU and utilisation. Breaking down cost per million tokens. Why inference demand grows faster. | 109, 209 | infra-business |
| 211 | `semiconductor-process-nodes` | 製程節點：從 7 奈米到 2 奈米代表什麼 | Node names vs physical dimensions. Density and PPA. Yield and wafer cost. The foundry race (TSMC, Samsung, Intel). | 107 | hardware |
| 212 | `advanced-packaging-intro` | 先進封裝入門：CoWoS 與 Chiplet | Why packaging became the AI bottleneck. 2.5D vs 3D. Interposers. Chiplets and UCIe. Taiwan's OSAT chain. | 211 | hardware · `seg-foundry-packaging:cowos` |
| 213 | `memory-and-hbm` | 記憶體牆與 HBM | The gap between compute and bandwidth. SRAM / HBM / DRAM hierarchy. How HBM is stacked. The three suppliers and their capacity. | 209 | hardware · `seg-memory-storage:hbm` |
| 214 | `networking-for-ai` | AI 叢集網路：Scale-up 與 Scale-out | NVLink and rack-scale systems. InfiniBand vs Ethernet (Ultra Ethernet). Switches and optical modules. All-Reduce. | 108, 209 | hardware · `seg-networking-optics:scale-up` |

### Level 3 · 深入 (14)

| order | slug | 標題 | Outline | Prereqs | Track / scene |
|---|---|---|---|---|---|
| 301 | `scaling-laws` | 縮放定律與運算最適化 | Kaplan vs Chinchilla. Compute-optimal training. The data wall and synthetic data. Inference-time scaling. The debate about where scaling goes next. | 203, 210 | models · `concept-scaling-surface` |
| 302 | `post-training-deep` | 後訓練深入：RLHF、DPO、RLVR 與蒸餾 | Reward models. PPO and GRPO. Verifiable rewards. Reward hacking. Controlling thinking length. Distilling small models. | 204 | models |
| 303 | `mixture-of-experts` | 混合專家模型（MoE）深入 | Routing and load balancing. Sparse activation. Expert parallelism and all-to-all traffic. Memory implications. Representative open MoE models. | 202, 214 | models · `seg-foundation-models:moe` |
| 304 | `inference-optimization` | 推論最佳化：KV Cache、量化、推測解碼與分離式推論 | PagedAttention. FP8/FP4 quantisation. Speculative decoding. Prefill/decode disaggregation. Batching vs latency. Tokens/s/W. | 210, 213 | infra-business |
| 305 | `model-evaluation` | 模型評測：Benchmark、競技場與 Agent 評測 | Major benchmarks (MMLU-Pro, GPQA, SWE-bench, HLE, ARC-AGI, etc.). Contamination and saturation. Arena voting. Task-length evaluations. How to run your own eval. | 204 | models |
| 306 | `transistor-evolution` | 電晶體演進：FinFET、GAA、CFET 與背面供電 | Short-channel effects. FinFET → nanosheet GAA. Backside power delivery (BSPDN). CFET and 2D-material outlook. | 211 | hardware · `seg-foundry-packaging:transistor` / `:bspdn` |
| 307 | `lithography-euv-high-na` | 微影深入：EUV 與 High-NA EUV | 13.5 nm tin-plasma source. Reflective optics. The Rayleigh criterion and NA (via `MathTeX`). Multi-patterning vs High-NA. Cost, throughput and the ASML supply chain. | 211 | hardware · `seg-semi-equipment-materials:euv` / `:high-na` |
| 308 | `advanced-packaging-deep` | 先進封裝深入：CoWoS-L、SoIC、混合鍵合與面板級封裝 | CoWoS-S vs -R vs -L. Hybrid bonding. Glass substrates. Panel-level packaging. Capacity and yield constraints. | 212 | hardware |
| 309 | `hbm-deep` | HBM 深入：TSV、堆疊與 HBM4 客製化 | TSVs. MR-MUF vs TC-NCF. Stack height. The HBM4 base die moving to logic processes. Bandwidth and power roadmap. | 213, 308 | hardware |
| 310 | `interconnect-deep` | 互連深入：SerDes、CPO 與 Scale-up 標準之爭 | 224G SerDes. Copper vs optics. LPO and CPO. NVLink Fusion vs UALink. Ultra Ethernet. | 214 | hardware · `seg-networking-optics:cpo` |
| 311 | `datacenter-power-cooling` | 資料中心電力與散熱深入 | Rack power-density trajectory. 800 V DC distribution. Direct-to-chip and immersion cooling. PUE and WUE. Grid interconnection and on-site generation (gas, nuclear, storage). | 108, 214 | infra-business · `seg-datacenter-infra:liquid` |
| 312 | `ai-capex-economics` | AI 資本支出與雲端經濟學 | Hyperscaler capex trends. Depreciation lives. GPU rental prices. How neoclouds are financed. AI ROI and the bubble debate. | 210 | infra-business |
| 313 | `ai-safety-and-regulation` | AI 安全、治理與法規 | Alignment and interpretability. Frontier safety frameworks. The EU AI Act. US chip export controls. Taiwan's AI basic law and sovereign AI. | 208 | society |
| 314 | `physical-ai-deep` | 實體 AI 深入：機器人、自駕與世界模型 | VLA models. Simulation and synthetic data. World models. Edge compute chips. State of commercialisation. | 205, 207 | society · `seg-physical-ai` |

The 主線 is the order sequence 101 → 314. Three suggested shortcuts are shown on `/learn`:
- 模型線: 101–105 → 201–208 → 301–305
- 硬體線: 101–107 → 209, 211–214 → 306–310
- 產業線: 102, 108–110 → 210 → 311–312

---

## 6. Revenue and financial presentation

### 6.1 Storage and normalisation

**Periods.** Store the company-native label (`FY2027-Q2`, `FY2025`, `2026-08`) **plus exact `start`/`end` dates**. Calendarisation is computed in `lib/fiscal.ts` and never hand-entered.
- Calendar quarter is the quarter with the most overlapping days. Example: NVIDIA FY2027-Q2 (2026-04-27 → 2026-07-26) has 65 days in CQ2 and 26 in CQ3, so it maps to **CY2026 Q2**.
- Display label: 「FY27 Q2（約 2026 Q2，2026/4/27–7/26）」.
- Cross-company charts (capex comparison, segment rankings) use calendarised quarters. Single-company charts use native labels, with the calendar range in the tooltip.

**Fiscal-year conventions** live in `financials.fiscalYear` and are explained in a tooltip 「財年說明」. Examples:
- NVIDIA: last Sunday of January, end-year naming
- Micron: around end of August / early September
- Apple: late September
- Microsoft: 30 June
- Oracle: 31 May
- Broadcom: around early November
- Japanese companies: March, with naming that varies by company (`naming` flag)
- TSMC, Samsung, SK hynix: calendar year

**YoY** compares the same fiscal quarter of the prior fiscal year, not the calendar quarter. A 53-week year gets a note. **TTM** = sum of the last 4 consecutive quarters. It is shown only when the quarters are continuous and none is an estimate.

**Currency.**
- Store native currency and native unit. Display native first, e.g. 「新台幣 9,337 億元」 or 「4,674 億美元」. Chinese units come from `lib/format.ts`: 萬, 億 and 兆, where 1 兆 = 10¹².
- Show a USD conversion as a secondary line: 「≈ 297 億美元（以 2026 Q2 平均匯率 31.4 換算，僅供比較）」.
- `src/data/fx/usd-rates.json` holds period-average rates per currency for quarter, month and year, with sources. Use FRED / Fed H.10 series where available (DEXTAUS, DEXJPUS, DEXKOUS, DEXUSEU inverted, DEXCHUS, DEXHKUS, …) and fall back to ECB reference rates. It is generated by `npm run fx` and committed.
- Monthly points use monthly averages, quarterly points quarterly averages, annual points annual averages.
- Ranking and sorting by USD is labelled 「以美元換算」.

**Taiwan monthly revenue.**
- Source: MOPS 公開資訊觀測站 monthly revenue filings, published by the 10th of the following month. MOPS reports in 新台幣千元; store in TWD million.
- Coverage: full TW profiles keep 24 months; compact TW profiles at least 13 months (enough for YoY).
- Display MonthlyRevenue bars with MoM %, YoY % and cumulative YTD YoY. `/taiwan` adds a heatmap with rows = companies grouped by segment, columns = months, diverging colour = YoY.
- Monthly figures are unaudited and consolidated. A note says this, and the quarterly totals come from the financial statements.

**Private companies.**
- `status: 'estimate'` plus a required `estimateBasis`, e.g. 「依媒體報導之年化營收」 with source and date.
- ARR is its own metric and is never mixed with GAAP revenue.
- Rendering: hatched fill, dashed outline and an 「估計」 badge on the chart and in the table.
- Estimates are excluded from TTM, rankings and segment aggregates unless the viewer turns on 「包含估計值」.
- Funding rounds and valuations go in `company.funding`.

**Guidance** renders as a range whisker after the last actual bar, labelled 「公司財測」. **Restatements** use `status: 'restated'` with a note, and the latest value wins.

**Segment mix.** Stacked bars from `mix[]`. Share-based data (e.g. TSMC by platform or by node) is shown as 100% stacks. Value-based data is shown as absolute stacks.

### 6.2 Chart components (build-time SVG)

- `RevenueBars`: quarterly or annual bars, YoY line on a secondary axis, optional guidance whisker.
- `MonthlyRevenue`
- `SegmentMix`
- `Sparkline` (cards)
- `MultiLine` (capex, pricing)
- `DotPlot` (benchmarks)
- `Heatmap` (TW monthly)
- `MarginLadder` (segment profit pools)

Shared behaviour:
- Each is wrapped in `ChartFrame`: title, 「資料截至」 date, unit and currency line, source links, and a `<details>` 「顯示資料表」 with a real `<table>`.
- `viewBox`-responsive SVG with `role="img"` and an `aria-label` summary sentence generated from the data.
- Hover: one delegated `chart-tooltip.ts` reads `data-tip` on marks. Pointer only; keyboard users get the table.
- Colours: five layer hues (foundation / silicon / systems / cloud-models / applications) with lightness steps per segment, defined in `tokens.css` for both themes. Estimates use an SVG `<pattern>`. Text contrast is AA in both themes.

### 6.3 Build-time validation rules

These run in `scripts/validate-data.ts`. Errors fail CI; warnings print in the report.

**Errors**
1. Schema failure.
2. A reference to an id that does not exist (registry in `--only` mode, files in full mode).
3. `company.hasFinancials` does not match the presence of the JSON file.
4. A `src` key is missing from `sources`.
5. Duplicate `period` within a series.
6. `start`/`end` overlap between consecutive points.
7. Quarter length outside 84–98 days, or month length outside 28–31.
8. **Continuity:** tier-1 listed companies need **≥ 12 consecutive quarters** of revenue, with the latest `end` within 200 days of `lastVerified`. Tier-2 listed companies need ≥ 3 fiscal years.
9. Series currency differs from `reportingCurrency` without a note.
10. Negative revenue.
11. An `estimate` point without `estimateBasis`.
12. A share-basis mix that sums outside 98–102%.
13. A value-basis mix that differs from total revenue for the same period by more than 2%, unless it has an explicit 「其他」 item.
14. A TW-listed company without monthly revenue covering the last 13 months.
15. Any of `TODO`, `待查`, `XXX`, `lorem` anywhere in content.
16. Learn prerequisites with higher `order`, or a cycle.
17. A `<Term id>`, `<Cite k>` or `<Scene3D id>` used in a body but not declared or nonexistent.
18. A raw internal Markdown link `](/`.
19. `fact-checked` status where `checkedBy` equals `author`.

**Warnings**
1. QoQ change above ±60% or YoY above ±150% without a `note`.
2. Four-quarter sum vs the annual figure differs by more than 1%.
3. Monthly sum vs the quarter differs by more than 1.5%.
4. `lastVerified` older than 180 days.
5. Tier-1 entry not yet `fact-checked`.
6. A benchmark snapshot older than 12 months shown as current.
7. Model pricing `asOf` older than 120 days.

---

## 7. Search, SEO, accessibility, theme, mobile, performance, deployment

### 7.1 Search (Pagefind 1.5.2)

- `<html lang="zh-TW">`. Pagefind's extended build, which is the default binary, segments Chinese for any `zh-` language. Stemming does not apply to Chinese.
- Indexing: `pagefind --site dist` runs inside `npm run build`.
- Attributes:
  - `data-pagefind-body` on `<main>` content.
  - `data-pagefind-ignore` on nav, footers, hotspot lists, chart tables and term popovers, so definitions are not duplicated into every page.
  - `data-pagefind-weight="10"` on H1 and aliases.
  - Filters: `data-pagefind-filter="類型:公司|文章|模型|趨勢|產業鏈|名詞"`, `環節:…`, `難度:入門|進階|深入`, `地區:…`.
  - Meta: `data-pagefind-meta="image:…"` (posters).
  - Sort: `data-pagefind-sort="updated:YYYY-MM-DD"`.
- Every company page shows a visible 「別名／代號」 line (English name, tickers, common variants), so 「TSMC」, 「2330」 and 「台積」 all match.
- Glossary terms are indexed through the `/glossary/` page, using per-term anchors with `data-pagefind-body` on each term block.
- UI: a header button and Ctrl/⌘+K inject `/pagefind/pagefind-component-ui.js` and `.css` **on first use**, then open `<pagefind-modal>`. The bundle path resolves relative to the script, so it works under a base path.
- Search runs in a Web Worker in 1.5.
- In dev mode search is unavailable (「搜尋需於建置後使用」). Test it with `build` + `preview`.
- `<ai-scene>` (toolbar, hotspot chips, keyboard help) and the scene skip link carry `data-pagefind-ignore`; the caption and 「場景文字說明」 stay indexed. Pagefind still takes the first poster as the result's `image` meta.
- Company H1s keep a space between the Chinese and English names (「台積電 TSMC」), so the title meta and its tokens are not glued together.
- Chinese tuning (2026-10-20, `src/client/search-loader.ts`). Pagefind tokenises the index with jieba (Simplified dictionary: most Traditional names become single characters) but the query with the browser's `Intl.Segmenter` (ICU), and every query word must start an indexed word. So the loader (a) sets `ranking.termSimilarity: 4` through `PagefindComponents.configureInstance`, and (b) retries a Chinese query that finds nothing with trailing ICU words dropped, then with its characters split. Measured on the 401 Han company names: top-3 hits 332 → 369, zero-result names 31 → 0. It also passes `bundlePath: withBase('/pagefind/')` and injects the UI as a classic script, so search works under a base path.
- `tests/e2e/search.spec.ts` (preview server only) asserts that 「先進封裝」, 「高頻寬記憶體」, 「TSMC」, 「台積電」, 「輝達」, 「三星電子」 and 「艾司摩爾」 each list the expected page in the top 3 of the real search UI.

### 7.2 SEO and meta

- `lib/seo.ts` produces: title, description (from schema), canonical (absolute, trailing slash), `og:locale=zh_TW`, OG and Twitter image (scene poster, or a section image in `public/og/`), and `theme-color` for both themes.
- JSON-LD per type:
  - `Article` (learn, trends)
  - `Organization` (companies; `tickerSymbol` where listed)
  - `DefinedTermSet` / `DefinedTerm` (glossary)
  - `Dataset` (company financials, citing sources)
  - `BreadcrumbList` (all)
  - `WebSite` with `SearchAction` is skipped because search is client-side.
- Slugs are ASCII kebab-case: portable across hosts and readable when shared.
- `@astrojs/sitemap`; `robots.txt` points to the sitemap.
- Every page shows 「資料截至 YYYY-MM-DD」 from `lastVerified`.

### 7.3 Accessibility (WCAG 2.2 AA)

- Skip link and landmarks.
- One H1 per page; MDX bodies start at H2 (lint rule).
- Visible focus rings. Contrast-checked tokens in both themes.
- Every 3D interaction has an HTML equivalent: hotspot list, step buttons and the text description.
- The canvas gets `aria-hidden="true"`; the figure is described by `meta.description`.
- `prefers-reduced-motion` is honoured in scenes, view transitions and the CSS.
- Every chart has a table and an aria summary.
- Popovers are reachable by keyboard and dismissed with Esc.
- Filters are a `<form>` with labelled controls and an `aria-live="polite"` result count.
- Touch targets are at least 44 px.
- axe runs on one URL per template.

### 7.4 Theme

- An inline head script (before paint) sets `html[data-theme]` from localStorage (inside try/catch) or else from the system.
- Tokens in `tokens.css` use `light-dark()`. Set `:root { color-scheme: light dark }` and override it per `[data-theme]`. `ThemeToggle` cycles 系統 / 淺色 / 深色.
- Scenes re-tint on theme change.
- `body` has an explicit background.

### 7.5 Typography and mobile

- Font stack: `system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`.
- Body 17 px / 1.8. Measure about 38em. `line-break: strict`. `overflow-wrap: anywhere` in tables. `font-variant-numeric: tabular-nums` in data.
- Style rule: half-width space between CJK and Latin or digits (盤古之白); `check-zh` warns when it is missing. Full-width punctuation in Chinese text.
- Layout breakpoints come from container queries plus three global breakpoints (480 / 768 / 1200).
- Scenes are at most 60svh on mobile, start at `low` quality, and need tap-to-interact.
- Wide tables scroll inside their own container, never the page.
- The compare page stacks columns.
- No horizontal page scroll at 320 px, enforced by a test.

### 7.6 Performance budgets

These are enforced by `scripts/check-budgets.ts` (reads `dist` plus the Vite manifest) and by Lighthouse CI.

| Budget | Limit |
|---|---|
| JS loaded on any page before scene activation (theme, popovers, chart tooltip, prefetch, scene loader, filters) | **≤ 20 KB gz** (≤ 28 KB on `/companies/` and `/models/compare/`) |
| `three` shared chunk | ≤ 175 KB gz (cached across pages) |
| Per-scene chunk (scene + kit modules it uses) | ≤ 60 KB gz (`meta.budgetKB`) |
| Scene runtime assets (geo JSON etc.) | ≤ 300 KB per scene |
| CSS total | ≤ 35 KB gz |
| HTML per page | ≤ 120 KB gz. Documented exceptions (single-page `#anchor` targets, not split): `/companies/` ≤ 220 KB, `/glossary/` ≤ 300 KB (~300 terms; `<Term>` popovers and search results link to `/glossary/#<id>`). `/memory/` ≤ 200 KB (memory topic: four markets, 59 fabs and ~213 merged sources; citations link to `/memory/#src-<key>`). `/sources/bibliography.json` is fetched only when a publisher group is opened, so it is not part of any page view. |
| Web fonts | 0 bytes |
| LCP (mobile, throttled) | ≤ 2.5 s. LCP is always text or poster, never canvas. |
| CLS | ≤ 0.05 |
| TBT | ≤ 200 ms on non-scene pages; ≤ 350 ms on scene pages |
| Lighthouse (mobile) | Perf ≥ 90 on non-scene and ≥ 80 on scene pages; A11y ≥ 95; Best Practices ≥ 95; SEO ≥ 95 |

### 7.7 Deployment (static)

- **Cloudflare Pages / Workers static assets (recommended).** Good latency in Taiwan, no base path. `public/_headers`: `/_astro/*` gets `Cache-Control: public, max-age=31536000, immutable`; `/pagefind/*` gets `max-age=3600`; HTML `max-age=0, must-revalidate`. The site stays far below the 20k-file and 25 MiB-per-file limits (about 450 pages plus Pagefind fragments).
- **GitHub Pages.** Set `BASE_PATH=/<repo>/` and `SITE_URL=https://<user>.github.io` unless there is a custom domain. Deploy with the `withastro/action` workflow; `build` already runs Pagefind. Keep `.nojekyll` in `public/`. Every internal URL goes through `withBase()`, and lint forbids hard-coded `href="/…"` in `.astro`. Custom headers are not supported, so you rely on hashed filenames. `trailingSlash: 'always'` with `format: 'directory'` behaves the same on all three hosts.
- **Vercel.** Zero config as a static output. Put the same cache headers in `vercel.json`. No adapter needed.
- All three: `src/pages/404.astro`. The CI order is build, then verify, then deploy.

---

## 8. Verification strategy

1. **`astro check`**: TS strict (`strictest`) across `.astro`, `.ts` and MDX. Zero errors required.
2. **`scripts/validate-data.ts`**: all rules in §6.3, plus:
   - scene `meta.json` schema,
   - every `SCENE_IDS` entry has a folder,
   - every roster id has a file (coverage report: counts per segment/tier, missing, stubs),
   - every segment has at least 8 companies and at least 3 featured,
   - every learn article in `curriculum.yaml` exists,
   - glossary ids used ⊆ files.

   Output is a machine-readable JSON report (`--json`) for the orchestrator.
3. **`check-zh.ts`**:
   - OpenCC s→tw diff flags Simplified characters.
   - Blocklist of mainland terms with suggestions: 芯片→晶片, 内存→記憶體, 软/軟件→軟體, 服务器→伺服器, 数据→資料, 网络→網路, 视频→影片, 硬件→硬體, 信息→資訊, 默认→預設, 程序(software)→程式, 质量→品質, 智能→智慧 (warning only for product names).
   - Missing CJK–Latin spacing (warning).
4. **`check-content-rules.ts`**:
   - no H1 in bodies,
   - heading order,
   - raw internal links,
   - `<Term>`/`<Cite>`/`<Scene3D>` ids,
   - level length targets,
   - full-profile body headings present: `## 公司概況`, `## 產品與技術`, `## 營收表現解讀`, `## 競爭格局`, `## 風險與觀察重點`,
   - images have alt text,
   - every number-bearing sentence in learn/trends near a `<Cite>` (heuristic warning).
5. **Link checker (`check-links.ts`).**
   - Serves `dist/` under the configured base path and runs linkinator recursively over internal URLs, with zero broken links required.
   - Also checks `#fragment` anchors for glossary and TOC links.
   - External URLs are checked in a separate non-blocking weekly job with rate limits (many IR sites block bots), reporting 404s.
6. **Playwright smoke (`tests/e2e/routes.spec.ts`).**
   - Routes are discovered by globbing `dist/**/index.html`, giving about 450 URLs, sharded across workers.
   - For each route:
     - HTTP 200, `<title>` matches the pattern, one H1, `lang="zh-TW"`;
     - **no `console.error`, no `pageerror`, no failed same-origin requests**;
     - no horizontal overflow at 390 px.
7. **WebGL (`tests/scenes/*.spec.ts`).**
   - Chromium launched with `channel: 'chromium'` (new headless) and `args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']`. Recent Chrome no longer falls back to SwiftShader for WebGL automatically, hence the explicit flag.
   - For each scene, via `/dev/scenes/<id>/` (dev server) and via the real host page (preview):
     - wait for `ai-scene[data-state="ready"]` (20 s);
     - assert `stats.frames ≥ 3` and `stats.drawCalls > 0`;
     - take an element screenshot and check with sharp that luminance stdev is above 4 (not blank);
     - run every variant and step via `scene:command`;
     - hotspot keyboard path: focus list item → `scene:hotspot` fires;
     - reduced-motion run: frames stop increasing within 1 s of ready;
     - `--disable-webgl` run: `data-state="fallback"`, poster visible, no console errors;
     - a page with three scenes never has more than 2 live contexts.
8. **Accessibility**: `@axe-core/playwright` on one URL per template, in light and dark, with zero serious or critical violations.
9. **Screenshots (`capture-screenshots.ts`).** Every template's representative URLs plus all segment pages, at 1440×900 and 390×844, light and dark, written to `artifacts/screens/<route>__<vp>__<theme>.png` with a contact sheet `artifacts/screens/index.html` for visual review. `capture-posters.ts` writes `src/assets/scene-posters/<id>.webp` (1600×900, quality 80).
10. **Lighthouse CI** (`lighthouserc.json`, mobile preset, 3 runs, median) on:
    - `/`
    - `/learn/what-is-llm/`
    - `/chain/foundry-packaging/`
    - `/companies/`
    - `/companies/tsmc/`
    - `/models/compare/`
    - `/taiwan/`
    - `/glossary/`

    Assertions use the §7.6 budgets, including `resource-summary:script:size`.
11. **Budget check** (`check-budgets.ts`), per §7.6.
12. **Fact-check protocol (human-like, by different agents).**
    - Tier-1 financials: every quarter checked against the primary filing or IR release; 3 random points cross-checked with a second source.
    - Models: pricing against the official pricing page; benchmarks against the lab report or leaderboard, with date.
    - Learn and trends: every numeric claim checked.
    - Compact profiles: random 20% sample per batch. If more than 10% of a batch fails, re-check the whole batch.
    - The checker sets `editorial.status: fact-checked`, `checkedBy` and `checkedOn`, and writes corrections in place.

---

## 9. Implementation decomposition (multi-agent)

### 9.1 Global conflict-avoidance rules

1. **One file per entity.** Each agent gets an explicit list of output paths and writes nothing else. Company agents own both `companies/<slug>.mdx` and `financials/<slug>.json`.
2. **Frozen contracts after Phase 0:** `src/schemas/**`, `content.config.ts`, `package.json` and the lockfile, the registries (`roster.yaml`, `glossary-index.yaml`, `curriculum.yaml`, `models-index.yaml`, `trends-index.yaml`, `scenes-index.yaml`), the component **APIs** (props), and `three/core` types. Any change goes in a new `proposals/<agent>-<ts>.yaml` (one file each, so no conflicts). The integrator merges proposals between waves.
3. **No concurrent builds.** Agents never run `astro build`, `npm install` or git commands. Self-checks:
   - `npm run validate:files -- <my paths>` (references checked against registries),
   - `npm run lint:zh -- <paths>`,
   - `npm run lint:content -- <paths>`.

   Scene and page agents use **one shared, orchestrator-started dev server** (`astro dev --port 4321`) and `npm run test:scene -- <id>`.
4. **Git:** the orchestrator commits at each wave boundary (one commit per wave). Agents return a JSON manifest:
   ```
   { files: [...], status, sourcesCount, openQuestions: [...], proposals: [...] }
   ```
5. **Research rules:**
   - Primary sources first: filings, IR, MOPS, official docs and pricing pages.
   - Every number has a source with an `accessed` date.
   - Corporate status (acquired, renamed, listed) is verified as of the research date.
   - Unknowns are omitted, not guessed. Estimates are labelled.
   - All prose in zh-TW per `docs/STYLE-zh-TW.md`.
6. **Concurrency cap:** about 12–16 research agents at once (web rate limits); 6–8 scene agents (SwiftShader tests are CPU-heavy).

### 9.2 Phases

**Phase 0: Scaffold and contracts** (1 architect agent, sequential)
- Init Astro 7.3 manually (no template). Install the pinned deps (§1). Write config, tsconfig and scripts.
- Write all schemas (§3) and the `makeSchemas` factory, plus `lib/` stubs (`paths`, `format`, `fiscal` and `fx` signatures, `collections`, `graph`, `seo`).
- Write **stub components with final prop APIs**: Term, Cite, Callout, KeyTakeaways, DeepDive, LevelSection, Figure, MathTeX, chips, NextSteps, PrereqBox, SourcesList, Scene3D, and every chart. MDX then compiles from day one.
- Write the registries from Appendix A/B, `curriculum.yaml` from §5, docs (style guide, content guide with templates and DoD, scene contract, ownership), and `new-entity.ts` templates.
- Seed one example file per collection (TSMC company + financials, `what-is-ai`, `foundry-packaging` segment, `anthropic-claude` model, one trend, five glossary terms, one source).
- Write `validate-data.ts`, `check-zh.ts` and `check-content-rules.ts`, the Playwright config and the dev scene sandbox route.
- **Gate:** `npm run check && npm run validate && npm run build` is green.

**Phase 1: Foundations** (parallel, 4 + 7 agents)
- **[DS] Design system** (1–2 agents): tokens (layer palette for both themes), base, prose (CJK), layout; BaseLayout, ArticleLayout, ProfileLayout; Header, Footer, ThemeToggle, Search loader; real implementations of the content components (popover terms and chips, DeepDive, NextSteps …); OG section images.
- **[3D] Engine core** (1 agent): `core/*`, `kit/*`, `gen-geo.ts` and its outputs, `Scene3D.astro`, the sandbox, and **two exemplar scenes**: `concept-neural-net` (simple) and `chain-panorama` (data-driven, hotspots, steps). Plus the scene test spec template and `SCENE-CONTRACT.md`.
- **[CH] Charts and finance** (1 agent): `fiscal.ts`, `fx.ts`, `financial-metrics.ts`, `format.ts` (億/兆), `fetch-fx.ts` with committed rates, every chart component, `chart-tooltip.ts`.
- **[REG] Registry research** (1 agent):
  - verify the roster's corporate status, tier and segment (~330 ids);
  - finalise `glossary-index.yaml` (~220 ids with zh, category and level);
  - write `benchmarks.yaml`;
  - write about 60 `sources/` registry files.

  The integrator applies the result before Phase 2.
- **[CT-seg] Segments** (7 agents × 2 segments, in chain order pairs): `segments/<id>.mdx`. These need only schemas and registries.
- **Gate:** the integrator merges proposals and registry updates; build green; exemplar scenes pass the WebGL tests.

**Phase 2: Content research and writing** (parallel waves; segment and page work can overlap)

| Wave | Work | Agents × batch | Notes |
|---|---|---|---|
| 2a | Glossary | 9 × ~25 terms, by category | Fast. Unblocks Term usage everywhere. |
| 2a | Model families | 9 × 3 families | `models/<family>.mdx` |
| 2a | Tier-1 companies, wave 1 (silicon and Taiwan) | 14 × 3 | full profile + financials (12+ Q, mix, margins, TW monthly) |
| 2b | Learn L1 + L2 | 12 × 2 articles (same track) | Track-adjacent pairs, e.g. 201+202, 211+212 |
| 2b | Tier-1 companies, wave 2 (systems, cloud, models, apps, physical) | 14 × 3 | |
| 2b | Trends | 9 × ~3 (same category) | |
| 2c | Learn L3 | 7 × 2 articles | after L2 so it can build on it |
| 2c | Compact companies | ~22 × 12–15, grouped by primary segment | summary, products, 3 FY revenue or estimate, TW 13-month revenue |
| 2c | Pages content | 1 agent | `pages/*.mdx` (home, chain, taiwan, methodology, about, models-intro, learn-intro) plus `src/data/taiwan/sites.yaml` |

Definition of done per file: schema-valid via `validate:files`, zh lint clean, `editorial.status: researched`, source minimums met, length targets met, manifest returned.

**Phase 3: Scenes** (parallel, starts at the Phase 1 3D gate; 21 remaining scenes)
- One scene per agent. Pair the light ones: `concept-embedding-space` + `concept-scaling-surface`; `trend-roadmap` + `learn-mountain`.
- Writes only `src/three/scenes/<id>/**`. Data-driven scenes code against the typed payload shapes in `three/core/types.ts`. New kit helpers go through proposals; until merged, they stay local.
- DoD: all variants and steps work; hotspots registered and mirrored in `meta.json`; budget met (`budgetKB`); `test:scene` passes, including the reduced-motion and fallback runs; dark and light both verified.

**Phase 4: Pages and templates** (parallel, 6 agents; starts after the Phase 1 DS/CH gate, using seed data, and overlaps Phase 2 and 3)
1. `/`, `/chain/`, `/chain/[segment]/`
2. `/learn/`, `/learn/[slug]/`
3. `/companies/`, `/companies/[slug]/` (filters script)
4. `/models/`, `/models/[slug]/`, `/models/compare/` (compare script)
5. `/trends/`, `/trends/[slug]/`, `/taiwan/`
6. `/glossary/`, `/sources/`, `/about/`, `/404`, plus SEO JSON-LD, sitemap and `_headers`

Each agent owns its `src/pages/<family>/**`, `src/components/<family>/**` and the `src/client/<script>.ts` files it creates.

**Phase 5: Integration** (1–2 integrator agents, sequential)
- Merge proposals (new terms or companies get delegated stub-filling tasks).
- Full `npm run validate` with real cross-references, fixing dangling refs by delegating to file owners.
- Knowledge-graph tuning, panorama data, `npm run build` with Pagefind, posters (`npm run posters`), coverage report.
- **Gate:** `npm run verify` green apart from fact-check warnings.

**Phase 6: Verification and fact-check** (parallel)
- **[QA]** 1 agent: E2E across all routes, scenes, axe, links, Lighthouse, budgets, screenshots and contact sheet.
- **[VIS]** 1 agent: reviews the contact sheet (layout bugs, overflow, dark-mode contrast, empty states) and files fixes to owners.
- **[FC]** fact-check, with checkers never checking their own work:
  - tier-1 financials: ~16 agents × 5 companies;
  - models: 5 × 5 families;
  - learn and trends numeric claims: 8 × ~8 files;
  - compact profiles: 20% sample, 6 agents.
- **Fix loop:** one fixer per file (the original owner role), then re-run the affected checks. Stop when `verify` is green and every tier-1 entry is `fact-checked`.

Approximate total: about 170 agent tasks. The critical path is Phase 0 → Phase 1 (3D core) → Phase 3 scenes → Phase 5 → Phase 6. Content waves run alongside.

---

## Appendix A: Segment taxonomy and company roster seed

**Taxonomy changes vs your plan:** EDA/IP/design services is split out of AI chips into its own segment. Licensing, royalty and NRE business models differ from chip vendors, and the Taiwan ASIC design-service houses are key players. Result: **14 segments in 5 layers**.

- Server-level parts (PSU, cold plates, PCB/CCL, rails, connectors) belong to `servers-systems`.
- Facility-level gear (UPS, switchgear, CDUs, chillers) and operators belong to `datacenter-infra`.
- Utilities and generation belong to `energy-power`.
- Business units of conglomerates are listed as `units` inside the parent: AWS/Trainium, Google Cloud/TPU/DeepMind/Waymo, Azure/Maia, Meta MTIA, Qwen in Alibaba, Huawei Cloud, Zoox, etc.

| order | id | 標題 | Layer |
|---|---|---|---|
| 1 | energy-power | 能源與電力 | foundation |
| 2 | semi-equipment-materials | 半導體設備與材料 | silicon |
| 3 | foundry-packaging | 晶圓代工與先進封裝 | silicon |
| 4 | memory-storage | 記憶體與儲存 | silicon |
| 5 | eda-ip-design | 晶片設計工具、矽智財與設計服務 | silicon |
| 6 | ai-accelerators | AI 晶片與加速器（GPU／ASIC／CPU） | silicon |
| 7 | networking-optics | 網通與光通訊 | systems |
| 8 | servers-systems | 伺服器、系統與關鍵零組件 | systems |
| 9 | datacenter-infra | 資料中心（電力、散熱、營運） | systems |
| 10 | cloud-neocloud | 雲端與新雲 | cloud-models |
| 11 | foundation-models | 基礎模型 | cloud-models |
| 12 | devtools-data-mlops | 開發工具、資料與 MLOps | cloud-models |
| 13 | apps-agents | 應用與 Agent | applications |
| 14 | physical-ai | 實體 AI（機器人、自駕、邊緣裝置） | applications |

**Roster seed.** ★ marks tier 1 with a full profile (~80). The rest are tier 2/3 and startups with compact profiles. Ids are kebab-case slugs; listed Taiwan small caps carry their zh name. The [REG] agent verifies status and trims or extends to about 300–340.

1. **energy-power (~24):** ge-vernova★, siemens-energy★, constellation-energy★, vistra★, nextera-energy, talen-energy, nrg-energy, oklo, nuscale-power, bloom-energy, cameco, fluence-energy, quanta-services, prysmian, mitsubishi-heavy, terrapower, kairos-power, commonwealth-fusion-systems, taipower(台電), fortune-electric(華城), shihlin-electric(士電), chung-hsin-electric(中興電), allis-electric(亞力)
2. **semi-equipment-materials (~40):** asml★, applied-materials★, lam-research★, tokyo-electron★, kla★, advantest★, teradyne, asm-international, screen-holdings, kokusai-electric, lasertec, disco, besi, onto-innovation, nova, camtek, axcelis, naura(北方華創), amec(中微), shin-etsu-chemical, sumco, globalwafers(環球晶), entegris, tokyo-ohka-kogyo, resonac, ajinomoto, linde, air-liquide, merck-kgaa, zeiss-smt, gptc(弘塑), scientech(辛耘), all-ring(萬潤), gudeng(家登), foxsemicon(京鼎), marketech(帆宣), uis(漢唐), kinik(中砂), topco(崇越), chroma(致茂)
3. **foundry-packaging (~23):** tsmc★, intel★ (secondary: ai-accelerators), umc★(聯電), smic★(中芯), globalfoundries, hua-hong(華虹), rapidus, tower-semiconductor, vis(世界先進), psmc(力積電), ase★(日月光投控), amkor★, jcet(長電科技), tongfu(通富微電), kyec(京元電), powertech(力成), chipbond(頎邦), ibiden, unimicron(欣興), nan-ya-pcb(南電), kinsus(景碩), shinko-electric, at-s
4. **memory-storage (~20):** samsung-electronics★ (secondary: foundry), sk-hynix★, micron★, sandisk★, western-digital★, kioxia, seagate, cxmt(長鑫), ymtc(長江存儲), nanya-tech(南亞科), winbond(華邦電), macronix(旺宏), phison(群聯), silicon-motion(慧榮), adata(威剛), pure-storage, netapp, vast-data, ddn, weka
5. **eda-ip-design (~16):** synopsys★, cadence★, arm★, alchip★(世芯-KY), guc★(創意), rambus, ceva, sifive, imagination-technologies, socionext, faraday(智原), ememory(力旺), m31(円星), ap-memory(愛普), andes(晶心科), alphawave (verify owner)
6. **ai-accelerators (~30):** nvidia★, amd★, broadcom★, marvell★, qualcomm★, mediatek★(聯發科), huawei★ (units: Ascend/HiSilicon, Huawei Cloud), cerebras, groq (verify status), sambanova, tenstorrent, etched, d-matrix, graphcore, ampere-computing, cambricon(寒武紀), hygon(海光), moore-threads(摩爾線程), metax(沐曦), biren(壁仞), enflame(燧原), kunlunxin(昆侖芯), rebellions, furiosaai, axelera-ai, positron, matx
7. **networking-optics (~27):** arista★, cisco★, coherent★, lumentum★, innolight★(中際旭創), credo★, astera-labs★, amphenol★, accton★(智邦), eoptolink(新易盛), fabrinet, ciena, corning, te-connectivity, nokia, applied-optoelectronics, lightmatter, ayar-labs, zte(中興通訊), ruijie(銳捷), bizlink(貿聯-KY), landmark(聯亞), luxnet(華星光), browave(波若威), 上詮, 光聖, 眾達-KY
8. **servers-systems (~33):** foxconn★(鴻海), quanta★(廣達), wistron★(緯創), wiwynn★(緯穎), inventec★(英業達), supermicro★, dell★, hpe★, lenovo★, delta-electronics★(台達電), celestica, fii(工業富聯; parent foxconn), gigabyte(技嘉), asus(華碩), msi(微星), mitac(神達), inspur(浪潮資訊), xfusion(超聚變), jabil, sanmina, lite-on(光寶科), avc(奇鋐), auras(雙鴻), jentech(健策), chenbro(勤誠), king-slide(川湖), gce(金像電), emc(台光電), tuc(台燿), lotes(嘉澤), aic(營邦)
9. **datacenter-infra (~22):** vertiv★, schneider-electric★, eaton★, equinix★, digital-realty★, abb, legrand, nvent, modine, iron-mountain, ntt-data, stack-infrastructure, qts, vantage-data-centers, aligned-data-centers, switch, airtrunk, gds(萬國數據), applied-digital, iren, cipher-mining, terawulf, chief-telecom(是方)
10. **cloud-neocloud (~24):** microsoft★, amazon★, alphabet★, oracle★, coreweave★, nebius★, alibaba★, tencent★, baidu★, ibm, cloudflare, digitalocean, akamai, softbank-group, crusoe, lambda, together-ai, vultr, nscale, fluidstack, g42, humain, chunghwa-telecom(中華電信), taiwan-ai-cloud(台智雲; parent asus)
11. **foundation-models (~28):** openai★, anthropic★, meta★, xai★, deepseek★, bytedance★, mistral-ai, cohere, ai21-labs, moonshot-ai(月之暗面), zhipu-ai(智譜), minimax, stepfun(階躍星辰), safe-superintelligence, thinking-machines-lab, reflection-ai, ai2, sakana-ai, upstage, naver, black-forest-labs, stability-ai, midjourney, runway, luma-ai, elevenlabs, suno
12. **devtools-data-mlops (~26):** databricks★, snowflake★, datadog★, hugging-face, scale-ai, surge-ai, mercor, labelbox, langchain, pinecone, weaviate, qdrant, mongodb, elastic, confluent, anyscale, modal, baseten, fireworks-ai, anysphere, cognition, replit, lovable, vercel, dataiku
13. **apps-agents (~29):** salesforce★, servicenow★, adobe★, palantir★, sap, workday, intuit, shopify, duolingo, perplexity, character-ai, harvey, abridge, glean, sierra, decagon, writer, notion, canva, figma, synthesia, grammarly, openevidence, hippocratic-ai, tempus-ai, appier(沛星), ikala, gogolook(走著瞧), cyberlink(訊連), 91app
14. **physical-ai (~30):** tesla★, apple★ (edge devices; secondary ai-accelerators, apps-agents), mobileye★, advantech★(研華), xiaomi, figure-ai, agility-robotics, apptronik, 1x, boston-dynamics, unitree(宇樹), ubtech(優必選), agibot(智元), physical-intelligence, skild-ai, aurora-innovation, pony-ai, weride, horizon-robotics(地平線), wayve, nuro, intuitive-surgical, fanuc, yaskawa, hiwin(上銀), ambarella, hailo, symbotic

---

## Appendix B: Models, trends and glossary seeds

**Model families (~26 files):**

| Origin | Families |
|---|---|
| US | openai-gpt, openai-gpt-oss, anthropic-claude, google-gemini, google-gemma, meta-llama, xai-grok, microsoft-phi-mai, amazon-nova, nvidia-nemotron, ibm-granite, ai2-olmo, apple-foundation-models |
| China | deepseek, alibaba-qwen, moonshot-kimi, zhipu-glm, minimax, bytedance-seed, tencent-hunyuan, baidu-ernie |
| Europe / Canada | mistral, cohere-command |
| Taiwan | taide (labName 國科會／國網中心), mediatek-breeze, foxconn-foxbrain |

**`benchmarks.yaml` seeds:** MMLU-Pro, GPQA-Diamond, HLE, SWE-bench Verified, LiveCodeBench, AIME, ARC-AGI-2, MMMU, Terminal-Bench, τ-bench, LMArena Elo, METR time-horizon, TMMLU+ (繁中). Each has what it measures, scale, higher-is-better, saturation note and URL.

**Trends (~25):**

| Category | Slug | 標題 |
|---|---|---|
| Hardware | `process-roadmap-2nm-and-beyond` | 2 奈米之後的製程藍圖 |
| Hardware | `cowos-capacity-panel-level` | CoWoS 擴產與面板級封裝 |
| Hardware | `hbm4-custom-base-die` | HBM4 與客製化記憶體 |
| Hardware | `co-packaged-optics` | CPO 走向量產 |
| Hardware | `rack-scale-systems` | 機櫃即電腦 |
| Hardware | `custom-asic-rise` | 客製化 ASIC 崛起 |
| Hardware | `800v-dc-power` | 800V 直流供電 |
| Hardware | `liquid-cooling-mainstream` | 液冷成為主流 |
| Hardware | `edge-ai-npu` | AI PC 與手機 NPU |
| Hardware | `nuclear-smr-for-ai` | 核能與 SMR 供電 |
| Software | `reasoning-test-time-compute` | 推理模型與推論時運算 |
| Software | `agentic-ai-mcp` | Agent 生態與 MCP |
| Software | `ai-coding` | AI 寫程式 |
| Software | `small-models-distillation` | 小模型與蒸餾 |
| Software | `open-weights-catch-up` | 開放權重模型追趕 |
| Software | `world-models-physical-ai` | 世界模型與實體 AI |
| Software | `long-context-memory` | 長上下文與記憶 |
| Market | `hyperscaler-capex` | 超大規模業者資本支出 |
| Market | `neocloud-gpu-financing` | 新雲與 GPU 融資 |
| Market | `inference-demand` | 推論需求超越訓練 |
| Market | `ai-monetization` | AI 營收化進度 |
| Policy | `export-controls` | 晶片出口管制 |
| Policy | `eu-ai-act-implementation` | 歐盟 AI 法實施 |
| Policy | `sovereign-ai` | 主權 AI |
| Policy | `taiwan-ai-policy` | 台灣 AI 政策與算力布局 |

**Glossary (~220 ids across 14 categories):** about 15–20 per category, with level spread roughly 35% L1, 40% L2, 25% L3. Examples: token, embedding, transformer, attention, kv-cache, moe, rlhf, rlvr, rag, mcp, agent, fp8, hbm, tsv, cowos, soic, chiplet, ucie, finfet, gaa, bspdn, euv, high-na, nvlink, infiniband, ultra-ethernet, serdes, cpo, lpo, pue, cdu, ttm, capex, arr, asic, tpu, odm, osat.

---

## References checked (2026-10-06)

- [Astro 7 release blog](https://astro.build/blog/astro-7/)
- [Astro v7 upgrade guide](https://docs.astro.build/en/guides/upgrade-to/v7/)
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/)
- [@astrojs/mdx](https://docs.astro.build/en/guides/integrations-guide/mdx/)
- [Astro Fonts API](https://docs.astro.build/en/guides/fonts/)
- [Pagefind multilingual / CJK](https://pagefind.app/docs/multilingual/)
- [Pagefind Component UI](https://pagefind.app/docs/search-ui/)
- npm registry (`npm view`) for every version listed in §1, including `astro` engines (`node >=22.12.0`) and the `@astrojs/check` peer range `typescript ^5 || ^6`.
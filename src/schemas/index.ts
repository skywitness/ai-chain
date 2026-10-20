// Collection schemas, built as a factory over `ref` so that standalone scripts
// (scripts/validate-data.ts) can validate files without the astro:content virtual module.
// FROZEN CONTRACT: changes go through proposals/ (see docs/OWNERSHIP.md).
import { z } from 'astro/zod';
import {
  Currency,
  DatedValue,
  EXCHANGES,
  Editorial,
  GLOSSARY_CATEGORIES,
  IsoDate,
  LAYER_IDS,
  Level,
  PartialDate,
  Region,
  SceneRef,
  Slug,
  Source,
} from './common';

export * from './common';

export type CollectionName =
  | 'learn'
  | 'segments'
  | 'companies'
  | 'financials'
  | 'models'
  | 'trends'
  | 'glossary'
  | 'sources'
  | 'pages';

export type RefValue = { collection: string; id: string };
/** Astro's reference() at build time; a registry-checking stub in scripts. */
export type Ref = (c: CollectionName) => z.ZodType<RefValue, any>;

export function makeSchemas(ref: Ref) {
  // ───────────────────────── learn ─────────────────────────
  const learn = z
    .strictObject({
      title: z.string().min(4).max(48),
      subtitle: z.string().max(80).optional(),
      description: z.string().min(40).max(160), // meta description (zh)
      level: Level,
      order: z.number().int().min(101).max(399), // 1xx/2xx/3xx = level
      track: z.enum(['foundations', 'models', 'hardware', 'infra-business', 'society']),
      prerequisites: z.array(ref('learn')).default([]),
      next: z.array(ref('learn')).max(3).default([]),
      relatedSegments: z.array(ref('segments')).default([]),
      relatedCompanies: z.array(ref('companies')).default([]),
      relatedModels: z.array(ref('models')).default([]),
      relatedTrends: z.array(ref('trends')).default([]),
      glossary: z.array(ref('glossary')).default([]), // must list every <Term id> used in body
      scenes: z.array(SceneRef).default([]),
      keyTakeaways: z.array(z.string().max(90)).min(3).max(6),
      estimatedMinutes: z.number().int().min(3).max(45),
      sources: z.array(Source).min(3),
      updated: IsoDate,
      lastVerified: IsoDate,
      editorial: Editorial,
    })
    .superRefine((d, ctx) => {
      if (Math.floor(d.order / 100) !== d.level)
        ctx.addIssue({ code: 'custom', path: ['order'], message: 'order hundreds digit must equal level' });
    });

  // ───────────────────────── segments ─────────────────────────
  const segment = z.strictObject({
    title: z.string(), // 「晶圓代工與先進封裝」
    titleEn: z.string(),
    order: z.number().int().min(1).max(14),
    layer: z.enum(LAYER_IDS),
    tagline: z.string().max(60),
    description: z.string().min(40).max(160),
    upstream: z.array(ref('segments')),
    downstream: z.array(ref('segments')),
    scene: SceneRef,
    scope: z.strictObject({
      includes: z.array(z.string()).min(2),
      excludes: z.array(z.string()).default([]),
    }),
    concentration: z.enum(['monopoly', 'oligopoly', 'competitive', 'fragmented']),
    bottleneck: z.strictObject({ level: z.number().int().min(1).max(5), note: z.string() }),
    keyMetrics: z.array(DatedValue).default([]),
    marketSize: z
      .array(
        z.strictObject({
          year: z.number().int(),
          value: z.number().positive(),
          unit: z.enum(['million', 'billion']),
          currency: Currency,
          status: z.enum(['actual', 'estimate', 'forecast']),
          definition: z.string(),
          source: Source,
        }),
      )
      .default([]),
    featuredCompanies: z.array(ref('companies')).min(3).max(12),
    taiwanRole: z.string().min(20),
    relatedLearn: z.array(ref('learn')).default([]),
    relatedTrends: z.array(ref('trends')).default([]),
    glossary: z.array(ref('glossary')).default([]),
    sources: z.array(Source).min(3),
    lastVerified: IsoDate,
    editorial: Editorial,
  });

  // ───────────────────────── companies ─────────────────────────
  const Listing = z.strictObject({
    exchange: z.enum(EXCHANGES),
    ticker: z.string().min(1), // ALWAYS quoted in YAML
    primary: z.boolean().default(true),
    adr: z.boolean().default(false),
  });
  const Product = z.strictObject({
    name: z.string(),
    nameZh: z.string().optional(),
    category: z.string(), // 「GPU」「HBM」「乙太網路交換器」…
    segment: ref('segments').optional(),
    launched: PartialDate.optional(),
    status: z.enum(['shipping', 'sampling', 'announced', 'roadmap', 'eol']),
    description: z.string().min(10),
    specs: z.array(z.strictObject({ label: z.string(), value: z.string() })).default([]),
    source: Source.optional(),
  });
  const Technology = z.strictObject({
    name: z.string(),
    description: z.string().min(10),
    maturity: z.enum(['research', 'pilot', 'production', 'mature']),
    glossary: z.array(ref('glossary')).default([]),
    source: Source.optional(),
  });
  const TimelineEvent = z.strictObject({
    date: PartialDate,
    title: z.string(),
    detail: z.string().optional(),
    kind: z.enum([
      'founding', 'ipo', 'product', 'deal', 'funding', 'acquisition', 'policy', 'milestone',
      'leadership', 'earnings', 'other',
    ]),
    source: Source.optional(),
  });
  const Relationship = z.strictObject({
    company: ref('companies'),
    type: z.enum(['supplier', 'customer', 'partner', 'investor', 'investee', 'competitor']),
    note: z.string().optional(),
    source: Source.optional(),
  });
  const Unit = z.strictObject({
    // business units without their own file: AWS, Google Cloud, DeepMind, Waymo, TPU…
    id: Slug,
    name: z.string(),
    nameZh: z.string(),
    segment: ref('segments'),
    description: z.string(),
  });
  const Funding = z.strictObject({
    date: PartialDate,
    round: z.string(),
    amountUsdM: z.number().positive().optional(),
    valuationUsdM: z.number().positive().optional(),
    investors: z.array(z.string()).default([]),
    source: Source,
  });
  const company = z
    .strictObject({
      name: z.string(), // 'TSMC'
      nameZh: z.string(), // '台積電'
      legalName: z.string().optional(),
      aliases: z.array(z.string()).default([]), // English/Chinese variants, tickers (search)
      website: z.url(),
      hq: z.strictObject({
        city: z.string(),
        cityZh: z.string(),
        country: z.string().length(2), // ISO 3166-1 alpha-2
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }),
      region: Region,
      founded: z.number().int().min(1800).max(2026).optional(),
      employees: z
        .strictObject({ value: z.number().int().positive(), asOf: IsoDate, source: Source.optional() })
        .optional(),
      ownership: z.enum(['listed', 'private', 'subsidiary', 'state-owned', 'nonprofit']),
      status: z.enum(['active', 'acquired', 'merged', 'defunct']).default('active'),
      statusNote: z.string().optional(), // 「2025-12 被 NVIDIA 以授權＋人才交易方式取得」
      listings: z.array(Listing).default([]),
      parent: ref('companies').optional(),
      primarySegment: ref('segments'),
      segments: z.array(ref('segments')).min(1),
      units: z.array(Unit).default([]),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]), // 1 一線龍頭, 2 二線要角, 3 利基/新創
      stage: z.enum(['startup', 'scaleup', 'mature']),
      profile: z.enum(['full', 'compact']),
      summary: z.string().min(60).max(420),
      chainRole: z.string().min(20), // 在產業鏈中的角色
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
      hasFinancials: z.boolean(), // must match existence of financials/<slug>.json
      sources: z.array(Source).min(1),
      lastVerified: IsoDate,
      editorial: Editorial,
    })
    .superRefine((c, ctx) => {
      const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      if (c.ownership === 'listed' && c.listings.length === 0) add('listings', 'listed company needs ≥1 listing');
      if (!c.segments.some((s) => s.id === c.primarySegment.id)) add('segments', 'segments must include primarySegment');
      if (c.ownership === 'subsidiary' && !c.parent && !c.statusNote) add('parent', 'subsidiary needs parent or statusNote');
      if (c.profile === 'full') {
        if (c.products.length < 3) add('products', 'full profile needs ≥3 products');
        if (c.technologies.length < 2) add('technologies', 'full profile needs ≥2 technologies');
        if (c.timeline.length < 5) add('timeline', 'full profile needs ≥5 timeline events');
        if (c.sources.length < 4) add('sources', 'full profile needs ≥4 sources');
        if (c.ownership === 'listed' && !c.hasFinancials) add('hasFinancials', 'listed full profile needs financials');
      } else if (c.products.length < 1) {
        add('products', 'compact profile needs ≥1 product');
      }
    });

  // ───────────────────────── financials (JSON) ─────────────────────────
  // FY2027-Q2 | FY2025 | FY2025-H1 | 2026-08 (calendar month, for Taiwan monthly revenue)
  const PeriodLabel = z.string().regex(/^(FY\d{4}(-Q[1-4]|-H[12])?|\d{4}-(0[1-9]|1[0-2]))$/);
  const FinPoint = z
    .strictObject({
      period: PeriodLabel,
      start: IsoDate,
      end: IsoDate,
      value: z.number().finite(),
      status: z.enum(['reported', 'restated', 'preliminary', 'estimate', 'guidance']).default('reported'),
      estimateBasis: z.string().optional(),
      src: z.string(), // key into financials.sources
      note: z.string().optional(),
    })
    .refine((p) => p.start < p.end, 'start must precede end')
    .refine((p) => p.status !== 'estimate' || !!p.estimateBasis, 'estimate requires estimateBasis');
  const Series = z.strictObject({
    metric: z.enum([
      'revenue', 'gross-margin', 'operating-margin', 'operating-income', 'net-income', 'capex', 'rnd',
      'free-cash-flow', 'arr', 'rpo', 'backlog', 'data-center-revenue', 'segment-revenue',
    ]),
    periodType: z.enum(['quarter', 'half', 'year', 'month']),
    unit: z.enum(['thousand', 'million', 'billion', 'percent']),
    currency: Currency.optional(), // required unless unit = percent
    basis: z.enum(['GAAP', 'non-GAAP', 'IFRS', 'TIFRS', 'J-GAAP', 'K-IFRS', 'CAS', 'HKFRS', 'estimate']).default('GAAP'),
    label: z.string().optional(), // zh label, required for segment-revenue
    points: z.array(FinPoint).min(1),
  });
  const MixSnapshot = z.strictObject({
    group: z.enum(['business-segment', 'platform', 'product', 'node', 'region', 'customer']),
    groupZh: z.string(),
    period: PeriodLabel,
    periodType: z.enum(['quarter', 'half', 'year']),
    basis: z.enum(['value', 'share']),
    unit: z.enum(['million', 'billion', 'percent']),
    currency: Currency.optional(),
    items: z.array(z.strictObject({ name: z.string(), nameZh: z.string(), value: z.number() })).min(2),
    src: z.string(),
  });
  const financials = z
    .strictObject({
      company: ref('companies'),
      reportingCurrency: Currency,
      accountingStandard: z.enum(['US-GAAP', 'IFRS', 'TIFRS', 'J-GAAP', 'K-IFRS', 'CAS', 'HKFRS', 'none']),
      fiscalYear: z.strictObject({
        endMonth: z.number().int().min(1).max(12),
        naming: z.enum(['end-year', 'start-year']), // NVIDIA FY2027 ends Jan-2027 = end-year
        description: z.string(), // 「會計年度結束於每年一月最後一個星期日」
      }),
      series: z.array(Series).min(1),
      mix: z.array(MixSnapshot).default([]),
      guidance: z
        .array(
          z.strictObject({
            forPeriod: PeriodLabel,
            metric: z.literal('revenue'),
            low: z.number(),
            high: z.number(),
            unit: z.enum(['million', 'billion']),
            currency: Currency,
            issued: IsoDate,
            src: z.string(),
          }),
        )
        .default([]),
      sources: z.record(z.string(), Source),
      lastVerified: IsoDate,
      editorial: Editorial,
    })
    .superRefine((f, ctx) => {
      for (const s of f.series) {
        if (s.unit !== 'percent' && !s.currency)
          ctx.addIssue({ code: 'custom', path: ['series'], message: `${s.metric}: currency required` });
        for (const p of s.points)
          if (!(p.src in f.sources))
            ctx.addIssue({ code: 'custom', path: ['series'], message: `${s.metric} ${p.period}: unknown src ${p.src}` });
      }
      for (const m of f.mix)
        if (!(m.src in f.sources)) ctx.addIssue({ code: 'custom', path: ['mix'], message: `unknown src ${m.src}` });
      for (const g of f.guidance)
        if (!(g.src in f.sources)) ctx.addIssue({ code: 'custom', path: ['guidance'], message: `unknown src ${g.src}` });
    });

  // ───────────────────────── models ─────────────────────────
  const ModelVersion = z.strictObject({
    id: Slug,
    name: z.string(),
    released: IsoDate,
    status: z.enum(['announced', 'preview', 'ga', 'deprecated', 'retired']),
    tier: z.enum(['flagship', 'mid', 'small', 'reasoning', 'specialized']),
    weights: z.enum(['closed', 'open-weights', 'open-source']), // open-source = weights + code + data/recipe
    license: z.string(), // 'proprietary' | 'Apache-2.0' | 'MIT' | …
    architecture: z.enum(['dense', 'moe', 'hybrid', 'diffusion', 'unknown']).default('unknown'),
    params: z
      .strictObject({
        totalB: z.number().positive().optional(),
        activeB: z.number().positive().optional(),
        disclosed: z.boolean(),
      })
      .optional(),
    modalitiesIn: z.array(z.enum(['text', 'image', 'audio', 'video', 'pdf'])).min(1),
    modalitiesOut: z.array(z.enum(['text', 'image', 'audio', 'video', '3d', 'action'])).min(1),
    contextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    knowledgeCutoff: PartialDate.optional(),
    reasoning: z.enum(['none', 'hybrid', 'always']).default('none'),
    availability: z.array(z.enum(['api', 'chat-app', 'cloud-marketplace', 'self-host', 'on-device'])).min(1),
    pricing: z
      .array(
        z.strictObject({
          asOf: IsoDate,
          inputPerMTok: z.number().nonnegative(),
          outputPerMTok: z.number().nonnegative(),
          cachedInputPerMTok: z.number().nonnegative().optional(),
          currency: z.literal('USD'),
          tierNote: z.string().optional(),
          source: Source,
        }),
      )
      .default([]),
    benchmarks: z
      .array(
        z.strictObject({
          benchmark: z.string(), // id in src/data/benchmarks.yaml
          score: z.number(),
          setting: z.string().optional(), // 'pass@1, no tools'
          reportedBy: z.enum(['lab', 'third-party', 'leaderboard']),
          date: IsoDate,
          source: Source,
        }),
      )
      .default([]),
    notes: z.string().optional(),
  });
  const model = z
    .strictObject({
      title: z.string(), // 「Claude 系列」
      family: z.string(),
      kind: z.enum(['llm', 'image', 'video', 'audio', 'world', 'robotics', 'embedding']).default('llm'),
      lab: ref('companies').optional(), // optional for non-company labs (e.g. TAIDE)
      labName: z.string(),
      labUnit: z.string().optional(), // 'google-deepmind' (matches company.units[].id)
      origin: z.enum(['US', 'CN', 'EU', 'TW', 'KR', 'JP', 'IL', 'CA', 'ME', 'other']),
      summary: z.string().min(60).max(420),
      strengths: z.array(z.string()).min(2),
      weaknesses: z.array(z.string()).min(1),
      bestFor: z.array(z.string()).min(1),
      positioning: z.strictObject({
        // 3D scatter coordinates
        capability: z.number().min(0).max(100),
        costIndex: z.number().min(0).max(100), // log-scaled blended $/MTok → 0..100 (100 = most expensive)
        openness: z.number().min(0).max(1), // 0 closed … 1 fully open
        method: z.enum(['computed', 'editorial']),
        asOf: IsoDate,
        note: z.string(),
      }),
      versions: z.array(ModelVersion).min(1),
      flagshipVersion: z.string(),
      relatedLearn: z.array(ref('learn')).default([]),
      glossary: z.array(ref('glossary')).default([]),
      sources: z.array(Source).min(3),
      lastVerified: IsoDate,
      editorial: Editorial,
    })
    .superRefine((m, ctx) => {
      if (!m.versions.some((v) => v.id === m.flagshipVersion))
        ctx.addIssue({ code: 'custom', path: ['flagshipVersion'], message: 'must match versions[].id' });
    });

  // ───────────────────────── trends ─────────────────────────
  const trend = z.strictObject({
    title: z.string(),
    description: z.string().min(40).max(160),
    category: z.enum(['hardware', 'software', 'market', 'policy']),
    horizon: z.enum(['near', 'mid', 'long']), // 2026–27 / 2028–30 / 2030+
    horizonYears: z.tuple([z.number().int(), z.number().int()]),
    confidence: z.enum(['high', 'medium', 'low']),
    confidenceRationale: z.string().min(20),
    impact: z.enum(['high', 'medium', 'low']),
    milestones: z
      .array(z.strictObject({ date: PartialDate, label: z.string(), status: z.enum(['done', 'expected', 'speculative']) }))
      .default([]), // feeds the roadmap-tunnel scene
    signals: z
      .array(z.strictObject({ text: z.string(), date: IsoDate.optional(), source: Source.optional() }))
      .min(2),
    counterpoints: z.array(z.string()).min(1),
    relatedSegments: z.array(ref('segments')).min(1),
    relatedCompanies: z.array(ref('companies')).default([]),
    relatedModels: z.array(ref('models')).default([]),
    relatedLearn: z.array(ref('learn')).default([]),
    glossary: z.array(ref('glossary')).default([]),
    sources: z.array(Source).min(3),
    published: IsoDate,
    lastVerified: IsoDate,
    editorial: Editorial,
  });

  // ───────────────────────── glossary (YAML) ─────────────────────────
  const glossary = z.strictObject({
    term: z.string(), // display, e.g. 'HBM'
    zh: z.string(), // 「高頻寬記憶體」
    en: z.string(), // 'High Bandwidth Memory'
    aliases: z.array(z.string()).default([]),
    category: z.enum(GLOSSARY_CATEGORIES),
    level: Level,
    short: z.string().max(90), // hover card
    definition: z.string().min(40).max(700),
    example: z.string().optional(),
    related: z.array(ref('glossary')).default([]),
    learnMore: z.array(ref('learn')).default([]),
    segments: z.array(ref('segments')).default([]),
    sources: z.array(Source).default([]),
    editorial: Editorial,
  });

  // ───────────────────────── curated sources registry (YAML) ─────────────────────────
  const sourceRegistry = z.strictObject({
    name: z.string(),
    nameZh: z.string().optional(),
    kind: z.enum([
      'company-ir', 'regulator', 'exchange', 'government', 'standards-body', 'research-lab', 'academic',
      'media', 'analyst', 'dataset', 'leaderboard',
    ]),
    homepage: z.url(),
    reliability: z.enum(['primary', 'secondary', 'tertiary']),
    usage: z.string(),
    notes: z.string().optional(),
  });

  // ───────────────────────── singleton pages ─────────────────────────
  const page = z.strictObject({
    title: z.string(),
    description: z.string().max(160),
    updated: IsoDate,
    sources: z.array(Source).default([]),
    editorial: Editorial,
  });

  return { learn, segment, company, financials, model, trend, glossary, sourceRegistry, page };
}

export type Schemas = ReturnType<typeof makeSchemas>;

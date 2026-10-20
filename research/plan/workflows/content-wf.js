export const meta = {
  name: 'ai-chain-content',
  description: 'Research and write site content in batches (write → independent fact-check-and-fix), with disjoint file ownership',
  phases: [
    { title: 'Write', detail: 'one writer agent per batch' },
    { title: 'Check', detail: 'independent fact-check-and-fix agent per batch' },
  ],
}

// args: { run: 'c1', asOf?: 'YYYY-MM-DD', searchBudget: 2, limit: 1, items: [{ type, label, ids: [...], note?, skipWrite?, files? }] }
// types: glossary | segment | model | trend | company-full | company-compact | learn | pages   (create new content)
//        financials-update | refresh                                                          (update existing content; see docs/UPDATING.md)
const RUN = args.run
const SEARCH = args.searchBudget ?? 2
const ASOF = args.asOf || '2026-10-06' // the data date ("today") for this run; also set src/lib/seo.ts DATA_DATE when it changes

const COMMON = `PROJECT: 「AI 產業鏈全景」, a Traditional-Chinese (zh-TW, Taiwan usage) educational website about the AI industry chain. It goes 由淺入深 (from beginner to deep), with a company database, LLM analysis and future trends. Root: C:\\dev2 (Windows; the Bash tool runs Git Bash). DATA DATE: ${ASOF}. Treat this as "today".
MUST READ before writing: docs/CONTENT-GUIDE.md (templates, MDX components, research rules, self-checks), docs/STYLE-zh-TW.md (Taiwan terminology, punctuation, citations), docs/SEGMENTS.md (the 14 segment ids and boundaries), and the relevant schema in src/schemas/index.ts (frontmatter must match EXACTLY; strictObject rejects unknown keys).
REGISTRIES you may reference (ONLY ids that exist there): company ids in src/data/roster/*.yaml; learn slugs in src/data/curriculum.yaml; model family ids in src/data/models-index.yaml; trend ids in src/data/trends-index.yaml; glossary term ids in src/data/glossary-index/*.yaml; benchmark ids in src/data/benchmarks.yaml; scene ids and variants in docs/SCENES.md.
RESEARCH: Every number needs a source with url and an accessed date. Prefer primary sources (IR releases, filings, official blogs and pricing pages, MOPS). The preliminary research in research/scouts/*.json is a starting point only and is NOT verified. The WebSearch quota is tiny and shared: use at most ${SEARCH} WebSearch calls in total. Instead use WebFetch on known URLs (Wikipedia en/zh, company IR and newsroom pages, stockanalysis.com, tw.stock.yahoo.com, Hugging Face, official docs and pricing pages) and curl via Bash. Never invent facts. Omit what you cannot verify, or label it clearly as an estimate or a report.
STAGING (important): a shared dev server watches src/content/, and a half-written or invalid file there breaks pages for everyone. So CREATE each NEW file first at research/staging/content/<collection>/<id>.<ext> (the same relative layout as src/content/), run the self-checks on the staging path until they pass, then MOVE it into place atomically with: mv research/staging/content/<collection>/<file> src/content/<collection>/<file>. When EDITING an existing file in src/content/ (for example a financials draft), copy it to staging, edit and validate it there, then mv it back. Never leave an invalid file in src/content/.
WRITE ONLY YOUR ASSIGNED FILES. Never run astro build, npm install or git. Before finishing, run and pass with ZERO errors on your files:
  npx tsx scripts/validate-data.ts --only <your files>
  npx tsx scripts/check-zh.ts <your files>
  npx tsx scripts/check-content-rules.ts <your mdx files>
MDX pitfalls: curly braces { } and a bare < in prose break MDX, so write them in words or escape them. Component tags must be balanced. Don't use <div>, <img>, <style> or <script>. The body starts at ## (no H1).`

function writerPrompt(it) {
  const ids = it.ids.join(', ')
  switch (it.type) {
    case 'glossary': return `TASK: Write one glossary file per term in src/data/glossary-index/${it.ids[0]}.yaml, at src/content/glossary/<term-id>.yaml. Use exactly the term, zh and en from the index. Each file needs: term, zh, en, aliases (common variants, Chinese and English), category: ${it.ids[0]}, level (from the index), short (≤ 90 characters, a hover-card sentence a beginner understands), definition (120–500 characters, accurate, explains why it matters to the AI industry chain, and gives concrete numbers where useful), an optional example (an everyday analogy or concrete case), related (2–5 other term ids from ANY category file in src/data/glossary-index/), learnMore (0–2 learn slugs from src/data/curriculum.yaml), segments (0–3 segment ids), sources (1–2 authoritative sources for technical terms, for example official docs, standards bodies or papers; may be empty for very basic terms), and editorial {status: researched, author: ${it.label}}. Only write files for the terms in YOUR category file.`
    case 'segment': return `TASK: Write src/content/segments/${it.ids[0]}.mdx, the chain-segment chapter page for "${it.ids[0]}" (see docs/SEGMENTS.md for its scope). Frontmatter per the segment schema: title, titleEn, order and layer from docs/SEGMENTS.md; tagline; description; upstream and downstream segment ids; scene (from docs/SCENES.md: the scene whose main page is this segment, with the right variant); scope includes and excludes; concentration; bottleneck (level 1–5 plus a note); keyMetrics (4–8 dated, sourced numbers such as market share, capacity or prices); marketSize (3–6 points with actual/estimate/forecast status, a definition and a source, ideally 2023–2030); featuredCompanies (6–12 roster ids from THIS segment's roster file src/data/roster/${it.ids[0]}.yaml, tier 1 first); taiwanRole; relatedLearn; relatedTrends; glossary (every <Term> you use); sources (≥ 6); lastVerified ${ASOF}; editorial. Body: three <LevelSection level={1|2|3}> blocks plus "## 台灣的角色", 2,500–4,500 characters total. Level 1 is a plain-language explanation with an analogy (Callout type="analogy"). Level 2 covers key technologies, the business model and cost structure, market size and the competitive landscape. Level 3 covers bottlenecks, supply and demand, geopolitics, and what to watch in 2026–2028. Use CompanyChip for companies, Term for jargon, Cite for numbers, and BarChart/LineChart or StatGrid where data helps.`
    case 'model': return `TASK: Write src/content/models/<id>.mdx for each model family: ${ids}. Use the models-index entries (title, lab, labUnit, origin, kind) from src/data/models-index.yaml. Research the CURRENT state as of ${ASOF} from official sources: the model release blog posts, the model cards, the official API pricing page, technical reports, Hugging Face pages for open weights, artificialanalysis.ai and lmarena.ai for third-party standings. Frontmatter per the model schema: summary, strengths (≥ 3), weaknesses (≥ 2), bestFor, positioning (computed per docs/CONTENT-GUIDE.md 4.5, with a note on the method), versions (the important releases of the last ~18 months, including retired or deprecated ones with their status; params only if disclosed; contextTokens; modalities; reasoning; availability; pricing per 1M tokens from the official pricing page with asOf; benchmarks using only ids from src/data/benchmarks.yaml, each with date, source and reportedBy), flagshipVersion, relatedLearn, glossary, sources (≥ 4), lastVerified, and editorial {status: researched, author: ${it.label}}. Body: the required H2 sections from docs/CONTENT-GUIDE.md 4.5 (1,200–2,500 characters): characteristics, ideal uses, version evolution, and a balanced, dated interpretation of the benchmarks. For non-LLM kinds (image, video, audio, world, robotics) use their natural metrics, and leave pricing empty where it is not per-token.`
    case 'trend': return `TASK: Write src/content/trends/<id>.mdx for each trend: ${ids}. Titles and categories come from src/data/trends-index.yaml. Frontmatter per the trend schema: description, category, horizon plus horizonYears, confidence plus confidenceRationale, impact, milestones (5–12 dated items between 2024 and 2031, status done/expected/speculative, used by a 3D timeline), signals (≥ 4, dated and sourced), counterpoints (≥ 2), relatedSegments, relatedCompanies (roster ids), relatedModels, relatedLearn, glossary, sources (≥ 5), published ${ASOF}, lastVerified, and editorial {status: researched, author: ${it.label}}. Body: the required H2 sections from docs/CONTENT-GUIDE.md 4.6 (1,500–3,000 characters), with concrete numbers and dates and a LineChart or BarChart where a time series exists. Be balanced: clearly separate announced facts from forecasts and speculation.`
    case 'company-full': return `TASK: FULL company profiles for: ${ids}. For each id write src/content/companies/<id>.mdx and handle src/content/financials/<id>.json. Use the roster entry (src/data/roster/*.yaml) for the id, names, tier, profile, ownership, HQ, listings and segment, and keep them consistent.
FINANCIALS: If src/content/financials/<id>.json exists, it is a script-harvested DRAFT from stockanalysis.com (raw data in research/fin/<id>.json; Taiwan monthly data in research/fin-tw/<id>.json). Verify the latest 2 quarters against the company's own earnings release or IR page and add that primary source to sources (keep the existing src keys; add for example "ir-q2-2026"); correct any wrong value and add a note. Add mix (latest quarter or year business-segment or platform mix, if the company discloses it), guidance (if the company issued revenue guidance for the next quarter), and, where relevant, a data-center-revenue or segment-revenue series with a zh label. Set editorial {status: researched, author: ${it.label}}. Keep ≥ 8 quarters. If no financials file exists and the company is listed, create one from stockanalysis/IR data following the schema. For private companies, create financials only if there are reliable reported numbers (ARR or revenue, status estimate plus estimateBasis), otherwise set hasFinancials: false.
PROFILE: the company schema plus docs/CONTENT-GUIDE.md 4.1 for full profiles: summary, chainRole, moat, risks, products (≥ 4, with status, launch dates and key specs), technologies (≥ 3, with glossary ids), keyMetrics (≥ 4, dated and sourced: market share, capacity, customers, backlog, employees and so on), competitors (roster ids), relationships (key suppliers and customers as roster ids), funding (private companies), timeline (≥ 8 events through ${ASOF}), models (model family ids if it is a lab), units (business units such as AWS or Google DeepMind), hasFinancials, sources (≥ 6), lastVerified ${ASOF}, editorial. Body: the 5 required H2 sections, 1,500–3,000 characters. 營收表現解讀 must interpret the real numbers (growth drivers, margins, segment mix, guidance), with Cite markers. No investment advice.`
    case 'company-compact': return `TASK: COMPACT company profiles for: ${ids}. For each id write src/content/companies/<id>.mdx (profile: compact) and, if src/content/financials/<id>.json exists (a script-harvested draft), sanity-check its latest annual figure against one source and set its editorial {status: researched, author: ${it.label}}. hasFinancials must match whether that file exists. Do not create new financials files for compact profiles unless the company is listed and the data is easy to verify. Use the roster entry for the id, names, tier, profile, ownership, HQ, listings and segment. Frontmatter: summary (60–420 characters), chainRole, products (1–4, with status and description), technologies (0–2), keyMetrics (0–3, sourced), competitors (roster ids only), funding (private startups: the latest rounds and valuation, sourced), timeline (2–6 events, including the latest 2025–2026 development), hasFinancials, sources (≥ 2), lastVerified ${ASOF}, editorial. Body: "## 公司概況" plus optionally "## 近期動態", 200–600 characters. Verify the CURRENT status (acquired, IPO, renamed) as of ${ASOF}.`
    case 'learn': return `TASK: Write the learn articles: ${ids}. Each one goes in src/content/learn/<slug>.mdx, using the title, order, level, track, prereqs and scene from src/data/curriculum.yaml (frontmatter prerequisites = the curriculum prereqs; scenes = [{id, variant}] from the curriculum scene field, and embed it in the body with <Scene3D id=… variant=… caption=…/> at the most relevant point). Follow the template in docs/CONTENT-GUIDE.md 4.3 (一句話解釋 → 生活化比喻 → 原理 → DeepDive → 與產業鏈的連結), with length by level (L1 2,000–3,000; L2 3,000–5,000; L3 4,000–7,000 characters). Teach clearly: build intuition first, then mechanism, then numbers. Use Term for every piece of jargon (declare each in the glossary frontmatter list; ids from src/data/glossary-index/), CompanyChip/SegmentChip to connect to the industry chain, Cite for every number, and FlowSteps/Compare/StatGrid/BarChart/LineChart/MathTeX where they help understanding. keyTakeaways: 3–6 bullet sentences of at most 90 characters each. relatedSegments, relatedCompanies, relatedModels, relatedTrends: real ids. sources ≥ 4 (papers, official docs and reputable explainers). editorial {status: researched, author: ${it.label}}. The facts must be accurate and current as of ${ASOF}.`
    case 'pages': return `TASK: Site singleton content and data. Write:
(1) src/content/pages/home.mdx, chain.mdx, taiwan.mdx, methodology.mdx, about.mdx, models-intro.mdx, learn-intro.mdx (page schema; bodies of 300–1,500 characters each; home = a welcoming intro to the site and how to use it 由淺入深; chain = an overview of the 5 layers and 14 segments and how money and value flow; taiwan = Taiwan's role in the AI supply chain; methodology = data sources, fiscal-year normalisation, FX, the estimate policy, the update cadence and the fact-check process; about = purpose and disclaimer; models-intro = how to read model comparisons and benchmarks; learn-intro = how the learning path works).
(2) src/data/taiwan/sites.yaml: about 20–30 Taiwan AI-supply-chain sites and clusters (science parks, major fabs, packaging sites, server clusters, ports): { sites: [{ id, name, nameEn, lat, lon, kind: science-park|fab|packaging|server-cluster|port|research, city, companies: [roster ids], note }] }, with accurate coordinates.
(3) src/data/campuses.yaml: about 30–50 major AI data-center campuses and mega projects worldwide (for the cloud-globe scene): { campuses: [{ id, name, operator (roster id if exists, else a name), lat, lon, mw (planned or operating IT/grid capacity), status: operating|construction|planned, country, note, source }] }, sourced and dated.
(4) src/content/sources/<publisher-id>.yaml: a curated registry of about 40–60 primary data sources the site relies on (company IR portals of the largest companies, SEC EDGAR, MOPS 公開資訊觀測站, TWSE, IEA, SEMI, TrendForce, Epoch AI, Artificial Analysis, LMArena, METR, arXiv, the EU AI Act portal, BIS export controls, 國科會 and so on) per the sourceRegistry schema.
editorial {status: researched, author: ${it.label}} where the schema has it.`
    case 'financials-update': return `TASK: UPDATE the financials of: ${ids} to the data date ${ASOF}. For each id, edit src/content/financials/<id>.json (it exists and was fact-checked earlier — keep every existing verified point). Fresh raw data may be in research/fin/<id>.json and research/fin-tw/<id>.json (re-harvested by scripts/harvest/fin.ts --force --only …; if missing or older than the latest results, fetch stockanalysis.com / tw.stock.yahoo.com yourself). Append every quarter (and, for Taiwan-listed companies, every month) reported after the file's lastVerified up to ${ASOF}; verify the newest quarter against the company's own earnings release or IR page and add it as a source (e.g. key "ir-q3-2026"); update margins, segment mix, guidance (replace outdated guidance), and add notes for large moves. Keep the 8–16 most recent quarters for full profiles (drop the oldest if needed), 24 months for Taiwan monthly series. Then update src/content/companies/<id>.mdx where the new results change facts: keyMetrics (dates and values), timeline (add the earnings release and any material 2026 events), and — for full profiles — the 「營收表現解讀」 section so it interprets the newest numbers. Set lastVerified: "${ASOF}" in both files and editorial {status: researched, author: ${it.label}} (the checker will set fact-checked).`
    case 'refresh': return `TASK: REFRESH existing content to the data date ${ASOF}. Files: ${JSON.stringify(it.files ?? it.ids)}. ${it.focus ? 'FOCUS: ' + it.focus + '. ' : ''}For each file: find every time-sensitive statement (latest versions and releases, prices, benchmark standings, valuations and funding, corporate status such as IPO / acquisition / rename, capacities, market shares, dated key metrics, roadmaps and milestones) and check it against primary sources as of ${ASOF}. Add what is new since the file's lastVerified (new model versions with pricing and benchmarks, new funding rounds, new timeline events, milestones that moved from expected to done), correct what changed, and keep historical facts. Do not rewrite text that is still accurate. Set lastVerified (and updated/published where the schema has it) to "${ASOF}" and editorial {status: researched, author: ${it.label}}. If a registry entry is affected (e.g. a company was acquired → roster status/statusNote; a new model family → models-index), note it in your manifest under openQuestions instead of editing the frozen registry yourself.`
  }
}

function checkerPrompt(it, written) {
  return `ROLE: independent FACT-CHECKER and fixer (label ${it.label}-check). Another agent (${it.label}) just wrote these files: ${JSON.stringify(written?.files ?? it.ids)}.
Their manifest: ${JSON.stringify(written ?? {}).slice(0, 4000)}
TASK:
1. For each file, list every factual claim that matters: numbers, dates, product specs, prices, benchmark scores, rankings, corporate status (acquired, IPO, renamed), funding and valuations, financial figures, and "latest version" claims.
2. Verify them against the cited sources and other primary sources using WebFetch (and curl). At most ${SEARCH} WebSearch calls in total. For financials JSON, spot-check at least the latest 2 quarters and one older quarter against the company's IR releases, and check the fiscal-period labels and dates. For model files, check versions, release dates and pricing against the official pages. For learn and trend articles, check every numeric claim and technical statement for accuracy.
3. FIX errors directly in the files: correct the values, fix or replace bad source URLs, remove unverifiable claims or label them as estimates or reports, and fix zh-TW wording problems or misleading explanations. Keep the structure and the schema valid.
4. Also review the quality as an editor: is it clear 由淺入深, accurate, balanced, free of investment advice and of hype, in Taiwan Traditional Chinese, and do the cross-links use correct ids? Improve weak passages.
5. When a file is verified, set editorial.status: fact-checked, checkedBy: "${it.label}-check", checkedOn: "${ASOF}" (keep author unchanged). If serious problems remain that you cannot fix, leave status researched and put the reason in editorial.notes.
6. Run the three self-check commands from the common rules on all these files, with zero errors. Follow the STAGING rule for edits: copy to research/staging/content/…, edit and validate there, then mv back.
Return: {files, claimsChecked, errorsFound, fixed, unresolved}.`
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['done', 'partial', 'failed'] },
    sourcesCount: { type: 'integer' },
    openQuestions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['files', 'status'],
}
const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    claimsChecked: { type: 'integer' },
    errorsFound: { type: 'integer' },
    fixed: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'claimsChecked', 'errorsFound', 'fixed', 'unresolved'],
}

// Concurrency-limited pipeline: same stage semantics as pipeline(), but at most LIMIT items in flight.
// The user asked for fewer parallel agents to slow down usage. Change args.limit to tune it.
const LIMIT = (args && typeof args === 'object' && args.limit) || 2
async function limitedPipeline(limit, items, ...stages) {
  const out = new Array(items.length).fill(null)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      let v = items[i]
      try {
        for (let s = 0; s < stages.length; s++) {
          v = await stages[s](v, items[i], i)
          if (v == null) break
        }
        out[i] = v
      } catch (e) { out[i] = null }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}
log(`concurrency limit: ${LIMIT} item(s) at a time`)

const results = await limitedPipeline(LIMIT,
  args.items,
  (it) => it.skipWrite
    ? Promise.resolve({ files: it.files || it.ids, status: 'done', notes: 'The writer stage finished in an earlier run; these files are already in place. Verify them.' })
    : agent(`${COMMON}\n\nYOUR LABEL: ${it.label}\n${writerPrompt(it)}${it.note ? '\nNOTE: ' + it.note : ''}\nReturn the manifest.`,
      { label: `write:${it.label}`, phase: 'Write', schema: WRITE_SCHEMA }),
  (w, it) => agent(`${COMMON}\n\n${checkerPrompt(it, w)}`,
    { label: `check:${it.label}`, phase: 'Check', schema: CHECK_SCHEMA }).then(c => ({ label: it.label, type: it.type, write: w, check: c })),
)
const ok = results.filter(Boolean)
log(`${RUN}: ${ok.length}/${args.items.length} batches completed`)
return { run: RUN, results: ok, missing: args.items.filter((it, i) => !results[i]).map(it => it.label) }

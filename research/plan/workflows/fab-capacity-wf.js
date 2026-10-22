export const meta = {
  name: 'memory-fab-capacity',
  description: 'Fill per-fab monthly wafer capacity in src/data/memory/fabs.yaml: 3 regional researchers in parallel, then one fact-check + merge agent',
  phases: [
    { title: 'Research', detail: 'Korea / Taiwan-Japan-US-Singapore / China, patch files only' },
    { title: 'Merge', detail: 'independent fact-check, merge into fabs.yaml, validate' },
  ],
}

// args: { asOf?: '2026-10-23', searchBudget?: 12 }
const ASOF = (args && args.asOf) || '2026-10-23'
const SEARCH = (args && args.searchBudget) || 12

const COMMON = `PROJECT: 「AI 產業鏈全景」 (C:\\dev2), a zh-TW (Taiwan usage) educational website about the AI industry chain, live at https://skywitness.github.io/ai-chain/. TODAY: ${ASOF}.
CONTEXT: the new topic page /memory/ shows a 3D globe of memory fabs (scene memory-fab-map) whose column height is each site's current monthly wafer capacity (capacityKwpm, thousand 12-inch wafer starts per month) from src/data/memory/fabs.yaml (schema: memoryFabs in src/schemas/memory.ts; validator: npx tsx scripts/check-memory.ts). PROBLEM: only 7 of 59 sites have capacityKwpm (mostly Chinese sites), so China's columns look biggest while the largest sites (Samsung 華城/平澤, SK hynix 利川 M14/M16/清州, Micron 台中/林口/廣島, Kioxia 四日市/北上, CXMT 合肥) are stubs. That misleads readers. Your job is to find credible current capacity figures for the wafer fabs.
READ FIRST: src/schemas/memory.ts, src/data/memory/fabs.yaml (all sites, their ids, existing sources), the capacity sections of src/data/memory/dram.yaml, nand.yaml and hbm.yaml (company totals, e.g. Citrini Research end-2026 DRAM wafer capacity: Samsung 720, SK hynix 590, Micron 375, CXMT 350 千片/月 — reported by Tom's Hardware; that report or Citrini's own public post may include a per-fab breakdown), docs/STYLE-zh-TW.md and docs/CONTENT-GUIDE.md §1–2 (research and Source rules).
RULES: per-site capacity is rarely disclosed by the companies, so reputable ESTIMATES are acceptable and expected: analyst firms (TrendForce, Omdia, TechInsights, Counterpoint, Yole, SemiAnalysis, Citrini Research, KB/Kiwoom/Hana securities), or reputable media quoting the industry (ETNews, TheElec, Chosun Biz, Korea JoongAng Daily, BusinessKorea, DigiTimes, 工商時報, 經濟日報, Nikkei, Reuters, Bloomberg). Company disclosures (e.g. Nanya, Winbond annual reports, Kioxia IR, Micron Taiwan statements) are best. Every value: capacityKwpm in thousand 12-inch wafers per month (convert 8-inch if ever relevant and say so), capacityStatus actual (company-disclosed) / estimate (third-party) / forecast (a future-period target), a period (state it in the note, e.g. 「2025 年底估計」), the publisher, and a source with url and accessed date. Prefer 2025–2026 figures. Combined figures for a campus (e.g. 利川 M14+M16) are fine if you say which ids they cover and split only when the source splits. Do not invent or back-solve numbers; omit what you cannot support. Sanity-check sums against the company totals and say where they differ. HBM packaging, assembly/test and HDD plants have no wafer starts: skip them (you may add a note if a source gives packaging capacity in another unit). Also report any correction you find to existing fields (status, timeline, addKwpm, coordinates). At most ${SEARCH} WebSearch calls; use WebFetch and curl otherwise. Never send personal data (e.g. an email address) in request headers or URLs; use a generic User-Agent. Never run git, npm install or astro build, and do NOT edit src/data/memory/*.yaml (the merger does that).
OUTPUT: write a patch file research/staging/data/memory/fab-capacity-<region>.yaml with this shape (zh text, YAML):
  region: <region>
  updates:
    - { id: <fab id from fabs.yaml>, capacityKwpm: <number>, capacityStatus: estimate|actual|forecast, addKwpm: <optional number>, note: "<period, publisher, what the number covers>", src: <source key> }
  corrections: [ { id, field, from, to, reason, src } ]
  sources: { <key>: { title, publisher, url, type, lang, published?, accessed: "${ASOF}", note? } }   # Source format from src/schemas/common.ts
  gaps: [ "<site ids with no credible figure and why>" ]
Return a short manifest (counts, strongest/weakest figures, sum checks vs company totals).`

const REGIONS = [
  { key: 'korea', scope: 'South Korea: SK hynix 利川 M10/M14/M16, 清州 M11/M12, M15, M15X (has 40 — verify), and Samsung 華城, 平澤 P1/P2/P3 (P3 has 115 forecast — verify; the data has p1, p3, p4, p5 — say if P2 should be added as a new site with its coordinates and products), P4, 器興 (not in the list; propose it as a new site if it still runs memory lines). Separate DRAM vs NAND lines where sources do.' },
  { key: 'tw-jp-us-sg', scope: 'Taiwan, Japan, US, Singapore: Micron 台中 (A3/A5 etc.), 林口/桃園 (原華亞科), 廣島, Manassas, Singapore NAND (Fab 10 complex), Boise/Clay (construction; planned capacity → addKwpm); Kioxia/SanDisk 四日市 (Fab 2–7 combined is fine), 北上 K1, K2; Nanya 3A (company-disclosed capacity) and 5A plan; Winbond 台中 and 高雄 (Module A has 15 actual — verify). ' },
  { key: 'china', scope: 'China: CXMT 合肥 (two 12-inch fabs), 北京, new fabs in 合肥/上海 (planned → addKwpm); YMTC 武漢 fab 1–2 (has 200 — verify) and fab 3; Samsung 西安 NAND (has 150 — verify); SK hynix 無錫 C2/C2F (has 200 — verify) and 大連 fab 1 (has 100 — verify) and fab 2. Use export-control-era sources (2024–2026); note when capacity is constrained by tool access.' },
]

phase('Research')
const patches = await Promise.all(REGIONS.map((r) =>
  agent(`${COMMON}\n\nYOUR LABEL: fabcap-${r.key}. REGION: ${r.key}. SCOPE: ${r.scope}\nWrite research/staging/data/memory/fab-capacity-${r.key}.yaml.`, { label: `fabcap-${r.key}`, phase: 'Research' })
    .catch((e) => `FAILED: ${e}`)))

phase('Merge')
const merged = await agent(`${COMMON.replace('and do NOT edit src/data/memory/*.yaml (the merger does that).', '')}\n\nROLE: independent FACT-CHECKER and MERGER (label fabcap-merge). Three researchers wrote research/staging/data/memory/fab-capacity-{korea,tw-jp-us-sg,china}.yaml. Their manifests: ${patches.map((p, i) => `[${REGIONS[i].key}] ${String(p).slice(0, 2500)}`).join('\n')}
TASK: (1) Verify every proposed capacity, addKwpm and correction against its source (open the URL; confirm the number, unit, period, what it covers and who estimated it). Reject anything unsupported, mislabelled or ambiguous; prefer the most recent credible figure when sources differ and mention the spread in the note. Check that per-company sums are plausible against the company totals in dram.yaml / nand.yaml / hbm.yaml and note big gaps. (2) Merge the accepted values into src/data/memory/fabs.yaml through staging (copy to research/staging/data/memory/fabs.yaml, edit, validate with npx tsx scripts/check-memory.ts and npx tsx scripts/check-zh.ts on the staged file, then mv back). Add new sites only if well sourced (with city-level lat/lon, products, status). Add the new sources to the sources map (unique keys). Keep capacityStatus honest (estimate for third-party figures) and put the period and publisher in each note. Set editorial.notes to describe this pass, checkedBy "fabcap-merge", checkedOn "${ASOF}", lastVerified "${ASOF}". (3) If a correction affects hbm.yaml, dram.yaml or nand.yaml (e.g. a fab capacity they also list), fix that file the same way so the files agree. (4) Delete the three patch files when done. Return {accepted: n, rejected: [...with reasons], coverage: {before: 7, after: n, byCountry}, sumChecks, filesChanged}.`, { label: 'fabcap-merge', phase: 'Merge' })

return { patches, merged }

export const meta = {
  name: 'ai-chain-roster',
  description: 'Classify ~740 researched companies into 14 chain segments, dedupe, then verify and write the per-segment company roster YAML',
  phases: [
    { title: 'Classify', detail: 'one agent per scout file assigns ids and primary segments' },
    { title: 'Verify', detail: 'one agent per segment verifies status/listing/HQ and writes src/data/roster/<segment>.yaml' },
  ],
}

const SEGMENTS = [
  ['energy-power', 6], ['semi-equipment-materials', 9], ['foundry-packaging', 8], ['memory-storage', 6],
  ['eda-ip-design', 5], ['ai-accelerators', 11], ['networking-optics', 9], ['servers-systems', 10],
  ['datacenter-infra', 6], ['cloud-neocloud', 10], ['foundation-models', 9], ['devtools-data-mlops', 5],
  ['apps-agents', 6], ['physical-ai', 6],
]
const SEG_IDS = SEGMENTS.map(s => s[0])
const SCOUTS = ['compute', 'fab', 'infra', 'cloud', 'models_west', 'models_china', 'apps', 'physical', 'taiwan', 'trends', 'critic']

const CTX = `You are helping build 「AI 產業鏈全景」, a Traditional-Chinese (zh-TW) educational website about the AI industry chain. Project root: C:\\dev2. TODAY IS 2026-10-06.
Read docs/SEGMENTS.md first: it defines the 14 segment ids, their scope and boundary rules, plus the tier definitions and the M&A rules.
Read research/reg/appendix-a-seed.md: it is a seed roster with preferred ids per segment. If a company appears there, you MUST reuse that exact id.
ID RULES: kebab-case ASCII, short common English name, no legal suffixes (inc, corp, holdings, group, ltd, co). Examples: nvidia, sk-hynix, tokyo-electron, tsmc, foxconn (not hon-hai), samsung-electronics, alphabet (Google), meta, spacex (xAI merged into SpaceX), anysphere (Cursor). For Taiwan small caps, use the English short name or the seed id.`

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    rows: { type: 'array', items: { type: 'object', properties: {
      idx: { type: 'string' },
      keep: { type: 'boolean' },
      id: { type: 'string' },
      name: { type: 'string', description: 'canonical English display name' },
      nameZh: { type: 'string' },
      primarySegment: { type: 'string', enum: SEG_IDS },
      secondarySegments: { type: 'array', items: { type: 'string', enum: SEG_IDS } },
      tierGuess: { type: 'integer', enum: [1, 2, 3] },
      dropReason: { type: 'string', description: 'when keep=false: absorbed-by:<parent-id> | not-a-company | duplicate-of:<id> | out-of-scope' },
      note: { type: 'string', description: 'status facts worth keeping (acquisition, IPO, rename) with dates' },
    }, required: ['idx', 'keep', 'id', 'primarySegment', 'tierGuess'] } },
  },
  required: ['rows'],
}

phase('Classify')
const classified = await parallel(SCOUTS.map(k => () => agent(
  `${CTX}\n\nTASK: Classify every row in research/reg/scout-${k}.json (each row has an "idx"). Return exactly one output row per input row, with the same idx.\n- keep=false for: (a) companies fully absorbed by an acquirer and no longer operating independently → dropReason "absorbed-by:<parent-id>"; (b) projects, programs, or alliances that are not companies (e.g. Stargate, EU AI gigafactories) → "not-a-company"; (c) business units of a conglomerate that should live inside the parent's file (e.g. AWS → amazon, Google DeepMind → alphabet, Waymo → alphabet, Huawei Ascend → huawei, Kling → kuaishou) → "absorbed-by:<parent-id>"; (d) entries clearly outside the AI industry chain → "out-of-scope".\n- Keep companies that were acquired but still operate as a notable independent brand (e.g. Cursor/Anysphere under SpaceX). Keep pending acquisitions, and put the facts in note.\n- primarySegment must follow docs/SEGMENTS.md boundary rules. Use your judgement from the row's role/subsegment. You do not need web research for this step. Only use WebFetch if a company's identity is genuinely unclear, and do NOT use WebSearch (the quota is shared and scarce).\n- tierGuess: 1 = global top leader with decisive AI-chain impact; 2 = major player or regional leader; 3 = niche player or startup.\n- Do not create or edit any files.`,
  { label: `classify:${k}`, phase: 'Classify', schema: CLASSIFY_SCHEMA }
).then(r => r ? r.rows.map(x => ({ ...x, scout: k })) : [])))

const rows = classified.filter(Boolean).flat()
log(`classified ${rows.length} rows; kept ${rows.filter(r => r.keep).length}`)

// Merge by id (cross-scout duplicates), majority vote on primarySegment.
const byId = new Map()
for (const r of rows.filter(r => r.keep)) {
  const id = (r.id || '').toLowerCase().trim()
  if (!id) continue
  if (!byId.has(id)) byId.set(id, { id, names: new Set(), namesZh: new Set(), votes: {}, sec: new Set(), tiers: [], notes: [], idx: [] })
  const m = byId.get(id)
  if (r.name) m.names.add(r.name)
  if (r.nameZh) m.namesZh.add(r.nameZh)
  m.votes[r.primarySegment] = (m.votes[r.primarySegment] || 0) + 1
  for (const s of (r.secondarySegments || [])) m.sec.add(s)
  m.tiers.push(r.tierGuess)
  if (r.note) m.notes.push(r.note)
  m.idx.push(r.idx)
}
const dropped = rows.filter(r => !r.keep).map(r => `${r.idx} ${r.name || r.id}: ${r.dropReason || ''}${r.note ? ' — ' + r.note : ''}`)
const perSeg = Object.fromEntries(SEG_IDS.map(s => [s, []]))
for (const m of byId.values()) {
  const seg = Object.entries(m.votes).sort((a, b) => b[1] - a[1])[0][0]
  const others = Object.keys(m.votes).filter(s => s !== seg)
  perSeg[seg].push({
    id: m.id, names: [...m.names], namesZh: [...m.namesZh], tierGuess: Math.min(...m.tiers),
    alsoVotedSegments: others, secondary: [...m.sec].filter(s => s !== seg), notes: m.notes.slice(0, 3), srcIdx: m.idx,
  })
}
for (const s of SEG_IDS) log(`${s}: ${perSeg[s].length} candidates`)

phase('Verify')
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean' },
    count: { type: 'integer' },
    full: { type: 'integer' },
    handoffs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, toSegment: { type: 'string', enum: SEG_IDS }, reason: { type: 'string' } }, required: ['id', 'toSegment', 'reason'] } },
    removed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    added: { type: 'array', items: { type: 'string' } },
    issues: { type: 'string' },
  },
  required: ['written', 'count', 'full', 'handoffs', 'removed'],
}

const verified = await parallel(SEGMENTS.map(([seg, fullQuota]) => () => agent(
  `${CTX}\n\nYOUR SEGMENT: ${seg}. YOUR ONLY OUTPUT FILE: src/data/roster/${seg}.yaml. Do not write any other file.\n\nThe candidates below were classified into your segment from the research (srcIdx refers to rows in research/reg/scout-<key>.json, where you can read each company's role/latest/status_note). Also consider every company that research/reg/appendix-a-seed.md lists under your segment, and add any that are missing from the candidates.\n\nCANDIDATES (JSON):\n${JSON.stringify(perSeg[seg])}\n\nTASK:\n1. For each company, verify its CURRENT status as of 2026-10-06 (active / acquired / merged / IPO / renamed), its official English and Traditional-Chinese names (use the common Taiwan name, e.g. 輝達, 超微, 博通, 美光, 艾司摩爾; if no Chinese name exists, transliterate or keep the English), HQ city plus approximate lat/lon (city level is fine), website, founding year, ownership, and its listings (exchange enum per src/schemas/common.ts EXCHANGES, ticker as a quoted string).\n2. For listed companies, set "stockanalysis" to the stockanalysis.com path and CHECK it with curl via Bash (it is free and has no quota): curl -s -o /dev/null -w "%{http_code}" -A "Mozilla/5.0" "https://stockanalysis.com/<path>/financials/?p=quarterly" must return 200. Patterns: US → stocks/<ticker lowercase>; TWSE → quote/tpe/<code>; TPEx → quote/tpex/<code>; KRX → quote/krx/<code>; KOSDAQ → quote/kosdaq/<code>; Tokyo → quote/tyo/<code>; HKEX → quote/hkg/<4-digit code>; Shanghai/STAR → quote/sha/<code>; Shenzhen → quote/she/<code>; Euronext Amsterdam → quote/ams/<T>; Paris → quote/epa/<T>; XETRA → quote/etr/<T>; SIX → quote/swx/<T>; Stockholm → quote/sto/<T>; Toronto → quote/tsx/<T>; London → quote/lon/<T>. Prefer the home-market listing over ADRs unless only the ADR works. Use null if nothing works.\n3. For Taiwan-listed companies, set twMonthly to "<code>.TW" (TWSE) or "<code>.TWO" (TPEx).\n4. Tier: 1 = global top leader, 2 = major, 3 = niche/startup. Mark AT MOST ${fullQuota} companies with profile: full. These should be the tier-1 companies most important to the AI chain in this segment; everyone else gets profile: compact. Full profiles get deep pages with quarterly revenue charts, so prefer listed leaders, but top private labs or startups may be full.\n5. Remove a candidate only if it is fully absorbed or defunct, a duplicate of another id, or not part of this segment's scope (then hand it off with the target segment). Be COMPLETE: the user wants the most complete global coverage of tier-1/2/3 vendors and startups. You may add up to 8 important missing companies for your segment.\n6. role: one zh-TW sentence (Taiwan usage) describing its role in the AI chain.\n7. Write the YAML exactly in the format of src/data/roster/_example.yaml.txt, with the top-level "segment: ${seg}". Quote tickers and any numeric-looking strings. Order: tier 1 first, then tier 2, then tier 3. Validate with: npx tsx scripts/check-roster.ts src/data/roster/${seg}.yaml and fix every error (duplicate-id warnings against other segments' files can be reported in issues).\nRESEARCH LIMITS: WebSearch has a small shared quota, so use AT MOST 6 WebSearch calls. Prefer WebFetch of en.wikipedia.org / zh.wikipedia.org pages, official company sites and IR pages, and curl. Do not guess tickers: verify them.\nReturn the summary.`,
  { label: `verify:${seg}`, phase: 'Verify', schema: SUMMARY_SCHEMA }
).then(r => r ? ({ seg, ...r }) : null)))

return { dropped, verified: verified.filter(Boolean), perSegCounts: Object.fromEntries(SEG_IDS.map(s => [s, perSeg[s].length])) }

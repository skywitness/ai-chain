export const meta = {
  name: 'ai-chain-integration',
  description: 'Sequential integration + QA of the finished site: fixes, production build with Pagefind and scene posters, automated QA, visual review, final verification',
  phases: [
    { title: 'Fix', detail: 'known integration issues and production hygiene' },
    { title: 'Build', detail: 'production build, Pagefind, scene posters' },
    { title: 'QA', detail: 'links, routes, a11y, budgets' },
    { title: 'Visual', detail: 'screenshot review and polish' },
    { title: 'Verify', detail: 'final full verification and report' },
  ],
}

// One agent at a time, as the user asked (each step awaits the previous one).
const COMMON = `PROJECT: 「AI 產業鏈全景」 — a Traditional-Chinese (zh-TW, Taiwan usage) educational website about the AI industry chain, Astro 7.3 static output + three.js r186 scenes. Root: C:\\dev2 (Windows; Bash tool = Git Bash). Content is COMPLETE: 710 companies (99 full with financials), 38 learn articles, 40 trends, 47 model families, 14 segments, 299 glossary terms, 23 3D scenes, all page templates. Data date 2026-10-06.
YOU ARE THE INTEGRATOR: you may edit any file in the repo (including frozen foundation files, schemas, scripts and package.json scripts) when needed to fix integration problems, but keep changes minimal and consistent with the existing design (read docs/*.md and research/design/architecture.md sections 7–8 first). Never edit content facts without a source. Never run npm install of new packages unless essential (then explain why). Never run git commands.
Useful commands: npx astro check · npx tsx scripts/validate-data.ts · npx tsx scripts/check-zh.ts · npx tsx scripts/check-content-rules.ts · npm run build (= astro build + pagefind) · see docs/QA.md for the e2e/a11y/links/budgets/screenshots/posters scripts and their env vars.
DEV SERVER: http://127.0.0.1:4321/ may be running (started by the app). If it is not reachable, start one yourself in the background: npx astro dev --port 4321 --host 127.0.0.1 ; for production checks use npx astro preview --port 4322 --host 127.0.0.1 after a build.
Write throwaway files only under research/tmp/integration/. Before finishing, stop any server or browser process you started.
Return a concise report: what you changed (files), what you verified (commands + results), what remains.`

const steps = [
  { phase: 'Fix', label: 'fix-integration', prompt: `TASK 1 — fix the known integration issues:
1. Production hygiene: the pages under src/pages/dev/ (components, charts, scenes sandbox) must not be in the production build (keep them working in dev). Use the existing pattern (getStaticPaths returning [] when import.meta.env.PROD, or another clean Astro approach). The scene sandbox is needed in dev for posters/tests — keep it in dev.
2. src/components/company/FinNotes.astro:57 has a TS2538 error reported by astro check — fix it. Then make \`npx astro check\` report 0 errors overall.
3. ProfileLayout (src/layouts/ProfileLayout.astro): the facts aside comes before the main column in DOM/focus order and sits high on phones — move it after the main column in the DOM while keeping the desktop visual layout.
4. FlowSteps (src/components/content/FlowSteps.astro): switches to a horizontal layout at 36rem regardless of step count, so 5+ steps get squeezed — make the breakpoint depend on step count (or wrap gracefully).
5. Card titles (src/components/ui/Card.astro): CJK titles break awkwardly with text-wrap: balance — use a CJK-friendly rule (e.g. text-wrap: pretty / word-break: keep-all with overflow-wrap fallback) so words like 「機器人」 are not split.
6. Scene3D: add a visually-hidden-until-focused 「跳過 3D 場景」 skip link before the scene controls so keyboard users can bypass the scene's controls.
7. /glossary/ is ~255 KB gz vs the 120 KB page budget: add an explicit, documented exception for /glossary/ (and /sources/, /companies/ if needed) in scripts/check-budgets.ts rather than splitting the page (single-page #anchors are required). Also check dist/sources/bibliography.json (~2 MB): make sure it is not loaded on page view (lazy fetch only on demand) or trim it.
8. scripts/check-zh.ts flags 斗 (as in 斗山 Doosan) as Simplified — add 斗 to the ALLOW set, then restore nameZh 「斗山能源」 in src/content/companies/doosan-enerbility.mdx if the roster uses it.
9. The home page 「雲端巨頭的資本支出」 chart only has Meta and Oracle: add a quarterly capex series (metric: capex, million USD, from the companies' own earnings releases / 10-Q cash-flow statements, ≥ 8 quarters) to src/content/financials/microsoft.json, amazon.json and alphabet.json, with sources; keep the files schema-valid.
10. src/content/pages/home.mdx and chain.mdx: remove the sections that duplicate the page template's own blocks (home: 「由淺入深，三種讀法」 repeats the 三種起點 cards; chain: 「由下而上的五層」 overlaps the 五層各做什麼 section) — keep the intros concise.
Run astro check, validate-data (full), check-zh (full), check-content-rules (full): all 0 errors.` },
  { phase: 'Build', label: 'build-posters', prompt: `TASK 2 — production build, search and scene posters:
1. Run the full production build (npm run build → astro build + pagefind). Fix any build errors or content-layer warnings (e.g. dangling references).
2. Make sure Pagefind indexes the site in Chinese: test with the Pagefind Node API or by serving dist and searching 「先進封裝」「高頻寬記憶體」「TSMC」「台積電」「輝達」 — each should return the expected page in the top 3. Fix data-pagefind attributes if not.
3. Generate the scene posters for all 23 scenes in light and dark with scripts/capture-posters.ts (see docs/QA.md and docs/SCENE-CONTRACT.md for the sandbox URL; needs the dev server). Check that Scene3D shows the poster before the scene loads and when WebGL is unavailable, in both themes. Optimise sizes (≤ 120 KB each).
4. Rebuild and confirm the posters are in the build output and referenced correctly with the base path.
5. Also generate the OG section images if public/og/ is missing any.` },
  { phase: 'QA', label: 'qa-automated', prompt: `TASK 3 — automated QA on the production build (serve dist with astro preview on port 4322 or the static server in tests/helpers):
1. Internal link check over all of dist (scripts/check-links.ts) — fix every broken internal link or #fragment (fix the source, not the checker).
2. Route smoke tests over ALL routes from dist (ROUTES_FROM=dist; shard it): HTTP 200, title pattern, one h1, lang zh-TW, no console errors / page errors / failed same-origin requests, no horizontal overflow at 390 px and 320 px. Fix the failures you find (group by root cause; fix templates/components rather than individual pages).
3. Accessibility: run tests/a11y/axe.spec.ts on one URL per template in light and dark; fix every serious/critical violation.
4. Scene tests: run the scene suite for all 23 scenes against the dev server; fix failures.
5. Budgets: run scripts/check-budgets.ts; fix regressions or document justified exceptions.
6. Re-run until everything passes. Report the final pass/fail counts.` },
  { phase: 'Visual', label: 'visual-review', prompt: `TASK 4 — visual review and polish, like a demanding product designer:
1. Capture screenshots (scripts/capture-screenshots.ts or Playwright) at 1440×900 and 390×844, light and dark, of: /, /chain/, /chain/foundry-packaging/, /chain/cloud-neocloud/, /learn/, /learn/what-is-ai/, /learn/transformer-and-attention/, /learn/hbm-deep/, /companies/, /companies/tsmc/, /companies/nvidia/, /companies/openai/ (private), /companies/gudeng/ (Taiwan compact), /companies/figure-ai/ (startup compact), /models/, /models/anthropic-claude/, /models/compare/, /trends/, /trends/co-packaged-optics/, /taiwan/, /glossary/, /sources/, /about/, /404/. Also the scene pages' scenes after they load.
2. LOOK at every screenshot critically: hierarchy, spacing, zh-TW typography, alignment, overflow, empty states, chart readability, colour contrast in both themes, scene framing, consistency between page families. Make a ranked issue list.
3. Fix the significant issues (CSS/components/templates). Rebuild and re-shoot to confirm.
4. Save the final contact sheet under artifacts/screens/ (index.html).` },
  { phase: 'Verify', label: 'final-verify', prompt: `TASK 5 — final verification and report:
1. Run the complete verification sequence from docs/QA.md (astro check, validate-data, check-zh, check-content-rules, npm run build, check-links, route smoke tests on all routes, axe, scene tests, budgets) and fix anything that regressed.
2. Run scripts/report-coverage.ts and include the coverage numbers (roster vs files, financials, curriculum, models, trends, glossary, scenes, editorial status counts).
3. Write docs/QA-REPORT.md (zh-TW): what was verified, the final results of every check, known limitations / remaining minor issues, and how to deploy (static dist; Cloudflare Pages / GitHub Pages with BASE_PATH / Vercel), and how to preview locally (npm run build && npx astro preview).
4. Leave the repo clean: remove leftovers in research/staging/, stray zz-* files, and temporary servers.` },
]

const reports = []
for (const s of steps) {
  phase(s.phase)
  const r = await agent(`${COMMON}\n\nPrevious step reports (for context):\n${reports.map((x) => `## ${x.label}\n${String(x.report).slice(0, 3000)}`).join('\n\n') || '(none)'}\n\n${s.prompt}`, { label: s.label, phase: s.phase })
  reports.push({ label: s.label, report: r })
  log(`${s.label}: ${r ? 'done' : 'FAILED'}`)
}
return reports

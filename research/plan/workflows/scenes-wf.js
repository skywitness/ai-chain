export const meta = {
  name: 'ai-chain-scenes',
  description: 'Build the remaining 21 three.js scenes (one agent each), then an independent visual + accuracy review/fix per scene',
  phases: [
    { title: 'Build', detail: 'one scene per agent, own folder only' },
    { title: 'Review', detail: 'independent reviewer screenshots, critiques and fixes each scene' },
  ],
}

// args: { scenes: [{ id, brief }] }
const COMMON = `PROJECT: 「AI 產業鏈全景」, a zh-TW educational website about the AI industry chain (Astro 7 + three.js r186, vanilla TS). Root: C:\\dev2 (Windows; the Bash tool runs Git Bash). TODAY: 2026-10-06.
MUST READ: docs/SCENE-CONTRACT.md (the engine API, the folder layout, the meta.json fields, kit modules, budgets, testing; written by the 3D core agent), docs/SCENES.md (the catalogue CONTRACT: ids, required variants, host pages, data shapes), research/design/scenes3d.md (the detailed design, including your scene's entry in section B), and the two exemplar scenes src/three/scenes/neural-net/ and src/three/scenes/chain-panorama/, which set the quality bar. Match their structure and polish.
YOU OWN ONLY src/three/scenes/<your-id>/** and src/three/fixtures/<your-id>.json (if your scene needs data). Do NOT edit src/three/core/** or src/three/kit/**. If you need a new kit capability, implement it locally inside your scene folder and write proposals/scene-<id>.yaml describing it. Never run astro build, npm install or git.
DEV SERVER: http://127.0.0.1:4321/ (shared, hot reload). Your sandbox is /dev/scenes/<id>/ (with variant, step, theme and quality toggles; see SCENE-CONTRACT.md for the URL params). If the server is down, start your own: npx astro dev --port <4500 + your index> --host 127.0.0.1 (in the background) and set BASE_URL for the tests.
TEST: SCENE=<id> npx playwright test tests/scenes --config tests/scenes/playwright.config.ts (it checks ready, frames, draw calls, a non-blank render, every variant and step, reduced motion, the no-WebGL fallback, and console errors). It must pass.
ACCURACY: the scene teaches real engineering, so the structure must be correct (for example the order of the EUV optical path, the CoWoS layer stack, and the HBM die count and TSVs). Never hard-code industry statistics; use 「示意」 labels for illustrative quantities.
LANGUAGE: every label, step title, caption, hotspot and description is in Traditional Chinese (Taiwan usage), with English technical terms where customary.
TEST FILES: never create test or fixture entries inside src/content/** or src/pages/** (other agents and the validators see them). Use research/tmp/<your-label>/ for throwaway scripts and pages, and delete anything temporary you created before you finish.
INTERRUPTED WORK: a previous agent started this exact task and was cut off by a usage limit. Any files already present in the paths you own are its partial output. Inspect them first, keep what is correct and good, fix or finish the rest, and delete broken leftovers. Do not assume they work: test everything.
VISUAL BAR: calm, premium "technical diorama" style per scenes3d.md A14; legible labels; good composition at 16:9 and on mobile (4:5); correct in both light and dark themes; smooth at mid tier; within the draw-call and triangle budgets.`

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
  args.scenes,
  (s, _orig, i) => s.skipBuild ? Promise.resolve(`The builder finished scene ${s.id} in an earlier run; its files are in src/three/scenes/${s.id}/. Review them.`) : agent(`${COMMON}\n\nYOUR SCENE: ${s.id}. Fallback port: ${4500 + i}.\nBRIEF: ${s.brief}\n\nBuild the scene with ALL the required variants from docs/SCENES.md, guided steps that go 由淺入深 (step 1 is the overview, later steps add depth), hotspots with zh-TW labels and details (link hotspots to the relevant /chain/, /learn/ or /glossary/ pages when that helps), a full zh-TW text description in meta.json (at least 80 characters, describing what the scene shows for screen-reader users), reduced-motion behaviour, and theme reactivity. Take screenshots of every variant in light and dark at 1600×900 and 900×1125 with Playwright (save them in research/tmp/scenes/${s.id}/), LOOK at them, and iterate until the scene is clear, accurate and beautiful. Run the scene test until it passes. Return a manifest: files, variants, steps, hotspots, draw calls and triangles per variant, test result, and screenshot paths.`,
    { label: `scene:${s.id}`, phase: 'Build' }),
  (built, s) => agent(`${COMMON}\n\nROLE: independent REVIEWER and fixer for scene "${s.id}" (you may edit only src/three/scenes/${s.id}/** and src/three/fixtures/${s.id}.json).\nBRIEF: ${s.brief}\nBuilder manifest: ${String(built).slice(0, 5000)}\n\nTASK: (1) Run the scene test. (2) Screenshot every variant and step in both themes, at desktop and mobile sizes, and look at each image critically, like a demanding art director and a domain expert: Are the composition and camera framing good? Are the labels readable and not overlapping? Is the colour contrast right in both themes? Is anything clipped, empty or confusing? Is the engineering accurate? Is the learning progression across the steps clear? Is the zh-TW wording natural (Taiwan usage)? (3) Fix every significant problem you find directly in the code. (4) Re-run the test and the screenshots to confirm. Return {issuesFound: [...], fixed: [...], remaining: [...], testPassed: boolean}.`,
    { label: `review:${s.id}`, phase: 'Review' }).then(r => ({ id: s.id, built, review: r })),
)
return results.filter(Boolean)

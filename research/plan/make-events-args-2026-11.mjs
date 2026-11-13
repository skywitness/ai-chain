// Builds research/plan/events-args-2026-11-13.json for research/plan/workflows/content-wf.js:
// company events (+ Q3 financials where reported), trends and segments found by the 2026-11-13 audit
// (research/plan/audit-2026-11-13.md). Leads are unverified: the content-wf agents verify them.
// Excluded on purpose: NVIDIA and Anthropic (wait for 11-17 results and the ~11-19 IPO) and the files the
// models update owns (companies stepfun, bytedance, deepseek, spacex, mistral-ai, reflection-ai, meituan;
// trends/open-weights-race; segments/foundation-models).
import { writeFileSync } from 'node:fs';

const ASOF = '2026-11-13';
const NO_NVIDIA = 'Do not change statements about NVIDIA\'s CEO or Anthropic\'s IPO in this pass (a later pass handles them after 2026-11-19).';

// listed companies with a newly reported quarter: financials-update + event leads
const FIN = {
  lumentum: 'EVENT: 2026-11-02 Marvell agreed to acquire Lumentum in an all-stock deal (4.5 MRVL shares per LITE share, implied EV about US$115B; outside date 2027-11-01, extendable to 2028-08-01; closing expected 1H28). Sources: https://www.cnbc.com/2026/11/02/marvell-lumentum-ai-deal.html , Marvell 8-K https://www.sec.gov/Archives/edgar/data/1835632/000119312526442717/d352474d8k.htm',
  'mitsui-chemicals': 'EVENT: 2026-11-09 Mitsui Chemicals, with ¥200B of preferred equity from the Development Bank of Japan, agreed to buy JSR from JIC for ¥1.84T including debt (about US$11.6B). Source: https://www.thestar.com.my/tech/tech-news/2026/11/09/mitsui-chemicals-and-dbj-to-buy-jsr-for-116-billion-filing-shows — confirm with the company release.',
  coreweave: 'Q3 (11-10): revenue $3.661B; backlog about $132.5B; >1.7 GW active and 4.6 GW contracted; FY26 guidance revenue $13.0–13.3B, capex $37–39B. Source: https://www.sec.gov/Archives/edgar/data/1769628/000176962826000461/coreweave3q26earningspress.htm',
  nebius: 'Q3 (11-12; stockanalysis may lag — use the company release): revenue $980.8M; ARR $6.4B, the >$7B ARR target moved to Feb 2027; 2026 capex about $27B; 2027 guidance revenue $12–13B, capex $40–45B (from a secondary summary https://www.stocktitan.net/articles/nebius-q3-2026-earnings-revenue-arr-targets — verify on nebius.com IR).',
  cerebras: 'Q3 (11-12): GAAP revenue $210.8M (+55%); FY26 core revenue guidance $940–960M; Oracle will offer Cerebras inference on OCI from 2027. Source: https://www.sec.gov/Archives/edgar/data/0002021728/000162828026073366/cbrsannouncesfinancialresu.htm',
  terawulf: 'EVENT: Google is backstopping the debt for the Anthropic lease at Hawesville (11-04). Verify with the company release.',
  microsoft: 'FY27Q1 (10-28): calendar-2026 capex cut to approximately $170B (from about $175B) because of third-party capacity delays, Q2 expected above $50B; commercial RPO $677B (+73%); Azure +48%; Maia 300 (N2P, 8× HBM4, multi-GW deployments from 2027, blog 10-12). Fix stale future-tense text 「預計 2026 年 10 月…」 in the file. Sources: https://www.microsoft.com/en-us/investor/events/fy-2027/earnings-fy-2027-q1 , https://blogs.microsoft.com/blog/2026/10/12/microsoft-to-expand-azure-maia-system-to-multi-gigawatt-deployments/',
  alphabet: 'Q3: Google Cloud revenue $30.71B (+103%), backlog $560.8B (site has $514B); capex guidance unchanged $195–205B with a significant increase in 2027; Q3 purchases of PP&E $51.36B. Sources: https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm , 10-Q https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/goog-20260930.htm',
  amazon: 'Q3: AWS $45.98B (+39%); RPO about $578B (site has $496B); capex about $220B for 2026 unchanged; a secured facility of up to about $80B; Q3 gross PP&E purchases $77.26B. Sources: https://www.sec.gov/Archives/edgar/data/1018724/000101872426000038/amzn-20260930xex991.htm , 10-Q https://www.sec.gov/Archives/edgar/data/1018724/000101872426000040/amzn-20260930.htm',
  meta: 'Q3: capex guidance narrowed to $135–145B; Q3 PP&E purchases $33.94B; financing: $25B common stock via forward sale plus a $12.5B mandatory convertible (10-27), $15B USD notes (11-05) and €9B (11-12), planned ATM up to $60B from 2027. Source: https://www.sec.gov/Archives/edgar/data/1326801/000162828026066700/meta-09302026xexhibit991.htm and Meta pricing releases on investor.atmeta.com',
  tsmc: 'Q3: revenue US$46.72B, gross margin 66.4%; Q4 guidance $52.3–54.3B; 2026 growth about 44% in USD; capex unchanged $60–64B; N2 8% of Q3 wafer revenue; N2-family capacity more than doubles by 2027; A14 risk production 2027, volume 2028; Arizona fab 2 volume 3Q27; October revenue NT$586.89B (+59.7% YoY). Sources: 6-K https://www.sec.gov/Archives/edgar/data/0001046179/000104617926000726/a3q26e_withguidancexfinal.htm , https://pr.tsmc.com/english/news/3349',
  amd: 'Q3: revenue $13.4B; data center $8.5B (+97%); Q4 guidance about $17B; AMD 10-Q values the Taalas deal at about $2.9B (up to ~$1.4B contingent; not closed). Sources: https://www.sec.gov/Archives/edgar/data/2488/000000248826000188/q32026991.htm , https://www.sec.gov/Archives/edgar/data/0000002488/000000248826000191/amd-20260926.htm',
  intel: 'Q3: revenue $16.5B; foundry $6.7B with a $1.85B operating loss. Source: https://www.sec.gov/Archives/edgar/data/50863/000005086326000188/q326earningsrelease.htm',
  asml: 'Q3 (10-15): 2026 revenue outlook €44–45B. Verify on asml.com IR.',
  'applied-materials': 'FQ4 2026 revenue $10.41B (verify on ir.appliedmaterials.com; FQ4 ended late October).',
  'lam-research': 'FQ1 FY27 revenue $8.22B. Fix stale future-tense text 「將於 2026 年 10 月…」 in the file.',
  'sk-hynix': 'Q3: revenue ₩104.6T, operating profit ₩83.3T (80% margin); HBM4 to pass HBM3E in 4Q; LTAs cover >50% of 2027–28 capacity; M15X max capacity by end-2026. Source: https://news.skhynix.com/q3-2026-business-results/ (consistent with src/data/memory/hbm.yaml, updated 2026-11-13).',
  'samsung-electronics': 'Q3: operating profit ₩107.4T, of which DS ₩106.5T; HBM4 ~60% of 3Q HBM revenue; 2027 HBM sold out; 2026 capex ~₩84.4T. Source: https://images.samsung.com/is/content/samsung/assets/global/ir/docs/2026_3Q_conference_eng.pdf',
  'ge-vernova': 'Q3: gas turbine backlog plus slot reservations 122 GW (64 + 58) at end-Q3; year-end target raised to at least 130 GW. Source: https://www.sec.gov/Archives/edgar/data/1996810/000199681026000162/gevpressrelease3q26.htm',
  caterpillar: 'EVENT: Anthropic bought about $3.4B of Caterpillar turbines, up to 1.7 GW (FT via TechCrunch 11-09: https://techcrunch.com/2026/11/09/anthropic-joins-ais-natural-gas-frenzy-buys-3-4b-worth-of-turbines/) — reported; state it as reported.',
  iren: 'EVENT: ARR target moved to Jan 2027.',
  'cipher-mining': 'EVENT: $850M convertible notes.',
  'core-scientific': 'EVENT: leaving bitcoin mining in Q4 2026.',
  advantech: 'Fix stale future-tense text 「預計 2026 年 10 月…」 in the file (find out what happened).',
  ajinomoto: 'Fix stale future-tense text 「預定 2026 年 11 月…」 in the file.',
  'digital-realty': 'Fix stale future-tense text 「將於 2026 年 10 月…」 in the file.',
  disco: 'Fix stale future-tense text 「預定…（2026 年 10 月…」 in the file.',
  hiwin: 'Fix stale future-tense text 「預計 2026 年 11 月…」 in the file.',
  'hon-precision': 'Fix stale future-tense text 「預計 2026 年 10 月…」 in the file.',
  ibiden: 'Fix stale text about 「2026 年 10 月至 2027 年 3 月的營收與獲利，將…」 in the file.',
  sunon: 'Fix stale future-tense text 「預定於 2026 年 10 月…」 in the file.',
};

// companies without a new quarter on the site's financial sources: refresh with leads (2 per batch)
const REFRESH = {
  firmus: 'ASX IPO withdrawn 2026-10-09 (terms A$11/share, A$7.1B raise, ticker AIF); exploring a US$2–3B private round (Bloomberg). Source: https://www.abc.net.au/news/2026-10-09/firmus-float-gets-pulled-following-lacklustre-investor-demand/107246230 . Roster statusNote says listing expected 10-22 — report the registry change.',
  nscale: 'IPO still not priced; reportedly weighing a delay of the NYSE IPO to 2027 (Telegraph/Reuters 11-10); Microsoft dropped its anchor deal at Loughton (UK) around 10-19 and declined a Texas expansion option (FT/Reuters ~11-10); reportedly in talks with Anthropic over a second $45B compute deal (Bloomberg 10-19). All reported. Sources: https://techfundingnews.com/nvidia-backed-nscale-weighs-delaying-35b-listing-as-microsoft-passes-on-texas-expansion/ , https://techcrunch.com/2026/10/19/nscale-and-anthropic-are-reportedly-in-talks-for-yet-another-45-billion-compute-deal/',
  'agility-robotics': 'SPAC merger with Churchill XI closed 2026-11-04; trading on Nasdaq as AGLT from 11-05; gross proceeds about $465M. Sources: https://www.agilityrobotics.com/news , https://techcrunch.com/2026/11/05/agility-is-the-first-pure-humanoid-robot-company-on-the-stock-market-are-you-buying/ . Report the roster change (listing, ownership).',
  'character-ai': 'Filed for Chapter 11 on 2026-10-13; Disney is the stalking-horse bidder ($20M plus a license) and is hiring most of the staff; sale expected to close late Nov or early Dec. Fix the stale 「預期出售程序於 2026 年 11 月」 text. Source: https://techcrunch.com/2026/10/13/just-5-years-in-interactive-chatbot-platform-character-ai-files-for-bankruptcy/ . Report the roster status change.',
  'shield-ai': '2026-11-05: $1B Series H at $28.8B post-money (site shows $12.7B), plus $1B structured equity from Blackstone and $500M debt from JPMorgan; acquiring Echodyne (not in roster) for $5.3B, closing early 2027; now brands itself "Shield". Source: https://shield.ai/shield-to-acquire-echodyne-in-a-transaction-valued-at-5-3-billion-and-raise-2-5-billion-at-a-28-8-billion-valuation/',
  jsr: 'Mitsui Chemicals with ¥200B DBJ preferred equity agreed on 2026-11-09 to buy JSR from JIC for ¥1.84T including debt (about $11.6B). Report the roster change (pending acquisition).',
  'fermi-america': 'The 15-year, $6.5B AMD-backed TensorWave lease was terminated; an unnamed investment-grade hyperscaler takes an initial 600 MW from 2027, with only a $200M prepayment and a $15M early-works agreement signed. Source: https://www.sec.gov/Archives/edgar/data/2071778/000121390026118351/ea031197701ex99-1.htm',
  tensorwave: 'Its 15-year $6.5B lease at Fermi America\'s Project Matador was terminated (Fermi 8-K exhibit https://www.sec.gov/Archives/edgar/data/2071778/000121390026118351/ea031197701ex99-1.htm).',
  tenstorrent: '$1.5B Series E at a $6.2B post-money valuation on 2026-10-19 (https://theaiinsider.tech/2026/10/19/tenstorrent-announces-a-1-5b-series-e-at-a-6-2b-valuation/ — confirm with the company release).',
  openai: 'New round reported (not closed): first reported 10-22 as up to $30B, target cut to up to $20B on 10-31, valuation $1.25T (pre/post unclear), about $11B raised so far (Bloomberg via TechCrunch 11-06); Brockman said 11-05 the company could be "IPO ready" in 2027. Also GPT-6.1 Terra (10-26) and GPT-6 as ChatGPT default (10-07) — keep model detail brief and consistent with src/content/models/openai-gpt.mdx. Sources: https://www.cnbc.com/2026/10/31/openai-fundraising-20-billion-valuation.html , https://techcrunch.com/2026/11/06/openai-reportedly-raises-an-additional-11-billion-at-a-1-25-trillion-valuation/',
  'thinking-machines-lab': 'Reportedly near a $5B round at $40B pre-money led by Accel; NVIDIA in talks for about $2.5B (Business Insider 11-06; https://dealroom.co/news/170334-thinking-machines-lab-nears-5b-round-at-40b-valuation-led-by-accel/). Inkling 2 Small released 11-05 (see the models file).',
  'physical-intelligence': 'In talks to raise at least $1B at about $20B (Bloomberg 10-27; https://thenextweb.com/news/physical-intelligence-20bn-valuation-talks-bloomberg). Reported only.',
  lambda: 'Raising up to $4B at $14.5B pre-money (WSJ 10-06); backlog $50B including $35B from Anthropic; IPO planned for 2027; Alabama campus about $33.1B in Lowndes County (company, 11-04). Sources: https://techcrunch.com/2026/10/06/ai-computing-startup-lambda-to-raise-4b-ahead-of-planned-ipo , https://lambda.com/blog/lambda-to-invest-33-billion-in-alabama-with-new-data-center',
  fal: '$1.3B Series F at $16B on 2026-11-03 (site shows $4.5B). Source: https://techcrunch.com/2026/11/03/ai-inference-startup-fal-doubles-its-valuation-to-16b-as-demand-surges/',
  legora: '$550M Series E at $8.8B (2026-10-21). Source: https://techcrunch.com/2026/10/21/legal-ai-startup-legora-raises-550m-series-e-at-8-8b-valuation/',
  furiosaai: '$620M Series D at about $2.9B (2026-10-28). Source: https://thenextweb.com/news/furiosaai-series-d-620m-2-9bn-valuation',
  manus: 'Raised more than $500M, its first round since the Meta deal ended (2026-10-08). Source: https://techcrunch.com/2026/10/08/chinas-manus-raises-over-500m-in-first-funding-round-since-split-with-meta/',
  ymtc: 'The parent\'s STAR Market IPO is paused, possibly until 1H27 (Reuters 11-04; https://www.businesskorea.co.kr/news/articleView.html?idxno=280615); fab 4 construction from 2027 with ≥60% domestic tools (consistent with src/data/memory/fabs.yaml).',
  kunlunxin: 'Hong Kong IPO may slip to 2027 (Bloomberg 11-03); Baidu denied it. Source: https://www.thestandard.com.hk/finance/article/347348/Baidus-AI-chip-unit-Kunlunxin-may-defer-HK-IPO-in-2027-Bloomberg',
  'scale-ai': 'CORRECTION: Francis deSouza has been CEO since 2026-08-10; the site still names Droege. Source: https://axios.com/2026/07/30/scale-ai-google-cloud-coo-francis-desouza',
  taalas: 'AMD\'s 10-Q values the deal at about $2.9B, of which up to about $1.4B is contingent; not yet closed (statusNote says amount undisclosed). Source: https://www.sec.gov/Archives/edgar/data/0000002488/000000248826000191/amd-20260926.htm',
  crusoe: 'Google bought its Wyoming site (11-06); $700M credit facility (10-22). Source: https://www.crusoe.ai/resources/newsroom/crusoe-wyoming-data-center-campus-update',
  humain: 'Aramco reportedly completed its 49% purchase from PIF for about $2.6B (secondary source only — verify or omit).',
  cohere: 'Letter of intent to acquire AISLE (10-15); the Aleph Alpha merger has still not closed.',
  'hugging-face': 'DOJ is asking competition questions about the NVIDIA deal. ' + 'Leave any NVIDIA-CEO wording unchanged in this pass.',
  'vast-data': 'Hyundai/Kia investment; 14 customers committed more than $10B.',
  'd-matrix': 'NVIDIA investment reported, not confirmed — state as reported or omit.',
  'nous-research': 'Raised at a valuation of about $1.35–1.5B (Crunchbase 11-10).',
  upstage: 'Raised at a valuation of about $1.35–1.5B (Crunchbase 11-10).',
  labelbox: 'Raised at a valuation of about $1.35–1.5B (Crunchbase 11-10).',
  groq: 'CHECK: a report says "$350M at $3.5B, 2026-08-17" (TechCrunch), which conflicts with the site\'s "~$650M in 2026". Resolve from primary sources.',
  'lace-lithography': 'Fix stale text 「2026 年 10 月，官網尚未公布…」 in the file.',
  trumpf: 'Fix stale future-tense text 「預定 2026 年 10 月…」 in the file (results of fiscal year ending June are published in October).',
  marvell: 'EVENT: 2026-11-02 agreed to acquire Lumentum (all-stock, 4.5 MRVL per LITE, implied EV ~US$115B; outside date 2027-11-01 extendable to 2028-08-01; close expected 1H28). Its next quarter reports in early December, so no new financials now. Sources: https://www.cnbc.com/2026/11/02/marvell-lumentum-ai-deal.html , 8-K https://www.sec.gov/Archives/edgar/data/1835632/000119312526442717/d352474d8k.htm',
  oracle: 'Investor Day 10-28: FY27 revenue ≥ $90B; FY30 revenue ≥ $225B with operating margin ≥ 40%; capex peaks in FY27–28; new capital capped at $20B for FY27–30; raised $10B equity plus $10B notes at 7.00–8.65% (11-02/04). Next quarter reports in December. Sources: https://www.sec.gov/Archives/edgar/data/1341439/000119312526435853/d75538dex991.htm , https://www.sec.gov/Archives/edgar/data/1341439/000119312526447507/d131790d8k.htm',
  broadcom: 'EVENT: a residual-value backstop of about $43B for an SPV holding AI racks (8-K 10-27, https://www.sec.gov/Archives/edgar/data/1730168/000119312526434271/d148323d8k.htm). Next quarter reports in December.',
  'schneider-electric': 'Q3 revenue update (Schneider reports revenue only for Q3); fix stale text 「2026 年 10 月 29 日公布…」 in the file.',
};

// trends (1 per batch)
const TRENDS = {
  'export-controls-us-china': 'Milestone 2026-11-10 (expected) → done: a BIS rule in the Federal Register on 2026-11-09 extends the suspension of the affiliates rule from 11-09 to 2027-01-10; add 2027-01-10 as a new expected milestone; fix the stale 「尚未公布，美中休戰在 2026 年 11 月…」 and 「將在 2026 年 11 月…」 text. Source: https://www.federalregister.gov/documents/2026/11/09/2026-22793/extension-of-the-suspension-of-expansion-of-end-user-controls-for-affiliates-of-certain-listed . Section 232 chip tariff changes (10-14 Federal Register notice on Proclamation 11032) were not verified — check.',
  'hyperscaler-capex': 'Milestone 2026-10 (Q3 earnings) → done. CORRECTION: Microsoft\'s ~$175B was for CALENDAR 2026, not FY2027; on 10-28 it was cut to approximately $170B (companies/microsoft.mdx is already right). Q3 PP&E purchases (cash, excl. finance leases): MSFT $39.37B ($45.2B incl. finance leases), GOOGL $51.36B, AMZN $77.26B gross, META $33.94B — sum about $201.9B vs about $165B in Q2 (re-check). Guidance: Alphabet $195–205B unchanged with a significant 2027 increase; Amazon about $220B unchanged; Meta narrowed to $135–145B; Microsoft CY2026 ~ $170B. TrendForce 10-14: nine large CSPs 2026 $957B (+106%), 2027 > $1.5T (+60%); AI server revenue about $479B in 2026 and $920B in 2027 (https://www.trendforce.com/presscenter/news/20261014-13269.html). Site states "more than $886.7B for 2026, about $1.3T for 2027" — update.',
  'power-bottleneck-onsite-generation': 'GE Vernova reached 122 GW (backlog 64 + slot reservations 58) at end-Q3 and raised its year-end target to at least 130 GW (site milestone: ≥125 GW by year-end). Anthropic bought about $3.4B of Caterpillar turbines, up to 1.7 GW (FT via TechCrunch 11-09, reported). Sources: https://www.sec.gov/Archives/edgar/data/1996810/000199681026000162/gevpressrelease3q26.htm , https://techcrunch.com/2026/11/09/anthropic-joins-ais-natural-gas-frenzy-buys-3-4b-worth-of-turbines/',
  'ai-infra-financing-bubble': 'Meta: $25B common stock via forward sale plus $12.5B mandatory convertible (10-27), $15B USD notes (11-05) and €9B (11-12), planned ATM up to $60B from 2027. Oracle: $10B equity plus $10B notes at 7.00–8.65% (11-02/04). Broadcom: residual-value backstop of about $43B for an SPV holding AI racks (8-K 10-27). Amazon: secured facility up to about $80B. Fermi: TensorWave lease terminated. Microsoft commercial RPO $677B, +73% (site has $678B, +84% — fix). Sources: Broadcom 8-K https://www.sec.gov/Archives/edgar/data/1730168/000119312526434271/d148323d8k.htm , Oracle 8-K https://www.sec.gov/Archives/edgar/data/1341439/000119312526447507/d131790d8k.htm , Meta releases on investor.atmeta.com',
  'physical-ai-commercialization': 'Agility Robotics\' SPAC merger closed 11-04, trading as AGLT from 11-05 (gross proceeds ~$465M); Shield AI $28.8B; Physical Intelligence talks at ~$20B (reported). Check other humanoid milestones in the file (Figure reported ~$38B talks seen only on aggregators — verify or omit).',
  'process-roadmap-2nm-and-beyond': 'N2P volume in 2H26 is not confirmed by TSMC. TSMC said: N2 was 8% of Q3 wafer revenue; N2-family capacity more than doubles by 2027; A14 risk production 2027, volume 2028; Arizona fab 2 volume 3Q27. Microsoft Maia 300 uses N2P, deploying 2027. Sources: TSMC 6-K https://www.sec.gov/Archives/edgar/data/0001046179/000104617926000726/a3q26e_withguidancexfinal.htm , https://blogs.microsoft.com/blog/2026/10/12/microsoft-to-expand-azure-maia-system-to-multi-gigawatt-deployments/',
  'memory-supercycle': 'Align with the memory topic data updated on 2026-11-13 (src/data/memory/*.yaml): Q4 DRAM forecast still +10–15% (TrendForce 9-30); new on 11-11: PC DRAM +13–18% in 4Q, PC OEMs building inventory, 1Q27 procurement revised down; SK hynix and Samsung Q3 records; 2027 DRAM bit supply growth 24%; Counterpoint 3Q26 DRAM revenue ~US$200B. Link to /memory/ and the Phison/Micron model pages is already on the page.',
  'hbm4-custom-base-die': 'Align with src/data/memory/hbm.yaml (2026-11-13): SK hynix HBM4 overtakes HBM3E in 4Q26; Samsung HBM4 ~60% of 3Q HBM revenue, HBM4E mass production 1H27; Samsung and SK hynix passed NVIDIA 12-Hi HBM4 qualification; report (unconfirmed) Rubin Ultra may use 8-Hi HBM4.',
  'custom-asic-rise': 'Microsoft Maia 300: N2P, 8× HBM4, multi-GW deployments from 2027 (blog 10-12); Broadcom SPV backstop (8-K 10-27); Cerebras inference on OCI from 2027; check Google TPU / AWS Trainium / OpenAI chip news since 10-06 (Trainium 3/4, Ironwood successors) from official sources. No roadmap update found for Rubin Ultra/Feynman.',
  'nuclear-smr-for-ai': 'Constellation signed a 20-year PPA with Google funding more than $4.3B of uprates (about 890 MW, first in 2028) and has a DOE conditional loan guarantee of up to $5B (https://www.sec.gov/Archives/edgar/data/1168165/000186827526000116/ceg-20261109991.htm). SMR companies (Oklo, X-energy, Kairos, TerraPower) were not checked — check official newsrooms for milestones since 10-06.',
  'reverse-acquihire-deals': 'Character.AI: Chapter 11 on 10-13, Disney stalking-horse ($20M plus a license) hiring most of the staff. Anthropic–Opaque license plus acqui-hire (around 10-13) — verify. Manus raised >$500M after its Meta deal ended (10-08).',
  'scale-up-fabric-wars': 'Milestone 2026-10 「乙太網路 scale-up 交換器開始部署（博通與 Dell\'Oro 的預期）」 is still expected — verify whether deployments started (Broadcom Tomahawk Ultra / SUE, UALink, NVLink Fusion news since 10-06) and update the status or move the date.',
};

const SEGMENTS = {
  'cloud-neocloud': 'Q3 hyperscaler capex and backlog (see hyperscaler-capex lead), CoreWeave/Nebius Q3, Lambda funding and Alabama campus, Nscale and Firmus IPO changes, Crusoe/Google Wyoming.',
  'foundry-packaging': 'TSMC Q3 (revenue US$46.72B, GM 66.4%, Q4 guide $52.3–54.3B, N2 8% of Q3 wafer revenue, capex $60–64B, October revenue NT$586.89B); the page still uses Q2 and August data.',
  'ai-accelerators': 'AMD Q3 (revenue $13.4B, data center $8.5B +97%, Q4 guide ~$17B), Intel Q3, Cerebras Q3, Tenstorrent and FuriosaAI rounds, Maia 300, Taalas deal value. Do not change NVIDIA CEO statements in this pass (later pass after 11-19); NVIDIA Q3 FY27 results come 11-17.',
  'semi-equipment-materials': 'ASML 2026 outlook €44–45B, Applied Materials FQ4 $10.41B, Lam $8.22B, Mitsui Chemicals–JSR acquisition (¥1.84T).',
  'memory-storage': 'Align with src/data/memory/*.yaml updated 2026-11-13 (SK hynix and Samsung Q3, HBM4, prices, storage EB) and the /memory/ topic.',
};

const items = [];
let n = 0;
const lbl = (p) => `${p}-${String(++n).padStart(2, '0')}`;
for (const [id, note] of Object.entries(FIN)) items.push({ type: 'financials-update', label: lbl('evfin'), ids: [id], note: `${note} ${NO_NVIDIA}` });
const ref = Object.entries(REFRESH);
for (let i = 0; i < ref.length; i += 2) {
  const pair = ref.slice(i, i + 2);
  items.push({
    type: 'refresh', label: lbl('evco'), ids: pair.map(([id]) => id), files: pair.map(([id]) => `src/content/companies/${id}.mdx`),
    focus: 'corporate events since lastVerified: funding and valuation, IPO/listing, M&A, bankruptcy, leadership, major deals; stale future-tense text about October–November 2026',
    note: pair.map(([id, l]) => `[${id}] ${l}`).join(' ') + ` ${NO_NVIDIA} If the roster (src/data/roster/*.yaml) needs a change (status, statusNote, listings), put the exact proposed change in openQuestions — the integrator applies it.`,
  });
}
for (const [id, note] of Object.entries(TRENDS)) items.push({ type: 'refresh', label: lbl('evtr'), ids: [id], files: [`src/content/trends/${id}.mdx`], focus: 'milestones (expected → done, new dates), signals and key numbers since lastVerified; keep milestone statuses honest', note: `${note} ${NO_NVIDIA}` });
for (const [id, note] of Object.entries(SEGMENTS)) items.push({ type: 'refresh', label: lbl('evseg'), ids: [id], files: [`src/content/segments/${id}.mdx`], focus: 'key numbers, market sizes, leaders and recent developments since lastVerified', note: `${note} ${NO_NVIDIA}` });

const args = { run: `events-${ASOF}`, asOf: ASOF, searchBudget: 3, limit: items.length, items };
writeFileSync('research/plan/events-args-2026-11-13.json', JSON.stringify(args));
console.log(`${items.length} items: ${Object.keys(FIN).length} financials+events, ${Math.ceil(ref.length / 2)} company refresh batches (${ref.length} companies), ${Object.keys(TRENDS).length} trends, ${Object.keys(SEGMENTS).length} segments → ${items.length * 2} agents`);

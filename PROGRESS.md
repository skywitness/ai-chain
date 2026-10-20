# AI 產業鏈全景：工作進度紀錄

## ✅ 專案完成（2026-10-20）

所有內容、3D 場景、頁面模板、整合與 QA 都已完成。完整驗證結果、已知限制與部署方式見 **`docs/QA-REPORT.md`**。

| 檢查 | 結果 |
|---|---|
| `astro check` | 0 錯誤 |
| `validate-data` | 1,656 個檔案，0 錯誤 |
| 建置 | 861 頁，Pagefind 索引 857 頁 |
| 連結檢查 | 32,279 條連結，0 失效 |
| 路由冒煙測試 | 1,723 項通過 |
| 無障礙（axe） | 68/68 |
| 3D 場景測試 | 184/184 |
| 大小預算 | 全部在預算內 |
| GitHub Pages（base path） | 驗證通過 |

- 整合 run：`wf_6f186578-e36`，5 個步驟全數成功。
- 截圖總覽：`artifacts/screens/index.html`。
- 部署前一定要設定 `SITE_URL`（必要時也設定 `BASE_PATH`）。
- **已上線（2026-10-20）**：https://skywitness.github.io/ai-chain/
  - GitHub repo：https://github.com/skywitness/ai-chain（公開，分支 `main`）。
  - push 到 `main` 時，`.github/workflows/deploy.yml` 會以 `BASE_PATH=/ai-chain/` 自動建置並部署。
  - 第一次部署 run 39434199569 成功。線上檢查結果：首頁 3D 場景正常、console 沒有錯誤、中文搜尋「台積電」的第 2 筆就是公司頁。
- **之後的更新**請依 **`docs/UPDATING.md`**。根目錄的 `CLAUDE.md` 會讓新的 session 自動讀到這份指南。
  - 參數產生器：`scripts/plan/make-update-args.mjs`。
  - `content-wf.js` 新增了 `financials-update` 與 `refresh` 兩種類型，以及 `asOf`（資料基準日）參數。

---

## （歷史紀錄）最新狀態與接手方式（2026-10-18，用量即將用完前記錄）

**已完成**
- 23 個 3D 場景
- 6 組頁面模板
- 38 篇學習文章
- 40 篇趨勢文章
- 47 份模型分析
- 14 篇環節頁
- 299 個術語
- 99 家完整公司檔案（含財報）
- 頁面導言、來源名錄、台灣聚落與 AI 園區資料

以上全部都已撰寫並查核。2026-10-17 的全量驗證結果為 0 錯誤。

**進行中**：精簡公司檔案。總共 67 批。
- 先前的 run `wf_09fe94bd-c6b` 做到第 1–43 批後，碰到每週用量上限（10/23 17:00 重置）而中斷。
- 2026-10-19 用 `next-batches.mjs` 重新計算後，以 run `wf_389e3810-2d9` 接續（limit 1），剩下的工作是：
  - compact-22：只需重新查核。
  - compact-44 到 compact-67：共 24 批，需要撰寫加查核。
- 中斷時磁碟上共有 489 份公司檔案。
- ✅ 2026-10-20：run `wf_389e3810-2d9` 完成，49 個 agent 全數成功，**67 批精簡公司檔案全部完成**。
  - 全量驗證結果為 0 錯誤（1,655 個檔案）。
  - 名冊 710 家中只缺百度（baidu）。原因是 full-27 批次的撰寫 agent 只完成了阿里巴巴與騰訊，百度的財報已驗證，但公司檔沒寫。
  - 已用 run `wf_123189f6-24b` 補寫並查核百度。
  - 同時在背景試跑完整的 `astro build`，log 寫在 `research/tmp/build1.log`，用來為整合階段找出問題。
  - ✅ 試跑結果：建置成功，863 頁、29 秒，exit 0。發現的問題：
    - 百度的引用警告，補寫完成後就會消失。
    - `/dev/` 測試頁被建進正式版。
    - 名詞頁約 1.3 MB、`sources/bibliography.json` 約 2 MB，都需要處理。
    - 公司頁合計 71 MB，平均每頁約 100 KB（未壓縮）。
- **下一步**：整合與 QA。腳本為 `research/plan/workflows/integration-wf.js`，沒有 args，依序跑 5 個 agent，每次 1 個：
  1. 修正已知問題
  2. 正式建置、Pagefind 與場景海報
  3. 自動 QA
  4. 視覺審查
  5. 最終驗證與 `docs/QA-REPORT.md`
  - 等百度的 workflow 完成後再啟動，遵守一次一個 workflow 的規則。
- ✅ 百度已補寫並查核完成（run `wf_123189f6-24b`），**710 家公司全部完成**。
- 整合與 QA 執行中：run `wf_6f186578-e36`。若中斷，可以用 resumeFromRunId 續跑，已完成的步驟會使用快取；換成新的對話則直接重跑 `integration-wf.js`，每個步驟都會先檢查現況。

**剩下的工作**
1. 精簡公司檔案的剩餘批次。依磁碟狀態計算，在 2026-10-18 時：
   - 29 批需要撰寫加查核：compact-39 到 compact-67。
   - 2 批只需查核：compact-22、compact-38。
2. 整合與 QA，待辦清單見第 5d 節「待整合處理」：
   - 修正 FinNotes.astro 的 TS 錯誤
   - 修正 ProfileLayout 的焦點順序
   - 調整名詞頁的大小預算
   - 執行 `astro build` 與 Pagefind
   - 執行連結檢查、e2e、axe，產生場景海報並審查截圖

**接手步驟（新的對話也適用，不依賴舊 session 的快取）**
1. 執行 `node research/plan/next-batches.mjs`。它會依 `src/content/companies/*.mdx` 是否存在、以及是否已標為 `fact-checked`，產生 `research/plan/next-args.json`，裡面只包含還沒完成的批次。
2. 用 Workflow 執行 `research/plan/workflows/content-wf.js`（scriptPath 指向這份 repo 內的複本），args 就是 `next-args.json` 的內容。
   - 腳本已支援 `limit`（同時數量）與 `skipWrite`（只查核）。
   - **使用者要求一次只跑一個 workflow，並保持 limit 1。**
3. 精簡公司檔案完成後，進入整合與 QA。
4. 開發伺服器：桌面 App 用 `preview_start`（name 為 `astro-dev`，設定在 `.claude/launch.json`）；或在背景執行 `npx astro dev --port 4321 --host 127.0.0.1`。內容 agent 不需要伺服器，場景與頁面 agent 才需要。
5. 暫停時：用 TaskStop 停止 workflow、關閉 4300–4699 埠上的 node 程序，並用 `next-batches.mjs` 重新計算剩餘工作。

> 最近一次暫停：2026-10-09（使用者第三次要求暫停）。所有背景 workflow 都已停止，所有開發伺服器也已關閉。最新狀態請看第 5c 節。
> 繼續時請先讀完這份檔案。

## 1. 專案概要
- **目標**：繁體中文 AI 產業鏈教學網站，內容由淺入深。包含公司資料庫（產品、技術、營收）、大模型特性分析、未來趨勢，每章都有 three.js 3D 互動場景。網站不做測驗。
- **技術**：Astro 7.3（靜態輸出）、three.js r186（原生 TypeScript）、Pagefind 搜尋、建置時產生的 SVG 圖表、TypeScript 6、Playwright 測試。
- **使用者決定**：Astro + three.js、全站繁體中文、最完整的公司範圍（一二三線廠商加新創）、每章一個 3D 主題場景。

## 2. 重要文件
| 文件 | 用途 |
|---|---|
| `research/design/architecture.md` | 主架構設計，包括 schema、路由、課程、財報呈現與驗證 |
| `research/design/scenes3d.md` | 3D 引擎與場景設計 |
| `docs/SEGMENTS.md` | 14 環節的定義與邊界 |
| `docs/SCENES.md` | 23 個場景的契約，包括 id、變體與資料格式 |
| `docs/SCENE-CONTRACT.md` | 場景開發 API，由 3D 核心 agent 撰寫 |
| `docs/CONTENT-GUIDE.md` | 內容範本、MDX 元件、調研規則與暫存區流程 |
| `docs/STYLE-zh-TW.md` | 台灣用語與排版規範 |
| `docs/QA.md` | 測試與檢查指令 |
| `research/scouts/*.json`、`research/critique.json` | 2026-10 產業盤點的原始調研（未完整查證） |

## 3. 已完成 ✅
1. **骨架與規格**：package.json（已安裝所有相依套件）、astro.config、tsconfig（已移除 TS6 棄用的 baseUrl）、`src/schemas/*`、`src/content.config.ts`。
2. **名冊**：
   - `src/data/roster/*.yaml`：14 個環節共 **710 家公司**，其中 99 家為完整檔案。
   - `src/data/curriculum.yaml`：38 篇學習文章。
   - `src/data/models-index.yaml`：47 個模型系列。
   - `src/data/trends-index.yaml`：41 篇趨勢文章。
   - `src/data/glossary-index/*.yaml`：299 個術語。
   - `src/data/benchmarks.yaml`。
3. **財報管線**：
   - `scripts/harvest/fin.ts` 從 stockanalysis.com 與 Yahoo 股市擷取資料，437 家上市公司與 119 家台股月營收全部成功。
   - `scripts/harvest/build-financials.ts` 產生 435 份財務 JSON 初稿，全部通過驗證。
4. **基礎建設**：
   - 設計系統：`src/styles`、`src/layouts`、`src/components/{ui,layout,content}`、`src/lib/{paths,seo,collections}`。
   - 圖表與財務函式庫：`src/components/charts`、`src/lib/{format,fiscal,fx,financial-metrics}`、`src/data/fx`。
   - 3D 引擎：`src/three/core`、`src/three/kit`、`Scene3D.astro`、`/dev/scenes/[id]`、`src/data/geo`。
   - QA 工具：playwright.config、`tests/*`、`scripts/check-*`。
   - `astro check` 結果為 0 錯誤。
5. **檢查腳本**：`scripts/validate-data.ts`、`check-zh.ts`（已修正 OpenCC 誤判上游、占、干等字）、`check-content-rules.ts`、`check-roster.ts`。
6. **已寫入 src/content 的內容（只完成撰寫，尚未經查核 agent 核實）**：
   - glossary 299／299
   - segments 14／14
   - models 46／47（缺 midjourney、runway-gen、kling 這一批中的部分）
   - trends 3／41
   - companies 76／710
   - learn 0／38
   - financials 440
   - pages 0、sources 0

## 4. 未完成 ⏳（依建議順序）
各批次的撰寫完成狀態記錄在 `research/plan/done-agents.json`。**目前沒有任何查核（check）agent 完成。**

| 項目 | 剩餘工作 |
|---|---|
| 內容第一批（c1） | trends 13 批（除 trends-02 以外）、models-14、所有 57 個查核 |
| 內容第二批（c2） | 完整公司檔案 11 批：full-18、21、25、26、27、31、32、34、35、36、37；學習文章 19 批；所有查核 |
| 頁面內容（c0-pages） | `src/content/pages/*.mdx`、`src/data/taiwan/sites.yaml`、`src/data/campuses.yaml`、`src/content/sources/*.yaml` |
| 3D 場景 | 已有 19 個資料夾，但多數 agent 中途失敗，需要逐一檢查是否完整。尚缺 company-globe、roadmap-tunnel、taiwan-map、learn-mountain、embedding-space；所有場景都還沒有審查 |
| 頁面模板 | 6 組頁面家族都已部分寫入 `src/pages/*`，但 agent 中途失敗，需要重跑建置與審查 |
| 內容第三批（c3a、c3b） | 610 家精簡公司檔案（67 批），尚未開始 |
| 整合與 QA | 完整驗證、`astro build`、Pagefind、連結檢查、e2e、axe、場景海報、截圖審查、效能預算 |

## 5. 已知待清理
- `src/content/learn/zz-fixture-pages-learn.mdx`：頁面 agent 留下的測試檔，會造成 1 個驗證錯誤，**必須刪除**。
- `src/pages/dev/zz-foundation-review*.astro`：基礎審查 agent 留下的 3 個測試頁，應刪除。
- `research/staging/content/`：失敗 agent 留下的半成品（companies 4、financials 4、models 1、trends 8），續跑的 agent 會處理，或可直接清空。
- 財務驗證有約 600 個警告，主要是季增減超過 60% 但缺少附註，以及仍為未查證的初稿。這些應由公司 agent 補上。

## 5b. 2026-10-09 繼續後的執行紀錄（第二次暫停）
- 已清除 `zz-fixture` 與 `zz-foundation-review` 測試殘檔，並重新啟動開發伺服器。
- 啟動 3 個 workflow，腳本已加入「接手中斷工作」的說明：
  - 3D 場景：run `wf_3665b258-bcd`。**已手動停止**，16 個 agent 開始過，0 個完成。
  - 頁面模板：run `wf_2d9230ea-da8`。**已手動停止**，6 個 agent 開始過，0 個完成。
  - 頁面內容：run `wf_6918c5c4-bb1`。**撰寫已完成**，查核未完成，已停止。產出包括：
    - `src/content/pages/*.mdx` 7 篇
    - `src/content/sources/*.yaml` 60 份
    - `src/data/taiwan/sites.yaml`
    - `src/data/campuses.yaml`
- 使用者要求暫停，所以停止了所有 workflow。另外關閉了 4321 開發伺服器，以及 agent 自行開在 4500–4605 埠的 13 個孤兒 node 伺服器。
- 再次刪除頁面 agent 重新產生的 `src/content/learn/zz-fixture-pages-learn.mdx`。暫停時全量驗證結果為 0 錯誤（946 個檔案，638 個警告）。
- `research/plan/done-agents.json` 已更新，包含這三個 run 的完成狀態。
- **注意**：3D 場景與頁面模板的檔案目前都只完成一半（`src/three/scenes/*`、`src/pages/*`、`src/components/{home,chain,learn,company,model,trend,taiwan,reference}`）。繼續時應用目前的腳本開新 run，腳本裡已有接手說明。
- 頁面 learn agent 習慣建立 `zz-fixture-*.mdx` 測試檔。建議在 pages-wf.js 加上「測試檔不得放進 src/content，用完必須刪除」的規定。

## 5c. 2026-10-09 第三次繼續（使用者選擇「完整多 agent workflow」）
- 開發伺服器改由桌面 App 管理（`.claude/launch.json` 中的 `astro-dev`），沒有 2 小時的背景時限。
- workflow 腳本已加入規定：測試檔不得放進 `src/content` 或 `src/pages`。
- 第一輪啟動後，使用者再次要求暫停（第三次暫停），兩個 workflow 都已手動停止：
  - 頁面模板：run `wf_4c22c750-b74`，6 個 agent 開始過，0 個完成
  - 3D 場景：run `wf_4bfa1b55-8c7`，16 個 agent 開始過，0 個完成
- 暫停時處理：
  - 用 `preview_stop` 關閉 App 管理的開發伺服器。
  - 停止 13 個孤兒 node 伺服器與 4 個 Playwright 瀏覽器。
  - 全量驗證結果為 0 錯誤（945 個檔案）。
  - `research/plan/done-agents.json` 已更新。
- **繼續時**：
  1. 用 `preview_start`（name 為 `astro-dev`）啟動伺服器。
  2. 用目前的 `pages-wf.js` 與 `scenes-wf.js` 開新 run，腳本已有接手與禁止測試檔的規定，場景的 args 用 `research/plan/scenes-args.json`。
  3. 3D 場景與頁面模板目前仍是前幾輪留下的半成品。

## 5d. 2026-10-15 第四次繼續
- 開發伺服器：`preview_start astro-dev`。
- 使用者要求**減少平行 agent 以降低用量消耗**。因此停止了 `wf_5277c834-a5f` 與 `wf_f3a6c69f-6e6`，並把三個 workflow 腳本（scenes、pages、content）改成用 `limitedPipeline`，以 `args.limit` 控制同時處理的項目數，預設為 2。
- 第一輪執行中（每個 workflow 同時 2 個 agent，總共 4 個）：
  - 頁面模板：run `wf_24f0c538-78c`，args 為 `{"limit":2}`
  - 3D 場景：run `wf_9a30a7ca-540`，args 為 `research/plan/scenes-args-ordered.json`（limit 2，總覽頁的場景排在前面）
- 之後的內容 workflow 也要在 args 加上 `"limit": 2`。
- ✅ **頁面模板完成**（run `wf_24f0c538-78c`，12 個 agent 全數成功）：6 組頁面家族都已建置並經過審查。待整合處理的項目：
  - `src/components/company/FinNotes.astro:57` 有 1 個 TS 錯誤。
  - ProfileLayout 的側欄在 DOM 中排在主欄之前，焦點順序不對。
  - FlowSteps 在 36rem 寬就切成橫排，步驟多時太擠。
  - Card 標題的 CJK 斷行不自然。
  - Scene3D 在鍵盤導覽中缺少「跳過場景」連結。
  - `/glossary/` 約 255 KB gz，超過預算，需要放寬例外。
  - `home.mdx` 與 `chain.mdx` 的導言內容和頁面區塊重複。
  - Microsoft、Amazon、Alphabet 的財務資料缺少 capex 序列。
- **2026-10-15 使用者要求每個 workflow 同時只跑 1 個 agent**。因此停止了 `wf_9a30a7ca-540` 與 `wf_21d2fc55-d86`。停止前的完成狀態：
  - 3D 場景已完成製作與審查 9 個：learn-mountain、company-globe、model-galaxy、roadmap-tunnel、taiwan-map、cloud-globe、attention、gpu-scale、cowos。另外 hbm 已完成製作。
  - 學習文章 learn-01 到 learn-08 共 16 篇已撰寫並查核。
- 目前執行中（每個 workflow limit 1，總共 2 個 agent）：
  - 3D 場景：run `wf_e6fdc628-de8`，args 在 `research/plan/scenes-args-r3.json`，共 12 個場景，其中 hbm 只做審查（`skipBuild`）。
  - 內容：run `wf_669c334d-eae`，args 在 `research/plan/r3-args.json`，共 106 項，從 learn-09 開始。
- 2026-10-16 進度檢查：
  - 3D 場景：hbm、euv-litho、wafer-transistor、network、datacenter、chip-floorplan、train-infer 都已完成製作與審查。energy 已完成製作，但審查 agent 因 API 連線中斷（ECONNRESET）失敗，**需要用 skipBuild 補做審查**。agent-loop 正在審查，physical-ai、embedding-space、scaling-surface 還在排隊。
  - 內容：學習文章 38 篇全部完成撰寫與查核，趨勢文章 trends-01、03、04 也已完成撰寫與查核。
- ✅ **3D 場景 workflow 完成**（run `wf_e6fdc628-de8`）：23 個場景全部建好並審查完畢，只有 energy 的審查因連線中斷失敗。
  - energy 補審查：run `wf_08bab829-518`（skipBuild）。
  - ✅ energy 補審查完成，**23 個 3D 場景全部完成**。
  - 精簡公司檔案曾以 run `wf_e270fdc2-06f` 啟動，但使用者在 2026-10-16 要求**一次只跑一個 workflow**，因此停止。
    - compact-01 已完成撰寫與查核。
    - compact-02 撰寫到一半時被停止。
    - 剩餘清單在 `research/plan/c3-args-remaining.json`，共 66 批。
- **一次只跑一個 workflow（同時 1 個 agent）**，依序執行：
  1. ✅ 內容 r3（run `wf_669c334d-eae`）：142 個 agent 全數成功。
     - 學習文章 38、趨勢 40、模型 47、完整公司 99 都已完成撰寫與查核。
     - 2026-10-17 全量驗證：0 錯誤（1,055 個檔案），已查核的內容檔有 366 份、財報 107 份。
  2. 精簡公司檔案：run `wf_09fe94bd-c6b`，執行中，共 66 批（compact-02 到 compact-67），limit 1。
  3. 整合與 QA
- （已被取代）內容第二輪 r2 原本的規劃：run `wf_21d2fc55-d86`，limit 2，args 在 `research/plan/r2-args.json`。共 114 項，依序為學習文章 19 批、趨勢 13 批、models-14、完整公司 11 批（以上撰寫＋查核），接著是 70 項只需查核的既有內容。`content-wf.js` 新增 `skipWrite` 選項，供只需查核的項目使用。
- 若需要暫停：
  1. 用 TaskStop 停止兩個 workflow。
  2. 用 `preview_stop` 關閉伺服器。
  3. 關閉 4300–4699 埠上的 node 程序與 Playwright 瀏覽器。
  4. 從日誌更新 `research/plan/done-agents.json`。

### 繼續時建議順序（一次最多 2 個主要 workflow）
1. 3D 場景（腳本 `research/plan/workflows/scenes-wf.js`，args 用 `research/plan/scenes-args.json`）＋頁面模板（`pages-wf.js`，沒有 args）
2. 頁面內容查核（續跑 `wf_6918c5c4-bb1`），以及內容第一批（c1）續跑
3. 內容第二批（c2）續跑
4. 第三批：c3a、c3b
5. 整合、建置與 QA

## 6. 如何繼續
1. 啟動開發伺服器（背景執行，timeout 設 2 小時）：`npx astro dev --port 4321 --host 127.0.0.1`
2. **若仍是同一個 Claude 對話（session）**，可以用 resume 續跑，已完成的 agent 會直接使用快取：
   - c1：`Workflow({scriptPath: research/plan/workflows/content-wf.js 對應的 scratchpad 路徑, resumeFromRunId: "wf_e4bbf97b-60a", args: research/plan/c1-args.json})`
   - c2：`resumeFromRunId: "wf_b5a03b28-974"`，args 為 `research/plan/c2-args.json`
   - 3D 場景：`resumeFromRunId: "wf_cbe00821-535"`，args 為 `research/plan/scenes-args.json`（場景 workflow 腳本）
   - 頁面模板：`resumeFromRunId: "wf_ba9a3f0a-368"`（頁面 workflow 腳本，沒有 args）
   - 頁面內容：`resumeFromRunId: "wf_6918c5c4-bb1"`，args 為 `{"run":"c0-pages","searchBudget":4,"items":[{"type":"pages","label":"pages","ids":["pages"]}]}`
3. **若是新的對話**，resume 快取無法跨 session 使用。請用 `research/plan/done-agents.json` 排除已完成的撰寫批次，只把剩下的批次放進 args，再以 `research/plan/workflows/*.js` 重新啟動。已完成撰寫的批次只需要跑查核。
4. 之後執行第三批：`research/plan/c3a-args.json`（34 批）與 `c3b-args.json`（33 批）。
5. **用量提醒**：同時執行 3 個以上 workflow 會很快用完 session 用量（已發生兩次）。建議一次最多 2 個 workflow。查核階段可以考慮對精簡公司檔案改為抽樣查核。

## 7. 重要調研發現（2026-10 現況，內容撰寫時需再核實）
- OpenAI 推出 GPT-6（Astra、Sol、Luna）；Anthropic 推出 Claude Fable 5.1、Opus 5.5、Sonnet 5.5；Google 預覽 Gemini 4 Argon；Meta 改推 Muse 系列，Llama 停止更新；OpenAI 的 Sora 已停止服務。
- SpaceX 於 2026-02 併購 xAI（7 月改名 SpaceXAI），2026-06 上市，2026-08 以 600 億美元收購 Cursor。
- 上市潮：Cerebras（2026-05）、智譜與 MiniMax（2026-01 港股）、宇樹（2026-08 科創板）。
- NVIDIA 以約 200 億美元與 Groq 簽下授權加挖角交易（2025-12）；AMD 收購 World Labs（待完成）。

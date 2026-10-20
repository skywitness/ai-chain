# 網站更新指南（給維護者與新的 Claude session）

這份文件說明網站完成後如何持續更新。任何新的 Claude Code session 開啟 `C:\dev2` 時，都會透過根目錄的 `CLAUDE.md` 讀到這裡。

> **使用者偏好（必須遵守）**
> - 更新工作用 Workflow 執行時，**一次只跑一個 workflow，且 `limit` 設為 1**，也就是同時只有 1 個 agent。這樣可以降低用量消耗。
> - 啟動大型 workflow 前，先向使用者說明規模並取得同意。

---

## 0. 基本觀念

| 項目 | 位置 |
|---|---|
| 資料基準日（全站「今天」） | `src/lib/seo.ts` 的 `DATA_DATE`；`docs/CONTENT-GUIDE.md` 與 `docs/STYLE-zh-TW.md` 開頭的日期；workflow args 的 `asOf` |
| 公司名冊（710 家） | `src/data/roster/<環節>.yaml` |
| 其他名冊 | `src/data/curriculum.yaml`（學習文章）、`models-index.yaml`、`trends-index.yaml`、`glossary-index/*.yaml`、`benchmarks.yaml` |
| 內容 | `src/content/{companies,financials,models,trends,learn,segments,glossary,pages,sources}/` |
| 資料規格 | `src/schemas/index.ts`；寫作規範在 `docs/CONTENT-GUIDE.md` 與 `docs/STYLE-zh-TW.md` |
| 內容 workflow | `research/plan/workflows/content-wf.js`，可撰寫、更新、查核 |
| 產生 workflow 參數 | `scripts/plan/make-update-args.mjs` |
| 財報擷取 | `scripts/harvest/fin.ts`（stockanalysis.com 與 Yahoo 股市）；`scripts/harvest/build-financials.ts` 只產生**新公司**的財報初稿，不覆寫既有檔 |
| 驗證與 QA | `docs/QA.md`；上次的完整結果見 `docs/QA-REPORT.md` |

`content-wf.js` 的每個項目都會跑兩個階段：先由撰寫或更新 agent 處理，再由**獨立的查核 agent** 逐項核對來源並修正，查核通過後狀態設為 `fact-checked`。如果只想查核，在項目加上 `skipWrite: true`，參數產生器對應的選項是 `--check-only`。

---

## 1. 標準更新流程（任何類型都適用）

1. **決定新的資料基準日**，例如 `2027-01-31`。
2. **更新基準日**：修改 `src/lib/seo.ts` 的 `DATA_DATE`，以及 `docs/CONTENT-GUIDE.md`、`docs/STYLE-zh-TW.md` 開頭提到基準日的地方。
3. **產生參數**：用 `node scripts/plan/make-update-args.mjs …` 產生 `research/plan/update-args.json`，用法見下面各節。
4. **執行 workflow**：以 `research/plan/workflows/content-wf.js` 為 scriptPath，args 為 `update-args.json` 的內容。一次一個 workflow，limit 1。
5. **驗證**：依 `docs/QA.md` §5 跑完整驗證，至少要跑：
   - `npx astro check`
   - `npx tsx scripts/validate-data.ts`
   - `npx tsx scripts/check-zh.ts`
   - `npx tsx scripts/check-content-rules.ts`
   - `npm run build`
   - `npx tsx scripts/check-links.ts`
6. **部署**：本 repo 已設定 GitHub Pages 自動部署。只要 commit 並 push 到 `main`（需經使用者同意），`.github/workflows/deploy.yml` 就會建置並發布到 https://skywitness.github.io/ai-chain/ 。其他平台的部署方式見 `docs/QA-REPORT.md` §6。

如果 workflow 中途中斷（例如用量用完），重新執行相同的參數產生指令即可。查核完成的檔案會更新 `lastVerified` 與 `editorial.status`，可以用來判斷哪些已經做完。新公司的批次則可以用 `node research/plan/next-batches.mjs` 的作法，以磁碟上的檔案是否存在來判斷。

---

## 2. 常見更新類型

### 2.1 每季財報更新（最常見）

公司公布新一季財報後執行。台股月營收也一起更新。

```bash
# (1) 重新擷取原始資料：全部上市公司約 25 分鐘；也可以用 --only 指定公司
npx tsx scripts/harvest/fin.ts --force
# (2) 產生參數：一線上市公司（約 93 家，每批 3 家）
node scripts/plan/make-update-args.mjs --type financials-update --as-of 2027-01-31 --tier 1 --listed
# 只更新台股：加上 --region TW；只更新特定公司：--ids tsmc,nvidia,sk-hynix
```

更新 agent 會在 `src/content/financials/<id>.json` 加入新的季度與月份，與公司 IR 核對最新一季，並更新業務組成與財測，再同步公司頁的 keyMetrics、timeline 與「營收表現解讀」。

精簡檔案公司的財報量很大，建議每半年更新一次，或只挑重點公司更新。

### 2.2 大模型更新（新版本、價格、評測）

```bash
node scripts/plan/make-update-args.mjs --type refresh --collection models --all --as-of 2027-01-31 --focus "new versions since lastVerified, official API pricing, benchmark standings with dates"
```

- 出現**全新的模型系列**時，先在 `src/data/models-index.yaml` 新增 id、title、lab、origin、kind，再用 `--type model --ids <新 id>` 撰寫。
- 新的評測項目要先加到 `src/data/benchmarks.yaml`。
- 模型星系 3D 場景的資料會在建置時自動從模型檔計算，不需要手動修改。

### 2.3 公司動態（融資、IPO、併購、改名）

```bash
node scripts/plan/make-update-args.mjs --type refresh --collection companies --ids openai,anthropic,spacex --as-of 2027-01-31 --focus "funding, valuation, corporate status, latest products"
# 一次更新整個環節：--segment foundation-models --all
```

- 公司**被併購或下市**時，同時修改名冊 `src/data/roster/<環節>.yaml` 的 `status`、`statusNote`、`ownership`，並執行 `npx tsx scripts/check-roster.ts`。
- 公司上市後若要開始有財報：在名冊補上 `listings` 與 `stockanalysis` 路徑，執行 `npx tsx scripts/harvest/fin.ts --only <id>` 與 `npx tsx scripts/harvest/build-financials.ts --only <id>`，再用 `--type financials-update --ids <id>` 核對，並把公司檔的 `hasFinancials` 改為 `true`。

### 2.4 新增公司

1. 在對應環節的 `src/data/roster/<環節>.yaml` 新增條目，格式參考同檔其他公司，必要欄位見 `src/schemas/roster.ts`。執行 `npx tsx scripts/check-roster.ts` 確認沒有錯誤或重複。
2. 上市公司先擷取財報：
   - `npx tsx scripts/harvest/fin.ts --only <id>`
   - `npx tsx scripts/harvest/build-financials.ts --only <id>`
3. 撰寫：`node scripts/plan/make-update-args.mjs --type company-compact --ids <id1>,<id2> --as-of <日期>`。一線大廠改用 `company-full`，並把名冊的 `profile` 設為 `full`。

### 2.5 新增或改寫文章（學習、趨勢、環節）

- **新學習文章**：先在 `src/data/curriculum.yaml` 加入 order、slug、level、track、title、prereqs、scene，再用 `--type learn --ids <slug>`。
- **新趨勢**：先在 `src/data/trends-index.yaml` 加入，再用 `--type trend --ids <id>`。
- **既有文章更新**：`--type refresh --collection trends --all`。也可以用 `--collection learn` 或 `--collection segments`。
- **新術語**：在 `src/data/glossary-index/<分類>.yaml` 加入 id，再撰寫 `src/content/glossary/<id>.yaml`。數量少時直接手寫即可。

### 2.6 定期全站查核（不改內容，只核實）

```bash
node scripts/plan/make-update-args.mjs --type refresh --collection companies --all --check-only --as-of 2027-01-31
```

`/sources/` 頁面的「資料新鮮度」表會列出 `lastVerified` 超過 180 天的條目，`validate-data` 也會對這些條目發出警告。可以依此決定優先更新哪些內容。

### 2.7 3D 場景或頁面修改

- **場景**：依 `docs/SCENE-CONTRACT.md` 與 `docs/SCENES.md` 修改 `src/three/scenes/<id>/`。修改後執行場景測試，並重新產生海報：
  ```bash
  npm run test:scene
  npx tsx scripts/capture-posters.ts
  ```
  `research/plan/workflows/scenes-wf.js` 可以用 `skipBuild` 只做審查。
- **頁面**：修改 `src/pages/`、`src/components/`。修改後跑 e2e 與 a11y 測試，見 `docs/QA.md`。

---

## 3. 給新 session 的指令範本（直接貼上）

> 請讀 `CLAUDE.md` 與 `docs/UPDATING.md`，把網站的資料基準日更新為 2027-01-31，執行 §2.1 的每季財報更新（一線上市公司），一次只跑一個 workflow、limit 1，完成後跑 `docs/QA.md` §5 的完整驗證並回報。

> 請依 `docs/UPDATING.md` §2.2 更新所有大模型的版本、價格與評測到 2027-01-31，完成後驗證並建置。

> 請依 `docs/UPDATING.md` §2.4 新增以下公司到產業鏈資料庫：○○○（環節：△△）、□□□（環節：▽▽），撰寫並查核後驗證。

> 請依 `docs/UPDATING.md` §2.6 對 foundation-models 環節的公司做一次只查核不改寫的全面查核。

---

## 4. 注意事項

- **暫存區**：所有內容變更都要先寫在 `research/staging/content/…`，通過驗證後再用 `mv` 搬進 `src/content/`，避免讓開發伺服器讀到壞檔。workflow 的 agent 已內建這條規則。
- **WebSearch 額度很少**：每個 workflow 共用約 200 次搜尋。agent 主要使用 WebFetch 讀一手來源，例如 IR、SEC、MOPS、官方定價頁、Hugging Face、Wikipedia。
- **測試殘檔**：不可在 `src/content` 或 `src/pages` 留下測試檔，例如 `zz-*`。
- **用量**：大型更新（例如全部 710 家公司）會消耗大量用量。請分批進行，並維持一次一個 workflow、limit 1。中斷後重新產生參數即可接續。
- **暫停**：要暫停時，用 TaskStop 停止 workflow，並關閉 4300–4699 埠上 agent 自行啟動的 node 開發伺服器。

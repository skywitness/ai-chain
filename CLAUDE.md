# AI 產業鏈全景（C:\dev2）

繁體中文（台灣用語）的 AI 產業鏈教學網站，以 Astro 7.3 靜態輸出加上 three.js r186 互動 3D 場景製作。網站已在 2026-10-20 完成，資料基準日是 `src/lib/seo.ts` 的 `DATA_DATE`。

- 內容規模：14 個產業鏈環節、710 家公司（99 家完整檔案含財報）、47 個模型系列、40 篇趨勢、38 篇學習文章、299 個名詞、24 個 3D 場景，以及記憶體與儲存專題 `/memory/`（2026-10-23 加入）。
- 記憶體專題的資料在 `src/data/memory/*.yaml`（格式見 `src/schemas/memory.ts`），更新方式見 `docs/UPDATING.md` §2.8。
- 完成狀態與歷程見 `PROGRESS.md`；驗證結果、已知限制與部署方式見 `docs/QA-REPORT.md`。

## 要更新網站時

**先讀 `docs/UPDATING.md`。** 裡面有每季財報、大模型、公司動態、新增公司、文章與全站查核的完整步驟，以及可直接使用的指令範本。

## 使用者偏好（必須遵守）

- Workflow 數量與 agent 並行數**不設限**（2026-10-22 使用者要求）：可同時跑多個 workflow，args 的 `limit` 依工作量設定（例如等於項目數）。
- 啟動大型 workflow 前，先說明規模並取得同意。
- 所有網站內容都使用繁體中文（台灣用語），回覆使用者也用繁體中文。

## 重要文件

| 文件 | 用途 |
|---|---|
| `docs/UPDATING.md` | 更新流程 |
| `docs/CONTENT-GUIDE.md` | 內容範本、MDX 元件、調研規則、暫存區流程 |
| `docs/STYLE-zh-TW.md` | 用字、標點、引用規範 |
| `docs/SEGMENTS.md` | 14 個環節的定義與邊界 |
| `docs/SCENES.md`、`docs/SCENE-CONTRACT.md` | 3D 場景的契約與開發 API |
| `docs/QA.md` | 所有檢查指令與完整驗證流程（§5） |
| `src/schemas/index.ts`、`src/schemas/roster.ts`、`src/schemas/memory.ts` | 資料格式（strictObject，不允許多餘欄位） |
| `research/design/architecture.md`、`research/design/scenes3d.md` | 原始架構設計 |

## 常用指令

```bash
npm run dev                                # 開發伺服器（桌面 App 可用 preview_start，name 為 astro-dev）
npm run build                              # astro build 加上 Pagefind 搜尋索引
npx astro preview                          # 預覽正式版
npx astro check                            # 型別檢查
npx tsx scripts/validate-data.ts           # 內容驗證（加 --only <files> 只驗證指定檔案）
npx tsx scripts/check-zh.ts                # 繁中用字檢查
npx tsx scripts/check-content-rules.ts     # 內容結構規則
npx tsx scripts/check-roster.ts            # 公司名冊檢查
npx tsx scripts/check-memory.ts            # 記憶體專題資料檢查（src/data/memory/*.yaml）
npx tsx scripts/check-links.ts             # 站內連結檢查（需要先建置）
node scripts/plan/make-update-args.mjs ... # 產生更新 workflow 的參數（見 docs/UPDATING.md）
```

## 規則摘要

- 內容變更要先寫在 `research/staging/content/…`，驗證通過後再用 `mv` 搬進 `src/content/`。
- 只能引用名冊中存在的 id。新增公司、模型、趨勢或文章時，要先改名冊。
- 每個數字都要附來源與存取日期，查不到的內容寧可省略。網站內容不提供投資建議。
- 不要在 `src/content`、`src/pages` 留下測試檔。
- 部署：GitHub repo 是 https://github.com/skywitness/ai-chain（公開，分支 `main`）。push 到 `main` 會自動部署到 https://skywitness.github.io/ai-chain/（`.github/workflows/deploy.yml`，`BASE_PATH=/ai-chain/`）。只在使用者要求時才 commit 或 push。

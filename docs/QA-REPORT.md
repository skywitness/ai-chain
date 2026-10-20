# 最終驗證報告（QA-REPORT）

- **驗證日期：** 2026-10-20（內容資料基準日 2026-10-06）
- **範圍：** 整合階段（Phase 5）與最終驗證（Phase 6）。完整流程依 `docs/QA.md` §5 執行，每一步都通過後才往下跑。
- **環境：** Windows 11、Node 24.19.0、Astro 7.3.6、three.js 0.186.1、Pagefind 1.5.2、Playwright 1.63.0（Chromium 新 headless 模式，WebGL 以 SwiftShader 執行）、@axe-core/playwright 4.13.0。

---

## 1. 結論

所有自動化檢查都通過：沒有錯誤、沒有失敗的測試，也沒有超出預算的頁面。網站可以部署（見第 6 節）。部署前請先設定 `SITE_URL`。

| # | 檢查 | 指令 | 結果 |
|---|---|---|---|
| 1 | 型別 | `npx astro check` | ✅ 369 個檔案，0 錯誤、0 警告（2 則 Zod 棄用提示，見 §5） |
| 2 | 內容資料 | `npx tsx scripts/validate-data.ts` | ✅ 1,656 個檔案，0 錯誤、15 則警告 |
| 3 | 繁中用語 | `npx tsx scripts/check-zh.ts` | ✅ 1,656 個檔案，0 錯誤、11 則警告 |
| 4 | 內容規則 | `npx tsx scripts/check-content-rules.ts` | ✅ 856 個 MDX 檔，0 錯誤、0 警告 |
| 5 | 覆蓋率 | `npx tsx scripts/report-coverage.ts`（另跑 `--strict`） | ✅ 名冊與各索引 100%；`--strict` 結束碼 0 |
| 6 | 建置 | `npm run build` | ✅ 861 頁（建置約 27 秒），沒有錯誤或警告；Pagefind 索引 857 頁 |
| 7 | 站內連結 | `npx tsx scripts/check-links.ts` | ✅ 861 頁、32,279 個連結、1,004 個不重複站內網址；失效 0、錨點錯誤 0、轉址 0、孤立頁 0 |
| 8 | 效能預算 | `npx tsx scripts/check-budgets.ts` | ✅ 全部在預算內 |
| 9 | 海報完整性 | `npx tsx scripts/capture-posters.ts --verify` | ✅ 23 個場景、46 張海報，0 個問題 |
| 10 | 路由冒煙測試 | `ROUTES_FROM=dist npx playwright test tests/e2e`（預覽伺服器） | ✅ 1,724 個測試：1,723 通過、1 略過（搜尋測試只跑桌機，屬預期） |
| 11 | 無障礙 | `QA_STRICT=1 ROUTES_FROM=dist npx playwright test tests/a11y` | ✅ 68/68 通過（17 種範本 × 淺色／深色 × 桌機／手機），serious／critical 違規 0 |
| 12 | 3D 場景 | `npm run test:scene`（開發伺服器，4 workers） | ✅ 184/184 通過（23 個場景 × 4 項 × 淺色／深色） |
| 13 | GitHub Pages（base path） | `BASE_PATH=ai-chain-atlas/` 建置後跑連結、預算與路由測試 | ✅ 見 §3.6 |
| 14 | 視覺檢查 | `npx tsx scripts/capture-screenshots.ts --serve --clean --scene-shots` | ✅ 審查發現的問題都已修正（見 §4） |

---

## 2. 內容覆蓋率（`report-coverage.ts`，2026-10-20）

### 2.1 名冊與檔案

| 項目 | 檔案數 | 應有數 | 覆蓋率 |
|---|---|---|---|
| 公司檔（名冊） | 710 | 710 | 100% |
| ├ 依層級 | tier 1：103／tier 2：302／tier 3：305 | 同左 | 100% |
| └ 依檔案類型 | full：100／compact：610 | 同左 | 100% |
| 學習文章（`curriculum.yaml`） | 38（L1 10、L2 14、L3 14） | 38 | 100% |
| 產業鏈環節（`SEGMENT_IDS`） | 14 | 14 | 100% |
| 模型系列（`models-index.yaml`） | 47（LLM 30、圖像 4、影片 5、語音 2、世界模型 3、機器人 3） | 47 | 100% |
| 趨勢文章（`trends-index.yaml`） | 40（硬體 14、軟體 10、市場 9、政策 7） | 40 | 100% |
| 名詞（`glossary-index/`，14 個分類） | 299 | 299 | 100% |
| 單頁（`src/content/pages/`） | 7 | 7 | 100% |
| 資料來源名錄（`src/content/sources/`） | 60 | — | — |
| 3D 場景（資料夾、`index.ts`、`meta.json`、淺色＋深色海報） | 23 | 23 | 100% |

14 個環節的公司檔全部到齊。公司數最少的是「晶片設計工具、矽智財與設計服務」（27 家），最多的是「半導體設備與材料」（88 家）。

### 2.2 財務資料

| 項目 | 結果 |
|---|---|
| 財務檔總數 | 441 份；宣告 `hasFinancials` 的公司也是 441 家，兩者一致 |
| 上市公司（tier 1） | 93/93（100%） |
| 上市公司（tier 2） | 202/202（100%） |
| 上市公司（tier 3） | 140/142（99%）：Oklo 與 Fermi America 尚無營收，依規則不建財務檔（公司檔內已說明） |
| 完整檔案（full）的上市公司 | 92/92 |
| 台股月營收序列 | 119/119 |
| 未上市公司的財務檔 | 6 份：OpenAI、Anthropic、Anysphere、字節跳動、Databricks、華為 |

### 2.3 編輯狀態

| 集合 | stub | draft | researched | fact-checked | 合計 |
|---|---|---|---|---|---|
| 公司 | 0 | 0 | 0 | 710 | 710 |
| 財務 | 0 | 0 | 0 | 441 | 441 |
| 學習文章 | 0 | 0 | 0 | 38 | 38 |
| 環節 | 0 | 0 | 0 | 14 | 14 |
| 模型 | 0 | 0 | 0 | 47 | 47 |
| 趨勢 | 0 | 0 | 0 | 40 | 40 |
| 名詞 | 0 | 0 | 0 | 299 | 299 |
| 單頁 | 0 | 0 | 0 | 7 | 7 |
| tier 1 公司 | 0 | 0 | 0 | 103 | 103 |

全部內容檔都已標為 `fact-checked`。資料來源名錄的 schema 沒有 `editorial` 欄位，所以不列入此表。

---

## 3. 各項檢查細節

### 3.1 靜態檢查

- **`astro check`：** 0 錯誤、0 警告。另有 2 則提示，都是 Zod 4 的棄用提示：`scripts/validate-data.ts:42` 的 `ZodTypeAny`，與 `src/schemas/index.ts:237` 的 `z.number().finite()`。兩者都不影響驗證結果。
- **`validate-data`：** 15 則警告，都屬「請補附註」層級：
  - 13 則是年營收變動超過 60% 卻沒有附註，分屬 9 家公司：Applied Digital、Blue Owl、華城（Fortune Electric）、禾賽、地平線機器人、Hut 8、NuScale Power、TeraWulf、Uber。
  - 2 則是 SpaceX 與宇樹科技（Unitree）只有 4 季資料。兩家都是近期才上市，但檔案沒有寫附註說明。
- **`check-zh`：** 11 則警告，分布在 11 份公司檔（第四範式、亞太智能機器、百川智能、寒武紀、崑崙芯、面壁智能、海光、飛騰、Character.AI、DayOne、萬國數據）。多半是公司或產品正式名稱中的「智能」「數據」「信息」（例如「亞太智能機器」「萬國數據」），以及法律語境中的「程序」。依風格指南，正式名稱可以保留，所以列為警告，不是錯誤。
- **`check-content-rules`：** 856 個 MDX 檔，0 錯誤、0 警告。

### 3.2 建置與搜尋

- **`npm run build`：** `astro build` 產生 861 頁，也就是 860 個 `index.html` 加上 `404.html`。各區：公司 711、學習 39、趨勢 41、模型 49、產業鏈 15，以及首頁、名詞、來源、台灣、關於本站各 1。沒有錯誤，也沒有懸空參照或引用的警告。開發用頁面（`/dev/`）不會進入正式版。
- **Pagefind：** 索引 857 頁、32,486 個詞，有 4 個篩選條件與 1 種排序，語言為 zh-tw。
- **輸出：** `dist/` 共 2,049 個檔案、約 122 MB，其中 Pagefind 約 15 MB。檔案數與單檔大小都遠低於 Cloudflare Pages 的上限（2 萬個檔案、每檔 25 MiB）。
- **搜尋品質：**
  - `tests/e2e/search.spec.ts` 以真實的搜尋介面測 7 個查詢：先進封裝、高頻寬記憶體、TSMC、台積電、輝達、三星電子、艾司摩爾。預期頁面都出現在前 3 名。
  - 401 個以中文書寫的公司名稱中，369 個能在前 3 名找到該公司，沒有任何名稱查不到結果。

### 3.3 建置產物檢查

- **站內連結：** `dist/` 的每一頁都當作起點，並驗證 `#錨點`，結果 0 失效、0 孤立頁。
- **效能預算（gzip -9）：**

| 預算 | 實測最大值 | 上限 |
|---|---|---|
| 每頁初始 JS | 13.1 KB | 20 KB（`/companies/`、`/models/compare/` 為 28 KB） |
| 每頁 CSS | 25.4 KB | 35 KB（全站 CSS 合計 73.2 KB） |
| 每頁 HTML（一般頁） | 79.4 KB | 120 KB |
| `/companies/` HTML（明列例外） | 122.7 KB | 220 KB |
| `/glossary/` HTML（明列例外） | 267.6 KB | 300 KB |
| three.js 共用 chunk | 146.9 KB（4 個檔案） | 175 KB |
| 每個場景 | 4.3–30.7 KB | 依各場景 `meta.budgetKB`，皆在上限內 |

- **海報：** 23 個場景 × 淺色／深色共 46 張，1600×900 WebP，27–82 KB。

### 3.4 瀏覽器測試（預覽伺服器 `astro preview`）

- **路由冒煙測試：** `dist/` 的 860 條路由，桌機（1440×900）與手機（390×844，另測 320 px）各跑一次；另有 404 測試與搜尋測試。共 1,723 個通過、1 個略過，10 個 workers 跑 9.5 分鐘。
  - 每條路由檢查：HTTP 200、標題格式、恰好一個 `<h1>`、`lang="zh-TW"`、沒有 console 錯誤或失敗的請求、沒有水平溢出。
- **無障礙（axe，`QA_STRICT=1`）：** 17 種範本 × 淺色／深色 × 桌機／手機，68 個測試全部通過，WCAG 2.0／2.1／2.2 A 與 AA 的 serious／critical 違規為 0。

### 3.5 3D 場景（開發伺服器沙盒）

`npm run test:scene`：23 個場景，每個場景跑 4 項測試，淺色與深色各一次，共 184 個，全部通過（4 個 workers，11 分鐘）。4 項測試如下：

1. 算繪成功，並逐一切換所有變體與步驟，過程沒有錯誤。
2. 減少動態效果時只算繪靜態畫面。
3. 停用 WebGL 時顯示海報備援。
4. 寬度 320 px 時沒有水平捲動。

### 3.6 GitHub Pages（base path）驗證

以 `BASE_PATH=ai-chain-atlas/` 重新建置並驗證：

- **建置：** 861 頁，Pagefind 索引 857 頁。
- **站內連結：** 0 失效。檢查伺服器只在 base 之下提供檔案，漏加 base 的連結會被抓到。
- **效能預算：** 全部在預算內，`/glossary/` 為 270.4 KB。
- **路由測試：** 涵蓋公司頁以外的全部 150 條路由，加上 4 個公司頁，桌機與手機各一次，另有 404 測試與搜尋測試，共 311 個通過、1 個略過。

驗證完成後已用預設 base（`/`）重新建置，所以目前的 `dist/` 是根目錄部署版。

### 3.7 視覺檢查

截圖總覽在 `artifacts/screens/index.html`：24 條路由 × 桌機／手機 × 淺色／深色，共 96 張整頁截圖，另有 48 張場景啟動後的截圖。審查發現的問題都已修正，見 §4。

---

## 4. 整合階段的修正摘要

| 步驟 | 主要修正 |
|---|---|
| 1. 已知問題 | 開發頁面移出正式版（`src/pages/dev/[page].astro`）；ProfileLayout 焦點順序；FlowSteps 依步驟數與文字長度決定是否橫排；卡片標題的中文斷行；3D 場景的「跳過 3D 場景」連結；`/glossary/` 預算例外與說明；「斗」字加入允許清單；移除首頁與產業鏈頁重複的區塊 |
| 2. 建置與海報 | 修正 base path 下搜尋失效；排序調整與中文無結果時的退回查詢；搜尋結果醒目標示改為粗體；公司頁標題中英文之間加空格；排除場景控制項的索引；海報擷取模式（`?poster=1`）並重新產生 46 張海報；各頁預設 OG 圖 |
| 3. 自動 QA | 320 px 溢出（圖表頁尾、相關頁面、來源主機名稱）；開發伺服器場景 504（`vite.optimizeDeps.include`）；`test:scene` 改用場景專用設定檔 |
| 4. 視覺審查 | 中文與行內元件之間多餘的半形空格、引用標記與標點避頭（`src/lib/mdast-cjk.mjs`）；長頁截圖分段拼接；模型頁側欄順序；長數值字級；少期數營收圖寬度；募資表欄寬；環節頁「不包含」展開鈕；場景標籤對齊；趨勢隧道標籤截斷 |
| 5. 最終驗證 | 見下列 |

第 5 步（本次）的變更：

- `scripts/report-coverage.ts`：資料來源名錄沒有 `editorial` 欄位，不再被算成 60 筆「invalid」，改為不列入編輯狀態表。
- `vercel.json`（新增）：Vercel 的建置指令、輸出資料夾、結尾斜線，以及與 `public/_headers` 相同的快取與安全標頭（依 architecture §7.7）。`public/_headers` 開頭的註解同步更新。
- `.gitignore`：加入 `research/tmp/`（agent 暫存區）與 `research/staging/`（內容暫存區，檔案通過驗證後就移入 `src/content/`）。
- 清理：
  - `research/staging/` 已經沒有任何檔案，只剩空的資料夾結構，給內容 workflow 使用。
  - 專案中沒有 `zz-*` 測試檔。
  - 根目錄的 `tc.html`（調研時存下的外部新聞網頁）與 `tests/scenes/research/…/scenes*.json`（先前場景測試誤寫在測試資料夾內的報告）都已移到 `research/tmp/integration/`。
  - 本步驟啟動的預覽伺服器都已關閉。

---

## 5. 已知限制與待處理的小問題

這些都不影響上線，建議在後續維護時處理。

1. **正式網址：** `astro.config.mjs` 在未設定 `SITE_URL` 時，會用佔位網址 `https://ai-chain-atlas.example.org`。canonical、`og:url`、sitemap 與 `robots.txt` 都依賴它，**部署時一定要設定 `SITE_URL`**。
2. **Lighthouse CI 尚未建立：** 沒有安裝 `@lhci/cli`，也沒有 `lighthouserc.json`，LCP、CLS、TBT 沒有自動檢查。目前只以靜態大小預算控制。
3. **外部連結未定期檢查：** `check-links.ts --external` 可以手動執行，但每週限速的排程還沒有建立。許多 IR 網站會擋機器人，失敗只列為警告。
4. **內容警告（非錯誤）：**
   - 財務檔有 13 處年營收大幅變動缺少附註，SpaceX 與宇樹科技各缺「上市未滿 8 季」的說明附註。
   - 用語檢查有 11 則警告，都在公司檔中的正式名稱或原文用語裡。
   - 需要有來源的編輯才能補上這些附註，本次沒有修改內容事實。
5. **兩家上市公司沒有財務檔：** Oklo、Fermi America 尚無營收。開始有營收後，請補財務檔並把 `hasFinancials` 改為 `true`。
6. **中文搜尋：**
   - Pagefind 對 zh-tw 不做詞幹處理，而且建索引與查詢時的中文斷詞方式不同。
   - `src/client/search-loader.ts` 的「無結果時退回查詢」會攔截 Pagefind 的一個內部函式。內部函式改變時，這個功能會自動停用，搜尋本身不受影響。
   - 升級 Pagefind 後，請重跑 `tests/e2e/search.spec.ts`。
   - 開發伺服器上沒有搜尋功能，只有建置後才有。
7. **大型頁面例外：**
   - `/glossary/`（約 268 KB gzip）與 `/companies/`（約 123 KB）是明列的 HTML 預算例外。
   - `/sources/bibliography.json`（約 2 MB，gzip 約 430 KB）只在讀者展開發布者群組時才會載入。
8. **Zod 棄用提示：** `astro check` 的 2 則提示（`ZodTypeAny`、`.finite()`）在 Zod 4 都是無作用的舊寫法，可以在下次修改 schema 時順手移除。
9. **海報與截圖的重現性：**
   - 海報是場景就緒後約 1.5 秒的畫面，每次重新擷取時，粒子位置與視角會有些微差異。
   - Windows 與 Linux 的算繪結果也不會逐像素相同。若要做像素比對，請在 `mcr.microsoft.com/playwright:v1.63.0-noble` 容器中產生基準圖。
10. **場景測試範圍：**
    - 場景測試在開發沙盒上執行。
    - 正式頁面上的場景只由路由冒煙測試涵蓋：等待場景離開載入狀態，並確認沒有 console 錯誤。
    - architecture §8.7 提到的「同一頁最多 2 個 WebGL context」目前沒有獨立測試。
11. **資料時效：** 全站以 2026-10-06 為資料基準日。財報、模型定價與排行榜會持續變動，需要定期更新並重跑完整驗證。
12. **CI 設定：** 專案目前沒有 `.github/workflows/`，部署方式由維護者決定。§6.2 提供 GitHub Pages 的範例 workflow。

---

## 6. 部署

網站是純靜態輸出，不需要伺服器端執行環境。所有平台的共同步驟：

1. Node 版本 22.12 以上（`package.json` 的 `engines`）。
2. 執行 `npm ci`，再執行 `npm run build`，也就是 `astro build && pagefind --site dist`，會同時建立搜尋索引。
3. 上傳 `dist/`。`404.html` 在根目錄，三個平台都會自動當成 404 頁。
4. 環境變數：

| 變數 | 用途 | 例子 |
|---|---|---|
| `SITE_URL` | 正式站的 origin（canonical、OG、sitemap、robots） | `https://ai-chain.example.tw` |
| `BASE_PATH` | 子路徑部署時的 base（GitHub Pages 專案頁） | `/ai-chain-atlas/` |

建議的發布順序：建置 → 驗證（`docs/QA.md` §5）→ 部署。`trailingSlash: 'always'` 搭配 `format: 'directory'`，在三個平台上的網址行為都相同。

### 6.1 Cloudflare Pages（建議：台灣延遲低、不需要 base path）

- 在 Cloudflare Pages 連結 Git 儲存庫，設定如下：
  - Framework preset：Astro
  - Build command：`npm run build`
  - Build output directory：`dist`
- 環境變數：
  - `SITE_URL`：正式網址
  - `NODE_VERSION`：`22`
- `public/_headers` 會原封不動複製到 `dist/_headers`，Cloudflare 會自動套用：
  - `/_astro/*`：快取一年（immutable）
  - `/pagefind/*`：1 小時
  - HTML：每次重新驗證
  - 另外附加 `nosniff` 與 `Referrer-Policy`
- 也可以不連結 Git，直接上傳已建置的資料夾：`npx wrangler pages deploy dist --project-name <專案名稱>`（需要 Cloudflare 帳號登入）。

### 6.2 GitHub Pages（有 base path）

- 到 Settings → Pages，把 Source 設為「GitHub Actions」。
- 專案頁網址是 `https://<帳號>.github.io/<儲存庫>/`，所以要設定 `BASE_PATH=/<儲存庫>/` 與 `SITE_URL=https://<帳號>.github.io`。
- 使用自訂網域時，`BASE_PATH` 用 `/`，`SITE_URL` 用自訂網域。
- `public/.nojekyll` 已存在，`_astro/` 資料夾不會被 Jekyll 略過。
- GitHub Pages 不支援 `_headers`，快取只能依賴檔名雜湊。
- 範例 workflow（`.github/workflows/deploy.yml`）：

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
        env:
          BASE_PATH: /ai-chain-atlas/
          SITE_URL: https://<帳號>.github.io
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

部署前，請先在本機用相同的 base 驗證（`docs/QA.md` §5.1）：

```bash
BASE_PATH=ai-chain-atlas/ npm run build
BASE_PATH=ai-chain-atlas/ npm run links
BASE_PATH=ai-chain-atlas/ npx tsx scripts/check-budgets.ts
BASE_PATH=ai-chain-atlas/ ROUTES_FROM=dist PW_WEBSERVER=preview npx playwright test tests/e2e
```

在 Windows 的 Git Bash 中，`BASE_PATH` 請寫成不含開頭斜線的形式（`ai-chain-atlas/`），否則會被改寫成 Windows 路徑。GitHub Actions 的 Linux 環境沒有這個問題。

### 6.3 Vercel

- 匯入 Git 儲存庫。Framework preset 會自動偵測為 Astro。
- 根目錄的 `vercel.json` 已指定以下設定，並設定與 `_headers` 相同的快取與安全標頭：
  - 建置指令：`npm run build`
  - 輸出資料夾：`dist`
  - `trailingSlash: true`
- Vercel 的靜態 HTML 預設就會每次重新驗證。
- 在 Project Settings 設定：
  - 環境變數 `SITE_URL`
  - Node.js 版本 22.x
- 不需要 adapter。

---

## 7. 本機預覽

```bash
npm ci                     # 第一次或 package-lock.json 變更後
npm run build              # astro build + Pagefind 索引
npx astro preview          # http://localhost:4321/
```

- 指定位址與埠：`npx astro preview --port 4322 --host 127.0.0.1`。
- 預覽 GitHub Pages 版：

  ```bash
  BASE_PATH=ai-chain-atlas/ npm run build
  BASE_PATH=ai-chain-atlas/ npx astro preview
  ```

  網址為 `http://localhost:4321/ai-chain-atlas/`。
- 開發模式：`npx astro dev --port 4321 --host 127.0.0.1`。開發模式有即時重新載入，也有 `/dev/scenes/<id>/` 場景沙盒，但沒有站內搜尋。
- 完整驗證流程與各腳本選項見 `docs/QA.md`。

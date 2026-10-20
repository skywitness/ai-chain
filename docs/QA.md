# 品質檢查（QA）手冊

本文件說明「AI 產業鏈全景」所有自動化檢查的用途、執行方式與完整驗證流程。設計依據：`research/design/architecture.md` 第 7、8 節，與 `research/design/scenes3d.md` 第 D 節。最近一次完整驗證的結果見 `docs/QA-REPORT.md`。

所有指令都在專案根目錄（`C:\dev2`）執行。腳本內部會自行切換到專案根目錄，所以從子目錄執行也可以。

---

## 1. 檢查一覽

| 檢查 | 指令 | 需要 | 失敗條件 |
|---|---|---|---|
| 型別 | `npm run check` | — | `astro check` 有錯誤 |
| 內容資料 | `npm run validate` | — | schema、參照、財務規則（§6.3） |
| 繁中用語 | `npm run lint:zh` | — | 簡體字、中國用語 |
| 內容規則 | `npm run lint:content` | — | 必要標題、層級段落 |
| 覆蓋率報告 | `npm run coverage` | — | 預設只報告；`--strict` 時缺檔即失敗 |
| 建置 | `npm run build` | — | 建置失敗 |
| 站內連結 | `npm run links` | `dist/` | 站內失效連結、`#錨點` 不存在 |
| 效能預算 | `npx tsx scripts/check-budgets.ts` | `dist/` | 超過 §7.6 預算 |
| 路由冒煙測試 | `npm run test:e2e` | 伺服器 | 見 §3 |
| 無障礙 | `npx playwright test tests/a11y` | 伺服器 | 任一 serious／critical 的 WCAG 違規 |
| 3D 場景 | `npm run test:scene` | 開發伺服器 | 由 3D agent 定義（`tests/scenes/`，使用自己的設定檔 `tests/scenes/playwright.config.ts`：淺色／深色兩個專案；`SCENE_BASE_URL` 指定伺服器、`SCENE=a,b` 只跑部分場景） |
| 截圖總覽 | `npm run shots` | 伺服器 | 只產生報告（給人工視覺檢查） |
| 場景海報 | `npm run posters` | 開發伺服器 | 擷取失敗或超過 120 KB |
| 海報完整性 | `npx tsx scripts/capture-posters.ts --verify` | — | 缺海報、尺寸或大小不符 |

「伺服器」指開發伺服器（`npx astro dev --port 4321 --host 127.0.0.1`）或建置後的預覽（`npx astro preview --port 4321 --host 127.0.0.1`）。所有 Playwright 測試與擷取腳本預設連到 `http://127.0.0.1:4321`。

---

## 2. 環境變數

| 變數 | 預設值 | 用途 |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:4321` | 受測伺服器的來源（origin） |
| `BASE_PATH` | `/` | Astro `base`（GitHub Pages 例如 `ai-chain-atlas/`）。網址會自動加上 |
| `SITE_URL` | `astro.config.mjs` 的預設值 | 正式站網址；連結檢查會把它改寫成本機伺服器 |
| `DIST_DIR` | `dist` | 建置輸出資料夾 |
| `ROUTES_FROM` | （未設定） | 設為 `dist` 時，路由取自 `dist/**/index.html`（排除 `/dev/`、`/_astro/`、`/pagefind/`） |
| `ROUTES` | （未設定） | 路由清單，以逗號、空白或換行分隔；`@檔名.txt` 從檔案讀取（`#` 之後為註解） |
| `ROUTES_FILTER` | （未設定） | 正規表示式，只保留符合的路由（例如 `^/chain/`） |
| `ROUTES_LIMIT` | （未設定） | 只取前 n 個路由 |
| `A11Y_ROUTES` | （未設定） | 覆寫或追加無障礙測試的網址：`company-profile=/companies/nvidia/ /extra/route/` |
| `QA_STRICT` | （未設定） | `1`：範本還沒有頁面（404）時判定失敗，而不是略過。最終驗證時使用 |
| `QA_SKIP_SCENES` | （未設定） | `1`：路由測試不等待 `<ai-scene>` 載入完成 |
| `QA_IGNORE_CONSOLE` | （未設定） | 正規表示式；符合的 `console.error` 不算錯誤（請只用於已知的第三方雜訊） |
| `PW_WEBSERVER` | （未設定） | `dev` 或 `preview`：讓 Playwright 自行啟動伺服器（已有伺服器時直接沿用） |
| `PW_WORKERS` | `50%`（CI 為 2） | Playwright worker 數 |
| `PW_CHANNEL` | `chromium` | `chromium` = 完整 Chromium 的新 headless 模式；設為空字串改用 headless shell |
| `CI` | （未設定） | 禁止 `test.only`、失敗重試 1 次、輸出 JSON 報告 |

**Git Bash 注意事項：** Git Bash 會把以 `/` 開頭的參數與環境變數改寫成 Windows 路徑（`/repo/` → `C:/Program Files/Git/repo/`）。請寫成不含開頭斜線的形式（`BASE_PATH=repo/`、`--routes "chain/,learn/what-is-ai/"`），或先設定 `MSYS_NO_PATHCONV=1`。腳本偵測到被改寫的路徑時會直接報錯並提示。

---

## 3. Playwright 測試

設定檔：`playwright.config.ts`。

- **專案：** `desktop`（1440×900）與 `mobile`（390×844、觸控、Android Chrome UA），裝置像素比皆為 1。
- **WebGL：** 啟動參數 `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`，headless 下也能跑 WebGL 2。
- **其他：** `locale: zh-TW`、`timezoneId: Asia/Taipei`；失敗時保留 trace 與截圖（`test-results/`），HTML 報告在 `playwright-report/`（`npx playwright show-report`）。
- **webServer：** 預設關閉，伺服器由我們自己啟動。設定 `PW_WEBSERVER=dev|preview` 才會由 Playwright 啟動。

### 3.1 路由冒煙測試 `tests/e2e/routes.spec.ts`

每個路由是一個獨立測試，兩個專案各跑一次。檢查項目：

1. HTTP 200。
2. `<title>` 以「｜AI 產業鏈全景」結尾，而且前面有頁名；首頁則以「AI 產業鏈全景」開頭。
3. 恰好一個 `<h1>`。
4. `<html lang="zh-TW">`。
5. 沒有 `console.error`、沒有 `pageerror`、沒有失敗的同源請求（網路錯誤或 HTTP ≥ 400）。導覽中斷造成的 `ERR_ABORTED` 不算。
6. 沒有水平溢出：
   - `mobile`：版面視埠必須是 390 px（缺少 `<meta name="viewport">` 時會是 980 px 而失敗）；在 390 px 與 320 px 都不能有水平捲動。
   - `desktop`：1440 px 不能有水平捲動。
   - 失敗訊息會列出最外層的「凸出元素」（例如 `main > div.wide [8…608]`）。被祖先以 `overflow-x: auto|hidden|clip` 包住的內容（例如自帶捲軸的寬表格）不算。

另有一個測試確認不存在的網址回應 404；`src/pages/404.astro` 存在後，也會檢查 404 頁的 `<h1>`、`lang` 與標題。

頁面上若有 `<ai-scene>`，測試會等它離開 `loading` 狀態（最多 15 秒），讓場景的錯誤記在正確的路由上。

```bash
# 開發伺服器上的首頁（預設）
npm run test:e2e

# 指定路由
ROUTES="chain/,learn/what-is-ai/" npx playwright test tests/e2e

# 建置後的全部路由，分 4 片平行執行（CI 每台機器跑一片）
ROUTES_FROM=dist npx playwright test tests/e2e --shard=1/4
```

PowerShell 寫法：`$env:ROUTES_FROM='dist'; npx playwright test tests/e2e`。

### 3.2 無障礙 `tests/a11y/axe.spec.ts`

以 `@axe-core/playwright` 檢查**每種頁面範本各一個網址**，淺色與深色主題各一次（共 17 種範本 × 2 主題 × 2 專案）。

- 主題：先模擬 `prefers-color-scheme`，載入後再強制設定 `html[data-theme]`，並停用 CSS transition／animation，確保對比是以最終顏色計算。
- 判定：WCAG 2.0／2.1／2.2 A 與 AA 規則中，影響程度為 serious 或 critical 的違規必須為 0。axe 的 best-practice 結果只列在測試註記與附件（`axe-<範本>-<主題>.json`），不判定失敗。
- 代表頁面（`tests/helpers/routes.ts` 的 `TEMPLATES`）：首頁、學習路徑、學習文章（優先 `what-is-llm`）、產業鏈總覽、環節頁（優先 `foundry-packaging`）、公司資料庫、公司檔案（優先 `tsmc`）、大模型總覽、模型系列（優先 `anthropic-claude`）、模型比較、未來趨勢、趨勢文章、台灣供應鏈、名詞解釋、資料來源、關於本站、404 頁。詳細頁取自 `src/content/<collection>/` 的檔案；`ROUTES_FROM=dist` 時只挑 `dist/` 中真的存在的頁面。
- 還沒有內容或還沒實作（404）的範本會被**略過**並註明原因；設定 `QA_STRICT=1` 則改為失敗。

```bash
npx playwright test tests/a11y
npx playwright test tests/a11y --project=mobile --grep "company-profile"
A11Y_ROUTES="company-profile=companies/nvidia/" npx playwright test tests/a11y
```

### 3.3 共用測試工具 `tests/helpers/`

3D agent 的 `tests/scenes/*.spec.ts` 也可以使用：

| 模組 | 匯出 |
|---|---|
| `env.ts` | `ROOT`、`DIST`、`BASE_URL`、`BASE_PATH`、`SITE_NAME`、`TITLE_SUFFIX`、`urlFor(route, baseUrl?, basePath?)`、`stripBase(pathname, basePath?)`、`normalizeBase(base)`、`siteUrl()`、`envList(name)`、`envFlag(name)` |
| `routes.ts` | `discoverRoutes(): { routes, source, error? }`、`routesFromDist(dist?)`、`routesFromEnv(name?)`、`normalizeRoute(route)`、`sortRoutes(routes)`、`routeSlug(route)`、`TEMPLATES`、`resolveTemplates(defs?)` |
| `browser.ts` | `WEBGL_ARGS`、`CHROMIUM_CHANNEL`、`VIEWPORTS`、`MIN_WIDTH`、`THEMES`、`NO_MOTION_CSS`、`EVAL_SHIM`、`installEvalShim(ctxOrPage)`、`prepareTheme(page, theme)`、`applyTheme(page, theme)`、`nextFrames(page, n?)`、`freezeMotion(page)`、`settle(page, { networkIdleMs? })`、`waitForScenes(page, { timeoutMs?, graceMs? })` |
| `page-checks.ts` | `trackProblems(page, { origin?, ignoreConsole?, expectedErrorUrls? }) → { log, all(), dispose() }`、`measureOverflow(page) → { viewportWidth, scrollWidth, overflowPx, offenders }`、`describeOverflow(report)` |
| `static-server.ts` | `startStaticServer({ root, basePath?, port?, host? }) → { origin, url, server, close() }` |

`waitForScenes` 接受兩份設計文件的狀態名稱：忙碌中為 `loading`、`mounting`；完成為 `ready`、`running`、`paused`、`fallback`、`error`、`contextlost`、`disposed`。尚未啟動的場景（`poster` 或沒有 `data-state`）在 2.5 秒寬限後視為已穩定（涵蓋 idle 自動載入）。

以 `tsx` 執行、會用 `page.evaluate()` 的腳本，請在每個 BrowserContext 上呼叫 `installEvalShim(ctx)`，否則 esbuild 的 `__name` 包裝會讓頁面端拋出「`__name is not defined`」。Playwright 測試執行器不需要。

---

## 4. 腳本

### 4.1 站內連結 `scripts/check-links.ts`（`npm run links`）

以內建的小型靜態伺服器提供 `dist/`（遵守 `BASE_PATH`；base 以外的網址一律 404，所以忘了加 base 的連結會被抓到），再用 linkinator 遞迴爬所有站內連結，並驗證 `#錨點`（`id` 或 `<a name>`，中文錨點會先解碼）。

- `dist/` 中**每個** HTML 頁都是起點，所以沒有被連到的頁面也會被檢查；報告另外列出「沒有其他頁面連入的頁面」（孤立頁，警告）。
- 指向 `SITE_URL` 的絕對網址（canonical、`og:url`、sitemap）會改寫到本機伺服器，當作站內連結檢查。
- 會轉址的站內連結（多半是少了結尾斜線）列為警告。
- 外部連結預設略過；`--external` 會一併檢查，但失敗只列為警告（許多 IR 網站會擋機器人；正式的外部連結檢查應每週另跑並限速）。

選項：`--json`、`--url <執行中的伺服器>`、`--external`、`--no-fragments`、`--dist <dir>`、`--base <path>`、`--concurrency <n>`、`--timeout <ms>`、`-v`。結束碼：0 通過、1 有失效站內連結或錨點、2 設定錯誤（例如沒有 `dist/`）。

### 4.2 效能預算 `scripts/check-budgets.ts`

建置後量測 gzip（level 9）大小，對照 architecture §7.6：

| 預算 | 上限 | 量測方式 |
|---|---|---|
| 每頁初始 JS | 20 KB（`/companies/`、`/models/compare/` 為 28 KB） | 內嵌 `<script>` ＋ `<script src>` ＋ `<link rel=modulepreload>` ＋ 它們的靜態 import 閉包。動態 `import()`（three、場景、搜尋 UI）不計。若 three.js 出現在靜態閉包中，直接判定失敗 |
| three 共用 chunk | 175 KB | 含 `__THREE__` 或檔名為 `three.*` 的 chunk，加上 three/addons 的 chunk |
| 每個場景 | `meta.budgetKB`（最多 60 KB） | 場景載入器 `import.meta.glob` 中 `…/scenes/<id>/index.ts` 對應的 chunk ＋ 靜態依賴，扣除 three、所有場景共用的執行環境、頁面初始 JS 與 JSON 資料 chunk |
| 場景資料 | 300 KB | 檔名對應 `src/data/**/*.json` 的 chunk |
| 每頁 CSS | 35 KB | `<link rel=stylesheet>` ＋ 內嵌 `<style>`（另列出全站 CSS 總量供參考） |
| 每頁 HTML | 120 KB；明列例外：`/companies/` 220 KB、`/glossary/` 300 KB | HTML 檔本身 |

**HTML 例外（`HTML_EXCEPTIONS`）：** 只有「必須是單一頁、深連結指向頁內 `#錨點`」的頁面可以列為例外，例外清單與理由寫在腳本內，摘要表會逐頁列出。

- `/companies/`：220 KB。完整公司表在伺服器端產生，篩選、排序與無 JavaScript 的檢視都不需要另外抓資料。
- `/glossary/`：300 KB（2026-10-20 實測約 268 KB）。約 300 個名詞必須在同一頁，因為各頁的 `<Term>` 說明卡片、「完整解釋」連結與搜尋結果都連到 `/glossary/#<名詞 id>`，所以不拆頁。
- `/sources/bibliography.json`（約 2 MB，gzip 約 430 KB）不算頁面預算：`/sources/` 只有在讀者展開某個發布者群組（或網址帶有該群組的 `#錨點`）時才會抓取，一般瀏覽不會載入。

調高例外上限時，請同時更新本文件與 architecture §7.6，並附上實測大小。

選項：`--json`、`--all`（列出每一頁）、`--warn-only`、`--dist`、`--base`。結束碼：0 通過、1 超過預算、2 設定錯誤。

### 4.3 截圖總覽 `scripts/capture-screenshots.ts`（`npm run shots`）

每個路由 × {桌機 1440×900、手機 390×844} × {淺色、深色} 各一張整頁截圖（超過 12,000 px 高的頁面會截斷並標示），輸出到 `artifacts/screens/<路由>__<desktop|mobile>__<light|dark>.png`，並產生：

- `artifacts/screens/index.html`：截圖總覽（可依路由篩選、只看有問題的路由；標示 HTTP 狀態、水平溢出、console／網路錯誤、場景錯誤）。
- `artifacts/screens/manifest.json`：每張截圖的中繼資料。

路由來源：`--routes` → `ROUTES` → `--templates`（每種範本一頁＋全部 14 個環節頁）→ `dist/` 全部路由 → `/`。擷取時會模擬「減少動態效果」、停用 CSS 動畫，並把 `loading="lazy"` 的圖片改為立即載入並等它解碼完成（否則畫面外的場景海報會是空白）。超過 4,000 px 高的頁面分段擷取再以 sharp 拼接：WebGL 旗標選用的 SwiftShader 單次擷取上限約 8,192 px，超過的部分會從頁首重複，一次整頁擷取會得到錯誤的長圖。

選項：`--base <url>`、`--serve`（直接提供 `dist/`，不需另開伺服器）、`--out <dir>`、`--viewports desktop,mobile`、`--themes light,dark`、`--concurrency <n>`、`--viewport-only`、`--max-height <px>`、`--dpr <n>`、`--scene-wait <ms>`、`--clean`、`--scene-shots`。

`--scene-shots`：整頁截圖之後，再逐一把頁面上的 3D 場景捲進畫面、啟動（手機版會點「載入 3D 場景」），等它進入執行狀態後擷取整個場景區塊（舞台、工具列與場景重點），存成 `<路由>__scene-<場景 id>__<desktop|mobile>__<light|dark>.png`，在總覽中列在該路由的整頁截圖下方。整頁截圖裡畫面外的場景只會顯示海報，要檢查場景載入後的樣子請加這個選項。

### 4.4 場景海報 `scripts/capture-posters.ts`（`npm run posters`）

對 `src/three/scenes/` 下每個已有 `index.ts` 的場景資料夾（沙盒也只為這些資料夾產生頁面），開啟開發沙盒 `/dev/scenes/<id>/?poster=1&theme=<light|dark>&quality=high`，等場景就緒後擷取舞台，輸出 `src/assets/scene-posters/<id>-<theme>.webp`：

- `poster=1`：沙盒只留下 800×450 的舞台（沒有側欄、統計框、工具列、示意資料標籤、提示與舊海報），場景自己的控制項（`[role=group]` 的篩選按鈕、滑桿）也會隱藏，只保留圖例與標籤；以裝置像素比 2 擷取，剛好 1600×900。
- 建議加 `--settle 1500`，讓開場動畫與粒子流先跑完再擷取。2026-10-20 的 46 張海報為 27–82 KB。
- `astro.config.mjs` 的 `vite.optimizeDeps.include` 已列出 `three` 與場景用到的 three/addons，開發伺服器啟動時就會預先打包，不會在第一次載入場景時才重新最佳化（場景以 `import.meta.glob`／`import()` 載入，Vite 的相依掃描找不到它們）。場景若新增其他 `three/addons/…` 或其他套件，請一併加入清單。
- 若開發伺服器仍回應「504 Outdated Optimize Dep」（Vite 相依快取過期，場景載入失敗；多半是另一個伺服器共用了 `node_modules/.vite`），重新啟動開發伺服器；或另開一個不共用快取的伺服器再以 `--base` 指定，例如 `npx astro dev --port 4323 --host 127.0.0.1 --ignore-lock --config <把 vite.cacheDir 改成別處的設定檔>`。

- 尺寸固定 1600×900（舞台比 1600 px 窄時，改用較高的裝置像素比重新算繪，而不是放大圖片）。
- WebP 品質 75；超過 120 KB 時每次降 5，最低 40。
- 就緒條件：`<ai-scene>` 的 `data-state` 為 `running`、`paused` 或 `ready`，或 `window.__scene.ready` 完成；`error`、`fallback`、`contextlost` 視為失敗。

沙盒契約以 `docs/SCENES.md` 與 `docs/SCENE-CONTRACT.md` 為準。若 3D agent 調整網址或選擇器，不需改程式，用參數覆寫即可：

```bash
npx tsx scripts/capture-posters.ts \
  --url "dev/scenes/{id}/?poster=1&theme={theme}" \
  --stage "[data-poster-stage], ai-scene .scene-stage, ai-scene" \
  --ready "ai-scene[data-state=running]" \
  --fail "ai-scene[data-state=error], ai-scene[data-state=fallback]"
```

其他選項：`--ids a,b`、`--themes`、`--out`、`--width`、`--height`、`--quality`、`--max-kb`、`--timeout`、`--settle`、`--reduced-motion`、`--scenes-dir`、`--dry-run`、`--verify`（不開瀏覽器，只檢查每個場景是否有兩張海報、格式、尺寸與大小）。

### 4.5 覆蓋率報告 `scripts/report-coverage.ts`（`npm run coverage`）

比對名冊與實際檔案：

- 公司：名冊 id × `src/content/companies/`，依主要環節、層級（tier）、檔案類型（full／compact）；並列出公司檔少於 8 家的環節。
- 財務：各 tier 上市公司的財務檔覆蓋率、full 上市公司的財務檔、台股月營收序列、`hasFinancials` 與檔案不一致、沒有公司檔的財務檔。
- 學習文章 × `curriculum.yaml`（依難度）、環節 × `SEGMENT_IDS`、模型 × `models-index.yaml`（依類型）、趨勢 × `trends-index.yaml`（依類別）、名詞 × `glossary-index/`（依分類檔）、單頁 × 固定清單。
- 場景：`SCENE_IDS` × 資料夾、`index.ts`、`meta.json` 與兩張海報。
- 各集合的編輯狀態（stub／draft／researched／fact-checked／無效），以及 tier 1 公司的狀態。資料來源名錄（`sources`）的 schema 沒有 `editorial` 欄位，不列入此表。

選項：`--json`、`--all`（列出所有缺漏 id）、`--strict`（有缺檔即結束碼 1）。

---

## 5. 完整驗證流程

整合階段（Phase 5）與最終驗證（Phase 6）依下列順序執行。前一步失敗就先修正，不要往下跑。

```bash
# 1. 靜態檢查（不需要伺服器）
npm run check
npm run validate
npm run lint:zh
npm run lint:content
npm run coverage

# 2. 建置（只有整合者可以執行；會同時建立 Pagefind 索引）
npm run build

# 3. 建置產物檢查
npm run links
npx tsx scripts/check-budgets.ts
npx tsx scripts/capture-posters.ts --verify

# 4. 以預覽伺服器跑瀏覽器測試（另開一個終端機，或改用 PW_WEBSERVER=preview）
npx astro preview --port 4321 --host 127.0.0.1
ROUTES_FROM=dist npx playwright test tests/e2e
QA_STRICT=1 ROUTES_FROM=dist npx playwright test tests/a11y
npm run test:scene          # 3D agent 的場景測試（沙盒在開發伺服器上）

# 5. 視覺檢查（交給 VIS agent）
npx tsx scripts/capture-screenshots.ts --serve --clean
```

PowerShell：

```powershell
$env:ROUTES_FROM = 'dist'; npx playwright test tests/e2e
$env:QA_STRICT = '1'; npx playwright test tests/a11y
Remove-Item Env:ROUTES_FROM, Env:QA_STRICT
```

只用一個指令讓 Playwright 自己啟動預覽伺服器：

```bash
PW_WEBSERVER=preview ROUTES_FROM=dist npx playwright test tests/e2e tests/a11y
```

### 5.1 GitHub Pages（有 base path）

```bash
BASE_PATH=ai-chain-atlas/ npm run build
BASE_PATH=ai-chain-atlas/ npm run links
BASE_PATH=ai-chain-atlas/ npx tsx scripts/check-budgets.ts
BASE_PATH=ai-chain-atlas/ ROUTES_FROM=dist PW_WEBSERVER=preview npx playwright test tests/e2e
```

### 5.2 平行與分片

路由測試每條路由是獨立測試，可直接分片：`--shard=1/4` … `--shard=4/4`。SwiftShader 很吃 CPU，3D 場景測試同時執行的 worker 建議不超過 CPU 核心數的一半（`PW_WORKERS=4`）。

---

## 6. 產出位置

| 路徑 | 內容 | 版本控制 |
|---|---|---|
| `playwright-report/` | Playwright HTML 報告 | 忽略 |
| `test-results/` | 失敗截圖、trace、axe JSON 附件、CI 的 `results.json` | 忽略 |
| `artifacts/screens/` | 截圖總覽 | 忽略 |
| `src/assets/scene-posters/` | 場景海報 WebP | **要提交** |

---

## 7. 已知限制

- 開發伺服器上沒有站內搜尋（Pagefind 只在建置後存在）；搜尋相關的端對端測試請對預覽伺服器執行。
- 效能預算以靜態分析判斷 chunk 歸屬：場景 chunk 靠場景載入器 `import.meta.glob` 的鍵名（`…/scenes/<id>/index.ts`）對應；若載入器改用其他方式，報告會列出「找不到 chunk 的場景資料夾」。Astro 沒有輸出 Vite manifest（`astro.config.mjs` 為凍結檔），所以不使用 manifest。
- 被 Rolldown 併入場景 chunk 的 JSON 資料會算在場景程式預算內；只有獨立成 chunk 的 JSON 才算在 300 KB 資料預算。
- 場景沙盒（`src/pages/dev/scenes/[id].astro`）的網址參數是 `variant`、`step`、`quality`、`theme`、`motion`、`seed`、`height` 與 `poster`。`poster=1` 只處理版面（見 §4.4），沒有固定動畫時間，也沒有關閉自動旋轉：海報是就緒後約 1.5 秒的畫面，重新擷取時粒子位置與視角會有些微差異。
- Lighthouse CI（`@lhci/cli`）尚未安裝，`lighthouserc.json` 也還沒有建立；LCP、CLS、TBT 預算目前沒有自動檢查。
- 截圖與海報在 Windows 與 Linux 上的像素不會完全相同；若要做像素比對，請在 `mcr.microsoft.com/playwright:v1.63.0-noble` 容器中產生基準圖。

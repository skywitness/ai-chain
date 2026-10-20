# AI 產業鏈全景

🌐 **網站：<https://skywitness.github.io/ai-chain/>**

由淺入深認識 AI 產業鏈：從電力、半導體設備、晶圓代工、記憶體、AI 晶片、網通、伺服器、資料中心，到雲端、基礎模型、開發工具、應用與實體 AI。網站以繁體中文（台灣用語）撰寫，並搭配 three.js 互動 3D 場景。

## 內容

| 區塊 | 內容 |
|---|---|
| 產業鏈 | 5 層、14 個環節，每個環節都有分級說明（入門／進階／深入）與主題 3D 場景 |
| 公司資料庫 | 710 家全球一二三線廠商與新創；99 家完整檔案附季營收、毛利率與業務組成圖表；台股附月營收 |
| 學習路徑 | 38 篇文章，從「什麼是 AI」到 HBM、CoWoS、EUV、縮放定律、推論最佳化 |
| 大模型特性分析 | 47 個模型系列（LLM、圖像、影片、語音、世界模型、機器人），附版本、價格、評測與並排比較 |
| 未來趨勢 | 40 篇，涵蓋硬體、軟體、市場、政策，並有 2024–2031 時光隧道 |
| 台灣 AI 供應鏈 | 產業聚落 3D 地圖與台股月營收熱圖 |
| 名詞解釋 | 299 個術語 |

所有內容都經過撰寫與獨立查核兩道程序，每個數字都附來源。資料基準日為 **2026-10-06**。

> 本站內容僅供教育參考，不構成投資建議。

## 技術

- [Astro](https://astro.build/) 7（靜態輸出）、TypeScript、MDX 內容集合（Zod schema 驗證）
- [three.js](https://threejs.org/) r186：23 個互動 3D 場景，延遲載入，支援減少動態效果，無 WebGL 時改顯示預覽圖
- 建置時產生的 SVG 圖表，不需要圖表函式庫
- [Pagefind](https://pagefind.app/) 中文全文搜尋
- Playwright（頁面、3D 場景、無障礙測試）與自訂資料驗證、繁中用字檢查腳本

## 本機執行

需要 Node.js 22.12 以上。

```bash
npm ci
npm run dev        # 開發伺服器 http://localhost:4321
npm run build      # 正式建置，產生 dist/ 與搜尋索引
npx astro preview  # 預覽正式版
```

## 部署

`dist/` 是純靜態網站，可以部署到 Cloudflare Pages、GitHub Pages 或 Vercel。

- 建置時要設定 `SITE_URL`，例如 `https://example.com`。
- 部署到子路徑時要設定 `BASE_PATH`，例如 GitHub Pages 的 `/ai-chain/`。

詳細步驟見 [docs/QA-REPORT.md](docs/QA-REPORT.md) §6。

本 repo 已設定 GitHub Pages 自動部署：推送到 `main` 時，[.github/workflows/deploy.yml](.github/workflows/deploy.yml) 會自動建置並發布到 <https://skywitness.github.io/ai-chain/>。也可以在 Actions 頁籤手動執行。

## 文件

- [docs/UPDATING.md](docs/UPDATING.md)：網站更新流程，包括每季財報、大模型、公司動態與新增內容
- [docs/QA.md](docs/QA.md)、[docs/QA-REPORT.md](docs/QA-REPORT.md)：檢查指令與驗證結果
- [docs/CONTENT-GUIDE.md](docs/CONTENT-GUIDE.md)、[docs/STYLE-zh-TW.md](docs/STYLE-zh-TW.md)：內容範本與寫作規範
- [docs/SEGMENTS.md](docs/SEGMENTS.md)、[docs/SCENES.md](docs/SCENES.md)、[docs/SCENE-CONTRACT.md](docs/SCENE-CONTRACT.md)：環節定義與 3D 場景規格
- [research/design/](research/design/)：原始架構設計

## 資料來源

公司財報取自各公司的財報與 IR 公告、SEC EDGAR 與公開資訊觀測站等一手來源。部分季度資料以 Stock Analysis 與 Yahoo 股市彙整後，再與公司公告核對。模型資訊取自官方模型卡、定價頁、技術報告與第三方評測排行榜。每一頁都列出引用來源與存取日期。

# 內容撰寫指南（Content agents 必讀）

資料基準日：**2026-10-06**。全站繁體中文（台灣用語），遵守 `docs/STYLE-zh-TW.md`。
Schema 定義：`src/schemas/index.ts`（frontmatter 必須完全符合，`strictObject` 不允許多餘欄位）。
環節定義：`docs/SEGMENTS.md`。公司 id 名冊：`src/data/roster/*.yaml`（只能引用名冊中存在的 id）。

---

## 1. 調研規則

1. **一手來源優先**：公司 IR 新聞稿／財報／法說簡報、SEC EDGAR、公開資訊觀測站、官方部落格、官方定價頁、標準組織、政府文件。其次是可靠媒體與維基百科（需交叉查證）。
2. **每個數字都要有來源**，並記錄 `accessed: "2026-10-06"`（或實際讀取日）。
3. **查不到就省略**，絕不猜測或捏造。估計值必須標 `status: estimate` 與 `estimateBasis`。
4. **WebSearch 額度很少**（整個 workflow 共用約 200 次）：每個 agent 最多使用指派的次數（通常 ≤ 4 次）。請改用 **WebFetch** 直接讀取已知網址：
   - 維基百科：`https://en.wikipedia.org/wiki/<Title>`、`https://zh.wikipedia.org/wiki/<標題>`
   - 季營收與財務：`https://stockanalysis.com/<path>/financials/?p=quarterly`（path 見名冊的 `stockanalysis` 欄位）；年度：`.../financials/`；營收分項：`.../revenue/`
   - 台股月營收：`https://tw.stock.yahoo.com/quote/<code>.TW/revenue`（上櫃用 `.TWO`）
   - 公司官網、IR 網站、新聞稿頁面、官方部落格
   - SEC：`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=<name>&type=10-Q`
   - 模型：官方 model card、定價頁、技術報告、Hugging Face 模型頁 `https://huggingface.co/<org>/<model>`、`https://artificialanalysis.ai/models`、`https://lmarena.ai/leaderboard`
5. 也可以用 Bash 的 `curl -sL -A "Mozilla/5.0"` 取得原始 HTML，再用 node 擷取需要的數字（無額度限制）。
6. 已預先擷取的財務資料：`research/fin/<company-id>.json`（stockanalysis 季／年資料）與 `research/fin-tw/<company-id>.json`（台股月營收）。若存在，請直接使用並與一手來源核對最新一季。
7. 調研初稿可參考 `research/scouts/*.json`（2026-10 初步盤點，**未經完整查證**，數字仍需以一手來源確認）。

## 2. Source 物件格式（frontmatter）

```yaml
sources:
  - key: tsmc-q2-2026            # 選填；內文 <Cite k="tsmc-q2-2026" /> 引用時必填
    title: "TSMC Reports Second Quarter EPS of NT$15.36"
    publisher: TSMC
    url: "https://pr.tsmc.com/english/news/3237"
    type: press-release           # filing | annual-report | ir-presentation | earnings-call | press-release | monthly-revenue | company-site | paper | docs | standard | government | dataset | leaderboard | news | analyst | book | other
    lang: en                      # zh-TW | zh-CN | en | ja | ko | de | fr | other
    published: "2026-07-17"       # 選填
    accessed: "2026-10-06"
```
所有日期、ticker、看起來像數字的字串一律加引號。

## 3. MDX 內文可用元件（不需 import，直接使用）

| 元件 | 用途 | 範例 |
|---|---|---|
| `<Term id="hbm">HBM</Term>` | 名詞解釋浮動卡片；id 必須列在 frontmatter `glossary` 中，且存在於名詞索引 | |
| `<Cite k="key" />` | 引用標記，對應 `sources[].key` | `營收年增 53%<Cite k="tsmc-aug" />。` |
| `<CompanyChip id="tsmc" />` | 公司連結小卡（可加文字子元素） | `<CompanyChip id="nvidia">輝達</CompanyChip>` |
| `<ModelChip id="anthropic-claude" />` | 模型系列連結 | |
| `<SegmentChip id="foundry-packaging" />` | 環節連結 | |
| `<LearnLink id="what-is-llm">文字</LearnLink>` | 學習文章連結 | |
| `<TrendLink id="co-packaged-optics">文字</TrendLink>` | 趨勢文章連結 | |
| `<Callout type="info" title="標題">…</Callout>` | 提示框；type: info / tip / warn / analogy（生活化比喻）/ data | |
| `<DeepDive title="深入一點：…">…</DeepDive>` | 可展開的進階內容 | |
| `<LevelSection level={1} title="這一環在做什麼">…</LevelSection>` | 分級段落（環節頁使用；1 入門／2 進階／3 深入） | |
| `<MathTeX tex="R = k_1 \frac{\lambda}{NA}" display />` | 數學公式（建置時轉 MathML） | |
| `<Scene3D id="cowos" variant="exploded" caption="…" />` | 嵌入 3D 場景；id 必須是 `SCENE_IDS` 之一 | |
| `<FlowSteps steps={["設計","光罩","晶圓製造","封裝","測試"]} title="…" />` | 流程步驟圖；容器夠寬時才橫排，所需寬度依步驟數、標題長度與是否有 `detail` 而定。有 `detail` 時：3 步以下 36rem、4 步 44rem、5 步 52rem、6 步 62rem 以上才橫排，7 步以上一律直排；文章欄寬約 48rem，所以 5 步以上會維持直排。所有步驟都沒有 `detail` 又維持直排時，改以編號串成的細線呈現（不加外框） | |
| `<Compare title="…" left={{ title: "FinFET", items: ["…","…"] }} right={{ title: "GAA", items: ["…"] }} />` | 左右比較 | |
| `<StatGrid items={[{ label: "全球 EUV 市占", value: "≈100%", note: "ASML，2026" }]} />` | 數字卡片 | |
| `<BarChart title="…" unit="十億美元" data={[{ label: "2024", value: 230 }]} source="key" />` | 簡易長條圖（建置時 SVG） | |
| `<LineChart title="…" unit="…" series={[{ name: "Microsoft", points: [{ x: "2024", y: 55.7 }] }]} source="key" />` | 簡易折線圖 | |

Markdown 表格、清單、粗體都可以用。不要使用圖片檔、HTML `<div>`、`<style>`、`<script>`。

排版由建置處理，不必手動調整（`src/lib/mdast-cjk.mjs`）：行內元件或粗體前後若兩側都是中文，多打的半形空格會在輸出時去掉（`**…。** 其中`、`要靠 <Term>交換器</Term> 互相` 都會變成緊接；中英文之間的空格保留）；`<Cite>` 會和前一個字黏在一起，不會單獨落到行首；小卡與 `<Term>` 後面的「。，、）」等標點不會被擠到下一行行首。

## 4. 各集合範本

### 4.1 公司 `src/content/companies/<id>.mdx`
- `profile` 與 `tier` 必須與名冊一致；`hasFinancials` 必須與 `src/content/financials/<id>.json` 是否存在一致。
- `summary`（60–420 字）：這家公司是誰、做什麼、為何在 AI 鏈中重要。
- `chainRole`：在產業鏈中的位置與上下游。
- `products`：完整檔案 ≥3、精簡檔案 ≥1，每項有 `status` 與 `description`。
- `technologies`：完整檔案 ≥2。
- `timeline`：完整檔案 ≥5（含 2025–2026 重要事件）。
- `keyMetrics`：例如市占率、產能、客戶集中度、ARR、員工數（每項附來源與日期）。
- `competitors`：只能填名冊中存在的 id。
- 私人公司：`funding`（輪次、金額、估值、日期、來源）。
- **完整檔案（full）內文必須包含以下 H2**：
  `## 公司概況`、`## 產品與技術`、`## 營收表現解讀`、`## 競爭格局`、`## 風險與觀察重點`，總長 1,500–3,000 字。
- **精簡檔案（compact）內文**：200–600 字，包含 `## 公司概況`，可加 `## 近期動態`。

### 4.2 財務 `src/content/financials/<id>.json`
- 單位：一律存 **百萬（million）** 原幣；百分比用 `unit: percent`。
- 期別標籤：公司財年 `FY2027-Q2`（第二季）、`FY2025`（全年）、月 `2026-08`；`start`／`end` 必須是確切日期。
- `fiscalYear.naming`：財年以結束年份命名者為 `end-year`（例如 NVIDIA FY2027 結束於 2027 年 1 月）。
- 一線上市公司：季營收 **至少 8 季連續**（建議 12 季以上），加上毛利率與營業利益率；有揭露者加上業務分項 `mix`、財測 `guidance`。
- 台股：另加 `periodType: month` 的月營收（至少 13 個月，建議 24 個月），單位 million TWD。
- 私人公司：可用 `metric: arr` 或 `revenue` 加 `status: estimate`，必附 `estimateBasis`。
- 若 `research/fin/<id>.json` 已由腳本產生初稿，請核對最新一季與一手來源，並補上 `mix`、`guidance` 與 IR 來源。

### 4.3 學習文章 `src/content/learn/<slug>.mdx`
內文結構（H2）：
1. `## 一句話解釋`
2. `## 生活化比喻`（使用 `<Callout type="analogy">`）
3. `## 原理`（可多個 H2／H3）
4. `<DeepDive title="深入一點：…">`
5. `## 與產業鏈的連結`（使用 CompanyChip／SegmentChip）
6. 重點整理由版面自動從 `keyTakeaways` 產生，內文不用重寫。

長度：入門 2,000–3,000 字；進階 3,000–5,000 字；深入 4,000–7,000 字。frontmatter 的 `scenes` 與內文 `<Scene3D>` 的 id 需一致。

### 4.4 環節 `src/content/segments/<id>.mdx`
內文用三個 `<LevelSection>`：
- `level={1} title="這一環在做什麼"`：入門說明與比喻
- `level={2} title="關鍵技術與商業模式"`：技術、成本結構、市場規模、競爭格局
- `level={3} title="深入議題"`：瓶頸、供需、地緣政治、未來 2–3 年看點

另外加 `## 台灣的角色`。總長 2,500–4,500 字。`featuredCompanies` 為 3–12 個名冊 id。

### 4.5 模型 `src/content/models/<id>.mdx`
- `versions`：列出近 18 個月的重要版本（含已退役者，標 `status`）。
- `pricing`：取自官方定價頁（USD／百萬 tokens），附日期。
- `benchmarks`：只使用 `src/data/benchmarks.yaml` 中的 id；每筆附日期、來源與 `reportedBy`。
- `positioning`：capability（0–100 綜合能力，可參考 Artificial Analysis Intelligence Index）、costIndex（0–100，以混合價格對數換算：$0.05/M → 0，$100/M → 100）、openness（0 封閉、0.5 開放權重受限授權、0.8 開放權重寬鬆授權、1 完全開源含資料）。
- 內文 H2：`## 系列概覽`、`## 特性分析`、`## 適合與不適合的用途`、`## 版本演進`、`## 評測解讀`（提醒評測日期與方法差異）。1,200–2,500 字。

### 4.6 趨勢 `src/content/trends/<slug>.mdx`
- `milestones`：2024–2031 的重要節點（done／expected／speculative），供 3D 時光隧道使用。
- `signals`：可觀察的指標（附日期與來源）；`counterpoints`：反方觀點。
- 內文 H2：`## 趨勢摘要`、`## 為什麼重要`、`## 關鍵驅動力`、`## 時間表與里程碑`、`## 受影響的環節與公司`、`## 反方觀點與風險`、`## 觀察指標`。1,500–3,000 字。

### 4.7 名詞 `src/content/glossary/<id>.yaml`
`term`、`zh`、`en`、`category`、`level`、`short`（≤90 字的浮動卡片說明）、`definition`（40–700 字）、`example`（選填）、`related`（其他名詞 id）、`learnMore`（學習文章 slug）、`segments`。

## 5. 編輯狀態
`editorial: { status: researched, author: <你的 agent 標籤> }`。只有查核 agent 可以把狀態改成 `fact-checked`，且 `checkedBy` 必須與 `author` 不同。

## 6. 自我檢查（完成前必跑）
```
npx tsx scripts/validate-data.ts --only <你的檔案路徑...>
npx tsx scripts/check-zh.ts <你的檔案路徑...>
npx tsx scripts/check-content-rules.ts <你的檔案路徑...>
```
三者都要零錯誤。**不要**執行 `astro build`、`npm install` 或任何 git 指令。只寫入指派給你的檔案。

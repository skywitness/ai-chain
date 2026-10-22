# 3D 場景目錄（契約）

技術細節（引擎、生命週期、品質分級、無障礙、預算）以 `research/design/scenes3d.md` 第 A 節為準，並套用下列**覆寫規則**：

1. **場景探索**：每個場景是 `src/three/scenes/<id>/` 資料夾，內含 `index.ts`（`export default` 一個 `SceneModule`）與 `meta.json`（符合 `src/schemas/scene.ts`）。引擎以 `import.meta.glob('/src/three/scenes/*/index.ts')` 自動發現，**不需要共用的 registry 檔**。
2. **變體＋導覽步驟取代 depth 參數**：`variant` 決定場景版本，`steps`（meta.json）提供由淺入深的導覽：step 0 是總覽（入門），後面的步驟逐步加深（進階 → 深入）。工具列顯示「導覽 1/4」與上一步／下一步。
3. 頁面嵌入一律透過 `<Scene3D id variant caption data? autoload? height? />`（`src/components/scene/Scene3D.astro`）。
4. 場景不得寫死產業數字。需要數字的場景，從頁面傳入的 `data` 取得（build-time 由內容集合計算），或在 meta 的 hotspot `detail` 中以「示意」標註。
5. 只用程序化幾何（procedural），不下載外部模型；中文文字一律用 HTML 標籤層（LabelLayer），不做 3D 文字。

| id | 名稱 | 變體（variants，第一個為預設） | 主要頁面 | 學習目標 | data |
|---|---|---|---|---|---|
| `chain-panorama` | AI 產業鏈全景塔 | `hero`, `explore` | `/`、`/chain/`、learn 102 | 5 層 14 環節由下而上：電力→晶片→系統→雲與模型→應用；粒子流表示價值流；點擊環節前往環節頁 | segments（id、標題、層、代表公司） |
| `learn-mountain` | 學習之山 | `default` | `/learn/` | 三層台地（入門／進階／深入）上的文章節點與先修路徑；點擊開啟文章 | curriculum |
| `neural-net` | 神經網路如何學習 | `forward`, `backprop` | learn 104 | 神經元、權重（線粗細）、啟動值亮起；反向傳播時誤差流回、權重更新 | none |
| `embedding-space` | 嵌入向量空間 | `semantic`, `rag` | learn 201、206 | 詞語點雲依語意聚類；向量加減示範；RAG：查詢向量找最近鄰文件片段 | none |
| `attention` | Transformer 注意力劇場 | `attention`, `layers`, `moe` | learn 202、303；環節 foundation-models | Token 方塊、Q/K/V、注意力弧線（滑過 token 顯示權重）；層層堆疊；MoE 路由器把 token 分派給專家 | none |
| `train-infer` | 訓練與推論 | `training`, `inference`, `pipeline` | learn 203、210、304；環節 devtools-data-mlops | 訓練：大量 GPU 同步、梯度 all-reduce；推論：請求批次、KV cache、prefill/decode；pipeline：資料→清洗→訓練→評測→部署 | none |
| `scaling-surface` | 縮放定律曲面 | `default` | learn 301 | (參數量, 資料量) 上的 loss 曲面與運算最適脊線 | none |
| `euv-litho` | EUV 微影光路 | `euv`, `high-na` | 環節 semi-equipment-materials；learn 307 | 錫滴→CO₂ 雷射→電漿 13.5nm 光→集光鏡→光罩→反射鏡組→晶圓台；High-NA 變形光學 | none |
| `wafer-transistor` | 從晶圓到電晶體 | `wafer`, `transistor`, `bspdn` | 環節 foundry-packaging；learn 107、211、306 | 晶圓→晶粒→電晶體縮放；平面→FinFET→GAA→CFET 形變；背面供電 | none |
| `cowos` | CoWoS 先進封裝拆解 | `cowos`, `soic` | learn 212、308 | 爆炸圖：載板、中介層、邏輯晶粒、HBM 堆疊；SoIC 混合鍵合 | none |
| `hbm` | HBM 堆疊與頻寬 | `hbm`, `hierarchy` | 環節 memory-storage；learn 213、309 | DRAM 晶粒、TSV、基底晶粒、頻寬流；記憶體階層塔（容量 vs 延遲） | none |
| `chip-floorplan` | 晶片平面圖城市 | `floorplan` | 環節 eda-ip-design | 晶片像城市：運算核心、NoC、SerDes、HBM PHY、快取；滑過顯示 IP 類型；放大到標準單元 | none |
| `gpu-scale` | 從晶片到超級機櫃 | `chip`, `die`, `rack` | 環節 ai-accelerators、servers-systems；learn 106、209 | GPU 晶粒→模組→運算托盤→NVL72 機櫃→叢集，逐級放大；die：SM、Tensor Core、L2、HBM；rack：托盤、交換托盤、電源、液冷管 | none |
| `network` | AI 網路與光通訊 | `scale-up`, `scale-out`, `cpo` | 環節 networking-optics；learn 214、310 | 機櫃內 NVLink 網域 vs 葉脊架構封包流；銅線 vs 光纖 vs CPO 光引擎 | none |
| `datacenter` | AI 資料中心剖面 | `overview`, `liquid`, `power-chain` | 環節 datacenter-infra；learn 108、311 | 機房：機櫃列、冷熱通道；氣冷 vs 直接液冷 vs 浸沒；電網→變電→UPS→PDU→機櫃→晶片 | none |
| `energy` | GW 級 AI：電力與能源 | `grid`, `onsite` | 環節 energy-power | 電網、發電廠（燃氣、核能／SMR、太陽能＋儲能）供電給 GW 級園區；功率尺度比較 | none |
| `cloud-globe` | 雲端與新雲版圖 | `globe` | 環節 cloud-neocloud；learn 312 | 地球儀上的雲端區域與大型 AI 園區；資本支出柱狀 | custom（園區清單：名稱、經緯度、業者、MW） |
| `model-galaxy` | 大模型星系 | `galaxy` | `/models/`、learn 208 | 模型依能力 × 成本 × 開放程度散佈於 3D 空間，依實驗室著色；時間滑桿 | models |
| `agent-loop` | AI Agent 運作迴圈與 MCP | `loop` | 環節 apps-agents；learn 207 | 規劃→工具呼叫（MCP 伺服器衛星）→觀察→記憶，動畫化的工具呼叫 | none |
| `physical-ai` | 實體 AI：感知→模型→動作 | `robot`, `autonomy` | 環節 physical-ai；learn 314 | 人形機器人或機械臂的感知—決策—動作；光達點雲街景與自駕 | none |
| `company-globe` | 全球 AI 企業地球儀 | `globe` | `/companies/` | 數百家公司總部點位，依層著色、依營收大小；城市聚集（新竹、矽谷）；篩選 | companies |
| `roadmap-tunnel` | 技術時光隧道 2024–2031 | `tunnel` | `/trends/` | 四條軌道（硬體／軟體／市場／政策）沿時間隧道排列里程碑 | trends |
| `taiwan-map` | 台灣 AI 供應鏈地圖 | `map` | `/taiwan/` | 立體台灣地圖，科學園區與產業聚落高塔、出口弧線 | taiwan |
| `memory-fab-map` | 全球記憶體產能地圖 | `globe` | `/memory/` | 地球儀上的記憶體／HBM 封裝／NAND 晶圓廠，柱高＝月產能，可切換產品別（DRAM／HBM／NAND／全部）與狀態（現有產能／擴產中）；點選顯示產能、擴產規模、時程與資本支出 | custom（`src/data/memory/fabs.yaml` 的 fabs 陣列） |

## 頁面資料（data）形狀
- `segments`：`{ id, title, titleEn, layer, order, tagline, href, companies: [{ id, name, nameZh }] }[]`
- `curriculum`：`{ slug, title, level, order, track, prereqs: string[], href }[]`
- `models`：`{ id, title, lab, origin, capability, costIndex, openness, released, href, kind }[]`
- `companies`：`{ id, name, nameZh, lat, lon, layer, segment, tier, revenueUsdM: number | null, href, city }[]`
- `trends`：`{ id, title, category, milestones: [{ date, label, status }], href }[]`
- `taiwan`：`{ sites: [{ id, name, lat, lon, kind, companies: string[] }], companies: [{ id, nameZh, site, segment }] }`
- `custom`（cloud-globe）：`{ campuses: [{ name, lat, lon, operator, mw, status }] }`
- `custom`（memory-fab-map）：`{ asOf, fabs: [{ id, company, companyName, href, name, city, country, lat, lon, products: ('dram'|'hbm'|'hbm-packaging'|'nand'|'hdd'|'ssd'|'other')[], status: 'operating'|'expanding'|'construction'|'planned'|'delayed', capacityKwpm?, capacityStatus?: 'actual'|'estimate'|'forecast', addKwpm?, capex?, timeline?, note? }] }`（由 `src/lib/scene-data/memory-fabs.ts` 從 `src/data/memory/fabs.yaml` 產生；`companyName` 取名冊中文名，`href` 為 `/companies/<id>/`，不含 base）

各場景在 `index.ts` 內以 type guard 驗證 data；缺資料時用 `src/three/fixtures/<id>.json` 示意資料（開發／測試用），並在畫面角落標示「示意資料」。

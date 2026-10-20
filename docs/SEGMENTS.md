# 產業鏈 14 環節定義（5 層）

本站以「由下而上」的順序描述 AI 產業鏈。每家公司只有一個 `primarySegment`（主要營收或在 AI 鏈中最關鍵的角色），另可列多個 `segments`。

| order | id | 標題 | Layer | 範圍（includes） | 邊界規則 |
|---|---|---|---|---|---|
| 1 | `energy-power` | 能源與電力 | foundation | 發電（天然氣、核能／SMR、再生能源）、電網與輸配電設備（變壓器、重電）、電力公用事業、燃氣渦輪、燃料電池、儲能、電網工程 | 機房內 UPS／配電／開關設備歸 `datacenter-infra`；台灣重電（華城、士電、中興電、亞力）歸此 |
| 2 | `semi-equipment-materials` | 半導體設備與材料 | silicon | 前段設備（微影、蝕刻、沉積、量測檢測、清洗、CMP）、後段設備（鍵合、切割、TCB、混合鍵合）、測試設備（ATE、探針卡）、材料（矽晶圓、光阻、特殊氣體、化學品、光罩、空白光罩）、廠務工程 | ABF 載板與 IC 載板歸 `foundry-packaging`；玻纖布／CCL 歸 `servers-systems` |
| 3 | `foundry-packaging` | 晶圓代工與先進封裝 | silicon | 晶圓代工、先進封裝（CoWoS、SoIC、面板級）、封測代工（OSAT）、IC 載板（ABF、BT）、玻璃基板 | IDM 若以記憶體為主歸 `memory-storage`（Samsung 主環節為記憶體，次環節含代工） |
| 4 | `memory-storage` | 記憶體與儲存 | silicon | HBM、DRAM、NAND、企業級 SSD、HDD、記憶體控制晶片、儲存系統（Pure Storage、VAST Data 等） | |
| 5 | `eda-ip-design` | 晶片設計工具、矽智財與設計服務 | silicon | EDA、半導體 IP（CPU/NPU/介面 IP）、ASIC 設計服務（世芯、創意） | Broadcom、Marvell、聯發科雖有 ASIC 業務，主環節歸 `ai-accelerators` |
| 6 | `ai-accelerators` | AI 晶片與加速器（GPU／ASIC／CPU） | silicon | GPU、AI ASIC、TPU 類、伺服器 CPU、推論晶片新創、中國 AI 晶片、邊緣 AI／NPU 晶片 | 雲端自研晶片（TPU、Trainium、Maia、MTIA）列為母公司的 `units` |
| 7 | `networking-optics` | 網通與光通訊 | systems | 交換器晶片與系統、網卡／DPU、retimer／AEC／PCIe／CXL 晶片、光模組與光元件、CPO／矽光子、光纖、高速連接器與線纜 | 伺服器內部連接器（嘉澤）歸 `servers-systems` 亦可，以營收主體判斷 |
| 8 | `servers-systems` | 伺服器、系統與關鍵零組件 | systems | AI 伺服器 ODM／OEM、機櫃整合、主機板、電源供應器（PSU）、散熱模組（冷板、風扇、水冷頭）、PCB／CCL、滑軌、機殼、伺服器連接器 | 機房級設備（CDU、冰水機）歸 `datacenter-infra` |
| 9 | `datacenter-infra` | 資料中心（電力、散熱、營運） | systems | 機房電力設備（UPS、開關設備、PDU）、機房級散熱（CDU、冷卻塔、浸沒式）、資料中心開發商／REIT／託管業者、轉型 AI 的礦企房東 | 提供 GPU 算力租賃者歸 `cloud-neocloud` |
| 10 | `cloud-neocloud` | 雲端與新雲 | cloud-models | 超大規模雲端、新雲（GPU 雲）、推論雲、主權 AI 算力平台、電信雲 | Microsoft、Amazon、Alphabet、Oracle、阿里、騰訊、百度等以雲端為主環節，旗下模型實驗室列為 `units` 並另有 `models` 條目 |
| 11 | `foundation-models` | 基礎模型 | cloud-models | 大型語言模型實驗室、多模態生成模型（圖像／影片／音訊／世界模型）公司 | Google DeepMind 為 Alphabet 的 unit；Meta 主環節歸此 |
| 12 | `devtools-data-mlops` | 開發工具、資料與 MLOps | cloud-models | 資料平台、向量資料庫、訓練資料標註、MLOps、推論平台軟體、Agent 框架、AI 程式開發工具（Cursor、Cognition、Replit、Lovable） | |
| 13 | `apps-agents` | 應用與 Agent | applications | 企業 SaaS 與 Agent、垂直 AI（法律、醫療、金融）、消費級 AI、創意工具、AI 搜尋、AI 安全 | |
| 14 | `physical-ai` | 實體 AI（機器人、自駕、邊緣裝置） | applications | 人形與通用機器人、工業機器人、自駕車與 Robotaxi、機器人零組件、終端 AI 裝置（手機、AI PC、眼鏡）品牌 | Tesla、Apple 主環節歸此；Qualcomm 歸 `ai-accelerators` |

## 層（layer）
- `foundation`：能源與電力
- `silicon`：設備材料、代工封裝、記憶體、設計工具／IP、AI 晶片
- `systems`：網通光通訊、伺服器系統、資料中心
- `cloud-models`：雲端、基礎模型、開發工具與資料
- `applications`：應用與 Agent、實體 AI

## 層級（tier）
- `1`：全球一線龍頭，對 AI 鏈有決定性影響（完整檔案 `profile: full`，約 100 家）
- `2`：二線要角，重要供應商或區域龍頭
- `3`：利基廠商、三線供應商與新創

## 併購／改名規則
- 已被完全併購且不再獨立營運者：不建立公司檔，改寫入母公司的 `timeline`／`units`（例如 Celestial AI → Marvell）。
- 被併購但仍以獨立品牌營運且具代表性者（例如 Cursor／Anysphere 之於 SpaceX）：可保留，`ownership: subsidiary`、`parent` 指向母公司。
- 宣布但尚未完成的併購：保留原公司，`statusNote` 註明。

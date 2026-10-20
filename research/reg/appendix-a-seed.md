**Taxonomy changes vs your plan:** EDA/IP/design services is split out of AI chips into its own segment. Licensing, royalty and NRE business models differ from chip vendors, and the Taiwan ASIC design-service houses are key players. Result: **14 segments in 5 layers**.

- Server-level parts (PSU, cold plates, PCB/CCL, rails, connectors) belong to `servers-systems`.
- Facility-level gear (UPS, switchgear, CDUs, chillers) and operators belong to `datacenter-infra`.
- Utilities and generation belong to `energy-power`.
- Business units of conglomerates are listed as `units` inside the parent: AWS/Trainium, Google Cloud/TPU/DeepMind/Waymo, Azure/Maia, Meta MTIA, Qwen in Alibaba, Huawei Cloud, Zoox, etc.

| order | id | 標題 | Layer |
|---|---|---|---|
| 1 | energy-power | 能源與電力 | foundation |
| 2 | semi-equipment-materials | 半導體設備與材料 | silicon |
| 3 | foundry-packaging | 晶圓代工與先進封裝 | silicon |
| 4 | memory-storage | 記憶體與儲存 | silicon |
| 5 | eda-ip-design | 晶片設計工具、矽智財與設計服務 | silicon |
| 6 | ai-accelerators | AI 晶片與加速器（GPU／ASIC／CPU） | silicon |
| 7 | networking-optics | 網通與光通訊 | systems |
| 8 | servers-systems | 伺服器、系統與關鍵零組件 | systems |
| 9 | datacenter-infra | 資料中心（電力、散熱、營運） | systems |
| 10 | cloud-neocloud | 雲端與新雲 | cloud-models |
| 11 | foundation-models | 基礎模型 | cloud-models |
| 12 | devtools-data-mlops | 開發工具、資料與 MLOps | cloud-models |
| 13 | apps-agents | 應用與 Agent | applications |
| 14 | physical-ai | 實體 AI（機器人、自駕、邊緣裝置） | applications |

**Roster seed.** ★ marks tier 1 with a full profile (~80). The rest are tier 2/3 and startups with compact profiles. Ids are kebab-case slugs; listed Taiwan small caps carry their zh name. The [REG] agent verifies status and trims or extends to about 300–340.

1. **energy-power (~24):** ge-vernova★, siemens-energy★, constellation-energy★, vistra★, nextera-energy, talen-energy, nrg-energy, oklo, nuscale-power, bloom-energy, cameco, fluence-energy, quanta-services, prysmian, mitsubishi-heavy, terrapower, kairos-power, commonwealth-fusion-systems, taipower(台電), fortune-electric(華城), shihlin-electric(士電), chung-hsin-electric(中興電), allis-electric(亞力)
2. **semi-equipment-materials (~40):** asml★, applied-materials★, lam-research★, tokyo-electron★, kla★, advantest★, teradyne, asm-international, screen-holdings, kokusai-electric, lasertec, disco, besi, onto-innovation, nova, camtek, axcelis, naura(北方華創), amec(中微), shin-etsu-chemical, sumco, globalwafers(環球晶), entegris, tokyo-ohka-kogyo, resonac, ajinomoto, linde, air-liquide, merck-kgaa, zeiss-smt, gptc(弘塑), scientech(辛耘), all-ring(萬潤), gudeng(家登), foxsemicon(京鼎), marketech(帆宣), uis(漢唐), kinik(中砂), topco(崇越), chroma(致茂)
3. **foundry-packaging (~23):** tsmc★, intel★ (secondary: ai-accelerators), umc★(聯電), smic★(中芯), globalfoundries, hua-hong(華虹), rapidus, tower-semiconductor, vis(世界先進), psmc(力積電), ase★(日月光投控), amkor★, jcet(長電科技), tongfu(通富微電), kyec(京元電), powertech(力成), chipbond(頎邦), ibiden, unimicron(欣興), nan-ya-pcb(南電), kinsus(景碩), shinko-electric, at-s
4. **memory-storage (~20):** samsung-electronics★ (secondary: foundry), sk-hynix★, micron★, sandisk★, western-digital★, kioxia, seagate, cxmt(長鑫), ymtc(長江存儲), nanya-tech(南亞科), winbond(華邦電), macronix(旺宏), phison(群聯), silicon-motion(慧榮), adata(威剛), pure-storage, netapp, vast-data, ddn, weka
5. **eda-ip-design (~16):** synopsys★, cadence★, arm★, alchip★(世芯-KY), guc★(創意), rambus, ceva, sifive, imagination-technologies, socionext, faraday(智原), ememory(力旺), m31(円星), ap-memory(愛普), andes(晶心科), alphawave (verify owner)
6. **ai-accelerators (~30):** nvidia★, amd★, broadcom★, marvell★, qualcomm★, mediatek★(聯發科), huawei★ (units: Ascend/HiSilicon, Huawei Cloud), cerebras, groq (verify status), sambanova, tenstorrent, etched, d-matrix, graphcore, ampere-computing, cambricon(寒武紀), hygon(海光), moore-threads(摩爾線程), metax(沐曦), biren(壁仞), enflame(燧原), kunlunxin(昆侖芯), rebellions, furiosaai, axelera-ai, positron, matx
7. **networking-optics (~27):** arista★, cisco★, coherent★, lumentum★, innolight★(中際旭創), credo★, astera-labs★, amphenol★, accton★(智邦), eoptolink(新易盛), fabrinet, ciena, corning, te-connectivity, nokia, applied-optoelectronics, lightmatter, ayar-labs, zte(中興通訊), ruijie(銳捷), bizlink(貿聯-KY), landmark(聯亞), luxnet(華星光), browave(波若威), 上詮, 光聖, 眾達-KY
8. **servers-systems (~33):** foxconn★(鴻海), quanta★(廣達), wistron★(緯創), wiwynn★(緯穎), inventec★(英業達), supermicro★, dell★, hpe★, lenovo★, delta-electronics★(台達電), celestica, fii(工業富聯; parent foxconn), gigabyte(技嘉), asus(華碩), msi(微星), mitac(神達), inspur(浪潮資訊), xfusion(超聚變), jabil, sanmina, lite-on(光寶科), avc(奇鋐), auras(雙鴻), jentech(健策), chenbro(勤誠), king-slide(川湖), gce(金像電), emc(台光電), tuc(台燿), lotes(嘉澤), aic(營邦)
9. **datacenter-infra (~22):** vertiv★, schneider-electric★, eaton★, equinix★, digital-realty★, abb, legrand, nvent, modine, iron-mountain, ntt-data, stack-infrastructure, qts, vantage-data-centers, aligned-data-centers, switch, airtrunk, gds(萬國數據), applied-digital, iren, cipher-mining, terawulf, chief-telecom(是方)
10. **cloud-neocloud (~24):** microsoft★, amazon★, alphabet★, oracle★, coreweave★, nebius★, alibaba★, tencent★, baidu★, ibm, cloudflare, digitalocean, akamai, softbank-group, crusoe, lambda, together-ai, vultr, nscale, fluidstack, g42, humain, chunghwa-telecom(中華電信), taiwan-ai-cloud(台智雲; parent asus)
11. **foundation-models (~28):** openai★, anthropic★, meta★, xai★, deepseek★, bytedance★, mistral-ai, cohere, ai21-labs, moonshot-ai(月之暗面), zhipu-ai(智譜), minimax, stepfun(階躍星辰), safe-superintelligence, thinking-machines-lab, reflection-ai, ai2, sakana-ai, upstage, naver, black-forest-labs, stability-ai, midjourney, runway, luma-ai, elevenlabs, suno
12. **devtools-data-mlops (~26):** databricks★, snowflake★, datadog★, hugging-face, scale-ai, surge-ai, mercor, labelbox, langchain, pinecone, weaviate, qdrant, mongodb, elastic, confluent, anyscale, modal, baseten, fireworks-ai, anysphere, cognition, replit, lovable, vercel, dataiku
13. **apps-agents (~29):** salesforce★, servicenow★, adobe★, palantir★, sap, workday, intuit, shopify, duolingo, perplexity, character-ai, harvey, abridge, glean, sierra, decagon, writer, notion, canva, figma, synthesia, grammarly, openevidence, hippocratic-ai, tempus-ai, appier(沛星), ikala, gogolook(走著瞧), cyberlink(訊連), 91app
14. **physical-ai (~30):** tesla★, apple★ (edge devices; secondary ai-accelerators, apps-agents), mobileye★, advantech★(研華), xiaomi, figure-ai, agility-robotics, apptronik, 1x, boston-dynamics, unitree(宇樹), ubtech(優必選), agibot(智元), physical-intelligence, skild-ai, aurora-innovation, pony-ai, weride, horizon-robotics(地平線), wayve, nuro, intuitive-surgical, fanuc, yaskawa, hiwin(上銀), ambarella, hailo, symbotic

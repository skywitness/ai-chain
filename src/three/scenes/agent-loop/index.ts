/**
 * agent-loop — AI Agent 運作迴圈與 MCP (variant: loop).
 *
 * A technical diorama of an LLM agent. The LLM 「大腦」 floats over a pedestal (the host program
 * that runs the loop) whose collar is the MCP client. A task token circles a four-station track (規劃 → 行動 → 觀察 → 記憶). On 行動 a
 * tool call (cyan ArcRibbon + comet) leaves the collar, passes a gate in the green guardrail ring
 * and reaches one of five MCP servers; on 觀察 the result (violet particles) flows back on a lower
 * arc; on 記憶 the call/result blocks land in the context-window tray above the brain. Long-term
 * memory is a store inside the ring. Deeper steps add context compaction, human approval at the
 * gate and an indirect prompt injection (a red packet) that the guardrail blocks.
 *
 * Steps: 總覽 → 規劃 → 呼叫工具 → 觀察結果 → 記憶 → 權限防護 → 提示注入 (all in variant `loop`).
 * Each step runs its own illustrative episode (script.ts); reduced motion shows the episode's
 * representative frame (`still`) statically.
 *
 * Labels: wide stages label things beside them; small stages (phones: 4:3 inline, 4:5 tall) and
 * portrait stages move several labels (layoutLabels) because labels are large relative to the
 * diorama there. Moving callouts flip beside their anchor near the stage edges (calloutAlign).
 */
import { Color, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, RingGeometry, Vector3 } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose, type CardContent, type LabelHandle, type LabelSpec, type Palette, type SceneContext } from '../../core/types';
import { ArcRibbons } from '../../kit/ArcRibbons';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { buildCore, buildFloor, buildGuard, buildMemoryStore, buildServers, buildThreat, buildTrack, buildTray, paintGroup } from './build';
import {
  BRAIN_Y,
  COLLAR_Y,
  GATE,
  MEMORY_PHI,
  MEMORY_R,
  R_COLLAR,
  R_GUARD,
  serverR,
  R_TRACK,
  SERVER,
  SERVER_TOP,
  SHELL_R,
  STATIONS,
  T_BROWSER,
  TOOLS,
  TRAY,
  TRAY_W,
  TRAY_Y_PORTRAIT,
  arcPoint,
  arcSamples,
  bump,
  clamp01,
  easeInOut,
  outArc,
  polar,
  polylineLength,
  returnArc,
  smooth,
  stationPhi,
  type ArcSpec,
} from './layout';
import { BLOCK_NAME, SLOTS, blocksAt, episodeFor, stationOf, type BlockType, type Episode } from './script';

const N = TOOLS.length;
const GAP = 10; // 'once'-mode time multiplexing: path j lives at uTime ∈ [GAP·j, GAP·j + 1.3]
const P_WRITE = N;
const P_READ = N + 1;
const P_COMPACT = N + 2;
const P_COMPACT_P = N + 3;
const TRAIN = [0, -0.035, -0.07, -0.105, -0.14, -0.175, -0.21, -0.245, -0.28];
const COMET = [0, -0.022, -0.044, -0.066, -0.088, -0.11];

/* glow sprite slots */
const G_BRAIN = 0;
const G_TOKEN = 1;
const G_TRAIL = 2; // 3
const G_STATION = 5; // 4
const G_LED = 9; // N
const G_GATE = 14; // N
const G_STORE = 19;
const G_THREAT = 20;
const G_IMPACT = 21;
const G_BLOCK = 22;
const G_PORT = 23; // N
const G_COUNT = 28;

type HotId =
  | 'llm'
  | 'agent-loop'
  | 'mcp-client'
  | 'context-window'
  | 'long-term-memory'
  | 'guardrails'
  | 'prompt-injection'
  | (typeof TOOLS)[number]['id'];

/** Per-step emphasis: how much each group is dimmed (0 = focus). */
interface Dim {
  tools: number;
  memory: number;
  guard: number;
}
const STEP_DIM: readonly Dim[] = [
  { tools: 0, memory: 0, guard: 0 },
  { tools: 0.55, memory: 0.3, guard: 0.45 },
  { tools: 0, memory: 0.5, guard: 0.15 },
  { tools: 0, memory: 0, guard: 0.3 },
  { tools: 0.5, memory: 0, guard: 0.5 },
  { tools: 0, memory: 0.5, guard: 0 },
  { tools: 0.45, memory: 0.5, guard: 0 },
];

const HOME: CameraPose = { position: [0, 7.1, 10.5], target: [0, 0.8, 1.2] };
const HOME_PORTRAIT: CameraPose = { position: [0, 8.9, 11.2], target: [0, 0.85, 0.45], fov: 40 };
/*
 * Step poses. The five servers sit 72° apart, so whatever the azimuth, some server is near the
 * line of sight behind the brain; each pose keeps that server clear of the brain and the context
 * tray (low elevation for the tray-centred 記憶 view, a near-front view for 權限防護, a low
 * right-side view for 提示注入 so the tray floats above the back servers instead of across them).
 * Every pose except the 規劃 close-up keeps all five servers and their labels in frame.
 */
const STEP_POSES: readonly (CameraPose | null)[] = [
  null, // 總覽 → ctx.homePose
  { position: [0.5, 4.0, 6.9], target: [0, 1.3, 0.1] }, // 規劃: close on the brain and the stations
  { position: [-0.3, 7.0, 9.8], target: [0.2, 0.6, 1.1] }, // 呼叫工具: every server and its tool name
  { position: [-1.6, 5.2, 10.0], target: [-0.3, 0.9, 1.0] }, // 觀察結果: the result flowing back
  { position: [-0.45, 5.0, 7.55], target: [-0.45, 1.55, 0.4] }, // 記憶: tray above, store on the left
  { position: [1.3, 6.9, 9.9], target: [0.2, 0.6, 0.6] }, // 權限防護: both risky tools' checkpoints
  { position: [8.2, 4.6, 5.6], target: [0.8, 1.0, 1.1] }, // 提示注入: the browser arc in profile
];
/**
 * Portrait stages (phones, `height="tall"`): the poses the reader should end up with. The host
 * scales every setPose() distance by |portrait home| / |home| on portrait stages, so these are
 * pre-shrunk by that factor in `fitForHost` (null = scale the landscape pose).
 */
const STEP_POSES_PORTRAIT: readonly (CameraPose | null)[] = [
  null,
  { position: [0.6, 6.4, 10.4], target: [0, 2.0, 0.1] },
  { position: [-2.3, 9.4, 12.6], target: [0, 1.0, 0.4] },
  { position: [-1.9, 7.6, 12.4], target: [-0.2, 1.5, 0.6] },
  { position: [-0.4, 7.46, 11.1], target: [-0.4, 2.2, 0.3] },
  { position: [1.7, 9.6, 12.8], target: [0.15, 1.4, 0.4] },
  { position: [8.4, 7.4, 8.6], target: [0.3, 1.7, 1.3] },
];
const dist = (p: CameraPose): number => {
  const a = p.position as readonly number[];
  const b = p.target as readonly number[];
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
};
const PORTRAIT_K = dist(HOME_PORTRAIT) / dist(HOME);
/** Undo the host's portrait distance scaling so `p` is the pose the camera actually reaches. */
const fitForHost = (p: CameraPose): CameraPose => {
  const a = p.position as readonly number[];
  const t = p.target as readonly number[];
  const k = 1 / PORTRAIT_K;
  return { ...p, position: [t[0]! + (a[0]! - t[0]!) * k, t[1]! + (a[1]! - t[1]!) * k, t[2]! + (a[2]! - t[2]!) * k] };
};

/* Per-tool label strings, built once (render() runs every frame and should not build strings). */
const PLAN_TEXT = TOOLS.map((t) => `規劃：${t.thought}`);
const CALL_TEXT = TOOLS.map((t) => `tools/call → ${t.fn}`);
const EXEC_TEXT = TOOLS.map((t) => `執行 ${t.fn}…`);
const RESULT_TEXT = TOOLS.map((t) => `結果：${t.result}`);
/* Small stages name the tool in the approval callout (it covers the server's own label there). */
const WAIT_TEXT = TOOLS.map((t) => `${t.short}：等待人類核准`);
const OK_TEXT = TOOLS.map((t) => `${t.short}：已核准，放行`);
const FILL_TEXT = new Map<number, string>();
/** Context fill label: mode 0 已用, 1 已滿, 2 壓縮後; cached per (mode, slots). */
const fillText = (mode: number, used: number): string => {
  const key = mode * 1000 + used;
  let t = FILL_TEXT.get(key);
  if (t === undefined) {
    t = `${mode === 2 ? '壓縮後' : mode === 1 ? '已滿' : '已用'} ${used}／${TRAY.slots} 格（示意）`;
    FILL_TEXT.set(key, t);
  }
  return t;
};

const STATION_CARD: readonly string[] = [
  '模型讀取整個上下文（系統提示、任務、先前的工具結果），決定下一步：要呼叫哪個工具、帶什麼參數，或已經可以回覆使用者。推理模型會先產生一段思考，再做決定。',
  '模型輸出結構化的工具呼叫（工具名稱加上 JSON 參數）。主程式檢查權限後，交給 MCP 用戶端送到對應的伺服器執行。',
  '伺服器回傳的結果以「工具結果」訊息加入上下文。模型在下一輪讀到它，判斷行動是否成功，必要時修正計畫或重試。',
  '這一輪的呼叫與結果留在上下文視窗（短期記憶）；值得長期保存的重點寫入長期記憶庫。上下文快滿時，舊內容會被壓縮成摘要。',
];

const CARD_LINKS: Partial<Record<string, { href: string; linkLabel: string }>> = {
  llm: { href: '/chain/foundation-models/', linkLabel: '前往「基礎模型」環節 →' },
  'agent-loop': { href: '/learn/agents-and-mcp/', linkLabel: '閱讀：AI Agent 與 MCP →' },
  'tool-browser': { href: '/glossary/#computer-use', linkLabel: '名詞：電腦操作 →' },
  'tool-search': { href: '/glossary/#rag', linkLabel: '延伸：RAG 檢索 →' },
  'long-term-memory': { href: '/glossary/#vector-database', linkLabel: '名詞：向量資料庫 →' },
  guardrails: { href: '/chain/apps-agents/', linkLabel: '前往「應用與 Agent」環節 →' },
};

/* module-level scratch (no per-frame allocations) */
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const m4 = new Matrix4();
const q0 = new Quaternion();
const c1 = new Color();
const c2 = new Color();
const vp = new Vector3();
const flying = { on: false, pos: new Vector3() };
const TRAY_NAME_LIFT = [0, -27] as const;
/** Stage width (CSS px) below which the compact label layout applies (phones, and small 16:9 stages just above the host's 40rem breakpoint). */
const COMPACT_W = 760;
const THOUGHT_LIFT = [0, -28] as const;
const NO_OFFSET = [0, 0] as const;
const occD = new Vector3();
const occC = new Vector3();

export default defineScene({
  json,
  meta: {
    camera: {
      ...HOME,
      fov: 36,
      minDistance: 4.5,
      maxDistance: 22,
      minPolar: 0.3,
      maxPolar: 1.38,
      portrait: HOME_PORTRAIT,
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 44, tris: 60_000 },
  },

  create(ctx: SceneContext) {
    const { scene, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'agent-loop';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));

    /* ───────── static diorama ───────── */
    const floor = buildFloor(ctx);
    const core = buildCore(ctx);
    const track = buildTrack(ctx);
    const guard = buildGuard(ctx);
    const servers = buildServers(ctx);
    const store = buildMemoryStore(ctx);
    const tray = buildTray(ctx);
    const threat = buildThreat(ctx);
    root.add(floor.group, core.group, track.group, guard.group, servers.group, store.group, tray.group, threat.mesh);
    const storeTop = store.group.position.clone().setY(0.66);

    /* ───────── arcs & flows ───────── */
    const outA = TOOLS.map(outArc);
    const retA = TOOLS.map(returnArc);
    const writeA: ArcSpec = { start: new Vector3(-0.32, BRAIN_Y - 0.3, 0.3), end: storeTop.clone(), height: 0.28, tc: 0 };
    const readA: ArcSpec = { start: storeTop.clone().add(new Vector3(0.06, 0, -0.06)), end: new Vector3(-0.28, BRAIN_Y - 0.36, 0.22), height: 0.36, tc: 0 };
    // Compaction: tray → long-term store, one path per tray height (landscape / portrait layout).
    const compactA: ArcSpec = { start: new Vector3(-TRAY_W / 2 + 0.6, TRAY.y - 0.15, TRAY.z), end: storeTop.clone(), height: 0.25, tc: 0 };
    const compactAP: ArcSpec = { start: new Vector3(-TRAY_W / 2 + 0.6, TRAY_Y_PORTRAIT - 0.15, TRAY.z), end: storeTop.clone(), height: 0.25, tc: 0 };

    const arcs = ctx.track(new ArcRibbons({ count: N * 2, mode: 'planar', segments: 40, flow: 0.55, theme: ctx.theme }));
    // Kit workaround (proposals/scene-agent-loop.yaml): the ribbon strip is back-facing whenever an arc runs
    // left → right on screen, and the kit material uses the default FrontSide, so those arcs were culled.
    arcs.object.material.side = DoubleSide;
    arcs.object.material.forceSinglePass = true;
    arcs.setArcs([
      ...outA.map((a) => ({ start: a.start, end: a.end, height: a.height, width: 0.04, alpha: 0, progress: 1 })),
      ...retA.map((a) => ({ start: a.start, end: a.end, height: a.height, width: 0.03, alpha: 0, progress: 1 })),
    ]);
    root.add(arcs.object);

    const flowPath = (a: ArcSpec, j: number): FlowPath => {
      const pts = arcSamples(a, 40);
      return { points: pts, speed: polylineLength(pts), offset: -GAP * j };
    };
    const callFlow = ctx.track(
      new PathFlow({
        paths: outA.map(flowPath),
        count: N * COMET.length,
        size: 0.13,
        sizeVariance: 0,
        speed: 1,
        speedVariance: 0,
        smooth: false,
        mode: 'once',
        onceOffsets: COMET,
        fadeEnds: 0.02,
        byLength: false,
        theme: ctx.theme,
      }),
    );
    const resultFlow = ctx.track(
      new PathFlow({
        paths: [...retA, writeA, readA, compactA, compactAP].map(flowPath),
        count: (N + 4) * TRAIN.length,
        size: 0.09,
        sizeVariance: 0,
        speed: 1,
        speedVariance: 0,
        smooth: false,
        mode: 'once',
        onceOffsets: TRAIN,
        fadeEnds: 0.03,
        byLength: false,
        theme: ctx.theme,
      }),
    );
    root.add(callFlow.object, resultFlow.object);

    const glows = ctx.track(new GlowSprites({ count: G_COUNT, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── pick proxies for thin parts ───────── */
    const proxyMat = ctx.track(new MeshBasicMaterial());
    proxyMat.visible = false;
    const loopProxy = new Mesh(ctx.track(new RingGeometry(R_TRACK - 0.26, R_TRACK + 0.26, 72)), proxyMat);
    loopProxy.rotation.x = -Math.PI / 2;
    loopProxy.position.y = 0.06;
    const collarProxy = new Mesh(ctx.track(new CylinderGeometry(R_COLLAR + 0.1, R_COLLAR + 0.1, 0.24, 32, 1, true)), proxyMat);
    collarProxy.position.y = COLLAR_Y;
    root.add(loopProxy, collarProxy);

    /* ───────── labels ───────── */
    const stationLabels = STATIONS.map((s, i) => {
      const p = polar(R_TRACK + 0.2, stationPhi(i), 0.06);
      return labels.add({
        text: `${s.num} ${s.name}`,
        position: p,
        align: p.z > 0 ? (p.x < 0 ? 'below' : 'right') : p.x < 0 ? 'left' : 'right',
        priority: 28,
        hotspot: 'agent-loop',
      });
    });
    const llmLabel = labels.add({ text: 'LLM 大腦', position: [SHELL_R + 0.06, BRAIN_Y + 0.16, 0], align: 'right', kind: 'strong', priority: 34, hotspot: 'llm' });
    const collarLabel = labels.add({ text: 'MCP 用戶端', position: polar(R_COLLAR + 0.12, 62, COLLAR_Y), align: 'right', kind: 'tag', priority: 14, hotspot: 'mcp-client' });
    const serverLabels = TOOLS.map((t) => labels.add({ text: t.short, position: polar(serverR(t.phi), t.phi, SERVER_TOP), priority: 22, hotspot: t.id }));
    const guardLabel = labels.add({ text: '權限與防護欄', position: polar(R_GUARD + 0.04, 108, 0.2), align: 'right', priority: 18, hotspot: 'guardrails' });
    const storeLabel = labels.add({
      text: '長期記憶庫',
      position: polar(MEMORY_R + 0.36, MEMORY_PHI - 4, 0.36),
      align: 'left',
      priority: 20,
      hotspot: 'long-term-memory',
    });
    // Tray labels follow the tray group (positions are local offsets).
    const trayLabel = labels.add({ text: '上下文視窗（短期記憶）', object: tray.group, position: [-TRAY_W / 2 - 0.12, 0, 0], align: 'left', priority: 26, hotspot: 'context-window' });
    const fillLabel = labels.add({ text: '', object: tray.group, position: [TRAY_W / 2 + 0.12, 0, 0], align: 'right', kind: 'muted', priority: 16, hotspot: 'context-window' });
    const mcpLabel = labels.add({ text: '外圈：MCP 伺服器', position: polar(serverR(36) + 0.1, 36, 0.02), align: 'center', kind: 'tag', priority: 12, visible: false });
    const thoughtLabel = labels.add({ text: '', position: [0, BRAIN_Y + SHELL_R + 0.1, 0], align: 'above', priority: 40, always: true });
    const eventLabel = labels.add({ text: '', position: [0, 0, 0], align: 'above', priority: 42, always: true });
    const gateLabel = labels.add({ text: '', position: [0, 0, 0], align: 'above', priority: 44, always: true });
    labels.setMax(Math.max(ctx.tier.maxLabels, 14));
    // Hide labels whose anchor is behind the brain's glass shell (e.g. a back server seen past it).
    const OCC_R2 = (SHELL_R * 0.95) ** 2;
    const OWN_R2 = (SHELL_R + 0.32) ** 2; // the brain's own labels (name, thought) never hide
    labels.setOccluder((w, cam) => {
      if (w.distanceToSquared(core.brain.position) < OWN_R2) return false;
      const o = cam.position;
      occD.subVectors(w, o);
      const len = occD.length();
      if (len < 1e-6) return false;
      occD.multiplyScalar(1 / len);
      occC.subVectors(o, core.brain.position);
      const b = occC.dot(occD);
      const disc = b * b - (occC.lengthSq() - OCC_R2);
      if (disc <= 0) return false;
      const hit = -b - Math.sqrt(disc);
      return hit > 0 && hit < len - 0.02;
    });

    /**
     * Label updates go through `put`, which forwards only real changes: LabelHandle.set() always
     * invalidates, so calling it every frame would keep the demand loop (reduced motion) alive.
     */
    interface LabelCache {
      text?: string;
      swatch?: string;
      kind?: LabelSpec['kind'];
      priority?: number;
      visible?: boolean;
      align?: LabelSpec['align'];
      offset?: LabelSpec['offset'];
      always?: boolean;
      pos: Vector3;
      hasPos: boolean;
    }
    const cache = new Map<LabelHandle, LabelCache>();
    const put = (h: LabelHandle, patch: Partial<Pick<LabelSpec, 'text' | 'swatch' | 'kind' | 'priority' | 'visible' | 'align' | 'offset' | 'always'>> & { position?: Vector3 }) => {
      let c = cache.get(h);
      if (!c) cache.set(h, (c = { pos: new Vector3(), hasPos: false }));
      let dirty = false;
      const out: Partial<LabelSpec> = {};
      if (patch.text !== undefined && patch.text !== c.text) {
        out.text = c.text = patch.text;
        dirty = true;
      }
      if (patch.swatch !== undefined && patch.swatch !== c.swatch) {
        out.swatch = c.swatch = patch.swatch;
        dirty = true;
      }
      if (patch.kind !== undefined && patch.kind !== c.kind) {
        out.kind = c.kind = patch.kind;
        dirty = true;
      }
      if (patch.priority !== undefined && patch.priority !== c.priority) {
        out.priority = c.priority = patch.priority;
        dirty = true;
      }
      if (patch.visible !== undefined && patch.visible !== c.visible) {
        out.visible = c.visible = patch.visible;
        dirty = true;
      }
      if (patch.align !== undefined && patch.align !== c.align) {
        out.align = c.align = patch.align;
        dirty = true;
      }
      if (patch.always !== undefined && patch.always !== c.always) {
        out.always = c.always = patch.always;
        dirty = true;
      }
      // Offsets are module constants, so a reference compare is enough.
      if (patch.offset !== undefined && patch.offset !== c.offset) {
        out.offset = c.offset = patch.offset;
        dirty = true;
      }
      if (patch.position && (!c.hasPos || c.pos.distanceToSquared(patch.position) > 1e-8)) {
        c.pos.copy(patch.position);
        c.hasPos = true;
        out.position = c.pos;
        dirty = true;
      }
      if (dirty) h.set(out);
    };
    const setText = (h: LabelHandle, text: string, swatch?: string) => put(h, swatch === undefined ? { text } : { text, swatch });

    /* Label placement per stage shape. Wide landscape: side servers label outward (left / right) so
       the back pair stays clear of the context tray. Small stages (phones) and portrait stages use
       the variants in layoutLabels(): labels there are large relative to the diorama. */
    let portrait = ctx.size.portrait;
    /** Small stages (phones: 4:3 inline, 4:5 tall): labels are large relative to the diorama. */
    let compact = portrait || ctx.size.width < COMPACT_W;
    /** Stack the tray's name and fill count above it (small stages with headroom: 4:3, 4:5). */
    let stackTray = portrait || (compact && ctx.size.aspect < 1.6);
    /** 規劃 spells out what each station does; small stages keep the short names (the caption has it). */
    const stationText = () => {
      stationLabels.forEach((h, i) => {
        const st = STATIONS[i]!;
        put(h, { text: ctx.step === 1 && !compact ? `${st.num} ${st.name}：${st.verb}` : `${st.num} ${st.name}` });
      });
    };
    /**
     * Step- and stage-dependent label ranks. The moving event callout is drawn over everything
     * (`always`), except on small stages in 總覽 and 規劃, where it yields to the brain and station
     * names it would otherwise cover. 權限防護 / 提示注入 promote the guardrail label (on small
     * stages it must not hide a server's name).
     */
    const stepRanks = () => {
      const yields = compact && ctx.step <= 1;
      put(eventLabel, { always: !yields, priority: yields ? 27 : 42 });
      put(guardLabel, { priority: ctx.step >= 5 && !compact ? 32 : 18 });
    };
    /**
     * 呼叫工具 names each server's tool; on small stages only where the label has room (the front
     * centre and the back pair; the side pair sits at the stage edges).
     */
    const serverText = () => {
      serverLabels.forEach((h, j) => {
        const t = TOOLS[j]!;
        const room = !compact || Math.abs(polar(serverR(t.phi), t.phi, 0, v1).x) < 1 || v1.z < 0;
        put(h, { text: ctx.step === 2 && room ? `${t.short}・${t.fn}` : t.short });
      });
    };
    const layoutLabels = () => {
      // Stations: labels outside the track on wide stages. On a narrow landscape stage the brain's
      // name (to its right) would cover ②'s label, so ② and ③ label below their stations.
      const narrow = compact && !portrait;
      stationLabels.forEach((h, i) => {
        const p = polar(R_TRACK + 0.2, stationPhi(i), 0.06, v1);
        const front = p.z > 0;
        const left = p.x < 0;
        put(h, { position: v1, align: narrow ? (!front && left ? 'left' : 'below') : front ? (left ? 'below' : 'right') : left ? 'left' : 'right' });
      });
      stationText();
      TOOLS.forEach((t, j) => {
        const c = polar(serverR(t.phi), t.phi, 0, v1);
        const side = Math.abs(c.x) < 1 ? 0 : Math.sign(c.x);
        if (side === 0) put(serverLabels[j]!, { position: polar(serverR(t.phi) + 0.5, t.phi, 0.05, v2), align: 'below' });
        // Portrait: the side servers sit near the stage edges, so their labels lean inward (a label
        // that does not fit inside the stage is hidden by the label layer). The back pair labels
        // above the server; the front pair below its pad, in the free floor under the guardrail
        // (above it, they would collide with the brain and station labels).
        else if (portrait && c.z < 0) put(serverLabels[j]!, { position: v2.copy(c).setY(SERVER_TOP + 0.42).setX(c.x - side * 0.6), align: 'above' });
        else if (portrait) put(serverLabels[j]!, { position: v2.set(c.x - side * 0.4, 0.05, c.z + 0.5), align: 'below' });
        else {
          // Small 4:3 stages: the back pair labels sit higher, between the stacked tray labels and
          // the brain's name.
          const y = narrow && stackTray && c.z < 0 ? SERVER_TOP + 0.5 : SERVER.h * 0.62;
          put(serverLabels[j]!, { position: v2.copy(c).add(v3.set(side * (SERVER.w / 2 + 0.06), y, 0)), align: side < 0 ? 'left' : 'right' });
        }
      });
      serverText();
      // Portrait: beside the brain, the name would cover the ② station label (labels are large
      // relative to a phone stage), so it sits on top of the shell with the thought callout above it.
      put(llmLabel, portrait ? { position: v1.set(0, BRAIN_Y + SHELL_R + 0.04, 0), align: 'above' } : { position: v1.set(SHELL_R + 0.06, BRAIN_Y + 0.16, 0), align: 'right' });
      put(thoughtLabel, { offset: portrait ? THOUGHT_LIFT : NO_OFFSET });
      // Small stages: the guardrail label moves to the free floor at the ring's front-right, the
      // store label under the store (beside them they would run off the stage or hit the station
      // labels).
      put(guardLabel, compact ? { position: polar(R_GUARD + 0.12, 28, 0, v1), align: 'below' } : { position: polar(R_GUARD + 0.04, 108, 0.2, v1), align: 'right' });
      put(
        storeLabel,
        compact
          ? { position: polar(MEMORY_R, MEMORY_PHI, 0, v1).add(v2.set(0, 0, 0.42)), align: 'below' }
          : { position: polar(MEMORY_R + 0.36, MEMORY_PHI - 4, 0.36, v1), align: 'left' },
      );
      tray.setY(portrait ? TRAY_Y_PORTRAIT : TRAY.y);
      stepRanks();
      // Small 4:3 / 4:5 stages: the tray is too short on screen for two labels beside it, so the
      // name and the fill count stack above its centre (a 16:9 stage has no headroom for that).
      put(trayLabel, stackTray ? { position: v1.set(0, 0.28, 0), align: 'above', offset: TRAY_NAME_LIFT } : { position: v1.set(-TRAY_W / 2 - 0.12, 0, 0), align: 'left', offset: NO_OFFSET });
      put(fillLabel, stackTray ? { position: v1.set(0, 0.28, 0), align: 'above', kind: 'tag' } : { position: v1.set(TRAY_W / 2 + 0.12, 0, 0), align: 'right', kind: 'muted' });
    };
    layoutLabels();

    /**
     * Moving callouts (event and gate labels) sit above their anchor, but flip beside it near the
     * left / right stage edge, where a centred label would not fit and the label layer would drop it.
     */
    const calloutAlign = (w: Vector3, text: string): NonNullable<LabelSpec['align']> => {
      const width = ctx.size.width;
      vp.copy(w).project(ctx.camera);
      const x = ((vp.x + 1) / 2) * width;
      const fs = Math.min(13, Math.max(11, 8.8 + 0.004 * width)); // the label font-size clamp
      let tw = 30; // padding + swatch
      for (let i = 0; i < text.length; i++) tw += text.charCodeAt(i) > 0x2e7f ? fs : fs * 0.58;
      if (x + tw / 2 > width - 4) return 'left';
      if (x - tw / 2 < 4) return 'right';
      return 'above';
    };
    /** Height of the callouts that start at the brain (above the stacked name + thought in portrait). */
    const eventY = () => BRAIN_Y + (portrait ? 1.5 : 0.9);

    /* ───────── colours ───────── */
    const C = {
      bg: new Color(),
      fg: new Color(),
      flow: new Color(),
      optic: new Color(),
      pos: new Color(),
      neg: new Color(),
      amber: new Color(),
      accent: new Color(),
      agent: new Color(),
      mem: new Color(),
      body: new Color(),
      ink: new Color(),
      ledOff: new Color(),
      system: new Color(),
      station: new Color(),
    };
    const blockColor = (t: BlockType): Color => {
      switch (t) {
        case 'system':
          return C.system;
        case 'task':
          return C.amber;
        case 'call':
          return C.flow;
        case 'result':
          return C.optic;
        default:
          return C.mem;
      }
    };
    const dark = () => ctx.theme === 'dark';
    let css = ctx.palette.css;

    /* ───────── emphasis (dimming) & hover ───────── */
    const dim: Dim = { ...(STEP_DIM[ctx.step] ?? STEP_DIM[0]!) };
    const toolDim = (j: number) => (ctx.step === 6 && j === T_BROWSER ? 0 : dim.tools);
    const hot = new Map<string, number>();
    const hotOf = (id: HotId) => hot.get(id) ?? 0;

    const paint = () => {
      const dk = dark();
      // Servers.
      TOOLS.forEach((t, j) => {
        const d = toolDim(j);
        const h = hotOf(t.id);
        c1.copy(C.body).lerp(C.bg, 0.55 * d).lerp(C.amber, 0.28 * h);
        servers.bodies.setColorAt(j, c1);
        c1.copy(C.body).lerp(C.bg, dk ? 0.35 : 0.25).lerp(C.bg, 0.5 * d);
        servers.pads.setColorAt(j, c1);
        c1.copy(C.ink).lerp(C.bg, 0.6 * d);
        paintGroup(servers.emblemGeo, servers.emblemRanges, j, c1);
      });
      for (const m of [servers.bodies, servers.pads]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
      // Guard.
      guard.bandMat.color.copy(C.pos);
      guard.bandMat.opacity = ((dk ? 0.1 : 0.13) + 0.12 * hotOf('guardrails')) * (1 - 0.6 * dim.guard);
      guard.railMat.color.copy(C.pos);
      guard.railMat.opacity = (dk ? 0.55 : 0.7) * (1 - 0.55 * dim.guard) + 0.3 * hotOf('guardrails');
      // Memory.
      const md = dim.memory;
      store.diskMat.color.copy(C.mem).lerp(C.body, dk ? 0.55 : 0.4).lerp(C.bg, 0.45 * md);
      store.diskMat.emissive.copy(C.mem).multiplyScalar((dk ? 0.25 : 0.05) * (1 - md) + 0.3 * hotOf('long-term-memory'));
      store.glassMat.opacity = (dk ? 0.1 : 0.14) * (1 - 0.5 * md);
      tray.glassMat.opacity = ((dk ? 0.07 : 0.06) + 0.08 * hotOf('context-window')) * (1 - 0.4 * md);
      tray.frameMat.color.copy(C.fg);
      tray.frameMat.opacity = ((dk ? 0.38 : 0.42) + 0.35 * hotOf('context-window')) * (1 - 0.5 * md);
      // Core.
      core.coreMat.color.copy(C.accent).lerp(C.bg, dark() ? 0.1 : 0.22);
      core.wireMat.color.copy(C.accent).lerp(C.fg, dk ? 0.25 : 0);
      core.pedestalMat.color.copy(C.body).lerp(C.bg, dk ? 0.15 : 0.3);
      track.trackMat.color.copy(C.agent);
      track.trackMat.emissive.copy(C.agent).multiplyScalar((dk ? 0.18 : 0.03) + 0.35 * hotOf('agent-loop'));
      // Labels follow emphasis.
      serverLabels.forEach((h, j) => put(h, { kind: toolDim(j) > 0.4 ? 'muted' : 'default', priority: toolDim(j) > 0.4 ? 8 : 22 }));
      for (const h of [storeLabel, trayLabel]) put(h, { kind: md > 0.4 ? 'muted' : 'default' });
      put(guardLabel, { kind: dim.guard > 0.4 ? 'muted' : 'default' });
    };

    const applyPalette = (p: Palette) => {
      const dk = p.theme === 'dark';
      css = p.css;
      C.bg.copy(p.bg);
      C.fg.copy(p.fg);
      C.flow.copy(p.flow);
      C.optic.copy(p.optic);
      C.pos.copy(p.pos);
      C.neg.copy(p.neg);
      C.amber.copy(p.highlight);
      C.accent.copy(p.accent);
      C.agent.copy(p.seg['apps-agents']);
      C.mem.copy(p.seg['memory-storage']);
      C.body.copy(p.bg).lerp(p.fg, dk ? 0.24 : 0.13).lerp(p.muted, 0.18);
      C.ink.copy(p.fg).lerp(p.bg, dk ? 0.08 : 0.12);
      C.ledOff.copy(p.muted).lerp(p.bg, 0.35);
      C.system.copy(p.muted).lerp(p.fg, dk ? 0.15 : 0.1);
      // Idle stations: gold pucks on dark; on light, pale porcelain pucks with a hint of the agent
      // hue (a darkened gold reads as khaki on the cream floor).
      if (dk) C.station.copy(p.seg['apps-agents']).lerp(p.bg, 0.32);
      else C.station.copy(p.bg).lerp(p.fg, 0.03).lerp(p.seg['apps-agents'], 0.16);
      lights.apply(p);
      floor.discMat.color.copy(p.bg).lerp(p.fg, dk ? 0.05 : 0.035);
      floor.recolorGrid(c1.copy(p.grid).lerp(p.fg, dk ? 0.1 : 0.06), dk ? 0.7 : 0.85);
      floor.shadowMat.color.copy(dk ? p.accent : p.fg);
      floor.shadowMat.opacity = dk ? 0.1 : 0.09;
      threat.mat.color.copy(p.neg);
      threat.mat.emissive.copy(p.neg).multiplyScalar(dk ? 0.6 : 0.25);
      core.coreMat.emissive.copy(p.accent).multiplyScalar(dk ? 0.35 : 0.08);
      track.tokenMat.color.copy(p.highlight);
      track.tokenMat.emissive.copy(p.highlight).multiplyScalar(dk ? 0.7 : 0.25);
      for (const f of [callFlow, resultFlow]) f.setTheme(p.theme);
      callFlow.recolor(() => p.flow);
      resultFlow.recolor((i) => (i < N ? p.optic : p.seg['memory-storage']));
      callFlow.setSize(dk ? 0.13 : 0.1);
      resultFlow.setSize(dk ? 0.095 : 0.075);
      arcs.setTheme(p.theme);
      for (let j = 0; j < N; j++) {
        arcs.setColor(j, p.flow);
        arcs.setColor(N + j, p.optic);
      }
      glows.setTheme(p.theme);
      put(collarLabel, { swatch: css['scene-flow'] ?? '' });
      paint();
    };

    /* ───────── episode state ───────── */
    let ep: Episode = episodeFor(ctx.step);
    let pi = 0;
    let pt = 0;
    let blocks: BlockType[] = blocksAt(ep, 0);
    const enter = (i: number) => {
      pi = i;
      blocks = blocksAt(ep, i);
    };

    /* ───────── per-frame render of the current (phase, time) ───────── */
    const outProg = new Float32Array(N);
    const outAlpha = new Float32Array(N);
    const retProg = new Float32Array(N);
    const retAlpha = new Float32Array(N);
    const gateFlash = new Float32Array(N);
    const led = new Float32Array(N);
    const port = new Float32Array(N);

    const gateState = new Uint8Array(N); // 0 base, 1 waiting (amber), 2 approved (green), 3 blocked (red)

    const blockAt = (n: number, x: number, y: number, z: number, w: number, s: number, col: Color) => {
      if (n >= tray.blocks.instanceMatrix.count) return;
      v1.set(x, y, z);
      v2.set(Math.max(0.001, (w * TRAY.pitch - 0.03) * s), Math.max(0.001, TRAY.block * s), Math.max(0.001, TRAY.block * s));
      tray.blocks.setMatrixAt(n, m4.compose(v1, q0.identity(), v2));
      tray.blocks.setColorAt(n, col);
    };
    const slotX = (slot: number, w: number) => -TRAY_W / 2 + (slot + w / 2) * TRAY.pitch;
    /** World → tray-local (the tray group is only translated). */
    const toTray = (w: Vector3, out: Vector3) => out.set(w.x - tray.group.position.x, w.y - tray.group.position.y, w.z - tray.group.position.z);
    const brainLocal = new Vector3();
    const storeLocal = new Vector3();

    const render = () => {
      const ph = ep.phases[pi]!;
      const t = pt;
      const k = clamp01(t / ph.dur);
      const dk = dark();
      const tool = TOOLS[ph.tool]!;
      const j = ph.tool;
      const step = ctx.step;

      // Reset per-frame state.
      const faint = step === 2 ? 0.42 : dk ? 0.24 : 0.26;
      for (let i = 0; i < N; i++) {
        outProg[i] = 1;
        outAlpha[i] = faint * (1 - toolDim(i));
        retProg[i] = 1;
        retAlpha[i] = 0;
        gateFlash[i] = 0;
        led[i] = 0;
        port[i] = 0;
        gateState[i] = 0;
      }
      let brain = 0.12;
      let storeGlow = 0;
      let callT = -1;
      let resPath = -1;
      let resT = 0;
      let threatU = -1;
      let threatScale = 0;
      let impact = 0;
      let thought = '';
      let event = '';
      let eventSwatch = '';
      let gateText = '';
      let gateSwatch = '';
      let gateTool = j;
      v3.set(0, 0, 0); // event anchor

      /* token on the track */
      const prev = ep.phases[pi - 1];
      const from = stationOf(prev ? prev.kind : ph.kind);
      const to = stationOf(ph.kind);
      const hops = (to - from + 4) % 4;
      const moveDur = Math.min(0.6, ph.dur * 0.35);
      const mk = hops ? easeInOut(clamp01(t / moveDur)) : 1;
      const phi = stationPhi(from) - 90 * hops * mk;
      polar(R_TRACK, phi, 0.15, track.token.position);
      const moving = hops > 0 && mk < 1 ? Math.sin(Math.PI * mk) : 0;
      const activeStation = mk > 0.5 ? to : from;

      /* phase choreography */
      switch (ph.kind) {
        case 'plan': {
          brain = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(k * Math.PI * 4)) * (1 - smooth(0.8, 1, k));
          thought = pi === 0 && k < 0.4 ? '收到任務：整理一份比較報告（示意）' : PLAN_TEXT[j]!;
          if (ph.recall) {
            resPath = P_READ;
            resT = 1.3 * clamp01((k - 0.06) / 0.42);
            storeGlow = bump(0.02, 0.5, k);
            if (k > 0.06 && k < 0.55) {
              event = '從長期記憶取回';
              eventSwatch = css['seg-memory-storage'] ?? '';
              arcPoint(readA, Math.min(1, resT), v3);
            }
          }
          if (k > 0.72 && ep.phases[pi + 1]?.kind === 'act') {
            event = `工具呼叫 → 上下文`;
            eventSwatch = css['scene-flow'] ?? '';
            v3.set(0, eventY(), 0);
          }
          break;
        }
        case 'act': {
          const a = outA[j]!;
          let prog: number;
          if (ph.approve) {
            const hold = a.tc - 0.035;
            if (k < 0.27) prog = hold * easeInOut(k / 0.27);
            else if (k < 0.7) prog = hold;
            else prog = hold + (1 - hold) * easeInOut(clamp01((k - 0.7) / 0.26));
            if (k > 0.24 && k < 0.95) {
              const ok = k > 0.63;
              gateState[j] = ok ? 2 : 1;
              gateText = compact ? (ok ? OK_TEXT[j]! : WAIT_TEXT[j]!) : ok ? '已核准，放行' : '等待人類核准';
              gateSwatch = ok ? (css['c-pos'] ?? '') : (css['scene-highlight'] ?? '');
              gateFlash[j] = ok ? 1 - smooth(0.66, 0.95, k) * 0.6 : 0.55 + 0.45 * Math.sin(k * Math.PI * 10);
            }
          } else {
            prog = easeInOut(clamp01((k - 0.05) / 0.78));
            gateFlash[j] = bump(a.tc - 0.12, a.tc + 0.2, prog);
            if (gateFlash[j]! > 0.05) gateState[j] = 2;
          }
          outProg[j] = Math.max(0.001, prog);
          outAlpha[j] = 1;
          callT = prog;
          port[j] = 1 - smooth(0.1, 0.4, k);
          if (!gateText) {
            event = CALL_TEXT[j]!;
            eventSwatch = css['scene-flow'] ?? '';
            arcPoint(a, Math.max(0.02, prog), v3);
          }
          break;
        }
        case 'exec': {
          outAlpha[j] = 1 - 0.35 * k;
          callT = 1 + 0.2 * clamp01(k / 0.4);
          led[j] = 0.55 + 0.45 * Math.sin(k * Math.PI * 7);
          event = EXEC_TEXT[j]!;
          eventSwatch = css['scene-flow'] ?? '';
          polar(serverR(tool.phi), tool.phi, SERVER_TOP + 0.5, v3);
          break;
        }
        case 'observe': {
          const a = retA[j]!;
          outAlpha[j] = 0.65 + (faint - 0.65) * smooth(0, 0.5, k);
          // Injection: the hidden instruction (red packet) leads the result train; it is stopped at
          // the checkpoint (kHit), the ring turns red, and only then does the clean data continue.
          const LEAD = 0.06;
          const kHit = 0.34;
          const kGo = 0.54;
          const tb = a.tc - 0.02;
          let tau: number;
          if (!ph.inject) tau = 1.3 * clamp01((k - 0.04) / 0.8);
          else if (k < kHit) tau = (tb - LEAD) * easeInOut(clamp01((k - 0.04) / (kHit - 0.04)));
          else if (k < kGo) tau = tb - LEAD;
          else tau = tb - LEAD + (1.3 - tb + LEAD) * clamp01((k - kGo) / 0.42);
          retProg[j] = Math.max(0.001, Math.min(1, tau));
          retAlpha[j] = 1;
          resPath = j;
          resT = tau;
          led[j] = 0.6 * (1 - smooth(0, 0.3, k));
          port[j] = bump(0.85, 1.3, tau);
          gateFlash[j] = bump(a.tc - 0.1, a.tc + 0.2, tau);
          if (gateFlash[j]! > 0.05) gateState[j] = 2;
          event = RESULT_TEXT[j]!;
          eventSwatch = css['scene-optic'] ?? '';
          arcPoint(a, Math.min(1, Math.max(0.03, tau)), v3);
          if (ph.inject) {
            threatU = Math.min(tau + LEAD, tb);
            threatScale = 1 - smooth(kGo - 0.02, kGo + 0.2, k);
            if (k >= kHit) {
              gateState[j] = 3;
              gateFlash[j] = 1 - 0.55 * smooth(kGo, 1, k);
              impact = bump(kHit - 0.03, kGo + 0.12, k);
              gateText = '已攔截：網頁中的可疑指令';
              gateSwatch = css['c-neg'] ?? '';
              if (k < kGo + 0.05) event = '';
            } else {
              event = '網頁內容（藏有指令）';
              eventSwatch = css['c-neg'] ?? '';
            }
          }
          break;
        }
        case 'memory': {
          retAlpha[j] = 1 - smooth(0, 0.45, k);
          if (k < 0.62) {
            event = '工具結果 → 上下文';
            eventSwatch = css['scene-optic'] ?? '';
            v3.set(0, eventY(), 0);
          }
          if (ph.ltWrite) {
            resPath = P_WRITE;
            resT = 1.3 * clamp01((k - 0.5) / 0.42);
            storeGlow = bump(0.75, 1.05, k);
            if (k >= 0.62) {
              event = '重點寫入長期記憶';
              eventSwatch = css['seg-memory-storage'] ?? '';
              arcPoint(writeA, Math.min(1, Math.max(0.05, resT)), v3);
            }
          }
          break;
        }
        case 'compact': {
          resPath = portrait ? P_COMPACT_P : P_COMPACT;
          resT = 1.3 * clamp01((k - 0.52) / 0.4);
          storeGlow = bump(0.8, 1.1, k);
          if (k < 0.55) {
            event = '上下文快滿：舊內容壓縮成摘要';
            eventSwatch = css['seg-memory-storage'] ?? '';
            v3.set(-TRAY_W / 2 + 0.6, 0.22, 0).add(tray.group.position);
          } else {
            event = '摘要重點存入長期記憶';
            eventSwatch = css['seg-memory-storage'] ?? '';
            arcPoint(portrait ? compactAP : compactA, Math.min(1, Math.max(0.05, resT)), v3);
          }
          break;
        }
        case 'done': {
          brain = 0.35 + 0.65 * bump(0, 0.55, k);
          thought = '任務完成：回覆使用者';
          break;
        }
        default:
      }

      /* step 5: risky tools' gates show amber when idle (needs approval) */
      if (step === 5) for (let i = 0; i < N; i++) if (TOOLS[i]!.risky && gateState[i] === 0) gateState[i] = 1;

      /* ── apply: arcs ── */
      for (let i = 0; i < N; i++) {
        arcs.setProgress(i, outProg[i]!);
        arcs.setAlpha(i, outAlpha[i]! * (dk ? 0.95 : 0.9));
        arcs.setProgress(N + i, retProg[i]!);
        arcs.setAlpha(N + i, retAlpha[i]!);
      }

      /* ── flows (time-multiplexed 'once' paths) ── */
      callFlow.object.visible = callT >= 0;
      if (callT >= 0) callFlow.setTime(GAP * j + callT);
      resultFlow.object.visible = resPath >= 0;
      if (resPath >= 0) resultFlow.setTime(GAP * resPath + resT);

      /* ── gates ── */
      for (let i = 0; i < N; i++) {
        const st = gateState[i]!;
        const base = st === 1 ? C.amber : st === 3 ? C.neg : C.pos;
        c1.copy(base).lerp(C.bg, st === 0 ? 0.25 + 0.5 * dim.guard : 0);
        if (st === 0) c1.lerp(C.pos, 0.3 * hotOf('guardrails'));
        guard.gates.setColorAt(i, c1);
        const g = Math.max(gateFlash[i]!, 0.35 * hotOf('guardrails'));
        polar(R_GUARD, TOOLS[i]!.phi, GATE.cy, v1);
        glows.set(G_GATE + i, v1, 1.1 + 0.5 * g, base, g * (dk ? 0.8 : 0.55));
      }
      if (guard.gates.instanceColor) guard.gates.instanceColor.needsUpdate = true;

      /* ── servers: status strips ── */
      for (let i = 0; i < N; i++) {
        const h = hotOf(TOOLS[i]!.id);
        const on = Math.max(led[i]!, 0.6 * h);
        c1.copy(C.ledOff).lerp(C.bg, 0.5 * toolDim(i)).lerp(C.flow, on);
        servers.leds.setColorAt(i * 4, c1);
        servers.leds.setColorAt(i * 4 + 2, c1);
        c1.lerp(C.ledOff, 0.4 * (1 - on));
        servers.leds.setColorAt(i * 4 + 1, c1);
        servers.leds.setColorAt(i * 4 + 3, c1);
        polar(serverR(TOOLS[i]!.phi) - 0.32, TOOLS[i]!.phi, 0.6, v1);
        glows.set(G_LED + i, v1, 0.9 + 0.4 * on, C.flow, on * (dk ? 0.75 : 0.45));
        // MCP client ports.
        const pp = Math.max(port[i]!, 0.6 * hotOf('mcp-client'));
        c1.copy(C.flow).lerp(C.bg, 0.35 * (1 - pp));
        core.ports.setColorAt(i, c1);
        polar(R_COLLAR + 0.02, TOOLS[i]!.phi, COLLAR_Y, v1);
        glows.set(G_PORT + i, v1, 0.45 + 0.3 * pp, C.flow, pp * (dk ? 0.85 : 0.5));
      }
      if (servers.leds.instanceColor) servers.leds.instanceColor.needsUpdate = true;
      if (core.ports.instanceColor) core.ports.instanceColor.needsUpdate = true;

      /* ── brain ── */
      const bh = hotOf('llm');
      const b = Math.min(1, brain + 0.5 * bh);
      core.coreMat.emissive.copy(C.accent).multiplyScalar((dk ? 0.3 : 0.06) + (dk ? 0.6 : 0.22) * b);
      core.wireMat.opacity = (dk ? 0.45 : 0.4) + 0.4 * b;
      v1.set(0, BRAIN_Y, 0);
      glows.set(G_BRAIN, v1, 2.0 + 0.9 * b, C.accent, (dk ? 0.35 : 0.2) + (dk ? 0.45 : 0.25) * b);

      /* ── token, trail, stations ── */
      const lh = hotOf('agent-loop');
      glows.set(G_TOKEN, track.token.position, 0.75, C.amber, dk ? 0.9 : 0.55);
      for (let i = 0; i < 3; i++) {
        polar(R_TRACK, phi + (i + 1) * 8 * (hops ? 1 : 0), 0.15, v1);
        glows.set(G_TRAIL + i, v1, 0.5 - i * 0.1, C.amber, moving * (0.55 - i * 0.15) * (dk ? 1 : 0.7));
      }
      for (let i = 0; i < 4; i++) {
        const on = i === activeStation ? 1 : 0;
        if (on) c1.copy(C.agent).lerp(C.amber, 0.6);
        else c1.copy(C.station);
        c1.lerp(C.amber, 0.2 * lh);
        track.stations.setColorAt(i, c1);
        polar(R_TRACK, stationPhi(i), 0.1, v1);
        glows.set(G_STATION + i, v1, 0.9, C.amber, (on * 0.55 + lh * 0.3) * (dk ? 1 : 0.6));
        put(stationLabels[i]!, { kind: on ? 'strong' : 'default' });
      }
      if (track.stations.instanceColor) track.stations.instanceColor.needsUpdate = true;

      /* ── long-term memory store ── */
      const sh = Math.max(storeGlow, 0.5 * hotOf('long-term-memory'));
      v1.copy(storeTop).setY(0.4);
      glows.set(G_STORE, v1, 1.1 + 0.6 * sh, C.mem, sh * (dk ? 0.8 : 0.5));
      store.diskMat.emissive.copy(C.mem).multiplyScalar((dk ? 0.1 : 0.0) * (1 - dim.memory) + (dk ? 0.45 : 0.25) * sh);

      /* ── prompt-injection packet ── */
      threat.mesh.visible = threatU >= 0 && threatScale > 0.01;
      if (threat.mesh.visible) {
        arcPoint(retA[T_BROWSER]!, threatU, threat.mesh.position);
        threat.mesh.position.y += 0.06;
        threat.mesh.scale.setScalar(threatScale * (1 + 0.25 * hotOf('prompt-injection')));
        threat.mesh.rotation.set(t * 2.1, t * 2.9, 0);
      }
      glows.set(G_THREAT, threat.mesh.position, 0.7, C.neg, threat.mesh.visible ? threatScale * (dk ? 0.9 : 0.6) : 0);
      polar(R_GUARD, TOOLS[gateTool]!.phi, GATE.cy, v1);
      glows.set(G_IMPACT, v1, 1.5 + 1.4 * impact, C.neg, impact * (dk ? 0.85 : 0.55));

      /* ── context tray ── */
      const md = dim.memory;
      toTray(v1.set(0, BRAIN_Y, 0), brainLocal);
      toTray(storeTop, storeLocal);
      let n = 0;
      let slot = 0;
      let used = 0;
      flying.on = false;
      const compacting = ph.kind === 'compact';
      const squeeze = compacting ? smooth(0.08, 0.5, k) : 0;
      const sumX = slotX(2, SLOTS.summary);
      for (let bi = 0; bi < blocks.length; bi++) {
        const bt = blocks[bi]!;
        const w = SLOTS[bt];
        let x = slotX(slot, w);
        let s = 1;
        if (compacting && bi >= 2) {
          x += (sumX - x) * squeeze;
          s = 1 - squeeze;
        }
        c2.copy(blockColor(bt)).lerp(C.bg, 0.45 * md);
        if (s > 0.01) blockAt(n++, x, 0, 0, w, s, c2);
        if (!compacting || bi < 2) used += w;
        slot += w;
      }
      const landing = (type: BlockType, a: number, b: number, from: Vector3) => {
        const e = easeInOut(clamp01((k - a) / (b - a)));
        if (k < a) return;
        const w = SLOTS[type];
        v2.set(slotX(slot, w), 0, 0);
        v1.copy(from).lerp(v2, e);
        v1.y += 0.45 * Math.sin(Math.PI * e);
        c2.copy(blockColor(type)).lerp(C.bg, 0.45 * md);
        blockAt(n++, v1.x, v1.y, v1.z, w, 0.45 + 0.55 * e, c2);
        if (e < 1) {
          flying.on = true;
          flying.pos.copy(v1).add(tray.group.position);
          glows.setColor(G_BLOCK, c2);
        }
        if (e > 0.5) used += w;
        slot += w;
      };
      if (ph.kind === 'plan') {
        if (ph.recall) landing('recall', 0.32, 0.56, storeLocal);
        if (ep.phases[pi + 1]?.kind === 'act') landing('call', 0.72, 0.97, brainLocal);
      } else if (ph.kind === 'memory') landing('result', 0.08, 0.6, brainLocal);
      else if (compacting) {
        slot = 2;
        const e = smooth(0.36, 0.62, k);
        if (e > 0) {
          c2.copy(C.mem).lerp(C.bg, 0.45 * md);
          blockAt(n++, sumX, 0, 0, SLOTS.summary, e, c2);
          used += SLOTS.summary;
        }
      }
      tray.blocks.count = n;
      tray.blocks.instanceMatrix.needsUpdate = true;
      if (tray.blocks.instanceColor) tray.blocks.instanceColor.needsUpdate = true;
      glows.set(G_BLOCK, flying.pos, 0.6, c2, flying.on ? (dk ? 0.8 : 0.45) : 0);
      if (flying.on && event) v3.copy(flying.pos).add(v2.set(0, 0.12, 0));
      setText(fillLabel, fillText(compacting && k > 0.45 ? 2 : used >= TRAY.slots ? 1 : 0, used));

      /* ── labels ── */
      setText(thoughtLabel, thought, thought ? (css['c-accent'] ?? '') : undefined);
      setText(eventLabel, event, eventSwatch);
      if (event) {
        v3.setY(v3.y + 0.12);
        put(eventLabel, { position: v3, align: calloutAlign(v3, event) });
      }
      setText(gateLabel, gateText, gateSwatch);
      if (gateText) {
        polar(R_GUARD, TOOLS[gateTool]!.phi, GATE.cy + GATE.r + 0.1, v1);
        put(gateLabel, { position: v1, align: calloutAlign(v1, gateText) });
      }
    };

    /* ───────── step / motion plumbing ───────── */
    const showPose = (i: number, opts?: { duration: number }) => {
      if (i <= 0) {
        ctx.setPose(ctx.homePose, opts);
        return;
      }
      const pp = portrait ? STEP_POSES_PORTRAIT[i] : null;
      ctx.setPose(pp ? fitForHost(pp) : STEP_POSES[i]!, opts);
    };
    const showStatic = () => {
      const [i, k] = ep.still;
      enter(i);
      pt = k * (ep.phases[i]?.dur ?? 1);
      render();
    };
    const startEpisode = () => {
      ep = episodeFor(ctx.step);
      enter(0);
      pt = 0;
      if (!ctx.animate) showStatic();
      else render();
    };

    let dimTween: { cancel(): void } | null = null;
    const applyEmphasis = (instant = false) => {
      dimTween?.cancel();
      const target = STEP_DIM[ctx.step] ?? STEP_DIM[0]!;
      const from = { ...dim };
      const run = (kk: number) => {
        dim.tools = from.tools + (target.tools - from.tools) * kk;
        dim.memory = from.memory + (target.memory - from.memory) * kk;
        dim.guard = from.guard + (target.guard - from.guard) * kk;
        paint();
        render();
      };
      if (instant) run(1);
      else dimTween = ctx.tween.run(run, { duration: 600, fade: true });
      const s = ctx.step;
      put(mcpLabel, { visible: s === 2 });
      put(collarLabel, { kind: s === 2 ? 'default' : 'tag', priority: s === 2 ? 30 : 14 });
      serverText();
      stationText();
      stepRanks();
    };

    /* ───────── hotspots ───────── */
    const hotTweens = new Map<string, { cancel(): void }>();
    const setHot = (id: string) => (on: boolean) => {
      hotTweens.get(id)?.cancel();
      const from = hot.get(id) ?? 0;
      hotTweens.set(
        id,
        ctx.tween.run(
          (kk) => {
            hot.set(id, from + ((on ? 1 : 0) - from) * kk);
            paint();
            render();
          },
          { duration: 220, ease: 'cubicOut', fade: true },
        ),
      );
    };
    const cardFor = (id: string, extra?: Partial<CardContent>): CardContent => {
      const h = hsText.get(id);
      const link = CARD_LINKS[id];
      const c: CardContent = { title: h?.label ?? id };
      if (h?.detail) c.body = h.detail;
      if (h?.href) c.href = h.href;
      else if (link) {
        c.href = link.href;
        c.linkLabel = link.linkLabel;
      }
      return { ...c, ...extra };
    };

    hotspots.register('llm', {
      object: core.shell,
      anchor: [0, BRAIN_Y + SHELL_R, 0],
      onHighlight: setHot('llm'),
      card: () => cardFor('llm', { swatch: css['c-accent'] ?? '' }),
      pose: { position: [0.7, 3.3, 5.2], target: [0, 1.45, 0] },
    });
    hotspots.register('agent-loop', {
      object: loopProxy,
      anchor: polar(R_TRACK, 45, 0.15),
      onHighlight: setHot('agent-loop'),
      card: (hit) => {
        if (hit?.object === track.stations && hit.instanceId !== undefined) {
          const st = STATIONS[hit.instanceId]!;
          return cardFor('agent-loop', { title: `${st.num} ${st.name}：${st.verb}`, body: STATION_CARD[hit.instanceId] ?? '' });
        }
        return cardFor('agent-loop', { swatch: css['seg-apps-agents'] ?? '' });
      },
      pose: { position: [0, 5.4, 5.8], target: [0, 0.4, 0] },
    });
    ctx.picker.add(track.stations, { id: 'agent-loop' });
    hotspots.register('mcp-client', {
      object: collarProxy,
      anchor: [0, COLLAR_Y, R_COLLAR],
      onHighlight: setHot('mcp-client'),
      card: () => cardFor('mcp-client', { swatch: css['scene-flow'] ?? '' }),
      pose: { position: [1.4, 2.7, 4.4], target: [0, 0.7, 0] },
    });
    TOOLS.forEach((t, i) => {
      const target = polar(serverR(t.phi), t.phi, 0.6);
      hotspots.register(t.id, {
        object: servers.proxies[i]!,
        anchor: polar(serverR(t.phi), t.phi, SERVER_TOP + 0.2),
        onHighlight: setHot(t.id),
        card: () => cardFor(t.id, { items: [{ label: `工具名稱（示意）：${t.fn}` }] }),
        pose: { position: [target.x * 0.85, 2.9, target.z * 0.85 + 4.2], target: [target.x, 0.6, target.z] },
      });
    });
    const trayAnchor = new Object3D();
    trayAnchor.position.set(0, 0.15, 0);
    tray.group.add(trayAnchor);
    hotspots.register('context-window', {
      object: tray.glass,
      anchor: trayAnchor,
      onHighlight: setHot('context-window'),
      card: () =>
        cardFor('context-window', {
          items: (['system', 'task', 'call', 'result', 'recall', 'summary'] as const).map((b) => ({ label: BLOCK_NAME[b], meta: `${SLOTS[b]} 格（示意）` })),
        }),
      pose: { position: [0, 3.8, 4.8], target: [0, 2.4, -0.1] },
    });
    hotspots.register('long-term-memory', {
      object: store.group,
      anchor: storeTop,
      onHighlight: setHot('long-term-memory'),
      card: () => cardFor('long-term-memory', { swatch: css['seg-memory-storage'] ?? '' }),
      pose: { position: [-4.6, 2.7, 3.7], target: [-1.9, 0.45, 0.1] },
    });
    hotspots.register('guardrails', {
      object: guard.group,
      anchor: polar(R_GUARD, 36, 0.5),
      onHighlight: setHot('guardrails'),
      card: () => cardFor('guardrails', { swatch: css['c-pos'] ?? '' }),
      pose: { position: [3.6, 3.8, 6.8], target: [0.8, 0.45, 1.2] },
    });
    hotspots.register('prompt-injection', {
      object: threat.mesh,
      anchor: polar(R_GUARD, TOOLS[T_BROWSER]!.phi, GATE.cy),
      onHighlight: setHot('prompt-injection'),
      card: () => cardFor('prompt-injection', { swatch: css['c-neg'] ?? '' }),
      pose: { position: [4.4, 2.7, 5.2], target: [0, 0.6, 2.7] },
    });

    /* ───────── go ───────── */
    applyPalette(ctx.palette);
    applyEmphasis(true);
    startEpisode();
    callFlow.update(0);

    let spin = 0;
    return {
      update(dt, t) {
        // Motion off (reduced motion / paused): the static frame is drawn by showStatic() and the
        // hover tweens; doing nothing here lets the demand loop go idle.
        if (!ctx.animate) return;
        arcs.update(t);
        if (dt > 0) {
          spin += dt;
          core.wire.rotation.y = spin * 0.18;
          core.core.rotation.y = -spin * 0.08;
          core.brain.position.y = BRAIN_Y + 0.035 * Math.sin(spin * 1.1);
          pt += dt;
          let ph = ep.phases[pi]!;
          while (pt >= ph.dur) {
            pt -= ph.dur;
            if (pi + 1 >= ep.phases.length) enter(0);
            else enter(pi + 1);
            ph = ep.phases[pi]!;
          }
        }
        render();
      },
      setStep(i) {
        if (STEP_POSES[i] === undefined && i !== 0) return;
        // Pose first: under reduced motion it is a cut, so the static frame below is laid out
        // (callout sides) for the step's own camera.
        showPose(i);
        startEpisode();
        applyEmphasis();
      },
      onMotion(animate) {
        if (!animate) {
          core.brain.position.y = BRAIN_Y;
          showStatic();
        } else render();
      },
      onPalette(p) {
        applyPalette(p);
        render();
      },
      onResize(size) {
        const next = size.portrait;
        const nextCompact = next || size.width < COMPACT_W;
        const nextStack = next || (nextCompact && size.aspect < 1.6);
        if (next !== portrait || nextCompact !== compact || nextStack !== stackTray) {
          const shape = next !== portrait;
          portrait = next;
          compact = nextCompact;
          stackTray = nextStack;
          layoutLabels();
          // The host re-applies the home pose on a shape change; keep the step's framing instead.
          if (shape && ctx.step > 0) showPose(ctx.step, { duration: 0 });
        }
        render();
      },
      dispose() {
        dimTween?.cancel();
        hotTweens.forEach((tw) => tw.cancel());
        root.removeFromParent();
      },
    };
  },
});

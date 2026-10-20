/**
 * agent-loop layout: constants, tool specs, polar helpers and the tool-call arcs.
 *
 * Coordinates: y up, the default camera looks from +z. Azimuth φ (degrees) is measured from +z
 * toward +x, so polar(r, 0) is the front centre and polar(r, 90) the right side.
 *
 *   r = 0      LLM 大腦 on a pedestal; the MCP 用戶端 collar rings the pedestal top
 *   r = 1.6    the loop track with four stations (規劃 → 行動 → 觀察 → 記憶) on the diagonals
 *   r = 2.2    長期記憶庫 (left side, between ④ 記憶 and ① 規劃, inside the guardrail)
 *   r = 2.85   權限與防護欄: a low glass band with one checkpoint ring per MCP server; every
 *              tool call and every result passes through its ring
 *   r ≈ 4      five MCP servers (none at the back centre, which the context tray covers)
 *   above      上下文視窗 (context window) tray floating over the brain
 */
import { Vector3 } from 'three';

export const DEG = Math.PI / 180;

export const R_TRACK = 1.6;
export const R_GUARD = 2.85;
export const R_SERVER = 4.05;
/** Servers sit on an ellipse: closer at the front, farther apart at the back (keeps the tray clear). */
export const serverR = (phiDeg: number): number => R_SERVER - 0.35 * Math.cos(phiDeg * DEG);
export const R_COLLAR = 0.66;
export const R_FLOOR = 5.5;
export const BRAIN_Y = 1.34;
export const BRAIN_R = 0.42;
export const SHELL_R = 0.58;
export const COLLAR_Y = 0.44;
export const GUARD_H = 0.3;
/**
 * Checkpoint ring on the guardrail: a vertical ring of radius `r` centred at height `cy`, facing
 * the radial direction, on a slim post that stands on the band. Calls cross it at `cy + 0.18`,
 * results at `cy - 0.19` (both inside the ring).
 */
export const GATE = { r: 0.3, tube: 0.026, cy: 0.74 } as const;
export const Y_CALL = GATE.cy + 0.18;
export const Y_RESULT = GATE.cy - 0.19;
export const SERVER = { w: 0.64, h: 0.74, d: 0.5, padY: 0.06 } as const;
export const SERVER_TOP = SERVER.padY + SERVER.h;
export const MEMORY_PHI = -92;
export const MEMORY_R = 2.12;
export const TRAY = { y: 2.9, z: -0.18, slots: 18, pitch: 0.172, block: 0.15 } as const;
/** Portrait stages: the tray floats higher, in the band above the diorama (clear of the back servers). */
export const TRAY_Y_PORTRAIT = 4.4;
export const TRAY_W = TRAY.slots * TRAY.pitch;

/** Loop stations, in loop order. Station i sits at φ = -135 - 90·i. */
export const STATIONS = [
  { id: 'plan', name: '規劃', num: '①', verb: '決定下一步' },
  { id: 'act', name: '行動', num: '②', verb: '呼叫工具' },
  { id: 'observe', name: '觀察', num: '③', verb: '讀取結果' },
  { id: 'memory', name: '記憶', num: '④', verb: '更新上下文' },
] as const;
export const stationPhi = (i: number): number => -135 - 90 * i;

export interface ToolSpec {
  id: string;
  name: string;
  /** Short 3D label. */
  short: string;
  /** Illustrative tool name exposed by the MCP server. */
  fn: string;
  phi: number;
  thought: string;
  result: string;
  /** High-risk tool: needs human approval in the 權限防護 step. */
  risky: boolean;
}

/** Index order is the order the overview task uses them. */
export const TOOLS: readonly ToolSpec[] = [
  { id: 'tool-search', name: '搜尋', short: '搜尋', fn: 'web_search', phi: 216, thought: '先搜尋相關資料', result: '搜尋結果清單', risky: false },
  { id: 'tool-browser', name: '瀏覽器／電腦操作', short: '瀏覽器／電腦操作', fn: 'browser_open', phi: 0, thought: '打開最相關的網頁', result: '網頁內容', risky: false },
  { id: 'tool-code', name: '程式執行', short: '程式執行', fn: 'run_code', phi: 144, thought: '寫程式整理資料', result: '計算結果', risky: true },
  { id: 'tool-database', name: '資料庫', short: '資料庫', fn: 'sql_query', phi: 72, thought: '查詢內部資料庫', result: '查詢結果', risky: false },
  { id: 'tool-files', name: '檔案系統', short: '檔案系統', fn: 'write_file', phi: 288, thought: '把報告寫成檔案', result: '檔案已儲存', risky: true },
];
export const T_SEARCH = 0;
export const T_BROWSER = 1;
export const T_CODE = 2;
export const T_DATABASE = 3;
export const T_FILES = 4;

export function polar(r: number, phiDeg: number, y = 0, out = new Vector3()): Vector3 {
  const a = phiDeg * DEG;
  return out.set(r * Math.sin(a), y, r * Math.cos(a));
}

/** Unit tangent at φ (direction of increasing φ). */
export function tangent(phiDeg: number, out = new Vector3()): Vector3 {
  const a = phiDeg * DEG;
  return out.set(Math.cos(a), 0, -Math.sin(a));
}

/* ───────────── arcs (same quadratic Bézier as kit/ArcRibbons 'planar') ───────────── */

export interface ArcSpec {
  start: Vector3;
  end: Vector3;
  height: number;
  /** Bézier parameter where the arc crosses the guardrail radius. */
  tc: number;
}

const mid = new Vector3();
export function arcPoint(a: ArcSpec, t: number, out = new Vector3()): Vector3 {
  mid.addVectors(a.start, a.end).multiplyScalar(0.5);
  mid.y += a.height * 2;
  const u = 1 - t;
  return out.set(
    u * u * a.start.x + 2 * t * u * mid.x + t * t * a.end.x,
    u * u * a.start.y + 2 * t * u * mid.y + t * t * a.end.y,
    u * u * a.start.z + 2 * t * u * mid.z + t * t * a.end.z,
  );
}

/** Build an arc from `start` to `end` whose height is chosen so it crosses r = R_GUARD at `yCross`. */
export function makeArc(start: Vector3, end: Vector3, yCross: number): ArcSpec {
  const flat: ArcSpec = { start, end, height: 0, tc: 0.5 };
  const p = new Vector3();
  const radial = (t: number) => {
    arcPoint(flat, t, p);
    return Math.hypot(p.x, p.z) - R_GUARD;
  };
  let lo = 0;
  let hi = 1;
  const sLo = Math.sign(radial(0));
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (Math.sign(radial(m)) === sLo) lo = m;
    else hi = m;
  }
  const tc = (lo + hi) / 2;
  const base = arcPoint(flat, tc, p).y;
  const height = (yCross - base) / (4 * tc * (1 - tc));
  return { start, end, height, tc };
}

/** Polyline samples of an arc (for PathFlow, smooth: false). */
export function arcSamples(a: ArcSpec, n = 40): Vector3[] {
  return Array.from({ length: n + 1 }, (_, i) => arcPoint(a, i / n));
}

export function polylineLength(pts: readonly Vector3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i]!.distanceTo(pts[i - 1]!);
  return l;
}

export function outArc(tool: ToolSpec): ArcSpec {
  const t = tangent(tool.phi).multiplyScalar(-0.1);
  return makeArc(polar(R_COLLAR + 0.03, tool.phi, COLLAR_Y).add(t), polar(serverR(tool.phi) - 0.3, tool.phi, 0.6).add(t), Y_CALL);
}

export function returnArc(tool: ToolSpec): ArcSpec {
  const t = tangent(tool.phi).multiplyScalar(0.11);
  return makeArc(polar(serverR(tool.phi) - 0.3, tool.phi, 0.34).add(t), polar(R_COLLAR + 0.03, tool.phi, COLLAR_Y - 0.06).add(t), Y_RESULT);
}

/* ───────────── easing ───────────── */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (k: number): number => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
/** 0 → 1 → 0 bump over [a, b]. */
export const bump = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return Math.sin(Math.PI * t);
};

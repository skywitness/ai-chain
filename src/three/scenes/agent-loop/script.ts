/**
 * agent-loop choreography: one illustrative "episode" (a task the agent works through) per guided
 * step. An episode is a list of phases; each loop cycle is plan → act → exec → observe → memory
 * with one tool. The context window (上下文視窗) contents at any phase are a pure replay of the
 * phases before it, so reduced motion can jump straight to a representative frame (`still`).
 */
import { T_BROWSER, T_CODE, T_DATABASE, T_FILES, T_SEARCH } from './layout';

export type Kind = 'plan' | 'act' | 'exec' | 'observe' | 'memory' | 'compact' | 'done';
export type BlockType = 'system' | 'task' | 'call' | 'result' | 'recall' | 'summary';

/** Slots a block occupies in the context tray (illustrative: results are longer than calls). */
export const SLOTS: Readonly<Record<BlockType, number>> = { system: 1, task: 1, call: 1, result: 2, recall: 1, summary: 2 };

export const BLOCK_NAME: Readonly<Record<BlockType, string>> = {
  system: '系統提示',
  task: '任務',
  call: '工具呼叫',
  result: '工具結果',
  recall: '取回的記憶',
  summary: '摘要',
};

export interface Phase {
  kind: Kind;
  /** Tool index (layout TOOLS); ignored for 'compact' and 'done'. */
  tool: number;
  /** Seconds. */
  dur: number;
  /** act: the call waits at the gate for human approval. */
  approve?: true;
  /** observe: a prompt-injection packet rides back with the result and is blocked. */
  inject?: true;
  /** plan: first retrieve a note from long-term memory. */
  recall?: true;
  /** memory / compact: also write a note to long-term memory. */
  ltWrite?: true;
}

export interface Episode {
  phases: Phase[];
  initial: BlockType[];
  /** Reduced motion: [phase index, progress 0..1] of the representative frame. */
  still: readonly [number, number];
}

interface Timing {
  plan: number;
  act: number;
  exec: number;
  observe: number;
  memory: number;
}
const BASE: Timing = { plan: 1.5, act: 1.6, exec: 0.75, observe: 1.7, memory: 1.1 };

interface CycleOpts {
  approve?: true;
  inject?: true;
  recall?: true;
  ltWrite?: true;
}

function cycle(tool: number, tm: Timing = BASE, o: CycleOpts = {}): Phase[] {
  return [
    { kind: 'plan', tool, dur: tm.plan + (o.recall ? 1.3 : 0), ...(o.recall ? { recall: true as const } : {}) },
    { kind: 'act', tool, dur: tm.act + (o.approve ? 2.2 : 0), ...(o.approve ? { approve: true as const } : {}) },
    { kind: 'exec', tool, dur: tm.exec },
    { kind: 'observe', tool, dur: tm.observe + (o.inject ? 2.0 : 0), ...(o.inject ? { inject: true as const } : {}) },
    { kind: 'memory', tool, dur: tm.memory + (o.ltWrite ? 0.7 : 0), ...(o.ltWrite ? { ltWrite: true as const } : {}) },
  ];
}
const done = (dur = 2.6): Phase => ({ kind: 'done', tool: 0, dur });
const START: BlockType[] = ['system', 'task'];

export function episodeFor(step: number): Episode {
  switch (step) {
    case 1: {
      const tm = { ...BASE, plan: 2.5 };
      return { phases: [...cycle(T_SEARCH, tm), ...cycle(T_BROWSER, tm), done()], initial: START, still: [0, 0.72] };
    }
    case 2: {
      const tm = { plan: 0.8, act: 2.0, exec: 0.9, observe: 1.1, memory: 0.7 };
      return {
        phases: [T_SEARCH, T_CODE, T_DATABASE, T_BROWSER, T_FILES].flatMap((t) => cycle(t, tm)).concat(done(2)),
        initial: START,
        // The database call (a side server, clear of the context tray) nearly at its server.
        still: [11, 0.72],
      };
    }
    case 3: {
      const tm = { plan: 0.9, act: 1.2, exec: 0.6, observe: 2.5, memory: 1.7 };
      return { phases: [...cycle(T_SEARCH, tm), ...cycle(T_DATABASE, tm), done()], initial: START, still: [3, 0.62] };
    }
    case 4:
      return {
        phases: [
          ...cycle(T_SEARCH, BASE, { recall: true }),
          { kind: 'compact', tool: 0, dur: 2.8, ltWrite: true },
          ...cycle(T_DATABASE),
          done(),
        ],
        initial: [...START, 'call', 'result', 'call', 'result', 'call', 'result', 'call', 'result'],
        still: [5, 0.8],
      };
    case 5:
      return {
        phases: [...cycle(T_CODE, BASE, { approve: true }), ...cycle(T_SEARCH), ...cycle(T_FILES, BASE, { approve: true }), done()],
        initial: START,
        still: [1, 0.5],
      };
    case 6:
      return {
        phases: [...cycle(T_BROWSER, BASE, { inject: true }), ...cycle(T_SEARCH), done()],
        initial: START,
        // The red packet held at the checkpoint, ring red, the clean result still waiting.
        still: [3, 0.44],
      };
    default:
      return {
        phases: [
          ...cycle(T_SEARCH),
          ...cycle(T_BROWSER),
          ...cycle(T_CODE),
          ...cycle(T_DATABASE),
          ...cycle(T_FILES, BASE, { ltWrite: true }),
          done(),
        ],
        initial: START,
        // The database call (a side server, seen in profile) halfway out, context well filled.
        still: [16, 0.6],
      };
  }
}

/** Station (0 規劃, 1 行動, 2 觀察, 3 記憶) where the task token rests during a phase. */
export function stationOf(kind: Kind): number {
  switch (kind) {
    case 'act':
    case 'exec':
      return 1;
    case 'observe':
      return 2;
    case 'memory':
    case 'compact':
      return 3;
    default:
      return 0;
  }
}

/** Blocks a phase adds (or the compaction it performs), applied when the phase completes. */
export function applyOp(ep: Episode, i: number, blocks: BlockType[]): BlockType[] {
  const ph = ep.phases[i];
  if (!ph) return blocks;
  switch (ph.kind) {
    case 'plan': {
      const out = [...blocks];
      if (ph.recall) out.push('recall');
      if (ep.phases[i + 1]?.kind === 'act') out.push('call');
      return out;
    }
    case 'memory':
      return [...blocks, 'result'];
    case 'compact':
      return [...blocks.slice(0, 2), 'summary'];
    default:
      return blocks;
  }
}

/** Context contents at the START of phase i. */
export function blocksAt(ep: Episode, i: number): BlockType[] {
  let b = [...ep.initial];
  for (let j = 0; j < i; j++) b = applyOp(ep, j, b);
  return b;
}

export const slotsOf = (b: readonly BlockType[]): number => b.reduce((s, t) => s + SLOTS[t], 0);

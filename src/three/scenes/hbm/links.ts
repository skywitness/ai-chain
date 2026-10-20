/**
 * hbm scene — hotspot text, card links and cross-variant jumps shared by both variants.
 */
import json from './meta.json';
import type { SceneContext } from '../../core/types';

export interface HotspotText {
  id: string;
  label: string;
  detail?: string;
}

/** meta.json hotspot text by id (the cards repeat the HTML list's detail). */
export const HOTSPOT_TEXT: ReadonlyMap<string, HotspotText> = new Map(
  (json.hotspots as HotspotText[]).map((h) => [h.id, h] as const),
);

/** Card links (site-relative, without the base; cards pass them through ctx.href). */
export const LINKS: Readonly<Record<string, readonly [string, string]>> = {
  'hbm-stack': ['/chain/memory-storage/', '前往「記憶體與儲存」環節 →'],
  gpu: ['/chain/ai-accelerators/', '前往「AI 晶片與加速器」環節 →'],
  interposer: ['/glossary/#interposer', '名詞解釋：中介層 →'],
  'base-die': ['/glossary/#base-die', '名詞解釋：基底晶粒 →'],
  'dram-die': ['/learn/memory-and-hbm/', '延伸閱讀：記憶體牆與 HBM →'],
  tsv: ['/learn/hbm-deep/', '延伸閱讀：HBM 深入 →'],
  'micro-bump': ['/glossary/#hybrid-bonding', '名詞解釋：混合鍵合 →'],
  fill: ['/learn/hbm-deep/', '延伸閱讀：HBM 深入 →'],
  interface: ['/glossary/#hbm4', '名詞解釋：HBM4 →'],
  registers: ['/glossary/#memory-hierarchy', '名詞解釋：記憶體階層 →'],
  sram: ['/glossary/#sram', '名詞解釋：SRAM →'],
  ddr: ['/glossary/#lpddr', '名詞解釋：LPDDR →'],
  ssd: ['/glossary/#ssd', '名詞解釋：SSD →'],
  hdd: ['/glossary/#hdd', '名詞解釋：HDD →'],
};

/** Hierarchy-only hotspots (registered in the package variant as jumps to the tower). */
export const HIERARCHY_IDS = ['registers', 'sram', 'ddr', 'ssd', 'hdd'] as const;
/** Package-only hotspots → the guided step that shows them. */
export const STACK_PART_STEP: Readonly<Record<string, number>> = {
  gpu: 0,
  interposer: 0,
  'base-die': 1,
  'dram-die': 1,
  tsv: 2,
  'micro-bump': 2,
  fill: 3,
  interface: 4,
};

/** Ask the host to go to a guided step (public scene:command API on <ai-scene>). */
export function gotoStep(ctx: SceneContext, index: number): void {
  ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index } }));
}

/** A hotspot picked in one variant that the other variant should focus once it is mounted. */
const pendingFocus = new WeakMap<HTMLElement, { id: string; at: number }>();

/**
 * Register a hotspot that lives in the other variant: selecting it from the HTML list jumps to
 * the guided step that shows it (the host switches variant for that step), and the remounted
 * variant then focuses it (see resumeFocus).
 */
export function crossLink(ctx: SceneContext, id: string, stepIndex: number): void {
  ctx.hotspots.register(id, {
    onSelect: () => {
      pendingFocus.set(ctx.root, { id, at: performance.now() });
      gotoStep(ctx, stepIndex);
      return true;
    },
  });
}

/**
 * Call at the end of create(): if the reader picked one of this variant's hotspots while the
 * other variant was mounted, focus it (camera pose + card) right after the host applies the step.
 */
export function resumeFocus(ctx: SceneContext): void {
  const p = pendingFocus.get(ctx.root);
  pendingFocus.delete(ctx.root);
  if (!p || performance.now() - p.at > 10_000) return;
  ctx.root.addEventListener(
    'scene:step',
    () => ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'focus', id: p.id } })),
    { once: true, signal: ctx.signal },
  );
}

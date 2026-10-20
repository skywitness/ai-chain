/**
 * hbm — HBM 堆疊與頻寬 (variants: hbm, hierarchy).
 *
 *  - hbm (stack.ts): an AI package diorama — GPU + four HBM stacks on a silicon interposer. Guided
 *    steps open the front-right stack: 總覽 → 晶粒堆疊 (base die + 12/16 DRAM dies, exploded) →
 *    矽穿孔 (cross-section: TSVs, micro-bumps, data up/down the TSVs and across the interposer) →
 *    接合填充 (TC-NCF vs MR-MUF replay) → 介面加寬 (16 → 32 channels, 1,024 → 2,048 bits). An
 *    in-stage control toggles HBM3E / HBM4 and 12 / 16 layers.
 *  - hierarchy (hierarchy.ts): the memory-hierarchy tower (registers → SRAM → HBM → DDR/LPDDR →
 *    SSD → HDD) with capacity, latency and bandwidth on log scales (order-of-magnitude, 示意);
 *    steps 記憶體階層 → 記憶體牆.
 *
 * The variants share little geometry, so there is no setVariant(): the host remounts the scene.
 * Reduced motion: flows become static dotted streams, every step shows its final state.
 */
import json from './meta.json';
import { defineScene } from '../../core/types';
import { createHierarchyScene, HIER_CAMERA } from './hierarchy';
import { createStackScene, STACK_CAMERA } from './stack';

export default defineScene({
  json,
  meta: {
    camera: STACK_CAMERA,
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 80_000 },
    variants: {
      hierarchy: { camera: HIER_CAMERA },
    },
  },

  create(ctx) {
    return ctx.variant === 'hierarchy' ? createHierarchyScene(ctx) : createStackScene(ctx);
  },
});

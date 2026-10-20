/**
 * gpu-scale — 從晶片到超級機櫃 (variants: chip, die, rack).
 *
 *  - chip (chip.ts): a true-scale machine room. The guided tour zooms package → superchip board →
 *    compute tray → NVL72 rack → pod; each level lights its own flow (HBM traffic, NVLink-C2C,
 *    coolant, NVLink spine, scale-out optics).
 *  - rack (rack.ts): the NVL72-style rack exploded by function (power shelves, compute trays,
 *    NVLink switch trays, frame + slide rails, cable cartridges, busbar, manifolds, CDU + hoses),
 *    seen from the front and the back, with illustrative supplier roles (示意).
 *  - die (die.ts): a GPU compute die opened up: GPCs of SMs (4 Tensor Cores each), the central L2,
 *    HBM PHYs and stacks (DRAM slices on a base die, TSVs), NVLink SerDes and the die-to-die link.
 *
 * Variants share little geometry, so `setVariant` is omitted and the host remounts. Step 0 (總覽)
 * shows the current variant's overview; every other step names its variant. Reduced motion: no
 * ambient motion, static dotted flows, camera cuts, the exploded / lifted parts in final positions.
 * No industry figures: counts that are product structure (72 GPUs, 18 + 9 trays, 4 Tensor Cores per
 * SM) are drawn as built; illustrative quantities are labelled 「示意」 in text.
 */
import json from './meta.json';
import { defineScene } from '../../core/types';
import { buildChip, CHIP_CAMERA } from './chip';
import { buildDie, DIE_CAMERA } from './die';
import { buildRack, RACK_CAMERA } from './rack';

export default defineScene({
  json,
  meta: {
    camera: CHIP_CAMERA,
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 70, tris: 120_000 },
    variants: {
      die: { camera: DIE_CAMERA },
      rack: { camera: RACK_CAMERA },
    },
  },

  create(ctx) {
    if (ctx.variant === 'die') return buildDie(ctx);
    if (ctx.variant === 'rack') return buildRack(ctx);
    return buildChip(ctx);
  },
});

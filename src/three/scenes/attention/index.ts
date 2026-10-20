/**
 * attention — Transformer 注意力劇場 (variants: attention, layers, moe).
 *
 * A demo sentence 「台積電 為 輝達 生產 AI 晶片」 walks through a Transformer:
 *  - attention (attention.ts): tokens → embedding columns → Q/K/V columns; the focused token's
 *    attention weights are arcs (width = weight, causal mask dims later tokens); four heads fan
 *    out in their own colours; the KV-cache step moves cached K/V into a tray and generates one
 *    new token that only computes its own Q/K/V. Hover / tap a token to see its arcs.
 *  - layers (layers.ts): a stack of Transformer blocks — residual streams with ⊕ nodes, the
 *    attention slab (the only cross-token mixing), per-token FFN boxes, norms, and next-token
 *    probabilities at the top.
 *  - moe (moe.ts): a router sends every token to the top-2 of 8 experts; load bars go from
 *    unbalanced to balanced.
 *
 * Steps (由淺入深): 總覽 → 切成 Token → 嵌入向量 → Q、K、V → 注意力權重 → 多頭注意力 → 層層堆疊
 * (layers) → 混合專家 (moe) → KV 快取. Step 0 has no variant, so a page can embed any variant.
 * Variants share little geometry, so `setVariant` is omitted and the host remounts.
 * All numbers are illustrative (示意). Reduced motion: every step shows its final state.
 */
import json from './meta.json';
import { defineScene, type SceneContext } from '../../core/types';
import { ATTN_POSES, buildAttention } from './attention';
import { LAYER_POSES, buildLayers } from './layers';
import { MOE_POSES, buildMoe } from './moe';

const LIMITS = { fov: 36, minDistance: 4.5, maxDistance: 19, minPolar: 0.55, maxPolar: 1.62, minAzimuth: -1.15, maxAzimuth: 1.15 };

export default defineScene({
  json,
  meta: {
    camera: {
      ...ATTN_POSES['home']!,
      ...LIMITS,
      portrait: { position: [0.5, 4.45, 9.4], target: [0, 0.95, -0.2], fov: 40 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 120_000 },
    variants: {
      layers: {
        camera: {
          ...LAYER_POSES['home']!,
          ...LIMITS,
          maxDistance: 22,
          portrait: { position: [2.4, 5.4, 12.6], target: [0.3, 3.65, 0], fov: 40 },
        },
      },
      moe: {
        camera: {
          ...MOE_POSES['home']!,
          ...LIMITS,
          portrait: { position: [0.5, 6.0, 9.6], target: [0, 1.95, 0.1], fov: 40 },
        },
      },
    },
  },

  create(ctx: SceneContext) {
    const title = (i: number) => ctx.json.steps?.[i]?.title ?? '';
    if (ctx.variant === 'layers') return buildLayers(ctx, title);
    if (ctx.variant === 'moe') return buildMoe(ctx, title);
    return buildAttention(ctx, title);
  },
});

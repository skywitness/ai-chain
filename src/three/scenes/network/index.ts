/**
 * network — AI 網路與光通訊 (variants: scale-up, scale-out, cpo).
 *
 *  - scale-up  (scaleUp.ts): an NVLink domain inside one rack. Compute trays above and below,
 *    NVLink switch trays in the middle, a copper spine at the back wiring every GPU to every
 *    switch chip; dense GPU↔GPU packet streams vs sparse NIC streams leaving the rack.
 *  - scale-out (scaleOut.ts): servers → leaf → spine. Steps morph the fabric from top-of-rack
 *    leaves to a rail-optimised fabric (links recoloured by rail), play a ring All-Reduce
 *    (Reduce-Scatter → All-Gather) and an ECMP collision hotspot that adaptive routing clears.
 *  - cpo (cpo.ts): three bays — copper DAC, pluggable optics (DSP + laser at the front panel),
 *    co-packaged optics (optical engines around the switch ASIC, external laser source) — with
 *    electrical (flow colour) particles turning into optical (optic colour) particles where the
 *    E/O conversion happens, and power-per-bit bars (示意).
 *
 * Steps 由淺入深: 總覽 (any variant) → NVLink 網域 → 全互連 → 葉脊架構 → 軌道最佳化 → 壅塞熱點 →
 * 銅纜與光模組 → CPO 光引擎. Variants share little geometry, so `setVariant` is omitted and the
 * host remounts with the matching builder.
 *
 * The HTML hotspot list shows every hotspot. Hotspots of another variant are registered as
 * proxies: hovering shows their card, selecting switches variant and then focuses the hotspot.
 * Reduced motion: PathFlow streams become static dotted lines; choreographies (All-Reduce,
 * congestion) show their final state.
 */
import json from './meta.json';
import { defineScene } from '../../core/types';
import { hotspotCard, orbitPose, type Builder } from './common';
import { build as buildCpo } from './cpo';
import { build as buildScaleOut } from './scaleOut';
import { build as buildScaleUp } from './scaleUp';

const VARIANT_OF: Readonly<Record<string, string>> = {
  gpu: 'scale-up',
  'nvlink-switch': 'scale-up',
  'copper-spine': 'scale-up',
  nic: 'scale-up',
  'leaf-switch': 'scale-out',
  'spine-switch': 'scale-out',
  rail: 'scale-out',
  'all-reduce': 'scale-out',
  congestion: 'scale-out',
  dac: 'cpo',
  pluggable: 'cpo',
  'cpo-engine': 'cpo',
  'laser-source': 'cpo',
  'power-per-bit': 'cpo',
};
const VARIANT_NAME: Readonly<Record<string, string>> = {
  'scale-up': '機櫃內（Scale-up）',
  'scale-out': '機櫃之間（Scale-out）',
  cpo: '銅線、光模組與 CPO',
};

/** A hotspot picked in the list while another variant was showing: focus it after the remount. */
let pendingFocus: string | null = null;

/**
 * The three builders are bundled with the module (≈ 26 KB gzip in total) instead of lazily
 * imported per variant: a synchronous `create` leaves no window in which a step / variant command
 * can arrive while the instance is still being built.
 */
const BUILDERS: Readonly<Record<string, Builder>> = { 'scale-up': buildScaleUp, 'scale-out': buildScaleOut, cpo: buildCpo };

const UP = orbitPose([-1.45, 2.1, 0.4], 10.6, 44, 13);
const OUT = orbitPose([0, 1.95, 0.2], 12.0, 10, 17);
const CPO = orbitPose([0, 0.55, 0.35], 10.4, 6, 33);

export default defineScene({
  json,
  meta: {
    camera: {
      ...UP,
      fov: 36,
      minDistance: 3.5,
      maxDistance: 20,
      minPolar: 0.35,
      maxPolar: 1.62,
      portrait: orbitPose([-0.4, 2.2, -0.3], 11.6, 42, 12),
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 60, tris: 80_000 },
    variants: {
      'scale-out': {
        camera: { ...OUT, fov: 36, minDistance: 4, maxDistance: 24, minPolar: 0.3, maxPolar: 1.55, portrait: orbitPose([0, 1.9, 0], 12.6, 14, 24) },
      },
      cpo: {
        camera: { ...CPO, fov: 36, minDistance: 3, maxDistance: 20, minPolar: 0.2, maxPolar: 1.45, portrait: orbitPose([-0.75, 0.45, 0.3], 14.5, 4, 50) },
      },
    },
  },

  create(ctx) {
    const build = BUILDERS[ctx.variant] ?? buildScaleUp;
    const built = build(ctx);

    // Proxies for hotspots that belong to the other variants.
    for (const h of json.hotspots) {
      const v = VARIANT_OF[h.id];
      if (!v || v === ctx.variant) continue;
      ctx.hotspots.register(h.id, {
        anchor: built.anchor,
        card: () => hotspotCard(ctx, h.id, { subtitle: `切換到「${VARIANT_NAME[v] ?? v}」視圖查看` }),
        onSelect: () => {
          pendingFocus = h.id;
          ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'variant', variant: v } }));
          return true;
        },
      });
    }

    let timer = 0;
    const focus = pendingFocus;
    if (focus && VARIANT_OF[focus] === ctx.variant) {
      pendingFocus = null;
      // After the host has applied the step for the new variant (it may move the camera home).
      timer = window.setTimeout(() => {
        ctx.hotspots.focus(focus, 'list');
        ctx.hotspots.select(focus, 'list');
      }, 120);
    }

    return {
      ...built,
      dispose() {
        window.clearTimeout(timer);
        built.dispose?.();
      },
    };
  },
});

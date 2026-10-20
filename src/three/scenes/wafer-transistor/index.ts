/**
 * wafer-transistor — 從晶圓到電晶體 (variants: wafer, transistor, bspdn).
 *
 *  - wafer: a 300 mm wafer with a die grid, an ambient wafer-sort sweep (yield), then callout zooms
 *    into one die's floorplan (step 1) and into an exploded interconnect stack with transistors at
 *    the bottom (step 2). → wafer.ts
 *  - transistor: one device morphing planar → FinFET → GAA nanosheet → CFET, sliced at the gate so
 *    the cut face shows the gate wrapping 1 → 3 → 4 sides; carriers flow source → drain (steps 3–6;
 *    the overview cycles through all four). → transistor.ts
 *  - bspdn: front-side vs backside power delivery side by side; the power network slides to the
 *    back of the thinned wafer while signals stay on the front (step 7). → bspdn.ts
 *
 * The variants share little geometry, so `setVariant` is omitted and the host remounts. Hotspots of
 * the other variants are registered as stubs: choosing one in the HTML list switches variant and
 * then focuses it in the new mount. Reduced motion: every step shows its final state (no sweep, no
 * cycling, morphs and reveals are cuts, flows are static dotted streams).
 */
import { Group } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type HotspotSource, type SceneContext } from '../../core/types';
import { buildBspdn } from './bspdn';
import { STEP, studioEnvironment, type View } from './common';
import { buildTransistor } from './transistor';
import { buildWafer } from './wafer';

const OWN: Record<string, readonly string[]> = {
  wafer: ['wafer', 'die', 'yield', 'floorplan', 'feol', 'beol', 'bump'],
  transistor: ['gate', 'channel', 'source-drain', 'gate-dielectric'],
  bspdn: ['signal-wires', 'power-network', 'backside-contact', 'carrier-wafer'],
};

/** Hotspot chosen in the list while another variant was mounted (per <ai-scene> element). */
const pending = new WeakMap<HTMLElement, string>();

export default defineScene({
  json,
  meta: {
    camera: {
      position: [0.4, 6.4, 7.6],
      target: [0.3, -0.3, 0.3],
      fov: 36,
      minDistance: 2.2,
      maxDistance: 24,
      minPolar: 0.12,
      maxPolar: 1.42,
      portrait: { position: [0.3, 9.6, 8.6], target: [0.2, -0.5, 0.4] },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 80_000 },
    variants: {
      transistor: {
        camera: {
          // = the CFET pose in transistor.ts (the tallest architecture): the reset pose for every step
          position: [6.1, 4.26, 6.77],
          target: [0.52, 0.59, -0.38],
          fov: 30,
          minDistance: 3.5,
          maxDistance: 22,
          minPolar: 0.2,
          maxPolar: 1.5,
          portrait: { position: [8.48, 6.16, 9.19], target: [0.47, 0.61, -0.35] },
        },
      },
      bspdn: {
        camera: {
          position: [1.0, 2.0, 9.6],
          target: [0, 0.3, 0],
          fov: 34,
          minDistance: 4,
          maxDistance: 24,
          minPolar: 0.5,
          maxPolar: 1.62,
          minAzimuth: -1.1,
          maxAzimuth: 1.1,
          portrait: { position: [1.81, 4.4, 17.64], target: [-0.05, 1.27, -0.04] },
        },
      },
    },
  },

  create(ctx: SceneContext) {
    const root = new Group();
    root.name = 'wafer-transistor';
    ctx.scene.add(root);
    const lights = addStudioLights(ctx.scene, ctx.palette);
    // Soft reflections for metal / copper / the wafer on the mid and high tiers only (scenes3d.md A14).
    const env = ctx.quality === 'low' ? { apply() {}, dispose() {} } : studioEnvironment(ctx);

    const variant = ctx.variant in OWN ? ctx.variant : 'wafer';
    const view: View =
      variant === 'transistor'
        ? buildTransistor(ctx, root)
        : variant === 'bspdn'
          ? buildBspdn(ctx, root)
          : buildWafer(ctx, root);

    // Stubs for the other variants' hotspots: list / keyboard selection switches variant first.
    for (const [v, ids] of Object.entries(OWN)) {
      if (v === variant) continue;
      for (const id of ids)
        ctx.hotspots.register(id, {
          onSelect: (src: HotspotSource) => {
            if (src === 'pointer' || src === 'touch') return false;
            pending.set(ctx.root, id);
            ctx.root.dispatchEvent(
              new CustomEvent('scene:command', { detail: { type: 'variant', variant: v } }),
            );
            return true;
          },
        });
    }

    const stepOf = (i: number) => {
      const want = json.steps[i]?.variant;
      return want && want !== variant ? STEP.overview : i;
    };
    let timer = 0;
    const flushPending = () => {
      const id = pending.get(ctx.root);
      if (!id || !OWN[variant]?.includes(id)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (ctx.signal.aborted || pending.get(ctx.root) !== id) return;
        pending.delete(ctx.root);
        ctx.hotspots.focus(id, 'list');
        ctx.hotspots.select(id, 'list');
      }, 120);
    };

    return {
      update(dt, t) {
        view.update?.(dt, t);
      },
      setStep(i) {
        view.setStep(stepOf(i));
        flushPending();
      },
      onPalette(p) {
        lights.apply(p);
        env.apply(p);
        view.onPalette?.(p);
      },
      onMotion(animate) {
        view.onMotion?.(animate);
      },
      onQuality(_q, tier) {
        view.onQuality?.(tier.particles);
      },
      onResize(size) {
        view.onResize?.(size);
      },
      dispose() {
        window.clearTimeout(timer);
        view.dispose?.();
        root.removeFromParent();
        lights.group.removeFromParent();
        env.dispose();
      },
    };
  },
});

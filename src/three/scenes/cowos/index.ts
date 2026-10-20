/**
 * cowos — CoWoS 先進封裝拆解 (variants: cowos, soic).
 *
 * `cowos` (package.ts): a generic AI-accelerator package as an exploded technical diorama —
 * ABF substrate + BGA → C4 bumps → interposer (CoWoS-S silicon with TSVs | CoWoS-L organic RDL
 * with LSI bridges) → micro-bumps → 2 reticle-sized GPU dies + 8 HBM stacks. An in-stage panel
 * drives the explode (0–100%) and the S/L toggle. Data flows GPU ⇄ HBM on the interposer, power
 * rises through the stack.
 * `soic` (soic.ts): micro-bump joint vs SoIC hybrid bonding side by side, pitch P vs P/4.
 *
 * Steps (由淺入深): 總覽 → 逐層拆解 → 中介層 → HBM 堆疊 → 光罩極限 → CoWoS-L (cowos) → 混合鍵合 →
 * 接合之後 (soic). Step 0 names no variant, so a page embedding `variant="soic"` keeps it.
 * Variants share little geometry, so the module omits setVariant and the host remounts.
 * Reduced motion: flows become static dotted streams, step transitions are cuts, nothing explodes
 * on its own (the slider drives the view).
 */
import json from './meta.json';
import { defineScene } from '../../core/types';
import { buildPackage } from './package';
import { buildSoic } from './soic';

export default defineScene({
  json,
  meta: {
    camera: {
      position: [6.0, 7.2, 12.6],
      target: [0.35, 0.7, 0.75],
      fov: 34,
      minDistance: 4.5,
      maxDistance: 24,
      minPolar: 0.12,
      maxPolar: 1.42,
      // Portrait: seen from the +X side (package.ts turns every step pose the same way), so the
      // package's long side runs up the screen.
      portrait: { position: [12.6, 11.35, -1.95], target: [0.35, 0.9, 0.2], fov: 38 },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 60, tris: 220_000 },
    variants: {
      soic: {
        camera: {
          // A higher three-quarter view than the package: the pad arrays on the die faces are the subject.
          position: [0, 5.75, 8.55],
          target: [0, 0.62, 0.25],
          fov: 34,
          minDistance: 3.5,
          maxDistance: 18,
          minPolar: 0.15,
          maxPolar: 1.45,
          // Portrait: the two demonstrators sit front (SoIC) and back (micro-bumps); the target leans to
          // the front one so its caption clears the control panel.
          portrait: { position: [0.78, 7.55, 9.7], target: [0, 0.6, 0.8], fov: 38 },
        },
      },
    },
  },

  create(ctx) {
    return ctx.variant === 'soic' ? buildSoic(ctx) : buildPackage(ctx);
  },
});

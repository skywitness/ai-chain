/**
 * datacenter — AI 資料中心剖面 (variants: overview, liquid, power-chain).
 *
 *  - overview: a cutaway AI data hall (rack rows, cold aisles, contained hot aisles, fan wall,
 *    row-end CDUs, overhead busways) with the electrical room, cooling plant and outdoor yard.
 *  - liquid: three lanes side by side — air (raised floor + CRAH + chiller), direct-to-chip
 *    (cold plates → manifold → CDU → facility water) and immersion — each ending at a cooling
 *    tower; illustrative PUE bars in front.
 *  - power-chain: grid → substation → MV switchgear → transformer → UPS → busway → rack PSU →
 *    VRM → GPU (AC lane) and the 800 V DC lane; energy particles thin out and conversion losses
 *    rise as heat. On portrait stages the chain is turned to run top → bottom.
 *
 * Steps (由淺入深): 總覽 → 冷熱通道 → 電力與冷卻 → 三種散熱 → 液冷迴路 → PUE → 供電鏈 → 800V 直流.
 * Each variant is a separate build (the host remounts on variant change). Static parts are merged
 * per zone and material (kit.ts); guided steps dim zones, toggle flows and label groups.
 * Reduced motion: flows become static dotted streams, fans stop, camera moves are cuts.
 */
import { Vector3 } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose, type SceneContext } from '../../core/types';
import { Kit, type View } from './kit';
import { overview } from './overview';
import { liquid } from './liquid';
import { powerChain } from './power';

export interface VariantBuild {
  view(step: number, portrait: boolean): View;
  /** Orientation change (power-chain turns its layout); return true if hotspots must re-register. */
  layout?(portrait: boolean): boolean;
  update?(dt: number, t: number): void;
}

const CAM = {
  overview: {
    position: [8.48, 14.65, 13.61],
    target: [-0.67, 0.3, -1.37],
    fov: 34,
    portrait: { position: [5.94, 17.74, 12.51], target: [-0.37, 0.3, -2.04], fov: 40 },
  },
  liquid: {
    position: [7.0, 9.0, 15.1],
    target: [-0.1, 0.35, 0.55],
    fov: 34,
    portrait: { position: [-0.75, 17.75, 14.05], target: [0.3, 0.3, 0.35], fov: 40 },
  },
  'power-chain': {
    position: [8.3, 10.7, 13.9],
    target: [0.5, 0.7, 0.3],
    fov: 34,
    portrait: { position: [-5.4, 22.35, 14.65], target: [0.0, 0.6, 0.4], fov: 40 },
  },
} satisfies Record<string, CameraPose & { portrait: CameraPose }>;

const limits = { minDistance: 4, maxDistance: 34, minPolar: 0.25, maxPolar: 1.38 };
/** Phones (and other narrow stages): fewer, shorter labels per step (see Kit.compact). */
const isCompact = (size: { width: number }) => size.width > 0 && size.width < 640;

export default defineScene({
  json,
  meta: {
    camera: { ...CAM.overview, ...limits },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 64, tris: 50_000 },
    variants: {
      liquid: { camera: { ...CAM.liquid, ...limits } },
      'power-chain': { camera: { ...CAM['power-chain'], ...limits } },
    },
  },

  create(ctx: SceneContext) {
    const lights = addStudioLights(ctx.scene, ctx.palette);
    const kit = new Kit(ctx);
    kit.compact = isCompact(ctx.size);
    const v: VariantBuild = ctx.variant === 'liquid' ? liquid(kit, ctx.size.portrait) : ctx.variant === 'power-chain' ? powerChain(kit, ctx.size.portrait) : overview(kit);
    kit.palette(ctx.palette);

    let portrait = ctx.size.portrait;
    const register = () =>
      kit.registerHotspots((_id, c, size) => {
        const h = ctx.homePose;
        const dir = new Vector3(...(h.position as [number, number, number])).sub(new Vector3(...(h.target as [number, number, number]))).normalize();
        const dist = Math.min(11, Math.max(4.2, size * 1.45 + 2.6));
        const p = c.clone().addScaledVector(dir, dist);
        return { position: [p.x, p.y, p.z], target: [c.x, c.y, c.z] };
      });
    register();

    const show = (step: number, pose = true) => kit.apply(v.view(step, portrait), pose);

    return {
      update(dt, t) {
        kit.update(dt, t);
        v.update?.(dt, t);
      },
      setStep(i) {
        show(i);
      },
      onPalette(p) {
        lights.apply(p);
        kit.palette(p);
      },
      onMotion(animate) {
        kit.motion(animate);
      },
      onQuality(_q, tier) {
        kit.quality(tier);
      },
      onResize(size) {
        const compact = isCompact(size);
        if (size.portrait === portrait && compact === kit.compact) return;
        kit.compact = compact;
        // An orientation flip turns the liquid / power-chain layouts and the host has just reset
        // the camera to the home pose: re-frame the current step for the new stage shape.
        const flip = size.portrait !== portrait;
        if (flip) {
          portrait = size.portrait;
          if (v.layout?.(portrait)) register();
        }
        show(ctx.step, flip);
      },
      dispose() {
        kit.dispose();
        lights.group.removeFromParent();
      },
    };
  },
});

/**
 * physical-ai — 實體 AI：感知→模型→動作 (variants: robot, autonomy).
 *
 * robot (robot.ts + rig.ts): a procedural humanoid at a table picks a cube and places it in a tray
 * from a language instruction. Sensors (stereo head cameras, wrist camera, 6-axis F/T sensor,
 * fingertip tactile pads, joint encoders) stream into a floating VLA tower (image / language /
 * state tokens → Transformer → action chunk); the action chunk streams to the arm joints. The
 * sim-to-real step shows a mirrored, translucent simulation twin with parallel environments whose
 * colours are randomised every cycle.
 *
 * autonomy (autonomy.ts + lidar.ts): a stylised street. A roof LiDAR sweeps a point cloud that is
 * ray-cast once against the street's primitives; camera frustums and a radar fan show the other
 * sensors; detected objects get class-coloured 3D boxes; dashed lines are predicted motions and a
 * pink ribbon is the planned lane change (waypoints closer together = slower). The end-to-end card
 * shows a modular stack (感知→預測→規劃→控制) collapsing into one network.
 *
 * Steps: 總覽 · 感知 · VLA 模型 · 致動與控制 · 模擬到現實 (robot) · 自駕感知 · 預測與規劃 ·
 * 端到端模型 (autonomy). The variants share little geometry, so `setVariant` is omitted and the
 * host re-creates the scene; each variant's code is its own chunk (both prefetched, see below).
 * Reduced motion: a representative static moment per step, frozen streams, the full static cloud.
 */
import json from './meta.json';
import { defineScene } from '../../core/types';

/**
 * Each variant is its own chunk, but both start loading as soon as this module is evaluated: a
 * variant switch re-creates the scene, and an import still in flight at that moment would leave
 * the stage empty (background only) until it resolves.
 */
let robotP: Promise<typeof import('./robot')> | null = null;
let autonomyP: Promise<typeof import('./autonomy')> | null = null;
const robotMod = () => (robotP ??= import('./robot'));
const autonomyMod = () => (autonomyP ??= import('./autonomy'));
void robotMod().catch(() => (robotP = null));
void autonomyMod().catch(() => (autonomyP = null));

export default defineScene({
  json,
  meta: {
    camera: {
      position: [1.0, 1.8, 4.1],
      target: [0.0, 0.92, 0.0],
      fov: 36,
      minDistance: 1.6,
      maxDistance: 11,
      minPolar: 0.35,
      maxPolar: 1.52,
      minAzimuth: -1.25,
      maxAzimuth: 1.25,
      portrait: { position: [1.4, 2.32, 4.9], target: [0.4, 1.55, 0] },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 70, tris: 150_000 },
    variants: {
      autonomy: {
        camera: {
          position: [22.8, 19.8, 15.3],
          target: [0.3, 1.8, -10.5],
          fov: 34,
          minDistance: 9,
          maxDistance: 60,
          minPolar: 0.15,
          maxPolar: 1.36,
          minAzimuth: -0.7,
          maxAzimuth: 2.1,
          portrait: { position: [13, 30, 18], target: [0.4, 1.5, -12.5], fov: 40 },
        },
      },
    },
  },

  async create(ctx) {
    const mod = await (ctx.variant === 'autonomy' ? autonomyMod() : robotMod());
    return mod.create(ctx);
  },
});

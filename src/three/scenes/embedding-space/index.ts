/**
 * embedding-space — 嵌入向量空間 (variants: semantic, rag).
 *
 * semantic: 118 zh-TW words placed by an illustrative 16-D embedding (space.ts), drawn by their
 *   first three dims. Clusters (晶片, 記憶體, 國家, 城市, 人物, 情緒, 動物, 食物) glow softly; hover
 *   or tap a word for its 4 nearest neighbours (real cosine similarity on the illustrative
 *   vectors). Steps add a camera-locked panel with a word's 16 numbers (貓 kept as reference
 *   ticks), a close-up of neighbour links, and vector arithmetic drawn as parallelograms
 *   (國王 − 男人 + 女人 ≈ 女王, 東京 − 日本 + 台灣 ≈ 台北).
 * rag: question card / 嵌入模型 / documents → 向量資料庫 (48 chunk cards); the question becomes a
 *   query vector (dashed route), a search sphere picks the top-4 chunks, which are copied into the
 *   上下文視窗 feeding the LLM, which writes an answer citing #1–#4.
 *
 * Both variants are built once and switched in place (setVariant). Step 0 總覽 works in either
 * variant; steps 1–3 force semantic, 4–6 force rag. Portrait stages rotate the word space and
 * stack the RAG pipeline in three rows. Reduced motion: every step shows its final state.
 */
import { Group, LineBasicMaterial, LineSegments } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose, type QualityTier, type SceneContext } from '../../core/types';
import { command, floorGrid, type View, type ViewApi } from './common';
import { createRag } from './rag';
import { createSemantic } from './semantic';

const HOME: Record<'semantic' | 'rag', CameraPose & { portrait: CameraPose }> = {
  semantic: {
    position: [1.0, 2.8, 11.7],
    target: [-0.1, 0.25, 0],
    portrait: { position: [0.3, 2.5, 14.0], target: [-0.05, -0.05, 0], fov: 44 },
  },
  rag: {
    position: [0.75, 2.7, 12.3],
    target: [0.45, 0.3, 0],
    portrait: { position: [0.4, 2.2, 14.3], target: [0.1, 0.4, 0], fov: 44 },
  },
};
const LABELS = { semantic: 40, rag: 34 };
const LABELS_COMPACT = { semantic: 22, rag: 24 };
const COMPACT_W = 600;

export default defineScene({
  json,
  meta: {
    camera: {
      ...HOME.semantic,
      fov: 36,
      minDistance: 5,
      maxDistance: 24,
      minPolar: 0.3,
      maxPolar: 1.8,
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 36, tris: 50_000 },
    variants: {
      rag: {
        camera: {
          ...HOME.rag,
          fov: 36,
          minDistance: 5,
          maxDistance: 24,
          minPolar: 0.55,
          maxPolar: 1.75,
          minAzimuth: -1.05,
          maxAzimuth: 1.05,
        },
      },
    },
  },

  create(ctx: SceneContext) {
    const root = new Group();
    root.name = 'embedding-space';
    ctx.scene.add(root);
    const lights = addStudioLights(ctx.scene, ctx.palette);

    /* ───────── floor: faded grid ───────── */
    const grid = floorGrid(8.5, 0.85);
    const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const floor = new LineSegments(ctx.track(grid.geometry), gridMat);
    floor.renderOrder = -1;
    root.add(floor);

    /* ───────── views ───────── */
    let variant = ctx.variant === 'rag' ? 'rag' : 'semantic';
    const api: ViewApi = {
      goStep: (index) => command(ctx, { type: 'step', index }),
      goVariant: (v) => command(ctx, { type: 'variant', variant: v }),
      get active() {
        return variant;
      },
    };
    const views: Record<'semantic' | 'rag', View> = {
      semantic: createSemantic(ctx, root, api),
      rag: createRag(ctx, root, api),
    };
    const view = () => views[variant === 'rag' ? 'rag' : 'semantic'];
    let portrait = ctx.size.aspect < 0.9;
    let compact = ctx.size.width < COMPACT_W;
    let tier: QualityTier = ctx.tier;
    views.semantic.compact(compact);
    views.rag.compact(compact);

    const activate = () => {
      views.semantic.setActive(variant === 'semantic');
      views.rag.setActive(variant === 'rag');
      floor.position.y = view().floorY;
      ctx.labels.setMax(Math.min(tier.maxLabels, (compact ? LABELS_COMPACT : LABELS)[variant === 'rag' ? 'rag' : 'semantic']));
    };
    const recolorFloor = () => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.1 : 0.05), dark ? 0.6 : 0.8);
    };
    const goTo = (step: number) => {
      view().start(step);
      ctx.setPose(view().pose(step) ?? ctx.homePose);
    };
    recolorFloor();
    activate();

    return {
      update(dt, t) {
        view().update(dt, t);
      },
      setStep(i) {
        goTo(i);
      },
      setVariant(v) {
        variant = v === 'rag' ? 'rag' : 'semantic';
        activate();
        goTo(ctx.step);
        return true;
      },
      onPalette(p) {
        lights.apply(p);
        recolorFloor();
        views.semantic.palette(p);
        views.rag.palette(p);
      },
      onQuality(_q, t) {
        tier = t;
        views.semantic.quality(t);
        views.rag.quality(t);
        activate();
      },
      onMotion(animate) {
        views.semantic.motion(animate);
        views.rag.motion(animate);
      },
      onResize(size) {
        const c = size.width < COMPACT_W;
        const next = size.aspect < 0.9;
        if (c === compact && next === portrait) return;
        if (c !== compact) {
          compact = c;
          views.semantic.compact(c);
          views.rag.compact(c);
        }
        if (next !== portrait) {
          portrait = next;
          views.semantic.layout(portrait);
          views.rag.layout(portrait);
        }
        activate();
        // Step poses depend on the stage shape: restart the step and refit its camera (step 0
        // keeps the host's own home-pose handling, which respects a reader who has orbited).
        view().start(ctx.step);
        const pose = view().pose(ctx.step);
        if (pose) ctx.setPose(pose);
      },
      dispose() {
        root.removeFromParent();
      },
    };
  },
});

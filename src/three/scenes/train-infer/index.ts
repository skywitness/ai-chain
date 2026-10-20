/**
 * train-infer — 訓練與推論：算力的兩種用法 (variants: training, inference, pipeline).
 *
 * One "AI factory" table with three dioramas side by side; a variant is the diorama in view and
 * switching variants (or guided steps) flies the camera from one to the next (in place, no remount):
 *  - training  (training.ts): data-parallel training on a ring of 8 GPUs — micro-batches, forward
 *    and backward passes through 4-layer model replicas, ring all-reduce (reduce-scatter +
 *    all-gather, 14 hops), identical weight updates and a falling loss curve (示意).
 *  - inference (inference.ts): a continuous-batching simulation — users, request queue,
 *    scheduler, prefill (compute-bound) vs decode (bandwidth-bound) iterations, a KV cache that
 *    grows one cell per token in HBM, and tokens streaming back to their users.
 *  - pipeline  (pipeline.ts): the closed-loop conveyor data → filter → dedupe → tokenize →
 *    pretrain → post-train (SFT/RLHF) → eval → deploy → feedback & monitoring.
 *
 * Steps 由淺入深: 總覽 → 訓練迴圈 → 梯度同步 → 批次推論 → 預填與解碼 → KV 快取 → 資料處理 → 訓練到部署.
 * Reduced motion: no flows or simulation; every step shows a fully populated still (static dotted
 * streams, a frozen mid-decode batch, a complete loss curve) and camera moves become cuts.
 * Only the zone in view is rendered (the other two are hidden once the camera arrives).
 */
import { Group, Vector3 } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose, type CardContent, type SceneContext, type Tween } from '../../core/types';
import type { V3, Zone, ZoneEnv, ZoneId } from './common';
import { buildInference } from './inference';
import { buildPipeline } from './pipeline';
import { buildTraining } from './training';

const ZONES: readonly ZoneId[] = ['training', 'inference', 'pipeline'];
const ZONE_NAME: Record<ZoneId, string> = { training: '訓練', inference: '推論', pipeline: '流程' };
const ORIGIN: Record<ZoneId, V3> = { training: [-18, 0, 0], inference: [0, 0, 0], pipeline: [18, 0, 0] };
const at = (z: ZoneId, p: V3): V3 => [ORIGIN[z][0] + p[0], ORIGIN[z][1] + p[1], ORIGIN[z][2] + p[2]];
const pose = (z: ZoneId, position: V3, target: V3): CameraPose => ({ position: at(z, position), target: at(z, target) });

const HOME: Record<ZoneId, CameraPose> = {
  training: pose('training', [1.4, 6.1, 9.7], [0, 0.72, 0.05]),
  inference: pose('inference', [0.7, 6.4, 8.9], [-0.2, 0.72, 0.2]),
  pipeline: pose('pipeline', [0, 7.9, 7.3], [0, 0.05, 0.2]),
};
const PORTRAIT: Record<ZoneId, CameraPose> = {
  training: pose('training', [1.0, 9.9, 9.7], [0, 0.5, 0.6]),
  inference: pose('inference', [0.1, 8.6, 9.6], [-0.6, 0.8, 0.3]),
  pipeline: pose('pipeline', [0, 14.0, 8.2], [0, 0, 0.8]),
};

/** Card links (the hotspot list stays a list of buttons; the card carries the link). */
const LINKS: Record<string, [string, string]> = {
  'data-parallel': ['/glossary/#data-parallelism', '查看「資料平行」名詞解釋 →'],
  'model-replica': ['/glossary/#backpropagation', '查看「反向傳播」名詞解釋 →'],
  'all-reduce': ['/glossary/#all-reduce', '查看「All-Reduce」名詞解釋 →'],
  'loss-curve': ['/glossary/#loss-function', '查看「損失函數」名詞解釋 →'],
  'request-batching': ['/glossary/#batching', '查看「批次處理」名詞解釋 →'],
  'serving-gpu': ['/learn/training-vs-inference-economics/', '閱讀「訓練與推論的經濟學」→'],
  'prefill-decode': ['/learn/inference-optimization/', '閱讀「推論最佳化」→'],
  'kv-cache': ['/glossary/#kv-cache', '查看「KV Cache」名詞解釋 →'],
  'data-prep': ['/glossary/#training-data', '查看「訓練資料」名詞解釋 →'],
  pretraining: ['/learn/pretraining-to-chat/', '閱讀「從預訓練到對話助理」→'],
  'post-training': ['/glossary/#post-training', '查看「後訓練」名詞解釋 →'],
  evaluation: ['/glossary/#benchmark', '查看「基準測試」名詞解釋 →'],
  deployment: ['/chain/devtools-data-mlops/', '前往「開發工具與 MLOps」環節 →'],
};

export default defineScene({
  json,
  meta: {
    camera: {
      ...HOME.training,
      fov: 36,
      minPolar: 0.3,
      maxPolar: 1.36,
      minAzimuth: -1.15,
      maxAzimuth: 1.15,
      portrait: PORTRAIT.training,
    },
    controls: 'orbit',
    loop: 'continuous',
    // One zone ≈ 15–25 calls / 18–29k tris; during a flight two zones are drawn (≈ 47 / 50k).
    budget: { calls: 60, tris: 80_000 },
    variants: {
      inference: { camera: { ...HOME.inference, portrait: PORTRAIT.inference } },
      pipeline: { camera: { ...HOME.pipeline, portrait: PORTRAIT.pipeline } },
    },
  },

  create(ctx: SceneContext) {
    const root = new Group();
    root.name = 'train-infer';
    ctx.scene.add(root);
    const lights = addStudioLights(ctx.scene, ctx.palette);
    const text = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const isZone = (v: string): v is ZoneId => (ZONES as readonly string[]).includes(v);
    let active: ZoneId = isZone(ctx.variant) ? ctx.variant : 'training';

    /* ───────── hotspots: cross-zone selection ───────── */
    const hsPose = new Map<string, CameraPose>();
    let focusId: string | null = null; // fly to this hotspot instead of the step pose
    let pendingSelect: string | null = null; // select once the camera has arrived

    const withLink = (id: string, c: CardContent): CardContent => {
      const l = LINKS[id];
      return l ? { ...c, href: l[0], linkLabel: l[1] } : c;
    };
    const makeEnv = (zone: ZoneId): ZoneEnv => ({
      ctx,
      parent: root,
      origin: new Vector3(...ORIGIN[zone]),
      detail: (id) => text.get(id)?.detail ?? '',
      unfit: (p) => unfit(zone, p),
      register: (id, spec) => {
        if (spec.pose) hsPose.set(id, spec.pose);
        ctx.hotspots.register(id, {
          ...spec,
          card: (hit) => {
            const t = text.get(id);
            const base: CardContent = { title: t?.label ?? id, body: t?.detail ?? '' };
            if (zone !== active) return { ...base, body: `${base.body}（位於「${ZONE_NAME[zone]}」視角，點選即可前往。）` };
            return withLink(id, spec.card?.(hit) ?? base);
          },
          onSelect: (source) => {
            if (zone !== active) {
              focusId = id;
              pendingSelect = id;
              setTimeout(() => (focusId = null), 0);
              ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'variant', variant: zone } }));
              return true;
            }
            return spec.onSelect?.(source) ?? false;
          },
        });
      },
    });

    const dist = (p: CameraPose) => {
      const a = p.position as V3;
      const b = p.target as V3;
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    /** Undo the host's portrait distance scaling (it also applies to homePose) for an exact pose. */
    const unfit = (zone: ZoneId, p: CameraPose): CameraPose => {
      if (!ctx.size.portrait) return p;
      const k = dist(PORTRAIT[zone]) / dist(HOME[zone]);
      const a = p.position as V3;
      const b = p.target as V3;
      return { ...p, position: [b[0] + (a[0] - b[0]) / k, b[1] + (a[1] - b[1]) / k, b[2] + (a[2] - b[2]) / k] };
    };

    const zones: Record<ZoneId, Zone> = {
      training: buildTraining(makeEnv('training')),
      inference: buildInference(makeEnv('inference')),
      pipeline: buildPipeline(makeEnv('pipeline')),
    };
    for (const z of ZONES) {
      zones[z].setVisible(z === active);
      zones[z].onResize?.(ctx.size.portrait);
    }

    /* ───────── camera flights ───────── */
    let cam: Tween | null = null;
    const settle = () => {
      cam = null;
      for (const z of ZONES) if (z !== active) zones[z].setVisible(false);
      if (pendingSelect) {
        const id = pendingSelect;
        pendingSelect = null;
        ctx.hotspots.select(id, 'command');
      }
    };
    const fly = (p: CameraPose) => {
      cam?.cancel();
      const tgt = ctx.controls?.target;
      const t = p.target as V3;
      const d = tgt ? Math.hypot(tgt.x - t[0], tgt.y - t[1], tgt.z - t[2]) : 0;
      cam = ctx.setPose(p, { duration: 800 + Math.min(800, d * 40), onComplete: settle });
    };
    const targetPose = (step: number): CameraPose =>
      (focusId && hsPose.get(focusId)) || zones[active].pose(step) || unfit(active, ctx.size.portrait ? PORTRAIT[active] : HOME[active]);

    return {
      update(dt) {
        zones[active].update(dt);
      },
      setStep(i) {
        zones[active].start(i);
        fly(targetPose(i));
      },
      setVariant(v) {
        if (!isZone(v)) return false;
        // Only the zone we leave and the one we fly to are drawn during the flight.
        for (const z of ZONES) if (z !== active && z !== v) zones[z].setVisible(false);
        active = v;
        zones[v].setVisible(true);
        zones[v].start(ctx.step);
        fly(targetPose(ctx.step));
        return true;
      },
      onMotion(animate) {
        for (const z of ZONES) zones[z].setMotion(animate);
      },
      onPalette(p) {
        lights.apply(p);
        for (const z of ZONES) zones[z].onPalette(p);
      },
      onQuality(_q, tier) {
        for (const z of ZONES) zones[z].onQuality(tier);
      },
      onResize(size) {
        for (const z of ZONES) zones[z].onResize?.(size.portrait);
      },
      dispose() {
        cam?.cancel();
        root.removeFromParent();
      },
    };
  },
});

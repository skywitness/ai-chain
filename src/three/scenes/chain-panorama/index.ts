/**
 * chain-panorama — AI 產業鏈全景塔 (variants: hero, explore).
 *
 * Five stacked translucent layer slabs (foundation → applications) hold the 14 segment nodes,
 * coloured with --seg-*. PathFlow particles rise from energy to applications
 * (電力 → 晶圓 → 晶片 → 機櫃 → Token → 應用); physical AI is a side wing next to the top layer.
 * Hover a node: a card with the segment's top companies (from page data). Click: /chain/<id>/.
 *
 *  - hero: cinematic, slow auto-orbit, fewer labels.
 *  - explore: interactive, all segment labels, syncs with a page side panel through
 *    `scene:hotspot` events and `scene:command` { type: 'focus', id }.
 *
 * Data ('segments', docs/SCENES.md): { id, title, titleEn, layer, order, tagline, href,
 * companies: [{ id, name, nameZh }] }[]. Without data the fixture is used (「示意資料」 badge).
 */
import {
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  Vector3,
} from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { LAYER_IDS, SEGMENT_IDS } from '../../core/ids';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type LabelHandle,
  type LayerId,
  type Palette,
  type SceneContext,
  type SegmentId,
} from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
import { scaleCount } from '../../core/quality';

/* ───────────────────────── data ───────────────────────── */

export interface SegmentDatum {
  id: SegmentId;
  title: string;
  titleEn?: string;
  layer: LayerId;
  order?: number;
  tagline?: string;
  href?: string;
  companies?: { id: string; name: string; nameZh?: string }[];
}

function isSegments(d: unknown): d is SegmentDatum[] {
  return (
    Array.isArray(d) &&
    d.length > 0 &&
    d.every(
      (s) =>
        !!s &&
        typeof s === 'object' &&
        (SEGMENT_IDS as readonly string[]).includes((s as SegmentDatum).id) &&
        typeof (s as SegmentDatum).title === 'string' &&
        (LAYER_IDS as readonly string[]).includes((s as SegmentDatum).layer) &&
        ((s as SegmentDatum).companies === undefined || Array.isArray((s as SegmentDatum).companies)),
    )
  );
}

/* ───────────────────────── layout ───────────────────────── */

interface LayerSpec {
  id: LayerId;
  y: number;
  w: number;
  d: number;
  name: string;
  stage: string;
}
const LAYERS: readonly LayerSpec[] = [
  { id: 'foundation', y: 0, w: 8.4, d: 3.6, name: '能源基礎', stage: '電力' },
  { id: 'silicon', y: 1.8, w: 9.4, d: 3.2, name: '晶片與半導體', stage: '晶圓 → 晶片' },
  { id: 'systems', y: 3.6, w: 7.6, d: 2.9, name: '系統與機房', stage: '伺服器 → 機櫃' },
  { id: 'cloud-models', y: 5.4, w: 6.6, d: 2.7, name: '雲端與模型', stage: '算力 → Token' },
  { id: 'applications', y: 7.2, w: 3.2, d: 2.3, name: '應用', stage: '產品與服務' },
];
const WING = { x: 3.45, w: 2.3, d: 2.1 };
const SLAB_T = 0.14;
const NODE_H = 0.22;

/** Node position on its layer: [x, z] (camera looks from +z). */
const NODE_XZ: Record<SegmentId, [number, number]> = {
  'energy-power': [0, 0.15],
  'semi-equipment-materials': [-3.6, 0.42],
  'foundry-packaging': [-1.8, -0.42],
  'memory-storage': [0, 0.42],
  'eda-ip-design': [1.8, -0.42],
  'ai-accelerators': [3.6, 0.42],
  'networking-optics': [-2.5, 0.36],
  'servers-systems': [0, -0.36],
  'datacenter-infra': [2.5, 0.36],
  'cloud-neocloud': [-2.2, 0.34],
  'foundation-models': [0, -0.34],
  'devtools-data-mlops': [2.2, 0.34],
  'apps-agents': [0, 0.1],
  'physical-ai': [WING.x, 0.1],
};

/** Short 3D label names (the hotspot list and cards use the full titles). */
const SHORT: Record<SegmentId, string> = {
  'energy-power': '能源電力',
  'semi-equipment-materials': '設備材料',
  'foundry-packaging': '代工封裝',
  'memory-storage': '記憶體',
  'eda-ip-design': 'EDA・矽智財',
  'ai-accelerators': 'AI 晶片',
  'networking-optics': '網通光通訊',
  'servers-systems': '伺服器',
  'datacenter-infra': '資料中心',
  'cloud-neocloud': '雲端與新雲',
  'foundation-models': '基礎模型',
  'devtools-data-mlops': '開發工具',
  'apps-agents': '應用與 Agent',
  'physical-ai': '實體 AI',
};

const LAYER_OF: Record<SegmentId, LayerId> = {
  'energy-power': 'foundation',
  'semi-equipment-materials': 'silicon',
  'foundry-packaging': 'silicon',
  'memory-storage': 'silicon',
  'eda-ip-design': 'silicon',
  'ai-accelerators': 'silicon',
  'networking-optics': 'systems',
  'servers-systems': 'systems',
  'datacenter-infra': 'systems',
  'cloud-neocloud': 'cloud-models',
  'foundation-models': 'cloud-models',
  'devtools-data-mlops': 'cloud-models',
  'apps-agents': 'applications',
  'physical-ai': 'applications',
};

const STEP_FOCUS: readonly (readonly LayerId[])[] = [
  [],
  ['foundation', 'silicon'],
  ['systems'],
  ['cloud-models'],
  ['applications'],
];

const POSES: Record<'hero' | 'explore', CameraPose> = {
  hero: { position: [7.6, 7.9, 14.0], target: [0.45, 3.55, 0] },
  explore: { position: [6.9, 7.3, 13.6], target: [0.4, 3.6, 0] },
};
const STEP_POSES: readonly CameraPose[] = [
  POSES.explore,
  { position: [6.0, 5.0, 11.6], target: [0, 1.0, 0] },
  { position: [5.4, 6.6, 10.6], target: [0, 3.6, 0] },
  { position: [5.0, 8.2, 10.0], target: [0, 5.4, 0] },
  { position: [6.0, 9.8, 9.6], target: [1.5, 7.15, 0] },
];

function roundedRect(w: number, d: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

const layerY = (id: LayerId) => LAYERS.find((l) => l.id === id)!.y;
const nodePos = (id: SegmentId, out = new Vector3()) => {
  const [x, z] = NODE_XZ[id];
  return out.set(x, layerY(LAYER_OF[id]) + SLAB_T / 2 + NODE_H / 2, z);
};

/* ───────────────────────── scene ───────────────────────── */

export default defineScene<SegmentDatum[]>({
  json,
  meta: {
    camera: {
      ...POSES.hero,
      fov: 36,
      minDistance: 6,
      maxDistance: 24,
      minPolar: 0.45,
      maxPolar: 1.5,
      portrait: { position: [6.9, 11.2, 19.6], target: [0.6, 4.2, 0] },
    },
    controls: 'orbit',
    autoRotate: 0.45,
    loop: 'continuous',
    budget: { calls: 60, tris: 80_000 },
    variants: {
      explore: { camera: { ...POSES.explore, fov: 38, minDistance: 6, maxDistance: 24, minPolar: 0.45, maxPolar: 1.5 }, autoRotate: false },
    },
  },
  guard: isSegments,
  fixture: () => import('../../fixtures/chain-panorama.json'),

  create(ctx: SceneContext<SegmentDatum[]>) {
    const { scene, materials, labels, hotspots } = ctx;
    const root = new Group();
    root.name = 'chain-panorama';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const data = new Map<SegmentId, SegmentDatum>((ctx.data ?? []).map((s) => [s.id, s]));
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));
    const explore = () => ctx.variant === 'explore';

    /* ───────── floor: faded grid + soft contact glow ───────── */
    const grid = buildFloorGrid(10, 0.8);
    const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const gridLines = new LineSegments(ctx.track(grid.geometry), gridMat);
    gridLines.position.y = -0.42;
    root.add(gridLines);
    const shadowTex = ctx.track(radialTexture(256));
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = new Mesh(ctx.track(new PlaneGeometry(15, 9)), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.4;
    root.add(shadow);

    /* ───────── layer slabs ───────── */
    interface Slab {
      spec: LayerSpec;
      group: Group;
      fill: MeshStandardMaterial;
      edge: LineBasicMaterial;
      dim: number;
    }
    const slabs: Slab[] = [];
    const makeSlab = (spec: LayerSpec, w: number, d: number, x = 0): Slab => {
      const g = new Group();
      g.position.set(x, spec.y, 0);
      const shape = roundedRect(w, d, Math.min(0.42, d * 0.16));
      const geo = ctx.track(new ExtrudeGeometry(shape, { depth: SLAB_T, bevelEnabled: false, curveSegments: 6 }));
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -SLAB_T / 2, 0);
      const fill = materials.glass(`layer:${spec.id}`, 0.2, { roughness: 0.3, metalness: 0.05 });
      const mesh = new Mesh(geo, fill);
      mesh.renderOrder = 2;
      g.add(mesh);
      const pts = shape.getPoints(10).map((p) => new Vector3(p.x, SLAB_T / 2 + 0.004, -p.y));
      const edge = materials.line(`layer:${spec.id}`, { transparent: true, opacity: 0.85 });
      const loop = new LineLoop(ctx.track(new BufferGeometry().setFromPoints(pts)), edge);
      loop.renderOrder = 3;
      g.add(loop);
      root.add(g);
      return { spec, group: g, fill, edge, dim: 0 };
    };
    for (const spec of LAYERS) slabs.push(makeSlab(spec, spec.w, spec.d));
    const appsSpec = LAYERS[4]!;
    const wing = makeSlab(appsSpec, WING.w, WING.d, WING.x);
    // Bridge between the applications slab and the physical-AI wing.
    const bridgeGeo = ctx.track(new ExtrudeGeometry(roundedRect(WING.x - WING.w / 2 - appsSpec.w / 2 + 0.3, 0.5, 0.08), { depth: 0.06, bevelEnabled: false }));
    bridgeGeo.rotateX(-Math.PI / 2);
    const bridge = new Mesh(bridgeGeo, wing.fill);
    bridge.position.set((appsSpec.w / 2 + WING.x - WING.w / 2) / 2, appsSpec.y - 0.03, 0.1);
    root.add(bridge);
    const slabFor = (id: SegmentId): Slab[] => (id === 'physical-ai' ? [wing] : slabs.filter((s) => s.spec.id === LAYER_OF[id]));

    /* ───────── segment nodes ───────── */
    interface Node {
      id: SegmentId;
      mesh: Mesh<CylinderGeometry, MeshStandardMaterial>;
      base: Vector3;
      lift: number;
      hot: number;
      label: LabelHandle;
    }
    const nodeGeo = ctx.track(new CylinderGeometry(0.4, 0.4, NODE_H, 6, 1));
    nodeGeo.rotateY(Math.PI / 6);
    const nodes: Node[] = [];
    const glows = ctx.track(new GlowSprites({ count: SEGMENT_IDS.length, theme: ctx.theme }));
    root.add(glows.object);
    for (const id of SEGMENT_IDS) {
      const mat = ctx.track(new MeshStandardMaterial({ roughness: 0.38, metalness: 0.22 }));
      const mesh = new Mesh(nodeGeo, mat);
      const base = nodePos(id);
      mesh.position.copy(base);
      mesh.name = id;
      root.add(mesh);
      // Front-row nodes label below, crowded back rows to the side, the rest above.
      const front = (NODE_XZ[id][1] > 0.2 && LAYER_OF[id] !== 'applications') || id === 'energy-power';
      const side = !front && (LAYER_OF[id] === 'silicon' || LAYER_OF[id] === 'systems');
      const label = labels.add({
        text: SHORT[id],
        object: mesh,
        position: front ? [0, -0.12, 0.42] : side ? [0.36, 0.02, 0] : [0, 0.42, 0],
        align: front ? 'below' : side ? 'right' : 'above',
        priority: 10,
        hotspot: id,
      });
      nodes.push({ id, mesh, base, lift: 0, hot: 0, label });
    }

    /* ───────── labels: layers + flow stages ───────── */
    const layerLabels = LAYERS.map((l, i) =>
      labels.add({
        text: `${i + 1}　${l.name}`,
        position: [-l.w / 2 - 0.1, l.y, l.d / 2 - 0.25],
        align: 'left',
        kind: 'strong',
        priority: 30,
      }),
    );
    const stageLabels = LAYERS.map((l, i) =>
      labels.add({
        text: l.stage,
        position: [i === 4 ? -l.w / 2 + 0.1 : l.w / 2 + 0.1, l.y + 0.25, -l.d / 2 + 0.3],
        align: i === 4 ? 'left' : 'right',
        kind: 'tag',
        priority: 4,
      }),
    );
    const wingLabel = labels.add({
      text: '側翼',
      position: [WING.x + WING.w / 2 + 0.1, appsSpec.y, WING.d / 2 - 0.2],
      align: 'right',
      kind: 'tag',
      priority: 3,
    });

    /* ───────── value flows ───────── */
    const routes: SegmentId[][] = [];
    const sil: SegmentId[] = ['semi-equipment-materials', 'foundry-packaging', 'memory-storage', 'eda-ip-design', 'ai-accelerators'];
    const sys: SegmentId[] = ['networking-optics', 'servers-systems', 'datacenter-infra'];
    const cld: SegmentId[] = ['cloud-neocloud', 'foundation-models', 'devtools-data-mlops'];
    sil.forEach((s, i) =>
      sys.forEach((y, j) => {
        const end: SegmentId = (i * 3 + j) % 5 === 4 ? 'physical-ai' : 'apps-agents';
        routes.push(['energy-power', s, y, cld[(i + j) % 3]!, end]);
      }),
    );
    cld.forEach((c) => routes.push(['energy-power', 'datacenter-infra', c, 'apps-agents']));
    const lift = (id: SegmentId, dy: number) => nodePos(id).add(new Vector3(0, dy, 0));
    const routePoints = (r: SegmentId[]) => {
      const pts: Vector3[] = [];
      r.forEach((id, i) => {
        const p = lift(id, NODE_H / 2 + 0.05);
        if (i === 0) pts.push(p.clone().add(new Vector3(0, -0.05, 0)));
        else {
          // Ease into each node from below so streams read as "rising".
          const prev = pts[pts.length - 1]!;
          pts.push(new Vector3(p.x * 0.7 + prev.x * 0.3, p.y - 0.55, p.z * 0.7 + prev.z * 0.3));
          pts.push(p);
        }
      });
      return pts;
    };
    const routeColors = (r: SegmentId[], p: Palette): Color[] => {
      const cols: Color[] = [];
      r.forEach((id, i) => {
        const c = p.seg[id].clone();
        if (i === 0) cols.push(c);
        else cols.push(p.seg[r[i - 1]!].clone().lerp(c, 0.5), c);
      });
      return cols;
    };
    const flowPaths: FlowPath[] = routes.map((r) => ({ points: routePoints(r), color: routeColors(r, ctx.palette) }));
    const FLOW_MAX = 1500;
    const flow = ctx.track(
      new PathFlow({
        paths: flowPaths,
        count: FLOW_MAX,
        size: 0.075,
        speed: 0.75,
        speedVariance: 0.25,
        fadeEnds: 0.05,
        theme: ctx.theme,
        seed: 11,
      }),
    );
    flow.setCount(scaleCount(FLOW_MAX, ctx.tier, 120));
    flow.setReduced(!ctx.animate);
    root.add(flow.object);

    // Faint conduits along every route so the structure reads even when particles are sparse.
    const conduitGeo = ctx.track(new BufferGeometry());
    const conduitMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const conduits = new LineSegments(conduitGeo, conduitMat);
    conduits.renderOrder = 4;
    root.add(conduits);
    const curves = routes.map((r) => new CatmullRomCurve3(routePoints(r), false, 'centripetal'));
    const buildConduits = (p: Palette) => {
      const pos: number[] = [];
      const col: number[] = [];
      const a = p.theme === 'dark' ? 0.22 : 0.32;
      curves.forEach((cv, ri) => {
        const pts = cv.getSpacedPoints(48);
        const cols = routeColors(routes[ri]!, p);
        for (let i = 0; i < pts.length - 1; i++) {
          const t0 = (i / (pts.length - 1)) * (cols.length - 1);
          const t1 = ((i + 1) / (pts.length - 1)) * (cols.length - 1);
          for (const [pt, t] of [
            [pts[i]!, t0],
            [pts[i + 1]!, t1],
          ] as const) {
            pos.push(pt.x, pt.y, pt.z);
            const i0 = Math.min(cols.length - 1, Math.floor(t));
            const c = cols[i0]!.clone().lerp(cols[Math.min(cols.length - 1, i0 + 1)]!, t - i0);
            col.push(c.r, c.g, c.b, a);
          }
        }
      });
      conduitGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      conduitGeo.setAttribute('color', new Float32BufferAttribute(col, 4));
      conduitGeo.computeBoundingSphere();
    };

    /* ───────── palette ───────── */
    const tmp = new Color();
    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      lights.apply(p);
      grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.08 : 0.04), dark ? 0.55 : 0.75);
      shadowMat.color.copy(dark ? p.flow : p.fg);
      shadowMat.opacity = dark ? 0.08 : 0.07;
      flow.recolor((i) => routeColors(routes[i]!, p));
      flow.setTheme(p.theme);
      flow.setSize(dark ? 0.075 : 0.06);
      glows.setTheme(p.theme);
      buildConduits(p);
      for (const s of [...slabs, wing]) applySlab(s);
      for (const n of nodes) applyNode(n);
      for (const n of nodes) n.label.set({ swatch: p.css[`seg-${n.id}`] ?? '' });
      layerLabels.forEach((h, i) => h.set({ swatch: p.css[`layer-${LAYERS[i]!.id}`] ?? '' }));
    };
    const applySlab = (s: Slab) => {
      const dark = ctx.theme === 'dark';
      const k = 1 - 0.75 * s.dim;
      s.fill.opacity = (dark ? 0.17 : 0.13) * k;
      s.edge.opacity = (dark ? 0.85 : 0.9) * (1 - 0.6 * s.dim);
    };
    const applyNode = (n: Node) => {
      const p = ctx.palette;
      const dark = p.theme === 'dark';
      const dim = slabFor(n.id)[0]?.dim ?? 0;
      const segC = p.seg[n.id];
      n.mesh.material.color.copy(segC).lerp(p.bg, 0.65 * dim);
      n.mesh.material.emissive.copy(segC).multiplyScalar((dark ? 0.32 : 0.06) + 0.4 * n.hot);
      n.mesh.material.emissive.lerp(tmp.set(0, 0, 0), 0.7 * dim);
      n.mesh.scale.setScalar(1 + 0.12 * n.hot);
      n.mesh.position.copy(n.base).add(new Vector3(0, 0.14 * n.lift, 0));
      const i = SEGMENT_IDS.indexOf(n.id);
      glows.set(i, n.mesh.position, 1.5 + 0.6 * n.hot, segC, ((dark ? 0.42 : 0.3) + 0.35 * n.hot) * (1 - 0.8 * dim));
    };
    applyPalette(ctx.palette);

    /* ───────── hotspots & cards ───────── */
    const cardFor = (id: SegmentId): CardContent => {
      const d = data.get(id);
      const h = hsText.get(id);
      const companies = (d?.companies ?? []).slice(0, 3);
      const c: CardContent = {
        title: d?.title ?? h?.label ?? SHORT[id],
        swatch: ctx.palette.css[`seg-${id}`] ?? '',
        href: d?.href ?? h?.href ?? `/chain/${id}/`,
        linkLabel: '前往環節頁 →',
      };
      if (d?.titleEn) c.subtitle = d.titleEn;
      const body = d?.tagline ?? h?.detail;
      if (body) c.body = body;
      if (companies.length)
        c.items = companies.map((co) => ({
          label: co.nameZh && co.nameZh !== co.name ? `${co.nameZh}（${co.name}）` : co.name,
          href: `/companies/${co.id}/`,
        }));
      return c;
    };
    const nodeTween = new Map<SegmentId, { cancel(): void }>();
    for (const n of nodes) {
      const layer = LAYER_OF[n.id];
      const ly = layerY(layer);
      const [x] = NODE_XZ[n.id];
      hotspots.register(n.id, {
        object: n.mesh,
        anchor: n.mesh,
        card: () => cardFor(n.id),
        pose: { position: [x * 0.55 + 5.6, ly + 3.8, 9.6], target: [x * 0.55, ly + 0.2, 0] },
        onHighlight: (on) => {
          nodeTween.get(n.id)?.cancel();
          const from = n.hot;
          nodeTween.set(
            n.id,
            ctx.tween.run(
              (k) => {
                n.hot = from + ((on ? 1 : 0) - from) * k;
                n.lift = n.hot;
                applyNode(n);
              },
              { duration: 220, ease: 'cubicOut', fade: true },
            ),
          );
        },
      });
    }

    /* ───────── steps / variant ───────── */
    let dimTween: { cancel(): void } | null = null;
    const focusLayers = (focus: readonly LayerId[]) => {
      dimTween?.cancel();
      const all = [...slabs, wing];
      const from = all.map((s) => s.dim);
      const to = all.map((s) => (focus.length && !focus.includes(s.spec.id) ? 1 : 0));
      dimTween = ctx.tween.run(
        (k) => {
          all.forEach((s, i) => {
            s.dim = from[i]! + (to[i]! - from[i]!) * k;
            applySlab(s);
          });
          for (const n of nodes) applyNode(n);
        },
        { duration: 600, fade: true },
      );
      const focusedSeg = (id: SegmentId) => !focus.length || focus.includes(LAYER_OF[id]);
      for (const n of nodes)
        n.label.set({ priority: (explore() ? 20 : 8) + (focusedSeg(n.id) ? 10 : -20), kind: focusedSeg(n.id) ? 'default' : 'muted' });
      layerLabels.forEach((h, i) => h.set({ priority: focus.length && !focus.includes(LAYERS[i]!.id) ? 2 : 30 }));
    };
    const applyVariant = () => {
      const ex = explore();
      for (const n of nodes) n.label.set({ priority: ex ? 20 : 8 });
      stageLabels.forEach((h) => h.set({ visible: true }));
      wingLabel.set({ visible: ex });
    };
    applyVariant();

    return {
      update(_dt, t) {
        flow.update(t);
      },
      setStep(i) {
        focusLayers(STEP_FOCUS[i] ?? []);
        ctx.setPose(i > 0 ? STEP_POSES[i]! : ctx.homePose);
      },
      setVariant() {
        applyVariant();
        focusLayers(STEP_FOCUS[ctx.step] ?? []);
        ctx.setPose(ctx.step > 0 ? STEP_POSES[ctx.step]! : ctx.homePose);
      },
      onMotion(animate) {
        flow.setReduced(!animate);
      },
      onQuality(_q, tier) {
        flow.setCount(scaleCount(FLOW_MAX, tier, 120));
      },
      onPalette(p) {
        applyPalette(p);
      },
      dispose() {
        nodeTween.forEach((t) => t.cancel());
        dimTween?.cancel();
        root.removeFromParent();
      },
    };
  },
});

/* ───────────────────────── helpers ───────────────────────── */

/** A square grid of short segments whose alpha fades with distance from the centre. */
function buildFloorGrid(radius: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 16;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      const t0 = i / pieces;
      const t1 = (i + 1) / pieces;
      for (const t of [t0, t1]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.hypot(x, z) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.6);
      }
    }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const colors = new Float32Array((pos.length / 3) * 4);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  return {
    geometry,
    recolor(c: Color, alpha: number) {
      const attr = geometry.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}

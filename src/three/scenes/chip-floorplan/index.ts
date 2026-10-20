/**
 * chip-floorplan — 晶片平面圖城市 (variant: floorplan).
 *
 * A large AI accelerator die drawn as a "city" (layout.ts): SM clusters are tower blocks, the L2
 * SRAM band is a row of warehouses with the crossbar in the middle, the NoC mesh runs in the
 * streets with packets (PathFlow), and the "ports" sit on the edges — HBM PHYs + memory
 * controllers on the long edges (facing ghost HBM stacks on the interposer), SerDes, PCIe/CXL, the
 * CPU management complex and clock/sensors on the short edges. Hover a block for its IP type and
 * whether it is typically licensed IP or custom.
 *
 * Guided steps follow the EDA flow (由淺入深):
 *   0 總覽 · 1 規格與 IP (block diagram, coloured by sourcing) · 2 RTL 設計 (one SM lifted and
 *   exploded; copies pulse) · 3 邏輯合成 (zoom callout: an unplaced netlist cloud of standard cells,
 *   cells.ts) · 4 佈局繞線 (cells snap into rows between VDD/VSS rails, CTS + fillers, then M2/M3
 *   routing with vias) · 5 簽核驗證 (top-metal power grid + bumps with current flow, IR-drop map)
 *   · 6 設計定案 (one photomask per layer rises from the die).
 * Reduced motion: packets become static dotted streams, every step shows its final state.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  FrontSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { scaleCount } from '../../core/quality';
import {
  defineScene,
  type CameraPose,
  type CardContent,
  type ColorRef,
  type LabelHandle,
  type LabelSpec,
  type Palette,
  type PickHit,
  type SceneContext,
  type Tween,
} from '../../core/types';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';
import { GlowSprites } from '../../kit/GlowSprites';
import { PathFlow } from '../../kit/PathFlow';
import {
  BLOCK_TYPES,
  DIE_D,
  DIE_T,
  DIE_W,
  HBM_STACK,
  HBM_X,
  HOTSPOT_OF,
  INTERPOSER,
  IO_X,
  PDN_Y,
  SM_BASE_H,
  SOURCING,
  SOURCING_TEXT,
  buildLayout,
  buildPdn,
  buildRoutes,
  irDrop,
  type BlockType,
  type Paint,
  type Part,
  type RouteKind,
  type Sourcing,
} from './layout';
import { CAT_OF, CELL_NAME, PLATE_D, PLATE_W, ROWS, ROW_H, Y_M2, buildCells, railZ, rowZ, type CellCat } from './cells';

/* ───────────────────────── constants ───────────────────────── */

const HOME: CameraPose = { position: [3.6, 9.85, 11.85], target: [0.2, -0.6, 1.2] };
/** Lifted / exploded SM (RTL step): extra scale, horizontal spread, lift, gap above the base. */
const EXPL = { k: 1.15, spread: 0.1, lift: 1.0, gap: 0.05 };
const INSET_POS = new Vector3(0.95, 2.3, -0.55);
const INSET_TILT = 0.32;

type V3 = [number, number, number];
const STEP_POSES: readonly ({ position: V3; target: V3 } | null)[] = [
  null,
  { position: [0.05, 12.6, 4.3], target: [0.05, -0.4, 0.55] },
  { position: [2.75, 3.9, 3.45], target: [1.1, 1.0, 0.75] },
  { position: [1.95, 6.5, 6.45], target: [0.95, 1.72, -0.1] },
  { position: [1.95, 6.5, 6.45], target: [0.95, 1.72, -0.1] },
  { position: [3.9, 8.6, 9.0], target: [0.1, -0.2, 0.75] },
  { position: [6.6, 7.6, 11.4], target: [0.3, 1.3, 0.5] },
];
/**
 * Extra camera distance per step on portrait stages, on top of the host's portrait fit (which only
 * scales by |portrait| / |main|): the portrait frustum is much narrower than 16:9.
 */
const PORTRAIT_DIST: readonly number[] = [1, 1.5, 1.08, 1.12, 1.12, 1.24, 1.16];
/** Portrait target drop per step (moves tall content up into the empty top of a 4:5 frame). */
const PORTRAIT_DY: readonly number[] = [0, 0, 0, -0.95, -0.95, 0, -0.7];
/**
 * Whole-die steps get a more frontal pose on portrait stages: seen from the side, the die (and the
 * mask stack) is wider than a 4:5 frame. These are pre-fit poses (the host still scales them).
 */
const PORTRAIT_POSES: Readonly<Partial<Record<number, { position: V3; target: V3 }>>> = {
  5: { position: [0.9, 11.2, 9.6], target: [0.1, -0.5, 0.55] },
  6: { position: [1.45, 7.95, 14.7], target: [0.2, 1.0, 0.6] },
};
/** The standard-cell inset shrinks on portrait stages so its side legends still fit. */
const PORTRAIT_INSET = 0.74;
/** …and a little more on phone-width portrait stages (the legends become short stacked tags). */
const PORTRAIT_INSET_NARROW = 0.62;
/** Stage width (CSS px) below which the inset legends switch to short, evenly stacked tags. */
const NARROW_W = 640;
/** Vertical pitch (px) of the stacked legend tags on narrow stages (a tag is ~19 px tall and the
 * label layer's collision grid adds padding and 4 px rounding). */
const LEGEND_PITCH = 29;

const PAINT: Readonly<Record<Paint, ColorRef>> = {
  compute: 'seg:ai-accelerators',
  tensor: 'seg:ai-accelerators',
  sram: 'chart:1',
  rf: 'chart:1',
  sched: 'flow',
  noc: 'flow',
  hbm: 'seg:memory-storage',
  serdes: 'chart:3',
  pcie: 'chart:2',
  cpu: 'chart:4',
  clock: 'seg:devtools-data-mlops',
};
const SOURCE_PAINT: Readonly<Record<Sourcing, ColorRef>> = {
  custom: 'seg:ai-accelerators',
  licensed: 'chart:4',
  mixed: 'chart:3',
};
const CELL_PAINT: Readonly<Record<CellCat, ColorRef>> = {
  logic: 'seg:ai-accelerators',
  ff: 'chart:3',
  buf: 'chart:1',
  phys: 'muted',
};

interface TypeInfo {
  name: string;
  short: string;
  /** Shorter name for the sourcing labels on narrow (portrait) stages. */
  tiny?: string;
  en: string;
  vendors?: string;
  href: string;
  link: string;
  pose: CameraPose;
}
const GLOSS = '名詞解釋 →';
const TYPE_INFO: Readonly<Record<BlockType, TypeInfo>> = {
  compute: {
    name: '運算核心（SM 與 Tensor Core）',
    short: '運算核心（SM）',
    en: 'Streaming Multiprocessor・Tensor Core',
    vendors: '例：GPU 與 AI ASIC 公司的自家架構',
    href: '/glossary/#tensor-core',
    link: GLOSS,
    pose: { position: [3.3, 4.4, 5.0], target: [1.4, -0.1, 0.5] },
  },
  l2: {
    name: 'L2 快取（SRAM）',
    short: 'L2 快取',
    en: 'L2 cache・SRAM macros',
    vendors: '記憶體編譯器：晶圓廠、新思科技等',
    href: '/glossary/#sram',
    link: GLOSS,
    pose: { position: [1.8, 4.6, 4.2], target: [0, -0.1, -0.4] },
  },
  noc: {
    name: '晶片內網路（NoC）',
    short: 'NoC 路由器',
    en: 'Network-on-Chip・router・crossbar',
    vendors: '例：Arteris、安謀（Arm），或自研',
    href: '/chain/eda-ip-design/',
    link: '前往 EDA・矽智財環節 →',
    pose: { position: [-0.6, 4.6, 5.0], target: [-1.3, -0.1, 0.4] },
  },
  hbm: {
    name: 'HBM PHY 與記憶體控制器',
    short: 'HBM PHY',
    en: 'HBM PHY・memory controller',
    vendors: '例：新思科技、益華電腦、Rambus、創意電子',
    href: '/glossary/#hbm',
    link: GLOSS,
    pose: { position: [1.6, 3.8, 6.9], target: [0, -0.1, 2.7] },
  },
  serdes: {
    name: 'SerDes 高速介面',
    short: 'SerDes',
    en: 'Serializer / Deserializer',
    vendors: '例：新思科技、益華電腦，或 ASIC 合作夥伴',
    href: '/glossary/#serdes',
    link: GLOSS,
    pose: { position: [-1.4, 4.0, 3.6], target: [-3.5, -0.1, 0] },
  },
  pcie: {
    name: 'PCIe／CXL 介面',
    short: 'PCIe／CXL',
    en: 'PCI Express・Compute Express Link',
    vendors: '例：新思科技、益華電腦、Rambus',
    href: '/glossary/#pcie',
    link: GLOSS,
    pose: { position: [6.2, 3.4, 3.4], target: [3.6, -0.1, 0.6] },
  },
  cpu: {
    name: 'CPU 管理子系統',
    short: 'CPU 管理核心',
    tiny: 'CPU',
    en: 'Management CPU complex',
    vendors: '例：安謀（Arm）、晶心科技、SiFive',
    href: '/glossary/#risc-v',
    link: GLOSS,
    pose: { position: [6.0, 3.2, 4.4], target: [3.6, -0.1, 1.5] },
  },
  clock: {
    name: '時脈與感測器',
    short: '時脈／感測器',
    tiny: '時脈',
    en: 'PLL・thermal / voltage sensors',
    vendors: '例：類比 IP 業者；OTP：力旺電子',
    href: '/glossary/#silicon-ip',
    link: GLOSS,
    pose: { position: [5.8, 3.0, 5.0], target: [3.5, -0.1, 2.0] },
  },
};

const paintOfType = (t: BlockType): Paint => (t === 'compute' ? 'tensor' : t === 'l2' ? 'sram' : t);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeIO = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* scratch (no per-frame allocations) */
const m4 = new Matrix4();
const qI = new Quaternion();
const vP = new Vector3();
const vS = new Vector3();
const vA = new Vector3();
const cA = new Color();
const cB = new Color();

/* ───────────────────────── scene ───────────────────────── */

export default defineScene({
  json,
  meta: {
    camera: {
      ...HOME,
      fov: 36,
      minDistance: 2.4,
      maxDistance: 24,
      minPolar: 0.12,
      maxPolar: 1.32,
      portrait: { position: [1.7, 15.5, 11.2], target: [0.1, -0.4, 0.5] },
    },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 40, tris: 70_000 },
  },

  create(ctx: SceneContext) {
    const { scene, materials, labels, hotspots, picker } = ctx;
    const root = new Group();
    root.name = 'chip-floorplan';
    scene.add(root);
    const lights = addStudioLights(scene, ctx.palette);
    const hsText = new Map((json.hotspots ?? []).map((h) => [h.id, h]));

    const layout = buildLayout();
    const sel = layout.sms[layout.sel]!;
    const smDist = layout.sms.map((s) => Math.hypot(s.x - sel.x, s.z - sel.z));

    /* ───────── state (tweened) ───────── */
    type Key = 'flat' | 'src' | 'heat' | 'lift' | 'zoom' | 'place' | 'pdn' | 'masks' | 'wave';
    const S: Record<Key, number> = { flat: 0, src: 0, heat: 0, lift: 0, zoom: 0, place: 0, pdn: 0, masks: 0, wave: 0 };
    const tw: Partial<Record<Key, Tween>> = {};
    const hot: Record<string, number> = {};
    const hotTw = new Map<string, Tween>();
    const stepDim: Record<BlockType, number> = { compute: 0, l2: 0, noc: 0, hbm: 0, serdes: 0, pcie: 0, cpu: 0, clock: 0 };
    let dimFrom = { ...stepDim };
    let dimTo = { ...stepDim };
    let dirtyCity = true;
    let dirtyInset = true;
    let dirtyMisc = true;
    let t0 = 0;

    const go = (k: Key, to: number, duration = 750, delay = 0) => {
      tw[k]?.cancel();
      const from = S[k];
      if (Math.abs(from - to) < 1e-4) {
        S[k] = to;
        return;
      }
      tw[k] = ctx.tween.run(
        (e) => {
          S[k] = from + (to - from) * e;
          dirtyCity = dirtyInset = dirtyMisc = true;
        },
        { duration, delay, ease: k === 'place' ? 'linear' : 'cubicInOut' },
      );
    };

    /* ───────── floor: faded grid + soft contact shadow ───────── */
    const grid = buildFloorGrid(9.5, 0.6);
    const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const gridLines = new LineSegments(ctx.track(grid.geometry), gridMat);
    gridLines.position.y = -0.62;
    root.add(gridLines);
    const shadowMat = ctx.track(new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }));
    const shadow = new Mesh(ctx.track(new PlaneGeometry(15, 15)), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.6;
    root.add(shadow);

    /* ───────── interposer, die, seal ring, HBM stacks ───────── */
    const siliconRef: ColorRef = (p) => (p.theme === 'dark' ? p.bg.clone().lerp(p.fg, 0.13).lerp(p.muted, 0.12) : p.fg.clone().lerp(p.bg, 0.8));
    const interMat = materials.standard((p) => (p.theme === 'dark' ? p.bg.clone().lerp(p.fg, 0.07) : p.fg.clone().lerp(p.bg, 0.9)), { roughness: 0.7, metalness: 0.1 });
    const inter = new Mesh(ctx.track(new RoundedBoxGeometry(INTERPOSER.w, INTERPOSER.t, INTERPOSER.d, 2, 0.05)), interMat);
    inter.position.y = -DIE_T - 0.03 - INTERPOSER.t / 2;
    root.add(inter);
    const dieMat = materials.standard(siliconRef, { roughness: 0.42, metalness: 0.3 });
    const die = new Mesh(ctx.track(new RoundedBoxGeometry(DIE_W, DIE_T, DIE_D, 2, 0.04)), dieMat);
    die.position.y = -DIE_T / 2;
    root.add(die);
    const ringMat = materials.line('muted', { transparent: true, opacity: 0.7 });
    const ring = new LineLoop(ctx.track(rectGeometry(DIE_W - 0.12, DIE_D - 0.12, 0.004)), ringMat);
    root.add(ring);

    const stackY0 = inter.position.y + INTERPOSER.t / 2;
    const stackGeo = ctx.track(new RoundedBoxGeometry(HBM_STACK.w, HBM_STACK.h, HBM_STACK.d, 2, 0.04));
    // Front faces only: with DoubleSide the back faces blend in triangle order and leave diagonal
    // light/dark patches inside the translucent boxes.
    const stackMat = materials.glass('seg:memory-storage', 0.12, { roughness: 0.35, side: FrontSide });
    const stackAlpha = () => (ctx.theme === 'dark' ? 0.14 : 0.12);
    const stacks = new InstancedMesh(stackGeo, stackMat, 6);
    const stackPos: Vector3[] = [];
    for (const zs of [-1, 1])
      for (const x of HBM_X) {
        const p = new Vector3(x, stackY0 + HBM_STACK.h / 2, zs * (DIE_D / 2 + HBM_STACK.gap + HBM_STACK.d / 2));
        stacks.setMatrixAt(stackPos.length, m4.makeTranslation(p));
        stackPos.push(p);
      }
    stacks.renderOrder = 2;
    root.add(stacks);
    ctx.track({ dispose: () => stacks.dispose() });
    // Stacked-die slices (base die + DRAM dies) as outline rings.
    const sliceGeo = ctx.track(new BufferGeometry());
    {
      const pos: number[] = [];
      for (const p of stackPos) {
        for (let k = 0; k <= 5; k++) {
          const y = stackY0 + 0.02 + (k / 5) * (HBM_STACK.h - 0.04);
          const hw = HBM_STACK.w / 2 - 0.01;
          const hd = HBM_STACK.d / 2 - 0.01;
          const c: [number, number][] = [
            [-hw, -hd],
            [hw, -hd],
            [hw, hd],
            [-hw, hd],
          ];
          for (let i = 0; i < 4; i++) {
            const a = c[i]!;
            const b = c[(i + 1) % 4]!;
            pos.push(p.x + a[0], y, p.z + a[1], p.x + b[0], y, p.z + b[1]);
          }
        }
      }
      sliceGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    }
    const sliceMat = materials.line('seg:memory-storage', { transparent: true, opacity: 0.5, depthWrite: false });
    const slices = new LineSegments(sliceGeo, sliceMat);
    slices.renderOrder = 3;
    root.add(slices);

    /* ───────── city: merged rounded blocks per type + instanced details ───────── */
    const city = new Group();
    city.name = 'city';
    root.add(city);
    interface BlockMesh {
      type: BlockType;
      mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
      parts: Part[];
      vertsPer: number;
      color: BufferAttribute;
    }
    const blockMat = ctx.track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.22 }));
    const blockMeshes: BlockMesh[] = [];
    for (const type of BLOCK_TYPES) {
      const parts = layout.parts.filter((p) => p.rounded && p.type === type && !(p.sm === layout.sel && p.type === 'compute'));
      if (!parts.length) continue;
      const geos = parts.map((p) => {
        const r = Math.min(0.045, p.h * 0.45, p.w * 0.25, p.d * 0.25);
        const g = new RoundedBoxGeometry(p.w, p.h, p.d, 1, r);
        g.translate(p.x, p.y0 + p.h / 2, p.z);
        return g;
      });
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      ctx.track(merged);
      const vertsPer = merged.getAttribute('position').count / parts.length;
      const color = new BufferAttribute(new Float32Array(merged.getAttribute('position').count * 3), 3);
      color.setUsage(DynamicDrawUsage);
      merged.setAttribute('color', color);
      const mesh = new Mesh(merged, blockMat);
      mesh.name = `blocks-${type}`;
      city.add(mesh);
      blockMeshes.push({ type, mesh, parts, vertsPer, color });
    }
    // The selected SM's base is its own mesh so it can lift and explode.
    const selBasePart = layout.parts.find((p) => p.sm === layout.sel && p.rounded)!;
    const selBaseMat = ctx.track(new MeshStandardMaterial({ roughness: 0.5, metalness: 0.22 }));
    const selBase = new Mesh(ctx.track(new RoundedBoxGeometry(selBasePart.w, selBasePart.h, selBasePart.d, 1, 0.045)), selBaseMat);
    city.add(selBase);

    const flatParts = layout.parts.filter((p) => !p.rounded);
    const boxGeo = ctx.track(new BoxGeometry(1, 1, 1));
    const detailMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 }));
    const details = new InstancedMesh(boxGeo, detailMat, flatParts.length);
    details.instanceMatrix.setUsage(DynamicDrawUsage);
    details.setColorAt(0, cA.set(1, 1, 1));
    details.instanceColor?.setUsage(DynamicDrawUsage);
    city.add(details);
    ctx.track({ dispose: () => details.dispose() });
    const selFlat: number[] = [];
    flatParts.forEach((p, i) => {
      details.setMatrixAt(i, m4.compose(vP.set(p.x, p.y0 + p.h / 2, p.z), qI, vS.set(p.w, p.h, p.d)));
      if (p.sm === layout.sel && p.type === 'compute') selFlat.push(i);
    });
    details.instanceMatrix.needsUpdate = true;
    details.computeBoundingSphere();

    /* ───────── NoC packets ───────── */
    const routes = buildRoutes(layout.l2Rows);
    const routeColor = (kind: RouteKind, p: Palette): Color[] => {
      if (kind === 'mem') return [p.seg['memory-storage'].clone().lerp(p.flow, 0.25), p.seg['memory-storage'].clone()];
      if (kind === 'io') return [p.chart[2]!.clone(), p.flow.clone()];
      return [p.flow.clone()];
    };
    const PACKETS = 520;
    const packets = ctx.track(
      new PathFlow({
        paths: routes.map((r) => ({ points: r.points, color: routeColor(r.kind, ctx.palette), weight: r.kind === 'req' ? 1.2 : 1 })),
        count: PACKETS,
        size: 0.075,
        sizeVariance: 0.2,
        speed: 0.75,
        speedVariance: 0.2,
        smooth: false,
        samples: 96,
        fadeEnds: 0.05,
        theme: ctx.theme,
        seed: 21,
      }),
    );
    packets.setCount(scaleCount(PACKETS, ctx.tier, 90));
    root.add(packets.object);

    const glows = ctx.track(new GlowSprites({ count: layout.routers.length + 4, theme: ctx.theme }));
    root.add(glows.object);

    /* ───────── power-delivery network (signoff) ───────── */
    const pdn = buildPdn();
    const pdnGroup = new Group();
    pdnGroup.name = 'pdn';
    root.add(pdnGroup);
    const strapMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.55, transparent: true }));
    const straps = new InstancedMesh(boxGeo, strapMat, pdn.straps.length);
    pdn.straps.forEach((s, i) => straps.setMatrixAt(i, m4.compose(vP.set(s.x, PDN_Y, s.z), qI, vS.set(s.w, 0.016, s.d))));
    straps.setColorAt(0, cA.set(1, 1, 1));
    straps.computeBoundingSphere();
    pdnGroup.add(straps);
    ctx.track({ dispose: () => straps.dispose() });
    const bumpGeo = ctx.track(new CylinderGeometry(0.075, 0.075, 0.06, 14));
    const bumpMat = ctx.track(new MeshStandardMaterial({ roughness: 0.3, metalness: 0.7, transparent: true }));
    const bumps = new InstancedMesh(bumpGeo, bumpMat, pdn.bumps.length);
    pdn.bumps.forEach((b, i) => bumps.setMatrixAt(i, m4.makeTranslation(b.x, PDN_Y + 0.045, b.z)));
    bumps.setColorAt(0, cA.set(1, 1, 1));
    bumps.computeBoundingSphere();
    pdnGroup.add(bumps);
    ctx.track({ dispose: () => bumps.dispose() });
    const CURRENT = 360;
    const current = ctx.track(
      new PathFlow({
        paths: pdn.drops.map((d) => ({ points: d, color: ctx.palette.power })),
        count: CURRENT,
        size: 0.06,
        sizeVariance: 0.2,
        speed: 0.55,
        smooth: false,
        fadeEnds: 0.1,
        theme: ctx.theme,
        seed: 5,
      }),
    );
    current.setCount(scaleCount(CURRENT, ctx.tier, 60));
    pdnGroup.add(current.object);

    /* ───────── standard-cell inset (synthesis / place & route) ───────── */
    const cb = buildCells(ctx.rng);
    const inset = new Group();
    inset.name = 'inset';
    root.add(inset);
    const plateMat = materials.standard(siliconRef, { roughness: 0.5, metalness: 0.25 });
    const plate = new Mesh(ctx.track(new RoundedBoxGeometry(PLATE_W + 0.2, 0.06, PLATE_D + 0.2, 1, 0.03)), plateMat);
    plate.position.y = -0.03;
    inset.add(plate);
    const frameMat = materials.line('highlight', { transparent: true, opacity: 0.9 });
    const frame = new LineLoop(ctx.track(rectGeometry(PLATE_W + 0.2, PLATE_D + 0.2, 0.004)), frameMat);
    inset.add(frame);
    // Rails: VDD / VSS alternate along the row boundaries.
    const railMat = ctx.track(new MeshStandardMaterial({ roughness: 0.35, metalness: 0.5, transparent: true }));
    const rails = new InstancedMesh(boxGeo, railMat, ROWS + 1);
    for (let r = 0; r <= ROWS; r++) rails.setMatrixAt(r, m4.compose(vP.set(0, 0.006, railZ(r)), qI, vS.set(4.5, 0.012, 0.032)));
    rails.setColorAt(0, cA.set(1, 1, 1));
    inset.add(rails);
    ctx.track({ dispose: () => rails.dispose() });
    const cellMat = ctx.track(new MeshStandardMaterial({ roughness: 0.45, metalness: 0.12 }));
    const cellMesh = new InstancedMesh(boxGeo, cellMat, cb.cells.length);
    cellMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    cellMesh.setColorAt(0, cA.set(1, 1, 1));
    inset.add(cellMesh);
    ctx.track({ dispose: () => cellMesh.dispose() });
    const wireMat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
    const wireMesh = new InstancedMesh(boxGeo, wireMat, cb.wires.length);
    wireMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    wireMesh.setColorAt(0, cA.set(1, 1, 1));
    inset.add(wireMesh);
    ctx.track({ dispose: () => wireMesh.dispose() });
    const ratGeo = ctx.track(new BufferGeometry());
    const ratPos = new Float32BufferAttribute(new Float32Array(cb.nets.length * 6), 3);
    ratPos.setUsage(DynamicDrawUsage);
    ratGeo.setAttribute('position', ratPos);
    const ratMat = materials.line('fg', { transparent: true, opacity: 0.4, depthWrite: false });
    const rats = new LineSegments(ratGeo, ratMat);
    rats.frustumCulled = false;
    inset.add(rats);
    const SIGNALS = 90;
    const signals = ctx.track(
      new PathFlow({
        paths: cb.nets.slice(0, 48).map((n) => ({ points: n.path, color: ctx.palette.flow })),
        count: SIGNALS,
        size: 0.045,
        sizeVariance: 0.15,
        speed: 0.5,
        smooth: false,
        fadeEnds: 0.12,
        theme: ctx.theme,
        seed: 9,
      }),
    );
    signals.setCount(scaleCount(SIGNALS, ctx.tier, 24));
    inset.add(signals.object);
    // Zoom callout: four lines from the lifted SM to the plate corners.
    const calloutGeo = ctx.track(new BufferGeometry());
    const calloutPos = new Float32BufferAttribute(new Float32Array(8 * 3), 3);
    calloutPos.setUsage(DynamicDrawUsage);
    calloutGeo.setAttribute('position', calloutPos);
    const calloutMat = materials.line('highlight', { transparent: true, opacity: 0.6, depthWrite: false });
    const callout = new LineSegments(calloutGeo, calloutMat);
    callout.frustumCulled = false;
    root.add(callout);
    const beamGeo = ctx.track(new BufferGeometry());
    const beamPos = new Float32BufferAttribute(new Float32Array(8 * 3), 3);
    beamPos.setUsage(DynamicDrawUsage);
    beamGeo.setAttribute('position', beamPos);
    beamGeo.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const beamMat = materials.basic('highlight', { transparent: true, opacity: 0.1, depthWrite: false, side: DoubleSide });
    const beam = new Mesh(beamGeo, beamMat);
    beam.frustumCulled = false;
    beam.renderOrder = 4;
    root.add(beam);

    /* ───────── photomask plates (tape-out) ───────── */
    const MASKS = 6;
    const atlas = ctx.track(buildMaskAtlas(layout.parts));
    const maskMat = materials.basic((p) => (p.theme === 'dark' ? p.flow.clone().lerp(p.fg, 0.35) : p.fg.clone().lerp(p.optic, 0.25)), {
      map: atlas,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    const maskPlates: Mesh[] = [];
    for (let i = 0; i < MASKS; i++) {
      const g = ctx.track(new PlaneGeometry(DIE_W + 0.3, DIE_D + 0.3));
      g.rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv') as BufferAttribute;
      const col = i % 3;
      const row = Math.floor(i / 3);
      for (let k = 0; k < uv.count; k++) uv.setXY(k, (col + uv.getX(k)) / 3, 1 - (row + 1 - uv.getY(k)) / 2);
      const m = new Mesh(g, maskMat);
      m.renderOrder = 20 + i;
      m.visible = false;
      root.add(m);
      maskPlates.push(m);
    }
    const maskY = (i: number, k: number) => 0.06 + (0.75 + i * 0.52) * k;

    /* ───────── colours ───────── */
    const paintCache = new Map<string, Color>();
    const resolve = (ref: ColorRef): Color => {
      const key = typeof ref === 'string' ? ref : '';
      let c = key ? paintCache.get(key) : undefined;
      if (!c) {
        c = materials.color(ref);
        if (key) paintCache.set(key, c);
      }
      return c;
    };
    const silicon = new Color();
    const white = new Color(1, 1, 1);
    const toned = (ref: ColorRef, tone: number, out: Color) => {
      out.copy(resolve(ref));
      if (tone > 0) out.lerp(white, tone * (ctx.theme === 'dark' ? 0.8 : 0.7));
      else if (tone < 0) out.lerp(ctx.theme === 'dark' ? ctx.palette.bg : ctx.palette.fg, -tone * (ctx.theme === 'dark' ? 0.7 : 0.45));
      return out;
    };
    const waveOf = new Float32Array(layout.sms.length);
    const hoverDim = () => {
      let m = 0;
      for (const k in hot) m = Math.max(m, hot[k] ?? 0);
      return m;
    };
    const partColor = (p: Part, out: Color) => {
      toned(PAINT[p.paint], p.tone, out);
      if (S.src > 0) out.lerp(toned(SOURCE_PAINT[SOURCING[p.type]], p.tone * 0.6, cB), S.src);
      if (S.heat > 0 && (p.type === 'compute' || p.type === 'l2')) {
        out.lerp(silicon, 0.5 * S.heat);
        out.lerp(ctx.palette.heat, irDrop(p.x, p.z) * 0.92 * S.heat);
      }
      if (p.sm !== undefined && waveOf[p.sm]! > 0) out.lerp(ctx.palette.highlight, waveOf[p.sm]! * 0.55);
      const h = hot[HOTSPOT_OF[p.type]] ?? 0;
      if (h > 0) out.lerp(ctx.palette.highlight, 0.42 * h);
      const isSel = p.sm === layout.sel && p.type === 'compute';
      const sd = isSel ? 0 : stepDim[p.type];
      const d = Math.max(sd, 0.4 * hoverDim() * (1 - h));
      if (d > 0) out.lerp(silicon, (ctx.theme === 'dark' ? 0.86 : 0.66) * d);
      return out;
    };
    const paintCity = (onlyCompute = false) => {
      for (const b of blockMeshes) {
        if (onlyCompute && b.type !== 'compute') continue;
        const arr = b.color.array as Float32Array;
        b.parts.forEach((p, i) => {
          partColor(p, cA);
          const o = i * b.vertsPer * 3;
          for (let v = 0; v < b.vertsPer; v++) {
            arr[o + v * 3] = cA.r;
            arr[o + v * 3 + 1] = cA.g;
            arr[o + v * 3 + 2] = cA.b;
          }
        });
        b.color.needsUpdate = true;
      }
      flatParts.forEach((p, i) => {
        if (onlyCompute && p.type !== 'compute') return;
        details.setColorAt(i, partColor(p, cA));
      });
      if (details.instanceColor) details.instanceColor.needsUpdate = true;
      selBaseMat.color.copy(partColor(selBasePart, cA));
    };

    const paintStatic = (p: Palette) => {
      const dark = p.theme === 'dark';
      paintCache.clear();
      silicon.copy(resolve(siliconRef));
      pdn.straps.forEach((s, i) => straps.setColorAt(i, s.vdd ? p.power : cA.copy(p.muted).lerp(dark ? p.fg : p.bg, dark ? 0.25 : 0.12)));
      if (straps.instanceColor) straps.instanceColor.needsUpdate = true;
      pdn.bumps.forEach((b, i) => bumps.setColorAt(i, b.vdd ? cA.copy(p.power).lerp(white, 0.15) : cA.copy(p.muted).lerp(dark ? p.fg : p.bg, dark ? 0.45 : 0.1)));
      strapMat.metalness = dark ? 0.55 : 0.3;
      bumpMat.metalness = dark ? 0.7 : 0.35;
      if (bumps.instanceColor) bumps.instanceColor.needsUpdate = true;
      for (let r = 0; r <= ROWS; r++) rails.setColorAt(r, r % 2 === 0 ? p.power : cA.copy(p.muted).lerp(p.fg, dark ? 0.3 : 0.25));
      if (rails.instanceColor) rails.instanceColor.needsUpdate = true;
      cb.wires.forEach((w, i) => {
        const ref: ColorRef = w.kind === 'm2' ? 'flow' : w.kind === 'm3' ? 'chart:5' : w.kind === 'clk' ? 'chart:2' : 'fg';
        cA.copy(resolve(ref));
        if (w.kind === 'via') cA.lerp(p.bg, dark ? 0.15 : 0.3);
        wireMesh.setColorAt(i, cA);
      });
      if (wireMesh.instanceColor) wireMesh.instanceColor.needsUpdate = true;
      paintCells();
    };
    const paintCells = () => {
      const h = hot['standard-cells'] ?? 0;
      cb.cells.forEach((c, i) => {
        const cat = CAT_OF[c.kind];
        toned(CELL_PAINT[cat], cat === 'phys' ? (c.kind === 'tap' ? -0.3 : 0.1) : 0.05, cA);
        if (h > 0) cA.lerp(ctx.palette.highlight, 0.35 * h);
        cellMesh.setColorAt(i, cA);
      });
      if (cellMesh.instanceColor) cellMesh.instanceColor.needsUpdate = true;
    };

    const applyPalette = (p: Palette) => {
      const dark = p.theme === 'dark';
      lights.apply(p);
      grid.recolor(p.grid.clone().lerp(p.fg, dark ? 0.1 : 0.05), dark ? 0.5 : 0.7);
      shadowMat.color.copy(dark ? p.flow : p.fg);
      shadowMat.opacity = dark ? 0.07 : 0.08;
      paintStatic(p);
      packets.recolor((i) => routeColor(routes[i]!.kind, p));
      packets.setTheme(p.theme);
      packets.setSize(dark ? 0.08 : 0.065);
      packets.setOpacity(dark ? 1 : 0.9);
      current.recolor(() => p.power);
      current.setTheme(p.theme);
      current.setSize(dark ? 0.07 : 0.055);
      signals.recolor(() => p.flow);
      signals.setTheme(p.theme);
      signals.setSize(dark ? 0.05 : 0.04);
      glows.setTheme(p.theme);
      ringMat.opacity = dark ? 0.55 : 0.75;
      stackMat.opacity = stackAlpha();
      sliceMat.opacity = dark ? 0.4 : 0.42;
      for (const l of allLabels) applySwatch(l);
      dirtyCity = dirtyInset = dirtyMisc = true;
    };

    /* ───────── geometry updates ───────── */
    const selTop = new Vector3();
    const placeSel = () => {
      const e = easeIO(clamp01(S.lift));
      const k = 1 + EXPL.k * e;
      const L = EXPL.lift * e;
      selBase.position.set(sel.x, L + (SM_BASE_H / 2) * k, sel.z);
      selBase.scale.setScalar(k);
      for (const i of selFlat) {
        const p = flatParts[i]!;
        const spread = k * (1 + EXPL.spread * e);
        vP.set(sel.x + (p.x - sel.x) * spread, L + (p.y0 + p.h / 2) * k + (p.y0 > 0 ? EXPL.gap * e : 0), sel.z + (p.z - sel.z) * spread);
        details.setMatrixAt(i, m4.compose(vP, qI, vS.set(p.w * k, p.h * k, p.d * k)));
      }
      details.instanceMatrix.needsUpdate = true;
      details.computeBoundingSphere();
      selTop.set(sel.x, L + SM_BASE_H * k, sel.z);
    };

    const corners: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    const applyInset = () => {
      const z = easeIO(clamp01(S.zoom));
      const on = z > 0.01;
      inset.visible = on;
      callout.visible = on;
      beam.visible = on;
      if (!on) return;
      inset.position.lerpVectors(selTop, INSET_POS, z);
      const insetK = portrait ? (narrow ? PORTRAIT_INSET_NARROW : PORTRAIT_INSET) : 1;
      inset.scale.setScalar(0.07 + (insetK - 0.07) * z);
      inset.rotation.x = INSET_TILT * z;
      inset.updateMatrixWorld(true);
      // Callout lines.
      const hw = (PLATE_W + 0.2) / 2;
      const hd = (PLATE_D + 0.2) / 2;
      const s = (selBasePart.w / 2) * (1 + EXPL.k * easeIO(clamp01(S.lift)));
      const pc: [number, number][] = [
        [-hw, -hd],
        [hw, -hd],
        [hw, hd],
        [-hw, hd],
      ];
      const sc: [number, number][] = [
        [-s, -s],
        [s, -s],
        [s, s],
        [-s, s],
      ];
      for (let i = 0; i < 4; i++) {
        corners[i]!.set(pc[i]![0], 0, pc[i]![1]);
        inset.localToWorld(corners[i]!);
        calloutPos.setXYZ(i * 2, selTop.x + sc[i]![0], selTop.y + 0.005, selTop.z + sc[i]![1]);
        calloutPos.setXYZ(i * 2 + 1, corners[i]!.x, corners[i]!.y, corners[i]!.z);
        beamPos.setXYZ(i, selTop.x + sc[i]![0], selTop.y + 0.005, selTop.z + sc[i]![1]);
        beamPos.setXYZ(i + 4, corners[i]!.x, corners[i]!.y - 0.035, corners[i]!.z);
      }
      calloutPos.needsUpdate = true;
      beamPos.needsUpdate = true;
      calloutMat.opacity = (ctx.theme === 'dark' ? 0.7 : 0.85) * z;
      beamMat.opacity = (ctx.theme === 'dark' ? 0.07 : 0.12) * z;

      // Cells: netlist cloud (place = 0) → well taps in the empty rows → placement → clock-tree
      // synthesis (CTS) → routing (M2 / M3 + vias) → filler / decap cells close the gaps.
      const k = S.place;
      const tapK = smooth(0, 0.07, k);
      const placeK = clamp01((k - 0.04) / 0.42);
      const clkK = smooth(0.46, 0.62, k);
      const routeK = clamp01((k - 0.6) / 0.28);
      const fillK = smooth(0.87, 0.98, k);
      const bob = ctx.animate && k < 0.02 && ctx.step === 3;
      const t = t0;
      cb.cells.forEach((c, i) => {
        const cat = CAT_OF[c.kind];
        let s = 1;
        if (c.kind === 'tap') s = tapK;
        else if (cat === 'phys') s = fillK;
        else if (c.kind === 'clk') s = clkK;
        const local = clamp01((placeK * 1.25 - c.delay) / 0.5);
        const e = easeIO(local);
        const yb = bob ? Math.sin(t * 0.9 + i * 0.7) * 0.03 : 0;
        const tx = c.x;
        const tz = rowZ(c.row);
        const x = cat === 'phys' || c.kind === 'clk' ? tx : c.cloud[0] + (tx - c.cloud[0]) * e;
        const y = cat === 'phys' || c.kind === 'clk' ? c.h / 2 : c.cloud[1] + yb + (c.h / 2 - c.cloud[1] - yb) * e;
        const zz = cat === 'phys' || c.kind === 'clk' ? tz : c.cloud[2] + (tz - c.cloud[2]) * e;
        const cs = s * (0.82 + 0.18 * e);
        vS.set(Math.max(0.0001, (c.w - 0.008) * cs), Math.max(0.0001, c.h * cs), Math.max(0.0001, (ROW_H - 0.04) * cs));
        cellMesh.setMatrixAt(i, m4.compose(vP.set(x, y, zz), qI, vS));
      });
      cellMesh.instanceMatrix.needsUpdate = true;
      cellMesh.computeBoundingSphere();
      cb.wires.forEach((w, i) => {
        const rk = w.kind === 'clk' ? clamp01((clkK * 1.3 - w.order * 0.3) / 1) : clamp01((routeK * 1.4 - w.order * 0.4) / 1);
        const s = rk > 0 ? 1 : 0;
        vS.set(w.kind === 'm2' ? w.w * rk : w.w * s, Math.max(0.0001, w.h * s), w.kind === 'm3' ? w.d * rk : w.d * s);
        if (s === 0) vS.set(0.0001, 0.0001, 0.0001);
        wireMesh.setMatrixAt(i, m4.compose(vP.set(w.x, w.y, w.z), qI, vS));
      });
      wireMesh.instanceMatrix.needsUpdate = true;
      railMat.opacity = 0.35 + 0.65 * clamp01(k * 3);
      // Ratsnest (netlist connections) fades out as cells are placed.
      const ratA = 1 - smooth(0.0, 0.5, k);
      rats.visible = ratA > 0.01;
      ratMat.opacity = (ctx.theme === 'dark' ? 0.45 : 0.5) * ratA;
      if (rats.visible) {
        cb.nets.forEach((n, i) => {
          for (const [j, idx] of [
            [0, n.from],
            [1, n.to],
          ] as const) {
            cellMesh.getMatrixAt(idx, m4);
            vA.setFromMatrixPosition(m4);
            ratPos.setXYZ(i * 2 + j, vA.x, vA.y + cb.cells[idx]!.h / 2 + 0.005, vA.z);
          }
        });
        ratPos.needsUpdate = true;
      }
      signals.object.visible = routeK >= 1;
      phaseLabel.set({ text: phaseText(k), visible: ctx.step === 4 });
    };
    const phaseText = (k: number) =>
      k >= 0.999
        ? '擺放 → 時脈樹 → 繞線 → 填充：完成'
        : k < 0.46
          ? '① 擺放（placement）'
          : k < 0.61
            ? '② 時脈樹合成（CTS）'
            : k < 0.88
              ? '③ 繞線（routing）'
              : '④ 補上填充單元';

    const applyMisc = () => {
      // Flatten (spec block diagram).
      city.scale.y = 1 - 0.72 * easeIO(clamp01(S.flat));
      // Power grid.
      const pv = Math.max(S.pdn, hot['power-grid'] ?? 0);
      pdnGroup.visible = pv > 0.01;
      strapMat.opacity = pv;
      bumpMat.opacity = pv;
      current.setOpacity(pv);
      // HBM stacks fade out in the block-diagram (spec) view.
      const sv = 1 - easeIO(clamp01(S.flat));
      stacks.visible = slices.visible = sv > 0.02;
      stackMat.opacity = stackAlpha() * sv;
      sliceMat.opacity = (ctx.theme === 'dark' ? 0.4 : 0.42) * sv;
      // Masks.
      const mk = S.masks;
      maskMat.opacity = (ctx.theme === 'dark' ? 0.62 : 0.66) * clamp01(mk * 1.6);
      maskPlates.forEach((m, i) => {
        m.visible = mk > 0.01;
        m.position.y = maskY(i, easeIO(clamp01(mk * 1.15 - i * 0.03)));
      });
      // Router glows (+ IR hot spots in signoff). While the standard-cell inset is open the
      // packets and glows step back so the inset reads first.
      const dark = ctx.theme === 'dark';
      const calm = 1 - 0.7 * easeIO(clamp01(S.zoom));
      packets.setOpacity((dark ? 1 : 0.9) * calm);
      const nd = Math.max(stepDim.noc, 0.4 * hoverDim() * (1 - (hot['noc'] ?? 0)), 1 - calm);
      layout.routers.forEach(([x, z], i) => {
        glows.set(i, vP.set(x, 0.1, z), 0.42 + 0.25 * (hot['noc'] ?? 0), ctx.palette.flow, ((dark ? 0.55 : 0.3) + 0.3 * (hot['noc'] ?? 0)) * (1 - 0.8 * nd) * (1 - 0.6 * S.flat));
      });
      const base = layout.routers.length;
      const hotspotsIR: [number, number, number][] = [
        [-1.9, -0.55, 2.4],
        [1.75, 1.05, 2.0],
        [2.2, -1.6, 1.2],
      ];
      hotspotsIR.forEach(([x, z, d], i) => glows.set(base + i, vP.set(x, 0.35, z), d, ctx.palette.heat, (dark ? 0.55 : 0.35) * S.heat));
      glows.set(base + 3, vP.set(0, 0.15, 0), 0.9, ctx.palette.flow, (dark ? 0.45 : 0.25) * (1 - 0.8 * nd));
    };

    /* ───────── labels ───────── */
    interface Lbl {
      h: LabelHandle;
      steps: readonly number[];
      swatch?: ColorRef;
      type?: BlockType;
      text: string;
      /** Shorter text for narrow (phone-width) stages. */
      narrowText?: string;
      kind: NonNullable<LabelSpec['kind']>;
    }
    const allLabels: Lbl[] = [];
    const applySwatch = (l: Lbl) => {
      if (!l.swatch) return;
      const c = resolve(l.swatch);
      l.h.set({ swatch: `#${c.getHexString()}` });
    };
    const lbl = (spec: LabelSpec, steps: readonly number[], extra: { swatch?: ColorRef; type?: BlockType; narrowText?: string } = {}): Lbl => {
      const l: Lbl = { h: labels.add(spec), steps, text: spec.text, kind: spec.kind ?? 'default', ...extra };
      allLabels.push(l);
      applySwatch(l);
      return l;
    };
    const CHIP = [0, 1, 5, 6];
    lbl({ text: 'AI 加速器晶粒（示意）', position: [-DIE_W / 2 + 0.05, 0.02, -DIE_D / 2 - 0.05], align: 'above', kind: 'strong', priority: 30, hotspot: 'die' }, [0, 1]);
    const blockLabel = (type: BlockType, pos: [number, number, number], align: NonNullable<LabelSpec['align']>, priority: number, steps: readonly number[] = CHIP) =>
      lbl({ text: TYPE_INFO[type].short, position: pos, align, priority, hotspot: HOTSPOT_OF[type] }, steps, { swatch: PAINT[paintOfType(type)], type });
    blockLabel('compute', [-1.925, 0.3, 1.4], 'above', 22);
    blockLabel('compute', [1.925, 0.3, -1.4], 'above', 8, [0, 1]);
    blockLabel('l2', [0, 0.16, -1.15], 'above', 20);
    blockLabel('noc', [-1.925, 0.1, 2.14], 'below', 16, [0, 1]);
    blockLabel('hbm', [-2.55, 0.08, 2.9], 'below', 18);
    blockLabel('hbm', [2.55, 0.08, -2.9], 'above', 6, [0, 1]);
    blockLabel('serdes', [-IO_X - 0.2, 0.1, -0.4], 'left', 18);
    blockLabel('serdes', [IO_X + 0.2, 0.1, -1.6], 'right', 9, [0, 1]);
    blockLabel('pcie', [IO_X + 0.25, 0.1, 0.47], 'right', 17);
    blockLabel('cpu', [IO_X + 0.25, 0.12, 1.5], 'right', 17);
    blockLabel('clock', [IO_X + 0.25, 0.1, 2.14], 'right', 12);
    lbl({ text: 'HBM 堆疊（封裝內）', position: [2.55, HBM_STACK.h, DIE_D / 2 + HBM_STACK.gap + HBM_STACK.d * 0.8], align: 'below', kind: 'muted', priority: 7, hotspot: 'hbm-phy' }, [0], { swatch: 'seg:memory-storage' });
    lbl({ text: '矽中介層', position: [-INTERPOSER.w / 2, -0.2, INTERPOSER.d / 2 - 0.3], align: 'left', kind: 'tag', priority: 3 }, [0]);
    // Spec: legend of sourcing colours.
    // Same wording as the block labels' suffix. On phones the middle tag drops to a second row
    // (applyLayout): three tags side by side do not fit under a 300 px wide die.
    const srcLegend = (['custom', 'licensed', 'mixed'] as const).map((src, i) =>
      lbl({ text: SOURCING_TEXT[src], position: [(i - 1) * 2.7, 0.02, DIE_D / 2 + 0.08], align: 'below', kind: 'tag', priority: 28, offset: [0, 4] }, [1], { swatch: SOURCE_PAINT[src] }),
    );

    // RTL: the exploded SM.
    const selPart = (paint: Paint, q = 0) => flatParts.filter((p) => p.sm === layout.sel && p.paint === paint)[q]!;
    const exploded = (p: Part, dy: number): [number, number, number] => {
      const k = 1 + EXPL.k;
      const spread = k * (1 + EXPL.spread);
      return [sel.x + (p.x - sel.x) * spread, EXPL.lift + (p.y0 + p.h) * k + EXPL.gap + dy, sel.z + (p.z - sel.z) * spread];
    };
    lbl({ text: '一個 SM（放大）', position: [sel.x - 0.42, EXPL.lift + 0.12, sel.z + 0.3], align: 'left', kind: 'strong', priority: 30, hotspot: 'compute-cores' }, [2]);
    lbl({ text: 'Tensor Core', position: exploded(selPart('tensor', 0), 0.02), align: 'above', priority: 26, hotspot: 'compute-cores' }, [2], { swatch: 'seg:ai-accelerators' });
    lbl({ text: '暫存器檔', position: exploded(selPart('rf', 1), 0.01), align: 'right', priority: 25, hotspot: 'compute-cores' }, [2], { swatch: 'chart:1' });
    lbl({ text: '排程器', position: exploded(selPart('sched', 3), 0), align: 'right', priority: 24, hotspot: 'compute-cores', offset: [0, 10] }, [2], { swatch: 'flow' });
    lbl({ text: 'L1／共享記憶體', position: exploded(selPart('sram', 0), 0), align: 'below', priority: 25, hotspot: 'compute-cores', offset: [0, 6] }, [2], { swatch: 'chart:1' });
    lbl({ text: '同一份設計複製成許多 SM（示意）', position: [-1.2, 0.3, 0.35], align: 'above', kind: 'default', priority: 21 }, [2]);
    lbl({ text: 'RTL 範例：acc <= acc + a*b（每個時脈做一次乘加）', position: [sel.x - 0.45, EXPL.lift + 0.6, sel.z - 0.3], align: 'left', kind: 'default', priority: 22 }, [2]);

    // Synthesis / place & route: inset legend (follows the inset transform): cell types on the left,
    // rails and wiring on the right.
    const ins = (spec: LabelSpec, steps: readonly number[], extra: { swatch?: ColorRef; narrowText?: string } = {}) => lbl({ ...spec, object: inset }, steps, extra);
    const lx = -PLATE_W / 2 - 0.14;
    const rx = PLATE_W / 2 + 0.14;
    const insetTitle = ins({ text: '放大：一小塊標準單元（示意）', position: [-PLATE_W / 2 - 0.05, 0.05, -PLATE_D / 2 - 0.1], align: 'above', kind: 'strong', priority: 32 }, [3, 4]);
    const netlistLabel = ins({ text: '閘級網表：只有元件與連線，還沒有位置', position: [PLATE_W / 2 - 0.2, 0.25, -PLATE_D / 2 - 0.1], align: 'above', kind: 'default', priority: 31 }, [3], {
      narrowText: '閘級網表：還沒有位置',
    });
    /**
     * Side legends. Wide stages: each tag sits beside the row it describes. Narrow stages: the
     * rows are only a few px apart, so the tags get short texts and stack at a fixed pitch around
     * the plate's middle (applyLayout). `slot` is the position in that stack.
     */
    interface Legend {
      l: Lbl;
      side: -1 | 1;
      slot: number;
      wide: { position: [number, number, number]; offset: [number, number] };
    }
    const legends: Legend[] = [];
    const legend = (side: -1 | 1, slot: number, text: string, narrowText: string, swatch: ColorRef, z: number, steps: readonly number[], priority: number, dy = 0, cells = true, y = side < 0 ? 0.02 : 0.01) => {
      const position: [number, number, number] = [side < 0 ? lx : rx, y, z];
      const l = ins({ text, position, align: side < 0 ? 'left' : 'right', kind: 'tag', priority, offset: [0, dy], ...(cells ? { hotspot: 'standard-cells' } : {}) }, steps, { swatch, narrowText });
      legends.push({ l, side, slot, wide: { position, offset: [0, dy] } });
    };
    legend(-1, 0, '邏輯閘', '邏輯閘', CELL_PAINT.logic, rowZ(1), [3, 4], 27);
    legend(-1, 1, '正反器', '正反器', CELL_PAINT.ff, rowZ(3), [3, 4], 27);
    // Clock buffers do not exist yet in the synthesised netlist: CTS inserts them during P&R.
    legend(-1, 2, '緩衝器', '緩衝器', CELL_PAINT.buf, rowZ(5), [3], 27);
    legend(-1, 2, '緩衝器／時脈緩衝器', '緩衝器', CELL_PAINT.buf, rowZ(5), [4], 27);
    legend(-1, 3, '填充／去耦', '填充', CELL_PAINT.phys, rowZ(7), [4], 26);
    legend(1, 0, 'VDD 電源軌', 'VDD', 'power', railZ(0), [4], 25, 0, false);
    legend(1, 1, 'VSS 接地軌', 'VSS', 'muted', railZ(1) + 0.02, [4], 24, 6, false);
    legend(1, 2, 'M2 水平導線', 'M2', 'flow', rowZ(4), [4], 25, 0, false, Y_M2);
    legend(1, 3, 'M3 垂直導線', 'M3', 'chart:5', rowZ(6), [4], 25, 0, false, Y_M2);
    legend(1, 4, '時脈樹', '時脈樹', 'chart:2', rowZ(8), [4], 25, 0, false, Y_M2);
    const phaseLabel = labels.add({ text: '', object: inset, position: [PLATE_W / 2 - 0.2, 0.25, -PLATE_D / 2 - 0.1], align: 'above', kind: 'strong', priority: 31 });

    // Signoff.
    const pdnLabel = lbl({ text: '頂層供電網（VDD／VSS）', position: [-DIE_W / 2 + 0.15, PDN_Y, -1.4], align: 'left', kind: 'default', priority: 28, hotspot: 'power-grid' }, [5], { swatch: 'power' });
    lbl({ text: '電源凸塊（bump）', position: [2.8, PDN_Y + 0.08, 2.8], align: 'right', priority: 26, hotspot: 'power-grid' }, [5], { swatch: 'power' });
    lbl({ text: 'IR drop 熱區（示意）', position: [-1.9, 0.5, -0.55], align: 'above', priority: 27 }, [5], { swatch: 'heat' });
    lbl({ text: '簽核：時序、IR drop、DRC／LVS 都通過才能交件', position: [0, 0, -INTERPOSER.d / 2], align: 'above', kind: 'strong', priority: 31, offset: [0, -6] }, [5], {
      narrowText: '簽核：時序、IR drop、DRC／LVS',
    });

    // Tape-out.
    const mx = -DIE_W / 2 - 0.15;
    lbl({ text: '每一層圖形各做成光罩（示意）', position: [0, maskY(MASKS - 1, 1) + 0.02, -DIE_D / 2 - 0.15], align: 'above', kind: 'strong', priority: 31 }, [6]);
    // Layer names sit left of the plates; on portrait stages (no side room) they sit on the plates.
    const maskLabels = [
      lbl({ text: '電晶體（閘極）層', position: [mx, maskY(0, 1), DIE_D / 2], align: 'left', kind: 'tag', priority: 26 }, [6]),
      lbl({ text: '接點與金屬連線層', position: [mx, maskY(2, 1), DIE_D / 2], align: 'left', kind: 'tag', priority: 25 }, [6]),
      lbl({ text: '頂層金屬與凸塊', position: [mx, maskY(MASKS - 1, 1), DIE_D / 2], align: 'left', kind: 'tag', priority: 26 }, [6]),
    ];
    lbl({ text: 'GDSII／OASIS → 晶圓廠製作光罩', position: [DIE_W / 2 + 0.1, maskY(3, 1), DIE_D / 2], align: 'right', kind: 'tag', priority: 24 }, [6]);

    const applyLabels = () => {
      const st = ctx.step;
      for (const l of allLabels) {
        const on = l.steps.includes(st);
        let text = narrow && l.narrowText ? l.narrowText : l.text;
        if (l.type && st === 1) {
          const info = TYPE_INFO[l.type];
          text = `${portrait ? (info.tiny ?? info.short) : info.short}・${SOURCING_TEXT[SOURCING[l.type]]}`;
        }
        l.h.set({ visible: on, text, kind: l.type && st === 5 ? 'muted' : l.kind });
        if (l.type) l.h.set({ swatch: `#${resolve(st === 1 ? SOURCE_PAINT[SOURCING[l.type]] : PAINT[paintOfType(l.type)]).getHexString()}` });
      }
      phaseLabel.set({ visible: st === 4 });
      if (narrow && st === 4) insetTitle.h.set({ visible: false });
    };

    /* ───────── hotspots, picking, cards ───────── */
    const typeAnchor: Record<BlockType, [number, number, number]> = {
      compute: [-1.925, 0.2, 0.5],
      l2: [0, 0.1, -1.0],
      noc: [-1.925, 0.08, 1.01],
      hbm: [0, 0.06, 2.86],
      serdes: [-IO_X, 0.08, 0],
      pcie: [IO_X, 0.08, 0.47],
      cpu: [IO_X, 0.1, 1.5],
      clock: [IO_X, 0.08, 2.14],
    };
    const nearestPart = (type: BlockType, pt: Vector3 | undefined) => {
      if (!pt) return undefined;
      let best: Part | undefined;
      let bd = Infinity;
      for (const p of layout.parts) {
        if (p.type !== type || !p.rounded) continue;
        const d = (p.x - pt.x) ** 2 + (p.z - pt.z) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    };
    const partFromHit = (hit: PickHit | null): Part | undefined => {
      if (!hit) return undefined;
      if (hit.object === details && hit.instanceId !== undefined) return flatParts[hit.instanceId];
      if (hit.object === selBase) return selBasePart;
      const bm = blockMeshes.find((b) => b.mesh === hit.object);
      return bm ? nearestPart(bm.type, hit.point) : undefined;
    };
    const macroCount = {
      hbm: HBM_X.length * 2, // one PHY per HBM stack, on both long edges
      serdes: layout.parts.filter((p) => p.type === 'serdes' && p.rounded).length,
    };
    const cardFor = (type: BlockType, hit: PickHit | null): CardContent => {
      const info = TYPE_INFO[type];
      const t = hsText.get(HOTSPOT_OF[type]);
      const part = partFromHit(hit);
      let subtitle = info.en;
      if (part && type === 'compute' && part.sm !== undefined) {
        const s = layout.sms[part.sm]!;
        const inCluster = layout.sms.filter((o) => o.cluster === s.cluster).indexOf(s);
        subtitle = `叢集 ${s.cluster + 1}・第 ${inCluster + 1} 個 SM（共 ${layout.sms.length} 個，示意）`;
      } else if (part && (type === 'hbm' || type === 'serdes')) {
        const unit = type === 'hbm' ? '組' : '個';
        subtitle = `第 ${part.idx + 1} ${unit}（共 ${macroCount[type]} ${unit}，示意）・${info.en}`;
      }
      const items = [{ label: SOURCING_TEXT[SOURCING[type]], meta: 'IP 來源' }];
      if (info.vendors) items.push({ label: info.vendors, meta: '' });
      return {
        title: info.name,
        subtitle,
        body: t?.detail ?? '',
        items,
        href: info.href,
        linkLabel: info.link,
        swatch: `#${resolve(PAINT[paintOfType(type)]).getHexString()}`,
      };
    };
    const highlight = (id: string, on: boolean, after?: () => void) => {
      hotTw.get(id)?.cancel();
      const from = hot[id] ?? 0;
      hotTw.set(
        id,
        ctx.tween.run(
          (k) => {
            hot[id] = from + ((on ? 1 : 0) - from) * k;
            dirtyCity = dirtyMisc = true;
            after?.();
          },
          { duration: 220, ease: 'cubicOut', fade: true },
        ),
      );
    };

    for (const type of BLOCK_TYPES) {
      const id = HOTSPOT_OF[type];
      hotspots.register(id, {
        anchor: typeAnchor[type],
        pickable: false,
        card: (hit) => cardFor(type, hit),
        pose: TYPE_INFO[type].pose,
        onHighlight: (on) => highlight(id, on),
      });
    }
    for (const b of blockMeshes) picker.add(b.mesh, { id: HOTSPOT_OF[b.type] });
    picker.add(selBase, { id: 'compute-cores' });
    picker.add(details, { id: (h) => (h.instanceId !== undefined ? HOTSPOT_OF[flatParts[h.instanceId]?.type ?? 'compute'] : null) });

    hotspots.register('power-grid', {
      anchor: [0, PDN_Y, 0],
      pickable: false,
      pose: STEP_POSES[5]!,
      card: () => ({
        title: '供電網路（PDN）',
        subtitle: 'Power Delivery Network・IR drop',
        body: hsText.get('power-grid')?.detail ?? '',
        items: [
          { label: '自行設計（用 EDA 工具規劃與分析）', meta: '來源' },
          { label: '分析工具例：新思科技、益華電腦', meta: '' },
        ],
        href: '/glossary/#bspdn',
        linkLabel: GLOSS,
        swatch: ctx.palette.css['scene-power'] ?? '',
      }),
      onHighlight: (on) => highlight('power-grid', on),
    });
    picker.add(straps, { id: 'power-grid' });
    picker.add(bumps, { id: 'power-grid' });

    hotspots.register('standard-cells', {
      anchor: inset,
      pickable: false,
      pose: STEP_POSES[4]!,
      card: (hit) => {
        const c = hit?.object === cellMesh && hit.instanceId !== undefined ? cb.cells[hit.instanceId] : undefined;
        const name = c ? CELL_NAME[c.kind] : null;
        return {
          title: name ? name[0] : '標準單元',
          subtitle: name ? '標準單元（standard cell）' : 'Standard cells',
          body: name ? `${name[1]}所有標準單元高度相同，排成一列列 row，上下共用 VDD／VSS 電源軌。` : (hsText.get('standard-cells')?.detail ?? ''),
          items: [
            { label: SOURCING_TEXT.licensed, meta: 'IP 來源' },
            { label: '元件庫例：晶圓廠、新思科技', meta: '' },
          ],
          href: '/glossary/#eda',
          linkLabel: GLOSS,
          swatch: `#${resolve(c ? CELL_PAINT[CAT_OF[c.kind]] : CELL_PAINT.logic).getHexString()}`,
        };
      },
      onHighlight: (on) => {
        highlight('standard-cells', on, paintCells);
        // From the list: the SM that holds the cells lights up too.
        highlight('compute-cores', on);
      },
      onSelect: (source) => {
        if ((source === 'list' || source === 'keyboard') && ctx.step !== 3 && ctx.step !== 4) {
          ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index: 4 } }));
        }
      },
    });
    picker.add(cellMesh, { id: 'standard-cells' });

    hotspots.register('die', {
      anchor: [-DIE_W / 2 + 0.6, 0, -DIE_D / 2 + 0.4],
      pickable: false,
      card: () => ({
        title: 'AI 加速器晶粒',
        subtitle: 'Die・Floorplan',
        body: hsText.get('die')?.detail ?? '',
        href: '/chain/eda-ip-design/',
        linkLabel: '前往 EDA・矽智財環節 →',
      }),
      onHighlight: (on) => ctx.tween.to(ringMat, { opacity: on ? 1 : ctx.theme === 'dark' ? 0.55 : 0.75 }, { duration: 200, fade: true }),
    });
    picker.add(die, { id: 'die' });

    /* ───────── steps ───────── */
    const DIMS: readonly Partial<Record<BlockType, number>>[] = [
      {},
      {},
      { compute: 0.45, l2: 0.7, noc: 0.7, hbm: 0.7, serdes: 0.7, pcie: 0.7, cpu: 0.7, clock: 0.7 },
      { compute: 0.72, l2: 0.72, noc: 0.72, hbm: 0.72, serdes: 0.72, pcie: 0.72, cpu: 0.72, clock: 0.72 },
      { compute: 0.72, l2: 0.72, noc: 0.72, hbm: 0.72, serdes: 0.72, pcie: 0.72, cpu: 0.72, clock: 0.72 },
      { l2: 0.25, noc: 0.35, hbm: 0.35, serdes: 0.35, pcie: 0.35, cpu: 0.35, clock: 0.35 },
      { compute: 0.15, l2: 0.15, noc: 0.15, hbm: 0.15, serdes: 0.15, pcie: 0.15, cpu: 0.15, clock: 0.15 },
    ];
    let dimTween: Tween | null = null;
    const setDims = (i: number) => {
      dimFrom = { ...stepDim };
      const want = DIMS[i] ?? {};
      dimTo = { compute: 0, l2: 0, noc: 0, hbm: 0, serdes: 0, pcie: 0, cpu: 0, clock: 0, ...want };
      dimTween?.cancel();
      dimTween = ctx.tween.run(
        (k) => {
          for (const t of BLOCK_TYPES) stepDim[t] = dimFrom[t] + (dimTo[t] - dimFrom[t]) * k;
          dirtyCity = dirtyMisc = true;
        },
        { duration: 650 },
      );
    };

    const poseFor = (i: number): CameraPose => {
      const p = STEP_POSES[i];
      if (!p) return ctx.homePose;
      const pp = portrait ? PORTRAIT_POSES[i] : undefined;
      if (pp) return pp;
      const k = portrait ? (PORTRAIT_DIST[i] ?? 1) : 1;
      const dy = portrait ? (PORTRAIT_DY[i] ?? 0) : 0;
      const [tx, ty, tz] = p.target;
      const [px, py, pz] = p.position;
      return { position: [tx + (px - tx) * k, ty + (py - ty) * k + dy, tz + (pz - tz) * k], target: [tx, ty + dy, tz] };
    };
    const showStep = (i: number, first = false) => {
      const prev = curStep;
      curStep = i;
      setDims(i);
      go('flat', i === 1 ? 1 : 0, 800);
      go('src', i === 1 ? 1 : 0, 700);
      go('heat', i === 5 ? 1 : 0, 900, i === 5 ? 250 : 0);
      go('pdn', i === 5 ? 1 : 0, 700);
      go('lift', i >= 2 && i <= 4 ? 1 : 0, 900);
      go('zoom', i === 3 || i === 4 ? 1 : 0, 900, (i === 3 || i === 4) && prev < 3 ? 450 : 0);
      if (i === 4) {
        // Place & route plays from the netlist cloud (always from the start when entering).
        if (prev !== 4) S.place = 0;
        tw.place?.cancel();
        tw.place = ctx.tween.run(
          (e) => {
            S.place = e;
            dirtyInset = true;
          },
          { duration: 5200, delay: prev === 3 ? 200 : 1100, ease: 'linear' },
        );
      } else go('place', 0, i === 3 && prev === 4 ? 1000 : 0);
      go('masks', i === 6 ? 1 : 0, i === 6 ? 1800 : 500, i === 6 ? 300 : 0);
      if (i !== 2) S.wave = 0;
      waveOf.fill(0);
      if (i === 2 && !ctx.animate) staticWave();
      applyLabels();
      dirtyCity = dirtyInset = dirtyMisc = true;
      if (!first) ctx.setPose(poseFor(i));
      ctx.invalidate();
    };
    let curStep = 0;
    const staticWave = () => {
      layout.sms.forEach((s, i) => (waveOf[i] = s.cluster === sel.cluster || i === layout.sel ? 0 : 0.22));
      dirtyCity = true;
    };

    /* ───────── portrait ───────── */
    let portrait = ctx.size.portrait;
    let narrow = ctx.size.width < NARROW_W;
    const applyLayout = () => {
      labels.setMax(portrait ? 18 : 30);
      // Inset legends: beside their rows on wide stages, a short evenly spaced stack on phones.
      const n = { [-1]: 0, [1]: 0 } as Record<-1 | 1, number>;
      for (const g of legends) n[g.side] = Math.max(n[g.side], g.slot + 1);
      for (const g of legends) {
        if (!narrow) g.l.h.set({ position: g.wide.position, offset: g.wide.offset });
        else {
          // One shared anchor per column (exact pitch), centred a little below the plate's middle
          // so the top tag clears the title row (the right column more: the phase title is wider).
          g.l.h.set({ position: [g.wide.position[0] + (g.side < 0 ? 0.06 : -0.06), 0.02, 0], offset: [0, Math.round((g.slot - (n[g.side] - 1) / 2) * LEGEND_PITCH) + (g.side < 0 ? 16 : 22)] });
        }
      }
      // Wide stages: inset title above the plate's left corner, netlist / phase notes above its
      // right corner. Phones: one title row centred above the plate (the phase replaces the inset
      // title in step 4, see applyLabels) and the netlist note below the plate.
      const topLeft: Partial<LabelSpec> = { position: [-PLATE_W / 2 - 0.05, 0.05, -PLATE_D / 2 - 0.1], align: 'above', offset: [0, 0] };
      const topRight: Partial<LabelSpec> = { position: [PLATE_W / 2 - 0.2, 0.25, -PLATE_D / 2 - 0.1], align: 'above', offset: [0, 0] };
      const topMid: Partial<LabelSpec> = { position: [0, 0.05, -PLATE_D / 2 - 0.1], align: 'above', offset: [0, -6] };
      const below: Partial<LabelSpec> = { position: [0, 0, PLATE_D / 2 + 0.12], align: 'below', offset: [0, 12] };
      insetTitle.h.set(narrow ? topMid : topLeft);
      netlistLabel.h.set(narrow ? below : topRight);
      phaseLabel.set(narrow ? topMid : topRight);
      srcLegend[1]!.h.set({ offset: [0, narrow ? 4 + LEGEND_PITCH : 4] });
      for (const l of maskLabels) l.h.set(portrait ? { align: 'right', offset: [14, -2] } : { align: 'left', offset: [0, 0] });
      // No room left of the die on a 4:5 stage: the power-grid title sits above its first strap.
      pdnLabel.h.set(portrait ? { align: 'above', offset: [40, -6] } : { align: 'left', offset: [0, 0] });
      dirtyInset = true;
    };
    applyLayout();
    const relayout = () => {
      applyLayout();
      applyLabels();
    };

    /* ───────── initial state ───────── */
    applyPalette(ctx.palette);
    packets.setReduced(!ctx.animate);
    current.setReduced(!ctx.animate);
    signals.setReduced(!ctx.animate);
    showStep(ctx.step, true);

    const flush = () => {
      if (dirtyCity) {
        placeSel();
        paintCity();
        dirtyCity = false;
      }
      if (dirtyMisc) {
        applyMisc();
        dirtyMisc = false;
      }
      if (dirtyInset) {
        applyInset();
        dirtyInset = false;
      }
    };
    flush();

    return {
      update(dt, t) {
        t0 = t;
        packets.update(t);
        if (pdnGroup.visible) current.update(t);
        if (signals.object.visible) signals.update(t);
        if (ctx.animate && dt > 0) {
          if (curStep === 2) {
            // Copies of the same SM design pulse outward from the lifted one.
            for (let i = 0; i < layout.sms.length; i++) {
              if (i === layout.sel) continue;
              const w = Math.sin(t * 2.2 - smDist[i]! * 2.4);
              waveOf[i] = w > 0 ? w ** 6 * 0.75 : 0;
            }
            // Only the compute colours change per frame; a pending full repaint (tweens of the
            // sourcing / dim state) still happens in flush().
            if (!dirtyCity) paintCity(true);
          }
          if (curStep === 3 && S.zoom > 0.99 && S.place < 0.02) dirtyInset = true;
        }
        flush();
      },
      setStep(i) {
        showStep(i);
      },
      onMotion(animate) {
        packets.setReduced(!animate);
        current.setReduced(!animate);
        signals.setReduced(!animate);
        waveOf.fill(0);
        if (!animate && curStep === 2) staticWave();
        dirtyCity = dirtyInset = dirtyMisc = true;
        ctx.invalidate();
      },
      onQuality(_q, tier) {
        packets.setCount(scaleCount(PACKETS, tier, 90));
        current.setCount(scaleCount(CURRENT, tier, 60));
        signals.setCount(scaleCount(SIGNALS, tier, 24));
      },
      onPalette(p) {
        applyPalette(p);
        applyLabels();
        flush();
      },
      onResize(size) {
        const nar = size.width < NARROW_W;
        if (size.portrait !== portrait) {
          portrait = size.portrait;
          narrow = nar;
          relayout();
          // The host re-applies the home pose when the stage shape flips; keep the step's view.
          if (curStep > 0) ctx.setPose(poseFor(curStep));
          ctx.invalidate();
        } else if (nar !== narrow) {
          narrow = nar;
          relayout();
          ctx.invalidate();
        }
      },
      dispose() {
        for (const t of Object.values(tw)) t?.cancel();
        hotTw.forEach((t) => t.cancel());
        dimTween?.cancel();
        root.removeFromParent();
      },
    };
  },
});

/* ───────────────────────── helpers ───────────────────────── */

function rectGeometry(w: number, d: number, y: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-w / 2, y, -d / 2, w / 2, y, -d / 2, w / 2, y, d / 2, -w / 2, y, d / 2], 3));
  return g;
}

/** A square grid of short segments whose alpha fades with distance from the centre. */
function buildFloorGrid(radius: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 16;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
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
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  return {
    geometry,
    recolor(c: Color, alpha: number) {
      const attr = geometry.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}

/**
 * Photomask atlas (3 × 2 cells, white on transparent): each cell is one mask layer's pattern
 * drawn inside the floorplan blocks — gates (fine vertical lines), contacts (dots), M1 (vertical),
 * M2 (horizontal, as in the standard-cell inset), upper metal (vertical, wider pitch), and the
 * top-metal power grid with bumps. Neighbouring metal layers alternate direction.
 */
function buildMaskAtlas(parts: readonly Part[]) {
  const CW = 512;
  const CH = Math.round((CW * (DIE_D + 0.3)) / (DIE_W + 0.3));
  const blocks = parts.filter((p) => p.rounded && p.y0 === 0);
  return canvasTexture(CW * 3, CH * 2, (g) => {
    const sx = CW / (DIE_W + 0.3);
    for (let layer = 0; layer < 6; layer++) {
      const ox = (layer % 3) * CW;
      const oy = Math.floor(layer / 3) * CH;
      const X = (x: number) => ox + (x + (DIE_W + 0.3) / 2) * sx;
      const Y = (z: number) => oy + (z + (DIE_D + 0.3) / 2) * sx;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 2;
      g.strokeRect(X(-DIE_W / 2) + 1, Y(-DIE_D / 2) + 1, DIE_W * sx - 2, DIE_D * sx - 2);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(X(-DIE_W / 2), Y(-DIE_D / 2), DIE_W * sx, DIE_D * sx);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 1;
      for (const b of blocks) {
        const x0 = X(b.x - b.w / 2);
        const y0 = Y(b.z - b.d / 2);
        const w = b.w * sx;
        const h = b.d * sx;
        g.save();
        g.beginPath();
        g.rect(x0, y0, w, h);
        g.clip();
        g.beginPath();
        if (layer === 0) for (let x = x0 + 1; x < x0 + w; x += 3) (g.moveTo(x, y0), g.lineTo(x, y0 + h));
        else if (layer === 1) for (let y = y0 + 2; y < y0 + h; y += 4) for (let x = x0 + 2; x < x0 + w; x += 4) g.rect(x, y, 1.4, 1.4);
        else if (layer === 2) for (let x = x0 + 2; x < x0 + w; x += 4) (g.moveTo(x, y0), g.lineTo(x, y0 + h));
        else if (layer === 3) for (let y = y0 + 1; y < y0 + h; y += 3) (g.moveTo(x0, y), g.lineTo(x0 + w, y));
        else if (layer === 4) for (let x = x0 + 3; x < x0 + w; x += 7) (g.moveTo(x, y0), g.lineTo(x, y0 + h));
        if (layer === 1) g.fill();
        else g.stroke();
        g.restore();
        if (layer < 5) g.strokeRect(x0, y0, w, h);
      }
      if (layer === 5) {
        g.lineWidth = 3;
        for (let i = -5; i <= 5; i++) {
          g.beginPath();
          g.moveTo(X(i * 0.7), Y(-DIE_D / 2 + 0.15));
          g.lineTo(X(i * 0.7), Y(DIE_D / 2 - 0.15));
          g.stroke();
        }
        for (let j = -4; j <= 4; j++) {
          g.beginPath();
          g.moveTo(X(-DIE_W / 2 + 0.15), Y(j * 0.7));
          g.lineTo(X(DIE_W / 2 - 0.15), Y(j * 0.7));
          g.stroke();
        }
        for (let i = -5; i <= 5; i++)
          for (let j = -4; j <= 4; j++) {
            if ((i + j) % 2 !== 0) continue;
            g.beginPath();
            g.arc(X(i * 0.7), Y(j * 0.7), 4.5, 0, Math.PI * 2);
            g.fill();
          }
      }
    }
  });
}

/**
 * gpu-scale — scene-private helpers: palette tones, geometry builders, an instanced-part group
 * with per-instance hotspots, an emissive highlighter, the tray-front texture atlas, hotspot cards
 * and the faded floor grid. Nothing here is shared with other scenes (see proposals/scene-gpu-scale.yaml).
 */
import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  TubeGeometry,
  Vector3,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CameraPose, CardContent, CardItem, LabelHandle, Palette, SceneContext, Vec3Like } from '../../core/types';
import { toVec3 } from '../../core/tween';
import { canvasTexture, radialTexture } from '../../kit/canvasTex';
import json from './meta.json';

export type Ctx = SceneContext;
export type Tone = (p: Palette) => Color;

/* ───────────────────────── palette tones ───────────────────────── */

const mix = (a: Color, b: Color, t: number) => a.clone().lerp(b, t);
const dk = (p: Palette) => p.theme === 'dark';

/** Theme-aware tones for hardware. Hues come from the palette tokens only. */
export const T = {
  /** Rack cabinet frame: charcoal on light, slate on dark. */
  cabinet: (p: Palette) => (dk(p) ? mix(p.bg, p.muted, 0.62) : mix(p.fg, p.bg, 0.2)),
  /** Tray chassis sheet metal. */
  chassis: (p: Palette) => (dk(p) ? mix(p.bg, p.fg, 0.4) : mix(p.fg, p.bg, 0.58)),
  /** Light metal: cold plates, rails, covers. */
  metal: (p: Palette) => (dk(p) ? mix(p.bg, p.fg, 0.62) : mix(p.bg, p.muted, 0.32)),
  /** Printed circuit board. */
  pcb: (p: Palette) => (dk(p) ? mix(p.bg, p.seg['cloud-neocloud'], 0.3) : mix(p.seg['cloud-neocloud'], p.fg, 0.42)),
  /** Organic package substrate: a calm, desaturated tone of the packaging hue. */
  substrate: (p: Palette) =>
    dk(p) ? mix(p.bg, p.seg['foundry-packaging'], 0.22).lerp(p.muted, 0.32) : mix(p.muted, p.seg['foundry-packaging'], 0.3).lerp(p.bg, 0.12),
  /** Bare silicon (interposer, base die). */
  silicon: (p: Palette) => (dk(p) ? mix(p.bg, p.fg, 0.5) : mix(p.fg, p.bg, 0.5)),
  gpu: (p: Palette) => p.seg['ai-accelerators'].clone(),
  hbm: (p: Palette) => (dk(p) ? p.seg['memory-storage'].clone() : mix(p.seg['memory-storage'], p.bg, 0.16)),
  cpu: (p: Palette) => p.seg['datacenter-infra'].clone(),
  compute: (p: Palette) => p.seg['servers-systems'].clone(),
  nvswitch: (p: Palette) => p.seg['networking-optics'].clone(),
  power: (p: Palette) => p.power.clone(),
  coolant: (p: Palette) => p.coolant.clone(),
  heat: (p: Palette) => p.heat.clone(),
  optic: (p: Palette) => p.optic.clone(),
  flow: (p: Palette) => p.flow.clone(),
  sram: (p: Palette) => p.seg['cloud-neocloud'].clone(),
  muted: (p: Palette) => p.muted.clone(),
};

/** A tray / module face tinted toward a functional hue (diorama colour coding). */
export const face = (hue: Tone, k = 0.5): Tone => (p) => mix(T.chassis(p), hue(p), dk(p) ? k : k * 0.92);

/* ───────────────────────── geometry ───────────────────────── */

export function bx(w: number, h: number, d: number, x = 0, y = 0, z = 0): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y, z);
}

export function rb(w: number, h: number, d: number, r: number, x = 0, y = 0, z = 0, seg = 2): BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999).translate(x, y, z);
}

export function cyl(r: number, h: number, x = 0, y = 0, z = 0, axis: 'x' | 'y' | 'z' = 'y', seg = 10): BufferGeometry {
  const g = new CylinderGeometry(r, r, h, seg, 1);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}

/** Merge geometries that share attributes (all indexed, position/normal/uv) and dispose the inputs. */
export function merge(ctx: Ctx, geos: BufferGeometry[]): BufferGeometry {
  // RoundedBoxGeometry is non-indexed: flatten everything when the inputs are mixed.
  const mixed = geos.some((x) => x.index) && geos.some((x) => !x.index);
  const src = mixed ? geos.map((x) => (x.index ? x.toNonIndexed() : x)) : geos;
  const g = mergeGeometries(src, false);
  for (const x of new Set([...geos, ...src])) x.dispose();
  return ctx.track(g ?? new BufferGeometry());
}

/** A tube with a per-vertex colour ramp along its length (heat pickup in a coolant loop). */
export function rampTube(points: Vector3[], radius: number, segs = 64, radial = 6): { geo: TubeGeometry; curve: CatmullRomCurve3 } {
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.15);
  const geo = new TubeGeometry(curve, segs, radius, radial, false);
  geo.setAttribute('color', new Float32BufferAttribute(new Float32Array(geo.attributes['position']!.count * 3), 3));
  return { geo, curve };
}

/** Recolour a rampTube: colours sampled along u (0..1) from `stops`. */
export function paintRamp(geo: TubeGeometry, stops: readonly Color[], segs = 64, radial = 6): void {
  const col = geo.getAttribute('color') as Float32BufferAttribute;
  const c = new Color();
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const f = u * (stops.length - 1);
    const i0 = Math.min(stops.length - 1, Math.floor(f));
    c.copy(stops[i0]!).lerp(stops[Math.min(stops.length - 1, i0 + 1)]!, f - i0);
    for (let j = 0; j <= radial; j++) col.setXYZ(i * (radial + 1) + j, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
/** Compose a matrix from position, uniform-or-vector scale and a Y rotation. */
export function mat(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rotY = 0): Matrix4 {
  _q.setFromAxisAngle(_up, rotY);
  return new Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}
const _up = new Vector3(0, 1, 0);

/* ───────────────────────── instanced parts with hotspots ───────────────────────── */

export interface InstItem {
  m: Matrix4;
  tone: Tone;
  id?: string | null;
}

/** An InstancedMesh whose instances carry a palette tone and an optional hotspot id. */
export class Inst {
  readonly mesh: InstancedMesh;
  items: InstItem[];
  private readonly c = new Color();

  constructor(ctx: Ctx, geo: BufferGeometry, material: Material, items: InstItem[], capacity = items.length) {
    this.mesh = new InstancedMesh(geo, material, Math.max(1, capacity));
    this.items = items;
    this.mesh.count = items.length;
    items.forEach((it, i) => this.mesh.setMatrixAt(i, it.m));
    this.mesh.setColorAt(0, this.c);
    ctx.track({ dispose: () => this.mesh.dispose() });
  }

  setMatrices(): void {
    this.items.forEach((it, i) => this.mesh.setMatrixAt(i, it.m));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  paint(p: Palette, hot: ReadonlySet<string> | null, amount = 0.42): void {
    this.items.forEach((it, i) => {
      this.c.copy(it.tone(p));
      if (hot && it.id && hot.has(it.id)) this.c.lerp(p.highlight, amount);
      this.mesh.setColorAt(i, this.c);
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  idAt = (h: { instanceId?: number }): string | null => (h.instanceId !== undefined ? (this.items[h.instanceId]?.id ?? null) : null);
}

/* ───────────────────────── highlight ───────────────────────── */

interface Lit {
  mat: MeshStandardMaterial;
  base?: (p: Palette) => Color;
}

/** Emissive / instance-colour highlight shared by every hotspot of a variant. */
export class Highlighter {
  hot: string | null = null;
  private mats = new Map<string, Lit[]>();
  private insts: Inst[] = [];
  private extra: ((p: Palette, hot: string | null) => void)[] = [];

  /** `aliases[id]` = other hotspot ids that light up together with `id` (e.g. the whole rack). */
  constructor(
    private readonly ctx: Ctx,
    private readonly aliases: Record<string, readonly string[]> = {},
  ) {}

  addMats(id: string, mats: MeshStandardMaterial[], base?: (p: Palette) => Color): void {
    const list = this.mats.get(id) ?? [];
    for (const m of mats) list.push(base ? { mat: m, base } : { mat: m });
    this.mats.set(id, list);
  }
  addInst(...i: Inst[]): void {
    this.insts.push(...i);
  }
  onApply(fn: (p: Palette, hot: string | null) => void): void {
    this.extra.push(fn);
  }

  set(id: string, on: boolean): void {
    if (on) this.hot = id;
    else if (this.hot === id) this.hot = null;
    this.apply();
  }

  apply(): void {
    const p = this.ctx.palette;
    const k = dk(p) ? 0.5 : 0.32;
    const set = this.hot ? new Set([this.hot, ...(this.aliases[this.hot] ?? [])]) : null;
    for (const [id, list] of this.mats)
      for (const l of list) {
        if (l.base) l.mat.emissive.copy(l.base(p));
        else l.mat.emissive.setRGB(0, 0, 0);
        if (set?.has(id)) l.mat.emissive.copy(p.highlight).multiplyScalar(k);
      }
    for (const i of this.insts) i.paint(p, set);
    for (const f of this.extra) f(p, this.hot);
    this.ctx.invalidate();
  }
}

/* ───────────────────────── hotspots & cards ───────────────────────── */

const TEXT = new Map((json.hotspots ?? []).map((h) => [h.id, h]));

/** Glossary / chain links and typical participants (示意) shown inside the cards. */
const LINKS: Record<string, { href: string; label: string; items?: CardItem[]; note?: string }> = {
  'gpu-package': {
    href: '/learn/advanced-packaging-intro/',
    label: '延伸閱讀：先進封裝入門 →',
    items: [
      { label: 'CoWoS', meta: '名詞解釋', href: '/glossary/#cowos' },
      { label: '台積電', meta: '晶圓製造與 CoWoS 封裝', href: '/companies/tsmc/' },
    ],
  },
  superchip: {
    href: '/chain/ai-accelerators/',
    label: '前往 AI 晶片環節 →',
    items: [
      { label: '輝達（NVIDIA）', href: '/companies/nvidia/' },
      { label: '為什麼 AI 需要 GPU？', meta: '學習', href: '/learn/why-gpus/' },
    ],
  },
  'compute-tray': {
    href: '/chain/servers-systems/',
    label: '前往伺服器與系統環節 →',
    items: [{ label: 'AI 伺服器', meta: '名詞解釋', href: '/glossary/#ai-server' }],
  },
  'nvlink-switch': {
    href: '/glossary/#nvlink',
    label: '名詞解釋：NVLink →',
    items: [{ label: 'scale-up', meta: '名詞解釋', href: '/glossary/#scale-up' }],
  },
  'nvl72-rack': {
    href: '/glossary/#nvl72',
    label: '名詞解釋：NVL72 →',
    items: [{ label: 'AI 叢集網路：Scale-up 與 Scale-out', meta: '學習', href: '/learn/networking-for-ai/' }],
  },
  'ai-pod': {
    href: '/learn/networking-for-ai/',
    label: '延伸閱讀：Scale-up 與 Scale-out →',
    items: [{ label: 'scale-out', meta: '名詞解釋', href: '/glossary/#scale-out' }],
  },
  'sm-array': {
    href: '/learn/gpu-architecture/',
    label: '延伸閱讀：GPU 與 AI 加速器架構 →',
    items: [{ label: 'CUDA', meta: '名詞解釋', href: '/glossary/#cuda' }],
  },
  'tensor-core': {
    href: '/glossary/#tensor-core',
    label: '名詞解釋：Tensor Core →',
    items: [{ label: 'GPU 與 AI 加速器架構', meta: '學習', href: '/learn/gpu-architecture/' }],
  },
  'l2-cache': { href: '/glossary/#sram', label: '名詞解釋：SRAM →' },
  hbm: {
    href: '/learn/memory-and-hbm/',
    label: '延伸閱讀：記憶體牆與 HBM →',
    note: 'HBM 供應商',
    items: [
      { label: 'SK 海力士', href: '/companies/sk-hynix/' },
      { label: '美光', href: '/companies/micron/' },
      { label: '三星電子', href: '/companies/samsung-electronics/' },
      { label: 'TSV 矽穿孔', meta: '名詞解釋', href: '/glossary/#tsv' },
    ],
  },
  'nvlink-io': {
    href: '/glossary/#serdes',
    label: '名詞解釋：SerDes →',
    items: [{ label: '光罩尺寸上限', meta: '名詞解釋', href: '/glossary/#reticle-limit' }],
  },
  power: {
    href: '/glossary/#psu',
    label: '名詞解釋：電源供應器 →',
    note: '常見參與者（示意，非完整名單）',
    items: [
      { label: '台達電', href: '/companies/delta-electronics/' },
      { label: '光寶科', href: '/companies/lite-on/' },
      { label: '800V 直流供電', meta: '名詞解釋', href: '/glossary/#800v-dc' },
    ],
  },
  'liquid-cooling': {
    href: '/learn/datacenter-power-cooling/',
    label: '延伸閱讀：資料中心電力與散熱 →',
    note: '常見參與者（示意，非完整名單）',
    items: [
      { label: '奇鋐', meta: '冷板・液冷模組', href: '/companies/avc/' },
      { label: '雙鴻', meta: '冷板・分歧管', href: '/companies/auras/' },
      { label: '台達電', meta: 'CDU', href: '/companies/delta-electronics/' },
      { label: 'CDU', meta: '名詞解釋', href: '/glossary/#cdu' },
    ],
  },
  'cable-spine': {
    href: '/glossary/#nvlink',
    label: '名詞解釋：NVLink →',
    note: '常見參與者（示意，非完整名單）',
    items: [
      { label: '安費諾', meta: '高速線纜・連接器', href: '/companies/amphenol/' },
      { label: '貿聯-KY', meta: '線材', href: '/companies/bizlink/' },
    ],
  },
  'rack-integration': {
    href: '/chain/servers-systems/',
    label: '前往伺服器與系統環節 →',
    note: '常見參與者（示意，非完整名單）',
    items: [
      { label: '鴻海', meta: '整櫃組裝', href: '/companies/foxconn/' },
      { label: '廣達', meta: '整櫃組裝', href: '/companies/quanta/' },
      { label: '緯創・緯穎', meta: '整櫃組裝', href: '/companies/wiwynn/' },
      { label: '川湖', meta: '滑軌', href: '/companies/king-slide/' },
      { label: 'L10／L11', meta: '名詞解釋', href: '/glossary/#l10-l11' },
    ],
  },
};

export function cardFor(id: string): CardContent {
  const t = TEXT.get(id);
  const l = LINKS[id];
  const c: CardContent = { title: t?.label ?? id };
  if (t?.detail) c.body = t.detail;
  if (l) {
    c.href = l.href;
    c.linkLabel = l.label;
    if (l.items) c.items = l.items;
    if (l.note) c.subtitle = l.note;
  }
  return c;
}

/** Step index (in meta.json) that shows each hotspot best. */
export function stepOf(id: string): number {
  const where: Record<string, string> = {
    'gpu-package': 'package',
    superchip: 'superchip',
    'compute-tray': 'tray',
    'nvlink-switch': 'rack',
    'nvl72-rack': 'rack',
    'ai-pod': 'pod',
    'sm-array': 'die',
    'tensor-core': 'sm',
    'l2-cache': 'die',
    hbm: 'hbm-io',
    'nvlink-io': 'hbm-io',
    power: 'power-cooling',
    'liquid-cooling': 'power-cooling',
    'cable-spine': 'rack-explode',
    'rack-integration': 'supply-chain',
  };
  return Math.max(0, json.steps.findIndex((s) => s.id === where[id]));
}

export interface HotspotOpts {
  object?: Object3D;
  anchor?: Vec3Like | Object3D;
  pose?: CameraPose;
  pickable?: boolean;
}

/** Register a hotspot that lives in this variant (card + emissive highlight). */
export function hotspot(ctx: Ctx, hl: Highlighter, id: string, o: HotspotOpts): void {
  ctx.hotspots.register(id, {
    ...o,
    card: () => cardFor(id),
    onHighlight: (on) => hl.set(id, on),
  });
}

/**
 * Hotspots from the other variants: hovering them in the list shows their card at `anchor` (a
 * related part of this view) with a pointer to the step that shows them; selecting jumps there.
 */
export function crossHotspots(ctx: Ctx, own: readonly string[], anchor: Vec3Like | Object3D): void {
  for (const h of json.hotspots ?? []) {
    if (own.includes(h.id)) continue;
    const step = json.steps[stepOf(h.id)];
    ctx.hotspots.register(h.id, {
      anchor,
      pickable: false,
      card: () => {
        const c = cardFor(h.id);
        if (step) c.body = `${c.body ?? ''}（在「${step.title}」步驟中顯示，點選即可切換。）`;
        return c;
      },
      onSelect: () => {
        const index = stepOf(h.id);
        ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index } }));
        return true;
      },
    });
  }
}

/* ───────────────────────── floor ───────────────────────── */

/** A square grid of short segments fading out radially, plus a soft contact shadow. */
export function floor(ctx: Ctx, radius: number, step: number, y = 0): { group: Object3D[]; apply(p: Palette): void } {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx2: number, bz: number) => {
    for (let i = 0; i < pieces; i++)
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx2 - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, y, z);
        const r = Math.hypot(x, z) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.6);
      }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const g = ctx.track(new BufferGeometry());
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  const lm = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const lines = new LineSegments(g, lm);
  lines.renderOrder = -2;
  const tex = ctx.track(radialTexture(256));
  const sm = ctx.track(new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(radius * 1.5, radius * 1.1)), sm);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = y + 0.002;
  shadow.renderOrder = -1;
  for (const o of [lines, shadow]) {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  }
  return {
    group: [lines, shadow],
    apply(p) {
      const c = mix(p.grid, p.fg, dk(p) ? 0.1 : 0.05);
      const a = dk(p) ? 0.6 : 0.85;
      const attr = g.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * a);
      attr.needsUpdate = true;
      sm.color.copy(dk(p) ? p.flow : p.fg);
      sm.opacity = dk(p) ? 0.07 : 0.09;
    },
  };
}

/* ───────────────────────── tray-front texture atlas ───────────────────────── */

export const ATLAS_ROWS = ['compute', 'switch', 'power', 'mgmt', 'blank', 'net', 'rear', 'rear-power'] as const;
export type FrontKind = (typeof ATLAS_ROWS)[number];
const ROW_H = 64;

/**
 * Grayscale front-panel patterns (vents, ports, PSU fans, handles) multiplied with the material
 * colour, so they follow the theme. One 512 × 512 canvas, one row per front type.
 */
export function frontAtlas(ctx: Ctx) {
  return ctx.track(
    canvasTexture(512, 512, (g, w) => {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.fillRect(0, 0, w, 512);
      const dark = (a: number) => `rgba(0,0,0,${a})`;
      const lite = (a: number) => `rgba(255,255,255,${a})`;
      const rect = (x: number, y: number, ww: number, hh: number, a: number) => {
        g.fillStyle = dark(a);
        g.fillRect(x, y, ww, hh);
      };
      const vents = (x0: number, y0: number, x1: number, y1: number, pitch = 7, a = 0.34) => {
        for (let x = x0; x < x1 - 3; x += pitch) for (let y = y0; y < y1 - 3; y += pitch) rect(x, y, pitch - 3, pitch - 3, a);
      };
      const bevel = (y0: number) => {
        rect(0, y0, w, 2, 0.25);
        rect(0, y0 + ROW_H - 3, w, 3, 0.3);
        rect(0, y0, 3, ROW_H, 0.3);
        rect(w - 3, y0, 3, ROW_H, 0.3);
      };
      // compute: handle, NIC cages, vents, SSD bays
      let y = 0;
      rect(10, y + 14, 10, 36, 0.45);
      for (let i = 0; i < 4; i++) {
        rect(40 + i * 46, y + 16, 38, 32, 0.55);
        g.fillStyle = lite(0.35);
        g.fillRect(44 + i * 46, y + 22, 30, 8);
      }
      vents(232, y + 12, 400, y + 54);
      for (let i = 0; i < 4; i++) rect(410 + i * 22, y + 12, 16, 40, 0.42);
      rect(492, y + 14, 10, 36, 0.45);
      bevel(y);
      // switch: vents with a management port block
      y = ROW_H;
      rect(10, y + 14, 10, 36, 0.45);
      vents(34, y + 12, 220, y + 54, 7, 0.3);
      rect(232, y + 20, 48, 24, 0.5);
      vents(292, y + 12, 480, y + 54, 7, 0.3);
      rect(492, y + 14, 10, 36, 0.45);
      bevel(y);
      // power shelf: six PSUs with fans
      y = ROW_H * 2;
      for (let i = 0; i < 6; i++) {
        const x = 6 + i * 84;
        rect(x, y + 6, 80, 52, 0.12);
        g.strokeStyle = dark(0.45);
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x + 22, y + 32, 15, 0, Math.PI * 2);
        g.stroke();
        g.beginPath();
        g.arc(x + 22, y + 32, 6, 0, Math.PI * 2);
        g.stroke();
        vents(x + 44, y + 14, x + 76, y + 52, 6, 0.32);
      }
      bevel(y);
      // management switch: rows of small ports
      y = ROW_H * 3;
      for (let r = 0; r < 2; r++) for (let i = 0; i < 24; i++) rect(30 + i * 15 + (i >= 12 ? 8 : 0), y + 14 + r * 20, 11, 14, 0.55);
      vents(420, y + 12, 500, y + 54, 7, 0.3);
      bevel(y);
      // blank panel: perforation
      y = ROW_H * 4;
      vents(8, y + 8, 504, y + 58, 9, 0.18);
      bevel(y);
      // network switch: dense OSFP cages
      y = ROW_H * 5;
      for (let r = 0; r < 2; r++) for (let i = 0; i < 16; i++) rect(14 + i * 30, y + 10 + r * 24, 24, 18, 0.55);
      bevel(y);
      // tray rear (seen from behind): blind-mate NVLink connector blocks, the busbar clip and the
      // two coolant quick-disconnects
      y = ROW_H * 6;
      const conn = (x0: number) => {
        for (let i = 0; i < 2; i++) {
          const x = x0 + i * 74;
          rect(x, y + 12, 66, 40, 0.5);
          g.fillStyle = lite(0.28);
          for (let r = 0; r < 3; r++) for (let c = 0; c < 10; c++) g.fillRect(x + 5 + c * 6, y + 18 + r * 11, 3, 6);
        }
      };
      conn(20);
      conn(344);
      rect(232, y + 8, 48, 48, 0.2);
      rect(246, y + 12, 20, 40, 0.6);
      for (const cx of [196, 316]) {
        g.fillStyle = dark(0.55);
        g.beginPath();
        g.arc(cx, y + 32, 12, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = lite(0.3);
        g.beginPath();
        g.arc(cx, y + 32, 5, 0, Math.PI * 2);
        g.fill();
      }
      bevel(y);
      // power-shelf rear: AC inlets, the busbar clip and exhaust grilles
      y = ROW_H * 7;
      for (let i = 0; i < 6; i++) {
        rect(16 + i * 34, y + 18, 24, 28, 0.5);
        g.fillStyle = lite(0.3);
        g.fillRect(21 + i * 34, y + 24, 14, 6);
      }
      rect(232, y + 8, 48, 48, 0.2);
      rect(246, y + 12, 20, 40, 0.6);
      vents(300, y + 12, 500, y + 54, 7, 0.3);
      bevel(y);
    }),
  );
}

/** A front plate (facing +z) whose UVs select one atlas row. */
export function frontPlate(ctx: Ctx, kind: FrontKind, w: number, h: number): PlaneGeometry {
  const g = new PlaneGeometry(w, h);
  const row = ATLAS_ROWS.indexOf(kind);
  const v1 = 1 - (row * ROW_H) / 512;
  const v0 = 1 - ((row + 1) * ROW_H) / 512;
  const uv = g.getAttribute('uv') as Float32BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) > 0.5 ? v1 - 0.002 : v0 + 0.002);
  uv.needsUpdate = true;
  return ctx.track(g);
}

/* ───────────────────────── camera poses ───────────────────────── */

const _pa = new Vector3();
const _pb = new Vector3();

/** The same view direction and target with the camera distance multiplied by `f`. */
export function zoomPose(p: CameraPose, f: number): CameraPose {
  const t = toVec3(p.target, new Vector3());
  const pos = toVec3(p.position, new Vector3()).sub(t).multiplyScalar(f).add(t);
  return { ...p, position: [pos.x, pos.y, pos.z] };
}

/**
 * The pose for the current stage shape. The host scales every pose by |portrait| / |main| on
 * portrait stages (to keep a landscape framing in view); a scene-specific portrait pose is
 * pre-divided by that ratio so the camera lands exactly on it.
 */
export function stagePose(ctx: Ctx, land: CameraPose, port?: CameraPose | null): CameraPose {
  if (!ctx.size.portrait || !port) return land;
  const cam = ctx.meta.camera;
  if (!cam.portrait?.position) return port;
  const main = toVec3(cam.position, _pa).distanceTo(toVec3(cam.target, _pb));
  const prt = toVec3(cam.portrait.position, _pa).distanceTo(toVec3(cam.portrait.target ?? cam.target, _pb));
  return main > 0 && prt > 0 ? zoomPose(port, main / prt) : port;
}

/**
 * Camera moves for the guided tour. Level 0 returns to the home pose (pre-divided like any other
 * portrait pose, because ctx.setPose scales distances on portrait stages); the first call on mount
 * at level 0 leaves the host's home pose alone, so a stage resize right after mount (portrait
 * phones, full screen) is not overridden by a tween. An orientation flip re-frames a deep step.
 */
export function stepCamera(ctx: Ctx, land: readonly CameraPose[], port: readonly (CameraPose | null)[]) {
  let posed = false;
  let lv = 0;
  let portrait = ctx.size.portrait;
  const pose = () => (lv === 0 ? stagePose(ctx, ctx.homePose, ctx.homePose) : stagePose(ctx, land[lv]!, port[lv]));
  return {
    go(level: number): void {
      lv = level;
      if (posed || lv !== 0) ctx.setPose(pose(), { duration: 1100 });
      posed = true;
    },
    resize(size: { portrait: boolean }): void {
      if (size.portrait === portrait) return;
      portrait = size.portrait;
      if (lv !== 0) ctx.setPose(pose(), { duration: 600 });
    },
  };
}

/* ───────────────────────── portrait label placement ───────────────────────── */

export type Align = 'above' | 'below' | 'left' | 'right' | 'center';

/** Where a label goes on portrait stages (phones) when its landscape spot would leave the stage. */
export interface PortraitPlace {
  pos?: Vector3;
  align?: Align;
  /** A shorter text (the hotspot list and cards carry the full wording). */
  text?: string;
}

export interface PlacedLabel {
  h: LabelHandle;
  land: { pos: Vector3; align: Align; text: string };
  port?: PortraitPlace | undefined;
}

/** Apply the landscape or portrait placement of every label that has a portrait override. */
export function placeLabels(labs: readonly PlacedLabel[], portrait: boolean): void {
  for (const l of labs) {
    if (!l.port) continue;
    const p = portrait ? l.port : null;
    l.h.set({ position: p?.pos ?? l.land.pos, align: p?.align ?? l.land.align, text: p?.text ?? l.land.text });
  }
}

/* ───────────────────────── small utils ───────────────────────── */

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function v3(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z);
}

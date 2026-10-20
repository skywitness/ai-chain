/**
 * datacenter/kit.ts — scene-private "diorama" helpers (proposed for src/three/kit in
 * proposals/scene-datacenter.yaml):
 *
 *  - Static parts are accumulated per (zone, material) and merged into ONE mesh each, so a whole
 *    facility costs ~30 draw calls. Zones dim as a unit (guided-step focus) by re-tinting their
 *    own material instances toward the background.
 *  - Hotspots: invisible proxy boxes per part group + a highlight frame (wire box + soft fill).
 *  - Pipes along filleted polylines (TubeGeometry), PathFlow wrappers with palette-keyed colours,
 *    label groups that follow the guided step, ambient fans (one InstancedMesh).
 */
import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { scaleCount } from '../../core/quality';
import type {
  CameraPose,
  CardContent,
  LabelHandle,
  LabelSpec,
  Palette,
  PaletteKey,
  QualityTier,
  SceneContext,
  SceneHotspotJson,
} from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';
import { PathFlow } from '../../kit/PathFlow';

export type V3 = [number, number, number];
type Tone = (p: Palette) => Color;
type Kind = 'std' | 'basic' | 'glass' | 'line';

interface MatSpec {
  tone: Tone;
  kind?: Kind;
  /** [dark, light] opacity for transparent kinds. */
  op?: readonly [number, number];
  rough?: number;
  metal?: number;
  /** Emissive share of the tone (dark theme; ×0.25 on light). */
  glow?: number;
}

const mix = (a: Color, b: Color, t: number) => a.clone().lerp(b, t);
const key = (k: PaletteKey): Tone => (p) => p[k].clone();
const dk = (p: Palette) => p.theme === 'dark';

/** The material catalogue (all colours come from the palette). */
const MATS = {
  slab: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.1 : 0.075), rough: 0.9, metal: 0.02 },
  floor: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.055 : 0.03), rough: 0.95, metal: 0 },
  metal: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.44 : 0.07), rough: 0.4, metal: 0.3 },
  steel: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.27 : 0.32), rough: 0.5, metal: 0.4 },
  dark: { tone: (p) => mix(p.fg, p.bg, dk(p) ? 0.86 : 0.2), rough: 0.45, metal: 0.35 },
  power: { tone: key('power'), rough: 0.45, metal: 0.25, glow: 0.22 },
  bus: { tone: (p) => mix(p.power, mix(p.bg, p.fg, 0.45), 0.4), rough: 0.35, metal: 0.55, glow: 0.12 },
  coolant: { tone: key('coolant'), rough: 0.4, metal: 0.25, glow: 0.22 },
  heat: { tone: key('heat'), rough: 0.45, metal: 0.2, glow: 0.22 },
  it: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.52 : 0.42), rough: 0.5, metal: 0.2 },
  itBar: { tone: (p) => p.seg['ai-accelerators'].clone(), rough: 0.5, metal: 0.15, glow: 0.18 },
  chip: { tone: (p) => p.seg['ai-accelerators'].clone(), rough: 0.35, metal: 0.4, glow: 0.35 },
  pcb: { tone: (p) => mix(p.seg['cloud-neocloud'], p.bg, dk(p) ? 0.55 : 0.35), rough: 0.6, metal: 0.1 },
  led: { tone: key('flow'), kind: 'basic' },
  ledP: { tone: key('power'), kind: 'basic' },
  ledOk: { tone: key('pos'), kind: 'basic' },
  accent: { tone: (p) => p.seg['datacenter-infra'].clone(), kind: 'basic' },
  pipeC: { tone: key('coolant'), kind: 'glass', op: [0.42, 0.5] },
  pipeH: { tone: key('heat'), kind: 'glass', op: [0.42, 0.5] },
  pipeP: { tone: key('power'), kind: 'glass', op: [0.38, 0.48] },
  glassH: { tone: key('heat'), kind: 'glass', op: [0.1, 0.12] },
  glassC: { tone: key('coolant'), kind: 'glass', op: [0.2, 0.22] },
  glass: { tone: (p) => mix(p.bg, p.fg, 0.5), kind: 'glass', op: [0.07, 0.07] },
  tintC: { tone: key('coolant'), kind: 'basic', op: [0.15, 0.15] },
  tintH: { tone: key('heat'), kind: 'basic', op: [0.16, 0.13] },
  tintP: { tone: key('power'), kind: 'basic', op: [0.16, 0.14] },
  edge: { tone: (p) => mix(p.grid, p.fg, dk(p) ? 0.3 : 0.25), kind: 'line', op: [0.85, 0.9] },
  ink: { tone: (p) => mix(p.fg, p.bg, dk(p) ? 0.15 : 0.2), kind: 'line', op: [0.9, 0.9] },
  card: { tone: (p) => mix(p.bg, p.fg, dk(p) ? 0.14 : 0.04), rough: 0.7, metal: 0.05 },
  lineH: { tone: key('heat'), kind: 'line', op: [0.8, 0.85] },
  lineC: { tone: key('coolant'), kind: 'line', op: [0.8, 0.85] },
  lineP: { tone: key('power'), kind: 'line', op: [0.85, 0.9] },
} satisfies Record<string, MatSpec>;
export type MatKey = keyof typeof MATS;

interface ZoneMat {
  spec: MatSpec;
  mat: Material & { color: Color; opacity: number };
}
interface Zone {
  group: Group;
  dim: number;
  mats: Map<MatKey, ZoneMat>;
}

/** Label with the step groups it belongs to. */
interface KLabel {
  h: LabelHandle;
  text: string;
  /** Shorter text for compact (narrow) stages. */
  short: string | null;
  groups: readonly string[] | null;
  zone: string | null;
  kind: NonNullable<LabelSpec['kind']>;
  prio: number;
  swatch: Swatch | null;
}

export interface FlowDef {
  pts: readonly (V3 | Vector3)[];
  /** One palette key, or one per control point. */
  tone: PaletteKey | readonly PaletteKey[];
  w?: number;
  speed?: number;
  offset?: number;
}
interface KFlow {
  pf: PathFlow;
  defs: readonly FlowDef[];
  max: number;
  min: number;
  size: readonly [number, number];
  op: number;
  on: boolean;
  zone: string | null;
}

/** What a guided step shows. */
export interface View {
  /** World-space camera pose for the current layout (null = ctx.homePose). Scaled by the host on portrait stages. */
  pose: CameraPose | null;
  dim?: Readonly<Record<string, number>>;
  /** Visible flows (default: all). */
  flows?: readonly string[];
  /** Visible label groups (labels without groups always show). */
  labels?: readonly string[];
}

const tmpV = new Vector3();
const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const UP = new Vector3(0, 1, 0);

export class Kit {
  readonly root = new Group();
  readonly ctx: SceneContext;
  private zones = new Map<string, Zone>();
  private parts = new Map<string, BufferGeometry[]>();
  private lineParts = new Map<string, number[]>();
  private bounds = new Map<string, Box3>();
  private labelsList: KLabel[] = [];
  private flowsMap = new Map<string, KFlow>();
  private hsIds: string[] = [];
  private hsText = new Map<string, SceneHotspotJson>();
  private hl: { lines: LineSegments; fill: InstancedMesh; lineMat: LineBasicMaterial; fillMat: MeshBasicMaterial };
  private fanMesh: InstancedMesh | null = null;
  private fans: { p: Vector3; q: Quaternion; s: number; spin: number }[] = [];
  private fanAngle = 0;
  private grid: { geo: BufferGeometry; fade: number[]; mat: LineBasicMaterial } | null = null;
  private shadowMat: MeshBasicMaterial | null = null;
  private dimTween: { cancel(): void } | null = null;
  private onPal: ((p: Palette) => void)[] = [];
  /**
   * Narrow stage (phones): DOM labels keep their pixel size while the diorama shrinks, so a guided
   * step shows only the labels of its active zones (labels of dimmed zones are hidden instead of
   * muted) and long names switch to their `short` text. Set by index.ts before `apply`.
   */
  compact = false;

  constructor(ctx: SceneContext) {
    this.ctx = ctx;
    this.root.name = 'datacenter';
    ctx.scene.add(this.root);
    for (const h of (ctx.json.hotspots ?? []) as SceneHotspotJson[]) this.hsText.set(h.id, h);

    // Hotspot highlight frame: up to 24 boxes (wire edges + soft fill).
    const lineGeo = ctx.track(new BufferGeometry());
    lineGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(24 * 24 * 3), 3));
    lineGeo.setDrawRange(0, 0);
    const lineMat = ctx.track(new LineBasicMaterial({ transparent: true, toneMapped: false, depthTest: false }));
    const lines = new LineSegments(lineGeo, lineMat);
    lines.renderOrder = 20;
    lines.frustumCulled = false;
    const fillMat = ctx.track(new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide, forceSinglePass: true }));
    const fill = new InstancedMesh(ctx.track(new BoxGeometry(1, 1, 1)), fillMat, 24);
    fill.count = 0;
    fill.renderOrder = 19;
    fill.frustumCulled = false;
    ctx.track({ dispose: () => fill.dispose() });
    this.root.add(lines, fill);
    this.hl = { lines, fill, lineMat, fillMat };
  }

  /* ───────────────────────── zones & materials ───────────────────────── */

  private zone(name: string): Zone {
    let z = this.zones.get(name);
    if (!z) {
      z = { group: new Group(), dim: 0, mats: new Map() };
      z.group.name = name;
      this.root.add(z.group);
      this.zones.set(name, z);
    }
    return z;
  }

  private mat(zoneName: string, k: MatKey): ZoneMat {
    const z = this.zone(zoneName);
    let m = z.mats.get(k);
    if (!m) {
      const spec: MatSpec = MATS[k];
      const kind = spec.kind ?? 'std';
      const transparent = !!spec.op;
      let mat: ZoneMat['mat'];
      if (kind === 'line') mat = new LineBasicMaterial({ transparent, toneMapped: false });
      else if (kind === 'basic') mat = new MeshBasicMaterial({ transparent, toneMapped: false, depthWrite: !transparent, side: DoubleSide });
      else
        mat = new MeshStandardMaterial({
          roughness: spec.rough ?? (kind === 'glass' ? 0.2 : 0.45),
          metalness: spec.metal ?? (kind === 'glass' ? 0.05 : 0.3),
          transparent,
          depthWrite: !transparent,
          side: kind === 'glass' ? DoubleSide : FrontSide,
        });
      // Thin panels, tints and tubes: one pass is enough (three.js draws transparent double-sided
      // materials twice by default, which would add ~10 draw calls per variant).
      if (transparent) mat.forceSinglePass = true;
      this.ctx.track(mat);
      m = { spec, mat };
      z.mats.set(k, m);
      this.tint(m, z.dim, this.ctx.palette);
    }
    return m;
  }

  private tint(m: ZoneMat, dim: number, p: Palette): void {
    const dark = dk(p);
    const c = m.spec.tone(p);
    m.mat.color.copy(c).lerp(p.bg, 0.86 * dim);
    if (m.spec.op) m.mat.opacity = m.spec.op[dark ? 0 : 1] * (1 - 0.7 * dim);
    const std = m.mat as unknown as MeshStandardMaterial;
    if (std.isMeshStandardMaterial) {
      std.emissive.copy(c).multiplyScalar((m.spec.glow ?? 0) * (dark ? 1 : 0.25) * (1 - dim));
    }
  }

  /* ───────────────────────── geometry ───────────────────────── */

  /** Add a positioned geometry to (zone, material); `hs` = hotspot id[:sub] whose bounds it extends. */
  add(zone: string, k: MatKey, g: BufferGeometry, hs?: string): void {
    const id = `${zone}|${k}`;
    const list = this.parts.get(id) ?? [];
    list.push(g);
    this.parts.set(id, list);
    if (hs) {
      g.computeBoundingBox();
      const b = this.bounds.get(hs);
      if (b) b.union(g.boundingBox!);
      else this.bounds.set(hs, g.boundingBox!.clone());
    }
  }

  /** Box of size [w, h, d] centred at p (y = centre). r > 0 → chamfered edges. */
  box(zone: string, k: MatKey, s: V3, p: V3, o: { r?: number; ry?: number; hs?: string } = {}): void {
    const r = Math.min(o.r ?? 0, s[0] / 2.01, s[1] / 2.01, s[2] / 2.01);
    const g = r > 0.004 ? new RoundedBoxGeometry(s[0], s[1], s[2], 1, r) : new BoxGeometry(s[0], s[1], s[2]);
    if (o.ry) g.rotateY(o.ry);
    g.translate(p[0], p[1], p[2]);
    this.add(zone, k, g, o.hs);
  }

  /** Box resting on y = base (p[1] is the floor height). */
  block(zone: string, k: MatKey, s: V3, p: V3, o: { r?: number; ry?: number; hs?: string } = {}): void {
    this.box(zone, k, s, [p[0], p[1] + s[1] / 2, p[2]], o);
  }

  /** Cylinder (radius r, length h) centred at p along `axis`. */
  cyl(zone: string, k: MatKey, r: number, h: number, p: V3, o: { axis?: 'x' | 'y' | 'z'; seg?: number; r2?: number; hs?: string; open?: boolean } = {}): void {
    const g = new CylinderGeometry(r, o.r2 ?? r, h, o.seg ?? 18, 1, o.open ?? false);
    if (o.axis === 'x') g.rotateZ(Math.PI / 2);
    else if (o.axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(p[0], p[1], p[2]);
    this.add(zone, k, g, o.hs);
  }

  /** Thin strut (r = half-width) from a to b — lattice towers, braces. */
  rod(zone: string, k: MatKey, a: V3, b: V3, r: number, seg = 4): void {
    const va = new Vector3(...a);
    const d = new Vector3(...b).sub(va);
    const g = new CylinderGeometry(r, r, d.length(), seg, 1);
    g.applyQuaternion(tmpQ.setFromUnitVectors(UP, d.clone().normalize()));
    g.translate(va.x + d.x / 2, va.y + d.y / 2, va.z + d.z / 2);
    this.add(zone, k, g);
  }

  /** Pipe along a filleted polyline; returns the dense centre-line (reuse it for flows). */
  pipe(zone: string, k: MatKey, pts: readonly V3[], r: number, o: { hs?: string; fillet?: number; radial?: number } = {}): Vector3[] {
    const line = fillet(pts, o.fillet ?? Math.max(0.12, r * 3));
    const curve = new CatmullRomCurve3(line, false, 'centripetal');
    const g = new TubeGeometry(curve, Math.max(8, Math.ceil(curve.getLength() * 9)), r, o.radial ?? 8, false);
    this.add(zone, k, g, o.hs);
    return line;
  }

  /** Line segments [ax, ay, az, bx, by, bz, …]. */
  lines(zone: string, k: MatKey, seg: readonly number[]): void {
    const id = `${zone}|${k}`;
    const list = this.lineParts.get(id) ?? [];
    for (const v of seg) list.push(v);
    this.lineParts.set(id, list);
  }

  /** Dashed polyline (dash / gap lengths in world units) — standby feeds, reference lines. */
  dashed(zone: string, k: MatKey, pts: readonly V3[], dash = 0.14, gap = 0.1): void {
    const seg: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = new Vector3(...pts[i - 1]!);
      const d = new Vector3(...pts[i]!).sub(a);
      const len = d.length();
      d.normalize();
      for (let s = 0; s < len; s += dash + gap) {
        const e = Math.min(s + dash, len);
        seg.push(a.x + d.x * s, a.y + d.y * s, a.z + d.z * s, a.x + d.x * e, a.y + d.y * e, a.z + d.z * e);
      }
    }
    this.lines(zone, k, seg);
  }

  /** Outline of a box's top/bottom rectangles and vertical edges. */
  frame(zone: string, k: MatKey, s: V3, p: V3, verticals = true): void {
    const [w, h, d] = s;
    const x0 = p[0] - w / 2, x1 = p[0] + w / 2, z0 = p[2] - d / 2, z1 = p[2] + d / 2;
    const y0 = p[1], y1 = p[1] + h;
    const seg: number[] = [];
    for (const y of [y0, y1]) seg.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
    if (verticals) for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as const) seg.push(x, y0, z, x, y1, z);
    this.lines(zone, k, seg);
  }

  /** Ambient fan (4 blades) at p; axis = rotation axis. */
  fan(p: V3, r: number, axis: 'x' | 'y' | 'z' = 'y', spin = 1): void {
    const q = new Quaternion();
    if (axis === 'x') q.setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
    else if (axis === 'z') q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    this.fans.push({ p: new Vector3(...p), q, s: r, spin });
  }

  /** Merge everything added so far into meshes; build hotspot proxies. Call once. */
  build(): void {
    for (const [id, list] of this.parts) {
      const [zoneName, k] = id.split('|') as [string, MatKey];
      const m = this.mat(zoneName, k);
      const mesh = new Mesh(this.ctx.track(merge(list)), m.mat);
      if (m.spec.op) mesh.renderOrder = m.spec.kind === 'glass' ? 6 : 4;
      mesh.matrixAutoUpdate = false;
      this.zone(zoneName).group.add(mesh);
    }
    this.parts.clear();
    for (const [id, seg] of this.lineParts) {
      const [zoneName, k] = id.split('|') as [string, MatKey];
      const g = this.ctx.track(new BufferGeometry());
      g.setAttribute('position', new Float32BufferAttribute(seg, 3));
      const ls = new LineSegments(g, this.mat(zoneName, k).mat);
      ls.renderOrder = 7;
      ls.matrixAutoUpdate = false;
      this.zone(zoneName).group.add(ls);
    }
    this.lineParts.clear();
    if (this.fans.length) {
      const blade = new BoxGeometry(2, 0.08, 0.34);
      const blade2 = blade.clone().rotateY(Math.PI / 2);
      const g = this.ctx.track(merge([blade, blade2]));
      const fm = this.mat('fans', 'steel');
      this.fanMesh = new InstancedMesh(g, fm.mat, this.fans.length);
      this.ctx.track({ dispose: () => this.fanMesh?.dispose() });
      this.zone('fans').group.add(this.fanMesh);
      this.spinFans(0);
    }
    // Hotspot proxies (invisible boxes: pickable, no draw call).
    const proxyMat = this.ctx.track(new MeshBasicMaterial({ visible: false }));
    const unit = this.ctx.track(new BoxGeometry(1, 1, 1));
    const ids = new Set<string>();
    for (const [hs, b] of this.bounds) {
      const id = hs.split(':')[0]!;
      ids.add(id);
      const m = new Mesh(unit, proxyMat);
      b.getCenter(m.position);
      b.getSize(m.scale).addScalar(0.08);
      m.name = `hs:${hs}`;
      m.userData['hs'] = id;
      this.proxyGroup(id).add(m);
    }
    this.hsIds = [...ids];
  }

  private proxies = new Map<string, Group>();
  private proxyGroup(id: string): Group {
    let g = this.proxies.get(id);
    if (!g) {
      g = new Group();
      g.name = `proxy:${id}`;
      this.root.add(g);
      this.proxies.set(id, g);
    }
    return g;
  }

  private spinFans(a: number): void {
    const m = this.fanMesh;
    if (!m) return;
    this.fans.forEach((f, i) => {
      tmpQ.setFromAxisAngle(UP, a * f.spin + i * 0.7).premultiply(f.q);
      m.setMatrixAt(i, tmpM.compose(f.p, tmpQ, tmpV.set(f.s / 2, f.s / 2, f.s / 2)));
    });
    m.instanceMatrix.needsUpdate = true;
  }

  /* ───────────────────────── floor ───────────────────────── */

  /** Faded floor grid + soft contact shadow centred at (cx, cz). */
  floor(cx: number, cz: number, radius: number, y = -0.25): void {
    const pos: number[] = [];
    const fade: number[] = [];
    const step = 1;
    const n = Math.floor(radius / step);
    const add = (ax: number, az: number, bx: number, bz: number) => {
      for (let i = 0; i < 16; i++)
        for (const t of [i / 16, (i + 1) / 16]) {
          const x = ax + (bx - ax) * t;
          const z = az + (bz - az) * t;
          pos.push(cx + x, y, cz + z);
          const r = Math.hypot(x, z) / radius;
          fade.push(Math.max(0, 1 - r * r) ** 1.6);
        }
    };
    for (let i = -n; i <= n; i++) {
      add(i * step, -radius, i * step, radius);
      add(-radius, i * step, radius, i * step);
    }
    const geo = this.ctx.track(new BufferGeometry());
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
    const mat = this.ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
    const ls = new LineSegments(geo, mat);
    ls.renderOrder = -2;
    this.root.add(ls);
    this.grid = { geo, fade, mat };
    const tex = this.ctx.track(radialTexture(256));
    this.shadowMat = this.ctx.track(new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    const sh = new Mesh(this.ctx.track(new PlaneGeometry(radius * 1.7, radius * 1.7)), this.shadowMat);
    sh.rotation.x = -Math.PI / 2;
    sh.position.set(cx, y + 0.01, cz);
    sh.renderOrder = -1;
    this.root.add(sh);
  }

  /* ───────────────────────── labels ───────────────────────── */

  label(
    text: string,
    pos: V3,
    o: Omit<LabelSpec, 'text' | 'position' | 'object' | 'swatch'> & { groups?: readonly string[]; zone?: string; swatch?: Swatch; short?: string } = {},
  ): LabelHandle {
    const { groups, zone, swatch, short, ...spec } = o;
    const h = this.ctx.labels.add({ ...spec, text: this.compact && short ? short : text, position: pos, object: this.root });
    const kl: KLabel = { h, text, short: short ?? null, groups: groups ?? null, zone: zone ?? null, kind: spec.kind ?? 'default', prio: spec.priority ?? 0, swatch: swatch ?? null };
    this.labelsList.push(kl);
    if (swatch) h.set({ swatch: this.ctx.palette.css[cssOf(swatch)] ?? '' });
    return h;
  }

  /* ───────────────────────── flows ───────────────────────── */

  flow(
    name: string,
    defs: readonly FlowDef[],
    o: { count: number; min?: number; size?: readonly [number, number]; speed?: number; op?: number; zone?: string; seed?: number; fade?: number; sv?: number },
  ): PathFlow {
    const p = this.ctx.palette;
    const pf = this.ctx.track(
      new PathFlow({
        paths: defs.map((d) => ({ points: d.pts, color: tones(d.tone, p), weight: d.w ?? 1, speed: d.speed ?? 1, offset: d.offset ?? 0 })),
        count: o.count,
        size: (o.size ?? [0.07, 0.055])[dk(p) ? 0 : 1],
        sizeVariance: 0.3,
        speed: o.speed ?? 0.8,
        speedVariance: o.sv ?? 0.18,
        fadeEnds: o.fade ?? 0.04,
        theme: this.ctx.theme,
        seed: o.seed ?? 5,
      }),
    );
    const f: KFlow = { pf, defs, max: o.count, min: o.min ?? 40, size: o.size ?? [0.07, 0.055], op: o.op ?? 1, on: true, zone: o.zone ?? null };
    pf.setCount(scaleCount(o.count, this.ctx.tier, f.min));
    pf.setReduced(!this.ctx.animate);
    pf.setOpacity(f.op);
    this.root.add(pf.object);
    this.flowsMap.set(name, f);
    return pf;
  }

  /* ───────────────────────── hotspots ───────────────────────── */

  card(id: string): CardContent {
    const h = this.hsText.get(id);
    const c: CardContent = { title: h?.label ?? id };
    if (h?.detail) c.body = h.detail;
    if (h?.glossary) {
      c.href = `/glossary/#${h.glossary}`;
      c.linkLabel = '名詞解釋 →';
    } else if (h?.href) {
      c.href = h.href;
      c.linkLabel = h.href.startsWith('/learn/') ? '延伸閱讀 →' : h.href.startsWith('/chain/') ? '產業鏈環節 →' : '了解更多 →';
    }
    return c;
  }

  /** World-space centre of a hotspot's parts (after root transforms). */
  center(id: string): Vector3 {
    const b = new Box3();
    for (const [hs, bb] of this.bounds) if (hs === id || hs.startsWith(`${id}:`)) b.union(bb);
    this.root.updateMatrixWorld(true);
    return this.root.localToWorld(b.getCenter(new Vector3()));
  }

  /**
   * Register every hotspot that has parts. `poseFor(id, centre, size)` gives the focus pose for the
   * current orientation (the host scales its distance on portrait stages). Call again after a
   * layout change: registering replaces the previous entry.
   */
  registerHotspots(poseFor: (id: string, c: Vector3, size: number) => CameraPose): void {
    for (const id of this.hsIds) {
      const b = new Box3();
      const boxes: Box3[] = [];
      for (const [hs, bb] of this.bounds)
        if (hs === id || hs.startsWith(`${id}:`)) {
          b.union(bb);
          boxes.push(bb);
        }
      const c = this.center(id);
      const pose = poseFor(id, c, b.getSize(tmpV).length());
      this.ctx.hotspots.register(id, {
        object: this.proxyGroup(id),
        anchor: c,
        card: () => this.card(id),
        onHighlight: (on) => this.highlight(on ? boxes : null),
        // Clicking a part opens its card (with the glossary / chapter link inside) instead of
        // leaving the page: several links point at the chapter that hosts this very scene.
        onSelect: () => {
          const card = this.card(id);
          this.ctx.card.show(card, c, { interactive: true });
          this.ctx.announce(`已選取：${card.title}${card.body ? `。${card.body}` : ''}`);
          this.ctx.invalidate();
          return true;
        },
        pose,
      });
    }
    // Hotspots without parts in this variant (the list is shared by all variants): register the
    // card only, so a list click shows the same text and glossary / chapter link as elsewhere.
    for (const id of this.hsText.keys()) if (!this.hsIds.includes(id)) this.ctx.hotspots.register(id, { card: () => this.card(id), pickable: false });
  }

  private highlight(boxes: Box3[] | null): void {
    const { lines, fill } = this.hl;
    const arr = (lines.geometry.getAttribute('position') as Float32BufferAttribute).array as Float32Array;
    let n = 0;
    let i = 0;
    for (const b of (boxes ?? []).slice(0, 24)) {
      const lo = b.min.clone().subScalar(0.05);
      const hi = b.max.clone().addScalar(0.05);
      const c = [lo, hi];
      for (const [a, bb] of EDGES) {
        for (const v of [a, bb]) {
          arr[i++] = c[v & 1]!.x;
          arr[i++] = c[(v >> 1) & 1]!.y;
          arr[i++] = c[(v >> 2) & 1]!.z;
        }
      }
      fill.setMatrixAt(n++, tmpM.compose(lo.clone().add(hi).multiplyScalar(0.5), tmpQ.identity(), hi.clone().sub(lo)));
    }
    lines.geometry.getAttribute('position').needsUpdate = true;
    lines.geometry.setDrawRange(0, n * 24);
    fill.count = n;
    fill.instanceMatrix.needsUpdate = true;
    this.ctx.invalidate();
  }

  /**
   * A pose authored in root-local (landscape) space → world. When the layout is turned for a
   * portrait stage, the target follows the layout and the camera keeps the home viewing direction.
   */
  worldPose(p: CameraPose, distScale = 1): CameraPose {
    if (this.root.rotation.y === 0) return p;
    const h = this.ctx.homePose;
    const dir = new Vector3(...(h.position as V3)).sub(new Vector3(...(h.target as V3))).normalize();
    const t = new Vector3(...(p.target as V3));
    const dist = new Vector3(...(p.position as V3)).distanceTo(t) * distScale;
    this.root.updateMatrixWorld(true);
    const tw = this.root.localToWorld(t);
    const pw = tw.clone().addScaledVector(dir, dist);
    return { position: [pw.x, pw.y, pw.z], target: [tw.x, tw.y, tw.z] };
  }

  /* ───────────────────────── steps ───────────────────────── */

  apply(v: View, poseNow = true): void {
    // Zones: tween dims.
    this.dimTween?.cancel();
    const zs = [...this.zones.entries()];
    const from = zs.map(([, z]) => z.dim);
    const to = zs.map(([n]) => v.dim?.[n] ?? 0);
    this.dimTween = this.ctx.tween.run(
      (e) => {
        zs.forEach(([, z], i) => {
          z.dim = from[i]! + (to[i]! - from[i]!) * e;
          for (const m of z.mats.values()) this.tint(m, z.dim, this.ctx.palette);
        });
        for (const f of this.flowsMap.values()) this.flowOpacity(f);
      },
      { duration: 650, fade: true },
    );
    // Flows: show / hide.
    for (const [name, f] of this.flowsMap) {
      f.on = !v.flows || v.flows.includes(name);
      f.pf.object.visible = f.on;
      this.flowOpacity(f);
    }
    // Labels: groups + zone emphasis (compact stages drop the labels of dimmed zones).
    for (const l of this.labelsList) {
      const dimmed = !!l.zone && (v.dim?.[l.zone] ?? 0) > 0.4;
      const vis = (!l.groups || !v.labels || l.groups.some((g) => v.labels!.includes(g))) && !(this.compact && dimmed);
      l.h.set({
        visible: vis,
        text: this.compact && l.short ? l.short : l.text,
        kind: dimmed && l.kind !== 'strong' ? 'muted' : l.kind,
        priority: l.prio - (dimmed ? 20 : 0),
      });
    }
    if (poseNow) this.ctx.setPose(v.pose ?? this.home());
  }

  /** ctx.homePose, landing exactly where the variant's camera meta puts it (see `exact`). */
  home(): CameraPose {
    return this.exact(this.ctx.homePose);
  }

  /**
   * A pose that lands exactly as authored: `ctx.setPose` scales every pose by |portrait| / |main|
   * on portrait stages, so a pose authored for the portrait stage (or the portrait home pose) is
   * pre-divided by that factor here.
   */
  exact(pose: CameraPose): CameraPose {
    const cam = this.ctx.meta.camera;
    if (!this.ctx.size.portrait || !cam.portrait?.position) return pose;
    const main = v3(cam.position).distanceTo(v3(cam.target));
    const port = v3(cam.portrait.position).distanceTo(v3(cam.portrait.target ?? cam.target));
    if (!(main > 0 && port > 0)) return pose;
    const t = v3(pose.target);
    const p = v3(pose.position).sub(t).multiplyScalar(main / port).add(t);
    return { ...pose, position: [p.x, p.y, p.z] };
  }

  private flowOpacity(f: KFlow): void {
    const z = f.zone ? this.zones.get(f.zone) : undefined;
    f.pf.setOpacity(f.op * (1 - 0.8 * (z?.dim ?? 0)));
  }

  /* ───────────────────────── lifecycle ───────────────────────── */

  /** Register an extra palette hook (variant-specific objects). */
  onPalette(fn: (p: Palette) => void): void {
    this.onPal.push(fn);
  }

  palette(p: Palette): void {
    const dark = dk(p);
    for (const z of this.zones.values()) for (const m of z.mats.values()) this.tint(m, z.dim, p);
    for (const f of this.flowsMap.values()) {
      f.pf.recolor((i) => tones(f.defs[i]!.tone, p));
      f.pf.setTheme(p.theme);
      f.pf.setSize(f.size[dark ? 0 : 1]);
    }
    for (const l of this.labelsList) if (l.swatch) l.h.set({ swatch: p.css[cssOf(l.swatch)] ?? '' });
    if (this.grid) {
      const c = mix(p.grid, p.fg, dark ? 0.08 : 0.04);
      const a = dark ? 0.42 : 0.5;
      const attr = this.grid.geo.getAttribute('color') as Float32BufferAttribute;
      this.grid.fade.forEach((f, i) => attr.setXYZW(i, c.r, c.g, c.b, f * a));
      attr.needsUpdate = true;
    }
    if (this.shadowMat) {
      this.shadowMat.color.copy(dark ? p.flow : p.fg);
      this.shadowMat.opacity = dark ? 0.07 : 0.08;
    }
    this.hl.lineMat.color.copy(p.highlight);
    this.hl.lineMat.opacity = 0.95;
    this.hl.fillMat.color.copy(p.highlight);
    this.hl.fillMat.opacity = dark ? 0.1 : 0.12;
    for (const fn of this.onPal) fn(p);
  }

  update(dt: number, t: number): void {
    for (const f of this.flowsMap.values()) f.pf.update(t);
    if (this.fanMesh && dt > 0) {
      this.fanAngle += dt * 2.2;
      this.spinFans(this.fanAngle);
    }
  }

  motion(animate: boolean): void {
    for (const f of this.flowsMap.values()) f.pf.setReduced(!animate);
  }

  quality(tier: QualityTier): void {
    for (const f of this.flowsMap.values()) f.pf.setCount(scaleCount(f.max, tier, f.min));
  }

  dispose(): void {
    this.dimTween?.cancel();
    this.root.removeFromParent();
  }
}

/* ───────────────────────── helpers ───────────────────────── */

/** 12 box edges as pairs of corner indices (bit0 = x, bit1 = y, bit2 = z). */
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Label swatch: a palette key or a segment colour (`seg:<id>`). */
export type Swatch = PaletteKey | `seg:${string}`;
const CSS_KEY: Partial<Record<PaletteKey, string>> = {
  bg: 'scene-bg', fg: 'scene-fg', grid: 'scene-grid', muted: 'scene-muted', highlight: 'scene-highlight', flow: 'scene-flow',
  power: 'scene-power', heat: 'scene-heat', coolant: 'scene-coolant', optic: 'scene-optic', twAccent: 'scene-tw-accent',
  pos: 'c-pos', neg: 'c-neg', accent: 'c-accent',
};
const cssOf = (k: Swatch): string => (k.startsWith('seg:') ? `seg-${k.slice(4)}` : (CSS_KEY[k as PaletteKey] ?? 'scene-fg'));

function tones(t: PaletteKey | readonly PaletteKey[], p: Palette): Color | Color[] {
  return typeof t === 'string' ? p[t as PaletteKey].clone() : (t as readonly PaletteKey[]).map((k) => p[k].clone());
}

/** A Vec3Like (tuple or Vector3) as a fresh Vector3. */
export const v3 = (p: CameraPose['position']): Vector3 => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2]));
/** Polyline with rounded corners (quadratic fillets sampled densely). */
export function fillet(pts: readonly V3[], r: number): Vector3[] {
  const v = pts.map((p) => new Vector3(...p));
  if (v.length < 3) return v;
  const out: Vector3[] = [v[0]!];
  for (let i = 1; i < v.length - 1; i++) {
    const a = v[i - 1]!, b = v[i]!, c = v[i + 1]!;
    const la = a.distanceTo(b), lc = c.distanceTo(b);
    const k = Math.min(r, la * 0.45, lc * 0.45);
    const p0 = b.clone().add(a.clone().sub(b).setLength(k));
    const p1 = b.clone().add(c.clone().sub(b).setLength(k));
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const q = p0.clone().multiplyScalar((1 - t) * (1 - t)).add(b.clone().multiplyScalar(2 * (1 - t) * t)).add(p1.clone().multiplyScalar(t * t));
      out.push(q);
    }
  }
  out.push(v[v.length - 1]!);
  // Densify long straight runs so Catmull-Rom stays straight between fillets.
  const dense: Vector3[] = [out[0]!];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!, b = out[i]!;
    const n = Math.min(8, Math.floor(a.distanceTo(b) / 0.6));
    for (let s = 1; s <= n; s++) dense.push(a.clone().lerp(b, s / (n + 1)));
    dense.push(b);
  }
  return dense;
}

/** Merge geometries into one non-indexed position + normal geometry (disposes the inputs). */
function merge(list: BufferGeometry[]): BufferGeometry {
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of flat) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of flat) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += c;
  }
  for (const g of new Set([...list, ...flat])) g.dispose();
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

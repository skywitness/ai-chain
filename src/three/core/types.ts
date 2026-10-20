/**
 * Scene contract shared by the engine (src/three/core), the kit (src/three/kit) and every scene
 * module (src/three/scenes/<id>/index.ts). Read docs/SCENE-CONTRACT.md for the guide.
 *
 * This file is type-only except for `defineScene()` (an identity helper), so importing it never
 * pulls three.js into a chunk.
 */
import type {
  Color,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LayerId, SegmentId } from '../../schemas/common';

export type { LayerId, SegmentId };

/* ───────────────────────────── quality, theme, state ───────────────────────────── */

/** Rendering tier. `off` (no WebGL 2, or the reader turned 3D off) never reaches a scene. */
export type Quality = 'high' | 'medium' | 'low';
export type ThemeName = 'light' | 'dark';

/**
 * Host lifecycle. `data-state` on `<ai-scene>` mirrors it.
 * poster → loading → running ⇄ paused → disposed; any state may go to error / contextlost.
 * `fallback` = no WebGL 2 (or 3D disabled): the poster and the HTML equivalents stay.
 */
export type HostState =
  | 'poster'
  | 'loading'
  | 'running'
  | 'paused'
  | 'error'
  | 'contextlost'
  | 'fallback'
  | 'disposed';

/** Budget numbers for a quality tier (see core/quality.ts TIERS). */
export interface QualityTier {
  readonly dprCap: number;
  readonly antialias: boolean;
  /** Max simultaneously visible LabelLayer labels. */
  readonly maxLabels: number;
  /** Multiplier for particle / instance counts (high = 1). */
  readonly particles: number;
  /** Draw-call and triangle ceilings for this tier. */
  readonly calls: number;
  readonly tris: number;
  /** Frame cap in fps for continuous loops (0 = display rate). */
  readonly fpsCap: number;
}

export type Vec3Like = Vector3 | readonly [number, number, number];

/* ───────────────────────────── meta ───────────────────────────── */

/** Mirrors src/schemas/scene.ts (meta.json). Kept structural so a JSON import type-checks. */
export interface SceneStep {
  id: string;
  title: string;
  caption: string;
  variant?: string;
}
export interface SceneHotspotJson {
  id: string;
  label: string;
  detail?: string;
  glossary?: string;
  /** Site-relative path WITHOUT the base, e.g. "/chain/memory-storage/". */
  href?: string;
}
export interface SceneJson {
  id: string;
  title: string;
  description: string;
  variants: string[];
  defaultVariant: string;
  steps?: SceneStep[];
  hotspots?: SceneHotspotJson[];
  data: string;
  loop: string;
  budgetKB: number;
}

export interface CameraPose {
  position: Vec3Like;
  target: Vec3Like;
  /** Vertical field of view in degrees at a 16:9 stage (see SceneCameraSpec.fov). */
  fov?: number;
}

export interface SceneCameraSpec extends CameraPose {
  /** Vertical FOV (deg) at 16:9. Narrower stages widen it to keep the horizontal extent. Default 40. */
  fov?: number;
  near?: number;
  far?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Polar clamp in radians (0 = straight down from above). */
  minPolar?: number;
  maxPolar?: number;
  minAzimuth?: number;
  maxAzimuth?: number;
  /** Pose used when the stage is portrait (aspect < 1), e.g. on phones. */
  portrait?: Partial<CameraPose>;
}

/** Runtime half of a scene's metadata (the JSON half lives in meta.json). */
export interface SceneMeta {
  camera: SceneCameraSpec;
  /** 'orbit' (default) | 'orbit-limited' (no zoom, tight polar clamp) | 'none'. */
  controls?: 'orbit' | 'orbit-limited' | 'none';
  /** Slow auto-rotation when motion is allowed. `true` = speed 0.4; a number = OrbitControls speed. */
  autoRotate?: boolean | number;
  /** Overrides meta.json `loop`. 'continuous' renders every frame while visible and playing. */
  loop?: 'continuous' | 'demand';
  /** Allow panning (default false). */
  pan?: boolean;
  /** High-tier ceilings checked by tests. */
  budget: { calls: number; tris: number };
  /** Per-variant overrides of the fields above. */
  variants?: Record<string, Partial<Omit<SceneMeta, 'variants' | 'budget'>>>;
}

/* ───────────────────────────── palette ───────────────────────────── */

export type PaletteKey =
  | 'bg'
  | 'fg'
  | 'grid'
  | 'muted'
  | 'highlight'
  | 'flow'
  | 'power'
  | 'heat'
  | 'coolant'
  | 'optic'
  | 'twAccent'
  | 'pos'
  | 'neg'
  | 'accent';

export interface Palette extends Readonly<Record<PaletteKey, Color>> {
  readonly theme: ThemeName;
  readonly seg: Readonly<Record<SegmentId, Color>>;
  readonly layer: Readonly<Record<LayerId, Color>>;
  /** --chart-1 … --chart-8 (index 0 = --chart-1). */
  readonly chart: readonly Color[];
  /** Resolved CSS colour strings by token name without the leading dashes, e.g. css['seg-energy-power']. */
  readonly css: Readonly<Record<string, string>>;
}

/** A colour that follows the theme. Strings: a PaletteKey, `seg:<id>`, `layer:<id>` or `chart:<1-8>`. */
export type ColorRef =
  | PaletteKey
  | `seg:${SegmentId}`
  | `layer:${LayerId}`
  | `chart:${number}`
  | ((p: Palette) => Color);

/* ───────────────────────────── services ───────────────────────────── */

export interface Disposable {
  dispose(): void;
}

export interface Rng {
  /** Uniform [0, 1). Seeded (mulberry32) so posters and tests are deterministic. */
  (): number;
  range(min: number, max: number): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Standard normal (Box–Muller). */
  normal(): number;
}

export type EaseName = 'linear' | 'cubicInOut' | 'cubicOut' | 'quadOut' | 'quadInOut' | 'backOut';
export type Ease = (k: number) => number;

export interface TweenOptions {
  /** Milliseconds. Default 700. Forced to 0 (a cut) under reduced motion unless `fade` is set. */
  duration?: number;
  ease?: Ease | EaseName;
  delay?: number;
  /** A short fade that is kept (≤150 ms) under reduced motion instead of becoming a cut. */
  fade?: boolean;
  onComplete?: () => void;
}
export interface Tween {
  cancel(): void;
  readonly done: Promise<void>;
}
export interface Tweener {
  /** Calls fn(k) with the eased progress 0→1 on every frame until done. */
  run(fn: (k: number) => void, opts?: TweenOptions): Tween;
  /** Tweens numeric properties of `target`. */
  to<T extends object>(target: T, to: Partial<Record<keyof T, number>>, opts?: TweenOptions): Tween;
  vec3(v: Vector3, to: Vec3Like, opts?: TweenOptions): Tween;
  color(c: Color, to: Color, opts?: TweenOptions): Tween;
  /** Moves camera + controls target (and optionally fov). Default 700 ms cubicInOut. */
  camera(pose: CameraPose, opts?: TweenOptions): Tween;
  cancelAll(): void;
  readonly active: number;
}

export interface Materials {
  /** Resolve a ColorRef against the current palette (a new Color). */
  color(ref: ColorRef): Color;
  /** Unlit "diagram" family (MeshBasicMaterial, toneMapped false). */
  basic(ref: ColorRef, params?: import('three').MeshBasicMaterialParameters): import('three').MeshBasicMaterial;
  /** Lit "hardware" family (MeshStandardMaterial, metalness .35, roughness .45 by default). */
  standard(
    ref: ColorRef,
    params?: import('three').MeshStandardMaterialParameters,
  ): import('three').MeshStandardMaterial;
  /** Translucent enclosure (transparent, depthWrite false). Opacity default 0.16. */
  glass(
    ref: ColorRef,
    opacity?: number,
    params?: import('three').MeshStandardMaterialParameters,
  ): import('three').MeshStandardMaterial;
  line(ref: ColorRef, params?: import('three').LineBasicMaterialParameters): import('three').LineBasicMaterial;
  /**
   * Keep `material[prop]` (a Color) in sync with the palette. `adjust` may tweak the resolved colour
   * (e.g. multiply for emissive). Returns the material, tracked for disposal.
   */
  bind<M extends import('three').Material>(
    material: M,
    prop: string,
    ref: ColorRef,
    adjust?: (c: Color, p: Palette) => void,
  ): M;
}

export interface LabelSpec {
  text: string;
  /** World position, or a local offset when `object` is set. */
  position?: Vec3Like;
  /** Follow this object's world matrix. */
  object?: Object3D;
  /** Higher wins collisions. Default 0. */
  priority?: number;
  /** Style: 'default' chip, 'strong' (bold, larger), 'muted', 'tag' (small caps-like). */
  kind?: 'default' | 'strong' | 'muted' | 'tag';
  /** CSS colour of the leading swatch (e.g. palette.css['seg-memory-storage']). */
  swatch?: string;
  /** Where the label box sits relative to the anchor. Default 'center'. */
  align?: 'center' | 'above' | 'below' | 'left' | 'right';
  /** Extra pixel offset [x, y] (y down). */
  offset?: readonly [number, number];
  /** Skip collision culling (still counts toward the visible budget). */
  always?: boolean;
  visible?: boolean;
  /** Optional hotspot id: the label lights up while that hotspot is highlighted. */
  hotspot?: string;
}
export interface LabelHandle {
  set(patch: Partial<LabelSpec>): void;
  remove(): void;
  /** Whether the label was placed in the last layout pass. */
  readonly shown: boolean;
}
export interface LabelLayer {
  add(spec: LabelSpec): LabelHandle;
  clear(): void;
  /** Return true when the world point is hidden (e.g. behind a globe). */
  setOccluder(fn: ((world: Vector3, camera: PerspectiveCamera) => boolean) | null): void;
  /** Override the tier's visible-label budget. */
  setMax(n: number): void;
  readonly count: number;
}

export interface PickHit {
  object: Object3D;
  instanceId?: number;
  point: Vector3;
  /** Hotspot id resolved from the picker registration (or null). */
  id: string | null;
  /** Index for screen-space point sets. */
  index?: number;
}
export interface PickOptions {
  /** Hotspot id for every hit, or a resolver from instanceId / child object. */
  id?: string | ((hit: { object: Object3D; instanceId?: number }) => string | null);
  /** Raycast children too (default true). */
  recursive?: boolean;
}
export interface ScreenPoint {
  position: Vector3;
  id: string | null;
}
export interface Picker {
  /** Make an object (and its children) pickable. Returns an unregister function. */
  add(object: Object3D, opts?: PickOptions): () => void;
  /**
   * Screen-space picking for markers/points (≤ 1000): nearest within 18 px (mouse) / 28 px (touch).
   * `cull(world)` → true to skip (e.g. back of a globe).
   */
  addPoints(
    points: () => readonly ScreenPoint[],
    opts?: { cull?: (world: Vector3) => boolean },
  ): () => void;
  onHover(cb: (hit: PickHit | null, ev: PointerEvent) => void): () => void;
  onClick(cb: (hit: PickHit | null, ev: PointerEvent) => void): () => void;
  /** Synchronous pick at client coordinates. */
  pick(clientX: number, clientY: number, touch?: boolean): PickHit | null;
}

export interface CardItem {
  label: string;
  meta?: string;
  href?: string;
}
export interface CardContent {
  title: string;
  subtitle?: string;
  body?: string;
  items?: CardItem[];
  /** Site-relative path (base is added automatically) or absolute URL. */
  href?: string;
  linkLabel?: string;
  /** CSS colour for the title swatch. */
  swatch?: string;
}
export interface CardApi {
  /**
   * Show next to a world point or a stage-relative pixel position. `interactive` cards accept the
   * pointer and render `href` as a link; other cards show 「點擊…」 unless `hint: false`.
   */
  show(content: CardContent, at: Vec3Like | { x: number; y: number }, opts?: { interactive?: boolean; hint?: boolean }): void;
  hide(): void;
  readonly visible: boolean;
}

export interface HotspotSpec {
  /** Object used for the default highlight and as the anchor when `anchor` is not set. */
  object?: Object3D;
  /** World anchor for cards and focus moves. Default: object's bounding-box centre. */
  anchor?: Vec3Like | Object3D;
  /** Make `object` pickable with this hotspot id (default true when object is given). */
  pickable?: boolean;
  /** Overrides meta.json / Scene3D label, detail and href. */
  label?: string;
  detail?: string;
  href?: string;
  /** Rich card for hover / select. Receives the pick hit when triggered by the pointer. */
  card?: (hit: PickHit | null) => CardContent | null;
  /** Custom highlight. Default: a gentle scale-up of `object`. */
  onHighlight?: (on: boolean) => void;
  /** Custom select. Return true to suppress the default (navigate if href, else open the card). */
  onSelect?: (source: HotspotSource) => boolean | void;
  /** Camera pose used by `focus` (list click, scene:command focus). */
  pose?: CameraPose;
}
export type HotspotSource = 'pointer' | 'touch' | 'list' | 'command' | 'keyboard';
export interface HotspotRegistry {
  register(id: string, spec: HotspotSpec): () => void;
  highlight(id: string | null, source?: HotspotSource): void;
  select(id: string, source?: HotspotSource): void;
  /** Highlight + move the camera to the hotspot pose (if any). */
  focus(id: string | null, source?: HotspotSource): void;
  readonly hovered: string | null;
  readonly selected: string | null;
  ids(): string[];
}

/* ───────────────────────────── context / instance / module ───────────────────────────── */

export interface StageSize {
  width: number;
  height: number;
  aspect: number;
  portrait: boolean;
}

export interface SceneContext<D = unknown> {
  readonly id: string;
  /** The <ai-scene> element. */
  readonly root: HTMLElement;
  /** Positioned container holding the canvas and overlays. */
  readonly stage: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly json: SceneJson;
  readonly meta: SceneMeta;
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** null when meta.controls is 'none'. Disabled (not null) inline on touch devices. */
  readonly controls: OrbitControls | null;

  /** Current variant (live). */
  readonly variant: string;
  /** Current step index (live). */
  readonly step: number;
  /** Validated page data, the fixture, or null. */
  readonly data: D | null;
  /** True when `data` came from src/three/fixtures (the stage shows 「示意資料」). */
  readonly isFixture: boolean;

  readonly quality: Quality;
  readonly tier: QualityTier;
  /** OS / site preference for reduced motion (live). */
  readonly reducedMotion: boolean;
  /** Whether ambient animation is currently playing (false when reduced and not opted in, or paused). */
  readonly animate: boolean;
  readonly palette: Palette;
  readonly theme: ThemeName;
  readonly size: StageSize;
  /** import.meta.env.BASE_URL (always ends with "/"). */
  readonly base: string;
  /** Aborted on dispose: pass to addEventListener({ signal }). */
  readonly signal: AbortSignal;

  readonly labels: LabelLayer;
  readonly picker: Picker;
  readonly hotspots: HotspotRegistry;
  readonly tween: Tweener;
  readonly materials: Materials;
  readonly card: CardApi;
  readonly rng: Rng;

  /** Request one frame (demand loop). Cheap; call freely. */
  invalidate(): void;
  /** Track a disposable (geometry, material, texture, kit object…) for automatic disposal. */
  track<T extends Disposable>(o: T): T;
  /** Base-aware internal URL: href('/chain/x/') → '/<base>/chain/x/'. Absolute URLs pass through. */
  href(path: string): string;
  /** Navigate (dispatches cancelable scene:navigate first). */
  navigate(path: string, opts?: { newTab?: boolean }): void;
  /** Dispatch `scene:<type>` (bubbling) from the <ai-scene> element. */
  emit(type: string, detail?: unknown): void;
  /** Polite screen-reader announcement. */
  announce(text: string): void;
  /**
   * Smoothly move the camera (instant under reduced motion). On portrait stages the distance is
   * scaled by |camera.portrait| / |camera| so landscape-authored poses still frame their subject.
   */
  setPose(pose: CameraPose, opts?: TweenOptions): Tween;
  /** Default pose for the current variant and stage shape (use it for the 總覽 step). */
  readonly homePose: CameraPose;
  /** World → stage pixel coordinates (null when behind the camera). */
  project(world: Vec3Like): { x: number; y: number } | null;
}

export interface SceneInstance {
  /**
   * Called before every rendered frame. `dt`/`t` are the ANIMATION clock in seconds: frozen (dt = 0)
   * while motion is off. Return true to request another frame in demand mode.
   */
  update?(dt: number, t: number): boolean | void;
  /** Go to guided step `index` (0 = 總覽). The host already switched variant if the step names one. */
  setStep?(index: number, step: SceneStep | undefined): void;
  /** Switch variant in place. Omit it (or return false) and the host remounts the scene instead. */
  setVariant?(variant: string): boolean | void;
  onPalette?(p: Palette): void;
  onQuality?(q: Quality, tier: QualityTier): void;
  /** Ambient motion turned on/off (reduced motion, 暫停／播放). */
  onMotion?(animate: boolean): void;
  onResize?(size: StageSize): void;
  dispose?(): void;
}

export interface SceneModule<D = unknown> {
  /** The scene's meta.json (import json from './meta.json'). */
  json: SceneJson;
  meta: SceneMeta;
  /** Type guard for page data. If it fails (or no data), `fixture` is loaded. */
  guard?: (data: unknown) => data is D;
  /** Lazy fixture: () => import('../../fixtures/<id>.json'). */
  fixture?: () => Promise<{ default: unknown }>;
  create(ctx: SceneContext<D>): SceneInstance | Promise<SceneInstance>;
}

/** Identity helper that gives scene modules full type inference. */
export function defineScene<D = unknown>(mod: SceneModule<D>): SceneModule<D> {
  return mod;
}

/* ───────────────────────────── element / test hooks ───────────────────────────── */

export interface SceneStats {
  frames: number;
  drawCalls: number;
  triangles: number;
  quality: Quality | null;
  state: HostState;
  variant: string;
  step: number;
  geometries: number;
  textures: number;
  animate: boolean;
  loop: 'continuous' | 'demand';
  /** High-tier ceilings from the scene's runtime meta (null before load). */
  budget: { calls: number; tris: number } | null;
  /** True when the scene runs on fixture data (「示意資料」). */
  fixture: boolean;
}

export type SceneCommand =
  | { type: 'focus'; id: string | null }
  | { type: 'select'; id: string }
  | { type: 'step'; index: number }
  | { type: 'variant'; variant: string }
  | { type: 'reset' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'load' };

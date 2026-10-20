# 3D Scene Contract (for scene agents)

This is the working contract for every scene in `src/three/scenes/<id>/`. It is precise on purpose:
if this document and an older design note disagree, **this document and `docs/SCENES.md` win**
(`research/design/scenes3d.md` is background reading).

Two exemplar scenes set the quality bar. Read them before you start:

- `src/three/scenes/neural-net/` — a concept scene: real computation (a tiny MLP), guided steps that
  switch variants, `PathFlow` in `'once'` mode, instanced meshes, a static reduced-motion state,
  hotspots with per-instance cards, a portrait layout.
- `src/three/scenes/chain-panorama/` — a data-driven scene: page data with a type guard and a fixture,
  `PathFlow` loops with colour ramps, label placement on a crowded layout, hover cards with company
  lists, click-to-navigate, step focus (dimming), two variants with different camera and labels.

Open them in the sandbox: `http://127.0.0.1:4321/dev/scenes/neural-net/` and `/dev/scenes/chain-panorama/`.

---

## 1. What you own and what you never touch

You write **only** `src/three/scenes/<id>/**` (and `src/three/fixtures/<id>.json` if your scene takes
data). The folder name **must** equal the scene id from `SCENE_IDS` in `src/schemas/common.ts`.

Nothing registers a scene: the engine discovers `/src/three/scenes/*/index.ts` with
`import.meta.glob`, and `Scene3D.astro` / the sandbox read `/src/three/scenes/*/meta.json`.

Never edit `src/three/core/**`, `src/three/kit/**`, `src/components/scene/**` or the sandbox. If you
need a new kit helper or an engine feature, write `proposals/<your-label>.yaml` (what, why, the API
you want) and meanwhile implement it locally inside your scene folder.

## 2. Folder layout

```
src/three/scenes/<id>/
  meta.json      the JSON half of the metadata (validated by src/schemas/scene.ts)
  index.ts       export default defineScene({...})   ← the scene module
  *.ts           optional helpers (geometry builders, simulation, layout) — scene-private
src/three/fixtures/<id>.json   optional illustrative data for data-driven scenes
```

Keep everything procedural: no downloaded models, no image files, no fonts. zh-TW text is **never**
geometry or a texture — it goes through the LabelLayer (`ctx.labels`) or the card (`ctx.card`).

## 3. `meta.json`

Schema: `src/schemas/scene.ts` (strict — no extra keys).

| field | type | notes |
|---|---|---|
| `id` | scene id | must equal the folder name |
| `title` | string | zh-TW scene name; shown on the poster and as the accessible name |
| `description` | string ≥ 80 chars | complete text alternative (screen readers, no-WebGL readers). Describe what is shown and what it teaches, not how to use the mouse. Rendered in 「場景文字說明」. |
| `variants` | string[] ≥ 1 | e.g. `["forward", "backprop"]` (docs/SCENES.md lists yours) |
| `defaultVariant` | string | one of `variants` |
| `steps` | `{ id, title, caption, variant? }[]` | guided tour 由淺入深. Step 0 is always 「總覽」. `title` ≤ 6 characters reads best on the toolbar; `caption` is 1–2 sentences. `variant` forces that variant when the step is selected (and a deep link `?step=` starts in it). |
| `hotspots` | `{ id, label, detail?, glossary?, href? }[]` | static hotspots → the HTML 「場景重點」 list. `href` is site-relative **without** the base (`"/chain/memory-storage/"`). |
| `data` | `none \| segments \| companies \| models \| trends \| taiwan \| curriculum \| custom` | page data shape (docs/SCENES.md) |
| `loop` | `continuous \| demand` | `continuous` only if something moves on its own (flows, simulations) |
| `budgetKB` | int ≤ 60 | gzip budget of your scene chunk (target ≤ 30) |

Minimal example:

```json
{
  "id": "hbm",
  "title": "HBM 堆疊與頻寬",
  "description": "（至少 80 字的完整文字說明……）",
  "variants": ["hbm", "hierarchy"],
  "defaultVariant": "hbm",
  "steps": [
    { "id": "overview", "title": "總覽", "caption": "……" },
    { "id": "tsv", "title": "矽穿孔", "caption": "……" },
    { "id": "hierarchy", "title": "記憶體階層", "caption": "……", "variant": "hierarchy" }
  ],
  "hotspots": [
    { "id": "base-die", "label": "基底晶粒", "detail": "……" },
    { "id": "dram-die", "label": "DRAM 晶粒", "detail": "……" }
  ],
  "data": "none",
  "loop": "continuous",
  "budgetKB": 30
}
```

Rules for text: Traditional Chinese, Taiwan usage (`docs/STYLE-zh-TW.md`), full-width punctuation,
half-width space between CJK and Latin/digits. **No industry numbers** in meta or code: numbers come
from page `data`, or are explicitly marked 「示意」 in a hotspot `detail`.

## 4. `index.ts` — the scene module

```ts
import json from './meta.json';
import { defineScene } from '../../core/types';

export default defineScene<MyData>({
  json,                 // meta.json (typed structurally)
  meta: { ... },        // runtime half: camera, controls, loop, budget (SceneMeta below)
  guard: isMyData,      // optional: type guard for page data
  fixture: () => import('../../fixtures/<id>.json'), // optional, lazy
  create(ctx) {         // build the scene; may be async
    ...
    return { update, setStep, setVariant, onPalette, onQuality, onMotion, onResize, dispose };
  },
});
```

### 4.1 `SceneMeta` (runtime metadata)

```ts
interface SceneMeta {
  camera: {
    position: Vec3Like; target: Vec3Like;   // Vec3Like = Vector3 | [x, y, z]
    fov?: number;            // vertical FOV in degrees AT 16:9 (default 40). Narrower stages widen
                             // it automatically to keep the horizontal extent.
    near?: number; far?: number;            // default 0.1 / 200
    minDistance?: number; maxDistance?: number;   // default 0.45× / 2.2× the start distance
    minPolar?: number; maxPolar?: number;   // radians from +Y; default 0.12 … 0.52π
    minAzimuth?: number; maxAzimuth?: number;
    portrait?: Partial<CameraPose>;         // pose for portrait stages (aspect < 1); its fov is
                                            // specified at 4:5
  };
  controls?: 'orbit' | 'orbit-limited' | 'none';  // default 'orbit'; 'orbit-limited' = no zoom
  autoRotate?: boolean | number;   // true = 0.4; number = OrbitControls speed. Off under reduced motion.
  loop?: 'continuous' | 'demand';  // overrides meta.json loop
  pan?: boolean;                   // default false
  budget: { calls: number; tris: number };  // high-tier ceilings, checked by the test suite
  variants?: Record<string, Partial<Omit<SceneMeta, 'variants' | 'budget'>>>;  // per-variant overrides
}
```

### 4.2 `SceneInstance` (what `create` returns)

All members are optional.

```ts
interface SceneInstance {
  update?(dt: number, t: number): boolean | void;
  setStep?(index: number, step: SceneStep | undefined): void;
  setVariant?(variant: string): boolean | void;
  onPalette?(p: Palette): void;
  onQuality?(q: Quality, tier: QualityTier): void;
  onMotion?(animate: boolean): void;
  onResize?(size: StageSize): void;
  dispose?(): void;
}
```

- **`update(dt, t)`** runs before every rendered frame. `dt`/`t` are the **animation clock** in
  seconds: when motion is off (reduced motion, or the reader pressed 暫停動畫) `dt` is 0 and `t` is
  frozen. Drive ambient animation from them only. Return `true` to ask for another frame in
  `demand` mode (rarely needed: tweens and damping already keep frames coming).
- **`setStep(i, step)`** is called after create (with the initial step) and whenever the reader
  changes step. If the step names a variant, the host has already switched variant. Typical work:
  `ctx.setPose(...)`, dim/undim parts, show more labels. Step 0 should return to `ctx.homePose`.
- **`setVariant(v)`** switches in place. **Omit it** (or return `false`) and the host disposes and
  re-creates your scene with the new variant — the simplest correct choice for variants that
  share little geometry.
- **`onPalette(p)`** after a theme switch. Materials made through `ctx.materials` are already
  updated; re-tint anything else (instance colours, kit objects: `flow.recolor(...)`,
  `flow.setTheme(p.theme)`, `glows.setTheme(...)`, `lights.apply(p)`).
- **`onQuality(q, tier)`** when the adaptive governor drops or raises the tier: scale particle /
  instance counts (`flow.setCount(scaleCount(MAX, tier))`).
- **`onMotion(animate)`** when ambient motion turns on/off: `flow.setReduced(!animate)`, show a
  static state.
- **`onResize(size)`** — `{ width, height, aspect, portrait }` in CSS px. Switch to a portrait
  layout if you have one.
- **`dispose()`** — remove what you added (`root.removeFromParent()`), cancel your own timers.
  Everything passed to `ctx.track()`, everything from `ctx.materials`, and every geometry /
  material / texture still in `ctx.scene` is disposed by the host anyway (DisposableBag +
  `deepDispose`). The dev build warns if geometries or textures leak.

## 5. `ctx` — the SceneContext API

```ts
interface SceneContext<D> {
  // identity & three.js
  id: string; root: HTMLElement /* <ai-scene> */; stage: HTMLElement; canvas: HTMLCanvasElement;
  json: SceneJson; meta: SceneMeta /* merged with the current variant's overrides */;
  renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera;
  controls: OrbitControls | null;   // null when meta.controls === 'none'

  // live state (getters)
  variant: string; step: number;
  data: D | null; isFixture: boolean;
  quality: 'high' | 'medium' | 'low'; tier: QualityTier;
  reducedMotion: boolean;  // the OS/site preference
  animate: boolean;        // ambient motion currently on
  palette: Palette; theme: 'light' | 'dark';
  size: { width; height; aspect; portrait };
  base: string;            // import.meta.env.BASE_URL, ends with '/'
  signal: AbortSignal;     // aborted on dispose — use for addEventListener(..., { signal })

  // services
  labels: LabelLayer; picker: Picker; hotspots: HotspotRegistry; card: CardApi;
  tween: Tweener; materials: Materials; rng: Rng;

  // helpers
  invalidate(): void;                          // request a frame (demand loop); cheap
  track<T extends { dispose(): void }>(o: T): T;
  href(path: string): string;                  // '/chain/x/' → '<base>chain/x/'; idempotent
  navigate(path: string, opts?: { newTab?: boolean }): void;  // fires cancelable scene:navigate
  emit(type: string, detail?: unknown): void;  // dispatches `scene:<type>` (bubbles)
  announce(text: string): void;                // polite screen-reader message
  setPose(pose: CameraPose, opts?: TweenOptions): Tween;  // camera move; a cut under reduced motion;
                                               // distance auto-scaled on portrait stages
  homePose: CameraPose;                        // default pose for this variant + stage shape
  project(world: Vec3Like): { x: number; y: number } | null;  // world → stage px
}
```

### 5.1 Palette and materials (theme)

`ctx.palette` holds `THREE.Color`s resolved from CSS tokens (works with any CSS colour syntax):

| key | token | meaning |
|---|---|---|
| `bg fg grid muted` | `--scene-bg/-fg/-grid/-muted` | surfaces, text-like ink, grid lines |
| `highlight` | `--scene-highlight` | hover / selection / "active" |
| `flow power heat coolant optic` | `--scene-flow/…` | data, electricity, heat, coolant, optics |
| `twAccent` | `--scene-tw-accent` | Taiwan highlight |
| `pos neg accent` | `--c-pos/--c-neg/--c-accent` | growth, decline, UI accent |
| `seg[<segment-id>]` | `--seg-*` | 14 segment hues |
| `layer[<layer-id>]` | `--layer-*` | 5 layer hues |
| `chart[0..7]` | `--chart-1…8` | categorical |
| `css['<token>']` | — | resolved CSS strings, e.g. `palette.css['seg-memory-storage']` for label swatches |

Never write hex colours in a scene. Make materials through `ctx.materials` so they follow the theme
automatically:

```ts
ctx.materials.standard('seg:memory-storage')            // lit hardware (metalness .35, roughness .45)
ctx.materials.basic('flow', { transparent: true })      // unlit diagram colour (toneMapped false)
ctx.materials.glass('layer:silicon', 0.18)              // translucent enclosure, depthWrite false
ctx.materials.line('grid', { transparent: true, opacity: 0.6 })
ctx.materials.bind(myMaterial, 'emissive', 'highlight', (c, p) => c.multiplyScalar(p.theme === 'dark' ? 0.4 : 0.1))
ctx.materials.color('chart:3')                          // a resolved Color (not live)
```

A `ColorRef` is a palette key (`'fg'`, `'heat'` …), `'seg:<id>'`, `'layer:<id>'`, `'chart:<1-8>'`
or `(p: Palette) => Color`.

Lighting: `addStudioLights(ctx.scene, ctx.palette)` from `../../core/lights` (hemisphere + key +
rim, tuned per theme); call `lights.apply(p)` in `onPalette`. No shadow maps.

Design language: a clean technical diorama. Rounded low-poly forms, translucent glass for
containers, saturated segment colours for the subject, muted grid/floor for context, glow halos
(`GlowSprites`) instead of bloom. Additive glow reads on dark; on light, use normal blending and
slightly smaller, more opaque marks (every kit module does this via `setTheme`). Check both themes.

### 5.2 Labels (`ctx.labels`)

Pooled DOM labels projected each frame, with a collision grid and priorities. They are
`aria-hidden` (the hotspot list and description carry the text for assistive tech).

```ts
const h = ctx.labels.add({
  text: 'HBM3E',
  object: mesh,             // follow this object (position becomes a local offset)…
  position: [0, 0.6, 0],    // …or a world position when no object is given
  align: 'above',           // 'center' | 'above' | 'below' | 'left' | 'right'
  offset: [0, -4],          // extra px
  kind: 'default',          // 'default' | 'strong' (titles) | 'muted' | 'tag' (small)
  swatch: ctx.palette.css['seg-memory-storage'],  // leading colour dot
  priority: 10,             // higher wins collisions
  always: false,            // skip collision culling
  hotspot: 'hbm-stack',     // lights up while that hotspot is highlighted (and is always shown)
});
h.set({ text: '…', visible: false });   // update; text changes re-render only when different
h.remove();
ctx.labels.setOccluder((world, camera) => globe.isBehind(world, camera));  // hide back-side labels
ctx.labels.setMax(20);                  // override the tier budget (40 / 24 / 12)
```

Placement tips from the exemplars: give titles priority 30, primary labels 10–20, decorations
≤ 5; on crowded rows alternate `above` / `below` / `right`; shorten 3D label text (the hotspot list
and cards carry the full names); check 320 px and 1280 px.

### 5.3 Hotspots, picking and cards

Every pickable thing must have an entry in the HTML hotspot list (keyboard and screen-reader
equivalent). The list comes from `meta.json` `hotspots` plus the page's `hotspots` prop; register the
3D side with the same ids:

```ts
ctx.hotspots.register('base-die', {
  object: baseDieMesh,            // default highlight target + anchor; pickable by default
  anchor: [0, 1.2, 0],            // optional world anchor (or an Object3D) for cards/focus
  pickable: true,
  card: (hit) => ({ title: '基底晶粒', body: '……', items: [{ label: 'SK 海力士' }], href: '/chain/memory-storage/' }),
  onHighlight: (on) => { /* custom highlight; default = gentle scale-up of `object` */ },
  onSelect: (source) => { /* return true to suppress default (navigate if href, else open card) */ },
  pose: { position: [3, 2, 4], target: [0, 1, 0] },  // used by list click / scene:command focus
});
```

Behaviour you get for free: hover (mouse) → highlight + card + `aria-current` on the list item +
`scene:hotspot {id, action:'hover'}`; click → navigate when the hotspot has an `href` (Ctrl/⌘ = new
tab) or open an interactive card + announce; on touch the first tap opens the interactive card with
the link; list hover/focus/click mirrors all of it; Esc closes the card.

Picking helpers when a hotspot covers many parts or instances:

```ts
ctx.picker.add(instancedMesh, { id: ({ instanceId }) => hotspotIdFor(instanceId) });  // InstancedMesh → hotspot
ctx.picker.add(proxyMesh, { id: 'rack' });   // invisible proxy: keep mesh.visible = true, set material.visible = false
ctx.picker.addPoints(() => globe.points(), { cull: (w) => globe.isBehind(w, ctx.camera) }); // ≤ 1000 markers
ctx.picker.onHover((hit, ev) => …); ctx.picker.onClick((hit, ev) => …);   // raw access if needed
ctx.card.show({ title, body }, worldPointOrPx, { interactive: true }); ctx.card.hide();
```

`card(hit)` receives the pick hit (with `instanceId` / `index`) so one hotspot can show
per-instance details (see neural-net's neuron cards).

### 5.4 Tweens and camera

```ts
ctx.tween.run((k) => { … }, { duration: 600, ease: 'cubicInOut' });
ctx.tween.to(material, { opacity: 0.2 }, { duration: 200, fade: true });   // fade: kept (≤150 ms) under reduced motion
ctx.tween.vec3(obj.position, [0, 1, 0]);
ctx.tween.color(material.color, ctx.palette.highlight);
ctx.setPose({ position: [4, 3, 6], target: [0, 1, 0] });                  // = tween.camera with portrait fit
```

Tweens run on real time (they work while ambient motion is paused) and become instant cuts under
reduced motion (except `fade: true`). Every tween returns `{ cancel(), done }`.

### 5.5 Seeded randomness

Use `ctx.rng` (mulberry32 seeded from the scene id and `?seed=`), never `Math.random()`, so posters,
screenshots and tests are deterministic: `ctx.rng()`, `ctx.rng.range(a, b)`, `ctx.rng.int(n)`,
`ctx.rng.pick(arr)`, `ctx.rng.normal()`.

## 6. Data and fixtures

Data-driven scenes (`meta.json` `data` ≠ `none`) receive the page payload serialised by
`<Scene3D data={…}>`. Shapes are listed in `docs/SCENES.md` → 「頁面資料（data）形狀」.

```ts
interface Campus { name: string; lat: number; lon: number; operator: string; mw: number | null; status: string }
interface CloudData { campuses: Campus[] }
const isCloudData = (d: unknown): d is CloudData =>
  !!d && typeof d === 'object' && Array.isArray((d as CloudData).campuses) &&
  (d as CloudData).campuses.every((c) => typeof c.name === 'string' && Number.isFinite(c.lat) && Number.isFinite(c.lon));

export default defineScene<CloudData>({
  json, meta,
  guard: isCloudData,
  fixture: () => import('../../fixtures/cloud-globe.json'),
  create(ctx) { const campuses = ctx.data?.campuses ?? []; … },
});
```

- If page data is missing or fails the guard (a console **warning**, not an error), the fixture is
  loaded and the stage shows 「示意資料」 (`ctx.isFixture === true`).
- Fixtures are for development only: plausible, clearly illustrative, no invented precise figures.
- Never `fetch` at runtime. The only runtime assets are the generated geo files, loaded lazily:
  `Globe.create()` imports `src/data/geo/land-dots.json`; import `src/data/geo/taiwan.json` with a
  dynamic `import()` inside `create` so it stays out of other chunks.
- Links inside data are site-relative without the base; pass them through `ctx.href()` (cards do it
  for you).

## 7. Kit modules (`src/three/kit/`)

All custom GLSL lives in the kit. Construct, add `.object` / `.group` to your scene, and
`ctx.track(...)` the instance. Each has `dispose()`.

### PathFlow — particle flows along paths (one draw call)
```ts
import { PathFlow, type FlowPath } from '../../kit/PathFlow';
const flow = ctx.track(new PathFlow({
  paths: [{ points: [[0,0,0],[1,2,0],[2,3,1]], color: [cA, cB, cC] /* or one Color */, weight: 1, speed: 1, offset: 0 }],
  count: scaleCount(1500, ctx.tier), // total particles (high-tier count × tier factor)
  size: 0.07, sizeVariance: 0.35, speed: 0.9 /* world units/s */, speedVariance: 0.15,
  smooth: true /* Catmull-Rom */, samples: 64, mode: 'loop' /* | 'once' */, fadeEnds: 0.06,
  opacity: 1, theme: ctx.theme, byLength: true, seed: 7,
  onceOffsets: [0, -0.05, -0.1],     // 'once' mode: per-particle offsets (comets)
}));
ctx.scene.add(flow.object);
flow.update(t);            // in update(): loop mode follows the animation clock
flow.setTime(s);           // 'once' mode choreography: t = s·speed/length + offset, hidden outside 0..1
flow.setReduced(!ctx.animate);   // static evenly spaced dotted streams
flow.recolor((i) => colorsFor(i, p)); flow.setTheme(p.theme); flow.setSize(0.06); flow.setOpacity(0.8);
flow.setCount(n);          // quality changes (any prefix samples every path)
```

### ArcRibbons — instanced arcs (one draw call)
```ts
const arcs = ctx.track(new ArcRibbons({ count: 64, mode: 'planar' /* | 'globe' */, radius: 1, up: [0,1,0], segments: 32, flow: 0.4, theme: ctx.theme }));
arcs.setArcs([{ start, end, height: 0.5, width: 0.02, color, alpha: 1, progress: 1 }]);
arcs.setProgress(i, k); arcs.setAlpha(i, a); arcs.setColor(i, c); arcs.setWidth(i, w);
arcs.update(t); arcs.setTheme(theme); arcs.setOpacity(o);
```

### GlowSprites — additive halos (fake bloom)
```ts
const glows = ctx.track(new GlowSprites({ count: 20, theme: ctx.theme }));
glows.set(i, position, diameter, color, alpha); glows.setAlpha(i, a); glows.setSize(i, d);
glows.setColor(i, c); glows.setCount(n); glows.setTheme(theme); glows.setOpacity(o);
```

### ExplodedStack — layers driven by an explode value
```ts
const stack = ctx.track(new ExplodedStack({ layers: [{ object: substrate, label: '載板' }, …], gap: 0.6, axis: 'y', explode: 0 }));
ctx.scene.add(stack.group);
stack.set(0.5); stack.animateTo(1, ctx.tween); stack.anchor(i) /* world point at the +X edge */;
```

### Axes3D — linear/log axes with HTML ticks
```ts
const axes = ctx.track(new Axes3D({
  size: [6, 3, 3],
  x: { label: '每百萬 token 價格（美元，對數）', domain: [0.05, 100], scale: 'log' },
  y: { label: '能力指數', domain: [0, 100], ticks: 5 },
  z: { label: '開放程度', domain: [0, 1], ticks: [0, 0.5, 1], format: (v) => `${v}` },
  grid: ['xz', 'xy'], labels: ctx.labels, materials: ctx.materials,
}));
ctx.scene.add(axes.group); const p = axes.map(price, capability, openness);
```

### Globe — dotted land, ocean, atmosphere, markers
```ts
import { Globe, latLonToVec3, vec3ToLatLon } from '../../kit/Globe';
const globe = ctx.track(await Globe.create({ materials: ctx.materials, palette: ctx.palette, radius: 1,
  density: ctx.quality === 'high' ? 1 : ctx.quality === 'medium' ? 0.6 : 0.4 }));
ctx.scene.add(globe.group);
globe.setMarkers([{ id: 'tsmc', lat: 24.77, lon: 121.0, color, height: 0.05, size: 0.008 }]); // same 0.25° bucket → stacked
ctx.picker.addPoints(() => globe.points(), { cull: (w) => globe.isBehind(w, ctx.camera) });
ctx.labels.setOccluder((w, cam) => globe.isBehind(w, cam));
ctx.setPose(globe.poseFor(25, 121, 3.2));   // fly to
globe.setPalette(p);                         // in onPalette (atmosphere is dark-theme only)
```
Coordinates: y up, lon 0 faces +z, east is +x.

### projectTw — Taiwan projection (shared with scripts/gen-geo.ts)
```ts
import { projectTw, unprojectTw, twToVec3 } from '../../kit/projectTw';
const [x, y] = projectTw(120.97, 24.78);     // 1 unit = 100 km, origin 23.7°N 120.95°E, y = north
mesh.position.set(...twToVec3(x, y, 0.1));   // onto the XZ plane (y up)
const tw = (await import('../../../data/geo/taiwan.json')).default;
// tw.groups.{main, penghu, kinmen, matsu, islets}: flat [x0,y0,x1,y1,…] outer rings (already projected)
// tw.borders: county border polylines; tw.counties: [{ id, name, en, x, y }] label anchors; tw.bbox
```
Kinmen and Matsu are far west/north in true position: draw them as labelled insets.
Credit line for the caption: 「資料來源：內政部國土測繪中心」.

### canvasTex — procedural textures
```ts
canvasTexture(w, h, (g, w, h) => { … })   // CanvasTexture (sRGB)
radialTexture(128)                          // soft white→transparent disc (contact shadows, glows)
await textTexture('2nm', { color: '#fff', height: 64 })   // Latin/digits only, never CJK
```

### Other helpers
- `scaleCount(n, ctx.tier, min?)` from `../../core/quality` — scale a high-tier count.
- `addStudioLights(scene, palette)` from `../../core/lights`.
- `SEGMENT_IDS`, `LAYER_IDS`, `SEGMENT_LAYER` from `../../core/ids` (do **not** import values from
  `src/schemas/*` in client code: that pulls Zod into the bundle; `import type` is fine).
- `deepDispose(object3D)`, `DisposableBag` from `../../core/dispose`.

## 8. Budgets

| | high | medium | low |
|---|---|---|---|
| DPR cap | 2 | 1.5 | 1 |
| Draw calls | ≤ 150 | ≤ 100 | ≤ 60 |
| Triangles | ≤ 500k | ≤ 200k | ≤ 80k |
| Particles (tier factor) | ×1 | ×0.45 | ×0.15 |
| Visible labels | 40 | 24 | 12 |
| Frame cap (continuous) | display | display | 30 fps |

- Your `meta.budget` is your **own** high-tier ceiling; the test fails above it. The exemplars use
  `{ calls: 30, tris: 60_000 }` (neural-net, 12 calls) and `{ calls: 60, tris: 80_000 }`
  (chain-panorama, 39 calls).
- Scene chunk ≤ 30 KB gzip (hard cap 45; meta `budgetKB`). The exemplars are 10–13 KB including the
  kit modules they use.
- Use `InstancedMesh` for anything with > 50 copies, one `LineSegments` for many lines, kit modules for
  particles/arcs/halos. Static meshes: `matrixAutoUpdate = false` after placing them.
- No per-frame allocations in `update()` (module-level scratch vectors), ≤ 4 ms per frame.
- Mount (create + first frame) ≤ 300 ms; build big buffers in chunks if needed.
- The adaptive governor (continuous scenes, auto quality only) lowers DPR, then calls
  `onQuality('low')`. Implement `onQuality` if you have particles.

## 9. Motion and accessibility

- `ctx.animate === false` when the reader prefers reduced motion (`prefers-reduced-motion`,
  `html[data-motion="reduce"]`, `?motion=reduce`) or pressed 暫停動畫. Then: no ambient motion, no
  auto-rotation (host), `PathFlow.setReduced(true)`, and each step shows its **final state**
  statically (see `showStatic()` in neural-net). The test asserts the frame counter stops.
- 播放動畫 lets the reader opt in for that scene only; you get `onMotion(true)`.
- Every fact taught in 3D must also be in text: `description`, step captions, hotspot `detail`, and
  the page prose. 3D is an enhancement, never the only channel.
- The host provides: a focusable stage with keyboard orbit (←/→ ±15°, ↑/↓ ±10°, +/− dolly, 0/Home
  reset, PageUp/PageDown steps, Enter select, Esc close), cooperative wheel zoom (Ctrl+wheel or after
  engaging; otherwise the page scrolls and 「按住 Ctrl 並滾動以縮放」 shows), touch that never traps
  scrolling inline, 全螢幕互動 with full touch controls, live-region announcements, and the poster
  fallback without WebGL 2.
- Colour is never the only channel: pair colour with position, size, labels or line style.
- Portrait stages (phones, `height="tall"`): provide `camera.portrait` and, if needed, a portrait
  layout in `onResize` (neural-net rotates the network vertical). `ctx.setPose` scales landscape
  poses automatically.

## 10. Embedding (pages) and events

```astro
<Scene3D id="chain-panorama" variant="explore" height="tall" autoload="visible"
         data={segments} caption="AI 產業鏈五層十四環節（資料截至 2026-10）"
         hotspots={[{ id: 'energy-power', label: '能源與電力', href: '/chain/energy-power/' }]} step={0} />
```

Props: `id`, `variant?`, `caption?`, `data?`, `autoload?: 'visible' | 'idle' | 'click'`,
`height?: 'normal' | 'tall' | 'hero'`, `hotspots?`, `step?`, `class?`.

Events dispatched by `<ai-scene>` (all bubble): `scene:state {state}`, `scene:ready {id, variant}`,
`scene:step {index, id, title}`, `scene:variant {variant}`, `scene:hotspot {id, action: 'hover' |
'leave' | 'select', source}`, `scene:navigate {href}` (cancelable). Commands: dispatch
`scene:command` on the element with `{type: 'focus', id}`, `{type: 'select', id}`,
`{type: 'step', index}`, `{type: 'variant', variant}`, `{type: 'reset' | 'play' | 'pause' | 'load'}`.
`data-state` on the element: `poster | loading | running | paused | contextlost | error | fallback`.

Test hooks: `document.querySelector('ai-scene').stats` returns `{ frames, drawCalls, triangles,
quality, state, variant, step, geometries, textures, animate, loop, budget, fixture }`;
`window.__scenes.all()` / `window.__scenes.get('<scene-id>')` give `{ id, el, stats(), command(c) }`
handles for every scene on the page. At most two WebGL contexts are live per page: a third scene
evicts the least recently visible one back to its poster (it reloads on scroll-back).

## 11. Testing

1. Sandbox: `http://127.0.0.1:4321/dev/scenes/<id>/` (toggles for variant, quality, theme, motion,
   height; live stats; event log). URL parameters: `?variant= &step= &quality=high|medium|low|off
   &theme=light|dark &motion=reduce &seed= &height=`. Add `&nonav` to cancel navigations.
   `&poster=1` is the poster-capture mode used by `scripts/capture-posters.ts`: a bare 800×450 stage
   (no sandbox chrome, stats, toolbar, badge, hint or old poster; in-stage controls such as
   `[role=group]` chip rows and sliders are hidden, legends stay), screenshotted at DPR 2 →
   1600×900. Keep scene controls inside `[role=group]` (or as direct parents of their buttons /
   inputs) so posters never show dead controls.
2. Scene suite (dev server running on 4321, or set `SCENE_BASE_URL`):
   ```
   # Git Bash
   SCENE=<id> npx playwright test tests/scenes --config tests/scenes/playwright.config.ts
   # PowerShell
   $env:SCENE='<id>'; npx playwright test tests/scenes --config tests/scenes/playwright.config.ts
   ```
   It checks, in light and dark: ready ≤ 20 s, frames ≥ 3, draw calls > 0 and within `meta.budget`,
   a non-blank canvas (luminance σ > 4), every variant, every step (and prev/next), reduced motion
   (frames stop), WebGL disabled (fallback + poster + step captions still work), no horizontal
   scroll at 320 px, and **no console errors, page errors or `THREE.*` warnings**. Screenshots are
   written to `test-results/scenes/`. Look at them.
3. Type-check your folder. The root `tsconfig.json` currently trips TypeScript 6's `baseUrl`
   deprecation, so use a private config in `research/tmp/<your-label>/tsconfig.json`:
   ```json
   {
     "extends": "../../../tsconfig.json",
     "compilerOptions": { "ignoreDeprecations": "6.0", "baseUrl": "../../.." },
     "include": ["../../../.astro/types.d.ts", "../../../src/three/**/*"],
     "exclude": []
   }
   ```
   then `npx tsc --noEmit -p research/tmp/<your-label>/tsconfig.json`.
4. Definition of done: both themes look polished at 1280 px and 390 px (portrait `tall` too), all
   suite checks pass, labels are readable, the description and captions teach the same thing as the
   3D, and the chunk is within budget.

## 12. Copy-paste template

`src/three/scenes/<id>/meta.json` — see §3. `src/three/scenes/<id>/index.ts`:

```ts
/**
 * <id> — <zh-TW title> (variants: a, b).
 * One paragraph: what it shows, what each step adds, how reduced motion looks.
 */
import { BoxGeometry, Group, Mesh } from 'three';
import json from './meta.json';
import { addStudioLights } from '../../core/lights';
import { defineScene, type CameraPose } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';

const STEP_POSES: readonly (CameraPose | null)[] = [
  null, // 0 = 總覽 → ctx.homePose
  { position: [2.5, 2, 3.5], target: [0, 0.6, 0] },
];

export default defineScene({
  json,
  meta: {
    camera: { position: [4, 3, 6], target: [0, 0.6, 0], fov: 38, portrait: { position: [5, 4, 8.5] } },
    controls: 'orbit',
    loop: 'continuous',
    budget: { calls: 20, tris: 30_000 },
  },

  create(ctx) {
    const root = new Group();
    ctx.scene.add(root);
    const lights = addStudioLights(ctx.scene, ctx.palette);

    const chip = new Mesh(ctx.track(new BoxGeometry(1.6, 0.25, 1.6)), ctx.materials.standard('seg:ai-accelerators'));
    chip.position.y = 0.5;
    root.add(chip);

    const glows = ctx.track(new GlowSprites({ count: 1, theme: ctx.theme }));
    glows.set(0, [0, 0.9, 0], 1.6, ctx.palette.highlight, 0.6);
    root.add(glows.object);

    ctx.labels.add({ text: 'AI 晶片', object: chip, position: [0, 0.4, 0], align: 'above', kind: 'strong', hotspot: 'chip' });
    ctx.hotspots.register('chip', {
      object: chip,
      card: () => ({ title: 'AI 晶片', body: '（與 meta.json hotspot detail 相同的說明）' }),
      pose: { position: [2.2, 1.8, 2.8], target: [0, 0.5, 0] },
    });

    const showStep = (i: number) => ctx.setPose(STEP_POSES[i] ?? ctx.homePose);

    return {
      update(dt) {
        chip.rotation.y += dt * 0.4; // ambient motion only (dt = 0 when motion is off)
      },
      setStep(i) {
        showStep(i);
      },
      onPalette(p) {
        lights.apply(p);
        glows.setTheme(p.theme);
        glows.setColor(0, p.highlight);
      },
      onMotion(animate) {
        if (!animate) chip.rotation.y = 0; // a clear static pose
      },
      dispose() {
        root.removeFromParent();
      },
    };
  },
});
```

Checklist before you report done: meta.json validates (`npx tsx scripts/validate-data.ts`), the
scene suite passes for your id, you looked at the light and dark screenshots at desktop and 390 px,
no hex colours or industry numbers in code, all zh-TW text follows the style guide.

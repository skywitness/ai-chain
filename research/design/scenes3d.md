# AI 產業鏈網站：3D 層設計（three.js r186 + Astro 7，僅靜態網站）

## 0. Baseline checked on 2026-10-06

| Package | Version | Note |
|---|---|---|
| `three` | **0.186.1** (r186, 2026-09-24) | Pin `~0.186.1`. r186 added a Gaussian splat renderer, which we do not use (the downloads are heavy) |
| `@types/three` | 0.186.0 | Same minor version as three |
| `astro` | 7.3.6 (Vite 8.3.3 / Rolldown) | Scenes are vanilla custom elements, not framework islands |
| `@playwright/test` | 1.63.0 | Headless WebGL runs through SwiftShader |
| `world-atlas` | 2.0.2, ISC | TopoJSON built from Natural Earth, which is public domain |
| `taiwan-atlas` | 2021.9.20, MIT | TopoJSON at 1:10,000 built from the Ministry of the Interior (MOI) shapefiles |
| `topojson-client` 3.1.0, `d3-geo` 3.1.1 (ISC) | | Used only in build scripts, never shipped |
| `postprocessing` (pmndrs) | 6.39.5 | Its peer range is `three <0.187`, which ties it to three releases. **We avoid it** and use three's own addons |

r183–r186 changes that affect this design:
- `Clock` was deprecated in r183. Use `THREE.Timer` and call `timer.connect(document)` so it handles page visibility.
- In r183, `PostProcessing` was renamed to `RenderPipeline`. That class is WebGPU-only, so it is irrelevant on WebGL.
- `PCFSoftShadowMap` is deprecated and its code path now logs a warning. Use `PCFShadowMap`, because our console-error gate would fail on that warning.
- BatchedMesh now supports per-instance opacity.
- Chrome no longer falls back to SwiftShader for WebGL automatically. Real users without a GPU get **no WebGL**, so the poster fallback is required. Tests must pass `--enable-unsafe-swiftshader`.

---

## A. Shared engine (vanilla TypeScript, no React)

### A1. Layout

```
src/three/
  engine/   types.ts detect.ts renderer.ts SceneHost.ts loop.ts quality.ts motion.ts
            theme.ts materials.ts env.ts controls.ts picking.ts hotspots.ts labels.ts
            tween.ts dispose.ts postfx.ts rng.ts testhooks.ts
  kit/      PathFlow.ts ArcRibbons.ts GlowSprites.ts ExplodedStack.ts Axes3D.ts
            globe/{Globe.ts, geo.ts} tw/projectTw.ts canvasTex.ts
  scenes/   s01-panorama/ … s18-taiwan/   (one folder and one chunk per scene)
  fixtures/ <sceneId>.json               (lets scenes be built before real content exists)
  registry.ts
src/components/scene/  Scene3D.astro  SceneControls.astro  ai-scene.ts (custom element)
src/pages/__scenes/[id].astro            (test/poster harness, built only when SCENE_HARNESS=1)
scripts/  build-geo.ts  posters.ts  attention-demo.py
```

### A2. Renderer choice: WebGLRenderer. Do not adopt WebGPU in v1

- **Browser support.** WebGPU now ships in Chrome/Edge, Safari 26 on every Apple platform, and Firefox on Windows and on Apple Silicon Macs. Firefox for Android still lacks it, and older Android devices only get Chromium's compatibility mode. `WebGPURenderer` would fall back to its WebGL2 backend on those devices anyway.
- **Rewrite cost.** The three.js manual still describes WebGPURenderer as experimental, with greatly improved maturity. It does **not** support `ShaderMaterial`, `onBeforeCompile` or `EffectComposer`, so every custom shader would have to be rewritten in TSL. Initialisation is asynchronous, and the node system adds a lot of bundle weight.
- **No compute need.** Our scenes do not need GPU compute. The largest is about 20k particles, and those are animated in vertex shaders.
- **Simpler testing.** Headless WebGL2 through SwiftShader is mature and deterministic.
- **Keeping the door open.** All custom GLSL lives in about five kit files (PathFlow, ArcRibbons, GlowSprites, the globe atmosphere shader and the tunnel grid). Scenes use only stock materials plus those kit modules, so a later TSL port touches only kit/.
- **When to revisit:** a scene needs GPU simulation above 200k particles, or WebGPURenderer drops the "experimental" label and Firefox Android ships WebGPU.

### A3. Renderer settings (`renderer.ts`)

```ts
new WebGLRenderer({ canvas, antialias: tier !== 'low', alpha: true,
  powerPreference: 'default',            // don't force the discrete GPU or drain laptop batteries
  stencil: false, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, TIER[tier].dprCap));
renderer.toneMapping = NeutralToneMapping;   // keeps brand colours true
renderer.outputColorSpace = SRGBColorSpace;
renderer.debug.checkShaderErrors = import.meta.env.DEV || isTest;
renderer.shadowMap.type = PCFShadowMap;      // only on the high tier, only where a scene opts in
```

- Diagram and unlit materials use `toneMapped: false` so palette hex values render exactly.
- three r163+ requires WebGL2.
- Detection runs once per page on a probe canvas: `getContext('webgl2')`, then `gl.getParameter(gl.RENDERER)`, then `WEBGL_lose_context`. This happens before the real renderer exists, because `antialias` must be chosen at context creation.

### A4. Scene module contract

```ts
export type Tier = 'high' | 'mid' | 'low';
export type Depth = 'intro' | 'mid' | 'deep';          // 入門 / 進階 / 深入
export interface SceneMeta {
  id: SceneId; loop: 'continuous' | 'demand'; autoRotate?: boolean;
  controls: 'orbit' | 'orbit-limited' | 'scroll' | 'none';
  camera: { fov: number; position: Vec3; target: Vec3; minDist?: number; maxDist?: number; polar?: [number, number] };
  budget: { calls: number; tris: number };              // high-tier caps, checked by tests
  posterPose: { time: number; depth: Depth; step?: number };
}
export interface SceneContext<D> {
  renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; controls: OrbitControls | null;
  data: D; preset: string | null; tier: Tier; reducedMotion: boolean; depth: Depth; palette: Palette;
  labels: LabelLayer; picker: Picker; hotspots: HotspotRegistry; ui: UiBindings; tween: Tweener;
  rng: () => number;                    // seeded (mulberry32) so posters and tests are deterministic
  invalidate(): void; track<T extends { dispose(): void }>(o: T): T; signal: AbortSignal;
  env(): Promise<Texture>;              // shared PMREM of RoomEnvironment, procedural, no download
}
export interface SceneInstance {
  update(dt: number, t: number): boolean | void;   // returning true keeps a demand-mode loop ticking
  setDepth?(d: Depth): void; setStep?(i: number): void; onPalette?(p: Palette): void;
  onTier?(t: Tier): void; onResize?(w: number, h: number): void; dispose?(): void;
}
export interface SceneModule<D = unknown> { meta: SceneMeta; create(ctx: SceneContext<D>): SceneInstance | Promise<SceneInstance>; }
```

The registry uses static `import()` strings so Vite splits each scene into its own chunk:

```ts
export const registry = { panorama: () => import('./scenes/s01-panorama'), … } satisfies Record<SceneId, () => Promise<{ default: SceneModule<any> }>>;
```

### A5. `<ai-scene>` element and SceneHost lifecycle

`Scene3D.astro` renders all of the following on the server, so the content works with no JavaScript:

```html
<figure class="scene">
  <ai-scene scene="cowos" preset="" depth="intro" style="aspect-ratio:16/9" tabindex="-1">
    <div class="scene-stage" role="img" aria-label="CoWoS 封裝 3D 拆解圖" aria-describedby="cowos-desc">
      <picture class="scene-poster">…light/dark webp, width/height set…</picture>
      <button class="scene-activate" hidden>載入 3D 互動</button>
    </div>
    <div class="scene-toolbar">深度：[入門|進階|深入] · 重設視角 · 全螢幕互動 · 暫停/播放 · 畫質</div>
    <div class="scene-controls"><!-- slot: sliders/toggles carrying data-bind="explode" etc. --></div>
    <ol class="scene-hotspots"><!-- <button data-hotspot> or <a href> for each pickable --></ol>
    <div class="scene-card" popover="manual"></div><div class="sr-only" aria-live="polite"></div>
    <script type="application/json" data-scene-data>{…}</script>
  </ai-scene>
  <figcaption id="cowos-desc">說明 · 資料來源 · 資料截至 2026-09 · 「示意」標註</figcaption>
</figure>
```

A `<script>` inside Scene3D.astro (bundled once per page) defines the custom element. `connectedCallback` and `disconnectedCallback` drive the lifecycle, so it works with or without Astro's ClientRouter or view transitions.

State machine: `poster → loading → mounting → running ⇄ paused → disposed`. Any state can move to `error`/`contextlost`, which shows the poster again.

1. **Near view.** An IntersectionObserver with `rootMargin: "100% 0px"` starts `import()` of the scene chunk. That chunk pulls the shared three chunk. A `dataUrl` fetch runs in parallel.
2. **Visible.** A second observer at threshold 0 creates the canvas under the poster, the renderer, the camera, the controls and the scene. It then calls `await renderer.compileAsync(scene, camera)` so shader compiles happen without jank, renders the first frame, and fades the poster out over 200 ms (0 ms under reduced motion). Finally it dispatches `scene:ready`.
3. **Pause** when the stage leaves view, when `document.visibilitychange` reports hidden, or when another scene is in fullscreen. Pausing calls `setAnimationLoop(null)` and stops the label and picking work too.
4. **Resize** comes from a ResizeObserver on the stage, coalesced through rAF. It calls `setSize(w, h, false)`, updates `camera.aspect`, notifies `labels.resize` and `scene.onResize`, and invalidates.
5. **Dispose** runs in this order: stop the loop, abort the AbortController (removes every listener), disconnect the observers, cancel tweens, `scene.dispose()`, `bag.dispose()` (geometries, materials, textures, render targets, PMREM), `controls.dispose()`, `composer?.dispose()`, `labels.destroy()`, `renderer.renderLists.dispose()`, `renderer.dispose()`, `renderer.forceContextLoss()`, remove the canvas, and show the poster again.
6. **Context loss.** `webglcontextlost` calls `preventDefault()` and shows the poster. `webglcontextrestored` triggers a full dispose and remount.
7. **Page policy:** one scene per page. Where a chapter needs two, the second goes on its 深入 sub-page. There is a hard cap of 2 live contexts; a third mount disposes the scene that was visible least recently.

### A6. Lazy loading and data delivery

- **Chunks.** Three core plus the addons in use (OrbitControls, RoundedBoxGeometry, RoomEnvironment, BufferGeometryUtils) form one shared `three-vendor` chunk, configured through Vite 8/Rolldown's chunk-grouping option (check the option name against current Vite docs). The engine is one chunk, each scene is its own chunk, and postFX is a separate chunk loaded only on the high tier in dark theme.
- **Home hero.** The poster is the LCP image (`fetchpriority="high"`). The scene is imported after `load` plus `requestIdleCallback({ timeout: 2000 })`.
- **Data, small.** Data is computed at build time from content collections and serialised into `data-scene-data` if it is under 8 KB gzipped.
- **Data, large.** Larger data goes to a static endpoint, for example `src/pages/data/geo/companies.json.ts` producing `/data/geo/companies.json`, which is fetched lazily.
- **Types.** A shared `SceneDataMap[SceneId]` type keeps build-time and runtime types in sync, with zod at build time.
- **No numbers in code.** Scenes contain no hard-coded industry figures. Every number comes from a collection with `source` and `asOf`, and the figcaption shows them.
- **Save-Data or user choice.** If `navigator.connection.saveData` is set, or the user picked 「關閉 3D」, no scene loads automatically; the page shows the 「載入 3D 互動」 button instead.

### A7. Render loop

- `Loop` uses `renderer.setAnimationLoop` and `THREE.Timer`.
- **`continuous` mode** is for ambient flows. On the low tier, frames are capped at 30 fps by accumulating the delta.
- **`demand` mode** renders only after `invalidate()`. Triggers are controls `change`, pointer moves, UI bindings, tweens, and an `update()` that returns true. OrbitControls damping keeps invalidating while `controls.update()` returns true.
- **Reduced motion** forces `demand` mode.
- **No per-frame allocations.** Use module-level scratch `Vector3`/`Matrix4` objects.
- **Static objects** set `matrixAutoUpdate = false`.
- **Shader-animated meshes** (PathFlow, ArcRibbons) set `frustumCulled = false` or a manual bounding sphere, because their positions live in the shader.

### A8. Quality tiers and the adaptive governor

| | high | mid | low |
|---|---|---|---|
| DPR cap | 2.0 | 1.5 | 1.0 |
| MSAA | on | on | off |
| Draw calls | ≤150 | ≤100 | ≤60 |
| Triangles | ≤500k | ≤200k | ≤80k |
| PathFlow particles (total) | ≤20k | ≤8k | ≤2k |
| Shadows | 1 directional, PCF, 1024–2048 | baked blob / contact texture | none |
| Glow | UnrealBloom, half-res (dark theme only) | GlowSprites (additive halos) | GlowSprites, reduced |
| Visible labels | 40 | 24 | 12 |
| Frame target | 60 | 60 (45 floor) | 30 cap |
| GPU texture memory | ≤64 MB | ≤32 MB | ≤16 MB |

**Static detection (`detect.ts`)** returns `off` if WebGL2 is missing. Otherwise:
- **Software renderer.** A renderer string matching `/SwiftShader|llvmpipe|Software|Basic Render/` gives `low` with click-to-load in production; in test mode it simply gives `low`.
- **Low-end phones.** A coarse pointer, a short screen side under 820, and any of: memory ≤4, cores <8, or a GPU matching `Mali-G[0-6]`, `Adreno [3-6]xx` or PowerVR, give `low`.
- **Other phones and integrated GPUs.** Other phones and iOS give `mid`. Desktops with Intel HD/UHD graphics, ≤4 cores or ≤4 GB memory also give `mid`.
- **Everything else** is `high`.
- **Overrides.** The user can force a tier in the toolbar's 畫質 menu (自動/高/中/低/關閉 3D), stored in localStorage behind try/catch. Tests can force it with `?tier=`.

**Runtime governor (continuous scenes only):**
- It ignores the first 2 s after mount.
- It measures the median frame time over 120 frames. If that is above 22 ms, it steps down one level: DPR −0.25 (minimum 1.0), then bloom off, then `scene.onTier('low')`, which cuts particle and instance counts.
- If the median stays below 12 ms for 5 s, it steps up once. It steps up at most once per 10 s, to avoid oscillation.
- MSAA cannot change after context creation, so the governor never changes it.

### A9. Reduced motion (`prefers-reduced-motion: reduce`, or the site toggle `html[data-motion="reduce"]`)

- Demand loop only, no auto-rotation, and no idle sway or twinkle.
- Tweens become a cut, or a fade of 150 ms or less.
- PathFlow freezes its time uniform and lays particles out evenly as **static dotted streams**, so the direction still reads. Arrowheads come from GlowSprites.
- Scrubbed or scroll-driven camera moves snap to steps.
- A 「播放動畫」 button lets the user opt in for that scene only; the choice is not persisted.
- Tested by comparing two screenshots taken 1 s apart, which must be identical.

### A10. WebGL fallback and posters

- **Posters.** Each scene's poster is a real render: `npm run posters` launches Playwright against the harness with `?poster=1&theme=…&depth=intro`. That mode uses the fixed `posterPose.time`, the seeded RNG, real data and no auto-rotate, and waits for `window.__scene.ready`.
- **Variants.** Screenshots are taken at 1600×900 (desktop) and 900×1125 (mobile, 4:5), in both light and dark. `sharp` converts them to WebP/AVIF at 60 KB or less each, stored as `public/posters/<id>-<theme>-<d|m>.webp`. They are committed to git and double as OG images.
- **Display.** Two `<img>` elements are swapped by CSS on `[data-theme]`. A `<picture media>` cannot be used, because the site toggle overrides the OS setting.
- **No WebGL2, `off` tier, or `<noscript>`.** The poster stays, with the caption 「您的瀏覽器未啟用 WebGL 2，以下為靜態示意圖」. The hotspot list still works as normal links and buttons, and its info cards open as HTML.
- **No layout shift.** `aspect-ratio` is reserved on the stage, and the poster has the same box.

### A11. OrbitControls conventions (`controls.ts`)

- **Defaults:** `enableDamping` on (factor 0.08), `rotateSpeed` 0.6, pan off (S10 and S18 allow pan within a bounding box), min/max distance and polar clamps from `meta.camera`.
- **Auto-rotate** happens only if `meta.autoRotate` is set and motion is allowed, at speed 0.4. It pauses for 6 s after any interaction.
- **Wheel on desktop, cooperative.** A capture-phase `wheel` listener on the canvas sets `controls.enableZoom = e.ctrlKey || engaged`, where `engaged` means the user clicked in the stage within the last 8 s or the stage has focus. Trackpad pinch already arrives as ctrl+wheel. When zoom is not allowed, OrbitControls returns early without `preventDefault`, so the page keeps scrolling, and a 1.5 s hint shows 「按住 Ctrl 並滾動以縮放」.
- **Touch, inline.** On coarse-pointer devices, inline scenes do **not** attach OrbitControls, and the canvas keeps `touch-action: pan-y`, so page scrolling never gets trapped. A tap picks an object; the picker handles it.
- **Touch, fullscreen.** 「全螢幕互動」 opens an immersive overlay using the Fullscreen API, or a fixed dialog on iOS. There OrbitControls are attached with `touch-action: none`: one finger rotates, two fingers dolly and rotate. Esc or ✕ exits.
- **Keyboard** (when the stage has focus):
  - ←/→ change azimuth by ±15° and ↑/↓ change polar angle by ±10°, applied as a spherical offset followed by `controls.update()`.
  - `+`/`-` dolly, `0`/Home resets, Esc closes the card or exits fullscreen.
  - PageUp/PageDown step through scene steps where they exist.
- **Camera moves** go through `tween.camera(to, {duration: 700, ease: cubicInOut})`. Under reduced motion the duration is 0.
- **Reset view** is always available in the toolbar.

### A12. Picking, hotspots and accessibility

- **Pointer state machine.** A pointerdown followed by a pointerup within 6 px and 400 ms counts as a click. Hover works for `pointerType === 'mouse'` only and is processed at most once per frame.
- **Two pickers:**
  - `RaycastPicker`: a `Raycaster` limited to layer 1 (the pickable layer). It hits simplified invisible proxy meshes for complex parts, and gets `instanceId` for InstancedMesh. three-mesh-bvh is not needed.
  - `ScreenSpacePicker`: for markers, stars and beads. It projects N points (N ≤ 1000) and picks the nearest within 18 px for mouse or 28 px for touch. Points on the back of a globe are culled with `dot(normal, toCamera) > 0`. This is more forgiving than raycasting tiny spheres.
- **Highlight.** Hover lerps `instanceColor` or `color` toward `palette.highlight` and scales by 1.06. Selection adds a ring sprite or a back-face hull. **No OutlinePass.**
- **HotspotRegistry.** Scenes register `{id, label, objectRef | instanceId | pointIndex, anchor, href?, cardHtmlId?}`. The list `<ol class="scene-hotspots">` is server-rendered from the same data, and the registry links each item to its object:
  - Focusing or hovering a list item highlights the object, and optionally frames it.
  - Enter or click selects it, opening the HTML card or navigating.
  - Hovering in 3D sets `aria-current` on the matching list item.
  - Selection is announced in the live region (「已選取：HBM3E 12 層堆疊」).
- **Events.** The host emits `scene:hover` and `scene:select` CustomEvents so page HTML can react. Ctrl/⌘-clicking a navigation hotspot in the canvas opens a new tab.
- **ARIA.** The stage is `role="img"` with `aria-describedby` pointing at the figcaption. We avoid `role="application"`. Every fact a scene teaches is also present in the page text or list, so 3D is an enhancement, never the only channel.

### A13. Labels: a pooled projected-DOM `LabelLayer` instead of CSS2DRenderer

CSS2DRenderer gives every object its own element and walks the scene each frame. It has no priority, no collision handling and no pooling, and people report it slowing down beyond roughly 1,000 labels. Our layer adds the following on top of the same idea:
- A pool of N absolutely positioned elements moved with `transform: translate3d()`.
- Each frame where the camera changed, it projects candidate labels and culls those behind the camera, off-screen, or failing an occlusion test. The occlusion test is a globe dot-product test, or a raycast against an `occluders` layer every 4th frame.
- It sorts labels by priority and places them greedily on a collision grid, then fades them in and out.
- Exploded views get leader lines from a single `<svg>` overlay.
- All zh-TW text stays in the DOM. It uses the page font, stays crisp and is selectable, and needs no CJK font atlas.
- Labels are `aria-hidden`, because the hotspot list already duplicates them.
- CSS2DRenderer remains allowed for quick prototypes only.

### A14. Theme palette and visual language

- **Tokens.** Colours are CSS custom properties on `:root`, with dark mode redefined for `[data-theme=dark]` and for `prefers-color-scheme` when no explicit theme is set:
  - `--scene-bg / -fg / -grid / -muted / -highlight / -flow / -power / -heat / -coolant / -optic / -tw-accent`
  - 13 `--seg-*` colours, one per chain layer.
- **Reading and updating.** `theme.ts` reads them with `getComputedStyle(host)` into a `Palette` of `THREE.Color`. A MutationObserver on `html[data-theme]` plus `matchMedia` triggers `materials.applyPalette()`. Because all materials come from the palette-bound registry in `materials.ts`, this updates them in place. The scene's `onPalette` runs and the frame is invalidated.
- **Canvas.** The canvas uses `alpha: true` and clears transparent, so the container's CSS background shows through.

Suggested segment hues (dark / light):

| Segment | Dark | Light |
|---|---|---|
| 能源 | `#F5A524` | `#B86E00` |
| 設備材料 | `#F07A3A` | `#B4501A` |
| 代工封裝 | `#EF5D5D` | `#B83232` |
| 記憶體 | `#E0569B` | `#A82E6E` |
| AI 晶片 | `#A56BF0` | `#6F3FC0` |
| 網通 | `#6D7CF5` | `#3C4BC4` |
| 伺服器 | `#3E9BF0` | `#1F69B8` |
| 資料中心 | `#26BFD9` | `#0E7F94` |
| 雲端 | `#2BC9A4` | `#11826A` |
| 模型 | `#57CC6A` | `#2D8A3E` |
| 工具/MLOps | `#A6CF3E` | `#66861A` |
| 應用/Agent | `#E8C83A` | `#8F7A10` |
| 實體 AI | `#FF8FA3` | `#C2455E` |

Colour is never the only channel: position and labels always encode the same thing. Validate contrast against both backgrounds.

**Visual language: a "technical diorama".**
- Clean low-poly procedural forms with bevelled edges (`RoundedBoxGeometry`).
- Lighting is a hemisphere light plus one key directional light. The shared RoomEnvironment PMREM gives metal parts subtle reflections on the mid and high tiers. A soft radial contact-shadow texture replaces shadow maps outside the high tier.
- Material families:
  - `hardware`: Standard, metalness 0.5, roughness 0.35.
  - `silicon`: Physical with iridescence on the high tier, Standard otherwise.
  - `diagram`: Basic, `toneMapped: false`.
  - `glass`: transparent Standard at opacity 0.12–0.2 with `depthWrite: false`, for enclosures and cutaways.
  - `glow`: the additive sprite shader.
- Semantic colours: data = cyan-white, power = amber, heat = orange-red, coolant = blue, optics = violet. Taiwan highlight = `--tw-accent`.
- **Bloom.** High tier and dark theme only. UnrealBloomPass at half resolution with threshold 1.0, strength 0.6 and radius 0.4, followed by an OutputPass. Only objects meant to glow output HDR values above 1 (`toneMapped: false`, colour × 2–3), which gives selective bloom by luminance without a second composer. Light theme has no bloom; glow sprites switch to normal blending with darker tints.
- **Motion.** Camera moves use cubic in-out easing over 600–900 ms. Flows are calm, not frantic.

### A15. Kit modules (shared techniques)

- **`PathFlow`.** Polylines are resampled by arc length to 64 points and packed into an RGBA32F `DataTexture` (64 × pathCount). Each particle is an instanced quad with `aPath, aOffset, aSpeed, aSize, aColor`. The vertex shader computes `t = fract(uTime*aSpeed + aOffset)`, does two `texelFetch` calls with a manual lerp, then billboards the quad. It is one draw call for any count, with a reduced-motion static layout. Used by S01, S02, S04, S07, S09, S10, S11, S14 and S15.
- **`ArcRibbons`.** An instanced strip of 32 segments with per-instance start, end, height, width, colour and progress. It has two modes: planar Bézier (attention, tool calls) and great-circle with altitude (globe). One draw call, with draw-on animation through `aProgress`. Used by S03, S12, S14, S16 and S18.
- **`GlowSprites`.** Instanced additive halos (a radial-gradient CanvasTexture) used as fake bloom on mid and low tiers.
- **`ExplodedStack`.** Ordered layers with spacing driven by a `0..1` explode value, plus label anchors for leader lines. Used by S01, S06, S07 and S08.
- **`Axes3D`.** Linear or log axes, grid planes and HTML tick labels through LabelLayer. Used by S04 and S13.
- **`Globe`.** A land dot-matrix (one InstancedMesh or Points draw from `land-dots.bin`), an ocean sphere, and a fresnel atmosphere in dark theme only. It also provides `latLonToVec3`, `flyTo(lat, lon, dist)` using a quaternion slerp of the camera around the origin, marker InstancedMesh with city stacking (grouped by 0.25° buckets and stacked along the normal), and screen-space picking. Used by S12 and S16.
- **`projectTw`.** A tiny local equirectangular projection for Taiwan, shared by the build script and the runtime. Used by S18.
- **Instancing guidance:**
  - Use InstancedMesh for repeated identical geometry.
  - Use **BatchedMesh** for many distinct static parts that share a material (S08 rack parts, S10 facility equipment, S11 diorama). With r186's per-instance opacity, filters can fade parts.
  - Use `mergeGeometries` for non-interactive decor.

### A16. Budgets per scene (CI-enforced unless marked)

- **JS:** the three-vendor chunk is about 150–180 KB gzipped (measure it; it is shared and cached). The engine is ≤25 KB gzipped, each kit module ≤8 KB, and each scene chunk ≤30 KB (hard cap 45).
- **Data:** ≤40 KB gzipped per scene. Geo assets are ≤60 KB gzipped and shared.
- **Main thread:** mounting (create, `compileAsync`, first frame) ≤300 ms on a mid-range laptop, with no long task over 100 ms; build large instance buffers in chunks across frames if needed.
- **Per frame:** JS `update()` ≤4 ms (high) and ≤6 ms (low).
- **FPS** (on reference devices, not gated in CI): desktop p95 frame time ≤20 ms; mid-range phone ≥30 fps.
- **First interactive frame:** ≤1.5 s after the stage becomes visible on a mid-range laptop over cable.

### A17. Memory hygiene

- **Tracking.** Every geometry, material, texture, render target, PMREM and composer goes through `ctx.track()` into a DisposableBag. `deepDispose(object3D)` also walks material texture slots.
- **Listeners** are registered with `{ signal }`. Observers are disconnected and tweens cancelled. Label DOM is removed. Instance arrays are released by nulling scene references.
- **Leak check (dev and test).** After `scene.dispose()` and before `renderer.dispose()`, assert that `renderer.info.memory.geometries === 0 && textures === 0`. The test suite mounts and unmounts each scene 5 times and expects JS heap growth under 3 MB, measured with CDP `HeapProfiler.collectGarbage` and `Runtime.getHeapUsage`.
- **Dynamic instance buffers** use `DynamicDrawUsage` plus `addUpdateRange` only while animating. Afterwards `computeBoundingSphere()` is called once.

### A18. Depth contract (由淺入深)

Every scene implements `setDepth('intro' | 'mid' | 'deep')`. The toolbar segmented control 深度：入門 / 進階 / 深入 is two-way synced with the page's depth sections: when a 「進階」 heading scrolls into view, `setDepth('mid')` is called, unless the user has pinned a depth. Higher depths add parts, labels, numbers and controls; they never remove 入門 context. Optional `setStep(i)` handles scrollytelling: `<ol data-scene-steps>` items are watched by an IntersectionObserver (no library). S05, S08, S10 and S17 use steps.

---

## B. Scene catalog (18 modules; presets reuse a module on another chapter)

**Taxonomy check.** The 13 layers are sound, with three changes:
1. Physical AI is drawn as a **side wing** next to the top layers, because it is a parallel deployment branch rather than "above applications".
2. Boundary rule: in-rack power, cooling and PCB belong to 伺服器與系統; facility-level equipment belongs to 資料中心.
3. ABF substrates are filed under packaging, and EDA/IP becomes a sub-ring of the AI 晶片 layer.

台灣供應鏈 works as both an overlay toggle (S01, S16) and its own scene (S18).

| # | id | 名稱 | Host (proposed slug) | Kit | Complexity |
|---|---|---|---|---|---|
| S01 | panorama | AI 產業鏈全景塔 | `/` | PathFlow, ExplodedStack, Glow | L |
| S02 | neural-net | 神經網路如何學習 | `/learn/ai-basics/` | PathFlow | M |
| S03 | attention | Transformer 注意力劇場 | `/learn/llm-transformer/` | ArcRibbons | M |
| S04 | train-infer | 訓練與推論：算力的兩種用法 | `/learn/training-inference/`; preset `pipeline` on `/chain/devtools-mlops/` | PathFlow, Axes3D | M |
| S05 | wafer-transistor | 從晶圓到電晶體 | `/chain/foundry-packaging/`; preset `euv` on `/chain/equipment-materials/` | — | L |
| S06 | cowos | CoWoS 先進封裝拆解 | `/chain/foundry-packaging/advanced-packaging/` | ExplodedStack | M |
| S07 | hbm | HBM 記憶體堆疊與頻寬 | `/chain/memory/` | ExplodedStack, PathFlow | M |
| S08 | gpu-scale | 從晶片到超級機櫃 | `/chain/ai-chips/`; preset `rack` on `/chain/servers/` | ExplodedStack, PathFlow | L |
| S09 | network | AI 網路與光通訊 | `/chain/networking/` | PathFlow | M |
| S10 | datacenter | AI 資料中心剖面 | `/chain/datacenter/` | PathFlow, BatchedMesh | L |
| S11 | energy | GW 級 AI：電力與能源 | `/chain/energy/` | PathFlow | M |
| S12 | cloud-globe | 雲端與新雲版圖 | `/chain/cloud/` | Globe, ArcRibbons | M |
| S13 | model-galaxy | 大模型星系 | `/models/` (also chain chapter 基礎模型) | Axes3D, Glow | M |
| S14 | agent-loop | AI Agent 運作迴圈與 MCP | `/chain/apps-agents/` | ArcRibbons, PathFlow | S |
| S15 | physical-ai | 實體 AI：感知→模型→動作 | `/chain/physical-ai/` | PathFlow | L |
| S16 | company-globe | 全球 AI 企業地球儀 | `/companies/` | Globe | S (after Globe) |
| S17 | roadmap-tunnel | 2024–2030 技術時光隧道 | `/trends/` | — | M |
| S18 | taiwan-map | 台灣 AI 供應鏈地圖 | `/taiwan/` | projectTw, ArcRibbons | M |

The collection names below are proposals; align them with the content-schema owner. Every data row carries `source` and `asOf`.

### S01 · AI 產業鏈全景塔 (`panorama`)
- **Goal:** AI is a dependency stack running from electricity to intelligence. Show what each layer does and who the key players are.
- **Depth:**
  - 入門: 4 bands (基礎設施 / 運算硬體 / 平台 / 智慧).
  - 進階: all 13 layers plus company counts.
  - 深入: company beads, the Taiwan overlay, and EDA/IP and sub-segment rings.
- **Visual:** 13 rounded slabs stacked into a gently tapering tower, energy at the bottom and widest. Gaps separate the 4 bands, and physical AI is a cantilevered wing near the top. 24 helical PathFlow streams rise through the tower. Particle colour is sampled from a 13×1 segment ramp, so particles change colour as they pass each layer (電力→晶片→算力→智慧). Instanced company beads sit on each slab rim. Slow auto-rotation.
- **Interactions:**
  - Hover a slab: it lifts 0.15 units and an HTML card shows the layer name, a one-line summary, the top 5 companies with tickers, the company count, and 「前往章節 →」.
  - Click navigates to `/chain/<slug>/`.
  - 「台灣供應鏈」 toggle: Taiwanese beads switch to the accent colour, the rest dim, and each layer gets a badge 「台灣 N 家」.
  - An explode slider adjusts layer spacing.
  - The hotspot list is the 13 layer links.
- **Data:** `segments` (order, slug, nameZh, band, colorToken, oneLiner) and `companies`, aggregated per segment (count, top 5, Taiwanese count, bead list). Inline, about 6 KB.
- **Tech:** 13 meshes (ExtrudeGeometry rounded rects) plus EdgesGeometry lines; beads as one InstancedMesh (≤350); PathFlow; Glow; projected labels on desktop with leader lines on the right. About 35 draw calls and under 60k triangles.
- **Tiers:** high 12k particles plus bloom; mid 5k plus GlowSprites; low 1.5k with no beads (counts appear in the cards instead).
- **Mobile:** fixed 3/4 camera with a slight sway. Tap a slab to open its card. Layer chips appear as a horizontal scroller below. Only band labels are drawn.
- **Reduced motion:** static isometric pose, frozen dotted streams, no rotation or sway, instant hover lift.

### S02 · 神經網路如何學習 (`neural-net`)
- **Goal:** neurons, weights and activations; a forward pass gives a prediction; loss; backpropagation and gradient descent improve the weights.
- **Depth:**
  - 入門: data flows through the network to make a prediction.
  - 進階: weights, bias, activation, loss and the learning rate.
  - 深入: per-edge ∂L/∂w, learning-rate divergence, and overfitting shown with a train/test split.
- **Visual:**
  - A small MLP (4-6-6-3). Nodes are spheres whose brightness is the activation; edges are coloured and sized by weight sign and magnitude.
  - Forward pulses travel left to right in cyan; the backward pass runs right to left in magenta, and edges visibly re-tint.
  - A side 2D canvas (an HTML canvas, not 3D) shows the decision-boundary heatmap. The training is real: a tiny seeded MLP in TypeScript learns XOR, spirals or circles.
- **Interactions:** buttons 前向傳播 / 計算誤差 / 反向傳播 / 更新權重; play or pause training; learning-rate slider; dataset picker; hover a node or edge to see its value.
- **Data:** step captions from the page's MDX frontmatter `sceneSteps`. No collection data.
- **Tech:** InstancedMesh of 19 spheres, LineSegments with vertex colours for edges, PathFlow pulses along the edges. Demand loop while paused.
- **Tiers:** trivial; the low tier drops the pulses.
- **Mobile:** vertical (top to bottom) layout with a smaller 3-4-4-2 network.
- **Reduced motion:** step-through only, with instant highlights per stage.

### S03 · Transformer 注意力劇場 (`attention`)
- **Goal:** text becomes tokens, then vectors; self-attention weighs the other tokens; multiple heads learn different patterns; the model predicts the next token; the KV cache grows with context.
- **Depth:**
  - 入門: tokenisation and "attention = which words matter".
  - 進階: Q/K/V, softmax weights and multi-head attention.
  - 深入: how attention changes from layer to layer, the KV cache as a growing stack (linking to the HBM chapter), and the O(n²) cost of context.
- **Visual:**
  - Token chips laid out on the x-axis rise into embedding columns (16 small cubes each).
  - Hovering a token draws ArcRibbons to every other token, with thickness and opacity set by attention weight.
  - The final stage shows probability bars for the next token.
- **Interactions:** stage stepper 分詞 / 嵌入 / 注意力 / 預測; hover or focus a token; head selector; layer slider; choice of 3–4 preset sentences, for example 「台積電 為 輝達 生產 最新 的 AI 晶片」. No free-text input in v1, because a tokenizer and model are too heavy to ship.
- **Data:** `attentionDemos`, precomputed offline by `scripts/attention-demo.py` using a small Apache-2.0 open model that handles Chinese (`output_attentions=True`). Weights are quantised to uint8 per [layer][head][i][j], with PCA-3D embeddings, about 3–5 KB per sentence. The figcaption names the model.
- **Tech:** instanced RoundedBox chips, InstancedMesh embedding cubes (about 200), and ArcRibbons for all arcs in one draw call. Token text is HTML labels.
- **Tiers:** trivial.
- **Mobile:** sentences of 8 tokens or fewer; tap a token to toggle its arcs.
- **Reduced motion:** arcs appear at full length without growing.

### S04 · 訓練與推論：算力的兩種用法 (`train-infer`)
- **Goal:**
  - Training is large, batch, cluster-scale compute.
  - Inference is per request and sensitive to latency and throughput.
  - Compute has grown by orders of magnitude, and test-time compute is now rising.
- **Depth:**
  - 入門: learning once versus answering every time.
  - 進階: FLOPs, GPU-hours, batching, latency versus throughput, and cost per token.
  - 深入: Chinchilla-style compute-optimal scaling, reasoning tokens, prefill (compute-bound) versus decode (memory-bound), and disaggregated serving.
- **Visual:**
  - Mode A, a split stage. 「訓練工廠」 shows a data river flowing into a big GPU block. 「推論服務」 shows a ring of users sending request dots to a serving cluster, with tokens streaming back.
  - Mode B, 「規模定律」: a log-scale 3D plot. Notable models are cubes whose volume is proportional to log training FLOPs, placed by date and parameter count. A year slider grows the field.
- **Interactions:** mode toggle; year slider; hover a cube to see FLOPs, parameters, date and source; in inference mode, sliders for batch size and number of users drive a simple queue simulation of latency against utilisation.
  - **Preset `pipeline`** (MLOps chapter): a looping pipeline 資料→預訓練→後訓練(SFT/RL)→評測→部署→監控.
- **Data:** `models` fields `trainingFlops`, `params`, `releaseDate`, sourced from **Epoch AI "Data on AI models" (CC BY 4.0; attribution required in the caption)**, plus `inferenceDemo` parameters.
- **Tech:** InstancedMesh cubes, Axes3D, PathFlow.
- **Tiers:** particles scale with tier.
- **Mobile:** tabs switch 訓練 / 推論. Mode B uses a fixed 2.5D camera.
- **Reduced motion:** static flow arrows; the slider snaps.

### S05 · 從晶圓到電晶體 (`wafer-transistor`)
- **Goal:** the scale from a 300 mm wafer, to a die, to the interconnect stack, to one transistor. Why gate control moves from FinFET to GAA nanosheets to CFET. Backside power delivery. Why big dies yield worse.
- **Depth:**
  - 入門: a wafer becomes many chips, and a transistor is a switch.
  - 進階: process nodes, FinFET versus GAA, and the role of EUV.
  - 深入: CFET, backside power (TSMC's Super Power Rail, Intel's PowerVia), High-NA EUV, and a **die-size → good-dies-per-wafer calculator** (Murphy yield with a defect-density slider), which explains why chiplets exist.
- **Visual:** a "powers of ten" zoom through 4 levels: an iridescent wafer, then a die floorplan (cores, cache, I/O), then exploded metal layers, then the transistor. The transistor morphs between FinFET, GAA and CFET, and an optional toggle moves the power rails to the back side. A scale bar in HTML tracks the level (mm → µm → nm).
- **Interactions:** level stepper 晶圓 / 晶粒 / 金屬層 / 電晶體 (also scroll-driven); architecture segmented control; cross-section slider using a clipping plane; hover parts (源極 / 汲極 / 閘極 / 通道).
  - **Preset `euv`** (equipment chapter): EUV light path from CO₂ laser to tin droplet to collector to mirrors to reticle to wafer stage, with part hotspots for the equipment and materials companies.
- **Data:** `processNodes` (company, node, year, transistor type, BSPDN, density) and `equipmentParts` for the preset.
- **Tech:**
  - The wafer is a CircleGeometry with a procedural die grid in its shader; high tier adds MeshPhysical iridescence.
  - The die is procedural boxes with a CanvasTexture floorplan.
  - Transistor parts each have per-architecture configurations, and morphs are tweens of position and scale.
  - Uses `renderer.localClippingEnabled`.
- **Tiers:** iridescence on high only; under 100k triangles.
- **Mobile:** button-driven levels; the clipping slider becomes a 「剖面」 toggle.
- **Reduced motion:** crossfade cuts between levels and instant architecture swaps.

### S06 · CoWoS 先進封裝拆解 (`cowos`)
- **Goal:** why packaging is the AI bottleneck. Logic dies and HBM sit together on an interposer or RDL. The reticle limit drives interposer growth. Hybrid bonding.
- **Depth:**
  - 入門: the GPU chip and memory share one package.
  - 進階: interposer, µbumps, TSVs, C4 bumps, and the ABF substrate.
  - 深入: CoWoS-S, -L and -R; interposer size in reticle multiples; SoIC hybrid bonding; panel-level (CoPoS) and glass-core substrates; capacity in wafers per month.
- **Visual:** a generic (unbranded) package: 2 compute dies, 8 HBM stacks, interposer or RDL with LSI bridges, substrate, BGA balls and lid. An explode slider separates the layers, and leader-line labels name them.
- **Interactions:** explode slider (0–100%); variant toggle CoWoS-S / CoWoS-L / SoIC / InFO; 「光罩尺寸」 overlay showing a 26×33 mm rectangle against the interposer; hover or click a part to open a card with the companies involved (foundry, OSAT, substrate, HBM makers).
- **Data:** `packagingTech` (variant, interposer reticle multiple, year, products) and `packageParts` (part → company ids).
- **Tech:** ExplodedStack; bumps as an InstancedMesh (5k high, 1k low); clipping cross-section; lid uses the Standard material with the environment map.
- **Mobile:** 3 preset buttons 組合 / 半拆 / 全拆; numbered markers with a legend list.
- **Reduced motion:** no automatic explode on entry; the slider drives the view directly.

### S07 · HBM 記憶體堆疊與頻寬 (`hbm`)
- **Goal:** the memory wall. HBM stacks DRAM dies with TSVs on a base die. Interface width and bandwidth grow by generation. The base die moves to logic processes in HBM4 ("custom HBM").
- **Depth:**
  - 入門: a nearby warehouse reached by a wide road.
  - 進階: stack height, TSVs, generations and capacity.
  - 深入: bonding methods (MR-MUF / TC-NCF / hybrid), base die on a foundry process, thermals, and memory-bound decode (links to S03 and S04).
- **Visual:**
  - A cross-section of an 8-, 12- or 16-high stack. TSV columns glow, and data packets flow up and down them, out through the interposer and into the GPU.
  - 「頻寬比較」 mode shows DDR5, GDDR7, HBM3E and HBM4 as pipes whose cross-sections are proportional to interface width, with particle throughput proportional to bandwidth.
- **Interactions:** generation selector; stack-height toggle; comparison mode; hover a layer (core die, base die, TSV, µbump) to open a card with vendors.
- **Data:** `memoryTech` (generation, IO width, pin speed, GB/s per stack, maximum height, GB per stack, year, vendors). The particle rate is derived from these values.
- **Tech:** InstancedMesh dies and TSVs (a representative 32×32 grid; 16×16 on low); PathFlow along the TSVs; transparent cylinder pipes.
- **Mobile:** comparison shown as vertical bars; fewer TSVs.
- **Reduced motion:** static gradient dashes in place of flow; the numbers carry the comparison.

### S08 · 從晶片到超級機櫃 (`gpu-scale`)
- **Goal:** scale-up versus scale-out, and how GPUs become a rack-scale computer: the NVL72 NVLink domain, compute and switch trays, power shelves, liquid-cooling manifolds, then pods. Alternatives include TPU pods, AMD Helios and Trainium UltraServer. Shows who builds each part (ODM/OEM, power, cooling, cables).
- **Depth:**
  - 入門: many chips act as one computer.
  - 進階: trays, NVLink spine, rack kW and liquid cooling.
  - 深入: NVLink switch topology, scale-up versus scale-out bandwidth, alternative system architectures, and the component-to-supplier map.
- **Visual:** 5 nested zoom levels: package (simplified S06 geometry), compute board, 1U tray, rack (18 compute trays, 9 switch trays, power shelves, manifolds, rear cable cartridge), and a pod row of racks. Only the current level and its neighbours are built.
- **Interactions:**
  - Breadcrumb stepper 晶片 / 模組 / 運算托盤 / 機櫃 / 叢集.
  - System preset toggle (data-driven layouts).
  - 「顯示 NVLink」 animates all-to-all links.
  - A stats panel shows GPUs, scale-up bandwidth, kW and cooling.
  - Hover a component for its role and suppliers.
  - **Preset `rack`** (servers chapter) starts at the tray and rack levels with the ODM, power and cooling hotspots.
- **Data:** `systems` (vendor, accelerators per rack, CPUs, switch trays, rack kW, scale-up bandwidth, cooling, ODMs) and `chips`.
- **Tech:** BatchedMesh for distinct rack parts; InstancedMesh for trays, GPUs and racks; a shared 512² CanvasTexture atlas for vents and LEDs; cables as LineSegments bundles; PathFlow for NVLink traffic. Pod level stays at 150 draw calls or fewer.
- **Mobile:** swipeable levels; pod racks drawn as plain boxes.
- **Reduced motion:** crossfades between levels; static highlighted NVLink lines.

### S09 · AI 網路與光通訊 (`network`)
- **Goal:** distributed training means constant gradient exchange. Fabric topologies; InfiniBand versus Ethernet/UEC; scale-up, scale-out and scale-across; the trade-off between reach and power that drives copper, pluggable optics, LPO and CPO.
- **Depth:**
  - 入門: GPUs talk constantly over highways.
  - 進階: leaf-spine topology and 800G/1.6T transceivers.
  - 深入: rail-optimised topology, all-reduce traffic, congestion, CPO power arithmetic (pJ/bit × Tb/s = W), and optical circuit switches.
- **Visual:**
  - Mode A: three tiers (server rows, leaf switches, spine switches) with packet flows. The rail-optimised view recolours links by rail.
  - Mode B: a switch ASIC at centre with three link variants side by side: copper DAC, a pluggable transceiver (laser, DSP, fibre), and CPO optical engines around the ASIC. Bars compare reach, pJ/bit, latency and serviceability.
- **Interactions:** topology toggle 胖樹 / 軌道最佳化; play 「訓練流量模擬」 (ring all-reduce); click a switch to isolate its links; link-type control in mode B; hover components for companies.
- **Data:** `networkTech` (type, reach, pJ/bit, rate, year) and `networkParts` mapped to companies.
- **Tech:** instanced node boxes; all links in one LineSegments with vertex colours; PathFlow over baked multi-hop paths; procedural parts for mode B.
- **Tiers:** packets 4096 / 1500 / 512.
- **Mobile:** 8 servers instead of 32; no link labels.
- **Reduced motion:** packets off; the selected flow path is highlighted statically.

### S10 · AI 資料中心剖面 (`datacenter`)
- **Goal:** the anatomy of a facility.
  - Power chain: substation, MV switchgear, transformer, UPS/BESS, busway/PDU, rack power shelf (rising toward 800 V HVDC), VRM, chip.
  - Cooling: air with hot/cold aisles; direct-to-chip liquid with CDU, facility loop and dry cooler; immersion.
  - Rack density growth and PUE.
- **Depth:**
  - 入門: a building of computers that needs power and cooling.
  - 進階: aisles, liquid cooling, PUE and the power chain.
  - 深入: rack density toward 1 MW, 800 V DC, CDU sizing, WUE and heat reuse.
- **Visual:** a cutaway hall (back walls only) with instanced rack rows and containment.
  - The air/liquid/immersion toggle switches between airflow particles (cold blue to hot red) and supply/return pipe loops with flow.
  - 「電力路徑」 traces electricity from the outdoor substation, through the equipment, into one rack, ending at the chip, with voltage labels at each step.
- **Interactions:** cooling segmented control; power-path stepper; a kW/rack density slider (air-cooled racks glow red past the limit); hover equipment for its role and vendors.
- **Data:** `dcComponents` (role, vendor ids, voltage and temperature labels) and `rackDensity` (year → typical kW).
- **Tech:**
  - InstancedMesh racks (80 high, 40 low); BatchedMesh facility equipment; merged TubeGeometry pipes along CatmullRom curves.
  - PathFlow for coolant, air and power.
  - The power trace is an animated dash shader.
  - Shadows on high only.
- **Tiers:** flow particles 8k / 3k / 800.
- **Mobile:** 2 rack rows; the power path shown as steps.
- **Reduced motion:** static arrows; the power trace advances step by step.

### S11 · GW 級 AI：電力與能源 (`energy`)
- **Goal:** AI campuses now operate at gigawatt scale. What 1 GW means. Generation mix and capacity factors. Transmission. Interconnection queues; behind-the-meter gas, fuel cells and SMRs; turbine and transformer lead times; Taiwan's grid.
- **Depth:**
  - 入門: AI needs a lot of electricity, with intuitive comparisons.
  - 進階: generation types and capacity factor.
  - 深入: queues, lead times, siting and grid constraints.
- **Visual:**
  - A low-poly diorama: gas turbine, nuclear dome, solar field, wind farm and battery containers, linked by catenary transmission lines to a campus, with flowing energy.
  - 「GW 比較」 mode: comparison columns whose height is proportional to MW (a 2015-era data centre, a reactor, AI megacampuses, Taiwan's peak demand) with household-unit tokens.
- **Interactions:** mode toggle; hover a plant for capacity factor, lead time and vendors; a campus MW slider that computes how many plants of each type are needed; choose which comparison chips to show.
- **Data:** `energyComparisons` (label, MW, source, year), `generationTypes` (capacity factor, lead time, vendors) and `megaprojects` (shared with S12).
- **Tech:** procedural primitives; InstancedMesh solar panels (2k high, 400 low) and turbines (blade rotation in the vertex shader); PathFlow on catenary curves; shadows on high only.
- **Mobile:** comparison mode is the default; the diorama camera is fixed.
- **Reduced motion:** turbines stopped; no particles.

### S12 · 雲端與新雲版圖 (`cloud-globe`)
- **Goal:** where AI compute lives: hyperscalers, neoclouds, sovereign AI, and flagship megaprojects with GW rings.
- **Depth:**
  - 入門: the cloud means renting someone else's data centre.
  - 進階: hyperscalers versus neoclouds versus sovereign providers.
  - 深入: capacity timelines, siting by energy availability, and capex context (charts stay 2D on the page).
- **Visual:** Globe kit. Region markers are short pillars coloured by provider type. Megaprojects are glowing beacons with ring size proportional to planned GW. Optional ArcRibbons connect each operator's HQ to its sites.
- **Interactions:** filter chips 超大規模雲 / 新雲 / 主權 AI / 巨型專案 plus individual providers; hover a site for its card (operator, location, MW/GW, status, timeline, source); click through to the company page; 「飛到」 buttons for 北美 / 歐洲 / 中東 / 亞太; an accessible sortable table of sites below.
- **Data:** `cloudRegions` and `megaprojects`, served from `/data/geo/cloud.json` (about 15 KB gzipped), plus `land-dots.bin`.
- **Tech:** Globe kit (land dots 20k high, 8k low); InstancedMesh markers; ScreenSpacePicker; ArcRibbons in great-circle mode.
- **Mobile:** globe at 50vh, horizontally scrolling filter chips, and the table promoted.
- **Reduced motion:** no spin; fly-to is instant.

### S13 · 大模型星系 (`model-galaxy`)
- **Goal:** the LLM landscape across capability, price, openness, context, modality, reasoning and release timing; the cost-capability frontier moving over time.
- **Depth:**
  - 入門: closed versus open, and frontier versus efficient.
  - 進階: price per million tokens, context window, modalities and reasoning.
  - 深入: the Pareto frontier over time, cost decline at fixed capability, benchmark caveats (contamination, saturation), and MoE active versus total parameters.
- **Visual:** a 3D scatter "galaxy". Default axes are x = log output price, y = capability index, z = openness. Star size reflects context window, colour reflects vendor, and constellation lines trace each model family's versions.
- **Interactions:** remappable axes (price, capability, date, context, speed, openness); filters (vendor, open/closed, modality, reasoning); a 時間軸 slider so the galaxy grows over time; a Pareto frontier ribbon toggle; camera presets 正面 2D / 斜視 3D; hover a star for its card; click through to `/models/<slug>/`.
- **Data:** `models` (vendor, release date, open flag, license, input and output price, context, modalities, reasoning, `scores[{source, value, asOf}]`, speed, active/total parameters).
  - Prefer score sources with explicit open licences, such as Epoch AI's CC BY data.
  - For any other leaderboard, check its terms and store only one derived value with citation and date.
- **Tech:** instanced billboard stars with a glow shader; LineSegments for constellations; Axes3D. Axis transitions lerp between `aPosA` and `aPosB` in the shader. Label priority goes to the top N models.
- **Tiers:** trivial; bloom on high.
- **Mobile:** defaults to the 2D frontier with a fixed camera, plus a list below.
- **Reduced motion:** instant remaps; no twinkle.

### S14 · AI Agent 運作迴圈與 MCP (`agent-loop`)
- **Goal:** an agent is an LLM running in a loop with tools and memory: perceive, plan, act, observe. MCP host/client/server architecture. Human-in-the-loop gates, context management and A2A.
- **Depth:**
  - 入門: a chatbot answers, while an agent completes tasks.
  - 進階: tools, MCP and memory.
  - 深入: context engineering, sub-agents, permissions, prompt injection through tool outputs, and evals.
- **Visual:**
  - A central LLM orb on a 4-station track: 感知 / 規劃 / 行動 / 觀察.
  - A task token circulates around the track.
  - An outer ring of MCP servers (search, code, database, calendar, browser) connects through an MCP hub with ArcRibbons.
  - A context-window bar fills as steps accumulate, next to a long-term memory stack.
- **Interactions:** scenario picker 研究助理 / 程式碼代理 / 客服代理; play or step, with the transcript in an HTML side panel; a 「人類核准」 toggle that inserts an approval gate; hover a tool for an explanation.
- **Data:** `agentScenarios` (steps with phase, tool, text and context tokens) and a glossary.
- **Tech:** torus track, instanced spheres, ArcRibbons, PathFlow.
- **Tiers:** trivial.
- **Mobile:** smaller loop with the transcript below; step mode only.
- **Reduced motion:** step mode; the token jumps between stations.

### S15 · 實體 AI：感知→模型→動作 (`physical-ai`)
- **Goal:** sensors (camera, LiDAR, radar, IMU, tactile), edge compute, VLA and world models, actuators (motors, harmonic reducers, roller screws, dexterous hands), simulation and synthetic data, and BOM cost shares with their supply chain, Taiwan included.
- **Depth:**
  - 入門: sees, thinks, moves.
  - 進階: sensors, compute modules and the actuator BOM.
  - 深入: VLA action chunks, world models, sim-to-real, and modular versus end-to-end stacks.
- **Visual:**
  - Two presets, 人形機器人 and 自駕車, both procedural articulated rigs built from capsules and boxes (no skinning).
  - Camera frustums, a LiDAR point cloud computed once by raycasting simple obstacles in JS, and radar cones.
  - Sensor data flows to the compute module, then through a floating VLA block, then to the actuators, which run a keyframed pick-and-place task or a braking or lane-change manoeuvre.
- **Interactions:** preset toggle; stage stepper 感知 / 理解 / 規劃 / 控制; sensor on/off chips to see what each sensor sees; hover a component for its BOM share and companies.
- **Data:** `physicalAiComponents` (function, specs, company ids, BOM share with source).
- **Tech:** hand-written forward kinematics with keyframe interpolation (a tiny module); LiDAR as Points (30k high, 8k low); wireframe frustums; PathFlow; shadows on high.
- **Mobile:** one preset at a time; sensors as chips.
- **Reduced motion:** a static pose per stage and a full static point cloud with no sweep.

### S16 · 全球 AI 企業地球儀 (`company-globe`)
- **Goal:** the geography of the roughly 300 companies, how each segment clusters, and the link from each marker to its company profile.
- **Depth:**
  - 入門: markers by segment.
  - 進階: tier and region filters, with height proportional to log of latest revenue.
  - 深入: concentration rings (share of companies or revenue by country per segment) plus a stats panel.
- **Visual:** Globe kit. Each HQ is a bead coloured by primary segment, with a secondary-segment ring. Companies in the same city stack into pillars.
- **Interactions:**
  - Filters for 13 segment chips, tier (龍頭 / 主要 / 新創) and region, plus a search box (the camera flies to the match).
  - Hover a bead for a mini card (Chinese and English names, ticker, segment, city, latest quarterly revenue with YoY).
  - Click opens `/companies/<slug>/`.
  - Filter state is shared with the HTML directory table below through the URL (`?seg=memory&tier=leader`).
  - 「前往台灣地圖」 links to S18.
- **Data:** `/data/geo/companies.json`, built from the `companies` and `financials` collections (about 300 × 120 B, about 10 KB gzipped).
- **Tech:** Globe kit; one InstancedMesh of beads; filtering through a per-instance `aVisible` attribute that fades instances; ScreenSpacePicker; labels only on hover and for the top cities.
- **Tiers:** land dots scale with tier.
- **Mobile:** globe at 50vh, filter chips, and the list as the primary view; tap a bead for its card.
- **Reduced motion:** no spin; instant fly-to.

### S17 · 2024–2030 技術時光隧道 (`roadmap-tunnel`)
- **Goal:** hardware and software roadmaps:
  - Hardware: process nodes, packaging, HBM, GPUs and ASICs, networking, power and cooling.
  - Software: reasoning, agents and MCP, long context, multimodal and world models, on-device models, open weights, and falling inference cost.
  - Every item carries an explicit status: 已出貨 / 已發表 / 路線圖 / 預測.
- **Depth:**
  - 入門: one key milestone per lane per year.
  - 進階: every shipped or announced item.
  - 深入: roadmap and forecast items with uncertainty fuzz and sources.
- **Visual:** a cylindrical tunnel along the time axis with glowing year rings. Lanes are angular sectors (製程, 封裝, 記憶體, 晶片, 網通, 電力散熱, 模型, Agent, 實體 AI). Milestones are nodes on the wall with pooled HTML cards. A 「現在 2026-10」 ring separates the solid past from the translucent future.
- **Interactions:** sticky, scroll-scrubbed fly-through (scroll position mapped to camera z; demand render on scroll); a year slider; lane filter chips (硬體 / 軟體 / per lane); hover a node for date precision, status and source; click through to the related article or company.
- **Data:** `milestones` (date, precision, lane, title, summary, status, sourceUrl, related companies and segments).
- **Tech:** an open CylinderGeometry with a grid shader; InstancedMesh nodes; LabelLayer pooling with priority by camera distance (at most 12–20 cards).
- **Mobile:** two lanes (硬體 / 軟體) and full-width cards.
- **Reduced motion:** no fly-through; year snapping with instant camera. An HTML timeline list always exists.

### S18 · 台灣 AI 供應鏈地圖 (`taiwan-map`)
- **Goal:** Taiwan's role across the clusters:
  - IC design in Hsinchu; foundry fabs in Hsinchu, Taichung, Tainan and Kaohsiung; CoWoS/AP sites in Zhunan, Taichung and Chiayi; OSAT in Kaohsiung.
  - PCB and substrates in Taoyuan; server ODMs in Taoyuan, Linkou and Hsinchu; power and thermal; memory; robotics components in central Taiwan.
  - Constraints on power and water.
- **Depth:**
  - 入門: the main parks and what each makes.
  - 進階: companies per cluster.
  - 深入: facility level (fab name, node or function) plus the 「一顆 AI 晶片的旅程」 tour.
- **Visual:** an extruded Taiwan island with county borders on top. Penghu is in place; Kinmen and Matsu appear as labelled insets. Clusters are glowing pylons with segment-coloured company beads stacked on them. An optional 「出貨」 view adds ArcRibbons to off-map customer markers. High tier adds a low-resolution heightmap relief.
- **Interactions:**
  - Segment filter chips; hover a cluster for its company list; click a company to open its profile.
  - The tour steps 設計 → 晶圓 → CoWoS → 測試 → 載板/PCB → 伺服器組裝 → 出貨, with the camera flying between clusters and the HTML narrative in sync.
  - Bounded pan is allowed.
- **Data:** `taiwanClusters` (park or zone, lat/lon, companies, facilities with company, name and function), `companies` filtered to Taiwan, `twTourSteps`, and `/data/geo/taiwan.json`.
- **Tech:** Shape plus ExtrudeGeometry from the pre-projected rings; LineSegments for borders; InstancedMesh beads; `projectTw` shared with the build script. High tier uses a 256×512 heightmap-displaced plane masked by the island shape.
- **Mobile:** Taiwan's tall shape suits portrait; the cluster list is a bottom sheet.
- **Reduced motion:** the tour cuts between positions.

---

## C. Assets

- **Geometry is procedural first.** v1 ships **no glTF**. There is a contingency allowance of at most 2 glTF files, each ≤200 KB, made in-house in Blender (licence cleared) and compressed with `gltf-transform` meshopt plus quantisation, using `MeshoptDecoder` (about 20 KB). Candidates would be the S15 humanoid and car, only if the procedural versions read poorly. No third-party models and no splats.
- **3D text: none in CJK.** zh-TW 3D text would need a font atlas or typeface file of several MB. All labels are HTML (LabelLayer). For rare Latin or number marks that must sit inside the scene, such as a "2nm" engraving or year numbers on the tunnel rings, draw a runtime CanvasTexture with the already-loaded page font (`document.fonts.ready`), which costs zero bytes. troika-three-text is not used.
- **Page font:** Noto Sans TC from Google Fonts, whose CSS2 API automatically splits it by unicode-range, with a system fallback stack (`"PingFang TC","Microsoft JhengHei"`).
- **Textures are procedural:**
  - CanvasTexture for the die floorplan, the vent/LED atlas, glow sprites and the tunnel grid.
  - DataTexture for PathFlow paths and the segment ramp.
  - The RoomEnvironment PMREM (no HDR download).
  - The only baked image is the optional Taiwan heightmap: 8-bit PNG at 256×512, about 60–80 KB, high tier only. It is derived from the MOI 20 m DEM on data.gov.tw (政府資料開放授權條款 第 1 版), with the attribution 「內政部」.
- **World map:**
  - Source: `world-atlas` 2.0.2 (ISC package; data from Natural Earth, which is **public domain**, so attribution is optional but we credit it in the site's 資料來源 page).
  - Build step: `scripts/build-geo.ts` reads `land-50m.json`, converts it with topojson-client to a feature, generates a Fibonacci sphere of about 40k points, keeps those inside land per `d3-geo.geoContains` (about 12k remain), quantises lat/lon to Int16 (×100), and writes `public/data/geo/land-dots.bin` (about 50 KB raw).
  - Country borders, if needed, come from `countries-110m`.
  - Natural Earth draws de facto boundaries; the site keeps neutral place-name labelling.
- **Taiwan outline:**
  - Source: `taiwan-atlas` (MIT code), file `counties-10t.json`. Its data comes from the MOI datasets 「直轄市、縣市界線(TWD97經緯度)」 and 鄉鎮市區界線, licensed under 政府資料開放授權條款 第 1 版, which is compatible with CC BY 4.0. The credit line is 「資料來源：內政部國土測繪中心」.
  - Build step: `build-geo.ts` simplifies to about 2–5% with topojson-simplify, projects with `projectTw`, splits the main island, Penghu and small islands from the Kinmen/Matsu insets, rounds to 3 decimals, and writes `public/data/geo/taiwan.json` (target ≤40 KB gzipped).
  - The npm package dates from 2021. Re-derive from the current MOI shapefile if borders ever change; no county-level change has happened since 2014.
- **Other data licences:**
  - Epoch AI data is CC BY 4.0, with the citation in the S04 and S13 captions.
  - The attention-demo model must be Apache-2.0 or MIT, and its name goes in the S03 caption.
  - Leaderboard-derived scores require checking each source's terms before storing.
  - Cluster coordinates are hand-curated from official park websites.

---

## D. Build order, acceptance and testing

### D1. Gates

**G0, project (sequential).**
- Astro 7 with strict TypeScript; `three@~0.186.1` and `@types/three@0.186.0`; chunk grouping configured.
- Content schemas for the scene-facing fields.
- `fixtures/<id>.json` for all 18 scenes, so scenes do not wait on research.

**G1, engine minimum. Required before scene work fans out.**
- `types.ts` (the contract), `<ai-scene>` with SceneHost (mount, resize, IntersectionObserver and visibility pause, dispose, context loss), `renderer.ts` and `detect.ts`.
- Static tiers with the `?tier` override; Loop with continuous and demand modes and Timer; the motion module.
- `theme.ts` with `materials.ts`; `controls.ts` (conventions, keyboard, cooperative wheel); Picker and HotspotRegistry; LabelLayer; Tweener; DisposableBag; rng.
- `Scene3D.astro` and `SceneControls.astro` (slider, toggle and segmented control with `data-bind`).
- The `/__scenes/[id]` harness and test hooks.
- The Playwright smoke suite (D3, points 1–3).

**G2, finished in parallel with early scenes; required before any scene is marked done.**
- Adaptive governor, postFX bloom chunk, fullscreen/immersive mode, poster pipeline, perf and leak tests, axe audit.

**Kit gates:**
- PathFlow and GlowSprites before S01, S02, S04, S07, S09, S10, S11, S14 and S15.
- ArcRibbons before S03, S12, S14, S16 and S18.
- ExplodedStack before S01, S06, S07 and S08.
- Axes3D before S04 and S13.
- Globe and `build-geo` before S12, then S16.
- `projectTw` and `build-geo` before S18.

**Pilot.** Build **S06 CoWoS** first, end to end. It exercises ExplodedStack, leader labels, sliders, hotspots, picking, materials, depth, posters and tests, and validates the whole pipeline before fan-out.

**Parallel lanes after the pilot:**
- A (flows): S01, S10, S11, S09.
- B (hardware): S05, S07, then S08 (it reuses the S06 package).
- C (geo): Globe kit, S12, S16, S18.
- D (concepts): S02, S03, S04, S13, S14, S15, S17.

**Final phase:**
- Swap fixtures for real content.
- Regenerate posters.
- Tune on reference devices: a recent desktop GPU, an Intel UHD laptop, a mid-range Android (Snapdragon 6-series), and an iPhone 13 or newer.

### D2. Per-scene acceptance checklist
1. It is registered, implements `SceneModule`, and declares `meta.budget` and `posterPose`.
2. It reads data only through `ctx.data`. No industry figures are hard-coded. The caption shows source, 資料截至 date, and a 示意 marker where the visual is illustrative.
3. All zh-TW text is in the DOM, with no CJK geometry. Labels respect the tier label budget.
4. Every pickable object has an entry in the hotspot list. Keyboard support covers Tab, arrows, ±, 0, Enter and Esc, with a visible focus ring and live-region announcements. The axe audit on the host page shows 0 serious violations.
5. Layout is correct at 360×640, 768, 1280 and 1920 with no horizontal overflow. The mobile simplification is in place. Touch never traps scrolling, and the fullscreen mode works.
6. Tiers high, mid and low change the counts as specified. Draw calls, triangles, chunk size and data size are within budget.
7. Reduced motion gives a static pose, no auto-rotation, and no animation unless the user clicks 播放. The identical-screenshot test passes.
8. Light and dark themes are both legible and switch live. Label contrast is at least 4.5:1.
9. Lifecycle: it pauses offscreen and when the tab is hidden; resize is correct; dispose leaves memory at 0; 5 mount/unmount cycles grow the heap by less than 3 MB.
10. Four posters exist (light/dark × desktop/mobile), and the WebGL-disabled fallback has been checked.
11. Playwright smoke passes in every tier × theme combination, along with the interaction spec and the visual baseline.
12. On real hardware: desktop p95 frame time ≤20 ms, phone ≥30 fps, no long task over 100 ms during mount.
13. Content review confirms the learning goal is achievable without the 3D. Depths 入門 / 進階 / 深入 each add something meaningful.

### D3. Headless testing (Playwright 1.63 with SwiftShader)

**Configuration:**
- `launchOptions.args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']`, `deviceScaleFactor: 1`.
- The web server builds with `SCENE_HARNESS=1` and runs `astro preview`.
- Projects: `desktop` (1280×720) and `mobile` (`devices['Pixel 7']` with touch). WebKit smoke is optional.
- Baselines are generated in the `mcr.microsoft.com/playwright:v1.63.0-noble` image so Windows and Linux pixels do not diverge.

**Harness URL:** `/__scenes/<id>?test=1&tier=high|mid|low&theme=dark|light&motion=reduce&depth=deep&seed=1`. The page exposes `window.__scene`:

```
{ ready: Promise<void>,
  debug(): { state, tier, loopMode, frames, calls, tris, geometries, textures,
             hovered, selected, camera: { az, polar, dist } },
  setTime(t), unmount(), remount(), sampleFrames(n): Promise<{ p50, p95, updateP95 }> }
```

The checks:
1. **Console and page errors.** Fail on `console.error`, on warnings matching `/THREE\./` (which catches shader errors and deprecations such as `PCFSoftShadowMap`), and on `pageerror`. Only a narrow allow-list of SwiftShader warnings is accepted, such as "GPU stall due to ReadPixels".
2. **Ready.** `__scene.ready` must resolve within 15 s.
3. **Not blank.** Take a stage screenshot and decode it with pngjs. More than 3% of pixels must differ from the background token (L1 > 24), and there must be more than 8 quantised colour buckets, which catches all-black output from a broken shader.
4. **Budgets.** After one frame at `tier=high`, `debug().calls` and `tris` must be within `meta.budget`.
5. **Interaction.**
   - Focusing the first hotspot list item sets `debug().hovered`, and Enter sets `debug().selected`.
   - Focusing the stage and pressing ArrowRight changes `camera.az`.
   - A navigation hotspot changes the URL.
   - On mobile, tapping a projected anchor opens the card.
6. **Pause.** Scroll the stage out of view; `frames` stays flat for 1 s and `state` is `'paused'`. Set `visibilityState` to hidden and check the same.
7. **Reduced motion.** With `emulateMedia({ reducedMotion: 'reduce' })`, `loopMode` is `'demand'` and two screenshots taken 1 s apart are identical.
8. **Fallback.** An init script makes `getContext('webgl2')` return null. The poster is visible, the hotspot list works, and there are no errors. The context-loss test calls `WEBGL_lose_context.loseContext()`, expects the poster, then `restoreContext()` and expects the scene to render again.
9. **Theme.** Toggling `data-theme` changes a background pixel sample, with no errors.
10. **Lazy load.** On the host page, no request for `s0X-*.js` happens before scrolling; it is requested once the stage is within one viewport.
11. **Leaks.** Five `unmount()`/`remount()` cycles. After each unmount, geometries and textures are 0. CDP `HeapProfiler.collectGarbage` followed by `Runtime.getHeapUsage` shows less than 3 MB growth.
12. **Visual regression.** `toHaveScreenshot` at `posterPose` with `maxDiffPixelRatio: 0.02`, both themes. This is deterministic under SwiftShader with the seed and fixed time.
13. **FPS.** In CI, SwiftShader FPS is not meaningful, so only `updateP95 ≤ 4 ms` (CPU) and "frames advance while visible" are gated. `npm run test:perf` runs headed with the real GPU on a developer machine, plus a CDP `Emulation.setCPUThrottlingRate(4)` mobile profile. It samples 300 rAF frames, reports p50 and p95 against `perf-baseline.json`, and fails on regressions above 20%.
14. **Bundle.** A size check (`size-limit` or a script over the build manifest) enforces the A16 kB budgets per chunk.

---

**Sources**

- [three.js manual: WebGPURenderer](https://threejs.org/manual/pages/webgpurenderer)
- [three.js releases](https://github.com/mrdoob/three.js/releases)
- [r186 splat renderer](https://radiancefields.com/three.js-ships-its-native-gaussian-splat-renderer-and-splat-raycasting-in-r186)
- [r183 RenderPipeline rename](https://app.cinevva.com/news/2026-03-18-threejs-r183-render-pipeline)
- [Clock → Timer, r183](https://discourse.threejs.org/t/clock-timer-r183/90704)
- [WebGPU browser support](https://www.abratabia.com/webgpu/browser-support.php)
- [WebGPU adoption 2026](https://enterno.io/en/s/research-webgpu-adoption-browsers-2026)
- [Chromium: Intent to Remove SwiftShader fallback](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM/m/oLrB5up_BwAJ)
- [Chromium SwiftShader doc](https://chromium.googlesource.com/chromium/src/+/da170c2267b2201954efe1c8fa5d2d89ab09f7bf/docs/gpu/swiftshader.md)
- [CSS2DRenderer label limits](https://discourse.threejs.org/t/how-to-implement-text-labels-for-a-viewer-application/7397)
- [Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/)
- [taiwan-atlas](https://github.com/dkaoster/taiwan-atlas)
- [taiwan-atlas on npm](https://www.npmjs.com/package/taiwan-atlas)
- [data.gov.tw boundary dataset](https://data.gov.tw/dataset/32158)
- [Epoch AI: Data on AI models (CC BY 4.0)](https://epoch.ai/data/ai-models)

npm versions were checked live with `npm view` on 2026-10-06.
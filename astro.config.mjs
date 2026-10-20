// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import cjkTypography from './src/lib/mdast-cjk.mjs';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://ai-chain-atlas.example.org',
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'always',
  build: { format: 'directory' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  integrations: [
    // zh-TW typography at the seams between text and inline elements (src/lib/mdast-cjk.mjs). Astro 7 renders
    // Markdown and MDX with Sätteri, which reads `processor.options.mdastPlugins` when it builds its renderers.
    {
      name: 'cjk-typography',
      hooks: {
        'astro:config:setup': ({ config }) => {
          const processor = /** @type {{ name: string, options: { mdastPlugins?: unknown[] } }} */ (config.markdown.processor);
          if (processor?.name !== 'satteri' || !Array.isArray(processor.options.mdastPlugins)) {
            throw new Error('cjk-typography: expected the default Sätteri Markdown processor');
          }
          if (!processor.options.mdastPlugins.includes(cjkTypography)) processor.options.mdastPlugins.push(cjkTypography);
        },
      },
    },
    mdx({ optimize: true }),
    sitemap({ filter: (u) => !u.includes('/dev/') }),
  ],
  devToolbar: { enabled: false },
  vite: {
    // Dev only. Scenes load through import.meta.glob / import(), so Vite's dependency scan misses three and its
    // addons; discovering them on first scene load re-optimises mid-session and a long-running dev server then
    // answers "504 Outdated Optimize Dep" for scene modules. Pre-bundle them at startup instead.
    optimizeDeps: {
      include: [
        'three',
        'three/addons/controls/OrbitControls.js',
        'three/addons/geometries/RoundedBoxGeometry.js',
        'three/addons/utils/BufferGeometryUtils.js',
      ],
    },
  },
});

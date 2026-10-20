/**
 * Test hooks. Every <ai-scene> exposes `element.stats` (see element.ts) and registers itself in
 * `window.__scenes` so Playwright can inspect and drive scenes:
 *
 *   window.__scenes.all()            → SceneTestHandle[]
 *   window.__scenes.get('neural-net') → first handle for that scene id (or element id)
 *   handle.stats()                    → { frames, drawCalls, triangles, quality, state, … }
 *   handle.command({ type: 'step', index: 2 })
 */
import type { SceneCommand, SceneStats } from './types';

export interface SceneTestHandle {
  id: string;
  el: HTMLElement;
  stats(): SceneStats;
  command(c: SceneCommand): void;
}

export interface SceneTestRegistry {
  all(): SceneTestHandle[];
  get(idOrElementId: string): SceneTestHandle | undefined;
}

declare global {
  interface Window {
    __scenes?: SceneTestRegistry;
  }
}

const handles = new Set<SceneTestHandle>();

export function registerTestHandle(h: SceneTestHandle): () => void {
  handles.add(h);
  if (!window.__scenes) {
    window.__scenes = {
      all: () => [...handles],
      get: (id) => [...handles].find((x) => x.id === id || x.el.id === id),
    };
  }
  return () => handles.delete(h);
}

// Page data for the `learn-mountain` scene (docs/SCENES.md → 「頁面資料（data）形狀」 → curriculum):
//   { slug, title, level, order, track, prereqs: string[], href }[]
// Build-time only. Owner: pages-learn agent.
//
//   import { curriculumSceneData } from '../../lib/scene-data/curriculum';
//   <Scene3D id="learn-mountain" data={curriculumSceneData()} />
//
// `href` is site-relative WITHOUT the base path (the scene passes it through ctx.href()).
import { getCurriculum, type Level, type TrackId } from '../collections';

export interface CurriculumSceneNode {
  slug: string;
  title: string;
  level: Level;
  order: number;
  track: TrackId;
  prereqs: string[];
  href: string;
}

/** Minimal article shape accepted by the builder (curriculum.yaml rows, or merged learn items). */
export interface CurriculumSceneInput {
  slug: string;
  title: string;
  level: number;
  order: number;
  track: string;
  prereqs?: readonly string[] | undefined;
}

const TRACKS = new Set<string>(['foundations', 'models', 'hardware', 'infra-business', 'society']);

/**
 * Build the scene payload. Defaults to src/data/curriculum.yaml. Articles are sorted by `order`,
 * levels are clamped to 1–3, and prerequisites that do not point to another listed article (or that
 * would point forward in the order, which the scene draws as a path going downhill) are dropped.
 */
export function curriculumSceneData(articles?: readonly CurriculumSceneInput[]): CurriculumSceneNode[] {
  const src = articles ?? getCurriculum().articles;
  const sorted = [...src]
    .filter((a) => a && typeof a.slug === 'string' && a.slug.length > 0)
    .sort((a, b) => a.order - b.order);
  const orderOf = new Map(sorted.map((a) => [a.slug, a.order]));
  return sorted.map((a) => {
    const level = Math.min(3, Math.max(1, Math.round(Number(a.level) || 1))) as Level;
    const track = (TRACKS.has(a.track) ? a.track : 'foundations') as TrackId;
    const prereqs = [...new Set(a.prereqs ?? [])].filter((p) => {
      const o = orderOf.get(p);
      return o !== undefined && o < a.order;
    });
    return {
      slug: a.slug,
      title: a.title,
      level,
      order: a.order,
      track,
      prereqs,
      href: `/learn/${a.slug}/`,
    };
  });
}

// meta.json schema for src/three/scenes/<id>/meta.json (validated by scripts/validate-data.ts).
// FROZEN CONTRACT: changes go through proposals/.
import { z } from 'astro/zod';
import { SceneIdSchema, Slug } from './common';

export const sceneMeta = z.strictObject({
  id: SceneIdSchema,
  title: z.string(), // zh-TW 場景名稱
  description: z.string().min(80), // 完整文字替代說明（zh-TW），供螢幕閱讀器與無 WebGL 時使用
  variants: z.array(z.string()).min(1),
  defaultVariant: z.string(),
  steps: z
    .array(
      z.strictObject({
        id: Slug,
        title: z.string(),
        caption: z.string(),
        variant: z.string().optional(),
      }),
    )
    .default([]), // 導覽步驟：step 0 = 總覽，之後逐步加深（由淺入深）
  hotspots: z
    .array(
      z.strictObject({
        id: Slug,
        label: z.string(),
        detail: z.string().optional(),
        glossary: z.string().optional(),
        href: z.string().optional(), // site-relative path without base, e.g. "/chain/memory-storage/"
      }),
    )
    .default([]), // static hotspots; data-driven scenes add runtime hotspots from their data payload
  data: z.enum(['none', 'segments', 'companies', 'models', 'trends', 'taiwan', 'curriculum', 'custom']),
  loop: z.enum(['continuous', 'demand']),
  budgetKB: z.number().int().max(60), // gzip budget of the scene chunk
});
export type SceneMeta = z.infer<typeof sceneMeta>;

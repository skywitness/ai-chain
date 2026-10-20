// src/data/roster/<segment-id>.yaml — the company id registry, one file per primary segment.
// FROZEN after Phase 0; changes go through proposals/.
import { z } from 'astro/zod';
import { EXCHANGES, Region, SEGMENT_IDS, Slug } from './common';

export const RosterEntry = z.strictObject({
  id: Slug,
  name: z.string().min(1),
  nameZh: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  profile: z.enum(['full', 'compact']),
  ownership: z.enum(['listed', 'private', 'subsidiary', 'state-owned', 'nonprofit']),
  status: z.enum(['active', 'acquired', 'merged', 'defunct']).default('active'),
  statusNote: z.string().optional(),
  parent: Slug.optional(),
  region: Region,
  hq: z.strictObject({
    city: z.string(),
    cityZh: z.string(),
    country: z.string().length(2),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
  website: z.url(),
  founded: z.number().int().min(1800).max(2026).optional(),
  listings: z.array(z.strictObject({ exchange: z.enum(EXCHANGES), ticker: z.string().min(1) })).default([]),
  stockanalysis: z.string().regex(/^(stocks\/[a-z0-9.-]+|quote\/[a-z]+\/[A-Za-z0-9.-]+)$/).nullable().default(null),
  twMonthly: z.string().regex(/^\d{4,6}\.TWO?$/).nullable().default(null),
  secondarySegments: z.array(z.enum(SEGMENT_IDS)).default([]),
  role: z.string().min(8), // 一句話：在 AI 產業鏈中的角色（zh-TW）
});
export const RosterFile = z.strictObject({
  segment: z.enum(SEGMENT_IDS),
  companies: z.array(RosterEntry).min(1),
});
export type RosterEntryT = z.infer<typeof RosterEntry>;

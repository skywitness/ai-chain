// Shared loaders for registries and content files (used by validate / lint / coverage scripts).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parse } from 'yaml';
import { SCENE_IDS, SEGMENT_IDS } from '../../src/schemas/common';

export type RosterCo = {
  id: string; name: string; nameZh: string; tier: 1 | 2 | 3; profile: 'full' | 'compact'; ownership: string;
  region: string; stockanalysis?: string | null; twMonthly?: string | null; secondarySegments?: string[];
  segment: string; listings?: { exchange: string; ticker: string }[]; hq: { lat: number; lon: number; city: string; cityZh: string; country: string };
  role: string; website: string; status?: string; parent?: string;
};

const readYaml = (p: string) => parse(readFileSync(p, 'utf8'));

export function loadRoster(): Map<string, RosterCo> {
  const m = new Map<string, RosterCo>();
  const dir = 'src/data/roster';
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = readYaml(`${dir}/${f}`) as { segment: string; companies: RosterCo[] };
    for (const c of doc?.companies ?? []) m.set(c.id, { ...c, segment: doc.segment });
  }
  return m;
}

export function loadCurriculum() {
  const doc = readYaml('src/data/curriculum.yaml') as {
    articles: { order: number; slug: string; level: number; track: string; title: string; prereqs: string[]; scene: string | null }[];
  };
  return new Map(doc.articles.map((a) => [a.slug, a]));
}

export function loadIndex(path: string, key: string): Map<string, any> {
  if (!existsSync(path)) return new Map();
  const doc = readYaml(path) as Record<string, any[]>;
  return new Map((doc[key] ?? []).map((x) => [x.id, x]));
}

export function loadGlossaryIndex(): Map<string, any> {
  const m = new Map<string, any>();
  const dir = 'src/data/glossary-index';
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = readYaml(`${dir}/${f}`) as { terms: any[] };
    for (const t of doc?.terms ?? []) m.set(t.id, t);
  }
  return m;
}

export function registries() {
  return {
    roster: loadRoster(),
    curriculum: loadCurriculum(),
    models: loadIndex('src/data/models-index.yaml', 'families'),
    trends: loadIndex('src/data/trends-index.yaml', 'trends'),
    benchmarks: loadIndex('src/data/benchmarks.yaml', 'benchmarks'),
    glossary: loadGlossaryIndex(),
    segments: new Set<string>(SEGMENT_IDS),
    scenes: new Set<string>(SCENE_IDS),
  };
}
export type Registries = ReturnType<typeof registries>;

/** Split an MDX file into frontmatter (parsed YAML) and body. */
export function readMdx(path: string): { data: any; body: string; bodyLine: number } {
  const src = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('missing frontmatter (--- … ---)');
  return { data: parse(m[1]!), body: m[2]!, bodyLine: m[1]!.split('\n').length + 3 };
}

export function readEntry(path: string): { data: any; body: string | null } {
  const ext = extname(path);
  if (ext === '.mdx' || ext === '.md') { const r = readMdx(path); return { data: r.data, body: r.body }; }
  if (ext === '.json') return { data: JSON.parse(readFileSync(path, 'utf8')), body: null };
  if (ext === '.yaml' || ext === '.yml') return { data: readYaml(path), body: null };
  throw new Error(`unsupported file type ${ext}`);
}

export const COLLECTIONS = ['learn', 'segments', 'companies', 'financials', 'models', 'trends', 'glossary', 'sources', 'pages'] as const;
export type Coll = (typeof COLLECTIONS)[number];

export function collectionOf(path: string): Coll | null {
  const m = path.replace(/\\/g, '/').match(/(?:^|\/)(?:src|research\/staging)\/content\/([^/]+)\//);
  return m && (COLLECTIONS as readonly string[]).includes(m[1]!) ? (m[1] as Coll) : null;
}
export const idOf = (path: string) => basename(path).replace(/\.(mdx|md|json|ya?ml)$/, '');

export function listContentFiles(): string[] {
  const out: string[] = [];
  for (const c of COLLECTIONS) {
    const dir = `src/content/${c}`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.(mdx|json|ya?ml)$/.test(f) && !f.startsWith('_')) out.push(`${dir}/${f}`);
  }
  return out;
}

/** Component usages in an MDX body: <Name attr="value" …>. */
export function componentUses(body: string, name: string, attr: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*?\\b${attr}=["']([^"']+)["']`, 'g');
  return [...body.matchAll(re)].map((m) => m[1]!);
}

// Build-time payload for /models/compare/: every version of every family with a content entry,
// flattened to display strings (see compare-core.ts). Owner: pages-models.
import { modelsCompareHref } from '../../lib/paths';
import { formatDate } from '../../lib/format';
import type { CompareBench, CompareData, CompareVersion } from './compare-core';
import {
  ARCH_LABELS,
  AVAILABILITY_LABELS,
  KIND_LABELS,
  ORIGIN_LABELS,
  REASONING_LABELS,
  REPORTER_LABELS,
  STATUS_LABELS,
  TIER_LABELS,
  WEIGHTS_LABELS,
  benchmarkMap,
  formatParams,
  formatScore,
  formatTokens,
  formatUsd,
  latestPrice,
  modalitiesText,
  pickBenchmark,
  type FamilyView,
} from './model-data';

export interface ComparePreset {
  label: string;
  keys: string[];
}

export function buildCompareData(families: readonly FamilyView[]): CompareData & { presets: ComparePreset[] } {
  const bmap = benchmarkMap();
  const versions: CompareVersion[] = [];
  const idCount = new Map<string, number>();
  for (const f of families) for (const v of f.versions) idCount.set(v.id, (idCount.get(v.id) ?? 0) + 1);

  const usedBench = new Set<string>();
  const strengths: Record<string, string[]> = {};
  for (const f of families) {
    if (!f.data) continue;
    strengths[f.id] = f.data.strengths.slice(0, 3);
    for (const v of f.versions) {
      const key = (idCount.get(v.id) ?? 0) > 1 ? `${f.id}.${v.id}` : v.id;
      const bench: CompareVersion['bench'] = {};
      for (const id of new Set(v.benchmarks.map((b) => b.benchmark))) {
        const b = pickBenchmark(v, id);
        if (!b) continue;
        const info = bmap.get(id);
        usedBench.add(id);
        bench[id] = {
          text: formatScore(b.score, info),
          score: b.score,
          date: b.date,
          reporter: REPORTER_LABELS[b.reportedBy] ?? b.reportedBy,
          setting: b.setting,
        };
      }
      const p = latestPrice(v);
      versions.push({
        key,
        id: v.id,
        name: v.name,
        familyId: f.id,
        familyTitle: f.title,
        href: f.href,
        lab: f.labName,
        origin: ORIGIN_LABELS[f.origin] ?? f.origin,
        kind: KIND_LABELS[f.kind] ?? f.kind,
        released: v.released,
        status: STATUS_LABELS[v.status] ?? v.status,
        tier: TIER_LABELS[v.tier] ?? v.tier,
        weights: WEIGHTS_LABELS[v.weights] ?? v.weights,
        open: v.weights !== 'closed',
        license: v.license === 'proprietary' ? '專有授權' : v.license,
        arch: ARCH_LABELS[v.architecture] ?? v.architecture,
        params: formatParams(v),
        modIn: modalitiesText(v.modalitiesIn),
        modOut: modalitiesText(v.modalitiesOut),
        context: formatTokens(v.contextTokens),
        maxOut: formatTokens(v.maxOutputTokens),
        cutoff: v.knowledgeCutoff ? formatDate(String(v.knowledgeCutoff), 'ym') : '未公開',
        reasoning: REASONING_LABELS[v.reasoning] ?? v.reasoning,
        availability: v.availability.map((a) => AVAILABILITY_LABELS[a] ?? a).join('、'),
        price: p
          ? {
              input: formatUsd(p.inputPerMTok),
              output: formatUsd(p.outputPerMTok),
              cached: p.cachedInputPerMTok !== undefined ? formatUsd(p.cachedInputPerMTok) : '—',
              asOf: p.asOf,
              note: p.tierNote,
            }
          : undefined,
        bench,
        flagship: v.id === f.flagship?.id,
      });
    }
  }

  const benches: CompareBench[] = [...bmap.values()]
    .filter((b) => usedBench.has(b.id))
    .sort((a, b) => a.order - b.order)
    .map((b) => ({ id: b.id, zh: b.zh, scale: b.scale, higherIsBetter: b.higherIsBetter }));

  // ── presets ──
  const keyOf = (f: FamilyView) => versions.find((v) => v.familyId === f.id && v.flagship)?.key;
  const llm = families
    .filter((f) => f.kind === 'llm' && f.data && f.flagship)
    .sort((a, b) => b.data!.positioning.capability - a.data!.positioning.capability);
  const pick = (list: FamilyView[], n: number) => list.slice(0, n).map(keyOf).filter((k): k is string => !!k);

  const defaults = (() => {
    const top = llm.slice(0, 3);
    const cn = llm.find((f) => f.origin === 'CN');
    const fourth = cn && !top.includes(cn) ? cn : llm[3];
    return pick([...top, ...(fourth ? [fourth] : [])], 4);
  })();

  const presets: ComparePreset[] = [];
  if (defaults.length >= 2) presets.push({ label: '能力最高的旗艦', keys: defaults });
  // Families whose current flagship has open weights (older open releases of closed families, such
  // as Grok 2 or Llama 4, are not today's flagships): the strongest three, plus the strongest one
  // from another region for contrast when there is one.
  const openFlag = llm.filter((f) => f.flagship && f.flagship.weights !== 'closed');
  const openTop = openFlag.slice(0, 3);
  const openOther = openFlag.find((f) => !openTop.includes(f) && !openTop.some((t) => t.origin === f.origin)) ?? openFlag[3];
  const openKeys = pick([...openTop, ...(openOther ? [openOther] : [])], 4);
  if (openKeys.length >= 2) presets.push({ label: '開放權重旗艦', keys: openKeys });
  const us = llm.find((f) => f.origin === 'US');
  const cn = llm.find((f) => f.origin === 'CN');
  const eu = llm.find((f) => f.origin === 'EU' || f.origin === 'CA');
  const tw = llm.find((f) => f.origin === 'TW' || f.origin === 'KR');
  const regional = pick([us, cn, eu, tw].filter((f): f is FamilyView => !!f), 4);
  if (regional.length >= 2) presets.push({ label: '各地區代表', keys: regional });
  // generations within the strongest family that has several priced flagship-tier versions
  for (const f of llm) {
    const gens = f.versions.filter((v) => v.tier === 'flagship' && v.status !== 'retired').slice(0, 4);
    if (gens.length >= 3) {
      const keys = gens.map((g) => versions.find((v) => v.familyId === f.id && v.id === g.id)?.key).filter((k): k is string => !!k);
      presets.push({ label: `${f.data!.family} 世代比較`, keys });
      break;
    }
  }
  const image = families.filter((f) => f.kind === 'image' && f.data && f.flagship);
  if (image.length >= 2) presets.push({ label: '圖像生成旗艦', keys: pick(image, 4) });

  return { versions, benches, defaults, strengths, compareHref: modelsCompareHref(), presets };
}

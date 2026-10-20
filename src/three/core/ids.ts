/**
 * Client-side copies of the segment / layer id lists. src/schemas/common.ts imports Zod at module
 * level, so importing its *values* would drag Zod into the browser bundle; only its types are used
 * here, and the checks below fail the type-check if the lists ever drift.
 */
import type { LayerId, SegmentId } from '../../schemas/common';

export const SEGMENT_IDS = [
  'energy-power',
  'semi-equipment-materials',
  'foundry-packaging',
  'memory-storage',
  'eda-ip-design',
  'ai-accelerators',
  'networking-optics',
  'servers-systems',
  'datacenter-infra',
  'cloud-neocloud',
  'foundation-models',
  'devtools-data-mlops',
  'apps-agents',
  'physical-ai',
] as const satisfies readonly SegmentId[];

export const LAYER_IDS = ['foundation', 'silicon', 'systems', 'cloud-models', 'applications'] as const satisfies readonly LayerId[];

/** Segment → layer (docs/SEGMENTS.md). */
export const SEGMENT_LAYER: Readonly<Record<SegmentId, LayerId>> = {
  'energy-power': 'foundation',
  'semi-equipment-materials': 'silicon',
  'foundry-packaging': 'silicon',
  'memory-storage': 'silicon',
  'eda-ip-design': 'silicon',
  'ai-accelerators': 'silicon',
  'networking-optics': 'systems',
  'servers-systems': 'systems',
  'datacenter-infra': 'systems',
  'cloud-neocloud': 'cloud-models',
  'foundation-models': 'cloud-models',
  'devtools-data-mlops': 'cloud-models',
  'apps-agents': 'applications',
  'physical-ai': 'applications',
};

type MissingSegment = Exclude<SegmentId, (typeof SEGMENT_IDS)[number]>;
type MissingLayer = Exclude<LayerId, (typeof LAYER_IDS)[number]>;
/** Compile-time completeness check (both must be `true`). */
export const IDS_COMPLETE: [MissingSegment] extends [never] ? ([MissingLayer] extends [never] ? true : never) : never = true;

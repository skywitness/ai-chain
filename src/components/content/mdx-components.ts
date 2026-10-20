// The single component map for MDX bodies. Page templates render:
//   const { Content, headings } = await render(entry);
//   <Content components={mdxComponents} />
// MDX authors use these tags without imports (docs/CONTENT-GUIDE.md §3). Owner: design-system agent.
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

import Term from './Term.astro';
import Cite from './Cite.astro';
import CompanyChip from './CompanyChip.astro';
import ModelChip from './ModelChip.astro';
import SegmentChip from './SegmentChip.astro';
import LearnLink from './LearnLink.astro';
import TrendLink from './TrendLink.astro';
import Callout from './Callout.astro';
import DeepDive from './DeepDive.astro';
import LevelSection from './LevelSection.astro';
import MathTeX from './MathTeX.astro';
import FlowSteps from './FlowSteps.astro';
import Compare from './Compare.astro';
import StatGrid from './StatGrid.astro';
import KeyTakeaways from './KeyTakeaways.astro';
import Figure from './Figure.astro';
import Diagram from './Diagram.astro';
import ScenePlaceholder from './ScenePlaceholder.astro';
import BarChart from '../charts/BarChart.astro';
import LineChart from '../charts/LineChart.astro';

// Scene3D belongs to the 3D agent; resolve it lazily so MDX keeps compiling before it exists.
const sceneModules = import.meta.glob<{ default: AstroComponentFactory }>('../scene/Scene3D.astro', { eager: true });
const Scene3D: AstroComponentFactory = Object.values(sceneModules)[0]?.default ?? ScenePlaceholder;

export const mdxComponents = {
  Term,
  Cite,
  CompanyChip,
  ModelChip,
  SegmentChip,
  LearnLink,
  TrendLink,
  Callout,
  DeepDive,
  LevelSection,
  MathTeX,
  FlowSteps,
  Compare,
  StatGrid,
  KeyTakeaways,
  Figure,
  Diagram,
  Scene3D,
  BarChart,
  LineChart,
} as const;

export type MdxComponentName = keyof typeof mdxComponents;
export default mdxComponents;

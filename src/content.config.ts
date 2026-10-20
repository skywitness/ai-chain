import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { makeSchemas, type Ref } from './schemas/index';

const S = makeSchemas(reference as unknown as Ref);
const g = (dir: string, pattern: string) => glob({ base: `./src/content/${dir}`, pattern });

export const collections = {
  learn: defineCollection({ loader: g('learn', '*.mdx'), schema: S.learn }),
  segments: defineCollection({ loader: g('segments', '*.mdx'), schema: S.segment }),
  companies: defineCollection({ loader: g('companies', '*.mdx'), schema: S.company }),
  financials: defineCollection({ loader: g('financials', '*.json'), schema: S.financials }),
  models: defineCollection({ loader: g('models', '*.mdx'), schema: S.model }),
  trends: defineCollection({ loader: g('trends', '*.mdx'), schema: S.trend }),
  glossary: defineCollection({ loader: g('glossary', '*.yaml'), schema: S.glossary }),
  sources: defineCollection({ loader: g('sources', '*.yaml'), schema: S.sourceRegistry }),
  pages: defineCollection({ loader: g('pages', '*.mdx'), schema: S.page }),
};

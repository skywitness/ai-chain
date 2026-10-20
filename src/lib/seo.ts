// SEO helpers: page title pattern, canonical URLs, Open Graph / Twitter meta and JSON-LD builders.
// BaseLayout calls buildSeo(); page templates add JSON-LD objects through the layout's `jsonLd` prop.
// Owner: design-system agent.
import { absoluteUrl, withBase, withTrailingSlash } from './paths';

export const SITE_NAME = 'AI 產業鏈全景';
export const SITE_NAME_EN = 'AI Chain Atlas';
export const SITE_TAGLINE = '從電力到智慧應用';
export const SITE_DESCRIPTION =
  '由淺入深認識 AI 產業鏈：從能源、半導體、伺服器與資料中心，到雲端、基礎模型與應用，整理公司、模型、趨勢與台灣供應鏈的角色。';
/** 資料基準日 (data snapshot date) shown in the footer and used as the default `dateModified`. */
export const DATA_DATE = '2026-10-06';
export const DISCLAIMER = '本站內容僅供教育參考，不構成投資建議';
export const LOCALE = 'zh_TW';
export const LANG = 'zh-TW';
/** Default social image (public/og/default.png, 1200×630); pages may pass their own `image`, e.g. ogImageFor('learn'). */
export const DEFAULT_OG_IMAGE: string | undefined = '/og/default.png';
/** theme-color per theme; must match --c-bg in tokens.css */
export const THEME_COLORS = { light: '#f8f5ee', dark: '#0b1322' } as const;

const SEP = '｜';

/** 「{頁面標題}｜AI 產業鏈全景」. A title that already contains the site name is used as is. */
export function pageTitle(title?: string | null): string {
  const t = (title ?? '').trim();
  if (!t) return `${SITE_NAME}${SEP}${SITE_TAGLINE}`;
  if (t.includes(SITE_NAME)) return t;
  return `${t}${SEP}${SITE_NAME}`;
}

/** Collapse whitespace and cut a description to ≤ max characters (CJK-aware, adds an ellipsis). */
export function clampDescription(text: string | undefined, max = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if ([...t].length <= max) return t;
  return `${[...t].slice(0, max - 1).join('')}…`;
}

/** Canonical absolute URL with trailing slash; strips query and hash. */
export function canonicalUrl(pathOrUrl: string | URL, site: URL | string | undefined): string {
  const raw = typeof pathOrUrl === 'string' ? pathOrUrl : pathOrUrl.pathname;
  const clean = raw.replace(/[?#].*$/, '');
  // pathOrUrl from Astro.url already contains the base path; withBase() will not prefix twice.
  return withTrailingSlash(absoluteUrl(clean, site));
}

export type JsonLd = Record<string, unknown>;

export interface SeoInput {
  title?: string | undefined;
  description?: string | undefined;
  /** site-relative path ('/learn/what-is-ai/') or the current Astro.url */
  path: string | URL;
  site: URL | string | undefined;
  image?: string | undefined; // site-relative ('/og/learn.png') or absolute
  imageAlt?: string | undefined;
  type?: 'website' | 'article' | 'profile' | undefined;
  noindex?: boolean | undefined;
  publishedTime?: string | undefined;
  modifiedTime?: string | undefined;
  section?: string | undefined;
  jsonLd?: JsonLd | JsonLd[] | undefined;
}

export interface SeoMeta {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  /** [property, content] pairs for <meta property> */
  og: Array<[string, string]>;
  /** [name, content] pairs for <meta name> */
  twitter: Array<[string, string]>;
  /** serialised JSON-LD strings, ready for <script type="application/ld+json" set:html> */
  jsonLd: string[];
}

export function buildSeo(input: SeoInput): SeoMeta {
  const title = pageTitle(input.title);
  const description = clampDescription(input.description || SITE_DESCRIPTION);
  const canonical = canonicalUrl(input.path, input.site);
  const imgPath = input.image ?? DEFAULT_OG_IMAGE;
  const image = imgPath ? absoluteUrl(imgPath, input.site) : undefined;
  const og: Array<[string, string]> = [
    ['og:type', input.type ?? 'website'],
    ['og:site_name', SITE_NAME],
    ['og:locale', LOCALE],
    ['og:title', title],
    ['og:description', description],
    ['og:url', canonical],
  ];
  if (image) og.push(['og:image', image]);
  if (image && input.imageAlt) og.push(['og:image:alt', input.imageAlt]);
  if (input.type === 'article') {
    if (input.publishedTime) og.push(['article:published_time', input.publishedTime]);
    if (input.modifiedTime) og.push(['article:modified_time', input.modifiedTime]);
    if (input.section) og.push(['article:section', input.section]);
  }
  const twitter: Array<[string, string]> = [
    ['twitter:card', image ? 'summary_large_image' : 'summary'],
    ['twitter:title', title],
    ['twitter:description', description],
  ];
  if (image) twitter.push(['twitter:image', image]);
  const blocks = input.jsonLd ? (Array.isArray(input.jsonLd) ? input.jsonLd : [input.jsonLd]) : [];
  return {
    title,
    description,
    canonical,
    robots: input.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large',
    og,
    twitter,
    jsonLd: blocks.map(serializeJsonLd),
  };
}

/** JSON.stringify that is safe inside <script>: escapes '<', '>' and '&' and U+2028/2029. */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ───────────── JSON-LD builders ─────────────
const ctx = { '@context': 'https://schema.org' } as const;

function publisher(site: URL | string | undefined): JsonLd {
  return {
    '@type': 'Organization',
    name: SITE_NAME,
    alternateName: SITE_NAME_EN,
    url: absoluteUrl('/', site),
    logo: absoluteUrl('/favicon.svg', site),
  };
}

export function websiteJsonLd(site: URL | string | undefined): JsonLd {
  return { ...ctx, '@type': 'WebSite', name: SITE_NAME, alternateName: SITE_NAME_EN, inLanguage: LANG, url: absoluteUrl('/', site), description: SITE_DESCRIPTION };
}

export interface BreadcrumbItem {
  label: string;
  href?: string | undefined; // already based (withBase) or site-relative
}
export function breadcrumbJsonLd(items: readonly BreadcrumbItem[], site: URL | string | undefined): JsonLd {
  return {
    ...ctx,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.label,
      ...(it.href ? { item: withTrailingSlash(absoluteUrl(it.href, site)) } : {}),
    })),
  };
}

export interface ArticleLdInput {
  title: string;
  description?: string | undefined;
  path: string | URL;
  site: URL | string | undefined;
  datePublished?: string | undefined;
  dateModified?: string | undefined;
  image?: string | undefined;
  section?: string | undefined;
  keywords?: string[] | undefined;
  /** 'LearningResource' adds educationalLevel */
  educationalLevel?: string | undefined;
}
export function articleJsonLd(a: ArticleLdInput): JsonLd {
  const url = canonicalUrl(a.path, a.site);
  return {
    ...ctx,
    '@type': a.educationalLevel ? ['Article', 'LearningResource'] : 'Article',
    headline: a.title,
    ...(a.description ? { description: a.description } : {}),
    inLanguage: LANG,
    url,
    mainEntityOfPage: url,
    ...(a.datePublished ? { datePublished: a.datePublished } : {}),
    dateModified: a.dateModified ?? a.datePublished ?? DATA_DATE,
    ...(a.image ? { image: absoluteUrl(a.image, a.site) } : {}),
    ...(a.section ? { articleSection: a.section } : {}),
    ...(a.keywords?.length ? { keywords: a.keywords.join(', ') } : {}),
    ...(a.educationalLevel ? { educationalLevel: a.educationalLevel, learningResourceType: 'Article' } : {}),
    author: publisher(a.site),
    publisher: publisher(a.site),
  };
}

export interface OrganizationLdInput {
  name: string;
  nameZh?: string | undefined;
  legalName?: string | undefined;
  url?: string | undefined; // official website
  path: string | URL; // our profile page
  site: URL | string | undefined;
  description?: string | undefined;
  foundingDate?: string | number | undefined;
  tickers?: string[] | undefined; // 'NASDAQ:NVDA'
  address?: { city?: string | undefined; country?: string | undefined } | undefined;
  employees?: number | undefined;
}
export function organizationJsonLd(o: OrganizationLdInput): JsonLd {
  return {
    ...ctx,
    '@type': 'Organization',
    name: o.name,
    ...(o.nameZh ? { alternateName: o.nameZh } : {}),
    ...(o.legalName ? { legalName: o.legalName } : {}),
    ...(o.url ? { url: o.url, sameAs: [o.url] } : {}),
    mainEntityOfPage: canonicalUrl(o.path, o.site),
    ...(o.description ? { description: o.description } : {}),
    ...(o.foundingDate ? { foundingDate: String(o.foundingDate) } : {}),
    ...(o.tickers?.length ? { tickerSymbol: o.tickers.length === 1 ? o.tickers[0] : o.tickers } : {}),
    ...(o.address ? { address: { '@type': 'PostalAddress', addressLocality: o.address.city, addressCountry: o.address.country } } : {}),
    ...(o.employees ? { numberOfEmployees: { '@type': 'QuantitativeValue', value: o.employees } } : {}),
  };
}

export interface DefinedTermLdInput {
  id: string;
  name: string;
  alternateName?: string[] | undefined;
  description: string;
  site: URL | string | undefined;
}
export function definedTermSetJsonLd(terms: readonly DefinedTermLdInput[], site: URL | string | undefined): JsonLd {
  const setUrl = canonicalUrl('/glossary/', site);
  return {
    ...ctx,
    '@type': 'DefinedTermSet',
    '@id': setUrl,
    name: `${SITE_NAME} 名詞解釋`,
    inLanguage: LANG,
    url: setUrl,
    hasDefinedTerm: terms.map((t) => ({
      '@type': 'DefinedTerm',
      '@id': `${setUrl}#${t.id}`,
      termCode: t.id,
      name: t.name,
      ...(t.alternateName?.length ? { alternateName: t.alternateName } : {}),
      description: t.description,
      inDefinedTermSet: setUrl,
      url: `${setUrl}#${t.id}`,
    })),
  };
}

export interface DatasetLdInput {
  name: string;
  description: string;
  path: string | URL;
  site: URL | string | undefined;
  dateModified?: string | undefined;
  sources?: ReadonlyArray<{ title: string; url: string; publisher?: string | undefined }> | undefined;
  keywords?: string[] | undefined;
}
export function datasetJsonLd(d: DatasetLdInput): JsonLd {
  return {
    ...ctx,
    '@type': 'Dataset',
    name: d.name,
    description: d.description,
    inLanguage: LANG,
    url: canonicalUrl(d.path, d.site),
    dateModified: d.dateModified ?? DATA_DATE,
    creator: publisher(d.site),
    isAccessibleForFree: true,
    ...(d.keywords?.length ? { keywords: d.keywords } : {}),
    ...(d.sources?.length
      ? {
          isBasedOn: d.sources.map((s) => ({
            '@type': 'CreativeWork',
            name: s.title,
            url: s.url,
            ...(s.publisher ? { publisher: { '@type': 'Organization', name: s.publisher } } : {}),
          })),
        }
      : {}),
  };
}

/** Site-relative OG image for a section, e.g. ogImageFor('learn') → '/og/learn.png'. */
export function ogImageFor(section: string): string {
  return withBase(`/og/${section}.png`);
}

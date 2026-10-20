// @ts-check
/**
 * Sätteri mdast plugin (Astro 7's Markdown/MDX processor; registered in astro.config.mjs): zh-TW typography
 * for Markdown/MDX bodies, applied at render time. Source files are not changed, so the content checks still
 * read them as written. Three fixes, all at the seams between text and inline elements:
 *
 * 1. A half-width space between two CJK characters across an inline element is dropped. Authors write
 *    `要靠 <Term id="x">交換器</Term> 互相` or `**…總稱。** 其中` (CommonMark needs that space to close `**`
 *    after 「。」), but a half-width space belongs only between CJK and Latin/digits (docs/STYLE-zh-TW.md).
 *    It is removed only when the characters on both sides are CJK, so 「使用 <Term>HBM</Term>」 keeps it.
 *    Self-closing chips (`<CompanyChip id="x" />`) are left alone: their label is unknown here.
 * 2. A citation never starts a line on its own: a word joiner (U+2060) after the character before <Cite>
 *    keeps 「…兩倍[2]。」 from wrapping as 「…兩倍」/「[2]。」 (the marker is an ordinary inline <sup>).
 * 3. Closing punctuation never starts a line after an atomic inline. Chips are inline-flex and <Term> is a
 *    button, so line-breaking rules do not reach across them (a word joiner is ignored there): the element
 *    and the punctuation after it are wrapped in `<span class="cjk-glue">` (white-space: nowrap; utilities.css).
 *
 * A plain plugin object: Sätteri's `defineMdastPlugin` only adds types, so nothing is imported here.
 */

const HAN = /[⺀-⿟々-〇〡-〩〸-〻㐀-䶿一-鿿豈-﫿]/u;
const CJK_PUNCT =
  /[　-〄〈-〠〰〽・︐-︙︰-﹏！-／：-＠［-｀｛-･—…·]/u;
/** Punctuation that must not start a line (kinsoku): stops, commas, closing brackets, ellipsis, dash. */
const CLOSING_RUN =
  /^[、。，．：；！？）」』】〉》〕〗〙］｝…—]+/u;
const WJ = '⁠';

const isCJK = (/** @type {string | undefined} */ ch) => !!ch && (HAN.test(ch) || CJK_PUNCT.test(ch));

/** Inline elements whose rendered box is atomic (inline-flex chips; <Term> renders a button). */
const ATOMIC = new Set(['CompanyChip', 'ModelChip', 'SegmentChip', 'Term']);
/** Inline elements whose own text decides rule 1. */
const INLINE_JSX = new Set(['Term', 'CompanyChip', 'ModelChip', 'SegmentChip', 'LearnLink', 'TrendLink']);
const INLINE_MD = new Set(['strong', 'emphasis', 'link', 'delete']);

/**
 * First / last visible character of an inline node's text ('' when it has no text of its own).
 * @param {any} node
 * @param {'first' | 'last'} which
 * @returns {string}
 */
function edgeChar(node, which) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') {
    const v = String(node.value ?? '');
    return which === 'first' ? (v.trimStart()[0] ?? '') : v.trimEnd().slice(-1);
  }
  const kids = Array.isArray(node.children) ? [...node.children] : [];
  if (which === 'last') kids.reverse();
  for (const k of kids) {
    const c = edgeChar(k, which);
    if (c) return c;
  }
  return '';
}

const isInline = (/** @type {any} */ n) =>
  INLINE_MD.has(n?.type) || (n?.type === 'mdxJsxTextElement' && INLINE_JSX.has(n.name));

/**
 * Apply the three rules to one run of phrasing content. Text values are edited in a local map first, so
 * rules touching the same text node (a space trimmed at both ends, punctuation taken off the front) compose;
 * each changed node is then written back once.
 * @param {readonly any[]} kids
 * @param {any} ctx Sätteri MdastVisitorContext
 */
function fixRun(kids, ctx) {
  /** @type {Map<any, string>} */
  const text = new Map();
  const get = (/** @type {any} */ n) => (text.has(n) ? /** @type {string} */ (text.get(n)) : String(n.value ?? ''));
  /** @type {{ node: any, punct: string }[]} */
  const wraps = [];

  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    const prev = kids[i - 1];
    const next = kids[i + 1];

    // Rule 1: CJK ␣ <inline>CJK… / …CJK</inline> ␣ CJK
    if (isInline(el) && el.children?.length) {
      const first = edgeChar(el, 'first');
      const last = edgeChar(el, 'last');
      if (prev?.type === 'text' && isCJK(first)) {
        const v = get(prev);
        const m = / +$/.exec(v);
        if (m && isCJK(v.slice(0, m.index).slice(-1))) text.set(prev, v.slice(0, m.index));
      }
      if (next?.type === 'text' && isCJK(last)) {
        const v = get(next);
        const m = /^ +/.exec(v);
        if (m && isCJK(v.slice(m[0].length)[0])) text.set(next, v.slice(m[0].length));
      }
    }

    // Rule 2: …字⁠<Cite />
    if (el?.type === 'mdxJsxTextElement' && el.name === 'Cite' && prev?.type === 'text') {
      const v = get(prev);
      if (v && !/\s$/.test(v) && !v.endsWith(WJ)) text.set(prev, v + WJ);
    }

    // Rule 3: <span class="cjk-glue"><Chip />。</span>
    if (el?.type === 'mdxJsxTextElement' && ATOMIC.has(el.name) && next?.type === 'text') {
      const v = get(next);
      const m = CLOSING_RUN.exec(v);
      if (m) {
        text.set(next, v.slice(m[0].length));
        wraps.push({ node: el, punct: m[0] });
      }
    }
  }

  for (const [node, value] of text) {
    if (value === String(node.value ?? '')) continue;
    if (value === '') ctx.removeNode(node);
    else ctx.setProperty(node, 'value', value);
  }
  for (const { node, punct } of wraps) {
    // wrapNode makes `node` the wrapper's first child and keeps the wrapper's own children after it.
    ctx.wrapNode(node, {
      type: 'mdxJsxTextElement',
      name: 'span',
      attributes: [{ type: 'mdxJsxAttribute', name: 'class', value: 'cjk-glue' }],
      children: [{ type: 'text', value: punct }],
    });
  }
}

const visit = (/** @type {any} */ node, /** @type {any} */ ctx) => {
  const kids = node.children;
  if (Array.isArray(kids) && kids.some((k) => k?.type === 'text')) fixRun(kids, ctx);
};

export default {
  name: 'cjk-typography',
  paragraph: visit,
  heading: visit,
  tableCell: visit,
};

// Compute the remaining work from what is actually on disk (session-independent).
// A company is "done" when src/content/companies/<id>.mdx exists and has editorial.status fact-checked.
// Usage: node research/plan/next-batches.mjs  → writes research/plan/next-args.json (+ prints a summary)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const all = JSON.parse(readFileSync('research/plan/c3-args.json', 'utf8')).items; // all 67 compact batches
const fm = (p) => {
  const m = readFileSync(p, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? parse(m[1]) : {};
};
const state = (id) => {
  const p = `src/content/companies/${id}.mdx`;
  if (!existsSync(p)) return 'missing';
  try { return fm(p)?.editorial?.status === 'fact-checked' ? 'checked' : 'written'; } catch { return 'written'; }
};

const items = [];
const summary = { done: 0, checkOnly: 0, writeAndCheck: 0 };
for (const b of all) {
  const st = b.ids.map(state);
  if (st.every((s) => s === 'checked')) { summary.done++; continue; }
  if (st.every((s) => s !== 'missing')) {
    summary.checkOnly++;
    items.push({ ...b, skipWrite: true, files: b.ids.flatMap((i) => [`src/content/companies/${i}.mdx`, `src/content/financials/${i}.json`].filter(existsSync)) });
  } else {
    summary.writeAndCheck++;
    items.push({ ...b, note: `${b.note} Some files for these ids may already exist from an interrupted run; check and finish them.` });
  }
}
writeFileSync('research/plan/next-args.json', JSON.stringify({ run: 'c3-next', searchBudget: 1, limit: 1, items }));
console.log(summary, 'remaining batches:', items.map((i) => i.label + (i.skipWrite ? '(check)' : '')).join(' '));

// Editorial rules beyond the schema: body length targets and required headings.
//   npx tsx scripts/check-content-rules.ts [files…]   (default: all MDX content)
import { readMdx, collectionOf, listContentFiles, idOf, loadRoster } from './lib/registry';

const roster = loadRoster();
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = (targets.length ? targets : listContentFiles()).filter((f) => f.endsWith('.mdx'));
// Count CJK characters + Latin words, ignoring JSX tags/attributes.
const length = (body: string) => {
  const t = body.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  return (t.match(/[一-鿿]/g)?.length ?? 0) + (t.match(/[A-Za-z0-9]+/g)?.length ?? 0);
};
const RANGE: Record<string, [number, number]> = {
  'learn-1': [1800, 3600], 'learn-2': [2700, 5600], 'learn-3': [3600, 7800],
  'segments': [2200, 5000], 'companies-full': [1300, 3500], 'companies-compact': [150, 800],
  'models': [1000, 2800], 'trends': [1300, 3400],
};
const REQUIRED: Record<string, string[]> = {
  learn: ['## 一句話解釋', '## 生活化比喻', '## 與產業鏈的連結'],
  models: ['## 系列概覽', '## 特性分析', '## 適合與不適合的用途', '## 版本演進', '## 評測解讀'],
  trends: ['## 趨勢摘要', '## 為什麼重要', '## 反方觀點與風險', '## 觀察指標'],
  segments: ['## 台灣的角色'],
};
let errors = 0, warnings = 0;
for (const f of files) {
  const c = collectionOf(f);
  if (!c) continue;
  let r;
  try { r = readMdx(f); } catch (e) { console.log(`✗ ${f}: ${(e as Error).message}`); errors++; continue; }
  const n = length(r.body);
  let key: string = c;
  if (c === 'learn') key = `learn-${r.data.level}`;
  if (c === 'companies') key = `companies-${roster.get(idOf(f))?.profile ?? r.data.profile}`;
  const range = RANGE[key];
  if (range && (n < range[0] || n > range[1])) { warnings++; console.log(`⚠ ${f}: body length ${n} outside target ${range[0]}–${range[1]}`); }
  for (const h of REQUIRED[c] ?? []) if (!r.body.includes(h)) { errors++; console.log(`✗ ${f}: missing heading "${h}"`); }
  if (c === 'segments') for (const lvl of [1, 2, 3]) if (!new RegExp(`<LevelSection[^>]*level=\{${lvl}\}`).test(r.body)) { errors++; console.log(`✗ ${f}: missing <LevelSection level={${lvl}}>`); }
  if (c === 'learn' && !/<DeepDive\b/.test(r.body)) { warnings++; console.log(`⚠ ${f}: no <DeepDive> section`); }
  const heads = [...r.body.matchAll(/^(#{2,6})\s/gm)].map((m) => m[1]!.length);
  heads.forEach((h, i) => { if (i > 0 && h > heads[i - 1]! + 1) { warnings++; console.log(`⚠ ${f}: heading level jumps from H${heads[i - 1]} to H${h}`); } });
}
console.log(`\n${files.length} MDX files · ${errors} errors · ${warnings} warnings`);
process.exit(errors ? 1 : 0);

// zh-TW lint: Simplified characters and mainland terms.
//   npx tsx scripts/check-zh.ts [files…]   (default: all content files)
// Source titles/publishers (objects with url + publisher) are skipped, because the
// original titles of zh-CN sources are legitimately Simplified.
import { readFileSync } from 'node:fs';
import * as OpenCC from 'opencc-js';
import { parse } from 'yaml';
import { listContentFiles } from './lib/registry';

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
// Valid Traditional characters that OpenCC's per-character cn→tw map would rewrite (上游、占比、干擾、里程碑、征服、凶手、雇主、斗山…).
const ALLOW = new Set(['台', '只', '才', '于', '干', '里', '面', '系', '准', '游', '占', '征', '范', '裏', '涌', '凶', '雇', '咨', '斗']);
const ERROR_TERMS: [RegExp, string][] = [
  [/芯片/g, '晶片'], [/內存/g, '記憶體'], [/軟件/g, '軟體'], [/硬件/g, '硬體'], [/服務器/g, '伺服器'],
  [/視頻/g, '影片'], [/數據中心/g, '資料中心'], [/網絡/g, '網路'], [/默認/g, '預設'], [/人工智能/g, '人工智慧'],
  [/鼠標/g, '滑鼠'], [/屏幕/g, '螢幕'], [/顯卡/g, '顯示卡'], [/集成電路/g, '積體電路'], [/操作系統/g, '作業系統'],
];
const WARN_TERMS: [RegExp, string][] = [
  [/信息/g, '資訊'], [/質量/g, '品質'], [/(?<!演)算法/g, '演算法'], [/智能(?!手錶|眼鏡|體)/g, '智慧'], [/程序/g, '程式（軟體語境）'],
  [/數據(?!機)/g, '資料（統計語境可保留數據）'], [/接口/g, '介面'], [/硅/g, '矽'], [/云/g, '雲'],
];

function proseStrings(v: unknown, out: string[]) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => proseStrings(x, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const isSource = 'url' in o && 'publisher' in o;
    for (const [k, x] of Object.entries(o)) {
      if (isSource && ['title', 'publisher', 'note', 'url', 'archiveUrl'].includes(k)) continue;
      if (['url', 'website', 'homepage'].includes(k)) continue;
      proseStrings(x, out);
    }
  }
}

function textOf(path: string): string {
  const src = readFileSync(path, 'utf8');
  const out: string[] = [];
  if (path.endsWith('.mdx') || path.endsWith('.md')) {
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (m) { proseStrings(parse(m[1]!), out); out.push(m[2]!.replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '')); }
    else out.push(src);
  } else if (path.endsWith('.json')) proseStrings(JSON.parse(src), out);
  else if (/\.ya?ml$/.test(path)) proseStrings(parse(src), out);
  else out.push(src);
  return out.join('\n');
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = targets.length ? targets : listContentFiles();
let errors = 0;
let warnings = 0;
for (const f of files) {
  let text: string;
  try { text = textOf(f); } catch (e) { console.log(`✗ ${f}: cannot read (${(e as Error).message})`); errors++; continue; }
  const simp = new Map<string, number>();
  for (const ch of text) {
    if (!/[一-鿿]/.test(ch) || ALLOW.has(ch)) continue;
    if (s2t(ch) !== ch) simp.set(ch, (simp.get(ch) ?? 0) + 1);
  }
  if (simp.size) {
    errors++;
    console.log(`✗ ${f}: Simplified characters: ${[...simp].map(([c, n]) => `${c}→${s2t(c)}(${n})`).join(' ')}`);
  }
  for (const [re, fix] of ERROR_TERMS) {
    const n = text.match(re)?.length ?? 0;
    if (n) { errors++; console.log(`✗ ${f}: mainland term "${re.source}" ×${n} → use "${fix}"`); }
  }
  for (const [re, fix] of WARN_TERMS) {
    if (!fix) continue;
    const n = text.match(re)?.length ?? 0;
    if (n) { warnings++; console.log(`⚠ ${f}: "${re.source}" ×${n} → consider "${fix}"`); }
  }
}
console.log(`\n${files.length} files · ${errors} errors · ${warnings} warnings`);
process.exit(errors ? 1 : 0);

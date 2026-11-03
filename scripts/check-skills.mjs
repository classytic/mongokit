#!/usr/bin/env node
/**
 * Skill check: keeps `skills/**` and `llms.txt` honest. Run from the package root after a build.
 *
 *   1. size budgets: SKILL.md body <= 6 KB, description <= 400 chars, each reference <= 8 KB, llms.txt <= 3 KB
 *   2. clean-break words, em-dashes and emojis are forbidden
 *   3. every `import { a, b } from '<spec>'` in the skills resolves to a built entry that exports a and b
 *   4. every `@classytic/<this-package>/<subpath>` mentioned is a real export subpath
 *   5. every API name in the "Do not hand-roll" tables and in llms.txt is exported by the built package
 *      (names listed in skills/<name>/check-allow.json are skipped: host-side names, methods, other packages)
 *   6. every reference file is linked from SKILL.md; every llms.txt name appears in the skills text
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const short = pkg.name.split('/').pop();
const skillDir = join(root, 'skills', short);
const errors = [];
const fail = (msg) => errors.push(msg);

const BUDGET = { body: 6 * 1024, description: 400, reference: 8 * 1024, llms: 3 * 1024 };
const BANNED = [/deprecated/i, /legacy/i, /formerly/i, /backwards? compat/i, /old way/i, /—/, /–/, /\p{Extended_Pictographic}/u];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(join(skillDir, 'SKILL.md'))) {
  console.error(`check-skills: missing skills/${short}/SKILL.md`);
  process.exit(1);
}
const skillFiles = walk(join(root, 'skills')).filter((f) => f.endsWith('.md'));
const llmsPath = join(root, 'llms.txt');
if (!existsSync(llmsPath)) fail('missing llms.txt at the package root');
const allowPath = join(skillDir, 'check-allow.json');
const allow = new Set(existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : []);

// ---- 1. sizes and frontmatter
const skillText = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skillText);
if (!fm) fail('SKILL.md has no frontmatter');
const body = fm ? skillText.slice(fm[0].length) : skillText;
if (Buffer.byteLength(body) > BUDGET.body) fail(`SKILL.md body ${Buffer.byteLength(body)} B > ${BUDGET.body} B`);
const desc = fm && /^description:\s*(.*)$/m.exec(fm[1]);
if (!desc) fail('frontmatter needs a single-line description');
else if (desc[1].replace(/^["']|["']$/g, '').length > BUDGET.description) fail(`description ${desc[1].length} chars > ${BUDGET.description}`);
if (fm && !/^name:\s*\S+/m.test(fm[1])) fail('frontmatter needs name');
if (fm && !/minVersion:\s*\S+/.test(fm[1])) fail('frontmatter needs metadata.minVersion');
for (const f of skillFiles) {
  if (f.includes(`${join('skills', short, 'references')}`) && Buffer.byteLength(readFileSync(f)) > BUDGET.reference) fail(`${f} > ${BUDGET.reference} B`);
}
if (existsSync(llmsPath) && statSync(llmsPath).size > BUDGET.llms) fail(`llms.txt ${statSync(llmsPath).size} B > ${BUDGET.llms} B`);

// ---- 2. banned words
for (const f of [...skillFiles, ...(existsSync(llmsPath) ? [llmsPath] : [])]) {
  const text = readFileSync(f, 'utf8');
  for (const re of BANNED) if (re.test(text)) fail(`${f}: forbidden text ${re}`);
}

// ---- 6a. references linked
for (const f of skillFiles.filter((p) => p.includes('references'))) {
  const base = f.split(/[\\/]/).pop();
  if (!skillText.includes(base)) fail(`SKILL.md does not link references/${base}`);
}

// ---- export resolution (type declarations of the built package)
const dist = join(root, 'dist');
if (!existsSync(dist)) {
  console.error('check-skills: dist/ missing, build the package first');
  process.exit(1);
}
const exportsMap = pkg.exports ?? {};
const closureCache = new Map();
function declFor(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return entry.types ?? entry.import ?? entry.default ?? null;
  return null;
}
function readClosure(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return '';
  seen.add(file);
  let text = readFileSync(file, 'utf8');
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(readFileSync(file, 'utf8')))) {
    const base = resolve(dirname(file), m[1]);
    const cands = [base.replace(/\.(m?js)$/, '.d.$1').replace('.d.js', '.d.ts').replace('.d.mjs', '.d.mts'), `${base}.d.mts`, `${base}.d.ts`, join(base, 'index.d.mts')];
    const hit = cands.find((c) => existsSync(c) && statSync(c).isFile());
    if (hit) text += '\n' + readClosure(hit, seen);
  }
  return text;
}
function subpathKey(spec) {
  const rest = spec.slice(pkg.name.length);
  return rest === '' ? '.' : `.${rest}`;
}
function declText(key) {
  if (closureCache.has(key)) return closureCache.get(key);
  const entry = exportsMap[key];
  const file = entry && declFor(entry);
  const text = file ? readClosure(resolve(root, file)) : null;
  closureCache.set(key, text);
  return text;
}
let allDecl;
function allText() {
  if (allDecl === undefined) allDecl = Object.keys(exportsMap).map((k) => declText(k) ?? '').join('\n');
  return allDecl;
}
function exportsName(text, name) {
  const n = name.replace(/[$]/g, '\\$');
  const braces = new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${n}\\b[^}]*\\}`);
  const decl = new RegExp(`export\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\\s*\\*?\\s*${n}\\b`);
  return braces.test(text) || decl.test(text);
}

// ---- 3 + 4. imports and subpaths
const mdFiles = skillFiles;
for (const f of mdFiles) {
  const text = readFileSync(f, 'utf8');
  const importRe = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(text))) {
    const spec = m[3];
    if (!spec.startsWith(pkg.name)) continue;
    const key = subpathKey(spec);
    const decl = declText(key);
    if (decl === null) {
      fail(`${f}: import from '${spec}' is not an export of ${pkg.name}`);
      continue;
    }
    const names = (m[2] ?? '').split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
    for (const name of names) if (!exportsName(decl, name)) fail(`${f}: '${name}' is not exported from '${spec}'`);
  }
  const spRe = new RegExp(`${pkg.name.replace('/', '\\/')}(\\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])?`, 'g');
  while ((m = spRe.exec(text))) {
    const spec = m[0].replace(/[.,;:)]+$/, '');
    if (spec !== pkg.name && !(subpathKey(spec) in exportsMap)) fail(`${f}: subpath '${spec}' is not in package.json exports`);
  }
}

// ---- 5. API names in the hand-roll tables and llms.txt
function tokensFrom(text) {
  const out = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) out.push(m[1].trim());
  return out;
}
function apiNameOf(token) {
  if (token.startsWith('@') || token.startsWith('/') || token.includes(' ') && !token.includes('(')) return null;
  const head = token.split('(')[0].split('<')[0].trim();
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(head)) return null;
  if (head.includes('.')) return null; // member of an instance or namespace
  return head;
}
function checkNames(label, tokens) {
  const all = allText();
  for (const token of tokens) {
    const name = apiNameOf(token);
    if (!name || allow.has(name) || allow.has(token)) continue;
    if (!exportsName(all, name)) fail(`${label}: '${name}' (from \`${token}\`) is not exported by ${pkg.name}; add it to check-allow.json only if it is a host-side or other-package name`);
  }
}
const handRoll = /^#{1,3}[^\n]*hand-roll[^\n]*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/im.exec(body);
if (!handRoll) fail('SKILL.md needs a "Do not hand-roll" section');
else {
  const rows = handRoll[1].split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[-\s|:]+\|?$/.test(l.trim()));
  if (rows.length - 1 < 10) fail(`"Do not hand-roll" table has ${Math.max(rows.length - 1, 0)} rows, need >= 10`);
  for (const row of rows.slice(1)) {
    const cells = row.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === ''));
    checkNames('hand-roll table', tokensFrom(cells.slice(1).join(' ')));
  }
}
let llmsText = '';
if (existsSync(llmsPath)) {
  llmsText = readFileSync(llmsPath, 'utf8');
  checkNames('llms.txt', tokensFrom(llmsText));
  const corpus = skillFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const token of tokensFrom(llmsText)) {
    const name = apiNameOf(token);
    if (name && !corpus.includes(name)) fail(`llms.txt names '${name}' but the skills never mention it`);
  }
}

if (errors.length) {
  console.error(`check-skills: ${errors.length} problem(s) in ${pkg.name}`);
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}
console.log(`check-skills: ok (${pkg.name}: ${skillFiles.length} md files)`);

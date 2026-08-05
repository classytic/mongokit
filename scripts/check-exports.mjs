#!/usr/bin/env node
/**
 * FAIL LOUD — every `exports` / `main` / `module` / `types` target must exist on disk.
 *
 * ## Why this exists (attw does NOT cover it)
 *
 * `attw --pack` exits **0** when the packed tarball contains no type
 * declarations at all — it prints "This package does not contain types" and
 * reports success. Verified 2026-08-05 by moving `dist/` aside:
 *
 *     $ mv dist dist.bak && npx attw --pack . --profile esm-only
 *     This package does not contain types.
 *     $ echo $?
 *     0
 *
 * So `lint:package` — and therefore `ci` and `prepublishOnly` — would pass on a
 * package that shipped zero `.d.mts` files. A gate that cannot fail is
 * decoration. This script is the part that fails.
 *
 * It also catches the cheaper, likelier regression: renaming a tsdown entry
 * without updating `exports`, which is a `TS2307` for every consumer and is
 * invisible in a green build.
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** @type {string[]} */
const problems = [];
let checked = 0;
let typeTargets = 0;

/** @param {string} label @param {unknown} target */
function checkTarget(label, target) {
  if (typeof target !== 'string') return;
  if (!target.startsWith('./')) {
    problems.push(`${label}: "${target}" is not a relative "./" specifier`);
    return;
  }
  checked += 1;
  if (label.endsWith('types')) typeTargets += 1;
  if (!existsSync(resolve(root, target))) {
    problems.push(`${label}: "${target}" does not exist on disk`);
  }
}

for (const field of ['main', 'module', 'types']) {
  checkTarget(field, pkg[field]);
}

for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
  if (typeof conditions === 'string') {
    checkTarget(`exports["${subpath}"]`, conditions);
    continue;
  }
  const entries = Object.entries(conditions ?? {});
  if (entries.length === 0) {
    problems.push(`exports["${subpath}"]: no conditions declared`);
    continue;
  }
  if (!('types' in (conditions ?? {}))) {
    // An untyped subpath resolves to `any` for consumers, silently.
    problems.push(`exports["${subpath}"]: no "types" condition`);
  }
  for (const [condition, target] of entries) {
    checkTarget(`exports["${subpath}"].${condition}`, target);
  }
}

// The vacuous-pass guard: a build that emitted no declarations must not read
// as success just because every declared target happens to be absent-free.
if (typeTargets === 0) {
  problems.push('no "types" targets declared anywhere — the package would ship untyped');
}

if (problems.length > 0) {
  console.error(`check-exports: ${problems.length} problem(s) in package.json:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRun `npm run build` first; if a dist path moved, update "exports" to match.');
  process.exit(1);
}

console.log(
  `check-exports: OK — ${checked} target(s) across ${Object.keys(pkg.exports ?? {}).length} subpath(s), ${typeTargets} typed.`,
);

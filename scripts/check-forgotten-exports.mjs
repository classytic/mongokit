#!/usr/bin/env node
/**
 * Forgotten-export gate — a type in a PUBLIC signature that a consumer cannot name.
 *
 * ## The bug this exists to stop
 *
 * `AggregationBuilder` is exported. Its `sort()` accepted
 * `Record<string, 1 | -1 | 'asc' | 'desc'>`, declared locally as `SortSpec`, and
 * that alias was never exported from any published entry. So a host could write
 * the argument as a literal:
 *
 *     builder.sort({ createdAt: 'desc' })            // fine — inferred
 *
 * but could not declare one:
 *
 *     const spec: ??? = { createdAt: 'desc' }        // no importable name
 *
 * The only `SortSpec` they COULD import was the narrower repository-level one
 * (`Record<string, 1 | -1>`), which rejects `'desc'` — so the obvious guess was
 * also the wrong one.
 *
 * Nothing caught it. `tsc` is happy: the type is reachable inside the bundle.
 * `knip` reports the opposite direction (exports nobody imports). `publint` and
 * `attw` check resolution and module format, not nameability.
 *
 * ## What this checks
 *
 * Over the BUILT `.d.mts` files — the artifact a consumer actually sees:
 *
 *   1. collect every locally-declared type/interface/class across ALL of `dist`,
 *      entries AND shared chunks (tsdown hoists shared declarations into chunks,
 *      so the entry file alone does not contain the class being checked);
 *   2. treat a name as PUBLIC if it carries an `export` modifier or appears as
 *      the local side of an export clause anywhere — bundler chunks re-export
 *      under short aliases (`export { AggregationBuilder as i }`), so matching
 *      on the local name is what survives that rewriting;
 *   3. collect every type NAME in an exported declaration's PARAMETER or RETURN
 *      position, and report any that is declared locally but never exported.
 *
 * Parameter/return position only, deliberately. A type buried inside an exported
 * type's body is reachable through its parent (a host names the parent), but a
 * parameter type is something the caller must construct and hold. That
 * distinction keeps this at real findings instead of every internal alias.
 *
 * Run: node scripts/check-forgotten-exports.mjs   (after `npm run build`)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');

function declarationFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) declarationFiles(full, out);
    else if (entry.endsWith('.d.mts') || entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const hasExportModifier = (node) =>
  node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

function collectTypeNames(node, into) {
  if (!node) return;
  if (ts.isTypeReferenceNode(node)) {
    const n = node.typeName;
    into.add(ts.isIdentifier(n) ? n.text : n.right.text);
  }
  node.forEachChild((c) => collectTypeNames(c, into));
}

const files = declarationFiles(DIST);
if (files.length === 0) {
  console.error('✖ No built .d.mts files found — run `npm run build` first.');
  process.exit(1);
}

/** name -> Set<file> */
const declared = new Map();
/** Every name that is publicly reachable under SOME export, anywhere. */
const exportedNames = new Set();
/** { file, source, statements } per file, kept for the second pass. */
const parsed = [];

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
  );
  parsed.push({ file, source });

  for (const stmt of source.statements) {
    const name =
      (ts.isTypeAliasDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isFunctionDeclaration(stmt)) &&
      stmt.name?.text;
    if (name) {
      if (!declared.has(name)) declared.set(name, new Set());
      declared.get(name).add(file);
      if (hasExportModifier(stmt)) exportedNames.add(name);
    }
    // `export { Local as public }` — the LOCAL side is what a chunk declares.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        exportedNames.add((el.propertyName ?? el.name).text);
      }
    }
  }
}

/** name -> owner label, for names needed in a public parameter/return position. */
const findings = new Map();

for (const { file, source } of parsed) {
  for (const stmt of source.statements) {
    const declName = stmt.name?.text;
    const isPublic = hasExportModifier(stmt) || (declName && exportedNames.has(declName));
    if (!isPublic) continue;

    const record = (sigNode, label) => {
      const names = new Set();
      for (const p of sigNode.parameters ?? []) collectTypeNames(p.type, names);
      collectTypeNames(sigNode.type, names);
      for (const n of names) {
        if (!declared.has(n)) continue; // external / built-in — not ours
        if (exportedNames.has(n)) continue;
        if (!findings.has(n)) findings.set(n, { label, file });
      }
    };

    if (ts.isFunctionDeclaration(stmt)) record(stmt, declName ?? '(function)');
    if (ts.isClassDeclaration(stmt)) {
      for (const m of stmt.members) {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isMethodSignature(m)) {
          record(m, `${declName}.${m.name?.getText(source) ?? 'constructor'}()`);
        }
      }
    }
    if (ts.isInterfaceDeclaration(stmt)) {
      for (const m of stmt.members) {
        if (ts.isMethodSignature(m)) record(m, `${declName}.${m.name?.getText(source)}()`);
      }
    }
  }
}

/**
 * Down-only ratchet, now at ZERO — the rule is absolute: a type in a public
 * parameter or return position must be importable, no exceptions.
 *
 * It shipped at 11 (the count when the check was written) and the whole set was
 * converted in the same pass, so the constant stays only to make a regression
 * read as "went up from 0" rather than a bare failure. It should never rise.
 */
const BASELINE = 0;

for (const [name, { label, file }] of findings) {
  console.error(`    ${name} — in ${label}, ${path.relative(ROOT, file)}, but never exported`);
}

if (findings.size > BASELINE) {
  console.error(
    `\n✖ Forgotten exports: ${findings.size} (baseline ${BASELINE}).\n\n` +
      'A NEW type in a public parameter or return position is not importable, so callers\n' +
      'can pass a literal but cannot declare a variable for it. Export it from the entry\n' +
      '(alias it if the name would collide).\n',
  );
  process.exit(1);
}

if (findings.size < BASELINE) {
  console.log(
    `check:forgotten-exports — ${findings.size} (baseline ${BASELINE}). ` +
      `Progress: LOWER BASELINE to ${findings.size} to lock it in.`,
  );
  process.exit(0);
}

console.log(
  `check:forgotten-exports — ${findings.size}, at baseline. No growth. ` +
    `(${files.length} declaration file(s) scanned.)`,
);

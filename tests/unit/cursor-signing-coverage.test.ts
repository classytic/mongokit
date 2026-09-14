/**
 * EVERY cursor-minting or cursor-accepting call site must pass the secret.
 *
 * Signing has one failure mode that testing a feature cannot catch: a door
 * nobody remembered. mongokit mints cursors from THREE places — the keyset
 * engine, `lookupPopulate`'s keyset branch, and the aggregate-IR path — and the
 * third was found by audit after the first two were already signed and tested.
 * A deployment with one unsigned endpoint is an unsigned deployment, and every
 * feature test still passes.
 *
 * So the property is asserted over the SOURCE, not over behaviour: a scan
 * reaches the call site added next month, which a hand-written test never does.
 * Same reasoning as the `timingSafeEqual` guard beside it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Files that legitimately hold cursor call sites. */
const FILES = [
  'src/pagination/PaginationEngine.ts',
  'src/Repository.ts',
  'src/actions/aggregate-ir/keyset.ts',
  'src/pagination/utils/cursor.ts',
] as const;

/** The functions that either mint a token or turn one into a query. */
const CURSOR_CALLS =
  /\b(encodeCursor|resolveCursorFilter|encodeAggCursor|decodeAggCursor|decodeCursor)\s*\(/g;

/** Read a balanced call expression starting at the opening paren. */
function callExpression(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

interface Site {
  file: string;
  line: number;
  fn: string;
  text: string;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of FILES) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(CURSOR_CALLS)) {
      const at = match.index ?? 0;
      // Skip the declarations themselves — `export function encodeCursor(`.
      const precededBy = source.slice(Math.max(0, at - 20), at);
      if (/\b(function|const|let)\s+$/.test(precededBy)) continue;

      sites.push({
        file,
        line: source.slice(0, at).split('\n').length,
        fn: match[1],
        text: callExpression(source, at + match[0].length - 1),
      });
    }
  }
  return sites;
}

describe('every cursor call site carries the signing key', () => {
  const sites = collectSites();

  it('finds the call sites at all — a scan that matches nothing is not a guard', () => {
    // Guards against a rename silently emptying this test, which would then
    // pass forever while proving nothing.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line} ${s.fn}()`, s] as const))(
    '%s passes a secret',
    (_label, site) => {
      // Either the repository's resolved config, or a `secret` parameter
      // threaded down to it. Anything else is a cursor nobody signs.
      expect(site.text).toMatch(/cursorSecret|\bsecret\b/);
    },
  );
});

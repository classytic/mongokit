/**
 * Search-as-you-type text rules, shared by the WRITER (the search keys stored on
 * every document) and the READER (the query typed into a search box).
 *
 * Both sides MUST run the same function, otherwise a key written as `mohammed`
 * is never found by a query normalised to `Mohammed`. That is also why this
 * module is pure (no mongoose, no driver): a portal or mobile client imports it
 * from `@classytic/mongokit/search` to highlight matches with the exact rules
 * the server indexed with.
 *
 * Rules, in order:
 *   1. lower-case (before NFKD: `'İ'.toLowerCase()` yields a combining dot the
 *      next step removes);
 *   2. Unicode NFKD, then every combining mark (`\p{M}`) dropped: `é → e`,
 *      `ﬁ → fi`, and Arabic tashkeel (fatha, damma, kasra, shadda, sukun,
 *      tanween, superscript alef) disappear;
 *   3. Arabic folding: tatweel removed; `أ إ آ ٱ → ا` (the hamza/madda forms
 *      decompose to bare alef in step 2, wasla is folded here); `ى → ي`;
 *      `ة → ه`; Arabic-Indic and Persian digits → ASCII digits;
 *   4. format characters (`\p{Cf}`: ZWJ, ZWNJ, bidi marks) removed so a pasted
 *      name does not split or miss;
 *   5. split on anything that is not a letter or a digit (whitespace and
 *      punctuation: `al-harbi` → `al`, `harbi`; `noura.saad@x.io` → `noura`,
 *      `saad`, `x`, `io`).
 */

/** Characters folded after the mark strip (step 3). */
const FOLD: Readonly<Record<string, string>> = {
  ٱ: 'ا', // alef wasla (no NFKD decomposition)
  ى: 'ي', // alef maksura → yeh
  ة: 'ه', // teh marbuta → heh
};

const MARKS = /\p{M}+/gu;
/** Tatweel (kashida) and format characters (ZWJ/ZWNJ, bidi controls). */
const DROPPED = /[ـ\p{Cf}]+/gu;
const FOLDED = /[ٱىة٠-٩۰-۹]/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/u;

function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return FOLD[ch] ?? ch;
}

/**
 * The search tokens of `text`, in order, duplicates kept. Empty for blank text
 * or text with no letters/digits.
 *
 * @example tokenizeSearchText('  Mohammed AL-Harbi ') // ['mohammed', 'al', 'harbi']
 * @example tokenizeSearchText('مُحَمَّد أحمد')        // ['محمد', 'احمد']
 */
export function tokenizeSearchText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const folded = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(MARKS, '')
    .replace(DROPPED, '')
    .replace(FOLDED, foldChar);
  return folded.split(SEPARATORS).filter((t) => t.length > 0);
}

/**
 * `text` normalised to its tokens joined by single spaces: the canonical form to
 * compare or display ("what the index sees").
 *
 * @example normalizeSearchText('Café  Crème') // 'cafe creme'
 */
export function normalizeSearchText(text: string): string {
  return tokenizeSearchText(text).join(' ');
}

/** A `[start, end)` range of the ORIGINAL text, as {@link findSearchMatches} returns. */
export interface SearchMatchRange {
  start: number;
  end: number;
}

/** A run of the original text that can hold a token (letters, digits, and the marks/tatweel/format chars the normaliser drops). */
const WORD = /[\p{L}\p{N}\p{M}ـ\p{Cf}]+/gu;

/**
 * Where `query` matches `text` under the prefix-search rules: for every word of
 * `text` whose normalised form starts with one of the query's tokens, the
 * shortest leading run of the ORIGINAL characters that covers that token.
 * Offsets index the original string, so a client wraps them in `<mark>` with no
 * re-normalisation of its own.
 *
 * @example findSearchMatches('Mohammed Al-Harbi', 'moh har')
 *          // [{ start: 0, end: 3 }, { start: 12, end: 15 }]
 */
export function findSearchMatches(text: string, query: string): SearchMatchRange[] {
  const terms = [...new Set(tokenizeSearchText(query))];
  if (terms.length === 0 || typeof text !== 'string') return [];
  const out: SearchMatchRange[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const start = m.index ?? 0;
    const normalized = tokenizeSearchText(word).join('');
    let best = 0;
    for (const term of terms) {
      if (!normalized.startsWith(term)) continue;
      // Shortest original prefix whose normalised form covers the term.
      for (let len = 1; len <= word.length; len += 1) {
        if (tokenizeSearchText(word.slice(0, len)).join('').length >= term.length) {
          // Swallow trailing marks/tatweel so a highlighted letter keeps its harakat.
          while (len < word.length && tokenizeSearchText(word.slice(len, len + 1)).length === 0)
            len += 1;
          best = Math.max(best, len);
          break;
        }
      }
    }
    if (best > 0) out.push({ start, end: start + best });
  }
  return out;
}

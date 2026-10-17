/**
 * Prefix search, pure half: the normaliser (Latin + Arabic), the stored keys,
 * the query filter, the highlight ranges, and the write analysis. No mongo.
 */

import { describe, expect, it } from 'vitest';
import { analyzeUpdate, unresolvedForUpdate, writeKeys } from '../../src/search/derive.js';
import {
  buildSearchKeys,
  findSearchMatches,
  normalizeSearchText,
  prefixSearchFilter,
  SEARCH_KEYS_ERROR_CODES,
  searchKeysIndex,
  tokenizeSearchText,
} from '../../src/search/index.js';

describe('tokenizeSearchText / normalizeSearchText', () => {
  it('lower-cases, strips diacritics (NFKD), splits on whitespace and punctuation', () => {
    expect(tokenizeSearchText('  Mohammed   AL-Harbi ')).toEqual(['mohammed', 'al', 'harbi']);
    expect(tokenizeSearchText('Café Crème, Zoë')).toEqual(['cafe', 'creme', 'zoe']);
    expect(tokenizeSearchText('noura.saad@test.io')).toEqual(['noura', 'saad', 'test', 'io']);
    expect(tokenizeSearchText('ﬁle Ｆｕｌｌ')).toEqual(['file', 'full']); // compatibility forms
    expect(tokenizeSearchText('İstanbul')).toEqual(['istanbul']);
    expect(normalizeSearchText("O'Brien  & Søn")).toBe('o brien søn');
  });

  it('is empty for blank, punctuation-only and non-string input', () => {
    expect(tokenizeSearchText('')).toEqual([]);
    expect(tokenizeSearchText('  -- !! ')).toEqual([]);
    expect(tokenizeSearchText(undefined as unknown as string)).toEqual([]);
  });

  it('Arabic: strips tashkeel and tatweel', () => {
    expect(normalizeSearchText('مُحَمَّد')).toBe('محمد');
    expect(normalizeSearchText('عَبْدُ اللّٰهِ')).toBe('عبد الله');
    expect(normalizeSearchText('محـــمد')).toBe('محمد'); // tatweel
  });

  it('Arabic: unifies alef forms, alef maksura and teh marbuta', () => {
    expect(normalizeSearchText('أحمد')).toBe('احمد');
    expect(normalizeSearchText('إبراهيم')).toBe('ابراهيم');
    expect(normalizeSearchText('آمنة')).toBe('امنه');
    expect(normalizeSearchText('ٱلرحمن')).toBe('الرحمن');
    expect(normalizeSearchText('مصطفى')).toBe('مصطفي');
    expect(normalizeSearchText('فاطمة')).toBe('فاطمه');
    // Every spelling of one name lands on one key.
    const spellings = ['أَحْمَد', 'احمد', 'إحمد', 'آحمد', 'أحـمد'];
    expect(new Set(spellings.map(normalizeSearchText))).toEqual(new Set(['احمد']));
  });

  it('Arabic: Arabic-Indic and Persian digits become ASCII; ZWNJ does not split', () => {
    expect(normalizeSearchText('٠٥٥١٢٣')).toBe('055123');
    expect(normalizeSearchText('۱۲۳')).toBe('123');
    expect(tokenizeSearchText('می‌خواهم')).toEqual(['میخواهم']);
  });
});

describe('buildSearchKeys', () => {
  it('distinct tokens of every field, dotted paths and arrays flattened', () => {
    expect(
      buildSearchKeys(
        { name: 'Ahmed bin Ali', email: 'ahmed.ali@x.io', tags: ['Ali', 'Gold Team'], n: 7 },
        ['name', 'tags', 'n'],
      ),
    ).toEqual(['ahmed', 'bin', 'ali', 'gold', 'team', '7']);
    expect(
      buildSearchKeys({ contacts: [{ name: 'Sara' }, { name: 'Lina Saleh' }] }, ['contacts.name']),
    ).toEqual(['sara', 'lina', 'saleh']);
    expect(buildSearchKeys({ name: null }, ['name', 'missing'])).toEqual([]);
  });
});

describe('prefixSearchFilter', () => {
  it('one anchored, case-sensitive regex arm per distinct word (AND); string form, JSON-safe', () => {
    expect(prefixSearchFilter('Moh')).toEqual({ _searchKeys: { $regex: '^moh' } });
    const f = prefixSearchFilter('Moh  ali moh', { keysField: 'nameKeys' });
    expect(f).toEqual({
      $and: [{ nameKeys: { $regex: '^moh' } }, { nameKeys: { $regex: '^ali' } }],
    });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it('normalises the query with the writer rules (Arabic spelling variants meet)', () => {
    expect(prefixSearchFilter('أحمَ')).toEqual({ _searchKeys: { $regex: '^احم' } });
  });

  it('null when the query has no tokens; caps the arms', () => {
    expect(prefixSearchFilter('  ...  ')).toBeNull();
    const f = prefixSearchFilter('a b c d e f g h i j', { maxTerms: 3 }) as { $and: unknown[] };
    expect(f.$and).toHaveLength(3);
  });

  it('index declaration names the keys field', () => {
    expect(searchKeysIndex()).toEqual({
      fields: { _searchKeys: 1 },
      options: { name: '_searchKeys_1' },
    });
    expect(searchKeysIndex('nameKeys', { name: 'nameKeys' }).options.name).toBe('nameKeys');
  });
});

describe('findSearchMatches (client highlighting)', () => {
  it('ranges index the ORIGINAL text', () => {
    const text = 'Mohammed Al-Harbi';
    const ranges = findSearchMatches(text, 'moh HAR');
    expect(ranges).toEqual([
      { start: 0, end: 3 },
      { start: 12, end: 15 },
    ]);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['Moh', 'Har']);
  });

  it('Arabic: a highlighted prefix keeps its harakat, query spelling does not matter', () => {
    const text = 'أَحْمَد علي';
    const [r] = findSearchMatches(text, 'احم');
    expect(r).toBeDefined();
    // Covers أَحْمَ (letters + their marks), not the trailing د.
    expect(text.slice(r!.start, r!.end)).toBe('أَحْمَ');
  });

  it('no match, no ranges', () => {
    expect(findSearchMatches('Sara Zahrani', 'li')).toEqual([]);
    expect(findSearchMatches('Sara', '  ')).toEqual([]);
  });
});

describe('analyzeUpdate (write-path analysis)', () => {
  const fields = ['name', 'email'];

  it('plain patch and $set resolve fields; ancestors resolve nested paths', () => {
    expect(analyzeUpdate({ name: 'A' }, {}, fields, '_k').updated).toEqual({ name: 'A' });
    const e = analyzeUpdate({ $set: { profile: { name: 'Z' } } }, {}, ['profile.name'], '_k');
    expect(e.updated).toEqual({ 'profile.name': ['Z'] });
  });

  it('$unset clears; $setOnInsert is insert-only; filter equalities pin current values', () => {
    const e = analyzeUpdate(
      { $unset: { email: '' }, $setOnInsert: { name: 'N' } },
      { name: 'N', status: 'x' },
      fields,
      '_k',
    );
    expect(e.updated).toEqual({ email: undefined });
    expect(e.onInsert).toEqual({ name: 'N' });
    expect(e.pinned).toEqual({ name: 'N' });
    expect(unresolvedForUpdate(e, fields)).toEqual([]);
  });

  it('strips caller-supplied keys from every slot', () => {
    const plain: Record<string, unknown> = { name: 'A', _k: ['forged'] };
    analyzeUpdate(plain, {}, fields, '_k');
    expect(plain).toEqual({ name: 'A' });
    const op: Record<string, unknown> = { $set: { _k: ['x'] }, $setOnInsert: { _k: ['y'] } };
    analyzeUpdate(op, {}, fields, '_k');
    expect(op).toEqual({ $set: {}, $setOnInsert: {} });
  });

  it('refuses operators and partial paths it cannot follow', () => {
    for (const update of [
      { $push: { name: 'x' } },
      { $rename: { name: 'n2' } },
      { $set: { 'name.0': 'x' } },
      [{ $set: { name: { $concat: ['$name', '!'] } } }],
      [{ $replaceWith: { a: 1 } }],
    ]) {
      expect(() => analyzeUpdate(update, {}, fields, '_k')).toThrow(
        expect.objectContaining({ code: SEARCH_KEYS_ERROR_CODES.UNSUPPORTED_UPDATE, status: 400 }),
      );
    }
    // Operators on OTHER fields are fine.
    expect(() => analyzeUpdate({ $inc: { n: 1 } }, {}, fields, '_k')).not.toThrow();
    expect(() => analyzeUpdate([{ $set: { n: 1 } }], {}, fields, '_k')).not.toThrow();
  });

  it('writeKeys: plain patch gets the key, operator update gets $set / $setOnInsert', () => {
    const plain: Record<string, unknown> = { name: 'A' };
    writeKeys(plain, '_k', ['a']);
    expect(plain).toEqual({ name: 'A', _k: ['a'] });
    const op: Record<string, unknown> = { $set: { name: 'A' } };
    writeKeys(op, '_k', ['a']);
    expect(op).toEqual({ $set: { name: 'A', _k: ['a'] } });
    const ins: Record<string, unknown> = { $setOnInsert: { name: 'A' } };
    writeKeys(ins, '_k', ['a'], '$setOnInsert');
    expect(ins).toEqual({ $setOnInsert: { name: 'A', _k: ['a'] } });
  });
});

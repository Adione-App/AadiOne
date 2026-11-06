/**
 * Smart Search shared core (src/shared/search-*.ts) — the normalisation,
 * transliteration and ranking rules both the SQL engine and the in-memory
 * matcher (web panels, mobile app) run.
 */

import { describe, expect, it } from 'vitest';
import {
  devanagariToRoman,
  editDistance,
  normalizeIdentifier,
  normalizeSearchText,
  phoneticKey,
} from '../../src/shared/search-text';
import {
  SEARCH_SOURCE_RULES,
  SEARCH_TIER,
  analyzeSearchQuery,
  buildSearchTerms,
  createSmartMatcher,
  lookupSynonymGroups,
  matchTier,
  smartSearch,
  trigramSimilarity,
} from '../../src/shared/search-match';
import { SEARCH_SYNONYM_GROUPS } from '../../src/shared/search-dictionary';

describe('normalisation', () => {
  it('folds case, accents, punctuation and spacing, keeping Hindi intact', () => {
    expect(normalizeSearchText('  Okra - Lady’s Finger (भिंडी) ')).toBe('okra ladys finger भिंडी');
    expect(normalizeSearchText('CAFÉ   Crème')).toBe('cafe creme');
    expect(normalizeSearchText('Zed Black 3-in-1')).toBe('zed black 3 in 1');
    expect(normalizeSearchText('ke​la')).toBe('kela');
    expect(normalizeSearchText('')).toBe('');
  });

  it('normalises identifiers for order numbers and codes', () => {
    expect(normalizeIdentifier('# ad-2611 06')).toBe('AD261106');
  });
});

describe('Hindi transliteration', () => {
  it.each([
    ['केला', 'kelaa'],
    ['आलू', 'aaloo'],
    ['टमाटर', 'tamaatar'],
    ['प्याज', 'pyaaj'],
    ['दूध', 'doodh'],
    ['सेब', 'seb'],
    ['दही', 'dahee'],
    ['चावल', 'chaaval'],
    ['नमकीन', 'namkeen'],
    ['अदरक', 'adrak'],
    ['बिस्किट', 'biskit'],
    ['न', 'na'],
  ])('%s -> %s', (hindi, roman) => {
    expect(devanagariToRoman(hindi)).toBe(roman);
  });

  it('treats a nukta written separately like the composed letter', () => {
    expect(devanagariToRoman('ज़ेड')).toBe(devanagariToRoman('ज़ेड'));
    expect(devanagariToRoman('ज़ेड')).toBe('zed');
  });

  it('leaves non-Hindi text alone', () => {
    expect(devanagariToRoman('Banana (केला)')).toBe('Banana (kelaa)');
  });
});

describe('phonetic key', () => {
  it.each([
    [['aloo', 'alu', 'आलू', 'aaloo'], 'alu'],
    [['pyaz', 'pyaaz', 'pyaj', 'pyaaj', 'प्याज'], 'pyaj'],
    [['doodh', 'dudh', 'dud', 'दूध'], 'dud'],
    [['banana', 'baanana', 'bananna', 'bananaa'], 'banana'],
    [['kela', 'kelaa', 'केला', 'kayla'], 'kela'],
    [['seb', 'saib', 'सेब'], 'seb'],
    [['chawal', 'chaval', 'चावल'], 'chaval'],
    [['nimbu', 'नींबू'], 'nimbu'],
  ])('%j share the key %s', (spellings, key) => {
    for (const spelling of spellings) expect(phoneticKey(spelling), spelling).toBe(key);
  });

  it('keeps short different words apart', () => {
    expect(phoneticKey('seb')).not.toBe(phoneticKey('sev'));
    expect(phoneticKey('dal')).not.toBe(phoneticKey('dahi'));
  });

  it('has a no-vowel-folding variant for "keela"', () => {
    expect(phoneticKey('keela', { foldLongVowels: false })).toBe('kela');
  });
});

describe('edit distance and trigrams', () => {
  it('bounds the edit distance', () => {
    expect(editDistance('banana', 'banna')).toBe(1);
    expect(editDistance('banana', 'xxxxxxxxxx', 2)).toBe(3);
  });

  it('matches pg_trgm similarity', () => {
    // SELECT similarity('banna', 'banana') = 0.5 in PostgreSQL.
    expect(trigramSimilarity('banna', 'banana')).toBeCloseTo(0.5, 5);
    expect(trigramSimilarity('abc', 'abc')).toBe(1);
  });
});

describe('dictionary', () => {
  it('has no empty or single-member groups', () => {
    for (const group of SEARCH_SYNONYM_GROUPS) expect(group.length, JSON.stringify(group)).toBeGreaterThanOrEqual(2);
  });

  it('finds groups by any spelling and by a small typo only', () => {
    expect(lookupSynonymGroups('kela').some((g) => g.members.includes('banana'))).toBe(true);
    expect(lookupSynonymGroups('केला').some((g) => g.members.includes('banana'))).toBe(true);
    expect(lookupSynonymGroups('tamatr').some((g) => g.members.includes('tomato'))).toBe(true);
    expect(lookupSynonymGroups('chinese').some((g) => g.members.includes('cheese'))).toBe(false);
    expect(lookupSynonymGroups('laptop')).toEqual([]);
  });
});

describe('indexed terms', () => {
  it('indexes the name, its bracketed Hindi, words, transliteration and synonyms — each term once', () => {
    const terms = buildSearchTerms([
      { text: 'Banana (केला)', source: 'NAME' },
      { text: 'केला', source: 'NAME_HI' },
      { text: 'kela', source: 'KEYWORD' },
      { text: 'Fruits', source: 'CATEGORY' },
    ]);
    const byTerm = new Map(terms.map((t) => [t.term, t]));
    expect(byTerm.get('banana केला')?.source).toBe('NAME');
    expect(byTerm.get('banana')?.source).toBe('NAME');
    expect(byTerm.get('केला')?.source).toBe('NAME_ALT');
    expect(byTerm.get('kelaa')?.source).toBe('TRANSLIT');
    // A synonym of the WHOLE name is an alias of the product itself.
    expect(byTerm.get('kela')?.source).toBe('NAME_SYNONYM');
    expect(byTerm.get('fruits')?.source).toBe('CATEGORY');
    expect(new Set(terms.map((t) => t.term)).size).toBe(terms.length);
  });

  it('splits slash alternatives', () => {
    const terms = buildSearchTerms([{ text: 'Toor / Arhar Dal', source: 'NAME' }]).map((t) => t.term);
    expect(terms).toEqual(expect.arrayContaining(['toor', 'arhar dal']));
  });
});

describe('query analysis', () => {
  it('keeps one-letter queries to name prefixes', () => {
    const query = analyzeSearchQuery('a');
    expect(query.probes.map((p) => p.kind).sort()).toEqual(['nameprefix', 'term']);
  });

  it('drops one-letter words from longer queries and counts significant words', () => {
    const query = analyzeSearchQuery('amul a milk');
    expect(query.tokens).toEqual(['amul', 'milk']);
    expect(query.significantTokens).toBe(2);
  });

  it('never lets a weak match type outrank a stronger one', () => {
    const term = { term: 'banana', key: 'banana', source: 'NAME_TOKEN' as const, weight: SEARCH_SOURCE_RULES.NAME_TOKEN.weight };
    const exact = matchTier({ unit: 0, kind: 'term', value: 'banana', tier: SEARCH_TIER.EXACT_ALIAS, minSimilarity: 0 }, term);
    const fuzzy = matchTier({ unit: 0, kind: 'fuzzy', value: 'bana', tier: SEARCH_TIER.FUZZY, minSimilarity: 0.5 }, term);
    expect(exact.tier).toBeGreaterThan(fuzzy.tier);
    // A category can never reach an alias tier.
    const category = matchTier(
      { unit: 0, kind: 'term', value: 'fruits', tier: SEARCH_TIER.EXACT_NORMALIZED, minSimilarity: 0 },
      { term: 'fruits', key: 'fruits', source: 'CATEGORY', weight: 40 },
    );
    expect(category.tier).toBe(2);
  });
});

describe('smartSearch (in-memory)', () => {
  const items = [
    'Banana (केला)',
    'Raw Banana (कच्चा केला)',
    'Potato (आलू)',
    'Veg Aloo Tikki Burger',
    'Tomato (टमाटर)',
    'Onion (प्याज)',
    'Amul Milk',
    'Curd',
    'Rice',
    'Imported Apple (इम्पोर्टेड सेब)',
    'Sweet Lime (मौसंबी)',
    'Lemon (नींबू)',
    'Urban Cotton Shirt',
  ].map((name) => ({ name }));
  const find = (q: string) => smartSearch(items, q, (item) => [{ text: item.name, source: 'NAME' }]).map((item) => item.name);

  it.each([
    ['Banana', 'Banana (केला)'],
    ['Banna', 'Banana (केला)'],
    ['Bananaa', 'Banana (केला)'],
    ['केला', 'Banana (केला)'],
    ['Kela', 'Banana (केला)'],
    ['Keela', 'Banana (केला)'],
    ['Kayla', 'Banana (केला)'],
    ['Aloo', 'Potato (आलू)'],
    ['आलू', 'Potato (आलू)'],
    ['Tamat ar', 'Tomato (टमाटर)'],
    ['Pyaaj', 'Onion (प्याज)'],
    ['Dud', 'Amul Milk'],
    ['Saib', 'Imported Apple (इम्पोर्टेड सेब)'],
    ['Dahi', 'Curd'],
    ['Chaal', 'Rice'],
    ['nimbu', 'Lemon (नींबू)'],
    ['tom', 'Tomato (टमाटर)'],
  ])('"%s" finds %s first', (q, expected) => {
    expect(find(q)[0]).toBe(expected);
  });

  it('does not tag Sweet Lime as lemon, nor Urban as banana', () => {
    expect(find('nimbu')).not.toContain('Sweet Lime (मौसंबी)');
    expect(find('ban')).not.toContain('Urban Cotton Shirt');
  });

  it('returns nothing for unrelated text and everything for an empty query', () => {
    expect(find('xyzzy')).toEqual([]);
    expect(find('   ')).toHaveLength(items.length);
  });

  it('createSmartMatcher answers per item with the same rules', () => {
    const matcher = createSmartMatcher('kela');
    expect(matcher.matches(items[0], [{ text: items[0]!.name, source: 'NAME' }])).toBe(true);
    expect(matcher.matches(items[2], [{ text: items[2]!.name, source: 'NAME' }])).toBe(false);
    expect(createSmartMatcher('').active).toBe(false);
  });
});

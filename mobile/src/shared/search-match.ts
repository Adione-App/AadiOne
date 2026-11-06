/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Smart Search — the matching and ranking rules, shared by every search.
 *
 * Two executions of ONE rule set:
 *   - SQL, over the indexed `product_search_terms` table (backend
 *     infra/search/engine.ts builds its probes with `searchProbes`), for the
 *     catalogue-sized lists — customer search, admin products/inventory, the
 *     Home builder's product picker, seller orders by item;
 *   - in memory (`smartSearch`), for lists a screen or service already holds
 *     in full — the seller's own products, categories, restaurants, the
 *     admin catalogue explorer. `buildSearchTerms` here is the same function
 *     the indexer stores rows from, and `matchTier` is the same decision the
 *     SQL CASE makes, so a word matches in both or in neither.
 *
 * Ranking: every (query word, indexed term) match lands in one TIER; a better
 * tier always wins over any amount of a worse one, so a weak fuzzy match can
 * never outrank an exact one.
 *
 *   8 EXACT_NAME        the product's name exactly as typed
 *   7 EXACT_NORMALIZED  the whole name, ignoring case/punctuation/brackets
 *   6 EXACT_ALIAS       a whole word of the name, Hindi name, keyword, brand
 *   5 SYNONYM           a dictionary synonym (banana <-> kela <-> केला)
 *   4 PHONETIC          same sound, other spelling or script (kelaa, केला)
 *   3 PREFIX            a word starting with the query (ban -> banana)
 *   2 PARTIAL           the query inside a word
 *   1 FUZZY             a typo (banna -> banana), trigram similarity
 *
 * Within a tier: how many query words matched, then the field's weight
 * (name > keyword > brand > category), then similarity.
 */

import { SEARCH_SYNONYM_GROUPS } from './search-dictionary';
import { devanagariToRoman, editDistance, hasDevanagari, normalizeSearchText, phoneticKey, typoBudget } from './search-text';

export const SEARCH_TIER = {
  EXACT_NAME: 8,
  EXACT_NORMALIZED: 7,
  EXACT_ALIAS: 6,
  SYNONYM: 5,
  PHONETIC: 4,
  PREFIX: 3,
  PARTIAL: 2,
  FUZZY: 1,
} as const;

/** Where an indexed term came from. Stored in product_search_terms.source. */
export type SearchTermSource =
  | 'NAME'
  | 'NAME_ALT'
  | 'NAME_TOKEN'
  | 'NAME_HI'
  | 'NAME_SYNONYM'
  | 'KEYWORD'
  | 'BRAND'
  | 'SYNONYM'
  | 'TRANSLIT'
  | 'CATEGORY';

/** Field weight (within-tier ordering) and the best tier the field can reach. */
export const SEARCH_SOURCE_RULES: Readonly<Record<SearchTermSource, { weight: number; cap: number }>> = {
  NAME: { weight: 100, cap: SEARCH_TIER.EXACT_NORMALIZED },
  NAME_ALT: { weight: 94, cap: SEARCH_TIER.EXACT_ALIAS },
  NAME_TOKEN: { weight: 90, cap: SEARCH_TIER.EXACT_ALIAS },
  NAME_HI: { weight: 88, cap: SEARCH_TIER.EXACT_ALIAS },
  /** A synonym of the WHOLE name ("aloo" for "Potato (आलू)"): an alias of the product itself. */
  NAME_SYNONYM: { weight: 93, cap: SEARCH_TIER.EXACT_ALIAS },
  KEYWORD: { weight: 85, cap: SEARCH_TIER.EXACT_ALIAS },
  BRAND: { weight: 70, cap: SEARCH_TIER.EXACT_ALIAS },
  SYNONYM: { weight: 75, cap: SEARCH_TIER.SYNONYM },
  TRANSLIT: { weight: 75, cap: SEARCH_TIER.PHONETIC },
  CATEGORY: { weight: 40, cap: 2 },
};

/** Fuzzy (trigram) similarity a typo needs, by query key length. */
export function fuzzyThreshold(keyLength: number): number {
  return keyLength >= 7 ? 0.42 : 0.5;
}

/** Longest query that is searched; anything after this is ignored. */
export const SEARCH_MAX_QUERY_LENGTH = 80;
const MAX_TERM_LENGTH = 160;
const MAX_QUERY_TOKENS = 6;

/* -------------------------------------------------------------------------- */
/* Synonym dictionary index                                                   */
/* -------------------------------------------------------------------------- */

interface SynonymGroup {
  members: string[];
  /** phoneticKey of each member (multi-word members: compact). */
  keys: string[];
}

interface SynonymIndex {
  groups: SynonymGroup[];
  byKey: Map<string, number[]>;
  /** Every distinct single-word member key, for typo lookup. */
  fuzzyKeys: { key: string; groupIds: number[] }[];
}

let synonymIndex: SynonymIndex | null = null;

function getSynonymIndex(): SynonymIndex {
  if (synonymIndex) return synonymIndex;
  const groups: SynonymGroup[] = [];
  const byKey = new Map<string, number[]>();
  SEARCH_SYNONYM_GROUPS.forEach((rawMembers, groupId) => {
    const members = Array.from(new Set(rawMembers.map((m) => normalizeSearchText(m)).filter(Boolean)));
    const keys = members.map((m) => phoneticKey(m));
    groups.push({ members, keys });
    for (const key of keys) {
      if (key.length < 2) continue;
      const ids = byKey.get(key) ?? [];
      if (!ids.includes(groupId)) ids.push(groupId);
      byKey.set(key, ids);
    }
  });
  const fuzzyKeys = [...byKey.entries()].filter(([key]) => key.length >= 4).map(([key, groupIds]) => ({ key, groupIds }));
  synonymIndex = { groups, byKey, fuzzyKeys };
  return synonymIndex;
}

/**
 * Dictionary groups for one query word or phrase: exact (by phonetic key,
 * either vowel folding) or — only when nothing matched exactly and the word
 * is long enough — within a small typo distance ("keela" -> banana group).
 */
export function lookupSynonymGroups(text: string): { members: string[]; keys: string[]; fuzzy: boolean }[] {
  const index = getSynonymIndex();
  const keys = new Set([phoneticKey(text), phoneticKey(text, { foldLongVowels: false })].filter((k) => k.length >= 2));
  const exact = new Set<number>();
  for (const key of keys) for (const id of index.byKey.get(key) ?? []) exact.add(id);
  if (exact.size > 0) return [...exact].map((id) => ({ ...index.groups[id]!, fuzzy: false }));

  // Stricter than a product-name typo: a dictionary word is short and a
  // 2-letter slip lands on another word ("chinese" -> "cheese").
  const fuzzy = new Set<number>();
  for (const key of keys) {
    const budget = key.length >= 9 ? 2 : typoBudget(key.length) > 0 ? 1 : 0;
    if (budget === 0) continue;
    for (const candidate of index.fuzzyKeys) {
      if (Math.abs(candidate.key.length - key.length) > budget) continue;
      if (candidate.key[0] !== key[0]) continue; // a typo rarely changes the first letter
      if (editDistance(key, candidate.key, budget) <= budget) for (const id of candidate.groupIds) fuzzy.add(id);
    }
  }
  return [...fuzzy].map((id) => ({ ...index.groups[id]!, fuzzy: true }));
}

/* -------------------------------------------------------------------------- */
/* Indexed terms                                                              */
/* -------------------------------------------------------------------------- */

export interface SearchField {
  text: string | null | undefined;
  source: Extract<SearchTermSource, 'NAME' | 'NAME_HI' | 'KEYWORD' | 'BRAND' | 'CATEGORY'>;
}

export interface SearchTerm {
  term: string;
  key: string;
  source: SearchTermSource;
  weight: number;
}

/** Text with every (…) / […] part removed, and the removed parts. */
function splitBrackets(text: string): { base: string; parts: string[] } {
  const parts: string[] = [];
  const base = text.replace(/[([{]([^)\]}]*)[)\]}]?/g, (_whole, inner: string) => {
    parts.push(inner);
    return ' ';
  });
  return { base, parts };
}

/** Contiguous 1..3-word windows of `tokens`, as compact phonetic keys. */
function windowKeys(tokens: string[]): Set<string> {
  const keys = new Set<string>();
  for (let size = 1; size <= 3; size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const key = phoneticKey(tokens.slice(start, start + size).join(''));
      if (key.length >= 2) keys.add(key);
    }
  }
  return keys;
}

/**
 * Every searchable term for one record (product, category, restaurant…):
 * the normalised whole name, the name without its bracketed part and each
 * bracketed part ("Potato (आलू)" -> "potato", "आलू"), every word, the Roman
 * transliteration of any Hindi, keywords, brand, category, and the whole
 * dictionary group of any word or phrase found in the name / Hindi name /
 * keywords. One row per distinct term, keeping its strongest source.
 */
export function buildSearchTerms(fields: readonly SearchField[]): SearchTerm[] {
  const best = new Map<string, SearchTerm>();
  const add = (rawTerm: string, source: SearchTermSource) => {
    const term = normalizeSearchText(rawTerm).slice(0, MAX_TERM_LENGTH).trim();
    if (!term) return;
    const rule = SEARCH_SOURCE_RULES[source];
    const existing = best.get(term);
    if (existing) {
      const existingRule = SEARCH_SOURCE_RULES[existing.source];
      if (existingRule.cap > rule.cap || (existingRule.cap === rule.cap && existing.weight >= rule.weight)) return;
    }
    best.set(term, { term, key: phoneticKey(term).slice(0, MAX_TERM_LENGTH), source, weight: rule.weight });
  };
  const addTransliteration = (text: string) => {
    if (!hasDevanagari(text)) return;
    const roman = normalizeSearchText(devanagariToRoman(text));
    add(roman, 'TRANSLIT');
    for (const token of roman.split(' ')) if (token.length >= 2) add(token, 'TRANSLIT');
  };

  const synonymTokens: string[][] = [];
  const categorySynonymTokens: string[][] = [];
  /** Keys of whole names (name without brackets, each bracket part, Hindi name). */
  const wholeNameKeys = new Set<string>();

  for (const field of fields) {
    const text = field.text?.trim();
    if (!text) continue;

    switch (field.source) {
      case 'NAME': {
        add(text, 'NAME');
        const { base, parts } = splitBrackets(text);
        wholeNameKeys.add(phoneticKey(base));
        for (const part of parts) wholeNameKeys.add(phoneticKey(part));
        if (parts.length > 0) {
          add(base, 'NAME');
          for (const part of parts) {
            add(part, 'NAME_ALT');
            // "(काचरा / काचरी)": each alternative on its own as well.
            for (const alternative of part.split(/[/|,]/)) add(alternative, 'NAME_ALT');
          }
        }
        // "Toor / Arhar Dal": each side of the slash is an alias too.
        if (/[/|]/.test(base)) for (const alternative of base.split(/[/|]/)) add(alternative, 'NAME_ALT');
        const tokens = normalizeSearchText(text).split(' ');
        for (const token of tokens) add(token, 'NAME_TOKEN');
        addTransliteration(text);
        synonymTokens.push(tokens);
        break;
      }
      case 'NAME_HI':
      case 'KEYWORD': {
        if (field.source === 'NAME_HI') wholeNameKeys.add(phoneticKey(text));
        add(text, field.source);
        const tokens = normalizeSearchText(text).split(' ');
        for (const token of tokens) add(token, field.source);
        addTransliteration(text);
        synonymTokens.push(tokens);
        break;
      }
      case 'BRAND': {
        add(text, 'BRAND');
        for (const token of normalizeSearchText(text).split(' ')) if (token.length >= 3) add(token, 'BRAND');
        break;
      }
      case 'CATEGORY': {
        add(text, 'CATEGORY');
        if (hasDevanagari(text)) add(devanagariToRoman(text), 'CATEGORY');
        categorySynonymTokens.push(normalizeSearchText(text).split(' '));
        break;
      }
    }
  }

  const index = getSynonymIndex();
  const addGroups = (tokenLists: string[][], source: SearchTermSource) => {
    const keys = new Set<string>();
    for (const tokens of tokenLists) for (const key of windowKeys(tokens)) keys.add(key);
    const groupIds = new Set<number>();
    for (const key of keys) for (const id of index.byKey.get(key) ?? []) groupIds.add(id);
    for (const id of groupIds) for (const member of index.groups[id]!.members) add(member, source);
  };
  // The product IS this thing ("Potato (आलू)" is aloo): the group is an alias
  // of the whole name. Added first so it wins over the word-level SYNONYM rows.
  for (const key of wholeNameKeys) {
    for (const id of index.byKey.get(key) ?? []) for (const member of index.groups[id]!.members) add(member, 'NAME_SYNONYM');
  }
  addGroups(synonymTokens, 'SYNONYM');
  addGroups(categorySynonymTokens, 'CATEGORY');

  return [...best.values()];
}

/* -------------------------------------------------------------------------- */
/* Query analysis                                                             */
/* -------------------------------------------------------------------------- */

export type SearchProbeKind = 'term' | 'key' | 'syn' | 'prefix' | 'keyprefix' | 'nameprefix' | 'partial' | 'fuzzy';

/**
 * One thing to look for in the index on behalf of one query unit.
 * `unit` -1 is the whole multi-word query; 0..n-1 are its words.
 */
export interface SearchProbe {
  unit: number;
  kind: SearchProbeKind;
  value: string;
  tier: number;
  /** Fuzzy probes only: the similarity a match needs. */
  minSimilarity: number;
}

export interface AnalyzedSearchQuery {
  /** As typed (trimmed, capped). */
  raw: string;
  /** Lower-case raw, for the EXACT_NAME tier. */
  rawLower: string;
  normalized: string;
  tokens: string[];
  /** How many query words count towards coverage (3+ letters, or digits). */
  significantTokens: number;
  probes: SearchProbe[];
  /** False when nothing searchable remains (only punctuation…). */
  searchable: boolean;
}

/** A query word that counts towards coverage: 3+ letters, a number, or Hindi. */
export function isSignificantToken(token: string): boolean {
  return token.length >= 3 || /^\d+$/.test(token) || hasDevanagari(token);
}

function unitProbes(unit: number, text: string, options: { whole: boolean; multiWord: boolean }): SearchProbe[] {
  const probes: SearchProbe[] = [];
  const push = (kind: SearchProbeKind, value: string, tier: number, minSimilarity = 0) => {
    if (!value) return;
    if (probes.some((p) => p.kind === kind && p.value === value)) return;
    probes.push({ unit, kind, value, tier, minSimilarity });
  };
  const compact = text.replace(/ /g, '');
  const length = Array.from(compact).length;
  const keys = new Set([phoneticKey(text), phoneticKey(text, { foldLongVowels: false })]);

  push('term', text, options.whole ? SEARCH_TIER.EXACT_NORMALIZED : SEARCH_TIER.EXACT_ALIAS);
  if (length === 1) {
    // One letter: only names that START with it, nothing else.
    if (options.whole) push('nameprefix', text, SEARCH_TIER.PREFIX);
    return probes;
  }

  for (const key of keys) if (key.length >= 2) push('key', key, SEARCH_TIER.PHONETIC);
  for (const group of lookupSynonymGroups(text)) {
    // A typo of a synonym is a fuzzy match, and ranks like one.
    for (const key of group.keys) if (key.length >= 2) push('syn', key, group.fuzzy ? SEARCH_TIER.FUZZY : SEARCH_TIER.SYNONYM);
  }

  // A short word inside a longer query is noise for prefix/partial matching
  // ("tamat ar" must not bring up "arbi" through "ar").
  const prefixAllowed = options.multiWord && !options.whole ? length >= 3 : length >= 2;
  if (prefixAllowed) {
    push('prefix', text, SEARCH_TIER.PREFIX);
    for (const key of keys) if (key.length >= 3) push('keyprefix', key, SEARCH_TIER.PREFIX);
  }
  if (!options.whole || !options.multiWord) {
    // Inside-a-word matches start at 4 letters: "ban" inside "urban" is noise.
    if (length >= 4 && !hasDevanagari(text)) push('partial', text, SEARCH_TIER.PARTIAL);
  }
  for (const key of keys) {
    if (key.length >= 4) push('fuzzy', key, SEARCH_TIER.FUZZY, options.whole && options.multiWord ? 0.6 : fuzzyThreshold(key.length));
  }
  return probes;
}

/**
 * Everything the matcher needs to know about one query, computed once per
 * search. Normalises it, splits it into words (at most 6), and lists the
 * probes: the words themselves, their phonetic keys, dictionary synonyms,
 * prefixes, partials and typo keys — fewer and stricter for short words.
 */
export function analyzeSearchQuery(input: string): AnalyzedSearchQuery {
  const raw = input.trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
  const normalized = normalizeSearchText(raw);
  const allTokens = normalized ? normalized.split(' ') : [];
  const tokens = (allTokens.length > 1 ? allTokens.filter((t) => Array.from(t).length > 1 || /\d/.test(t)) : allTokens).slice(
    0,
    MAX_QUERY_TOKENS,
  );
  const probes: SearchProbe[] = [];

  if (tokens.length === 1) {
    probes.push(...unitProbes(0, tokens[0]!, { whole: true, multiWord: false }));
  } else if (tokens.length > 1) {
    probes.push(...unitProbes(-1, tokens.join(' '), { whole: true, multiWord: true }));
    tokens.forEach((token, index) => probes.push(...unitProbes(index, token, { whole: false, multiWord: true })));
  }

  return {
    raw,
    rawLower: raw.toLowerCase(),
    normalized: tokens.join(' '),
    tokens,
    significantTokens: tokens.filter(isSignificantToken).length,
    probes,
    searchable: probes.length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** Length in characters (PostgreSQL `length()`), not UTF-16 units. */
function charLength(text: string): number {
  return Array.from(text).length;
}

/** pg_trgm-compatible trigram similarity of two (single-word) strings. */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const set = new Set<string>();
    for (let i = 0; i + 3 <= padded.length; i += 1) set.add(padded.slice(i, i + 3));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * The tier one probe earns against one indexed term (0 = no match) and the
 * similarity used inside the tier. Mirrored by the SQL in
 * backend/src/infra/search/engine.ts — keep the two in step.
 */
export function matchTier(probe: SearchProbe, term: SearchTerm): { tier: number; similarity: number } {
  const rule = SEARCH_SOURCE_RULES[term.source];
  const isCategory = term.source === 'CATEGORY';
  let tier = 0;
  let similarity = 0;
  switch (probe.kind) {
    case 'term':
      if (term.term === probe.value) [tier, similarity] = [probe.tier, 1];
      break;
    case 'key':
    case 'syn':
      if (term.key === probe.value) [tier, similarity] = [probe.tier, probe.kind === 'key' ? 0.95 : 0.9];
      break;
    case 'prefix':
      if (term.term.startsWith(probe.value)) [tier, similarity] = [probe.tier, charLength(probe.value) / charLength(term.term)];
      break;
    case 'keyprefix':
      if (term.key.startsWith(probe.value)) [tier, similarity] = [probe.tier, (charLength(probe.value) / charLength(term.key)) * 0.9];
      break;
    case 'nameprefix':
      if ((term.source === 'NAME' || term.source === 'NAME_TOKEN') && term.term.startsWith(probe.value)) [tier, similarity] = [probe.tier, 0.5];
      break;
    case 'partial':
      if (!isCategory && term.term.includes(probe.value)) [tier, similarity] = [probe.tier, charLength(probe.value) / charLength(term.term)];
      break;
    case 'fuzzy': {
      const value = trigramSimilarity(probe.value, term.key);
      if (value >= probe.minSimilarity) [tier, similarity] = [probe.tier, value];
      break;
    }
  }
  if (tier === 0) return { tier: 0, similarity: 0 };
  const cap = isCategory && (probe.kind === 'prefix' || probe.kind === 'keyprefix' || probe.kind === 'fuzzy') ? 1 : rule.cap;
  return { tier: Math.min(tier, cap), similarity };
}

/** Score of one (unit, term) match: tier band, then field weight, then similarity. */
export function unitScore(tier: number, weight: number, similarity: number): number {
  return tier * 1000 + weight * 4 + Math.min(1, similarity) * 100;
}

/** Coverage bonus added once per record: share of the query's words matched. */
export function coverageBonus(coverage: number): number {
  return Math.max(0, Math.min(1, coverage)) * 400;
}

/** Whether a record matching `matchedSignificant` of the query's words qualifies at all. */
export function qualifies(query: AnalyzedSearchQuery, wholeMatched: boolean, matchedSignificant: number, anyMatch: boolean): boolean {
  if (!anyMatch) return false;
  if (wholeMatched || query.significantTokens === 0) return true;
  return matchedSignificant >= Math.ceil(query.significantTokens / 2);
}

export interface SearchScore {
  rank: number;
  tier: number;
}

/**
 * Scores one record's terms against an analysed query — the in-memory
 * twin of the SQL ranking. Null when the record does not match.
 * `exactName` is the record's display name, for the EXACT_NAME tier.
 */
export function scoreSearchTerms(query: AnalyzedSearchQuery, terms: readonly SearchTerm[], exactName?: string | null): SearchScore | null {
  if (!query.searchable) return null;
  const bestPerUnit = new Map<number, { score: number; tier: number }>();
  for (const probe of query.probes) {
    for (const term of terms) {
      const { tier, similarity } = matchTier(probe, term);
      if (tier === 0) continue;
      const score = unitScore(tier, term.weight, similarity);
      const current = bestPerUnit.get(probe.unit);
      if (!current || score > current.score) bestPerUnit.set(probe.unit, { score, tier });
    }
  }
  if (bestPerUnit.size === 0) return null;

  const wholeMatched = bestPerUnit.has(-1) || (query.tokens.length === 1 && bestPerUnit.has(0));
  const matchedSignificant = query.tokens.filter((token, index) => isSignificantToken(token) && bestPerUnit.has(index)).length;
  if (!qualifies(query, wholeMatched, matchedSignificant, true)) return null;

  let best = { score: 0, tier: 0 };
  for (const value of bestPerUnit.values()) if (value.score > best.score) best = value;
  const coverage = wholeMatched ? 1 : query.significantTokens === 0 ? 1 : matchedSignificant / query.significantTokens;
  let rank = best.score + coverageBonus(coverage);
  let tier = best.tier;
  if (exactName && exactName.trim().toLowerCase() === query.rawLower) {
    rank = Math.max(rank, unitScore(SEARCH_TIER.EXACT_NAME, 100, 1) + coverageBonus(1));
    tier = SEARCH_TIER.EXACT_NAME;
  }
  return { rank, tier };
}

/** Terms of in-memory items, rebuilt only when an item's searchable text changes. */
const termCache = new WeakMap<object, { signature: string; terms: SearchTerm[] }>();

function termsOf<T>(item: T, fields: readonly SearchField[]): SearchTerm[] {
  if (typeof item !== 'object' || item === null) return buildSearchTerms(fields);
  const signature = fields.map((f) => `${f.source}:${f.text ?? ''}`).join('');
  const cached = termCache.get(item as object);
  if (cached && cached.signature === signature) return cached.terms;
  const terms = buildSearchTerms(fields);
  termCache.set(item as object, { signature, terms });
  return terms;
}

/**
 * Filters and ranks an in-memory list with the Smart Search rules: only
 * matching items are returned, best first; ties keep the list's own order.
 * An empty / unsearchable query returns the list unchanged.
 *
 * `fieldsOf` names what is searchable on an item, e.g.
 *   (product) => [{ text: product.name, source: 'NAME' }, { text: product.categoryName, source: 'CATEGORY' }]
 */
export function smartSearch<T>(items: readonly T[], query: string, fieldsOf: (item: T) => readonly SearchField[]): T[] {
  const matcher = createSmartMatcher(query);
  if (!matcher.active) return [...items];
  const scored: { item: T; rank: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = matcher.score(item, fieldsOf(item));
    if (score) scored.push({ item, rank: score.rank, order });
  });
  scored.sort((a, b) => b.rank - a.rank || a.order - b.order);
  return scored.map((entry) => entry.item);
}

/**
 * One query analysed once, applied to many items — for callers that filter a
 * tree or keep their own order. `active` is false for an empty query (then
 * every item "matches").
 */
export function createSmartMatcher(query: string): {
  active: boolean;
  score: <T>(item: T, fields: readonly SearchField[]) => SearchScore | null;
  matches: <T>(item: T, fields: readonly SearchField[]) => boolean;
} {
  const analyzed = analyzeSearchQuery(query);
  const score = <T>(item: T, fields: readonly SearchField[]): SearchScore | null => {
    const name = fields.find((f) => f.source === 'NAME')?.text ?? null;
    return scoreSearchTerms(analyzed, termsOf(item, fields), name);
  };
  return {
    active: analyzed.searchable,
    score,
    matches: (item, fields) => !analyzed.searchable || score(item, fields) !== null,
  };
}

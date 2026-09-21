/**
 * Hindi / Hinglish / English synonym groups for search.
 *
 * `search_keywords` (see the `products_search_vector_update` DB trigger)
 * already lets an individual product be manually tagged with its own
 * Hindi/Hinglish spellings, but that only helps once someone has actually
 * tagged it — most products in practice only ever get an English `name`.
 * This is a small, curated, product-INDEPENDENT dictionary: given a query
 * term, `expandSearchTerms` returns every synonym in its group (plus the
 * term itself), so "aloo"/"आलू"/"alu" all expand to also search "potato"
 * regardless of whether any single product was ever tagged with all of
 * them. Deliberately a flat list, not a general translation engine — it
 * only needs to cover common grocery/quick-commerce vocabulary.
 */

const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['potato', 'potatoes', 'aloo', 'alu', 'आलू'],
  ['tomato', 'tomatoes', 'tamatar', 'tamater', 'टमाटर'],
  ['onion', 'onions', 'pyaz', 'pyaaz', 'pyaj', 'प्याज'],
  ['milk', 'doodh', 'dudh', 'दूध'],
  ['rice', 'chawal', 'chaval', 'चावल'],
  ['biscuit', 'biscuits', 'biscut', 'बिस्किट'],
  ['sugar', 'cheeni', 'chini', 'शक्कर', 'चीनी'],
  ['salt', 'namak', 'nimak', 'नमक'],
  ['flour', 'atta', 'aata', 'गेहूं', 'आटा'],
  ['bread', 'pav', 'pao', 'ब्रेड'],
  ['oil', 'tel', 'तेल'],
  ['soap', 'sabun', 'साबुन'],
  ['shampoo', 'शैम्पू'],
  ['egg', 'eggs', 'anda', 'ande', 'अंडा'],
  ['water', 'pani', 'पानी'],
  ['tea', 'chai', 'chaye', 'चाय'],
  ['coffee', 'कॉफी'],
  ['ghee', 'घी'],
  ['curd', 'yogurt', 'dahi', 'दही'],
  ['paneer', 'पनीर'],
  ['lentils', 'dal', 'daal', 'दाल'],
  ['spinach', 'palak', 'पालक'],
  ['garlic', 'lehsun', 'lasun', 'लहसुन'],
  ['ginger', 'adrak', 'अदरक'],
  ['chilli', 'chili', 'mirch', 'मिर्च'],
  ['coriander', 'dhaniya', 'धनिया'],
  ['cucumber', 'kheera', 'khira', 'खीरा'],
  ['banana', 'kela', 'केला'],
  ['apple', 'seb', 'सेब'],
  ['orange', 'santra', 'संतरा'],
  ['mango', 'aam', 'आम'],
  ['detergent', 'surf', 'washing powder'],
  ['toothpaste', 'paste'],
  ['chocolate', 'chocolat'],
  ['noodles', 'noodle', 'maggi'],
  ['juice', 'ras', 'रस'],
];

const NORMALIZED_GROUPS: readonly (readonly string[])[] = ALIAS_GROUPS.map((group) =>
  group.map((word) => word.toLowerCase()),
);

/** Small, bounded (short words only) — a full Levenshtein table is
 * overkill here, this only ever runs against ~4-letter alias words. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      table[i]![j] = Math.min(
        table[i - 1]![j]! + 1,
        table[i]![j - 1]! + 1,
        table[i - 1]![j - 1]! + cost,
      );
    }
  }

  return table[rows - 1]![cols - 1]!;
}

/**
 * Every term that should be OR'd into a search query for `rawTerm` — the
 * term itself, plus every synonym in any alias group it (or a close typo of
 * it) belongs to. Always returns at least `[normalized(rawTerm)]`.
 */
export function expandSearchTerms(rawTerm: string): string[] {
  const term = rawTerm.trim().toLowerCase();
  const expanded = new Set<string>([term]);
  if (term.length === 0) return [term];

  for (const group of NORMALIZED_GROUPS) {
    const matchesGroup = group.some((word) => {
      if (word === term) return true;

      // Fuzzy match guards against unrelated short words colliding (e.g.
      // "tea" vs "pav") by requiring both sides to be reasonably long
      // before tolerating any edit distance, and scaling the tolerance
      // with length rather than using one fixed distance for every word.
      if (term.length < 3 || word.length < 3) return false;
      const maxDistance = Math.max(term.length, word.length) <= 5 ? 1 : 2;
      return levenshteinDistance(term, word) <= maxDistance;
    });

    if (matchesGroup) {
      for (const word of group) expanded.add(word);
    }
  }

  return Array.from(expanded);
}

/**
 * Client-side search suggestions — instant (no network round trip), using
 * the SAME Hindi/Hinglish/English synonym idea as the backend's alias
 * expansion (backend/src/infra/search/aliases.ts). Kept as its own small,
 * duplicated list rather than a shared package: this one only needs short
 * display strings for suggestion chips, not SQL-safe query terms, and the
 * two lists serve different jobs (backend broadens a query's matches;
 * this narrows what to suggest while typing).
 */

const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["potato", "aloo", "alu", "आलू"],
  ["tomato", "tamatar", "टमाटर"],
  ["onion", "pyaz", "प्याज"],
  ["milk", "doodh", "dudh", "दूध"],
  ["rice", "chawal", "चावल"],
  ["biscuit", "बिस्किट"],
  ["sugar", "cheeni", "chini", "चीनी"],
  ["salt", "namak", "नमक"],
  ["flour", "atta", "आटा"],
  ["bread", "pav", "ब्रेड"],
  ["oil", "tel", "तेल"],
  ["soap", "sabun", "साबुन"],
  ["shampoo", "शैम्पू"],
  ["egg", "anda", "अंडा"],
  ["water", "pani", "पानी"],
  ["tea", "chai", "चाय"],
  ["ghee", "घी"],
  ["curd", "dahi", "दही"],
  ["paneer", "पनीर"],
  ["lentils", "dal", "दाल"],
  ["garlic", "lehsun", "लहसुन"],
  ["ginger", "adrak", "अदरक"],
  ["coriander", "dhaniya", "धनिया"],
];

const HINDI_SCRIPT = /[ऀ-ॿ]/;

function display(term: string): string {
  return HINDI_SCRIPT.test(term) ? term : term.charAt(0).toUpperCase() + term.slice(1);
}

export interface SearchSuggestion {
  /** What gets set as the search text when this chip is tapped. */
  term: string;
  label: string;
}

/**
 * Given whatever's been typed so far, suggests a small, relevant set of
 * completions across English/Hinglish/Hindi — e.g. "alo" suggests
 * ["Aloo", "आलू", "Potato"]: the matched spelling itself, that group's
 * Hindi term, and its canonical English name, rather than dumping every
 * synonym in the group at once.
 */
export function suggestSearchTerms(rawPrefix: string, max = 6): SearchSuggestion[] {
  const prefix = rawPrefix.trim().toLowerCase();
  if (prefix.length === 0) return [];

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();

  const add = (term: string) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ term, label: display(term) });
  };

  for (const group of ALIAS_GROUPS) {
    if (suggestions.length >= max) break;

    const matched = group.find((word) => word.toLowerCase().startsWith(prefix));
    if (!matched) continue;

    add(matched);
    const hindiWord = group.find((word) => HINDI_SCRIPT.test(word));
    if (hindiWord) add(hindiWord);
    const canonical = group[0];
    if (canonical && canonical.toLowerCase() !== matched.toLowerCase()) add(canonical);
  }

  return suggestions.slice(0, max);
}

/**
 * Client-side search suggestions — instant (no network round trip), from the
 * SAME English / Hinglish / Hindi dictionary the server's Smart Search uses
 * (shared/search-dictionary.ts), so a chip never suggests a word the search
 * would not understand. Matching is spelling-insensitive too: "alo", "aalu"
 * and "आल" all suggest Aloo / आलू / Potato.
 */

import { SEARCH_SYNONYM_GROUPS } from "@shared/search-dictionary";
import { hasDevanagari, normalizeSearchText, phoneticKey } from "@shared/search-text";

function display(term: string): string {
  return hasDevanagari(term) ? term : term.charAt(0).toUpperCase() + term.slice(1);
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
  const prefix = normalizeSearchText(rawPrefix);
  if (prefix.length === 0) return [];
  const prefixKey = phoneticKey(prefix);

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();

  const add = (term: string) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ term, label: display(term) });
  };

  for (const group of SEARCH_SYNONYM_GROUPS) {
    if (suggestions.length >= max) break;

    const matched =
      group.find((word) => normalizeSearchText(word).startsWith(prefix)) ??
      (prefixKey.length >= 2 ? group.find((word) => phoneticKey(word).startsWith(prefixKey)) : undefined);
    if (!matched) continue;

    add(matched);
    const hindiWord = group.find((word) => hasDevanagari(word));
    if (hindiWord) add(hindiWord);
    const canonical = group[0];
    if (canonical && canonical.toLowerCase() !== matched.toLowerCase()) add(canonical);
  }

  return suggestions.slice(0, max);
}

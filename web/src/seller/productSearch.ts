/**
 * Seller-panel product search and category filtering — pure helpers (no
 * React), shared by Products and Inventory and unit-tested on their own
 * (tests/sellerProductSearch.test.ts).
 *
 * Categories are matched by their canonical ids (Product.categoryId and the
 * category's parent), never by comparing category-name strings, and every
 * category of a product's path is searched as its own field — the backend
 * indexer's shape (backend infra/search/indexer.ts: category + parent
 * category), so the in-memory search and the server's search agree.
 */

import type { SearchField } from '@shared/search-match';

export interface CategoryRef {
  id: string;
  name: string;
}

/** What search and the category filter need from a row. */
export interface CategorisedRow {
  name: string;
  nameHi?: string | null;
  /** The category path, top category first, then the subcategory. */
  categories: CategoryRef[];
}

/** A listing's category path, top category first (the parent is absent on an older API response). */
export function listingCategories(l: {
  categoryId: string;
  categoryName: string;
  parentCategoryId?: string | null;
  parentCategoryName?: string | null;
}): CategoryRef[] {
  const own = { id: l.categoryId, name: l.categoryName };
  return l.parentCategoryId && l.parentCategoryName ? [{ id: l.parentCategoryId, name: l.parentCategoryName }, own] : [own];
}

/** A row is in category `id` when that is its top category or its subcategory. */
export const inCategory = (row: CategorisedRow, id: string): boolean => row.categories.some((c) => c.id === id);

/**
 * What Smart Search looks at on a row: its name, Hindi name and EACH category
 * of its path as its own field. One joined "Grocery › Drinks" string would
 * only match the whole path or its first word (CATEGORY terms are matched
 * whole or by prefix — shared/search-match.ts), silently dropping every
 * Drinks product without "drink" in its name.
 */
export function productRowSearchFields(row: CategorisedRow): SearchField[] {
  return [
    { text: row.name, source: 'NAME' },
    { text: row.nameHi, source: 'NAME_HI' },
    ...row.categories.map((c): SearchField => ({ text: c.name, source: 'CATEGORY' })),
  ];
}

/**
 * The category filter's choices: every category the seller's rows sit in —
 * each top category, then its subcategories ("Grocery › Drinks") — by id.
 */
export function categoryOptions(rows: readonly CategorisedRow[]): { value: string; label: string }[] {
  const tops = new Map<string, { name: string; subs: Map<string, string> }>();
  for (const row of rows) {
    const [top, sub] = row.categories;
    if (!top) continue;
    const entry = tops.get(top.id) ?? { name: top.name, subs: new Map<string, string>() };
    if (sub) entry.subs.set(sub.id, sub.name);
    tops.set(top.id, entry);
  }
  return [...tops.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .flatMap(([id, top]) => [
      { value: id, label: top.name },
      ...[...top.subs.entries()]
        .sort(([, a], [, b]) => a.localeCompare(b))
        .map(([subId, name]) => ({ value: subId, label: `${top.name} › ${name}` })),
    ]);
}

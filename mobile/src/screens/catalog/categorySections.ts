/**
 * The Categories landing page, derived from the category tree the API returns
 * (GET /categories?includeChildren=true&withCounts=true). Pure (no React) so
 * it can be checked on its own.
 *
 * The hierarchy comes ONLY from each category's own `parentId` — never from
 * where it happens to sit in the response, never from its name:
 *
 *   - a ROOT (level 0) is a category with `parentId: null`;
 *   - a root's tiles are exactly the categories whose `parentId` is that root;
 *   - categories are deduplicated by id (first occurrence wins), and order is
 *     the API's own;
 *   - a category whose parent is not in the tree (deleted / hidden) is left
 *     out rather than placed under a guessed parent.
 *
 * So a root can never show up as another root's tile, and roots and tiles
 * are never mixed in one section: every root is in the top strip, and each
 * root with subcategories gets its own section.
 */

import type { CategoryDto } from "@shared";

export interface CategorySection {
  key: string;
  parent: CategoryDto;
  title: string;
  /** Only counts the API actually sent (see `buildCategoryTree`). */
  subtitle: string;
  tiles: CategoryDto[];
}

export interface CategoryTree {
  /** Every level-0 category, in API order — the top strip. */
  roots: CategoryDto[];
  /** One per root that has subcategories, in API order. */
  sections: CategorySection[];
  /** Root id → its direct subcategories. */
  childrenOf: Map<string, CategoryDto[]>;
  /** Category id → its parent (for search results' context). */
  parentOf: Map<string, CategoryDto>;
}

export function buildCategoryTree(categories: CategoryDto[]): CategoryTree {
  // Every category in the response, nested or not, once each.
  const byId = new Map<string, CategoryDto>();
  const visit = (category: CategoryDto, nestedUnder: string | null): void => {
    if (!byId.has(category.id)) {
      // `parentId` is the source of truth; the nesting is only a fallback for a response without it.
      const hasParentField = (category as { parentId?: string | null }).parentId !== undefined;
      byId.set(category.id, hasParentField ? category : { ...category, parentId: nestedUnder });
    }
    for (const child of category.children ?? []) visit(child, category.id);
  };
  for (const category of categories) visit(category, null);

  const all = [...byId.values()];
  const roots = all.filter((category) => category.parentId === null);
  const rootIds = new Set(roots.map((root) => root.id));

  const childrenOf = new Map<string, CategoryDto[]>();
  const parentOf = new Map<string, CategoryDto>();
  for (const category of all) {
    if (category.parentId === null || !rootIds.has(category.parentId)) continue;
    const parent = byId.get(category.parentId)!;
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), category]);
    parentOf.set(category.id, parent);
  }

  const sections: CategorySection[] = [];
  for (const root of roots) {
    const tiles = childrenOf.get(root.id) ?? [];
    if (tiles.length === 0) continue;
    // Products only when every subcategory has a count (else the total would be invented).
    const counted = tiles.every((tile) => typeof tile.productCount === "number");
    const products = counted ? tiles.reduce((sum, tile) => sum + (tile.productCount ?? 0), 0) : null;
    const parts = [`${tiles.length} ${tiles.length === 1 ? "subcategory" : "subcategories"}`];
    if (products !== null && products > 0) parts.push(`${products} ${products === 1 ? "product" : "products"}`);
    sections.push({ key: root.id, parent: root, title: root.name, subtitle: parts.join(" · "), tiles });
  }

  return { roots, sections, childrenOf, parentOf };
}

export interface CategorySearchResult {
  category: CategoryDto;
  /** The parent for a subcategory; null for a root. */
  parent: CategoryDto | null;
}

/** Case-insensitive match on the English and Hindi names — roots first, then subcategories. */
export function searchCategories(tree: CategoryTree, query: string): CategorySearchResult[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const matches = (category: CategoryDto) =>
    category.name.toLocaleLowerCase().includes(term) || (category.nameHi ?? "").toLocaleLowerCase().includes(term);

  const results: CategorySearchResult[] = tree.roots.filter(matches).map((category) => ({ category, parent: null }));
  for (const root of tree.roots) {
    for (const child of tree.childrenOf.get(root.id) ?? []) {
      if (matches(child)) results.push({ category: child, parent: root });
    }
  }
  return results;
}

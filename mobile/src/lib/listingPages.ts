/**
 * The products of a paginated listing, in page order, each product once —
 * keyset pages never overlap by themselves, but a product whose sort value
 * changes between two page requests (popularity updated mid-scroll) can
 * reach the next page too. Pure, so tests/listingPages.test.ts covers it.
 */
export function uniqueListingItems<T extends { id: string }>(
  pages: readonly { items: readonly T[] }[] | undefined,
): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

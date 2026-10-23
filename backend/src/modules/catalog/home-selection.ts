/**
 * Pure selection rules behind the Home feed (getHomeFeed). No I/O, so they are
 * unit-tested directly. Nothing here knows a category, product or seller by
 * name: order comes from the admin's HOME_CATEGORY_ORDER and from the
 * catalogue's own ranking.
 */

/**
 * Top categories in Home order: the admin's preferred paths first, in the
 * order listed, then every other category in its existing order. A preferred
 * path with no live category is skipped, so a stale entry never leaves a gap.
 */
export function orderByPreference<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  preferred: readonly string[] | null | undefined,
): { ordered: T[]; featured: T[] } {
  const byPath = new Map(items.map((item) => [pathOf(item), item]));
  const featured: T[] = [];
  const seen = new Set<string>();
  for (const path of preferred ?? []) {
    const item = byPath.get(path);
    if (!item || seen.has(path)) continue;
    seen.add(path);
    featured.push(item);
  }
  const rest = items.filter((item) => !seen.has(pathOf(item)));
  return { ordered: [...featured, ...rest], featured };
}

/**
 * The products each Home rail shows, from every rail's ranked candidates (in
 * rail order). Rails are filled in order, each one skipping what an earlier
 * rail already used, except when that would leave it with fewer than
 * `minSize`: then it shows its own top `displaySize`, because a repeat beats a
 * near-empty shelf. Every id a rail shows counts as used for the rails after it.
 */
export function pickRailProducts(
  candidateLists: readonly (readonly string[])[],
  displaySize: number,
  minSize: number,
): string[][] {
  const used = new Set<string>();
  return candidateLists.map((candidates) => {
    const fresh = candidates.filter((id) => !used.has(id)).slice(0, displaySize);
    const ids = fresh.length >= minSize ? fresh : candidates.slice(0, displaySize);
    for (const id of ids) used.add(id);
    return ids;
  });
}

/**
 * `fn` over `items` with at most `limit` running at once; results in input
 * order. (No I/O of its own: it only paces the caller's queries, so a long list
 * never fires them all at the same moment.)
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/**
 * The subcategory a product path belongs to under `topPath`:
 * "grocery/rice/basmati" → "grocery/rice". A product filed directly under the
 * top category is its own group ("grocery").
 */
export function subcategoryOf(topPath: string, productPath: string): string {
  if (productPath === topPath || !productPath.startsWith(`${topPath}/`)) return topPath;
  const next = productPath.slice(topPath.length + 1).split("/")[0];
  return next ? `${topPath}/${next}` : topPath;
}

/**
 * Up to `limit` product ids spread across subcategories: one from each
 * subcategory before a second from any, round after round. Candidates arrive
 * already ranked; subcategories take turns in the order their best product
 * appears, and each one contributes its own products in rank order. Nothing is
 * shuffled, so the same catalogue always yields the same shelf. Fewer
 * candidates than `limit` simply means a shorter shelf.
 */
export function balanceBySubcategory(
  candidates: readonly { id: string; path: string }[],
  topPath: string,
  limit: number,
): string[] {
  const queues = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const group = subcategoryOf(topPath, candidate.path);
    const queue = queues.get(group);
    if (queue) queue.push(candidate.id);
    else queues.set(group, [candidate.id]);
  }

  const picked: string[] = [];
  const lists = [...queues.values()];
  for (let round = 0; picked.length < limit; round += 1) {
    let tookAny = false;
    for (const list of lists) {
      const id = list[round];
      if (id === undefined) continue;
      tookAny = true;
      picked.push(id);
      if (picked.length === limit) break;
    }
    if (!tookAny) break;
  }
  return picked;
}

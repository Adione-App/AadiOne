/**
 * Bulk import — brands. A file names brands as text; the catalogue links
 * products to Brand rows (global: one "Bikaji" for every seller).
 *
 *   matching   case-insensitive and whitespace-normalised ("  BIKAJI ",
 *              "bikaji" and "Bikaji" are one brand), on the brand's name or
 *              on its slug (so "Haldirams" finds "Haldiram's" instead of
 *              colliding with it)
 *   preview    only looks: an unknown brand is reported "will be created";
 *              nothing is written before the seller confirms
 *   processing ensureBrands() inside the batch's own transaction: a brand is
 *              created once (INSERT … ON CONFLICT (slug) DO NOTHING, then read
 *              back), every row of the batch reuses it, and a batch that rolls
 *              back takes its new brands with it — no orphan brands.
 *              Two imports creating the same brand at once: the second insert
 *              waits on the first transaction's unique-slug entry and then
 *              reads the committed row (READ COMMITTED), so the slug's unique
 *              index guarantees a single brand.
 *
 * Sellers never edit a brand: existing rows are only read and linked.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { slugify } from '../../shared/text';
import { prisma, type Tx } from '../../infra/db/prisma';

/** Brand.name is VARCHAR(120). */
export const BRAND_NAME_MAX = 120;

/** The name as it should be stored: trimmed, inner whitespace collapsed. */
export function brandDisplayName(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** Equality key: display name, lower-cased. */
export function brandKey(text: string): string {
  return brandDisplayName(text).toLowerCase();
}

/** Deterministic per key, so the same brand always lands on the same unique slug. */
export function brandSlug(text: string): string {
  // Apostrophes are dropped, not turned into a dash: "Haldiram's" and "Haldirams" are one slug.
  // Names without Latin letters/digits (e.g. Devanagari) still get a stable slug.
  return slugify(brandDisplayName(text).replace(/['’`]/g, '')) || `brand-${createHash('sha256').update(brandKey(text)).digest('hex').slice(0, 12)}`;
}

/** Why this brand text cannot be used; null when it can. */
export function brandProblem(text: string): string | null {
  const name = brandDisplayName(text);
  if (name.length === 0) return null;
  if (name.length > BRAND_NAME_MAX) return `Brand name can be at most ${BRAND_NAME_MAX} characters.`;
  if (!/[\p{L}\p{N}]/u.test(name)) return 'Brand name must contain letters or numbers.';
  return null;
}

export interface BrandHit {
  id: string;
  name: string;
  isActive: boolean;
}

type Client = Tx | typeof prisma;

/** Existing brands for these names, keyed by brandKey(). Matches by normalised name first, then by slug. */
export async function findBrands(client: Client, names: string[]): Promise<Map<string, BrandHit>> {
  const wanted = new Map<string, string>(); // key -> slug
  for (const name of names) if (brandDisplayName(name)) wanted.set(brandKey(name), brandSlug(name));
  const out = new Map<string, BrandHit>();
  if (wanted.size === 0) return out;
  const keys = [...wanted.keys()];
  const slugs = [...new Set(wanted.values())];
  const found = await client.$queryRaw<{ id: string; name: string; slug: string; is_active: boolean; key: string }[]>`
    SELECT id::text AS id, name, slug, is_active, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) AS key
      FROM brands
     WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = ANY(${keys}) OR slug = ANY(${slugs})
     ORDER BY created_at ASC`;
  const byKey = new Map<string, BrandHit>();
  const bySlug = new Map<string, BrandHit>();
  for (const b of found) {
    const hit = { id: b.id, name: b.name, isActive: b.is_active };
    // Oldest first: if historical data has two brands with one name, always the same one wins.
    if (!byKey.has(b.key)) byKey.set(b.key, hit);
    if (!bySlug.has(b.slug)) bySlug.set(b.slug, hit);
  }
  for (const [key, slug] of wanted) {
    const hit = byKey.get(key) ?? bySlug.get(slug);
    if (hit) out.set(key, hit);
  }
  return out;
}

/**
 * Every named brand, created when missing — call INSIDE the transaction that
 * links products to them. Returns brands by brandKey() and the ids it created.
 */
export async function ensureBrands(tx: Tx, names: string[]): Promise<{ brands: Map<string, BrandHit>; created: BrandHit[] }> {
  const display = new Map<string, string>(); // key -> name to create with (first spelling wins)
  for (const name of names) {
    const shown = brandDisplayName(name);
    if (shown && !display.has(brandKey(shown))) display.set(brandKey(shown), shown);
  }
  const brands = await findBrands(tx, [...display.values()]);
  // Inserted in slug order, so two batches creating the same brands never wait on each other crosswise.
  const missing = [...display].filter(([key]) => !brands.has(key)).sort(([, a], [, b]) => (brandSlug(a) < brandSlug(b) ? -1 : 1));
  const created: BrandHit[] = [];
  for (const [, name] of missing) {
    const id = randomUUID();
    const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO brands (id, name, slug, is_active, created_at, updated_at)
      VALUES (${id}::uuid, ${name}, ${brandSlug(name)}, true, now(), now())
      ON CONFLICT (slug) DO NOTHING
      RETURNING id::text AS id`);
    if (inserted.length > 0) created.push({ id, name, isActive: true });
  }
  if (missing.length > 0) {
    // A fresh statement: also sees a brand another import committed while this one waited.
    const again = await findBrands(tx, missing.map(([, name]) => name));
    for (const [key, hit] of again) brands.set(key, hit);
  }
  return { brands, created };
}

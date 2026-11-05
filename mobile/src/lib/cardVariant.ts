/**
 * Which size a product card shows, and what its + does — the ONE rule every
 * customer product list uses (Home shelves, categories, search, View All,
 * stores, wishlist, "similar products"), through ProductCard.
 *
 * Built from the product's customer-visible variants (ProductSummaryDto.
 * variants: live, approved, listed — the server leaves hidden, deleted and
 * unreviewed ones out), as THIS customer sees them (their own unpaid
 * checkout's held units count as theirs — lib/ownHolds.ts).
 *
 *   - A variant can be bought when it is in stock (on sale, units left) and
 *     its store is taking orders.
 *   - The card shows the seller's default when it can be bought, otherwise
 *     the first one that can, in the server's order (default, then the
 *     seller's display order) — its own size AND price together. Nothing is
 *     ever written back: the seller's default stays what it is.
 *   - None can be bought: the card keeps the server's choice and shows the
 *     existing unavailable state (Sold Out / Store closed).
 *   - +: several can be bought → the variant sheet; exactly one → that one is
 *     added directly (its own listing and price); none → no add at all.
 *
 * The server re-checks everything at add (listing, variant, price, stock,
 * store), so a card painted from cached data can never add what can't be
 * sold. Pure (no React Native), so `npm run test:unit` covers it.
 */

import type { ProductSummaryDto, VariantDto } from "@shared";

export type CardAddMode = "direct" | "sheet" | "none";

export interface CardVariants {
  /** The size and price the card shows; null when the product has no listed variant. */
  shown: VariantDto | null;
  /** Every variant that can be bought right now, in display order. */
  purchasable: VariantDto[];
  /** What + does. */
  addMode: CardAddMode;
  /** The variant + adds when `addMode` is "direct". */
  direct: VariantDto | null;
}

type CardProduct = Pick<ProductSummaryDto, "defaultVariant" | "variantCount" | "variants">;

/**
 * In stock — the server's answer: on sale with units left (or a made-to-order
 * item switched on); own held units already counted (lib/ownHolds.ts) — and
 * from a store taking orders. Absent store state (older server) = open.
 */
export function isPurchasable(variant: Pick<VariantDto, "inStock" | "sellerAcceptingOrders">): boolean {
  return variant.inStock && variant.sellerAcceptingOrders !== false;
}

const asIs = (variant: VariantDto): VariantDto => variant;

/** The product's customer-visible variants (just the default from an older server), as this customer sees them. */
export function visibleVariantsOf(product: CardProduct, view: (variant: VariantDto) => VariantDto = asIs): VariantDto[] {
  const listed = product.variants && product.variants.length > 0 ? product.variants : product.defaultVariant ? [product.defaultVariant] : [];
  return listed.map(view);
}

/** Every variant this customer can add right now, in display order. */
export function purchasableVariantsOf(product: CardProduct, view: (variant: VariantDto) => VariantDto = asIs): VariantDto[] {
  return visibleVariantsOf(product, view).filter(isPurchasable);
}

export function cardVariantsOf(product: CardProduct, view: (variant: VariantDto) => VariantDto = asIs): CardVariants {
  const all = visibleVariantsOf(product, view);
  const purchasable = all.filter(isPurchasable);
  // Nothing can be bought: the server's own pick (it prefers an in-stock size
  // of a closed store, so the card says "Store closed" rather than "Sold out").
  const fallback = all.find((variant) => variant.id === product.defaultVariant?.id) ?? all.find((variant) => variant.isDefault) ?? all[0] ?? null;
  const shown = purchasable.find((variant) => variant.isDefault) ?? purchasable[0] ?? fallback;

  if (purchasable.length === 0) return { shown, purchasable, addMode: "none", direct: null };

  // An older server sends only the default: whether another size can be
  // bought is unknown, so a product with several keeps the sheet.
  const knowsAll = (product.variants?.length ?? 0) > 0;
  if (!knowsAll && product.variantCount > 1) return { shown, purchasable, addMode: "sheet", direct: null };

  return purchasable.length === 1
    ? { shown, purchasable, addMode: "direct", direct: purchasable[0]! }
    : { shown, purchasable, addMode: "sheet", direct: null };
}

/**
 * Nothing can be bought because the store selling it is not taking orders
 * (rather than sold out): when it opens again — without naming the store.
 * Customers are not shown who sells a product, and the server's message leads
 * with the store's name ("<store> is closed right now. Opens at 8:00 AM."),
 * so only what follows the name's sentence is kept ("" when it says nothing
 * more). Null when the store is not the reason.
 */
export function storeClosedHint(variants: readonly VariantDto[]): string | null {
  if (variants.some(isPurchasable)) return null;
  const closed = variants.find((variant) => variant.inStock && variant.sellerAcceptingOrders === false);
  if (!closed) return null;
  const message = closed.sellerClosedMessage ?? "";
  if (!closed.sellerName || !message.startsWith(closed.sellerName)) return message;
  const afterName = message.slice(closed.sellerName.length);
  const end = afterName.indexOf(".");
  return end === -1 ? "" : afterName.slice(end + 1).trim();
}

export type PageVariantMode = "choose" | "single" | "none";

/**
 * The product page's (and any full view's) answer from the same rule:
 * "choose" — two or more sizes can be bought, offer only those; "single" —
 * exactly one, which IS the product (no selector, added directly); "none" —
 * nothing can be bought (no selector, Add disabled).
 */
export function pageVariantsOf(
  product: CardProduct,
  view: (variant: VariantDto) => VariantDto = asIs,
): { visible: VariantDto[]; purchasable: VariantDto[]; mode: PageVariantMode; single: VariantDto | null } {
  const visible = visibleVariantsOf(product, view);
  const purchasable = visible.filter(isPurchasable);
  const mode: PageVariantMode = purchasable.length > 1 ? "choose" : purchasable.length === 1 ? "single" : "none";
  return { visible, purchasable, mode, single: mode === "single" ? purchasable[0]! : null };
}

/**
 * Which variant a multi-variant ProductCard's − / + acts on directly.
 *
 *   none of the product's variants in the cart → null (+ opens the sheet)
 *   exactly ONE of them in the cart            → that variant (− / + act on it)
 *   SEVERAL of them in the cart                → null (the customer picks which,
 *                                                 in the sheet — never guessed)
 *
 * Single-variant products never need this (their card uses its own variant).
 */

export function singleCartVariantOf(
  items: readonly { productId: string; variantId: string; qty: number }[],
  product: { id: string; variantCount: number },
): string | null {
  if (product.variantCount <= 1) return null;
  let found: string | null = null;
  for (const item of items) {
    if (item.productId !== product.id || item.qty <= 0) continue;
    if (found !== null && found !== item.variantId) return null;
    found = item.variantId;
  }
  return found;
}

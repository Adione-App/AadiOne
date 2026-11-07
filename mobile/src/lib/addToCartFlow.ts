/**
 * The ONE post-add step every Add / + in the app shares — product cards, the
 * variant sheet, the product page and food menus — pure, so it is
 * unit-tested (tests/addToCartFlow.test.ts):
 *
 *   1. the shared cart action (useCartActions `add` / `increment`): the
 *      optimistic local line — cart badge, product cards, Cart screen — and
 *      the server request behind it; false when it was refused on the device
 *      (login needed, limit reached: it already said why);
 *   2. only when it was accepted: `fly` (lib/flyToCart.ts `flyToCart`) with
 *      the product's image — the drop into the Mini Cart, which also makes
 *      that product the Mini Cart's latest-added thumbnail.
 *
 * A refused tap starts no animation and changes no thumbnail. A refusal from
 * the SERVER later rolls the optimistic line back (useCartActions); the Mini
 * Cart then shows the cart's last remaining line (MiniCartBar's removal
 * handoff), never the failed product.
 */

export type FlyToCart = (imageUrl: string | null, variantId: string) => void;

/** `add(variantId, snapshot)`; returns whether it was accepted (an older signature may return nothing = accepted). */
export function addAndFly<S>(
  add: (variantId: string, snapshot: S) => boolean | void,
  fly: FlyToCart,
  variantId: string,
  snapshot: S,
  imageUrl: string | null,
): boolean {
  if (add(variantId, snapshot) === false) return false;
  fly(imageUrl, variantId);
  return true;
}

/** One more of a line already in the cart — the same rule. */
export function incrementAndFly(
  increment: (variantId: string) => boolean | void,
  fly: FlyToCart,
  variantId: string,
  imageUrl: string | null,
): boolean {
  if (increment(variantId) === false) return false;
  fly(imageUrl, variantId);
  return true;
}

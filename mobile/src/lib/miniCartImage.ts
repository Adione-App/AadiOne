/**
 * Which image the Mini Cart's thumbnail should be asked to show when the
 * cart changes WITHOUT an add flight (the cart loading after launch, the
 * server's cart after login, a cart emptied at logout and filled again, a
 * restored line whose image arrives later). Pure, so it is unit-tested
 * (tests/miniCartImage.test.ts); components/MiniCartBar.tsx applies it.
 *
 *   nothing shown, cart has items       -> the latest product (the cart's
 *                                          last line = the last one added)
 *   shown product's image missing /     -> that product's image from the cart,
 *   failed, the cart has another one       once (a failed url is not retried)
 *   anything else                       -> nothing to do
 */

export interface ShownSlot {
  variantId: string | null;
  imageUrl: string | null;
  failed: boolean;
}

export interface CartLineImage {
  variantId: string;
  imageUrl: string | null;
}

export type SyncRequest = { imageUrl: string | null; variantId: string; sameProduct: boolean } | null;

export function miniCartSyncRequest(
  front: ShownSlot,
  items: readonly CartLineImage[],
  resolve: (url: string | null) => string | null,
): SyncRequest {
  const latest = items[items.length - 1];
  if (!latest) return null;
  if (front.variantId === null) return { imageUrl: latest.imageUrl, variantId: latest.variantId, sameProduct: false };

  const shown = items.find((item) => item.variantId === front.variantId);
  if (!shown) return null; // removed: the remove handoff in the component decides
  const shownUri = resolve(shown.imageUrl);
  const frontUri = resolve(front.imageUrl);
  if (shownUri && (!frontUri || front.failed) && shownUri !== frontUri) {
    return { imageUrl: shown.imageUrl, variantId: shown.variantId, sameProduct: true };
  }
  return null;
}

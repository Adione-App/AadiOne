/**
 * Wishlist — persisted locally (device-only; there is no backend wishlist
 * API yet, see backend's `FEATURE_WISHLIST_ENABLED` config key), same manual
 * AsyncStorage-read-then-hydrate pattern `useLocation` (store.ts) and
 * `useRecentSearches` use, rather than introducing zustand's `persist`
 * middleware for the first time in this codebase.
 *
 * Stores the full `ProductSummaryDto` for each saved product (not just its
 * id) so the Wishlist screen can render cards immediately from disk, with no
 * extra fetch-by-id round trip on cold start — the same trade-off
 * `pendingSnapshots` in useCartActions.ts makes for a just-added cart line.
 * Price/stock can go stale between visits; each entry gets silently
 * refreshed the next time that product's own card/detail screen re-fetches
 * it, same as any other cached product data in this app.
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ProductSummaryDto } from "@shared";

const STORAGE_KEY = "adione.wishlist";

interface WishlistPayload {
  /** Product ids, most-recently-saved first. */
  order: string[];
  products: Record<string, ProductSummaryDto>;
}

function isValidPayload(value: unknown): value is WishlistPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.order) || !v.order.every((id) => typeof id === "string")) {
    return false;
  }
  if (!v.products || typeof v.products !== "object") return false;
  return v.order.every((id) => (v.products as Record<string, unknown>)[id as string] !== undefined);
}

function persist(order: string[], products: Record<string, ProductSummaryDto>): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ order, products } satisfies WishlistPayload)).catch(
    () => {
      // Best-effort — losing the wishlist cache is not worth surfacing an error for.
    },
  );
}

interface WishlistState {
  order: string[];
  products: Record<string, ProductSummaryDto>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  isWishlisted: (productId: string) => boolean;
  /** Adds the product if it isn't saved yet, removes it if it is. */
  toggle: (product: ProductSummaryDto) => void;
  remove: (productId: string) => void;
  clear: () => void;
}

export const useWishlist = create<WishlistState>((set, get) => ({
  order: [],
  products: {},
  hydrated: false,

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isValidPayload(parsed)) {
          set({ order: parsed.order, products: parsed.products });
        }
      }
    } catch {
      // Corrupt/unreadable cache — start fresh, same as a first-time customer.
    } finally {
      set({ hydrated: true });
    }
  },

  isWishlisted(productId) {
    return productId in get().products;
  },

  toggle(product) {
    const { order, products } = get();

    if (product.id in products) {
      const nextOrder = order.filter((id) => id !== product.id);
      const nextProducts = { ...products };
      delete nextProducts[product.id];
      set({ order: nextOrder, products: nextProducts });
      persist(nextOrder, nextProducts);
      return;
    }

    const nextOrder = [product.id, ...order];
    const nextProducts = { ...products, [product.id]: product };
    set({ order: nextOrder, products: nextProducts });
    persist(nextOrder, nextProducts);
  },

  remove(productId) {
    const { order, products } = get();
    if (!(productId in products)) return;

    const nextOrder = order.filter((id) => id !== productId);
    const nextProducts = { ...products };
    delete nextProducts[productId];
    set({ order: nextOrder, products: nextProducts });
    persist(nextOrder, nextProducts);
  },

  clear() {
    set({ order: [], products: {} });
    persist([], {});
  },
}));

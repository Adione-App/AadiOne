/**
 * Server-state hooks.
 *
 * Every one of these returns data the SERVER computed — prices, stock, COD
 * eligibility, totals. The app renders them and never derives them.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  CartDto,
  CategoryDto,
  CursorPage,
  HomeFeedDto,
  OrderDetailDto,
  OrderSummaryDto,
  ProductDetailDto,
  ProductSummaryDto,
} from "@shared";
import { api } from "./api";

export const keys = {
  home: ["home"] as const,
  categories: ["categories"] as const,
  products: (params: string) => ["products", params] as const,
  product: (id: string) => ["product", id] as const,
  search: (term: string) => ["search", term] as const,
  rail: (key: string) => ["rail", key] as const,
  cart: ["cart"] as const,
  orders: ["orders"] as const,
  order: (id: string) => ["order", id] as const,
};

export function useHomeFeed() {
  return useQuery({
    queryKey: keys.home,
    queryFn: () => api.get<HomeFeedDto>("/home"),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: () =>
      api.get<CategoryDto[]>(
        "/categories?includeChildren=true&withCounts=true",
      ),
    // The category tree changes a few times a month; refetching it on every
    // screen entry would waste a round trip the customer waits for.
    staleTime: 10 * 60_000,
  });
}

export function useProducts(params: {
  categoryId?: string;
  inStock?: boolean;
  /** False skips the request entirely — e.g. while a category grid, not a product list, is on screen. */
  enabled?: boolean;
}) {
  const query = new URLSearchParams({ limit: "30" });
  if (params.categoryId) query.set("categoryId", params.categoryId);
  if (params.inStock) query.set("inStock", "true");

  return useQuery({
    queryKey: keys.products(query.toString()),
    queryFn: () =>
      api.get<CursorPage<ProductSummaryDto>>(`/products?${query.toString()}`),
    enabled: params.enabled ?? true,
    // Each category the customer has opened this session should stay ready
    // to show instantly if they switch back to it — react-query's default
    // 5-minute garbage-collect window is short enough that browsing several
    // categories evicts the first ones before the customer circles back.
    gcTime: 30 * 60_000,
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: keys.product(id),
    queryFn: () => api.get<ProductDetailDto>(`/products/${id}`),
    // Reopening a product already viewed this session (e.g. from the cart,
    // or backing out and tapping it again) should be instant, not refetched
    // from a blank loading screen.
    gcTime: 30 * 60_000,
  });
}

/** The full rail a Home "See All" opens — same ranking as the preview, no cap. */
export function useRailProducts(key: HomeFeedDto["rails"][number]["key"]) {
  return useQuery({
    queryKey: keys.rail(key),
    queryFn: () =>
      api.get<{ title: string; products: ProductSummaryDto[] }>(
        `/products/rail/${key}?limit=60`,
      ),
    // Same reasoning as useProducts — keep a rail's "See All" page ready
    // for the rest of the session instead of evicting it after 5 minutes.
    gcTime: 30 * 60_000,
  });
}

export function useSearch(term: string) {
  return useQuery({
    queryKey: keys.search(term),
    // `signal` is TanStack Query's own — passed through to `fetch` (see
    // api.ts) so a term this component has moved on from (search-as-you-type
    // firing a newer one) actually stops the request instead of completing
    // uselessly in the background. Also means an old, slow response can
    // never land after a newer one — there is no old response, it never
    // finishes.
    queryFn: ({ signal }) =>
      api.get<CursorPage<ProductSummaryDto>>(
        `/products/search?q=${encodeURIComponent(term)}&limit=30`,
        { signal },
      ),
    enabled: term.trim().length >= 2,
    // Without this, changing the search term swaps to a brand-new query with
    // no data yet — the whole results grid blanked out to a full loading
    // state on every keystroke, even though the previous term's results were
    // still perfectly good to look at for the instant it takes the new ones
    // to arrive. Keeping the old page on screen (see SearchScreen's
    // `isFetching` — a small inline indicator, not another full-screen
    // loader) makes typing feel continuous instead of flickery.
    placeholderData: keepPreviousData,
  });
}

/* -------------------------------------------------------------------------- */
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

export function useCart(distanceKm: number | null = null) {
  return useQuery({
    queryKey: [...keys.cart, distanceKm],
    queryFn: () =>
      api.get<CartDto>(
        distanceKm !== null
          ? `/cart?distanceKm=${encodeURIComponent(distanceKm)}`
          : "/cart",
      ),
    // The cart must never sit on a stale answer just because it was already
    // in memory — every screen that shows it refetches fresh the instant
    // it's observed, regardless of the app's default 30s staleTime. Without
    // this, an order placed on one screen could leave the cart looking
    // unchanged for up to 30s on another that had it cached (e.g. re-opening
    // the Cart tab right after checkout).
    refetchOnMount: "always",
  });
}

/**
 * Bumped every time the cart becomes authoritatively empty from OUTSIDE a
 * per-item mutation's own response — a successful order, or Clear Cart.
 *
 * Why this exists: a per-item add/update/remove request can still be in
 * flight when the user checks out or taps Clear Cart (e.g. they tapped `+`
 * then immediately hit Checkout before that request's response arrived).
 * That response is a `CartDto` computed against the cart as it was BEFORE
 * the clear/order — applying it afterward would resurrect an item/count
 * into a cart that has since been correctly emptied. Each mutation captures
 * the epoch it started with (`onMutate`) and its `onSuccess` compares that
 * to the current epoch before writing to the cache; a mismatch means an
 * authoritative clear happened in between, so the response is dropped.
 */
let cartEpoch = 0;

function bumpCartEpoch(): number {
  cartEpoch += 1;
  return cartEpoch;
}

/**
 * Called right after a successful order placement. The backend marks the
 * cart CONVERTED inside the SAME transaction that creates the order (see
 * `cartService.markConverted` in order.service.ts), so the cart is already
 * truly empty server-side by the time `POST /orders` resolves — this isn't
 * an optimistic guess, it's writing down what the server has already done.
 *
 * Previously this moment only called `invalidateQueries`, which marks the
 * cached (still showing the pre-order items) data stale and queues a
 * background `GET /cart` for every screen currently reading it. That GET
 * is a real network round trip — on a slow connection the badge and the
 * Cart screen kept showing the old count until it happened to land, which
 * is exactly the "order succeeded but badge still says 4" bug. Writing the
 * known-correct empty state directly makes every reader consistent in the
 * same tick as order success, with no dependency on network timing.
 */
export function clearCartAfterOrder(queryClient: QueryClient): void {
  bumpCartEpoch();

  queryClient.setQueriesData<CartDto>({ queryKey: keys.cart }, (old) =>
    old ? { ...old, items: [], bill: { ...old.bill, itemCount: 0 } } : old,
  );
}

export function useCartMutations() {
  const queryClient = useQueryClient();

  const write = (data: CartDto) => {
    queryClient.setQueriesData<CartDto>({ queryKey: keys.cart }, data);
  };

  type MutationContext = { epoch: number };

  // A newer authoritative clear (Clear Cart, or a successful order) landed
  // while this request was in flight — see `cartEpoch` above. That state is
  // correct and newer; this response is stale and must not overwrite it.
  const guardedWrite = (data: CartDto, context: MutationContext | undefined): void => {
    if (context && context.epoch !== cartEpoch) return;
    write(data);
  };

  const captureEpoch = (): MutationContext => ({ epoch: cartEpoch });

  const addItem = useMutation({
    mutationFn: (input: {
      variantId: string;
      qty?: number;
      distanceKm?: number | null;
    }) => {
      const distanceKm = input.distanceKm ?? null;

      const query =
        distanceKm !== null
          ? `?distanceKm=${encodeURIComponent(distanceKm)}`
          : "";

      return api.post<CartDto>(`/cart/items${query}`, {
        variantId: input.variantId,
        qty: input.qty ?? 1,
      });
    },

    onMutate: captureEpoch,
    onSuccess: (data, _vars, context) => guardedWrite(data, context),
  });

  const updateQty = useMutation({
    mutationFn: (input: {
      cartItemId: string;
      qty: number;
      distanceKm?: number | null;
    }) => {
      const distanceKm = input.distanceKm ?? null;

      const query =
        distanceKm !== null
          ? `?distanceKm=${encodeURIComponent(distanceKm)}`
          : "";

      return api.patch<CartDto>(`/cart/items/${input.cartItemId}${query}`, {
        qty: input.qty,
      });
    },

    onMutate: captureEpoch,
    onSuccess: (data, _vars, context) => guardedWrite(data, context),
  });

  const removeItem = useMutation({
    mutationFn: (input: { cartItemId: string; distanceKm?: number | null }) => {
      const distanceKm = input.distanceKm ?? null;

      const query =
        distanceKm !== null
          ? `?distanceKm=${encodeURIComponent(distanceKm)}`
          : "";

      return api.delete<CartDto>(`/cart/items/${input.cartItemId}${query}`);
    },

    onMutate: captureEpoch,
    onSuccess: (data, _vars, context) => guardedWrite(data, context),
  });

  const clearCart = useMutation({
    mutationFn: (input: { distanceKm?: number | null } = {}) => {
      const distanceKm = input.distanceKm ?? null;

      const query =
        distanceKm !== null
          ? `?distanceKm=${encodeURIComponent(distanceKm)}`
          : "";

      // The backend already offers one atomic bulk clear (DELETE /cart) —
      // one round trip instead of one DELETE per line.
      return api.delete<CartDto>(`/cart${query}`);
    },

    onSuccess: (data) => {
      // Clear is itself an authoritative empty, exactly like order success —
      // bump the epoch so a slower add/update from just before the tap can't
      // land afterward and resurrect an item (see `cartEpoch` above).
      bumpCartEpoch();
      write(data);
    },
  });

  const applyCoupon = useMutation({
    mutationFn: (input: { code: string; distanceKm?: number | null }) => {
      const distanceKm = input.distanceKm ?? null;

      const query =
        distanceKm !== null
          ? `?distanceKm=${encodeURIComponent(distanceKm)}`
          : "";

      return api.post<CartDto>(`/cart/coupon${query}`, {
        code: input.code,
      });
    },

    onMutate: captureEpoch,
    onSuccess: (data, _vars, context) => guardedWrite(data, context),
  });

  return {
    addItem,
    updateQty,
    removeItem,
    clearCart,
    applyCoupon,
  };
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export function useOrders() {
  return useQuery({
    queryKey: keys.orders,
    queryFn: () => api.get<CursorPage<OrderSummaryDto>>("/orders?limit=20"),
    // A cancelled/delivered order must show its real status the moment this
    // list is opened, not whatever it was up to 30s ago — see useCart's same
    // reasoning above.
    refetchOnMount: "always",
  });
}

export function useOrder(id: string, live: boolean) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: () => api.get<OrderDetailDto>(`/orders/${id}`),
    // Polling backs up the socket. A tracking screen that silently stops
    // updating is worse than one that costs a request every 30 seconds.
    refetchInterval: live ? 30_000 : false,
    refetchOnMount: "always",
  });
}

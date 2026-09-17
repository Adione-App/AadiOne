/**
 * Server-state hooks.
 *
 * Every one of these returns data the SERVER computed — prices, stock, COD
 * eligibility, totals. The app renders them and never derives them.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
}) {
  const query = new URLSearchParams({ limit: "30" });
  if (params.categoryId) query.set("categoryId", params.categoryId);
  if (params.inStock) query.set("inStock", "true");

  return useQuery({
    queryKey: keys.products(query.toString()),
    queryFn: () =>
      api.get<CursorPage<ProductSummaryDto>>(`/products?${query.toString()}`),
  });
}

export function useProduct(id: string) {
  return useQuery({
    queryKey: keys.product(id),
    queryFn: () => api.get<ProductDetailDto>(`/products/${id}`),
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
  });
}

export function useSearch(term: string) {
  return useQuery({
    queryKey: keys.search(term),
    queryFn: () =>
      api.get<CursorPage<ProductSummaryDto>>(
        `/products/search?q=${encodeURIComponent(term)}&limit=30`,
      ),
    enabled: term.trim().length >= 2,
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
  });
}

/**
 * Cart mutations.
 *
 * The server's response REPLACES local state rather than being merged into it.
 * If it corrected a quantity or removed an out-of-stock line, that correction
 * is what the customer must see — a merge would quietly restore the item.
 *
 * ROOT CAUSE FIXED HERE: this used to write the response into the single key
 * `['cart', null]` and merely INVALIDATE everything else, including whatever
 * `['cart', distanceKm]` key the screen is actually reading (distanceKm is a
 * real number once location is known, never null). Invalidation only queues
 * a slower background refetch — so the screen kept showing pre-mutation data
 * until that refetch happened to land, then "self-corrected" a second or two
 * later. `setQueriesData` with a partial key match updates EVERY cached
 * `['cart', *]` variant with this response directly and synchronously, so
 * the screen's own query is corrected in the same tick as the mutation
 * response — no dependent refetch, and nothing left to invalidate.
 */
export function useCartMutations() {
  const queryClient = useQueryClient();

  const write = (data: CartDto) => {
    queryClient.setQueriesData<CartDto>({ queryKey: keys.cart }, data);
  };


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

    onSuccess: (data) => {
      write(data);
    },
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

    onSuccess: (data) => {
      write(data);
    },
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

    onSuccess: (data) => {
      write(data);
    },
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

    onSuccess: (data) => {
      write(data);
    },
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
  });
}

export function useOrder(id: string, live: boolean) {
  return useQuery({
    queryKey: keys.order(id),
    queryFn: () => api.get<OrderDetailDto>(`/orders/${id}`),
    // Polling backs up the socket. A tracking screen that silently stops
    // updating is worse than one that costs a request every 30 seconds.
    refetchInterval: live ? 30_000 : false,
  });
}

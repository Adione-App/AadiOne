/**
 * Seller-panel queries shared by more than one page. Every key starts with
 * SELLER_QUERY_ROOT, so signing out drops all of them in one call.
 *
 * Pages share these hooks rather than declaring their own copies, so the
 * dashboard, Products and Inventory read ONE cached copy of each list and a
 * mutation refreshes it once for every screen.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SellerLifecycleDto } from '@shared';
import {
  SELLER_QUERY_ROOT,
  sellerApi,
  sellerErrorMessage,
  toEarningsSummary,
  type SellerActivityItem,
  type SellerAvailability,
  type SellerEarningsSummary,
  type SellerListingInventory,
  type SellerOrderSummary,
  type SellerProductInventory,
  type SellerTodayEarnings,
} from './sellerApi';
import { StockBatcher, confirmProduct, shiftFigures, shiftProduct, withUnsent } from './stockBatch';
import { toast } from './sellerUi';

export const sellerKeys = {
  all: [SELLER_QUERY_ROOT] as const,
  availability: [SELLER_QUERY_ROOT, 'availability'] as const,
  orders: [SELLER_QUERY_ROOT, 'orders'] as const,
  orderList: (filters: Record<string, string>) => [SELLER_QUERY_ROOT, 'orders', 'list', filters] as const,
  orderSummary: [SELLER_QUERY_ROOT, 'orders', 'summary'] as const,
  orderDetail: (id: string) => [SELLER_QUERY_ROOT, 'orders', 'detail', id] as const,
  listings: [SELLER_QUERY_ROOT, 'listings'] as const,
  products: [SELLER_QUERY_ROOT, 'products'] as const,
  categories: [SELLER_QUERY_ROOT, 'categories'] as const,
  catalogCategories: [SELLER_QUERY_ROOT, 'catalog-categories'] as const,
  subcategories: [SELLER_QUERY_ROOT, 'subcategories'] as const,
  menuSections: [SELLER_QUERY_ROOT, 'menu-sections'] as const,
  onboarding: [SELLER_QUERY_ROOT, 'onboarding'] as const,
  lifecycle: [SELLER_QUERY_ROOT, 'lifecycle'] as const,
  earnings: [SELLER_QUERY_ROOT, 'earnings'] as const,
  todayEarnings: [SELLER_QUERY_ROOT, 'earnings', 'today'] as const,
  orderCommissions: [SELLER_QUERY_ROOT, 'earnings', 'orders'] as const,
  settlements: [SELLER_QUERY_ROOT, 'settlements'] as const,
  settlementDetail: (id: string) => [SELLER_QUERY_ROOT, 'settlements', 'detail', id] as const,
  activity: [SELLER_QUERY_ROOT, 'activity'] as const,
};

/**
 * Where the signed-in seller is in the two-gate lifecycle (GET
 * /seller/lifecycle — open in every state). Decides between the onboarding
 * screens and the full panel; the server enforces the same rule.
 */
export function useSellerLifecycle() {
  return useQuery({
    queryKey: sellerKeys.lifecycle,
    queryFn: () => sellerApi.get<SellerLifecycleDto>('/seller/lifecycle'),
    // A decision by Aadione shows up without a reload.
    refetchInterval: 60_000,
  });
}

/** The seller's store state — name, ON/OFF switch, hours, closures. */
export function useSellerAvailability() {
  return useQuery({
    queryKey: sellerKeys.availability,
    queryFn: () => sellerApi.get<SellerAvailability>('/seller/availability'),
    // Opening/closing happens on the clock, not only on edits.
    refetchInterval: 60_000,
  });
}

/**
 * The seller's own Accepting Orders switch. The server's answer (not a guess)
 * is written to the cache, then re-read.
 */
export function useSetAcceptingOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (isAcceptingOrders: boolean) =>
      sellerApi.patch<SellerAvailability>('/seller/availability', { isAcceptingOrders }),
    onSuccess: (data) => queryClient.setQueryData(sellerKeys.availability, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: sellerKeys.availability }),
  });
}

/** Today's orders and how many sit in each working state — one request. */
export function useSellerOrderSummary() {
  return useQuery({
    queryKey: sellerKeys.orderSummary,
    queryFn: () => sellerApi.get<SellerOrderSummary>('/seller/orders/summary'),
    refetchInterval: 30_000,
  });
}

/** Today's sales and earnings — computed by the server's earnings rules. */
export function useSellerTodayEarnings() {
  return useQuery({
    queryKey: sellerKeys.todayEarnings,
    queryFn: () => sellerApi.get<SellerTodayEarnings>('/seller/earnings/today'),
    refetchInterval: 60_000,
  });
}

/** Lifetime earnings and settlement position (GET /seller/earnings). */
export function useSellerEarnings() {
  return useQuery({
    queryKey: sellerKeys.earnings,
    queryFn: () => sellerApi.get<SellerEarningsSummary>('/seller/earnings').then(toEarningsSummary),
  });
}

/** The seller's own products (with inventory + customer visibility). */
export function useSellerProducts() {
  return useQuery({
    queryKey: sellerKeys.products,
    queryFn: () => sellerApi.get<SellerProductInventory[]>('/seller/products'),
  });
}

/** Every listing the seller sells — own products and catalogue products. */
export function useSellerListings() {
  return useQuery({
    queryKey: sellerKeys.listings,
    queryFn: () => sellerApi.get<SellerListingInventory[]>('/seller/listings'),
  });
}

/** Recent changes made by the seller's team (and Aadione) — GET /seller/activity. */
export function useSellerActivity(limit = 15) {
  return useQuery({
    queryKey: [...sellerKeys.activity, limit],
    queryFn: () => sellerApi.get<SellerActivityItem[]>(`/seller/activity?limit=${limit}`),
  });
}

/** Refreshes everything a stock / price / visibility change affects. */
export function useRefreshInventory() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.activity }),
    ]);
}

/**
 * Marks everything a stock change affects as out of date WITHOUT re-reading
 * it now: the screen already shows the server's answer (useApplyListing), so
 * the lists are re-read only when next opened or refocused — not three full
 * list downloads after every tap.
 */
export function useMarkInventoryStale() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: sellerKeys.products, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings, refetchType: 'none' }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.activity, refetchType: 'none' }),
    ]);
}

/** Every cached copy of one listing — lists, the listing page, product rows and product pages (default and size listings). */
function patchListingCaches(
  queryClient: QueryClient,
  listingId: string,
  onListing: (listing: SellerListingInventory) => SellerListingInventory,
  onProduct: (product: SellerProductInventory) => SellerProductInventory,
): void {
  queryClient.setQueryData<SellerListingInventory[]>(sellerKeys.listings, (old) =>
    old?.map((row) => (row.id === listingId ? onListing(row) : row)),
  );
  queryClient.setQueryData<SellerListingInventory>([...sellerKeys.listings, listingId], (old) => (old ? onListing(old) : old));
  // The products list and every product page ([...products, id]).
  for (const [key, data] of queryClient.getQueriesData<SellerProductInventory[] | SellerProductInventory>({ queryKey: sellerKeys.products })) {
    if (Array.isArray(data)) queryClient.setQueryData(key, data.map(onProduct));
    else if (data && typeof data === 'object' && 'variants' in data) queryClient.setQueryData(key, onProduct(data));
  }
}

/**
 * Puts a listing the SERVER just returned (e.g. from stock-adjust) into every
 * cached copy at once — lists, the listing page and product pages, including
 * a size's listing — so the figures on screen match the confirmation.
 */
export function useApplyListing() {
  const queryClient = useQueryClient();
  return (listing: SellerListingInventory) =>
    patchListingCaches(
      queryClient,
      listing.id,
      (row) => ({ ...row, ...listing }),
      (product) => confirmProduct(product, listing),
    );
}

/**
 * Stock −/+ taps (stockBatch.ts): every tap shows at once, taps on one listing
 * are added up and sent as one change, one request per listing at a time, and
 * a refused batch is taken back. `adjust(listingId, delta, label)`;
 * `busy(listingId)` while taps of it are not confirmed yet.
 */
export function useStockBatcher() {
  const queryClient = useQueryClient();
  const markStale = useMarkInventoryStale();
  const labels = useRef(new Map<string, string>());
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((v) => v + 1);

  const shift = (listingId: string, delta: number) =>
    patchListingCaches(
      queryClient,
      listingId,
      (row) => shiftFigures(row, delta),
      (product) => shiftProduct(product, listingId, delta),
    );

  const batcher = useRef<StockBatcher<SellerListingInventory> | null>(null);
  batcher.current ??= new StockBatcher<SellerListingInventory>({
    send: (listingId, delta) => sellerApi.post<SellerListingInventory>(`/seller/listings/${listingId}/stock-adjust`, { delta }),
    onConfirmed: (listingId, listing, unsent) => {
      const shown = withUnsent(listing, unsent);
      patchListingCaches(
        queryClient,
        listingId,
        (row) => ({ ...row, ...shown }),
        (product) => confirmProduct(product, shown),
      );
      void markStale();
      void queryClient.invalidateQueries({ queryKey: [...sellerKeys.listings, listingId, 'movements'] });
      if (unsent === 0) toast(`${labels.current.get(listingId) ?? listing.productName}: ${listing.availableQty} available.`);
      rerender();
    },
    onFailed: (listingId, error, undo) => {
      shift(listingId, -undo);
      // The server is the authority: re-read the real figures.
      void queryClient.invalidateQueries({ queryKey: sellerKeys.products });
      void queryClient.invalidateQueries({ queryKey: sellerKeys.listings });
      toast(sellerErrorMessage(error), false);
      rerender();
    },
  });

  // Leaving the page sends what is waiting — a tap is never dropped.
  useEffect(() => () => batcher.current?.flushAll(), []);

  return {
    adjust: (listingId: string, delta: number, label: string) => {
      labels.current.set(listingId, label);
      shift(listingId, delta);
      batcher.current!.add(listingId, delta);
      rerender();
    },
    busy: (listingId: string) => batcher.current!.isBusy(listingId),
  };
}

/** `value`, once it has stopped changing for `ms` (search boxes that hit the server). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Seller-panel queries shared by more than one page. Every key starts with
 * SELLER_QUERY_ROOT, so signing out drops all of them in one call.
 *
 * Pages share these hooks rather than declaring their own copies, so the
 * dashboard, Products and Inventory read ONE cached copy of each list and a
 * mutation refreshes it once for every screen.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SellerLifecycleDto } from '@shared';
import {
  SELLER_QUERY_ROOT,
  sellerApi,
  toEarningsSummary,
  type SellerActivityItem,
  type SellerAvailability,
  type SellerEarningsSummary,
  type SellerListingInventory,
  type SellerOrderSummary,
  type SellerProductInventory,
  type SellerTodayEarnings,
} from './sellerApi';

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
 * Puts a listing the SERVER just returned (e.g. from stock-adjust) into the
 * cached lists at once, so the figures on screen match the confirmation
 * straight away; the follow-up refresh still re-reads everything.
 */
export function useApplyListing() {
  const queryClient = useQueryClient();
  return (listing: SellerListingInventory) => {
    queryClient.setQueryData<SellerListingInventory[]>(sellerKeys.listings, (old) =>
      old?.map((row) => (row.id === listing.id ? listing : row)),
    );
    queryClient.setQueryData<SellerProductInventory[]>(sellerKeys.products, (old) =>
      old?.map((product) =>
        product.listing?.id === listing.id
          ? {
              ...product,
              listing: {
                ...product.listing,
                stockQty: listing.stockQty,
                reservedQty: listing.reservedQty,
                availableQty: listing.availableQty,
                isAvailable: listing.isAvailable,
                pricePaise: listing.pricePaise,
                mrpPaise: listing.mrpPaise,
                updatedAt: listing.updatedAt,
              },
              visibility: listing.visibility,
            }
          : product,
      ),
    );
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

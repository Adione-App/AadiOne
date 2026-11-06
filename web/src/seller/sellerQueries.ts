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
import { StockBatcher, confirmProduct, figuresIn, holdFigures, shiftFigures, shiftProduct, withUnsent, type HeldFigures } from './stockBatch';
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

type StockOutcome = { ok: true; listing: SellerListingInventory } | { ok: false; error: unknown };

/**
 * ONE stock queue per query client, shared by every stock control on every
 * page (a list row, the stock dialog over it, the product page): two queues
 * on one listing could each confirm over the other's taps.
 */
interface SharedStock {
  batcher: StockBatcher<SellerListingInventory>;
  labels: Map<string, string>;
  /** Figures on screen of listings with unconfirmed changes (see holdFigures). */
  held: Map<string, HeldFigures>;
  /** Components to re-render / tell about an outcome. */
  listeners: Set<{ rerender: () => void; onSettled?: (listingId: string, outcome: StockOutcome) => void }>;
  adjust: (listingId: string, delta: number, label: string, note?: string) => void;
}
const sharedStock = new WeakMap<QueryClient, SharedStock>();

function stockFor(queryClient: QueryClient): SharedStock {
  const existing = sharedStock.get(queryClient);
  if (existing) return existing;

  const shift = (listingId: string, delta: number) =>
    patchListingCaches(
      queryClient,
      listingId,
      (row) => shiftFigures(row, delta),
      (product) => shiftProduct(product, listingId, delta),
    );
  /** What the screen shows for the listing now (any cached copy). */
  const shownFigures = (listingId: string): HeldFigures | null => {
    for (const key of [sellerKeys.listings, sellerKeys.products]) {
      for (const [, data] of queryClient.getQueriesData({ queryKey: key })) {
        const found = figuresIn(data, listingId);
        if (found) return found;
      }
    }
    return null;
  };
  const hold = (listingId: string) => {
    const figures = shared.batcher.isBusy(listingId) ? shownFigures(listingId) : null;
    if (figures) shared.held.set(listingId, figures);
    else shared.held.delete(listingId);
  };
  const tell = (listingId: string, outcome: StockOutcome | null) => {
    for (const listener of shared.listeners) {
      if (outcome) listener.onSettled?.(listingId, outcome);
      listener.rerender();
    }
  };

  const shared: SharedStock = {
    labels: new Map(),
    held: new Map(),
    listeners: new Set(),
    batcher: new StockBatcher<SellerListingInventory>({
      send: (listingId, delta, note) =>
        sellerApi.post<SellerListingInventory>(`/seller/listings/${listingId}/stock-adjust`, note ? { delta, note } : { delta }),
      onConfirmed: (listingId, listing, unsent) => {
        const shown = withUnsent(listing, unsent);
        patchListingCaches(
          queryClient,
          listingId,
          (row) => ({ ...row, ...shown }),
          (product) => confirmProduct(product, shown),
        );
        hold(listingId);
        // The screen already shows the server's answer: the lists are only
        // marked out of date (re-read when next opened), the history re-read.
        for (const key of [sellerKeys.products, sellerKeys.listings, sellerKeys.activity]) {
          void queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
        }
        void queryClient.invalidateQueries({ queryKey: [...sellerKeys.listings, listingId, 'movements'] });
        if (unsent === 0) toast(`${shared.labels.get(listingId) ?? listing.productName}: ${listing.availableQty} available.`);
        tell(listingId, { ok: true, listing });
      },
      onFailed: (listingId, error, undo) => {
        shared.held.delete(listingId);
        shift(listingId, -undo);
        // The server is the authority: re-read the real figures.
        void queryClient.invalidateQueries({ queryKey: sellerKeys.products });
        void queryClient.invalidateQueries({ queryKey: sellerKeys.listings });
        toast(sellerErrorMessage(error), false);
        tell(listingId, { ok: false, error });
      },
    }),
    adjust: (listingId, delta, label, note) => {
      if (!Number.isInteger(delta) || delta === 0) return;
      shared.labels.set(listingId, label);
      // A list read already on its way predates this tap: drop it.
      void queryClient.cancelQueries({ queryKey: sellerKeys.listings });
      void queryClient.cancelQueries({ queryKey: sellerKeys.products });
      shift(listingId, delta);
      shared.batcher.add(listingId, delta, note?.trim() ? note.trim() : undefined);
      hold(listingId);
      tell(listingId, null);
    },
  };

  // Figures fetched while taps are unconfirmed keep what the screen shows.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const key = event.query.queryKey;
    if (key[0] !== SELLER_QUERY_ROOT || (key[1] !== 'listings' && key[1] !== 'products')) return;
    for (const [listingId, figures] of shared.held) {
      if (!shared.batcher.isBusy(listingId)) continue;
      queryClient.setQueryData(key, (data: unknown) => holdFigures(data, listingId, figures));
    }
  });

  sharedStock.set(queryClient, shared);
  return shared;
}

/**
 * Stock −/+ taps (stockBatch.ts): every tap shows at once, taps on one listing
 * are added up and sent as one change, one request per listing at a time (one
 * shared queue — stockFor), and a refused change is taken back.
 * `adjust(listingId, delta, label, note?)` — a note makes it its own change,
 * sent at once (the "Adjust by an amount" form); `busy(listingId)` while
 * changes of it are not confirmed yet; `onSettled` hears each outcome.
 *
 * Never disables anything: a control stays usable while earlier taps are on
 * their way. Stale data cannot undo taps: list reads already running are
 * cancelled on a tap, and figures fetched while taps are unconfirmed are held
 * at what the screen shows (holdFigures) until the server's answer arrives.
 */
export function useStockBatcher(options: { onSettled?: (listingId: string, outcome: StockOutcome) => void } = {}) {
  const queryClient = useQueryClient();
  const shared = stockFor(queryClient);
  const [, setVersion] = useState(0);
  const settled = useRef(options.onSettled);
  settled.current = options.onSettled;

  useEffect(() => {
    const listener = {
      rerender: () => setVersion((v) => v + 1),
      onSettled: (listingId: string, outcome: StockOutcome) => settled.current?.(listingId, outcome),
    };
    shared.listeners.add(listener);
    return () => {
      shared.listeners.delete(listener);
      // The last stock control gone (leaving the page): send what is waiting — a tap is never dropped.
      if (shared.listeners.size === 0) shared.batcher.flushAll();
    };
  }, [shared]);

  return {
    adjust: shared.adjust,
    busy: (listingId: string) => shared.batcher.isBusy(listingId),
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

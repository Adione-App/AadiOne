/**
 * Admin marketplace views — types and queries for the read-mostly endpoints
 * in backend admin-marketplace.routes.ts. Every figure is computed by the
 * server; pages only display it.
 */

import { useQuery } from '@tanstack/react-query';
import { api, ApiRequestError } from './api';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type VisibilityReason =
  | 'VISIBLE'
  | 'STORE_DEACTIVATED'
  | 'STORE_NOT_APPROVED'
  | 'DISABLED_BY_ADMIN'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'HIDDEN_BY_SELLER'
  | 'NOT_LISTED'
  | 'OFF_SALE'
  | 'OUT_OF_STOCK';

export type StockState = 'IN_STOCK' | 'LOW' | 'OUT';

export interface MarketplaceProductRow {
  key: string;
  productId: string;
  productName: string;
  variantName: string | null;
  imageUrl: string | null;
  category: { id: string; name: string };
  seller: { id: string; name: string };
  ownership: 'SELLER' | 'CATALOG';
  listing: {
    id: string;
    pricePaise: number;
    mrpPaise: number;
    stockQty: number;
    reservedQty: number;
    availableQty: number;
    isAvailable: boolean;
    stock: StockState;
  } | null;
  approvalStatus: string;
  productStatus: string;
  visibility: { sellable: boolean; reason: VisibilityReason; availableQty: number; lowStock: boolean };
  updatedAt: string;
}

export interface MarketplaceProducts extends Paged<MarketplaceProductRow> {
  summary: { total: number; buyable: number; pendingApproval: number; rejected: number; lowStock: number; outOfStock: number; disabled: number };
}

export interface MarketplaceInventoryRow {
  listingId: string;
  seller: { id: string; name: string };
  product: { id: string; name: string; variantName: string | null; imageUrl: string | null; category: string };
  pricePaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  lowStockThreshold: number;
  isAvailable: boolean;
  stock: StockState;
  visibilityReason: VisibilityReason;
  updatedAt: string;
}

export interface MarketplaceInventory extends Paged<MarketplaceInventoryRow> {
  summary: {
    totalListings: number;
    totalProducts: number;
    sellers: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
    offSale: number;
    stockValuePaise: number;
  };
}

export interface StockHistoryRow {
  id: string;
  at: string;
  delta: number;
  reason: string;
  availableBefore: number;
  availableAfter: number;
  note: string | null;
  orderNumber: string | null;
  by: string;
}

export interface PaymentRow {
  id: string;
  provider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  method: string | null;
  amountPaise: number;
  currency: string;
  /** The gateway's own status (CREATED, CAPTURED, FAILED, …), as stored. */
  status: string;
  /**
   * What happened, combining that with the order's status (backend
   * `paymentOutcome`) — only PAID is money received.
   */
  outcome: 'PAID' | 'PENDING' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  failureReason: string | null;
  capturedAt: string | null;
  createdAt: string;
  order: { id: string; orderNumber: string; status: string; paymentMethod: string; cancellationReason: string | null };
  customer: { name: string | null; mobile: string | null };
  refund: { state: 'NONE' | 'PENDING' | 'PARTIAL' | 'REFUNDED' | 'FAILED'; refundedPaise: number };
}

export interface RefundRow {
  id: string;
  providerRefundId: string | null;
  amountPaise: number;
  status: string;
  reason: string | null;
  failureReason: string | null;
  completedAt: string | null;
  createdAt: string;
  provider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  order: { id: string; orderNumber: string; customerName: string | null };
  seller: { id: string; name: string } | null;
}

export interface AuditLogRow {
  id: string;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { name: string | null; role: string } | null;
  before: unknown;
  after: unknown;
}

export interface AuditLogs extends Paged<AuditLogRow> {
  entityTypes: { entityType: string; count: number }[];
}

export interface CommissionOverview {
  sellers: {
    sellerId: string;
    sellerName: string;
    isActive: boolean;
    defaultCommissionBp: number;
    categoryRules: number;
    productRules: number;
    grossSalesPaise: number;
    commissionPaise: number;
    netPayablePaise: number;
  }[];
  totals: { grossSalesPaise: number; commissionPaise: number; netPayablePaise: number };
  recentRules: {
    ruleId: string;
    seller: { id: string; name: string };
    scope: 'PRODUCT' | 'CATEGORY';
    targetName: string | null;
    rateBp: number;
    isActive: boolean;
    changedAt: string;
  }[];
}

/** Query string from a filter object, skipping empty values. */
export function toQuery(filters: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== null && value !== undefined && value !== '' && value !== 'ALL') params.set(key, String(value));
  }
  return params.toString();
}

export const marketplaceKeys = {
  products: (q: string) => ['admin', 'marketplace', 'products', q] as const,
  inventory: (q: string) => ['admin', 'marketplace', 'inventory', q] as const,
  history: (listingId: string) => ['admin', 'marketplace', 'inventory', 'history', listingId] as const,
  payments: (q: string) => ['admin', 'payments', q] as const,
  refunds: (q: string) => ['admin', 'refunds', q] as const,
  auditLogs: (q: string) => ['admin', 'audit-logs', q] as const,
  commission: ['admin', 'commission', 'overview'] as const,
  sellerActivity: (sellerId: string) => ['admin', 'sellers', sellerId, 'activity'] as const,
};

export function useMarketplaceProducts(query: string) {
  return useQuery({
    queryKey: marketplaceKeys.products(query),
    queryFn: () => api.get<MarketplaceProducts>(`/admin/marketplace/products?${query}`),
    placeholderData: (previous) => previous,
  });
}

export function useMarketplaceInventory(query: string) {
  return useQuery({
    queryKey: marketplaceKeys.inventory(query),
    queryFn: () => api.get<MarketplaceInventory>(`/admin/marketplace/inventory?${query}`),
    placeholderData: (previous) => previous,
  });
}

/**
 * Sellers for filter dropdowns (first 100, by name). Needs the Sellers
 * page's permission; without it the dropdown is simply not offered.
 */
export function useSellerOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'sellers', 'options'],
    queryFn: () =>
      api
        .get<{ items: { id: string; name: string }[] }>('/admin/sellers?limit=100')
        .then((page) => page.items.map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name))),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Marketplace catalogue (GET /admin/marketplace/catalogue) — read only        */
/* -------------------------------------------------------------------------- */

export interface CatalogueProduct {
  productId: string;
  name: string;
  imageUrl: string | null;
  seller: { id: string; name: string; sellerType: string };
  status: string;
  approvalStatus: string;
  categoryId: string;
  listingCount: number;
  minPricePaise: number | null;
  availableQty: number;
  updatedAt: string;
}

export interface CatalogueSellerRef {
  id: string;
  name: string;
  categoryId: string;
  isActive: boolean;
}

export interface CatalogueSubcategory {
  key: string;
  name: string;
  sellers: CatalogueSellerRef[];
  products: CatalogueProduct[];
}

export interface CatalogueTopCategory {
  key: string;
  name: string;
  sellers: CatalogueSellerRef[];
  products: CatalogueProduct[];
  subcategories: CatalogueSubcategory[];
  productCount: number;
}

export interface MarketplaceCatalogue {
  summary: { topCategories: number; subcategories: number; products: number; sellers: number };
  categories: CatalogueTopCategory[];
}

export function useMarketplaceCatalogue(filters: { q?: string; sellerId?: string }) {
  const query = toQuery({ q: filters.q, sellerId: filters.sellerId });
  return useQuery({
    queryKey: ['admin', 'marketplace', 'catalogue', query],
    queryFn: () => api.get<MarketplaceCatalogue>(`/admin/marketplace/catalogue${query ? `?${query}` : ''}`),
    placeholderData: (previous) => previous,
  });
}

/** A message safe to show an admin for a failed request. */
export function adminErrorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return 'Your account does not have access to this.';
    if (error.status >= 500) return fallback;
    return error.message;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/** Basis points as a percentage: 1250 -> "12.5%". */
export const percentBp = (bp: number): string => `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

export const shortDateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
export const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

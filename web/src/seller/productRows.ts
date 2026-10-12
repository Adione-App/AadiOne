/**
 * One row per thing the seller sells or has submitted — its own products
 * (GET /seller/products) and the catalogue products it lists (GET
 * /seller/listings) — shared by the dashboard, Products and Inventory, so
 * every screen classifies a product the same way.
 *
 * Every state is read from the server's own fields (`visibility.reason`,
 * `approvalStatus`, the latest approval item, listing numbers); nothing here
 * decides whether a customer can buy something.
 */

import type { ListingVisibility, SellerListingInventory, SellerProductInventory } from './sellerApi';
import { VISIBILITY, isEditable, reviewState } from './productUi';
import type { Tone } from '@/components/ui';

export interface RowListing {
  id: string;
  pricePaise: number;
  mrpPaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  isAvailable: boolean;
  lowStockThreshold: number;
  updatedAt: string | null;
  /** false = made-to-order food item (restaurant/cafe): no stock count. */
  tracksStock: boolean;
}

export interface ProductRow {
  key: string;
  own: boolean;
  href: string;
  name: string;
  category: string;
  image: string | null;
  /**
   * For an own product with several sizes / variants: the stock of ALL of
   * them added up (price = the lowest). Otherwise the one listing.
   */
  listing: RowListing | null;
  /** Live variants (sizes / options) of an own product; 1 for a simple item or a catalogue listing. */
  variantCount: number;
  visibility: ListingVisibility;
  /** APPROVED | PENDING | REJECTED (a catalogue listing is always APPROVED). */
  approval: string;
  /** Pending, but never submitted for review. */
  draft: boolean;
  review: { label: string; tone: Tone };
  editable: boolean;
  /** Own products: the product-level show/hide switch. */
  productId: string | null;
  productShown: boolean;
  /** Aadione disabled it (Product.status = ARCHIVED) or the store is deactivated. */
  adminLocked: boolean;
  canStartSelling: boolean;
  product: SellerProductInventory | null;
  /** Most recent change to the product or its listing. */
  updatedAt: string;
}

const later = (a: string, b: string | null | undefined): string => (b && b > a ? b : a);

/**
 * One row per product: a product with several sizes shows the sum of every
 * size's own stock (and its lowest price), never just the default size's.
 */
function productListing(p: SellerProductInventory, updatedAt: string | null): RowListing | null {
  const own = p.listing ? { ...p.listing, updatedAt } : null;
  const listings = (p.variants ?? []).map((v) => v.listing).filter((l): l is NonNullable<typeof l> => l !== null);
  if (listings.length <= 1 || !own) return own;
  const cheapest = listings.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  const sum = (pick: (l: (typeof listings)[number]) => number) => listings.reduce((n, l) => n + pick(l), 0);
  return {
    ...own,
    pricePaise: cheapest.pricePaise,
    mrpPaise: cheapest.mrpPaise,
    stockQty: sum((l) => l.stockQty),
    reservedQty: sum((l) => l.reservedQty),
    availableQty: sum((l) => l.availableQty),
    isAvailable: listings.some((l) => l.isAvailable),
    tracksStock: listings.every((l) => l.tracksStock),
  };
}

export function rowsOf(products: SellerProductInventory[], listings: SellerListingInventory[]): ProductRow[] {
  const ownListingIds = new Set(products.map((p) => p.listing?.id).filter(Boolean));
  const listingUpdated = new Map(listings.map((l) => [l.id, l.updatedAt]));
  const own: ProductRow[] = products.map((p) => {
    const review = reviewState(p);
    const listingUpdatedAt = p.listing ? (p.listing.updatedAt || listingUpdated.get(p.listing.id)) ?? null : null;
    return {
      key: `p-${p.id}`,
      own: true,
      href: `/seller/products/${p.id}`,
      name: p.name,
      category: [p.category.name, p.subcategory?.name].filter(Boolean).join(' › '),
      image: p.images[0]?.thumbUrl ?? p.images[0]?.url ?? null,
      listing: productListing(p, listingUpdatedAt),
      variantCount: Math.max(1, (p.variants ?? []).length),
      visibility: p.visibility,
      approval: p.approvalStatus,
      draft: p.approvalStatus === 'PENDING' && p.latestApproval?.status !== 'PENDING',
      review,
      editable: isEditable(p),
      productId: p.id,
      productShown: p.status === 'ACTIVE',
      adminLocked: p.status === 'ARCHIVED' || VISIBILITY[p.visibility.reason].admin === true,
      // An older product saved before price/stock were part of the form.
      canStartSelling: !p.listing && p.defaultVariant !== null && p.status !== 'ARCHIVED',
      product: p,
      updatedAt: later(p.updatedAt, listingUpdatedAt),
    };
  });
  const others: ProductRow[] = listings
    .filter((l) => !ownListingIds.has(l.id))
    .map((l) => ({
      key: `l-${l.id}`,
      own: false,
      href: `/seller/listings/${l.id}`,
      name: l.productName,
      category: [l.categoryName, l.variantName].filter(Boolean).join(' · '),
      image: l.imageUrl,
      listing: l,
      variantCount: 1,
      visibility: l.visibility,
      approval: l.approvalStatus,
      draft: false,
      review: { label: 'Approved', tone: 'brand' as Tone },
      editable: false,
      productId: null,
      productShown: true,
      adminLocked: l.productStatus === 'ARCHIVED' || VISIBILITY[l.visibility.reason].admin === true,
      canStartSelling: false,
      product: null,
      updatedAt: l.updatedAt,
    }));
  return [...own, ...others];
}

/** Listed, switched on sale, and nothing left to sell. */
export const isOutOfStock = (row: ProductRow): boolean =>
  row.listing !== null && row.listing.isAvailable && row.listing.availableQty <= 0;

/** Approved but switched off by the seller (product hidden or listing off sale). */
export const isHiddenBySeller = (row: ProductRow): boolean =>
  row.approval === 'APPROVED' && !row.adminLocked && ((row.own && !row.productShown) || (row.listing !== null && !row.listing.isAvailable));

export type AttentionKind = 'DISABLED' | 'REJECTED' | 'OUT_OF_STOCK' | 'LOW_STOCK' | 'HIDDEN' | 'DRAFT' | 'PENDING';

export interface Attention {
  kind: AttentionKind;
  label: string;
  tone: Tone;
  /** The fix, as a link label + where it goes. */
  action: string;
  href: string;
}

/** The most pressing thing about a row, if anything needs the seller. */
export function attentionOf(row: ProductRow): Attention | null {
  if (row.adminLocked) {
    return { kind: 'DISABLED', label: 'Disabled by Aadione', tone: 'red', action: 'View details', href: `${row.href}#visibility` };
  }
  if (row.approval === 'REJECTED') {
    return { kind: 'REJECTED', label: 'Rejected', tone: 'red', action: 'Fix & resubmit', href: `${row.href}#approval` };
  }
  if (isOutOfStock(row)) {
    return { kind: 'OUT_OF_STOCK', label: 'Out of stock', tone: 'red', action: 'Add stock', href: `${row.href}#inventory` };
  }
  if (row.visibility.lowStock) {
    return { kind: 'LOW_STOCK', label: `Low stock · ${row.listing?.availableQty ?? 0} left`, tone: 'amber', action: 'Add stock', href: `${row.href}#inventory` };
  }
  if (isHiddenBySeller(row)) {
    return { kind: 'HIDDEN', label: 'Hidden from customers', tone: 'gray', action: 'Show it', href: `${row.href}#visibility` };
  }
  if (row.draft) {
    return row.listing
      ? { kind: 'DRAFT', label: 'Ready for Submission', tone: 'blue', action: 'Submit for Approval', href: '/seller/products?approval=READY' }
      : { kind: 'DRAFT', label: 'Draft · needs price & stock', tone: 'gray', action: 'Add price & stock', href: `${row.href}#pricing` };
  }
  if (row.approval === 'PENDING') {
    return { kind: 'PENDING', label: 'Pending Approval', tone: 'amber', action: 'View', href: row.href };
  }
  return null;
}

/** Most urgent first. */
export const ATTENTION_ORDER: AttentionKind[] = ['DISABLED', 'OUT_OF_STOCK', 'REJECTED', 'LOW_STOCK', 'HIDDEN', 'DRAFT', 'PENDING'];

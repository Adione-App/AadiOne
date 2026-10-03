/**
 * Admin marketplace views — read-only monitoring across every seller, plus
 * product moderation. Aadione is one seller among the others here; nothing in
 * this module special-cases any seller.
 *
 *   products     one row per seller listing, plus seller-submitted products
 *                not listed yet — seller, category, price, stock, approval,
 *                customer visibility (listing-visibility.ts, the same rule
 *                the seller panel shows), status, last updated
 *   inventory    every listing with stock / reserved / available and a
 *                summary computed over ALL listings (not a page, not one
 *                seller)
 *   payments     Payment rows (never the provider's raw payload)
 *   refunds      Refund rows
 *   audit logs   AuditLog rows with sensitive values redacted
 *   commission   per-seller rules + the earnings the settlement service
 *                already computes
 *   catalogue    every seller's own categories merged by name into one
 *                Top category › Subcategory › Product tree, each product
 *                carrying the seller that owns it
 */

import { AppError } from '../../common/errors';
import { ErrorCode, ProductStatus } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { listingVisibility, type ListingVisibility, type ListingVisibilityReason } from '../catalog/listing-visibility';
import * as settlementService from '../sellers/seller-settlement.service';
import { maskMobile, paginate, redactAuditValue, refundSummary, stockState, type Paged, type StockState } from './admin-marketplace-views';

/** Upper bound on rows a monitoring view loads before filtering. */
const ROW_CAP = 5000;

const STORE_SELECT = { id: true, name: true, isActive: true, deletedAt: true, onboardingStatus: true } as const;
const PRODUCT_SELECT = {
  id: true,
  name: true,
  status: true,
  deletedAt: true,
  approvalStatus: true,
  submittedBySellerId: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
  images: { orderBy: { displayOrder: 'asc' as const }, take: 1, select: { url: true, thumbUrl: true } },
} as const;

const LISTING_SELECT = {
  id: true,
  pricePaise: true,
  mrpPaise: true,
  stockQty: true,
  reservedQty: true,
  isAvailable: true,
  lowStockThreshold: true,
  updatedAt: true,
  seller: { select: STORE_SELECT },
  variant: { select: { variantName: true, status: true, deletedAt: true, product: { select: PRODUCT_SELECT } } },
} as const;

async function loadListings(filter: { q?: string; sellerId?: string }) {
  return prisma.sellerListing.findMany({
    where: {
      ...(filter.sellerId ? { sellerId: filter.sellerId } : {}),
      seller: { deletedAt: null },
      variant: {
        deletedAt: null,
        product: { deletedAt: null, ...(filter.q ? { name: { contains: filter.q, mode: 'insensitive' as const } } : {}) },
      },
    },
    select: LISTING_SELECT,
    orderBy: { updatedAt: 'desc' },
    take: ROW_CAP,
  });
}

type ListingRow = Awaited<ReturnType<typeof loadListings>>[number];

const imageOf = (product: { images: { url: string; thumbUrl: string | null }[] }) =>
  product.images[0]?.thumbUrl ?? product.images[0]?.url ?? null;
const later = (a: Date, b: Date) => (a > b ? a : b);

/* -------------------------------------------------------------------------- */
/* products                                                                   */
/* -------------------------------------------------------------------------- */

export interface MarketplaceProductRow {
  key: string;
  productId: string;
  productName: string;
  variantName: string | null;
  imageUrl: string | null;
  category: { id: string; name: string };
  seller: { id: string; name: string };
  /** SELLER: the listing seller submitted it. CATALOG: a shared catalogue product. */
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
  visibility: ListingVisibility;
  updatedAt: string;
}

export interface MarketplaceProductQuery {
  q?: string;
  sellerId?: string;
  approval?: 'APPROVED' | 'PENDING' | 'REJECTED';
  visibility?: 'BUYABLE' | 'NOT_BUYABLE' | 'DISABLED';
  stock?: 'LOW' | 'OUT';
  page: number;
  pageSize: number;
}

export interface MarketplaceProductSummary {
  total: number;
  buyable: number;
  pendingApproval: number;
  rejected: number;
  lowStock: number;
  outOfStock: number;
  disabled: number;
}

export async function listMarketplaceProducts(
  query: MarketplaceProductQuery,
): Promise<Paged<MarketplaceProductRow> & { summary: MarketplaceProductSummary }> {
  const [listings, submitted] = await Promise.all([
    loadListings(query),
    prisma.product.findMany({
      where: {
        deletedAt: null,
        submittedBySellerId: query.sellerId ? query.sellerId : { not: null },
        submittedBySeller: { deletedAt: null },
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      },
      select: {
        ...PRODUCT_SELECT,
        submittedBySeller: { select: STORE_SELECT },
        variants: {
          where: { deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }],
          take: 1,
          select: { variantName: true, status: true, deletedAt: true },
        },
      },
      take: ROW_CAP,
    }),
  ]);

  const listingRows = listings.map((l): MarketplaceProductRow => {
    const product = l.variant.product;
    const { availableQty, state } = stockState(l);
    return {
      key: `l-${l.id}`,
      productId: product.id,
      productName: product.name,
      variantName: l.variant.variantName,
      imageUrl: imageOf(product),
      category: product.category,
      seller: { id: l.seller.id, name: l.seller.name },
      ownership: product.submittedBySellerId === l.seller.id ? 'SELLER' : 'CATALOG',
      listing: {
        id: l.id,
        pricePaise: l.pricePaise,
        mrpPaise: l.mrpPaise,
        stockQty: l.stockQty,
        reservedQty: l.reservedQty,
        availableQty,
        isAvailable: l.isAvailable,
        stock: state,
      },
      approvalStatus: product.approvalStatus,
      productStatus: product.status,
      visibility: listingVisibility({
        store: l.seller,
        product,
        variant: { status: l.variant.status, deletedAt: l.variant.deletedAt },
        listing: l,
      }),
      updatedAt: later(l.updatedAt, product.updatedAt).toISOString(),
    };
  });

  // A seller's own product shows once: as its listing when listed, otherwise here.
  const listed = new Set(listings.map((l) => `${l.variant.product.id}:${l.seller.id}`));
  const unlistedRows = submitted
    .filter((p) => p.submittedBySeller && !listed.has(`${p.id}:${p.submittedBySeller.id}`))
    .map((p): MarketplaceProductRow => ({
      key: `p-${p.id}`,
      productId: p.id,
      productName: p.name,
      variantName: p.variants[0]?.variantName ?? null,
      imageUrl: imageOf(p),
      category: p.category,
      seller: { id: p.submittedBySeller!.id, name: p.submittedBySeller!.name },
      ownership: 'SELLER',
      listing: null,
      approvalStatus: p.approvalStatus,
      productStatus: p.status,
      visibility: listingVisibility({ store: p.submittedBySeller!, product: p, variant: p.variants[0] ?? null, listing: null }),
      updatedAt: p.updatedAt.toISOString(),
    }));

  const all = [...listingRows, ...unlistedRows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const disabled = (r: MarketplaceProductRow) => r.visibility.reason === 'DISABLED_BY_ADMIN' || r.productStatus === ProductStatus.ARCHIVED;
  const summary: MarketplaceProductSummary = {
    total: all.length,
    buyable: all.filter((r) => r.visibility.sellable).length,
    pendingApproval: all.filter((r) => r.approvalStatus === 'PENDING').length,
    rejected: all.filter((r) => r.approvalStatus === 'REJECTED').length,
    lowStock: all.filter((r) => r.listing?.stock === 'LOW').length,
    outOfStock: all.filter((r) => r.listing?.stock === 'OUT').length,
    disabled: all.filter(disabled).length,
  };

  const filtered = all.filter(
    (r) =>
      (!query.approval || r.approvalStatus === query.approval) &&
      (!query.visibility ||
        (query.visibility === 'BUYABLE' ? r.visibility.sellable : query.visibility === 'DISABLED' ? disabled(r) : !r.visibility.sellable)) &&
      (!query.stock || r.listing?.stock === query.stock),
  );
  return { ...paginate(filtered, query.page, query.pageSize), summary };
}

/* -------------------------------------------------------------------------- */
/* moderation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Disable / enable ANY product (a seller's own or a shared catalogue one).
 * Never edits content. DISABLE sets Product.status = ARCHIVED — not buyable
 * from any seller, and no seller can lift it (seller-listing.service /
 * product-approval.service refuse). ENABLE returns a seller's own product as
 * INACTIVE (the seller decides when to show it) and a catalogue product as
 * ACTIVE (sellers only switch their listing, never the product).
 */
export async function moderateProduct(
  productId: string,
  input: { action: 'DISABLE' | 'ENABLE'; reason?: string | null },
  actorUserId: string,
): Promise<{ productId: string; status: string }> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { id: true, status: true, submittedBySellerId: true },
  });
  if (!product) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  const sellerId = product.submittedBySellerId;

  if (input.action === 'DISABLE') {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Give a reason (at least 3 characters) — sellers see it.' });
    }
    if (product.status !== ProductStatus.ARCHIVED) {
      await prisma.product.update({ where: { id: productId }, data: { status: ProductStatus.ARCHIVED } });
    }
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action: 'product.admin_disable',
        entityType: 'Product',
        entityId: productId,
        before: { status: product.status },
        after: { status: ProductStatus.ARCHIVED, reason, sellerId },
      },
    });
    return { productId, status: ProductStatus.ARCHIVED };
  }

  if (product.status !== ProductStatus.ARCHIVED) return { productId, status: product.status };
  const next = sellerId ? ProductStatus.INACTIVE : ProductStatus.ACTIVE;
  await prisma.product.update({ where: { id: productId }, data: { status: next } });
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'product.admin_enable',
      entityType: 'Product',
      entityId: productId,
      before: { status: product.status },
      after: { status: next, sellerId },
    },
  });
  return { productId, status: next };
}

/* -------------------------------------------------------------------------- */
/* inventory                                                                  */
/* -------------------------------------------------------------------------- */

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
  visibilityReason: ListingVisibilityReason;
  updatedAt: string;
}

export interface MarketplaceInventorySummary {
  /** Every live listing in the marketplace (all sellers). */
  totalListings: number;
  /** Distinct products those listings sell. */
  totalProducts: number;
  sellers: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  offSale: number;
  /** Σ selling price × available units, over all listings. */
  stockValuePaise: number;
}

export async function listMarketplaceInventory(query: {
  q?: string;
  sellerId?: string;
  stock?: 'IN' | 'LOW' | 'OUT' | 'OFF';
  page: number;
  pageSize: number;
}): Promise<Paged<MarketplaceInventoryRow> & { summary: MarketplaceInventorySummary }> {
  const listings = await loadListings(query);
  const rows = listings.map((l: ListingRow): MarketplaceInventoryRow => {
    const product = l.variant.product;
    const { availableQty, state } = stockState(l);
    return {
      listingId: l.id,
      seller: { id: l.seller.id, name: l.seller.name },
      product: { id: product.id, name: product.name, variantName: l.variant.variantName, imageUrl: imageOf(product), category: product.category.name },
      pricePaise: l.pricePaise,
      stockQty: l.stockQty,
      reservedQty: l.reservedQty,
      availableQty,
      lowStockThreshold: l.lowStockThreshold,
      isAvailable: l.isAvailable,
      stock: state,
      visibilityReason: listingVisibility({
        store: l.seller,
        product,
        variant: { status: l.variant.status, deletedAt: l.variant.deletedAt },
        listing: l,
      }).reason,
      updatedAt: l.updatedAt.toISOString(),
    };
  });

  const summary: MarketplaceInventorySummary = {
    totalListings: rows.length,
    totalProducts: new Set(rows.map((r) => r.product.id)).size,
    sellers: new Set(rows.map((r) => r.seller.id)).size,
    inStock: rows.filter((r) => r.stock === 'IN_STOCK').length,
    lowStock: rows.filter((r) => r.stock === 'LOW').length,
    outOfStock: rows.filter((r) => r.stock === 'OUT').length,
    offSale: rows.filter((r) => !r.isAvailable).length,
    stockValuePaise: rows.reduce((sum, r) => sum + r.pricePaise * r.availableQty, 0),
  };

  // Most urgent first: out of stock, then low, then the rest by name.
  const rank = (r: MarketplaceInventoryRow) => (r.stock === 'OUT' ? 0 : r.stock === 'LOW' ? 1 : 2);
  const filtered = rows
    .filter(
      (r) =>
        !query.stock ||
        (query.stock === 'OFF' ? !r.isAvailable : query.stock === 'IN' ? r.stock === 'IN_STOCK' : r.stock === query.stock),
    )
    .sort((a, b) => rank(a) - rank(b) || a.product.name.localeCompare(b.product.name));
  return { ...paginate(filtered, query.page, query.pageSize), summary };
}

/** One listing's stock history for admin — actors as names, never contact details. */
export async function listingStockHistory(listingId: string, limit = 50) {
  const listing = await prisma.sellerListing.findUnique({ where: { id: listingId }, select: { id: true } });
  if (!listing) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Listing not found.' });
  const rows = await prisma.stockLedger.findMany({
    where: { sellerListingId: listingId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      delta: true,
      reason: true,
      balanceAfter: true,
      note: true,
      sellerOrder: { select: { order: { select: { orderNumber: true } } } },
      actor: { select: { fullName: true, role: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.createdAt.toISOString(),
    delta: row.delta,
    reason: row.reason,
    // Available stock before/after (inventory.service writes balanceAfter =
    // stock − reserved; a sale moves stock and reservation together).
    availableBefore: row.reason === 'ORDER_COMMIT' ? row.balanceAfter : row.balanceAfter - row.delta,
    availableAfter: row.balanceAfter,
    note: row.note,
    orderNumber: row.sellerOrder?.order.orderNumber ?? null,
    by: row.actor ? `${row.actor.fullName ?? 'Unnamed'} (${row.actor.role})` : 'System',
  }));
}

/* -------------------------------------------------------------------------- */
/* payments + refunds                                                         */
/* -------------------------------------------------------------------------- */

export async function listPayments(query: { q?: string; status?: string; page: number; pageSize: number }) {
  const where = {
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.q
      ? {
          OR: [
            { order: { orderNumber: { contains: query.q, mode: 'insensitive' as const } } },
            { providerOrderId: { contains: query.q, mode: 'insensitive' as const } },
            { providerPaymentId: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      // Never `rawPayload` — the provider's full response stays server-side.
      select: {
        id: true,
        provider: true,
        providerOrderId: true,
        providerPaymentId: true,
        method: true,
        amountPaise: true,
        currency: true,
        status: true,
        failureReason: true,
        capturedAt: true,
        createdAt: true,
        order: { select: { id: true, orderNumber: true, status: true, paymentMethod: true, deliveryFullName: true, deliveryMobile: true } },
        refunds: { select: { status: true, amountPaise: true } },
      },
    }),
  ]);
  return {
    items: rows.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      method: p.method,
      amountPaise: p.amountPaise,
      currency: p.currency,
      status: p.status,
      failureReason: p.failureReason,
      capturedAt: p.capturedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      order: { id: p.order.id, orderNumber: p.order.orderNumber, status: p.order.status, paymentMethod: p.order.paymentMethod },
      customer: { name: p.order.deliveryFullName, mobile: maskMobile(p.order.deliveryMobile) },
      refund: refundSummary(p.amountPaise, p.refunds),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function listRefunds(query: { q?: string; status?: string; page: number; pageSize: number }) {
  const where = {
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.q ? { order: { orderNumber: { contains: query.q, mode: 'insensitive' as const } } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.refund.count({ where }),
    prisma.refund.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        providerRefundId: true,
        amountPaise: true,
        status: true,
        reason: true,
        failureReason: true,
        completedAt: true,
        createdAt: true,
        payment: { select: { provider: true, providerOrderId: true, providerPaymentId: true } },
        order: { select: { id: true, orderNumber: true, deliveryFullName: true } },
        sellerOrder: { select: { seller: { select: { id: true, name: true } } } },
      },
    }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      providerRefundId: r.providerRefundId,
      amountPaise: r.amountPaise,
      status: r.status,
      reason: r.reason,
      failureReason: r.failureReason,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      provider: r.payment.provider,
      providerOrderId: r.payment.providerOrderId,
      providerPaymentId: r.payment.providerPaymentId,
      order: { id: r.order.id, orderNumber: r.order.orderNumber, customerName: r.order.deliveryFullName },
      seller: r.sellerOrder?.seller ?? null,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/* -------------------------------------------------------------------------- */
/* audit logs                                                                 */
/* -------------------------------------------------------------------------- */

export async function listAuditLogs(query: {
  entityType?: string;
  action?: string;
  q?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}) {
  const where = {
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.q ? { entityId: { contains: query.q } } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
  };
  const [total, rows, entityTypes] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        before: true,
        after: true,
        createdAt: true,
        actor: { select: { fullName: true, role: true } },
      },
    }),
    prisma.auditLog.groupBy({ by: ['entityType'], _count: { _all: true }, orderBy: { entityType: 'asc' } }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor ? { name: row.actor.fullName, role: row.actor.role } : null,
      // Identity numbers, bank details and credentials never leave the server.
      before: redactAuditValue(row.before),
      after: redactAuditValue(row.after),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    entityTypes: entityTypes.map((e) => ({ entityType: e.entityType, count: e._count._all })),
  };
}

/* -------------------------------------------------------------------------- */
/* commission                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Marketplace commission at a glance: each seller's default rate and active
 * rule counts, the earnings the settlement service already computes for it,
 * and the latest rule changes. Rules are still edited per seller.
 */
export async function getCommissionOverview() {
  const [sellers, ruleCounts, earnings, recentRules] = await Promise.all([
    prisma.seller.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, isActive: true, defaultCommissionBp: true },
      orderBy: { name: 'asc' },
    }),
    prisma.commissionRule.findMany({ where: { isActive: true }, select: { sellerId: true, categoryId: true, productId: true } }),
    settlementService.listEarningsSummaries({}),
    prisma.commissionRule.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        rateBp: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        seller: { select: { id: true, name: true } },
        category: { select: { name: true } },
        product: { select: { name: true } },
      },
    }),
  ]);
  const bySeller = new Map(earnings.map((e) => [e.sellerId, e]));
  const rows = sellers.map((s) => {
    const e = bySeller.get(s.id);
    return {
      sellerId: s.id,
      sellerName: s.name,
      isActive: s.isActive,
      defaultCommissionBp: s.defaultCommissionBp,
      categoryRules: ruleCounts.filter((r) => r.sellerId === s.id && r.categoryId !== null).length,
      productRules: ruleCounts.filter((r) => r.sellerId === s.id && r.productId !== null).length,
      grossSalesPaise: e?.grossSalesPaise ?? 0,
      commissionPaise: e?.commissionPaise ?? 0,
      netPayablePaise: e?.netPayablePaise ?? 0,
    };
  });
  return {
    sellers: rows,
    totals: {
      grossSalesPaise: rows.reduce((sum, r) => sum + r.grossSalesPaise, 0),
      commissionPaise: rows.reduce((sum, r) => sum + r.commissionPaise, 0),
      netPayablePaise: rows.reduce((sum, r) => sum + r.netPayablePaise, 0),
    },
    recentRules: recentRules.map((r) => ({
      ruleId: r.id,
      seller: r.seller,
      scope: r.product ? 'PRODUCT' : 'CATEGORY',
      targetName: r.product?.name ?? r.category?.name ?? null,
      rateBp: r.rateBp,
      isActive: r.isActive,
      changedAt: r.updatedAt.toISOString(),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Marketplace catalogue — categories, subcategories, products, sellers      */
/* -------------------------------------------------------------------------- */

export interface CatalogueProductRow {
  productId: string;
  name: string;
  imageUrl: string | null;
  seller: { id: string; name: string; sellerType: string };
  status: string;
  approvalStatus: string;
  /** The seller's own category this product sits in (top or sub). */
  categoryId: string;
  listingCount: number;
  /** Lowest price across the product's listings; null when not listed yet. */
  minPricePaise: number | null;
  /** Sum of available stock across the product's listings. */
  availableQty: number;
  updatedAt: string;
}

export interface CatalogueSubcategoryNode {
  /** Merge key: the subcategory's slug under its top category. */
  key: string;
  name: string;
  sellers: { id: string; name: string; categoryId: string; isActive: boolean }[];
  products: CatalogueProductRow[];
}

export interface CatalogueTopNode {
  /** Merge key: the top category's slug. */
  key: string;
  name: string;
  sellers: { id: string; name: string; categoryId: string; isActive: boolean }[];
  /** Products attached directly to the top category (no subcategory). */
  products: CatalogueProductRow[];
  subcategories: CatalogueSubcategoryNode[];
  productCount: number;
}

export interface MarketplaceCatalogue {
  summary: { topCategories: number; subcategories: number; products: number; sellers: number };
  categories: CatalogueTopNode[];
}

/**
 * Admin → Marketplace Catalogue (read-only). Every seller owns its own
 * categories; rows with the same name (slug) at the same level are merged for
 * display, and every product row names the seller that owns it — two sellers'
 * "Grocery › Rice" show as one branch with both sellers' products.
 *
 * Optional filters: a seller, and a text search over category/product/seller
 * names (a match keeps the whole branch it is in).
 */
export async function getMarketplaceCatalogue(query: { sellerId?: string; q?: string }): Promise<MarketplaceCatalogue> {
  const [categories, products] = await Promise.all([
    prisma.category.findMany({
      where: { deletedAt: null, sellerId: query.sellerId ? query.sellerId : { not: null } },
      select: {
        id: true,
        name: true,
        slug: true,
        path: true,
        parentId: true,
        isActive: true,
        displayOrder: true,
        seller: { select: { id: true, name: true, sellerType: true, deletedAt: true } },
      },
      orderBy: [{ depth: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }],
      take: ROW_CAP,
    }),
    prisma.product.findMany({
      where: { deletedAt: null, ...(query.sellerId ? { submittedBySellerId: query.sellerId } : {}) },
      select: {
        id: true,
        name: true,
        status: true,
        approvalStatus: true,
        categoryId: true,
        updatedAt: true,
        submittedBySeller: { select: { id: true, name: true, sellerType: true } },
        images: { orderBy: { displayOrder: 'asc' }, take: 1, select: { url: true, thumbUrl: true } },
        variants: {
          where: { deletedAt: null },
          select: { sellerListings: { select: { pricePaise: true, stockQty: true, reservedQty: true, isAvailable: true } } },
        },
      },
      orderBy: { name: 'asc' },
      take: ROW_CAP,
    }),
  ]);

  const live = categories.filter((c) => c.seller && !c.seller.deletedAt);
  const byId = new Map(live.map((c) => [c.id, c]));

  const toRow = (p: (typeof products)[number]): CatalogueProductRow | null => {
    const owner = p.submittedBySeller ?? byId.get(p.categoryId)?.seller ?? null;
    if (!owner) return null;
    const listings = p.variants.flatMap((v) => v.sellerListings);
    return {
      productId: p.id,
      name: p.name,
      imageUrl: p.images[0]?.thumbUrl ?? p.images[0]?.url ?? null,
      seller: { id: owner.id, name: owner.name, sellerType: owner.sellerType },
      status: p.status,
      approvalStatus: p.approvalStatus,
      categoryId: p.categoryId,
      listingCount: listings.length,
      minPricePaise: listings.length ? Math.min(...listings.map((l) => l.pricePaise)) : null,
      availableQty: listings.reduce((sum, l) => sum + Math.max(0, l.stockQty - l.reservedQty), 0),
      updatedAt: p.updatedAt.toISOString(),
    };
  };

  const tops = new Map<string, CatalogueTopNode>();
  const subs = new Map<string, CatalogueSubcategoryNode>();
  const topKeyOf = (path: string) => path.split('/')[0]!;

  for (const c of live.filter((x) => x.parentId === null)) {
    const key = topKeyOf(c.path);
    const node = tops.get(key) ?? { key, name: c.name, sellers: [], products: [], subcategories: [], productCount: 0 };
    node.sellers.push({ id: c.seller!.id, name: c.seller!.name, categoryId: c.id, isActive: c.isActive });
    tops.set(key, node);
  }
  for (const c of live.filter((x) => x.parentId !== null)) {
    const parent = byId.get(c.parentId!);
    if (!parent) continue;
    const top = tops.get(topKeyOf(parent.path));
    if (!top) continue;
    const key = `${top.key}/${c.slug}`;
    let node = subs.get(key);
    if (!node) {
      node = { key, name: c.name, sellers: [], products: [] };
      subs.set(key, node);
      top.subcategories.push(node);
    }
    node.sellers.push({ id: c.seller!.id, name: c.seller!.name, categoryId: c.id, isActive: c.isActive });
  }

  const sellerIds = new Set<string>();
  for (const p of products) {
    const category = byId.get(p.categoryId);
    if (!category) continue;
    const row = toRow(p);
    if (!row) continue;
    sellerIds.add(row.seller.id);
    if (category.parentId === null) {
      tops.get(topKeyOf(category.path))?.products.push(row);
    } else {
      const parent = byId.get(category.parentId);
      if (!parent) continue;
      subs.get(`${topKeyOf(parent.path)}/${category.slug}`)?.products.push(row);
    }
  }

  const needle = query.q?.trim().toLowerCase() ?? '';
  const matches = (text: string) => text.toLowerCase().includes(needle);
  const productMatches = (row: CatalogueProductRow) => matches(row.name) || matches(row.seller.name);

  let result = [...tops.values()];
  if (needle) {
    result = result
      .map((top) => {
        if (matches(top.name)) return top;
        const keptSubs = top.subcategories
          .map((sub) => (matches(sub.name) ? sub : { ...sub, products: sub.products.filter(productMatches) }))
          .filter((sub) => matches(sub.name) || sub.products.length > 0);
        const keptProducts = top.products.filter(productMatches);
        return { ...top, subcategories: keptSubs, products: keptProducts };
      })
      .filter((top) => matches(top.name) || top.subcategories.length > 0 || top.products.length > 0);
  }
  for (const top of result) {
    top.productCount = top.products.length + top.subcategories.reduce((sum, sub) => sum + sub.products.length, 0);
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  for (const top of result) top.subcategories.sort((a, b) => a.name.localeCompare(b.name));

  return {
    summary: {
      topCategories: result.length,
      subcategories: result.reduce((sum, top) => sum + top.subcategories.length, 0),
      products: result.reduce((sum, top) => sum + top.productCount, 0),
      sellers: needle || query.sellerId ? new Set(result.flatMap((t) => [...t.products, ...t.subcategories.flatMap((s) => s.products)].map((p) => p.seller.id))).size : sellerIds.size,
    },
    categories: result,
  };
}

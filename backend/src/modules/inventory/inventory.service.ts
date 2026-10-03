/**
 * Inventory (Phase 5).
 *
 * This module owns the only code allowed to move stock. Every movement writes
 * a `stock_ledger` row, so a discrepancy between the shelf and the system is
 * always explainable — the single most common operational failure in real
 * grocery retail (PRD §20 R8).
 *
 * The reservation primitives here are what the order transaction calls; they
 * are deliberately written to take a transaction client so they run INSIDE
 * the caller's transaction and inherit its row locks.
 */

import { Prisma } from '@prisma/client';
import { ErrorCode, StockLedgerReason } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';

const log = moduleLogger('inventory');

export interface LockedOffer {
  id: string;
  variantId: string;
  sellerId: string;
  pricePaise: number;
  mrpPaise: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  isAvailable: boolean;
  maxQtyPerOrder: number;
  allowCod: string;
}

/**
 * Locks one seller's listing rows for a set of variants.
 *
 * THIS IS THE FUNCTION THAT PREVENTS OVERSELLING.
 *
 *   - `FOR UPDATE` holds the rows until the surrounding transaction commits,
 *     so two customers buying the last unit serialise instead of both reading
 *     "1 available".
 *   - `ORDER BY variant_id` makes the lock order deterministic. Without it,
 *     two concurrent orders containing the same two items in opposite order
 *     deadlock — the classic version of this bug.
 *
 * Must be called inside `runInTransaction`; locks taken outside one are
 * released immediately and protect nothing. Called once per seller involved
 * in a checkout (see order.service.ts's per-seller split) — never across
 * sellers in one call, since the lock ordering guarantee only holds within a
 * single seller's own rows.
 */
export async function lockOffersForUpdate(
  tx: Tx,
  sellerId: string,
  variantIds: string[],
): Promise<Map<string, LockedOffer>> {
  if (variantIds.length === 0) return new Map();

  const rows = await tx.$queryRaw<
    {
      id: string;
      variant_id: string;
      seller_id: string;
      price_paise: number;
      mrp_paise: number;
      stock_qty: number;
      reserved_qty: number;
      is_available: boolean;
      max_qty_per_order: number;
      allow_cod: string;
    }[]
  >`
    SELECT id, variant_id, seller_id, price_paise, mrp_paise, stock_qty,
           reserved_qty, is_available, max_qty_per_order, allow_cod
    FROM seller_listings
    WHERE seller_id = ${sellerId}::uuid
      AND variant_id IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY variant_id
    FOR UPDATE`;

  return new Map(
    rows.map((row) => [
      row.variant_id,
      {
        id: row.id,
        variantId: row.variant_id,
        sellerId: row.seller_id,
        pricePaise: row.price_paise,
        mrpPaise: row.mrp_paise,
        stockQty: row.stock_qty,
        reservedQty: row.reserved_qty,
        availableQty: Math.max(0, row.stock_qty - row.reserved_qty),
        isAvailable: row.is_available,
        maxQtyPerOrder: row.max_qty_per_order,
        allowCod: row.allow_cod,
      },
    ]),
  );
}

async function writeLedger(
  tx: Tx,
  input: {
    sellerListingId: string;
    delta: number;
    reason: StockLedgerReason;
    balanceAfter: number;
    sellerOrderId?: string | null;
    actorUserId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await tx.stockLedger.create({
    data: {
      sellerListingId: input.sellerListingId,
      delta: input.delta,
      reason: input.reason,
      balanceAfter: input.balanceAfter,
      sellerOrderId: input.sellerOrderId ?? null,
      actorUserId: input.actorUserId ?? null,
      note: input.note ?? null,
    },
  });
}

/**
 * Holds stock for an order awaiting payment.
 *
 * Increments `reserved_qty` rather than decrementing `stock_qty`: the goods are
 * still on the shelf, they are simply spoken for. The DB CHECK
 * `reserved_qty <= stock_qty` is the last line of defence if this is ever
 * called without a lock.
 */
export async function reserveStock(
  tx: Tx,
  items: { sellerListingId: string; variantId: string; qty: number }[],
  sellerOrderId: string,
): Promise<void> {
  for (const item of items) {
    const updated = await tx.sellerListing.update({
      where: { id: item.sellerListingId },
      data: { reservedQty: { increment: item.qty } },
      select: { stockQty: true, reservedQty: true },
    });

    await writeLedger(tx, {
      sellerListingId: item.sellerListingId,
      delta: -item.qty,
      reason: StockLedgerReason.ORDER_RESERVE,
      balanceAfter: updated.stockQty - updated.reservedQty,
      sellerOrderId,
    });
  }
}

/**
 * Converts a reservation into a sale: the goods have left the shelf.
 * Called when payment is confirmed (online) or at placement (COD).
 */
export async function commitReservation(
  tx: Tx,
  items: { sellerListingId: string; qty: number }[],
  sellerOrderId: string,
): Promise<void> {
  for (const item of items) {
    const updated = await tx.sellerListing.update({
      where: { id: item.sellerListingId },
      data: {
        stockQty: { decrement: item.qty },
        reservedQty: { decrement: item.qty },
      },
      select: { stockQty: true, reservedQty: true },
    });

    await writeLedger(tx, {
      sellerListingId: item.sellerListingId,
      delta: -item.qty,
      reason: StockLedgerReason.ORDER_COMMIT,
      balanceAfter: updated.stockQty - updated.reservedQty,
      sellerOrderId,
    });
  }
}

/** Returns held stock to sale — payment failed, expired, or order cancelled. */
export async function releaseReservation(
  tx: Tx,
  items: { sellerListingId: string; qty: number }[],
  sellerOrderId: string,
  reason: StockLedgerReason = StockLedgerReason.ORDER_RELEASE,
): Promise<void> {
  for (const item of items) {
    const updated = await tx.sellerListing.update({
      where: { id: item.sellerListingId },
      data: { reservedQty: { decrement: item.qty } },
      select: { stockQty: true, reservedQty: true },
    });

    await writeLedger(tx, {
      sellerListingId: item.sellerListingId,
      delta: item.qty,
      reason,
      balanceAfter: updated.stockQty - updated.reservedQty,
      sellerOrderId,
    });
  }
}

/** Puts already-sold goods back — a SellerOrder cancelled after commit. Only
 * ever restocks the ONE seller's items being cancelled, never a sibling
 * SellerOrder under the same parent Order (#8). */
export async function restockCommitted(
  tx: Tx,
  items: { sellerListingId: string; qty: number }[],
  sellerOrderId: string,
): Promise<void> {
  for (const item of items) {
    const updated = await tx.sellerListing.update({
      where: { id: item.sellerListingId },
      data: { stockQty: { increment: item.qty } },
      select: { stockQty: true, reservedQty: true },
    });

    await writeLedger(tx, {
      sellerListingId: item.sellerListingId,
      delta: item.qty,
      reason: StockLedgerReason.ORDER_CANCEL_RESTOCK,
      balanceAfter: updated.stockQty - updated.reservedQty,
      sellerOrderId,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Task 5.1 — admin/seller operations                                         */
/* -------------------------------------------------------------------------- */

export async function setStock(
  sellerListingId: string,
  newStockQty: number,
  actorUserId: string,
  note?: string,
): Promise<void> {
  await runInTransaction(async (tx) => {
    const [current] = await tx.$queryRaw<{ stock_qty: number; reserved_qty: number }[]>`
      SELECT stock_qty, reserved_qty FROM seller_listings
      WHERE id = ${sellerListingId}::uuid FOR UPDATE`;

    if (!current) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Inventory record not found.' });
    }

    // Refusing rather than silently clamping: stock below what is already
    // promised to paying customers is a decision for a human, not a default.
    if (newStockQty < current.reserved_qty) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `${current.reserved_qty} unit(s) are reserved for orders in progress. Stock cannot be set below that.`,
      });
    }

    await tx.sellerListing.update({
      where: { id: sellerListingId },
      data: { stockQty: newStockQty },
    });

    await writeLedger(tx, {
      sellerListingId,
      delta: newStockQty - current.stock_qty,
      reason: StockLedgerReason.MANUAL_ADJUST,
      balanceAfter: newStockQty - current.reserved_qty,
      actorUserId,
      note: note ?? 'manual stock adjustment',
    });
  });

  log.info({ sellerListingId, newStockQty, actorUserId }, 'stock adjusted');
}

/**
 * The next stock after adding `delta`, or the reason it's refused. Pure — the
 * rule `adjustStock` applies under the row lock.
 */
export function nextStockAfterAdjust(
  current: { stockQty: number; reservedQty: number },
  delta: number,
): { ok: true; stockQty: number } | { ok: false; message: string } {
  const next = current.stockQty + delta;
  if (next < 0) return { ok: false, message: 'Stock cannot go below zero.' };
  if (next < current.reservedQty) {
    return {
      ok: false,
      message: `${current.reservedQty} unit(s) are reserved for orders in progress. Stock cannot go below that.`,
    };
  }
  return { ok: true, stockQty: next };
}

/**
 * Relative stock change (the seller's +/- buttons). Computed from the value
 * read under the row lock, so two quick taps add up instead of the second
 * overwriting the first — which an absolute `setStock` from a stale screen
 * would do. Same reserved-quantity floor and ledger entry as `setStock`.
 */
export async function adjustStock(
  sellerListingId: string,
  delta: number,
  actorUserId: string,
  note?: string,
): Promise<{ stockQty: number; reservedQty: number }> {
  const result = await runInTransaction(async (tx) => {
    const [current] = await tx.$queryRaw<{ stock_qty: number; reserved_qty: number }[]>`
      SELECT stock_qty, reserved_qty FROM seller_listings
      WHERE id = ${sellerListingId}::uuid FOR UPDATE`;
    if (!current) {
      throw new AppError(ErrorCode.NOT_FOUND, { message: 'Inventory record not found.' });
    }
    const next = nextStockAfterAdjust({ stockQty: current.stock_qty, reservedQty: current.reserved_qty }, delta);
    if (!next.ok) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: next.message });

    await tx.sellerListing.update({ where: { id: sellerListingId }, data: { stockQty: next.stockQty } });
    await writeLedger(tx, {
      sellerListingId,
      delta,
      reason: StockLedgerReason.MANUAL_ADJUST,
      balanceAfter: next.stockQty - current.reserved_qty,
      actorUserId,
      note: note ?? 'manual stock adjustment',
    });
    return { stockQty: next.stockQty, reservedQty: current.reserved_qty };
  });

  log.info({ sellerListingId, delta, stockQty: result.stockQty, actorUserId }, 'stock adjusted by delta');
  return result;
}

export async function markOutOfStock(
  sellerListingId: string,
  actorUserId: string,
): Promise<void> {
  // Availability flag rather than zeroing stock: the shelf count may be
  // correct while the item is temporarily unsellable (damaged, misplaced), and
  // conflating the two destroys the audit trail.
  await prisma.sellerListing.update({
    where: { id: sellerListingId },
    data: { isAvailable: false },
  });
  log.info({ sellerListingId, actorUserId }, 'marked out of stock');
}

export async function markAvailable(
  sellerListingId: string,
  actorUserId: string,
): Promise<void> {
  await prisma.sellerListing.update({
    where: { id: sellerListingId },
    data: { isAvailable: true },
  });
  log.info({ sellerListingId, actorUserId }, 'marked available');
}

export async function updatePricing(
  sellerListingId: string,
  input: { pricePaise?: number; mrpPaise?: number },
  actorUserId: string,
): Promise<void> {
  const current = await prisma.sellerListing.findUnique({ where: { id: sellerListingId } });
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Inventory record not found.' });

  const mrpPaise = input.mrpPaise ?? current.mrpPaise;
  const pricePaise = input.pricePaise ?? current.pricePaise;

  // Also enforced by a CHECK constraint; caught here so the caller gets a
  // clear message instead of a database error.
  if (pricePaise > mrpPaise) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Selling price cannot be higher than MRP.',
    });
  }

  await prisma.sellerListing.update({
    where: { id: sellerListingId },
    data: { pricePaise, mrpPaise },
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: 'inventory.price.update',
      entityType: 'SellerListing',
      entityId: sellerListingId,
      before: { pricePaise: current.pricePaise, mrpPaise: current.mrpPaise },
      after: { pricePaise, mrpPaise },
    },
  });
}

export async function updateLimits(
  sellerListingId: string,
  input: { maxQtyPerOrder?: number; lowStockThreshold?: number },
  _actorUserId: string,
): Promise<void> {
  await prisma.sellerListing.update({
    where: { id: sellerListingId },
    data: {
      ...(input.maxQtyPerOrder !== undefined ? { maxQtyPerOrder: input.maxQtyPerOrder } : {}),
      ...(input.lowStockThreshold !== undefined
        ? { lowStockThreshold: input.lowStockThreshold }
        : {}),
    },
  });
}

export interface LowStockRow {
  sellerListingId: string;
  sellerName: string;
  productName: string;
  variantName: string;
  availableQty: number;
  lowStockThreshold: number;
}

type LowStockSqlRow = {
  id: string;
  seller_name: string;
  product_name: string;
  variant_name: string;
  available_qty: number;
  low_stock_threshold: number;
};

function toLowStockRow(row: LowStockSqlRow): LowStockRow {
  return {
    sellerListingId: row.id,
    sellerName: row.seller_name,
    productName: row.product_name,
    variantName: row.variant_name,
    availableQty: Number(row.available_qty),
    lowStockThreshold: row.low_stock_threshold,
  };
}

/** Feeds the seller/admin dashboard's low-stock panel. Uses the partial index. */
export async function listLowStock(sellerId: string, limit = 50): Promise<LowStockRow[]> {
  const rows = await prisma.$queryRaw<LowStockSqlRow[]>`
    SELECT sl.id, s.name AS seller_name, p.name AS product_name, v.variant_name,
           (sl.stock_qty - sl.reserved_qty) AS available_qty,
           sl.low_stock_threshold
    FROM seller_listings sl
    JOIN sellers s ON s.id = sl.seller_id
    JOIN product_variants v ON v.id = sl.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE sl.seller_id = ${sellerId}::uuid
      AND (sl.stock_qty - sl.reserved_qty) <= sl.low_stock_threshold
      AND v.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY (sl.stock_qty - sl.reserved_qty) ASC
    LIMIT ${limit}`;

  return rows.map(toLowStockRow);
}

/** Same as `listLowStock`, but across EVERY seller — admin's cross-seller
 * dashboard view (#26), rather than one seller's own panel. */
export async function listLowStockAllSellers(limit = 50): Promise<LowStockRow[]> {
  const rows = await prisma.$queryRaw<LowStockSqlRow[]>`
    SELECT sl.id, s.name AS seller_name, p.name AS product_name, v.variant_name,
           (sl.stock_qty - sl.reserved_qty) AS available_qty,
           sl.low_stock_threshold
    FROM seller_listings sl
    JOIN sellers s ON s.id = sl.seller_id
    JOIN product_variants v ON v.id = sl.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE (sl.stock_qty - sl.reserved_qty) <= sl.low_stock_threshold
      AND v.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY (sl.stock_qty - sl.reserved_qty) ASC
    LIMIT ${limit}`;

  return rows.map(toLowStockRow);
}

/** Stock movement history for one listing — the "why is this number wrong" view. */
export async function getLedger(sellerListingId: string, limit = 100) {
  return prisma.stockLedger.findMany({
    where: { sellerListingId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { fullName: true, mobile: true } } },
  });
}

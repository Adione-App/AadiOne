/**
 * Clears the fabricated stock (100000) that made-to-order food listings were
 * created with before stock-rules.ts. Touches ONLY listings with
 * tracks_stock = false — whose stock was never a real count (edits to it were
 * always refused) — and sets their stock_qty / reserved_qty to 0. A food
 * seller's TRACKED listing (limited portions) is reported and left alone.
 *
 * ORDER MATTERS: run it AFTER the code that never reserves against an
 * untracked listing is deployed. Older code would still reserve against it,
 * and with stock 0 the database's `reserved_qty <= stock_qty` check would
 * refuse those orders.
 */

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../infra/db/prisma';

export interface FoodStockReport {
  /** Untracked listings per seller, with what they hold now. */
  untracked: {
    sellerCode: string;
    sellerName: string;
    sellerType: string;
    listings: number;
    listingsToReset: number;
    totalStockQty: number;
    maxStockQty: number;
    totalReservedQty: number;
  }[];
  /** A food seller's listings that DO track stock (limited portions) — never changed here. */
  trackedFoodListings: { sellerCode: string; sellerName: string; listings: number; totalStockQty: number }[];
  listingsToReset: number;
}

export async function planFoodStockBackfill(client: PrismaClient = prisma): Promise<FoodStockReport> {
  const untracked = await client.$queryRaw<
    { code: string; name: string; seller_type: string; listings: bigint; to_reset: bigint; total_stock: bigint; max_stock: number | null; total_reserved: bigint }[]
  >`
    SELECT s.code, s.name, s.seller_type::text AS seller_type,
           count(*) AS listings,
           count(*) FILTER (WHERE sl.stock_qty <> 0 OR sl.reserved_qty <> 0) AS to_reset,
           COALESCE(sum(sl.stock_qty), 0) AS total_stock,
           max(sl.stock_qty) AS max_stock,
           COALESCE(sum(sl.reserved_qty), 0) AS total_reserved
    FROM seller_listings sl JOIN sellers s ON s.id = sl.seller_id
    WHERE NOT sl.tracks_stock
    GROUP BY s.code, s.name, s.seller_type
    ORDER BY s.code`;
  const tracked = await client.$queryRaw<{ code: string; name: string; listings: bigint; total_stock: bigint }[]>`
    SELECT s.code, s.name, count(*) AS listings, COALESCE(sum(sl.stock_qty), 0) AS total_stock
    FROM seller_listings sl JOIN sellers s ON s.id = sl.seller_id
    WHERE sl.tracks_stock AND s.seller_type IN ('RESTAURANT', 'CAFE')
    GROUP BY s.code, s.name
    ORDER BY s.code`;
  const rows = untracked.map((row) => ({
    sellerCode: row.code,
    sellerName: row.name,
    sellerType: row.seller_type,
    listings: Number(row.listings),
    listingsToReset: Number(row.to_reset),
    totalStockQty: Number(row.total_stock),
    maxStockQty: row.max_stock ?? 0,
    totalReservedQty: Number(row.total_reserved),
  }));
  return {
    untracked: rows,
    trackedFoodListings: tracked.map((row) => ({
      sellerCode: row.code,
      sellerName: row.name,
      listings: Number(row.listings),
      totalStockQty: Number(row.total_stock),
    })),
    listingsToReset: rows.reduce((sum, row) => sum + row.listingsToReset, 0),
  };
}

/** Idempotent: a second run finds nothing to reset. Audited. */
export async function applyFoodStockBackfill(actor: string, client: PrismaClient = prisma): Promise<{ reset: number }> {
  if (!actor.trim()) throw new Error('actor is required');
  return client.$transaction(async (tx) => {
    const reset = await tx.$executeRaw`
      UPDATE seller_listings
      SET stock_qty = 0, reserved_qty = 0, updated_at = now()
      WHERE NOT tracks_stock AND (stock_qty <> 0 OR reserved_qty <> 0)`;
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        action: 'inventory.food_stock_backfill',
        entityType: 'SellerListing',
        entityId: null,
        after: { initiatedBy: actor.trim().slice(0, 120), listingsReset: reset, rule: 'tracks_stock = false -> stock_qty = reserved_qty = 0' },
      },
    });
    return { reset };
  });
}

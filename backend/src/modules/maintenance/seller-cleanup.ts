/**
 * Permanent removal of an EXACT, fixed allowlist of sellers — dry run first,
 * execution only with the confirmation token that dry run printed.
 *
 * WHAT IT DOES PER SELLER (decided by the plan, shown in the dry run):
 *
 *   DELETE   no order or settlement history: the seller and everything it
 *            owns is deleted — its products (variants, images, listings,
 *            approval items), its own category tree (bottom-up), and through
 *            the schema's cascades its hours, closures, profile, bank details,
 *            documents, restaurant profile, staff memberships, master-category
 *            ASSIGNMENTS (never the shared categories themselves), commission
 *            rules, approval batches, imports, notifications, overrides.
 *   RETIRE   it has order or settlement history that must be kept (payments,
 *            refunds, settlements, customers' order records): its catalogue is
 *            deleted exactly as above, the seller row is kept but deactivated
 *            and soft-deleted (invisible everywhere), and its staff
 *            memberships end. Orders, payments, refunds, settlements, payment
 *            events and audit history are left untouched.
 *   BLOCKED  removing it would delete another seller's data (a product of
 *            theirs in this seller's categories, or their listing on this
 *            seller's product) — nothing is done; it needs a manual decision.
 *   NOT_FOUND  no seller has this exact code.
 *
 * Staff accounts (users) are NEVER deleted: a user who has no other seller
 * membership is turned back into a plain CUSTOMER account and its seller-panel
 * sessions are revoked — so the number is not left stuck to a seller that no
 * longer exists.
 *
 * ORDERS (separately gated, second token): an order of these sellers may be
 * deleted only if EVERY seller order in it belongs to an allowlisted seller,
 * it has NO payment row and NO refund, and its seller has NO settlement — i.e.
 * no Cashfree transaction, refund or payout ever referred to it. Anything
 * else is kept. Global order deletion and global audit-log deletion are NOT
 * done by this tool: they are only counted, for a separate, explicitly
 * approved decision.
 *
 * SAFETY: the plan is read inside a READ ONLY transaction; execution re-plans
 * and refuses unless the token matches (so data that changed since the dry
 * run is never acted on); each seller is one transaction; every run writes an
 * audit row (who, when, what) and is verified afterwards. Nothing printed or
 * recorded contains a credential, a bank detail or a customer's contact.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { UserRole, isSellerRole } from '../../shared';
import { prisma } from '../../infra/db/prisma';

type Db = PrismaClient | Prisma.TransactionClient;

/** The owner's list — the ONLY codes this tool will ever touch. */
export const SELLER_CLEANUP_ALLOWLIST: readonly { code: string; name: string; kind: string }[] = [
  { code: 'AADIONECAFE', name: 'Aadione Cafe', kind: 'Restaurant' },
  { code: 'HAHOKAMFOOD', name: 'Ha Hokam Food', kind: 'Restaurant' },
  { code: 'RAMDEVCLOTHING', name: 'Ram Dev Clothing', kind: 'Fashion' },
  { code: 'FASHIONSTORE', name: 'Fashion Store', kind: 'Fashion' },
  { code: 'HOMEANDKICHEN', name: 'Home and Kitchen', kind: 'Home' },
  { code: 'GIFTSTORE', name: 'Gift Store', kind: 'Other' },
  { code: 'SHOESSHOP', name: 'Shoes Shop', kind: 'Fashion' },
  { code: 'SABJIVALA', name: 'Sabji Vala', kind: 'Grocery' },
];

export type SellerCleanupAction = 'DELETE' | 'RETIRE' | 'BLOCKED' | 'NOT_FOUND';

export interface SellerOrderSummary {
  sellerOrders: number;
  parentOrders: number;
  /** Parent orders whose every seller order belongs to an allowlisted seller. */
  parentOrdersOnlyAllowlisted: number;
  /** Parent orders shared with a seller that is NOT on the list — never deleted. */
  parentOrdersMixed: number;
  ordersWithPaymentRows: number;
  capturedPayments: number;
  refunds: number;
  /** Orders the separately-gated order step may delete (see top). */
  deletableOrders: number;
}

export interface SellerCleanupEntry {
  code: string;
  suppliedName: string;
  suppliedKind: string;
  found: boolean;
  sellerId: string | null;
  name: string | null;
  sellerType: string | null;
  lifecycleStatus: string | null;
  isActive: boolean | null;
  softDeleted: boolean | null;
  discrepancies: string[];
  /** Rows per table this seller's removal would delete (catalogue + seller data). */
  counts: Record<string, number>;
  orders: SellerOrderSummary;
  settlements: number;
  /** Staff accounts: kept; those with no other seller membership become customers. */
  staffAccounts: { total: number; toCustomer: number; keptForOtherSellers: number; withCustomerOrders: number };
  /** Files left in storage after the rows go (images, documents) — a separate, manual clean-up. */
  storageFiles: { productImages: number; sellerDocuments: number };
  blockers: string[];
  action: SellerCleanupAction;
}

export interface SellerCleanupPlan {
  generatedAt: string;
  database: string;
  codes: string[];
  entries: SellerCleanupEntry[];
  global: {
    sellers: number;
    nonTargetSellers: number;
    nonTargetProducts: number;
    nonTargetListings: number;
    nonTargetCategories: number;
    orders: number;
    ordersOfNonTargetSellers: number;
    payments: Record<string, number>;
    refunds: number;
    settlements: number;
    paymentEvents: number;
    auditLogs: { total: number; sellerScoped: number; paymentFinancial: number; adminSecurity: number; other: number };
  };
  /** Required by --execute: changes whenever anything this run would touch changes. */
  token: string;
  /** Required in addition for the order step; null when no order is deletable. */
  ordersToken: string | null;
  deletableOrderIds: string[];
}

const SELLER_ROLE_FALLBACK = UserRole.CUSTOMER;

function hashToken(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

function databaseName(): string {
  try {
    return new URL(process.env['DATABASE_URL'] ?? '').pathname.replace(/^\//, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The allowlisted codes to act on: all of them, or an exact subset. */
export function resolveCodes(requested: string[] | null): string[] {
  const allowed = SELLER_CLEANUP_ALLOWLIST.map((entry) => entry.code);
  if (!requested || requested.length === 0) return allowed;
  const unknown = requested.filter((code) => !allowed.includes(code));
  if (unknown.length > 0) throw new Error(`not on the cleanup allowlist (exact, case-sensitive): ${unknown.join(', ')}`);
  return [...new Set(requested)];
}

function kindMatches(kind: string, sellerType: string): boolean {
  const map: Record<string, string[]> = {
    Restaurant: ['RESTAURANT', 'CAFE'],
    Fashion: ['FASHION'],
    Home: ['HOME', 'HOME_KITCHEN'],
    Grocery: ['GROCERY'],
    // "Other" in the owner's list: any non-food type is plausible; only a food type is a discrepancy.
    Other: ['ELECTRONICS', 'BEAUTY', 'HOME', 'HOME_KITCHEN', 'PHARMACY', 'SPORTS', 'BOOKS', 'KIDS', 'AUTOMOTIVE', 'PETS', 'SERVICES', 'OTHER'],
  };
  return (map[kind] ?? []).includes(sellerType);
}

async function ownedProductIds(db: Db, sellerId: string): Promise<string[]> {
  const rows = await db.product.findMany({
    where: { OR: [{ submittedBySellerId: sellerId }, { category: { sellerId } }] },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

interface PlannedEntry {
  entry: SellerCleanupEntry;
  deletableOrderIds: string[];
}

async function planEntry(db: Db, target: (typeof SELLER_CLEANUP_ALLOWLIST)[number], allSellerIds: string[]): Promise<PlannedEntry> {
  const seller = await db.seller.findUnique({
    where: { code: target.code },
    select: { id: true, name: true, sellerType: true, lifecycleStatus: true, isActive: true, deletedAt: true },
  });
  const emptyOrders: SellerOrderSummary = {
    sellerOrders: 0, parentOrders: 0, parentOrdersOnlyAllowlisted: 0, parentOrdersMixed: 0,
    ordersWithPaymentRows: 0, capturedPayments: 0, refunds: 0, deletableOrders: 0,
  };
  if (!seller) {
    return { deletableOrderIds: [], entry: {
      code: target.code, suppliedName: target.name, suppliedKind: target.kind, found: false,
      sellerId: null, name: null, sellerType: null, lifecycleStatus: null, isActive: null, softDeleted: null,
      discrepancies: ['no seller has this exact code'], counts: {}, orders: emptyOrders, settlements: 0,
      staffAccounts: { total: 0, toCustomer: 0, keptForOtherSellers: 0, withCustomerOrders: 0 },
      storageFiles: { productImages: 0, sellerDocuments: 0 }, blockers: [], action: 'NOT_FOUND',
    } };
  }

  const id = seller.id;
  const discrepancies: string[] = [];
  if (seller.name.trim().toLowerCase() !== target.name.trim().toLowerCase()) {
    discrepancies.push(`name is "${seller.name}", supplied "${target.name}"`);
  }
  if (!kindMatches(target.kind, seller.sellerType)) {
    discrepancies.push(`type is ${seller.sellerType}, supplied ${target.kind}`);
  }

  const productIds = await ownedProductIds(db, id);
  const variantIds = (await db.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } })).map((v) => v.id);
  const listingIds = (
    await db.sellerListing.findMany({ where: { OR: [{ sellerId: id }, { variantId: { in: variantIds } }] }, select: { id: true } })
  ).map((l) => l.id);

  const counts: Record<string, number> = {
    products: productIds.length,
    productVariants: variantIds.length,
    productImages: await db.productImage.count({ where: { productId: { in: productIds } } }),
    sellerListings: listingIds.length,
    stockLedger: await db.stockLedger.count({ where: { sellerListingId: { in: listingIds } } }),
    cartItems: await db.cartItem.count({ where: { sellerListingId: { in: listingIds } } }),
    backInStockSubscriptions: await db.backInStockSubscription.count({ where: { OR: [{ sellerId: id }, { sellerListingId: { in: listingIds } }] } }),
    productApprovalBatches: await db.productApprovalBatch.count({ where: { sellerId: id } }),
    productApprovalBatchItems: await db.productApprovalBatchItem.count({ where: { OR: [{ batch: { sellerId: id } }, { productId: { in: productIds } }] } }),
    ownCategories: await db.category.count({ where: { sellerId: id } }),
    masterCategoryAssignments: await db.sellerCategory.count({ where: { sellerId: id } }),
    sellerHours: await db.sellerHours.count({ where: { sellerId: id } }),
    sellerClosures: await db.sellerClosure.count({ where: { sellerId: id } }),
    sellerProfiles: await db.sellerProfile.count({ where: { sellerId: id } }),
    sellerBankDetails: await db.sellerBankDetail.count({ where: { sellerId: id } }),
    sellerDocuments: await db.sellerDocument.count({ where: { sellerId: id } }),
    restaurantProfiles: await db.restaurantProfile.count({ where: { sellerId: id } }),
    sellerStaff: await db.sellerStaff.count({ where: { sellerId: id } }),
    commissionRules: await db.commissionRule.count({ where: { sellerId: id } }),
    productImports: await db.productImport.count({ where: { sellerId: id } }),
    notifications: await db.notification.count({ where: { sellerId: id } }),
    configurationOverrides: await db.configuration.count({ where: { sellerId: id } }),
  };

  // Another seller's data that removing this one would destroy -> refuse.
  const blockers: string[] = [];
  const foreignProducts = await db.product.count({
    where: { category: { sellerId: id }, submittedBySellerId: { not: null, notIn: [id] } },
  });
  if (foreignProducts > 0) blockers.push(`${foreignProducts} product(s) of another seller sit in this seller's categories`);
  const foreignListings = await db.sellerListing.count({ where: { variantId: { in: variantIds }, sellerId: { not: id } } });
  if (foreignListings > 0) blockers.push(`${foreignListings} listing(s) of another seller are on this seller's products`);

  // Orders and money.
  const [orderRow] = await db.$queryRaw<
    { seller_orders: bigint; parent_orders: bigint; only_allowlisted: bigint; with_payments: bigint; captured: bigint; refunds: bigint }[]
  >`
    WITH so AS (SELECT id, order_id FROM seller_orders WHERE seller_id = ${id}::uuid),
         parents AS (SELECT DISTINCT order_id FROM so)
    SELECT
      (SELECT count(*) FROM so) AS seller_orders,
      (SELECT count(*) FROM parents) AS parent_orders,
      (SELECT count(*) FROM parents p WHERE NOT EXISTS (
          SELECT 1 FROM seller_orders x WHERE x.order_id = p.order_id
            AND NOT (x.seller_id = ANY(${allSellerIds}::uuid[])))) AS only_allowlisted,
      (SELECT count(DISTINCT pay.order_id) FROM payments pay WHERE pay.order_id IN (SELECT order_id FROM parents)) AS with_payments,
      (SELECT count(*) FROM payments pay WHERE pay.order_id IN (SELECT order_id FROM parents)
          AND pay.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')) AS captured,
      (SELECT count(*) FROM refunds r WHERE r.order_id IN (SELECT order_id FROM parents)) AS refunds`;
  const settlements = await db.sellerSettlement.count({ where: { sellerId: id } });

  const deletable =
    settlements > 0
      ? []
      : await db.$queryRaw<{ id: string }[]>`
          SELECT o.id FROM orders o
          WHERE o.id IN (SELECT order_id FROM seller_orders WHERE seller_id = ${id}::uuid)
            AND NOT EXISTS (SELECT 1 FROM seller_orders x WHERE x.order_id = o.id
                              AND NOT (x.seller_id = ANY(${allSellerIds}::uuid[])))
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id)
          ORDER BY o.id`;

  const orders: SellerOrderSummary = {
    sellerOrders: Number(orderRow?.seller_orders ?? 0),
    parentOrders: Number(orderRow?.parent_orders ?? 0),
    parentOrdersOnlyAllowlisted: Number(orderRow?.only_allowlisted ?? 0),
    parentOrdersMixed: Number(orderRow?.parent_orders ?? 0) - Number(orderRow?.only_allowlisted ?? 0),
    ordersWithPaymentRows: Number(orderRow?.with_payments ?? 0),
    capturedPayments: Number(orderRow?.captured ?? 0),
    refunds: Number(orderRow?.refunds ?? 0),
    deletableOrders: deletable.length,
  };

  // Staff accounts.
  const staff = await db.sellerStaff.findMany({ where: { sellerId: id }, select: { userId: true } });
  let toCustomer = 0;
  let keptForOtherSellers = 0;
  let withCustomerOrders = 0;
  for (const member of staff) {
    const other = await db.sellerStaff.count({
      where: { userId: member.userId, sellerId: { notIn: allSellerIds }, isActive: true, deletedAt: null },
    });
    if (other > 0) keptForOtherSellers += 1;
    else toCustomer += 1;
    if ((await db.order.count({ where: { userId: member.userId } })) > 0) withCustomerOrders += 1;
  }

  const action: SellerCleanupAction =
    blockers.length > 0 ? 'BLOCKED' : orders.sellerOrders > 0 || settlements > 0 ? 'RETIRE' : 'DELETE';

  const entry: SellerCleanupEntry = {
    code: target.code,
    suppliedName: target.name,
    suppliedKind: target.kind,
    found: true,
    sellerId: id,
    name: seller.name,
    sellerType: seller.sellerType,
    lifecycleStatus: seller.lifecycleStatus,
    isActive: seller.isActive,
    softDeleted: seller.deletedAt !== null,
    discrepancies,
    counts,
    orders,
    settlements,
    staffAccounts: { total: staff.length, toCustomer, keptForOtherSellers, withCustomerOrders },
    storageFiles: { productImages: counts['productImages'] ?? 0, sellerDocuments: counts['sellerDocuments'] ?? 0 },
    blockers,
    action,
  };
  return { entry, deletableOrderIds: deletable.map((row) => row.id) };
}

async function planGlobal(db: Db, targetIds: string[]): Promise<SellerCleanupPlan['global']> {
  const [paymentRows, auditRow, ordersRow] = await Promise.all([
    db.payment.groupBy({ by: ['status'], _count: { _all: true } }),
    db.$queryRaw<{ total: bigint; seller_scoped: bigint; payment: bigint; admin: bigint }[]>`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE entity_type = 'Seller' AND entity_id = ANY(${targetIds}::text[])) AS seller_scoped,
        count(*) FILTER (WHERE action LIKE 'payment.%' OR action LIKE 'refund%' OR action LIKE 'settlement%'
                           OR entity_type IN ('Payment', 'Refund', 'SellerSettlement')) AS payment,
        count(*) FILTER (WHERE action LIKE 'auth.%' OR action LIKE 'admin.%' OR action LIKE 'config%'
                           OR action LIKE 'app_update_policy%' OR entity_type IN ('User', 'Configuration')) AS admin
      FROM audit_logs`,
    db.$queryRaw<{ total: bigint; non_target: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id = o.id
                                              AND NOT (so.seller_id = ANY(${targetIds}::uuid[])))) AS non_target
      FROM orders o`,
  ]);
  const audit = auditRow[0];
  const total = Number(audit?.total ?? 0);
  const sellerScoped = Number(audit?.seller_scoped ?? 0);
  const paymentFinancial = Number(audit?.payment ?? 0);
  const adminSecurity = Number(audit?.admin ?? 0);
  return {
    sellers: await db.seller.count(),
    nonTargetSellers: await db.seller.count({ where: { id: { notIn: targetIds } } }),
    nonTargetProducts: await db.product.count({
      where: { NOT: { OR: [{ submittedBySellerId: { in: targetIds } }, { category: { sellerId: { in: targetIds } } }] } },
    }),
    nonTargetListings: await db.sellerListing.count({ where: { sellerId: { notIn: targetIds } } }),
    nonTargetCategories: await db.category.count({ where: { OR: [{ sellerId: null }, { sellerId: { notIn: targetIds } }] } }),
    orders: Number(ordersRow[0]?.total ?? 0),
    ordersOfNonTargetSellers: Number(ordersRow[0]?.non_target ?? 0),
    payments: Object.fromEntries(paymentRows.map((row) => [row.status, row._count._all])),
    refunds: await db.refund.count(),
    settlements: await db.sellerSettlement.count(),
    paymentEvents: await db.paymentEvent.count(),
    auditLogs: {
      total,
      sellerScoped,
      paymentFinancial,
      adminSecurity,
      other: Math.max(0, total - sellerScoped - paymentFinancial - adminSecurity),
    },
  };
}

/** The dry run. Read-only: runs in a READ ONLY transaction. */
export async function planSellerCleanup(requestedCodes: string[] | null = null, client: PrismaClient = prisma): Promise<SellerCleanupPlan> {
  const codes = resolveCodes(requestedCodes);
  const targets = SELLER_CLEANUP_ALLOWLIST.filter((entry) => codes.includes(entry.code));
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const found = await tx.seller.findMany({ where: { code: { in: codes } }, select: { id: true } });
      const allIds = found.map((row) => row.id);
      const planned: PlannedEntry[] = [];
      for (const target of targets) planned.push(await planEntry(tx, target, allIds));
      const entries = planned.map((item) => item.entry);
      const global = await planGlobal(tx, allIds);
      const deletableOrderIds = [...new Set(planned.flatMap((item) => item.deletableOrderIds))].sort();
      const tokenBasis = entries.map((entry) => ({
        code: entry.code, sellerId: entry.sellerId, action: entry.action, counts: entry.counts,
        orders: entry.orders, settlements: entry.settlements, staff: entry.staffAccounts,
      }));
      return {
        generatedAt: new Date().toISOString(),
        database: databaseName(),
        codes,
        entries,
        global,
        token: hashToken('SC', { database: databaseName(), tokenBasis }),
        ordersToken: deletableOrderIds.length > 0 ? hashToken('SO', { database: databaseName(), deletableOrderIds }) : null,
        deletableOrderIds,
      };
    },
    { timeout: 180_000, maxWait: 30_000 },
  );
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExecuteOptions {
  confirmToken: string;
  /** Second confirmation: also delete the plan's deletable orders. */
  ordersConfirmToken?: string | null;
  /** Who ran it (name / email of the person), recorded in the audit row. */
  actor: string;
  /** A short description of the verified backup taken before the run. */
  backupNote: string;
}

export interface ExecuteResult {
  runId: string;
  results: { code: string; action: SellerCleanupAction; done: boolean; detail: string }[];
  deletedOrders: number;
  verification: { ok: boolean; problems: string[] };
}

async function deleteCatalogue(tx: Prisma.TransactionClient, sellerId: string): Promise<void> {
  const productIds = await ownedProductIds(tx, sellerId);
  // Products first (their variants, images, listings and approval items
  // cascade): a category cannot go while a product still sits in it.
  if (productIds.length > 0) await tx.product.deleteMany({ where: { id: { in: productIds } } });
  // The seller's remaining listings (e.g. on products it did not own).
  await tx.sellerListing.deleteMany({ where: { sellerId } });
  // Its own category tree, deepest level first (parent links are RESTRICT).
  const own = await tx.category.findMany({ where: { sellerId }, select: { depth: true } });
  const depths = [...new Set(own.map((row) => row.depth))].sort((a, b) => b - a);
  for (const depth of depths) await tx.category.deleteMany({ where: { sellerId, depth } });
}

async function releaseStaffAccounts(tx: Prisma.TransactionClient, sellerId: string, allTargetIds: string[], now: Date): Promise<number> {
  const staff = await tx.sellerStaff.findMany({ where: { sellerId }, select: { userId: true } });
  let demoted = 0;
  for (const { userId } of staff) {
    const other = await tx.sellerStaff.count({
      where: { userId, sellerId: { notIn: allTargetIds }, isActive: true, deletedAt: null },
    });
    if (other > 0) continue;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user && isSellerRole(user.role)) {
      await tx.user.update({ where: { id: userId }, data: { role: SELLER_ROLE_FALLBACK } });
      demoted += 1;
    }
    // Seller-panel sessions end; a customer-app session stays valid.
    await tx.refreshToken.updateMany({ where: { userId, scope: 'FULL', revokedAt: null }, data: { revokedAt: now } });
  }
  return demoted;
}

export async function executeSellerCleanup(
  requestedCodes: string[] | null,
  options: ExecuteOptions,
  client: PrismaClient = prisma,
): Promise<ExecuteResult> {
  if (!options.actor.trim()) throw new Error('--actor is required (who is running this)');
  if (!options.backupNote.trim()) throw new Error('a verified backup is required before execution');

  const before = await planSellerCleanup(requestedCodes, client);
  if (options.confirmToken !== before.token) {
    throw new Error(
      `confirmation token does not match the current plan (expected the token from a fresh dry run). Data may have changed since the dry run — run the dry run again and review it.`,
    );
  }
  const deleteOrders = Boolean(options.ordersConfirmToken);
  if (deleteOrders && options.ordersConfirmToken !== before.ordersToken) {
    throw new Error('orders confirmation token does not match the current plan — run the dry run again.');
  }

  const runId = randomUUID();
  const now = new Date();
  const allTargetIds = before.entries.flatMap((entry) => (entry.sellerId ? [entry.sellerId] : []));
  const results: ExecuteResult['results'] = [];
  let deletedOrders = 0;

  for (const entry of before.entries) {
    if (entry.action === 'NOT_FOUND' || entry.action === 'BLOCKED' || !entry.sellerId) {
      results.push({ code: entry.code, action: entry.action, done: false, detail: entry.action === 'BLOCKED' ? entry.blockers.join('; ') : 'not found' });
      continue;
    }
    const sellerId = entry.sellerId;
    const outcome = await client.$transaction(
      async (tx) => {
        // The allowlisted order step: only orders the plan listed, re-checked here.
        let ordersRemoved = 0;
        if (deleteOrders) {
          const mine = await tx.sellerOrder.findMany({ where: { sellerId }, select: { orderId: true } });
          const ids = [...new Set(mine.map((row) => row.orderId))].filter((orderId) => before.deletableOrderIds.includes(orderId));
          if (ids.length > 0) {
            const payments = await tx.payment.count({ where: { orderId: { in: ids } } });
            const refunds = await tx.refund.count({ where: { orderId: { in: ids } } });
            if (payments > 0 || refunds > 0) throw new Error(`orders of ${entry.code} gained a payment or refund since the dry run — stopped`);
            ordersRemoved = (await tx.order.deleteMany({ where: { id: { in: ids } } })).count;
          }
        }

        await deleteCatalogue(tx, sellerId);
        const demoted = await releaseStaffAccounts(tx, sellerId, allTargetIds, now);

        const remainingOrders = await tx.sellerOrder.count({ where: { sellerId } });
        const settlements = await tx.sellerSettlement.count({ where: { sellerId } });
        let action: SellerCleanupAction;
        if (remainingOrders === 0 && settlements === 0) {
          await tx.seller.delete({ where: { id: sellerId } });
          action = 'DELETE';
        } else {
          await tx.sellerStaff.updateMany({ where: { sellerId }, data: { isActive: false, deletedAt: now } });
          await tx.seller.update({ where: { id: sellerId }, data: { isActive: false, deletedAt: now } });
          action = 'RETIRE';
        }

        await tx.auditLog.create({
          data: {
            actorUserId: null,
            action: action === 'DELETE' ? 'seller.cleanup_delete' : 'seller.cleanup_retire',
            entityType: 'Seller',
            entityId: sellerId,
            before: { code: entry.code, name: entry.name, sellerType: entry.sellerType, counts: entry.counts, orders: entry.orders } as never,
            after: {
              runId,
              initiatedBy: options.actor.trim().slice(0, 120),
              backup: options.backupNote.trim().slice(0, 200),
              confirmToken: before.token,
              ordersDeleted: ordersRemoved,
              staffAccountsTurnedCustomer: demoted,
              orderHistoryKept: action === 'RETIRE' ? remainingOrders : 0,
              settlementsKept: settlements,
            } as never,
          },
        });
        return { action, ordersRemoved, demoted, remainingOrders };
      },
      { timeout: 180_000, maxWait: 30_000 },
    );
    deletedOrders += outcome.ordersRemoved;
    results.push({
      code: entry.code,
      action: outcome.action,
      done: true,
      detail:
        outcome.action === 'DELETE'
          ? `deleted (orders removed ${outcome.ordersRemoved}, staff accounts turned customer ${outcome.demoted})`
          : `retired: catalogue removed, seller deactivated; ${outcome.remainingOrders} seller order(s) and their payments kept`,
    });
  }

  // Verification against a fresh read.
  const after = await planSellerCleanup(requestedCodes, client);
  const problems: string[] = [];
  for (const entry of after.entries) {
    const result = results.find((r) => r.code === entry.code);
    if (!result?.done) continue;
    if (result.action === 'DELETE' && entry.found) problems.push(`${entry.code} still exists`);
    if (result.action === 'RETIRE') {
      if (!entry.softDeleted) problems.push(`${entry.code} is not soft-deleted`);
      for (const key of ['products', 'sellerListings', 'ownCategories'] as const) {
        if ((entry.counts[key] ?? 0) > 0) problems.push(`${entry.code} still has ${entry.counts[key]} ${key}`);
      }
    }
  }
  for (const key of ['nonTargetSellers', 'nonTargetProducts', 'nonTargetListings', 'nonTargetCategories'] as const) {
    if (after.global[key] !== before.global[key]) problems.push(`${key} changed: ${before.global[key]} -> ${after.global[key]}`);
  }
  if (after.global.payments && JSON.stringify(after.global.payments) !== JSON.stringify(before.global.payments)) {
    problems.push('payment rows changed — this tool must never delete a payment');
  }
  if (after.global.refunds !== before.global.refunds || after.global.settlements !== before.global.settlements) {
    problems.push('refund or settlement rows changed — this tool must never delete them');
  }

  return { runId, results, deletedOrders, verification: { ok: problems.length === 0, problems } };
}

/** The human-readable report. */
export function formatPlan(plan: SellerCleanupPlan): string {
  const lines: string[] = [];
  lines.push(`SELLER CLEANUP — DRY RUN (nothing has been changed)`);
  lines.push(`database: ${plan.database}   generated: ${plan.generatedAt}`);
  lines.push('');
  for (const entry of plan.entries) {
    lines.push(`■ ${entry.code} — ${entry.action}${entry.found ? `  (${entry.name}, ${entry.sellerType}, ${entry.lifecycleStatus}${entry.softDeleted ? ', already soft-deleted' : ''}${entry.isActive ? '' : ', inactive'})` : ''}`);
    for (const note of entry.discrepancies) lines.push(`    ! discrepancy: ${note}`);
    for (const blocker of entry.blockers) lines.push(`    ✖ blocked: ${blocker}`);
    if (!entry.found) continue;
    const nonZero = Object.entries(entry.counts).filter(([, n]) => n > 0);
    lines.push(`    rows to delete: ${nonZero.length === 0 ? 'none' : nonZero.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    const o = entry.orders;
    lines.push(
      `    orders: ${o.sellerOrders} seller order(s) in ${o.parentOrders} order(s) — ${o.parentOrdersMixed} shared with other sellers, ` +
        `${o.ordersWithPaymentRows} with payment rows (${o.capturedPayments} captured), ${o.refunds} refund(s); ${o.deletableOrders} deletable with the orders token`,
    );
    lines.push(`    settlements: ${entry.settlements}`);
    const s = entry.staffAccounts;
    lines.push(`    staff accounts: ${s.total} — ${s.toCustomer} would become customer accounts, ${s.keptForOtherSellers} kept for another seller, ${s.withCustomerOrders} have customer orders (accounts are never deleted)`);
    lines.push(`    files left in storage afterwards: ${entry.storageFiles.productImages} product image(s), ${entry.storageFiles.sellerDocuments} seller document(s)`);
  }
  const g = plan.global;
  lines.push('');
  lines.push('GLOBAL (counted only — this tool never deletes these globally)');
  lines.push(`  sellers ${g.sellers} (not on the list: ${g.nonTargetSellers}); their products ${g.nonTargetProducts}, listings ${g.nonTargetListings}, categories incl. shared ${g.nonTargetCategories}`);
  lines.push(`  orders ${g.orders} (involving a seller not on the list: ${g.ordersOfNonTargetSellers})`);
  lines.push(`  payments ${JSON.stringify(g.payments)}; refunds ${g.refunds}; settlements ${g.settlements}; payment events ${g.paymentEvents}`);
  lines.push(`  audit logs ${g.auditLogs.total}: seller-scoped (these sellers) ${g.auditLogs.sellerScoped}, payment/financial ${g.auditLogs.paymentFinancial}, admin/security ${g.auditLogs.adminSecurity}, other ${g.auditLogs.other}`);
  lines.push('');
  lines.push(`CONFIRMATION TOKEN: ${plan.token}`);
  lines.push(`ORDERS TOKEN (optional second confirmation): ${plan.ordersToken ?? 'none — no order is deletable'}`);
  return lines.join('\n');
}

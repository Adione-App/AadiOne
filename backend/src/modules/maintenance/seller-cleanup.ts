/**
 * Permanent removal of an EXACT, fixed allowlist of dummy sellers — a dry run
 * first; execution only with the confirmation token that dry run printed.
 *
 * PER-SELLER OUTCOME (decided by the plan, shown in the dry run, re-checked at
 * execution):
 *
 *   PERMANENTLY_DELETED   the seller row and everything it owns is deleted:
 *                         products (variants, images, listings, stock ledger,
 *                         approval items), its own category tree, hours,
 *                         closures, profile, bank details, documents (rows AND
 *                         private PDFs), restaurant profile, staff memberships,
 *                         master-category ASSIGNMENTS (never the shared
 *                         categories), commission rules, approval batches,
 *                         imports, notifications, overrides, back-in-stock
 *                         subscriptions, its exclusively-owned image files and
 *                         its disposable orders.
 *   ARCHIVED_FOR_HISTORY  everything above is deleted EXCEPT what valid history
 *                         still references through a RESTRICT foreign key:
 *                         seller_orders.seller_id (an order kept because money
 *                         moved, a refund, a coupon/referral record, or another
 *                         seller shares it) and seller_settlements.seller_id.
 *                         The seller row stays — deactivated, soft-deleted,
 *                         phone cleared — with those orders, their payments,
 *                         refunds and payment events, its settlements and (only
 *                         when it has settlements) its bank details. It appears
 *                         in no customer, seller or admin operational view. It
 *                         is NEVER reported as deleted.
 *   BLOCKED               removing it would destroy another seller's data (their
 *                         product in its categories, their listing on its
 *                         product, their category/assignment/commission rule on
 *                         its catalogue) — nothing is done for it.
 *   NOT_FOUND             no seller has this exact code.
 *
 * ORDERS: an order is deleted only when every seller in it is being removed by
 * this run, and it has no payment row, no refund, no PAID/REFUNDED payment
 * status, no coupon redemption, no referral reward, no payment audit entry, no
 * Cashfree payment event mentioning it, and none of its sellers has a
 * settlement. Every other order is kept, untouched, with the reason reported.
 *
 * PURGE-FINANCIAL MODE (`--purge-financial`, the owner's explicit choice for
 * dummy data; its own dry run and token): orders with payments, refunds,
 * coupon uses or payment events, those payment / refund / payment-event rows
 * and the sellers' settlements are deleted too (coupon usage counters are
 * reduced to match), so those sellers can be PERMANENTLY_DELETED. Still kept,
 * whatever the mode: an order shared with a seller that is not removed, an
 * order a customer's referral reward points at, a payment the gateway could
 * still complete (opened < 1 hour ago) and a refund still in progress at the
 * gateway — deleting those could lose track of real money. Webhooks for a
 * purged payment are only recorded (payment.service handleWebhook).
 *
 * STAFF ACCOUNTS: a person is never deleted outright. A member of another
 * (kept) seller, or an admin, only loses the membership. Someone who also uses
 * the shopping app becomes a plain CUSTOMER (seller-panel sessions revoked). A
 * seller-only account is ERASED exactly as the in-app account deletion does
 * (auth.service deleteAccount: tombstoned mobile, personal data cleared, row
 * kept anonymised so audit and order references stay valid).
 *
 * AUDIT LOGS: only entries about this seller's own catalogue, storefront and
 * disposable orders are deleted. Payment / refund / settlement / commission /
 * bank, security / authentication, compliance (applications, onboarding,
 * documents, lifecycle decisions) and unrecognised entries are kept, as is
 * every cleanup record. Nothing global is ever deleted.
 *
 * FILES: product, variant, category, restaurant and import images whose URL no
 * remaining row references (order lines, banners, brands, other sellers…), and
 * the seller's private documents, are copied to a backup folder BEFORE the
 * database changes and removed only after the commit.
 *
 * SAFETY: the dry run is a READ ONLY transaction. Execution re-plans inside ONE
 * repeatable-read transaction and refuses unless the token matches; it then
 * verifies, in that same transaction, that no other seller's catalogue, order,
 * payment, refund, settlement or payment event changed, and that the removed
 * sellers have no row left — any problem rolls everything back. Nothing printed
 * or recorded contains a credential, a bank detail or a customer's contact.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { UserRole, UserStatus, isSellerRole, maskMobile } from '../../shared';
import { prisma } from '../../infra/db/prisma';
import { storage, storageKeyFromUrl } from '../../infra/storage';
import { privateDocuments } from '../../infra/storage/private-documents';
import { sha256 } from '../../common/crypto';

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

export type SellerCleanupOutcome = 'PERMANENTLY_DELETED' | 'ARCHIVED_FOR_HISTORY' | 'BLOCKED' | 'NOT_FOUND';

export type StaffDecision = 'MEMBERSHIP_REMOVED' | 'TURNED_CUSTOMER' | 'ACCOUNT_ERASED';

export interface StaffAccountPlan {
  /** Masked — enough for the owner to recognise the number, no more. */
  mobile: string;
  role: string;
  decision: StaffDecision;
  reason: string;
}

export type AuditCategory = 'disposable' | 'financial' | 'security' | 'compliance' | 'cleanup' | 'unclassified';

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
  outcome: SellerCleanupOutcome;
  blockers: string[];
  /** ARCHIVED_FOR_HISTORY: the exact references that keep the seller row. */
  historyReferences: string[];
  /** What is kept, and why (archived sellers). */
  kept: string[];
  /** Rows this run deletes for the seller. */
  counts: Record<string, number>;
  orders: { sellerOrders: number; parentOrders: number; deletableOrders: number; retainedOrders: number; settlements: number };
  /** Kept orders (order number + why). */
  retainedOrders: { orderNumber: string; reasons: string[] }[];
  staff: StaffAccountPlan[];
  auditLogs: { delete: number; keep: Partial<Record<AuditCategory, number>> };
  files: { images: number; documents: number; keptShared: number };
  bannersToUnpublish: number;
}

export interface PlannedFile {
  kind: 'image' | 'document';
  key: string;
  sellerCode: string;
  /** Images: the stored URL (what other rows would reference). */
  url: string | null;
}

/**
 * `preserve` (default): orders with money, refunds or settlements are kept and
 * their seller archived. `purge-financial` (the owner's explicit choice for
 * dummy data): those orders, their payment rows, refunds, payment events and
 * the sellers' settlements are deleted too — except an order shared with a
 * seller that is not removed, an order a customer's referral reward points
 * at, a payment the gateway could still complete (opened < 1 hour ago) and a
 * refund still in progress at the gateway.
 */
export type CleanupMode = 'preserve' | 'purge-financial';

/** Financial rows a purge deletes — listed in full so the owner approves exactly these. */
export interface PurgedFinancialRows {
  payments: { orderNumber: string; status: string; amountPaise: number; createdAt: string }[];
  refunds: { orderNumber: string; status: string; amountPaise: number }[];
  settlements: { sellerCode: string; periodStart: string; periodEnd: string; status: string; netPayablePaise: number }[];
  paymentEvents: number;
  couponRedemptions: number;
}

export interface SellerCleanupPlan {
  generatedAt: string;
  mode: CleanupMode;
  /** Where this ran — host, port and database name only (never credentials). */
  target: { host: string; port: string; database: string; project: string; serverDatabase: string };
  codes: string[];
  /** purge-financial only. */
  financial: PurgedFinancialRows | null;
  entries: SellerCleanupEntry[];
  deletableOrders: { orderNumber: string; sellerCodes: string[] }[];
  files: PlannedFile[];
  banners: { id: string; title: string | null; actionType: string }[];
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
    auditLogs: number;
  };
  /** Required by --execute: changes whenever anything this run would touch changes. */
  token: string;
}

/** Ids the execution acts on (not printed; covered by the token). */
interface PlanInternals {
  removable: { sellerId: string; code: string; outcome: 'PERMANENTLY_DELETED' | 'ARCHIVED_FOR_HISTORY'; settlements: number; entry: SellerCleanupEntry }[];
  targetIds: string[];
  removableIds: string[];
  ownedProductIds: string[];
  ownedListingIds: string[];
  ownedCategoryIds: string[];
  deletableOrderIds: string[];
  auditIdsToDelete: string[];
  staff: { userId: string; decision: StaffDecision; sellerIds: string[] }[];
  bannerIds: string[];
  /** purge-financial only (empty otherwise). */
  purgedPaymentIds: string[];
  purgedRefundIds: string[];
  purgedSettlementIds: string[];
  purgedPaymentEventIds: string[];
  couponDecrements: { couponId: string; count: number }[];
}

const SELLER_ROLE_FALLBACK = UserRole.CUSTOMER;
const TX_OPTIONS = { timeout: 15 * 60_000, maxWait: 60_000 } as const;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function hashToken(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12).toUpperCase()}`;
}

/**
 * Which database DATABASE_URL points at — host, port, database and, behind a
 * shared Supabase pooler (one host for many projects), the project reference
 * from the `postgres.<ref>` user name. Never the password.
 */
export function databaseTarget(): { host: string; port: string; database: string; project: string } {
  try {
    const url = new URL(process.env['DATABASE_URL'] ?? '');
    const user = decodeURIComponent(url.username);
    return {
      host: url.hostname || 'unknown',
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || 'unknown',
      project: /^postgres\.[a-z0-9]+$/i.test(user) ? user.slice('postgres.'.length) : '-',
    };
  } catch {
    return { host: 'unknown', port: 'unknown', database: 'unknown', project: 'unknown' };
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

/* -------------------------------------------------------------------------- */
/* Audit-log classification                                                   */
/* -------------------------------------------------------------------------- */

const FINANCIAL_ENTITIES = new Set(['Payment', 'Refund', 'SellerSettlement', 'CommissionRule', 'SellerBankDetail']);
/** Catalogue, storefront and order-operations activity — disposable for a removed dummy seller. */
const DISPOSABLE_ACTION =
  /^(product\.|product_import\.|approval_batch\.|approval_batch_item\.|seller_listing\.|seller_listings\.|inventory\.|category\.|restaurant\.|order\.|seller_order\.|seller_orders\.|seller\.(update|update_hours|update_location|add_closure|remove_closure|store_open|store_close)$|seller_profile\.update$)/;
const COMPLIANCE_ACTION =
  /^(seller_application\.|seller_onboarding\.|seller_document\.|document\.|seller\.(create|activate|deactivate|lifecycle_activate|owner\.assign|type_change|name_correction)$)/;

/** Which retention class an audit entry belongs to. Only `disposable` is ever deleted. */
export function classifyAuditLog(action: string, entityType: string): AuditCategory {
  if (action.startsWith('seller.cleanup')) return 'cleanup';
  if (FINANCIAL_ENTITIES.has(entityType) || /^(payment|refund|settlement|commission|payout|bank)[._]/.test(action)) return 'financial';
  if (entityType === 'User' || /^(auth|admin|password|seller_login)[._]/.test(action)) return 'security';
  if (entityType === 'SellerDocument' || COMPLIANCE_ACTION.test(action)) return 'compliance';
  if (DISPOSABLE_ACTION.test(action)) return 'disposable';
  return 'unclassified';
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

interface OrderRow {
  id: string;
  order_number: string;
  payment_status: string;
  found_ids: string[];
  removable_ids: string[];
  other_codes: string[];
  payments: bigint;
  captured: bigint;
  refunds: bigint;
  coupons: bigint;
  referrals: bigint;
  settled: bigint;
  events: bigint;
  pay_audits: bigint;
  open_payments: bigint;
  open_refunds: bigint;
}

function orderRetentionReasons(row: OrderRow, mode: CleanupMode): string[] {
  const reasons: string[] = [];
  if (row.other_codes.length > 0) reasons.push(`shared with seller(s) not removed: ${row.other_codes.join(', ')}`);
  if (Number(row.referrals) > 0 && mode === 'purge-financial') reasons.push('referral reward reference (a customer\'s reward history)');
  if (Number(row.open_payments) > 0) reasons.push('a payment the gateway could still complete (opened less than 1 hour ago)');
  if (Number(row.open_refunds) > 0) reasons.push('a refund still in progress at the gateway');
  if (mode === 'purge-financial') return reasons;
  if (Number(row.captured) > 0) reasons.push(`${row.captured} captured payment(s)`);
  else if (Number(row.payments) > 0) reasons.push(`${row.payments} payment transaction row(s)`);
  if (Number(row.refunds) > 0) reasons.push(`${row.refunds} refund(s)`);
  if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(row.payment_status)) reasons.push(`payment status ${row.payment_status}`);
  if (Number(row.coupons) > 0) reasons.push('coupon redemption');
  if (Number(row.referrals) > 0) reasons.push('referral reward reference');
  if (Number(row.settled) > 0) reasons.push('a seller in it has settlements');
  if (Number(row.events) > 0) reasons.push('referenced by a payment gateway event');
  if (Number(row.pay_audits) > 0) reasons.push('payment audit history');
  return reasons;
}

async function idsOf(rows: Promise<{ id: string }[]>): Promise<string[]> {
  return (await rows).map((row) => row.id);
}

/** Every image URL this seller's rows hold. */
async function imageUrlsOf(db: Db, scope: { productIds: string[]; variantIds: string[]; categoryIds: string[]; sellerId: string; importIds: string[] }): Promise<string[]> {
  const rows = await db.$queryRaw<{ url: string }[]>`
    SELECT DISTINCT url FROM (
      SELECT unnest(ARRAY[pi.url, pi.card_url, pi.thumb_url]) AS url FROM product_images pi WHERE pi.product_id = ANY(${scope.productIds}::uuid[])
      UNION ALL SELECT pv.image_url FROM product_variants pv WHERE pv.id = ANY(${scope.variantIds}::uuid[])
      UNION ALL SELECT c.image_url FROM categories c WHERE c.id = ANY(${scope.categoryIds}::uuid[])
      UNION ALL SELECT unnest(ARRAY[rp.logo_url, rp.cover_image_url, rp.menu_image_url]) FROM restaurant_profiles rp WHERE rp.seller_id = ${scope.sellerId}::uuid
      UNION ALL SELECT unnest(ARRAY[pii.url, pii.thumb_url]) FROM product_import_images pii WHERE pii.import_id = ANY(${scope.importIds}::uuid[])
    ) t WHERE url IS NOT NULL AND url <> ''`;
  return rows.map((row) => row.url);
}

/** URLs (of `urls`) that a row OUTSIDE the removed set still references — kept. */
async function urlsStillReferenced(
  db: Db,
  urls: string[],
  removed: { productIds: string[]; variantIds: string[]; categoryIds: string[]; sellerIds: string[]; importIds: string[]; orderIds: string[] },
): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const rows = await db.$queryRaw<{ u: string }[]>`
    SELECT u FROM unnest(${urls}::text[]) AS u
    WHERE EXISTS (SELECT 1 FROM product_images pi WHERE NOT (pi.product_id = ANY(${removed.productIds}::uuid[])) AND u IN (pi.url, pi.card_url, pi.thumb_url))
       OR EXISTS (SELECT 1 FROM product_variants pv WHERE NOT (pv.id = ANY(${removed.variantIds}::uuid[])) AND pv.image_url = u)
       OR EXISTS (SELECT 1 FROM categories c WHERE NOT (c.id = ANY(${removed.categoryIds}::uuid[])) AND c.image_url = u)
       OR EXISTS (SELECT 1 FROM restaurant_profiles rp WHERE NOT (rp.seller_id = ANY(${removed.sellerIds}::uuid[])) AND u IN (rp.logo_url, rp.cover_image_url, rp.menu_image_url))
       OR EXISTS (SELECT 1 FROM product_import_images pii WHERE NOT (pii.import_id = ANY(${removed.importIds}::uuid[])) AND u IN (pii.url, pii.thumb_url))
       OR EXISTS (SELECT 1 FROM order_items oi JOIN seller_orders so ON so.id = oi.seller_order_id WHERE NOT (so.order_id = ANY(${removed.orderIds}::uuid[])) AND oi.image_url = u)
       OR EXISTS (SELECT 1 FROM banners b WHERE b.image_url = u OR strpos(b.layout::text, u) > 0)
       OR EXISTS (SELECT 1 FROM brands br WHERE br.logo_url = u)
       OR EXISTS (SELECT 1 FROM configurations cf WHERE strpos(cf.value::text, u) > 0)`;
  return new Set(rows.map((row) => row.u));
}

interface SellerScope {
  productIds: string[];
  variantIds: string[];
  imageIds: string[];
  listingIds: string[];
  categoryIds: string[];
  importIds: string[];
  batchIds: string[];
  batchItemIds: string[];
  otherEntityIds: string[];
}

async function sellerScope(db: Db, sellerId: string): Promise<SellerScope> {
  const productIds = await idsOf(
    db.product.findMany({ where: { OR: [{ submittedBySellerId: sellerId }, { category: { sellerId } }] }, select: { id: true } }),
  );
  const variantIds = await idsOf(db.productVariant.findMany({ where: { productId: { in: productIds } }, select: { id: true } }));
  const batchIds = await idsOf(db.productApprovalBatch.findMany({ where: { sellerId }, select: { id: true } }));
  return {
    productIds,
    variantIds,
    imageIds: await idsOf(db.productImage.findMany({ where: { productId: { in: productIds } }, select: { id: true } })),
    listingIds: await idsOf(db.sellerListing.findMany({ where: { sellerId }, select: { id: true } })),
    categoryIds: await idsOf(db.category.findMany({ where: { sellerId }, select: { id: true } })),
    importIds: await idsOf(db.productImport.findMany({ where: { sellerId }, select: { id: true } })),
    batchIds,
    batchItemIds: await idsOf(
      db.productApprovalBatchItem.findMany({ where: { OR: [{ batchId: { in: batchIds } }, { productId: { in: productIds } }] }, select: { id: true } }),
    ),
    otherEntityIds: [
      ...(await idsOf(db.sellerClosure.findMany({ where: { sellerId }, select: { id: true } }))),
      ...(await idsOf(db.sellerDocument.findMany({ where: { sellerId }, select: { id: true } }))),
      ...(await idsOf(db.commissionRule.findMany({ where: { sellerId }, select: { id: true } }))),
      ...(await idsOf(db.sellerProfile.findMany({ where: { sellerId }, select: { id: true } }))),
      ...(await idsOf(db.sellerBankDetail.findMany({ where: { sellerId }, select: { id: true } }))),
      ...(await idsOf(db.restaurantProfile.findMany({ where: { sellerId }, select: { id: true } }))),
    ],
  };
}

async function blockersOf(db: Db, sellerId: string, isPlatformOwned: boolean, scope: SellerScope): Promise<string[]> {
  const blockers: string[] = [];
  if (isPlatformOwned) blockers.push('platform-owned seller');
  const checks: [number, string][] = [
    [
      await db.product.count({ where: { category: { sellerId }, submittedBySellerId: { not: null, notIn: [sellerId] } } }),
      "product(s) of another seller sit in this seller's categories (products.category_id, ON DELETE RESTRICT)",
    ],
    [
      await db.sellerListing.count({ where: { variantId: { in: scope.variantIds }, sellerId: { not: sellerId } } }),
      "listing(s) of another seller are on this seller's products",
    ],
    [
      await db.category.count({ where: { parentId: { in: scope.categoryIds }, OR: [{ sellerId: null }, { sellerId: { not: sellerId } }] } }),
      "category(ies) of another owner sit under this seller's categories (categories.parent_id, ON DELETE RESTRICT)",
    ],
    [
      await db.sellerCategory.count({ where: { categoryId: { in: scope.categoryIds }, sellerId: { not: sellerId } } }),
      "another seller is assigned to one of this seller's categories (seller_categories.category_id, ON DELETE RESTRICT)",
    ],
    [
      await db.productApprovalBatchItem.count({ where: { productId: { in: scope.productIds }, batch: { sellerId: { not: sellerId } } } }),
      "another seller's approval batch contains this seller's product(s)",
    ],
    [
      await db.commissionRule.count({
        where: { sellerId: { not: sellerId }, OR: [{ categoryId: { in: scope.categoryIds } }, { productId: { in: scope.productIds } }] },
      }),
      "another seller's commission rule points at this seller's catalogue",
    ],
  ];
  for (const [count, text] of checks) if (count > 0) blockers.push(`${count} ${text}`);
  return blockers;
}

/** A user's footprint in the shopping app: any of it makes them a customer, never erased. */
async function customerFootprint(db: Db, userId: string): Promise<string[]> {
  const found: string[] = [];
  const [orders, addresses, customerSessions, devices, cartItems, coupons, referrals] = await Promise.all([
    db.order.count({ where: { userId } }),
    db.address.count({ where: { userId } }),
    db.refreshToken.count({ where: { userId, scope: 'CUSTOMER' } }),
    db.deviceToken.count({ where: { userId } }),
    db.cartItem.count({ where: { cart: { userId } } }),
    db.couponRedemption.count({ where: { userId } }),
    db.referral.count({ where: { OR: [{ referrerUserId: userId }, { referredUserId: userId }] } }),
  ]);
  if (orders > 0) found.push(`${orders} order(s)`);
  if (addresses > 0) found.push('saved address(es)');
  if (customerSessions > 0) found.push('shopping-app sign-in');
  if (devices > 0) found.push('app device token');
  if (cartItems > 0) found.push('cart');
  if (coupons > 0) found.push('coupon use');
  if (referrals > 0) found.push('referral');
  return found;
}

async function buildPlan(
  db: Db,
  requestedCodes: string[] | null,
  mode: CleanupMode,
): Promise<{ plan: SellerCleanupPlan; internals: PlanInternals }> {
  const codes = resolveCodes(requestedCodes);
  const targets = SELLER_CLEANUP_ALLOWLIST.filter((entry) => codes.includes(entry.code));
  const sellers = await db.seller.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true, sellerType: true, lifecycleStatus: true, isActive: true, deletedAt: true, isPlatformOwned: true },
  });
  const byCode = new Map(sellers.map((seller) => [seller.code, seller]));
  const targetIds = sellers.map((seller) => seller.id);

  // Pass 1: catalogue scope and blockers (independent of orders).
  const scopes = new Map<string, SellerScope>();
  const blockersById = new Map<string, string[]>();
  for (const seller of sellers) {
    const scope = await sellerScope(db, seller.id);
    scopes.set(seller.id, scope);
    blockersById.set(seller.id, await blockersOf(db, seller.id, seller.isPlatformOwned, scope));
  }
  const removableIds = sellers.filter((seller) => (blockersById.get(seller.id) ?? []).length === 0).map((seller) => seller.id);

  // Orders of every target, with why each must be kept.
  const orderRows = await db.$queryRaw<OrderRow[]>`
    WITH parents AS (SELECT DISTINCT order_id FROM seller_orders WHERE seller_id = ANY(${targetIds}::uuid[]))
    SELECT o.id::text AS id, o.order_number, o.payment_status::text AS payment_status,
      ARRAY(SELECT DISTINCT x.seller_id::text FROM seller_orders x WHERE x.order_id = o.id AND x.seller_id = ANY(${targetIds}::uuid[])) AS found_ids,
      ARRAY(SELECT DISTINCT x.seller_id::text FROM seller_orders x WHERE x.order_id = o.id AND x.seller_id = ANY(${removableIds}::uuid[])) AS removable_ids,
      ARRAY(SELECT DISTINCT s.code FROM seller_orders x JOIN sellers s ON s.id = x.seller_id
             WHERE x.order_id = o.id AND NOT (x.seller_id = ANY(${removableIds}::uuid[]))) AS other_codes,
      (SELECT count(*) FROM payments p WHERE p.order_id = o.id) AS payments,
      (SELECT count(*) FROM payments p WHERE p.order_id = o.id AND p.status IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')) AS captured,
      (SELECT count(*) FROM refunds r WHERE r.order_id = o.id) AS refunds,
      (SELECT count(*) FROM coupon_redemptions c WHERE c.order_id = o.id) AS coupons,
      (SELECT count(*) FROM referrals rf WHERE rf.first_eligible_order_id = o.id) AS referrals,
      (SELECT count(*) FROM seller_orders x JOIN seller_settlements st ON st.seller_id = x.seller_id WHERE x.order_id = o.id) AS settled,
      (SELECT count(*) FROM payment_events pe WHERE strpos(pe.payload::text, o.id::text) > 0 OR strpos(pe.payload::text, o.order_number) > 0) AS events,
      (SELECT count(*) FROM audit_logs a WHERE a.entity_id = o.id::text AND (a.action LIKE 'payment.%' OR a.action LIKE 'refund%')) AS pay_audits,
      (SELECT count(*) FROM payments p WHERE p.order_id = o.id AND p.status IN ('CREATED', 'PENDING', 'AUTHORIZED')
          AND p.created_at > now() - interval '1 hour') AS open_payments,
      (SELECT count(*) FROM refunds r WHERE r.order_id = o.id AND r.status IN ('PENDING', 'PROCESSING')) AS open_refunds
    FROM orders o WHERE o.id IN (SELECT order_id FROM parents)
    ORDER BY o.order_number`;
  const deletableOrderIds = new Set(orderRows.filter((row) => orderRetentionReasons(row, mode).length === 0).map((row) => row.id));
  const purgedSettlements: { id: string; sellerCode: string; periodStart: Date; periodEnd: Date; status: string; netPayablePaise: number }[] = [];

  // Staff accounts: one decision per person across all targets.
  const removableSet = new Set(removableIds);
  const staffRows = await db.sellerStaff.findMany({
    where: { sellerId: { in: removableIds } },
    select: { userId: true, sellerId: true, user: { select: { mobile: true, role: true, deletedAt: true } } },
  });
  const staffByUser = new Map<string, { mobile: string; role: UserRole; deletedAt: Date | null; sellerIds: string[] }>();
  for (const row of staffRows) {
    const current = staffByUser.get(row.userId) ?? { mobile: row.user.mobile, role: row.user.role, deletedAt: row.user.deletedAt, sellerIds: [] };
    current.sellerIds.push(row.sellerId);
    staffByUser.set(row.userId, current);
  }
  const staffPlans = new Map<string, { plan: StaffAccountPlan; sellerIds: string[] }>();
  for (const [userId, user] of staffByUser) {
    const elsewhere = await db.sellerStaff.count({
      where: { userId, isActive: true, deletedAt: null, sellerId: { notIn: [...removableSet] }, seller: { deletedAt: null } },
    });
    let decision: StaffDecision;
    let reason: string;
    if (!isSellerRole(user.role)) {
      decision = 'MEMBERSHIP_REMOVED';
      reason = `${user.role} account — only the membership goes`;
    } else if (user.deletedAt) {
      decision = 'MEMBERSHIP_REMOVED';
      reason = 'account already deleted';
    } else if (elsewhere > 0) {
      decision = 'MEMBERSHIP_REMOVED';
      reason = 'also a member of another seller that is kept';
    } else {
      const footprint = await customerFootprint(db, userId);
      // The number may already have its own, separate customer account
      // (auth/account-type.ts): one customer account per number, so this one
      // cannot become another — it keeps its history, with no membership.
      const separateCustomer = await db.user.count({ where: { mobile: user.mobile, role: UserRole.CUSTOMER, id: { not: userId } } });
      if (footprint.length > 0 && separateCustomer > 0) {
        decision = 'MEMBERSHIP_REMOVED';
        reason = `also a shopper (${footprint.join(', ')}), and the number has its own customer account — this account keeps its history, with no seller membership`;
      } else if (footprint.length > 0) {
        decision = 'TURNED_CUSTOMER';
        reason = `also a shopper (${footprint.join(', ')}) — kept as a CUSTOMER account`;
      } else {
        decision = 'ACCOUNT_ERASED';
        reason = 'seller-only account — erased like an in-app account deletion (row kept anonymised)';
      }
    }
    staffPlans.set(userId, {
      plan: { mobile: maskMobile(user.mobile) ?? '••••', role: user.role, decision, reason },
      sellerIds: user.sellerIds,
    });
  }

  // Banners pointing at what goes.
  const allProductIds = removableIds.flatMap((id) => scopes.get(id)?.productIds ?? []);
  const allCategoryIds = removableIds.flatMap((id) => scopes.get(id)?.categoryIds ?? []);
  const banners = await db.$queryRaw<{ id: string; title: string | null; action_type: string; action_value: string | null }[]>`
    SELECT id::text AS id, title, action_type::text AS action_type, action_value FROM banners
    WHERE is_active AND (
      (action_type IN ('STORE', 'RESTAURANT') AND action_value = ANY(${removableIds}::text[]))
      OR (action_type = 'PRODUCT' AND action_value = ANY(${allProductIds}::text[]))
      OR (action_type = 'CATEGORY' AND action_value = ANY(${allCategoryIds}::text[])))
    ORDER BY id`;

  // Per seller.
  const entries: SellerCleanupEntry[] = [];
  const removable: PlanInternals['removable'] = [];
  const auditIdsToDelete = new Set<string>();
  const files: PlannedFile[] = [];
  const allScopes = {
    productIds: allProductIds,
    variantIds: removableIds.flatMap((id) => scopes.get(id)?.variantIds ?? []),
    categoryIds: allCategoryIds,
    sellerIds: removableIds,
    importIds: removableIds.flatMap((id) => scopes.get(id)?.importIds ?? []),
    orderIds: [...deletableOrderIds],
  };

  for (const target of targets) {
    const seller = byCode.get(target.code);
    if (!seller) {
      entries.push({
        code: target.code, suppliedName: target.name, suppliedKind: target.kind, found: false,
        sellerId: null, name: null, sellerType: null, lifecycleStatus: null, isActive: null, softDeleted: null,
        discrepancies: ['no seller has this exact code'], outcome: 'NOT_FOUND', blockers: [], historyReferences: [], kept: [],
        counts: {}, orders: { sellerOrders: 0, parentOrders: 0, deletableOrders: 0, retainedOrders: 0, settlements: 0 },
        retainedOrders: [], staff: [], auditLogs: { delete: 0, keep: {} }, files: { images: 0, documents: 0, keptShared: 0 }, bannersToUnpublish: 0,
      });
      continue;
    }
    const id = seller.id;
    const scope = scopes.get(id)!;
    const blockers = blockersById.get(id) ?? [];
    const discrepancies: string[] = [];
    if (seller.name.trim().toLowerCase() !== target.name.trim().toLowerCase()) {
      discrepancies.push(`stored name is "${seller.name}", supplied "${target.name}" — matched by exact code; the name is never changed`);
    }
    if (!kindMatches(target.kind, seller.sellerType)) discrepancies.push(`type is ${seller.sellerType}, supplied ${target.kind}`);

    const mine = orderRows.filter((row) => row.found_ids.includes(id));
    const deletableMine = mine.filter((row) => deletableOrderIds.has(row.id));
    const retainedMine = mine.filter((row) => !deletableOrderIds.has(row.id));
    const sellerOrders = await db.sellerOrder.count({ where: { sellerId: id } });
    const settlementRows = await db.sellerSettlement.findMany({
      where: { sellerId: id },
      select: { id: true, periodStart: true, periodEnd: true, status: true, netPayablePaise: true },
      orderBy: { periodStart: 'asc' },
    });
    const settlements = settlementRows.length;
    // Purge: settlements go with the seller — unless an order it must keep stays (then so do they).
    const settlementsKept = mode === 'preserve' || retainedMine.length > 0 ? settlements : 0;

    const outcome: SellerCleanupOutcome =
      blockers.length > 0 ? 'BLOCKED' : retainedMine.length > 0 || settlementsKept > 0 ? 'ARCHIVED_FOR_HISTORY' : 'PERMANENTLY_DELETED';
    if (outcome === 'PERMANENTLY_DELETED' && settlements > 0) {
      for (const row of settlementRows) {
        purgedSettlements.push({ id: row.id, sellerCode: seller.code, periodStart: row.periodStart, periodEnd: row.periodEnd, status: row.status, netPayablePaise: row.netPayablePaise });
      }
    }

    const historyReferences: string[] = [];
    const kept: string[] = [];
    if (outcome === 'ARCHIVED_FOR_HISTORY') {
      const keptSellerOrders = await db.sellerOrder.count({ where: { sellerId: id, orderId: { notIn: [...deletableOrderIds] } } });
      if (retainedMine.length > 0) {
        historyReferences.push(
          `seller_orders.seller_id → sellers.id (ON DELETE RESTRICT): ${keptSellerOrders} seller order(s) in ${retainedMine.length} kept order(s)`,
        );
      }
      if (settlementsKept > 0) historyReferences.push(`seller_settlements.seller_id → sellers.id (ON DELETE RESTRICT): ${settlementsKept} settlement(s)`);
      kept.push('seller row (name, code, type, address) — deactivated, soft-deleted, phone cleared, hidden from every operational view');
      if (retainedMine.length > 0) kept.push(`${retainedMine.length} order(s) with their order lines, payments, refunds and payment events`);
      if (settlementsKept > 0) kept.push(`${settlementsKept} settlement(s) and the bank details they were paid to`);
    }

    const counts: Record<string, number> =
      outcome === 'BLOCKED'
        ? {}
        : {
            products: scope.productIds.length,
            productVariants: scope.variantIds.length,
            productImages: scope.imageIds.length,
            sellerListings: scope.listingIds.length,
            stockLedger: await db.stockLedger.count({ where: { sellerListingId: { in: scope.listingIds } } }),
            cartItems: await db.cartItem.count({ where: { sellerListingId: { in: scope.listingIds } } }),
            backInStockSubscriptions: await db.backInStockSubscription.count({ where: { OR: [{ sellerId: id }, { sellerListingId: { in: scope.listingIds } }] } }),
            productApprovalBatches: scope.batchIds.length,
            productApprovalBatchItems: scope.batchItemIds.length,
            ownCategories: scope.categoryIds.length,
            masterCategoryAssignments: await db.sellerCategory.count({ where: { sellerId: id } }),
            sellerHours: await db.sellerHours.count({ where: { sellerId: id } }),
            sellerClosures: await db.sellerClosure.count({ where: { sellerId: id } }),
            sellerProfiles: await db.sellerProfile.count({ where: { sellerId: id } }),
            sellerBankDetails: outcome === 'ARCHIVED_FOR_HISTORY' && settlementsKept > 0 ? 0 : await db.sellerBankDetail.count({ where: { sellerId: id } }),
            settlements: outcome === 'PERMANENTLY_DELETED' ? settlements : 0,
            payments: mode === 'purge-financial' ? await db.payment.count({ where: { orderId: { in: deletableMine.map((row) => row.id) } } }) : 0,
            refunds: mode === 'purge-financial' ? await db.refund.count({ where: { orderId: { in: deletableMine.map((row) => row.id) } } }) : 0,
            sellerDocuments: await db.sellerDocument.count({ where: { sellerId: id } }),
            restaurantProfiles: await db.restaurantProfile.count({ where: { sellerId: id } }),
            sellerStaffMemberships: await db.sellerStaff.count({ where: { sellerId: id } }),
            commissionRules: await db.commissionRule.count({ where: { sellerId: id } }),
            productImports: scope.importIds.length,
            sellerNotifications: await db.notification.count({ where: { sellerId: id } }),
            configurationOverrides: await db.configuration.count({ where: { sellerId: id } }),
            orders: deletableMine.length,
            sellerOrders: await db.sellerOrder.count({ where: { sellerId: id, orderId: { in: [...deletableOrderIds] } } }),
            orderNotifications: await db.notification.count({ where: { orderId: { in: deletableMine.map((row) => row.id) } } }),
            sellerRow: outcome === 'PERMANENTLY_DELETED' ? 1 : 0,
          };

    // Audit entries about this seller's own things (and its deletable orders).
    const auditKeep: Partial<Record<AuditCategory, number>> = {};
    let auditDelete = 0;
    if (outcome !== 'BLOCKED') {
      const deletableSellerOrderIds = await idsOf(
        db.sellerOrder.findMany({ where: { orderId: { in: deletableMine.map((row) => row.id) } }, select: { id: true } }),
      );
      const purgedMoneyIds =
        mode === 'purge-financial'
          ? [
              ...(await idsOf(db.payment.findMany({ where: { orderId: { in: deletableMine.map((row) => row.id) } }, select: { id: true } }))),
              ...(await idsOf(db.refund.findMany({ where: { orderId: { in: deletableMine.map((row) => row.id) } }, select: { id: true } }))),
              ...(outcome === 'PERMANENTLY_DELETED' ? settlementRows.map((row) => row.id) : []),
            ]
          : [];
      const entityIds = [
        ...scope.productIds, ...scope.variantIds, ...scope.imageIds, ...scope.listingIds, ...scope.categoryIds,
        ...scope.importIds, ...scope.batchIds, ...scope.batchItemIds, ...scope.otherEntityIds,
        ...deletableMine.map((row) => row.id), ...deletableSellerOrderIds, ...purgedMoneyIds,
      ];
      const audits = await db.$queryRaw<{ id: string; action: string; entity_type: string }[]>`
        SELECT id::text AS id, action, entity_type FROM audit_logs
        WHERE (entity_type = 'Seller' AND entity_id = ${id}) OR entity_id = ANY(${entityIds}::text[])`;
      // Purge deletes everything about these sellers except security events and cleanup records.
      const deletable: AuditCategory[] =
        mode === 'purge-financial' && outcome === 'PERMANENTLY_DELETED' ? ['disposable', 'financial', 'compliance', 'unclassified'] : ['disposable'];
      for (const audit of audits) {
        const category = classifyAuditLog(audit.action, audit.entity_type);
        if (deletable.includes(category)) {
          if (!auditIdsToDelete.has(audit.id)) auditDelete += 1;
          auditIdsToDelete.add(audit.id);
        } else {
          auditKeep[category] = (auditKeep[category] ?? 0) + 1;
        }
      }
    }

    // Files this seller exclusively owns.
    let imageCount = 0;
    let documentCount = 0;
    let keptShared = 0;
    if (outcome !== 'BLOCKED') {
      const urls = await imageUrlsOf(db, { ...scope, sellerId: id });
      const shared = await urlsStillReferenced(db, urls, allScopes);
      for (const url of urls) {
        const key = storageKeyFromUrl(url);
        if (!key || shared.has(url)) {
          keptShared += 1;
          continue;
        }
        if (!files.some((file) => file.kind === 'image' && file.key === key)) {
          files.push({ kind: 'image', key, sellerCode: seller.code, url });
          imageCount += 1;
        }
      }
      const documents = await db.sellerDocument.findMany({ where: { sellerId: id, fileKey: { not: null } }, select: { fileKey: true } });
      for (const document of documents) {
        files.push({ kind: 'document', key: document.fileKey!, sellerCode: seller.code, url: null });
        documentCount += 1;
      }
    }

    const staff = [...staffPlans.values()].filter((item) => item.sellerIds.includes(id)).map((item) => item.plan);
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
      outcome,
      blockers,
      historyReferences,
      kept,
      counts,
      orders: { sellerOrders, parentOrders: mine.length, deletableOrders: deletableMine.length, retainedOrders: retainedMine.length, settlements },
      retainedOrders: retainedMine.map((row) => ({ orderNumber: row.order_number, reasons: orderRetentionReasons(row, mode) })),
      staff: outcome === 'BLOCKED' ? [] : staff,
      auditLogs: { delete: auditDelete, keep: auditKeep },
      files: { images: imageCount, documents: documentCount, keptShared },
      bannersToUnpublish:
        outcome === 'BLOCKED'
          ? 0
          : banners.filter(
              (b) =>
                b.action_value === id ||
                scope.productIds.includes(b.action_value ?? '') ||
                scope.categoryIds.includes(b.action_value ?? ''),
            ).length,
    };
    entries.push(entry);
    if (outcome === 'PERMANENTLY_DELETED' || outcome === 'ARCHIVED_FOR_HISTORY') {
      removable.push({ sellerId: id, code: seller.code, outcome, settlements: settlementsKept, entry });
    }
  }

  const global = await planGlobal(db, targetIds);
  const [serverDb] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const target = { ...databaseTarget(), serverDatabase: serverDb?.name ?? 'unknown' };
  const deletableOrders = orderRows
    .filter((row) => deletableOrderIds.has(row.id))
    .map((row) => ({ orderNumber: row.order_number, sellerCodes: sellers.filter((s) => row.found_ids.includes(s.id)).map((s) => s.code) }));

  // purge-financial: every money row that goes with the deleted orders, itemised.
  const orderIds = [...deletableOrderIds];
  let financial: PurgedFinancialRows | null = null;
  let purgedPaymentIds: string[] = [];
  let purgedRefundIds: string[] = [];
  let purgedPaymentEventIds: string[] = [];
  let couponDecrements: { couponId: string; count: number }[] = [];
  if (mode === 'purge-financial') {
    const payments = await db.$queryRaw<{ id: string; order_number: string; status: string; amount_paise: number; created_at: Date; provider_order_id: string | null }[]>`
      SELECT p.id::text AS id, o.order_number, p.status::text AS status, p.amount_paise, p.created_at, p.provider_order_id
      FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.order_id = ANY(${orderIds}::uuid[]) ORDER BY o.order_number, p.created_at`;
    const refunds = await db.$queryRaw<{ id: string; order_number: string; status: string; amount_paise: number }[]>`
      SELECT r.id::text AS id, o.order_number, r.status::text AS status, r.amount_paise
      FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.order_id = ANY(${orderIds}::uuid[]) ORDER BY o.order_number`;
    const needles = [
      ...orderIds,
      ...orderRows.filter((row) => deletableOrderIds.has(row.id)).map((row) => row.order_number),
      ...payments.flatMap((p) => (p.provider_order_id ? [p.provider_order_id] : [])),
    ];
    purgedPaymentEventIds = await idsOf(
      db.$queryRaw<{ id: string }[]>`
        SELECT pe.id::text AS id FROM payment_events pe
        WHERE EXISTS (SELECT 1 FROM unnest(${needles}::text[]) AS n WHERE strpos(pe.payload::text, n) > 0)
        ORDER BY pe.id`,
    );
    const redemptions = await db.couponRedemption.groupBy({ by: ['couponId'], where: { orderId: { in: orderIds } }, _count: { _all: true } });
    couponDecrements = redemptions.map((row) => ({ couponId: row.couponId, count: row._count._all })).sort((a, b) => a.couponId.localeCompare(b.couponId));
    purgedPaymentIds = payments.map((p) => p.id);
    purgedRefundIds = refunds.map((r) => r.id);
    financial = {
      payments: payments.map((p) => ({ orderNumber: p.order_number, status: p.status, amountPaise: p.amount_paise, createdAt: p.created_at.toISOString() })),
      refunds: refunds.map((r) => ({ orderNumber: r.order_number, status: r.status, amountPaise: r.amount_paise })),
      settlements: purgedSettlements.map((s) => ({
        sellerCode: s.sellerCode, periodStart: s.periodStart.toISOString(), periodEnd: s.periodEnd.toISOString(), status: s.status, netPayablePaise: s.netPayablePaise,
      })),
      paymentEvents: purgedPaymentEventIds.length,
      couponRedemptions: redemptions.reduce((sum, row) => sum + row._count._all, 0),
    };
  }

  const internals: PlanInternals = {
    removable,
    targetIds,
    removableIds,
    ownedProductIds: allProductIds,
    ownedListingIds: removableIds.flatMap((id) => scopes.get(id)?.listingIds ?? []),
    ownedCategoryIds: allCategoryIds,
    deletableOrderIds: [...deletableOrderIds].sort(),
    auditIdsToDelete: [...auditIdsToDelete].sort(),
    staff: [...staffPlans.entries()].map(([userId, item]) => ({ userId, decision: item.plan.decision, sellerIds: item.sellerIds })),
    bannerIds: banners.map((b) => b.id),
    purgedPaymentIds,
    purgedRefundIds,
    purgedSettlementIds: purgedSettlements.map((s) => s.id).sort(),
    purgedPaymentEventIds,
    couponDecrements,
  };
  const tokenBasis = {
    mode,
    target,
    entries: entries.map((entry) => ({
      code: entry.code, sellerId: entry.sellerId, outcome: entry.outcome, counts: entry.counts, orders: entry.orders,
      staff: entry.staff, auditLogs: entry.auditLogs, files: entry.files,
    })),
    orders: internals.deletableOrderIds,
    audit: internals.auditIdsToDelete,
    staff: internals.staff,
    banners: internals.bannerIds,
    files: files.map((file) => `${file.kind}:${file.key}`).sort(),
    money: [purgedPaymentIds, purgedRefundIds, internals.purgedSettlementIds, purgedPaymentEventIds, couponDecrements],
  };
  const plan: SellerCleanupPlan = {
    generatedAt: new Date().toISOString(),
    mode,
    target,
    codes,
    financial,
    entries,
    deletableOrders,
    files,
    banners: banners.map((b) => ({ id: b.id, title: b.title, actionType: b.action_type })),
    global,
    token: hashToken('SC', tokenBasis),
  };
  return { plan, internals };
}

async function planGlobal(db: Db, targetIds: string[]): Promise<SellerCleanupPlan['global']> {
  const [paymentRows, ordersRow] = await Promise.all([
    db.payment.groupBy({ by: ['status'], _count: { _all: true } }),
    db.$queryRaw<{ total: bigint; non_target: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM seller_orders so WHERE so.order_id = o.id
                                              AND NOT (so.seller_id = ANY(${targetIds}::uuid[])))) AS non_target
      FROM orders o`,
  ]);
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
    auditLogs: await db.auditLog.count(),
  };
}

/** The dry run. Read-only: runs in a READ ONLY transaction. */
export async function planSellerCleanup(
  requestedCodes: string[] | null = null,
  client: PrismaClient = prisma,
  options: { mode?: CleanupMode } = {},
): Promise<SellerCleanupPlan> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return (await buildPlan(tx, requestedCodes, options.mode ?? 'preserve')).plan;
  }, TX_OPTIONS);
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExecuteOptions {
  confirmToken: string;
  /** Who ran it (name / email of the person), recorded in the audit rows. */
  actor: string;
  /** A short description of the verified database backup taken before the run. */
  backupNote: string;
  /** Required when the plan has files: each one is copied here before anything is changed. */
  filesBackupDir?: string | null;
  /** Must be the mode the approved dry run used (it is part of the token). */
  mode?: CleanupMode;
}

export interface FileResult extends PlannedFile {
  backedUp: boolean;
  /** Not in storage when backed up (already gone). */
  absent: boolean;
  status: 'pending' | 'deleted' | 'kept_still_referenced' | 'already_absent' | 'failed';
  error?: string;
}

export interface ExecuteResult {
  runId: string;
  target: SellerCleanupPlan['target'];
  results: { code: string; outcome: SellerCleanupOutcome; detail: string }[];
  deletedOrders: number;
  deletedAuditLogs: number;
  deletedSettlements: number;
  mode: CleanupMode;
  unpublishedBanners: number;
  staff: Record<StaffDecision, number>;
  files: FileResult[];
  manifestPath: string | null;
  verification: { ok: boolean; problems: string[] };
}

/** Columns that hold a seller id, found from the live schema (so a new table is never missed). */
async function sellerIdColumns(db: Db): Promise<{ table: string; column: string }[]> {
  const rows = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name IN ('seller_id', 'submitted_by_seller_id')
    ORDER BY table_name, column_name`;
  return rows
    .filter((row) => /^[a-z_]+$/.test(row.table_name) && /^[a-z_]+$/.test(row.column_name))
    .map((row) => ({ table: row.table_name, column: row.column_name }));
}

/** Tables still holding rows for `sellerId` (and how many). */
async function rowsReferencingSeller(db: Db, sellerId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, column } of await sellerIdColumns(db)) {
    const [row] = await db.$queryRaw<{ n: bigint }[]>(
      Prisma.sql`SELECT count(*) AS n FROM ${Prisma.raw(`"${table}"`)} WHERE ${Prisma.raw(`"${column}"`)}::text = ${sellerId}`,
    );
    const n = Number(row?.n ?? 0);
    if (n > 0) out[`${table}.${column}`] = n;
  }
  const [self] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM sellers WHERE id = ${sellerId}::uuid`;
  if (Number(self?.n ?? 0) > 0) out['sellers.id'] = 1;
  return out;
}

/** Everything the run must leave unchanged, fingerprinted. */
async function untouchedFingerprint(db: Db, internals: PlanInternals): Promise<Record<string, string>> {
  const t = internals.targetIds;
  const [row] = await db.$queryRaw<Record<string, string>[]>`
    SELECT
      (SELECT md5(coalesce(string_agg(id::text || updated_at::text, ',' ORDER BY id), '')) FROM sellers WHERE NOT (id = ANY(${t}::uuid[]))) AS sellers,
      (SELECT md5(coalesce(string_agg(id::text || updated_at::text, ',' ORDER BY id), '')) FROM products WHERE NOT (id = ANY(${internals.ownedProductIds}::uuid[]))) AS products,
      (SELECT md5(coalesce(string_agg(id::text || updated_at::text, ',' ORDER BY id), '')) FROM seller_listings WHERE NOT (id = ANY(${internals.ownedListingIds}::uuid[]))) AS listings,
      (SELECT md5(coalesce(string_agg(id::text || updated_at::text, ',' ORDER BY id), '')) FROM categories WHERE NOT (id = ANY(${internals.ownedCategoryIds}::uuid[]))) AS categories,
      (SELECT md5(coalesce(string_agg(seller_id::text || category_id::text, ',' ORDER BY seller_id, category_id), '')) FROM seller_categories WHERE NOT (seller_id = ANY(${t}::uuid[]))) AS seller_categories,
      (SELECT md5(coalesce(string_agg(id::text || updated_at::text, ',' ORDER BY id), '')) FROM orders WHERE NOT (id = ANY(${internals.deletableOrderIds}::uuid[]))) AS orders,
      (SELECT md5(coalesce(string_agg(id::text || status::text || amount_paise::text, ',' ORDER BY id), '')) FROM payments WHERE NOT (id = ANY(${internals.purgedPaymentIds}::uuid[]))) AS payments,
      (SELECT md5(coalesce(string_agg(id::text || status::text || amount_paise::text, ',' ORDER BY id), '')) FROM refunds WHERE NOT (id = ANY(${internals.purgedRefundIds}::uuid[]))) AS refunds,
      (SELECT md5(coalesce(string_agg(id::text || status::text || net_payable_paise::text, ',' ORDER BY id), '')) FROM seller_settlements WHERE NOT (id = ANY(${internals.purgedSettlementIds}::uuid[]))) AS settlements,
      (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM payment_events WHERE NOT (id = ANY(${internals.purgedPaymentEventIds}::uuid[]))) AS payment_events,
      (SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) FROM audit_logs WHERE NOT (id = ANY(${internals.auditIdsToDelete}::uuid[])) AND action NOT LIKE 'seller.cleanup%') AS audit_logs_kept`;
  return row ?? {};
}

async function deleteCatalogue(tx: Prisma.TransactionClient, sellerId: string): Promise<void> {
  const productIds = await idsOf(
    tx.product.findMany({ where: { OR: [{ submittedBySellerId: sellerId }, { category: { sellerId } }] }, select: { id: true } }),
  );
  // Products first (variants, images, listings, stock ledger, approval items
  // and product commission rules cascade): a category cannot go while a
  // product still sits in it.
  if (productIds.length > 0) await tx.product.deleteMany({ where: { id: { in: productIds } } });
  // Its remaining listings (cart items, back-in-stock subscriptions cascade).
  await tx.sellerListing.deleteMany({ where: { sellerId } });
  // Its own category tree, deepest level first (parent links are RESTRICT).
  const own = await tx.category.findMany({ where: { sellerId }, select: { depth: true } });
  const depths = [...new Set(own.map((row) => row.depth))].sort((a, b) => b - a);
  for (const depth of depths) await tx.category.deleteMany({ where: { sellerId, depth } });
}

/** Everything a seller owns apart from the row itself and its order/settlement history. */
async function deleteSellerData(tx: Prisma.TransactionClient, sellerId: string, keepBankDetails: boolean): Promise<void> {
  await deleteCatalogue(tx, sellerId);
  await tx.backInStockSubscription.deleteMany({ where: { sellerId } });
  await tx.productApprovalBatch.deleteMany({ where: { sellerId } });
  await tx.productImport.deleteMany({ where: { sellerId } });
  await tx.commissionRule.deleteMany({ where: { sellerId } });
  await tx.configuration.deleteMany({ where: { sellerId } });
  await tx.notification.deleteMany({ where: { sellerId } });
  await tx.sellerCategory.deleteMany({ where: { sellerId } });
  await tx.sellerHours.deleteMany({ where: { sellerId } });
  await tx.sellerClosure.deleteMany({ where: { sellerId } });
  await tx.sellerProfile.deleteMany({ where: { sellerId } });
  await tx.sellerDocument.deleteMany({ where: { sellerId } });
  await tx.restaurantProfile.deleteMany({ where: { sellerId } });
  await tx.sellerStaff.deleteMany({ where: { sellerId } });
  if (!keepBankDetails) await tx.sellerBankDetail.deleteMany({ where: { sellerId } });
}

async function applyStaffDecision(tx: Prisma.TransactionClient, userId: string, decision: StaffDecision, now: Date): Promise<void> {
  if (decision === 'MEMBERSHIP_REMOVED') return; // the membership rows go with the seller data
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) return;
  if (decision === 'TURNED_CUSTOMER') {
    if (isSellerRole(user.role)) await tx.user.update({ where: { id: userId }, data: { role: SELLER_ROLE_FALLBACK } });
    // Seller-panel sessions end; a shopping-app session stays valid.
    await tx.refreshToken.updateMany({ where: { userId, scope: 'FULL', revokedAt: null }, data: { revokedAt: now } });
    return;
  }
  // ACCOUNT_ERASED — the same erasure as the in-app account deletion
  // (auth.service deleteAccount): the row survives, anonymised, so audit and
  // order references stay valid; the number is freed for a new signup.
  await tx.user.update({
    where: { id: userId },
    data: {
      mobile: `del_${sha256(userId).slice(0, 11)}`,
      email: null,
      fullName: null,
      passwordHash: null,
      referralCode: null,
      mobileVerifiedAt: null,
      role: SELLER_ROLE_FALLBACK,
      status: UserStatus.DELETED,
      deletedAt: now,
    },
  });
  await tx.address.deleteMany({ where: { userId } });
  await tx.deviceToken.deleteMany({ where: { userId } });
  await tx.notification.deleteMany({ where: { userId } });
  await tx.passwordResetToken.deleteMany({ where: { userId } });
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await tx.cart.deleteMany({ where: { userId } });
}

function filePath(dir: string, file: PlannedFile): string {
  // Keys are validated storage keys (letters, digits, / _ . -) — no traversal.
  return path.join(dir, file.kind === 'image' ? 'images' : 'documents', ...file.key.split('/'));
}

async function backupFiles(dir: string, files: PlannedFile[]): Promise<FileResult[]> {
  const results: FileResult[] = [];
  for (const file of files) {
    let body: Buffer | null;
    if (file.kind === 'image') {
      body = await storage.get(file.key, MAX_FILE_BYTES);
    } else {
      try {
        body = await privateDocuments.get(file.key);
      } catch (error) {
        if ((error as { code?: string }).code === 'NOT_FOUND') body = null;
        else throw error;
      }
    }
    if (body) {
      const target = filePath(dir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    results.push({ ...file, backedUp: body !== null, absent: body === null, status: 'pending' });
  }
  return results;
}

async function fileStillExists(file: PlannedFile): Promise<boolean> {
  if (file.kind === 'image') return (await storage.get(file.key, MAX_FILE_BYTES)) !== null;
  try {
    await privateDocuments.get(file.key);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') return false;
    throw error;
  }
}

/** After the commit: remove each backed-up file no remaining row references. Safe to repeat. */
export async function deletePlannedFiles(files: FileResult[], client: PrismaClient = prisma): Promise<FileResult[]> {
  const imageUrls = new Map(files.filter((f) => f.kind === 'image').map((f) => [f.url ?? storage.publicUrl(f.key), f.key]));
  const referenced = await urlsStillReferenced(client, [...imageUrls.keys()], {
    productIds: [], variantIds: [], categoryIds: [], sellerIds: [], importIds: [], orderIds: [],
  });
  const referencedKeys = new Set([...referenced].map((url) => imageUrls.get(url)));
  // A document whose row still exists (e.g. the run rolled back) is never removed.
  const documentKeys = files.filter((f) => f.kind === 'document').map((f) => f.key);
  if (documentKeys.length > 0) {
    const rows = await client.sellerDocument.findMany({ where: { fileKey: { in: documentKeys } }, select: { fileKey: true } });
    for (const row of rows) if (row.fileKey) referencedKeys.add(row.fileKey);
  }
  const out: FileResult[] = [];
  for (const file of files) {
    if (file.status === 'deleted' || file.status === 'already_absent' || file.status === 'kept_still_referenced') {
      out.push(file);
      continue;
    }
    if (!file.backedUp && !file.absent) {
      out.push({ ...file, status: 'failed', error: 'not backed up — not deleted' });
      continue;
    }
    if (referencedKeys.has(file.key)) {
      out.push({ ...file, status: 'kept_still_referenced' });
      continue;
    }
    try {
      if (file.absent) {
        out.push({ ...file, status: 'already_absent' });
        continue;
      }
      if (file.kind === 'image') await storage.remove(file.key);
      else await privateDocuments.remove(file.key);
      const stillThere = await fileStillExists(file);
      out.push(stillThere ? { ...file, status: 'failed', error: 'still present after removal' } : { ...file, status: 'deleted' });
    } catch (error) {
      out.push({ ...file, status: 'failed', error: error instanceof Error ? error.message.slice(0, 200) : 'removal failed' });
    }
  }
  return out;
}

export async function executeSellerCleanup(
  requestedCodes: string[] | null,
  options: ExecuteOptions,
  client: PrismaClient = prisma,
): Promise<ExecuteResult> {
  if (!options.actor.trim()) throw new Error('--actor is required (who is running this)');
  if (!options.backupNote.trim()) throw new Error('a verified backup is required before execution');

  const mode: CleanupMode = options.mode ?? 'preserve';
  const dry = await planSellerCleanup(requestedCodes, client, { mode });
  if (options.confirmToken !== dry.token) {
    throw new Error(
      'confirmation token does not match the current plan (expected the token from a fresh dry run). Data may have changed since the dry run — run the dry run again and review it.',
    );
  }
  if (dry.files.length > 0 && !options.filesBackupDir) {
    throw new Error(`the plan removes ${dry.files.length} stored file(s): --files-backup <folder> is required (each is copied there first)`);
  }

  const runId = randomUUID();
  const now = new Date();

  // 1. Files are copied BEFORE any database change: a failure stops here.
  let files: FileResult[] = [];
  let manifestPath: string | null = null;
  if (dry.files.length > 0 && options.filesBackupDir) {
    const dir = path.join(options.filesBackupDir, `seller-cleanup-${runId}`);
    files = await backupFiles(dir, dry.files);
    manifestPath = path.join(dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ runId, target: dry.target, token: dry.token, files }, null, 2));
  }

  // 2. One repeatable-read transaction: re-plan, act, verify — or roll back.
  const transaction = client.$transaction(
    async (tx) => {
      const { plan, internals } = await buildPlan(tx, requestedCodes, mode);
      if (plan.token !== dry.token) throw new Error('the data changed between the check and the transaction — nothing was changed; run the dry run again');
      const before = await untouchedFingerprint(tx, internals);

      // Orders the plan proved disposable.
      let deletedOrders = 0;
      if (internals.deletableOrderIds.length > 0) {
        const ids = internals.deletableOrderIds;
        if (mode === 'preserve') {
          // Re-checked: still no money attached.
          const money =
            (await tx.payment.count({ where: { orderId: { in: ids } } })) + (await tx.refund.count({ where: { orderId: { in: ids } } }));
          if (money > 0) throw new Error('a deletable order gained a payment or refund — stopped, nothing changed');
        } else {
          // Purge: exactly the itemised money rows, nothing more (refunds first — RESTRICT).
          const refunds = await tx.refund.deleteMany({ where: { id: { in: internals.purgedRefundIds } } });
          if (refunds.count !== internals.purgedRefundIds.length) throw new Error('refunds changed since the plan — stopped, nothing changed');
          if ((await tx.refund.count({ where: { orderId: { in: ids } } })) > 0) throw new Error('an order gained a refund — stopped, nothing changed');
          await tx.paymentEvent.deleteMany({ where: { id: { in: internals.purgedPaymentEventIds } } });
          for (const { couponId, count } of internals.couponDecrements) {
            await tx.$executeRaw`UPDATE coupons SET used_count = GREATEST(used_count - ${count}, 0), updated_at = now() WHERE id = ${couponId}::uuid`;
          }
          const payments = await tx.payment.count({ where: { orderId: { in: ids } } });
          if (payments !== internals.purgedPaymentIds.length) throw new Error('payments changed since the plan — stopped, nothing changed');
        }
        await tx.notification.deleteMany({ where: { orderId: { in: ids } } });
        // Payments, coupon redemptions, order lines, status history and delivery tasks cascade.
        deletedOrders = (await tx.order.deleteMany({ where: { id: { in: ids } } })).count;
      }
      const deletedSettlements =
        internals.purgedSettlementIds.length > 0
          ? (await tx.sellerSettlement.deleteMany({ where: { id: { in: internals.purgedSettlementIds } } })).count
          : 0;

      const deletedAuditLogs =
        internals.auditIdsToDelete.length > 0 ? (await tx.auditLog.deleteMany({ where: { id: { in: internals.auditIdsToDelete } } })).count : 0;
      const unpublishedBanners =
        internals.bannerIds.length > 0 ? (await tx.banner.updateMany({ where: { id: { in: internals.bannerIds } }, data: { isActive: false } })).count : 0;

      const staffCounts: Record<StaffDecision, number> = { MEMBERSHIP_REMOVED: 0, TURNED_CUSTOMER: 0, ACCOUNT_ERASED: 0 };
      for (const member of internals.staff) {
        await applyStaffDecision(tx, member.userId, member.decision, now);
        staffCounts[member.decision] += 1;
      }

      const results: ExecuteResult['results'] = [];
      for (const item of internals.removable) {
        const { sellerId, code, entry } = item;
        const keepBankDetails = item.outcome === 'ARCHIVED_FOR_HISTORY' && item.settlements > 0;
        await deleteSellerData(tx, sellerId, keepBankDetails);
        if (item.outcome === 'PERMANENTLY_DELETED') {
          await tx.seller.delete({ where: { id: sellerId } });
        } else {
          await tx.seller.update({
            where: { id: sellerId },
            data: {
              isActive: false,
              isAcceptingOrders: false,
              deletedAt: now,
              phone: null,
              lifecycleReason: `Dummy seller removed by seller cleanup ${runId}; kept only for order/settlement history.`,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            actorUserId: null,
            action: item.outcome === 'PERMANENTLY_DELETED' ? 'seller.cleanup_permanent_delete' : 'seller.cleanup_archive',
            entityType: 'Seller',
            entityId: sellerId,
            before: { code, name: entry.name, sellerType: entry.sellerType, counts: entry.counts, orders: entry.orders } as never,
            after: {
              runId,
              outcome: item.outcome,
              initiatedBy: options.actor.trim().slice(0, 120),
              backup: options.backupNote.trim().slice(0, 300),
              confirmToken: dry.token,
              historyReferences: entry.historyReferences,
              auditLogsDeleted: entry.auditLogs.delete,
              filesPlanned: entry.files,
            } as never,
          },
        });
        results.push({
          code,
          outcome: item.outcome,
          detail:
            item.outcome === 'PERMANENTLY_DELETED'
              ? `seller row and all its data deleted (${entry.orders.deletableOrders} order(s) deleted)`
              : `archived: ${entry.historyReferences.join('; ')}`,
        });
      }
      for (const entry of plan.entries.filter((e) => e.outcome === 'BLOCKED' || e.outcome === 'NOT_FOUND')) {
        results.push({ code: entry.code, outcome: entry.outcome, detail: entry.outcome === 'BLOCKED' ? entry.blockers.join('; ') : 'no seller with this code' });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'seller.cleanup_run',
          entityType: 'Maintenance',
          entityId: runId,
          after: {
            runId,
            initiatedBy: options.actor.trim().slice(0, 120),
            backup: options.backupNote.trim().slice(0, 300),
            confirmToken: dry.token,
            mode,
            target: plan.target,
            outcomes: results.map((r) => ({ code: r.code, outcome: r.outcome })),
            ordersDeleted: deletedOrders,
            ...(mode === 'purge-financial'
              ? {
                  purged: {
                    payments: plan.financial?.payments ?? [],
                    refunds: plan.financial?.refunds ?? [],
                    settlements: plan.financial?.settlements ?? [],
                    paymentEvents: plan.financial?.paymentEvents ?? 0,
                    couponRedemptions: plan.financial?.couponRedemptions ?? 0,
                  },
                }
              : {}),
            auditLogsDeleted: deletedAuditLogs,
            bannersUnpublished: unpublishedBanners,
            staff: staffCounts,
            filesPlanned: dry.files.length,
          } as never,
        },
      });

      // Verify inside the transaction — any problem rolls everything back.
      const problems: string[] = [];
      const after = await untouchedFingerprint(tx, internals);
      for (const key of Object.keys(before)) {
        if (before[key] !== after[key]) problems.push(`${key} outside the removed sellers changed`);
      }
      for (const item of internals.removable) {
        const left = await rowsReferencingSeller(tx, item.sellerId);
        const allowed = item.outcome === 'ARCHIVED_FOR_HISTORY' ? ['sellers.id', 'seller_orders.seller_id', 'seller_settlements.seller_id', 'seller_bank_details.seller_id'] : [];
        for (const [where, n] of Object.entries(left)) {
          if (!allowed.includes(where)) problems.push(`${item.code}: ${n} row(s) left in ${where}`);
        }
        if (item.outcome === 'ARCHIVED_FOR_HISTORY' && !left['sellers.id']) problems.push(`${item.code}: archived seller row missing`);
      }
      if (problems.length > 0) throw new Error(`verification failed — everything rolled back: ${problems.join('; ')}`);
      return { results, deletedOrders, deletedAuditLogs, deletedSettlements, unpublishedBanners, staffCounts, internals };
    },
    { ...TX_OPTIONS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const outcome = await transaction.catch(async (error: unknown) => {
    // Rolled back: nothing may be removed from storage on the strength of this run.
    if (manifestPath) await writeFile(manifestPath, JSON.stringify({ runId, target: dry.target, token: dry.token, aborted: true, files }, null, 2));
    throw error;
  });

  // 3. Files, after the commit.
  if (files.length > 0) {
    files = await deletePlannedFiles(files, client);
    if (manifestPath) await writeFile(manifestPath, JSON.stringify({ runId, target: dry.target, token: dry.token, files }, null, 2));
  }

  // 4. Final verification of the real end state, from fresh reads.
  const problems: string[] = [];
  for (const item of outcome.internals.removable) {
    const left = await rowsReferencingSeller(client, item.sellerId);
    if (item.outcome === 'PERMANENTLY_DELETED') {
      if (Object.keys(left).length > 0) problems.push(`${item.code}: still referenced by ${Object.keys(left).join(', ')}`);
      if (await client.seller.findUnique({ where: { code: item.code }, select: { id: true } })) problems.push(`${item.code}: a seller with this code still exists`);
    } else {
      const seller = await client.seller.findUnique({ where: { id: item.sellerId }, select: { isActive: true, deletedAt: true } });
      if (!seller || seller.isActive || !seller.deletedAt) problems.push(`${item.code}: archived seller is not deactivated + soft-deleted`);
      for (const where of Object.keys(left)) {
        if (!['sellers.id', 'seller_orders.seller_id', 'seller_settlements.seller_id', 'seller_bank_details.seller_id'].includes(where)) {
          problems.push(`${item.code}: rows left in ${where}`);
        }
      }
    }
  }
  if (outcome.internals.deletableOrderIds.length > 0 && (await client.order.count({ where: { id: { in: outcome.internals.deletableOrderIds } } })) > 0) {
    problems.push('a deleted order still exists');
  }
  if (outcome.internals.auditIdsToDelete.length > 0 && (await client.auditLog.count({ where: { id: { in: outcome.internals.auditIdsToDelete } } })) > 0) {
    problems.push('a deleted audit entry still exists');
  }
  const { purgedPaymentIds, purgedRefundIds, purgedSettlementIds, purgedPaymentEventIds } = outcome.internals;
  if (
    (await client.payment.count({ where: { id: { in: purgedPaymentIds } } })) +
      (await client.refund.count({ where: { id: { in: purgedRefundIds } } })) +
      (await client.sellerSettlement.count({ where: { id: { in: purgedSettlementIds } } })) +
      (await client.paymentEvent.count({ where: { id: { in: purgedPaymentEventIds } } })) >
    0
  ) {
    problems.push('a purged payment, refund, settlement or payment event still exists');
  }
  for (const member of outcome.internals.staff) {
    const user = await client.user.findUnique({ where: { id: member.userId }, select: { role: true, status: true } });
    if (member.decision === 'ACCOUNT_ERASED' && user?.status !== UserStatus.DELETED) problems.push('an erased staff account is not erased');
    if (member.decision === 'TURNED_CUSTOMER' && user && isSellerRole(user.role)) problems.push('a staff account kept a seller role');
  }
  for (const file of files) {
    if (file.status === 'failed') problems.push(`file ${file.kind} ${file.key}: ${file.error ?? 'failed'}`);
    if (file.status === 'deleted' && (await fileStillExists(file))) problems.push(`file ${file.kind} ${file.key} still exists`);
  }

  return {
    runId,
    target: dry.target,
    results: outcome.results,
    deletedOrders: outcome.deletedOrders,
    deletedAuditLogs: outcome.deletedAuditLogs,
    deletedSettlements: outcome.deletedSettlements,
    mode,
    unpublishedBanners: outcome.unpublishedBanners,
    staff: outcome.staffCounts,
    files,
    manifestPath,
    verification: { ok: problems.length === 0, problems },
  };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

export function formatPlan(plan: SellerCleanupPlan): string {
  const lines: string[] = [];
  lines.push('SELLER CLEANUP — DRY RUN (nothing has been changed)');
  lines.push(
    plan.mode === 'purge-financial'
      ? 'MODE: PURGE-FINANCIAL — orders WITH payments/refunds, their payment rows, refunds, payment events and settlements ARE DELETED (see FINANCIAL ROWS below)'
      : 'MODE: preserve — orders with payments, refunds or settlements are kept and their seller archived',
  );
  lines.push(
    `target: host ${plan.target.host} port ${plan.target.port} database ${plan.target.database} project ${plan.target.project} (server reports database "${plan.target.serverDatabase}")`,
  );
  lines.push(`generated: ${plan.generatedAt}`);
  lines.push('');
  for (const entry of plan.entries) {
    const facts = entry.found
      ? `  (${entry.name}, ${entry.sellerType}, ${entry.lifecycleStatus}${entry.softDeleted ? ', already soft-deleted' : ''}${entry.isActive ? '' : ', inactive'})`
      : '';
    lines.push(`■ ${entry.code} — ${entry.outcome}${facts}`);
    for (const note of entry.discrepancies) lines.push(`    ! ${note}`);
    for (const blocker of entry.blockers) lines.push(`    ✖ blocked: ${blocker}`);
    if (!entry.found || entry.outcome === 'BLOCKED') continue;
    for (const reference of entry.historyReferences) lines.push(`    ⚑ kept by: ${reference}`);
    for (const item of entry.kept) lines.push(`    ⚑ kept: ${item}`);
    const nonZero = Object.entries(entry.counts).filter(([, n]) => n > 0);
    lines.push(`    rows deleted: ${nonZero.length === 0 ? 'none' : nonZero.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    const o = entry.orders;
    lines.push(`    orders: ${o.sellerOrders} seller order(s) in ${o.parentOrders} order(s) — ${o.deletableOrders} deleted, ${o.retainedOrders} kept; settlements ${o.settlements}`);
    for (const kept of entry.retainedOrders.slice(0, 20)) lines.push(`      kept ${kept.orderNumber}: ${kept.reasons.join('; ')}`);
    if (entry.retainedOrders.length > 20) lines.push(`      … ${entry.retainedOrders.length - 20} more kept order(s) in the JSON report`);
    for (const member of entry.staff) lines.push(`    staff ${member.mobile} (${member.role}): ${member.decision} — ${member.reason}`);
    const keep = Object.entries(entry.auditLogs.keep).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    lines.push(`    audit logs: ${entry.auditLogs.delete} deleted (catalogue/storefront/disposable orders); kept: ${keep}`);
    lines.push(`    files: ${entry.files.images} image(s) + ${entry.files.documents} private document(s) removed (backed up first); ${entry.files.keptShared} image URL(s) kept (still referenced elsewhere, or not in our storage)`);
    if (entry.bannersToUnpublish > 0) lines.push(`    banners pointing at it: ${entry.bannersToUnpublish} unpublished (not deleted)`);
  }
  const g = plan.global;
  lines.push('');
  lines.push(`ORDERS DELETED (${plan.deletableOrders.length}): ${plan.deletableOrders.map((o) => `${o.orderNumber} [${o.sellerCodes.join('+')}]`).join(', ') || 'none'}`);
  lines.push(`BANNERS UNPUBLISHED (${plan.banners.length}): ${plan.banners.map((b) => `${b.title ?? '(untitled)'} [${b.actionType}]`).join(', ') || 'none'}`);
  lines.push(`FILES REMOVED AFTER BACKUP: ${plan.files.filter((f) => f.kind === 'image').length} image(s), ${plan.files.filter((f) => f.kind === 'document').length} document(s)`);
  if (plan.financial) {
    const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
    const f = plan.financial;
    lines.push('');
    lines.push('FINANCIAL ROWS DELETED (purge-financial):');
    lines.push(`  payments (${f.payments.length}): ${f.payments.map((p) => `${p.orderNumber} ${p.status} ${rupees(p.amountPaise)}`).join(', ') || 'none'}`);
    lines.push(`  refunds (${f.refunds.length}): ${f.refunds.map((r) => `${r.orderNumber} ${r.status} ${rupees(r.amountPaise)}`).join(', ') || 'none'}`);
    lines.push(
      `  settlements (${f.settlements.length}): ${f.settlements.map((s) => `${s.sellerCode} ${s.periodStart.slice(0, 10)}→${s.periodEnd.slice(0, 10)} ${s.status} ${rupees(s.netPayablePaise)}`).join(', ') || 'none'}`,
    );
    lines.push(`  payment gateway events: ${f.paymentEvents}; coupon redemptions: ${f.couponRedemptions} (coupon usage counters reduced to match)`);
    lines.push('  The gateway (Cashfree) keeps its own record of every payment and refund; only Aadione\'s copy is deleted.');
  }
  lines.push('');
  lines.push('GLOBAL (counted only — never deleted by this tool)');
  lines.push(`  sellers ${g.sellers} (not on the list: ${g.nonTargetSellers}); their products ${g.nonTargetProducts}, listings ${g.nonTargetListings}, categories incl. shared ${g.nonTargetCategories}`);
  lines.push(`  orders ${g.orders} (involving a seller not on the list: ${g.ordersOfNonTargetSellers})`);
  lines.push(`  payments ${JSON.stringify(g.payments)}; refunds ${g.refunds}; settlements ${g.settlements}; payment events ${g.paymentEvents}; audit logs ${g.auditLogs}`);
  lines.push('');
  lines.push(`CONFIRMATION TOKEN: ${plan.token}`);
  return lines.join('\n');
}

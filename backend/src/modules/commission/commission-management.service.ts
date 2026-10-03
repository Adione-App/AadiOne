/**
 * Commission management (admin) and the seller's read-only commission view.
 *
 * The CALCULATION is untouched — commission.service.ts's
 * `resolveCommissionBp`/`resolveCommissionBpBatch` (product > category >
 * seller default, exact category only) run at order time and their result is
 * frozen onto OrderItem.commissionBp/commissionPaise. Changing a rule here
 * therefore affects NEW orders only; no past order or settlement is ever
 * recomputed.
 *
 * RULE LIFECYCLE — at most one ACTIVE rule per (seller, product) and per
 * (seller, category), enforced by the partial unique indexes
 * `commission_rules_one_active_per_product/_category` (v2_hardening) and by
 * `commission_rules_single_scope` (a rule targets a product OR a category):
 *   set rate  -> in ONE transaction, under a per-seller row lock:
 *                deactivate the scope's active rule (if any), create the new
 *                one. Same rate as the active rule -> no-op (no churn).
 *   remove    -> deactivate the active rule; resolution falls back to the
 *                next level (product -> category -> seller default).
 * Rules are never deleted: inactive rows are the history.
 */

import { ErrorCode } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { resolveCommissionBpBatch } from './commission.service';
import { sellerVisibleOrderWhere } from '../orders/order-visibility';
import { handoverOf } from '../orders/seller-order-views';

export type CommissionScope = { kind: 'PRODUCT'; productId: string } | { kind: 'CATEGORY'; categoryId: string };

async function loadSeller(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, defaultCommissionBp: true, deletedAt: true },
  });
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

const scopeWhere = (sellerId: string, scope: CommissionScope) =>
  scope.kind === 'PRODUCT'
    ? { sellerId, productId: scope.productId, categoryId: null }
    : { sellerId, categoryId: scope.categoryId, productId: null };

/** A rule for seller X may not target another seller's own menu (Category.sellerId). */
async function assertTarget(sellerId: string, scope: CommissionScope) {
  if (scope.kind === 'CATEGORY') {
    const category = await prisma.category.findFirst({
      where: { id: scope.categoryId, deletedAt: null },
      select: { sellerId: true },
    });
    if (!category) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Category not found.' });
    if (category.sellerId !== null && category.sellerId !== sellerId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: "That category belongs to another seller's own menu." });
    }
    return;
  }
  const product = await prisma.product.findFirst({
    where: { id: scope.productId, deletedAt: null },
    select: { category: { select: { sellerId: true } } },
  });
  if (!product) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  if (product.category.sellerId !== null && product.category.sellerId !== sellerId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: "That product belongs to another seller's own menu." });
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getCommissionConfig(sellerId: string) {
  const seller = await loadSeller(sellerId);
  const rules = await prisma.commissionRule.findMany({
    where: { sellerId, isActive: true },
    include: { category: { select: { name: true } }, product: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    defaultCommissionBp: seller.defaultCommissionBp,
    categoryRules: rules
      .filter((r) => r.categoryId !== null)
      .map((r) => ({ ruleId: r.id, categoryId: r.categoryId!, categoryName: r.category?.name ?? null, rateBp: r.rateBp, since: r.createdAt.toISOString() })),
    productRules: rules
      .filter((r) => r.productId !== null)
      .map((r) => ({ ruleId: r.id, productId: r.productId!, productName: r.product?.name ?? null, rateBp: r.rateBp, since: r.createdAt.toISOString() })),
  };
}

export async function listRuleHistory(sellerId: string) {
  await loadSeller(sellerId);
  const rules = await prisma.commissionRule.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
  return rules.map((r) => ({
    ruleId: r.id,
    scope: r.productId ? 'PRODUCT' : 'CATEGORY',
    productId: r.productId,
    categoryId: r.categoryId,
    rateBp: r.rateBp,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/* Admin writes                                                               */
/* -------------------------------------------------------------------------- */

export async function setDefaultCommission(sellerId: string, rateBp: number, actorUserId: string) {
  const seller = await loadSeller(sellerId);
  if (seller.defaultCommissionBp !== rateBp) {
    await prisma.$transaction([
      prisma.seller.update({ where: { id: sellerId }, data: { defaultCommissionBp: rateBp } }),
      prisma.auditLog.create({
        data: {
          actorUserId,
          action: 'commission.default_set',
          entityType: 'Seller',
          entityId: sellerId,
          before: { defaultCommissionBp: seller.defaultCommissionBp },
          after: { defaultCommissionBp: rateBp },
        },
      }),
    ]);
  }
  return getCommissionConfig(sellerId);
}

/** Create or replace the active rule for one scope (see the file header). */
export async function setRule(sellerId: string, scope: CommissionScope, rateBp: number, actorUserId: string) {
  await loadSeller(sellerId);
  await assertTarget(sellerId, scope);

  const outcome = await runInTransaction(async (tx) => {
    // Serialise rule changes per seller, so two concurrent "set" calls cannot
    // both deactivate-then-create (the partial unique index is the backstop).
    await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${sellerId}::uuid FOR UPDATE`;
    const active = await tx.commissionRule.findFirst({ where: { ...scopeWhere(sellerId, scope), isActive: true } });
    if (active && active.rateBp === rateBp) return { changed: false, ruleId: active.id, replacedRuleId: null };

    if (active) await tx.commissionRule.update({ where: { id: active.id }, data: { isActive: false } });
    const rule = await tx.commissionRule.create({ data: { ...scopeWhere(sellerId, scope), rateBp, isActive: true } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'commission.rule_set',
        entityType: 'CommissionRule',
        entityId: rule.id,
        before: active ? { ruleId: active.id, rateBp: active.rateBp } : undefined,
        after: { scope: scope.kind, ...scopeWhere(sellerId, scope), rateBp },
      },
    });
    return { changed: true, ruleId: rule.id, replacedRuleId: active?.id ?? null };
  });

  return { ...outcome, config: await getCommissionConfig(sellerId) };
}

/** Deactivate the scope's active rule; resolution falls back one level. */
export async function removeRule(sellerId: string, scope: CommissionScope, actorUserId: string) {
  await loadSeller(sellerId);
  const active = await prisma.commissionRule.findFirst({ where: { ...scopeWhere(sellerId, scope), isActive: true } });
  if (!active) throw new AppError(ErrorCode.NOT_FOUND, { message: 'No active commission rule for that scope.' });
  await prisma.$transaction([
    prisma.commissionRule.update({ where: { id: active.id }, data: { isActive: false } }),
    prisma.auditLog.create({
      data: { actorUserId, action: 'commission.rule_removed', entityType: 'CommissionRule', entityId: active.id, before: { rateBp: active.rateBp } },
    }),
  ]);
  return getCommissionConfig(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Seller — read-only view of its own commission                             */
/* -------------------------------------------------------------------------- */

/** Configuration + the rate each of the seller's listings would be charged
 * NOW — computed by the same resolver checkout uses, so it cannot drift. */
export async function getSellerCommissionView(sellerId: string) {
  const config = await getCommissionConfig(sellerId);
  const listings = await prisma.sellerListing.findMany({
    where: { sellerId },
    include: {
      variant: {
        select: {
          variantName: true,
          product: { select: { id: true, name: true, categoryId: true, category: { select: { name: true } } } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const rates = await resolveCommissionBpBatch(
    listings.map((l) => ({ sellerId, categoryId: l.variant.product.categoryId, productId: l.variant.product.id })),
    new Map([[sellerId, config.defaultCommissionBp]]),
  );
  const productRuleFor = new Set(config.productRules.map((r) => r.productId));
  const categoryRuleFor = new Set(config.categoryRules.map((r) => r.categoryId));
  return {
    ...config,
    listings: listings.map((l, i) => ({
      sellerListingId: l.id,
      productId: l.variant.product.id,
      productName: l.variant.product.name,
      variantName: l.variant.variantName,
      categoryId: l.variant.product.categoryId,
      categoryName: l.variant.product.category.name,
      effectiveCommissionBp: rates[i]!,
      source: productRuleFor.has(l.variant.product.id)
        ? 'PRODUCT'
        : categoryRuleFor.has(l.variant.product.categoryId)
          ? 'CATEGORY'
          : 'SELLER_DEFAULT',
    })),
  };
}

/** Commission actually charged on the seller's orders — the stored snapshot. */
export async function listSellerOrderCommissions(sellerId: string, limit: number) {
  const sellerOrders = await prisma.sellerOrder.findMany({
    // Only placed orders: an unpaid or expired order was never charged.
    where: { sellerId, order: sellerVisibleOrderWhere },
    include: {
      order: { select: { orderNumber: true, status: true } },
      items: { select: { productName: true, variantName: true, qty: true, lineTotalPaise: true, commissionBp: true, commissionPaise: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return sellerOrders.map((so) => ({
    sellerOrderId: so.id,
    orderNumber: so.order.orderNumber,
    status: so.status,
    // A READY order's delivery progress (same rule as the Orders page), so a
    // delivered order is not shown as still "Ready for pickup".
    handover: handoverOf(so.status, so.order.status),
    createdAt: so.createdAt.toISOString(),
    subtotalPaise: so.subtotalPaise,
    commissionBp: so.commissionBp,
    commissionPaise: so.commissionPaise,
    items: so.items,
  }));
}

/**
 * OPTIONS / VARIANTS of a seller's own product or food item — an extension of
 * the existing variant model, not a second one:
 *
 *   Product.optionGroups        optional groups, in order: [{ name: "Size", values: ["Half", "Full"] }]
 *   ProductVariant              one sellable combination; `optionValues` = { Size: "Full" },
 *                               `variantName` = "Full" ("Large / Black" for two groups)
 *   SellerListing (per variant) the seller's own price, MRP, stock and availability —
 *                               stock still moves through the ledgered inventory service
 *
 * No option groups = a simple item with exactly one variant (as every product
 * had before). Nothing here is product-specific: Size, Portion, Color,
 * Storage, Pack Size… are just group names the seller types.
 *
 * Restaurant / cafe (food) variants carry a selling price and availability
 * only — no SKU, MRP or stock (made to order, `tracksStock = false`).
 *
 * APPROVAL. A variant added to a not-yet-approved product is reviewed with the
 * product. A variant added to an APPROVED product starts `approvalStatus =
 * PENDING` and `status = DRAFT` — every existing "variant is ACTIVE" gate
 * (catalog, search, cart, checkout, restaurant menu) keeps it hidden — and is
 * decided through the normal approval batch (product-approval.service). The
 * product and its approved variants stay live the whole time.
 *
 * ORDER HISTORY. Variants are never hard-deleted (OrderItem copies the name,
 * SKU, image and price at order time anyway); a removed variant is
 * soft-deleted and its listing switched off.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  ApprovalStatus,
  ErrorCode,
  ProductStatus,
  StockLedgerReason,
  UnitType,
  isFoodSellerType,
  optionGroupsOf,
  optionValuesOf,
  type ProductOptionGroupDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { updateOwnListing } from './seller-listing.service';

/** A food listing has no stock count (made to order — inventory/stock-rules.ts). */
const FOOD_NO_STOCK = 0;
export const MAX_OPTION_GROUPS = 3;
export const MAX_OPTION_VALUES = 30;
export const MAX_VARIANTS = 100;

export interface VariantInput {
  /** An existing variant of this product to keep (and update); omitted = a new variant. */
  id?: string;
  /** One value per option group; omitted / {} for a simple item. */
  optionValues?: Record<string, string>;
  /** Simple item only — the variant's label ("1 kg", "Regular"). Option variants are named from their values. */
  variantName?: string;
  sku?: string;
  unit?: UnitType;
  unitValue?: number;
  pricePaise: number;
  /** Marketplace only. */
  mrpPaise?: number;
  /** Marketplace only: opening stock of a new variant, or the new absolute stock of an existing one. */
  stockQty?: number;
  isAvailable?: boolean;
}

export interface VariantSetInput {
  optionGroups: ProductOptionGroupDto[];
  variants: VariantInput[];
}

interface NormalizedVariant extends VariantInput {
  optionValues: Record<string, string>;
  variantName: string;
}

/** Option groups / values as a jsonb column value. */
const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const invalid = (message: string): AppError => new AppError(ErrorCode.VALIDATION_ERROR, { message });

/** Trims and checks option groups: unique names, unique non-empty values, sane limits. */
export function normalizeOptionGroups(groups: ProductOptionGroupDto[]): ProductOptionGroupDto[] {
  if (groups.length > MAX_OPTION_GROUPS) throw invalid(`Use at most ${MAX_OPTION_GROUPS} option groups.`);
  const seen = new Set<string>();
  return groups.map((group) => {
    const name = group.name.trim();
    if (!name || name.length > 40) throw invalid('Each option group needs a name of up to 40 characters (e.g. Size).');
    if (seen.has(name.toLowerCase())) throw invalid(`The option group "${name}" is listed twice.`);
    seen.add(name.toLowerCase());
    const values = group.values.map((v) => v.trim());
    if (values.length === 0) throw invalid(`Add at least one value to "${name}".`);
    if (values.length > MAX_OPTION_VALUES) throw invalid(`"${name}" can have at most ${MAX_OPTION_VALUES} values.`);
    const lower = new Set<string>();
    for (const value of values) {
      if (!value || value.length > 40) throw invalid(`Each value of "${name}" needs 1–40 characters.`);
      if (lower.has(value.toLowerCase())) throw invalid(`"${value}" is listed twice in "${name}".`);
      lower.add(value.toLowerCase());
    }
    return { name, values };
  });
}

/** "Large" / "Large / Black" — the group order decides the label order. */
export function variantNameOf(groups: ProductOptionGroupDto[], values: Record<string, string>): string {
  return groups.map((g) => values[g.name]).join(' / ');
}

/**
 * Validates a whole variant set against its option groups. No groups → exactly
 * one (simple) variant. With groups → every variant picks one value of every
 * group, and no two variants pick the same combination.
 */
export function normalizeVariantSet(input: VariantSetInput, food: boolean): { optionGroups: ProductOptionGroupDto[]; variants: NormalizedVariant[] } {
  const optionGroups = normalizeOptionGroups(input.optionGroups);
  if (input.variants.length === 0) throw invalid('An item needs at least one variant (its price).');
  if (input.variants.length > MAX_VARIANTS) throw invalid(`An item can have at most ${MAX_VARIANTS} variants.`);
  if (optionGroups.length === 0 && input.variants.length !== 1) {
    throw invalid('Without option groups an item has exactly one price. Add an option group (e.g. Size) for more variants.');
  }
  const combos = new Set<string>();
  const ids = new Set<string>();
  const variants = input.variants.map((variant) => {
    if (variant.id) {
      if (ids.has(variant.id)) throw invalid('The same variant is listed twice.');
      ids.add(variant.id);
    }
    let optionValues: Record<string, string> = {};
    let variantName: string;
    if (optionGroups.length === 0) {
      variantName = (variant.variantName ?? '').trim() || (food ? 'Regular' : '');
      if (!variantName) throw invalid('Enter the variant name, e.g. "1 kg".');
    } else {
      const given = variant.optionValues ?? {};
      const extra = Object.keys(given).filter((key) => !optionGroups.some((g) => g.name === key));
      if (extra.length > 0) throw invalid(`Unknown option group: ${extra.join(', ')}.`);
      for (const group of optionGroups) {
        const value = given[group.name]?.trim();
        if (!value || !group.values.includes(value)) throw invalid(`Choose a ${group.name} for every variant (one of: ${group.values.join(', ')}).`);
        optionValues[group.name] = value;
      }
      variantName = variantNameOf(optionGroups, optionValues);
      const key = variantName.toLowerCase();
      if (combos.has(key)) throw invalid(`"${variantName}" is listed twice.`);
      combos.add(key);
    }
    if (variantName.length > 80) throw invalid(`"${variantName}" is too long for a variant name (80 characters).`);
    if (!Number.isInteger(variant.pricePaise) || variant.pricePaise <= 0) throw invalid(`Enter a selling price for "${variantName}".`);
    if (!food) {
      if (variant.mrpPaise === undefined) throw invalid(`Enter the MRP for "${variantName}".`);
      if (variant.pricePaise > variant.mrpPaise) throw invalid(`"${variantName}": selling price cannot be higher than MRP.`);
      if (!variant.id && variant.stockQty === undefined) throw invalid(`Enter the opening stock for "${variantName}".`);
      if (!variant.id && !variant.sku?.trim()) throw invalid(`Enter a SKU for "${variantName}".`);
    }
    return { ...variant, optionValues, variantName };
  });
  return { optionGroups, variants };
}

function foodSku(): string {
  return `FOOD-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

/**
 * Creates the variant rows (+ the seller's own listing, + an opening-stock
 * ledger entry for stock-tracked ones). `pendingReview` = the product is
 * already approved, so these new variants wait for review hidden.
 */
export async function createVariantRows(
  tx: Tx,
  input: {
    sellerId: string;
    productId: string;
    food: boolean;
    variants: NormalizedVariant[];
    startOrder: number;
    pendingReview: boolean;
    defaultUnit: { unit: UnitType; unitValue: number };
    actorUserId: string;
  },
): Promise<{ variantId: string; listingId: string }[]> {
  const created: { variantId: string; listingId: string }[] = [];
  for (const [index, variant] of input.variants.entries()) {
    const sku = input.food ? (variant.sku?.trim() ? variant.sku.trim().toUpperCase() : foodSku()) : variant.sku!.trim().toUpperCase();
    const clash = await tx.productVariant.findUnique({ where: { sku }, select: { id: true } });
    if (clash) throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message: `The SKU ${sku} is already used by another product.` });
    const row = await tx.productVariant.create({
      data: {
        productId: input.productId,
        sku,
        variantName: variant.variantName,
        optionValues: variant.optionValues,
        unit: variant.unit ?? input.defaultUnit.unit,
        unitValue: variant.unitValue ?? input.defaultUnit.unitValue,
        isDefault: false,
        displayOrder: input.startOrder + index,
        status: input.pendingReview ? ProductStatus.DRAFT : ProductStatus.ACTIVE,
        approvalStatus: input.pendingReview ? ApprovalStatus.PENDING : ApprovalStatus.APPROVED,
      },
    });
    const listing = await tx.sellerListing.create({
      data: input.food
        ? {
            sellerId: input.sellerId,
            variantId: row.id,
            mrpPaise: variant.pricePaise,
            pricePaise: variant.pricePaise,
            stockQty: FOOD_NO_STOCK,
            tracksStock: false,
            isAvailable: variant.isAvailable ?? true,
          }
        : {
            sellerId: input.sellerId,
            variantId: row.id,
            mrpPaise: variant.mrpPaise!,
            pricePaise: variant.pricePaise,
            stockQty: variant.stockQty ?? 0,
            isAvailable: variant.isAvailable ?? true,
          },
    });
    if (listing.tracksStock && listing.stockQty > 0) {
      await tx.stockLedger.create({
        data: {
          sellerListingId: listing.id,
          delta: listing.stockQty,
          reason: StockLedgerReason.PURCHASE,
          balanceAfter: listing.stockQty,
          actorUserId: input.actorUserId,
          note: 'Opening stock',
        },
      });
    }
    created.push({ variantId: row.id, listingId: listing.id });
  }
  return created;
}

/**
 * PUT /seller/products/:id/variants — the product's whole option/variant set
 * as the seller now wants it: groups, and the variants in display order.
 *
 *   variant with `id`     kept and updated (name/options, SKU, price, MRP, stock, availability)
 *   variant without `id`  added (pending review when the product is already approved)
 *   live variant missing  removed — soft delete, listing switched off, orders untouched
 *
 * The first variant becomes the default. Price and stock of kept variants go
 * through updateOwnListing (price ≤ MRP, ledgered stock, reserved floor).
 * Refused while the product (or a new variant of it) is in an open review, so
 * the admin never reviews something that changes underneath.
 */
export async function syncProductVariants(sellerId: string, productId: string, input: VariantSetInput, actorUserId: string) {
  const [seller, product] = await Promise.all([
    prisma.seller.findUnique({ where: { id: sellerId }, select: { sellerType: true } }),
    prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        name: true,
        approvalStatus: true,
        submittedBySellerId: true,
        optionGroups: true,
        variants: {
          where: { deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            variantName: true,
            optionValues: true,
            approvalStatus: true,
            status: true,
            unit: true,
            unitValue: true,
            sellerListings: { where: { sellerId }, select: { id: true, pricePaise: true, mrpPaise: true, stockQty: true, isAvailable: true } },
          },
        },
      },
    }),
  ]);
  if (!product || product.submittedBySellerId !== sellerId) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  }
  const underReview = await prisma.productApprovalBatchItem.count({ where: { productId, status: ApprovalStatus.PENDING } });
  if (underReview > 0) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'This item is being reviewed by Aadione. Its options can be changed again once the review is done.',
    });
  }

  const food = isFoodSellerType(seller?.sellerType);
  const { optionGroups, variants } = normalizeVariantSet(input, food);
  const existing = new Map(product.variants.map((v) => [v.id, v]));
  for (const variant of variants) {
    if (variant.id && !existing.has(variant.id)) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Variant not found.' });
  }
  const approved = product.approvalStatus === ApprovalStatus.APPROVED;
  const keptIds = new Set(variants.filter((v) => v.id).map((v) => v.id!));
  const removed = product.variants.filter((v) => !keptIds.has(v.id));
  const defaults = product.variants[0] ?? { unit: UnitType.PIECE, unitValue: 1 };

  await runInTransaction(async (tx) => {
    // Re-checked behind the lock a submission holds (product-approval.service
    // lockSellerForProductEdit): a submission that won the race makes this a
    // refusal instead of a change under the reviewer's eyes.
    await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${sellerId}::uuid FOR SHARE`;
    if ((await tx.productApprovalBatchItem.count({ where: { productId, status: ApprovalStatus.PENDING } })) > 0) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'This item is being reviewed by Aadione. Its options can be changed again once the review is done.',
      });
    }
    const now = new Date();
    // 1. Removed variants: soft delete (names freed by the live-only unique), listing off.
    if (removed.length > 0) {
      const ids = removed.map((v) => v.id);
      await tx.productVariant.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now, status: ProductStatus.INACTIVE, isDefault: false } });
      await tx.sellerListing.updateMany({ where: { sellerId, variantId: { in: ids } }, data: { isAvailable: false } });
    }
    // 2. Kept variants: park their names first so renames/swaps never collide mid-way.
    const kept = variants.filter((v) => v.id);
    for (const variant of kept) {
      await tx.productVariant.update({ where: { id: variant.id! }, data: { variantName: `~${variant.id!.slice(0, 12)}` } });
    }
    for (const [index, variant] of variants.entries()) {
      if (!variant.id) continue;
      const before = existing.get(variant.id)!;
      // A rejected variant the seller changed goes back for review (hidden meanwhile).
      const resubmit = approved && before.approvalStatus === ApprovalStatus.REJECTED;
      const sku = !food && variant.sku?.trim() ? variant.sku.trim().toUpperCase() : undefined;
      if (sku) {
        const clash = await tx.productVariant.findFirst({ where: { sku, id: { not: variant.id } }, select: { id: true } });
        if (clash) throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message: `The SKU ${sku} is already used by another product.` });
      }
      await tx.productVariant.update({
        where: { id: variant.id },
        data: {
          variantName: variant.variantName,
          optionValues: variant.optionValues,
          displayOrder: index,
          isDefault: index === 0,
          ...(sku ? { sku } : {}),
          ...(variant.unit ? { unit: variant.unit } : {}),
          ...(variant.unitValue ? { unitValue: variant.unitValue } : {}),
          ...(resubmit ? { approvalStatus: ApprovalStatus.PENDING, status: ProductStatus.DRAFT } : {}),
        },
      });
    }
    // 3. New variants.
    const fresh = variants.map((v, index) => ({ v, index })).filter(({ v }) => !v.id);
    for (const { v, index } of fresh) {
      const [row] = await createVariantRows(tx, {
        sellerId,
        productId,
        food,
        variants: [v],
        startOrder: index,
        pendingReview: approved,
        defaultUnit: { unit: defaults.unit, unitValue: defaults.unitValue },
        actorUserId,
      });
      if (index === 0) await tx.productVariant.update({ where: { id: row!.variantId }, data: { isDefault: true } });
    }
    await tx.product.update({ where: { id: productId }, data: { optionGroups: asJson(optionGroups) } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'product.seller_variants_update',
        entityType: 'Product',
        entityId: productId,
        before: {
          optionGroups: optionGroupsOf(product.optionGroups),
          variants: product.variants.map((v) => ({ id: v.id, name: v.variantName, options: optionValuesOf(v.optionValues) })),
        },
        after: asJson({
          optionGroups,
          variants: variants.map((v) => ({ id: v.id ?? null, name: v.variantName })),
          removed: removed.map((v) => v.id),
        }),
      },
    });
  });

  // 4. Price / MRP / stock / availability of kept variants — the existing,
  // ledgered listing rules (price ≤ MRP, stock never below reserved, food
  // items have no stock).
  for (const variant of variants) {
    if (!variant.id) continue;
    const listing = existing.get(variant.id)!.sellerListings[0];
    if (!listing) continue;
    const changes = {
      ...(variant.pricePaise !== listing.pricePaise ? { pricePaise: variant.pricePaise } : {}),
      ...(!food && variant.mrpPaise !== undefined && variant.mrpPaise !== listing.mrpPaise ? { mrpPaise: variant.mrpPaise } : {}),
      ...(!food && variant.stockQty !== undefined && variant.stockQty !== listing.stockQty ? { stockQty: variant.stockQty } : {}),
      ...(variant.isAvailable !== undefined && variant.isAvailable !== listing.isAvailable ? { isAvailable: variant.isAvailable } : {}),
    };
    if (Object.keys(changes).length > 0) await updateOwnListing(sellerId, listing.id, changes, actorUserId);
  }
}

/* -------------------------------------------------------------------------- */
/* One variant at a time — add, edit, show / hide, delete                     */
/* -------------------------------------------------------------------------- */
//
// The product page's variant manager. Price, MRP, stock and the on-sale switch
// of a variant are its own listing's (PATCH /seller/listings/:id and its
// stock-adjust — ledgered, row-locked, unchanged); these change the variant
// itself. Each one touches exactly one variant (plus, when needed, which
// variant is the default and the product's option values) — never another
// variant's price, stock or review state, never an order.
//
// Every change runs behind the same locks as a whole-set edit: the seller row
// FOR SHARE (a "Submit for Approval" holds it FOR UPDATE) and this product's
// row FOR UPDATE (two variant changes of one product, one after the other).

const VARIANT_ORDER = [{ isDefault: 'desc' as const }, { displayOrder: 'asc' as const }, { createdAt: 'asc' as const }];

async function lockProductForVariantChange(tx: Tx, sellerId: string, productId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM sellers WHERE id = ${sellerId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
}

async function refuseWhileUnderReview(tx: Tx, productId: string): Promise<void> {
  if ((await tx.productApprovalBatchItem.count({ where: { productId, status: ApprovalStatus.PENDING } })) > 0) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'This item is being reviewed by Aadione. Its options can be changed again once the review is done.',
    });
  }
}

/** The seller's own live product with its live variants (default first), or NOT_FOUND. */
async function loadOwnVariantProduct(tx: Tx, sellerId: string, productId: string) {
  const [seller, product] = await Promise.all([
    tx.seller.findUnique({ where: { id: sellerId }, select: { sellerType: true } }),
    tx.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        approvalStatus: true,
        submittedBySellerId: true,
        optionGroups: true,
        variants: {
          where: { deletedAt: null },
          orderBy: VARIANT_ORDER,
          select: {
            id: true,
            variantName: true,
            optionValues: true,
            approvalStatus: true,
            status: true,
            isDefault: true,
            displayOrder: true,
            sku: true,
            unit: true,
            unitValue: true,
          },
        },
      },
    }),
  ]);
  // Another seller's product is reported exactly like a missing one.
  if (!product || product.submittedBySellerId !== sellerId) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Product not found.' });
  return { food: isFoodSellerType(seller?.sellerType), product };
}

type LiveVariant = Awaited<ReturnType<typeof loadOwnVariantProduct>>['product']['variants'][number];

function variantOf(variants: LiveVariant[], variantId: string): LiveVariant {
  const variant = variants.find((v) => v.id === variantId);
  if (!variant) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Variant not found.' });
  return variant;
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function refuseDuplicate(variants: LiveVariant[], variantName: string, exceptId?: string): void {
  if (variants.some((v) => v.id !== exceptId && sameLabel(v.variantName, variantName))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message: `"${variantName}" already exists for this product.` });
  }
}

/**
 * One value per option group for a variant. A value the group does not have
 * yet (a new size, "2 kg") is added to that group, after its current values.
 */
function resolveOptionValues(groups: ProductOptionGroupDto[], given: Record<string, string>) {
  const extra = Object.keys(given).filter((key) => !groups.some((g) => g.name === key));
  if (extra.length > 0) throw invalid(`Unknown option group: ${extra.join(', ')}.`);
  const optionValues: Record<string, string> = {};
  const nextGroups = groups.map((group) => {
    const value = given[group.name]?.trim() ?? '';
    if (!value || value.length > 40) throw invalid(`Enter the ${group.name} (1–40 characters).`);
    const existing = group.values.find((v) => v.toLowerCase() === value.toLowerCase());
    optionValues[group.name] = existing ?? value;
    if (existing) return group;
    if (group.values.length >= MAX_OPTION_VALUES) throw invalid(`"${group.name}" can have at most ${MAX_OPTION_VALUES} values.`);
    return { name: group.name, values: [...group.values, value] };
  });
  return { optionGroups: nextGroups, optionValues, variantName: variantNameOf(nextGroups, optionValues) };
}

/** Drops option values no live variant uses any more (a deleted or renamed size). */
function pruneOptionGroups(groups: ProductOptionGroupDto[], live: Record<string, string>[]): ProductOptionGroupDto[] {
  return groups.map((group) => ({ name: group.name, values: group.values.filter((value) => live.some((values) => values[group.name] === value)) }));
}

/**
 * Keeps the default variant one customers can see: when the default is hidden
 * or deleted, the first visible variant (display order) takes over. Changes
 * nothing when the default is still live, or when none is.
 */
async function keepLiveDefault(tx: Tx, productId: string): Promise<void> {
  const variants = await tx.productVariant.findMany({
    where: { productId, deletedAt: null },
    orderBy: VARIANT_ORDER,
    select: { id: true, isDefault: true, status: true },
  });
  const current = variants.find((v) => v.isDefault);
  if (current && current.status === ProductStatus.ACTIVE) return;
  const next = variants.find((v) => v.status === ProductStatus.ACTIVE) ?? (current ? null : variants[0]);
  if (!next) return;
  await tx.productVariant.updateMany({ where: { productId, isDefault: true }, data: { isDefault: false } });
  await tx.productVariant.update({ where: { id: next.id }, data: { isDefault: true } });
}

export interface AddVariantInput {
  optionValues?: Record<string, string>;
  sku?: string;
  unit?: UnitType;
  unitValue?: number;
  pricePaise: number;
  mrpPaise?: number;
  stockQty?: number;
  isAvailable?: boolean;
}

/**
 * POST /seller/products/:id/variants — one more variant of the SAME product
 * (a new size, "2 kg"): its own SKU, listing and opening stock (ledgered).
 * Existing variants are untouched. On an approved product it waits for review
 * hidden (PENDING / DRAFT) while the product and its approved variants stay on
 * sale; otherwise it is reviewed with the product. A combination the product
 * already has is refused.
 */
export async function addProductVariant(sellerId: string, productId: string, input: AddVariantInput, actorUserId: string) {
  return runInTransaction(async (tx) => {
    await lockProductForVariantChange(tx, sellerId, productId);
    await refuseWhileUnderReview(tx, productId);
    const { food, product } = await loadOwnVariantProduct(tx, sellerId, productId);
    const groups = optionGroupsOf(product.optionGroups);
    if (groups.length === 0) {
      throw invalid('This product has a single price. Turn on options (e.g. Weight) in "Edit details" to sell it in more sizes.');
    }
    if (product.variants.length >= MAX_VARIANTS) throw invalid(`An item can have at most ${MAX_VARIANTS} variants.`);
    const resolved = resolveOptionValues(groups, input.optionValues ?? {});
    const {
      variants: [variant],
    } = normalizeVariantSet({ optionGroups: resolved.optionGroups, variants: [{ ...input, optionValues: resolved.optionValues }] }, food);
    refuseDuplicate(product.variants, variant!.variantName);

    const defaults = product.variants[0] ?? { unit: UnitType.PIECE, unitValue: 1 };
    const [row] = await createVariantRows(tx, {
      sellerId,
      productId,
      food,
      variants: [variant!],
      startOrder: Math.max(-1, ...product.variants.map((v) => v.displayOrder)) + 1,
      pendingReview: product.approvalStatus === ApprovalStatus.APPROVED,
      defaultUnit: { unit: defaults.unit, unitValue: defaults.unitValue },
      actorUserId,
    });
    await tx.product.update({ where: { id: productId }, data: { optionGroups: asJson(resolved.optionGroups) } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'product.seller_variant_add',
        entityType: 'ProductVariant',
        entityId: row!.variantId,
        after: asJson({ productId, variantName: variant!.variantName, listingId: row!.listingId }),
      },
    });
    return row!;
  });
}

export interface UpdateVariantInput {
  /** Option products: this variant's values (a new value is added to its group). */
  optionValues?: Record<string, string>;
  /** Simple products only: the variant's label. */
  variantName?: string;
  sku?: string;
  unit?: UnitType;
  unitValue?: number;
}

/**
 * PATCH /seller/products/:id/variants/:variantId — the variant's own details
 * (label / option values, SKU, unit). Price, MRP, stock and on-sale are its
 * listing's. Same rules as the whole-set edit: a rejected variant of an
 * approved product goes back for review (hidden meanwhile).
 */
export async function updateProductVariant(sellerId: string, productId: string, variantId: string, input: UpdateVariantInput, actorUserId: string) {
  await runInTransaction(async (tx) => {
    await lockProductForVariantChange(tx, sellerId, productId);
    await refuseWhileUnderReview(tx, productId);
    const { food, product } = await loadOwnVariantProduct(tx, sellerId, productId);
    const variant = variantOf(product.variants, variantId);
    const groups = optionGroupsOf(product.optionGroups);

    const data: Prisma.ProductVariantUpdateInput = {};
    let nextGroups: ProductOptionGroupDto[] | null = null;
    if (input.optionValues !== undefined) {
      if (groups.length === 0) throw invalid('This product has no options; edit its variant name instead.');
      const resolved = resolveOptionValues(groups, { ...optionValuesOf(variant.optionValues), ...input.optionValues });
      refuseDuplicate(product.variants, resolved.variantName, variant.id);
      data.optionValues = resolved.optionValues;
      data.variantName = resolved.variantName;
      const live = product.variants.map((v) => (v.id === variant.id ? resolved.optionValues : optionValuesOf(v.optionValues)));
      nextGroups = pruneOptionGroups(resolved.optionGroups, live);
    } else if (input.variantName !== undefined) {
      if (groups.length > 0) throw invalid('This variant is named from its options; change its option values instead.');
      const name = input.variantName.trim();
      if (!name || name.length > 80) throw invalid('Enter the variant name (1–80 characters), e.g. "1 kg".');
      data.variantName = name;
    }
    if (!food && input.sku !== undefined) {
      const sku = input.sku.trim().toUpperCase();
      if (sku !== variant.sku) {
        const clash = await tx.productVariant.findFirst({ where: { sku, id: { not: variant.id } }, select: { id: true } });
        if (clash) throw new AppError(ErrorCode.VALIDATION_ERROR, { status: 409, message: `The SKU ${sku} is already used by another product.` });
        data.sku = sku;
      }
    }
    if (!food && input.unit !== undefined) data.unit = input.unit;
    if (!food && input.unitValue !== undefined) data.unitValue = input.unitValue;
    if (Object.keys(data).length === 0) return;

    // A rejected variant the seller changed goes back for review (hidden meanwhile).
    if (product.approvalStatus === ApprovalStatus.APPROVED && variant.approvalStatus === ApprovalStatus.REJECTED) {
      data.approvalStatus = ApprovalStatus.PENDING;
      data.status = ProductStatus.DRAFT;
    }
    await tx.productVariant.update({ where: { id: variant.id }, data });
    if (nextGroups) await tx.product.update({ where: { id: productId }, data: { optionGroups: asJson(nextGroups) } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'product.seller_variant_update',
        entityType: 'ProductVariant',
        entityId: variant.id,
        before: asJson({ variantName: variant.variantName, sku: variant.sku, unit: variant.unit, unitValue: variant.unitValue }),
        after: asJson({ ...data, productId }),
      },
    });
  });
}

/**
 * PATCH /seller/products/:id/variants/:variantId/visibility — show or hide
 * ONE variant from customers (the product and its other variants stay as they
 * are; a hidden default hands over to the next visible variant). Only a live
 * variant — not one waiting for or refused in review. The listing's on-sale
 * switch is separate and untouched.
 */
export async function setProductVariantVisibility(sellerId: string, productId: string, variantId: string, visible: boolean, actorUserId: string) {
  await runInTransaction(async (tx) => {
    await lockProductForVariantChange(tx, sellerId, productId);
    const { product } = await loadOwnVariantProduct(tx, sellerId, productId);
    const variant = variantOf(product.variants, variantId);
    if (variant.approvalStatus !== ApprovalStatus.APPROVED || (variant.status !== ProductStatus.ACTIVE && variant.status !== ProductStatus.INACTIVE)) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'This option is waiting for (or was refused in) review — it can be shown or hidden once Aadione approves it.',
      });
    }
    const status = visible ? ProductStatus.ACTIVE : ProductStatus.INACTIVE;
    if (variant.status === status) return;
    await tx.productVariant.update({ where: { id: variant.id }, data: { status } });
    await keepLiveDefault(tx, productId);
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: visible ? 'product.seller_variant_shown' : 'product.seller_variant_hidden',
        entityType: 'ProductVariant',
        entityId: variant.id,
        before: { status: variant.status },
        after: asJson({ status, productId }),
      },
    });
  });
}

/**
 * DELETE /seller/products/:id/variants/:variantId — removes ONE variant:
 * soft delete (orders, order items, ledger and cart history keep pointing at
 * it untouched), its listing switched off sale, its option value dropped when
 * no other variant uses it, and the default handed to a remaining variant.
 * The product's only remaining variant cannot be deleted — the seller hides
 * or deletes the product instead, so nothing ends up as a product without a
 * variant.
 */
export async function deleteProductVariant(sellerId: string, productId: string, variantId: string, actorUserId: string) {
  await runInTransaction(async (tx) => {
    await lockProductForVariantChange(tx, sellerId, productId);
    await refuseWhileUnderReview(tx, productId);
    const { product } = await loadOwnVariantProduct(tx, sellerId, productId);
    const variant = variantOf(product.variants, variantId);
    if (product.variants.length <= 1) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        status: 409,
        message: 'This is the only option of this product. Hide or delete the product instead.',
      });
    }
    await tx.productVariant.update({
      where: { id: variant.id },
      data: { deletedAt: new Date(), status: ProductStatus.INACTIVE, isDefault: false },
    });
    await tx.sellerListing.updateMany({ where: { sellerId, variantId: variant.id }, data: { isAvailable: false } });
    await keepLiveDefault(tx, productId);
    const groups = optionGroupsOf(product.optionGroups);
    if (groups.length > 0) {
      const live = product.variants.filter((v) => v.id !== variant.id).map((v) => optionValuesOf(v.optionValues));
      await tx.product.update({ where: { id: productId }, data: { optionGroups: asJson(pruneOptionGroups(groups, live)) } });
    }
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'product.seller_variant_delete',
        entityType: 'ProductVariant',
        entityId: variant.id,
        before: asJson({ productId, variantName: variant.variantName, sku: variant.sku }),
      },
    });
  });
}

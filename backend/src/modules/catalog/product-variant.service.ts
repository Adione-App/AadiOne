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

/** Made-to-order capacity of a food listing (mirrors FOOD_ITEM_CAPACITY). */
const FOOD_CAPACITY = 100_000;
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
            stockQty: FOOD_CAPACITY,
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

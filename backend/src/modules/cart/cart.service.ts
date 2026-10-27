/**
 * Cart (Phase 6, redesigned for V2's multi-seller marketplace).
 *
 * THE CART STORES NO PRICES. `cart_items` holds only (seller listing, qty);
 * every price, discount and availability figure is resolved live from
 * `seller_listings` on each read. There is nowhere for a stale or tampered
 * price to live, which is the "never trust client totals" rule expressed in
 * the data model rather than in a validation check.
 *
 * V2: the cart is SELLER-AGNOSTIC. One cart per user, not one per seller — a
 * line points at a specific `SellerListing` (not a bare variant), so its
 * seller is derivable per-item. This is what lets a single cart mix products
 * from any number of sellers; checkout (order.service.ts) is what groups
 * these lines BY seller into one SellerOrder each.
 *
 * Revalidation NEVER silently alters the basket. When stock runs out or a
 * price moves, the cart is corrected AND a `changes[]` entry is returned so
 * the app can show "Tata Salt 1 kg is out of stock and was removed" — a
 * customer discovering a changed total at the payment screen is how trust is
 * lost.
 */

import { Prisma } from "@prisma/client";
import {
  CodPolicy,
  ConfigKey,
  ErrorCode,
  type CartChangeDto,
  type CartDto,
  type CartItemDto,
  type CartSellerGroupDto,
} from "../../shared";
import { resolveItemCodPolicy } from "../../shared/cod";
import { AppError } from "../../common/errors";
import { prisma, type DbClient } from "../../infra/db/prisma";
import * as configService from "../configuration/configuration.service";
import * as pricingService from "../pricing/pricing.service";
import { moduleLogger } from "../../common/logger";
import { unorderableMessage, unorderableReason } from "./orderability";
import { cartLineEligibility, isGone } from "./eligibility";
import { trackedAvailableQty } from "../inventory/stock-rules";
import * as sellerService from "../sellers/seller.service";
import { orderingState, statusOf, storeStatuses, type StoreStatus } from "../sellers/store-availability";

const log = moduleLogger("cart");

/** Everything needed to price and validate every line, in one query. */
const CART_INCLUDE = {
  items: {
    orderBy: { createdAt: "asc" },
    include: {
      sellerListing: {
        include: {
          seller: { include: { hours: { orderBy: { dayOfWeek: "asc" } } } },
          variant: {
            include: {
              product: {
                include: {
                  brand: true,
                  category: true,
                  images: {
                    orderBy: { displayOrder: "asc" },
                    take: 1,
                  },
                },
              },
              images: { orderBy: { displayOrder: "asc" }, take: 1 },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

async function getOrCreateCart(userId: string, client: DbClient = prisma) {
  const existing = await client.cart.findFirst({
    where: { userId, status: "ACTIVE" },
    include: CART_INCLUDE,
  });
  if (existing) return existing;

  // The partial unique index `carts_one_active_per_user` guarantees a
  // concurrent duplicate create fails rather than producing two live carts.
  try {
    return await client.cart.create({
      data: { userId, status: "ACTIVE" },
      include: CART_INCLUDE,
    });
  } catch (error) {
    // A simultaneous request (double tap, two screens loading the cart, two
    // devices) created it a moment ago: use that cart instead of failing the
    // shopper's request with "already exists". (No caller passes a
    // transaction — inside one, the failed insert would abort it.)
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    return client.cart.findFirstOrThrow({
      where: { userId, status: "ACTIVE" },
      include: CART_INCLUDE,
    });
  }
}

type LoadedCart = Awaited<ReturnType<typeof getOrCreateCart>>;

/* -------------------------------------------------------------------------- */
/* Task 6.2 — revalidation                                                    */
/* -------------------------------------------------------------------------- */

interface RevalidationOutcome {
  /** Every remaining line, available or not. */
  items: CartItemDto[];
  changes: CartChangeDto[];
  /** AVAILABLE lines only — what the bill, COD and an order are computed from. */
  priceable: pricingService.PriceableItem[];
  codPolicies: { productName: string; resolvedPolicy: CodPolicy }[];
  /** `sellerListingId` of every available line. */
  availableListingIds: string[];
  /** Each line's seller's current status. */
  statuses: ReadonlyMap<string, StoreStatus>;
}

async function revalidate(cart: LoadedCart): Promise<RevalidationOutcome> {
  const [config, statuses] = await Promise.all([
    configService.getMany([ConfigKey.DEFAULT_COD_POLICY, ConfigKey.DEFAULT_MAX_QTY_PER_ORDER]),
    storeStatuses(cart.items.map((item) => item.sellerListing.seller)),
  ]);

  const items: CartItemDto[] = [];
  const changes: CartChangeDto[] = [];
  const priceable: pricingService.PriceableItem[] = [];
  const codPolicies: { productName: string; resolvedPolicy: CodPolicy }[] = [];
  const availableListingIds: string[] = [];

  const removeIds: string[] = [];
  const quantityFixes: { id: string; qty: number }[] = [];

  for (const item of cart.items) {
    const offer = item.sellerListing;
    const variant = offer.variant;
    const product = variant.product;
    const seller = offer.seller;
    const productName = `${product.name} ${variant.variantName}`.trim();

    // --- gone for good (deleted) — the only line ever taken out ------------
    if (isGone({ seller, product, variant })) {
      removeIds.push(item.id);
      changes.push({
        type: "ITEM_REMOVED_UNAVAILABLE",
        variantId: variant.id,
        productName,
        message: `${productName} is no longer sold and was removed from your cart.`,
      });
      continue;
    }

    // Tracked: stock left. Made-to-order food: no stock count — its only
    // limit is the per-order one (inventory/stock-rules.ts).
    const trackedQty = trackedAvailableQty(offer);
    const availableQty = trackedQty ?? (offer.maxQtyPerOrder || config.DEFAULT_MAX_QTY_PER_ORDER);
    // Not orderable right now (store closed, product off sale, no stock): the
    // line STAYS, marked, outside the bill — it counts again by itself when
    // that changes. Nothing is removed for a temporary state.
    const eligibility = cartLineEligibility({
      seller,
      product,
      variant,
      listing: offer,
      availableQty: trackedQty,
      store: statusOf(statuses, seller.id),
      displayName: productName,
    });

    // --- quantity (available lines only: an unavailable line keeps what the
    // customer chose and is checked again when it comes back) -------------
    const maxQty = offer.maxQtyPerOrder || config.DEFAULT_MAX_QTY_PER_ORDER;
    let qty = item.qty;

    if (eligibility.orderable && offer.tracksStock && qty > availableQty) {
      changes.push({
        type: "QTY_REDUCED_STOCK",
        variantId: variant.id,
        productName,
        message: `Only ${availableQty} left of ${productName}. Quantity updated.`,
        previousValue: qty,
        newValue: availableQty,
      });
      qty = availableQty;
    }

    if (eligibility.orderable && qty > maxQty) {
      changes.push({
        type: "QTY_REDUCED_LIMIT",
        variantId: variant.id,
        productName,
        message: `You can order up to ${maxQty} of ${productName} per order.`,
        previousValue: qty,
        newValue: maxQty,
      });
      qty = maxQty;
    }

    if (qty !== item.qty) quantityFixes.push({ id: item.id, qty });

    // --- COD ---------------------------------------------------------------
    const categoryChain: CodPolicy[] = [];
    const category = product.category;
    // One level is loaded eagerly; ancestors resolve from the catalog cache
    // when the full chain matters (order creation).
    if (category) categoryChain.push(category.allowCod);

    const resolvedPolicy = resolveItemCodPolicy(
      {
        sellerListing: offer.allowCod,
        productVariant: variant.allowCod,
        product: product.allowCod,
        categoryChain,
        seller: seller.allowCod,
      },
      config.DEFAULT_COD_POLICY,
    );

    const image =
      variant.imageUrl ??
      variant.images[0]?.url ??
      product.images[0]?.url ??
      null;

    items.push({
      id: item.id,
      sellerListingId: offer.id,
      variantId: variant.id,
      productId: product.id,
      sellerId: seller.id,
      sellerName: seller.name,
      productName: product.name,
      variantName: variant.variantName,
      brandName: product.brand?.name ?? null,
      imageUrl: image,
      qty,
      mrpPaise: offer.mrpPaise,
      unitPricePaise: offer.pricePaise,
      lineTotalPaise: offer.pricePaise * qty,
      lineDiscountPaise: Math.max(
        0,
        (offer.mrpPaise - offer.pricePaise) * qty,
      ),
      inStock: offer.isAvailable && availableQty > 0,
      availableQty,
      maxQtyPerOrder: maxQty,
      allowCod: resolvedPolicy === CodPolicy.ALLOW,
      available: eligibility.orderable,
      unavailableReason: eligibility.reason,
      storeClosedReason: eligibility.storeClosedReason,
      unavailableMessage: eligibility.message,
    });

    if (!eligibility.orderable) continue;
    codPolicies.push({ productName, resolvedPolicy });
    availableListingIds.push(offer.id);
    priceable.push({
      variantId: variant.id,
      qty,
      mrpPaise: offer.mrpPaise,
      unitPricePaise: offer.pricePaise,
      taxRateBp: product.taxRateBp,
    });
  }

  // Persist the corrections so the next read is consistent with what the
  // customer was just shown.
  if (removeIds.length > 0) {
    await prisma.cartItem.deleteMany({ where: { id: { in: removeIds } } });
  }
  for (const fix of quantityFixes) {
    await prisma.cartItem.update({
      where: { id: fix.id },
      data: { qty: fix.qty },
    });
  }

  if (changes.length > 0) {
    log.info(
      { cartId: cart.id, changes: changes.length },
      "cart corrected on revalidation",
    );
  }

  return { items, changes, priceable, codPolicies, availableListingIds, statuses };
}

function groupBySeller(
  items: CartItemDto[],
  statuses: ReadonlyMap<string, StoreStatus>,
): CartSellerGroupDto[] {
  const groups = new Map<string, CartSellerGroupDto>();
  for (const item of items) {
    let group = groups.get(item.sellerId);
    if (!group) {
      const status = statusOf(statuses, item.sellerId);
      group = {
        sellerId: item.sellerId,
        sellerName: item.sellerName,
        items: [],
        subtotalPaise: 0,
        isOpen: status.acceptingOrders,
        closedMessage: status.message,
      };
      groups.set(item.sellerId, group);
    }
    group.items.push(item);
    if (item.available) group.subtotalPaise += item.lineTotalPaise;
  }
  return [...groups.values()];
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface CartContext {
  cartId: string;
  /** Available lines only. */
  priceable: pricingService.PriceableItem[];
  codPolicies: { productName: string; resolvedPolicy: CodPolicy }[];
  availableListingIds: string[];
  couponCode: string | null;
}

/**
 * Builds the full cart payload. Always revalidates — there is no "fast path"
 * that skips it, because a stale cart is exactly what produces a surprise at
 * checkout. Store status is read live on every call, so a cart kept overnight
 * is checked against today's stores, never yesterday's answer.
 */
export async function getCart(
  userId: string,
  options: { distanceKm?: number | null } = {},
): Promise<{ dto: CartDto; context: CartContext }> {
  const cart = await getOrCreateCart(userId);
  const [{ items, changes, priceable, codPolicies, availableListingIds, statuses }, ordering] = await Promise.all([
    revalidate(cart),
    orderingState(),
  ]);

  let couponCode = cart.couponCode;
  let coupon: pricingService.ResolvedCoupon | null = null;

  if (couponCode) {
    try {
      coupon = await pricingService.resolveCoupon(couponCode, userId);
    } catch {
      // A coupon that has since expired or hit its limit is dropped with a
      // notice rather than blocking the whole cart from loading.
      await prisma.cart.update({
        where: { id: cart.id },
        data: { couponCode: null },
      });
      changes.push({
        type: "COUPON_REMOVED",
        variantId: null,
        productName: null,
        message: `Coupon ${couponCode} is no longer valid and was removed.`,
      });
      couponCode = null;
    }
  }

  // The bill (and the minimum order) covers the AVAILABLE lines only — what
  // an order placed now would contain.
  const { bill } = await pricingService.computeBill({
    items: priceable,
    distanceKm: options.distanceKm ?? null,
    coupon,
  });

  const minOrderValuePaise = await configService.get(
    ConfigKey.MIN_ORDER_VALUE_PAISE,
  );
  const shortfallPaise = Math.max(
    0,
    minOrderValuePaise - bill.itemsSubtotalPaise,
  );

  const availableItemCount = items.filter((item) => item.available).length;
  const unavailableItemCount = items.length - availableItemCount;
  const minimumMessage = `Add ₹${Math.ceil(shortfallPaise / 100)} more to place an order.`;

  // Checkout of the available lines (current apps).
  let availableCheckoutBlockedReason: string | null = null;
  if (items.length === 0) availableCheckoutBlockedReason = "Your cart is empty.";
  else if (!ordering.enabled) availableCheckoutBlockedReason = ordering.message;
  else if (availableItemCount === 0) {
    availableCheckoutBlockedReason =
      "None of the items in your cart can be ordered right now. Remove them, or order when the store reopens.";
  } else if (shortfallPaise > 0) availableCheckoutBlockedReason = minimumMessage;

  // Whole-cart checkout (older apps): every line must be orderable.
  let checkoutBlockedReason: string | null = null;
  if (items.length === 0) checkoutBlockedReason = "Your cart is empty.";
  else if (!ordering.enabled) checkoutBlockedReason = ordering.message;
  else if (unavailableItemCount > 0) {
    checkoutBlockedReason = [
      ...new Set(items.filter((item) => !item.available).map((item) => item.unavailableMessage ?? "")),
    ]
      .filter(Boolean)
      .join(" ");
  } else if (shortfallPaise > 0) checkoutBlockedReason = minimumMessage;

  return {
    dto: {
      id: cart.id,
      items,
      sellerGroups: groupBySeller(items, statuses),
      bill,
      changes,
      checkoutEnabled: checkoutBlockedReason === null,
      checkoutBlockedReason,
      minOrderValuePaise,
      shortfallPaise,
      availableCheckoutEnabled: availableCheckoutBlockedReason === null,
      availableCheckoutBlockedReason,
      availableItemCount,
      unavailableItemCount,
      orderingEnabled: ordering.enabled,
      orderingPausedMessage: ordering.message,
    },
    context: {
      cartId: cart.id,
      priceable,
      codPolicies,
      availableListingIds,
      couponCode,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Task 6.1 — mutations                                                       */
/* -------------------------------------------------------------------------- */

export async function addItem(
  userId: string,
  sellerListingId: string,
  qty: number,
  distanceKm: number | null = null,
): Promise<CartDto> {
  const offer = await prisma.sellerListing.findUnique({
    where: { id: sellerListingId },
    include: {
      seller: { include: { hours: { orderBy: { dayOfWeek: "asc" } } } },
      variant: { include: { product: true } },
    },
  });

  if (!offer) throw new AppError(ErrorCode.PRODUCT_UNAVAILABLE);
  const unorderable = unorderableReason({
    seller: offer.seller,
    product: offer.variant.product,
    variant: offer.variant,
  });
  if (unorderable) {
    throw new AppError(ErrorCode.PRODUCT_UNAVAILABLE, {
      message: unorderableMessage(unorderable, offer.variant.product.name, offer.seller.name),
      internalMessage: `listing ${sellerListingId} not orderable: ${unorderable}`,
    });
  }
  // Closed right now (own switch OFF, closure, outside hours) — refused, the
  // same gate checkout applies.
  await sellerService.assertSellerAcceptingOrders(offer.seller);

  // null = made to order (no stock count): only the switch and the per-order limit apply.
  const availableQty = trackedAvailableQty(offer);
  if (!offer.isAvailable || (availableQty !== null && availableQty <= 0)) {
    throw new AppError(ErrorCode.ITEM_OUT_OF_STOCK, {
      message: `${offer.variant.product.name} is out of stock.`,
    });
  }

  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((item) => item.sellerListingId === sellerListingId);
  const desiredQty = (existing?.qty ?? 0) + qty;

  const maxQty =
    offer.maxQtyPerOrder ||
    (await configService.get(ConfigKey.DEFAULT_MAX_QTY_PER_ORDER));

  if (desiredQty > maxQty) {
    throw new AppError(ErrorCode.QTY_LIMIT_EXCEEDED, {
      message: `You can order up to ${maxQty} of this item per order.`,
    });
  }
  if (availableQty !== null && desiredQty > availableQty) {
    throw new AppError(ErrorCode.INSUFFICIENT_STOCK, {
      message: `Only ${availableQty} left in stock.`,
    });
  }

  // The unique (cart_id, seller_listing_id) index makes this a single atomic
  // upsert rather than a read-then-write that two taps could race.
  await prisma.cartItem.upsert({
    where: { cartId_sellerListingId: { cartId: cart.id, sellerListingId } },
    create: { cartId: cart.id, sellerListingId, qty },
    update: { qty: desiredQty },
  });

  return (await getCart(userId, { distanceKm })).dto;
}

export async function updateItemQty(
  userId: string,
  cartItemId: string,
  qty: number,
  distanceKm: number | null = null,
): Promise<CartDto> {
  const item = await prisma.cartItem.findFirst({
    where: {
      id: cartItemId,
      cart: { userId, status: "ACTIVE" },
    },
    include: {
      sellerListing: {
        include: {
          seller: { include: { hours: { orderBy: { dayOfWeek: "asc" } } } },
          variant: { include: { product: true } },
        },
      },
    },
  });

  // Ownership is checked HERE, in the service — the route guard only proves
  // the caller is logged in, not that this cart item is theirs.
  if (!item)
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: "Cart item not found.",
    });

  if (qty <= 0) {
    await prisma.cartItem.delete({ where: { id: cartItemId } });
    return (await getCart(userId, { distanceKm })).dto;
  }

  const offer = item.sellerListing;

  // More of it is ADDING to the cart: the same gates as `addItem` (store
  // taking orders, product sellable). Fewer is always allowed, so a closed
  // store's line can still be reduced or removed.
  if (qty > item.qty) {
    const unorderable = unorderableReason({
      seller: offer.seller,
      product: offer.variant.product,
      variant: offer.variant,
    });
    if (unorderable) {
      throw new AppError(ErrorCode.PRODUCT_UNAVAILABLE, {
        message: unorderableMessage(unorderable, offer.variant.product.name, offer.seller.name),
        internalMessage: `listing ${offer.id} not orderable: ${unorderable}`,
      });
    }
    await sellerService.assertSellerAcceptingOrders(offer.seller);
    if (!offer.isAvailable) {
      throw new AppError(ErrorCode.ITEM_OUT_OF_STOCK, {
        message: `${offer.variant.product.name} is out of stock.`,
      });
    }
  }

  const availableQty = trackedAvailableQty(offer);
  if (availableQty !== null && qty > availableQty) {
    throw new AppError(ErrorCode.INSUFFICIENT_STOCK, {
      message: `Only ${availableQty} left in stock.`,
    });
  }
  if (qty > offer.maxQtyPerOrder) {
    throw new AppError(ErrorCode.QTY_LIMIT_EXCEEDED, {
      message: `You can order up to ${offer.maxQtyPerOrder} of this item per order.`,
    });
  }

  await prisma.cartItem.update({ where: { id: cartItemId }, data: { qty } });
  return (await getCart(userId, { distanceKm })).dto;
}

export async function removeItem(
  userId: string,
  cartItemId: string,
  distanceKm: number | null = null,
): Promise<CartDto> {
  const deleted = await prisma.cartItem.deleteMany({
    where: {
      id: cartItemId,
      cart: { userId, status: "ACTIVE" },
    },
  });
  if (deleted.count === 0) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: "Cart item not found.",
    });
  }
  return (await getCart(userId, { distanceKm })).dto;
}

export async function clearCart(
  userId: string,
  distanceKm: number | null = null,
): Promise<CartDto> {
  const cart = await prisma.cart.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  if (cart) {
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: null },
    });
  }
  return (await getCart(userId, { distanceKm })).dto;
}

export async function applyCoupon(
  userId: string,
  code: string,
  distanceKm: number | null = null,
): Promise<CartDto> {
  // Validate before storing, so an invalid code is rejected immediately rather
  // than silently dropped at the next cart read.
  const coupon = await pricingService.resolveCoupon(code, userId);

  const cart = await getOrCreateCart(userId);
  await prisma.cart.update({
    where: { id: cart.id },
    data: { couponCode: coupon.code },
  });

  return (await getCart(userId, { distanceKm })).dto;
}

export async function removeCoupon(
  userId: string,
  distanceKm: number | null = null,
): Promise<CartDto> {
  const cart = await prisma.cart.findFirst({
    where: { userId, status: "ACTIVE" },
  });
  if (cart)
    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: null },
    });
  return (await getCart(userId, { distanceKm })).dto;
}

/**
 * Marks the cart converted once its order is created — only if it is still
 * ACTIVE. Two checkouts of the same cart racing (a double tap with fresh
 * idempotency keys, two devices) both read it ACTIVE; the second one's
 * conditional update waits for the first to commit, then matches nothing and
 * throws, rolling back its order and stock reservation. Unconditional, both
 * orders were created from one cart.
 */
/**
 * Puts lines back into the customer's active cart — an unpaid order that was
 * cancelled before any payment (orders/unpaid-order-guard.ts). A line already
 * there gets the quantity added; the next read revalidates everything (a
 * closed store's lines show as unavailable, quantities are capped).
 */
export async function restoreLines(
  userId: string,
  lines: readonly { sellerListingId: string; qty: number }[],
): Promise<void> {
  if (lines.length === 0) return;
  const cart = await getOrCreateCart(userId);
  for (const line of lines) {
    await prisma.cartItem.upsert({
      where: { cartId_sellerListingId: { cartId: cart.id, sellerListingId: line.sellerListingId } },
      create: { cartId: cart.id, sellerListingId: line.sellerListingId, qty: line.qty },
      update: { qty: { increment: line.qty } },
    });
  }
}

/**
 * After an order: takes its lines out of the cart, inside the order's
 * transaction. Every line ordered: the cart is converted (markConverted).
 * Some lines left (unavailable ones the customer kept): the cart stays
 * ACTIVE with only those, and its coupon — spent on this order — is cleared.
 *
 * Concurrency, as markConverted: the cart row is claimed with a conditional
 * update (a second checkout of the same lines waits for the first to commit),
 * and every ordered line must still be there to delete — if another checkout
 * took them meanwhile, this throws and rolls the second order back.
 */
export async function consumeOrderedLines(
  cartId: string,
  orderedListingIds: readonly string[],
  client: DbClient = prisma,
): Promise<void> {
  const claimed = await client.cart.updateMany({
    where: { id: cartId, status: "ACTIVE" },
    data: { couponCode: null },
  });
  if (claimed.count === 0) {
    throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
      internalMessage: `cart ${cartId} was already converted by a concurrent checkout`,
    });
  }
  const deleted = await client.cartItem.deleteMany({
    where: { cartId, sellerListingId: { in: [...orderedListingIds] } },
  });
  if (deleted.count !== orderedListingIds.length) {
    throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
      internalMessage: `cart ${cartId}: ${deleted.count} of ${orderedListingIds.length} ordered lines left — a concurrent checkout took them`,
    });
  }
  const left = await client.cartItem.count({ where: { cartId } });
  if (left === 0) await markConverted(cartId, client);
}

export async function markConverted(
  cartId: string,
  client: DbClient = prisma,
): Promise<void> {
  const converted = await client.cart.updateMany({
    where: { id: cartId, status: "ACTIVE" },
    data: { status: "CONVERTED" },
  });
  if (converted.count === 0) {
    throw new AppError(ErrorCode.ORDER_IN_PROGRESS, {
      internalMessage: `cart ${cartId} was already converted by a concurrent checkout`,
    });
  }
}

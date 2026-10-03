/**
 * Orders and checkout — V2 multi-seller redesign.
 *
 * `placeOrder` is the most important function in this system. It re-derives
 * EVERY decision from the database inside one transaction with every
 * involved seller's inventory rows locked — nothing the client sent is
 * trusted, and nothing read outside the lock is relied upon.
 *
 * V2's central move: a checkout groups the cart's items BY SELLER and
 * creates one Order (the customer-facing parent — payment, address,
 * aggregate totals) plus one SellerOrder per seller involved (owning that
 * seller's own items, status lifecycle, cancellation and commission
 * snapshot). See order-state.service.ts for how the two levels transition.
 */

import type { Category, Prisma } from '@prisma/client';
import {
  ActorType,
  CodPolicy,
  ConfigKey,
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  SellerOrderStatus,
  STATUS_PROGRESSION,
  CUSTOMER_TIMELINE_LABELS,
  CUSTOMER_TIMELINE_STEPS,
  CustomerTimelineStep,
  ORDER_STATUS_LABELS,
  SELLER_ORDER_STATUS_LABELS,
  toCustomerTimelineStep,
  toOrderBucket,
  type CheckoutQuoteResponse,
  type CursorPage,
  type OrderDetailDto,
  type OrderItemDto,
  type OrderSummaryDto,
  type OrderTimelineEntryDto,
  type SellerOrderSummaryDto,
} from '../../shared';
import { resolveItemCodPolicy, resolveOrderCodEligibility } from '../../shared/cod';
import { generateOrderNumber, formatAddressLine } from '../../shared/text';
import { extractInclusiveTaxPaise } from '../../shared/money';
import { AppError } from '../../common/errors';
import { randomNumericCode, sha256, safeEqual } from '../../common/crypto';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';
import * as configService from '../configuration/configuration.service';
import * as sellerService from '../sellers/seller.service';
import { unorderableMessage, unorderableReason } from '../cart/orderability';
import * as addressService from '../addresses/address.service';
import * as pricingService from '../pricing/pricing.service';
import * as inventoryService from '../inventory/inventory.service';
import * as cartService from '../cart/cart.service';
import * as commissionService from '../commission/commission.service';
import * as notificationService from '../notifications/notification.service';
import {
  announceNewOrder,
  transitionOrder,
  transitionSellerOrder,
} from './order-state.service';

const log = moduleLogger('orders');

/* -------------------------------------------------------------------------- */
/* COD resolution                                                             */
/* -------------------------------------------------------------------------- */

/** Full leaf-to-root chain, so a policy set on "Grocery" reaches its children. */
function buildCategoryChain(
  categoryId: string,
  byId: Map<string, Category>,
): CodPolicy[] {
  const chain: CodPolicy[] = [];
  let current = byId.get(categoryId);
  let guard = 0;
  while (current && guard < 10) {
    chain.push(current.allowCod);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return chain;
}

/* -------------------------------------------------------------------------- */
/* Checkout quote (POST /checkout/quote)                                      */
/* -------------------------------------------------------------------------- */

interface CheckoutContextItem {
  sellerListingId: string;
  sellerId: string;
  sellerAllowCod: CodPolicy;
  variantId: string;
  qty: number;
  productId: string;
  productName: string;
  variantName: string;
  brandName: string | null;
  imageUrl: string | null;
  sku: string;
  unitDisplay: string;
  taxRateBp: number;
  categoryId: string;
  productAllowCod: CodPolicy;
  variantAllowCod: CodPolicy;
}

interface CheckoutContext {
  addressId: string;
  distanceKm: number;
  delivery: sellerService.CartDelivery;
  items: CheckoutContextItem[];
}

/**
 * Assembles everything checkout needs, WITHOUT side effects.
 *
 * Runs the same validations and the same pricing engine as order creation, so
 * the Review screen shows the server's bill rather than one the client
 * computed. This is why the app never needs to do arithmetic.
 *
 * Serviceability is per seller: every seller in the cart must deliver to the
 * address, and the delivery fee/ETA are priced on the farthest of them
 * (seller.service.ts `assertSellersServe`).
 */
async function buildCheckoutContext(
  userId: string,
  addressId: string,
): Promise<CheckoutContext> {
  const address = await addressService.getOwnedAddress(userId, addressId);

  const cart = await prisma.cart.findFirst({
    where: { userId, status: 'ACTIVE' },
    include: {
      items: {
        include: {
          sellerListing: {
            include: {
              seller: { select: { id: true, allowCod: true } },
              variant: {
                include: {
                  product: { include: { brand: true } },
                  images: { orderBy: { displayOrder: 'asc' }, take: 1 },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!cart || cart.items.length === 0) {
    throw new AppError(ErrorCode.CART_EMPTY);
  }

  // Recomputed here rather than read from the cached flag on the address row.
  const delivery = await sellerService.assertSellersServe(
    address.latitude,
    address.longitude,
    cart.items.map((item) => item.sellerListing.sellerId),
  );

  return {
    addressId,
    distanceKm: delivery.check.distanceKm,
    delivery,
    items: cart.items.map((item) => {
      const offer = item.sellerListing;
      const variant = offer.variant;
      return {
        sellerListingId: offer.id,
        sellerId: offer.sellerId,
        sellerAllowCod: offer.seller.allowCod,
        variantId: item.sellerListing.variantId,
        qty: item.qty,
        productId: variant.product.id,
        productName: variant.product.name,
        variantName: variant.variantName,
        brandName: variant.product.brand?.name ?? null,
        imageUrl: variant.imageUrl ?? variant.images[0]?.url ?? null,
        sku: variant.sku,
        unitDisplay: variant.variantName,
        taxRateBp: variant.product.taxRateBp,
        categoryId: variant.product.categoryId,
        productAllowCod: variant.product.allowCod,
        variantAllowCod: variant.allowCod,
      };
    }),
  };
}

export async function getCheckoutQuote(
  userId: string,
  addressId: string,
  couponCode?: string | null,
): Promise<CheckoutQuoteResponse> {
  const context = await buildCheckoutContext(userId, addressId);

  const { dto: cartDto } = await cartService.getCart(userId, {
    distanceKm: context.distanceKm,
  });

  const coupon = couponCode ? await pricingService.resolveCoupon(couponCode, userId) : null;

  const offers = await prisma.sellerListing.findMany({
    where: { id: { in: context.items.map((i) => i.sellerListingId) } },
  });
  const offerByListing = new Map(offers.map((offer) => [offer.id, offer]));

  const { bill } = await pricingService.computeBill({
    items: context.items.map((item) => {
      const offer = offerByListing.get(item.sellerListingId);
      return {
        variantId: item.variantId,
        qty: item.qty,
        mrpPaise: offer?.mrpPaise ?? 0,
        unitPricePaise: offer?.pricePaise ?? 0,
        taxRateBp: item.taxRateBp,
      };
    }),
    distanceKm: context.distanceKm,
    coupon,
  });

  // --- COD eligibility ---------------------------------------------------
  const categories = await prisma.category.findMany({ where: { deletedAt: null } });
  const byId = new Map(categories.map((category) => [category.id, category]));
  const config = await configService.getMany([
    ConfigKey.DEFAULT_COD_POLICY,
    ConfigKey.COD_MAX_ORDER_VALUE_PAISE,
    ConfigKey.COD_FIRST_ORDER_MAX_PAISE,
  ]);

  const deliveredCount = await prisma.order.count({
    where: { userId, status: OrderStatus.DELIVERED },
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const codResult = resolveOrderCodEligibility({
    items: context.items.map((item) => ({
      productName: `${item.productName} ${item.variantName}`.trim(),
      resolvedPolicy: resolveItemCodPolicy(
        {
          sellerListing: offerByListing.get(item.sellerListingId)?.allowCod ?? CodPolicy.INHERIT,
          productVariant: item.variantAllowCod,
          product: item.productAllowCod,
          categoryChain: buildCategoryChain(item.categoryId, byId),
          seller: item.sellerAllowCod,
        },
        config.DEFAULT_COD_POLICY,
      ),
    })),
    // Each item already folds its OWN seller's policy into `resolvedPolicy`
    // above (multi-seller carts have no single "the seller" left to check
    // separately) — this stays a neutral pass-through.
    sellerPolicy: CodPolicy.ALLOW,
    defaultPolicy: config.DEFAULT_COD_POLICY,
    orderTotalPaise: bill.totalPaise,
    codMaxOrderValuePaise: config.COD_MAX_ORDER_VALUE_PAISE,
    isFirstOrder: deliveredCount === 0,
    codFirstOrderMaxPaise: config.COD_FIRST_ORDER_MAX_PAISE,
    customerCodBlocked: user.codBlocked,
  });

  const eta = await sellerService.estimateEta({
    distanceKm: context.distanceKm,
    itemCount: bill.itemCount,
    sellerId: context.delivery.farthest.id,
  });

  const serviceability = await sellerService.cartServiceability(context.delivery, bill.itemCount);

  return {
    bill,
    changes: cartDto.changes,
    serviceability,
    codAllowed: codResult.allowed,
    codBlockedReason: codResult.reason,
    // COD is listed but disabled with a reason rather than hidden — a missing
    // option is confusing, an explained one is not (PRD §4.3).
    availablePaymentMethods: codResult.allowed
      ? [PaymentMethod.ONLINE, PaymentMethod.COD]
      : [PaymentMethod.ONLINE],
    etaMinutes: eta.etaMinutes,
    etaMinMinutes: eta.etaMinMinutes,
    etaMaxMinutes: eta.etaMaxMinutes,
  };
}

/* -------------------------------------------------------------------------- */
/* Task 8.2 — place order                                                     */
/* -------------------------------------------------------------------------- */

export interface PlaceOrderInput {
  userId: string;
  addressId: string;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  notes?: string | null;
  expectedTotalPaise?: number | undefined;
  /** Keyed by SELLER LISTING now, not bare variant — see PlaceOrderRequest's
   * own comment in shared/dto.ts. */
  expectedItems?: { sellerListingId: string; unitPricePaise: number }[] | undefined;
  idempotencyKey: string;
}

export interface PlaceOrderResult {
  order: OrderDetailDto;
  /** Present for online orders — the client uses it to start payment. */
  requiresPayment: boolean;
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  // Cheap checks first, outside the transaction, so an out-of-area address
  // never takes inventory locks: EVERY seller in the cart must deliver here
  // (priced on the farthest). Seller availability is checked PER SELLER in
  // the cart, inside the transaction but still before any lock (below) — a
  // closed restaurant must not block a grocery order, and vice versa.
  const address = await addressService.getOwnedAddress(input.userId, input.addressId);
  const cartSellers = await prisma.cartItem.findMany({
    where: { cart: { userId: input.userId, status: 'ACTIVE' } },
    select: { sellerListing: { select: { sellerId: true } } },
  });
  if (cartSellers.length === 0) throw new AppError(ErrorCode.CART_EMPTY);
  const delivery = await sellerService.assertSellersServe(
    address.latitude,
    address.longitude,
    cartSellers.map((row) => row.sellerListing.sellerId),
  );
  const serviceability = delivery.check;
  const servingSellerIds = new Set(delivery.sellers.map((seller) => seller.id));

  const config = await configService.getMany([
    ConfigKey.DEFAULT_COD_POLICY,
    ConfigKey.COD_MAX_ORDER_VALUE_PAISE,
    ConfigKey.COD_FIRST_ORDER_MAX_PAISE,
    ConfigKey.MIN_ORDER_VALUE_PAISE,
    ConfigKey.PAYMENT_HOLD_MINUTES,
    ConfigKey.DELIVERY_OTP_REQUIRED_FOR_COD,
  ]);

  const categories = await prisma.category.findMany({ where: { deletedAt: null } });
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } });
  const deliveredCount = await prisma.order.count({
    where: { userId: input.userId, status: OrderStatus.DELIVERED },
  });

  const eta = await sellerService.estimateEta({
    distanceKm: serviceability.distanceKm,
    itemCount: 1,
    sellerId: delivery.farthest.id,
  });

  let deliveryOtp: string | null = null;

  const created = await runInTransaction(
    async (tx) => {
      /* --- cart ------------------------------------------------------- */
      const cart = await tx.cart.findFirst({
        where: { userId: input.userId, status: 'ACTIVE' },
        include: {
          items: {
            include: {
              sellerListing: {
                include: {
                  seller: { include: { hours: { orderBy: { dayOfWeek: 'asc' } } } },
                  variant: {
                    include: {
                      product: { include: { brand: true } },
                      images: { orderBy: { displayOrder: 'asc' }, take: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!cart || cart.items.length === 0) throw new AppError(ErrorCode.CART_EMPTY);

      /* --- every seller must be open (switch ON, no closure, in hours) -- */
      // Sellers that stopped trading altogether (deleted, admin-inactive,
      // onboarding not approved) are refused per item below as
      // PRODUCT_UNAVAILABLE, exactly as before; this gate is only about
      // whether a trading seller is open right now.
      const checkedSellers = new Set<string>();
      for (const line of cart.items) {
        const seller = line.sellerListing.seller;
        if (checkedSellers.has(seller.id)) continue;
        checkedSellers.add(seller.id);
        if (seller.deletedAt || !seller.isActive || seller.onboardingStatus !== 'APPROVED') continue;
        // A seller added to the cart after the pre-check above must still
        // deliver to this address.
        if (!servingSellerIds.has(seller.id)) {
          await sellerService.assertServiceable(address.latitude, address.longitude, seller);
        }
        await sellerService.assertSellerAcceptingOrders(seller);
      }

      /* --- group by seller (#3) ----------------------------------------- */
      const itemsBySeller = new Map<string, typeof cart.items>();
      for (const item of cart.items) {
        const sellerId = item.sellerListing.sellerId;
        const bucket = itemsBySeller.get(sellerId);
        if (bucket) bucket.push(item);
        else itemsBySeller.set(sellerId, [item]);
      }

      /* --- LOCK inventory, per seller, deterministic order -------------- */
      // Everything below reads from these locked rows. Prices, stock and COD
      // flags are taken from here, never from the client and never from a
      // read that happened before the lock. Locking one seller at a time
      // (sellers visited in sorted-id order, variants sorted within each)
      // keeps the deadlock-free guarantee `lockOffersForUpdate` relies on.
      const offersByListingId = new Map<string, inventoryService.LockedOffer>();
      for (const sellerId of [...itemsBySeller.keys()].sort()) {
        const items = itemsBySeller.get(sellerId)!;
        const variantIds = items.map((item) => item.sellerListing.variantId).sort();
        const offers = await inventoryService.lockOffersForUpdate(tx, sellerId, variantIds);
        for (const offer of offers.values()) offersByListingId.set(offer.id, offer);
      }

      /* --- per-item validation ---------------------------------------- */
      const priceable: pricingService.PriceableItem[] = [];
      const codItems: { productName: string; resolvedPolicy: CodPolicy }[] = [];

      // Keyed by sellerListingId — the per-item prices the customer's cart
      // was showing (see PlaceOrderRequest's own comment). Only ever a
      // SAFETY CHECK, same as `expectedTotalPaise` below.
      const expectedPriceByListing = new Map(
        (input.expectedItems ?? []).map((entry) => [entry.sellerListingId, entry.unitPricePaise]),
      );
      const priceMismatches: {
        message: string;
        variantId: string;
        productId: string;
        name: string;
        qty: number;
        oldPrice: number;
        currentPrice: number;
        availableQty: number;
      }[] = [];

      for (const item of cart.items) {
        const variant = item.sellerListing.variant;
        const product = variant.product;
        const seller = item.sellerListing.seller;
        const displayName = `${product.name} ${variant.variantName}`.trim();
        const offer = offersByListingId.get(item.sellerListingId);

        // Authoritative orderability check (see cart/orderability.ts): seller
        // live (not deleted, active, onboarding APPROVED) and product
        // APPROVED + active — re-checked here, inside the transaction, since
        // a cart line can outlive any of those.
        const unorderable = unorderableReason({ seller, product, variant });
        if (!offer || !offer.isAvailable || unorderable) {
          throw new AppError(ErrorCode.PRODUCT_UNAVAILABLE, {
            message: unorderable
              ? `${unorderableMessage(unorderable, displayName, seller.name)} Please review your cart.`
              : `${displayName} is no longer available. Please review your cart.`,
            internalMessage: `listing ${item.sellerListingId} not orderable: ${unorderable ?? 'listing unavailable'}`,
          });
        }

        if (offer.availableQty < item.qty) {
          throw new AppError(ErrorCode.ITEM_OUT_OF_STOCK, {
            message:
              offer.availableQty === 0
                ? `${displayName} just went out of stock. Please review your cart.`
                : `Only ${offer.availableQty} left of ${displayName}. Please review your cart.`,
            details: [
              {
                message: `${displayName}: ${offer.availableQty} available`,
                variantId: item.sellerListing.variantId,
                available: offer.availableQty,
              },
            ],
          });
        }

        const expectedUnitPricePaise = expectedPriceByListing.get(item.sellerListingId);
        if (
          expectedUnitPricePaise !== undefined &&
          expectedUnitPricePaise !== offer.pricePaise
        ) {
          priceMismatches.push({
            message: `${displayName}: price changed from ₹${(expectedUnitPricePaise / 100).toFixed(2)} to ₹${(offer.pricePaise / 100).toFixed(2)}`,
            variantId: item.sellerListing.variantId,
            productId: product.id,
            name: displayName,
            qty: item.qty,
            oldPrice: expectedUnitPricePaise,
            currentPrice: offer.pricePaise,
            availableQty: offer.availableQty,
          });
        }

        if (item.qty > offer.maxQtyPerOrder) {
          throw new AppError(ErrorCode.QTY_LIMIT_EXCEEDED, {
            message: `You can order up to ${offer.maxQtyPerOrder} of ${displayName} per order.`,
          });
        }

        const resolvedPolicy = resolveItemCodPolicy(
          {
            sellerListing: offer.allowCod as CodPolicy,
            productVariant: variant.allowCod,
            product: product.allowCod,
            categoryChain: buildCategoryChain(product.categoryId, categoryById),
            seller: seller.allowCod,
          },
          config.DEFAULT_COD_POLICY,
        );
        codItems.push({ productName: displayName, resolvedPolicy });

        priceable.push({
          variantId: item.sellerListing.variantId,
          qty: item.qty,
          mrpPaise: offer.mrpPaise,
          unitPricePaise: offer.pricePaise,
          taxRateBp: product.taxRateBp,
        });
      }

      // Reported ALL AT ONCE (not on the first mismatch found) so the
      // client can refresh and show every affected product in one go.
      if (priceMismatches.length > 0) {
        throw new AppError(ErrorCode.PRICE_CHANGED, {
          message: 'Prices have changed since you reviewed your order. Please check and try again.',
          details: priceMismatches,
        });
      }

      /* --- coupon (parent-level, applies across every seller) ----------- */
      const couponCode = input.couponCode ?? cart.couponCode;
      const coupon = couponCode
        ? await pricingService.resolveCoupon(couponCode, input.userId)
        : null;

      /* --- pricing ----------------------------------------------------- */
      const { bill } = await pricingService.computeBill({
        items: priceable,
        distanceKm: serviceability.distanceKm,
        coupon,
      });

      if (bill.itemsSubtotalPaise < config.MIN_ORDER_VALUE_PAISE) {
        throw new AppError(ErrorCode.MIN_ORDER_NOT_MET, {
          message: `Minimum order value is ₹${Math.ceil(config.MIN_ORDER_VALUE_PAISE / 100)}.`,
        });
      }

      if (
        input.expectedTotalPaise !== undefined &&
        input.expectedTotalPaise !== bill.totalPaise
      ) {
        throw new AppError(ErrorCode.PRICE_CHANGED, {
          message: 'Prices have changed since you reviewed your order. Please check and try again.',
          details: [
            { field: 'totalPaise', message: 'total changed', expected: input.expectedTotalPaise, actual: bill.totalPaise },
          ],
        });
      }

      /* --- COD eligibility --------------------------------------------- */
      if (input.paymentMethod === PaymentMethod.COD) {
        const codResult = resolveOrderCodEligibility({
          items: codItems,
          sellerPolicy: CodPolicy.ALLOW,
          defaultPolicy: config.DEFAULT_COD_POLICY,
          orderTotalPaise: bill.totalPaise,
          codMaxOrderValuePaise: config.COD_MAX_ORDER_VALUE_PAISE,
          isFirstOrder: deliveredCount === 0,
          codFirstOrderMaxPaise: config.COD_FIRST_ORDER_MAX_PAISE,
          customerCodBlocked: user.codBlocked,
        });

        if (!codResult.allowed) {
          throw new AppError(ErrorCode.COD_NOT_ALLOWED, {
            message: codResult.reason ?? 'Cash on Delivery is not available for this order.',
          });
        }
      }

      /* --- build per-seller breakdown (#4/#5/#6/#11) -------------------- */
      const isCod = input.paymentMethod === PaymentMethod.COD;
      const parentStatus = isCod ? OrderStatus.PROCESSING : OrderStatus.PENDING_PAYMENT;

      if (isCod && config.DELIVERY_OTP_REQUIRED_FOR_COD) {
        deliveryOtp = randomNumericCode(4);
      }

      interface SellerOrderInput {
        sellerId: string;
        itemsSubtotalPaise: number;
        itemDiscountPaise: number;
        taxPaise: number;
        subtotalPaise: number;
        commissionBp: number;
        commissionPaise: number;
        items: Prisma.OrderItemCreateManySellerOrderInput[];
      }

      const sellerOrderInputs: SellerOrderInput[] = [];

      // Resolved ONCE, in the same iteration order the loop below consumes
      // (`itemsBySeller` is not touched in between, so the pairing by index
      // is exact). Two queries total, batched across every seller and item
      // in this checkout, instead of up to three SEQUENTIAL queries PER
      // ITEM — the dominant cost in a multi-seller checkout's transaction
      // time (see commission.service.ts's own doc comment on why this is
      // safe to batch: nothing here is locked or written by this
      // transaction). `seller` is already loaded on every cart item (see the
      // cart `include` above), so the seller-default fallback costs nothing
      // extra either.
      const sellerDefaultBpBySellerId = new Map(
        [...itemsBySeller.values()].flatMap((items) =>
          items.map(
            (item) =>
              [item.sellerListing.sellerId, item.sellerListing.seller.defaultCommissionBp] as const,
          ),
        ),
      );
      const commissionRates = await commissionService.resolveCommissionBpBatch(
        [...itemsBySeller.entries()].flatMap(([sellerId, items]) =>
          items.map((item) => ({
            sellerId,
            categoryId: item.sellerListing.variant.product.categoryId,
            productId: item.sellerListing.variant.product.id,
          })),
        ),
        sellerDefaultBpBySellerId,
        tx,
      );
      let commissionRateIndex = 0;

      for (const [sellerId, items] of itemsBySeller) {
        let itemsSubtotalPaise = 0;
        let itemDiscountPaise = 0;
        let taxPaise = 0;
        const orderItemData: Prisma.OrderItemCreateManySellerOrderInput[] = [];

        for (const item of items) {
          const variant = item.sellerListing.variant;
          const product = variant.product;
          const offer = offersByListingId.get(item.sellerListingId)!;
          const lineTotal = offer.pricePaise * item.qty;
          const lineTax = extractInclusiveTaxPaise(lineTotal, product.taxRateBp);
          const resolvedPolicy = resolveItemCodPolicy(
            {
              sellerListing: offer.allowCod as CodPolicy,
              productVariant: variant.allowCod,
              product: product.allowCod,
              categoryChain: buildCategoryChain(product.categoryId, categoryById),
              seller: item.sellerListing.seller.allowCod,
            },
            config.DEFAULT_COD_POLICY,
          );

          itemsSubtotalPaise += lineTotal;
          itemDiscountPaise += Math.max(0, (offer.mrpPaise - offer.pricePaise) * item.qty);
          taxPaise += lineTax;

          // Commission resolved PER ITEM (product > category > seller
          // default — batched above, see `commissionRates`) and stored ON
          // THE ITEM — this is the source of truth (#1). `SellerOrder.
          // commissionPaise` below is derived as the EXACT sum of these,
          // never accumulated in parallel, so the two can never drift apart
          // even under a future refactor of this loop.
          const rateBp = commissionRates[commissionRateIndex]!;
          commissionRateIndex += 1;
          const lineCommissionPaise = commissionService.commissionPaiseFor(lineTotal, rateBp);

          // Full snapshot: renaming or deleting the product later must not
          // change what this receipt says.
          orderItemData.push({
            variantId: item.sellerListing.variantId,
            sellerListingId: item.sellerListingId,
            productName: product.name,
            variantName: variant.variantName,
            brandName: product.brand?.name ?? null,
            imageUrl: variant.imageUrl ?? variant.images[0]?.url ?? null,
            sku: variant.sku,
            unitDisplay: variant.variantName,
            qty: item.qty,
            mrpPaise: offer.mrpPaise,
            unitPricePaise: offer.pricePaise,
            lineDiscountPaise: Math.max(0, (offer.mrpPaise - offer.pricePaise) * item.qty),
            taxRateBp: product.taxRateBp,
            taxPaise: lineTax,
            lineTotalPaise: lineTotal,
            commissionBp: rateBp,
            commissionPaise: lineCommissionPaise,
            allowCodResolved: resolvedPolicy === CodPolicy.ALLOW,
          });
        }

        // Exact sum of what was just stored on each item — never a
        // separately-maintained running total — so `SellerOrder.
        // commissionPaise` is mechanically guaranteed to equal
        // `sum(items.commissionPaise)` (#1).
        const commissionPaise = orderItemData.reduce((sum, item) => sum + (item.commissionPaise ?? 0), 0);

        sellerOrderInputs.push({
          sellerId,
          itemsSubtotalPaise,
          itemDiscountPaise,
          taxPaise,
          // Tax-inclusive line totals already sum to this seller's true
          // monetary worth — adding taxPaise again would double-count it
          // (tax is EXTRACTED from lineTotalPaise, never added on top).
          subtotalPaise: itemsSubtotalPaise,
          // DERIVED weighted-average for display only (#1) — rounded here,
          // but rounding this display value can never feed back into
          // `commissionPaise` above, which stays exact regardless.
          commissionBp:
            itemsSubtotalPaise > 0 ? Math.round((commissionPaise / itemsSubtotalPaise) * 10_000) : 0,
          commissionPaise,
          items: orderItemData,
        });
      }

      /* --- create -------------------------------------------------------- */
      const order = await tx.order.create({
        data: {
          orderNumber: generateOrderNumber(),
          userId: input.userId,
          addressId: address.id,
          status: parentStatus,
          paymentMethod: input.paymentMethod,
          paymentStatus: OrderPaymentStatus.PENDING,

          itemsSubtotalPaise: bill.itemsSubtotalPaise,
          itemDiscountPaise: bill.itemDiscountPaise,
          couponId: coupon?.id ?? null,
          couponCode: coupon?.code ?? null,
          couponDiscountPaise: bill.couponDiscountPaise,
          deliveryFeePaise: bill.deliveryFeePaise,
          platformFeePaise: bill.platformFeePaise,
          taxPaise: bill.taxPaise,
          totalPaise: bill.totalPaise,
          // Starts equal to the checkout snapshot — drops only if a seller
          // portion is later cancelled/rejected (#9/#20).
          currentPayablePaise: bill.totalPaise,

          // Immutable address snapshot.
          deliveryFullName: address.fullName,
          deliveryMobile: address.mobile,
          deliveryAddressLine: formatAddressLine({
            houseNo: address.houseNo,
            street: address.street,
            area: address.area,
            landmark: address.landmark,
          }),
          deliveryLandmark: address.landmark,
          deliveryCity: address.city,
          deliveryState: address.state,
          deliveryPincode: address.pincode,
          deliveryLatitude: address.latitude,
          deliveryLongitude: address.longitude,

          distanceKm: serviceability.distanceKm,
          etaMinutes: eta.etaMinutes,
          promisedAt: new Date(Date.now() + eta.etaMaxMinutes * 60_000),
          deliveryOtpHash: deliveryOtp ? sha256(deliveryOtp) : null,
          notes: input.notes ?? null,
          idempotencyKey: input.idempotencyKey,

          ...(isCod ? { placedAt: new Date() } : {}),
          ...(isCod
            ? {}
            : {
                reservationExpiresAt: new Date(
                  Date.now() + config.PAYMENT_HOLD_MINUTES * 60_000,
                ),
              }),

          sellerOrders: {
            create: sellerOrderInputs.map((so) => ({
              sellerId: so.sellerId,
              status: SellerOrderStatus.NEW,
              itemsSubtotalPaise: so.itemsSubtotalPaise,
              itemDiscountPaise: so.itemDiscountPaise,
              taxPaise: so.taxPaise,
              subtotalPaise: so.subtotalPaise,
              commissionBp: so.commissionBp,
              commissionPaise: so.commissionPaise,
              items: { createMany: { data: so.items } },
            })),
          },
          statusHistory: {
            create: {
              fromStatus: null,
              toStatus: parentStatus,
              actorType: ActorType.CUSTOMER,
              actorUserId: input.userId,
              reason: 'Order created',
            },
          },
        },
        include: { sellerOrders: true },
      });

      /* --- stock, per seller order --------------------------------------- */
      for (const sellerOrder of order.sellerOrders) {
        const items = itemsBySeller.get(sellerOrder.sellerId)!;
        const reservations = items.map((item) => ({
          sellerListingId: item.sellerListingId,
          variantId: item.sellerListing.variantId,
          qty: item.qty,
        }));

        await inventoryService.reserveStock(tx, reservations, sellerOrder.id);

        if (isCod) {
          // No payment gate, so the goods leave the shelf immediately.
          await inventoryService.commitReservation(
            tx,
            reservations.map((r) => ({ sellerListingId: r.sellerListingId, qty: r.qty })),
            sellerOrder.id,
          );
        }
      }

      /* --- coupon redemption (parent-level) ------------------------------ */
      if (coupon) {
        await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            userId: input.userId,
            orderId: order.id,
            discountPaise: bill.couponDiscountPaise,
          },
        });
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      await cartService.markConverted(cart.id, tx);

      return order;
    },
    // Generous: this transaction locks several sellers' inventory rows and we
    // would rather wait than fail a paying customer.
    { timeoutMs: 15_000 },
  );

  log.info(
    {
      orderId: created.id,
      orderNumber: created.orderNumber,
      totalPaise: created.totalPaise,
      paymentMethod: created.paymentMethod,
      sellerCount: created.sellerOrders.length,
    },
    'order placed',
  );

  // Notifications and socket emits happen AFTER commit — never inside a
  // transaction holding inventory locks.
  await notificationService.notify({
    userId: created.userId,
    type: NotificationType.ORDER_PLACED,
    dedupeKey: `order:${created.id}:placed`,
    orderId: created.id,
    context: { orderNumber: created.orderNumber, totalPaise: created.totalPaise },
  });
  // COD is payable at the door, so sellers can start at once. An ONLINE
  // order reaches its sellers only when payment is confirmed (see
  // order-state.service.ts's dispatchOrderSideEffects).
  if (created.paymentMethod === PaymentMethod.COD) {
    for (const so of created.sellerOrders) {
      await notificationService.notifySeller(so.sellerId, {
        type: NotificationType.SELLER_NEW_ORDER,
        dedupeKey: `so:${so.id}:new`,
        orderId: created.id,
        context: { orderNumber: created.orderNumber, amountPaise: so.subtotalPaise },
      });
    }
  }
  announceNewOrder(created, created.sellerOrders);

  return {
    order: await getOrderDetail(input.userId, created.id, deliveryOtp),
    requiresPayment: created.paymentMethod === PaymentMethod.ONLINE,
  };
}

/* -------------------------------------------------------------------------- */
/* Task 8.4 — reads                                                           */
/* -------------------------------------------------------------------------- */

const ORDER_DETAIL_INCLUDE = {
  sellerOrders: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      seller: { select: { id: true, name: true } },
      items: {
        orderBy: { createdAt: 'asc' as const },
        include: {
          variant: {
            include: {
              images: { orderBy: { displayOrder: 'asc' as const }, take: 1 },
              product: {
                include: { images: { orderBy: { displayOrder: 'asc' as const }, take: 1 } },
              },
            },
          },
        },
      },
    },
  },
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
  address: true,
  deliveryTasks: { include: { agent: true }, orderBy: { assignedAt: 'desc' as const }, take: 1 },
} as const;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;
type SellerOrderWithRelations = OrderWithRelations['sellerOrders'][number];
type OrderItemWithRelations = SellerOrderWithRelations['items'][number];

function resolveItemImage(item: OrderItemWithRelations): string | null {
  return (
    item.imageUrl ??
    item.variant?.imageUrl ??
    item.variant?.images[0]?.url ??
    item.variant?.product.images[0]?.url ??
    null
  );
}

function toOrderItemDto(item: OrderItemWithRelations): OrderItemDto {
  return {
    id: item.id,
    variantId: item.variantId ?? '',
    productName: item.productName,
    variantName: item.variantName,
    brandName: item.brandName,
    imageUrl: resolveItemImage(item),
    sku: item.sku,
    qty: item.qty,
    mrpPaise: item.mrpPaise,
    unitPricePaise: item.unitPricePaise,
    lineDiscountPaise: item.lineDiscountPaise,
    lineTotalPaise: item.lineTotalPaise,
  };
}

function toSellerOrderSummaryDto(sellerOrder: SellerOrderWithRelations): SellerOrderSummaryDto {
  return {
    id: sellerOrder.id,
    sellerId: sellerOrder.sellerId,
    sellerName: sellerOrder.seller.name,
    status: sellerOrder.status,
    statusLabel: SELLER_ORDER_STATUS_LABELS[sellerOrder.status],
    subtotalPaise: sellerOrder.subtotalPaise,
    itemCount: sellerOrder.items.reduce((sum, item) => sum + item.qty, 0),
    items: sellerOrder.items.map(toOrderItemDto),
    rejectionReason: sellerOrder.rejectionReason,
    cancellationReason: sellerOrder.cancellationReason,
  };
}

/**
 * Disambiguates the customer timeline's "PROCESSING" sentinel (see
 * order-state-machine.ts's own doc comment) using the furthest-along
 * ACTIVE (non-cancelled/rejected) SellerOrder — the customer sees whatever
 * progress is real, even if one seller's portion lags or was dropped.
 */
function resolveProcessingSubStep(sellerOrders: SellerOrderWithRelations[]): CustomerTimelineStep {
  const active = sellerOrders.filter(
    (so) => so.status !== SellerOrderStatus.REJECTED && so.status !== SellerOrderStatus.CANCELLED,
  );
  if (active.some((so) => so.status === SellerOrderStatus.PREPARING || so.status === SellerOrderStatus.READY_FOR_PICKUP)) {
    return CustomerTimelineStep.PACKED;
  }
  if (active.some((so) => so.status === SellerOrderStatus.ACCEPTED)) {
    return CustomerTimelineStep.CONFIRMED;
  }
  return CustomerTimelineStep.PLACED;
}

function buildTimeline(order: OrderWithRelations): OrderTimelineEntryDto[] {
  const rawStep = toCustomerTimelineStep(order.status);
  const currentStep = rawStep === 'PROCESSING' ? resolveProcessingSubStep(order.sellerOrders) : rawStep;
  const reachedIndex = currentStep ? CUSTOMER_TIMELINE_STEPS.indexOf(currentStep) : -1;

  // Timestamps come from history, so the timeline shows when each step
  // actually happened rather than a guess.
  const timeFor = (statuses: OrderStatus[]): string | null => {
    const entry = order.statusHistory.find((h) => statuses.includes(h.toStatus));
    return entry ? entry.createdAt.toISOString() : null;
  };

  const stepStatuses: Record<string, OrderStatus[]> = {
    PLACED: [OrderStatus.PAYMENT_CONFIRMED, OrderStatus.PROCESSING],
    CONFIRMED: [OrderStatus.PROCESSING],
    PACKED: [OrderStatus.READY_FOR_PICKUP],
    OUT_FOR_DELIVERY: [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY],
    DELIVERED: [OrderStatus.DELIVERED],
  };

  return CUSTOMER_TIMELINE_STEPS.map((step, index) => ({
    step,
    label: CUSTOMER_TIMELINE_LABELS[step],
    status:
      reachedIndex < 0
        ? 'PENDING'
        : index < reachedIndex
          ? 'COMPLETED'
          : index === reachedIndex
            ? order.status === OrderStatus.DELIVERED
              ? 'COMPLETED'
              : 'IN_PROGRESS'
            : 'PENDING',
    at: timeFor(stepStatuses[step] ?? []),
  }));
}

function toSummary(order: OrderWithRelations): OrderSummaryDto {
  const allItems = order.sellerOrders.flatMap((so) => so.items);
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    bucket: toOrderBucket(order.status),
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalPaise: order.totalPaise,
    currentPayablePaise: order.currentPayablePaise,
    itemCount: allItems.reduce((sum, item) => sum + item.qty, 0),
    lineItemCount: allItems.length,
    itemThumbnails: allItems
      .map(resolveItemImage)
      .filter((url): url is string => url !== null)
      .slice(0, 3),
    sellerCount: order.sellerOrders.length,
    placedAt: (order.placedAt ?? order.createdAt).toISOString(),
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
  };
}

async function canCustomerCancel(order: OrderWithRelations): Promise<boolean> {
  const until = await configService.get(ConfigKey.CANCELLATION_ALLOWED_UNTIL);
  const currentIndex = STATUS_PROGRESSION.indexOf(order.status);
  const limitIndex = STATUS_PROGRESSION.indexOf(until);

  if (order.status === OrderStatus.PENDING_PAYMENT) return true;
  if (currentIndex < 0 || limitIndex < 0) return false;
  // At least one SellerOrder still cancellable by the customer (NEW/ACCEPTED)
  // — a customer whose only remaining seller is already PREPARING has
  // nothing left to self-cancel (#8: the button should not promise
  // something `cancelOrder` below can no longer deliver for anyone).
  const anyCancellable = order.sellerOrders.some(
    (so) => so.status === SellerOrderStatus.NEW || so.status === SellerOrderStatus.ACCEPTED,
  );
  // Inclusive: CANCELLATION_ALLOWED_UNTIL is documented as the LAST status
  // at which a customer may still cancel. V2 folded V1's early statuses
  // (ORDER_PLACED/STORE_ACCEPTED/PREPARING) into PROCESSING — the first entry
  // of STATUS_PROGRESSION — so the V1-era strict `<` against the default
  // PROCESSING made every placed order uncancellable by the customer.
  return currentIndex <= limitIndex && anyCancellable;
}

export async function getOrderDetail(
  userId: string,
  orderId: string,
  plainDeliveryOtp?: string | null,
): Promise<OrderDetailDto> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: ORDER_DETAIL_INCLUDE,
  });

  if (!order) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });

  const deliveryTask = order.deliveryTasks[0];
  const allItems = order.sellerOrders.flatMap((so) => so.items);

  return {
    ...toSummary(order),
    items: allItems.map(toOrderItemDto),
    sellerOrders: order.sellerOrders.map(toSellerOrderSummaryDto),
    bill: {
      itemCount: allItems.reduce((sum, item) => sum + item.qty, 0),
      itemsSubtotalPaise: order.itemsSubtotalPaise,
      itemDiscountPaise: order.itemDiscountPaise,
      couponCode: order.couponCode,
      couponDiscountPaise: order.couponDiscountPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      deliveryFeeWaivedReason: order.deliveryFeePaise === 0 ? 'Free delivery' : null,
      platformFeePaise: order.platformFeePaise,
      taxPaise: order.taxPaise,
      totalPaise: order.totalPaise,
      totalSavingsPaise: order.itemDiscountPaise + order.couponDiscountPaise,
    },
    // The saved address may have been edited or deleted since; the ORDER's
    // snapshot is what is shown.
    deliveryAddress: {
      id: order.addressId ?? '',
      label: order.address?.label ?? 'Delivery address',
      fullName: order.deliveryFullName,
      mobile: order.deliveryMobile,
      houseNo: null,
      street: null,
      area: order.deliveryAddressLine,
      city: order.deliveryCity,
      state: order.deliveryState,
      pincode: order.deliveryPincode,
      landmark: order.deliveryLandmark,
      latitude: order.deliveryLatitude,
      longitude: order.deliveryLongitude,
      isDefault: false,
      isServiceable: true,
      distanceKm: order.distanceKm,
      createdAt: order.createdAt.toISOString(),
    },
    distanceKm: order.distanceKm,
    etaMinutes: order.etaMinutes,
    promisedAt: order.promisedAt?.toISOString() ?? null,
    timeline: buildTimeline(order),
    cancellationReason: order.cancellationReason,
    canCancel: await canCustomerCancel(order),
    deliveryAgent:
      deliveryTask && order.status === OrderStatus.OUT_FOR_DELIVERY
        ? { name: deliveryTask.agent.name, mobile: deliveryTask.agent.mobile }
        : null,
    // Only ever returned at creation time; afterwards only the hash is stored.
    deliveryOtp: plainDeliveryOtp ?? null,
    notes: order.notes,
  };
}

export async function listOrders(
  userId: string,
  options: { status?: OrderStatus; cursor?: string | null; limit: number },
): Promise<CursorPage<OrderSummaryDto>> {
  const orders = await prisma.order.findMany({
    where: {
      userId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    include: ORDER_DETAIL_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = orders.length > options.limit;
  const page = hasMore ? orders.slice(0, options.limit) : orders;
  const last = page[page.length - 1];

  return {
    items: page.map(toSummary),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Cancels an order at the customer's request.
 *
 * V2: this is no longer a single state flip. Before any seller has been
 * engaged (still PENDING_PAYMENT) the whole order cancels via
 * `transitionOrder`, which cascades to every SellerOrder. Once seller
 * portions exist, only the ones STILL in NEW/ACCEPTED are individually
 * cancelled — one seller already PREPARING keeps preparing; the parent's
 * aggregate status (PARTIALLY_CANCELLED vs CANCELLED) is derived from the
 * result, never chosen here directly (#8/#18).
 */
export async function cancelOrder(
  userId: string,
  orderId: string,
  reason: string,
): Promise<OrderDetailDto> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: ORDER_DETAIL_INCLUDE,
  });
  if (!order) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Order not found.' });

  if (!(await canCustomerCancel(order))) {
    throw new AppError(ErrorCode.ORDER_NOT_CANCELLABLE, {
      message: 'This order can no longer be cancelled. Please call the store.',
    });
  }

  if (order.status === OrderStatus.PENDING_PAYMENT) {
    await transitionOrder({
      orderId,
      toStatus: OrderStatus.CANCELLED,
      actorType: ActorType.CUSTOMER,
      actorUserId: userId,
      reason,
    });
  } else {
    const cancellable = order.sellerOrders.filter(
      (so) => so.status === SellerOrderStatus.NEW || so.status === SellerOrderStatus.ACCEPTED,
    );
    for (const sellerOrder of cancellable) {
      await transitionSellerOrder({
        sellerOrderId: sellerOrder.id,
        toStatus: SellerOrderStatus.CANCELLED,
        actorType: ActorType.CUSTOMER,
        actorUserId: userId,
        reason,
      });
    }
  }

  return getOrderDetail(userId, orderId);
}

/** Verifies the delivery OTP the customer reads out at the door (COD). */
export async function verifyDeliveryOtp(orderId: string, submitted: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!order.deliveryOtpHash) return;

  if (!safeEqual(sha256(submitted), order.deliveryOtpHash)) {
    throw new AppError(ErrorCode.DELIVERY_OTP_INVALID);
  }
}

/**
 * Orders and checkout (Tasks 8.2–8.5).
 *
 * `placeOrder` is the most important function in this system. It re-derives
 * EVERY decision from the database inside one transaction with the inventory
 * rows locked — nothing the client sent is trusted, and nothing read outside
 * the lock is relied upon.
 */

import type { Category, Order, Prisma } from '@prisma/client';
import {
  ActorType,
  CodPolicy,
  ConfigKey,
  ErrorCode,
  NotificationType,
  OrderPaymentStatus,
  OrderStatus,
  PaymentMethod,
  STATUS_PROGRESSION,
  CUSTOMER_TIMELINE_LABELS,
  CUSTOMER_TIMELINE_STEPS,
  ORDER_STATUS_LABELS,
  toCustomerTimelineStep,
  toOrderBucket,
  type CheckoutQuoteResponse,
  type CursorPage,
  type OrderDetailDto,
  type OrderSummaryDto,
  type OrderTimelineEntryDto,
} from '../../shared';
import { resolveItemCodPolicy, resolveOrderCodEligibility } from '../../shared/cod';
import { generateOrderNumber, formatAddressLine } from '../../shared/text';
import { extractInclusiveTaxPaise } from '../../shared/money';
import { AppError } from '../../common/errors';
import { randomNumericCode, sha256, safeEqual } from '../../common/crypto';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { moduleLogger } from '../../common/logger';
import * as configService from '../configuration/configuration.service';
import * as storeService from '../stores/store.service';
import * as addressService from '../addresses/address.service';
import * as pricingService from '../pricing/pricing.service';
import * as inventoryService from '../inventory/inventory.service';
import * as cartService from '../cart/cart.service';
import { transitionOrder } from './order-state.service';

const log = moduleLogger('orders');

/* -------------------------------------------------------------------------- */
/* COD resolution (Task 8.3)                                                  */
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

interface CheckoutContext {
  storeId: string;
  addressId: string;
  distanceKm: number;
  items: {
    variantId: string;
    qty: number;
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
  }[];
}

/**
 * Assembles everything checkout needs, WITHOUT side effects.
 *
 * Runs the same validations and the same pricing engine as order creation, so
 * the Review screen shows the server's bill rather than one the client
 * computed. This is why the app never needs to do arithmetic.
 */
async function buildCheckoutContext(
  userId: string,
  addressId: string,
): Promise<CheckoutContext> {
  const store = await storeService.getActiveStore();
  const address = await addressService.getOwnedAddress(userId, addressId);

  // Recomputed here rather than read from the cached flag on the address row.
  const serviceability = await storeService.assertServiceable(
    address.latitude,
    address.longitude,
    store,
  );

  const cart = await prisma.cart.findFirst({
    where: { userId, storeId: store.id, status: 'ACTIVE' },
    include: {
      items: {
        include: {
          variant: {
            include: {
              product: { include: { brand: true } },
              images: { orderBy: { displayOrder: 'asc' }, take: 1 },
            },
          },
        },
      },
    },
  });

  if (!cart || cart.items.length === 0) {
    throw new AppError(ErrorCode.CART_EMPTY);
  }

  return {
    storeId: store.id,
    addressId,
    distanceKm: serviceability.distanceKm,
    items: cart.items.map((item) => ({
      variantId: item.variantId,
      qty: item.qty,
      productName: item.variant.product.name,
      variantName: item.variant.variantName,
      brandName: item.variant.product.brand?.name ?? null,
      imageUrl: item.variant.imageUrl ?? item.variant.images[0]?.url ?? null,
      sku: item.variant.sku,
      unitDisplay: item.variant.variantName,
      taxRateBp: item.variant.product.taxRateBp,
      categoryId: item.variant.product.categoryId,
      productAllowCod: item.variant.product.allowCod,
      variantAllowCod: item.variant.allowCod,
    })),
  };
}

export async function getCheckoutQuote(
  userId: string,
  addressId: string,
  couponCode?: string | null,
): Promise<CheckoutQuoteResponse> {
  const context = await buildCheckoutContext(userId, addressId);
  const store = await storeService.getActiveStore();

  const { dto: cartDto } = await cartService.getCart(userId, {
    distanceKm: context.distanceKm,
  });

  const coupon = couponCode ? await pricingService.resolveCoupon(couponCode, userId) : null;

  const offers = await prisma.storeVariant.findMany({
    where: { storeId: context.storeId, variantId: { in: context.items.map((i) => i.variantId) } },
  });
  const offerByVariant = new Map(offers.map((offer) => [offer.variantId, offer]));

  const { bill } = await pricingService.computeBill({
    items: context.items.map((item) => {
      const offer = offerByVariant.get(item.variantId);
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
          storeVariant: offerByVariant.get(item.variantId)?.allowCod ?? CodPolicy.INHERIT,
          productVariant: item.variantAllowCod,
          product: item.productAllowCod,
          categoryChain: buildCategoryChain(item.categoryId, byId),
          store: store.allowCod,
        },
        config.DEFAULT_COD_POLICY,
      ),
    })),
    storePolicy: store.allowCod,
    defaultPolicy: config.DEFAULT_COD_POLICY,
    orderTotalPaise: bill.totalPaise,
    codMaxOrderValuePaise: config.COD_MAX_ORDER_VALUE_PAISE,
    isFirstOrder: deliveredCount === 0,
    codFirstOrderMaxPaise: config.COD_FIRST_ORDER_MAX_PAISE,
    customerCodBlocked: user.codBlocked,
  });

  const eta = await storeService.estimateEta({
    distanceKm: context.distanceKm,
    itemCount: bill.itemCount,
    storeId: context.storeId,
  });

  const serviceability = await storeService.getServiceability(
    (await addressService.getOwnedAddress(userId, addressId)).latitude,
    (await addressService.getOwnedAddress(userId, addressId)).longitude,
  );

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
  idempotencyKey: string;
}

export interface PlaceOrderResult {
  order: OrderDetailDto;
  /** Present for online orders — the client uses it to start payment. */
  requiresPayment: boolean;
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const store = await storeService.getActiveStore();

  // Cheap checks first, outside the transaction, so a closed store or an
  // out-of-area address never takes inventory locks.
  await storeService.assertStoreAcceptingOrders(store);
  const address = await addressService.getOwnedAddress(input.userId, input.addressId);
  const serviceability = await storeService.assertServiceable(
    address.latitude,
    address.longitude,
    store,
  );

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

  const eta = await storeService.estimateEta({
    distanceKm: serviceability.distanceKm,
    itemCount: 1,
    storeId: store.id,
  });

  let deliveryOtp: string | null = null;

  const created = await runInTransaction(
    async (tx) => {
      /* --- cart ------------------------------------------------------- */
      const cart = await tx.cart.findFirst({
        where: { userId: input.userId, storeId: store.id, status: 'ACTIVE' },
        include: {
          items: {
            include: {
              variant: {
                include: {
                  product: { include: { brand: true } },
                  images: { orderBy: { displayOrder: 'asc' }, take: 1 },
                },
              },
            },
          },
        },
      });

      if (!cart || cart.items.length === 0) throw new AppError(ErrorCode.CART_EMPTY);

      /* --- LOCK inventory --------------------------------------------- */
      // Everything below reads from these locked rows. Prices, stock and COD
      // flags are taken from here, never from the client and never from a read
      // that happened before the lock.
      const variantIds = cart.items.map((item) => item.variantId).sort();
      const offers = await inventoryService.lockOffersForUpdate(tx, store.id, variantIds);

      /* --- per-item validation ---------------------------------------- */
      const priceable: pricingService.PriceableItem[] = [];
      const codItems: { productName: string; resolvedPolicy: CodPolicy }[] = [];
      const reservations: { storeVariantId: string; variantId: string; qty: number }[] = [];
      const orderItemData: Prisma.OrderItemCreateManyOrderInput[] = [];

      for (const item of cart.items) {
        const variant = item.variant;
        const product = variant.product;
        const displayName = `${product.name} ${variant.variantName}`.trim();
        const offer = offers.get(item.variantId);

        if (
          !offer ||
          !offer.isAvailable ||
          product.status !== 'ACTIVE' ||
          variant.status !== 'ACTIVE' ||
          product.deletedAt ||
          variant.deletedAt
        ) {
          throw new AppError(ErrorCode.PRODUCT_UNAVAILABLE, {
            message: `${displayName} is no longer available. Please review your cart.`,
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
                variantId: item.variantId,
                available: offer.availableQty,
              },
            ],
          });
        }

        if (item.qty > offer.maxQtyPerOrder) {
          throw new AppError(ErrorCode.QTY_LIMIT_EXCEEDED, {
            message: `You can order up to ${offer.maxQtyPerOrder} of ${displayName} per order.`,
          });
        }

        const resolvedPolicy = resolveItemCodPolicy(
          {
            storeVariant: offer.allowCod as CodPolicy,
            productVariant: variant.allowCod,
            product: product.allowCod,
            categoryChain: buildCategoryChain(product.categoryId, categoryById),
            store: store.allowCod,
          },
          config.DEFAULT_COD_POLICY,
        );
        codItems.push({ productName: displayName, resolvedPolicy });

        const lineTotal = offer.pricePaise * item.qty;

        priceable.push({
          variantId: item.variantId,
          qty: item.qty,
          mrpPaise: offer.mrpPaise,
          unitPricePaise: offer.pricePaise,
          taxRateBp: product.taxRateBp,
        });

        reservations.push({
          storeVariantId: offer.id,
          variantId: item.variantId,
          qty: item.qty,
        });

        // Full snapshot: renaming or deleting the product later must not
        // change what this receipt says.
        orderItemData.push({
          variantId: item.variantId,
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
          taxPaise: extractInclusiveTaxPaise(lineTotal, product.taxRateBp),
          lineTotalPaise: lineTotal,
          allowCodResolved: resolvedPolicy === CodPolicy.ALLOW,
        });
      }

      /* --- coupon ------------------------------------------------------ */
      // Re-validated INSIDE the transaction: usage limits can only be enforced
      // race-free if the check and the redemption commit together.
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

      // The client's figure is a SAFETY CHECK, never the charged amount. A
      // mismatch means prices moved while they were on the review screen, so
      // they are asked to confirm again rather than silently charged more.
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
          storePolicy: store.allowCod,
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

      /* --- create ------------------------------------------------------ */
      // COD skips PENDING_PAYMENT entirely: there is no payment to wait for.
      const isCod = input.paymentMethod === PaymentMethod.COD;
      const status = isCod ? OrderStatus.ORDER_PLACED : OrderStatus.PENDING_PAYMENT;

      if (isCod && config.DELIVERY_OTP_REQUIRED_FOR_COD) {
        deliveryOtp = randomNumericCode(4);
      }

      const order = await tx.order.create({
        data: {
          orderNumber: generateOrderNumber(),
          userId: input.userId,
          storeId: store.id,
          addressId: address.id,
          status,
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

          items: { createMany: { data: orderItemData } },
          statusHistory: {
            create: {
              fromStatus: null,
              toStatus: status,
              actorType: ActorType.CUSTOMER,
              actorUserId: input.userId,
              reason: 'Order created',
            },
          },
        },
      });

      /* --- stock ------------------------------------------------------- */
      await inventoryService.reserveStock(tx, reservations, order.id);

      if (isCod) {
        // No payment gate, so the goods leave the shelf immediately.
        await inventoryService.commitReservation(
          tx,
          reservations.map((r) => ({ storeVariantId: r.storeVariantId, qty: r.qty })),
          order.id,
        );
      }

      /* --- coupon redemption ------------------------------------------- */
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
    // Generous: this transaction locks several inventory rows and we would
    // rather wait than fail a paying customer.
    { timeoutMs: 15_000 },
  );

  log.info(
    {
      orderId: created.id,
      orderNumber: created.orderNumber,
      totalPaise: created.totalPaise,
      paymentMethod: created.paymentMethod,
    },
    'order placed',
  );

  // Notifications and socket emits happen AFTER commit — never inside a
  // transaction holding inventory locks.
  await queueOrderNotification(created, NotificationType.ORDER_PLACED);

  return {
    order: await getOrderDetail(input.userId, created.id, deliveryOtp),
    requiresPayment: created.paymentMethod === PaymentMethod.ONLINE,
  };
}

/* -------------------------------------------------------------------------- */
/* Notifications (wired fully in Phase 11)                                    */
/* -------------------------------------------------------------------------- */

async function queueOrderNotification(
  order: Order,
  type: NotificationType,
): Promise<void> {
  await prisma.notification
    .create({
      data: {
        userId: order.userId,
        orderId: order.id,
        type,
        title: 'Order update',
        body: `Your order ${order.orderNumber} is ${ORDER_STATUS_LABELS[order.status].toLowerCase()}.`,
      },
    })
    .catch((error) => log.error({ err: error, orderId: order.id }, 'failed to queue notification'));
}

/* -------------------------------------------------------------------------- */
/* Task 8.4 — reads                                                           */
/* -------------------------------------------------------------------------- */

const ORDER_DETAIL_INCLUDE = {
  items: {
    orderBy: { createdAt: 'asc' as const },
    // The row's own `imageUrl` is a snapshot taken at order time, so it stays
    // blank for older orders placed before the product had a photo. Falling
    // back to the variant's current image lets those orders pick one up
    // retroactively instead of showing a placeholder forever.
    //
    // Catalog images are uploaded at the PRODUCT level (catalog.service's
    // `toSummaryDto` reads `product.images[0]`, not the variant) — a variant
    // rarely has its own override image. So the fallback must check the
    // product's gallery too, or an image added in admin never shows up here.
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
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
  address: true,
  assignments: { include: { agent: true }, orderBy: { assignedAt: 'desc' as const }, take: 1 },
} as const;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

function resolveItemImage(item: OrderWithRelations['items'][number]): string | null {
  return (
    item.imageUrl ??
    item.variant?.imageUrl ??
    item.variant?.images[0]?.url ??
    item.variant?.product.images[0]?.url ??
    null
  );
}

function buildTimeline(order: OrderWithRelations): OrderTimelineEntryDto[] {
  const currentStep = toCustomerTimelineStep(order.status);
  const reachedIndex = currentStep ? CUSTOMER_TIMELINE_STEPS.indexOf(currentStep) : -1;

  // Timestamps come from history, so the timeline shows when each step
  // actually happened rather than a guess.
  const timeFor = (statuses: OrderStatus[]): string | null => {
    const entry = order.statusHistory.find((h) => statuses.includes(h.toStatus));
    return entry ? entry.createdAt.toISOString() : null;
  };

  const stepStatuses: Record<string, OrderStatus[]> = {
    PLACED: [OrderStatus.ORDER_PLACED, OrderStatus.PAYMENT_CONFIRMED],
    CONFIRMED: [OrderStatus.STORE_ACCEPTED],
    PACKED: [OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP],
    OUT_FOR_DELIVERY: [OrderStatus.OUT_FOR_DELIVERY],
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
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    bucket: toOrderBucket(order.status),
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalPaise: order.totalPaise,
    itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
    lineItemCount: order.items.length,
    itemThumbnails: order.items
      .map(resolveItemImage)
      .filter((url): url is string => url !== null)
      .slice(0, 3),
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
  return currentIndex < limitIndex;
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

  const assignment = order.assignments[0];

  return {
    ...toSummary(order),
    items: order.items.map((item) => ({
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
    })),
    bill: {
      itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
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
      assignment && order.status === OrderStatus.OUT_FOR_DELIVERY
        ? { name: assignment.agent.name, mobile: assignment.agent.mobile }
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

  await transitionOrder({
    orderId,
    toStatus: OrderStatus.CANCELLED,
    actorType: ActorType.CUSTOMER,
    actorUserId: userId,
    reason,
  });

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

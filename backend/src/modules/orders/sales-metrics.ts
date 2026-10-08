/**
 * The backend's single definition of a sale (see PLACED_ORDER_STATUSES /
 * COMPLETED_SALE_STATUSES in shared/order-state-machine.ts), as Prisma
 * filters — every customer count, "total spent" and revenue figure is built
 * from these and nothing else, so a cancelled, failed or unpaid order can
 * never be counted as a sale in one place and not another.
 *
 * Seller earnings and settlements keep their own, stricter per-SellerOrder
 * rule (seller-settlement.service.ts): the same delivered + paid parent, plus
 * that seller's own portion not cancelled or refunded.
 */

import type { Prisma } from '@prisma/client';
import {
  COMPLETED_SALE_STATUSES,
  OrderPaymentStatus,
  PLACED_ORDER_STATUSES,
} from '../../shared';

/** Orders that count as an order at all (placed, not cancelled/failed/unpaid). */
export const placedOrderWhere: Prisma.OrderWhereInput = {
  status: { in: [...PLACED_ORDER_STATUSES] },
};

/**
 * Completed sales — revenue. Delivered, with the money collected (the same
 * payment condition seller settlement requires).
 */
export const completedSaleWhere: Prisma.OrderWhereInput = {
  status: { in: [...COMPLETED_SALE_STATUSES] },
  paymentStatus: { in: [OrderPaymentStatus.PAID, OrderPaymentStatus.PARTIALLY_REFUNDED] },
};

/** SQL fragments of the same rule, for raw aggregations over `orders o`. */
export const PLACED_ORDER_STATUS_LIST = [...PLACED_ORDER_STATUSES] as string[];
export const COMPLETED_SALE_STATUS_LIST = [...COMPLETED_SALE_STATUSES] as string[];
export const COLLECTED_PAYMENT_STATUS_LIST = [OrderPaymentStatus.PAID, OrderPaymentStatus.PARTIALLY_REFUNDED] as string[];

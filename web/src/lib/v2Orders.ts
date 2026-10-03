/**
 * The V2 order model as the admin panel uses it — tabs, statuses, labels, the
 * next action for each state, and a SAFE view of one order's seller orders.
 *
 * V2 splits a customer's Order into one SellerOrder per seller. Kitchen work
 * (accept / prepare / ready / reject) happens per SellerOrder; the parent's
 * status is recomputed by the server from its SellerOrders, and the only
 * parent transitions an admin makes are the delivery leg (picked up, out for
 * delivery, delivered). See backend/src/shared/order-state-machine.ts.
 *
 * The generated `@shared` copy this panel compiles against is V1-era — its
 * AdminOrderTab (NEW / ACCEPTED / PREPARING / READY), OrderStatus and labels
 * predate V2 — so the V2 values are declared here, and the panel never sends
 * a value the V2 API rejects.
 */

import type { AdminOrderSummaryDto } from '@shared';

/* -------------------------------------------------------------------------- */
/* Parent order                                                               */
/* -------------------------------------------------------------------------- */

export const V2OrderStatus = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PROCESSING: 'PROCESSING',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  PICKED_UP: 'PICKED_UP',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  PARTIALLY_CANCELLED: 'PARTIALLY_CANCELLED',
  CANCELLED: 'CANCELLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type V2OrderStatus = (typeof V2OrderStatus)[keyof typeof V2OrderStatus];

/** V2's own labels (ORDER_STATUS_LABELS in the backend). */
const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting Payment',
  PAYMENT_CONFIRMED: 'Payment Received',
  PROCESSING: 'Processing',
  READY_FOR_PICKUP: 'Ready for Pickup',
  PICKED_UP: 'Picked Up',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  PARTIALLY_CANCELLED: 'Partially Cancelled',
  CANCELLED: 'Cancelled',
  PAYMENT_FAILED: 'Payment Failed',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially Refunded',
};

const ORDER_STATUS_STYLES: Record<string, string> = {
  PENDING_PAYMENT: 'bg-warn-50 text-warn-500',
  PAYMENT_CONFIRMED: 'bg-brand-50 text-brand-600',
  PROCESSING: 'bg-info-50 text-info-500',
  READY_FOR_PICKUP: 'bg-brand-100 text-brand-700',
  PICKED_UP: 'bg-purple-50 text-purple-600',
  OUT_FOR_DELIVERY: 'bg-purple-50 text-purple-600',
  DELIVERED: 'bg-brand-50 text-brand-600',
  PARTIALLY_CANCELLED: 'bg-warn-50 text-warn-500',
  CANCELLED: 'bg-danger-50 text-danger-500',
  PAYMENT_FAILED: 'bg-danger-50 text-danger-500',
  REFUNDED: 'bg-gray-100 text-gray-600',
  PARTIALLY_REFUNDED: 'bg-gray-100 text-gray-600',
};

const NEUTRAL_STYLE = 'bg-gray-100 text-gray-600';

/** "SOME_STATUS" -> "Some status", for a value this table does not know yet. */
function humanize(status: string): string {
  const words = status.toLowerCase().replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Unknown';
}

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? humanize(status);
}

export function orderStatusStyle(status: string): string {
  return ORDER_STATUS_STYLES[status] ?? NEUTRAL_STYLE;
}

/** V2 AdminOrderTab — the only `tab` values GET /admin/orders accepts. */
export const V2_ADMIN_ORDER_TABS = [
  { key: 'PAYMENT_PENDING', label: 'Payment Pending' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'READY_FOR_PICKUP', label: 'Ready for Pickup' },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for Delivery' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CANCELLED', label: 'Cancelled' },
] as const;
export type V2AdminOrderTab = (typeof V2_ADMIN_ORDER_TABS)[number]['key'];

/** GET /admin/orders row: V1's summary plus V2's marketplace fields. */
export type AdminOrderSummaryV2 = Omit<AdminOrderSummaryDto, 'status'> & {
  status: string;
  /** What the customer still pays — drops below totalPaise when a seller's portion is cancelled. */
  currentPayablePaise: number;
  /** Distinct sellers in this order. */
  sellerCount: number;
};

/**
 * The delivery-leg step an admin takes on the PARENT order (V2
 * TRANSITION_ACTORS: READY_FOR_PICKUP -> PICKED_UP -> OUT_FOR_DELIVERY ->
 * DELIVERED). Everything before READY_FOR_PICKUP is per seller order.
 */
export const PARENT_NEXT_ACTION: Partial<
  Record<string, { to: V2OrderStatus; label: string; needsRider?: boolean }>
> = {
  READY_FOR_PICKUP: { to: 'PICKED_UP', label: 'Mark picked up', needsRider: true },
  PICKED_UP: { to: 'OUT_FOR_DELIVERY', label: 'Send out', needsRider: true },
  // No delivery OTP: V2 marks an order delivered without one.
  OUT_FOR_DELIVERY: { to: 'DELIVERED', label: 'Mark delivered' },
};

/* -------------------------------------------------------------------------- */
/* Seller order                                                               */
/* -------------------------------------------------------------------------- */

export const SellerOrderStatus = {
  NEW: 'NEW',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY_FOR_PICKUP: 'READY_FOR_PICKUP',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;
export type SellerOrderStatus = (typeof SellerOrderStatus)[keyof typeof SellerOrderStatus];

const SELLER_ORDER_STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready for Pickup',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const SELLER_ORDER_STATUS_STYLES: Record<string, string> = {
  NEW: 'bg-info-50 text-info-500',
  ACCEPTED: 'bg-brand-50 text-brand-600',
  PREPARING: 'bg-warn-50 text-warn-500',
  READY_FOR_PICKUP: 'bg-brand-100 text-brand-700',
  REJECTED: 'bg-danger-50 text-danger-500',
  CANCELLED: 'bg-danger-50 text-danger-500',
};

export function sellerOrderStatusLabel(status: string): string {
  return SELLER_ORDER_STATUS_LABELS[status] ?? humanize(status);
}

export function sellerOrderStatusStyle(status: string): string {
  return SELLER_ORDER_STATUS_STYLES[status] ?? NEUTRAL_STYLE;
}

/**
 * The one forward step for a seller order (V2 ALLOWED_SELLER_ORDER_TRANSITIONS,
 * admin-permitted). Sent to PATCH /admin/seller-orders/:id/status.
 */
export const SELLER_ORDER_NEXT_ACTION: Partial<
  Record<string, { to: SellerOrderStatus; label: string }>
> = {
  NEW: { to: 'ACCEPTED', label: 'Accept' },
  ACCEPTED: { to: 'PREPARING', label: 'Start preparing' },
  PREPARING: { to: 'READY_FOR_PICKUP', label: 'Mark ready' },
};

/* -------------------------------------------------------------------------- */
/* Safe order detail                                                          */
/* -------------------------------------------------------------------------- */

export interface SellerOrderItemView {
  id: string;
  productName: string;
  variantName: string;
  qty: number;
  lineTotalPaise: number;
}

export interface SellerOrderView {
  id: string;
  sellerName: string;
  status: string;
  subtotalPaise: number;
  items: SellerOrderItemView[];
  rejectionReason: string | null;
  cancellationReason: string | null;
}

export interface AdminOrderDetailView {
  id: string;
  orderNumber: string;
  status: string;
  totalPaise: number;
  currentPayablePaise: number;
  sellerOrders: SellerOrderView[];
}

export class OrderDetailShapeError extends Error {
  constructor() {
    super('The order came back in an unexpected format. Please refresh.');
    this.name = 'OrderDetailShapeError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string {
  if (typeof value !== 'string') throw new OrderDetailShapeError();
  return value;
}
function num(value: unknown): number {
  if (typeof value !== 'number') throw new OrderDetailShapeError();
  return value;
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * GET /admin/orders/:id answers with the full database record — including
 * fields such as `deliveryOtpHash`, `idempotencyKey`, payments and the user
 * row. This keeps ONLY what the Orders screen shows, so nothing else is held
 * in the query cache or can reach the UI.
 */
export function toAdminOrderDetailView(raw: unknown): AdminOrderDetailView {
  if (!isRecord(raw) || !Array.isArray(raw['sellerOrders'])) throw new OrderDetailShapeError();

  return {
    id: str(raw['id']),
    orderNumber: str(raw['orderNumber']),
    status: str(raw['status']),
    totalPaise: num(raw['totalPaise']),
    currentPayablePaise: num(raw['currentPayablePaise']),
    sellerOrders: raw['sellerOrders'].map((so: unknown): SellerOrderView => {
      if (!isRecord(so)) throw new OrderDetailShapeError();
      const seller = isRecord(so['seller']) ? so['seller'] : null;
      const items = Array.isArray(so['items']) ? so['items'] : [];
      return {
        id: str(so['id']),
        sellerName: strOrNull(seller?.['name']) ?? 'Seller',
        status: str(so['status']),
        subtotalPaise: num(so['subtotalPaise']),
        items: items.map((item: unknown): SellerOrderItemView => {
          if (!isRecord(item)) throw new OrderDetailShapeError();
          return {
            id: str(item['id']),
            productName: str(item['productName']),
            variantName: typeof item['variantName'] === 'string' ? item['variantName'] : '',
            qty: num(item['qty']),
            lineTotalPaise: num(item['lineTotalPaise']),
          };
        }),
        rejectionReason: strOrNull(so['rejectionReason']),
        cancellationReason: strOrNull(so['cancellationReason']),
      };
    }),
  };
}

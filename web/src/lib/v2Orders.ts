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

/**
 * The tabs the Orders page shows. Payment Pending only where an admin acts on
 * it — the legacy direct-UPI mode, where the store confirms each payment by
 * hand (GET /admin/payment-mode `manualConfirmation`). With Cashfree an
 * unpaid checkout is not an order to work on: it settles (or expires) by
 * itself and is tracked in Payments. The backend tab stays for compatibility.
 */
export function visibleAdminOrderTabs(manualPaymentConfirmation: boolean) {
  return V2_ADMIN_ORDER_TABS.filter((item) => manualPaymentConfirmation || item.key !== 'PAYMENT_PENDING');
}

/**
 * Tabs with a count badge. `urgent` (red) only for Payment Pending in
 * direct-UPI mode — a payment the store must check; a normal Cashfree
 * checkout in progress never raises one.
 */
export function orderBadgeTabs(manualPaymentConfirmation: boolean): { key: V2AdminOrderTab; urgent: boolean }[] {
  return [
    ...(manualPaymentConfirmation ? [{ key: 'PAYMENT_PENDING' as const, urgent: true }] : []),
    { key: 'PROCESSING', urgent: false },
    { key: 'READY_FOR_PICKUP', urgent: false },
  ];
}

/** The tab an order of this status is listed under (a "View order" link opens it there). */
export function adminOrderTabOf(status: string): V2AdminOrderTab {
  switch (status) {
    case 'PENDING_PAYMENT':
      return 'PAYMENT_PENDING';
    case 'READY_FOR_PICKUP':
      return 'READY_FOR_PICKUP';
    case 'PICKED_UP':
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY';
    case 'DELIVERED':
      return 'COMPLETED';
    case 'CANCELLED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'CANCELLED';
    default:
      return 'PROCESSING';
  }
}

/** The tab to open: the requested one (e.g. a Dashboard link's ?tab=) when shown, else Processing. */
export function resolveAdminOrderTab(requested: string | null | undefined, manualPaymentConfirmation: boolean): V2AdminOrderTab {
  return visibleAdminOrderTabs(manualPaymentConfirmation).find((item) => item.key === requested)?.key ?? 'PROCESSING';
}

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

/** A line's measurable size from its variant's structured unit (GET /admin/orders/:id `measure`). */
export interface OrderMeasure {
  unit: string;
  unitValue: number;
}

export interface SellerOrderItemView {
  id: string;
  productName: string;
  /** The size / pack the customer chose, as ordered ("500 g", "1 kg", "Pack of 6"). */
  variantName: string;
  brandName: string | null;
  /** The product photo as it was when ordered (order item snapshot). */
  imageUrl: string | null;
  /** Option picks as ordered — [["Size", "M"], ["Color", "Black"]]; [] for a simple item. */
  options: [string, string][];
  sku: string | null;
  /** How many of that size were ordered. */
  qty: number;
  mrpPaise: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  /** Null when the size is not a measurable weight / volume, or the variant changed since. */
  measure: OrderMeasure | null;
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

export interface AdminOrderBillView {
  /** Items at their selling prices. */
  itemsSubtotalPaise: number;
  /** What the customer saved against MRP (already inside the selling prices). */
  mrpSavingsPaise: number;
  couponCode: string | null;
  couponDiscountPaise: number;
  deliveryFeePaise: number;
  platformFeePaise: number;
  /** Tax included in the item prices (shown for information, never added again). */
  taxPaise: number;
  totalPaise: number;
}

export interface AdminPaymentAttemptView {
  id: string;
  provider: string;
  /** upi / card / wallet / netbanking … as the gateway reported it; null when not known. */
  method: string | null;
  status: string;
  amountPaise: number;
  /** The gateway's payment id, else its order id. */
  reference: string | null;
  failureReason: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export interface AdminRefundRowView {
  id: string;
  amountPaise: number;
  status: string;
  component: string | null;
  reason: string | null;
  failureReason: string | null;
  reference: string | null;
  createdAt: string;
  completedAt: string | null;
  groupId: string | null;
  retryOfId: string | null;
}

export interface AdminHistoryEntryView {
  id: string;
  at: string;
  /** "Order" for the whole order, else the seller's name. */
  scope: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorName: string | null;
  reason: string | null;
}

export interface AdminOrderDetailView {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  /** When it was placed (placedAt, else when it was created). */
  placedAt: string;
  totalPaise: number;
  currentPayablePaise: number;
  bill: AdminOrderBillView;
  customer: { name: string | null; mobile: string | null; email: string | null };
  delivery: {
    name: string;
    mobile: string;
    label: string | null;
    addressLine: string;
    landmark: string | null;
    city: string;
    district: string | null;
    state: string;
    pincode: string;
    mode: string;
    latitude: number | null;
    longitude: number | null;
    notes: string | null;
    agentName: string | null;
  };
  cancellationReason: string | null;
  sellerOrders: SellerOrderView[];
  payments: AdminPaymentAttemptView[];
  refunds: AdminRefundRowView[];
  history: AdminHistoryEntryView[];
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
/** Optional money / counts: older orders may not carry the field — 0, never NaN. */
function numOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function toMeasure(value: unknown): OrderMeasure | null {
  if (!isRecord(value)) return null;
  const unit = strOrNull(value['unit']);
  const unitValue = numOrNull(value['unitValue']);
  return unit && unitValue !== null && unitValue > 0 ? { unit, unitValue } : null;
}

function toItem(item: unknown): SellerOrderItemView {
  if (!isRecord(item)) throw new OrderDetailShapeError();
  return {
    id: str(item['id']),
    productName: str(item['productName']),
    variantName: typeof item['variantName'] === 'string' ? item['variantName'] : '',
    brandName: strOrNull(item['brandName']),
    imageUrl: strOrNull(item['imageUrl']),
    options: isRecord(item['optionValues'])
      ? Object.entries(item['optionValues']).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
        )
      : [],
    sku: strOrNull(item['sku']),
    qty: num(item['qty']),
    mrpPaise: numOr0(item['mrpPaise']),
    unitPricePaise: numOr0(item['unitPricePaise']),
    lineTotalPaise: num(item['lineTotalPaise']),
    measure: toMeasure(item['measure']),
  };
}

function actorOf(entry: Json): { actorType: string; actorName: string | null } {
  const actor = isRecord(entry['actor']) ? entry['actor'] : null;
  return { actorType: strOrNull(entry['actorType']) ?? 'SYSTEM', actorName: strOrNull(actor?.['fullName']) };
}

/**
 * GET /admin/orders/:id answers with the full database record — including
 * fields such as `deliveryOtpHash`, `idempotencyKey`, payment payloads and
 * whole user rows (history actors). This keeps ONLY what the order details
 * show, so nothing else is held in the query cache or can reach the UI:
 * never a payment's raw payload, an OTP hash or an actor's account fields
 * beyond the name.
 */
export function toAdminOrderDetailView(raw: unknown): AdminOrderDetailView {
  if (!isRecord(raw) || !Array.isArray(raw['sellerOrders'])) throw new OrderDetailShapeError();

  const user = isRecord(raw['user']) ? raw['user'] : null;
  const sellerOrderRecords = records(raw['sellerOrders']);
  const sellerNameById = new Map<string, string>();

  const sellerOrders = raw['sellerOrders'].map((so: unknown): SellerOrderView => {
    if (!isRecord(so)) throw new OrderDetailShapeError();
    const seller = isRecord(so['seller']) ? so['seller'] : null;
    const sellerName = strOrNull(seller?.['name']) ?? 'Seller';
    sellerNameById.set(str(so['id']), sellerName);
    return {
      id: str(so['id']),
      sellerName,
      status: str(so['status']),
      subtotalPaise: num(so['subtotalPaise']),
      items: (Array.isArray(so['items']) ? so['items'] : []).map(toItem),
      rejectionReason: strOrNull(so['rejectionReason']),
      cancellationReason: strOrNull(so['cancellationReason']),
    };
  });

  const history: AdminHistoryEntryView[] = [
    ...records(raw['statusHistory']).map((entry) => ({
      id: str(entry['id']),
      at: str(entry['createdAt']),
      scope: 'Order',
      fromStatus: strOrNull(entry['fromStatus']),
      toStatus: str(entry['toStatus']),
      ...actorOf(entry),
      reason: strOrNull(entry['reason']),
    })),
    ...sellerOrderRecords.flatMap((so) =>
      records(so['statusHistory']).map((entry) => ({
        id: str(entry['id']),
        at: str(entry['createdAt']),
        scope: sellerNameById.get(str(so['id'])) ?? 'Seller',
        fromStatus: strOrNull(entry['fromStatus']),
        toStatus: str(entry['toStatus']),
        ...actorOf(entry),
        reason: strOrNull(entry['reason']),
      })),
    ),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const deliveryTask = records(raw['deliveryTasks'])[0];
  const agent = deliveryTask && isRecord(deliveryTask['agent']) ? deliveryTask['agent'] : null;

  return {
    id: str(raw['id']),
    orderNumber: str(raw['orderNumber']),
    status: str(raw['status']),
    paymentMethod: strOrNull(raw['paymentMethod']) ?? 'COD',
    paymentStatus: strOrNull(raw['paymentStatus']) ?? 'PENDING',
    placedAt: strOrNull(raw['placedAt']) ?? str(raw['createdAt']),
    totalPaise: num(raw['totalPaise']),
    currentPayablePaise: num(raw['currentPayablePaise']),
    bill: {
      itemsSubtotalPaise: numOr0(raw['itemsSubtotalPaise']),
      mrpSavingsPaise: numOr0(raw['itemDiscountPaise']),
      couponCode: strOrNull(raw['couponCode']),
      couponDiscountPaise: numOr0(raw['couponDiscountPaise']),
      deliveryFeePaise: numOr0(raw['deliveryFeePaise']),
      platformFeePaise: numOr0(raw['platformFeePaise']),
      taxPaise: numOr0(raw['taxPaise']),
      totalPaise: num(raw['totalPaise']),
    },
    customer: {
      name: strOrNull(user?.['fullName']),
      mobile: strOrNull(user?.['mobile']),
      email: strOrNull(user?.['email']),
    },
    delivery: {
      name: strOrNull(raw['deliveryFullName']) ?? '',
      mobile: strOrNull(raw['deliveryMobile']) ?? '',
      label: strOrNull(raw['deliveryLabel']),
      addressLine: strOrNull(raw['deliveryAddressLine']) ?? '',
      landmark: strOrNull(raw['deliveryLandmark']),
      city: strOrNull(raw['deliveryCity']) ?? '',
      district: strOrNull(raw['deliveryDistrict']),
      state: strOrNull(raw['deliveryState']) ?? '',
      pincode: strOrNull(raw['deliveryPincode']) ?? '',
      mode: strOrNull(raw['deliveryMode']) ?? 'SAVED_ADDRESS',
      latitude: numOrNull(raw['deliveryLatitude']),
      longitude: numOrNull(raw['deliveryLongitude']),
      notes: strOrNull(raw['notes']),
      agentName: strOrNull(agent?.['name']),
    },
    cancellationReason: strOrNull(raw['cancellationReason']),
    sellerOrders,
    payments: records(raw['payments'])
      .map((payment) => ({
        id: str(payment['id']),
        provider: strOrNull(payment['provider']) ?? '',
        method: strOrNull(payment['method']),
        status: str(payment['status']),
        amountPaise: numOr0(payment['amountPaise']),
        reference: strOrNull(payment['providerPaymentId']) ?? strOrNull(payment['providerOrderId']),
        failureReason: strOrNull(payment['failureReason']),
        capturedAt: strOrNull(payment['capturedAt']),
        createdAt: str(payment['createdAt']),
      }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    refunds: records(raw['refunds'])
      .map((refund) => ({
        id: str(refund['id']),
        amountPaise: numOr0(refund['amountPaise']),
        status: str(refund['status']),
        component: strOrNull(refund['componentType']),
        reason: strOrNull(refund['reason']),
        failureReason: strOrNull(refund['failureReason']),
        reference: strOrNull(refund['providerRefundId']),
        createdAt: str(refund['createdAt']),
        completedAt: strOrNull(refund['completedAt']),
        groupId: strOrNull(refund['groupId']),
        retryOfId: strOrNull(refund['retryOfId']),
      }))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    history,
  };
}

/* -------------------------------------------------------------------------- */
/* Display rules (pure)                                                       */
/* -------------------------------------------------------------------------- */

const MEASURED: Record<string, { base: string; big: string }> = {
  G: { base: 'g', big: 'kg' },
  KG: { base: 'g', big: 'kg' },
  ML: { base: 'ml', big: 'L' },
  L: { base: 'ml', big: 'L' },
};

function trimNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The total weight / volume of a line — its size × the ordered quantity
 * ("500 g" × 2 = "1 kg", "250 ml" × 3 = "750 ml") — from the variant's
 * structured unit, never from a name. Null when the size is not a weight or
 * volume (pieces, packs: the quantity already says it) or not known.
 */
export function lineTotalMeasure(measure: OrderMeasure | null, qty: number): string | null {
  if (!measure || qty <= 0) return null;
  const kind = MEASURED[measure.unit];
  if (!kind) return null;
  const inBase = measure.unit === 'KG' || measure.unit === 'L' ? measure.unitValue * 1000 * qty : measure.unitValue * qty;
  return inBase >= 1000 ? `${trimNumber(inBase / 1000)} ${kind.big}` : `${trimNumber(inBase)} ${kind.base}`;
}

const INSTRUMENT_LABELS: Record<string, string> = {
  upi: 'UPI',
  card: 'Card',
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  wallet: 'Wallet',
  app: 'Wallet',
  netbanking: 'Net banking',
  net_banking: 'Net banking',
  emi: 'EMI',
  paylater: 'Pay later',
  pay_later: 'Pay later',
};

/** "Cash on Delivery", or "Online · UPI" when the gateway said how it was paid. */
export function paymentMethodLabel(paymentMethod: string, payments: readonly Pick<AdminPaymentAttemptView, 'method' | 'status'>[]): string {
  if (paymentMethod === 'COD') return 'Cash on Delivery';
  // The instrument of the payment that went through, else the latest attempt that names one.
  const captured = payments.find((payment) => payment.status === 'CAPTURED' && payment.method);
  const named = captured ?? [...payments].reverse().find((payment) => payment.method);
  const method = named?.method?.toLowerCase();
  return method ? `Online · ${INSTRUMENT_LABELS[method] ?? humanize(method)}` : 'Online payment';
}

const PAYMENT_STATUS_LABELS: Record<string, { label: string; tone: 'brand' | 'amber' | 'red' | 'gray' }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  PAID: { label: 'Paid', tone: 'brand' },
  FAILED: { label: 'Failed', tone: 'red' },
  REFUNDED: { label: 'Refunded', tone: 'gray' },
  PARTIALLY_REFUNDED: { label: 'Partially refunded', tone: 'gray' },
};

/**
 * The ORDER's payment status as the server decided it (Order.paymentStatus —
 * PAID only after the server verified the payment), never an attempt's.
 * Cash on delivery not yet collected reads "To collect on delivery".
 */
export function paymentStatusView(paymentMethod: string, paymentStatus: string): { label: string; tone: 'brand' | 'amber' | 'red' | 'gray' } {
  if (paymentMethod === 'COD' && paymentStatus === 'PENDING') return { label: 'To collect on delivery', tone: 'amber' };
  return PAYMENT_STATUS_LABELS[paymentStatus] ?? { label: humanize(paymentStatus), tone: 'gray' };
}

export interface CustomerRefundView {
  id: string;
  amountPaise: number;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  /** What the refund was for, from its parts (Items, Delivery fee, Platform fee …). */
  parts: string[];
  reason: string | null;
  reference: string | null;
  at: string;
}

const COMPONENT_LABELS: Record<string, string> = {
  SELLER_PRODUCT: 'Items',
  DELIVERY_FEE: 'Delivery fee',
  PLATFORM_FEE: 'Platform fee',
  ORDER_FEES: 'Fees',
  FULL_ORDER: 'Whole order',
  ORPHAN_PAYMENT: 'Payment without an order',
};

/**
 * The refunds as the CUSTOMER got them: one entry per refund the customer
 * receives (a refund group's parts — items of each seller, delivery fee,
 * platform fee — together), a failed attempt that was retried counted once
 * (by its retry), and the totals of what was refunded and what is still on
 * its way. Seller-side deductions are not refunds and never appear here.
 */
export function customerRefunds(rows: readonly AdminRefundRowView[]): {
  refunds: CustomerRefundView[];
  refundedPaise: number;
  pendingPaise: number;
} {
  const retried = new Set(rows.map((row) => row.retryOfId).filter((id): id is string => id !== null));
  const live = rows.filter((row) => !retried.has(row.id));
  const groups = new Map<string, AdminRefundRowView[]>();
  for (const row of live) {
    const key = row.groupId ?? row.id;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const statusOf = (parts: AdminRefundRowView[]): CustomerRefundView['status'] =>
    parts.every((part) => part.status === 'COMPLETED') ? 'COMPLETED' : parts.some((part) => part.status === 'FAILED') ? 'FAILED' : 'PENDING';
  const refunds = [...groups.entries()].map(([key, parts]) => ({
    id: key,
    amountPaise: parts.reduce((sum, part) => sum + part.amountPaise, 0),
    status: statusOf(parts),
    parts: [...new Set(parts.map((part) => (part.component ? COMPONENT_LABELS[part.component] ?? humanize(part.component) : 'Refund')))],
    reason: parts.find((part) => part.reason)?.reason ?? null,
    reference: parts.length === 1 ? parts[0]!.reference : null,
    at: parts.reduce((latest, part) => (part.completedAt ?? part.createdAt) > latest ? (part.completedAt ?? part.createdAt) : latest, ''),
  }));
  return {
    refunds,
    refundedPaise: live.filter((row) => row.status === 'COMPLETED').reduce((sum, row) => sum + row.amountPaise, 0),
    pendingPaise: live.filter((row) => row.status === 'PENDING' || row.status === 'PROCESSING').reduce((sum, row) => sum + row.amountPaise, 0),
  };
}

/** Distinct products and total units across an order's lines. */
export function orderItemTotals(sellerOrders: readonly Pick<SellerOrderView, 'items'>[]): { products: number; units: number } {
  const items = sellerOrders.flatMap((so) => so.items);
  return { products: items.length, units: items.reduce((sum, item) => sum + item.qty, 0) };
}

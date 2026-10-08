/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Order state machines — the single definition of which order transitions are
 * legal, who may perform them, and how internal states are presented to the
 * customer.
 *
 * V2 has TWO machines, not one:
 *   - SellerOrderStatus: one seller's portion. NEW -> ACCEPTED -> PREPARING ->
 *     READY_FOR_PICKUP, or -> REJECTED/CANCELLED at any point before pickup.
 *     This is where V1's single per-order machine actually lives now.
 *   - OrderStatus: the parent, customer-facing envelope. Coarser, and mostly
 *     SYSTEM-driven — it's recomputed from the aggregate of its SellerOrders
 *     (see order.service.ts's `recomputeParentOrderStatus`) rather than
 *     transitioned directly the way a SellerOrder is.
 *
 * `transitionSellerOrder()`/`transitionOrder()` (order.service.ts) are the
 * ONLY code permitted to write `seller_orders.status`/`orders.status`, and
 * both validate against the tables below.
 */

import {
  ActorType,
  OrderStatus,
  SellerOrderStatus,
  TERMINAL_ORDER_STATUSES,
  TERMINAL_SELLER_ORDER_STATUSES,
} from "./enums";

/* -------------------------------------------------------------------------- */
/* SellerOrder — the per-seller machine                                       */
/* -------------------------------------------------------------------------- */

export const ALLOWED_SELLER_ORDER_TRANSITIONS: Readonly<
  Record<SellerOrderStatus, readonly SellerOrderStatus[]>
> = {
  [SellerOrderStatus.NEW]: [
    SellerOrderStatus.ACCEPTED,
    SellerOrderStatus.REJECTED,
    SellerOrderStatus.CANCELLED,
  ],
  [SellerOrderStatus.ACCEPTED]: [
    SellerOrderStatus.PREPARING,
    SellerOrderStatus.CANCELLED,
  ],
  [SellerOrderStatus.PREPARING]: [
    SellerOrderStatus.READY_FOR_PICKUP,
    SellerOrderStatus.CANCELLED,
  ],
  // Cancellable even once ready — a rider delay or a last-minute stock
  // problem can still require pulling this portion back before pickup.
  [SellerOrderStatus.READY_FOR_PICKUP]: [SellerOrderStatus.CANCELLED],
  [SellerOrderStatus.REJECTED]: [],
  [SellerOrderStatus.CANCELLED]: [],
};

/**
 * Which actors may perform a given SellerOrder transition.
 *
 * NEW/ACCEPTED are cancellable by the CUSTOMER (the seller hasn't started
 * work yet, or has only just confirmed) as well as the SELLER/ADMIN.
 * PREPARING onward is SELLER/ADMIN only — work is already underway, so a
 * customer-initiated cancellation past this point must go through support.
 */
export const SELLER_ORDER_TRANSITION_ACTORS: Readonly<
  Partial<Record<`${SellerOrderStatus}->${SellerOrderStatus}`, readonly ActorType[]>>
> = {
  "NEW->ACCEPTED": [ActorType.SELLER, ActorType.ADMIN],
  "NEW->REJECTED": [ActorType.SELLER, ActorType.ADMIN],
  "NEW->CANCELLED": [ActorType.CUSTOMER, ActorType.SELLER, ActorType.ADMIN],
  "ACCEPTED->PREPARING": [ActorType.SELLER, ActorType.ADMIN],
  "ACCEPTED->CANCELLED": [ActorType.CUSTOMER, ActorType.SELLER, ActorType.ADMIN],
  "PREPARING->READY_FOR_PICKUP": [ActorType.SELLER, ActorType.ADMIN],
  "PREPARING->CANCELLED": [ActorType.SELLER, ActorType.ADMIN],
  "READY_FOR_PICKUP->CANCELLED": [ActorType.ADMIN],
};

export function canTransitionSellerOrder(
  from: SellerOrderStatus,
  to: SellerOrderStatus,
): boolean {
  return (ALLOWED_SELLER_ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalSellerOrderStatus(status: SellerOrderStatus): boolean {
  return TERMINAL_SELLER_ORDER_STATUSES.includes(status);
}

export function canActorTransitionSellerOrder(
  from: SellerOrderStatus,
  to: SellerOrderStatus,
  actor: ActorType,
): boolean {
  if (!canTransitionSellerOrder(from, to)) return false;
  const allowed = SELLER_ORDER_TRANSITION_ACTORS[`${from}->${to}`];
  return allowed ? allowed.includes(actor) : actor === ActorType.SYSTEM;
}

/** Short, user-safe label for a seller-order status (seller panel badges). */
export const SELLER_ORDER_STATUS_LABELS: Readonly<Record<SellerOrderStatus, string>> = {
  [SellerOrderStatus.NEW]: "New",
  [SellerOrderStatus.ACCEPTED]: "Accepted",
  [SellerOrderStatus.PREPARING]: "Preparing",
  [SellerOrderStatus.READY_FOR_PICKUP]: "Ready for Pickup",
  [SellerOrderStatus.REJECTED]: "Rejected",
  [SellerOrderStatus.CANCELLED]: "Cancelled",
};

/* -------------------------------------------------------------------------- */
/* Order — the parent, customer-facing machine                               */
/* -------------------------------------------------------------------------- */

/**
 * Most of these are reached by `recomputeParentOrderStatus`, not chosen
 * directly by an actor — e.g. PROCESSING -> READY_FOR_PICKUP happens the
 * instant the last required SellerOrder reaches READY_FOR_PICKUP. Only the
 * payment and delivery-leg edges are actor-driven in the usual sense.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.PAYMENT_CONFIRMED,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PAYMENT_CONFIRMED]: [OrderStatus.PROCESSING],
  [OrderStatus.PROCESSING]: [
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.PARTIALLY_CANCELLED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PARTIALLY_CANCELLED]: [
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.READY_FOR_PICKUP]: [OrderStatus.PICKED_UP],
  [OrderStatus.PICKED_UP]: [OrderStatus.OUT_FOR_DELIVERY],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.DELIVERED],
  // Terminal states. REFUNDED is reachable only once the money is actually
  // back with the customer.
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUNDED],
  [OrderStatus.PAYMENT_FAILED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.PARTIALLY_REFUNDED]: [OrderStatus.REFUNDED],
};

export const TRANSITION_ACTORS: Readonly<
  Partial<Record<`${OrderStatus}->${OrderStatus}`, readonly ActorType[]>>
> = {
  "PENDING_PAYMENT->PAYMENT_CONFIRMED": [
    ActorType.SYSTEM,
    ActorType.PAYMENT_WEBHOOK,
    ActorType.ADMIN,
  ],
  "PENDING_PAYMENT->PAYMENT_FAILED": [
    ActorType.SYSTEM,
    ActorType.PAYMENT_WEBHOOK,
  ],
  "PENDING_PAYMENT->CANCELLED": [ActorType.CUSTOMER, ActorType.SYSTEM],
  "PAYMENT_CONFIRMED->PROCESSING": [ActorType.SYSTEM, ActorType.PAYMENT_WEBHOOK],
  // Every one of these is the SYSTEM reacting to a SellerOrder change, not a
  // human choosing the parent's status directly.
  "PROCESSING->READY_FOR_PICKUP": [ActorType.SYSTEM],
  "PROCESSING->PARTIALLY_CANCELLED": [ActorType.SYSTEM],
  "PROCESSING->CANCELLED": [ActorType.SYSTEM],
  "PARTIALLY_CANCELLED->READY_FOR_PICKUP": [ActorType.SYSTEM],
  "PARTIALLY_CANCELLED->CANCELLED": [ActorType.SYSTEM],
  "READY_FOR_PICKUP->PICKED_UP": [ActorType.ADMIN, ActorType.DELIVERY_AGENT],
  "PICKED_UP->OUT_FOR_DELIVERY": [ActorType.ADMIN, ActorType.DELIVERY_AGENT],
  "OUT_FOR_DELIVERY->DELIVERED": [ActorType.ADMIN, ActorType.DELIVERY_AGENT],
  "CANCELLED->REFUNDED": [ActorType.SYSTEM, ActorType.PAYMENT_WEBHOOK],
  "PARTIALLY_REFUNDED->REFUNDED": [ActorType.SYSTEM, ActorType.PAYMENT_WEBHOOK],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

export function canActorTransition(
  from: OrderStatus,
  to: OrderStatus,
  actor: ActorType,
): boolean {
  if (!canTransition(from, to)) return false;
  const allowed = TRANSITION_ACTORS[`${from}->${to}`];
  // Absence of an entry means "system only" — fail closed, never open.
  return allowed ? allowed.includes(actor) : actor === ActorType.SYSTEM;
}

/**
 * Statuses an order must have passed through for a given status to be
 * reached. Used to render the completed portion of the tracking timeline,
 * and to gate customer self-cancellation (see order.service's
 * `canCustomerCancel`).
 */
export const STATUS_PROGRESSION: readonly OrderStatus[] = [
  OrderStatus.PROCESSING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

/* -------------------------------------------------------------------------- */
/* Customer-facing timeline (deviation D5)                                     */
/* -------------------------------------------------------------------------- */

/**
 * The mockups show a 5-step timeline. Internally we track more states than
 * that (plus a whole second machine for SellerOrders) — there is no
 * "Packed" state, for example; PROCESSING and READY_FOR_PICKUP both present
 * as "Order Packed" once the customer has at least one accepted SellerOrder.
 *
 * Mapping here, in one place, is what lets us keep a precise internal machine
 * without ever making a client switch on a raw status string.
 */
export const CustomerTimelineStep = {
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  PACKED: "PACKED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
} as const;
export type CustomerTimelineStep =
  (typeof CustomerTimelineStep)[keyof typeof CustomerTimelineStep];

export const CUSTOMER_TIMELINE_STEPS: readonly CustomerTimelineStep[] = [
  CustomerTimelineStep.PLACED,
  CustomerTimelineStep.CONFIRMED,
  CustomerTimelineStep.PACKED,
  CustomerTimelineStep.OUT_FOR_DELIVERY,
  CustomerTimelineStep.DELIVERED,
];

export const CUSTOMER_TIMELINE_LABELS: Readonly<
  Record<CustomerTimelineStep, string>
> = {
  [CustomerTimelineStep.PLACED]: "Order Placed",
  [CustomerTimelineStep.CONFIRMED]: "Order Confirmed",
  [CustomerTimelineStep.PACKED]: "Order Packed",
  [CustomerTimelineStep.OUT_FOR_DELIVERY]: "Out for Delivery",
  [CustomerTimelineStep.DELIVERED]: "Delivered",
};

/**
 * Maps an internal PARENT status to its timeline step. `null` means the
 * order is in an exception state and the UI must show a banner (cancelled /
 * payment failed / awaiting payment) instead of a progress timeline.
 *
 * Note PROCESSING alone is ambiguous — "processing" covers everything from
 * "no seller has accepted yet" to "every seller is packed and ready." The
 * DTO layer (order.service.ts's `toSummary`/`getOrderDetail`) additionally
 * inspects the SellerOrders to decide PLACED vs CONFIRMED vs PACKED for a
 * PROCESSING parent — this function alone only distinguishes the OTHER,
 * unambiguous statuses.
 */
export function toCustomerTimelineStep(
  status: OrderStatus,
): CustomerTimelineStep | "PROCESSING" | null {
  switch (status) {
    case OrderStatus.PAYMENT_CONFIRMED:
      return CustomerTimelineStep.PLACED;
    case OrderStatus.PROCESSING:
    case OrderStatus.PARTIALLY_CANCELLED:
      // Ambiguous at this function's level — see doc comment above.
      return "PROCESSING";
    case OrderStatus.READY_FOR_PICKUP:
      return CustomerTimelineStep.PACKED;
    case OrderStatus.PICKED_UP:
    case OrderStatus.OUT_FOR_DELIVERY:
      return CustomerTimelineStep.OUT_FOR_DELIVERY;
    case OrderStatus.DELIVERED:
      return CustomerTimelineStep.DELIVERED;
    case OrderStatus.PENDING_PAYMENT:
    case OrderStatus.PAYMENT_FAILED:
    case OrderStatus.CANCELLED:
    case OrderStatus.REFUNDED:
    case OrderStatus.PARTIALLY_REFUNDED:
      return null;
    default: {
      // Exhaustiveness guard — adding a status without handling it fails the build.
      const _never: never = status;
      return _never;
    }
  }
}

/** Short, user-safe label for any internal parent status (badges, lists). */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  [OrderStatus.PENDING_PAYMENT]: "Awaiting Payment",
  [OrderStatus.PAYMENT_CONFIRMED]: "Payment Received",
  [OrderStatus.PROCESSING]: "Processing",
  [OrderStatus.READY_FOR_PICKUP]: "Ready for Pickup",
  [OrderStatus.PICKED_UP]: "Picked Up",
  [OrderStatus.OUT_FOR_DELIVERY]: "Out for Delivery",
  [OrderStatus.DELIVERED]: "Delivered",
  [OrderStatus.PARTIALLY_CANCELLED]: "Partially Cancelled",
  [OrderStatus.CANCELLED]: "Cancelled",
  [OrderStatus.PAYMENT_FAILED]: "Payment Failed",
  [OrderStatus.REFUNDED]: "Refunded",
  [OrderStatus.PARTIALLY_REFUNDED]: "Partially Refunded",
};

/**
 * Coarse bucket used by "My Orders" badges in the mockup
 * (Delivered / Cancelled / Ongoing).
 */
export const OrderBucket = {
  ONGOING: "ONGOING",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;
export type OrderBucket = (typeof OrderBucket)[keyof typeof OrderBucket];

export function toOrderBucket(status: OrderStatus): OrderBucket {
  if (status === OrderStatus.DELIVERED) return OrderBucket.DELIVERED;
  if (
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.PAYMENT_FAILED ||
    status === OrderStatus.REFUNDED
  ) {
    return OrderBucket.CANCELLED;
  }
  return OrderBucket.ONGOING;
}

/* -------------------------------------------------------------------------- */
/* Sales reporting — ONE definition for every count, spend and revenue figure */
/* -------------------------------------------------------------------------- */

/**
 * An order that was PLACED and still stands — paid online (or COD), in
 * progress or delivered. These are the orders a customer "has", and the only
 * ones any order count may include.
 *
 * Never a sale, whatever their totals say: PENDING_PAYMENT (online, not paid
 * yet), PAYMENT_FAILED (failed or expired), CANCELLED and REFUNDED.
 * PARTIALLY_REFUNDED is listed in the enum but no transition reaches it.
 */
export const PLACED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAYMENT_CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.PARTIALLY_CANCELLED,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.PICKED_UP,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED,
];

/**
 * A completed (realised) sale: delivered, so the money is in — COD is
 * collected at the door, an online payment was captured before the order was
 * placed. Revenue and "total spent" count only these, at
 * `currentPayablePaise` (the checkout total minus any seller portion
 * cancelled or rejected since), never the frozen receipt `totalPaise`.
 */
export const COMPLETED_SALE_STATUSES: readonly OrderStatus[] = [OrderStatus.DELIVERED];

/* -------------------------------------------------------------------------- */
/* Admin tabs — cross-seller order list (parent OrderStatus)                  */
/* -------------------------------------------------------------------------- */

export const AdminOrderTab = {
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PROCESSING: "PROCESSING",
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type AdminOrderTab = (typeof AdminOrderTab)[keyof typeof AdminOrderTab];

export const ADMIN_TAB_STATUSES: Readonly<
  Record<AdminOrderTab, readonly OrderStatus[]>
> = {
  [AdminOrderTab.PAYMENT_PENDING]: [OrderStatus.PENDING_PAYMENT],
  [AdminOrderTab.PROCESSING]: [
    OrderStatus.PAYMENT_CONFIRMED,
    OrderStatus.PROCESSING,
    OrderStatus.PARTIALLY_CANCELLED,
  ],
  [AdminOrderTab.READY_FOR_PICKUP]: [OrderStatus.READY_FOR_PICKUP],
  [AdminOrderTab.OUT_FOR_DELIVERY]: [OrderStatus.PICKED_UP, OrderStatus.OUT_FOR_DELIVERY],
  [AdminOrderTab.COMPLETED]: [OrderStatus.DELIVERED],
  [AdminOrderTab.CANCELLED]: [
    OrderStatus.CANCELLED,
    OrderStatus.PAYMENT_FAILED,
    OrderStatus.REFUNDED,
    OrderStatus.PARTIALLY_REFUNDED,
  ],
};

/* -------------------------------------------------------------------------- */
/* Seller panel tabs — one seller's own orders (SellerOrderStatus)            */
/* -------------------------------------------------------------------------- */

export const SellerOrderTab = {
  NEW: "NEW",
  ACCEPTED: "ACCEPTED",
  PREPARING: "PREPARING",
  READY: "READY",
  CANCELLED: "CANCELLED",
} as const;
export type SellerOrderTab = (typeof SellerOrderTab)[keyof typeof SellerOrderTab];

export const SELLER_ORDER_TAB_STATUSES: Readonly<
  Record<SellerOrderTab, readonly SellerOrderStatus[]>
> = {
  [SellerOrderTab.NEW]: [SellerOrderStatus.NEW],
  [SellerOrderTab.ACCEPTED]: [SellerOrderStatus.ACCEPTED],
  [SellerOrderTab.PREPARING]: [SellerOrderStatus.PREPARING],
  [SellerOrderTab.READY]: [SellerOrderStatus.READY_FOR_PICKUP],
  [SellerOrderTab.CANCELLED]: [SellerOrderStatus.REJECTED, SellerOrderStatus.CANCELLED],
};

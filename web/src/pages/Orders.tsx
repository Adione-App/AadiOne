/**
 * The order board (Task 13.3) — the highest-frequency screen in the system.
 *
 * Design constraints taken from how a counter actually works (PRD §5.1):
 *   - accepting an order is ONE click, never behind a menu or a detail page
 *   - a new order announces itself audibly and keeps announcing until seen
 *   - the board polls as well as listening on a socket, because a dropped
 *     socket must never cause a missed order
 *   - oldest-waiting orders are visually loudest
 *
 * V2 (marketplace): a customer's Order is split into one SellerOrder per
 * seller. Accept / prepare / ready / reject act on each SellerOrder (shown
 * when a row is expanded) via PATCH /admin/seller-orders/:id/status; the
 * parent's status follows from them. The parent itself only takes payment
 * confirmation, rider assignment and the delivery leg. See lib/v2Orders.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useEntryState } from "@/lib/scrollMemory";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { PaymentMethod, type CursorPage, type DeliveryAgentDto } from "@shared";
import { formatPaise } from "@shared/money";
import { formatRelativeTime } from "@shared/datetime";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Icon,
  Pill,
  SearchInput,
  Spinner,
  StatusPill,
  Surface,
  Thumb,
} from "@/components/ui";
import { useOrderSocket } from "@/lib/socket";
import { useMarkOrderRead } from "@/lib/orderAlerts";
import { PaidNotPlacedAlert } from "@/components/PaidNotPlacedAlert";
import { useDebouncedValue } from "@/seller/sellerQueries";
import { AdminOrderDetail } from "./AdminOrderDetail";
import {
  PARENT_NEXT_ACTION,
  SELLER_ORDER_NEXT_ACTION,
  SellerOrderStatus,
  V2OrderStatus,
  orderBadgeTabs,
  paymentStatusView,
  resolveAdminOrderTab,
  visibleAdminOrderTabs,
  toAdminOrderDetailView,
  type AdminOrderSummaryV2,
  type SellerOrderView,
  type V2AdminOrderTab,
} from "@/lib/v2Orders";

/** When an order was placed, in India time ("7 Nov 2026, 9:42 am"). */
const placedAtFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/**
 * One tab's list request. The key matches the Customers page's per-tab
 * queries and the badge counts below, so identical requests share one cache
 * entry instead of being sent twice.
 */
function ordersQuery(tab: V2AdminOrderTab, search: string) {
  return {
    queryKey: ["admin-orders", tab, search] as const,
    queryFn: () =>
      api.get<CursorPage<AdminOrderSummaryV2>>(
        `/admin/orders?tab=${tab}&limit=50${
          search ? `&search=${encodeURIComponent(search)}` : ""
        }`,
      ),
    // Polling remains enabled even when the socket is connected, so a dropped
    // realtime connection can never cause a missed order.
    refetchInterval: 20_000,
  };
}

export default function OrdersPage() {
  const [params] = useSearchParams();

  /**
   * Whether the legacy manual UPI confirmation controls apply at all. With a
   * payment gateway (Cashfree) payments settle only by server-side
   * verification, so the controls are hidden — and the backend refuses them
   * regardless. Hidden until the answer arrives.
   */
  const paymentMode = useQuery({
    queryKey: ["admin-payment-mode"],
    queryFn: () =>
      api.get<{ provider: string; manualConfirmation: boolean }>("/admin/payment-mode"),
    staleTime: 5 * 60_000,
  });
  const manualPayments = paymentMode.data?.manualConfirmation === true;

  // Tabs and badges for the active provider (v2Orders.ts): no Payment Pending
  // tab — and no red badge for checkouts in progress — with Cashfree. The
  // open tab is derived, so a link's ?tab= is honoured once the mode is known.
  const tabs = visibleAdminOrderTabs(manualPayments);
  const badgeTabs = orderBadgeTabs(manualPayments);
  // Tab, search and opened orders are kept per history entry, so Back to this
  // page shows the same rows the remembered scroll position belongs to.
  const [requestedTab, setTab] = useEntryState<string>("tab", params.get("tab") ?? "PROCESSING");
  const tab: V2AdminOrderTab = resolveAdminOrderTab(requestedTab, manualPayments);
  const [search, setSearch] = useEntryState("search", params.get("search") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useEntryState<string[]>("expanded", []);
  const expanded: ReadonlySet<string> = new Set(expandedIds);
  const setExpanded = (change: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
    setExpandedIds((ids) => [...change(new Set(ids))]);

  const queryClient = useQueryClient();
  const markOrderRead = useMarkOrderRead();

  /**
   * A "View order" link (the NEW ORDER popup) lands here with
   * ?tab=&search=&open=<orderId> — also while this page is already open, so
   * the URL is followed on every change, not only on the first render.
   */
  const linkTab = params.get("tab");
  const linkSearch = params.get("search");
  const linkOpen = params.get("open");
  useEffect(() => {
    if (linkTab) setTab(linkTab);
    if (linkSearch !== null) setSearch(linkSearch);
    if (linkOpen) setExpanded((current) => (current.has(linkOpen) ? current : new Set(current).add(linkOpen)));
  }, [linkTab, linkSearch, linkOpen]);

  // Smart Search on the server (order number, phone, customer name or an
  // item, in any language) — debounced, so typing is not one request per
  // key, with the previous results kept on screen until the new ones land.
  const debouncedSearch = useDebouncedValue(search.trim(), 350);
  const query = useQuery({
    ...ordersQuery(tab, debouncedSearch),
    // Only across searches in the same tab — never another tab's orders.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === tab ? previous : undefined),
  });

  /**
   * Badge counts, fetched independently of the open tab — an admin sitting
   * on Completed must still see that a payment is waiting. When the open tab
   * is one of these with no search, it IS the same query, not a second one.
   */
  const badgeQueries = useQueries({
    queries: badgeTabs.map((item) => ordersQuery(item.key, "")),
  });

  /**
   * Seller orders still waiting to be accepted, by parent order — what makes
   * a new order loud on the board. One request for all of them.
   */
  const awaitingAcceptance = useQuery({
    queryKey: ["admin-orders", "seller-orders", SellerOrderStatus.NEW],
    queryFn: () =>
      api.get<CursorPage<{ orderId: string }>>(
        `/admin/seller-orders?status=${SellerOrderStatus.NEW}&limit=100`,
      ),
    select: (page) => {
      const byOrder = new Map<string, number>();
      for (const sellerOrder of page.items) {
        byOrder.set(sellerOrder.orderId, (byOrder.get(sellerOrder.orderId) ?? 0) + 1);
      }
      return byOrder;
    },
    refetchInterval: 20_000,
  });

  /**
   * Delivery agents.
   */
  const agents = useQuery({
    queryKey: ["delivery-agents"],

    queryFn: () => api.get<DeliveryAgentDto[]>("/admin/delivery-agents"),
  });

  /**
   * Realtime order updates.
   */
  useOrderSocket({
    // The sound and the NEW ORDER popup are the panel-wide OrderAlerts (App.tsx).
    onNewOrder: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });
    },

    onStatusChanged: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });
    },
  });

  /**
   * Everything under "admin-orders" — lists, badges, awaiting-acceptance and
   * any expanded order's seller orders — is re-read from the server after
   * every action, success or failure. Nothing is updated optimistically, so
   * a status the server refused is never shown.
   */
  const refreshOrders = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["admin-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [queryClient]);

  /**
   * Parent-order delivery leg: picked up -> out for delivery -> delivered.
   */
  const advanceParent = useMutation({
    mutationFn: async (input: { orderId: string; toStatus: V2OrderStatus }) => {
      await api.patch(`/admin/orders/${input.orderId}/status`, {
        toStatus: input.toStatus,
      });
    },

    onSuccess: () => {
      setError(null);
      refreshOrders();
    },

    onError: (err: Error) => {
      setError(err.message);
      refreshOrders();
    },
  });

  /**
   * One seller's portion: accept / start preparing / mark ready / reject.
   */
  const sellerOrderAction = useMutation({
    mutationFn: async (input: {
      orderId: string;
      sellerOrderId: string;
      toStatus: SellerOrderStatus;
      reason?: string;
    }) => {
      await api.patch(`/admin/seller-orders/${input.sellerOrderId}/status`, {
        toStatus: input.toStatus,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    },

    onSuccess: () => {
      setError(null);
      refreshOrders();
    },

    onError: (err: Error) => {
      setError(err.message);
      refreshOrders();
    },
  });

  /**
   * Direct UPI payment verification.
   *
   * IMPORTANT:
   *
   * There is NO automatic "payment successful" decision here.
   *
   * The customer only attempts payment through UPI.
   * The admin independently checks the merchant UPI/bank transaction.
   *
   * Only after that check does the admin call:
   *
   * POST /admin/orders/:orderId/confirm-payment
   *
   * The backend is responsible for:
   *
   * PENDING_PAYMENT
   *        ↓
   * PAYMENT_CONFIRMED
   *
   * and for changing the payment to the paid/captured state.
   */
  const confirmPayment = useMutation({
    mutationFn: (input: { orderId: string; reference: string | null }) =>
      api.post(`/admin/orders/${input.orderId}/confirm-payment`, {
        reference: input.reference,
      }),

    onSuccess: () => {
      setError(null);
      refreshOrders();
    },

    onError: (err: Error) => {
      setError(err.message);
      refreshOrders();
    },
  });

  /**
   * Assign delivery agent.
   */
  const assign = useMutation({
    mutationFn: (input: { orderId: string; agentId: string }) =>
      api.post(`/admin/orders/${input.orderId}/assign`, {
        agentId: input.agentId,
      }),

    onSuccess: () => {
      setError(null);
      refreshOrders();
    },

    onError: (err: Error) => {
      setError(err.message);
      refreshOrders();
    },
  });

  const orders = query.data?.items ?? [];

  function toggleExpanded(orderId: string): void {
    // Opening an order reads its new-order alert for this admin (a no-op when it had none).
    if (!expanded.has(orderId)) markOrderRead.mutate(orderId);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  /**
   * Parent-order delivery step. "Mark delivered" needs no delivery OTP.
   */
  function handleParentAdvance(order: AdminOrderSummaryV2): void {
    const action = PARENT_NEXT_ACTION[order.status];

    if (!action) {
      return;
    }

    advanceParent.mutate({
      orderId: order.id,
      toStatus: action.to,
    });
  }

  /**
   * Seller-order step — Reject asks for the reason the customer will see.
   */
  function handleSellerOrderAction(
    orderId: string,
    sellerOrder: SellerOrderView,
    toStatus: SellerOrderStatus,
  ): void {
    if (toStatus === SellerOrderStatus.REJECTED) {
      const reason = window.prompt(
        `Why is ${sellerOrder.sellerName}'s part of this order being rejected? The customer will see this.`,
      );

      if (!reason?.trim()) {
        return;
      }

      sellerOrderAction.mutate({
        orderId,
        sellerOrderId: sellerOrder.id,
        toStatus,
        reason: reason.trim(),
      });
      return;
    }

    sellerOrderAction.mutate({
      orderId,
      sellerOrderId: sellerOrder.id,
      toStatus,
    });
  }

  const busySellerOrderId = sellerOrderAction.isPending
    ? (sellerOrderAction.variables?.sellerOrderId ?? null)
    : null;

  return (
    <div className="space-y-4">
      <PaidNotPlacedAlert />

      <Surface className="px-2">
        <div className="flex flex-nowrap gap-1 overflow-x-auto">
          {tabs.map((item) => {
            const badgeIndex = badgeTabs.findIndex((badge) => badge.key === item.key);
            const badge = badgeIndex >= 0 ? badgeTabs[badgeIndex] : undefined;
            const page = badgeIndex >= 0 ? badgeQueries[badgeIndex]?.data : undefined;
            const count = page?.items.length ?? 0;

            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`relative min-h-11 whitespace-nowrap px-4 text-sm font-semibold transition ${
                  tab === item.key
                    ? "text-brand-600 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-500"
                    : "text-gray-500 hover:text-gray-800"
                }`}
              >
                {item.label}

                {badge && count > 0 && (
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold ${
                      badge.urgent
                        ? "bg-danger-50 text-danger-500"
                        : "bg-brand-50 text-brand-600"
                    }`}
                  >
                    {count}
                    {page?.hasMore ? "+" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Surface>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search order number, phone, name or item…"
        className="max-w-md"
      />

      <ErrorBanner message={error} />

      {query.isLoading ? (
        <Spinner label="Loading orders…" />
      ) : query.isError && orders.length === 0 ? (
        <ErrorBanner message={`Could not load orders: ${query.error.message}`} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders here"
          hint="New orders appear automatically."
        />
      ) : (
        <div className="grid gap-3">
          {orders.map((order) => {
            const action = PARENT_NEXT_ACTION[order.status];
            const awaitingCount = awaitingAcceptance.data?.get(order.id) ?? 0;
            const isExpanded = expanded.has(order.id);

            /*
             * Orders with a seller portion waiting more than 5 minutes for
             * acceptance get a visual warning.
             */
            const waitingTooLong = awaitingCount > 0 && order.minutesSincePlaced >= 5;

            /*
             * UPI payment is waiting for admin verification only when:
             *
             * 0. Payments are confirmed manually at all (direct UPI / dev —
             *    never with the Cashfree gateway)
             * 1. Order is PENDING_PAYMENT
             * 2. Payment method is ONLINE
             * 3. Payment status is not already PAID
             *
             * We intentionally do not use a fake PENDING_VERIFICATION
             * PaymentStatus because that enum does not exist in this project.
             */
            const isPendingUpiPayment =
              manualPayments &&
              order.status === V2OrderStatus.PENDING_PAYMENT &&
              order.paymentMethod === PaymentMethod.ONLINE &&
              order.paymentStatus !== "PAID";

            return (
              <Card
                key={order.id}
                className={
                  waitingTooLong ? "border-l-4 border-l-danger-500" : ""
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">
                        #{order.orderNumber}
                      </span>

                      <StatusPill status={order.status} />

                      {/* Method and status are two separate facts; the status is the
                          server's (PAID only once it verified the payment). */}
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
                        {order.paymentMethod === PaymentMethod.COD ? "COD" : manualPayments ? "UPI" : "Online"}
                      </span>
                      <Pill tone={paymentStatusView(order.paymentMethod, order.paymentStatus).tone}>
                        {paymentStatusView(order.paymentMethod, order.paymentStatus).label}
                      </Pill>

                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                        {order.sellerCount} seller{order.sellerCount === 1 ? "" : "s"}
                      </span>

                      {awaitingCount > 0 && (
                        <span className="rounded bg-info-50 px-2 py-0.5 text-xs font-semibold text-info-500">
                          {awaitingCount} awaiting acceptance
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-gray-700">
                      {order.customerName} · {order.customerMobile}
                    </p>

                    <p className="text-sm text-gray-500">
                      {/* A live-location order goes to a GPS point, not a
                          saved address — the map link is the destination. */}
                      {order.deliveryMode === "LIVE_LOCATION" && (
                        <span className="mr-2 rounded bg-info-50 px-2 py-0.5 text-xs font-semibold text-info-500">
                          Live location
                        </span>
                      )}
                      {order.addressSummary}
                      {order.deliveryMode === "LIVE_LOCATION" && (
                        <>
                          {" · "}
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${order.deliveryLatitude},${order.deliveryLongitude}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-semibold text-brand-600 hover:underline"
                          >
                            Open in Maps
                          </a>
                        </>
                      )}
                    </p>

                    <p className="mt-1 text-xs text-gray-500">
                      {/* Products (lines) and units (their quantities) — never mixed up. */}
                      {order.lineItemCount} product{order.lineItemCount === 1 ? "" : "s"} · {order.itemCount} unit
                      {order.itemCount === 1 ? "" : "s"} · {order.distanceKm.toFixed(1)} km ·{" "}
                      <time dateTime={order.placedAt} title={formatRelativeTime(new Date(order.placedAt))}>
                        {placedAtFormat.format(new Date(order.placedAt))}
                      </time>
                      {order.deliveryAgentName &&
                        ` · ${order.deliveryAgentName}`}
                    </p>

                    {/* The order's first product photos, as ordered. */}
                    {order.itemThumbnails.length > 0 && (
                      <div className="mt-2 flex gap-1.5">
                        {order.itemThumbnails.map((url, index) => (
                          <Thumb key={`${url}-${index}`} src={url} alt="" fit="contain" />
                        ))}
                        {order.lineItemCount > order.itemThumbnails.length && (
                          <span className="flex h-11 items-center px-1 text-xs font-semibold text-gray-500">
                            +{order.lineItemCount - order.itemThumbnails.length}
                          </span>
                        )}
                      </div>
                    )}

                    {/*
                     * UPI payment claim.
                     *
                     * This information is only a reference for the admin.
                     * It is NOT treated as proof that payment was received.
                     */}
                    {isPendingUpiPayment && order.paymentClaim && (
                      <div className="mt-2 rounded-lg border border-warn-500/40 bg-warn-50 px-3 py-2">
                        <p className="text-sm font-semibold text-warn-500">
                          Customer says they have paid
                        </p>

                        {order.paymentClaim.utr ? (
                          <p className="mt-0.5 text-sm text-gray-700">
                            UPI reference:{" "}
                            <span className="font-mono font-semibold tracking-wide">
                              {order.paymentClaim.utr}
                            </span>
                          </p>
                        ) : (
                          <p className="mt-0.5 text-sm text-gray-700">
                            No reference given — match by amount and time.
                          </p>
                        )}

                        <p className="mt-0.5 text-xs text-gray-500">
                          Check your merchant UPI/bank transaction for{" "}
                          {formatPaise(order.totalPaise)} before confirming.
                        </p>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => toggleExpanded(order.id)}
                      aria-expanded={isExpanded}
                      className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:text-brand-700"
                    >
                      {isExpanded ? "Hide order details" : "View order details"}
                      <Icon
                        name="chevronDown"
                        className={`h-4 w-4 transition ${isExpanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <span className="text-lg font-bold">
                      {formatPaise(order.totalPaise)}
                    </span>

                    {order.currentPayablePaise !== order.totalPaise && (
                      <span className="-mt-2 text-xs text-gray-500">
                        Payable now {formatPaise(order.currentPayablePaise)}
                      </span>
                    )}

                    <div className="flex flex-wrap justify-end gap-2">
                      {order.status === V2OrderStatus.READY_FOR_PICKUP && (
                        <select
                          className="min-h-11 rounded-lg border border-gray-300 px-2 text-sm"
                          defaultValue=""
                          disabled={assign.isPending}
                          onChange={(event) => {
                            const agentId = event.target.value;

                            if (!agentId) {
                              return;
                            }

                            assign.mutate({
                              orderId: order.id,
                              agentId,
                            });
                          }}
                        >
                          <option value="" disabled>
                            {order.deliveryAgentName ? "Reassign rider…" : "Assign rider…"}
                          </option>

                          {(agents.data ?? [])
                            .filter((agent) => agent.isActive)
                            .map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name} ({agent.activeOrderCount})
                              </option>
                            ))}
                        </select>
                      )}

                      {/*
                       * MANUAL UPI VERIFICATION
                       *
                       * The admin:
                       *
                       * 1. Checks merchant UPI/bank transaction.
                       * 2. Optionally enters UTR/reference.
                       * 3. Confirms payment received.
                       *
                       * The client does NOT mark the order as paid.
                       * The backend performs the actual state transition.
                       */}
                      {isPendingUpiPayment && (
                        <>
                          <Button
                            onClick={() => {
                              /*
                               * First ask for UTR/reference.
                               *
                               * This is optional because the admin can
                               * independently match amount + time.
                               */
                              const reference = window.prompt(
                                `Enter the UPI UTR/reference for order ${order.orderNumber}.\n\n` +
                                  `Expected amount: ${formatPaise(order.totalPaise)}\n\n` +
                                  `Leave blank if you are confirming by amount/time.`,
                                order.paymentClaim?.utr ?? "",
                              );

                              /*
                               * Cancel the dialog = do nothing.
                               */
                              if (reference === null) {
                                return;
                              }

                              const cleanReference = reference.trim();

                              /*
                               * Second confirmation prevents accidental
                               * payment confirmation.
                               */
                              const confirmed = window.confirm(
                                `Confirm payment received?\n\n` +
                                  `Order: ${order.orderNumber}\n` +
                                  `Amount: ${formatPaise(order.totalPaise)}\n` +
                                  `Payment: UPI\n` +
                                  `UTR: ${
                                    cleanReference || "Not provided"
                                  }\n\n` +
                                  `Only continue after checking the merchant UPI/bank transaction.`,
                              );

                              if (!confirmed) {
                                return;
                              }

                              confirmPayment.mutate({
                                orderId: order.id,
                                reference: cleanReference || null,
                              });
                            }}
                            disabled={confirmPayment.isPending}
                          >
                            {confirmPayment.isPending
                              ? "Confirming…"
                              : "Mark Payment Received"}
                          </Button>

                          <Button
                            variant="secondary"
                            onClick={() => {
                              setError(
                                "Payment is still pending. Do not cancel the order unless the configured payment hold/expiry process requires it.",
                              );
                            }}
                          >
                            Keep Pending
                          </Button>
                        </>
                      )}

                      {action && (
                        <Button
                          onClick={() => handleParentAdvance(order)}
                          disabled={
                            advanceParent.isPending ||
                            (action.needsRider === true && !order.deliveryAgentName)
                          }
                        >
                          {action.needsRider && !order.deliveryAgentName
                            ? `${action.label} (assign a rider first)`
                            : action.label}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <SellerOrdersPanel
                    orderId={order.id}
                    busySellerOrderId={busySellerOrderId}
                    actionsDisabled={sellerOrderAction.isPending}
                    onAction={handleSellerOrderAction}
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * An order's seller orders, loaded when its row is expanded. Every action
 * here targets ONE seller order by its own id, so in a mixed order each
 * seller's portion moves independently.
 */
function SellerOrdersPanel({
  orderId,
  busySellerOrderId,
  actionsDisabled,
  onAction,
}: {
  orderId: string;
  busySellerOrderId: string | null;
  actionsDisabled: boolean;
  onAction: (orderId: string, sellerOrder: SellerOrderView, toStatus: SellerOrderStatus) => void;
}) {
  const detail = useQuery({
    queryKey: ["admin-orders", "detail", orderId],
    // Mapped straight away: only the fields this panel shows are kept.
    queryFn: () => api.get<unknown>(`/admin/orders/${orderId}`).then(toAdminOrderDetailView),
  });

  if (detail.isPending) {
    return (
      <div className="mt-3 border-t border-gray-100">
        <Spinner label="Loading order details…" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
        <p className="text-sm text-danger-600">
          Could not load this order's details: {detail.error.message}
        </p>
        <Button variant="secondary" onClick={() => void detail.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // The complete order (AdminOrderDetail.tsx); each seller's part keeps its
  // existing actions, unchanged.
  return (
    <AdminOrderDetail
      view={detail.data}
      sellerActions={(sellerOrder) => {
        const next = SELLER_ORDER_NEXT_ACTION[sellerOrder.status];
        const busy = busySellerOrderId === sellerOrder.id;
        return (
          <>
            {sellerOrder.status === SellerOrderStatus.NEW && (
              <Button
                variant="secondary"
                disabled={actionsDisabled}
                onClick={() => onAction(orderId, sellerOrder, SellerOrderStatus.REJECTED)}
              >
                Reject
              </Button>
            )}

            {next && (
              <Button
                disabled={actionsDisabled}
                onClick={() => onAction(orderId, sellerOrder, next.to)}
              >
                {busy ? "Updating…" : next.label}
              </Button>
            )}
          </>
        );
      }}
    />
  );
}

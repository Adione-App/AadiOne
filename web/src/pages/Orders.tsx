/**
 * The order board (Task 13.3) — the highest-frequency screen in the system.
 *
 * Design constraints taken from how a counter actually works (PRD §5.1):
 *   - accepting an order is ONE click, never behind a menu or a detail page
 *   - a new order announces itself audibly and keeps announcing until seen
 *   - the board polls as well as listening on a socket, because a dropped
 *     socket must never cause a missed order
 *   - oldest-waiting orders are visually loudest
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AdminOrderTab,
  OrderStatus,
  PaymentMethod,
  type AdminOrderSummaryDto,
  type CursorPage,
  type DeliveryAgentDto,
} from "@shared";
import { formatPaise } from "@shared/money";
import { formatRelativeTime } from "@shared/datetime";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  SearchInput,
  Spinner,
  StatusPill,
  Surface,
} from "@/components/ui";
import { useOrderSocket } from "@/lib/socket";

const TABS: { key: AdminOrderTab; label: string }[] = [
  {
    key: AdminOrderTab.PAYMENT_PENDING,
    label: "Payment to verify",
  },
  {
    key: AdminOrderTab.NEW,
    label: "New",
  },
  {
    key: AdminOrderTab.ACCEPTED,
    label: "Accepted",
  },
  {
    key: AdminOrderTab.PREPARING,
    label: "Preparing",
  },
  {
    key: AdminOrderTab.READY,
    label: "Ready",
  },
  {
    key: AdminOrderTab.OUT_FOR_DELIVERY,
    label: "Out for Delivery",
  },
  {
    key: AdminOrderTab.COMPLETED,
    label: "Completed",
  },
  {
    key: AdminOrderTab.CANCELLED,
    label: "Cancelled",
  },
];

/**
 * The one next action for each state — so the primary button is never
 * ambiguous.
 */
const NEXT_ACTION: Partial<
  Record<OrderStatus, { to: OrderStatus; label: string }>
> = {
  [OrderStatus.ORDER_PLACED]: {
    to: OrderStatus.STORE_ACCEPTED,
    label: "Accept",
  },

  [OrderStatus.STORE_ACCEPTED]: {
    to: OrderStatus.PREPARING,
    label: "Start preparing",
  },

  [OrderStatus.PREPARING]: {
    to: OrderStatus.READY_FOR_PICKUP,
    label: "Mark packed",
  },

  [OrderStatus.READY_FOR_PICKUP]: {
    to: OrderStatus.OUT_FOR_DELIVERY,
    label: "Send out",
  },

  [OrderStatus.OUT_FOR_DELIVERY]: {
    to: OrderStatus.DELIVERED,
    label: "Mark delivered",
  },
};

function useNewOrderChime(): {
  armed: boolean;
  announce: () => void;
  acknowledge: () => void;
} {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);

  const beep = useCallback(() => {
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.frequency.value = 880;

      gain.gain.setValueAtTime(0.15, context.currentTime);

      oscillator.start();
      oscillator.stop(context.currentTime + 0.25);
    } catch {
      // Audio blocked until the user interacts with the page.
      // The visual banner still does its job.
    }
  }, []);

  const announce = useCallback(() => {
    setArmed(true);
    beep();

    // Keep ringing every 10 seconds until acknowledged.
    if (timer.current === null) {
      timer.current = window.setInterval(beep, 10_000);
    }
  }, [beep]);

  const acknowledge = useCallback(() => {
    setArmed(false);

    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
      }
    },
    [],
  );

  return {
    armed,
    announce,
    acknowledge,
  };
}

export default function OrdersPage() {
  const [tab, setTab] = useState<AdminOrderTab>(AdminOrderTab.NEW);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const chime = useNewOrderChime();

  /**
   * Orders query.
   *
   * Polling remains enabled even when the socket is connected.
   * This prevents missed orders when realtime connection drops.
   */
  const query = useQuery({
    queryKey: ["admin-orders", tab, search],

    queryFn: () =>
      api.get<CursorPage<AdminOrderSummaryDto>>(
        `/admin/orders?tab=${tab}&limit=50${
          search ? `&search=${encodeURIComponent(search)}` : ""
        }`,
      ),

    refetchInterval: 20_000,
  });

  /**
   * Counts for the two time-sensitive tabs — New and Payment to verify —
   * fetched independently of whichever tab is currently open.
   *
   * Without this, an admin sitting on "Preparing" all day would never see
   * that a UPI order has been waiting for payment verification for the last
   * ten minutes: its tab carries no badge of its own, and the count used to
   * come from `query` above, which only ever reflects the CURRENTLY OPEN
   * tab — useless for flagging every OTHER tab. This is what actually makes
   * "Payment to verify" impossible to miss even when it isn't the tab
   * you're looking at.
   */
  const attentionCounts = useQuery({
    // Deliberately prefixed with "admin-orders" (not a standalone key) so
    // every existing `invalidateQueries({ queryKey: ["admin-orders"] })`
    // call already elsewhere in this file — after a status change, payment
    // confirmation, etc. — refreshes this too, without having to remember
    // to add a second invalidation at each of those call sites.
    queryKey: ["admin-orders", "attention-counts"],

    queryFn: async () => {
      const [newOrders, paymentPending] = await Promise.all([
        api.get<CursorPage<AdminOrderSummaryDto>>(
          `/admin/orders?tab=${AdminOrderTab.NEW}&limit=50`,
        ),
        api.get<CursorPage<AdminOrderSummaryDto>>(
          `/admin/orders?tab=${AdminOrderTab.PAYMENT_PENDING}&limit=50`,
        ),
      ]);

      return {
        [AdminOrderTab.NEW]: newOrders.items.length,
        [AdminOrderTab.PAYMENT_PENDING]: paymentPending.items.length,
      };
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
    onNewOrder: () => {
      chime.announce();

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
   * Advance an order through the normal order state machine.
   */
  const advance = useMutation({
    mutationFn: async (input: {
      orderId: string;
      toStatus: OrderStatus;
      reason?: string;
    }) => {
      await api.patch(`/admin/orders/${input.orderId}/status`, {
        toStatus: input.toStatus,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    },

    onSuccess: () => {
      setError(null);

      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });
    },

    onError: (err: Error) => {
      setError(err.message);
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

      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });

      void queryClient.invalidateQueries({
        queryKey: ["dashboard"],
      });
    },

    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const rejectPayment = useMutation({
    mutationFn: (input: { orderId: string; reason: string }) =>
      api.post(`/admin/orders/${input.orderId}/reject-payment`, {
        reason: input.reason,
      }),

    onSuccess: () => {
      setError(null);

      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });

      void queryClient.invalidateQueries({
        queryKey: ["dashboard"],
      });
    },

    onError: (err: Error) => {
      setError(err.message);
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
      void queryClient.invalidateQueries({
        queryKey: ["admin-orders"],
      });
    },

    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const orders = query.data?.items ?? [];

  /**
   * Normal order-state transition.
   */
  function handleAdvance(order: AdminOrderSummaryDto): void {
    const action = NEXT_ACTION[order.status];

    if (!action) {
      return;
    }

    advance.mutate({
      orderId: order.id,
      toStatus: action.to,
    });
  }

  /**
   * Reject an order.
   */
  function handleReject(order: AdminOrderSummaryDto): void {
    const reason = window.prompt(
      "Why is this order being rejected? The customer will see this.",
    );

    if (!reason) {
      return;
    }

    advance.mutate({
      orderId: order.id,
      toStatus: OrderStatus.REJECTED,
      reason,
    });
  }

  return (
    <div className="space-y-4">
      {chime.armed && (
        <button
          onClick={chime.acknowledge}
          className="w-full rounded-xl bg-brand-500 px-4 py-3 text-left font-semibold text-white shadow-lg"
        >
          New order received — tap to silence
        </button>
      )}

      <Surface className="px-2">
        <div className="flex flex-nowrap gap-1 overflow-x-auto">
          {TABS.map((item) => {
            // Payment verification blocks an order completely until it's
            // done, and its tab is easy to never visit on a normal counter
            // workflow — a louder, danger-toned badge (vs. New's neutral
            // brand one) so it reads as more urgent than "orders exist".
            const isPaymentPending = item.key === AdminOrderTab.PAYMENT_PENDING;
            const count = isPaymentPending
              ? (attentionCounts.data?.[AdminOrderTab.PAYMENT_PENDING] ?? 0)
              : item.key === AdminOrderTab.NEW
                ? (attentionCounts.data?.[AdminOrderTab.NEW] ?? 0)
                : 0;

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

                {count > 0 && (
                  <span
                    className={`ml-2 rounded-full px-2 py-0.5 text-xs font-bold ${
                      isPaymentPending
                        ? "bg-danger-50 text-danger-500"
                        : "bg-brand-50 text-brand-600"
                    }`}
                  >
                    {count}
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
        placeholder="Search by order number or phone…"
        className="max-w-md"
      />

      <ErrorBanner message={error} />

      {query.isLoading ? (
        <Spinner label="Loading orders…" />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders here"
          hint="New orders appear automatically."
        />
      ) : (
        <div className="grid gap-3">
          {orders.map((order) => {
            const action = NEXT_ACTION[order.status];

            /*
             * Orders waiting more than 5 minutes for acceptance
             * get a visual warning.
             */
            const waitingTooLong =
              order.status === OrderStatus.ORDER_PLACED &&
              order.minutesSincePlaced >= 5;

            /*
             * UPI payment is waiting for admin verification only when:
             *
             * 1. Order is PENDING_PAYMENT
             * 2. Payment method is ONLINE
             * 3. Payment status is not already PAID
             *
             * We intentionally do not use a fake PENDING_VERIFICATION
             * PaymentStatus because that enum does not exist in this project.
             */
            const isPendingUpiPayment =
              order.status === OrderStatus.PENDING_PAYMENT &&
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

                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          order.paymentMethod === PaymentMethod.COD
                            ? "bg-warn-50 text-warn-500"
                            : order.paymentStatus === "PAID"
                              ? "bg-brand-50 text-brand-600"
                              : "bg-danger-50 text-danger-500"
                        }`}
                      >
                        {order.paymentMethod === PaymentMethod.COD
                          ? "COD"
                          : `UPI · ${order.paymentStatus}`}
                      </span>
                    </div>

                    <p className="mt-1 text-sm text-gray-700">
                      {order.customerName} · {order.customerMobile}
                    </p>

                    <p className="text-sm text-gray-500">
                      {order.addressSummary}
                    </p>

                    <p className="mt-1 text-xs text-gray-500">
                      {order.itemCount} items · {order.distanceKm.toFixed(1)} km
                      · {formatRelativeTime(new Date(order.placedAt))}
                      {order.deliveryAgentName &&
                        ` · ${order.deliveryAgentName}`}
                    </p>

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
                  </div>

                  <div className="flex flex-col items-end gap-2">
                    <span className="text-lg font-bold">
                      {formatPaise(order.totalPaise)}
                    </span>

                    <div className="flex flex-wrap justify-end gap-2">
                      {order.status === OrderStatus.READY_FOR_PICKUP && (
                        <select
                          className="min-h-11 rounded-lg border border-gray-300 px-2 text-sm"
                          defaultValue=""
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
                            Assign rider…
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

                              /*
                               * IMPORTANT:
                               *
                               * This request does NOT directly change
                               * payment status in the browser.
                               *
                               * Backend must:
                               *
                               * - verify admin authorization
                               * - verify order is still pending payment
                               * - use server-side order amount
                               * - prevent duplicate confirmation
                               * - mark payment captured/paid
                               * - transition order
                               * - record audit information
                               */
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

                          <Button
                            variant="secondary"
                            onClick={() => {
                              const reason = window.prompt(
                                `Why is this UPI payment being marked as failed?\n\n` +
                                  `Order: ${order.orderNumber}\n` +
                                  `Amount: ${formatPaise(order.totalPaise)}\n\n` +
                                  `Only continue after checking the merchant UPI/bank transaction ` +
                                  `and determining that the payment was not received.`,
                                "Payment not received",
                              );

                              if (reason === null) {
                                return;
                              }

                              const cleanReason = reason.trim();

                              if (!cleanReason) {
                                setError(
                                  "A reason is required when marking payment as failed.",
                                );
                                return;
                              }

                              const confirmed = window.confirm(
                                `Mark payment as FAILED?\n\n` +
                                  `Order: ${order.orderNumber}\n` +
                                  `Amount: ${formatPaise(order.totalPaise)}\n` +
                                  `Payment: UPI\n\n` +
                                  `Only continue if you have checked the merchant UPI/bank account ` +
                                  `and confirmed that the payment was not received.`,
                              );

                              if (!confirmed) {
                                return;
                              }

                              rejectPayment.mutate({
                                orderId: order.id,
                                reason: cleanReason,
                              });
                            }}
                            disabled={rejectPayment.isPending}
                          >
                            {rejectPayment.isPending
                              ? "Marking Failed…"
                              : "Payment Failed"}
                          </Button>
                        </>
                      )}

                      {order.status === OrderStatus.ORDER_PLACED && (
                        <Button
                          variant="secondary"
                          onClick={() => handleReject(order)}
                        >
                          Reject
                        </Button>
                      )}

                      {action && (
                        <Button
                          onClick={() => handleAdvance(order)}
                          disabled={advance.isPending}
                        >
                          {action.label}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

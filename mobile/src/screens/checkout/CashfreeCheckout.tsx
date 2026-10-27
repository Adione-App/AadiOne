/**
 * Cashfree checkout for an order awaiting payment.
 *
 *   1. The customer picks an installed UPI app (Paytm, PhonePe, Google Pay…)
 *      and it opens straight away for this Cashfree order — or "More payment
 *      options" opens Cashfree's hosted checkout (UPI ID, cards, net banking).
 *      Amount, merchant and reference all come from the server-created
 *      Cashfree order, never from the phone.
 *   2. When the customer is back — success callback, failure, or backing out —
 *      the app asks the SERVER (`POST /payments/:orderId/refresh`), which asks
 *      Cashfree. The SDK callback, or simply returning, is never payment.
 *   3. Paid -> order tracking. Still in progress at the bank -> "Payment
 *      pending — checking status", checked again in the background. A failed
 *      or abandoned attempt leaves the order payable: the customer can try
 *      again (the same Cashfree order) until the payment window closes.
 */

import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Crypto from "expo-crypto";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { OrderStatus } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { api, ApiRequestError } from "@/lib/api";
import {
  isCashfreeAvailable,
  listInstalledUpiApps,
  openCashfreeCheckout,
  openCashfreeUpiApp,
  supportsDirectUpiApps,
  type CashfreeOutcome,
  type UpiAppOption,
} from "@/lib/cashfree";
import type { CashfreeCheckout as CheckoutSession, CreatePaymentResult, PaymentRefreshResult } from "@/lib/payments";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { useSystemBack } from "@/lib/useSystemBack";
import { AppText, Button, Card, NoticeStrip, Screen } from "@/components/ui";

type Phase =
  | "ready" // nothing attempted yet
  | "paying" // a UPI app / Cashfree checkout is open
  | "verifying" // asking the server what happened
  | "pending" // Cashfree says the attempt is still in progress — keep checking
  | "retry" // not paid; the order can still be paid
  | "closed" // the payment window closed without a payment
  | "late"; // paid after the window closed — refund under way

type Method = { kind: "app"; app: UpiAppOption } | { kind: "web" };

/** Polls after the payment UI closes: a UPI payment can take a few seconds to settle. */
const VERIFY_ATTEMPTS = 6;
const VERIFY_INTERVAL_MS = 2_500;
/** While a payment is pending at the bank: a gentler background check, for a few minutes. */
const PENDING_POLL_MS = 5_000;
const PENDING_POLL_LIMIT = 36;

const UNAVAILABLE =
  "Online payment is not available in this version of the app. Please update AdiOne to the latest version.";
const MAYBE_DEDUCTED = "If money was deducted, your order will be confirmed automatically.";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function CashfreeCheckout({
  orderId,
  amountPaise,
  initialCheckout,
  onPaid,
  onCancel,
  onCancelled,
}: {
  orderId: string;
  /** From the server's payment response — never computed on the phone. */
  amountPaise: number;
  initialCheckout: CheckoutSession;
  onPaid: () => void;
  onCancel: () => void;
  onCancelled: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const [phase, setPhase] = useState<Phase>("ready");
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Installed UPI apps; null while looking them up. */
  const [apps, setApps] = useState<UpiAppOption[] | null>(supportsDirectUpiApps() ? null : []);
  const attempted = useRef(false);
  const checkout = useRef<CheckoutSession>(initialCheckout);
  const mounted = useRef(true);
  const phaseRef = useRef<Phase>("ready");
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPolls = useRef(0);
  phaseRef.current = phase;

  const stopPendingPoll = () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
  };

  useEffect(() => {
    if (supportsDirectUpiApps()) {
      void listInstalledUpiApps().then((found) => {
        if (mounted.current) setApps(found);
      });
    }
    return () => {
      mounted.current = false;
      stopPendingPoll();
    };
  }, []);

  // Back from a UPI app by the app switcher (or the phone was locked): check
  // again — the customer may have finished paying while we were away.
  // Registered once: reads the phase and the latest `verify` through refs.
  const verifyRef = useRef<(context: null) => Promise<void>>(async () => undefined);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && attempted.current && (phaseRef.current === "pending" || phaseRef.current === "retry")) {
        stopPendingPoll();
        void verifyRef.current(null);
      }
    });
    return () => subscription.remove();
  }, []);

  const amount = formatPaise(amountPaise);

  /**
   * Shows what the server said. Only `paymentStatus === PAID` (or the order
   * having moved on to PROCESSING) is a paid order.
   */
  function apply(result: PaymentRefreshResult, context: { outcome: CashfreeOutcome | null; appName: string | null } | null): void {
    if (result.paymentStatus === "PAID" || result.status === OrderStatus.PROCESSING) {
      stopPendingPoll();
      onPaid();
      return;
    }
    if (result.latePaymentRefund) {
      stopPendingPoll();
      setPhase("late");
      return;
    }
    if (result.status !== OrderStatus.PENDING_PAYMENT) {
      stopPendingPoll();
      setPhase("closed");
      return;
    }
    if (result.attemptPending) {
      setPhase("pending");
      setNotice(null);
      schedulePendingPoll();
      return;
    }
    stopPendingPoll();
    setPhase("retry");
    if (result.lastAttemptFailed) {
      setNotice("The payment did not go through. No money was taken for it — you can try again.");
    } else if (context?.outcome?.kind === "error" && context.appName) {
      // The chosen app could not be opened or was closed before paying.
      setNotice(`The payment was not completed in ${context.appName}. Try again, choose another UPI app or use More payment options. ${MAYBE_DEDUCTED}`);
    } else {
      setNotice(`We haven't received a confirmation yet. ${MAYBE_DEDUCTED} You can also try again.`);
    }
  }

  /** The server's answer, polled briefly while a payment may still be settling. */
  async function verify(context: { outcome: CashfreeOutcome | null; appName: string | null } | null): Promise<void> {
    setPhase("verifying");
    setNotice(null);
    let last: PaymentRefreshResult | null = null;

    for (let i = 0; i < VERIFY_ATTEMPTS && mounted.current; i += 1) {
      try {
        last = await api.post<PaymentRefreshResult>(`/payments/${orderId}/refresh`);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status && err.status < 500) {
          if (!mounted.current) return;
          setPhase("retry");
          setNotice(err.message);
          return;
        }
      }
      if (last && (last.status !== OrderStatus.PENDING_PAYMENT || last.lastAttemptFailed)) break;
      await sleep(VERIFY_INTERVAL_MS);
    }
    if (!mounted.current) return;

    if (!last) {
      setPhase("retry");
      setNotice(`We could not check your payment right now. ${MAYBE_DEDUCTED}`);
      return;
    }
    apply(last, context);
  }

  verifyRef.current = verify;

  /** "Payment pending": one quiet check every few seconds, for a few minutes. */
  function schedulePendingPoll(): void {
    stopPendingPoll();
    if (pendingPolls.current >= PENDING_POLL_LIMIT) return;
    pendingTimer.current = setTimeout(async () => {
      pendingTimer.current = null;
      pendingPolls.current += 1;
      try {
        const result = await api.post<PaymentRefreshResult>(`/payments/${orderId}/refresh`);
        if (mounted.current && phaseRef.current === "pending") apply(result, null);
      } catch {
        if (mounted.current && phaseRef.current === "pending") schedulePendingPoll();
      }
    }, PENDING_POLL_MS);
  }

  async function pay(method: Method): Promise<void> {
    if (!isCashfreeAvailable()) {
      setNotice(UNAVAILABLE);
      return;
    }
    stopPendingPoll();
    setNotice(null);

    // After the first attempt, ask the server for the current session: it
    // returns the same Cashfree order while it is valid (so one order can
    // never be paid twice) and a fresh one only if it expired.
    if (attempted.current) {
      try {
        const fresh = await api.post<CreatePaymentResult>(
          "/payments/create",
          { orderId },
          Crypto.randomUUID(),
        );
        if (fresh.cashfree) checkout.current = fresh.cashfree;
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === "PAYMENT_ALREADY_CAPTURED") {
          onPaid();
          return;
        }
        setNotice(err instanceof ApiRequestError ? err.message : "Could not start the payment. Please try again.");
        setPhase("retry");
        return;
      }
    }

    attempted.current = true;
    pendingPolls.current = 0;
    setPhase("paying");
    let outcome: CashfreeOutcome | null = null;
    try {
      // Whatever the SDK reports, the server decides.
      outcome =
        method.kind === "app"
          ? await openCashfreeUpiApp(checkout.current, method.app.packageName)
          : await openCashfreeCheckout(checkout.current);
    } catch {
      // The payment UI could not be started (e.g. the app is gone).
      outcome = { kind: "error", message: null };
    }
    if (mounted.current) await verify({ outcome, appName: method.kind === "app" ? method.app.name : null });
  }

  /** Paying again while the last payment is still pending could charge twice — ask first. */
  function choose(method: Method): void {
    if (phase !== "pending") {
      void pay(method);
      return;
    }
    Alert.alert(
      "Your last payment is still pending",
      "Pay again only if your UPI app shows that the payment failed or was cancelled. If money was deducted, this order will be confirmed automatically.",
      [
        { text: "Keep waiting", style: "cancel" },
        { text: "Pay again", style: "destructive", onPress: () => void pay(method) },
      ],
    );
  }

  function confirmLeave(): void {
    if (attempted.current) {
      Alert.alert(
        "Leave payment?",
        `Your order stays reserved until the payment time ends. ${MAYBE_DEDUCTED}`,
        [
          { text: "Stay", style: "cancel" },
          { text: "Go back", onPress: onCancel },
        ],
      );
      return;
    }
    Alert.alert(
      "Cancel this order?",
      "You haven't made a payment yet, so this order will be cancelled. You can order again anytime.",
      [
        { text: "Stay", style: "cancel" },
        { text: "Cancel order", style: "destructive", onPress: () => void cancelUnattemptedOrder() },
      ],
    );
  }

  async function cancelUnattemptedOrder(): Promise<void> {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.post(`/orders/${orderId}/cancel`, { reason: "Customer left before attempting payment" });
      onCancelled();
    } catch {
      onCancel();
    } finally {
      setCancelling(false);
    }
  }

  // Android system back asks first, exactly like the header arrow.
  useSystemBack(() => {
    confirmLeave();
    return true;
  });

  const busy = phase === "paying" || phase === "verifying";
  const directApps = supportsDirectUpiApps();
  const hasApps = (apps?.length ?? 0) > 0;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={confirmLeave}
          disabled={cancelling || busy}
          hitSlop={12}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <AppText variant="h2">←</AppText>
        </Pressable>
        <View style={styles.headerText}>
          <AppText variant="h3">Payment</AppText>
          <AppText variant="body" color={colors.textSecondary}>
            Complete your payment to place the order
          </AppText>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance + 50 }]}
      >
        {notice && <NoticeStrip message={notice} />}

        <Card style={styles.amountCard}>
          <AppText variant="body" color={colors.textSecondary}>
            Total Amount
          </AppText>
          <AppText variant="displayLarge" color={colors.primary} style={styles.amount}>
            {amount}
          </AppText>
          <View style={styles.securePill}>
            <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
            <AppText variant="caption" color={colors.primary}>
              Secured by Cashfree Payments
            </AppText>
          </View>
        </Card>

        {phase === "late" ? (
          <Card style={styles.stateCard}>
            <Ionicons name="refresh-circle" size={36} color={colors.primary} />
            <AppText variant="bodyStrong">Your payment arrived after the payment time ended</AppText>
            <AppText variant="body" color={colors.textSecondary}>
              This order could not be placed, so your money is being refunded automatically to the
              same account. Refunds usually take 3 to 5 working days.
            </AppText>
            <Button label="Back to cart" onPress={onCancelled} style={styles.action} />
          </Card>
        ) : phase === "closed" ? (
          <Card style={styles.stateCard}>
            <Ionicons name="time-outline" size={36} color={colors.textSecondary} />
            <AppText variant="bodyStrong">The payment time for this order has ended</AppText>
            <AppText variant="body" color={colors.textSecondary}>
              No payment was received, so the order was not placed. You can order again from your cart.
            </AppText>
            <Button label="Back to cart" onPress={onCancelled} style={styles.action} />
          </Card>
        ) : (
          <>
            {phase === "pending" || phase === "verifying" || phase === "paying" ? (
              <Card style={styles.stateCard}>
                <View style={styles.statusRow}>
                  <Ionicons
                    name={phase === "pending" ? "hourglass-outline" : "sync-outline"}
                    size={22}
                    color={colors.primary}
                  />
                  <AppText variant="bodyStrong" style={styles.statusTitle}>
                    {phase === "pending"
                      ? "Payment pending — checking status"
                      : phase === "paying"
                        ? "Complete the payment in your UPI app"
                        : "Checking your payment…"}
                  </AppText>
                </View>
                <AppText variant="body" color={colors.textSecondary}>
                  {phase === "pending"
                    ? `Your UPI app or bank hasn't confirmed this payment yet. We'll keep checking. ${MAYBE_DEDUCTED} Don't pay again unless your UPI app shows the payment failed.`
                    : "Your order is confirmed only after the payment is verified with Cashfree."}
                </AppText>
                {phase === "pending" && (
                  <Button
                    label="Check payment status"
                    onPress={() => void verify(null)}
                    style={styles.action}
                  />
                )}
              </Card>
            ) : null}

            {phase !== "verifying" && phase !== "paying" && (
              <Card style={styles.stateCard}>
                {directApps && (
                  <>
                    <AppText variant="bodyStrong">
                      {phase === "pending" ? "Pay again with a UPI app" : "Pay with a UPI app"}
                    </AppText>
                    {apps === null ? (
                      <AppText variant="body" color={colors.textSecondary}>
                        Looking for UPI apps on this phone…
                      </AppText>
                    ) : hasApps ? (
                      <View style={styles.appList}>
                        {apps.map((app) => (
                          <Pressable
                            key={app.packageName}
                            onPress={() => choose({ kind: "app", app })}
                            disabled={busy || cancelling}
                            style={({ pressed }) => [styles.appRow, pressed && styles.appRowPressed]}
                            accessibilityRole="button"
                            accessibilityLabel={`Pay ${amount} with ${app.name}`}
                          >
                            <View style={[styles.appBadge, app.tint ? { backgroundColor: app.tint } : null]}>
                              <AppText variant="caption" color={app.tint ? colors.onPrimary : colors.primary} style={styles.appInitials}>
                                {app.initials}
                              </AppText>
                            </View>
                            <AppText variant="bodyStrong" style={styles.appName} numberOfLines={1}>
                              {app.name}
                            </AppText>
                            <AppText variant="caption" color={colors.primary}>
                              Pay {amount}
                            </AppText>
                            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <AppText variant="body" color={colors.textSecondary}>
                        No UPI app was found on this phone. You can still pay by UPI ID, card or net banking below.
                      </AppText>
                    )}
                  </>
                )}

                {!directApps && (
                  <AppText variant="body" color={colors.textSecondary}>
                    Pay with any UPI app, card or net banking on Cashfree's secure checkout. Your order is
                    confirmed only after the payment is verified with Cashfree.
                  </AppText>
                )}

                <Button
                  label={
                    directApps && hasApps
                      ? "More payment options"
                      : phase === "retry"
                        ? `Try again · ${amount}`
                        : `Pay ${amount}`
                  }
                  variant={directApps && hasApps ? "secondary" : "primary"}
                  onPress={() => choose({ kind: "web" })}
                  disabled={busy || cancelling}
                  style={styles.action}
                />
                {directApps && hasApps && (
                  <AppText variant="caption" color={colors.textSecondary}>
                    UPI ID, cards and net banking
                  </AppText>
                )}
                {phase === "retry" && (
                  <Button
                    label="Check payment status"
                    variant="secondary"
                    onPress={() => void verify(null)}
                    disabled={busy}
                    style={styles.secondaryAction}
                  />
                )}
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  back: {
    paddingRight: spacing.sm,
  },
  headerText: {
    flex: 1,
  },
  content: {
    padding: spacing.base,
    gap: spacing.base,
  },
  amountCard: {
    alignItems: "center",
    gap: spacing.sm,
  },
  amount: {
    marginVertical: spacing.sm,
  },
  securePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryLight,
  },
  stateCard: {
    gap: spacing.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusTitle: {
    flex: 1,
  },
  appList: {
    gap: spacing.sm,
  },
  appRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  appRowPressed: {
    opacity: 0.85,
  },
  appBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryLight,
  },
  appInitials: {
    fontWeight: "800",
  },
  appName: {
    flex: 1,
  },
  action: {
    marginTop: spacing.sm,
  },
  secondaryAction: {
    marginTop: spacing.xs,
  },
});

/**
 * Cashfree checkout for an order awaiting payment.
 *
 *   1. "Pay" opens Cashfree's hosted checkout with the server-issued session.
 *   2. When it closes — success callback, failure, or the customer backing
 *      out — the app asks the SERVER (`POST /payments/:orderId/refresh`),
 *      which asks Cashfree. The SDK callback is never treated as payment.
 *   3. Paid -> order tracking. A failed or abandoned attempt leaves the order
 *      payable: the customer can try again until the payment window closes.
 */

import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Crypto from "expo-crypto";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { OrderStatus } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { api, ApiRequestError } from "@/lib/api";
import { isCashfreeAvailable, openCashfreeCheckout } from "@/lib/cashfree";
import type { CashfreeCheckout as CheckoutSession, CreatePaymentResult, PaymentRefreshResult } from "@/lib/payments";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, Button, Card, NoticeStrip, Screen } from "@/components/ui";

type Phase =
  | "ready" // nothing attempted yet
  | "paying" // Cashfree checkout is open
  | "verifying" // asking the server what happened
  | "retry" // not paid; the order can still be paid
  | "closed" // the payment window closed without a payment
  | "late"; // paid after the window closed — refund under way

/** Polls after the checkout closes: a UPI payment can take a few seconds to settle. */
const VERIFY_ATTEMPTS = 6;
const VERIFY_INTERVAL_MS = 2_500;

const UNAVAILABLE =
  "Online payment is not available in this version of the app. Please update AdiOne to the latest version.";

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
  const attempted = useRef(false);
  const checkout = useRef<CheckoutSession>(initialCheckout);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const amount = formatPaise(amountPaise);

  /** The server's answer, polled briefly while a payment may still be settling. */
  async function verify(): Promise<void> {
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
      setNotice("We could not check your payment right now. If money was deducted, your order will be confirmed automatically.");
      return;
    }
    if (last.paymentStatus === "PAID" || last.status === OrderStatus.PROCESSING) {
      onPaid();
      return;
    }
    if (last.latePaymentRefund) {
      setPhase("late");
      return;
    }
    if (last.status !== OrderStatus.PENDING_PAYMENT) {
      setPhase("closed");
      return;
    }
    setPhase("retry");
    setNotice(
      last.lastAttemptFailed
        ? "The payment did not go through. No money was taken for it — you can try again."
        : "We haven't received a confirmation yet. If money was deducted, your order will be confirmed automatically — or you can try again.",
    );
  }

  async function pay(): Promise<void> {
    if (!isCashfreeAvailable()) {
      setNotice(UNAVAILABLE);
      return;
    }
    setNotice(null);

    // After the first attempt, ask the server for the current session: it
    // returns the same one while it is valid and a fresh one if it expired.
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
    setPhase("paying");
    try {
      // Whatever the SDK reports, the server decides.
      await openCashfreeCheckout(checkout.current);
    } catch {
      if (!mounted.current) return;
    }
    if (mounted.current) await verify();
  }

  function confirmLeave(): void {
    if (attempted.current) {
      Alert.alert(
        "Leave payment?",
        "Your order stays reserved until the payment time ends. If money was deducted, the order will be confirmed automatically.",
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

  const busy = phase === "paying" || phase === "verifying";

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
          <Card style={styles.stateCard}>
            <AppText variant="body" color={colors.textSecondary}>
              Pay with any UPI app, card or net banking on Cashfree's secure checkout. Your order is
              confirmed only after the payment is verified with Cashfree.
            </AppText>
            <Button
              label={
                phase === "verifying"
                  ? "Checking your payment…"
                  : phase === "paying"
                    ? "Payment in progress…"
                    : phase === "retry"
                      ? `Try again · ${amount}`
                      : `Pay ${amount}`
              }
              onPress={() => void pay()}
              disabled={busy || cancelling}
              loading={busy}
              style={styles.action}
            />
            {phase === "retry" && (
              <Button
                label="Check payment status"
                variant="secondary"
                onPress={() => void verify()}
                disabled={busy}
                style={styles.secondaryAction}
              />
            )}
          </Card>
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
  action: {
    marginTop: spacing.sm,
  },
  secondaryAction: {
    marginTop: spacing.xs,
  },
});

/**
 * The unpaid online order, in place in the Cart — never a separate screen.
 *
 *   checking      a small inline "Checking your payment…" while the server is
 *                 asked (non-blocking: the cart stays usable)
 *   waiting       a calm sentence (never "failed" unless the server said the
 *                 attempt failed — and even then no alarm) with Continue
 *                 payment (the same Cashfree order) and Cancel order (the
 *                 items go back into the cart)
 *   ended         why the order could not be placed / a late payment refund
 *   unavailable   this build cannot open Cashfree's checkout
 *
 * Opening / paying show nothing here: Cashfree's checkout is on screen.
 */

import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import { api } from "@/lib/api";
import type { PaymentState } from "@/lib/paymentFlow";
import {
  checkPendingPayment,
  dismissPaymentOutcome,
  forgetPendingPayment,
  resumePayment,
} from "@/lib/pendingPayment";

/** True when the panel has something to show for this state. */
export function paymentPanelShown(state: PaymentState): boolean {
  return (
    state.phase === "checking" ||
    state.phase === "waiting" ||
    state.phase === "ended" ||
    state.phase === "unavailable" ||
    state.phase === "launch_failed"
  );
}

export function PendingPaymentPanel({ state, onCancelled }: { state: PaymentState; onCancelled: () => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!paymentPanelShown(state)) return null;

  if (state.phase === "checking") {
    return (
      <View style={[styles.card, styles.quiet]} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <ActivityIndicator size="small" color={colors.primary} />
          <AppText variant="body" color={colors.textSecondary}>
            Checking your payment…
          </AppText>
        </View>
      </View>
    );
  }

  if (state.phase === "ended") {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Ionicons name={state.reason === "LATE_REFUND" ? "refresh-circle-outline" : "time-outline"} size={20} color={colors.textSecondary} />
          <AppText variant="bodyStrong" style={styles.flex}>
            {state.reason === "LATE_REFUND" ? "Your payment is being refunded" : "This order wasn't placed"}
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary}>
          {state.message}
        </AppText>
        <Button label="OK" variant="secondary" onPress={dismissPaymentOutcome} style={styles.action} />
      </View>
    );
  }

  if (state.phase !== "waiting" && state.phase !== "unavailable" && state.phase !== "launch_failed") return null;
  const order = state.order;
  const amount = formatPaise(order.amountPaise);
  const reason = state.phase === "waiting" ? state.reason : null;
  const message = state.message;

  async function cancelOrder(): Promise<void> {
    setCancelling(true);
    try {
      await api.post(`/orders/${order.orderId}/cancel`, { reason: "Customer cancelled before completing payment" });
      forgetPendingPayment();
      onCancelled();
    } catch {
      // Refused (e.g. it was paid meanwhile): the server's state decides what to show.
      await checkPendingPayment();
    } finally {
      setCancelling(false);
    }
  }

  function confirmCancel(): void {
    Alert.alert(
      "Cancel this order?",
      "The order is cancelled and its items go back into your cart. If money was already deducted, it is refunded automatically.",
      [
        { text: "Keep order", style: "cancel" },
        { text: "Cancel order", style: "destructive", onPress: () => void cancelOrder() },
      ],
    );
  }

  function continuePayment(): void {
    // Paying again while the bank is still answering could charge twice — ask first.
    if (reason === "PENDING") {
      Alert.alert(
        "Your last payment is still processing",
        "Pay again only if your UPI app shows that the payment failed or was cancelled. If money was deducted, this order is confirmed automatically.",
        [
          { text: "Keep waiting", style: "cancel" },
          { text: "Pay again", onPress: () => void resumePayment() },
        ],
      );
      return;
    }
    void resumePayment();
  }

  async function checkAgain(): Promise<void> {
    setChecking(true);
    try {
      await checkPendingPayment();
    } finally {
      setChecking(false);
    }
  }

  // Cashfree said success and the server is confirming it: no second payment offered.
  const confirming = reason === "CONFIRMING";

  // Cashfree's checkout never opened: say so, with the actual error, and try again.
  if (state.phase === "launch_failed") {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Ionicons name="alert-circle-outline" size={20} color={colors.warning} />
          <AppText variant="bodyStrong" style={styles.flex}>
            Couldn't open Cashfree checkout
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary}>
          {state.message}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {state.detail}
        </AppText>
        <View style={styles.actions}>
          <Button label={`Try again · ${amount}`} onPress={() => void resumePayment()} disabled={cancelling} style={styles.grow} />
        </View>
        <Button label="Cancel order" variant="ghost" onPress={confirmCancel} loading={cancelling} style={styles.cancel} />
      </View>
    );
  }

  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <Ionicons name={confirming || reason === "PENDING" ? "hourglass-outline" : "card-outline"} size={20} color={colors.primary} />
        <AppText variant="bodyStrong" style={styles.flex}>
          {confirming ? "Confirming your payment" : `Order awaiting payment · ${amount}`}
        </AppText>
      </View>
      <AppText variant="body" color={colors.textSecondary}>
        {message}
      </AppText>
      <View style={styles.actions}>
        {state.phase === "waiting" && !confirming ? (
          <Button label={`Continue payment · ${amount}`} onPress={continuePayment} disabled={cancelling} style={styles.grow} />
        ) : null}
        {confirming || reason === "PENDING" || reason === "CHECK_FAILED" ? (
          <Button label="Check again" variant="secondary" onPress={() => void checkAgain()} loading={checking} style={styles.grow} />
        ) : null}
      </View>
      {!confirming ? (
        <Button label="Cancel order" variant="ghost" onPress={confirmCancel} loading={cancelling} style={styles.cancel} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quiet: {
    paddingVertical: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  flex: {
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  grow: {
    flexGrow: 1,
    minWidth: 150,
  },
  action: {
    marginTop: spacing.xs,
  },
  cancel: {
    alignSelf: "center",
  },
});

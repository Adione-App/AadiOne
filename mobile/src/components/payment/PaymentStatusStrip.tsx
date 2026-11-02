/**
 * A compact note in the Cart about the last online payment — never an
 * "order awaiting payment" card and never a "Cancel order" button: an unpaid
 * checkout is not an order, and the cart is untouched.
 *
 *   pending (back in the cart)   "Confirming your last payment" — still being
 *                                checked quietly; Check now
 *   launch_failed                Cashfree's checkout could not be opened
 *                                (nothing was paid) — with its error, Try again
 *   ended                        the checkout's time ran out / a late payment
 *                                is being refunded — OK
 *   unavailable                  this build cannot open Cashfree's checkout
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import type { PaymentState } from "@/lib/paymentFlow";
import { checkPendingPayment, dismissPaymentOutcome, resumePayment } from "@/lib/pendingPayment";

/** True when the strip has something to show for this state (`minimized` = the pending screen was left). */
export function paymentStripShown(state: PaymentState, minimized: boolean): boolean {
  return (
    (state.phase === "pending" && minimized) ||
    state.phase === "launch_failed" ||
    state.phase === "ended" ||
    state.phase === "unavailable"
  );
}

export function PaymentStatusStrip({ state, minimized }: { state: PaymentState; minimized: boolean }) {
  const [checking, setChecking] = useState(false);
  if (!paymentStripShown(state, minimized)) return null;

  if (state.phase === "pending") {
    const checkNow = async () => {
      setChecking(true);
      try {
        await checkPendingPayment();
      } finally {
        setChecking(false);
      }
    };
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Ionicons name="hourglass-outline" size={20} color={colors.primary} />
          <AppText variant="bodyStrong" style={styles.flex}>
            Confirming your last payment
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary}>
          {state.message}
        </AppText>
        <Button label="Check now" variant="secondary" onPress={() => void checkNow()} loading={checking} style={styles.action} />
      </View>
    );
  }

  if (state.phase === "ended") {
    return (
      <View style={styles.card} accessibilityLiveRegion="polite">
        <View style={styles.row}>
          <Ionicons name={state.reason === "LATE_REFUND" ? "refresh-circle-outline" : "time-outline"} size={20} color={colors.textSecondary} />
          <AppText variant="bodyStrong" style={styles.flex}>
            {state.reason === "LATE_REFUND" ? "Your payment is being refunded" : "No order was placed"}
          </AppText>
        </View>
        <AppText variant="body" color={colors.textSecondary}>
          {state.message}
        </AppText>
        <Button label="OK" variant="secondary" onPress={dismissPaymentOutcome} style={styles.action} />
      </View>
    );
  }

  if (state.phase === "launch_failed") {
    // Cashfree's checkout never opened: say so, with the actual error, and try again.
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
        <Button label="Try again" onPress={() => void resumePayment()} style={styles.action} />
      </View>
    );
  }

  if (state.phase !== "unavailable") return null;
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <AppText variant="body" color={colors.textSecondary}>
        {state.message}
      </AppText>
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  flex: {
    flex: 1,
  },
  action: {
    marginTop: spacing.xs,
  },
});

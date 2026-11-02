/**
 * Back from Cashfree's checkout: a full, calm screen while the SERVER
 * verifies the payment ("Please wait while your payment is being verified.").
 *
 *   verifying   the server is being asked — nothing to tap; Android's back
 *               does nothing for these few seconds
 *   pending     not settled yet (bank still answering, success not yet
 *               confirmed, server unreachable): a neutral sentence — never
 *               "failed", never "successful" — and "Back to cart" (the cart
 *               is untouched; the checks go on quietly, and a confirmed
 *               payment still opens the order)
 *
 * Nothing here decides anything: lib/paymentFlow.ts shows the server's answer.
 */

import { ActivityIndicator, Modal, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import { MESSAGES, type PaymentState } from "@/lib/paymentFlow";

export function PaymentVerificationScreen({
  state,
  visible,
  onBackToCart,
}: {
  state: PaymentState;
  visible: boolean;
  onBackToCart: () => void;
}) {
  const shown = visible && (state.phase === "verifying" || state.phase === "pending");
  if (!shown) return null;
  const pending = state.phase === "pending";
  const amount = formatPaise(state.order.amountPaise);

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      // Back: while verifying, stay (a few seconds); once pending, back to the cart.
      onRequestClose={() => {
        if (pending) onBackToCart();
      }}
    >
      <View style={styles.screen} accessibilityViewIsModal>
        <View style={styles.center} accessibilityLiveRegion="polite">
          <View style={styles.badge}>
            <ActivityIndicator size="large" color={colors.primary} />
            <View style={styles.shield}>
              <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
            </View>
          </View>
          <AppText variant="h2" style={styles.text}>
            {pending ? "Confirming your payment" : "Verifying payment"}
          </AppText>
          <AppText variant="body" color={colors.textSecondary} style={styles.text}>
            {pending ? state.message : MESSAGES.VERIFYING}
          </AppText>
          <AppText variant="caption" color={colors.textSecondary} style={styles.text}>
            Amount {amount}
          </AppText>
          {!pending ? (
            <AppText variant="caption" color={colors.textSecondary} style={styles.text}>
              Please don't close the app or press back.
            </AppText>
          ) : null}
        </View>
        {pending ? (
          <View style={styles.footer}>
            <Button label="Back to cart" variant="secondary" onPress={onBackToCart} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  badge: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryLight,
    marginBottom: spacing.md,
  },
  shield: {
    position: "absolute",
    bottom: 6,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  text: {
    textAlign: "center",
    maxWidth: 340,
  },
  footer: {
    paddingBottom: spacing.md,
    borderRadius: radius.md,
  },
});

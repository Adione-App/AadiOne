/**
 * The server verified that the payment was NOT made (the attempt failed /
 * was cancelled / declined, or the checkout closed with nothing paid and
 * nothing in progress): a white bottom sheet over the dimmed cart.
 *
 *   Close (X)                    back to the normal cart — every item,
 *                                quantity, address and coupon as they were
 *   Retry payment                the SAME order through Cashfree again (the
 *                                server reuses or renews its Cashfree order —
 *                                never a second Aadione order)
 *   Try another payment method   back to the cart's payment choices, cart
 *                                unchanged; the server reuses or replaces the
 *                                unpaid checkout — never a duplicate
 *
 * It never promises a refund: nothing was taken (a payment that turns out to
 * have gone through is confirmed instead — lib/paymentFlow.ts).
 */

import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "@shared/theme";
import { AppText, Button } from "@/components/ui";
import type { PaymentState } from "@/lib/paymentFlow";

export function PaymentFailedSheet({
  state,
  visible,
  retrying,
  onClose,
  onRetry,
  onAnotherMethod,
}: {
  state: PaymentState;
  visible: boolean;
  retrying: boolean;
  onClose: () => void;
  onRetry: () => void;
  onAnotherMethod: () => void;
}) {
  if (!visible || state.phase !== "failed") return null;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={styles.bottom} pointerEvents="box-none">
          <Pressable
            onPress={onClose}
            style={styles.close}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close and return to cart"
          >
            <Ionicons name="close" size={22} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.sheet} accessibilityViewIsModal>
            <View style={styles.illustration}>
              <Ionicons name="card-outline" size={40} color={colors.textSecondary} />
              <View style={styles.cross}>
                <Ionicons name="close-circle" size={26} color={colors.danger} />
              </View>
            </View>
            <View accessibilityRole="header">
              <AppText variant="h2" style={styles.center}>
                Payment failed
              </AppText>
            </View>
            <AppText variant="body" color={colors.textSecondary} style={styles.center}>
              {state.message}
            </AppText>
            <Button label="Retry payment" onPress={onRetry} loading={retrying} style={styles.retry} />
            <Button label="Try another payment method" variant="ghost" onPress={onAnotherMethod} disabled={retrying} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
  },
  bottom: {
    flex: 1,
    justifyContent: "flex-end",
  },
  close: {
    alignSelf: "center",
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  sheet: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl + spacing.md,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: colors.surface,
  },
  illustration: {
    alignSelf: "center",
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.dangerSurface,
    marginBottom: spacing.sm,
  },
  cross: {
    position: "absolute",
    bottom: 4,
    right: 4,
    borderRadius: 13,
    backgroundColor: colors.surface,
  },
  center: {
    textAlign: "center",
  },
  retry: {
    marginTop: spacing.md,
  },
});

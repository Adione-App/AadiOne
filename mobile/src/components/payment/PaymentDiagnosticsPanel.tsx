/**
 * The payment-launch log on the phone itself — INTERNAL diagnostic build only
 * (EXPO_PUBLIC_PAYMENT_DIAGNOSTICS=1). Renders nothing in store / production
 * builds. Lets a tester read and copy exactly what happened between "Pay
 * Online" and Cashfree's checkout without adb. No secrets are recorded
 * (lib/paymentDiagnostics.ts).
 */

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { PAYMENT_DIAGNOSTICS, clearDiagnostics, usePaymentDiagnostics } from "@/lib/paymentDiagnostics";

export function PaymentDiagnosticsPanel() {
  const lines = usePaymentDiagnostics((s) => s.lines);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  if (!PAYMENT_DIAGNOSTICS) return null;

  const text = lines.map((l) => `${l.at} ${l.event} ${l.data}`).join("\n");

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} style={styles.flex}>
          <AppText variant="caption" color={colors.textPrimary}>
            {open ? "▾" : "▸"} Payment diagnostics ({lines.length})
          </AppText>
        </Pressable>
        <Pressable
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => setCopied(true));
          }}
          hitSlop={8}
        >
          <AppText variant="caption" color={colors.primary}>
            {copied ? "Copied" : "Copy"}
          </AppText>
        </Pressable>
        <Pressable onPress={() => { clearDiagnostics(); setCopied(false); }} hitSlop={8}>
          <AppText variant="caption" color={colors.textSecondary}>
            Clear
          </AppText>
        </Pressable>
      </View>
      {open ? (
        <ScrollView style={styles.log} nestedScrollEnabled>
          {lines.length === 0 ? (
            <AppText variant="caption" color={colors.textSecondary}>
              Tap Pay Online — each launch stage appears here.
            </AppText>
          ) : (
            lines.map((l, i) => (
              <AppText key={`${l.at}-${i}`} variant="caption" color={colors.textPrimary} style={styles.line}>
                {`${l.at.slice(11, 23)} ${l.event} ${l.data}`}
              </AppText>
            ))
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  flex: {
    flex: 1,
  },
  log: {
    maxHeight: 260,
  },
  line: {
    fontFamily: "monospace",
    fontSize: 10,
    lineHeight: 14,
  },
});

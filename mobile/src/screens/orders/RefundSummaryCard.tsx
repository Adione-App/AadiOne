/**
 * Order details — the order's refunds, as the customer sees them: ONE line
 * per refund (a cancellation, an approved request), never split by seller.
 * Each shows its amount, a plain status and, when useful, a short note. Below
 * them, "Request a refund" for a delivered order still inside its window — or
 * why it cannot be requested.
 *
 * Keeps the screen's green-and-white card look (same radius, border, shadow).
 */

import { Pressable, StyleSheet, View } from "react-native";
import { ChevronRight, RotateCcw } from "lucide-react-native";
import type { CustomerRefundDto, OrderRefundsDto } from "@shared";
import { formatPaise } from "@shared/money";
import { formatDateTimeInZone } from "@shared/datetime";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { refundTone } from "@/lib/refunds";

export function RefundSummaryCard({
  data,
  onRequestRefund,
}: {
  data: OrderRefundsDto;
  onRequestRefund: () => void;
}) {
  const { refunds, request } = data;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.icon}>
          <RotateCcw size={21} strokeWidth={2} color={colors.primary} />
        </View>
        <AppText variant="h3">Refunds</AppText>
      </View>

      {refunds.map((refund, index) => (
        <RefundRow key={refund.id} refund={refund} last={index === refunds.length - 1 && !request.eligible && !request.reason} />
      ))}

      {request.eligible ? (
        <Pressable
          onPress={onRequestRefund}
          style={({ pressed }) => [styles.requestRow, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Request a refund for an item in this order"
        >
          <View style={styles.requestText}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Request a refund
            </AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Missing, damaged or wrong item?
              {request.windowEndsAt
                ? ` Request by ${formatDateTimeInZone(new Date(request.windowEndsAt), "Asia/Kolkata")}.`
                : ""}
            </AppText>
          </View>
          <ChevronRight size={18} strokeWidth={2.4} color={colors.primary} />
        </Pressable>
      ) : request.reason ? (
        <AppText variant="caption" color={colors.textSecondary} style={styles.reason}>
          {request.reason}
        </AppText>
      ) : null}
    </View>
  );
}

function RefundRow({ refund, last }: { refund: CustomerRefundDto; last: boolean }) {
  const tone = refundTone(refund.status);
  const partlyBack = refund.refundedPaise > 0 && refund.refundedPaise < refund.amountPaise;
  return (
    <View style={[styles.row, last && styles.rowLast]} accessible accessibilityLabel={`${refund.title}, ${formatPaise(refund.amountPaise)}, ${refund.statusLabel}`}>
      <View style={styles.rowTop}>
        <AppText variant="bodyStrong" numberOfLines={2} style={styles.rowTitle}>
          {refund.title}
        </AppText>
        <AppText variant="bodyStrong">{formatPaise(refund.amountPaise)}</AppText>
      </View>
      <View style={styles.rowMeta}>
        <View style={[styles.pill, { backgroundColor: tone.bg }]}>
          <AppText variant="caption" color={tone.fg} style={styles.pillText}>
            {refund.statusLabel}
          </AppText>
        </View>
        <AppText variant="caption" color={colors.textSecondary}>
          {refund.destination === "BANK_TRANSFER" ? "By UPI / bank transfer" : "To your original payment"}
        </AppText>
      </View>
      {partlyBack && (
        <AppText variant="caption" color={colors.textSecondary} style={styles.note}>
          {formatPaise(refund.refundedPaise)} refunded so far
        </AppText>
      )}
      {refund.note && (
        <AppText variant="caption" color={colors.textSecondary} style={styles.note}>
          {refund.note}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.base,
    marginTop: spacing.md,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowTitle: {
    flex: 1,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
    flexWrap: "wrap",
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  pillText: {
    fontWeight: "700",
  },
  note: {
    marginTop: spacing.xs,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primarySurface,
    borderWidth: 1,
    borderColor: colors.primaryLight,
  },
  requestText: {
    flex: 1,
    gap: 2,
  },
  pressed: {
    opacity: 0.85,
  },
  reason: {
    marginTop: spacing.sm,
  },
});

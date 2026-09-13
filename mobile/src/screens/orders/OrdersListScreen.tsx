/**
 * My Orders (Task 14.12).
 *
 * Badges use the coarse bucket (Ongoing / Delivered / Cancelled) rather than
 * the internal status — a customer does not need to know the difference
 * between READY_FOR_PICKUP and PREPARING, and `toOrderBucket` keeps that
 * decision in one place.
 */

import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OrderSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { formatDateTimeInZone } from "@shared/datetime";
import { colors, radius, spacing } from "@shared/theme";
import { useOrders } from "@/lib/queries";
import {
  AppText,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
} from "@/components/ui";

const BUCKET_STYLE = {
  ONGOING: { bg: colors.infoSurface, fg: colors.info, label: "Ongoing" },
  DELIVERED: {
    bg: colors.successSurface,
    fg: colors.success,
    label: "Delivered",
  },
  CANCELLED: {
    bg: colors.dangerSurface,
    fg: colors.danger,
    label: "Cancelled",
  },
} as const;

export default function OrdersListScreen({
  onOpenOrder,
  onBrowse,
}: {
  onOpenOrder: (orderId: string) => void;
  onBrowse: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, refetch, isRefetching } = useOrders();

  if (isLoading) return <Loading label="Loading your orders…" />;
  if (isError) {
    return (
      <ErrorState
        message="We could not load your orders."
        onRetry={() => void refetch()}
      />
    );
  }

  const orders = data?.items ?? [];

  if (orders.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        hint="Your orders will appear here once you place one."
        action={{ label: "Start shopping", onPress: onBrowse }}
      />
    );
  }

  const renderItem = ({ item }: { item: OrderSummaryDto }) => {
    const bucket = BUCKET_STYLE[item.bucket];
    return (
      <Pressable onPress={() => onOpenOrder(item.id)}>
        <Card style={{ marginBottom: spacing.md }}>
          <View style={styles.row}>
            <View>
              <AppText variant="caption" color={colors.textSecondary}>
                Order ID
              </AppText>
              <AppText variant="bodyStrong">#{item.orderNumber}</AppText>
              <AppText variant="caption" color={colors.textSecondary}>
                {formatDateTimeInZone(new Date(item.placedAt), "Asia/Kolkata")}
              </AppText>
            </View>

            <View style={{ alignItems: "flex-end", gap: spacing.xs }}>
              <View style={[styles.badge, { backgroundColor: bucket.bg }]}>
                <AppText variant="caption" color={bucket.fg}>
                  {item.bucket === "ONGOING" ? item.statusLabel : bucket.label}
                </AppText>
              </View>
              <AppText variant="bodyStrong">
                {formatPaise(item.totalPaise)}
              </AppText>
              <AppText variant="caption" color={colors.textSecondary}>
                {item.itemCount} item{item.itemCount === 1 ? "" : "s"}
              </AppText>
            </View>
          </View>
        </Card>
      </Pressable>
    );
  };

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <AppText variant="h1">My Orders</AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          Your order history
        </AppText>
      </View>

      <FlatList
        data={orders}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{
          padding: spacing.base,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: "row", justifyContent: "space-between" },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
});

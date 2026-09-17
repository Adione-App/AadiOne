/**
 * My Orders (Task 14.12).
 *
 * Badges use the coarse bucket (Ongoing / Delivered / Cancelled) rather than
 * the internal status — a customer does not need to know the difference
 * between READY_FOR_PICKUP and PREPARING, and `toOrderBucket` keeps that
 * decision in one place.
 */

import { FlatList, Image, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronRight } from "lucide-react-native";
import type { OrderSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { formatDateTimeInZone } from "@shared/datetime";
import { colors, radius, spacing } from "@shared/theme";
import { useOrders } from "@/lib/queries";
import { resolveImageUrl } from "@/lib/api";
import {
  AppText,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
} from "@/components/ui";

/** More than this many item thumbnails and the rest collapse into a "+N" tile. */
const MAX_THUMBNAILS = 4;

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
    const shownThumbnails = item.itemThumbnails.slice(0, MAX_THUMBNAILS);
    const hiddenCount = item.itemCount - shownThumbnails.length;

    return (
      <Pressable onPress={() => onOpenOrder(item.id)}>
        <Card style={styles.card}>
          <View style={styles.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="caption" color={colors.textSecondary}>
                Order #{item.orderNumber}
              </AppText>
              <AppText variant="caption" color={colors.textSecondary}>
                {formatDateTimeInZone(new Date(item.placedAt), "Asia/Kolkata")}
              </AppText>
            </View>

            <View style={[styles.badge, { backgroundColor: bucket.bg }]}>
              <AppText variant="caption" color={bucket.fg}>
                {item.bucket === "ONGOING" ? item.statusLabel : bucket.label}
              </AppText>
            </View>
          </View>

          {shownThumbnails.length > 0 && (
            <View style={styles.thumbRow}>
              {shownThumbnails.map((url, index) => {
                const resolved = resolveImageUrl(url);
                return resolved ? (
                  <Image
                    key={`${url}-${index}`}
                    source={{ uri: resolved }}
                    style={styles.thumb}
                    resizeMode="contain"
                  />
                ) : (
                  <View key={`${url}-${index}`} style={styles.thumbPlaceholder} />
                );
              })}

              {hiddenCount > 0 && (
                <View style={styles.thumbMore}>
                  <AppText variant="caption" color={colors.textSecondary}>
                    +{hiddenCount}
                  </AppText>
                </View>
              )}
            </View>
          )}

          <View style={styles.bottomRow}>
            <AppText variant="caption" color={colors.textSecondary}>
              {item.itemCount} item{item.itemCount === 1 ? "" : "s"}
            </AppText>

            <View style={styles.bottomRight}>
              <AppText variant="bodyStrong">{formatPaise(item.totalPaise)}</AppText>
              <ChevronRight size={16} color={colors.textMuted} />
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
  card: { marginBottom: spacing.md, padding: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },

  thumbRow: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  thumbPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.skeleton,
  },
  thumbMore: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },

  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  bottomRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
});

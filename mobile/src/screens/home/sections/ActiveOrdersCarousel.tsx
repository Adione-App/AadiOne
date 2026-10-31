/**
 * Home — orders in progress. Every order of the customer that is on its way
 * (GET /orders/active: paid online or COD, not delivered or cancelled), one
 * card each, in a carousel:
 *
 *   - one order: one card, nothing moves;
 *   - several: the next card every ~2.5 s, with dots; a swipe takes over and
 *     the rotation resumes ~2.5 s after the swipe settles;
 *   - a refresh (a new order, a status change, one delivered) keeps the card
 *     on screen by its ORDER ID — never jumps back to the first one;
 *   - paused while Home is not on screen, or with Reduce Motion on.
 *
 * Tapping a card opens that order's tracking. The cards keep the earlier
 * single "order in progress" banner's look (green surface, rounded, Track ›).
 */

import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type ScrollViewInstance } from "react-native";
import { ChevronRight, Package } from "lucide-react-native";
import { formatPaise, type OrderSummaryDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { ACTIVE_ORDER_ROTATE_MS, indexAfterRefresh, nextCarouselIndex } from "@/lib/activeOrders";

export function ActiveOrdersCarousel({
  orders,
  paused,
  onOpen,
}: {
  orders: readonly OrderSummaryDto[];
  /** Home not focused (another tab or screen on top). */
  paused: boolean;
  onOpen: (orderId: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const shownIds = useRef<string[]>([]);
  const count = orders.length;
  const idsKey = orders.map((o) => o.id).join(",");

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => sub.remove();
  }, []);

  // The list changed: stay on the same order (by id), without animation.
  useEffect(() => {
    const nextIds = idsKey ? idsKey.split(",") : [];
    const next = indexAfterRefresh(shownIds.current, index, nextIds);
    shownIds.current = nextIds;
    if (next !== index) setIndex(next);
    if (width > 0) scrollRef.current?.scrollTo({ x: next * width, animated: false });
    // Only when the set or order of ids changes — a status change keeps the ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Rotation: one timer at a time, restarted after every move (a tick or a swipe).
  useEffect(() => {
    if (count <= 1 || paused || dragging || reduceMotion || width === 0) return undefined;
    const timer = setTimeout(() => {
      const next = nextCarouselIndex(index, count);
      setIndex(next);
      scrollRef.current?.scrollTo({ x: next * width, animated: true });
    }, ACTIVE_ORDER_ROTATE_MS);
    return () => clearTimeout(timer);
  }, [index, count, paused, dragging, reduceMotion, width]);

  if (count === 0) return null;

  const onLayout = (event: LayoutChangeEvent) => {
    const w = Math.round(event.nativeEvent.layout.width);
    if (w !== width) {
      setWidth(w);
      // A new width (rotation, first layout): re-align to the current card.
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ x: index * w, animated: false }));
    }
  };

  return (
    <View onLayout={onLayout} accessibilityLabel={count > 1 ? `${count} orders in progress` : undefined}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEnabled={count > 1}
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => setDragging(true)}
        onMomentumScrollEnd={(event) => {
          if (width > 0) {
            const settled = Math.round(event.nativeEvent.contentOffset.x / width);
            setIndex(Math.max(0, Math.min(count - 1, settled)));
          }
          setDragging(false);
        }}
        // A drag released without momentum still resumes the rotation.
        onScrollEndDrag={(event) => {
          if (Math.abs(event.nativeEvent.velocity?.x ?? 0) < 0.05) {
            if (width > 0) setIndex(Math.max(0, Math.min(count - 1, Math.round(event.nativeEvent.contentOffset.x / width))));
            setDragging(false);
          }
        }}
      >
        {orders.map((order) => (
          <View key={order.id} style={{ width: width || undefined }}>
            <OrderCard order={order} onOpen={onOpen} />
          </View>
        ))}
      </ScrollView>

      {count > 1 && (
        <View style={styles.dots} accessible={false} importantForAccessibility="no-hide-descendants">
          {orders.map((order, i) => (
            <View key={order.id} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

function OrderCard({ order, onOpen }: { order: OrderSummaryDto; onOpen: (orderId: string) => void }) {
  const items = `${order.itemCount} ${order.itemCount === 1 ? "item" : "items"}`;
  return (
    <Pressable
      onPress={() => onOpen(order.id)}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Order ${order.orderNumber}, ${order.statusLabel}, ${items}. Track order`}
    >
      <View style={styles.icon}>
        <Package size={20} color={colors.primary} strokeWidth={2} />
      </View>
      <View style={styles.text}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          Order #{order.orderNumber}
        </AppText>
        <AppText variant="caption" color={colors.primary} numberOfLines={1} style={styles.status}>
          {order.statusLabel}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
          {items} · {formatPaise(order.currentPayablePaise)}
        </AppText>
      </View>
      <View style={styles.action}>
        <AppText variant="bodyStrong" color={colors.primary} style={styles.actionText}>
          Track
        </AppText>
        <ChevronRight size={16} color={colors.primary} strokeWidth={2.5} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    backgroundColor: colors.primarySurface,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  status: {
    marginTop: 1,
    fontWeight: "700",
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
    marginLeft: spacing.sm,
  },
  actionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: spacing.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primaryLight,
  },
  dotActive: {
    width: 16,
    backgroundColor: colors.primary,
  },
});

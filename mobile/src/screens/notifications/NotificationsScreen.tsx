/**
 * Notifications — the customer's in-app feed.
 *
 * Tapping a row marks it read (once — a row already read, or with a read
 * request in flight, sends nothing) and, when it is about an order, opens
 * that order's tracking screen. What each type looks like and where it leads
 * lives in lib/notifications.ts, not here.
 */

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing } from "@shared/theme";
import { ApiRequestError } from "@/lib/api";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationFeed,
  useNotificationUnreadCount,
} from "@/lib/queries";
import {
  flattenNotificationPages,
  formatNotificationTime,
  notificationDestination,
  presentNotification,
  type NotificationDto,
} from "@/lib/notifications";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, EmptyState, ErrorState, Loading, Screen } from "@/components/ui";

export default function NotificationsScreen({
  onBack,
  onOpenOrder,
}: {
  onBack: () => void;
  onOpenOrder: (orderId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const feed = useNotificationFeed();
  const unread = useNotificationUnreadCount();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  /** Ids with a read request in flight — a double tap must not send two. */
  const pendingReads = useRef(new Set<string>());

  const items = useMemo(() => flattenNotificationPages(feed.data?.pages), [feed.data]);
  const hasUnread = (unread.data ?? 0) > 0 || items.some((n) => !n.isRead);

  const openItem = useCallback(
    (item: NotificationDto) => {
      if (!item.isRead && !pendingReads.current.has(item.id)) {
        pendingReads.current.add(item.id);
        markRead
          .mutateAsync(item.id)
          .catch(() => undefined)
          .finally(() => pendingReads.current.delete(item.id));
      }
      const destination = notificationDestination(item);
      if (destination) onOpenOrder(destination.orderId);
    },
    [markRead, onOpenOrder],
  );

  const loadMore = useCallback(() => {
    // One page at a time, and never past the last cursor.
    if (feed.hasNextPage && !feed.isFetchingNextPage && !feed.isFetchNextPageError) {
      void feed.fetchNextPage();
    }
  }, [feed]);

  const refresh = useCallback(() => {
    void feed.refetch();
    void unread.refetch();
  }, [feed, unread]);

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        onPress={onBack}
        hitSlop={12}
        style={styles.back}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <AppText variant="h2">←</AppText>
      </Pressable>
      <AppText variant="h3" style={{ flex: 1 }}>
        Notifications
      </AppText>
      {items.length > 0 && hasUnread && (
        <Pressable
          onPress={() => markAllRead.mutate()}
          disabled={markAllRead.isPending}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Mark all notifications as read"
        >
          <AppText
            variant="bodyStrong"
            color={markAllRead.isPending ? colors.textMuted : colors.primary}
          >
            Mark all read
          </AppText>
        </Pressable>
      )}
    </View>
  );

  let body: ReactNode;
  if (feed.isPending) {
    body = <Loading label="Loading notifications…" />;
  } else if (feed.isError && items.length === 0) {
    body = (
      <ErrorState
        message="We could not load your notifications."
        offline={feed.error instanceof ApiRequestError && feed.error.isOffline}
        onRetry={() => void feed.refetch()}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        title="No notifications yet"
        hint="Updates about your orders, payments and refunds will show up here."
        icon={<Ionicons name="notifications-outline" size={44} color={colors.primary} />}
      />
    );
  } else {
    body = (
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <NotificationRow item={item} onPress={openItem} />}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={{ paddingBottom: tabBarClearance + spacing.xxl }}
        refreshing={feed.isRefetching && !feed.isFetchingNextPage}
        onRefresh={refresh}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          feed.isFetchingNextPage ? (
            <ActivityIndicator style={styles.footer} color={colors.primary} />
          ) : feed.isFetchNextPageError ? (
            <Pressable
              onPress={() => void feed.fetchNextPage()}
              style={styles.footer}
              accessibilityRole="button"
            >
              <AppText variant="caption" color={colors.textSecondary} style={{ textAlign: "center" }}>
                Could not load more. Tap to retry.
              </AppText>
            </Pressable>
          ) : null
        }
      />
    );
  }

  return (
    <Screen>
      {header}
      {body}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function NotificationRow({
  item,
  onPress,
}: {
  item: NotificationDto;
  onPress: (item: NotificationDto) => void;
}) {
  const look = presentNotification(item.type);
  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [
        styles.row,
        !item.isRead && styles.rowUnread,
        pressed && styles.rowPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${item.isRead ? "" : "Unread. "}${item.title}. ${item.body}`}
    >
      <View style={[styles.iconCircle, { backgroundColor: look.toneSurface }]}>
        <Ionicons name={look.icon} size={20} color={look.tone} />
      </View>

      <View style={styles.rowText}>
        <AppText variant={item.isRead ? "body" : "bodyStrong"} numberOfLines={2}>
          {item.title}
        </AppText>
        <AppText variant="body" color={colors.textSecondary} numberOfLines={3}>
          {item.body}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
          {formatNotificationTime(item.createdAt)}
        </AppText>
      </View>

      {!item.isRead && <View style={styles.unreadDot} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  rowUnread: { backgroundColor: colors.primarySurface },
  rowPressed: { opacity: 0.7 },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    backgroundColor: colors.primary,
  },
  separator: { height: 1, backgroundColor: colors.divider },
  footer: { paddingVertical: spacing.lg },
});

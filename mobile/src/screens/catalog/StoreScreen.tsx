/**
 * A seller's store page — its header (GET /stores/:sellerId) and every
 * product it lists, priced by ITS OWN offers (GET /products?sellerId=),
 * loaded a page at a time as the customer scrolls.
 */

import { useCallback, useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProductSummaryDto, StoreSummaryDto } from "@shared";
import { formatDistance } from "@shared/distance";
import { colors, palette, radius, spacing } from "@shared/theme";
import { ProductCard } from "@/components/ProductCard";
import { ProductGridSkeleton } from "@/components/ProductCardSkeleton";
import { AppText, EmptyState, ErrorState, NoticeStrip, Screen } from "@/components/ui";
import { useStore, useStoreProducts } from "@/lib/queries";
import { useLocation } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { useCartActions } from "@/lib/useCartActions";
import { useGridColumns } from "@/lib/useGridColumns";
import { storeSubtitle } from "@/screens/home/homeEngine";

/** Room for MiniCartBar, which rests above the tab bar on this screen. */
const MINI_CART_ROOM = 84;

function StoreHeader({ store }: { store: StoreSummaryDto }) {
  return (
    <View style={styles.info}>
      <View style={styles.avatar}>
        <AppText style={styles.letter}>{store.name.trim().charAt(0).toUpperCase()}</AppText>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={styles.name} numberOfLines={1}>
          {store.name}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
          {storeSubtitle(store)}
        </AppText>
        <View style={styles.metaRow}>
          <View style={[styles.pill, store.isOpen ? styles.pillOpen : styles.pillClosed]}>
            <AppText style={[styles.pillText, { color: store.isOpen ? palette.green700 : colors.textSecondary }]} numberOfLines={1}>
              {store.isOpen ? "Open now" : store.nextOpenText ?? "Closed now"}
            </AppText>
          </View>
          <AppText variant="caption" color={colors.textSecondary}>
            {store.productCount} {store.productCount === 1 ? "product" : "products"}
            {store.distanceKm !== null ? ` · ${formatDistance(store.distanceKm)}` : ""}
          </AppText>
        </View>
      </View>
    </View>
  );
}

export default function StoreScreen({
  sellerId,
  onBack,
  onOpenProduct,
}: {
  sellerId: string;
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const columns = useGridColumns();
  const cart = useCartActions();
  const location = useLocation((state) => state.location);
  const near = useMemo(
    () => (location ? { latitude: location.latitude, longitude: location.longitude } : null),
    [location],
  );

  const store = useStore(sellerId, near);
  const products = useStoreProducts(sellerId);
  const items = useMemo(() => products.data?.pages.flatMap((page) => page.items) ?? [], [products.data]);

  const renderItem = useCallback(
    ({ item }: { item: ProductSummaryDto }) => (
      <View style={[styles.cardWrapper, { width: `${100 / columns}%` }]}>
        <ProductCard
          product={item}
          qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
          busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
          onPress={onOpenProduct}
          onAdd={cart.add}
          onIncrement={cart.increment}
          onDecrement={cart.decrement}
        />
      </View>
    ),
    [cart, columns, onOpenProduct],
  );

  const loadMore = useCallback(() => {
    if (products.hasNextPage && !products.isFetchingNextPage) void products.fetchNextPage();
  }, [products]);

  return (
    <Screen style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={colors.textPrimary} strokeWidth={2.25} />
        </Pressable>
        <AppText variant="h3" numberOfLines={1} style={{ flex: 1 }}>
          {store.data?.name ?? "Store"}
        </AppText>
      </View>

      {cart.error && (
        <View style={styles.notice}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {store.isError ? (
        <ErrorState message="This store isn't available right now." onRetry={() => void store.refetch()} />
      ) : products.isLoading ? (
        <ProductGridSkeleton columns={columns} />
      ) : products.isError ? (
        <ErrorState message="We could not load this store." onRetry={() => void products.refetch()} />
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          extraData={cart}
          numColumns={columns}
          ListHeaderComponent={store.data ? <StoreHeader store={store.data} /> : null}
          ListEmptyComponent={<EmptyState title="Nothing here yet" hint="This store hasn't listed any products right now." />}
          ListFooterComponent={
            products.isFetchingNextPage ? <ActivityIndicator color={colors.primary} style={{ margin: spacing.base }} /> : null
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.6}
          contentContainerStyle={{ padding: spacing.sm, paddingBottom: tabBarClearance + MINI_CART_ROOM }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: {
    width: 36,
    height: 36,
    justifyContent: "center",
  },
  notice: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
  },
  info: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    margin: spacing.xs,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: palette.green50,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: palette.white,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "800",
    color: palette.green600,
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: 4,
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    maxWidth: "100%",
  },
  pillOpen: {
    backgroundColor: palette.white,
  },
  pillClosed: {
    backgroundColor: colors.surfaceSunken,
  },
  pillText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },
  // Same grid cell spacing as RailProductsScreen / CategoriesScreen.
  cardWrapper: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
});

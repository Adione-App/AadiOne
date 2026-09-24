/**
 * "See All" for a Home rail (Popular, Offers, …).
 *
 * Shows the exact same ranking as the Home preview, just without the 10-item
 * cap — see `catalogService.listRailProducts` on the backend.
 */

import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HomeFeedDto, ProductSummaryDto } from "@shared";
import { colors, spacing } from "@shared/theme";
import { useRailProducts } from "@/lib/queries";
import { useCartActions } from "@/lib/useCartActions";
import { useGridColumns } from "@/lib/useGridColumns";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { AppText, EmptyState, ErrorState, NoticeStrip, Screen } from "@/components/ui";
import { ProductCard } from "@/components/ProductCard";
import { ProductGridSkeleton } from "@/components/ProductCardSkeleton";

export default function RailProductsScreen({
  railKey,
  fallbackTitle,
  onBack,
  onOpenProduct,
}: {
  railKey: HomeFeedDto["rails"][number]["key"];
  fallbackTitle: string;
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const rail = useRailProducts(railKey);
  const cart = useCartActions();
  const columns = useGridColumns();

  // Percentage width, not flex:1 — an incomplete last row (odd item count)
  // would otherwise stretch its lone card to the full row width instead of
  // its own column's share (see CategoriesScreen for the same fix).
  const renderItem = ({ item }: { item: ProductSummaryDto }) => (
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
  );

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">{rail.data?.title ?? fallbackTitle}</AppText>
      </View>

      {cart.error && (
        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm }}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {rail.isLoading ? (
        <ProductGridSkeleton columns={columns} />
      ) : rail.isError ? (
        <ErrorState message="We could not load this." onRetry={() => void rail.refetch()} />
      ) : (rail.data?.products.length ?? 0) === 0 ? (
        <EmptyState title="Nothing here yet" hint="Check back in a little while." />
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={rail.data?.products ?? []}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={columns}
          contentContainerStyle={{
            padding: spacing.sm,
            // The tab bar floats over this screen now (see MainTabs.tsx's
            // `AnimatedTabBar`) rather than reserving its own flex space.
            paddingBottom: tabBarClearance + spacing.xxl,
          }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          updateCellsBatchingPeriod={50}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: "center" },
  // Bigger vertical than horizontal padding — more breathing room BETWEEN
  // ROWS specifically (matches CategoriesScreen/SearchScreen's grids).
  cardWrapper: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
});

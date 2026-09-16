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
import { AppText, EmptyState, ErrorState, Loading, NoticeStrip, Screen } from "@/components/ui";
import { ProductCard } from "@/components/ProductCard";

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
  const rail = useRailProducts(railKey);
  const cart = useCartActions();
  const columns = useGridColumns();

  const renderItem = ({ item }: { item: ProductSummaryDto }) => (
    <View style={styles.cardWrapper}>
      <ProductCard
        product={item}
        qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
        busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
        onPress={() => onOpenProduct(item.id)}
        onAdd={() => item.defaultVariant && void cart.add(item.defaultVariant.id)}
        onIncrement={() => item.defaultVariant && void cart.increment(item.defaultVariant.id)}
        onDecrement={() => item.defaultVariant && void cart.decrement(item.defaultVariant.id)}
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
        <Loading />
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
          contentContainerStyle={{ padding: spacing.sm, paddingBottom: spacing.xxl }}
          showsVerticalScrollIndicator={false}
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
  cardWrapper: { flex: 1, padding: spacing.xs },
});

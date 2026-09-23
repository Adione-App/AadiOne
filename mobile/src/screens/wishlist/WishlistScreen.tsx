/**
 * Wishlist tab — every product saved via the heart icon on its card (see
 * ProductCard.tsx), read straight from the shared local store (useWishlist.ts).
 * Same grid/card/header shape as RailProductsScreen and CategoriesScreen's
 * own product grid, so a saved product looks and behaves identically here —
 * same ProductCard, same Add/stepper, same navigation into Product Detail.
 */

import { Pressable, FlatList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Heart } from "lucide-react-native";
import type { ProductSummaryDto } from "@shared";
import { colors, spacing } from "@shared/theme";
import { useWishlist } from "@/lib/useWishlist";
import { useCartActions } from "@/lib/useCartActions";
import { useGridColumns } from "@/lib/useGridColumns";
import { AppText, EmptyState, NoticeStrip, Screen } from "@/components/ui";
import { ProductCard } from "@/components/ProductCard";

export default function WishlistScreen({
  onOpenProduct,
  onBrowse,
}: {
  onOpenProduct: (productId: string) => void;
  onBrowse: () => void;
}) {
  const insets = useSafeAreaInsets();
  const order = useWishlist((state) => state.order);
  const products = useWishlist((state) => state.products);
  const clearWishlist = useWishlist((state) => state.clear);
  const cart = useCartActions();
  const columns = useGridColumns();

  const items = order
    .map((id) => products[id])
    .filter((product): product is ProductSummaryDto => product !== undefined);

  // Percentage width, not flex:1 — an incomplete last row (odd item count)
  // would otherwise stretch its lone card to the full row width instead of
  // its own column's share (see CategoriesScreen/RailProductsScreen for the
  // same fix).
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
        <AppText variant="h1" numberOfLines={1} style={{ flex: 1 }}>
          Wishlist
        </AppText>

        {items.length > 0 && (
          <Pressable
            onPress={clearWishlist}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear wishlist"
          >
            <AppText variant="bodyStrong" color={colors.primary}>
              Clear all
            </AppText>
          </Pressable>
        )}
      </View>

      {cart.error && (
        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm }}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<Heart size={48} color={colors.primary} strokeWidth={2} />}
          title="Your wishlist is empty"
          hint="Tap the heart on any product to save it here for later."
          action={{
            label: "Browse products",
            onPress: onBrowse,
          }}
        />
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={columns}
          contentContainerStyle={{ padding: spacing.sm, paddingBottom: spacing.xxl }}
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
  // Bigger vertical than horizontal padding — more breathing room BETWEEN
  // ROWS specifically (matches CategoriesScreen/SearchScreen/RailProducts's
  // grids).
  cardWrapper: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
});

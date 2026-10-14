/**
 * A horizontal product shelf — the existing `ProductCard`, unchanged, in a
 * virtualized horizontal FlatList inside a Home panel.
 *
 * Cards are handed the SAME stable cart callbacks Home always used
 * (`cart.add`/`increment`/`decrement`, see useCartActions), so React.memo on
 * ProductCard still skips every card whose own quantity didn't change.
 *
 * Which products a shelf shows is decided by the engine (homeEngine.ts); this
 * component only draws them. Every shelf with somewhere to go (its
 * `viewAll`: the category, the rail or previous orders) ends with a
 * full-width "See All" right under its own products, inside the same panel.
 */

import { memo, useCallback } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { ProductSummaryDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { ProductCard } from "@/components/ProductCard";
import type { useCartActions } from "@/lib/useCartActions";
import type { HomeAction, HomeSection } from "../homeEngine";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

/** The width Home has always given a ProductCard in a horizontal rail. */
export const SHELF_CARD_WIDTH = 132;
const CARD_GAP = 8;

type Cart = ReturnType<typeof useCartActions>;
type Shelf = Extract<HomeSection, { kind: "shelf" }>;

function ProductShelfImpl({
  section,
  cart,
  onOpenProduct,
  onAction,
}: {
  section: Shelf;
  cart: Cart;
  onOpenProduct: (productId: string) => void;
  onAction: (action: HomeAction) => void;
}) {
  const renderProduct = useCallback(
    ({ item }: { item: ProductSummaryDto }) => (
      <View style={styles.productWrapper}>
        <ProductCard
          product={item}
          qtyInCart={cart.qtyForCard(item)}
          busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
          onPress={onOpenProduct}
          onAdd={cart.add}
          onIncrement={cart.increment}
          onDecrement={cart.decrement}
        />
      </View>
    ),
    [cart, onOpenProduct],
  );

  const viewAll = section.viewAll;

  return (
    <SectionPanel>
      {/* "See All" sits under the products (below), not in the header. */}
      <SectionHeader title={section.title} subtitle={section.subtitle} />
      <FlatList
        horizontal
        data={section.products}
        keyExtractor={keyOf}
        renderItem={renderProduct}
        extraData={cart}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.productRow}
        getItemLayout={itemLayout}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews
      />
      {viewAll ? (
        <Pressable
          onPress={() => onAction(viewAll)}
          style={({ pressed }) => [styles.seeAll, pressed && styles.seeAllPressed]}
          accessibilityRole="button"
          accessibilityLabel={`See all ${section.title}`}
        >
          <AppText style={styles.seeAllText}>See All</AppText>
          <ChevronRight size={16} color={colors.textPrimary} strokeWidth={2.5} />
        </Pressable>
      ) : null}
    </SectionPanel>
  );
}

const keyOf = (item: ProductSummaryDto) => item.id;

const itemLayout = (_data: ArrayLike<ProductSummaryDto> | null | undefined, index: number) => ({
  length: SHELF_CARD_WIDTH + CARD_GAP,
  offset: (SHELF_CARD_WIDTH + CARD_GAP) * index,
  index,
});

export const ProductShelf = memo(ProductShelfImpl);

const styles = StyleSheet.create({
  productRow: {
    paddingHorizontal: PANEL_PADDING,
    gap: CARD_GAP,
  },
  productWrapper: {
    width: SHELF_CARD_WIDTH,
  },
  seeAll: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    height: 44,
    marginHorizontal: PANEL_PADDING,
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  seeAllPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  seeAllText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "700",
    color: colors.textPrimary,
  },
});

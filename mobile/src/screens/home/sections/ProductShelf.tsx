/**
 * A horizontal product shelf — the existing `ProductCard`, unchanged, in a
 * virtualized horizontal FlatList inside a Home panel.
 *
 * Each shelf reads the cart ITSELF (useCartActions) instead of being handed
 * Home's: a cart tap re-renders the shelves — whose memoised cards skip
 * every product whose own quantity did not change — never the whole Home
 * screen (banners, header, every section), as it used to on every tap.
 *
 * Which products a shelf shows is decided by the engine (homeEngine.ts) or,
 * for a shelf added in the Home Page Builder, by the server
 * (GET /content/home-shelves); this component only draws them. Every shelf
 * with somewhere to go (its `viewAll`: the category, the rail or previous
 * orders) ends with a full-width "See All" right under its own products,
 * inside the same panel.
 *
 * `display` (added shelves): a carousel with the admin's card size and gap,
 * or a grid of 2 or 3 per row — fewer when a card would get too narrow on
 * this phone (productGridColumns), so nothing ever overflows the screen.
 * Without it the shelf is exactly Home's standard carousel.
 */

import { memo, useCallback, useMemo } from "react";
import { FlatList, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { ProductSummaryDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { ProductCard } from "@/components/ProductCard";
import { useCartActions } from "@/lib/useCartActions";
import type { HomeAction, HomeSection } from "../homeEngine";
import { productGridColumns, type ProductShelfDisplay } from "../homeLayout";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

/** The width Home has always given a ProductCard in a horizontal rail. */
export const SHELF_CARD_WIDTH = 132;
const CARD_GAP = 8;

type Shelf = Pick<Extract<HomeSection, { kind: "shelf" }>, "title" | "subtitle" | "products" | "viewAll">;

/** Home's standard carousel — what every engine shelf uses. */
const STANDARD_DISPLAY: ProductShelfDisplay = { layout: "carousel", columns: 2, cardWidth: SHELF_CARD_WIDTH, gap: CARD_GAP };

function ProductShelfImpl({
  section,
  display = STANDARD_DISPLAY,
  onOpenProduct,
  onAction,
}: {
  section: Shelf;
  display?: ProductShelfDisplay;
  onOpenProduct: (productId: string) => void;
  onAction: (action: HomeAction) => void;
}) {
  const cart = useCartActions();
  const { width: screenWidth } = useWindowDimensions();
  const grid = useMemo(
    () => (display.layout === "grid" ? productGridColumns(display.columns, screenWidth - PANEL_PADDING * 2, display.gap) : null),
    [display.layout, display.columns, display.gap, screenWidth],
  );
  const cardWidth = grid ? grid.cardWidth : display.cardWidth;
  const renderProduct = useCallback(
    ({ item }: { item: ProductSummaryDto }) => (
      <View style={{ width: cardWidth }}>
        <ProductCard
          product={item}
          qtyInCart={cart.qtyForCard(item)}
          cartVariantId={cart.cartVariantForCard(item)}
          busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
          onPress={onOpenProduct}
          onAdd={cart.add}
          onIncrement={cart.increment}
          onDecrement={cart.decrement}
        />
      </View>
    ),
    [cart, onOpenProduct, cardWidth],
  );

  const viewAll = section.viewAll;
  const itemLayout = useCallback(
    (_data: ArrayLike<ProductSummaryDto> | null | undefined, index: number) => ({
      length: display.cardWidth + display.gap,
      offset: (display.cardWidth + display.gap) * index,
      index,
    }),
    [display.cardWidth, display.gap],
  );

  return (
    <SectionPanel>
      {/* "See All" sits under the products (below), not in the header. */}
      <SectionHeader title={section.title} subtitle={section.subtitle} />
      {grid ? (
        // A short, fixed list (the shelf's count): plain rows, no nested scrolling list.
        <View style={[styles.grid, { columnGap: display.gap, rowGap: display.gap + 4 }]}>
          {section.products.map((product) => (
            <View key={product.id}>{renderProduct({ item: product })}</View>
          ))}
        </View>
      ) : (
        <FlatList
          horizontal
          data={section.products}
          keyExtractor={keyOf}
          renderItem={renderProduct}
          extraData={cart}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[styles.productRow, { gap: display.gap }]}
          getItemLayout={itemLayout}
          initialNumToRender={4}
          maxToRenderPerBatch={4}
          windowSize={5}
          removeClippedSubviews
        />
      )}
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

export const ProductShelf = memo(ProductShelfImpl);

const styles = StyleSheet.create({
  productRow: {
    paddingHorizontal: PANEL_PADDING,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: PANEL_PADDING,
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

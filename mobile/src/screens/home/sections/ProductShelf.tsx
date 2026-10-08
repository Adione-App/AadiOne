/**
 * A horizontal product shelf — the existing `ProductCard`, unchanged, in a
 * virtualized horizontal FlatList inside a Home panel.
 *
 * Cards are handed the SAME stable cart callbacks Home always used
 * (`cart.add`/`increment`/`decrement`, see useCartActions), so React.memo on
 * ProductCard still skips every card whose own quantity didn't change.
 *
 * A lazy shelf (a subcategory further down the page) fetches its products
 * only once it is mounted — i.e. once the outer list scrolls near it — and
 * shows card skeletons until they arrive. Its products are passed back DOWN
 * from Home after cross-section de-duplication, so this component only
 * triggers the fetch; it never decides what to show.
 */

import { memo, useCallback } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ProductSummaryDto } from "@shared";
import { ProductCard } from "@/components/ProductCard";
import { useHomeSectionProducts } from "@/lib/queries";
import type { useCartActions } from "@/lib/useCartActions";
import type { HomeAction, HomeSection } from "../homeEngine";
import { ShelfSkeleton, useShimmer } from "./HomeSkeleton";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

/** The width Home has always given a ProductCard in a horizontal rail. */
export const SHELF_CARD_WIDTH = 132;
const CARD_GAP = 8;

type Cart = ReturnType<typeof useCartActions>;
type Shelf = Extract<HomeSection, { kind: "shelf" }>;

function LazyShelfLoader({ categoryId }: { categoryId: string }) {
  // The fetch this shelf is waiting for. Home observes the same query key
  // and re-renders this section with real products once it lands.
  const query = useHomeSectionProducts(categoryId, true);
  const progress = useShimmer();
  if (query.isError) return null;
  return <ShelfSkeleton progress={progress} cardWidth={SHELF_CARD_WIDTH} />;
}

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
          qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
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

  if (section.loading && section.lazyCategoryId) {
    return <LazyShelfLoader categoryId={section.lazyCategoryId} />;
  }

  return (
    <SectionPanel>
      <SectionHeader title={section.title} onViewAll={() => onAction(section.viewAll)} />
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
});

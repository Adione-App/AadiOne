/**
 * Category listing (Task 14.7).
 *
 * Sidebar of subcategories plus a product grid, matching the mockup. The
 * sticky "N items in cart" bar sits above the tab bar so checkout is always
 * one tap away while browsing.
 */

import { useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ProductSummaryDto } from '@shared';
import { formatPaise } from '@shared/money';
import { colors, radius, spacing } from '@shared/theme';
import { useCategories, useProducts } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import { useGridColumns } from '@/lib/useGridColumns';
import { AppText, EmptyState, Loading, NoticeStrip, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { ProductGridSkeleton } from '@/components/ProductCardSkeleton';
import CategoryIcon from '@/components/CategoryIcon';

export default function CategoriesScreen({
  onOpenProduct,
  onOpenCart,
  initialCategoryId,
}: {
  onOpenProduct: (productId: string) => void;
  onOpenCart: () => void;
  initialCategoryId?: string;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const categories = useCategories();
  const [selected, setSelected] = useState<string | undefined>(initialCategoryId);
  const cart = useCartActions();

  // Measured against the screen rather than fixed, and clamped at both ends:
  // a rail wide enough to read still has to leave two product cards room in
  // what is left, or names break mid-word and the price is squeezed out of the
  // card entirely. ~26% puts a 360dp screen at 94dp rail / 266dp grid.
  const railWidth = Math.round(Math.max(80, Math.min(104, width * 0.26)));
  const columns = useGridColumns(spacing.xs * 2 + railWidth);

  const leaves = (categories.data ?? []).flatMap((category) => category.children ?? [category]);

  useEffect(() => {
    if (!selected && leaves.length > 0) setSelected(leaves[0]!.id);
  }, [leaves, selected]);

  // This screen stays mounted inside its own tab stack, so `initialCategoryId`
  // only seeds `selected` on first mount. Without this, tapping a different
  // category chip on Home after Categories was already opened would navigate
  // here with a new `categoryId` param that silently had no effect, because
  // `selected` was already set from a previous visit.
  useEffect(() => {
    if (initialCategoryId) setSelected(initialCategoryId);
  }, [initialCategoryId]);

  const products = useProducts(selected ? { categoryId: selected } : {});

  if (categories.isLoading) return <Loading label="Loading categories…" />;

  // Stable references — see HomeScreen's renderProduct for why these are
  // passed directly rather than wrapped in a fresh per-item closure.
  const renderItem = ({ item }: { item: ProductSummaryDto }) => (
    <ProductCard
      product={item}
      qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
      busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
      onPress={onOpenProduct}
      onAdd={cart.add}
      onIncrement={cart.increment}
      onDecrement={cart.decrement}
    />
  );

  const cartCount = cart.cart?.bill.itemCount ?? 0;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <AppText variant="h1">Categories</AppText>
      </View>

      <View style={{ flex: 1, flexDirection: 'row' }}>
        <ScrollView
          style={[styles.sidebar, { width: railWidth }]}
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          showsVerticalScrollIndicator={false}
        >
          {leaves.map((category) => {
            const active = category.id === selected;
            return (
              <Pressable
                key={category.id}
                onPress={() => setSelected(category.id)}
                style={[styles.sidebarItem, active && styles.sidebarItemActive]}
              >
                <CategoryIcon
                  name={category.name}
                  imageUrl={category.imageUrl}
                  size={38}
                />
                <AppText
                  variant="caption"
                  color={active ? colors.primary : colors.textSecondary}
                  numberOfLines={3}
                  style={{ textAlign: 'center', marginTop: spacing.xxs }}
                >
                  {category.name}
                </AppText>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={{ flex: 1 }}>
          {cart.error && (
            <View style={{ padding: spacing.sm }}>
              <NoticeStrip message={cart.error} />
            </View>
          )}

          {products.isLoading ? (
            <ProductGridSkeleton columns={columns} />
          ) : (products.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="Nothing here yet" hint="Try another category." />
          ) : (
            <FlatList
              key={`grid-${columns}`}
              data={products.data?.items ?? []}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              numColumns={columns}
              contentContainerStyle={{
                padding: spacing.xs,
                paddingBottom: cartCount > 0 ? 96 : spacing.xxl,
              }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>

      {cartCount > 0 && (
        <Pressable onPress={onOpenCart} style={[styles.stickyBar, { bottom: spacing.sm }]}>
          <View>
            <AppText variant="bodyStrong" color={colors.onPrimary}>
              {cartCount} item{cartCount === 1 ? '' : 's'} in cart
            </AppText>
            <AppText variant="caption" color={colors.onPrimary}>
              {formatPaise(cart.cart?.bill.totalPaise ?? 0)}
            </AppText>
          </View>
          <AppText variant="bodyStrong" color={colors.onPrimary}>
            Checkout →
          </AppText>
        </Pressable>
      )}
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
  // Width is set at render from the screen size — see railWidth. Anything
  // fixed here would be overridden, so it is deliberately absent.
  sidebar: { backgroundColor: colors.surfaceMuted, flexGrow: 0, flexShrink: 0 },
  sidebarItem: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  sidebarItemActive: {
    backgroundColor: colors.primarySurface,
    borderLeftColor: colors.primary,
  },
  stickyBar: {
    position: 'absolute',
    left: spacing.base,
    right: spacing.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
});

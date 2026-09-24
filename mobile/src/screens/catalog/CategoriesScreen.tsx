/**
 * Category browsing (Task 14.7, restructured).
 *
 * Landing is a category showcase with big images, not a product grid.
 * Tapping a category that has subcategories (e.g. "Grocery") opens them in a
 * left sidebar with its products on the right — the original browsing
 * pattern, just reached through the showcase instead of being the landing
 * view. A category with none (e.g. "Vegetables & Fruits", added as its own
 * root with no children) goes straight to a full-width product grid.
 *
 * The floating mini-cart (same shared component as Home — see
 * MiniCartBar.tsx's `MiniCartOverlay`, mounted once at the MainTabs level)
 * covers "checkout is always one tap away" at every drill level here now;
 * this screen used to have its own bespoke sticky bar for that, which is
 * exactly the kind of per-screen duplicate the shared overlay replaced.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CategoryDto, ProductSummaryDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { useCategories, useProducts } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import { useGridColumns } from '@/lib/useGridColumns';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { resolveImageUrl } from '@/lib/api';
import { AppText, EmptyState, ErrorState, Loading, NoticeStrip, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import { ProductGridSkeleton } from '@/components/ProductCardSkeleton';
import CategoryIcon from '@/components/CategoryIcon';

/* =====================================================================
   DRILL STATE

   root       — the big-image category showcase
   category   — a parent's subcategories in a left sidebar, its products
                (of the selected subcategory) on the right
   products   — a full-width product grid for a leaf category
===================================================================== */

type Drill =
  | { level: 'root' }
  | { level: 'category'; parent: CategoryDto; selectedChildId: string }
  | { level: 'products'; category: CategoryDto };

export default function CategoriesScreen({
  onOpenProduct,
  initialCategoryId,
}: {
  onOpenProduct: (productId: string) => void;
  initialCategoryId?: string;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const { width } = useWindowDimensions();
  const categories = useCategories();
  const cart = useCartActions();
  const columns = useGridColumns();

  // Same sizing rule the sidebar used before this screen grew a landing
  // page: wide enough to read, but always leaving two product cards' worth
  // of room in what's left. See the original CategoriesScreen for the math.
  const railWidth = Math.round(Math.max(72, Math.min(92, width * 0.22)));
  const sidebarColumns = useGridColumns(spacing.xs * 2 + railWidth);

  const [drill, setDrill] = useState<Drill>({ level: 'root' });

  const openCategory = (category: CategoryDto) => {
    setDrill(
      category.children?.length
        ? { level: 'category', parent: category, selectedChildId: category.children[0]!.id }
        : { level: 'products', category },
    );
  };

  const selectSidebarChild = (childId: string) => {
    setDrill((current) =>
      current.level === 'category' ? { ...current, selectedChildId: childId } : current,
    );
  };

  const goBack = () => setDrill({ level: 'root' });

  // This screen stays mounted inside its own tab stack, so `initialCategoryId`
  // has to be re-applied on every change, not just on first mount — otherwise
  // tapping a different category chip/shelf on Home while Categories is
  // already mounted would navigate here with a new `categoryId` param that
  // silently had no effect. A leaf subcategory id opens its parent's sidebar
  // with that subcategory pre-selected, exactly like tapping it there would.
  useEffect(() => {
    if (!initialCategoryId) return;
    const roots = categories.data ?? [];

    for (const root of roots) {
      if (root.id === initialCategoryId) {
        openCategory(root);
        return;
      }
      const child = root.children?.find((item) => item.id === initialCategoryId);
      if (child) {
        setDrill({ level: 'category', parent: root, selectedChildId: child.id });
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCategoryId, categories.data]);

  // Android hardware back returns to the showcase instead of leaving the tab.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drill.level === 'root') return false;
      goBack();
      return true;
    });
    return () => subscription.remove();
  }, [drill]);

  const activeCategoryId =
    drill.level === 'category'
      ? drill.selectedChildId
      : drill.level === 'products'
        ? drill.category.id
        : undefined;

  const products = useProducts(
    activeCategoryId ? { categoryId: activeCategoryId, enabled: true } : { enabled: false },
  );

  if (categories.isLoading) return <Loading label="Loading categories…" />;
  if (categories.isError || !categories.data) {
    return (
      <ErrorState
        message="We could not load categories."
        onRetry={() => void categories.refetch()}
      />
    );
  }

  const headerTitle =
    drill.level === 'root'
      ? 'Categories'
      : drill.level === 'category'
        ? drill.parent.name
        : drill.category.name;

  const productGridColumns = drill.level === 'category' ? sidebarColumns : columns;

  // Stable references — see HomeScreen's renderProduct for why these are
  // passed directly rather than wrapped in a fresh per-item closure.
  //
  // Wrapped in a fixed-percentage-width cell rather than handing ProductCard
  // straight to FlatList: ProductCard's own root has `flex: 1`, and an
  // INCOMPLETE last row (e.g. 5 items in a 2-column grid) stretches a lone
  // flex:1 item to fill the whole row instead of just its own column's
  // share — exactly the "last card looks different / full width" bug. A
  // percentage width fixes every row, complete or not, to the same card
  // size; the padding also doubles as the gutter between cards.
  const renderProduct = ({ item }: { item: ProductSummaryDto }) => (
    <View style={[styles.productCell, { width: `${100 / productGridColumns}%` }]}>
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

  const productPane =
    products.isLoading ? (
      <ProductGridSkeleton columns={productGridColumns} />
    ) : products.isError && !products.data ? (
      // Only reachable with NOTHING cached for this category — `data`
      // stays whatever was last cached through a failed BACKGROUND
      // refetch (see `useProducts`), so a cache-exists-but-API-failed
      // case never hits this branch at all; it just keeps rendering the
      // FlatList below with the (still perfectly good) cached items,
      // exactly as if nothing had gone wrong.
      <ErrorState
        message="We could not load these products."
        onRetry={() => void products.refetch()}
      />
    ) : (products.data?.items.length ?? 0) === 0 ? (
      <EmptyState title="Nothing here yet" hint="Try another category." />
    ) : (
      <FlatList
        key={`grid-${productGridColumns}`}
        data={products.data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={renderProduct}
        numColumns={productGridColumns}
        contentContainerStyle={{
          padding: spacing.xs,
          // `tabBarClearance` — the tab bar is a floating overlay (see
          // MainTabs.tsx's `AnimatedTabBar`), not a flex sibling that
          // reserves its own space, so this grid's last row needs its own
          // clearance to not sit underneath the bar's visible plate at
          // rest. The `+ spacing.xxl` on top covers MiniCartBar, which also
          // floats over this screen (see `useMiniCartScreen`'s "categories"
          // case) — reserved UNCONDITIONALLY from the very first render, not
          // toggled on `cartCount > 0`: the cart query resolves independently
          // of this screen's own loading gate, and toggling this after first
          // paint was the cause of an intermittent first-scroll jump/blink.
          paddingBottom: tabBarClearance + spacing.xxl,
        }}
        showsVerticalScrollIndicator={false}
        // Off-screen rows get unmounted from the native tree instead of
        // staying rendered — a real memory/scroll-cost win on a long grid,
        // safe here since every row is a fixed, uniform ProductCard height.
        removeClippedSubviews
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        updateCellsBatchingPeriod={50}
      />
    );

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        {drill.level !== 'root' && (
          <Pressable
            onPress={goBack}
            hitSlop={12}
            style={styles.back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <AppText variant="h2">←</AppText>
          </Pressable>
        )}
        <AppText variant="h1" numberOfLines={1} style={{ flex: 1 }}>
          {headerTitle}
        </AppText>
      </View>

      {drill.level === 'root' && (
        <CategoryGrid categories={categories.data} onSelect={openCategory} />
      )}

      {drill.level === 'category' && (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <ScrollView
            style={[styles.sidebar, { width: railWidth }]}
            contentContainerStyle={{ paddingBottom: tabBarClearance + spacing.xxl }}
            showsVerticalScrollIndicator={false}
          >
            {drill.parent.children!.map((child) => {
              const active = child.id === drill.selectedChildId;
              return (
                <Pressable
                  key={child.id}
                  onPress={() => selectSidebarChild(child.id)}
                  style={[styles.sidebarItem, active && styles.sidebarItemActive]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${child.name}`}
                >
                  <CategoryIcon name={child.name} imageUrl={child.imageUrl} size={38} />
                  <AppText
                    variant="caption"
                    color={active ? colors.primary : colors.textSecondary}
                    numberOfLines={3}
                    style={{ textAlign: 'center', marginTop: spacing.xxs }}
                  >
                    {child.name}
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
            {productPane}
          </View>
        </View>
      )}

      {drill.level === 'products' && (
        <View style={{ flex: 1 }}>
          {cart.error && (
            <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm }}>
              <NoticeStrip message={cart.error} />
            </View>
          )}
          {productPane}
        </View>
      )}

    </Screen>
  );
}

/* =====================================================================
   CATEGORY SHOWCASE GRID — the landing view, big images
===================================================================== */

function CategoryGrid({
  categories,
  onSelect,
}: {
  categories: CategoryDto[];
  onSelect: (category: CategoryDto) => void;
}) {
  // The tab bar is a floating overlay now (see MainTabs.tsx's
  // `AnimatedTabBar`), not a flex sibling that reserves its own space — this
  // is the landing view for the Categories tab, so its last row needs its
  // own clearance to not sit underneath the bar's visible plate at rest,
  // same as every other tab root (see HomeScreen's identical `paddingTop`).
  const tabBarClearance = useTabBarClearance();

  if (categories.length === 0) {
    return <EmptyState title="Nothing here yet" hint="Check back in a little while." />;
  }

  return (
    <FlatList
      data={categories}
      keyExtractor={(item) => item.id}
      numColumns={2}
      columnWrapperStyle={styles.categoryRow}
      contentContainerStyle={[
        styles.categoryGrid,
        { paddingBottom: tabBarClearance + spacing.xxl },
      ]}
      renderItem={({ item }) => (
        <CategoryGridCard category={item} onPress={() => onSelect(item)} />
      )}
      showsVerticalScrollIndicator={false}
    />
  );
}

function CategoryGridCard({
  category,
  onPress,
}: {
  category: CategoryDto;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = () => {
    Animated.timing(scale, { toValue: 0.96, duration: 100, useNativeDriver: true }).start();
  };
  const pressOut = () => {
    Animated.timing(scale, { toValue: 1, duration: 100, useNativeDriver: true }).start();
  };

  // A parent category's own product count only reflects products assigned to
  // IT directly (see countProductsByCategory), not the total beneath its
  // children — showing that number on a category that holds all its items in
  // subcategories would misleadingly read as "0 items" or near it. Only leaf
  // cards, whose count is exactly what tapping them shows, get the badge.
  const isLeaf = !category.children?.length;
  const showCount = isLeaf && (category.productCount ?? 0) > 0;
  const resolvedImage = category.imageUrl ? resolveImageUrl(category.imageUrl) : null;

  return (
    <Pressable
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={styles.categoryCard}
      accessibilityRole="button"
      accessibilityLabel={`Open ${category.name}`}
    >
      <Animated.View style={[styles.categoryCardInner, { transform: [{ scale }] }]}>
        <View style={styles.categoryImageBox}>
          {resolvedImage ? (
            // Full-size, uncropped-by-a-circle image — a category photo read
            // as a small round icon (the old CategoryIcon shape) is exactly
            // what looked unclear here. Vector-icon fallback (no real image
            // yet) still uses the round icon since it's decorative, not a
            // photo losing detail.
            <Image
              source={{ uri: resolvedImage }}
              style={styles.categoryImage}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
              accessibilityLabel={category.name}
            />
          ) : (
            <CategoryIcon name={category.name} imageUrl={null} size={64} />
          )}
        </View>

        <AppText variant="bodyStrong" numberOfLines={2} style={styles.categoryCardName}>
          {category.name}
        </AppText>

        {showCount && (
          <AppText variant="caption" color={colors.textSecondary}>
            {category.productCount} item{category.productCount === 1 ? '' : 's'}
          </AppText>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 32, height: 32, justifyContent: 'center', marginRight: spacing.xs },

  /* Product grid — see renderProduct for why this wraps every card. */
  // Vertical padding is deliberately bigger than horizontal — the ask was
  // specifically for more breathing room BETWEEN ROWS (card 1/card 3, card
  // 2/card 4), not between columns, which already read fine at the
  // smaller gap.
  productCell: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },

  /* Category showcase grid — big images. `paddingBottom` is overridden
     inline (see `CategoryGrid`) with the tab bar's own clearance added on
     top — this base value is never actually used, kept only so the other
     three sides of `padding` above don't need repeating inline. */
  categoryGrid: {
    padding: spacing.base,
  },
  categoryRow: {
    gap: spacing.md,
  },
  categoryCard: {
    flex: 1,
    marginBottom: spacing.md,
  },
  categoryCardInner: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.sm,
    alignItems: 'center',
    overflow: 'hidden',
  },
  categoryImageBox: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  categoryImage: {
    width: '100%',
    height: '100%',
  },
  categoryCardName: {
    textAlign: 'center',
  },

  /* Left sidebar — subcategories of one parent */
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
});

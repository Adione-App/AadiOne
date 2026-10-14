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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react-native';
import {
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CategoryDto, ProductSummaryDto } from '@shared';
import { colors, radius, spacing } from '@shared/theme';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchProducts, useCategories, useProducts } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import { useGridColumns } from '@/lib/useGridColumns';
import { useTabBarClearance } from '@/lib/tabBarVisibility';
import { AppText, EmptyState, ErrorState, Loading, NoticeStrip, Screen } from '@/components/ui';
import { ProductCard } from '@/components/ProductCard';
import CategoryIcon from '@/components/CategoryIcon';
import { buildCategoryTree, searchCategories } from './categorySections';
import { PromoSlot } from '@/components/PromoBanner';

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

  // Opening a category with a sidebar warms the cache for its other
  // subcategories (up to 8, first page each), so tapping through the sidebar
  // is instant instead of waiting on a request per tap. Once per opened
  // category; fresh entries are skipped, and the open one loads as usual.
  const queryClient = useQueryClient();
  const sidebarParentId = drill.level === 'category' ? drill.parent.id : null;
  useEffect(() => {
    if (drill.level !== 'category') return;
    for (const child of (drill.parent.children ?? []).slice(0, 8)) {
      if (child.id !== drill.selectedChildId) prefetchProducts(queryClient, child.id);
    }
    // Only when a different category is opened — not on every sidebar tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarParentId, queryClient]);

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
        qtyInCart={cart.qtyForCard(item)}
        busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
        onPress={onOpenProduct}
        onAdd={cart.add}
        onIncrement={cart.increment}
        onDecrement={cart.decrement}
      />
    </View>
  );

  // The product pane's state comes ONLY from the selected category's own
  // query (one cache entry per category, so a late response for a category
  // the customer already left can never land here):
  //   data          → the grid at once (cached data paints immediately while
  //                   any background refresh runs; a failed refresh keeps it)
  //   error, no data → error + retry
  //   otherwise      → the static placeholder, only in this pane
  // No layout animations or timers sit between the data and the screen:
  // the cross-fade wrappers that used to (Reanimated `entering`/`exiting`
  // around the skeleton and the grid) could leave the old skeleton on
  // screen or the new grid at zero opacity — the stuck / blank pane.
  const productItems = products.data?.items;
  const productPane =
    productItems ? (
      productItems.length === 0 ? (
        <EmptyState title="Nothing here yet" hint="Try another category." />
      ) : (
        <FlatList
          key={`grid-${productGridColumns}`}
          data={productItems}
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
          // No `removeClippedSubviews`: on Android it can leave rows blank
          // after a layout change (sidebar switch, column change) — the page
          // is capped at 30 products, so the windowing below is enough.
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          updateCellsBatchingPeriod={50}
        />
      )
    ) : products.isError ? (
      // Nothing cached for this category and the request failed (or timed
      // out — every API call has one): stop loading, offer a retry.
      <ErrorState
        message="We could not load these products."
        offline={(products.error as { isOffline?: boolean } | null)?.isOffline === true}
        onRetry={() => void products.refetch()}
      />
    ) : (
      <ProductsPlaceholder columns={productGridColumns} />
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
        <CategoryLanding
          categories={categories.data}
          onOpenRoot={openCategory}
          onOpenChild={(category, parent) => setDrill({ level: 'category', parent, selectedChildId: category.id })}
        />
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
   PRODUCTS PLACEHOLDER — only while a category with nothing cached loads
===================================================================== */

/**
 * Soft light-green card shapes in the product pane only (the header,
 * sidebar and tab bar stay as they are). Static on purpose: no shimmer, no
 * entrance animation, nothing that can outlive the data — it is simply
 * replaced by the grid the moment the category's products arrive. Sized
 * like a ProductCard (image area, price, two name lines, size) so the grid
 * does not jump when it takes over.
 */
function ProductsPlaceholder({ columns }: { columns: number }) {
  return (
    <View
      style={styles.placeholderGrid}
      pointerEvents="none"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading products"
    >
      {Array.from({ length: columns * 3 }, (_, index) => (
        <View key={index} style={[styles.productCell, { width: `${100 / columns}%` }]}>
          <View style={styles.placeholderImage} />
          <View style={[styles.placeholderLine, { width: '40%', height: 14, marginTop: 24 }]} />
          <View style={[styles.placeholderLine, { width: '90%', marginTop: 26 }]} />
          <View style={[styles.placeholderLine, { width: '60%', marginTop: 6 }]} />
          <View style={[styles.placeholderLine, { width: '35%', height: 10, marginTop: 10 }]} />
        </View>
      ))}
    </View>
  );
}

/* =====================================================================
   CATEGORY SECTIONS — the landing view
===================================================================== */

/** Tile columns: as many as fit at MIN_TILE_WIDTH (3 on the narrowest phones, up to 6). */
function tileColumns(innerWidth: number): number {
  return Math.max(3, Math.min(6, Math.floor((innerWidth + TILE_GAP) / (MIN_TILE_WIDTH + TILE_GAP))));
}

/**
 * The landing view: a search bar that stays put, then (scrolling) every
 * root category in a strip and one section per root with its direct
 * subcategories — all from `buildCategoryTree` (categorySections.ts). While
 * searching, the matching categories replace the strip and sections; the
 * search runs over the category tree already loaded, with no request.
 */
function CategoryLanding({
  categories,
  onOpenRoot,
  onOpenChild,
}: {
  categories: CategoryDto[];
  onOpenRoot: (category: CategoryDto) => void;
  onOpenChild: (category: CategoryDto, parent: CategoryDto) => void;
}) {
  // The tab bar floats over the screen (MainTabs.tsx), so the content needs
  // its own clearance, like every other tab root.
  const tabBarClearance = useTabBarClearance();
  const { width } = useWindowDimensions();
  const tree = useMemo(() => buildCategoryTree(categories), [categories]);
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchCategories(tree, query), [tree, query]);
  const searching = query.trim().length > 0;

  const scrollRef = useRef<ScrollView>(null);
  /** Each section's y inside the scroll content (from onLayout). */
  const sectionY = useRef(new Map<string, number>());
  const [activeRootId, setActiveRootId] = useState<string | null>(null);

  const innerWidth = width - SECTION_MARGIN * 2 - SECTION_PADDING * 2 - 2;
  const columns = tileColumns(innerWidth);
  const tileWidth = Math.floor((innerWidth - TILE_GAP * (columns - 1)) / columns);
  const imageSize = tileWidth - TILE_PADDING * 2;

  // A root with subcategories scrolls to its section; one without opens its products.
  const openRoot = (root: CategoryDto) => {
    const y = sectionY.current.get(root.id);
    if (y === undefined) {
      onOpenRoot(root);
      return;
    }
    setActiveRootId(root.id);
    scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.sm), animated: true });
  };

  // The strip's highlight follows the section being read.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y + spacing.xl;
    let current: string | null = null;
    for (const section of tree.sections) {
      const top = sectionY.current.get(section.key);
      if (top !== undefined && top <= y) current = section.key;
    }
    if (current !== activeRootId) setActiveRootId(current);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <View style={styles.searchBar}>
          <Search size={18} color={colors.textMuted} strokeWidth={2.25} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search categories"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
            accessibilityLabel="Search categories"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
              <X size={18} color={colors.textSecondary} strokeWidth={2.25} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        onScroll={searching ? undefined : onScroll}
        scrollEventThrottle={64}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: tabBarClearance + spacing.xxl }}
      >
        {searching ? (
          results.length === 0 ? (
            <EmptyState title="No categories found" hint={`Nothing matches "${query.trim()}".`} />
          ) : (
            <View style={styles.results}>
              {results.map(({ category, parent }) => (
                <Pressable
                  key={category.id}
                  onPress={() => (parent ? onOpenChild(category, parent) : onOpenRoot(category))}
                  style={({ pressed }) => [styles.resultRow, pressed && styles.tilePressed]}
                  accessibilityRole="button"
                  accessibilityLabel={parent ? `Open ${category.name} in ${parent.name}` : `Open ${category.name}`}
                >
                  <View style={styles.resultIcon}>
                    <CategoryIcon name={category.name} imageUrl={category.imageUrl} size={36} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {category.name}
                    </AppText>
                    <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                      {parent ? `in ${parent.name}` : 'Category'}
                    </AppText>
                  </View>
                </Pressable>
              ))}
            </View>
          )
        ) : tree.roots.length === 0 ? (
          <EmptyState title="Nothing here yet" hint="Check back in a little while." />
        ) : (
          <>
            {/* Admin banners (Banners → "Categories — top"); nothing when none is live. */}
            <PromoSlot placement="categories_top" style={styles.promoTop} />

            {/* Every root category, in API order. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rootStrip}>
              {tree.roots.map((root) => {
                const active = root.id === activeRootId;
                return (
                  <Pressable
                    key={root.id}
                    onPress={() => openRoot(root)}
                    style={({ pressed }) => [styles.rootItem, pressed && styles.tilePressed]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${root.name}`}
                  >
                    <View style={[styles.rootImage, active && styles.rootImageActive]}>
                      <CategoryIcon name={root.name} imageUrl={root.imageUrl} size={48} />
                    </View>
                    <AppText
                      variant="caption"
                      numberOfLines={2}
                      color={active ? colors.primary : colors.textPrimary}
                      style={[styles.rootLabel, active && styles.rootLabelActive]}
                    >
                      {root.name}
                    </AppText>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* One section per root with subcategories: only its own direct children. */}
            {tree.sections.map((section, sectionIndex) => (
              // The outer wrapper sits directly in the scroll content, so its y is the section's offset.
              <View key={section.key} onLayout={(event) => sectionY.current.set(section.key, event.nativeEvent.layout.y)}>
              <View style={styles.section}>
                <Pressable
                  onPress={() => onOpenRoot(section.parent)}
                  style={styles.sectionHeader}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${section.title}`}
                >
                  <View style={styles.sectionIcon}>
                    <CategoryIcon name={section.parent.name} imageUrl={section.parent.imageUrl} size={34} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="h3" numberOfLines={1}>
                      {section.title}
                    </AppText>
                    <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                      {section.subtitle}
                    </AppText>
                  </View>
                </Pressable>

                <View style={styles.tileGrid}>
                  {section.tiles.map((category) => (
                    <Pressable
                      key={category.id}
                      onPress={() => onOpenChild(category, section.parent)}
                      style={({ pressed }) => [styles.tile, { width: tileWidth }, pressed && styles.tilePressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${category.name}`}
                    >
                      <View style={[styles.tileImage, { height: imageSize }]}>
                        <CategoryIcon name={category.name} imageUrl={category.imageUrl} size={imageSize - 6} />
                      </View>
                      <AppText variant="caption" numberOfLines={2} style={styles.tileLabel}>
                        {category.name}
                      </AppText>
                    </Pressable>
                  ))}
                </View>
              </View>
              {/* "Categories — between sections" banners, once: after the second section (or the last). */}
              {sectionIndex === Math.min(1, tree.sections.length - 1) ? <PromoSlot placement="categories_mid" style={styles.promoMid} /> : null}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** Landing layout spacing — tile width is computed from these and the screen width. */
const SECTION_MARGIN = spacing.md;
const SECTION_PADDING = spacing.md;
const TILE_GAP = spacing.sm;
const TILE_PADDING = 6;
/** Narrowest a tile may get before a column is dropped. */
const MIN_TILE_WIDTH = 68;

const styles = StyleSheet.create({
  // Wraps the skeleton/FlatList swap (see `productPane`'s own comments) —
  // `flex: 1` so it fills the same space its `<View style={{flex:1}}>`
  // parent always gave the content directly before this wrapper existed;
  // the fade transition is purely cosmetic on top, not a layout change.
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

  promoTop: { marginBottom: spacing.sm },
  promoMid: { marginBottom: spacing.md },

  /* Landing: search bar, root strip, results */
  searchWrap: {
    paddingHorizontal: SECTION_MARGIN,
    paddingBottom: spacing.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  rootStrip: {
    paddingHorizontal: SECTION_MARGIN,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  rootItem: {
    width: 76,
    alignItems: 'center',
  },
  rootImage: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rootImageActive: {
    borderColor: colors.primary,
  },
  rootLabel: {
    marginTop: spacing.xs,
    textAlign: 'center',
    fontWeight: '600',
  },
  rootLabelActive: {
    fontWeight: '800',
  },
  results: {
    marginHorizontal: SECTION_MARGIN,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  resultIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  /* Landing sections — compact tiles on soft light green, in white cards. */
  section: {
    marginHorizontal: SECTION_MARGIN,
    marginBottom: spacing.md,
    padding: SECTION_PADDING,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: colors.primarySurface,
  },
  tileGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: TILE_GAP,
  },
  tile: {
    padding: TILE_PADDING,
    borderRadius: radius.md,
    backgroundColor: colors.primarySurface,
    alignItems: 'center',
  },
  tilePressed: { opacity: 0.75 },
  tileImage: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileLabel: {
    marginTop: spacing.xs,
    minHeight: 32,
    textAlign: 'center',
    color: colors.textPrimary,
    fontWeight: '600',
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

  /* Products placeholder — the theme's light green (`primarySurface`). */
  placeholderGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: spacing.xs,
  },
  placeholderImage: {
    height: 110,
    borderRadius: radius.md,
    backgroundColor: colors.primarySurface,
  },
  placeholderLine: {
    height: 12,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySurface,
  },
});

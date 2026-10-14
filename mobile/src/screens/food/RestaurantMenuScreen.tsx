/**
 * A restaurant's / cafe's page — its cover photo, an information card
 * (logo, name, veg / non-veg, cuisine, open status, prep time, address), the
 * menu's sections as tabs, and the menu itself: Menu → Menu Section → Food
 * Item, exactly as the seller arranged it (GET /restaurants/:sellerId).
 *
 *   tabs       one per section that has items, with its item count; tapping
 *              one scrolls to it, and the active tab follows the scroll. Once
 *              the in-page tabs scroll away, the same tabs stay pinned at the
 *              top.
 *   sections   collapsible (header with count and chevron).
 *   items      ordinary seller listings through the SAME cart as everything
 *              else (`useCartActions`): server-checked price and stock, the
 *              shared optimistic quantities, MiniCartBar and checkout. A
 *              tap is ignored while that item's previous change is still
 *              being saved, so nothing is added twice. Each entry is one
 *              sellable variant ("Half" / "Full" are separate lines).
 *
 * Nothing is invented: a missing logo, cover or photo shows a plain
 * placeholder, and a value the restaurant has not set is left out.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from "react-native";
import { Image } from "expo-image";
import { ArrowLeft, ChevronDown, ChevronUp, Clock, MapPin, Triangle, UtensilsCrossed } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RestaurantDto, RestaurantMenuItemDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, palette, radius, spacing } from "@shared/theme";
import { DietBadge } from "@/components/FoodRestaurantCard";
import { QuantityStepper } from "@/components/ProductCard";
import { AppText, EmptyState, ErrorState, NoticeStrip, Screen } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { useRestaurantMenu } from "@/lib/queries";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { useCartActions, type CartItemSnapshot } from "@/lib/useCartActions";
import { Bone, useShimmer } from "@/screens/home/sections/HomeSkeleton";

/** Room for MiniCartBar, which rests above the tab bar on this screen. */
const MINI_CART_ROOM = 84;
const COVER_HEIGHT = 230;
const TABS_HEIGHT = 64;

type Cart = ReturnType<typeof useCartActions>;

function snapshotOf(item: RestaurantMenuItemDto): CartItemSnapshot {
  return {
    productId: item.productId,
    productName: item.name,
    variantName: item.variantName,
    brandName: null,
    imageUrl: item.imageUrl,
    mrpPaise: Math.max(item.mrpPaise, item.pricePaise),
    unitPricePaise: item.pricePaise,
    inStock: item.inStock,
    // Made to order: the server enforces real capacity on add; this only
    // feeds the optimistic line until it answers.
    availableQty: item.maxQtyPerOrder,
    maxQtyPerOrder: item.maxQtyPerOrder,
    allowCod: true,
    sellerListingId: item.sellerListingId,
    sellerId: item.sellerId,
    sellerName: item.restaurantName,
  };
}

/* -------------------------------------------------------------------------- */
/* Menu item                                                                   */
/* -------------------------------------------------------------------------- */

const MenuItemRow = memo(function MenuItemRow({
  item,
  showVariant,
  qty,
  busy,
  onAdd,
  onIncrement,
  onDecrement,
}: {
  item: RestaurantMenuItemDto;
  showVariant: boolean;
  qty: number;
  busy: boolean;
  onAdd: Cart["add"];
  onIncrement: Cart["increment"];
  onDecrement: Cart["decrement"];
}) {
  const image = resolveImageUrl(item.imageUrl);
  const discounted = item.mrpPaise > item.pricePaise;

  return (
    <View style={styles.item}>
      <View style={styles.itemCopy}>
        <DietBadge diet={item.diet} size={20} />
        <AppText style={styles.itemName} numberOfLines={2}>
          {item.name}
        </AppText>
        {showVariant && item.variantName ? (
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {item.variantName}
          </AppText>
        ) : null}
        <View style={styles.priceRow}>
          <AppText style={styles.price}>{formatPaise(item.pricePaise)}</AppText>
          {discounted && <AppText style={styles.mrp}>{formatPaise(item.mrpPaise)}</AppText>}
        </View>
        {item.description ? (
          <AppText style={styles.description} numberOfLines={3}>
            {item.description}
          </AppText>
        ) : null}
      </View>

      <View style={styles.itemSide}>
        <View style={[styles.itemImageBox, !item.inStock && styles.itemImageSoldOut]}>
          {image ? (
            <Image source={{ uri: image }} style={styles.itemImage} contentFit="cover" transition={150} cachePolicy="memory-disk" />
          ) : (
            <UtensilsCrossed size={30} color={palette.green600} strokeWidth={1.5} />
          )}
        </View>
        <View style={styles.action}>
          {!item.inStock ? (
            <View style={styles.soldOut}>
              <AppText style={styles.soldOutText}>Sold out</AppText>
            </View>
          ) : qty > 0 ? (
            <QuantityStepper
              qty={qty}
              max={item.maxQtyPerOrder}
              busy={busy}
              onIncrement={() => onIncrement(item.variantId)}
              onDecrement={() => onDecrement(item.variantId)}
            />
          ) : (
            <Pressable
              onPress={() => {
                // A tap while this item's previous change is still saving is ignored: never added twice.
                if (!busy) onAdd(item.variantId, snapshotOf(item));
              }}
              disabled={busy}
              style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityState={{ busy }}
              accessibilityLabel={`Add ${item.name}${showVariant ? `, ${item.variantName}` : ""}`}
            >
              {busy ? <ActivityIndicator size="small" color={colors.primary} /> : <AppText style={styles.addText}>ADD</AppText>}
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
});

/* -------------------------------------------------------------------------- */
/* Restaurant header                                                           */
/* -------------------------------------------------------------------------- */

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

function DietLabel({ restaurant, servesNonVeg }: { restaurant: RestaurantDto; servesNonVeg: boolean }) {
  if (restaurant.isVegOnly) {
    return (
      <View style={[styles.dietLabel, { borderColor: palette.green600 }]}>
        <DietBadge diet="VEG" size={16} />
        <AppText style={[styles.dietLabelText, { color: palette.green700 }]}>Pure Veg</AppText>
      </View>
    );
  }
  if (!servesNonVeg) return null;
  return (
    <View style={[styles.dietLabel, { borderColor: "#F4C7C9", backgroundColor: "#FFF5F5" }]}>
      <View style={styles.nonVegMark}>
        <Triangle size={9} color={palette.red500} fill={palette.red500} strokeWidth={1} />
      </View>
      <AppText style={[styles.dietLabelText, { color: palette.red500 }]}>Non Veg</AppText>
    </View>
  );
}

function RestaurantHero({
  restaurant,
  coverUrl,
  servesNonVeg,
  topInset,
  onBack,
}: {
  restaurant: RestaurantDto;
  coverUrl: string | null;
  servesNonVeg: boolean;
  topInset: number;
  onBack: () => void;
}) {
  const logo = resolveImageUrl(restaurant.logoUrl ?? null);
  const cuisine = restaurant.cuisine.filter((entry) => entry.trim()).join(", ");
  const address = [restaurant.addressLine, restaurant.city].filter(Boolean).join(", ");
  return (
    <View>
      <View style={[styles.cover, { height: COVER_HEIGHT + topInset }]}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
        ) : (
          <View style={styles.coverFallback}>
            <UtensilsCrossed size={56} color={palette.green300} strokeWidth={1.25} />
          </View>
        )}
        <Pressable
          onPress={onBack}
          hitSlop={8}
          style={[styles.coverBack, { top: topInset + spacing.sm }]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ArrowLeft size={24} color={colors.textPrimary} strokeWidth={2.25} />
        </Pressable>
      </View>

      <View style={styles.infoCard}>
        <View style={styles.logo}>
          {logo ? (
            <Image source={{ uri: logo }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
          ) : (
            <AppText style={styles.logoInitials}>{initialsOf(restaurant.name)}</AppText>
          )}
        </View>
        <View style={styles.infoBody}>
          <View style={styles.nameRow}>
            <AppText style={styles.infoName} numberOfLines={2}>
              {restaurant.name}
            </AppText>
            <DietLabel restaurant={restaurant} servesNonVeg={servesNonVeg} />
          </View>
          {cuisine ? (
            <AppText style={styles.cuisine} numberOfLines={2}>
              {cuisine}
            </AppText>
          ) : null}
          <View style={styles.infoMeta}>
            <View style={[styles.statusPill, restaurant.isOpen ? styles.statusOpen : styles.statusClosed]}>
              <AppText style={[styles.statusText, { color: restaurant.isOpen ? palette.green700 : colors.textSecondary }]}>
                {restaurant.isOpen ? "Open now" : restaurant.nextOpenText ?? "Closed now"}
              </AppText>
            </View>
            {restaurant.avgPrepMins !== null && (
              <View style={styles.metaItem}>
                <Clock size={15} color={colors.textSecondary} strokeWidth={2.25} />
                <AppText style={styles.metaText}>{restaurant.avgPrepMins} min prep</AppText>
              </View>
            )}
          </View>
          {address ? (
            <View style={[styles.metaItem, { marginTop: spacing.xs }]}>
              <MapPin size={15} color={colors.textSecondary} strokeWidth={2.25} />
              <AppText style={[styles.metaText, { flex: 1 }]} numberOfLines={2}>
                {address}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Section tabs                                                                */
/* -------------------------------------------------------------------------- */

interface Tab {
  key: string;
  title: string;
  count: number;
  imageUrl: string | null;
}

function SectionTabs({ tabs, active, onPress }: { tabs: Tab[]; active: string | null; onPress: (key: string) => void }) {
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, number>());
  // Keep the active tab in view as the menu scrolls.
  useEffect(() => {
    const x = active ? offsets.current.get(active) : undefined;
    if (x !== undefined) scrollRef.current?.scrollTo({ x: Math.max(0, x - spacing.base), animated: true });
  }, [active]);
  return (
    <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        const image = resolveImageUrl(tab.imageUrl);
        return (
          <Pressable
            key={tab.key}
            onLayout={(event) => offsets.current.set(tab.key, event.nativeEvent.layout.x)}
            onPress={() => onPress(tab.key)}
            style={[styles.tab, selected && styles.tabActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${tab.title}, ${tab.count} ${tab.count === 1 ? "item" : "items"}`}
          >
            {image ? <Image source={{ uri: image }} style={styles.tabImage} contentFit="cover" cachePolicy="memory-disk" /> : null}
            <AppText style={[styles.tabText, selected && styles.tabTextActive]} numberOfLines={1}>
              {tab.title} ({tab.count})
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function MenuSkeleton() {
  const progress = useShimmer();
  return (
    <View style={{ gap: spacing.base }}>
      <Bone progress={progress} width="100%" height={COVER_HEIGHT} rounded={0} />
      <View style={{ paddingHorizontal: spacing.base, gap: spacing.base }}>
        <Bone progress={progress} width="60%" height={22} />
        <Bone progress={progress} width="40%" height={14} />
        {Array.from({ length: 3 }, (_, index) => (
          <View key={index} style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.sm }}>
            <View style={{ flex: 1, gap: spacing.sm }}>
              <Bone progress={progress} width="70%" height={14} />
              <Bone progress={progress} width="30%" height={14} />
              <Bone progress={progress} width="90%" height={10} />
            </View>
            <Bone progress={progress} width={128} height={108} rounded={radius.lg} />
          </View>
        ))}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                      */
/* -------------------------------------------------------------------------- */

export default function RestaurantMenuScreen({
  sellerId,
  fallbackName,
  onBack,
}: {
  sellerId: string;
  fallbackName?: string | undefined;
  onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const menu = useRestaurantMenu(sellerId);
  const cart = useCartActions();
  const listRef = useRef<SectionList<RestaurantMenuItemDto, (typeof allSections)[number]>>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const tabsY = useRef(0);
  // While a tab tap scrolls the list, the scroll must not move the highlight back.
  const jumping = useRef(false);

  const allSections = useMemo(() => {
    const data = menu.data;
    if (!data) return [];
    const multipleMenus = data.menus.length > 1;
    return data.menus.flatMap((entry) =>
      entry.sections
        .filter((section) => section.items.length > 0)
        .map((section) => {
          // A dish listed with several variants (Half / Full) shows which one each line is.
          const perProduct = new Map<string, number>();
          for (const item of section.items) perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + 1);
          return {
            key: section.id,
            title: section.name,
            imageUrl: section.imageUrl,
            menuName: multipleMenus ? entry.name : null,
            multiVariant: perProduct,
            items: section.items,
            data: section.items,
          };
        }),
    );
  }, [menu.data]);

  const sections = useMemo(
    () => allSections.map((section) => (collapsed.has(section.key) ? { ...section, data: [] as RestaurantMenuItemDto[] } : section)),
    [allSections, collapsed],
  );
  const tabs: Tab[] = useMemo(
    () => allSections.map((section) => ({ key: section.key, title: section.title, count: section.items.length, imageUrl: section.imageUrl })),
    [allSections],
  );
  const activeKey = active ?? tabs[0]?.key ?? null;

  const servesNonVeg = useMemo(() => allSections.some((section) => section.items.some((item) => item.diet === "NON_VEG")), [allSections]);
  const coverUrl = useMemo(() => {
    const own = resolveImageUrl(menu.data?.restaurant.coverImageUrl ?? null);
    if (own) return own;
    // No cover set: a real photo from its own menu, else the plain placeholder.
    const photo = allSections.flatMap((section) => section.items).find((item) => item.imageUrl)?.imageUrl ?? null;
    return resolveImageUrl(photo);
  }, [menu.data, allSections]);

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const jumpTo = useCallback(
    (key: string) => {
      const sectionIndex = sections.findIndex((section) => section.key === key);
      if (sectionIndex < 0) return;
      setActive(key);
      jumping.current = true;
      setTimeout(() => {
        jumping.current = false;
      }, 700);
      listRef.current?.scrollToLocation({
        sectionIndex,
        itemIndex: 0,
        viewPosition: 0,
        // Land below the pinned tabs.
        viewOffset: TABS_HEIGHT + insets.top,
        animated: true,
      });
    },
    [sections, insets.top],
  );

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (jumping.current) return;
    // A section's zero-height footer counts as "visible" at the very top of the
    // screen; it belongs to the section ABOVE, so it must not decide the tab.
    const first = viewableItems.find((token) => token.section && !String(token.key ?? "").endsWith(":footer"));
    const key = (first?.section as { key?: string } | undefined)?.key;
    if (key) setActive(key);
  }).current;

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = event.nativeEvent.contentOffset.y;
    const shouldPin = tabsY.current > 0 && y >= tabsY.current - insets.top;
    setPinned((current) => (current === shouldPin ? current : shouldPin));
  }, [insets.top]);

  const renderItem = useCallback(
    ({ item, section }: { item: RestaurantMenuItemDto; section: (typeof sections)[number] }) => (
      <MenuItemRow
        item={item}
        showVariant={(section.multiVariant.get(item.productId) ?? 0) > 1}
        qty={cart.qtyFor(item.variantId)}
        busy={cart.isBusy(item.variantId)}
        onAdd={cart.add}
        onIncrement={cart.increment}
        onDecrement={cart.decrement}
      />
    ),
    [cart],
  );

  if (menu.isLoading) {
    return (
      <Screen style={styles.screen}>
        <MenuSkeleton />
      </Screen>
    );
  }
  if (menu.isError || !menu.data) {
    return (
      <Screen style={styles.screen}>
        <View style={[styles.plainBar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={onBack} hitSlop={12} style={styles.plainBack} accessibilityRole="button" accessibilityLabel="Back">
            <ArrowLeft size={22} color={colors.textPrimary} strokeWidth={2.25} />
          </Pressable>
          <AppText variant="h3" numberOfLines={1} style={{ flex: 1 }}>
            {fallbackName ?? "Menu"}
          </AppText>
        </View>
        <ErrorState message="We could not load this menu." onRetry={() => void menu.refetch()} />
      </Screen>
    );
  }

  const restaurant = menu.data.restaurant;

  return (
    <Screen style={styles.screen}>
      <SectionList
        ref={listRef}
        sections={sections}
        keyExtractor={(item) => item.sellerListingId}
        renderItem={renderItem}
        extraData={cart}
        stickySectionHeadersEnabled={false}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 20 }}
        onScrollToIndexFailed={() => undefined}
        // Pull down for fresh prices, availability and open status.
        refreshControl={
          <RefreshControl
            refreshing={menu.isRefetching}
            onRefresh={() => void menu.refetch()}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressViewOffset={insets.top}
          />
        }
        ListHeaderComponent={
          <View>
            <RestaurantHero restaurant={restaurant} coverUrl={coverUrl} servesNonVeg={servesNonVeg} topInset={insets.top} onBack={onBack} />
            {cart.error && (
              <View style={styles.notice}>
                <NoticeStrip message={cart.error} />
              </View>
            )}
            {tabs.length > 0 && (
              <View
                onLayout={(event) => {
                  tabsY.current = event.nativeEvent.layout.y;
                }}
              >
                <SectionTabs tabs={tabs} active={activeKey} onPress={jumpTo} />
              </View>
            )}
          </View>
        }
        renderSectionHeader={({ section }) => {
          const open = !collapsed.has(section.key);
          return (
            <View style={styles.sectionWrap}>
              {section.menuName ? <AppText style={styles.menuName}>{section.menuName}</AppText> : null}
              <Pressable
                onPress={() => toggle(section.key)}
                style={styles.sectionHeader}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                accessibilityLabel={`${section.title}, ${section.items.length} ${section.items.length === 1 ? "item" : "items"}. ${open ? "Collapse" : "Expand"}`}
              >
                <AppText style={styles.sectionTitle} numberOfLines={1}>
                  {section.title} <AppText style={styles.sectionCount}>({section.items.length})</AppText>
                </AppText>
                {open ? (
                  <ChevronUp size={22} color={colors.textPrimary} strokeWidth={2.25} />
                ) : (
                  <ChevronDown size={22} color={colors.textPrimary} strokeWidth={2.25} />
                )}
              </Pressable>
            </View>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<EmptyState title="The menu is being updated" hint="This place hasn't listed any items yet. Check back soon." />}
        contentContainerStyle={{ paddingBottom: tabBarClearance + MINI_CART_ROOM }}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        showsVerticalScrollIndicator={false}
      />

      {pinned && tabs.length > 0 ? (
        <View style={[styles.pinnedTabs, { paddingTop: insets.top }]}>
          <SectionTabs tabs={tabs} active={activeKey} onPress={jumpTo} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: colors.surface,
  },
  plainBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  plainBack: {
    width: 36,
    height: 36,
    justifyContent: "center",
  },
  cover: {
    width: "100%",
    backgroundColor: palette.green50,
    overflow: "hidden",
  },
  coverFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  coverBack: {
    position: "absolute",
    left: spacing.base,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  infoCard: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: -64,
    marginHorizontal: spacing.base,
    padding: spacing.md,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  logo: {
    width: 84,
    height: 84,
    borderRadius: 42,
    overflow: "hidden",
    backgroundColor: palette.green800,
    alignItems: "center",
    justifyContent: "center",
  },
  logoInitials: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "800",
    color: "#F5C451",
  },
  infoBody: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: spacing.sm,
    rowGap: 4,
  },
  infoName: {
    flexShrink: 1,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  dietLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  nonVegMark: {
    width: 16,
    height: 16,
    borderWidth: 1.75,
    borderColor: palette.red500,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  dietLabelText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "700",
  },
  cuisine: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  infoMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusOpen: {
    backgroundColor: palette.green50,
  },
  statusClosed: {
    backgroundColor: colors.surfaceSunken,
  },
  statusText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "700",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  metaText: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  notice: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
  },
  tabs: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: spacing.base,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: {
    backgroundColor: palette.green600,
    borderColor: palette.green600,
  },
  tabImage: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  tabText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  tabTextActive: {
    color: colors.textOnPrimary,
    fontWeight: "700",
  },
  pinnedTabs: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  sectionWrap: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  menuName: {
    marginBottom: 4,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: colors.primary,
    textTransform: "uppercase",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: palette.green50,
  },
  sectionTitle: {
    flex: 1,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  sectionCount: {
    fontSize: 18,
    fontWeight: "500",
    color: colors.textSecondary,
  },
  separator: {
    height: 1,
    marginHorizontal: spacing.base,
    backgroundColor: colors.divider,
  },
  item: {
    flexDirection: "row",
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
    gap: spacing.md,
  },
  itemCopy: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  itemName: {
    marginTop: 4,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  price: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  mrp: {
    fontSize: 13,
    lineHeight: 17,
    color: colors.textMuted,
    textDecorationLine: "line-through",
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  itemSide: {
    width: 132,
    alignItems: "center",
  },
  itemImageBox: {
    width: 132,
    height: 112,
    borderRadius: radius.lg,
    backgroundColor: palette.green50,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  itemImageSoldOut: {
    opacity: 0.5,
  },
  itemImage: {
    width: "100%",
    height: "100%",
  },
  action: {
    marginTop: -20,
    minWidth: 110,
    alignItems: "center",
  },
  addButton: {
    minWidth: 110,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  pressed: {
    opacity: 0.8,
  },
  addText: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "800",
    color: colors.primary,
  },
  soldOut: {
    minWidth: 110,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  soldOutText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "700",
    color: colors.textSecondary,
  },
});

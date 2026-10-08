/**
 * A restaurant's / cafe's menu — Menu → Menu Section → Food Item, exactly as
 * the seller arranged it (GET /restaurants/:sellerId).
 *
 * Food items are ordinary seller listings, so they go through the SAME cart
 * as everything else (`useCartActions`): the shared optimistic quantities,
 * the badge, MiniCartBar and checkout all work unchanged. Each entry is one
 * sellable variant (e.g. "Half" / "Full" are separate lines with their own
 * price), which is how the menu API returns them.
 */

import { memo, useCallback, useMemo } from "react";
import { Pressable, SectionList, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ArrowLeft, Clock, MapPin } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RestaurantDto, RestaurantMenuItemDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, palette, radius, spacing } from "@shared/theme";
import { QuantityStepper } from "@/components/ProductCard";
import { AppText, EmptyState, ErrorState, NoticeStrip, Screen } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { useRestaurantMenu } from "@/lib/queries";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { useCartActions, type CartItemSnapshot } from "@/lib/useCartActions";
import { Bone, useShimmer } from "@/screens/home/sections/HomeSkeleton";

/** Room for MiniCartBar, which rests above the tab bar on this screen. */
const MINI_CART_ROOM = 84;

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

function DietMark({ diet }: { diet: RestaurantMenuItemDto["diet"] }) {
  if (!diet) return null;
  const tone = diet === "VEG" ? palette.green500 : palette.red500;
  return (
    <View style={[styles.diet, { borderColor: tone }]} accessibilityLabel={diet === "VEG" ? "Vegetarian" : "Non-vegetarian"}>
      <View style={[styles.dietDot, { backgroundColor: tone }]} />
    </View>
  );
}

const MenuItemRow = memo(function MenuItemRow({
  item,
  showVariant,
  qty,
  onAdd,
  onIncrement,
  onDecrement,
}: {
  item: RestaurantMenuItemDto;
  showVariant: boolean;
  qty: number;
  onAdd: Cart["add"];
  onIncrement: Cart["increment"];
  onDecrement: Cart["decrement"];
}) {
  const image = resolveImageUrl(item.imageUrl);
  const discounted = item.mrpPaise > item.pricePaise;

  return (
    <View style={styles.item}>
      <View style={styles.itemCopy}>
        <DietMark diet={item.diet} />
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
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={2} style={styles.description}>
            {item.description}
          </AppText>
        ) : null}
      </View>

      <View style={styles.itemSide}>
        <View style={styles.itemImageBox}>
          {image ? (
            <Image source={{ uri: image }} style={styles.itemImage} contentFit="cover" transition={150} cachePolicy="memory-disk" />
          ) : null}
        </View>
        <View style={styles.action}>
          {!item.inStock ? (
            <View style={styles.unavailable}>
              <AppText style={styles.unavailableText}>Unavailable</AppText>
            </View>
          ) : qty > 0 ? (
            <QuantityStepper
              qty={qty}
              max={item.maxQtyPerOrder}
              onIncrement={() => onIncrement(item.variantId)}
              onDecrement={() => onDecrement(item.variantId)}
            />
          ) : (
            <Pressable
              onPress={() => onAdd(item.variantId, snapshotOf(item))}
              style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Add ${item.name}${showVariant ? `, ${item.variantName}` : ""}`}
            >
              <AppText style={styles.addText}>ADD</AppText>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
});

function RestaurantHeader({ restaurant }: { restaurant: RestaurantDto }) {
  const cuisine = restaurant.cuisine.filter((entry) => entry.trim()).join(", ");
  return (
    <View style={styles.info}>
      <AppText style={styles.infoName}>{restaurant.name}</AppText>
      {cuisine ? (
        <AppText variant="body" color={colors.textSecondary} numberOfLines={2}>
          {cuisine}
        </AppText>
      ) : null}
      <View style={styles.infoMeta}>
        <View style={[styles.statusPill, restaurant.isOpen ? styles.statusOpen : styles.statusClosed]}>
          <AppText style={[styles.statusText, { color: restaurant.isOpen ? palette.green700 : colors.textSecondary }]}>
            {restaurant.isOpen ? "Open now" : restaurant.nextOpenText ?? "Closed now"}
          </AppText>
        </View>
        {restaurant.isVegOnly && (
          <View style={[styles.statusPill, styles.statusOpen]}>
            <AppText style={[styles.statusText, { color: palette.green700 }]}>Pure Veg</AppText>
          </View>
        )}
        {restaurant.avgPrepMins !== null && (
          <View style={styles.metaItem}>
            <Clock size={13} color={colors.textSecondary} strokeWidth={2.25} />
            <AppText variant="caption" color={colors.textSecondary}>
              {restaurant.avgPrepMins} min prep
            </AppText>
          </View>
        )}
      </View>
      <View style={[styles.metaItem, { marginTop: spacing.xs }]}>
        <MapPin size={13} color={colors.textSecondary} strokeWidth={2.25} />
        <AppText variant="caption" color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
          {[restaurant.addressLine, restaurant.city].filter(Boolean).join(", ")}
        </AppText>
      </View>
    </View>
  );
}

function MenuSkeleton() {
  const progress = useShimmer();
  return (
    <View style={{ padding: spacing.base, gap: spacing.base }}>
      <Bone progress={progress} width="60%" height={22} />
      <Bone progress={progress} width="40%" height={14} />
      {Array.from({ length: 4 }, (_, index) => (
        <View key={index} style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.sm }}>
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Bone progress={progress} width="70%" height={14} />
            <Bone progress={progress} width="30%" height={14} />
            <Bone progress={progress} width="90%" height={10} />
          </View>
          <Bone progress={progress} width={104} height={96} rounded={radius.lg} />
        </View>
      ))}
    </View>
  );
}

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

  const sections = useMemo(() => {
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
            menuName: multipleMenus ? entry.name : null,
            multiVariant: perProduct,
            data: section.items,
          };
        }),
    );
  }, [menu.data]);

  const renderItem = useCallback(
    ({ item, section }: { item: RestaurantMenuItemDto; section: (typeof sections)[number] }) => (
      <MenuItemRow
        item={item}
        showVariant={(section.multiVariant.get(item.productId) ?? 0) > 1}
        qty={cart.qtyFor(item.variantId)}
        onAdd={cart.add}
        onIncrement={cart.increment}
        onDecrement={cart.decrement}
      />
    ),
    [cart],
  );

  const title = menu.data?.restaurant.name ?? fallbackName ?? "Menu";

  return (
    <Screen style={styles.screen}>
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={colors.textPrimary} strokeWidth={2.25} />
        </Pressable>
        <AppText variant="h3" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </AppText>
      </View>

      {cart.error && (
        <View style={styles.notice}>
          <NoticeStrip message={cart.error} />
        </View>
      )}

      {menu.isLoading ? (
        <MenuSkeleton />
      ) : menu.isError || !menu.data ? (
        <ErrorState message="We could not load this menu." onRetry={() => void menu.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.sellerListingId}
          renderItem={renderItem}
          extraData={cart}
          stickySectionHeadersEnabled
          ListHeaderComponent={<RestaurantHeader restaurant={menu.data.restaurant} />}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              {section.menuName ? (
                <AppText style={styles.menuName}>{section.menuName}</AppText>
              ) : null}
              <AppText style={styles.sectionTitle}>
                {section.title} <AppText style={styles.sectionCount}>({section.data.length})</AppText>
              </AppText>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <EmptyState title="The menu is being updated" hint="This place hasn't listed any items yet. Check back soon." />
          }
          contentContainerStyle={{ paddingBottom: tabBarClearance + MINI_CART_ROOM }}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={9}
          showsVerticalScrollIndicator={false}
        />
      )}
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
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: {
    width: 36,
    height: 36,
    justifyContent: "center",
  },
  notice: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
  },
  info: {
    padding: spacing.base,
    borderBottomWidth: 8,
    borderBottomColor: "#F2F4F3",
  },
  infoName: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  infoMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  statusOpen: {
    backgroundColor: palette.green50,
  },
  statusClosed: {
    backgroundColor: colors.surfaceSunken,
  },
  statusText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  sectionHeader: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  menuName: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: colors.primary,
    textTransform: "uppercase",
  },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  sectionCount: {
    fontSize: 14,
    fontWeight: "600",
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
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  itemCopy: {
    flex: 1,
    minWidth: 0,
  },
  diet: {
    width: 14,
    height: 14,
    borderWidth: 1.5,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  dietDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  itemName: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginTop: 4,
  },
  price: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  mrp: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textMuted,
    textDecorationLine: "line-through",
  },
  description: {
    marginTop: 4,
  },
  itemSide: {
    width: 112,
    alignItems: "center",
  },
  itemImageBox: {
    width: 112,
    height: 96,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSunken,
    overflow: "hidden",
  },
  itemImage: {
    width: "100%",
    height: "100%",
  },
  action: {
    marginTop: -16,
    minWidth: 92,
    alignItems: "center",
  },
  addButton: {
    minWidth: 92,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.8,
  },
  addText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    color: colors.primary,
  },
  unavailable: {
    minWidth: 92,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  unavailableText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: colors.textSecondary,
  },
});

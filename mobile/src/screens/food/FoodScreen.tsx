/**
 * Food — the restaurants and cafes that deliver to the customer's location
 * (GET /restaurants; the server applies each seller's own delivery radius),
 * each opening its menu.
 *
 * Top to bottom: header (back, "Food", delivery location, search), the hero,
 * the filter chips, then one card per place.
 *
 *   hero        the live admin banners of placement "food" — the ONE source
 *               of this screen's top banner (Admin Panel → Banners), drawn
 *               by the shared PromoBanners (default style: headline +
 *               image, "split"), on an optional "food_background" image.
 *               With none live there is no hero at all: the screen starts
 *               straight at its filters, no empty space.
 *   list        "food_list" banners after the second place.
 *   filters     All / Veg / Non-Veg / Restaurant / Cafe, applied by the
 *               SERVER (pure-veg kitchens, places with a non-veg item, seller
 *               type) — never guessed from names.
 *   search      narrows the loaded places by name or cuisine.
 *   cards       FoodRestaurantCard: real photo, status, cuisine, delivery
 *               time and fee for this location; nothing invented.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { ArrowLeft, ChevronDown, Coffee, Drumstick, Leaf, MapPin, Search, Utensils, UtensilsCrossed, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOD_BANNER_PLACEMENTS, type RestaurantListQuery, type RestaurantSummaryDto } from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { FoodRestaurantCard } from "@/components/FoodRestaurantCard";
import { PromoBanners, PromoSlot } from "@/components/PromoBanner";
import { AppText, EmptyState, ErrorState, Screen } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { useBanners, useRestaurants } from "@/lib/queries";
import { useLocation } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { Bone, useShimmer } from "@/screens/home/sections/HomeSkeleton";

/** Room for MiniCartBar, which rests above the tab bar on this screen. */
const MINI_CART_ROOM = 84;

type FilterKey = "ALL" | "VEG" | "NON_VEG" | "RESTAURANT" | "CAFE";

const FILTERS: { key: FilterKey; label: string; query: RestaurantListQuery }[] = [
  { key: "ALL", label: "All", query: {} },
  { key: "VEG", label: "Veg", query: { diet: "VEG" } },
  { key: "NON_VEG", label: "Non-Veg", query: { diet: "NON_VEG" } },
  { key: "RESTAURANT", label: "Restaurant", query: { type: "RESTAURANT" } },
  { key: "CAFE", label: "Cafe", query: { type: "CAFE" } },
];

function FilterIcon({ filter, active }: { filter: FilterKey; active: boolean }) {
  const size = 15;
  if (filter === "VEG") return <Leaf size={size} color={active ? colors.textOnPrimary : palette.green600} strokeWidth={2.25} />;
  if (filter === "NON_VEG") return <Drumstick size={size} color={active ? colors.textOnPrimary : "#E8590C"} strokeWidth={2.25} />;
  if (filter === "RESTAURANT") return <Utensils size={size} color={active ? colors.textOnPrimary : colors.textPrimary} strokeWidth={2.25} />;
  if (filter === "CAFE") return <Coffee size={size} color={active ? colors.textOnPrimary : "#B45309"} strokeWidth={2.25} />;
  return null;
}

function FoodSkeleton() {
  const progress = useShimmer();
  return (
    <View style={{ paddingHorizontal: spacing.base, gap: spacing.md }}>
      {Array.from({ length: 4 }, (_, index) => (
        <View key={index} style={{ flexDirection: "row", gap: spacing.md }}>
          <Bone progress={progress} width={140} height={106} rounded={radius.lg} />
          <View style={{ flex: 1, gap: spacing.sm, paddingTop: spacing.xs }}>
            <Bone progress={progress} width="70%" height={16} />
            <Bone progress={progress} width="50%" height={12} />
            <Bone progress={progress} width="80%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function FoodScreen({
  onOpenRestaurant,
  onBack,
  onOpenLocation,
}: {
  /** `diet`: the active Veg / Non-Veg filter, so the menu opens filtered the same way. */
  onOpenRestaurant: (sellerId: string, diet?: "VEG" | "NON_VEG") => void;
  onBack?: (() => void) | undefined;
  onOpenLocation?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const location = useLocation((state) => state.location);
  const near = useMemo(() => (location ? { latitude: location.latitude, longitude: location.longitude } : null), [location]);

  const [filterKey, setFilterKey] = useState<FilterKey>("ALL");
  const filter = FILTERS.find((f) => f.key === filterKey)!;
  const query = useRestaurants(near, filter.query);
  const openRestaurant = useCallback(
    (sellerId: string) => onOpenRestaurant(sellerId, filter.query.diet),
    [onOpenRestaurant, filter.query.diet],
  );
  const heroBanners = useBanners(FOOD_BANNER_PLACEMENTS.HERO);
  const background = useBanners(FOOD_BANNER_PLACEMENTS.BACKGROUND);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listRef = useRef<FlatList<RestaurantSummaryDto>>(null);

  // A food seller with an empty menu has nothing to order yet.
  const restaurants = useMemo(() => (query.data ?? []).filter((restaurant) => restaurant.menuItemCount > 0), [query.data]);
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return restaurants;
    return restaurants.filter((r) => r.name.toLowerCase().includes(term) || r.cuisine.some((c) => c.toLowerCase().includes(term)));
  }, [restaurants, search]);

  const slides = heroBanners.data ?? [];
  const backgroundUrl = resolveImageUrl(background.data?.[0]?.imageUrl ?? null);

  // A hero button on a banner with no tap target takes the customer to the places to order from.
  const scrollToList = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 320, animated: true });
  }, []);

  const refreshing = query.isRefetching || heroBanners.isRefetching;
  const refresh = useCallback(() => {
    void query.refetch();
    void heroBanners.refetch();
    void background.refetch();
  }, [query, heroBanners, background]);

  const header = (
    <View>
      <View style={[styles.top, { paddingTop: insets.top + spacing.xs }]}>
        {backgroundUrl ? (
          <Image source={{ uri: backgroundUrl }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
        ) : null}

        <View style={styles.headerRow}>
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
              <ArrowLeft size={24} color={colors.textPrimary} strokeWidth={2.25} />
            </Pressable>
          ) : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText style={styles.title}>Food</AppText>
            <Pressable
              onPress={onOpenLocation}
              disabled={!onOpenLocation}
              hitSlop={6}
              style={styles.locationRow}
              accessibilityRole="button"
              accessibilityLabel="Change delivery location"
            >
              <MapPin size={15} color={palette.green700} fill={palette.green700} strokeWidth={1.5} />
              <AppText style={styles.locationText} numberOfLines={1}>
                {location?.label ?? "Set your delivery location"}
              </AppText>
              {onOpenLocation ? <ChevronDown size={16} color={colors.textSecondary} strokeWidth={2.25} /> : null}
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setSearch("");
            }}
            style={styles.searchButton}
            accessibilityRole="button"
            accessibilityLabel={searchOpen ? "Close search" : "Search restaurants"}
          >
            {searchOpen ? <X size={20} color={colors.textPrimary} strokeWidth={2.25} /> : <Search size={20} color={colors.textPrimary} strokeWidth={2.25} />}
          </Pressable>
        </View>

        {searchOpen ? (
          <View style={styles.searchBox}>
            <Search size={16} color={colors.textMuted} strokeWidth={2.25} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search restaurants or cuisines"
              placeholderTextColor={colors.textMuted}
              style={styles.searchInput}
              autoFocus
              returnKeyType="search"
            />
          </View>
        ) : null}

        {/* Only live "food" banners; none = no hero and no space for one. */}
        {slides.length > 0 ? (
          <PromoBanners banners={slides} defaultVariant="split" onDecorativeCta={scrollToList} style={styles.hero} />
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {FILTERS.map((entry) => {
          const active = entry.key === filterKey;
          return (
            <Pressable
              key={entry.key}
              onPress={() => setFilterKey(entry.key)}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <FilterIcon filter={entry.key} active={active} />
              <AppText style={[styles.chipText, active && styles.chipTextActive]}>{entry.label}</AppText>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  const emptyHint =
    filterKey !== "ALL"
      ? "Nothing matches this filter here right now. Try another filter."
      : location
        ? "No restaurant or cafe delivers to this location right now. Try another address."
        : "Set your delivery location to see the restaurants and cafes near you.";

  return (
    <Screen style={styles.screen}>
      <FlatList
        ref={listRef}
        data={query.isLoading || query.isError ? [] : visible}
        keyExtractor={(item) => item.sellerId}
        renderItem={({ item, index }) => (
          <>
            <View style={styles.cardWrap}>
              <FoodRestaurantCard restaurant={item} onPress={openRestaurant} />
            </View>
            {/* "food_list" banners: after the second place (or the only one). */}
            {index === Math.min(1, visible.length - 1) ? <PromoSlot placement={FOOD_BANNER_PLACEMENTS.LIST} style={styles.listBanner} /> : null}
          </>
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          query.isLoading ? (
            <FoodSkeleton />
          ) : query.isError ? (
            <ErrorState
              message="We could not load restaurants."
              offline={(query.error as { isOffline?: boolean } | null)?.isOffline === true}
              onRetry={() => void query.refetch()}
            />
          ) : search.trim() ? (
            <EmptyState title="No match" hint={`Nothing here matches "${search.trim()}".`} />
          ) : (
            <EmptyState
              icon={<UtensilsCrossed size={44} color={colors.primary} strokeWidth={1.75} />}
              title="No places to show"
              hint={emptyHint}
            />
          )
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />}
        contentContainerStyle={{ paddingBottom: tabBarClearance + MINI_CART_ROOM }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={5}
        maxToRenderPerBatch={6}
        windowSize={7}
      />
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
  top: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
    backgroundColor: palette.green50,
    overflow: "hidden",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  back: {
    width: 36,
    height: 44,
    justifyContent: "center",
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
    color: palette.green800,
  },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 1,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  locationText: {
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  searchButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  // Cancels the header's side padding: PromoBanners keeps its own screen margins.
  hero: {
    marginTop: spacing.sm,
    marginHorizontal: -spacing.base,
  },
  listBanner: {
    marginBottom: spacing.md,
  },
  // A compact, consistent row: 36 dp chips, 13 dp labels, 15 dp icons.
  chips: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm + 2,
    gap: spacing.sm,
    alignItems: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  chipActive: {
    backgroundColor: palette.green700,
    borderColor: palette.green700,
  },
  chipText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  chipTextActive: {
    color: colors.textOnPrimary,
    fontWeight: "700",
  },
  cardWrap: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
  },
});

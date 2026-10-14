/**
 * Food — the restaurants and cafes that deliver to the customer's location
 * (GET /restaurants; the server applies each seller's own delivery radius),
 * each opening its menu.
 *
 * Top to bottom: header (back, "Food", delivery location, search), the hero,
 * the filter chips, then one card per place.
 *
 *   hero        admin banners of placement "food" (headline, subtitle,
 *               optional button text, dish image) on an optional
 *               "food_background" image — Admin Panel → Banners. With no
 *               banner configured a plain, generic hero is shown instead.
 *   filters     All / Veg / Non-Veg / Restaurant / Cafe, applied by the
 *               SERVER (pure-veg kitchens, places with a non-veg item, seller
 *               type) — never guessed from names.
 *   search      narrows the loaded places by name or cuisine.
 *   cards       FoodRestaurantCard: real photo, status, cuisine, delivery
 *               time and fee for this location; nothing invented.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft, ChevronDown, Coffee, Drumstick, Leaf, MapPin, Search, Utensils, UtensilsCrossed, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FOOD_BANNER_PLACEMENTS, type BannerDto, type RestaurantListQuery, type RestaurantSummaryDto } from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { FoodRestaurantCard } from "@/components/FoodRestaurantCard";
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
  const size = 17;
  if (filter === "VEG") return <Leaf size={size} color={active ? colors.textOnPrimary : palette.green600} strokeWidth={2.25} />;
  if (filter === "NON_VEG") return <Drumstick size={size} color={active ? colors.textOnPrimary : "#E8590C"} strokeWidth={2.25} />;
  if (filter === "RESTAURANT") return <Utensils size={size} color={active ? colors.textOnPrimary : colors.textPrimary} strokeWidth={2.25} />;
  if (filter === "CAFE") return <Coffee size={size} color={active ? colors.textOnPrimary : "#B45309"} strokeWidth={2.25} />;
  return null;
}

/** "Good food brings good mood" → the last two words in brand green, as in the design. */
function HeroTitle({ text }: { text: string }) {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return <AppText style={styles.heroTitle}>{text}</AppText>;
  return (
    <AppText style={styles.heroTitle}>
      {words.slice(0, -2).join(" ")} <AppText style={[styles.heroTitle, styles.heroAccent]}>{words.slice(-2).join(" ")}</AppText>
    </AppText>
  );
}

function HeroSlide({ banner, width, onCta }: { banner: BannerDto; width: number; onCta: (banner: BannerDto) => void }) {
  const image = resolveImageUrl(banner.imageUrl);
  const ratio = banner.imageWidth > 0 && banner.imageHeight > 0 ? banner.imageWidth / banner.imageHeight : 1;
  return (
    <View style={[styles.heroSlide, { width }]}>
      <View style={styles.heroCopy}>
        {banner.title ? <HeroTitle text={banner.title} /> : null}
        {banner.subtitle ? (
          <AppText style={styles.heroSubtitle} numberOfLines={3}>
            {banner.subtitle}
          </AppText>
        ) : null}
        {banner.ctaLabel ? (
          <Pressable onPress={() => onCta(banner)} style={({ pressed }) => [styles.heroCta, pressed && { opacity: 0.85 }]} accessibilityRole="button">
            <AppText style={styles.heroCtaText}>{banner.ctaLabel}</AppText>
          </Pressable>
        ) : null}
      </View>
      {image ? (
        <View style={styles.heroArt}>
          <Image
            source={{ uri: image }}
            style={{ width: "100%", aspectRatio: Math.min(Math.max(ratio, 0.6), 2.2) }}
            contentFit="contain"
            transition={150}
            cachePolicy="memory-disk"
            accessibilityLabel={banner.title ?? "Food"}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Shown only while no "food" banner is configured: plain and generic, nothing made up. */
function HeroFallback() {
  return (
    <View style={styles.heroSlide}>
      <View style={styles.heroCopy}>
        <HeroTitle text="Food from places near you" />
        <AppText style={styles.heroSubtitle}>Restaurants and cafes that deliver to your location</AppText>
      </View>
      <View style={[styles.heroArt, styles.heroFallbackArt]}>
        <UtensilsCrossed size={56} color={palette.green600} strokeWidth={1.5} />
      </View>
    </View>
  );
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
  onOpenRestaurant: (sellerId: string) => void;
  onBack?: (() => void) | undefined;
  onOpenLocation?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tabBarClearance = useTabBarClearance();
  const location = useLocation((state) => state.location);
  const near = useMemo(() => (location ? { latitude: location.latitude, longitude: location.longitude } : null), [location]);

  const [filterKey, setFilterKey] = useState<FilterKey>("ALL");
  const filter = FILTERS.find((f) => f.key === filterKey)!;
  const query = useRestaurants(near, filter.query);
  const heroBanners = useBanners(FOOD_BANNER_PLACEMENTS.HERO);
  const background = useBanners(FOOD_BANNER_PLACEMENTS.BACKGROUND);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
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
  const slideWidth = width - spacing.base * 2;

  const onCta = useCallback(
    (banner: BannerDto) => {
      if (banner.actionType === "COUPON" && banner.actionValue) {
        void Clipboard.setStringAsync(banner.actionValue);
        setCopied(banner.actionValue);
        return;
      }
      // Otherwise the button takes the customer to the places to order from.
      listRef.current?.scrollToOffset({ offset: 320, animated: true });
    },
    [],
  );

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

        {slides.length > 0 ? (
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            scrollEnabled={slides.length > 1}
            style={{ marginTop: spacing.sm }}
          >
            {slides.map((banner) => (
              <HeroSlide key={banner.id} banner={banner} width={slideWidth} onCta={onCta} />
            ))}
          </ScrollView>
        ) : heroBanners.isLoading ? (
          <View style={{ height: 150 }} />
        ) : (
          <HeroFallback />
        )}
        {copied ? (
          <AppText style={styles.copied}>
            Code {copied} copied
          </AppText>
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
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <FoodRestaurantCard restaurant={item} onPress={onOpenRestaurant} />
          </View>
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
    fontSize: 28,
    lineHeight: 34,
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
  heroSlide: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 150,
    marginTop: spacing.sm,
  },
  heroCopy: {
    flex: 1.15,
    paddingRight: spacing.sm,
  },
  heroTitle: {
    fontSize: 26,
    lineHeight: 31,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  heroAccent: {
    color: palette.green600,
  },
  heroSubtitle: {
    marginTop: spacing.xs,
    fontSize: 14,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  heroCta: {
    alignSelf: "flex-start",
    marginTop: spacing.md,
    paddingHorizontal: spacing.base,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: palette.green600,
    justifyContent: "center",
  },
  heroCtaText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    color: colors.textOnPrimary,
  },
  heroArt: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  heroFallbackArt: {
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.surface,
    maxWidth: 120,
    alignSelf: "center",
  },
  copied: {
    marginTop: spacing.xs,
    fontSize: 12,
    fontWeight: "700",
    color: palette.green700,
  },
  chips: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.base,
    height: 44,
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
    fontSize: 15,
    lineHeight: 20,
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

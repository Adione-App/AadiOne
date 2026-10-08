/**
 * Food tab — the restaurants and cafes that deliver to the customer's
 * location (GET /restaurants; the server applies each seller's own delivery
 * radius), each opening its menu.
 *
 * The filter chips are built from the list itself — one per food seller
 * type actually present, plus "Pure Veg" / "Open now" only when they would
 * narrow it — so a new food seller type appears as its own filter with no
 * change here.
 */

import { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RestaurantSummaryDto } from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { RestaurantCard } from "@/components/RestaurantCard";
import { AppText, EmptyState, ErrorState, Screen } from "@/components/ui";
import { useRestaurants } from "@/lib/queries";
import { useLocation } from "@/lib/store";
import { useTabBarClearance } from "@/lib/tabBarVisibility";
import { pluralTypeLabel, topCuisines } from "@/screens/home/homeEngine";
import { Bone, useShimmer } from "@/screens/home/sections/HomeSkeleton";

/** Room for MiniCartBar, which rests above the tab bar on this screen. */
const MINI_CART_ROOM = 84;

type Filter = { key: string; label: string; test: (restaurant: RestaurantSummaryDto) => boolean };

const ALL: Filter = { key: "all", label: "All", test: () => true };

function buildFilters(restaurants: readonly RestaurantSummaryDto[]): Filter[] {
  const filters: Filter[] = [ALL];
  const types = [...new Set(restaurants.map((restaurant) => restaurant.sellerType))];
  if (types.length > 1) {
    for (const type of types) {
      filters.push({ key: `type:${type}`, label: pluralTypeLabel(type), test: (r) => r.sellerType === type });
    }
  }
  const openCount = restaurants.filter((r) => r.isOpen).length;
  if (openCount > 0 && openCount < restaurants.length) {
    filters.push({ key: "open", label: "Open now", test: (r) => r.isOpen });
  }
  const vegCount = restaurants.filter((r) => r.isVegOnly).length;
  if (vegCount > 0 && vegCount < restaurants.length) {
    filters.push({ key: "veg", label: "Pure Veg", test: (r) => r.isVegOnly });
  }
  return filters;
}

function FoodSkeleton() {
  const progress = useShimmer();
  return (
    <View style={{ padding: spacing.base, gap: spacing.base }}>
      {Array.from({ length: 3 }, (_, index) => (
        <View key={index} style={{ gap: spacing.sm }}>
          <Bone progress={progress} width="100%" height={160} rounded={radius.lg} />
          <Bone progress={progress} width="50%" height={14} />
          <Bone progress={progress} width="35%" height={10} />
        </View>
      ))}
    </View>
  );
}

export default function FoodScreen({ onOpenRestaurant }: { onOpenRestaurant: (sellerId: string) => void }) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const location = useLocation((state) => state.location);
  const near = useMemo(
    () => (location ? { latitude: location.latitude, longitude: location.longitude } : null),
    [location],
  );
  const query = useRestaurants(near);

  // A food seller with an empty menu has nothing to order yet.
  const restaurants = useMemo(
    () => (query.data ?? []).filter((restaurant) => restaurant.menuItemCount > 0),
    [query.data],
  );
  const filters = useMemo(() => buildFilters(restaurants), [restaurants]);
  const [filterKey, setFilterKey] = useState(ALL.key);
  const active = filters.find((filter) => filter.key === filterKey) ?? ALL;
  const visible = useMemo(() => restaurants.filter(active.test), [restaurants, active]);
  const cuisines = useMemo(() => topCuisines(restaurants, 6), [restaurants]);

  return (
    <Screen style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <AppText style={styles.title}>Food</AppText>
        <View style={styles.locationRow}>
          <Ionicons name="location-outline" size={14} color={colors.primary} />
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
            {location?.label ? `Delivering to ${location.label}` : "Restaurants and cafes on AdiOne"}
          </AppText>
        </View>
      </View>

      {query.isLoading ? (
        <FoodSkeleton />
      ) : query.isError ? (
        <ErrorState
          message="We could not load restaurants."
          offline={(query.error as { isOffline?: boolean } | null)?.isOffline === true}
          onRetry={() => void query.refetch()}
        />
      ) : restaurants.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="restaurant-outline" size={48} color={colors.primary} />}
          title="No restaurants here yet"
          hint={
            location
              ? "No restaurant or cafe delivers to this location right now. Try another address."
              : "Set your delivery location to see the restaurants and cafes near you."
          }
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.sellerId}
          renderItem={({ item }) => (
            <View style={styles.cardWrap}>
              <RestaurantCard restaurant={item} onPress={onOpenRestaurant} />
            </View>
          )}
          ListHeaderComponent={
            <View>
              {cuisines.length > 0 && (
                <AppText variant="caption" color={colors.textSecondary} style={styles.cuisines} numberOfLines={2}>
                  {cuisines.join(" • ")}
                </AppText>
              )}
              {filters.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                  {filters.map((filter) => {
                    const selected = filter.key === active.key;
                    return (
                      <Pressable
                        key={filter.key}
                        onPress={() => setFilterKey(filter.key)}
                        style={[styles.chip, selected && styles.chipSelected]}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                      >
                        <AppText style={[styles.chipText, selected && styles.chipTextSelected]}>{filter.label}</AppText>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
              <AppText style={styles.count}>
                {visible.length} {visible.length === 1 ? "place" : "places"} to order from
              </AppText>
            </View>
          }
          ListEmptyComponent={<EmptyState title="Nothing matches" hint="Try another filter." />}
          contentContainerStyle={{ paddingBottom: tabBarClearance + MINI_CART_ROOM }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={4}
          windowSize={7}
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
  header: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  cuisines: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
  },
  chips: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  chipSelected: {
    borderColor: palette.green500,
    backgroundColor: palette.green50,
  },
  chipText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  chipTextSelected: {
    color: palette.green700,
    fontWeight: "800",
  },
  count: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  cardWrap: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.md,
  },
});

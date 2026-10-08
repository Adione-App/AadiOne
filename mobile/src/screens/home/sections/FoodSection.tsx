/**
 * Home's food block: an "order food" promo card plus a horizontal rail of
 * the restaurants and cafes that actually deliver here (GET /restaurants).
 *
 * Every word that names a place, a cuisine or a seller type comes from that
 * response, so a new food seller type, cuisine or restaurant shows up with
 * no change here. Home only includes this section when at least one food
 * seller has a menu — there is no "coming soon" state.
 */

import { memo, useMemo } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ArrowRight, UtensilsCrossed } from "lucide-react-native";
import type { RestaurantSummaryDto } from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { RESTAURANT_CARD_WIDTH, RestaurantCard } from "@/components/RestaurantCard";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { pluralTypeLabel, topCuisines } from "../homeEngine";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

function FoodSectionImpl({
  restaurants,
  onOpenRestaurant,
  onOpenFood,
}: {
  restaurants: RestaurantSummaryDto[];
  onOpenRestaurant: (sellerId: string) => void;
  onOpenFood: () => void;
}) {
  // "Restaurants & Cafes" — from the seller types actually present.
  const title = useMemo(
    () => [...new Set(restaurants.map((restaurant) => restaurant.sellerType))].map(pluralTypeLabel).join(" & "),
    [restaurants],
  );
  const cuisines = useMemo(() => topCuisines(restaurants), [restaurants]);
  const heroImage = resolveImageUrl(restaurants.find((restaurant) => restaurant.coverImageUrl)?.coverImageUrl);

  return (
    <SectionPanel>
      <Pressable
        onPress={onOpenFood}
        style={({ pressed }) => [styles.promo, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Explore food"
      >
        <View style={styles.promoCopy}>
          <AppText style={styles.promoTitle}>Order delicious food</AppText>
          <AppText style={styles.promoSubtitle} numberOfLines={2}>
            {cuisines.length > 0 ? cuisines.join(" • ") : title}
          </AppText>
          <View style={styles.promoCta}>
            <AppText style={styles.promoCtaText}>Explore Food</AppText>
            <ArrowRight size={12} color={palette.white} strokeWidth={2.75} />
          </View>
        </View>
        <View style={styles.promoArt}>
          {heroImage ? (
            <Image source={{ uri: heroImage }} style={styles.promoImage} contentFit="cover" transition={150} cachePolicy="memory-disk" />
          ) : (
            <UtensilsCrossed size={44} color={palette.green600} strokeWidth={1.75} />
          )}
        </View>
      </Pressable>

      <SectionHeader title={title} onViewAll={onOpenFood} />
      <FlatList
        horizontal
        data={restaurants}
        keyExtractor={(item) => item.sellerId}
        renderItem={({ item }) => <RestaurantCard restaurant={item} compact onPress={onOpenRestaurant} />}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        getItemLayout={(_data, index) => ({
          length: RESTAURANT_CARD_WIDTH + spacing.sm,
          offset: (RESTAURANT_CARD_WIDTH + spacing.sm) * index,
          index,
        })}
        initialNumToRender={3}
        windowSize={5}
      />
    </SectionPanel>
  );
}

export const FoodSection = memo(FoodSectionImpl);

const styles = StyleSheet.create({
  promo: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: PANEL_PADDING,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: palette.green50,
    borderWidth: 1,
    borderColor: palette.green100,
    overflow: "hidden",
  },
  pressed: {
    opacity: 0.85,
  },
  promoCopy: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.sm,
  },
  promoTitle: {
    fontSize: 18,
    lineHeight: 23,
    fontWeight: "800",
    color: palette.green900,
  },
  promoSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    color: colors.textSecondary,
    marginTop: 2,
  },
  promoCta: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 30,
    borderRadius: radius.pill,
    backgroundColor: palette.green600,
  },
  promoCtaText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "800",
    color: palette.white,
  },
  promoArt: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: palette.green100,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  promoImage: {
    width: "100%",
    height: "100%",
  },
  row: {
    paddingHorizontal: PANEL_PADDING,
    gap: spacing.sm,
  },
});

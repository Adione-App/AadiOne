/**
 * A restaurant / cafe card — every field is the seller's real data from
 * GET /restaurants. A seller without any menu photo gets a lettered tile,
 * never a stock food picture pretending to be theirs.
 *
 * `compact` is the fixed-width card of Home's horizontal food rail; the
 * default is the full-width card of the Food tab.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Clock, MapPin } from "lucide-react-native";
import type { RestaurantSummaryDto } from "@shared";
import { formatDistance } from "@shared/distance";
import { colors, palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";

export const RESTAURANT_CARD_WIDTH = 220;

function typeLabel(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}

function RestaurantCardImpl({
  restaurant,
  compact = false,
  onPress,
}: {
  restaurant: RestaurantSummaryDto;
  compact?: boolean;
  onPress: (sellerId: string) => void;
}) {
  const cover = resolveImageUrl(restaurant.coverImageUrl);
  const cuisine = restaurant.cuisine.filter((entry) => entry.trim().length > 0).join(", ");

  return (
    <Pressable
      onPress={() => onPress(restaurant.sellerId)}
      style={({ pressed }) => [styles.card, compact ? styles.cardCompact : styles.cardWide, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${restaurant.name}${restaurant.isOpen ? "" : ", closed now"}`}
    >
      <View style={[styles.media, compact ? styles.mediaCompact : styles.mediaWide]}>
        {cover ? (
          <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
        ) : (
          <View style={styles.lettered}>
            <AppText style={styles.letter}>{restaurant.name.trim().charAt(0).toUpperCase()}</AppText>
          </View>
        )}

        <View style={styles.typeChip}>
          <AppText style={styles.typeChipText}>{typeLabel(restaurant.sellerType)}</AppText>
        </View>

        {restaurant.isVegOnly && (
          <View style={styles.vegChip}>
            <View style={styles.vegDot} />
            <AppText style={styles.vegText}>Pure Veg</AppText>
          </View>
        )}

        {!restaurant.isOpen && (
          <View style={styles.closedBand}>
            <AppText style={styles.closedText} numberOfLines={1}>
              {restaurant.nextOpenText ?? "Closed now"}
            </AppText>
          </View>
        )}
      </View>

      <View style={styles.body}>
        <AppText style={styles.name} numberOfLines={1}>
          {restaurant.name}
        </AppText>
        {cuisine ? (
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {cuisine}
          </AppText>
        ) : null}

        <View style={styles.meta}>
          {restaurant.avgPrepMins !== null && (
            <View style={styles.metaItem}>
              <Clock size={12} color={colors.textSecondary} strokeWidth={2.25} />
              <AppText style={styles.metaText}>{restaurant.avgPrepMins} min</AppText>
            </View>
          )}
          {restaurant.distanceKm !== null && (
            <View style={styles.metaItem}>
              <MapPin size={12} color={colors.textSecondary} strokeWidth={2.25} />
              <AppText style={styles.metaText}>{formatDistance(restaurant.distanceKm)}</AppText>
            </View>
          )}
          <AppText style={styles.metaText}>
            {restaurant.menuItemCount} {restaurant.menuItemCount === 1 ? "item" : "items"}
          </AppText>
        </View>
      </View>
    </Pressable>
  );
}

export const RestaurantCard = memo(RestaurantCardImpl);

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  cardCompact: {
    width: RESTAURANT_CARD_WIDTH,
  },
  cardWide: {
    width: "100%",
  },
  pressed: {
    opacity: 0.85,
  },
  media: {
    backgroundColor: colors.primarySurface,
  },
  mediaCompact: {
    height: 112,
  },
  mediaWide: {
    height: 160,
  },
  lettered: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.green100,
  },
  letter: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: "800",
    color: palette.green600,
  },
  typeChip: {
    position: "absolute",
    left: spacing.sm,
    top: spacing.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.94)",
  },
  typeChipText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  vegChip: {
    position: "absolute",
    right: spacing.sm,
    top: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.94)",
  },
  vegDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.green500,
  },
  vegText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
    color: palette.green700,
  },
  closedBand: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    backgroundColor: "rgba(20,24,22,0.72)",
  },
  closedText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: palette.white,
  },
  body: {
    paddingHorizontal: spacing.sm + 2,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm + 2,
  },
  name: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: spacing.sm,
    marginTop: 4,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  metaText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
});

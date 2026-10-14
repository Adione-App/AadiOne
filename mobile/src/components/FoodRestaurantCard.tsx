/**
 * One restaurant / cafe on the Food screen: a large photo on the left (with
 * its veg / non-veg mark), the details on the right — name and open status,
 * cuisine tags, delivery time and delivery fee, and a chevron to its menu.
 *
 * Everything shown is real: the photo is the restaurant's own cover (else a
 * photo from its menu), the time and fee are what checkout would quote for
 * this location, and a value the server did not send is simply left out — no
 * ratings or review counts are drawn because none exist.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Bike, ChevronRight, Clock, UtensilsCrossed } from "lucide-react-native";
import type { RestaurantSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";

const MAX_TAGS = 3;

/** The square veg / non-veg mark used on Indian menus (green dot / red dot). */
export function DietBadge({ diet, size = 22 }: { diet: RestaurantSummaryDto["diet"] | "VEG" | "NON_VEG" | null | undefined; size?: number }) {
  if (!diet) return null;
  const tone = diet === "VEG" ? palette.green600 : palette.red500;
  return (
    <View
      style={[styles.dietBox, { width: size, height: size, borderColor: tone, borderRadius: size * 0.22 }]}
      accessibilityLabel={diet === "VEG" ? "Pure veg" : "Serves non-veg"}
    >
      <View style={{ width: size * 0.46, height: size * 0.46, borderRadius: size * 0.23, backgroundColor: tone }} />
    </View>
  );
}

/** "25–35 min" from the delivery estimate, else the kitchen's prep time. */
export function timeText(restaurant: RestaurantSummaryDto): string | null {
  const min = restaurant.etaMinMinutes ?? null;
  const max = restaurant.etaMaxMinutes ?? null;
  if (min !== null && max !== null) return min === max ? `${min} min` : `${min}–${max} min`;
  if (restaurant.avgPrepMins !== null) return `${restaurant.avgPrepMins} min prep`;
  return null;
}

function FoodRestaurantCardImpl({ restaurant, onPress }: { restaurant: RestaurantSummaryDto; onPress: (sellerId: string) => void }) {
  const image = resolveImageUrl(restaurant.coverImageUrl);
  const tags = restaurant.cuisine.map((c) => c.trim()).filter(Boolean).slice(0, MAX_TAGS);
  const time = timeText(restaurant);
  const fee = restaurant.deliveryFeePaise ?? null;

  return (
    <Pressable
      onPress={() => onPress(restaurant.sellerId)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${restaurant.name}, ${restaurant.isOpen ? "open" : "closed"}. Open menu`}
    >
      <View style={styles.photo}>
        {image ? (
          <Image source={{ uri: image }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
        ) : (
          <View style={styles.photoFallback}>
            <UtensilsCrossed size={34} color={palette.green600} strokeWidth={1.75} />
          </View>
        )}
        {restaurant.diet ? (
          <View style={styles.photoDiet}>
            <DietBadge diet={restaurant.diet} size={20} />
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <AppText style={styles.name} numberOfLines={2}>
            {restaurant.name}
          </AppText>
          <View style={[styles.status, restaurant.isOpen ? styles.statusOpen : styles.statusClosed]}>
            <AppText style={[styles.statusText, { color: restaurant.isOpen ? palette.green700 : colors.textSecondary }]}>
              {restaurant.isOpen ? "Open" : "Closed"}
            </AppText>
          </View>
        </View>
        {!restaurant.isOpen && restaurant.nextOpenText ? (
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {restaurant.nextOpenText}
          </AppText>
        ) : null}

        {tags.length > 0 && (
          <View style={styles.tags}>
            {tags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <AppText style={styles.tagText} numberOfLines={1}>
                  {tag}
                </AppText>
              </View>
            ))}
          </View>
        )}

        <View style={styles.footer}>
          <View style={styles.meta}>
            {time ? (
              <View style={styles.metaItem}>
                <Clock size={14} color={colors.textSecondary} strokeWidth={2.25} />
                <AppText style={styles.metaText} numberOfLines={1}>
                  {time}
                </AppText>
              </View>
            ) : null}
            {fee !== null ? (
              <View style={styles.metaItem}>
                <Bike size={15} color={palette.green700} strokeWidth={2.25} />
                <AppText style={[styles.metaText, styles.feeText]} numberOfLines={1}>
                  {fee === 0 ? "Free delivery" : `${formatPaise(fee)} delivery`}
                </AppText>
              </View>
            ) : null}
          </View>
          <View style={styles.chevron}>
            <ChevronRight size={18} color={palette.green700} strokeWidth={2.5} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export const FoodRestaurantCard = memo(FoodRestaurantCardImpl);

const PHOTO_RATIO = 1.32;

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.sm,
    gap: spacing.md,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  pressed: {
    opacity: 0.92,
  },
  photo: {
    width: "40%",
    aspectRatio: PHOTO_RATIO,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: palette.green50,
  },
  photoFallback: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  photoDiet: {
    position: "absolute",
    left: 8,
    bottom: 8,
    padding: 3,
    borderRadius: 7,
    backgroundColor: colors.surface,
  },
  dietBox: {
    borderWidth: 1.75,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 2,
    justifyContent: "space-between",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  name: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  status: {
    paddingHorizontal: 10,
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
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.xs,
  },
  tag: {
    maxWidth: "100%",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.md,
    backgroundColor: palette.green50,
  },
  tagText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
    color: palette.green700,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    rowGap: 4,
    columnGap: spacing.md,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  feeText: {
    color: palette.green700,
  },
  chevron: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: palette.green50,
    alignItems: "center",
    justifyContent: "center",
  },
});

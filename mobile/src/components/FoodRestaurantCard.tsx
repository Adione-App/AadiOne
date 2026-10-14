/**
 * One restaurant / cafe on the Food screen: its COVER photo on the left (the
 * place itself — never its menu image); the details on the right — its veg /
 * non-veg marks beside the name (green = serves veg, red = serves non-veg,
 * both for a place with both, from the real item marks: servesVeg /
 * servesNonVeg), open status, cuisine tags, its time and a chevron to its menu.
 *
 * Everything shown is real: the photo is the restaurant's own cover (else a
 * photo from its menu); the time is its configured preparation time as
 * prepTimeRange() shows it everywhere (30 → "25–35 min") and is left out when
 * the restaurant has not set one; no ratings, reviews or fees are drawn.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { ChevronRight, Clock, UtensilsCrossed } from "lucide-react-native";
import { prepTimeRange, type RestaurantSummaryDto } from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";

const MAX_TAGS = 3;
/** Fixed photo size, so every card has the same height whatever its text. */
const PHOTO_WIDTH = 112;
const PHOTO_HEIGHT = 104;

/** The square veg / non-veg mark used on Indian menus (green dot / red dot). */
export function DietBadge({
  diet,
  size = 22,
}: {
  diet: RestaurantSummaryDto["diet"] | "VEG" | "NON_VEG" | null | undefined;
  size?: number;
}) {
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

/** Which marks a place gets: from servesVeg / servesNonVeg; an older server's single `diet` otherwise. */
export function dietMarks(restaurant: Pick<RestaurantSummaryDto, "diet" | "servesVeg" | "servesNonVeg">): { veg: boolean; nonVeg: boolean } {
  if (restaurant.servesVeg !== undefined || restaurant.servesNonVeg !== undefined) {
    return { veg: Boolean(restaurant.servesVeg), nonVeg: Boolean(restaurant.servesNonVeg) };
  }
  return { veg: restaurant.diet === "VEG", nonVeg: restaurant.diet === "NON_VEG" };
}

function FoodRestaurantCardImpl({
  restaurant,
  onPress,
}: {
  restaurant: RestaurantSummaryDto;
  onPress: (sellerId: string) => void;
}) {
  const image = resolveImageUrl(restaurant.coverImageUrl);
  const tags = restaurant.cuisine.map((c) => c.trim()).filter(Boolean).slice(0, MAX_TAGS);
  const time = prepTimeRange(restaurant.avgPrepMins);
  const marks = dietMarks(restaurant);

  return (
    <Pressable
      onPress={() => onPress(restaurant.sellerId)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${restaurant.name}, ${restaurant.isOpen ? "open" : "closed"}${time ? `, ${time.label}` : ""}. Open menu`}
    >
      <View style={styles.photo}>
        {image ? (
          <Image source={{ uri: image }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
        ) : (
          <View style={styles.photoFallback}>
            <UtensilsCrossed size={30} color={palette.green600} strokeWidth={1.75} />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          {marks.veg || marks.nonVeg ? (
            <View style={styles.marks}>
              {marks.veg ? <DietBadge diet="VEG" size={14} /> : null}
              {marks.nonVeg ? <DietBadge diet="NON_VEG" size={14} /> : null}
            </View>
          ) : null}
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
          <AppText style={styles.nextOpen} numberOfLines={1}>
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
          {time ? (
            <View style={styles.metaItem}>
              <Clock size={13} color={colors.textSecondary} strokeWidth={2.25} />
              <AppText style={styles.metaText} numberOfLines={1}>
                {time.label}
              </AppText>
            </View>
          ) : (
            <View />
          )}
          <View style={styles.chevron}>
            <ChevronRight size={16} color={palette.green700} strokeWidth={2.5} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export const FoodRestaurantCard = memo(FoodRestaurantCardImpl);

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.sm,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.divider,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  pressed: {
    opacity: 0.92,
  },
  photo: {
    width: PHOTO_WIDTH,
    height: PHOTO_HEIGHT,
    borderRadius: radius.md,
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
  marks: {
    flexDirection: "row",
    gap: 3,
    marginTop: 3,
  },
  dietBox: {
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  name: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
    color: colors.textPrimary,
  },
  status: {
    paddingHorizontal: 8,
    paddingVertical: 2,
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
  nextOpen: {
    marginTop: 2,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
  },
  tag: {
    maxWidth: "100%",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: palette.green50,
  },
  tagText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: palette.green700,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: "auto",
    paddingTop: 6,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  chevron: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: palette.green50,
    alignItems: "center",
    justifyContent: "center",
  },
});

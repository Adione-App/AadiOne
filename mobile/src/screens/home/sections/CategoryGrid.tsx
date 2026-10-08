/**
 * "Shop by Category" — a 4-column grid of the live category tree: every top
 * category first (server order), then their subcategories, capped to a few
 * rows with "View All" for the rest. The server already leaves out empty and
 * switched-off categories, so whatever arrives here has something to buy.
 */

import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { CategoryDto } from "@shared";
import { colors, spacing } from "@shared/theme";
import CategoryIcon from "@/components/CategoryIcon";
import { AppText } from "@/components/ui";
import { SectionHeader, SectionPanel } from "./SectionShell";

const COLUMNS = 4;
const MAX_ROWS = 3;

function CategoryGridImpl({
  categories,
  onOpenCategory,
  onViewAll,
}: {
  categories: CategoryDto[];
  onOpenCategory: (categoryId: string) => void;
  onViewAll: () => void;
}) {
  const tiles = useMemo(
    () =>
      [...categories, ...categories.flatMap((category) => category.children ?? [])].slice(
        0,
        COLUMNS * MAX_ROWS,
      ),
    [categories],
  );

  if (tiles.length === 0) return null;

  return (
    <SectionPanel>
      <SectionHeader title="Shop by Category" onViewAll={onViewAll} />
      <View style={styles.grid}>
        {tiles.map((category) => (
          <Pressable
            key={category.id}
            onPress={() => onOpenCategory(category.id)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Open ${category.name}`}
          >
            <View style={styles.circle}>
              <CategoryIcon name={category.name} imageUrl={category.imageUrl} size={58} />
            </View>
            <AppText variant="caption" numberOfLines={2} style={styles.name}>
              {category.name}
            </AppText>
          </Pressable>
        ))}
      </View>
    </SectionPanel>
  );
}

export const CategoryGrid = memo(CategoryGridImpl);

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: spacing.xs,
  },
  tile: {
    width: `${100 / COLUMNS}%`,
    alignItems: "center",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md,
  },
  pressed: {
    opacity: 0.7,
  },
  circle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  name: {
    marginTop: spacing.xs,
    textAlign: "center",
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
    color: colors.textPrimary,
  },
});

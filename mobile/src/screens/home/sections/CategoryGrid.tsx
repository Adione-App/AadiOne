/**
 * A Home category grid — "Top Categories", "Explore Subcategories", "More
 * Categories". The engine (homeEngine.ts) decides which real categories fill
 * it; this only draws them: each tile opens its own category (a subcategory
 * opens inside its parent on the Categories screen), and "View All" opens the
 * full category list. The server already leaves out empty and switched-off
 * categories, so every tile has something to buy.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { CategoryDto } from "@shared";
import { colors, spacing } from "@shared/theme";
import CategoryIcon from "@/components/CategoryIcon";
import { AppText } from "@/components/ui";
import { SectionHeader, SectionPanel } from "./SectionShell";

/** Tile circle size per column count — five across stays readable on a 360 dp phone. */
const CIRCLE = { 4: 64, 5: 54 } as const;

function CategoryGridImpl({
  title,
  categories,
  columns,
  onOpenCategory,
  onViewAll,
}: {
  title: string;
  categories: CategoryDto[];
  columns: 4 | 5;
  onOpenCategory: (categoryId: string) => void;
  onViewAll?: (() => void) | undefined;
}) {
  if (categories.length === 0) return null;
  const circle = CIRCLE[columns];

  return (
    <SectionPanel>
      <SectionHeader title={title} onViewAll={onViewAll} />
      <View style={styles.grid}>
        {categories.map((category) => (
          <Pressable
            key={category.id}
            onPress={() => onOpenCategory(category.id)}
            style={({ pressed }) => [styles.tile, { width: `${100 / columns}%` }, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Open ${category.name}`}
          >
            <View style={[styles.circle, { width: circle, height: circle, borderRadius: circle / 2 }]}>
              <CategoryIcon name={category.name} imageUrl={category.imageUrl} size={circle - 6} />
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
    alignItems: "center",
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md,
  },
  pressed: {
    opacity: 0.7,
  },
  circle: {
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

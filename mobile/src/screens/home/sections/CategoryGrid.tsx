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
import { spacing } from "@shared/theme";
import CategoryIcon from "@/components/CategoryIcon";
import { AppText } from "@/components/ui";
import { SectionHeader, SectionPanel } from "./SectionShell";

/** Slightly larger rounded-square tiles for 4 or 5 columns. */
const TILE_SIZE = { 4: 80, 5: 70 } as const;
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

  const tileSize = TILE_SIZE[columns];

  return (
    <SectionPanel>
      <SectionHeader title={title} onViewAll={onViewAll} />

      <View style={styles.grid}>
        {categories.map((category) => (
          <Pressable
            key={category.id}
            onPress={() => onOpenCategory(category.id)}
            style={({ pressed }) => [
              styles.tile,
              { width: `${100 / columns}%` },
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Open ${category.name}`}
          >
            <View
              style={[
                styles.categoryImageBox,
                {
                  width: tileSize,
                  height: tileSize,
                },
              ]}
            >
              <CategoryIcon
                name={category.name}
                imageUrl={category.imageUrl}
                size={tileSize - 8}
              />
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
    opacity: 0.75,
  },

  categoryImageBox: {
    backgroundColor: "#F0F8F0",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },

  name: {
    marginTop: spacing.sm,
    textAlign: "center",
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "600",
    color: "#26382A",
  },
});

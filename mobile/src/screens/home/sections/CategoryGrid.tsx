/**
 * A Home category grid — "Shop by category", "Explore subcategories", "More
 * categories". Which categories fill it, in which order and how many come
 * from the admin's placement (Admin Panel → Category Management, applied by
 * homeLayout.ts); this only draws the tiles: grid or one scrolling row,
 * tiles per row (or as many as fit), tile shape, image fit and colours.
 * Each tile opens its own category (a subcategory opens inside its parent on
 * the Categories screen); "View all" opens the full category list.
 */

import { memo } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { contentColor } from "@shared";
import { spacing } from "@shared/theme";
import CategoryIcon from "@/components/CategoryIcon";
import { AppText } from "@/components/ui";
import type { CategoryGridDisplay, CategoryTile } from "../homeLayout";
import { SectionHeader, SectionPanel } from "./SectionShell";

const GRID_INSET = spacing.xs;
/** A tile never gets narrower than this when the columns are automatic. */
const MIN_TILE_WIDTH = 76;
const ROW_TILE_WIDTH = 84;
/** Image box per tiles-per-row — 4 and 5 keep the sizes Home always had. */
const BOX_BY_COLUMNS: Record<number, number> = { 3: 96, 4: 80, 5: 70, 6: 58 };
const DEFAULT_TILE_COLOR = "#F0F8F0";
const TEXT_COLOR = { dark: "#26382A", light: "#FFFFFF" } as const;

/** Tiles per row: the admin's number, or as many as fit (3 – 6). */
function columnsFor(display: CategoryGridDisplay, width: number): number {
  if (display.columns) return display.columns;
  return Math.min(6, Math.max(3, Math.floor(width / MIN_TILE_WIDTH)));
}

function Tile({
  tile,
  display,
  width,
  box: preferred,
  onOpenCategory,
}: {
  tile: CategoryTile;
  display: CategoryGridDisplay;
  width: number;
  box: number;
  onOpenCategory: (categoryId: string) => void;
}) {
  // Never wider than its cell (a little room either side), never tiny.
  const box = Math.max(48, Math.min(preferred, Math.floor(width - 4)));
  const radius = display.tileShape === "circle" ? box / 2 : display.tileShape === "square" ? 0 : 14;
  return (
    <Pressable
      onPress={() => onOpenCategory(tile.category.id)}
      style={({ pressed }) => [styles.tile, { width }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${tile.label}`}
    >
      <View
        style={[
          styles.imageBox,
          { width: box, height: box, borderRadius: radius, backgroundColor: contentColor(tile.tileBackground ?? display.tileBackground, DEFAULT_TILE_COLOR) },
        ]}
      >
        <CategoryIcon
          name={tile.category.name}
          imageUrl={tile.category.imageUrl}
          size={display.imageFit === "cover" ? box : box - 8}
          fit={display.imageFit}
          radius={display.imageFit === "cover" ? radius : 10}
        />
      </View>
      <AppText variant="caption" numberOfLines={2} style={[styles.name, tile.textColor ? { color: TEXT_COLOR[tile.textColor] } : null]}>
        {tile.label}
      </AppText>
    </Pressable>
  );
}

function CategoryGridImpl({
  title,
  subtitle,
  tiles,
  display,
  onOpenCategory,
  onViewAll,
}: {
  title: string;
  subtitle?: string | null;
  tiles: CategoryTile[];
  display: CategoryGridDisplay;
  onOpenCategory: (categoryId: string) => void;
  onViewAll?: (() => void) | undefined;
}) {
  const { width: screenWidth } = useWindowDimensions();
  if (tiles.length === 0) return null;

  if (display.layout === "row") {
    return (
      <SectionPanel>
        <SectionHeader title={title} subtitle={subtitle} onViewAll={onViewAll} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {tiles.map((tile) => (
            <Tile key={tile.category.id} tile={tile} display={display} width={ROW_TILE_WIDTH} box={72} onOpenCategory={onOpenCategory} />
          ))}
        </ScrollView>
      </SectionPanel>
    );
  }

  // SectionPanel has no side margin or padding; the grid keeps its own small inset.
  const innerWidth = screenWidth - GRID_INSET * 2;
  const columns = columnsFor(display, innerWidth);
  const cell = Math.floor(innerWidth / columns);

  return (
    <SectionPanel>
      <SectionHeader title={title} subtitle={subtitle} onViewAll={onViewAll} />
      <View style={styles.grid}>
        {tiles.map((tile) => (
          <Tile key={tile.category.id} tile={tile} display={display} width={cell} box={BOX_BY_COLUMNS[columns] ?? 80} onOpenCategory={onOpenCategory} />
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
    paddingHorizontal: GRID_INSET,
  },
  row: {
    paddingHorizontal: GRID_INSET,
    gap: spacing.xs,
  },
  tile: {
    alignItems: "center",
    marginBottom: spacing.md,
  },
  pressed: {
    opacity: 0.75,
  },
  imageBox: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  name: {
    marginTop: spacing.sm,
    paddingHorizontal: 2,
    textAlign: "center",
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "600",
    color: TEXT_COLOR.dark,
  },
});

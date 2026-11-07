/**
 * Loading placeholders for Home.
 *
 * Product placeholders are the existing `ProductCardSkeleton` (same box
 * sizes as the real card, so nothing jumps when data lands). Everything
 * else — banner, category circles — uses the shared `Bone`. Both come from
 * components/Skeleton.tsx: the app's one light-green, single-pulse skeleton
 * style, shared with Categories, Food, menus and search.
 */

import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { radius, spacing } from "@shared/theme";
import { ProductCardSkeleton } from "@/components/ProductCardSkeleton";
import { Bone, SkeletonGroup, useSkeletonPulse } from "@/components/Skeleton";
import { productGridColumns, type ProductShelfDisplay } from "../homeLayout";
import { PANEL_PADDING, SectionHeader, SectionPanel } from "./SectionShell";

/** Home's standard carousel card width (ProductShelf's SHELF_CARD_WIDTH). */
const STANDARD_CARD_WIDTH = 132;
const STANDARD_GAP = 8;

/**
 * A shelf still loading: its header (the real title when known, else a
 * bone), then product-card skeletons laid out exactly like the shelf's own
 * cards — a carousel row at its card width and gap, or a grid at its
 * columns — so the real shelf replaces it without moving.
 */
export function ShelfSkeleton({
  progress,
  cardWidth = STANDARD_CARD_WIDTH,
  count = 3,
  title,
  subtitle,
  display,
}: {
  progress: SharedValue<number>;
  cardWidth?: number;
  count?: number;
  title?: string;
  subtitle?: string | null;
  /** The shelf's own layout (Home Page Builder shelves); absent = the standard carousel. */
  display?: ProductShelfDisplay;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const gap = display?.gap ?? STANDARD_GAP;
  const grid = display?.layout === "grid" ? productGridColumns(display.columns, screenWidth - PANEL_PADDING * 2, gap) : null;
  const width = grid ? grid.cardWidth : (display?.cardWidth ?? cardWidth);
  // A grid shows one row (never an oversized block); a carousel what fits.
  const cards = grid ? grid.columns : count;
  return (
    <SectionPanel>
      {title ? (
        <SectionHeader title={title} subtitle={subtitle} />
      ) : (
        <View style={styles.headerRow}>
          <Bone progress={progress} width={140} height={16} />
          <Bone progress={progress} width={52} height={12} />
        </View>
      )}
      <View style={[grid ? styles.gridRow : styles.cardRow, { gap }]}>
        {Array.from({ length: cards }, (_, index) => (
          <View key={index} style={{ width }}>
            <ProductCardSkeleton progress={progress} />
          </View>
        ))}
      </View>
    </SectionPanel>
  );
}

/** A single shelf loading on its own (Latest Products, a Home Page Builder shelf): its own pulse. */
export function ShelfLoading(props: Omit<Parameters<typeof ShelfSkeleton>[0], "progress">) {
  const progress = useSkeletonPulse();
  return (
    <SkeletonGroup label={props.title ? `Loading ${props.title}` : "Loading products"}>
      <ShelfSkeleton progress={progress} {...props} />
    </SkeletonGroup>
  );
}

/** Whole-page placeholder for the very first load (nothing cached yet). */
export function HomeSkeleton({ cardWidth }: { cardWidth: number }) {
  const progress = useSkeletonPulse();

  return (
    <SkeletonGroup label="Loading">
      <View style={styles.bannerWrap}>
        <Bone progress={progress} width="100%" height={150} rounded={radius.xl} />
      </View>

      <SectionPanel>
        <View style={styles.headerRow}>
          <Bone progress={progress} width={130} height={16} />
        </View>
        <View style={styles.grid}>
          {Array.from({ length: 8 }, (_, index) => (
            <View key={index} style={styles.gridCell}>
              <Bone progress={progress} width={56} height={56} rounded={28} />
              <Bone progress={progress} width={48} height={10} style={{ marginTop: spacing.xs }} />
            </View>
          ))}
        </View>
      </SectionPanel>

      <ShelfSkeleton progress={progress} cardWidth={cardWidth} />
      <ShelfSkeleton progress={progress} cardWidth={cardWidth} />
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  bannerWrap: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: PANEL_PADDING,
    marginBottom: spacing.md,
  },
  cardRow: {
    flexDirection: "row",
    paddingHorizontal: PANEL_PADDING,
    overflow: "hidden",
  },
  gridRow: {
    flexDirection: "row",
    paddingHorizontal: PANEL_PADDING,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: spacing.xs,
  },
  gridCell: {
    width: "25%",
    alignItems: "center",
    marginBottom: spacing.md,
  },
});

/**
 * Loading placeholders for Home.
 *
 * Product placeholders are the existing `ProductCardSkeleton` (same box
 * sizes as the real card, so nothing jumps when data lands). Everything
 * else — banner, category circles — uses the shared `Bone`. Both come from
 * components/Skeleton.tsx: the app's one light-green, single-pulse skeleton
 * style, shared with Categories, Food, menus and search.
 */

import { StyleSheet, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { radius, spacing } from "@shared/theme";
import { ProductCardSkeleton } from "@/components/ProductCardSkeleton";
import { Bone, SkeletonGroup, useSkeletonPulse } from "@/components/Skeleton";
import { PANEL_PADDING, SectionPanel } from "./SectionShell";

/** A shelf still loading: title bone + a row of product-card skeletons. */
export function ShelfSkeleton({
  progress,
  cardWidth,
  count = 3,
}: {
  progress: SharedValue<number>;
  cardWidth: number;
  count?: number;
}) {
  return (
    <SectionPanel>
      <View style={styles.headerRow}>
        <Bone progress={progress} width={140} height={16} />
        <Bone progress={progress} width={52} height={12} />
      </View>
      <View style={styles.cardRow}>
        {Array.from({ length: count }, (_, index) => (
          <View key={index} style={{ width: cardWidth }}>
            <ProductCardSkeleton progress={progress} />
          </View>
        ))}
      </View>
    </SectionPanel>
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
    gap: spacing.sm,
    paddingHorizontal: PANEL_PADDING,
    overflow: "hidden",
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

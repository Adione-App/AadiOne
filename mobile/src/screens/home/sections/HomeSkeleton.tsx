/**
 * Loading placeholders for Home.
 *
 * Product placeholders are the existing `ProductCardSkeleton` (same box
 * sizes as the real card, so nothing jumps when data lands). Everything
 * else — banner, category circles, store/restaurant cards — uses `Bone`, a
 * soft opacity pulse. Every bone on screen reads ONE shared Reanimated value,
 * so a screenful of placeholders is still a single looping animation on the
 * UI thread.
 */

import { useEffect } from "react";
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import ReanimatedAnimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { radius, spacing } from "@shared/theme";
import { ProductCardSkeleton } from "@/components/ProductCardSkeleton";
import { PANEL_PADDING, SectionPanel } from "./SectionShell";

const BONE_COLOR = "#ECEEED";

/** One looping 0→1→0 driver; share it between every bone of a placeholder. */
export function useShimmer(): SharedValue<number> {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [progress]);
  return progress;
}

export function Bone({
  progress,
  width,
  height,
  rounded = radius.sm,
  style,
}: {
  progress: SharedValue<number>;
  width: DimensionValue;
  height: number;
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const animated = useAnimatedStyle(() => ({ opacity: 0.55 + progress.value * 0.45 }));
  return (
    <ReanimatedAnimated.View
      style={[{ width, height, borderRadius: rounded, backgroundColor: BONE_COLOR }, animated, style]}
    />
  );
}

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
            <ProductCardSkeleton progress={progress} index={index} />
          </View>
        ))}
      </View>
    </SectionPanel>
  );
}

/** Whole-page placeholder for the very first load (nothing cached yet). */
export function HomeSkeleton({ cardWidth }: { cardWidth: number }) {
  const progress = useShimmer();

  return (
    <View>
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
    </View>
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

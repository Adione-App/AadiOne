/**
 * Placeholder for a `ProductCard` that hasn't loaded yet.
 *
 * Mirrors ProductCard's exact current layout and box sizes — media box,
 * the floating Add-button bone straddling its bottom-right corner, then
 * price, the reserved discount-row gap, name, and variant, in that order
 * — so the grid doesn't jump (or visibly change shape) when real cards
 * replace these.
 *
 * Built from the app's shared skeleton bones (components/Skeleton.tsx): the
 * same light green and the same single pulse as every other loading
 * placeholder. This used to have its own light-grey shimmer sweep and a
 * staggered entrance — the "old grey skeleton" that sat next to the
 * Categories pane's light-green one.
 */

import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { colors, radius, shadow, spacing } from "@shared/theme";
import { IMAGE_BOX_ASPECT, IMAGE_BOX_MAX_HEIGHT } from "./ProductCard";
import { Bone, SkeletonGroup, useSkeletonPulse } from "./Skeleton";

export function ProductCardSkeleton({
  progress,
}: {
  /** The placeholder's shared pulse (`useSkeletonPulse`). */
  progress: SharedValue<number>;
}) {
  return (
    <View style={styles.card}>
      {/* `mediaWrap`/`media`/`imageBox` + the floating add-button bone below
          mirror ProductCard.tsx's own structure and sizes piece for piece
          (media padding, the width-following image box capped at 150dp, the
          34x34 button straddling the image's bottom-right corner), so real
          cards replace these without the grid jumping. */}
      <View style={styles.mediaWrap}>
        <View style={styles.media}>
          <View style={styles.imageBox}>
            <View style={styles.imageBoxSizer} />
            <Bone progress={progress} style={styles.imageBone} />
          </View>
        </View>

        <View style={styles.floatingActionWrap}>
          <Bone progress={progress} width={34} height={34} />
        </View>
      </View>

      <View style={styles.priceRow}>
        <Bone progress={progress} width={50} height={14} />
      </View>

      {/* Matches ProductCard's own reserved discount-row height, so a
          real card replacing this doesn't shift the grid by that amount. */}
      <View style={styles.discountContainer} />

      <View style={styles.nameContainer}>
        <Bone progress={progress} width="90%" height={12} />
        <Bone progress={progress} width="60%" height={12} style={{ marginTop: 4 }} />
      </View>

      <View style={styles.variantContainer}>
        <Bone progress={progress} width="40%" height={10} />
      </View>
    </View>
  );
}

/**
 * A grid of skeleton cards, laid out like the real product grids: the same
 * column count and the same per-card cell padding (`cardWrapper` /
 * `productCell` / `popularCell` on those screens). `style` is the real
 * grid's own container padding, so the first row sits where the first
 * real row will.
 */
export function ProductGridSkeleton({
  columns,
  count = 6,
  style,
}: {
  columns: number;
  count?: number;
  style?: StyleProp<ViewStyle>;
}) {
  // ONE shared driver for the whole grid — every card's every bone reads it.
  const progress = useSkeletonPulse();

  return (
    <SkeletonGroup label="Loading products" style={[styles.grid, style]}>
      {Array.from({ length: Math.ceil(count / columns) * columns }, (_, index) => (
        <View key={index} style={[styles.cell, { width: `${100 / columns}%` }]}>
          <ProductCardSkeleton progress={progress} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: spacing.sm,
  },
  // The real grids' card cell: more vertical than horizontal padding.
  cell: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  card: {
    flex: 1,
    width: "100%",
  },
  // Mirrors ProductCard's `mediaWrap` — the plain, unclipped positioning
  // root the floating button bone below anchors to, exactly like the real
  // Add button does (see ProductCard.tsx's own comment on why it isn't
  // anchored to `media` instead).
  mediaWrap: {
    position: "relative",
  },
  // Mirrors ProductCard's `media` — the border lives on the image area
  // only, not the whole card (see ProductCard.tsx for why).
  media: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.xs,
    overflow: "hidden",
    ...shadow.sm,
  },
  // Mirrors ProductCard's `imageBox` + `imageBoxSizer`.
  imageBox: {
    width: "100%",
    maxHeight: IMAGE_BOX_MAX_HEIGHT,
    overflow: "hidden",
  },
  imageBoxSizer: {
    width: "100%",
    aspectRatio: IMAGE_BOX_ASPECT,
  },
  imageBone: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  // Mirrors ProductCard's `floatingActionWrap` — same straddle-the-corner
  // position (`right`/`bottom` offsets) as the real Add button, so this
  // bone sits exactly where that control will actually appear.
  floatingActionWrap: {
    position: "absolute",
    right: spacing.xs,
    bottom: -16,
  },
  // Price now comes BEFORE name/variant, matching ProductCard's current
  // order — `marginTop` is the same `BUTTON_OVERHANG + IMAGE_TEXT_GAP`
  // (16 + 8) ProductCard's own `priceRow` reserves to clear the floating
  // button's overhang below the image.
  priceRow: {
    height: 22,
    marginTop: 24,
    justifyContent: "center",
  },
  discountContainer: {
    height: 18,
    marginTop: 4,
  },
  nameContainer: {
    height: 35,
    marginTop: spacing.xs,
    justifyContent: "flex-start",
  },
  variantContainer: {
    height: 16,
    marginTop: 2,
    justifyContent: "center",
  },
});

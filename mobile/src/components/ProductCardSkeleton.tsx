/**
 * Placeholder for a `ProductCard` that hasn't loaded yet.
 *
 * Mirrors ProductCard's exact current layout and box sizes — media box,
 * the floating Add-button bone straddling its bottom-right corner, then
 * price, the reserved discount-row gap, name, and variant, in that order
 * — so the grid doesn't jump (or visibly change shape) when real cards
 * replace these. Used only for a category/list that has never been
 * fetched — a category already in the query cache renders its real cards
 * immediately instead (see CategoriesScreen).
 *
 * VISUAL DESIGN — a soft light "sheen" sweeping over each bone, not a flat
 * grey block pulsing on/off. Every card shares ONE Reanimated shared value
 * (`shimmerProgress`, created once in `ProductGridSkeleton` and handed
 * down) driving every bone's sweep in lockstep — a single continuous
 * "light passing over the grid" read, rather than each bone animating
 * independently and looking busy. There's no gradient library in this
 * project (`expo-linear-gradient` isn't installed, and this doesn't
 * warrant adding one) — the sheen is faked with three adjacent bands of
 * decreasing opacity (`shimmerEdge`/`shimmerCore`), which reads as a soft
 * highlight rather than a hard-edged flash without needing a real
 * gradient.
 *
 * ALL of this runs on the UI thread via Reanimated — `withRepeat` for the
 * sweep, a worklet `entering` (see `makeCardEntering`) for the staggered
 * fade-up each card enters with. Nothing here touches the JS thread on a
 * per-frame basis, there are no `setInterval`/timers, and the single
 * shared driver means mounting a 12-card grid still only ever creates ONE
 * looping animation, not twelve.
 */

import { useEffect } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type EntryAnimationsValues,
  type SharedValue,
} from "react-native-reanimated";
import { colors, radius, shadow, spacing } from "@shared/theme";

/**
 * Explicit skeleton colors, deliberately NOT `colors.skeleton` (grey100,
 * `#F1F3F2`) — that token sits only ~4 RGB units off `colors.surface`
 * (white), which is functionally invisible on a real screen: exactly what
 * read as "random very-light-grey blocks, almost the same as the white
 * background" rather than a deliberate skeleton. `#F3F4F6` gives real,
 * clearly-visible-but-still-subtle contrast against white without being
 * dark grey. The shimmer highlight sweeping over it is genuinely opaque
 * white at its peak (see `shimmerCore` below) for the same reason — a
 * translucent highlight on an already-near-white base was invisible on
 * top of being invisible.
 */
const SKELETON_BASE = "#F3F4F6";
const SKELETON_HIGHLIGHT = "#FFFFFF";

/** One full sweep, left edge to right edge, in ms — slow and gentle, not a
 * fast blink. */
const SHIMMER_DURATION = 1400;

/** Fixed travel distance for every bone's sweep, in px — deliberately NOT
 * derived from each bone's own (often percentage-based) width. Every bone
 * sweeping across the exact same real-pixel range, driven by the same
 * shared progress, is what makes them read as one coordinated light pass
 * over the card rather than each bone doing its own independent thing —
 * and it means no bone ever needs to measure itself before it can animate. */
const SHIMMER_BAND_WIDTH = 60;
const SHIMMER_TRAVEL_FROM = -SHIMMER_BAND_WIDTH;
const SHIMMER_TRAVEL_TO = 200;

/** Per-card entrance stagger — capped so a big grid's LAST card still
 * starts within a fraction of a second, not visibly lagging behind. */
const STAGGER_MS = 45;
const STAGGER_CAP = 8;
const ENTRANCE_DURATION = 240;

/**
 * The moving highlight itself — three adjacent bands (low/high/low
 * opacity) faking a soft linear gradient. `pointerEvents="none"`: purely
 * decorative, must never intercept a touch meant for whatever's under it.
 */
function ShimmerSweep({ progress }: { progress: SharedValue<number> }) {
  const sweepStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [SHIMMER_TRAVEL_FROM, SHIMMER_TRAVEL_TO],
        ),
      },
    ],
  }));

  return (
    <ReanimatedAnimated.View
      pointerEvents="none"
      style={[styles.shimmerBand, sweepStyle]}
    >
      <View style={styles.shimmerEdge} />
      <View style={styles.shimmerCore} />
      <View style={styles.shimmerEdge} />
    </ReanimatedAnimated.View>
  );
}

function Bone({
  style,
  progress,
}: {
  style?: StyleProp<ViewStyle>;
  progress: SharedValue<number>;
}) {
  return (
    <View style={[styles.bone, style]}>
      <ShimmerSweep progress={progress} />
    </View>
  );
}

/**
 * Fades + rises in, staggered by this card's own position in the grid —
 * "the products are being prepared" rather than every placeholder just
 * appearing at once. A worklet FACTORY (not the entering function
 * itself), matching this codebase's own established custom-entering
 * pattern (see MiniCartBar.tsx's `barEntering`) — parametrized by `index`
 * so each card gets its own delay from the SAME shared timing constants.
 */
function makeCardEntering(index: number) {
  return (_values: EntryAnimationsValues) => {
    "worklet";
    const delay = Math.min(index, STAGGER_CAP) * STAGGER_MS;

    return {
      initialValues: {
        opacity: 0,
        transform: [{ translateY: 10 }],
      },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: ENTRANCE_DURATION })),
        transform: [
          {
            translateY: withDelay(
              delay,
              withTiming(0, {
                duration: ENTRANCE_DURATION,
                easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
              }),
            ),
          },
        ],
      },
    };
  };
}

export function ProductCardSkeleton({
  progress,
  index = 0,
}: {
  progress: SharedValue<number>;
  /** This card's position in the grid — purely for the entrance stagger
   * (see `makeCardEntering`); has no effect on the shimmer sweep itself,
   * which is driven identically by `progress` for every card. */
  index?: number;
}) {
  return (
    <ReanimatedAnimated.View style={styles.card} entering={makeCardEntering(index)}>
      {/* `mediaWrap`/`media`/`imageBox` + the floating add-button bone below
          mirror ProductCard.tsx's own structure and exact pixel sizes
          (media padding, 92px image box, the 34x34 button straddling the
          image's bottom-right corner) piece for piece. */}
      <View style={styles.mediaWrap}>
        <View style={styles.media}>
          <Bone progress={progress} style={styles.imageBox} />
        </View>

        <View style={styles.floatingActionWrap}>
          <Bone progress={progress} style={styles.floatingAddButton} />
        </View>
      </View>

      <View style={styles.priceRow}>
        <Bone progress={progress} style={{ width: 50, height: 14 }} />
      </View>

      {/* Matches ProductCard's own reserved discount-row height, so a
          real card replacing this doesn't shift the grid by that amount. */}
      <View style={styles.discountContainer} />

      <View style={styles.nameContainer}>
        <Bone progress={progress} style={{ width: "90%", height: 12 }} />
        <Bone progress={progress} style={{ width: "60%", height: 12, marginTop: 4 }} />
      </View>

      <View style={styles.variantContainer}>
        <Bone progress={progress} style={{ width: "40%", height: 10 }} />
      </View>
    </ReanimatedAnimated.View>
  );
}

/** A full grid of skeleton cards, matching the real grid's column count. */
export function ProductGridSkeleton({
  columns,
  count = 6,
}: {
  columns: number;
  count?: number;
}) {
  // ONE shared driver for the whole grid — every card's every bone reads
  // this same value, so mounting any number of cards still only ever
  // starts a single looping animation. `withRepeat(..., -1, false)` loops
  // the sweep continuously (0 -> 1, restart) for as long as this
  // component stays mounted; Reanimated tears it down automatically on
  // unmount (when `products.isLoading` flips false and this whole tree is
  // replaced by the real grid — see CategoriesScreen), nothing to clean
  // up by hand.
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: SHIMMER_DURATION, easing: ReanimatedEasing.linear }),
      -1,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = Math.ceil(count / columns);

  return (
    <View style={{ padding: spacing.xs }}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {Array.from({ length: columns }, (_, colIndex) => {
            const index = rowIndex * columns + colIndex;
            return (
              <View key={colIndex} style={styles.cell}>
                <ProductCardSkeleton progress={progress} index={index} />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
  },
  cell: {
    flex: 1,
    padding: spacing.xs,
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
    padding: spacing.sm,
    overflow: "hidden",
    ...shadow.sm,
  },
  imageBox: {
    width: "100%",
    height: 92,
  },
  // Mirrors ProductCard's `floatingActionWrap` — same straddle-the-corner
  // position (`right`/`bottom` offsets) as the real Add button, so this
  // bone sits exactly where that control will actually appear.
  floatingActionWrap: {
    position: "absolute",
    right: spacing.xs,
    bottom: -16,
  },
  // Mirrors ProductCard's `floatingAddButton` size/radius exactly (its
  // compact, pre-any-quantity state — every card starts here).
  floatingAddButton: {
    width: 34,
    height: 34,
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
  // Clearly visible neutral base — NOT a dark/flat grey block, NOT the
  // near-white `colors.skeleton` this used to be (see `SKELETON_BASE`'s own
  // comment). `overflow: hidden` + `position: relative` is what lets
  // `ShimmerSweep` clip to exactly this bone's own rounded bounds.
  bone: {
    borderRadius: radius.sm,
    backgroundColor: SKELETON_BASE,
    overflow: "hidden",
    position: "relative",
  },
  shimmerBand: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: SHIMMER_BAND_WIDTH,
    flexDirection: "row",
  },
  // Tapers in from fully transparent — `shimmerCore` (below) is the
  // genuinely bright part; these two just soften its leading/trailing
  // edge so the sweep reads as a smooth highlight, not a hard-edged bar.
  shimmerEdge: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  // Fully opaque white at its peak — against `SKELETON_BASE`, this is what
  // actually makes the sweep clearly visible in motion, the way it never
  // was as a 0.45-alpha tint over an already near-white base.
  shimmerCore: {
    flex: 1.4,
    backgroundColor: SKELETON_HIGHLIGHT,
    opacity: 0.85,
  },
});

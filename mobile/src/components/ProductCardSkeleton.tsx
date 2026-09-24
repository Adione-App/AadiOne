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
 * Every bone pulses opacity in a loop (a plain `Animated` loop, no gradient
 * library needed) — `ProductGridSkeleton` creates ONE shared pulse and hands
 * it to every card so the whole grid breathes in sync, rather than each
 * card animating independently and looking noisy.
 */

import { useEffect, useRef } from "react";
import { Animated, View, StyleSheet } from "react-native";
import { colors, radius, shadow, spacing } from "@shared/theme";

function useSkeletonPulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.55,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return pulse;
}

function Bone({ style, pulse }: { style?: object; pulse: Animated.Value }) {
  return <Animated.View style={[styles.bone, style, { opacity: pulse }]} />;
}

export function ProductCardSkeleton({ pulse: sharedPulse }: { pulse?: Animated.Value } = {}) {
  const ownPulse = useSkeletonPulse();
  const pulse = sharedPulse ?? ownPulse;

  return (
    <View style={styles.card}>
      {/* `mediaWrap`/`media`/`imageBox` + the floating add-button bone below
          mirror ProductCard.tsx's own structure and exact pixel sizes
          (media padding, 92px image box, the 34x34 button straddling the
          image's bottom-right corner) piece for piece — this used to be a
          full-width button below a name-then-price stack, which was
          ProductCard's OLD layout; it had drifted out of sync with the
          current floating-button/price-before-name design, which is what
          actually made the loading state look "off" against the real
          cards that replace it. */}
      <View style={styles.mediaWrap}>
        <View style={styles.media}>
          <Animated.View style={[styles.imageBox, { opacity: pulse }]} />
        </View>

        <View style={styles.floatingActionWrap}>
          <Animated.View style={[styles.floatingAddButton, { opacity: pulse }]} />
        </View>
      </View>

      <View style={styles.priceRow}>
        <Bone pulse={pulse} style={{ width: 50, height: 14 }} />
      </View>

      {/* Matches ProductCard's own reserved discount-row height, so a
          real card replacing this doesn't shift the grid by that amount. */}
      <View style={styles.discountContainer} />

      <View style={styles.nameContainer}>
        <Bone pulse={pulse} style={{ width: "90%", height: 12 }} />
        <Bone pulse={pulse} style={{ width: "60%", height: 12, marginTop: 4 }} />
      </View>

      <View style={styles.variantContainer}>
        <Bone pulse={pulse} style={{ width: "40%", height: 10 }} />
      </View>
    </View>
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
  const pulse = useSkeletonPulse();
  const rows = Math.ceil(count / columns);

  return (
    <View style={{ padding: spacing.xs }}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {Array.from({ length: columns }, (_, colIndex) => (
            <View key={colIndex} style={styles.cell}>
              <ProductCardSkeleton pulse={pulse} />
            </View>
          ))}
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
    backgroundColor: colors.skeleton,
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
    borderRadius: radius.sm,
    backgroundColor: colors.skeleton,
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
  bone: {
    borderRadius: radius.sm,
    backgroundColor: colors.skeleton,
  },
});

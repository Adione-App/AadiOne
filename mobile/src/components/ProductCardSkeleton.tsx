/**
 * Placeholder for a `ProductCard` that hasn't loaded yet.
 *
 * Mirrors ProductCard's exact box sizes (image/name/variant/price/button)
 * so the grid doesn't jump when real cards replace these. Used only for a
 * category/list that has never been fetched — a category already in the
 * query cache renders its real cards immediately instead (see
 * CategoriesScreen / RailProductsScreen).
 *
 * Every bone pulses opacity in a loop (a plain `Animated` loop, no gradient
 * library needed) — `ProductGridSkeleton` creates ONE shared pulse and hands
 * it to every card so the whole grid breathes in sync, rather than each
 * card animating independently and looking noisy.
 */

import { useEffect, useRef } from "react";
import { Animated, View, StyleSheet } from "react-native";
import { colors, radius, spacing } from "@shared/theme";

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
      <View style={styles.media}>
        <Animated.View style={[styles.imageBox, { opacity: pulse }]} />
      </View>

      <View style={styles.nameContainer}>
        <Bone pulse={pulse} style={{ width: "90%", height: 12 }} />
        <Bone pulse={pulse} style={{ width: "60%", height: 12, marginTop: 4 }} />
      </View>

      <View style={styles.variantContainer}>
        <Bone pulse={pulse} style={{ width: "40%", height: 10 }} />
      </View>

      <View style={styles.priceRow}>
        <Bone pulse={pulse} style={{ width: 50, height: 14 }} />
      </View>

      {/* Matches ProductCard's own reserved discount-row height, so a
          real card replacing this doesn't shift the grid by that amount. */}
      <View style={styles.discountContainer} />

      <Animated.View style={[styles.button, { opacity: pulse }]} />
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
  // Mirrors ProductCard's `media` — the border lives on the image area
  // only, not the whole card (see ProductCard.tsx for why).
  media: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    overflow: "hidden",
  },
  imageBox: {
    width: "100%",
    height: 92,
    borderRadius: radius.md,
    backgroundColor: colors.skeleton,
  },
  nameContainer: {
    height: 34,
    marginTop: spacing.xs,
    justifyContent: "flex-start",
  },
  variantContainer: {
    height: 16,
    marginTop: 2,
    justifyContent: "center",
  },
  priceRow: {
    height: 22,
    marginTop: 2,
    justifyContent: "center",
  },
  discountContainer: {
    height: 18,
    marginTop: 4,
  },
  button: {
    width: "100%",
    height: 36,
    marginTop: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.skeleton,
  },
  bone: {
    borderRadius: radius.sm,
    backgroundColor: colors.skeleton,
  },
});

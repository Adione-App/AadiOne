/**
 * Placeholder for a `ProductCard` that hasn't loaded yet.
 *
 * Mirrors ProductCard's exact box sizes (image/name/variant/price/button)
 * so the grid doesn't jump when real cards replace these. Used only for a
 * category/list that has never been fetched — a category already in the
 * query cache renders its real cards immediately instead (see
 * CategoriesScreen / RailProductsScreen).
 */

import { View, StyleSheet } from "react-native";
import { colors, radius, spacing } from "@shared/theme";

function Bone({ style }: { style?: object }) {
  return <View style={[styles.bone, style]} />;
}

export function ProductCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.imageBox} />

      <View style={styles.nameContainer}>
        <Bone style={{ width: "90%", height: 12 }} />
        <Bone style={{ width: "60%", height: 12, marginTop: 4 }} />
      </View>

      <View style={styles.variantContainer}>
        <Bone style={{ width: "40%", height: 10 }} />
      </View>

      <View style={styles.priceRow}>
        <Bone style={{ width: 50, height: 14 }} />
      </View>

      <View style={styles.button} />
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
  const rows = Math.ceil(count / columns);

  return (
    <View style={{ padding: spacing.xs }}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {Array.from({ length: columns }, (_, colIndex) => (
            <View key={colIndex} style={styles.cell}>
              <ProductCardSkeleton />
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
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    overflow: "hidden",
  },
  imageBox: {
    width: "100%",
    height: 96,
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

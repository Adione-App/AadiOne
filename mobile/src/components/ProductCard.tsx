import { Image, Pressable, StyleSheet, View } from "react-native";

import type { ProductSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";

import { resolveImageUrl } from "../lib/api";
import { AppText } from "./ui";

/* =====================================================================
   QUANTITY STEPPER
===================================================================== */

export function QuantityStepper({
  qty,
  max,
  onIncrement,
  onDecrement,
  busy,
}: {
  qty: number;
  max: number;
  onIncrement: () => void;
  onDecrement: () => void;
  busy?: boolean;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={onDecrement}
        disabled={busy}
        hitSlop={8}
        style={styles.stepperButton}
        accessibilityLabel="Decrease quantity"
      >
        <AppText
          variant="h3"
          color={colors.primary}
          style={styles.stepperSymbol}
        >
          −
        </AppText>
      </Pressable>

      <AppText variant="bodyStrong" style={styles.quantityText}>
        {qty}
      </AppText>

      <Pressable
        onPress={onIncrement}
        disabled={busy || qty >= max}
        hitSlop={8}
        style={styles.stepperButton}
        accessibilityLabel="Increase quantity"
      >
        <AppText
          variant="h3"
          color={qty >= max ? colors.disabledText : colors.primary}
          style={styles.stepperSymbol}
        >
          +
        </AppText>
      </Pressable>
    </View>
  );
}

/* =====================================================================
   PRODUCT CARD
===================================================================== */

export function ProductCard({
  product,
  qtyInCart,
  onPress,
  onAdd,
  onIncrement,
  onDecrement,
  busy,
}: {
  product: ProductSummaryDto;
  qtyInCart: number;
  onPress: () => void;
  onAdd: () => void;
  onIncrement: () => void;
  onDecrement: () => void;
  busy?: boolean;
}) {
  const variant = product.defaultVariant;

  const outOfStock = !variant?.inStock;

  const imageUrl = resolveImageUrl(product.thumbUrl);

  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Open ${product.name}`}
    >
      {/* =============================================================
          IMAGE
      ============================================================= */}

      <View style={styles.imageBox}>
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={styles.image}
            resizeMode="contain"
          />
        ) : (
          <View style={styles.imagePlaceholder} />
        )}

        {variant && variant.discountPercent > 0 && (
          <View style={styles.discountBadge}>
            <AppText
              variant="overline"
              color={colors.discountBadgeText}
              style={styles.discountText}
            >
              {variant.discountPercent}% OFF
            </AppText>
          </View>
        )}
      </View>

      {/* =============================================================
          PRODUCT NAME

          Fixed height keeps all cards aligned.
      ============================================================= */}

      <View style={styles.nameContainer}>
        <AppText variant="body" numberOfLines={2} style={styles.productName}>
          {product.name}
        </AppText>
      </View>

      {/* =============================================================
          VARIANT / WEIGHT

          Always reserves the same space.
      ============================================================= */}

      <View style={styles.variantContainer}>
        {variant && (
          <AppText
            variant="caption"
            color={colors.textSecondary}
            numberOfLines={1}
            style={styles.variantName}
          >
            {variant.variantName}
          </AppText>
        )}
      </View>

      {/* =============================================================
          BOTTOM
      ============================================================= */}

      <View style={styles.bottomSection}>
        {/* PRICE */}

        <View style={styles.priceContainer}>
          {variant && (
            <>
              <AppText variant="price" numberOfLines={1} style={styles.price}>
                {formatPaise(variant.pricePaise)}
              </AppText>

              {variant.mrpPaise > variant.pricePaise && (
                <AppText
                  variant="caption"
                  color={colors.textMuted}
                  numberOfLines={1}
                  style={styles.mrp}
                >
                  {formatPaise(variant.mrpPaise)}
                </AppText>
              )}
            </>
          )}
        </View>

        {/* ACTION */}

        <View style={styles.actionContainer}>
          {outOfStock ? (
            <View style={styles.outOfStockTag}>
              <AppText
                variant="caption"
                color={colors.textSecondary}
                numberOfLines={1}
                style={styles.outOfStockText}
              >
                Out of stock
              </AppText>
            </View>
          ) : qtyInCart > 0 ? (
            <QuantityStepper
              qty={qtyInCart}
              max={variant?.maxQtyPerOrder ?? 10}
              onIncrement={onIncrement}
              onDecrement={onDecrement}
              busy={busy}
            />
          ) : (
            <Pressable
              onPress={onAdd}
              disabled={busy}
              style={[styles.addButton, busy && styles.addButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel={`Add ${product.name} to cart`}
            >
              <AppText
                variant="bodyStrong"
                color={colors.primary}
                style={styles.addText}
              >
                Add
              </AppText>

              <AppText
                variant="bodyStrong"
                color={colors.primary}
                style={styles.addPlus}
              >
                +
              </AppText>
            </Pressable>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/* =====================================================================
   STYLES
===================================================================== */

const styles = StyleSheet.create({
  /* ================================================================
     CARD

     IMPORTANT:
     No margin here.

     The parent controls spacing. This allows the same card to work
     correctly in:
       - Home horizontal rails
       - Category 2-column grid
  ================================================================ */

  card: {
    flex: 1,

    width: "100%",

    height: 190,

    backgroundColor: colors.surface,

    borderRadius: radius.lg,

    borderWidth: 1,

    borderColor: colors.border,

    padding: spacing.xs,

    overflow: "hidden",
  },

  /* ================================================================
     IMAGE
  ================================================================ */

  imageBox: {
    width: "100%",

    height: 70,

    alignItems: "center",

    justifyContent: "center",

    position: "relative",
  },

  image: {
    width: "100%",

    height: "100%",
  },

  imagePlaceholder: {
    width: "100%",

    height: "100%",

    backgroundColor: colors.skeleton,

    borderRadius: radius.md,
  },

  /* ================================================================
     DISCOUNT
  ================================================================ */

  discountBadge: {
    position: "absolute",

    top: 0,

    left: 0,

    backgroundColor: colors.discountBadge,

    paddingHorizontal: 8,

    paddingVertical: 3,

    borderRadius: radius.sm,

    zIndex: 2,
  },

  discountText: {
    fontSize: 9,

    lineHeight: 12,

    fontWeight: "700",
  },

  /* ================================================================
     PRODUCT NAME
  ================================================================ */

  nameContainer: {
    height: 32,

    marginTop: 4,

    justifyContent: "flex-start",
  },

  productName: {
    fontSize: 12,

    lineHeight: 17,

    color: colors.textPrimary,

    fontWeight: "500",
  },

  /* ================================================================
     VARIANT
  ================================================================ */

  variantContainer: {
    height: 16,

    marginTop: 2,

    justifyContent: "center",
  },

  variantName: {
    fontSize: 10,

    lineHeight: 14,

    color: colors.textSecondary,
  },

  /* ================================================================
     BOTTOM
  ================================================================ */

  bottomSection: {
    height: 32,

    marginTop: "auto",

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    gap: 6,
  },

  /* ================================================================
     PRICE
  ================================================================ */

  priceContainer: {
    flex: 1,

    minWidth: 0,

    height: 32,

    justifyContent: "center",
  },

  price: {
    fontSize: 14,

    lineHeight: 18,

    fontWeight: "800",

    color: colors.textPrimary,
  },

  mrp: {
    fontSize: 9,

    lineHeight: 12,

    textDecorationLine: "line-through",

    marginTop: 0,
  },

  /* ================================================================
     ACTION
  ================================================================ */

  actionContainer: {
    width: 62,

    height: 30,

    alignItems: "flex-end",

    justifyContent: "center",
  },

  /* ================================================================
     ADD
  ================================================================ */

  addButton: {
    width: 62,

    height: 30,

    borderRadius: radius.pill,

    borderWidth: 1,

    borderColor: colors.primary,

    backgroundColor: colors.surface,

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    gap: 3,
  },

  addButtonDisabled: {
    opacity: 0.5,
  },

  addText: {
    fontSize: 12,

    lineHeight: 16,

    fontWeight: "700",
  },

  addPlus: {
    fontSize: 15,

    lineHeight: 17,

    fontWeight: "700",
  },

  /* ================================================================
     OUT OF STOCK
  ================================================================ */

  outOfStockTag: {
    width: 62,

    height: 30,

    paddingHorizontal: 4,

    borderRadius: radius.sm,

    backgroundColor: colors.surfaceSunken,

    alignItems: "center",

    justifyContent: "center",
  },

  outOfStockText: {
    fontSize: 9,

    lineHeight: 12,

    textAlign: "center",
  },

  /* ================================================================
     QUANTITY STEPPER
  ================================================================ */

  stepper: {
    width: 62,

    height: 30,

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    paddingHorizontal: 2,

    borderRadius: radius.pill,

    borderWidth: 1,

    borderColor: colors.primary,

    backgroundColor: colors.surface,
  },

  stepperButton: {
    width: 20,

    height: 26,

    alignItems: "center",

    justifyContent: "center",
  },

  stepperSymbol: {
    fontSize: 18,

    lineHeight: 21,

    fontWeight: "600",
  },

  quantityText: {
    fontSize: 12,

    lineHeight: 16,

    fontWeight: "700",

    minWidth: 16,

    textAlign: "center",
  },
});

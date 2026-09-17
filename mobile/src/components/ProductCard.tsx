import { memo } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { ShoppingCart } from "lucide-react-native";

import type { ProductSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, shadow, spacing } from "@shared/theme";

import { resolveImageUrl } from "../lib/api";
import { AppText } from "./ui";

/* =====================================================================
   QUANTITY STEPPER

   `fullWidth` is the pill used in the card's own action bar and the
   product-detail footer — big, easy to tap, spans the space a lone "Add"
   button would have used. The compact (default) size is for tight rows,
   like the cart screen's line item next to its delete icon.
===================================================================== */

export function QuantityStepper({
  qty,
  max,
  onIncrement,
  onDecrement,
  fullWidth,
}: {
  qty: number;
  max: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** @deprecated no longer disables the buttons — cart sync is race-safe
   * per-tap now, so there's nothing an in-flight request needs protecting
   * from. Kept so existing call sites don't need to change. */
  busy?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <View style={[styles.stepper, fullWidth && styles.stepperFullWidth]}>
      <Pressable
        onPress={onDecrement}
        hitSlop={8}
        style={[
          styles.stepperButton,
          fullWidth && styles.stepperButtonFullWidth,
        ]}
        accessibilityLabel="Decrease quantity"
      >
        <AppText
          variant="h3"
          color={colors.onPrimary}
          style={styles.stepperSymbol}
        >
          −
        </AppText>
      </Pressable>

      <AppText
        variant="bodyStrong"
        color={colors.onPrimary}
        style={[styles.quantityText, fullWidth && styles.quantityTextFullWidth]}
      >
        {qty}
      </AppText>

      <Pressable
        onPress={onIncrement}
        disabled={qty >= max}
        hitSlop={8}
        style={[
          styles.stepperButton,
          fullWidth && styles.stepperButtonFullWidth,
        ]}
        accessibilityLabel="Increase quantity"
      >
        <AppText
          variant="h3"
          // The stepper's pill is solid green — `disabledText` (grey) reads
          // as invisible on it, unlike on the white surfaces it's tuned for.
          color={qty >= max ? "rgba(255,255,255,0.45)" : colors.onPrimary}
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

function ProductCardImpl({
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
    // Plain View, not Pressable: navigation belongs to the image alone (see
    // below), never to the card as a whole. A Pressable here previously
    // wrapped everything, including the Add/stepper buttons — and a DISABLED
    // nested Pressable (mid-request) doesn't claim the touch, so the tap fell
    // through to this outer Pressable's onPress and opened Product Details
    // instead of doing nothing. Removing the outer handler entirely closes
    // that hole rather than working around it.
    <View style={styles.card}>
      {/* =============================================================
          IMAGE — the ONLY part of the card that opens Product Details.
      ============================================================= */}

      <Pressable
        onPress={onPress}
        style={styles.imageBox}
        accessibilityRole="button"
        accessibilityLabel={`Open ${product.name}`}
      >
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={[styles.image, outOfStock && styles.imageFaded]}
            resizeMode="contain"
          />
        ) : (
          <View style={styles.imagePlaceholder} />
        )}

        {outOfStock ? (
          <View style={styles.outOfStockBadge}>
            <AppText
              variant="overline"
              color={colors.textSecondary}
              style={styles.badgeText}
            >
              Out of Stock
            </AppText>
          </View>
        ) : (
          variant &&
          variant.discountPercent > 0 && (
            <View style={styles.discountBadge}>
              <AppText
                variant="overline"
                color={colors.discountBadgeText}
                style={styles.badgeText}
              >
                {variant.discountPercent}% OFF
              </AppText>
            </View>
          )
        )}
      </Pressable>

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
          PRICE
      ============================================================= */}

      <View style={styles.priceRow}>
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

      {/* =============================================================
          ACTION BAR — full width, matches the reference design.
      ============================================================= */}

      {outOfStock ? (
        <View style={styles.outOfStockBar}>
          <AppText
            variant="bodyStrong"
            color={colors.textSecondary}
            style={styles.outOfStockBarText}
          >
            Out of Stock
          </AppText>
        </View>
      ) : qtyInCart > 0 ? (
        <QuantityStepper
          qty={qtyInCart}
          max={variant?.maxQtyPerOrder ?? 10}
          onIncrement={onIncrement}
          onDecrement={onDecrement}
          busy={busy}
          fullWidth
        />
      ) : (
        <Pressable
          onPress={onAdd}
          style={styles.addButton}
          accessibilityRole="button"
          accessibilityLabel={`Add ${product.name} to cart`}
        >
          <ShoppingCart size={14} color={colors.onPrimary} strokeWidth={2.3} />
          <AppText
            variant="bodyStrong"
            color={colors.onPrimary}
            style={styles.addText}
          >
            Add
          </AppText>
        </Pressable>
      )}
    </View>
  );
}

// Memoized so a re-render triggered by one product's qty change (via
// useCartActions' forceRender) doesn't re-render every other visible card —
// only useful once a screen's own onAdd/onIncrement/onDecrement callbacks are
// stable across renders too; harmless either way.
export const ProductCard = memo(ProductCardImpl);

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

    backgroundColor: colors.surface,

    borderRadius: radius.lg,

    borderWidth: 1,

    borderColor: colors.border,

    padding: spacing.sm,

    overflow: "hidden",

    ...shadow.sm,
  },

  /* ================================================================
     IMAGE
  ================================================================ */

  imageBox: {
    width: "100%",

    height: 96,

    alignItems: "center",

    justifyContent: "center",

    position: "relative",
  },

  image: {
    width: "100%",

    height: "100%",
  },

  imageFaded: {
    opacity: 0.4,
  },

  imagePlaceholder: {
    width: "100%",

    height: "100%",

    backgroundColor: colors.skeleton,

    borderRadius: radius.md,
  },

  /* ================================================================
     BADGES (discount / out of stock)
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

  outOfStockBadge: {
    position: "absolute",

    top: 0,

    left: 0,

    backgroundColor: colors.surfaceSunken,

    paddingHorizontal: 8,

    paddingVertical: 3,

    borderRadius: radius.sm,

    zIndex: 2,
  },

  badgeText: {
    fontSize: 9,

    lineHeight: 12,

    fontWeight: "700",
  },

  /* ================================================================
     PRODUCT NAME
  ================================================================ */

  nameContainer: {
    height: 34,

    marginTop: spacing.xs,

    justifyContent: "flex-start",
  },

  productName: {
    fontSize: 13,

    lineHeight: 17,

    color: colors.textPrimary,

    fontWeight: "600",
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
    fontSize: 11,

    lineHeight: 14,

    color: colors.textSecondary,
  },

  /* ================================================================
     PRICE
  ================================================================ */

  priceRow: {
    flexDirection: "row",

    alignItems: "baseline",

    gap: 6,

    height: 22,

    marginTop: 2,
  },

  price: {
    fontSize: 15,

    lineHeight: 19,

    fontWeight: "800",

    color: colors.textPrimary,
  },

  mrp: {
    fontSize: 11,

    lineHeight: 14,

    textDecorationLine: "line-through",
  },

  /* ================================================================
     ADD BUTTON — full width, matches the reference design.
  ================================================================ */

  addButton: {
    width: "100%",

    height: 36,

    marginTop: spacing.sm,

    borderRadius: radius.pill,

    backgroundColor: colors.primary,

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    gap: 6,
  },

  addText: {
    fontSize: 13,

    lineHeight: 17,

    fontWeight: "700",
  },

  /* ================================================================
     OUT OF STOCK BAR
  ================================================================ */

  outOfStockBar: {
    width: "100%",

    height: 36,

    marginTop: spacing.sm,

    borderRadius: radius.pill,

    backgroundColor: colors.surfaceSunken,

    alignItems: "center",

    justifyContent: "center",
  },

  outOfStockBarText: {
    fontSize: 12,

    lineHeight: 16,
  },

  /* ================================================================
     QUANTITY STEPPER

     Default size: compact pill for tight rows (the cart screen's line
     item). `fullWidth` styles below are merged on top for the card's own
     action bar and the product-detail footer.
  ================================================================ */

  stepper: {
    width: 62,

    height: 30,

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    paddingHorizontal: 2,

    borderRadius: radius.pill,

    backgroundColor: colors.primary,
  },

  stepperFullWidth: {
    width: "100%",

    height: 36,

    marginTop: spacing.sm,

    paddingHorizontal: 4,
  },

  stepperButton: {
    width: 20,

    height: 26,

    alignItems: "center",

    justifyContent: "center",
  },

  stepperButtonFullWidth: {
    width: 32,

    height: 32,

    borderRadius: radius.circle,

    backgroundColor: "rgba(255,255,255,0.18)",
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

  quantityTextFullWidth: {
    fontSize: 14,

    lineHeight: 18,
  },
});

import { memo, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { Image } from "expo-image";
import { Info, ShoppingCart } from "lucide-react-native";

import type { ProductSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, shadow, spacing } from "@shared/theme";

import { resolveImageUrl } from "../lib/api";
import {
  type CartItemSnapshot,
  snapshotFromProduct,
} from "../lib/useCartActions";
import { flyToCart } from "../lib/flyToCart";
import { AppText } from "./ui";

/* =====================================================================
   ANIMATED QUANTITY — odometer-style digit roll.

   Incrementing: the new number pops up from below into place while the
   old one slides up and out above. Decrementing: the reverse — the new
   number drops in from above while the old one slides down and out
   below. Both numbers are real siblings clipped by one fixed-height
   `overflow: hidden` box, driven by a single Animated.Value so they move
   in lockstep — cheap (a transform + opacity, native driver) and used by
   every QuantityStepper in the app (Home, Category, Cart, product
   detail), so it only needed writing once here.
===================================================================== */

const QTY_ANIM_DURATION = 180;

function AnimatedQuantity({
  qty,
  textStyle,
  color,
  lineHeight,
}: {
  qty: number;
  textStyle: StyleProp<TextStyle>;
  color: string;
  lineHeight: number;
}) {
  const [displayQty, setDisplayQty] = useState(qty);
  const [outgoingQty, setOutgoingQty] = useState<number | null>(null);
  const directionRef = useRef<1 | -1>(1);
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (qty === displayQty) return;

    directionRef.current = qty > displayQty ? 1 : -1;
    setOutgoingQty(displayQty);
    setDisplayQty(qty);
    anim.setValue(0);

    Animated.timing(anim, {
      toValue: 1,
      duration: QTY_ANIM_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setOutgoingQty(null));
    // `displayQty` deliberately excluded — this must fire once per `qty`
    // change, not re-run when the effect's own setState updates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty]);

  const sign = directionRef.current;

  // Incoming number: slides in from below (increment) or above (decrement)
  // and overshoots slightly past its resting scale — the "pop".
  const incomingTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [sign * lineHeight, 0],
  });
  const incomingScale = anim.interpolate({
    inputRange: [0, 0.6, 1],
    outputRange: [0.6, 1.08, 1],
  });
  const incomingOpacity = anim.interpolate({
    inputRange: [0, 0.3, 1],
    outputRange: [0, 1, 1],
  });

  // Outgoing number: slides out the opposite way and fades.
  const outgoingTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -sign * lineHeight],
  });
  const outgoingOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });

  return (
    <View style={[styles.qtyClip, { height: lineHeight }]}>
      {outgoingQty !== null && (
        <Animated.Text
          style={[
            textStyle,
            {
              color,
              position: "absolute",
              opacity: outgoingOpacity,
              transform: [{ translateY: outgoingTranslateY }],
            },
          ]}
        >
          {outgoingQty}
        </Animated.Text>
      )}

      <Animated.Text
        style={[
          textStyle,
          {
            color,
            opacity: incomingOpacity,
            transform: [
              { translateY: incomingTranslateY },
              { scale: incomingScale },
            ],
          },
        ]}
      >
        {displayQty}
      </Animated.Text>
    </View>
  );
}

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

      <AnimatedQuantity
        qty={qty}
        color={colors.onPrimary}
        lineHeight={fullWidth ? 18 : 16}
        textStyle={[
          styles.quantityText,
          fullWidth && styles.quantityTextFullWidth,
        ]}
      />

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
  /** Called with the PRODUCT id — from the image, or the More Details icon. */
  onPress: (productId: string) => void;
  /** Called with the VARIANT id and enough product data to show the new
   * line in the cart badge/Cart screen before the server confirms it — same
   * stable function for every card, so changing one product's quantity
   * doesn't recreate props for the rest. */
  onAdd: (variantId: string, snapshot: CartItemSnapshot) => void;
  onIncrement: (variantId: string) => void;
  onDecrement: (variantId: string) => void;
  busy?: boolean;
}) {
  const variant = product.defaultVariant;

  const outOfStock = !variant?.inStock;

  const imageUrl = resolveImageUrl(product.thumbUrl);

  const openDetails = () => onPress(product.id);

  const imageWrapRef = useRef<View>(null);

  // Fires the flying-image animation from this card's own product image to
  // the cart tab icon — purely decorative (see flyToCart.tsx); the real
  // Add/+ handler below always still runs regardless of whether the
  // measurement succeeds.
  const triggerFly = () => {
    imageWrapRef.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) flyToCart({ x, y, width, height }, imageUrl);
    });
  };

  return (
    // Plain View, not Pressable: navigation belongs to the image and the
    // More Details icon alone (see below), never to the card as a whole. A
    // Pressable here previously wrapped everything, including the
    // Add/stepper buttons — and a DISABLED nested Pressable (mid-request)
    // doesn't claim the touch, so the tap fell through to this outer
    // Pressable's onPress and opened Product Details instead of doing
    // nothing. Removing the outer handler entirely closes that hole rather
    // than working around it.
    <View style={styles.card}>
      {/* =============================================================
          IMAGE + MORE DETAILS — the only two things that open Product
          Details. Siblings, not nested: the icon is its own independent
          Pressable layered on top of the image's corner, not a Pressable
          inside a Pressable, so neither can ever intercept the other's
          touch or accidentally disable itself against the image beneath.
      ============================================================= */}

      <View style={styles.imageWrap} ref={imageWrapRef} collapsable={false}>
        <Pressable
          onPress={openDetails}
          style={styles.imageBox}
          accessibilityRole="button"
          accessibilityLabel={`Open ${product.name}`}
        >
          {imageUrl ? (
            <Image
              source={{ uri: imageUrl }}
              style={[styles.image, outOfStock && styles.imageFaded]}
              contentFit="contain"
              transition={150}
              cachePolicy="memory-disk"
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

        <Pressable
          onPress={openDetails}
          style={styles.detailsButton}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`View details for ${product.name}`}
        >
          <Info size={13} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
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

          Wrapped in ActionBarTransition so switching between "Add",
          the stepper, and "Out of Stock" is a quick fade/scale instead
          of an abrupt swap — covers both directions: the stepper
          appearing after a tap on Add, and Add reappearing when a
          decrement empties the line.
      ============================================================= */}

      <ActionBarTransition
        mode={outOfStock ? "outOfStock" : qtyInCart > 0 ? "stepper" : "add"}
      >
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
            onIncrement={() => {
              if (!variant) return;
              triggerFly();
              onIncrement(variant.id);
            }}
            onDecrement={() => variant && onDecrement(variant.id)}
            busy={busy}
            fullWidth
          />
        ) : (
          <Pressable
            onPress={() => {
              if (!variant) return;
              triggerFly();
              onAdd(variant.id, snapshotFromProduct(product, variant));
            }}
            style={styles.addButton}
            accessibilityRole="button"
            accessibilityLabel={`Add ${product.name} to cart`}
          >
            <ShoppingCart
              size={14}
              color={colors.onPrimary}
              strokeWidth={2.3}
            />
            <AppText
              variant="bodyStrong"
              color={colors.onPrimary}
              style={styles.addText}
            >
              Add
            </AppText>
          </Pressable>
        )}
      </ActionBarTransition>
    </View>
  );
}

/* =====================================================================
   ACTION BAR TRANSITION — fade + scale between Add / stepper / out-of-
   stock. Fast (200ms) so it reads as a snap, not a wait; the quantity
   number itself is already instant (AnimatedQuantity) regardless of this.
===================================================================== */

export type ActionBarMode = "add" | "stepper" | "outOfStock";

export function ActionBarTransition({
  mode,
  children,
}: {
  mode: ActionBarMode;
  children: React.ReactNode;
}) {
  // Deliberately no caller-supplied `style` prop here: this Animated.View's
  // opacity/scale is native-driven (useNativeDriver: true). Merging in an
  // outside style animated by a DIFFERENT, JS-driven value (e.g. a `flex`
  // resize — flex isn't supported by the native driver at all) onto this
  // same node makes RN try to build one native config covering both and
  // throws ("Style property 'flex' is not supported by native animated
  // module"). A caller that needs to size this needs a wrapping Animated.View
  // of its OWN around <ActionBarTransition>, not a style passed through it —
  // see ProductDetailScreen's footer for that pattern.
  const anim = useRef(new Animated.Value(1)).current;
  const prevMode = useRef(mode);

  useEffect(() => {
    if (mode === prevMode.current) return;
    prevMode.current = mode;

    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [mode, anim]);

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [
          {
            scale: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [0.88, 1],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
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

  imageWrap: {
    position: "relative",
  },

  imageBox: {
    width: "100%",

    height: 70,

    alignItems: "center",

    justifyContent: "center",

    position: "relative",
  },

  /* ================================================================
     MORE DETAILS — its own Pressable, layered over the image's corner,
     not nested inside the image's Pressable (see file header).
  ================================================================ */

  detailsButton: {
    position: "absolute",

    top: 4,

    right: 4,

    width: 22,

    height: 22,

    borderRadius: radius.circle,

    backgroundColor: "rgba(255,255,255,0.85)",

    alignItems: "center",

    justifyContent: "center",

    zIndex: 3,
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
    fontSize: 8,

    lineHeight: 12,

    fontWeight: "700",
  },

  /* ================================================================
     PRODUCT NAME
  ================================================================ */

  nameContainer: {
    height: 35,

    marginTop: spacing.xs,

    justifyContent: "flex-start",
  },

  productName: {
    fontSize: 12,

    lineHeight: 15,

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

  qtyClip: {
    minWidth: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});

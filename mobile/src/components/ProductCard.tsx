import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { Heart, Plus } from "lucide-react-native";

import type { ProductSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, shadow, spacing } from "@shared/theme";

import { resolveImageUrl } from "../lib/api";
import {
  type CartItemSnapshot,
  snapshotFromProduct,
} from "../lib/useCartActions";
import { flyToCart } from "../lib/flyToCart";
import { useWishlist } from "../lib/useWishlist";
import { useVariantSheet } from "../lib/variantSheet";
import { quantityLimitOf } from "../lib/quantityLimit";
import { AppText } from "./ui";



/** Short and snappy: the new number reads immediately; the roll is a cue, not a wait. */
const QTY_ANIM_DURATION = 120;

function AnimatedQuantity({
  qty,
  textStyle,
  color,
  lineHeight,
  clipWidth,
}: {
  qty: number;
  textStyle: StyleProp<TextStyle>;
  color: string;
  lineHeight: number;
  
  clipWidth: number;
}) {
  // What is on screen: the number rolling in, and (mid-roll) the one rolling out.
  const [roll, setRoll] = useState<{ shown: number; outgoing: number | null; direction: 1 | -1 }>({
    shown: qty,
    outgoing: null,
    direction: 1,
  });
  const anim = useRef(new Animated.Value(1)).current;

  // A new `qty` is taken in the SAME render it arrives in (React's "adjust
  // state while rendering"), not in an effect after paint — which used to
  // paint the OLD number at rest for a frame before every roll ("4 … then
  // 5"). A tap mid-roll rolls out the number that was rolling in.
  if (qty !== roll.shown) {
    setRoll({ shown: qty, outgoing: roll.shown, direction: qty > roll.shown ? 1 : -1 });
  }

  // Starts the roll before the frame is painted. An interrupted roll's
  // completion (`finished: false`) must not clear the newer roll's number.
  useLayoutEffect(() => {
    if (roll.outgoing === null) return;
    anim.setValue(0);
    const target = roll.shown;
    Animated.timing(anim, {
      toValue: 1,
      duration: QTY_ANIM_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setRoll((current) => (current.shown === target ? { ...current, outgoing: null } : current));
    });
  }, [roll.shown, roll.outgoing, anim]);

  const sign = roll.direction;
  const outgoingQty = roll.outgoing;
  const displayQty = roll.shown;

  // Incoming number: a short slide from half a line below (increment) or
  // above (decrement), readable from the first frame. It used to start
  // invisible at 60% scale and travel a full line over 180 ms, so the new
  // quantity only became legible well after the tap.
  const incomingTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [sign * lineHeight * 0.5, 0],
  });
  const incomingScale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.9, 1],
  });
  const incomingOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 1],
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
    <View style={[styles.qtyClip, { height: lineHeight, width: clipWidth }]}>
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


/**
 * The ONE quantity control ("−  1  +") — Home cards, category / search
 * grids, the product page, the variant sheet, Food menus and the Cart all
 * render this, so it looks and behaves the same everywhere: a solid green
 * rectangle (the Home card's original look), flat 32×32 tap targets, the
 * rolling quantity above. `fullWidth` only stretches it to its container
 * (product page footer, variant sheet); the default is the card's 85px.
 * The quantity always comes from the cart (`qty`), never local state.
 *
 * `max` only dims `+`: a tap at the limit still goes to `onIncrement`, whose
 * cart action refuses it with a popup saying why (useCartActions.ts) —
 * never a silently dead button.
 */
export function QuantityStepper({
  qty,
  max,
  onIncrement,
  onDecrement,
  fullWidth,
  style,
}: {
  qty: number;
  /** The variant's limit (lib/quantityLimit.ts) — for the dimmed `+` only. */
  max: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Accepted for callers' convenience; the cart actions themselves serialise changes per variant. */
  busy?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const atMax = qty >= max;
  return (
    <View
      style={[
        styles.stepper,
        fullWidth ? styles.stepperFullWidth : styles.stepperCompactWidth,
        style,
      ]}
    >
      <Pressable
        onPress={onDecrement}
        hitSlop={8}
        style={({ pressed }) => [styles.stepperButton, pressed && styles.stepperButtonPressed]}
        accessibilityRole="button"
        accessibilityLabel="Decrease quantity"
      >
        <AppText variant="h3" color={colors.onPrimary} style={styles.stepperSymbol}>
          −
        </AppText>
      </Pressable>

      <View style={styles.qtyCenterSlot}>
        <AnimatedQuantity
          qty={qty}
          color={colors.onPrimary}
          lineHeight={18}
          clipWidth={28}
          textStyle={[styles.quantityText, styles.quantityTextFullWidth]}
        />
      </View>

      <Pressable
        onPress={onIncrement}
        hitSlop={8}
        style={({ pressed }) => [styles.stepperButton, pressed && !atMax && styles.stepperButtonPressed]}
        accessibilityRole="button"
        accessibilityLabel="Increase quantity"
        accessibilityHint={atMax ? "Maximum quantity reached" : undefined}
      >
        <AppText
          variant="h3"
          // The control is solid green — `disabledText` (grey) reads as
          // invisible on it, unlike on the white surfaces it's tuned for.
          color={atMax ? "rgba(255,255,255,0.45)" : colors.onPrimary}
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

/** The floating overlay's compact ("+") size — the morph's starting point. */
const COMPACT_WIDTH = 34;

const STEPPER_EXPANDED_WIDTH = 85;

const BUTTON_OVERHANG = 16;
/** The reserved breathing room between the media box and the text below it
 * — on top of `BUTTON_OVERHANG`, not instead of it. */
const IMAGE_TEXT_GAP = spacing.sm;

/** Image box width : height — see `imageBox`. ProductCardSkeleton mirrors both. */
export const IMAGE_BOX_ASPECT = 4 / 5;
/** The image box's height on any card wide enough to reach it (≥120dp box). */
export const IMAGE_BOX_MAX_HEIGHT = 150;


const MORPH_ENTER_DURATION = 140;
const MORPH_EXIT_DURATION = 120;


function tapHaptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

function ProductCardImpl({
  product,
  qtyInCart,
  cartVariantId = null,
  onPress,
  onAdd,
  onIncrement,
  onDecrement,
  busy,
}: {
  product: ProductSummaryDto;
  qtyInCart: number;
  /**
   * Several sizes / options only: the ONE variant of this product in the
   * cart (`useCartActions().cartVariantForCard`). The card's − and + act on
   * it directly; null (none, or several in the cart) means the variant sheet.
   */
  cartVariantId?: string | null;
  /** Called with the PRODUCT id — from the image, or the More Details icon. */
  onPress: (productId: string) => void;
  
  /** The cart actions return false when the tap was refused (limit reached — they show why). */
  onAdd: (variantId: string, snapshot: CartItemSnapshot) => boolean | void;
  onIncrement: (variantId: string) => boolean | void;
  onDecrement: (variantId: string) => void;
  busy?: boolean;
}) {
  const variant = product.defaultVariant;

  const outOfStock = !variant?.inStock;

  const imageUrl = resolveImageUrl(product.thumbUrl);

 
  const imageBoxRef = useRef<View>(null);

  const openDetails = () => onPress(product.id);
  // Several sizes / options: the card never picks one — it opens the variant
  // sheet (components/VariantSheet.tsx), and its quantity is the product's
  // total across them (`useCartActions().qtyForCard`).
  const hasOptions = product.variantCount > 1;
  const openOptions = () => useVariantSheet.getState().open(product, openDetails);

  // Shared across every card/screen (see useWishlist.ts) — subscribed via
  // a selector keyed to THIS product's own id, so a toggle on one card only
  // re-renders that card, not every other visible one.
  const wishlisted = useWishlist((state) => product.id in state.products);
  const toggleWishlist = useWishlist((state) => state.toggle);

  const morph = useSharedValue(qtyInCart > 0 ? 1 : 0);

  useEffect(() => {
    const entering = qtyInCart > 0;
    morph.value = withTiming(entering ? 1 : 0, {
      duration: entering ? MORPH_ENTER_DURATION : MORPH_EXIT_DURATION,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qtyInCart > 0]);

  const morphStyle = useAnimatedStyle(() => {

    if (outOfStock) return {};
    return {
      width:
        COMPACT_WIDTH + (STEPPER_EXPANDED_WIDTH - COMPACT_WIDTH) * morph.value,
    };
  }, [outOfStock]);

  return (
  
    <Pressable
      style={styles.card}
      onPress={openDetails}
      accessibilityRole="button"
      accessibilityLabel={`Open ${product.name}`}
    >
     
      <View style={styles.mediaWrap}>
        {/* The ONLY bordered surface on the whole card — a dedicated media
            box, not the card as a whole (see `card`'s own style below: no
            border there anymore). Everything below stays open/borderless. */}
        <View style={styles.media}>
          <View ref={imageBoxRef} style={styles.imageBox}>
            {/* Gives the box its height — see `imageBoxSizer`. */}
            <View style={styles.imageBoxSizer} />
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

            {outOfStock && (
              <View style={styles.outOfStockBadge}>
                <AppText
                  variant="overline"
                  color={colors.textSecondary}
                  style={styles.badgeText}
                >
                  Out of Stock
                </AppText>
              </View>
            )}
          </View>
        </View>

       
        <Pressable
          onPress={() => toggleWishlist(product)}
          style={styles.heartButton}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={
            wishlisted
              ? `Remove ${product.name} from wishlist`
              : `Save ${product.name} to wishlist`
          }
        >
          <Heart
            size={14}
            color={wishlisted ? colors.danger : colors.textSecondary}
            fill={wishlisted ? colors.danger : "none"}
            strokeWidth={2.2}
          />
        </Pressable>

        
        <ReanimatedAnimated.View
          style={[
            styles.floatingActionWrap,
            !outOfStock && styles.floatingActionMask,
            morphStyle,
          ]}
          pointerEvents="box-none"
        >
          <ActionBarTransition
            mode={outOfStock ? "outOfStock" : qtyInCart > 0 ? "stepper" : "add"}
          >
            {outOfStock ? (
              <View style={styles.floatingOutOfStock}>
                <AppText
                  variant="caption"
                  color={colors.textSecondary}
                  style={styles.floatingOutOfStockText}
                >
                  Sold Out
                </AppText>
              </View>
            ) : qtyInCart > 0 ? (
              <QuantityStepper
                qty={qtyInCart}
                max={variant ? quantityLimitOf(variant).max : 0}
                onIncrement={() => {
                  if (!variant) return;
                  tapHaptic();
                  // Several sizes: one more of the size already in the cart.
                  // Several sizes in the cart: the customer picks which (sheet).
                  const target = hasOptions ? cartVariantId : variant.id;
                  if (!target) return openOptions();
                  // Only an accepted step flies into the cart.
                  if (onIncrement(target) !== false) flyToCart(imageUrl, target);
                }}
                onDecrement={() => {
                  if (!variant) return;
                  tapHaptic();
                  // Several sizes: one fewer of the size in the cart — never a
                  // sheet. Only when SEVERAL sizes are in the cart is the
                  // choice the customer's (sheet); the card never guesses one.
                  const target = hasOptions ? cartVariantId : variant.id;
                  if (!target) return openOptions();
                  onDecrement(target);
                }}
                busy={busy}
                fullWidth
                style={[
                  styles.floatingStepperShape,
                  styles.floatingStepperWidth,
                ]}
              />
            ) : (
              <Pressable
                onPress={() => {
                  if (!variant) return;
                  tapHaptic();
                  // Several sizes / options: the customer picks one in the
                  // variant sheet — the card never adds a size nobody chose.
                  if (hasOptions) {
                    openOptions();
                    return;
                  }
                  if (onAdd(variant.id, snapshotFromProduct(product, variant)) !== false) flyToCart(imageUrl, variant.id);
                }}
                style={styles.floatingAddButton}
                accessibilityRole="button"
                accessibilityLabel={
                  hasOptions
                    ? `Choose an option of ${product.name}`
                    : `Add ${product.name} to cart`
                }
              >
                <Plus size={18} color={colors.primary} strokeWidth={2.6} />
              </Pressable>
            )}
          </ActionBarTransition>
        </ReanimatedAnimated.View>
      </View>

      {/* =============================================================
          PRICE — shown first, matching the reference layout.
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

      

      <View style={styles.discountContainer}>
        {!outOfStock && variant && variant.discountPercent > 0 && (
          <View style={styles.discountBadge}>
            <AppText
              variant="overline"
              color={colors.discountBadgeText}
              style={styles.badgeText}
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
    </Pressable>
  );
}


export type ActionBarMode = "add" | "stepper" | "outOfStock";

export function ActionBarTransition({
  mode,
  children,
}: {
  mode: ActionBarMode;
  children: React.ReactNode;
}) {
 
  const anim = useRef(new Animated.Value(1)).current;
  const prevMode = useRef(mode);

  useEffect(() => {
    if (mode === prevMode.current) return;
    prevMode.current = mode;

    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1,
      duration: 140,
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

export const ProductCard = memo(ProductCardImpl);

/* =====================================================================
   STYLES
===================================================================== */

const styles = StyleSheet.create({
  
  card: {
    flex: 1,

    width: "100%",
  },

  

  mediaWrap: {
    position: "relative",
  },

  media: {
    borderWidth: 1,

    borderColor: colors.divider,

    borderRadius: radius.md,

    backgroundColor: colors.surface,

    padding: spacing.xs,

    overflow: "hidden",

    ...shadow.sm,
  },

  // The same card renders at very different widths (≈106–150dp: Home
  // carousels, 2-column Categories, 3-column View All grids). A fixed 150dp
  // height made narrow cards tall slivers that `cover` cropped hard at the
  // sides. The box now follows the card's width (4:5 portrait), capped at
  // the old 150dp so wide cards (Categories, Home carousels) keep their
  // height; the image is `contain`ed in it, so nothing is ever cut off.
  imageBox: {
    width: "100%",

    maxHeight: IMAGE_BOX_MAX_HEIGHT,

    overflow: "hidden",

    position: "relative",
  },

  // Sets `imageBox`'s height to width / IMAGE_BOX_ASPECT; the box's
  // `maxHeight` then caps it. The ratio can't sit on `imageBox` itself:
  // Yoga feeds a max-clamped height back through `aspectRatio` into the
  // width, which would shrink the box sideways instead of capping it.
  imageBoxSizer: {
    width: "100%",

    aspectRatio: IMAGE_BOX_ASPECT,
  },

  
  heartButton: {
    position: "absolute",

    top: 4,

    right: 4,

    width: 24,

    height: 24,

    borderRadius: radius.circle,

    backgroundColor: "rgba(255,255,255,0.9)",

    alignItems: "center",

    justifyContent: "center",

    zIndex: 3,
  },

 


  floatingActionWrap: {
    position: "absolute",

    right: spacing.xs,

    bottom: -BUTTON_OVERHANG,

    zIndex: 3,
  },


  floatingActionMask: {
    height: 36,
    overflow: "hidden",
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "flex-end",
  },

  floatingAddButton: {
    width: 34,

    height: 34,

    borderRadius: radius.sm,

    backgroundColor: colors.surface,

    borderWidth: 1.5,

    borderColor: colors.primary,

    alignItems: "center",

    justifyContent: "center",

    ...shadow.sm,
  },

  // Overrides QuantityStepper's own (pill-shaped) corners for this one
  // usage only — ProductDetailScreen's footer stepper stays pill-shaped
  // to match the Cart button beside it, so this can't just change the
  // shared `stepper`/`stepperFullWidth` styles those both draw from.
  floatingStepperShape: {
    borderRadius: radius.sm,
  },

  // Overrides `stepperFullWidth`'s `alignSelf: "stretch"` for this one
  // usage — see `floatingActionMask`'s own comment for why the stepper
  // must render at its real final width always, not whatever width the
  // (mid-animation) wrap currently has.
  floatingStepperWidth: {
    width: STEPPER_EXPANDED_WIDTH,
  },

  floatingOutOfStock: {
    height: 28,

    paddingHorizontal: spacing.sm,

    borderRadius: radius.pill,

    backgroundColor: "rgba(255,255,255,0.92)",

    alignItems: "center",

    justifyContent: "center",
  },

  floatingOutOfStockText: {
    fontSize: 10,

    fontWeight: "700",
  },

  image: {
    position: "absolute",

    top: 0,

    right: 0,

    bottom: 0,

    left: 0,
  },

  imageFaded: {
    opacity: 0.4,
  },

  imagePlaceholder: {
    position: "absolute",

    top: 0,

    right: 0,

    bottom: 0,

    left: 0,

    backgroundColor: colors.skeleton,

    borderRadius: radius.md,
  },

  /* ================================================================
     BADGES (discount / out of stock)
  ================================================================ */

  // In-flow now (see the DISCOUNT section above) — no longer overlaid on
  // the image, so no `position: absolute`/`zIndex` here anymore.
  discountBadge: {
    alignSelf: "flex-start",

    backgroundColor: colors.discountBadge,

    paddingHorizontal: 8,

    paddingVertical: 3,

    borderRadius: radius.sm,
  },

  discountContainer: {
    height: 18,

    marginTop: 4,

    justifyContent: "center",
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

    // Clears the floating Add/stepper overlay's overhang (see
    // `floatingActionWrap`) PLUS a real gap on top of it — constant
    // regardless of the stepper's current width, since only its width
    // (never its vertical position) ever animates.
    marginTop: BUTTON_OVERHANG + IMAGE_TEXT_GAP,
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
     QUANTITY STEPPER

     Default size: compact pill for tight rows (the cart screen's line
     item). `fullWidth` styles below are merged on top for the card's own
     action bar and the product-detail footer.
  ================================================================ */

  // No `justifyContent` needed — the center slot between the two buttons is
  // `flex: 1` (see `qtyCenterSlot`), which already consumes 100% of
  // whatever space is left, so there's nothing left for `justifyContent`
  // to distribute.
  // The Home card's rectangle — now every QuantityStepper's own shape.
  stepper: {
    height: 36,

    flexDirection: "row",

    alignItems: "center",

    paddingHorizontal: 4,

    borderRadius: radius.sm,

    backgroundColor: colors.primary,
  },

  // The compact (non-`fullWidth`) size's own width — split out from
  // `stepper` so `fullWidth` mode (below) never has a competing explicit
  // `width` left over to fight its `alignSelf: "stretch"`.
  stepperCompactWidth: {
    width: STEPPER_EXPANDED_WIDTH,
  },

  // `alignSelf: "stretch"`, not `width: "100%"` — a percentage width has to
  // RESOLVE against the parent's width, which raced visibly (a flash to
  // ~full card width before settling) the instant this mounted under
  // ProductCard's Reanimated-animated `floatingActionWrap`. `stretch` is
  // plain Yoga flex fill: it's recalculated as part of the SAME layout pass
  // as the parent's own (possibly still-animating) width, so there's never
  // a frame where the two disagree.
  stepperFullWidth: {
    alignSelf: "stretch",
  },

  // Flat 32×32 tap targets (plus `hitSlop`) on every control.
  stepperButton: {
    width: 32,

    height: 32,

    alignItems: "center",

    justifyContent: "center",
  },

  stepperButtonPressed: {
    opacity: 0.6,
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

    textAlign: "center",
  },

  quantityTextFullWidth: {
    fontSize: 14,

    lineHeight: 18,
  },

  
  qtyCenterSlot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  // `width` is set inline per-instance (see AnimatedQuantity's `clipWidth`
  // prop) — FIXED, not `minWidth`, so the box itself never resizes between
  // "1" and "10".
  qtyClip: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});

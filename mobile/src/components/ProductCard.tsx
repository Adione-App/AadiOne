import { memo, useEffect, useRef, useState } from "react";
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
import { Heart, Plus } from "lucide-react-native";

import type { ProductSummaryDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, shadow, spacing } from "@shared/theme";

import { resolveImageUrl } from "../lib/api";
import {
  type CartItemSnapshot,
  snapshotFromProduct,
} from "../lib/useCartActions";
import { flyFromCart, flyToCart } from "../lib/flyToCart";
import { useWishlist } from "../lib/useWishlist";
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
  clipWidth,
}: {
  qty: number;
  textStyle: StyleProp<TextStyle>;
  color: string;
  lineHeight: number;
  /** FIXED (not min) width for the clip box both digits share — this is
   * what makes "1" -> "10" resize NOTHING: the box never grows/shrinks, so
   * there's nothing for the surrounding flex row to reflow around. Centered
   * text inside a fixed box also means the glyph itself never drifts
   * left/right as digit count changes. */
  clipWidth: number;
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
  flatButtons,
  style,
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
  /** Drops the `-`/`+` buttons' own circular background in `fullWidth`
   * mode, leaving just the symbol on the shared pill behind it — the app-
   * wide stepper look (ProductCard's floating overlay, ProductDetailScreen's
   * footer). Opt-in (default off, unused elsewhere currently) rather than
   * the new default so a future `fullWidth` caller that DOES want the
   * circular buttons doesn't have to fight this. The buttons keep the SAME
   * touch-target size either way — only the background/radius drops. */
  flatButtons?: boolean;
  /** Extends/overrides the container's own style — e.g. a different
   * corner radius for one specific usage (see ProductCard's floating
   * overlay) without touching the shared pill shape every other caller
   * relies on. */
  style?: StyleProp<ViewStyle>;
}) {
  const buttonStyle = [
    styles.stepperButton,
    fullWidth && (flatButtons ? styles.stepperButtonFullWidthFlat : styles.stepperButtonFullWidth),
  ];

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
        style={buttonStyle}
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

      {/* `flex: 1` between two FIXED-width buttons (identical width on both
          sides) is what GUARANTEES the number sits exactly centered — by
          construction, not by relying on `justifyContent` math staying
          balanced. Growing/shrinking for "1" vs "10" happens symmetrically
          inside this slot; the buttons on either side never move. */}
      <View style={styles.qtyCenterSlot}>
        <AnimatedQuantity
          qty={qty}
          color={colors.onPrimary}
          lineHeight={fullWidth ? 18 : 16}
          clipWidth={fullWidth ? 28 : 16}
          textStyle={[
            styles.quantityText,
            fullWidth && styles.quantityTextFullWidth,
          ]}
        />
      </View>

      <Pressable
        onPress={onIncrement}
        disabled={qty >= max}
        hitSlop={8}
        style={buttonStyle}
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

/** The floating overlay's compact ("+") size — the morph's starting point. */
const COMPACT_WIDTH = 34;
/**
 * The expanded "− N +" pill's width — a FIXED constant, not a percentage of
 * the card/media box. It used to be computed as ~60% of the measured media
 * width (capped at a hard floor for narrow cards), which meant the SAME
 * control rendered at a different pixel width on every screen — ~100px on
 * Home's 132px-wide rail cards (the floor), but grown out past 130px+ on
 * Category/Search's wider grid cards, since those comfortably clear 60%.
 * Every card everywhere must show a pixel-identical stepper, so there is no
 * ratio to compute at all: this is the one width every card uses.
 *
 * The value itself (100) is still content-driven: two 32px flat buttons +
 * the quantity digit (>= 16px) + the pill's own 4px horizontal padding on
 * each side = 88px minimum, plus a little headroom so there's genuine
 * breathing room rather than zero-overflow. It's comfortably under 60% of
 * every grid card width in the app (~140-160px, see useGridColumns); Home's
 * own rail cards are narrower still (132px, ~76%) — a legible, tappable
 * stepper takes priority over the 60% target there, same trade-off the old
 * floor already made, just without a wider ratio-driven value anywhere else
 * to be inconsistent with.
 */
const STEPPER_EXPANDED_WIDTH = 100;
/** How far the floating Add/stepper overlay hangs below the media box's
 * bottom edge (`floatingActionWrap.bottom` below) — reused by `priceRow`'s
 * `marginTop` so the two can never drift out of sync and leave the text
 * sitting under the button, regardless of how wide the stepper gets. */
const BUTTON_OVERHANG = 16;
/** The reserved breathing room between the media box and the text below it
 * — on top of `BUTTON_OVERHANG`, not instead of it. */
const IMAGE_TEXT_GAP = spacing.sm;

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

  // Shared across every card/screen (see useWishlist.ts) — subscribed via
  // a selector keyed to THIS product's own id, so a toggle on one card only
  // re-renders that card, not every other visible one.
  const wishlisted = useWishlist((state) => product.id in state.products);
  const toggleWishlist = useWishlist((state) => state.toggle);

  // Morphs the floating Add/stepper overlay's WIDTH between the compact
  // 34px "+" circle and the fixed-width stepper pill — a real UI-thread
  // width animation (Reanimated can animate `width` directly; RN's classic
  // native driver can't, which is what used to make this a
  // `LayoutAnimation` call instead). `morph` drives the interpolation and
  // reacts ONLY when `qtyInCart` crosses the 0 boundary (matches
  // `ActionBarTransition`'s own add/stepper mode split) — a same-mode qty
  // change (e.g. 2 -> 3) never re-triggers it.
  const morph = useSharedValue(qtyInCart > 0 ? 1 : 0);

  useEffect(() => {
    morph.value = withTiming(qtyInCart > 0 ? 1 : 0, {
      duration: 220,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qtyInCart > 0]);

  const morphStyle = useAnimatedStyle(() => {
    // Out of stock shows the (differently-sized, auto-width) "Sold Out"
    // pill instead of the Add/stepper pair this morph is for — leave its
    // width alone rather than forcing it into the compact 34px target.
    if (outOfStock) return {};
    return { width: COMPACT_WIDTH + (STEPPER_EXPANDED_WIDTH - COMPACT_WIDTH) * morph.value };
  }, [outOfStock]);

  return (
    // Plain View, not Pressable: navigation belongs to the image alone (see
    // below), never to the card as a whole. A Pressable here previously
    // wrapped everything, including the Add/stepper buttons — and a
    // DISABLED nested Pressable (mid-request) doesn't claim the touch, so
    // the tap fell through to this outer Pressable's onPress and opened
    // Product Details instead of doing nothing. Removing the outer handler
    // entirely closes that hole rather than working around it.
    <View style={styles.card}>
      {/* =============================================================
          IMAGE + WISHLIST HEART + FLOATING ADD/STEPPER

          The heart and the Add/+ control float OVER the image's bottom
          edge (not below it, in normal flow) — matches the quick-commerce
          reference: a compact circular "+" before anything's in the cart,
          which becomes the full-width "− N +" stepper the instant it is,
          both anchored to the same spot so nothing else on the card moves.
      ============================================================= */}

      <View style={styles.mediaWrap}>
        {/* The ONLY bordered surface on the whole card — a dedicated media
            box, not the card as a whole (see `card`'s own style below: no
            border there anymore). Everything below stays open/borderless. */}
        <View style={styles.media}>
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
          </Pressable>
        </View>

        {/* Saves/removes this product in the shared, device-persisted
            wishlist (see useWishlist.ts) — read on the Wishlist tab. Sits on
            `mediaWrap` (not `media`) so it isn't clipped by the media box's
            own `overflow: hidden`. */}
        <Pressable
          onPress={() => toggleWishlist(product)}
          style={styles.heartButton}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={
            wishlisted ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`
          }
        >
          <Heart
            size={14}
            color={wishlisted ? colors.danger : colors.textSecondary}
            fill={wishlisted ? colors.danger : "none"}
            strokeWidth={2.2}
          />
        </Pressable>

        {/* Also on `mediaWrap`, not `media` — this straddles the media
            box's bottom-right corner on purpose (see `floatingActionWrap`'s
            own comment), which `media`'s `overflow: hidden` would clip. */}
        <ReanimatedAnimated.View
          style={[styles.floatingActionWrap, morphStyle]}
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
                max={variant?.maxQtyPerOrder ?? 10}
                onIncrement={() => {
                  if (!variant) return;
                  flyToCart(imageUrl);
                  onIncrement(variant.id);
                }}
                onDecrement={() => {
                  if (!variant) return;
                  // Only the tap that's about to empty the line plays the
                  // "leaving the cart" flight — every other decrement just
                  // changes the number in place (its own AnimatedQuantity
                  // digit-roll handles that already). The overlay's own
                  // morph back down to the compact "+" reacts automatically
                  // to `qtyInCart` crossing 0 (see `morph` above), so it
                  // needs no imperative trigger here.
                  if (qtyInCart === 1) {
                    flyFromCart(imageUrl);
                  }
                  onDecrement(variant.id);
                }}
                busy={busy}
                fullWidth
                flatButtons
                style={styles.floatingStepperShape}
              />
            ) : (
              <Pressable
                onPress={() => {
                  if (!variant) return;
                  flyToCart(imageUrl);
                  onAdd(variant.id, snapshotFromProduct(product, variant));
                }}
                style={styles.floatingAddButton}
                accessibilityRole="button"
                accessibilityLabel={`Add ${product.name} to cart`}
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

      {/* =============================================================
          DISCOUNT — lives in the info section now, not overlaid on the
          image (see `media` above). Fixed height, same pattern as
          `nameContainer`/`variantContainer` below, so a product WITHOUT a
          discount doesn't end up a row shorter than one that has it.
      ============================================================= */}

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

     Deliberately NO border/background/shadow here anymore — quick-
     commerce reference apps (Instamart/Blinkit/Zepto/BigBasket) put that
     treatment on the IMAGE area only, never around the whole card. See
     `media` below for where it actually lives now. The product info below
     the image stays visually open, not boxed in.
  ================================================================ */

  card: {
    flex: 1,

    width: "100%",
  },

  /* ================================================================
     MEDIA — the one bordered surface on the card. `mediaWrap` is the
     plain, unclipped positioning root (heart button + floating Add/
     stepper both anchor to IT, not to `media`, specifically so the
     stepper can still straddle `media`'s bottom edge without being cut
     off by `media`'s own `overflow: hidden`). `media` is the actual
     bordered/padded box the image sits inside.
  ================================================================ */

  mediaWrap: {
    position: "relative",
  },

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

    alignItems: "center",

    justifyContent: "center",

    position: "relative",
  },

  /* ================================================================
     WISHLIST HEART — its own Pressable, layered over the image's
     corner, not nested inside the image's Pressable (see file header).
     Decorative only — see the JSX comment above its usage.
  ================================================================ */

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

  /* ================================================================
     FLOATING ADD/STEPPER — straddles the image's bottom edge (half on
     the image, half below it — `bottom: -BUTTON_OVERHANG` is deliberate,
     not a mistake) instead of sitting fully inside the image or fully
     below it in normal flow. `right` (no `left`) anchors this box's RIGHT
     edge in place while its own `width` is animated (see `morphStyle` in
     ProductCardImpl) between the compact 34px "+" and the (~60%-capped)
     stepper pill — that's what makes it visibly grow LEFTWARD from a fixed
     right edge instead of the old hug-content layout snapping between the
     two. Only WIDTH ever animates here — height/position are fixed — so
     the button's bottom edge sits at the same `BUTTON_OVERHANG` distance
     below the media box regardless of quantity, and `priceRow`'s
     `marginTop` (== `BUTTON_OVERHANG + IMAGE_TEXT_GAP`) reserves a
     CONSTANT, quantity-independent gap for it. `mediaWrap` has no
     `overflow: hidden`, so this bottom half hanging below it is never
     clipped.
  ================================================================ */

  floatingActionWrap: {
    position: "absolute",

    right: spacing.xs,

    bottom: -BUTTON_OVERHANG,

    zIndex: 3,
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
  stepper: {
    height: 30,

    flexDirection: "row",

    alignItems: "center",

    paddingHorizontal: 2,

    borderRadius: radius.pill,

    backgroundColor: colors.primary,
  },

  // The compact (non-`fullWidth`) size's own width — split out from
  // `stepper` so `fullWidth` mode (below) never has a competing explicit
  // `width` left over to fight its `alignSelf: "stretch"`.
  stepperCompactWidth: {
    width: 62,
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

    height: 36,

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

  // Same touch-target footprint as `stepperButtonFullWidth`, just with no
  // background/radius of its own — see `flatButtons` on QuantityStepper.
  stepperButtonFullWidthFlat: {
    width: 32,

    height: 32,
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

  // Fills the flex:1 gap `qtyCenterSlot` reserves between the two buttons —
  // this is what makes the number sit dead-center regardless of the
  // stepper's overall width.
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

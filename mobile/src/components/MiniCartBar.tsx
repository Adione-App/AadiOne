/**
 * Floating mini-cart — shows the most recently added product thumbnails +
 * running count once there's at least one item, so the customer always has
 * a one-tap way to reach checkout. Renders nothing at all when the cart is
 * empty, not just visually hidden.
 *
 * `MiniCartOverlay` (the default export) is a ROOT-LEVEL overlay — mounted
 * once in MainTabs.tsx as a sibling of `Tab.Navigator`, not inside
 * HomeScreen — specifically so its position is never subject to the same
 * per-tab content resize `AnimatedTabBar`'s own height collapse drives
 * (`react-native-screens` wraps each tab's content in an absolutely-
 * positioned native view sized off that resize; observed in practice as a
 * multi-second lag / the bar getting stuck mid-transition, since that
 * native layer doesn't track a continuously-animating sibling's size the
 * way a plain RN view does). Instead, `MiniCartOverlay` computes its OWN
 * `bottom` offset directly from `tabBarHiddenByScroll` — the EXACT SAME
 * Reanimated shared value `AnimatedTabBar` reads for its own collapse, with
 * the same duration/easing — so the two are provably one coordinated
 * animation with no cross-tree layout dependency to lag behind.
 *
 * It only renders on the three screens registered in `useMiniCartScreen`
 * (Home's own feed, Categories' landing/drill-down views, and Product
 * Detail) — every other screen (Search, Rail, Cart, Account, …) renders
 * nothing. This is the ONE mini-cart implementation used everywhere it
 * appears — Categories used to have its own separate bespoke sticky bar,
 * and Product Detail its own separate "Go to Cart" landing-target
 * registration; both were replaced by this shared overlay rather than kept
 * as parallel implementations. What changes per screen is only WHERE it
 * rests (see `positionStyle` below): above the tab bar on Home/Categories
 * (collapsing with it on Home specifically), above Product Detail's own
 * fixed Add-to-Cart footer on that screen.
 *
 * Also registers its own on-screen position as the "fly to cart" landing
 * target (see flyToCart.tsx) — it's the thing that's actually visible
 * wherever an add happens, so that's what the flying item should land on.
 *
 * ANIMATION: entirely Reanimated (UI-thread worklets), not RN's `Animated`.
 * The pill itself plays a custom `entering`/`exiting` transition (mounts on
 * the first item, unmounts on the last one leaving/Clear Cart).
 *
 * A NEWLY ADDED thumbnail (cart state updates synchronously, so it's in
 * `items` well before `flyToCart.tsx`'s flying dot finishes its flight)
 * stays INVISIBLE until that flight's exact `ADD_DURATION` has elapsed,
 * then plays a quick settle-in. Two earlier attempts both looked wrong for
 * opposite reasons: playing the thumbnail's own entrance immediately (at
 * t=0) had it visibly competing with the flying dot for the whole flight —
 * two things clearly moving into the same spot at once; showing it with NO
 * entrance at all (instantly, at t=0) fixed that competition but introduced
 * a different bug — the real thumbnail sitting there, fully visible, for
 * the ~420ms the dot is STILL visibly in the air, i.e. "the cart shows the
 * item before the drop animation finishes". Delaying the reveal to land
 * exactly when the dot disappears is what makes it read as ONE continuous
 * handoff: the dot arrives and fades out, and that's the same instant the
 * real thumbnail appears — never both at once, never one before the other.
 * `isFirstRender` (see `MiniCartPill`) skips the delay for whatever's
 * ALREADY in the cart the very first time this renders (app cold start
 * with existing items) — there's no flying dot to sync with then, so
 * waiting 420ms to show them would just be a pointless empty-looking pill.
 *
 * A REMOVED thumbnail still plays its own `exiting` (a short upward fade —
 * that one isn't decorated by anything else, so it stays as-is), and every
 * thumbnail still gets a `layout` transition so the REMAINING ones slide
 * smoothly into their new slots instead of snapping when a sibling leaves.
 * None of this touches React state per frame — Reanimated drives all of it
 * off the native layout commit itself.
 */

import { useEffect, useRef } from "react";
import { Image } from "expo-image";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
} from "react-native-reanimated";
import { ChevronRight } from "lucide-react-native";
import type { CartItemDto } from "@shared";
import { colors, layout, radius, shadow, spacing } from "@shared/theme";
import { resolveImageUrl } from "@/lib/api";
import { useCartActions } from "@/lib/useCartActions";
import { ADD_DURATION, useFlyToCartStore } from "@/lib/flyToCart";
import {
  productDetailFooterHeight,
  tabBarHiddenByScroll,
  useMiniCartScreen,
} from "@/lib/tabBarVisibility";
import { navigateToCart } from "@/navigation/navigationRef";
import { AppText } from "./ui";

const MAX_THUMBNAILS = 3;
const THUMB_SIZE = 34;
const THUMB_OVERLAP = 10;
/** Gap kept above whatever the bar is currently resting on — the visible
 * tab bar when it's shown, the raw screen bottom edge when it's hidden. */
const BOTTOM_GAP = spacing.sm;
/** Matches `AnimatedTabBar`'s own collapse exactly — see its comment in
 * MainTabs.tsx for why these two need to move in lockstep. */
const FOLLOW_DURATION = 240;

/* =====================================================================
   CUSTOM LAYOUT ANIMATIONS

   Raw worklet builders (Reanimated's documented escape hatch) rather than
   the preset builders (`FadeIn`, `SlideInUp`, …) — none of those combine
   the exact "small translate + fade + slight scale" all three specs below
   ask for without fighting preset composition, and these need to be small/
   subtle (a 34px thumbnail, not a full-screen sheet), never the bouncy/
   dramatic feel a bare preset defaults to.
===================================================================== */

function barEntering(values: EntryAnimationsValues) {
  "worklet";
  return {
    initialValues: {
      opacity: 0,
      originY: values.targetOriginY + 18,
      transform: [{ scale: 0.94 }],
    },
    animations: {
      opacity: withTiming(1, { duration: 220 }),
      originY: withSpring(values.targetOriginY, { damping: 16, stiffness: 180 }),
      transform: [{ scale: withSpring(1, { damping: 16, stiffness: 180 }) }],
    },
  };
}

function barExiting(values: ExitAnimationsValues) {
  "worklet";
  return {
    initialValues: {
      opacity: 1,
      originY: values.currentOriginY,
      transform: [{ scale: 1 }],
    },
    animations: {
      opacity: withTiming(0, { duration: 180 }),
      originY: withTiming(values.currentOriginY + 18, { duration: 200 }),
      transform: [{ scale: withTiming(0.94, { duration: 200 }) }],
    },
  };
}

function thumbnailExiting(values: ExitAnimationsValues) {
  "worklet";
  return {
    initialValues: {
      opacity: 1,
      originY: values.currentOriginY,
      transform: [{ scale: 1 }],
    },
    animations: {
      opacity: withTiming(0, { duration: 160 }),
      originY: withTiming(values.currentOriginY - 14, { duration: 180 }),
      transform: [{ scale: withTiming(0.7, { duration: 180 }) }],
    },
  };
}

/** The visual pill itself — no positioning opinion of its own, that's
 * `MiniCartOverlay`'s job below. */
function MiniCartPill({
  items,
  itemCount,
  onPress,
}: {
  items: CartItemDto[];
  itemCount: number;
  onPress: () => void;
}) {
  // Measured directly on the thumbnail stack (not the whole pill) so a
  // dropped item lands exactly where the stacked images are, not in the
  // dead space over the "CART / N ITEMS" label.
  const thumbRowRef = useRef<View>(null);
  const setCartTargetPosition = useFlyToCartStore((state) => state.setCartTargetPosition);

  const measure = () => {
    thumbRowRef.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) setCartTargetPosition({ x, y, width, height });
    });
  };

  // Small pulse whenever the count actually changes (add OR remove) — a
  // quiet confirmation that the bar itself reacted, on top of the flying
  // thumbnail. Guarded so it doesn't fire on the FIRST render (there's no
  // "change" to react to when the bar first appears with 1 item already
  // in it) — only on a genuine transition between two counts. A shared
  // value driven from a `useEffect`, not a per-frame binding — this only
  // ever updates on an actual count change, never during scroll.
  const pulse = useSharedValue(1);
  const prevCountRef = useRef(itemCount);
  useEffect(() => {
    if (prevCountRef.current === itemCount) return;
    prevCountRef.current = itemCount;

    pulse.value = 0.94;
    pulse.value = withSpring(1, { damping: 12, stiffness: 260 });
  }, [itemCount, pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  // Flips to `false` once, right after the FIRST commit — see the file
  // header for why a thumbnail's entrance is delayed to land exactly when
  // `flyToCart.tsx`'s flying dot does, EXCEPT for whatever's already in the
  // cart on this very first render (nothing flew in for those, so there's
  // nothing to sync with — showing them immediately is correct there).
  const isFirstRender = useSharedValue(true);
  useEffect(() => {
    isFirstRender.value = false;
  }, [isFirstRender]);

  // Defined per-render (not hoisted to module scope) specifically so it can
  // close over `isFirstRender` above — Reanimated's babel plugin still
  // workletizes it correctly wherever it's defined.
  const thumbnailEntering = (values: EntryAnimationsValues) => {
    "worklet";
    const delay = isFirstRender.value ? 0 : ADD_DURATION;
    return {
      initialValues: {
        opacity: 0,
        originY: values.targetOriginY - 14,
        transform: [{ scale: 0.85 }],
      },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: 180 })),
        originY: withDelay(delay, withTiming(values.targetOriginY, { duration: 200 })),
        transform: [{ scale: withDelay(delay, withTiming(1, { duration: 200 })) }],
      },
    };
  };

  if (itemCount === 0) return null;

  // Last 3 distinct LINES (not remaining quantity), oldest-of-the-three
  // first — `cart.items` is already append-ordered, so this slice reads
  // left-to-right as oldest-behind to newest-on-top once stacked below.
  const thumbnails = items.slice(-MAX_THUMBNAILS);

  return (
    // `alignItems: "center"` is what keeps the pill hugging its content
    // width (like the reference) instead of stretching edge to edge — the
    // Pressable below has no flex/width of its own.
    <ReanimatedAnimated.View
      style={styles.pillWrap}
      pointerEvents="box-none"
      entering={barEntering}
      exiting={barExiting}
    >
      <ReanimatedAnimated.View style={pulseStyle}>
        <Pressable
          style={styles.bar}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`Go to cart, ${itemCount} item${itemCount === 1 ? "" : "s"}`}
        >
          <View style={styles.textBlock}>
            <AppText variant="bodyStrong" color={colors.onPrimary} numberOfLines={1} style={styles.cartLabel}>
              CART
            </AppText>
            <AppText variant="caption" color={colors.onPrimary} numberOfLines={1} style={styles.itemsLabel}>
              {itemCount} ITEM{itemCount === 1 ? "" : "S"}
            </AppText>
          </View>

          {/* `collapsable={false}` — otherwise Android may optimize this
              View out of the native tree, silently breaking
              `measureInWindow` (it would measure the wrong/parent node). */}
          <ReanimatedAnimated.View
            ref={thumbRowRef}
            onLayout={measure}
            collapsable={false}
            style={styles.thumbRow}
            layout={LinearTransition.duration(220)}
          >
            {thumbnails.map((item, index) => {
              const uri = resolveImageUrl(item.imageUrl);
              return (
                <ReanimatedAnimated.View
                  // Keyed by VARIANT, not `item.id` — a brand-new line's
                  // `id` is a synthetic `pending-${variantId}` placeholder
                  // (see useCartActions' `optimisticCart`) until the
                  // server confirms it and swaps in the real cart-item id.
                  // Keying by the id would make that swap look like the
                  // placeholder thumbnail exiting and a new one entering
                  // for the SAME product a moment later — the exact
                  // "blinks again after landing" glitch this avoids.
                  // `variantId` never changes across that transition.
                  key={item.variantId}
                  entering={thumbnailEntering}
                  exiting={thumbnailExiting}
                  layout={LinearTransition.duration(220)}
                  style={[styles.thumbBox, index > 0 && { marginLeft: -THUMB_OVERLAP, zIndex: index }]}
                >
                  {uri ? (
                    <Image
                      source={{ uri }}
                      style={styles.thumbImage}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={styles.thumbPlaceholder} />
                  )}
                </ReanimatedAnimated.View>
              );
            })}
          </ReanimatedAnimated.View>

          <View style={styles.arrowButton}>
            <ChevronRight size={18} color={colors.primary} strokeWidth={2.6} />
          </View>
        </Pressable>
      </ReanimatedAnimated.View>
    </ReanimatedAnimated.View>
  );
}

/**
 * Root-level positioning wrapper — see the file header. Reads cart state
 * itself (same shared optimistic store every other cart-touching screen
 * uses, via `useCartActions`) rather than taking it as props, since it no
 * longer has a parent screen handing it down.
 */
export default function MiniCartOverlay() {
  const insets = useSafeAreaInsets();
  const cart = useCartActions();
  const screen = useMiniCartScreen((state) => state.screen);

  const barHeight = layout.tabBarHeight + insets.bottom;

  // Reads `tabBarHiddenByScroll`/`productDetailFooterHeight` — the SAME
  // shared values `AnimatedTabBar`'s own collapse and Product Detail's
  // footer respectively already maintain — directly inside the worklet,
  // with the SAME duration/easing as the footer. Nothing here goes through
  // React state or a parent screen's layout at all, so there's no
  // cross-tree cascade left to lag: this recalculates on the UI thread in
  // the same frame whatever it's tracking does. `screen` is captured as a
  // plain JS value (via the dependency array) since it only changes on
  // navigation focus, not per frame.
  const positionStyle = useAnimatedStyle(() => {
    let restingOn: number;
    if (screen === "productDetail") {
      // Falls back to the tab-bar height before the footer's very first
      // `onLayout` has landed, rather than momentarily resting on 0 (the
      // very bottom edge, right where the real footer will appear).
      restingOn = productDetailFooterHeight.value || barHeight;
    } else if (screen === "categories") {
      // The tab bar never hides on scroll here — always rest above it.
      restingOn = barHeight;
    } else {
      // "home" (or "none", irrelevant — nothing renders below anyway).
      restingOn = tabBarHiddenByScroll.value ? 0 : barHeight;
    }

    return {
      bottom: withTiming(BOTTOM_GAP + restingOn, {
        duration: FOLLOW_DURATION,
        easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
      }),
    };
  }, [screen, barHeight]);

  if (screen === "none") return null;

  const items = cart.cart?.items ?? [];
  const itemCount = cart.cart?.bill.itemCount ?? 0;

  return (
    <ReanimatedAnimated.View style={[styles.overlayWrap, positionStyle]} pointerEvents="box-none">
      <MiniCartPill items={items} itemCount={itemCount} onPress={navigateToCart} />
    </ReanimatedAnimated.View>
  );
}

const styles = StyleSheet.create({
  overlayWrap: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  pillWrap: {
    alignItems: "center",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.base,
    height: 56,
    paddingLeft: spacing.base + 2,
    paddingRight: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    ...shadow.lg,
  },
  textBlock: {
    alignItems: "flex-start",
  },
  cartLabel: {
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  itemsLabel: {
    opacity: 0.85,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  thumbRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  thumbBox: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImage: {
    width: "100%",
    height: "100%",
  },
  thumbPlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: colors.skeleton,
  },
  arrowButton: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    backgroundColor: colors.onPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
});

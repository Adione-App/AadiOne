/**
 * Floating Mini Cart — bottom-right pink card: a single "latest product"
 * thumbnail on the left, "Cart" / "N items" on the right.
 *
 * Behaviour:
 *
 * 1. First cart item:
 *    Mini Cart smoothly enters from below.
 *
 * 2. New (or re-incremented) product:
 *    - flyToCart()'s overlay drops the product's image into the thumbnail
 *      slot (see @/lib/flyToCart) while the slot keeps showing whatever
 *      it was already showing.
 *    - The instant the overlay lands, the slot swaps straight to the new
 *      image and the overlay disappears — never both visible at once, and
 *      never a second entrance animation on the slot itself.
 *    - A flight's landing only ever applies if it's still the MOST
 *      RECENTLY requested add — see `latestAddFlightId`/`landedFlightId`
 *      in flyToCart.tsx. An older, superseded flight landing late can
 *      never overwrite a newer image.
 *
 * 3. Remove:
 *    The Mini Cart stays put — only the item count updates. The slot
 *    keeps showing the last product that was actually ADDED (not
 *    necessarily "whatever's still in the cart") until a new add
 *    replaces it.
 *
 * 4. Last item removed:
 *    Mini Cart exits downward.
 *
 * Position: flyToCart()'s flights never read a cached position from here at
 * all — this only ever registers a stable `AnimatedRef` (see
 * `useAnimatedRef` below) for its own card and thumbnail slot, once, on
 * mount. Every flight calls Reanimated's `measure()` on those refs itself,
 * fresh, every frame — see flyToCart.tsx's file header for why a
 * cached-and-periodically-refreshed position (the previous approach here)
 * couldn't reliably stay in sync with a Reanimated-driven `transform` like
 * `positionStyle` below.
 */

import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";

import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  useAnimatedRef,
  useAnimatedStyle,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
} from "react-native-reanimated";

import type { CartItemDto } from "@shared";

import { colors, layout, radius, shadow, spacing } from "@shared/theme";

import { resolveImageUrl } from "@/lib/api";
import { useCartActions } from "@/lib/useCartActions";

import { ADD_DURATION, useFlyToCartStore } from "@/lib/flyToCart";

import {
  productDetailFooterHeight,
  tabBarHiddenByScroll,
  useMiniCartScreen,
  type MiniCartScreen,
} from "@/lib/tabBarVisibility";

import { navigateToCart } from "@/navigation/navigationRef";
import { AppText } from "./ui";

/**
 * Single product-image slot size — MUST exactly match flyToCart's own
 * `DOT_SIZE`, which is what the flying image animates at.
 */
const IMAGE_SIZE = 28;

/**
 * Mini Cart's own accent color, per an explicit request — deliberately
 * local to this component rather than routed through `colors.primary`
 * (which stays the app's regular brand green everywhere else).
 */
const MINI_CART_BG = "#DA9100";
/**
 * Dark ink, not `colors.onPrimary` (white) — `MINI_CART_BG` above is a
 * bright, light gold, so white text/icons drawn on top of it would be
 * unreadable.
 */
const MINI_CART_FG = "#141816";

// A bit more than the bare minimum (`spacing.md`, 12px) — the card sat
// visibly too close to the true screen bottom, especially once its own
// resting line stopped depending on the tab bar at all (see
// `positionStyle`'s "hidden" branch, which now also adds `insets.bottom` on
// top of this).
const BOTTOM_GAP = spacing.md;

const FOLLOW_DURATION = 240;

/**
 * How long the image slot waits for its matching flyToCart() flight to
 * report landing before swapping to the new image anyway. Pure safety net
 * for a lost/late signal — under normal operation `landedFlightId` fires
 * well before this.
 */
const REVEAL_SAFETY_MARGIN = 200;

/**
 * Mini Cart enters from a small distance below.
 */
function barEntering(values: EntryAnimationsValues) {
  "worklet";

  return {
    initialValues: {
      opacity: 0,
      originY: values.targetOriginY + 18,
      transform: [
        {
          scale: 0.96,
        },
      ],
    },

    animations: {
      opacity: withTiming(1, {
        duration: 200,
      }),

      originY: withTiming(values.targetOriginY, {
        duration: 240,
        easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
      }),

      transform: [
        {
          scale: withTiming(1, {
            duration: 240,
            easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
          }),
        },
      ],
    },
  };
}

/**
 * Mini Cart leaves downward when the final item is removed. This is the
 * ONLY Mini Cart exit animation — removing one item out of several never
 * triggers this; the bar just stays put and the count updates.
 */
function barExiting(values: ExitAnimationsValues) {
  "worklet";

  return {
    initialValues: {
      opacity: 1,
      originY: values.currentOriginY,
      transform: [
        {
          scale: 1,
        },
      ],
    },

    animations: {
      opacity: withTiming(0, {
        duration: 170,
      }),

      originY: withTiming(values.currentOriginY + 18, {
        duration: 200,
        easing: ReanimatedEasing.in(ReanimatedEasing.cubic),
      }),

      transform: [
        {
          scale: withTiming(0.96, {
            duration: 200,
          }),
        },
      ],
    },
  };
}

function MiniCartPill({
  items,
  itemCount,
  screen,
  onPress,
}: {
  items: CartItemDto[];
  itemCount: number;
  screen: MiniCartScreen;
  onPress: () => void;
}) {
  /**
   * The whole card and its thumbnail slot — Reanimated refs, not plain
   * `useRef`s. `useAnimatedRef` is what lets flyToCart.tsx's flights call
   * Reanimated's `measure()` on these directly, from a worklet, on demand —
   * see flyToCart.tsx's file header for why that (rather than caching a
   * `measureInWindow()` result here) is what actually fixes stale-position
   * flights. Both identities stay stable for as long as this component is
   * mounted, which is exactly what's registered below — never a measured
   * value, only the means to measure one whenever a flight needs it.
   */
  const barRef = useAnimatedRef<View>();
  const imageBoxRef = useAnimatedRef<View>();

  const setMiniCartRefs = useFlyToCartStore((state) => state.setMiniCartRefs);

  const latestAddFlightId = useFlyToCartStore(
    (state) => state.latestAddFlightId,
  );
  const landedFlightId = useFlyToCartStore((state) => state.landedFlightId);

  /**
   * Registered once, on mount, and cleared on unmount — `barRef`/
   * `imageBoxRef`'s own identities never change across this component's
   * re-renders (that's `useAnimatedRef`'s whole contract), so there is
   * nothing to re-register when item count, screen, or scroll position
   * change. Those are exactly the cases the OLD `measureInWindow`-based
   * version had to explicitly re-run for — no longer necessary, since a
   * flight now measures fresh on its own instead of reading anything cached
   * here.
   */
  useEffect(() => {
    setMiniCartRefs({ barRef, imageBoxRef });
    return () => setMiniCartRefs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The most recently ADDED distinct product. Cart lines only ever get
   * appended at the tail when a brand-new variant is added — incrementing
   * an existing line's quantity never reorders it (see useCartActions'
   * cart selector) — so `items[items.length - 1]` is exactly "the latest
   * product" for seeding the slot on mount (see the lazy useState
   * initializer below), and for the removed-item fallback right below.
   * Every ADD updates the displayed image through the flight id system
   * further down instead of through re-reading this on every render.
   */
  const latestItem = items[items.length - 1] ?? null;

  /**
   * TWO-LAYER IMAGE SLOT.
   *
   * Why a single `<Image source={{ uri }}>` (the previous approach) could
   * still blink even with `Image.prefetch()` + waiting for the FLYING
   * dot's own `onLoad`: `Image.prefetch()` only proves expo-image's SHARED
   * cache has the bytes decoded somewhere — it says nothing about THIS
   * PARTICULAR native `<Image>` VIEW. The real slot below is a completely
   * separate mounted component from the flying dot in flyToCart.tsx; the
   * instant `source` on it changes from A's uri to B's, THAT view still
   * has to go through its own native attach/decode/paint cycle for B,
   * regardless of how "ready" B supposedly was elsewhere. On a slow
   * device/frame, that's a real (if brief) gap where the view has already
   * dropped A but hasn't painted B yet — the reported blink.
   *
   * The fix: never let the VISIBLE `<Image>`'s own `source` change at all.
   * Two `<Image>` layers are permanently mounted here, stacked exactly on
   * top of each other (see `imageLayer` below) — `slots[0]` and `slots[1]`
   * — and `frontIndex` (below) says which one is currently OPAQUE
   * (visible) vs fully transparent (hidden). A new product is written into
   * whichever slot ISN'T currently front — that slot's OWN `<Image>` loads
   * it in the background, invisible — and only that SAME view's own
   * `onLoad`/`onError` (see the JSX below) flips `frontIndex` to reveal
   * it. The previously-front slot doesn't disappear until that exact
   * moment; it just becomes the new hidden slot, still holding whatever
   * it last showed, ready to receive the NEXT product. Neither `<Image>`
   * ever remounts or has its `source` swapped out from under itself while
   * visible — only their SHARED opacity/z-index role toggles.
   */
  interface Slot {
    /** Identifies which WRITE to this slot this is — compared inside its
     * own onLoad/onError (see the JSX below) against
     * `latestRequestedTokenRef` so a load event for an image this slot has
     * since moved on from (a newer product overwrote it before this one
     * finished) can never wrongly promote stale content to front. */
    token: number;
    imageUrl: string | null;
    variantId: string | null;
  }

  const [slots, setSlots] = useState<[Slot, Slot]>(() => [
    {
      token: 0,
      imageUrl: latestItem?.imageUrl ?? null,
      variantId: latestItem?.variantId ?? null,
    },
    { token: -1, imageUrl: null, variantId: null },
  ]);
  const [frontIndex, setFrontIndex] = useState<0 | 1>(0);
  // Mirrors `frontIndex` synchronously for `requestDisplay` below — it
  // needs "which slot is the hidden BACK one" at the exact instant it's
  // called, which React's own (batched, next-render) state can't
  // guarantee already reflects a promotion from earlier in the same tick.
  const frontIndexRef = useRef<0 | 1>(0);

  const nextTokenRef = useRef(1);
  const latestRequestedTokenRef = useRef(0);

  const frontSlot = slots[frontIndex];

  /**
   * Writes a new candidate product into the current BACK slot and arms it
   * to become front the moment ITS OWN `<Image>` (see the JSX below)
   * confirms it actually loaded — never before, never on a guess. A no-op
   * if this is already what's showing.
   *
   * The variantId check (not a url-string comparison) is deliberate: the
   * OPTIMISTIC line (ProductCard's own snapshot) and the eventual
   * server-confirmed line can legitimately resolve to two DIFFERENT url
   * strings for the exact same product (the client's own fallback chain
   * isn't identical to the backend's) — comparing by url alone would
   * treat that as a genuinely new product and run it through a pointless
   * swap for an image that's visually identical.
   */
  const requestDisplay = (imageUrl: string | null, variantId: string | null) => {
    if (variantId !== null && variantId === frontSlot.variantId) return;

    const backIndex: 0 | 1 = frontIndexRef.current === 0 ? 1 : 0;
    const token = nextTokenRef.current++;
    latestRequestedTokenRef.current = token;

    setSlots((prev) => {
      const next = [...prev] as [Slot, Slot];
      next[backIndex] = { token, imageUrl, variantId };
      return next;
    });

    // No image at all (e.g. a product with no thumbnail) — there is no
    // `<Image>`/`onLoad` to wait for (the JSX below renders the plain
    // placeholder View instead in that case), so promote immediately.
    if (!resolveImageUrl(imageUrl)) {
      promote(backIndex, token);
    }
  };

  /**
   * Makes `index`'s slot the visible one — but ONLY if `token` still
   * matches the most recently REQUESTED write for it (see
   * `latestRequestedTokenRef` above). Safe to call for the ALREADY-front
   * slot too (its own steady-state `onLoad` calls this too) — promoting a
   * slot to the role it already holds is a harmless no-op.
   */
  const promote = (index: 0 | 1, token: number) => {
    if (latestRequestedTokenRef.current !== token) return;
    frontIndexRef.current = index;
    setFrontIndex(index);
  };

  /**
   * If the product currently shown in the slot is the one that was just
   * removed from the cart entirely (its line no longer appears in
   * `items`), swap to another remaining item's image instead of
   * continuing to display a product that's no longer in the cart. Fires
   * ONLY in that case — removing a DIFFERENT product never touches the
   * front slot. `items` here is already the optimistic list (see
   * useCartActions' `optimisticCart`), so this reacts the instant a
   * removal is tapped, not once the network confirms it. Deliberately
   * independent of the remove-flight animation in flyToCart.tsx — that's
   * a separate, purely visual flight and stays completely untouched by
   * this.
   */
  useEffect(() => {
    if (frontSlot.variantId === null) return;
    if (items.some((item) => item.variantId === frontSlot.variantId)) return;

    const fallback = items[items.length - 1] ?? null;
    requestDisplay(fallback?.imageUrl ?? null, fallback?.variantId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, frontSlot.variantId]);

  /**
   * Which flight's image has already been requested, if any — guards
   * against applying the same reveal twice (once from the landing effect,
   * once from the safety-timeout racing it).
   */
  const appliedFlightIdRef = useRef<number | null>(null);

  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevealTimeout = () => {
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
  };

  const applyReveal = (
    flightId: number,
    imageUrl: string | null,
    variantId: string | null,
  ) => {
    if (appliedFlightIdRef.current === flightId) return;
    appliedFlightIdRef.current = flightId;
    requestDisplay(imageUrl, variantId);
  };

  const prevLatestAddFlightIdRef = useRef(latestAddFlightId);

  /**
   * A NEW add flight was just REQUESTED (flyToCart() was actually called —
   * see flyToCart.tsx). Arms a safety-net timeout in case its landing
   * signal is ever lost. Does NOT touch the front slot itself — it keeps
   * showing whatever it already was until a landing (or this timeout)
   * confirms the swap, exactly matching "Mini Cart image only changes
   * according to the latest-added logic," never a guess.
   */
  useEffect(() => {
    if (latestAddFlightId === prevLatestAddFlightIdRef.current) return;
    prevLatestAddFlightIdRef.current = latestAddFlightId;

    if (latestAddFlightId === null) return;

    const thisFlightId = latestAddFlightId;

    clearRevealTimeout();
    revealTimeoutRef.current = setTimeout(() => {
      revealTimeoutRef.current = null;

      // Only force-reveal if THIS flight is still the latest one
      // requested — a superseded flight (a newer add already started) is
      // simply dropped, never allowed to overwrite a fresher image.
      const store = useFlyToCartStore.getState();
      if (store.latestAddFlightId === thisFlightId) {
        applyReveal(
          thisFlightId,
          store.latestAddImageUrl,
          store.latestAddVariantId,
        );
      }
    }, ADD_DURATION + REVEAL_SAFETY_MARGIN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestAddFlightId]);

  const prevLandedFlightIdRef = useRef(landedFlightId);

  /**
   * A flyToCart() flight just reported landing (see flyToCart.tsx's
   * onDone) — reveal ONLY if it's still the CURRENT latest requested add.
   * An older flight landing late (rapid adds, jittery JS-thread
   * scheduling) is ignored outright: it can never overwrite a newer
   * image, whether or not that newer one has landed yet.
   *
   * Applied DURING RENDER, deliberately NOT inside a `useEffect` — this is
   * React's own documented pattern for syncing state to a change in the
   * SAME commit (see "You Might Not Need an Effect" / adjusting state
   * when a prop changes). `onDone` (flyToCart.tsx) sets `landedFlightId`
   * AND removes the flying dot from `FlyToCartOverlay`'s own state in the
   * same synchronous call, so both updates land in the same React batch —
   * but an EFFECT here would still only run AFTER that batch's commit had
   * already painted, meaning the slot was visibly still showing the OLD
   * image for one full frame right after the dot landed on top of it and
   * disappeared: a flash back to the old image before snapping to the
   * new one. That flash was the reported blink. Reading and reacting to
   * `landedFlightId` here instead makes React redo this render with the
   * new image BEFORE committing anything, so the dot's disappearance and
   * the slot's new image reach the screen in the exact same paint.
   */
  if (landedFlightId !== prevLandedFlightIdRef.current) {
    prevLandedFlightIdRef.current = landedFlightId;

    if (landedFlightId !== null && landedFlightId === latestAddFlightId) {
      clearRevealTimeout();
      const store = useFlyToCartStore.getState();
      applyReveal(landedFlightId, store.latestAddImageUrl, store.latestAddVariantId);
    }
  }

  useEffect(() => {
    return () => clearRevealTimeout();
  }, []);

  if (itemCount === 0) {
    return null;
  }

  const slotAUri = resolveImageUrl(slots[0].imageUrl);
  const slotBUri = resolveImageUrl(slots[1].imageUrl);

  return (
    <ReanimatedAnimated.View
      ref={barRef}
      collapsable={false}
      pointerEvents="box-none"
      entering={barEntering}
      exiting={barExiting}
    >
      <Pressable
        style={styles.bar}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Go to cart, ${itemCount} item${
          itemCount === 1 ? "" : "s"
        }`}
      >
        <View
          ref={imageBoxRef}
          collapsable={false}
          style={styles.imageBox}
        >
          {/* SLOT A and SLOT B — two permanently mounted layers, stacked
              exactly on top of each other (`imageLayer` is an absolute
              fill of this 28x28 box). Neither ever remounts and neither's
              `source` ever changes while it's the visible one — see the
              `Slot`/`requestDisplay`/`promote` architecture note above for
              why that's the actual fix. Which one is on top is purely
              `opacity`/`zIndex`, toggled by `frontIndex`; both stay
              mounted always so the hidden one can keep loading the next
              candidate without ever being torn down and rebuilt. */}
          <View
            pointerEvents="none"
            style={[
              styles.imageLayer,
              { opacity: frontIndex === 0 ? 1 : 0, zIndex: frontIndex === 0 ? 1 : 0 },
            ]}
          >
            {slotAUri ? (
              <Image
                source={{ uri: slotAUri }}
                style={styles.image}
                contentFit="cover"
                cachePolicy="memory-disk"
                onLoad={() => promote(0, slots[0].token)}
                onError={() => promote(0, slots[0].token)}
              />
            ) : (
              <View style={styles.imagePlaceholder} />
            )}
          </View>

          <View
            pointerEvents="none"
            style={[
              styles.imageLayer,
              { opacity: frontIndex === 1 ? 1 : 0, zIndex: frontIndex === 1 ? 1 : 0 },
            ]}
          >
            {slotBUri ? (
              <Image
                source={{ uri: slotBUri }}
                style={styles.image}
                contentFit="cover"
                cachePolicy="memory-disk"
                onLoad={() => promote(1, slots[1].token)}
                onError={() => promote(1, slots[1].token)}
              />
            ) : (
              <View style={styles.imagePlaceholder} />
            )}
          </View>
        </View>

        <View style={styles.textBlock}>
          <AppText
            variant="bodyStrong"
            color={MINI_CART_FG}
            numberOfLines={1}
            style={styles.cartLabel}
          >
            Cart
          </AppText>

          <AppText
            variant="caption"
            color={MINI_CART_FG}
            numberOfLines={1}
            style={styles.itemsLabel}
          >
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </AppText>
        </View>
      </Pressable>
    </ReanimatedAnimated.View>
  );
}

export default function MiniCartOverlay() {
  const insets = useSafeAreaInsets();

  const cart = useCartActions();

  const screen = useMiniCartScreen((state) => state.screen);

  const barHeight = layout.tabBarHeight + insets.bottom;

  /**
   * Mini Cart follows the bottom/tab-bar position.
   *
   * This animation is independent of the thumbnail animation.
   *
   * `styles.overlayWrap`'s own `bottom` is a CONSTANT (`BOTTOM_GAP`) — this
   * only ever animates `transform: translateY`, shifting the whole card
   * UP off that fixed resting line by however much room the tab bar (or
   * Product Detail's footer) currently needs. Same reasoning as
   * AnimatedTabBar's own fix (see MainTabs.tsx): a transform never touches
   * layout, so this can never itself be the cause of anything else on
   * screen moving, no matter how often `restingOn` changes underneath it.
   */
  const positionStyle = useAnimatedStyle(() => {
    let restingOn: number;

    if (screen === "productDetail") {
      restingOn = productDetailFooterHeight.value || barHeight;
    } else if (screen === "categories") {
      restingOn = barHeight;
    } else {
      // Even with the tab bar fully hidden (scrolled down on Home), still
      // lift clear of the device's own safe-area inset (gesture-nav bar /
      // home indicator) — this used to drop all the way to `0` here, so the
      // card's only clearance from the true screen bottom was
      // `BOTTOM_GAP` alone with no `insets.bottom` at all, unlike the
      // tab-bar-visible case above (`barHeight` already bakes it in). On a
      // gesture-nav device that read as sitting right on top of the system
      // bar — too low.
      restingOn = tabBarHiddenByScroll.value ? insets.bottom : barHeight;
    }

    return {
      transform: [
        {
          translateY: withTiming(-restingOn, {
            duration: FOLLOW_DURATION,
            easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
          }),
        },
      ],
    };
  }, [screen, barHeight, insets.bottom]);

  if (screen === "none") {
    return null;
  }

  const items = cart.cart?.items ?? [];

  const itemCount = cart.cart?.bill.itemCount ?? 0;

  return (
    <ReanimatedAnimated.View
      pointerEvents="box-none"
      style={[styles.overlayWrap, positionStyle]}
    >
      <MiniCartPill
        items={items}
        itemCount={itemCount}
        screen={screen}
        onPress={navigateToCart}
      />
    </ReanimatedAnimated.View>
  );
}

const styles = StyleSheet.create({
  overlayWrap: {
    position: "absolute",

    // Flush against the screen's right edge — no margin, no safe-area
    // spacing, no `left` (the wrapper hugs the card's own intrinsic width).
    right: 0,
    
    // The one constant resting line — `positionStyle`'s `translateY` moves
    // the card UP from here, it never changes this itself (see that
    // style's own comment).
    bottom: BOTTOM_GAP,
  },

  bar: {
    flexDirection: "row",
    alignItems: "center",

    gap: spacing.sm,

    height: 56,

    paddingHorizontal: spacing.sm,
    paddingRight: spacing.base,

    // Right edge touches the screen edge, so only the left corners round.
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,

    backgroundColor: MINI_CART_BG,

    ...shadow.lg,
  },

  imageBox: {
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,

    borderRadius: radius.sm,

    backgroundColor: colors.surface,

    alignItems: "center",
    justifyContent: "center",

    overflow: "hidden",
  },

  // One of the two stacked slot layers inside `imageBox` — absolutely
  // fills it (same 28x28 bounds `imageBox` itself defines) so both layers
  // sit pixel-for-pixel on top of each other regardless of which is
  // currently visible. See the `Slot`/`requestDisplay` architecture note
  // above `MiniCartPill`'s own state for why there are two of these.
  imageLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },

  image: {
    width: "100%",
    height: "100%",
  },

  imagePlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: colors.skeleton,
  },

  textBlock: {
    alignItems: "flex-start",
  },

  cartLabel: {
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  itemsLabel: {
    opacity: 0.85,
    fontWeight: "700",
    letterSpacing: 0.1,
  },
});

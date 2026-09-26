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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
   * TWO-LAYER IMAGE SLOT, with an explicit READY + LANDED dual gate.
   *
   * `slots[0]`/`slots[1]` are two permanently mounted `<Image>` layers
   * (see the JSX below), stacked exactly on top of each other — never
   * remounted, never key'd by product/quantity/anything that changes.
   * `frontIndex` says which one is opaque (visible) vs fully transparent
   * (hidden). A new product is written into whichever slot ISN'T front;
   * that slot's own `<Image>` loads it in the background, invisible.
   *
   * A slot becoming the visible one — a PROMOTION — requires BOTH of:
   *
   *   pendingReadyRef.current  — the BACK slot's own `<Image>` has fired
   *                              its own onLoad/onError (see `markReady`).
   *   pendingLandedRef.current — the flying dot has actually finished its
   *                              drop onto the Mini Cart (see `markLanded`)
   *                              — or, for the removed-item fallback below
   *                              (which has no flight of its own), this is
   *                              simply always true.
   *
   * Loading is kicked off at flight START now (`latestAddFlightId`
   * changing), not at landing — the back slot gets the image's FULL
   * ~160ms flight time to load, not just whatever's left once it lands.
   * That's exactly why the dual gate is needed: without it, a fast-
   * loading (e.g. already-cached) image could become ready WHILE the
   * flying dot is still mid-air, and promoting it then would show the
   * product in the real slot before its own flying copy has visually
   * arrived — `pendingLandedRef` holds that back regardless of how early
   * `pendingReadyRef` turns true.
   *
   * `pendingTokenRef`/`pendingFlightIdRef` correlate a `markReady`/
   * `markLanded` call back to the SPECIFIC transition it belongs to — a
   * rapid A -> B -> C means B's own onLoad (or B's flight landing) can
   * still arrive AFTER C has already superseded it in the back slot;
   * both checks bail out immediately if the token/flightId they're
   * holding no longer matches what's currently pending.
   *
   * Every mutation of these refs, and every `setSlots`/`setFrontIndex`
   * call, happens from a proper effect or a native event callback
   * (`useEffect`/`useLayoutEffect`/`setTimeout`/`onLoad`/`onError`) —
   * NEVER during render. An earlier version called this logic directly
   * from the render body (piggybacking on `landedFlightId` changing) to
   * dodge an extra frame; that's no longer necessary architecturally,
   * because the FRONT slot is never touched until an explicit promotion
   * either way — so there's nothing for a "one frame late" effect to be
   * late FOR. The visible slot only ever changes at the exact moment
   * `maybePromote` runs, whether that's triggered synchronously-ish from
   * a `useLayoutEffect` (landing) or from a native `onLoad` callback
   * (ready) — both are proper effect/event contexts, and in both cases
   * the OLD image was never removed in between, so there is no
   * intermediate frame to leak either way.
   */
  interface Slot {
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
  // Mirrors `frontIndex` for `requestDisplay` below, which needs "which
  // slot is the hidden BACK one" — always read via the ref (never the
  // `frontIndex` state closure), since `requestDisplay` is called from
  // effects/callbacks that may run after several renders have passed
  // since their own closure was created.
  const frontIndexRef = useRef<0 | 1>(0);

  const nextTokenRef = useRef(1);

  const pendingTokenRef = useRef<number | null>(null);
  const pendingSlotIndexRef = useRef<0 | 1 | null>(null);
  const pendingFlightIdRef = useRef<number | null>(null);
  const pendingReadyRef = useRef(false);
  const pendingLandedRef = useRef(false);

  const frontSlot = slots[frontIndex];

  // Promotes the pending back slot to front — but only once BOTH gates
  // (see this whole block's own comment above) are satisfied for the
  // SAME still-current transition.
  const maybePromote = (token: number) => {
    if (pendingTokenRef.current !== token) return;
    if (!pendingReadyRef.current || !pendingLandedRef.current) return;

    const index = pendingSlotIndexRef.current;
    if (index === null) return;

    frontIndexRef.current = index;
    setFrontIndex(index);

    pendingTokenRef.current = null;
    pendingSlotIndexRef.current = null;
    pendingFlightIdRef.current = null;
  };

  /**
   * Writes a new candidate product into the current BACK slot and starts
   * it loading. A no-op if this is already what's showing — the variantId
   * check (not a url-string comparison) is deliberate: the OPTIMISTIC
   * line (ProductCard's own snapshot) and the eventual server-confirmed
   * line can legitimately resolve to two DIFFERENT url strings for the
   * exact same product, so comparing by url alone would treat that as a
   * genuinely new product and run it through a pointless swap.
   *
   * `flightId`/`waitForLanding` belong only to ADD flights. REMOVE never
   * calls this function; it directly updates the current front slot.
   */
  const requestDisplay = (
    imageUrl: string | null,
    variantId: string | null,
    options: { flightId?: number; waitForLanding?: boolean } = {},
  ) => {
    // For a real add flight, even if the same product is already visible
    // (quantity re-increment), we still need to register the flight so the
    // landing signal stays synchronized with the flying image. For non-flight
    // fallbacks, the same-product request is still a no-op.
    if (
      variantId !== null &&
      variantId === frontSlot.variantId &&
      options.flightId == null
    ) {
      return;
    }

    const backIndex: 0 | 1 = frontIndexRef.current === 0 ? 1 : 0;
    const token = nextTokenRef.current++;

    pendingTokenRef.current = token;
    pendingSlotIndexRef.current = backIndex;
    pendingFlightIdRef.current = options.flightId ?? null;
    // No image at all (e.g. a product with no thumbnail) — there's no
    // `<Image>`/`onLoad` to wait for (the JSX below renders the plain
    // placeholder View instead in that case), so this gate starts open.
    pendingReadyRef.current = !resolveImageUrl(imageUrl);
    pendingLandedRef.current = !options.waitForLanding;

    setSlots((prev) => {
      const next = [...prev] as [Slot, Slot];
      next[backIndex] = { token, imageUrl, variantId };
      return next;
    });

    maybePromote(token);
  };

  // The back slot's own `<Image>` (see the JSX below) has fired its own
  // onLoad/onError — i.e. genuinely painted, not merely prefetched.
  const markReady = (token: number) => {
    if (pendingTokenRef.current !== token) return;
    pendingReadyRef.current = true;
    maybePromote(token);
  };

  // The flying dot has landed (or the safety timeout below is recovering
  // from a lost landing signal) for the flight this pending transition is
  // waiting on.
  const markLanded = (flightId: number) => {
    if (pendingFlightIdRef.current !== flightId) return;
    const token = pendingTokenRef.current;
    if (token === null) return;
    pendingLandedRef.current = true;
    maybePromote(token);
  };

  /**
   * REMOVE HANDOFF — intentionally independent from ADD.
   *
   * When the currently displayed product is removed, the optimistic cart
   * already contains the remaining items. Switch the FRONT slot immediately.
   *
   * REMOVE must never wait for image onLoad, a flying-dot completion, or the
   * ADD reveal timeout. Any unfinished ADD transition is invalidated first,
   * so stale onLoad/landing callbacks cannot bring the removed product back.
   */
  useEffect(() => {
    if (frontSlot.variantId === null) return;
    if (items.some((item) => item.variantId === frontSlot.variantId)) return;

    // Cancel any unfinished ADD reveal for the product being removed.
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }

    pendingTokenRef.current = null;
    pendingSlotIndexRef.current = null;
    pendingFlightIdRef.current = null;
    pendingReadyRef.current = false;
    pendingLandedRef.current = false;

    const fallback = items[items.length - 1] ?? null;
    const index = frontIndexRef.current;
    const token = nextTokenRef.current++;

    // REMOVE is immediate. Do not send the fallback through requestDisplay(),
    // because that function is intentionally gated for ADD handoffs.
    setSlots((prev) => {
      const next = [...prev] as [Slot, Slot];
      next[index] = {
        token,
        imageUrl: fallback?.imageUrl ?? null,
        variantId: fallback?.variantId ?? null,
      };
      return next;
    });

    // Keep the other slot untouched so the next ADD can reuse it without
    // introducing a blank frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, frontSlot.variantId]);

  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRevealTimeout = () => {
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
  };

  const prevLatestAddFlightIdRef = useRef(latestAddFlightId);

  /**
   * A NEW add flight was just REQUESTED (flyToCart() was actually called
   * — see flyToCart.tsx). Starts loading its image into the back slot
   * RIGHT NOW — not once it lands — so it has the flight's full duration
   * to finish rather than whatever's left after landing (see this
   * section's own architecture comment above for why the ready+landed
   * dual gate is what makes starting this early safe). Also arms a
   * safety-net timeout purely to recover from a LOST landing signal —
   * `markLanded` still requires `pendingReadyRef` too, so this can never
   * bypass image readiness, only stand in for a missing landing event.
   */
  useEffect(() => {
    if (latestAddFlightId === prevLatestAddFlightIdRef.current) return;
    prevLatestAddFlightIdRef.current = latestAddFlightId;

    if (latestAddFlightId === null) return;

    const thisFlightId = latestAddFlightId;
    const store = useFlyToCartStore.getState();

    requestDisplay(store.latestAddImageUrl, store.latestAddVariantId, {
      flightId: thisFlightId,
      waitForLanding: true,
    });

    clearRevealTimeout();
    revealTimeoutRef.current = setTimeout(() => {
      revealTimeoutRef.current = null;

      // Only recover if THIS flight is still the latest one requested —
      // a superseded flight (a newer add already started) is simply
      // dropped, never allowed to overwrite a fresher image.
      if (useFlyToCartStore.getState().latestAddFlightId === thisFlightId) {
        markLanded(thisFlightId);
      }
    }, ADD_DURATION + REVEAL_SAFETY_MARGIN);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestAddFlightId]);

  /**
   * A flyToCart() flight just reported landing (see flyToCart.tsx's
   * onDone) — `useLayoutEffect`, not a regular `useEffect`: it still runs
   * before the screen actually paints (same reasoning flyToCart.tsx's own
   * `FlightDot` already uses `useLayoutEffect` for), so there's no extra
   * visible frame versus reacting during render — but it's a genuine
   * effect, not a state update piggybacked onto the render body. Safe
   * here specifically because `markLanded` never touches the FRONT slot
   * directly — it only ever flips one of the two gates a promotion
   * needs, so there's no "old image was already removed" state for a
   * one-tick-later effect to be too slow to prevent.
   */
  useLayoutEffect(() => {
    if (landedFlightId === null) return;
    // An older flight landing late (rapid adds, jittery JS-thread
    // scheduling) is ignored outright — it can never overwrite a newer
    // image, whether or not that newer one has landed yet.
    if (landedFlightId !== latestAddFlightId) return;

    clearRevealTimeout();
    markLanded(landedFlightId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedFlightId]);

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
        <View ref={imageBoxRef} collapsable={false} style={styles.imageBox}>
          {/* SLOT A and SLOT B — two permanently mounted layers, stacked
              exactly on top of each other (`imageLayer` is an absolute
              fill of this 28x28 box). Neither ever remounts. BOTH layers
              remain fully opaque; only zIndex changes which already-painted
              image is on top. This is intentional: changing opacity on the
              two layers during the landing handoff can expose a compositor
              blank frame, which is the thumbnail blink we are eliminating. */}
          <View
            pointerEvents="none"
            style={[
              styles.imageLayer,
              {
                // NEVER fade the currently visible image out.
                // Both layers stay fully opaque; zIndex alone decides which
                // already-painted image is on top. This avoids the native
                // compositor blank-frame that can happen when opacity 0 -> 1
                // and zIndex change together during the landing handoff.
                opacity: 1,
                zIndex: frontIndex === 0 ? 2 : 1,
              },
            ]}
          >
            {slotAUri ? (
              <Image
                source={{ uri: slotAUri }}
                style={styles.image}
                contentFit="cover"
                cachePolicy="memory-disk"
                onLoad={() => markReady(slots[0].token)}
                onError={() => markReady(slots[0].token)}
              />
            ) : (
              <View style={styles.imagePlaceholder} />
            )}
          </View>

          <View
            pointerEvents="none"
            style={[
              styles.imageLayer,
              {
                // Keep this layer painted as well. It stays underneath the
                // current front image until maybePromote() makes it the top
                // layer after BOTH ready + landed gates are satisfied.
                opacity: 1,
                zIndex: frontIndex === 1 ? 2 : 1,
              },
            ]}
          >
            {slotBUri ? (
              <Image
                source={{ uri: slotBUri }}
                style={styles.image}
                contentFit="cover"
                cachePolicy="memory-disk"
                onLoad={() => markReady(slots[1].token)}
                onError={() => markReady(slots[1].token)}
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

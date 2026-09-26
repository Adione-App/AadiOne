/**
 * Mini-cart product drop animation.
 *
 * ADD:
 * - The product image appears just above the Mini Cart's own top edge.
 * - It drops a short distance down into the single thumbnail slot.
 * - It does NOT fly from the product card.
 * - It does NOT fly from the top of the screen.
 * - It does NOT travel across the screen.
 *
 * The real thumbnail in MiniCartBar stays showing whatever it already was
 * until this drop actually lands — see `latestAddFlightId` /
 * `latestAddImageUrl` / `landedFlightId` below, which is how the two
 * separate components (this overlay, mounted at the app root, and
 * MiniCartBar, mounted in the tab navigator) stay in sync without a direct
 * callback between them, and how a stale/superseded flight's landing can
 * never overwrite a newer one (see the fields' own doc comments).
 *
 * If flyToCart() is called before the Mini Cart even EXISTS to measure
 * (e.g. the very first item going into an empty cart — MiniCartBar doesn't
 * mount at all until the cart is non-empty), the flight is queued and
 * started the moment it becomes measurable instead of being dropped
 * silently — see `miniCartRefs`/`queuedAdds` below.
 *
 * POSITION — NEVER CACHED, ALWAYS LIVE:
 * MiniCartBar can move at any time (scroll-driven tab-bar hide/show,
 * Product Detail's footer height, screen changes), and it moves via a
 * Reanimated `transform`, not a layout change — see MiniCartBar.tsx's
 * `positionStyle`. An earlier version of this file had MiniCartBar
 * `measureInWindow()` itself into a Zustand-cached `{ x, y, width, height }`
 * rect, re-measured on a timer after each move "settled." That was the
 * actual bug: `measureInWindow` (JS-thread/bridge) doesn't reliably reflect
 * a Reanimated UI-thread transform, so MiniCartBar had to wait out a
 * settle delay before re-measuring at all — meaning ANY flight requested
 * during that window (e.g. adding an item while mid-scroll, exactly when
 * the Mini Cart is moving) animated toward wherever the Mini Cart USED TO
 * be, not where it actually was or was about to be.
 *
 * The fix: MiniCartBar registers a stable Reanimated `AnimatedRef` (via
 * `useAnimatedRef`) for its own card and thumbnail slot once, on mount —
 * see `miniCartRefs` below — and every flight calls Reanimated's `measure()`
 * on those refs itself, EVERY FRAME, for the flight's entire duration (see
 * `FlightDot`'s `useAnimatedStyle`). `measure()` runs on the UI thread and
 * reads the view's actual current rendered geometry, transform included, so
 * there is no position to go stale: if the Mini Cart is moving while a
 * flight is playing, the flight's start/end points move with it, in real
 * time, on every single frame — never a cached number from before.
 *
 * REMOVE:
 * flyFromCart() is called from useCartActions.ts's `decrement`/`remove`,
 * synchronously and immediately when a line is actually emptied — before
 * their async cart-mutation dispatch, so the visual never waits on the
 * network. MiniCartBar's own displayed image is untouched by removal (it
 * only ever changes on a new add); this is a separate, temporary flight.
 *
 * The actual cart state is handled independently by useCartActions.
 * This file is purely responsible for the visual animation, and that
 * animation is driven end-to-end by Reanimated (`useSharedValue` /
 * `useAnimatedStyle` / `useAnimatedRef` / `measure` / `withTiming` /
 * `runOnJS`) — never React Native's classic `Animated` API, and never
 * React Native's own `measureInWindow`/`measure` view methods either (see
 * above for why those specifically don't work here).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { create } from "zustand";
import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  interpolate,
  measure,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedRef,
} from "react-native-reanimated";
import { runOnJS } from "react-native-worklets";

import { colors, radius } from "@shared/theme";

/**
 * The live Reanimated refs MiniCartBar registers for its own card (whole
 * pill — its top edge is what an ADD flight drops from) and its thumbnail
 * slot (what every flight's dot sizes/lands itself to). Both refs are
 * STABLE object identities for as long as MiniCartBar stays mounted
 * (`useAnimatedRef()` never changes identity across its owner's re-renders)
 * — what changes from frame to frame is what `measure()` returns for them,
 * never the refs themselves, which is exactly why holding onto these
 * (rather than a measured rect) is what makes "always current position"
 * possible at all.
 */
export interface MiniCartRefs {
  barRef: AnimatedRef<View>;
  imageBoxRef: AnimatedRef<View>;
}

interface FlyToCartStore {
  /**
   * Set once by MiniCartBar on mount, cleared on unmount — `null` exactly
   * when there is currently no Mini Cart to fly toward (empty cart). Never
   * holds a measured position, only the means to measure one on demand.
   */
  miniCartRefs: MiniCartRefs | null;
  setMiniCartRefs: (refs: MiniCartRefs | null) => void;

  /**
   * The most recently REQUESTED add flight's id and its own immutable
   * image/variant, set together, atomically, the instant flyToCart() is
   * called — before the flight even necessarily starts (it may still be
   * queued). This is the single source of truth for "what SHOULD the Mini
   * Cart be showing once every in-flight add has settled."
   *
   * `latestAddVariantId` exists purely as a STABLE IDENTITY for MiniCartBar
   * to track "which product is currently displayed" by — never read by the
   * animation itself. The image URL alone isn't reliable for that: the
   * OPTIMISTIC line (from ProductCard's snapshot, shown before the server
   * confirms) and the eventual server-confirmed line can legitimately
   * resolve to two DIFFERENT url strings for the exact same product (the
   * client's own fallback chain isn't identical to the backend's), so
   * comparing by url briefly looked like "the displayed product was
   * removed" the instant the server response landed — see MiniCartBar.tsx's
   * `displayedVariantId` for the actual fix this enables.
   */
  latestAddFlightId: number | null;
  latestAddImageUrl: string | null;
  latestAddVariantId: string | null;

  /**
   * The id of whichever add flight most recently reported landing (see
   * `onDone` in FlyToCartOverlay below). MiniCartBar reveals its pending
   * image ONLY when this equals `latestAddFlightId` — an older flight
   * landing late (rapid adds, jittery JS-thread scheduling) is otherwise
   * ignored outright, so it can never overwrite a newer image, landed or
   * not. This is what makes "an older animation completion must never
   * overwrite the latest Mini Cart image" a guarantee rather than a
   * side-effect of timing.
   */
  landedFlightId: number | null;
}

export const useFlyToCartStore = create<FlyToCartStore>((set) => ({
  miniCartRefs: null,
  latestAddFlightId: null,
  latestAddImageUrl: null,
  latestAddVariantId: null,
  landedFlightId: null,

  setMiniCartRefs: (refs) => {
    set({ miniCartRefs: refs });
    if (refs) flushQueuedAdds();
  },
}));

type FlightKind = "add" | "remove";

interface Flight {
  id: number;
  kind: FlightKind;
  imageUrl: string | null;
}

let nextFlightId = 0;

let onFlight: ((flight: Flight) => void) | null = null;

/**
 * Adds requested before the Mini Cart's position has been fully measured
 * (`miniCartRefs` still `null` — the Mini Cart doesn't exist yet to measure
 * anything). Flushed by `flushQueuedAdds()` once a mounted MiniCartBar has
 * registered its refs AND a mounted overlay (`onFlight`) is listening.
 * Each entry keeps the `id` reserved for it by flyToCart() at call time, so
 * `latestAddFlightId` is correct even while still queued.
 */
let queuedAdds: Array<{ id: number; imageUrl: string | null }> = [];

function startAddFlight(id: number, imageUrl: string | null) {
  onFlight?.({
    id,
    kind: "add",
    imageUrl,
  });
}

function flushQueuedAdds() {
  const state = useFlyToCartStore.getState();

  if (!state.miniCartRefs || !onFlight || queuedAdds.length === 0) {
    return;
  }

  const toStart = queuedAdds;
  queuedAdds = [];

  toStart.forEach(({ id, imageUrl }) => startAddFlight(id, imageUrl));
}

/**
 * Called when a product is added to cart (or an already-in-cart line is
 * incremented).
 *
 * `variantId` is NOT used by the flight/animation at all — it exists purely
 * so `latestAddVariantId` (see the store above) can carry a stable identity
 * through to MiniCartBar's reveal, alongside the image. It never touches
 * `queuedAdds`/`Flight`/`FlightDot` below, none of which need it.
 *
 * This never reads or caches a position itself — it only checks WHETHER a
 * Mini Cart currently exists to fly toward (`miniCartRefs`). The actual
 * position is measured fresh, every frame, by `FlightDot` itself once the
 * flight starts (see the file header and `FlightDot`'s `useAnimatedStyle`).
 */
export function flyToCart(imageUrl: string | null, variantId: string): void {
  // Fire-and-forget: gives a cold cache the earliest possible head start.
  // Usually a no-op in practice — the same URL was almost always already
  // loaded into expo-image's shared memory cache by whatever product card
  // or gallery is already showing it on screen, which is what actually
  // makes the flying image render instantly (see FlightDot's own <Image>,
  // also expo-image, with the same `cachePolicy`).
  if (imageUrl) {
    Image.prefetch(imageUrl).catch(() => undefined);
  }

  // Reserve this flight's id and record it as "the latest requested add"
  // IMMEDIATELY, synchronously — before anything else, including before
  // it's known whether the flight can start right away or must queue.
  // This is what a rapid `Add Apple -> Add Milk -> Add Bread` sequence
  // relies on: each call's own id/image/variant triple is captured here,
  // atomically, and nothing downstream can ever read a mix of one flight's
  // id with another's image/variant.
  const flightId = nextFlightId++;

  useFlyToCartStore.setState({
    latestAddFlightId: flightId,
    latestAddImageUrl: imageUrl,
    latestAddVariantId: variantId,
  });

  const state = useFlyToCartStore.getState();

  if (!state.miniCartRefs || !onFlight) {
    queuedAdds.push({ id: flightId, imageUrl });
    return;
  }

  startAddFlight(flightId, imageUrl);
}

/**
 * Called when a cart line is completely removed — see useCartActions.ts's
 * `decrement`/`remove`, which capture the removed line's own image and call
 * this synchronously, before their async cart-mutation dispatch.
 */
export function flyFromCart(imageUrl: string | null): void {
  if (imageUrl) {
    Image.prefetch(imageUrl).catch(() => undefined);
  }

  if (!useFlyToCartStore.getState().miniCartRefs || !onFlight) return;

  onFlight({
    id: nextFlightId++,
    kind: "remove",
    imageUrl,
  });
}

/**
 * Keep this value exported because MiniCartBar uses the same duration
 * for the thumbnail handoff's own safety-net timeout.
 */
export const ADD_DURATION = 250;

export const REMOVE_DURATION = 250;

/**
 * Must exactly match MiniCart thumbnail size.
 */
const DOT_SIZE = 28;

/**
 * How far above the Mini Cart's own live top edge the new image starts.
 *
 * This is intentionally SMALL.
 *
 * The image does NOT fly from the product card or screen top.
 * It simply appears slightly above the Mini Cart and drops into it.
 */
const ADD_DROP_DISTANCE = 60;

/**
 * Remove animation distance — same short travel distance as
 * `ADD_DROP_DISTANCE`, just the reverse direction.
 */
export const REMOVE_DISTANCE = 60;

function FlightDot({
  flight,
  refs,
  onDone,
}: {
  flight: Flight;
  refs: MiniCartRefs;
  onDone: () => void;
}) {
  const progress = useSharedValue(0);

  /**
   * `onDone` (and therefore the handoff to MiniCartBar's real slot — see
   * `landedFlightId`) used to fire purely on the drop animation's own
   * timer (160ms), with no regard for whether `flight.imageUrl` had
   * actually finished DECODING yet. An already-cached product (its bitmap
   * long resident in expo-image's memory cache from an earlier add/view)
   * always finishes well inside 160ms, so this never showed up for it —
   * but the FIRST time a given product's image is decoded this session,
   * a disk-cache read or network fetch can genuinely take longer than
   * that, even though `Image.prefetch()` (see `flyToCart()` above) starts
   * it as early as possible. When it did, `onDone` fired on schedule
   * anyway, the dot was removed, and the real slot revealed the SAME
   * still-loading uri — both blank for a few more ms until the decode
   * actually finished and the now-mounted real `<Image>` finally painted:
   * exactly the reported "blank → blink → correct" pattern, a genuine
   * load-latency race, not a remount/key/size bug. Gating on BOTH the
   * animation's own completion AND the image's own `onLoad` (whichever
   * finishes last) means the handoff never happens before the bitmap is
   * actually ready, so there's nothing left to pop in late. A REMOVE
   * flight, or an ADD with no image at all, has nothing to wait for —
   * `imageReadyRef` starts `true` for those, so they behave exactly as
   * before, gated on animation timing alone.
   */
  const animationDoneRef = useRef(false);
  const imageReadyRef = useRef(flight.kind !== "add" || !flight.imageUrl);
  const doneFiredRef = useRef(false);

  const maybeFinish = () => {
    if (doneFiredRef.current) return;
    if (!animationDoneRef.current || !imageReadyRef.current) return;
    doneFiredRef.current = true;
    onDone();
  };

  const handleAnimationDone = () => {
    animationDoneRef.current = true;
    maybeFinish();
  };

  // A failed load must still count as "ready" — otherwise a broken image
  // URL would strand this flight forever: the dot would never be removed
  // (its `onDone` never fires), even though MiniCartBar's own independent
  // safety-timeout would still reveal the real slot regardless.
  const handleImageSettled = () => {
    imageReadyRef.current = true;
    maybeFinish();
  };

  /**
   * The last successful `measure()` result, used ONLY as a same-flight
   * fallback for the rare frame where `measure()` momentarily returns
   * `null` (e.g. right as a REMOVE flight's own Mini Cart is mid-unmount,
   * between React detaching it and Reanimated's `exiting` animation
   * actually finishing). This is NOT the old cross-flight position cache —
   * it's reset fresh per `FlightDot` instance and only ever holds a value
   * `measure()` itself produced a frame or two earlier in this SAME flight.
   */
  const lastGood = useSharedValue<{
    topY: number;
    targetX: number;
    targetY: number;
  } | null>(null);

  /**
   * Reanimated (not React Native's classic `Animated`) drives this value —
   * the same engine MiniCartBar's own entrance/exit animations use. This is
   * the actual fix for the landing handoff: classic
   * `Animated.timing(..., { useNativeDriver: true }).start(cb)` runs the
   * interpolation on the native UI thread, but its JS callback only fires
   * after a bridge round-trip once native reports completion — so the dot
   * was already sitting motionless for a beat before onDone() (and
   * therefore the reveal) ever fired. Reanimated's `withTiming(...,
   * callback)` fires its callback via `runOnJS` straight from the UI
   * thread the instant the animation finishes — low latency, and never
   * mixed with the classic API for this animation.
   */
  useLayoutEffect(() => {
    const duration = flight.kind === "add" ? ADD_DURATION : REMOVE_DURATION;

    const easing = ReanimatedEasing.out(ReanimatedEasing.cubic);

    progress.value = withTiming(1, { duration, easing }, (finished) => {
      "worklet";
      if (finished) {
        runOnJS(handleAnimationDone)();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.id, flight.kind]);

  const isAdd = flight.kind === "add";

  /**
   * Measures the Mini Cart's card + thumbnail slot FRESH, ON THE UI
   * THREAD, on every single frame this flight is on screen — see the file
   * header for why a one-time (or periodically-refreshed) cached position
   * can never be correct here. `measure()` reflects the view's ACTUAL
   * current rendered geometry, including whatever Reanimated `transform`
   * MiniCartBar's own `positionStyle` currently has applied — so if the
   * Mini Cart is moving while this flight plays, `targetY`/`topY` move
   * with it, in the same frame, automatically.
   */
  const animatedStyle = useAnimatedStyle(() => {
    const barMeasurement = measure(refs.barRef);
    const imageBoxMeasurement = measure(refs.imageBoxRef);

    let topY: number;
    let targetX: number;
    let targetY: number;

    if (barMeasurement && imageBoxMeasurement) {
      topY = barMeasurement.pageY;
      targetX =
        imageBoxMeasurement.pageX +
        imageBoxMeasurement.width / 2 -
        DOT_SIZE / 2;
      targetY =
        imageBoxMeasurement.pageY +
        imageBoxMeasurement.height / 2 -
        DOT_SIZE / 2;

      lastGood.value = { topY, targetX, targetY };
    } else if (lastGood.value) {
      // A momentary miss (see this value's own comment) — hold the last
      // real measurement rather than guessing or snapping to (0, 0).
      ({ topY, targetX, targetY } = lastGood.value);
    } else {
      // Never measured even once. Can't happen in normal operation — a
      // flight only ever starts once `miniCartRefs` is registered, which
      // only happens once the Mini Cart has actually mounted — but render
      // fully transparent and off-screen rather than flashing at (0, 0) if
      // it somehow does.
      return {
        opacity: 0,
        transform: [{ translateX: -9999 }, { translateY: -9999 }],
      };
    }

    /**
     * ADD:
     *
     *       [ D ]       <- starts just above the Mini Cart's live top edge
     *         ↓
     *         ↓
     *       [ D ]       <- exact thumbnail slot, measured this same frame
     *
     * No long-distance movement.
     *
     * REMOVE:
     *
     * Small upward movement from the cart.
     */
    const startY = topY - ADD_DROP_DISTANCE;

    const translateY = isAdd
      ? interpolate(progress.value, [0, 1], [startY, targetY])
      : interpolate(
          progress.value,
          [0, 1],
          [targetY, targetY - REMOVE_DISTANCE],
        );

    /**
     * Keep the thumbnail almost the same size.
     *
     * Slight scale gives a natural drop/settle feeling on ADD, but it
     * should never look like a zoom animation. A single continuous curve
     * (no mid-flight breakpoint) — a breakpoint here compounds with the
     * translateY's own ease-out deceleration and reads as a tiny
     * hesitation right before landing.
     */
    const scale = isAdd
      ? interpolate(progress.value, [0, 1], [0.94, 1])
      : interpolate(progress.value, [0, 1], [1, 0.82]);

    /**
     * ADD: very short fade-in at the beginning, then fully visible for the
     * rest of the drop — no fade-out at the end.
     */
    const opacity = isAdd
      ? interpolate(progress.value, [0, 0.08, 1], [0, 1, 1])
      : interpolate(progress.value, [0, 0.2, 1], [1, 1, 0]);

    return {
      opacity,
      // `translateX` (not a static `left`) because `targetX` is itself
      // measured fresh every frame now, same reasoning as `translateY`.
      transform: [{ translateX: targetX }, { translateY }, { scale }],
    };
  }, [refs, isAdd]);

  return (
    <ReanimatedAnimated.View
      pointerEvents="none"
      style={[styles.dot, animatedStyle]}
    >
      {flight.imageUrl ? (
        <Image
          source={{ uri: flight.imageUrl }}
          style={styles.dotImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          onLoad={handleImageSettled}
          onError={handleImageSettled}
        />
      ) : (
        <View style={styles.dotFallback} />
      )}
    </ReanimatedAnimated.View>
  );
}

/**
 * Mount this ONCE at app root.
 *
 * It must be above the navigation content so the screen coordinates
 * `measure()` returns for the Mini Cart (see `FlightDot`) line up with this
 * overlay's own coordinate space.
 */
export function FlyToCartOverlay() {
  const [flights, setFlights] = useState<Flight[]>([]);

  const miniCartRefs = useFlyToCartStore((state) => state.miniCartRefs);

  /**
   * Remembers the last non-null refs seen. Needed for exactly one edge
   * case: a REMOVE flight for the cart's LAST item — `flyFromCart()` starts
   * it while the Mini Cart still exists, but the qty-drops-to-0 state
   * update that triggers happens essentially the same tick, which unmounts
   * MiniCartPill (clearing `miniCartRefs` back to `null`) well before the
   * already-running flight's own ~160ms finishes. Without this, the
   * flight's dot would vanish mid-air the instant the cart emptied instead
   * of finishing its short trip out. `FlightDot` itself still measures
   * fresh every frame against these refs for as long as the underlying
   * native view survives its own `exiting` animation (see MiniCartBar.tsx)
   * — this only keeps the REFERENCE alive a little longer, it doesn't
   * change how the position itself is obtained.
   */
  const lastRefsRef = useRef<MiniCartRefs | null>(null);
  if (miniCartRefs) lastRefsRef.current = miniCartRefs;

  useEffect(() => {
    onFlight = (flight) => {
      setFlights((previous) => [...previous, flight]);
    };

    // In case flyToCart() was called (and queued) before this overlay
    // mounted and started listening.
    flushQueuedAdds();

    return () => {
      onFlight = null;
    };
  }, []);

  const refsForFlights = miniCartRefs ?? lastRefsRef.current;

  if (!refsForFlights || flights.length === 0) {
    return null;
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {flights.map((flight) => (
        <FlightDot
          key={flight.id}
          flight={flight}
          refs={refsForFlights}
          onDone={() => {
            if (flight.kind === "add") {
              // First tell MiniCartBar that the image has landed. Keep the
              // flying copy alive for one short frame window so MiniCartBar
              // can promote its already-loaded back image before this copy
              // disappears. This removes the native compositor gap that can
              // otherwise look like a blink at the exact handoff point.
              useFlyToCartStore.setState({ landedFlightId: flight.id });

              setTimeout(() => {
                setFlights((previous) =>
                  previous.filter((item) => item.id !== flight.id),
                );
              }, 40);
              return;
            }

            // REMOVE flights are purely visual. They never control the real
            // MiniCart thumbnail/state, so they can disappear immediately.
            setFlights((previous) =>
              previous.filter((item) => item.id !== flight.id),
            );
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: "absolute",
    // Fixed at the overlay's own origin — `animatedStyle` positions the dot
    // entirely via `transform: translateX/translateY` (both measured fresh
    // every frame), never via these `top`/`left`, so they just need to be
    // pinned at (0, 0) once so the transform values ARE the absolute
    // screen coordinates.
    top: 0,
    left: 0,

    width: DOT_SIZE,
    height: DOT_SIZE,

    borderRadius: radius.sm,

    // Deliberately NO border — this must render pixel-identical to
    // MiniCartBar.tsx's real destination slot (`styles.imageBox`: same
    // size, same `borderRadius`, same `backgroundColor`, no border) at
    // every frame, not just at the moment they swap. A border here that
    // the real slot doesn't have was the actual cause of the reported
    // "image blink" — it's not the image resizing at all (both are a
    // fixed 28x28 from their very first frame): landing removes this
    // dot and reveals the real slot underneath in the same render (see
    // MiniCartBar.tsx's `landedFlightId` handling), and a colored ring
    // simply vanishing at that exact instant read as the image "popping"
    // into its final state.
    backgroundColor: colors.surface,

    overflow: "hidden",
  },

  dotImage: {
    width: "100%",
    height: "100%",
  },

  dotFallback: {
    width: "100%",
    height: "100%",
    backgroundColor: colors.primary,
  },
});

/**
 * Cart add/remove pop animation — a small square product thumbnail that
 * hops into the floating cart on add, and hops out of it on remove, the
 * way modern quick-commerce apps do it.
 *
 * Deliberately NOT a cross-screen flight from the tapped product card
 * anymore — it starts (add) / ends (remove) a short distance ABOVE
 * whichever cart summary is currently on screen, never from the product's
 * actual on-screen position. That means callers no longer need to measure
 * anything about the tapped card at all; `flyToCart`/`flyFromCart` just
 * take the image URL.
 *
 * The LANDING TARGET is registered by whichever cart-summary UI is
 * currently on screen — MiniCartBar (Home), CategoriesScreen's sticky
 * checkout bar, ProductDetailScreen's Go to Cart button — each measures its
 * own position and calls `setCartTargetPosition`.
 *
 * Purely decorative and fire-and-forget: the actual cart state (badge count,
 * item list) already updates synchronously via the optimistic store in
 * useCartActions.ts the instant a tap happens — this never gates or delays
 * that. If the overlay isn't mounted yet or nothing has registered a target
 * position (e.g. a screen with no cart-summary UI at all), both functions
 * silently no-op rather than blocking anything.
 *
 * Positions are WINDOW-relative (`measureInWindow`), matching
 * `FlyToCartOverlay`, which is mounted as a full-screen absolutely
 * positioned layer at the app root — so window coordinates line up with the
 * overlay's own coordinate space with no extra offset math.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, View } from "react-native";
import { create } from "zustand";
import { colors, radius } from "@shared/theme";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlyToCartStore {
  cartTargetPosition: ScreenRect | null;
  setCartTargetPosition: (rect: ScreenRect) => void;
}

export const useFlyToCartStore = create<FlyToCartStore>((set) => ({
  cartTargetPosition: null,
  setCartTargetPosition: (rect) => set({ cartTargetPosition: rect }),
}));

type FlightKind = "add" | "remove";

interface Flight {
  id: number;
  kind: FlightKind;
  imageUrl: string | null;
}

let nextFlightId = 0;
let onFlight: ((flight: Flight) => void) | null = null;

/** Call right when an item is added (qty 0 -> 1, or any +). */
export function flyToCart(imageUrl: string | null): void {
  const target = useFlyToCartStore.getState().cartTargetPosition;
  if (!target || !onFlight) return;
  onFlight({ id: nextFlightId++, kind: "add", imageUrl });
}

/** Call right when the last unit of a line is removed (qty 1 -> 0). */
export function flyFromCart(imageUrl: string | null): void {
  const target = useFlyToCartStore.getState().cartTargetPosition;
  if (!target || !onFlight) return;
  onFlight({ id: nextFlightId++, kind: "remove", imageUrl });
}

/** Exported so MiniCartBar.tsx can time its own thumbnail's reveal to land
 * exactly when this flight does — see its own comment for why. */
export const ADD_DURATION = 420;
const REMOVE_DURATION = 300;
/** Matches MiniCartBar's thumbBox exactly, so the dot lands flush with the
 * stack instead of visibly resizing into it. */
const DOT_SIZE = 34;
/** How far above the cart the add-hop starts / the remove-hop ends. */
const HOP_DISTANCE = 56;

function FlightDot({ flight, target, onDone }: { flight: Flight; target: ScreenRect; onDone: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (flight.kind === "add") {
      // ONE continuous timing over the whole flight — no sequence, no
      // spring settle at the end. A spring's very nature is to overshoot
      // and oscillate back, which combined with the opacity fade below
      // used to read as "shrinks, disappears, reappears" right at landing.
      // A single easeOut timing still gathers speed early and settles
      // smoothly late, without ever reversing direction.
      Animated.timing(progress, {
        toValue: 1,
        duration: ADD_DURATION,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(onDone);
    } else {
      Animated.timing(progress, {
        toValue: 1,
        duration: REMOVE_DURATION,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(onDone);
    }
    // Runs once per flight — `onDone` is stable enough for this (removes
    // this flight from the overlay's list), re-subscribing mid-flight would
    // only restart the same animation from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targetX = target.x + target.width / 2 - DOT_SIZE / 2;
  const targetY = target.y + target.height / 2 - DOT_SIZE / 2;

  let translateY: Animated.AnimatedInterpolation<number>;
  let scale: Animated.AnimatedInterpolation<number>;
  let opacity: Animated.AnimatedInterpolation<number>;

  if (flight.kind === "add") {
    // ONE continuous drop from just above the cart down to it — every
    // channel (position, size, opacity) moves in a SINGLE direction with
    // no reversal, dip, or overshoot, so nothing ever reads as "shrinking"
    // or "disappearing" mid-flight. Opacity fades in ONCE right at the very
    // start (so it doesn't hard-pop into existence) and then stays fully
    // visible for the rest of the flight — it never fades back out, so
    // there's no visible "landing pop". The REAL thumbnail underneath stays
    // invisible until this exact flight duration has elapsed (see
    // MiniCartBar's `thumbnailEntering`, delayed by this same
    // `ADD_DURATION`) — otherwise it would already be sitting there, fully
    // visible, for the entire ~420ms this dot is still visibly in the air,
    // which read as "the cart shows the item before the drop finishes".
    translateY = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [targetY - HOP_DISTANCE, targetY],
    });
    scale = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [0.8, 1],
    });
    opacity = progress.interpolate({
      inputRange: [0, 0.12, 1],
      outputRange: [0, 1, 1],
    });
  } else {
    // Starts AT the cart, hops up a short distance while shrinking/fading
    // out — no bounce, quick and light, matching "remove" reading as
    // lighter/faster than "add".
    translateY = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [targetY, targetY - HOP_DISTANCE],
    });
    scale = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.55],
    });
    opacity = progress.interpolate({
      inputRange: [0, 0.15, 1],
      outputRange: [1, 1, 0],
    });
  }

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          left: targetX,
          opacity,
          transform: [{ translateY }, { scale }],
        },
      ]}
    >
      {flight.imageUrl ? (
        <Image source={{ uri: flight.imageUrl }} style={styles.dotImage} resizeMode="cover" />
      ) : (
        <View style={styles.dotFallback} />
      )}
    </Animated.View>
  );
}

/** Mount once, at the app root, above the navigation tree. */
export function FlyToCartOverlay() {
  const [flights, setFlights] = useState<Flight[]>([]);
  const target = useFlyToCartStore((state) => state.cartTargetPosition);

  useEffect(() => {
    onFlight = (flight) => setFlights((prev) => [...prev, flight]);
    return () => {
      onFlight = null;
    };
  }, []);

  if (!target) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {flights.map((flight) => (
        <FlightDot
          key={flight.id}
          flight={flight}
          target={target}
          onDone={() => setFlights((prev) => prev.filter((f) => f.id !== flight.id))}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    position: "absolute",
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.primaryLight,
    overflow: "hidden",
    backgroundColor: colors.surface,
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

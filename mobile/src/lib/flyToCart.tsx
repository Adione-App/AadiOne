/**
 * "Fly to cart" animation — the small product-image dot that arcs from a
 * tapped Add/+ button into the Cart tab icon, the way Blinkit/Zepto show an
 * add landing somewhere real instead of just updating a number.
 *
 * Purely decorative and fire-and-forget: the actual cart state (badge count,
 * item list) already updates synchronously via the optimistic store in
 * useCartActions.ts the instant a tap happens — this never gates or delays
 * that. If the overlay isn't mounted yet or the cart icon's position hasn't
 * been measured, `flyToCart` silently no-ops rather than blocking anything.
 *
 * Positions are WINDOW-relative (`measureInWindow`) on both ends, matching
 * `FlyToCartOverlay`, which is mounted as a full-screen absolutely
 * positioned layer at the app root — so window coordinates line up with the
 * overlay's own coordinate space with no extra offset math.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, View } from "react-native";
import { create } from "zustand";
import { colors } from "@shared/theme";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlyToCartStore {
  cartIconPosition: ScreenRect | null;
  setCartIconPosition: (rect: ScreenRect) => void;
}

export const useFlyToCartStore = create<FlyToCartStore>((set) => ({
  cartIconPosition: null,
  setCartIconPosition: (rect) => set({ cartIconPosition: rect }),
}));

interface Flight {
  id: number;
  from: ScreenRect;
  imageUrl: string | null;
}

let nextFlightId = 0;
let onFlight: ((flight: Flight) => void) | null = null;

/** Call from a tap handler — `from` is this tap's own on-screen rect (e.g.
 * the product image just tapped), measured via `measureInWindow`. */
export function flyToCart(from: ScreenRect, imageUrl: string | null): void {
  const target = useFlyToCartStore.getState().cartIconPosition;
  if (!target || !onFlight) return;
  onFlight({ id: nextFlightId++, from, imageUrl });
}

const DURATION = 650;
const DOT_SIZE = 40;
/** How far the arc rises above a straight line between start and end. */
const ARC_HEIGHT = 90;

function FlightDot({ flight, target, onDone }: { flight: Flight; target: ScreenRect; onDone: () => void }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: DURATION,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(onDone);
    // Runs once per flight — `onDone` is stable enough for this (removes
    // this flight from the overlay's list), re-subscribing mid-flight would
    // only restart the same animation from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startX = flight.from.x + flight.from.width / 2 - DOT_SIZE / 2;
  const startY = flight.from.y + flight.from.height / 2 - DOT_SIZE / 2;
  const endX = target.x + target.width / 2 - DOT_SIZE / 2;
  const endY = target.y + target.height / 2 - DOT_SIZE / 2;

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [startX, endX] });
  const linearY = progress.interpolate({ inputRange: [0, 1], outputRange: [startY, endY] });
  // A rise-then-fall hump layered on top of the straight-line descent below
  // is what makes it read as a "drop" rather than a slide.
  const arc = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -ARC_HEIGHT, 0] });
  const scale = progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0.85, 0.25] });
  const opacity = progress.interpolate({ inputRange: [0, 0.75, 1], outputRange: [1, 1, 0] });

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          opacity,
          transform: [
            { translateX },
            { translateY: Animated.add(linearY, arc) },
            { scale },
          ],
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
  const target = useFlyToCartStore((state) => state.cartIconPosition);

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
    borderRadius: DOT_SIZE / 2,
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

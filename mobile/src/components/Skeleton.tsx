/**
 * The app's ONE loading-skeleton language — every screen's placeholders are
 * built from these, so they all look and move the same:
 *
 *   colour     the theme's light green (`colors.primarySurface`), the tone
 *              the Categories product pane introduced; never grey
 *   corners    `radius.sm` by default, or the real element's own radius
 *   motion     one gentle opacity pulse; every bone of a placeholder reads
 *              the SAME shared value (`useSkeletonPulse`), so a screenful of
 *              bones is still a single looping animation on the UI thread
 *
 * Placeholders keep the real content's box sizes (ProductCardSkeleton is
 * ProductCard's layout, RestaurantCardSkeleton FoodRestaurantCard's, …) so
 * nothing jumps when the data replaces them. No layout animations
 * (`entering` / `exiting`): a skeleton is simply swapped for the content —
 * a layout animation around that swap once left the old skeleton on screen.
 */

import { useEffect } from "react";
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import ReanimatedAnimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { colors, radius } from "@shared/theme";

export const SKELETON_COLOR = colors.primarySurface;

/** Half a pulse (dim → bright), in ms. */
const PULSE_DURATION = 900;
/** The dimmest point of the pulse — never so faint the bone disappears. */
const PULSE_MIN_OPACITY = 0.55;

/** One looping 0→1→0 driver; share it between every bone of a placeholder. */
export function useSkeletonPulse(): SharedValue<number> {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: PULSE_DURATION, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [progress]);
  return progress;
}

/** One placeholder block. Size it with `width`/`height` or with `style`. */
export function Bone({
  progress,
  width,
  height,
  rounded = radius.sm,
  style,
}: {
  progress: SharedValue<number>;
  width?: DimensionValue;
  height?: number;
  rounded?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const animated = useAnimatedStyle(() => ({
    opacity: PULSE_MIN_OPACITY + progress.value * (1 - PULSE_MIN_OPACITY),
  }));
  return (
    <ReanimatedAnimated.View
      style={[styles.bone, { width, height, borderRadius: rounded }, style, animated]}
    />
  );
}

/** Groups a placeholder's bones for screen readers ("Loading …"). */
export function SkeletonGroup({
  label,
  style,
  children,
}: {
  label: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return (
    <View
      style={style}
      pointerEvents="none"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bone: {
    backgroundColor: SKELETON_COLOR,
  },
});

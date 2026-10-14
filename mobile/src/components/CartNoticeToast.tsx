/**
 * The cart popup (lib/cartNotice.ts): a white card with a green accent near
 * the top of the screen, fading/sliding in, gone after a moment. It never
 * takes touches (`pointerEvents="none"`), so nothing underneath — tabs,
 * buttons, the variant sheet — is blocked while it shows.
 */

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { Info } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing } from "@shared/theme";
import { useCartNotice } from "@/lib/cartNotice";
import { AppText } from "@/components/ui";

const VISIBLE_MS = 2400;

export function CartNoticeToast() {
  const message = useCartNotice((state) => state.message);
  const version = useCartNotice((state) => state.version);
  const hide = useCartNotice((state) => state.hide);
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!message) {
      Animated.timing(progress, { toValue: 0, duration: 160, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished) setShown(null);
        },
      );
      return;
    }
    setShown(message);
    Animated.timing(progress, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // A repeat of the same message (a new `version`) restarts this timer instead of stacking.
    const timer = setTimeout(hide, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [message, version, hide, progress]);

  if (!shown) return null;

  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <Animated.View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[
          styles.toast,
          {
            opacity: progress,
            transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
          },
        ]}
      >
        <Info size={18} color={colors.primary} strokeWidth={2.4} />
        <AppText variant="bodyStrong" style={styles.text}>
          {shown}
        </AppText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: spacing.base,
    right: spacing.base,
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    maxWidth: 520,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.base,
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    backgroundColor: colors.surface,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.16,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { flexShrink: 1, color: colors.textPrimary },
});

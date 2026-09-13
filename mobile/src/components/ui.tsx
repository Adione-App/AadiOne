/**
 * Design-system components (Task 14.1).
 *
 * Built to the brief's constraints rather than to a generic style guide:
 *   - base body text is 16pt, not 14 — small type is the most common
 *     accessibility failure in Indian consumer apps
 *   - touch targets never below 48pt
 *   - buttons are pill-shaped and green, as in the mockups
 *   - no decorative animation
 */

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import {
  colors,
  radius,
  spacing,
  typography,
  layout,
  statusColors,
} from "@shared/theme";

import { ORDER_STATUS_LABELS, type OrderStatus } from "@shared";

import { useEffect, useRef } from "react";

/* -------------------------------------------------------------------------- */

export function AppText({
  children,
  variant = "body",
  color = colors.textPrimary,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  variant?: keyof typeof typography;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const preset = typography[variant];

  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontSize: preset.fontSize,
          fontWeight: preset.fontWeight as TextStyle["fontWeight"],
          lineHeight: preset.fontSize * preset.lineHeight,
          color,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* -------------------------------------------------------------------------- */

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isDisabled = disabled === true || loading === true;

  const background = {
    primary: isDisabled ? colors.disabled : colors.primary,
    secondary: colors.surface,
    danger: colors.danger,
    ghost: "transparent",
  }[variant];

  const textColor = {
    primary: isDisabled ? colors.disabledText : colors.onPrimary,
    secondary: isDisabled ? colors.disabledText : colors.textPrimary,
    danger: colors.onPrimary,
    ghost: colors.primary,
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          opacity: pressed && !isDisabled ? 0.85 : 1,
        },
        variant === "secondary" && {
          borderWidth: 1,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <AppText variant="button" color={textColor}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */

export function Input({
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  maxLength,
  autoFocus,
  secureTextEntry,
  prefix,
  autoCapitalize,
  autoCorrect,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "phone-pad" | "number-pad" | "email-address";
  maxLength?: number;
  autoFocus?: boolean;
  secureTextEntry?: boolean;
  prefix?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
}) {
  return (
    <View style={styles.inputRow}>
      {prefix !== undefined && (
        <View style={styles.inputPrefix}>
          <AppText variant="bodyLarge" color={colors.textSecondary}>
            {prefix}
          </AppText>
        </View>
      )}

      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoFocus={autoFocus}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        style={styles.input}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/* -------------------------------------------------------------------------- */

export function Screen({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

/* -------------------------------------------------------------------------- */

export function StatusBadge({ status }: { status: OrderStatus }) {
  const tone = statusColors[status];

  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <AppText variant="caption" color={tone.fg}>
        {ORDER_STATUS_LABELS[status]}
      </AppText>
    </View>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Error state.
 *
 * A network failure and a server failure get different copy: telling someone
 * with no signal that "our servers had a problem" sends them to support
 * instead of to their settings.
 */

export function ErrorState({
  message,
  onRetry,
  offline,
}: {
  message: string;
  onRetry?: () => void;
  offline?: boolean;
}) {
  return (
    <View style={styles.centered}>
      <AppText variant="h3" style={{ textAlign: "center" }}>
        {offline ? "No internet connection" : "Something went wrong"}
      </AppText>

      <AppText
        variant="body"
        color={colors.textSecondary}
        style={{
          textAlign: "center",
          marginTop: spacing.sm,
        }}
      >
        {offline ? "Please check your connection and try again." : message}
      </AppText>

      {onRetry && (
        <Button
          label="Try again"
          onPress={onRetry}
          style={{ marginTop: spacing.lg }}
        />
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: {
    label: string;
    onPress: () => void;
  };
}) {
  return (
    <View style={styles.centered}>
      <AppText variant="h3" style={{ textAlign: "center" }}>
        {title}
      </AppText>

      {hint && (
        <AppText
          variant="body"
          color={colors.textSecondary}
          style={{
            textAlign: "center",
            marginTop: spacing.sm,
          }}
        >
          {hint}
        </AppText>
      )}

      {action && (
        <Button
          label={action.label}
          onPress={action.onPress}
          style={{ marginTop: spacing.lg }}
        />
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Generic loading component.
 *
 * Keep this unchanged because it is used by normal screens
 * throughout the application.
 */

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator size="large" color={colors.primary} />

      {label && (
        <AppText
          variant="body"
          color={colors.textSecondary}
          style={{ marginTop: spacing.md }}
        >
          {label}
        </AppText>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Startup loading screen.
 *
 * Used only while the application is restoring the customer session.
 *
 * This is intentionally separate from the generic Loading component so
 * normal loading states throughout the app are not affected.
 *
 * IMPORTANT:
 * - Uses adione-start-logo.png
 * - The image itself contains the icon + AadiOne name
 * - No separate AadiOne text is rendered
 * - Logo has a small fade/scale entrance animation
 * - Loading bar continuously animates
 */

export function StartupLoading() {
  const opacity = useRef(new Animated.Value(0)).current;

  const scale = useRef(new Animated.Value(0.88)).current;

  const progress = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    /*
     * Logo entrance animation
     */
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 650,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),

      Animated.spring(scale, {
        toValue: 1,
        friction: 7,
        tension: 55,
        useNativeDriver: true,
      }),
    ]).start();

    /*
     * Loading progress animation
     *
     * useNativeDriver MUST be false because width
     * is being animated.
     */
    const progressAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),

        Animated.timing(progress, {
          toValue: 0.35,
          duration: 1000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );

    progressAnimation.start();

    return () => {
      progressAnimation.stop();
    };
  }, [opacity, scale, progress]);

  /*
   * Convert progress value to percentage width.
   */
  const progressWidth = progress.interpolate({
    inputRange: [0.35, 1],
    outputRange: ["35%", "100%"],
  });

  return (
    <View style={styles.startupScreen}>
      {/* ---------------------------------------------------------------- */}
      {/* AadiOne combined startup logo                                   */}
      {/* Icon + AadiOne name are already inside this image               */}
      {/* ---------------------------------------------------------------- */}

      <Animated.View
        style={[
          styles.startupLogoContainer,
          {
            opacity,
            transform: [{ scale }],
          },
        ]}
      >
        <Image
          source={require("../../assets/adione-start-logo.png")}
          style={styles.startupLogo}
          resizeMode="contain"
          accessibilityLabel="AadiOne"
        />
      </Animated.View>

      {/* ---------------------------------------------------------------- */}
      {/* Animated loading bar                                             */}
      {/* ---------------------------------------------------------------- */}

      <View style={styles.startupLoadingContainer}>
        <View style={styles.startupLoadingTrack}>
          <Animated.View
            style={[
              styles.startupLoadingProgress,
              {
                width: progressWidth,
              },
            ]}
          />
        </View>

        <Text style={styles.startupLoadingText}>Loading...</Text>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */

/** Yellow strip used for cart corrections — never a silent change. */

export function NoticeStrip({
  message,
  tone = "warning",
}: {
  message: string;
  tone?: "warning" | "info";
}) {
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor:
            tone === "warning" ? colors.warningSurface : colors.infoSurface,
        },
      ]}
    >
      <AppText
        variant="body"
        color={tone === "warning" ? colors.warning : colors.info}
      >
        {message}
      </AppText>
    </View>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  /* ---------------------------------------------------------------------- */
  /* Existing design-system styles                                           */
  /* ---------------------------------------------------------------------- */

  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },

  button: {
    minHeight: layout.minTouchTarget,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    minHeight: layout.minTouchTarget,
  },

  inputPrefix: {
    paddingHorizontal: spacing.base,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingVertical: spacing.md,
  },

  input: {
    flex: 1,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
  },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.base,
  },

  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },

  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },

  notice: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },

  /* ---------------------------------------------------------------------- */
  /* AadiOne Startup Loading                                                */
  /* ---------------------------------------------------------------------- */

  startupScreen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },

  startupLogoContainer: {
    alignItems: "center",
    justifyContent: "center",
  },

  startupLogo: {
    width: 270,
    height: 270,
  },

  startupLoadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 22,
  },

  startupLoadingTrack: {
    width: 150,
    height: 6,
    borderRadius: 999,
    backgroundColor: "#E2E7E4",
    overflow: "hidden",
  },

  startupLoadingProgress: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },

  startupLoadingText: {
    marginTop: 8,
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "500",
  },
});

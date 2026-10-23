/**
 * Wraps a screen that shows one customer's own data (cart, orders, addresses,
 * profile, rewards, notifications). Signed in: the screen itself. Signed out
 * — a guest who got here, or a session that ended while it was open — a short
 * "log in to …" prompt instead, never a failed request or an error screen.
 * Logging in from the prompt swaps the real screen in place.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { colors, spacing } from "@shared/theme";
import { openLogin } from "@/lib/authGate";
import { AUTH_REASON_COPY, type AuthReason } from "@/lib/guestAccess";
import { useAuth } from "@/lib/store";
import { AppText, EmptyState, Screen } from "@/components/ui";

export function RequireAccount({
  reason,
  title,
  onBack,
  children,
}: {
  reason: AuthReason;
  /** The screen's own title, kept in the header so the customer knows where they are. */
  title: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const status = useAuth((state) => state.status);
  const sessionExpired = useAuth((state) => state.sessionExpired);

  if (status === "authenticated") return <>{children}</>;

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            hitSlop={12}
            style={styles.back}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <AppText variant="h2">←</AppText>
          </Pressable>
        ) : null}
        <AppText variant="h3">{title}</AppText>
      </View>

      <EmptyState
        icon={<Ionicons name="person-circle-outline" size={52} color={colors.primary} />}
        title={sessionExpired ? "Your session has expired" : "Log in to continue"}
        hint={
          sessionExpired
            ? `Please log in again. ${AUTH_REASON_COPY[reason]}`
            : AUTH_REASON_COPY[reason]
        }
        action={{ label: "Log in", onPress: () => openLogin(reason) }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
  },
  back: {
    marginRight: spacing.md,
  },
});

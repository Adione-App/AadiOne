/**
 * Referral-code entry — shown ONLY inline inside OtpVerifyScreen, and only
 * once, right after a brand-new account is created (see that screen's
 * `verify()` for exactly how "once" is guaranteed: it's gated on the fresh
 * `isNewUser` flag from THIS verify-otp response, which can only ever be
 * true the single time an account is created — nothing here is a persisted
 * client flag, and nothing here can be reached again from the profile).
 *
 * A plain presentational step, not a navigator screen: OtpVerifyScreen holds
 * the just-fetched `AuthResponse` locally and defers `setSession()` (which is
 * what flips the app into MainTabs) until `onDone` fires here, whether that's
 * a successful code apply or Skip.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors, radius, spacing } from "@shared/theme";
import { ApiRequestError } from "@/lib/api";
import { useApplyReferralCode } from "@/lib/queries";
import { AppText, Button } from "@/components/ui";

export default function ReferralCodeStep({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const applyReferralCode = useApplyReferralCode();

  async function handleContinue(): Promise<void> {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      onDone();
      return;
    }

    setError(null);
    try {
      await applyReferralCode.mutateAsync(trimmed);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Could not apply this referral code.",
      );
    }
  }

  return (
    <View style={styles.content}>
      <View style={styles.iconCircle}>
        <Ionicons name="gift-outline" size={30} color={colors.primary} />
      </View>

      <AppText variant="display" style={styles.heading}>
        Got a referral code?
      </AppText>

      <AppText variant="body" color={colors.textSecondary} style={styles.subtitle}>
        Enter a friend's code to say thanks — or skip and come back to Rewards
        any time.
      </AppText>

      <TextInput
        value={code}
        onChangeText={(value) => {
          setCode(value.toUpperCase());
          setError(null);
        }}
        placeholder="Enter referral code"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={16}
        style={[styles.input, error ? styles.inputError : null]}
      />

      {error && (
        <AppText variant="caption" color={colors.danger} style={styles.error}>
          {error}
        </AppText>
      )}

      <Button
        label="Continue"
        onPress={handleContinue}
        loading={applyReferralCode.isPending}
        disabled={applyReferralCode.isPending}
        style={styles.continueButton}
      />

      <Pressable
        onPress={onDone}
        disabled={applyReferralCode.isPending}
        hitSlop={10}
        style={styles.skipButton}
      >
        <AppText variant="bodyStrong" color={colors.textSecondary}>
          Skip for now
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.xl,
  },

  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: radius.circle,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySurface,
    marginBottom: spacing.lg,
  },

  heading: {
    fontSize: 27,
    lineHeight: 34,
    fontWeight: "700",
  },

  subtitle: {
    marginTop: spacing.xs,
  },

  input: {
    marginTop: spacing.xl,
    height: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 1,
    color: colors.textPrimary,
  },

  inputError: {
    borderColor: colors.danger,
  },

  error: {
    marginTop: spacing.sm,
  },

  continueButton: {
    marginTop: spacing.lg,
    minHeight: 48,
  },

  skipButton: {
    alignSelf: "center",
    marginTop: spacing.lg,
    padding: spacing.sm,
  },
});

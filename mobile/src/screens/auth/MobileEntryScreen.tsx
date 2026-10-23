/**
 * Mobile number entry — single authentication entry point.
 *
 * Opened as a modal over the app (lib/authGate.ts) only when the customer
 * starts something that needs an account; "Not now" (or back / swipe down)
 * returns them to the screen they were browsing.
 */

import { useState } from "react";
import {
  Image,
  ImageBackground,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import type { SendOtpResponse } from "@shared";
import { normalizeIndianMobile } from "@shared/phone";
import { colors, radius, spacing } from "@shared/theme";

import { api, ApiRequestError } from "@/lib/api";
import { cancelLogin, useAuthGate } from "@/lib/authGate";
import { AUTH_REASON_COPY } from "@/lib/guestAccess";
import { useAuth } from "@/lib/store";
import { AppText, Button, Input } from "@/components/ui";

import adioneLogo from "../../../assets/adione-logo.png";
import mobileBackground from "../../../assets/mobile-no-background.png";

const HIGHLIGHTS = [
  {
    title: "Fast Delivery",
    icon: "flash" as const,
  },
  {
    title: "Trusted Store",
    icon: "shield-checkmark" as const,
  },
  {
    title: "Best Prices",
    icon: "pricetag" as const,
  },
];

export default function MobileEntryScreen({
  navigation,
}: {
  navigation: {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}) {
  const insets = useSafeAreaInsets();

  const [mobile, setMobile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Why the login was asked for ("Log in to add items to your cart."); none
  // for a plain "Log in" from Account.
  const reason = useAuthGate((state) => state.reason);
  const sessionExpired = useAuth((state) => state.sessionExpired);
  const reasonLine =
    reason && reason !== "account"
      ? AUTH_REASON_COPY[reason]
      : sessionExpired
        ? "Your session has expired. Please log in again."
        : null;

  const normalizedMobile = normalizeIndianMobile(mobile);
  const isValid = normalizedMobile !== null;

  async function sendOtp(): Promise<void> {
    if (!normalizedMobile) return;

    setBusy(true);
    setError(null);

    try {
      const result = await api.post<SendOtpResponse>("/auth/send-otp", {
        mobile: normalizedMobile,
      });

      navigation.navigate("OtpVerify", {
        mobile: normalizedMobile,
        resendAfterSeconds: result.resendAfterSeconds,
        devOtp: result.devOtp,
      });
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not send OTP. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboard}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom + spacing.lg,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* -------------------------------------------------------------- */}
          {/* HERO                                                           */}
          {/* -------------------------------------------------------------- */}

          <View style={styles.hero}>
            <ImageBackground
              source={mobileBackground}
              style={styles.heroBackground}
              resizeMode="cover"
            >
              {/* Back to browsing — login is never required to look around */}
              <Pressable
                onPress={cancelLogin}
                hitSlop={10}
                style={styles.notNow}
                accessibilityRole="button"
                accessibilityLabel="Not now, continue browsing"
              >
                <Ionicons name="close" size={16} color={colors.textPrimary} />
                <AppText variant="caption" color={colors.textPrimary} style={styles.notNowText}>
                  Not now
                </AppText>
              </Pressable>

              {/* Text sits over the empty left/top portion of the artwork */}
              <View style={styles.heroContent}>
                <AppText
                  variant="h2"
                  color={colors.textPrimary}
                  style={styles.welcome}
                >
                  Welcome to
                </AppText>

                <Image
                  source={adioneLogo}
                  style={styles.logo}
                  resizeMode="contain"
                  accessibilityLabel="AdiOne"
                />

                <AppText
                  variant="body"
                  color={colors.textSecondary}
                  style={styles.heroDescription}
                >
                  Your daily essentials,
                </AppText>

                <AppText
                  variant="body"
                  color={colors.textSecondary}
                  style={styles.heroDescription}
                >
                  delivered in{" "}
                  <AppText variant="bodyStrong" color={colors.primary}>
                    30 minutes
                  </AppText>
                </AppText>

                {/* Feature list */}
                <View style={styles.highlights}>
                  {HIGHLIGHTS.map((item) => (
                    <View key={item.title} style={styles.highlight}>
                      <View style={styles.highlightIcon}>
                        <Ionicons
                          name={item.icon}
                          size={14}
                          color={colors.primary}
                        />
                      </View>

                      <AppText
                        variant="caption"
                        color={colors.textPrimary}
                        style={styles.highlightText}
                      >
                        {item.title}
                      </AppText>
                    </View>
                  ))}
                </View>
              </View>
            </ImageBackground>
          </View>

          {/* -------------------------------------------------------------- */}
          {/* MOBILE NUMBER SHEET                                            */}
          {/* -------------------------------------------------------------- */}

          <View style={styles.sheet}>
            {reasonLine ? (
              <AppText variant="bodyStrong" color={colors.primary} style={styles.reason}>
                {reasonLine}
              </AppText>
            ) : null}

            <AppText variant="h2">Enter Mobile Number</AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.sheetDescription}
            >
              We will send you a 6-digit OTP to verify
            </AppText>

            <View style={styles.inputContainer}>
              <Input
                value={mobile}
                onChangeText={(text) => {
                  setMobile(text);
                  setError(null);
                }}
                placeholder="Enter mobile number"
                keyboardType="phone-pad"
                maxLength={10}
                prefix="+91"
                autoFocus
                autoCorrect={false}
              />
            </View>

            {error && (
              <AppText
                variant="caption"
                color={colors.danger}
                style={styles.error}
              >
                {error}
              </AppText>
            )}

            <Button
              label="Send OTP"
              onPress={sendOtp}
              loading={busy}
              disabled={!isValid || busy}
              style={styles.button}
            />

            {/* Continue separator */}
            <View style={styles.separatorRow}>
              <View style={styles.separator} />

              <AppText
                variant="caption"
                color={colors.textMuted}
                style={styles.orText}
              >
                or continue with
              </AppText>

              <View style={styles.separator} />
            </View>

            {/* Terms */}
            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.terms}
            >
              By continuing, you agree to our
            </AppText>

            <View style={styles.termsRow}>
              <AppText
                variant="caption"
                color={colors.primary}
                style={styles.termsBold}
              >
                Terms & Conditions
              </AppText>

              <AppText variant="caption" color={colors.textSecondary}>
                {" "}
                and{" "}
              </AppText>

              <AppText
                variant="caption"
                color={colors.primary}
                style={styles.termsBold}
              >
                Privacy Policy
              </AppText>
            </View>

            {/* ------------------------------------------------------------ */}
            {/* TRUST FEATURES                                               */}
            {/* ------------------------------------------------------------ */}

            <View style={styles.trustRow}>
              <TrustItem
                icon="ribbon"
                title="100% Original"
                subtitle="Products"
              />

              <View style={styles.trustDivider} />

              <TrustItem
                icon="lock-closed"
                title="Secure"
                subtitle="Payments"
              />

              <View style={styles.trustDivider} />

              <TrustItem
                icon="headset"
                title="24/7 Customer"
                subtitle="Support"
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Trust item                                                                 */
/* -------------------------------------------------------------------------- */

function TrustItem({
  icon,
  title,
  subtitle,
}: {
  icon: "ribbon" | "lock-closed" | "headset";
  title: string;
  subtitle: string;
}) {
  return (
    <View style={styles.trustItem}>
      <View style={styles.trustIcon}>
        <Ionicons name={icon} size={17} color={colors.primary} />
      </View>

      <AppText
        variant="overline"
        color={colors.textPrimary}
        style={styles.trustTitle}
      >
        {title}
      </AppText>

      <AppText
        variant="overline"
        color={colors.textSecondary}
        style={styles.trustSubtitle}
      >
        {subtitle}
      </AppText>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.surface,
  },

  keyboard: {
    flex: 1,
  },

  scrollContent: {
    flexGrow: 1,
  },

  /* ---------------------------------------------------------------------- */
  /* Hero                                                                   */
  /* ---------------------------------------------------------------------- */

  hero: {
    width: "100%",
    height: 405,
    overflow: "hidden",
  },

  heroBackground: {
    flex: 1,
    width: "100%",
    height: "100%",
  },

  notNow: {
    position: "absolute",
    top: spacing.md,
    right: spacing.base,
    zIndex: 2,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.circle,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },

  notNowText: {
    marginLeft: 4,
    fontWeight: "700",
  },

  reason: {
    marginBottom: spacing.sm,
  },

  heroContent: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.lg,
    width: "58%",
  },

  welcome: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "700",
  },

  logo: {
    width: 175,
    height: 62,
    marginTop: spacing.xs,
    alignSelf: "flex-start",
  },

  heroDescription: {
    fontSize: 13,
    lineHeight: 19,
  },

  highlights: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },

  highlight: {
    flexDirection: "row",
    alignItems: "center",
  },

  highlightIcon: {
    width: 27,
    height: 27,
    borderRadius: radius.circle,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  highlightText: {
    fontSize: 12,
    fontWeight: "600",
  },

  /* ---------------------------------------------------------------------- */
  /* White authentication sheet                                            */
  /* ---------------------------------------------------------------------- */

  sheet: {
    marginTop: -22,
    marginHorizontal: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,

    zIndex: 10,
  },

  sheetDescription: {
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },

  inputContainer: {
    width: "100%",
  },

  error: {
    marginTop: spacing.sm,
  },

  button: {
    marginTop: spacing.md,
    minHeight: 48,
  },

  /* ---------------------------------------------------------------------- */
  /* Separator                                                              */
  /* ---------------------------------------------------------------------- */

  separatorRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.lg,
  },

  separator: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },

  orText: {
    marginHorizontal: spacing.md,
  },

  /* ---------------------------------------------------------------------- */
  /* Terms                                                                  */
  /* ---------------------------------------------------------------------- */

  terms: {
    marginTop: spacing.lg,
    textAlign: "center",
  },

  termsRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: spacing.xs,
  },

  termsBold: {
    fontWeight: "700",
  },

  /* ---------------------------------------------------------------------- */
  /* Trust bar                                                              */
  /* ---------------------------------------------------------------------- */

  trustRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySurface,
  },

  trustItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },

  trustIcon: {
    width: 30,
    height: 30,
    borderRadius: radius.circle,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },

  trustTitle: {
    textAlign: "center",
    fontSize: 8,
    fontWeight: "700",
  },

  trustSubtitle: {
    textAlign: "center",
    fontSize: 8,
  },

  trustDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border,
  },
});

/**
 * Mobile number entry — single authentication entry point.
 *
 * Opened as a modal over the app (lib/authGate.ts) only when the customer
 * starts something that needs an account; "Not now" (or back / swipe down)
 * returns them to the screen they were browsing.
 *
 * Keyboard: the number field, its error and Send OTP stay above the keyboard
 * whatever its height (useKeyboardReveal); "Not now" floats inside the safe
 * area, so it can be tapped with the keyboard open or closed.
 */

import { useState } from "react";
import {
  Image,
  ImageBackground,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import type { SendOtpResponse } from "@shared";
import { normalizeIndianMobile } from "@shared/phone";
import { colors, palette, radius, spacing } from "@shared/theme";

import { api, ApiRequestError } from "@/lib/api";
import { cancelLogin, useAuthGate } from "@/lib/authGate";
import { AUTH_REASON_COPY } from "@/lib/guestAccess";
import { useAuth } from "@/lib/store";
import { useKeyboardReveal } from "@/lib/useKeyboardReveal";
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

/** The artwork's height: 46% of the screen, kept between these (short phones keep the form in reach). */
const HERO_MIN = 300;
const HERO_MAX = 405;
/** The floating "Not now" pill: 40 dp tall, 8 dp below the status bar. */
const NOT_NOW_HEIGHT = 40;
const NOT_NOW_ROOM = NOT_NOW_HEIGHT + spacing.sm * 2;

export default function MobileEntryScreen({
  navigation,
}: {
  navigation: {
    navigate: (screen: string, params?: Record<string, unknown>) => void;
  };
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const heroHeight = Math.round(
    Math.min(HERO_MAX, Math.max(HERO_MIN, windowHeight * 0.46)),
  );
  // With the keyboard open, the form block scrolls up to just below the "Not now" pill.
  const keyboard = useKeyboardReveal({ topReserve: insets.top + NOT_NOW_ROOM });

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
      {/* "padding" on both platforms: with Android edge-to-edge the window is
          not resized for the keyboard, so this is what makes room for it. */}
      <KeyboardAvoidingView behavior="padding" style={styles.keyboard}>
        <View {...keyboard.frameProps} style={styles.keyboard}>
          <ScrollView
            {...keyboard.scrollProps}
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: insets.top,
                paddingBottom: insets.bottom + spacing.lg,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <View
              ref={keyboard.contentRef}
              collapsable={false}
              style={styles.scrollContent}
            >
              {/* -------------------------------------------------------------- */}
              {/* HERO                                                           */}
              {/* -------------------------------------------------------------- */}

              <View style={[styles.hero, { height: heroHeight }]}>
                <ImageBackground
                  source={mobileBackground}
                  style={styles.heroBackground}
                  resizeMode="cover"
                >
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
                <View style={styles.sheetHandle} />

                {/* Kept above the keyboard while typing: heading → Send OTP. */}
                <View ref={keyboard.blockRef} collapsable={false}>
                  {reasonLine ? (
                    <AppText
                      variant="bodyStrong"
                      color={colors.primary}
                      style={styles.reason}
                    >
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
                      accessibilityLabel="Mobile number"
                      onFocus={keyboard.reveal}
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
                </View>

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
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      {/* Back to browsing — login is never required to look around. Floats
          inside the safe area (above the scroll content), so it stays visible
          and tappable with the keyboard open or closed. */}
      <Pressable
        onPress={() => {
          Keyboard.dismiss();
          cancelLogin();
        }}
        hitSlop={8}
        style={({ pressed }) => [
          styles.notNow,
          { top: insets.top + spacing.sm },
          pressed && styles.notNowPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Not now, continue browsing"
      >
        <Ionicons name="close" size={18} color={colors.textPrimary} />
        <AppText
          variant="caption"
          color={colors.textPrimary}
          style={styles.notNowText}
        >
          Not now
        </AppText>
      </Pressable>
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
    overflow: "hidden",
    // The artwork's own sky / mint tones while it loads.
    backgroundColor: palette.green50,
  },

  heroBackground: {
    flex: 1,
    width: "100%",
    height: "100%",
  },

  // A solid white pill with a soft shadow: readable over the artwork, the
  // sheet or the keyboard-scrolled form alike. 40 dp + 8 dp hitSlop = 56 dp target.
  notNow: {
    position: "absolute",
    right: spacing.base,
    zIndex: 20,
    height: NOT_NOW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.md,
    paddingRight: spacing.base,
    borderRadius: radius.circle,
    backgroundColor: palette.white,
    borderWidth: 1,
    borderColor: palette.green100,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },

  notNowPressed: {
    backgroundColor: palette.green50,
  },

  notNowText: {
    marginLeft: 6,
    fontSize: 14,
    lineHeight: 18,
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

  // Overlaps the artwork's green hill; a soft upward shadow separates the two.
  sheet: {
    flexGrow: 1,
    marginTop: -24,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    shadowColor: "#0F2A1A",
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
    zIndex: 10,
  },

  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.green100,
    marginBottom: spacing.lg,
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

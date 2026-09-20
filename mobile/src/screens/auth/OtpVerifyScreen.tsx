/**
 * OTP verification.
 *
 * Designed to match the AdiOne OTP reference:
 * - top illustration
 * - Verify OTP heading
 * - mobile number + Change
 * - six OTP boxes
 * - resend timer
 * - security notice
 * - Verify & Continue button
 */

import { useEffect, useRef, useState } from "react";
import {
  ImageBackground,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import type { AuthResponse, SendOtpResponse } from "@shared";
import { formatIndianMobile } from "@shared/phone";
import { colors, radius, spacing } from "@shared/theme";

import { api, ApiRequestError } from "@/lib/api";
import { useAuth } from "@/lib/store";
import { AppText, Button, Screen } from "@/components/ui";
import type { AuthScreenProps } from "@/navigation/types";

import enterOtpBackground from "../../../assets/enterOtp-background.png";

const OTP_LENGTH = 6;

export default function OtpVerifyScreen({
  route,
  navigation,
}: AuthScreenProps<"OtpVerify">) {
  const { mobile } = route.params;

  const insets = useSafeAreaInsets();

  const setSession = useAuth((state) => state.setSession);

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  const [secondsLeft, setSecondsLeft] = useState(
    route.params.resendAfterSeconds,
  );

  const inputs = useRef<(TextInput | null)[]>([]);

  /* ---------------------------------------------------------------------- */
  /* Development OTP                                                        */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (route.params.devOtp) {
      setDigits(route.params.devOtp.split("").slice(0, OTP_LENGTH));
    }
  }, [route.params.devOtp]);

  /* ---------------------------------------------------------------------- */
  /* Countdown                                                              */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (secondsLeft <= 0) return;

    const timer = setInterval(() => {
      setSecondsLeft((value) => Math.max(0, value - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsLeft]);

  const code = digits.join("");

  /* ---------------------------------------------------------------------- */
  /* OTP input                                                              */
  /* ---------------------------------------------------------------------- */

  function handleChange(index: number, value: string): void {
    setError(null);

    // Handle pasted OTP / SMS autofill.
    if (value.length > 1) {
      const chars = value.replace(/\D/g, "").slice(0, OTP_LENGTH).split("");

      const next = Array(OTP_LENGTH).fill("");

      chars.forEach((char, position) => {
        next[position] = char;
      });

      setDigits(next);

      const nextIndex = Math.min(chars.length, OTP_LENGTH - 1);

      inputs.current[nextIndex]?.focus();

      return;
    }

    const digit = value.replace(/\D/g, "");

    const next = [...digits];

    next[index] = digit;

    setDigits(next);

    if (digit && index < OTP_LENGTH - 1) {
      inputs.current[index + 1]?.focus();
    }
  }

  function handleKeyPress(index: number, key: string): void {
    if (key === "Backspace" && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Verify OTP                                                             */
  /* ---------------------------------------------------------------------- */

  async function verify(): Promise<void> {
    if (code.length !== OTP_LENGTH) return;

    setBusy(true);
    setError(null);

    try {
      const result = await api.post<AuthResponse>("/auth/verify-otp", {
        mobile,
        otp: code,
      });

      await setSession(result);

      /*
       * Root navigator changes automatically after authentication.
       */
    } catch (err) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : "Invalid OTP. Please try again.";

      setError(message);

      setDigits(Array(OTP_LENGTH).fill(""));

      inputs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Resend OTP                                                             */
  /* ---------------------------------------------------------------------- */

  async function resend(): Promise<void> {
    // Guards against rapid double-taps firing a second request before the
    // first one's response (and its cooldown) has come back — the button is
    // only hidden once `secondsLeft` updates, which needs a network
    // round-trip. The backend enforces the real cooldown regardless; this
    // just avoids sending it duplicate requests from one tap.
    if (resendBusy) return;

    setError(null);
    setResendBusy(true);

    try {
      const result = await api.post<SendOtpResponse>("/auth/send-otp", {
        mobile,
      });

      setSecondsLeft(result.resendAfterSeconds);

      if (result.devOtp) {
        setDigits(result.devOtp.split("").slice(0, OTP_LENGTH));
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);

        // The backend is the source of truth for the cooldown — if it says
        // requests are still blocked (e.g. this one lost a race with
        // another in-flight request for the same number), resync the
        // on-screen countdown to match rather than leaving it at 0.
        if (err.retryAfterSeconds !== undefined) {
          setSecondsLeft(err.retryAfterSeconds);
        }
      } else {
        setError("Could not resend OTP.");
      }
    } finally {
      setResendBusy(false);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* UI                                                                      */
  /* ---------------------------------------------------------------------- */

  return (
    <Screen
      style={[
        styles.screen,
        {
          paddingTop: insets.top,
        },
      ]}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Top illustration                                                   */}
      {/* ------------------------------------------------------------------ */}

      <ImageBackground
        source={enterOtpBackground}
        style={styles.illustration}
        resizeMode="cover"
      />

      {/* ------------------------------------------------------------------ */}
      {/* Main content                                                        */}
      {/* ------------------------------------------------------------------ */}

      <View
        style={[
          styles.content,
          {
            paddingBottom: insets.bottom + spacing.lg,
          },
        ]}
      >
        {/* Back button */}
        <Pressable
          onPress={navigation.goBack}
          style={styles.backButton}
          hitSlop={12}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>

        {/* Heading */}
        <AppText variant="display" style={styles.heading}>
          Verify OTP
        </AppText>

        <AppText
          variant="body"
          color={colors.textSecondary}
          style={styles.subtitle}
        >
          Enter the 6-digit code sent to
        </AppText>

        {/* Mobile number */}
        <View style={styles.numberRow}>
          <View style={styles.phoneNumber}>
            <Ionicons name="call-outline" size={19} color={colors.primary} />

            <AppText variant="bodyStrong" style={styles.number}>
              {formatIndianMobile(mobile)}
            </AppText>
          </View>

          <Pressable onPress={navigation.goBack} hitSlop={10}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Change
            </AppText>
          </Pressable>
        </View>

        {/* ---------------------------------------------------------------- */}
        {/* OTP boxes                                                        */}
        {/* ---------------------------------------------------------------- */}

        <View style={styles.otpRow}>
          {digits.map((digit, index) => (
            <TextInput
              key={index}
              ref={(element) => {
                inputs.current[index] = element;
              }}
              value={digit}
              onChangeText={(value) => handleChange(index, value)}
              onKeyPress={({ nativeEvent }) =>
                handleKeyPress(index, nativeEvent.key)
              }
              keyboardType="number-pad"
              maxLength={OTP_LENGTH}
              autoFocus={index === 0}
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              selectionColor={colors.primary}
              style={[
                styles.otpBox,
                index === 0 && !digit ? styles.otpBoxFocused : null,
                digit ? styles.otpBoxFilled : null,
              ]}
            />
          ))}
        </View>

        {/* Error */}
        {error && (
          <AppText variant="caption" color={colors.danger} style={styles.error}>
            {error}
          </AppText>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Resend                                                            */}
        {/* ---------------------------------------------------------------- */}

        <View style={styles.resendContainer}>
          {secondsLeft > 0 ? (
            <AppText variant="caption" color={colors.textSecondary}>
              Resend OTP in{" "}
              <AppText variant="bodyStrong" color={colors.primary}>
                00:{String(secondsLeft).padStart(2, "0")}
              </AppText>
            </AppText>
          ) : (
            <Pressable onPress={resend} disabled={resendBusy} hitSlop={8}>
              <AppText
                variant="bodyStrong"
                color={resendBusy ? colors.textMuted : colors.primary}
              >
                {resendBusy ? "Sending…" : "Resend OTP"}
              </AppText>
            </Pressable>
          )}
        </View>

        {/* ---------------------------------------------------------------- */}
        {/* Security notice                                                   */}
        {/* ---------------------------------------------------------------- */}

        <View style={styles.securityNotice}>
          <View style={styles.securityIcon}>
            <Ionicons
              name="shield-checkmark"
              size={20}
              color={colors.primary}
            />
          </View>

          <View style={styles.securityContent}>
            <AppText variant="bodyStrong" color={colors.primary}>
              Do not share OTP with anyone
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.securityText}
            >
              For your security, never share your OTP with anyone.
            </AppText>
          </View>
        </View>

        {/* ---------------------------------------------------------------- */}
        {/* Verify button                                                     */}
        {/* ---------------------------------------------------------------- */}

        <Button
          label="Verify & Continue"
          onPress={verify}
          loading={busy}
          disabled={code.length !== OTP_LENGTH || busy}
          style={styles.verifyButton}
        />
      </View>
    </Screen>
  );
}

/* ========================================================================== */
/* Styles                                                                     */
/* ========================================================================== */

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 0,
    backgroundColor: colors.surface,
  },

  /* ---------------------------------------------------------------------- */
  /* Illustration                                                           */
  /* ---------------------------------------------------------------------- */

  illustration: {
    width: "100%",
    height: 155,
    marginTop: spacing.xs,
  },

  /* ---------------------------------------------------------------------- */
  /* Content                                                                */
  /* ---------------------------------------------------------------------- */

  content: {
    flex: 1,
    paddingHorizontal: spacing.base,
  },

  backButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -2,
  },

  heading: {
    marginTop: spacing.xs,
    fontSize: 27,
    lineHeight: 34,
    fontWeight: "700",
  },

  subtitle: {
    marginTop: spacing.xs,
  },

  /* ---------------------------------------------------------------------- */
  /* Mobile number                                                          */
  /* ---------------------------------------------------------------------- */

  numberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },

  phoneNumber: {
    flexDirection: "row",
    alignItems: "center",
  },

  number: {
    marginLeft: spacing.sm,
    fontSize: 15,
  },

  /* ---------------------------------------------------------------------- */
  /* OTP                                                                    */
  /* ---------------------------------------------------------------------- */

  otpRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.xl,
  },

  otpBox: {
    width: 45,
    height: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    textAlign: "center",
    fontSize: 21,
    fontWeight: "600",
    color: colors.textPrimary,
  },

  otpBoxFocused: {
    borderColor: colors.primary,
    borderWidth: 1.5,
  },

  otpBoxFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySurface,
  },

  error: {
    marginTop: spacing.sm,
  },

  /* ---------------------------------------------------------------------- */
  /* Resend                                                                 */
  /* ---------------------------------------------------------------------- */

  resendContainer: {
    marginTop: spacing.base,
  },

  /* ---------------------------------------------------------------------- */
  /* Security notice                                                        */
  /* ---------------------------------------------------------------------- */

  securityNotice: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xl,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.primarySurface,
  },

  securityIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.circle,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  securityContent: {
    flex: 1,
  },

  securityText: {
    marginTop: 2,
    lineHeight: 17,
  },

  /* ---------------------------------------------------------------------- */
  /* Button                                                                 */
  /* ---------------------------------------------------------------------- */

  verifyButton: {
    marginTop: spacing.lg,
    minHeight: 48,
  },
});

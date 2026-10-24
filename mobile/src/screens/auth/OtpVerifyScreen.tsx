/**
 * OTP verification.
 *
 * Designed to match the AdiOne OTP reference:
 * - top illustration
 * - Verify OTP heading
 * - mobile number + Change
 * - six OTP boxes
 * - resend timer
 * - Verify & Continue button
 * - security notice
 *
 * Keyboard: the OTP boxes, their error, Resend and Verify & Continue stay
 * above the keyboard whatever its height (useKeyboardReveal) — the same
 * treatment as the mobile-number screen, so moving between them never jumps.
 */

import { useEffect, useRef, useState } from "react";
import {
  ImageBackground,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import type { AuthResponse, SendOtpResponse } from "@shared";
import { formatIndianMobile } from "@shared/phone";
import { colors, radius, spacing } from "@shared/theme";

import { api, ApiRequestError, setAccessToken } from "@/lib/api";
import { loginCompleted } from "@/lib/authGate";
import { useAuth } from "@/lib/store";
import { useKeyboardReveal } from "@/lib/useKeyboardReveal";
import { AppText, Button } from "@/components/ui";
import type { AuthScreenProps } from "@/navigation/types";
import ReferralCodeStep from "./ReferralCodeStep";

import enterOtpBackground from "../../../assets/enterOtp-background.png";

const OTP_LENGTH = 6;

export default function OtpVerifyScreen({
  route,
  navigation,
}: AuthScreenProps<"OtpVerify">) {
  const { mobile } = route.params;

  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardReveal({ topReserve: insets.top + spacing.sm });

  const setSession = useAuth((state) => state.setSession);

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);

  // Holds a brand-new account's auth response while the referral-code step
  // (below) is shown in its place — `setSession` (and closing the login
  // modal after it) is deliberately deferred until
  // that step finishes, so it never gets a chance to unmount this screen
  // before the referral step has been shown. Stays null for every existing
  // (non-`isNewUser`) login, which never sees this step at all.
  const [pendingNewUserAuth, setPendingNewUserAuth] =
    useState<AuthResponse | null>(null);

  const [secondsLeft, setSecondsLeft] = useState(
    route.params.resendAfterSeconds,
  );

  const inputs = useRef<(TextInput | null)[]>([]);
  // The box the caret is in (autofocus starts at the first one).
  const [focused, setFocused] = useState<number | null>(0);

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

      // Signed in: the keyboard goes before the next step / the modal closes.
      Keyboard.dismiss();

      if (result.user.isNewUser) {
        // Makes the referral-code step's own authenticated `/referrals/apply`
        // call work (it needs a bearer token) without yet running the rest
        // of `setSession`'s side effects (refresh-token save, socket
        // connect, push registration, and — critically — the `status` flip
        // that swaps this whole screen away). Those all still happen, just
        // once `finishSignup` below runs.
        setAccessToken(result.tokens.accessToken);
        setPendingNewUserAuth(result);
        return;
      }

      await setSession(result);

      // Closes the login modal — back on the screen the customer was on —
      // and carries out the action that asked for the login, once.
      loginCompleted();
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
  /* Referral-code step (new users only)                                    */
  /* ---------------------------------------------------------------------- */

  async function finishSignup(): Promise<void> {
    if (!pendingNewUserAuth) return;
    await setSession(pendingNewUserAuth);
    loginCompleted();
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

  if (pendingNewUserAuth) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <KeyboardAvoidingView behavior="padding" style={styles.flex}>
          <ScrollView
            contentContainerStyle={{
              paddingBottom: insets.bottom + spacing.lg,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <ImageBackground
              source={enterOtpBackground}
              style={styles.illustration}
              resizeMode="cover"
            />
            <ReferralCodeStep onDone={finishSignup} />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* "padding" on both platforms, as on the mobile-number screen: with
          Android edge-to-edge the window is not resized for the keyboard. */}
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <View {...keyboard.frameProps} style={styles.flex}>
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

              <View style={styles.content}>
                {/* Back button */}
                <Pressable
                  onPress={navigation.goBack}
                  style={styles.backButton}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                >
                  <Ionicons
                    name="arrow-back"
                    size={24}
                    color={colors.textPrimary}
                  />
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
                    <Ionicons
                      name="call-outline"
                      size={19}
                      color={colors.primary}
                    />

                    <AppText variant="bodyStrong" style={styles.number}>
                      {formatIndianMobile(mobile)}
                    </AppText>
                  </View>

                  <Pressable
                    onPress={navigation.goBack}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Change mobile number"
                  >
                    <AppText variant="bodyStrong" color={colors.primary}>
                      Change
                    </AppText>
                  </Pressable>
                </View>

                {/* Kept above the keyboard: OTP boxes → Verify & Continue. */}
                <View ref={keyboard.blockRef} collapsable={false}>
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
                        onFocus={() => {
                          setFocused(index);
                          keyboard.reveal();
                        }}
                        onBlur={() =>
                          setFocused((current) =>
                            current === index ? null : current,
                          )
                        }
                        keyboardType="number-pad"
                        maxLength={OTP_LENGTH}
                        autoFocus={index === 0}
                        textContentType="oneTimeCode"
                        autoComplete="sms-otp"
                        selectionColor={colors.primary}
                        accessibilityLabel={`OTP digit ${index + 1} of ${OTP_LENGTH}`}
                        style={[
                          styles.otpBox,
                          digit ? styles.otpBoxFilled : null,
                          focused === index ? styles.otpBoxFocused : null,
                        ]}
                      />
                    ))}
                  </View>

                  {/* Error */}
                  {error && (
                    <AppText
                      variant="caption"
                      color={colors.danger}
                      style={styles.error}
                    >
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
                      <Pressable
                        onPress={resend}
                        disabled={resendBusy}
                        hitSlop={8}
                      >
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
              </View>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
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

  flex: {
    flex: 1,
  },

  scrollContent: {
    flexGrow: 1,
  },

  /* ---------------------------------------------------------------------- */
  /* Illustration                                                         */
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
    marginTop: spacing.lg,
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
    marginTop: spacing.base,
    minHeight: 48,
  },
});

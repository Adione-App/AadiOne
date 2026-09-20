import { useEffect, useState } from "react";
import {
  Alert,
  AppState,
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import * as Crypto from "expo-crypto";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";

import { OrderStatus, type CreatePaymentResponse } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { api, ApiRequestError } from "@/lib/api";

import {
  AppText,
  Button,
  Card,
  Input,
  Loading,
  NoticeStrip,
  Screen,
} from "@/components/ui";

type Stage = "ready" | "opened" | "claimed";

const NO_UPI_APP =
  "No compatible UPI app found. Please install Google Pay, PhonePe, Paytm, BHIM or another UPI app.";

// Keep these files directly inside mobile/assets/.
const CHECKOUT_UPI_BANNER = require("../../../assets/upi-page-banner.png");
const CHECKOUT_PENDING_BANNER = require("../../../assets/payment-pending-banner.png");

export default function UpiPaymentScreen({
  orderId,
  onPaid,
  onCancel,
  onCancelled,
}: {
  orderId: string;
  onPaid: () => void;
  /** Leaving WITHOUT cancelling — a real payment attempt may be in flight,
   * so the order stays pending and this should land somewhere the customer
   * can check on it later (Order Tracking). */
  onCancel: () => void;
  /** The order was just actually cancelled — nothing to track, so this
   * should return the customer to a normal screen (the cart), not tracking
   * for an order that no longer exists in any meaningful sense. */
  onCancelled: () => void;
}) {
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<Stage>("ready");
  const [utr, setUtr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [claimIdempotencyKey] = useState(() => Crypto.randomUUID());

  /*
   * One idempotency key for this payment-intent creation attempt.
   * Retrying the request must not create multiple payment records.
   */
  const [paymentIdempotencyKey] = useState(() => Crypto.randomUUID());

  /*
   * The backend creates the UPI intent.
   *
   * IMPORTANT:
   * The amount displayed on this screen comes ONLY from
   * intent.data.amountPaise returned by the server.
   * Never calculate or hardcode the payment amount on the client.
   */
  const intent = useQuery({
    queryKey: ["payment-intent", orderId],
    queryFn: () =>
      api.post<CreatePaymentResponse>(
        "/payments/create",
        { orderId },
        paymentIdempotencyKey,
      ),
    staleTime: Infinity,
    retry: false,
  });

  /*
   * Payment status is checked only after the customer explicitly
   * claims that they have paid.
   *
   * Returning from a UPI application is NOT payment success.
   */
  const order = useQuery({
    queryKey: ["order-payment-status", orderId],
    queryFn: () =>
      api.get<{
        status: OrderStatus;
        paymentStatus: string;
      }>(`/payments/${orderId}/status`),
    enabled: stage === "claimed",
    refetchInterval: stage === "claimed" ? 10_000 : false,
  });

  /*
   * Only the backend-confirmed order state can finish this screen.
   * The customer claiming payment does NOT directly mark payment as paid.
   */
  useEffect(() => {
    if (order.data && order.data.status !== OrderStatus.PENDING_PAYMENT) {
      onPaid();
    }
  }, [order.data, onPaid]);

  /*
   * Returning from the UPI app is NOT payment success.
   * It only means the customer has returned to AdiOne.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && stage === "opened") {
        setError(null);
      }
    });

    return () => subscription.remove();
  }, [stage]);

  async function openUpiPayment(): Promise<void> {
    const url = intent.data?.upiIntentUrl;

    if (!url) {
      setError("UPI payment is currently unavailable. Please try again.");
      return;
    }

    setError(null);

    try {
      const Linking = await import("expo-linking");
      const supported = await Linking.canOpenURL(url);

      if (!supported) {
        setError(NO_UPI_APP);
        return;
      }

      await Linking.openURL(url);

      // Opening the UPI app is NOT payment confirmation.
      setStage("opened");
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not open a compatible UPI app. Please try again.",
      );
    }
  }

  async function claimPaid(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      await api.post(
        "/payments/claim",
        {
          orderId,
          utr: utr.trim().length === 12 ? utr.trim() : null,
        },
        claimIdempotencyKey,
      );

      // This only tells the backend: "Customer says they paid."
      // It does NOT mark the payment as paid.
      setStage("claimed");
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not submit the payment information.",
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Leaving before ever successfully opening a UPI app (`stage` never left
   * "ready" — see `openUpiPayment`) means no payment was attempted at all,
   * not even a failed one. Previously this order was left sitting as
   * PENDING_PAYMENT forever regardless — indistinguishable from a real
   * abandoned payment, and confusing to see in order history with nothing
   * to actually verify. Since NOTHING was attempted, the order is safe to
   * cancel outright (the existing self-cancel endpoint already allows this
   * for any PENDING_PAYMENT order — see order.service.ts's
   * `canCustomerCancel`), instead of leaving a phantom order behind. Once a
   * UPI app HAS been opened, this reverts to the original "might have paid,
   * leave it pending" behaviour, since a real attempt may be in flight and
   * must never be cancelled out from under the customer.
   */
  function confirmLeave(): void {
    if (stage !== "ready") {
      Alert.alert(
        "Leave payment?",
        "Your payment will remain pending. If you paid successfully, the store can verify it from the merchant account.",
        [
          { text: "Stay", style: "cancel" },
          { text: "Go back", onPress: onCancel },
        ],
      );
      return;
    }

    Alert.alert(
      "Cancel this order?",
      "You haven't made a payment yet, so this order will be cancelled. You can add items to your cart and order again anytime.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: "Cancel order",
          style: "destructive",
          onPress: () => void cancelUnattemptedOrder(),
        },
      ],
    );
  }

  async function cancelUnattemptedOrder(): Promise<void> {
    if (cancelling) return;
    setCancelling(true);

    try {
      await api.post(`/orders/${orderId}/cancel`, {
        reason: "Customer left before attempting payment",
      });
      onCancelled();
    } catch {
      // Best-effort — if cancelling fails for any reason, fall back to the
      // original safe behaviour rather than leaving the customer stuck on
      // this screen with no way out.
      onCancel();
    } finally {
      setCancelling(false);
    }
  }

  if (intent.isLoading) {
    return <Loading label="Preparing UPI payment…" />;
  }

  if (intent.isError || !intent.data || !intent.data.upiIntentUrl) {
    return (
      <Screen
        style={{
          padding: spacing.base,
          paddingTop: insets.top + spacing.xxl,
        }}
      >
        <NoticeStrip
          message={
            intent.error instanceof ApiRequestError
              ? intent.error.message
              : "Could not prepare the UPI payment. Please try again."
          }
        />

        <Button
          label="Go back"
          variant="secondary"
          // The payment intent itself failed, so — same as never opening a
          // UPI app — nothing was ever attempted. `confirmLeave` already
          // knows to cancel the order in that case instead of leaving it
          // stranded as pending.
          onPress={confirmLeave}
          disabled={cancelling}
          loading={cancelling}
          style={{ marginTop: spacing.base }}
        />
      </Screen>
    );
  }

  /*
   * The amount is ALWAYS taken from the backend-created payment intent.
   */
  const amount = formatPaise(intent.data.amountPaise);
  const vpa = intent.data.upiVpa ?? "";

  return (
    <Screen>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.sm,
          },
        ]}
      >
        <Pressable
          onPress={confirmLeave}
          disabled={cancelling}
          hitSlop={12}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <AppText variant="h2">←</AppText>
        </Pressable>

        <View style={styles.headerText}>
          <AppText variant="h3">
            {stage === "ready" ? "Pay with UPI" : "Payment Verification"}
          </AppText>
          <AppText
            variant="body"
            color={colors.textSecondary}
            style={styles.headerSubtitle}
          >
            {stage === "ready"
              ? "Complete your payment to place the order"
              : "We are waiting for your payment"}
          </AppText>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {error && <NoticeStrip message={error} />}

        {stage === "ready" ? (
          <ReadyPaymentView
            amount={amount}
            vpa={vpa}
            onPay={() => void openUpiPayment()}
          />
        ) : (
          <VerificationView
            amount={amount}
            vpa={vpa}
            utr={utr}
            setUtr={setUtr}
            busy={busy}
            claimed={stage === "claimed"}
            onClaim={() => void claimPaid()}
            onPayAgain={() => void openUpiPayment()}
            onViewOrder={onPaid}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function ReadyPaymentView({
  amount,
  vpa,
  onPay,
}: {
  amount: string;
  vpa: string;
  onPay: () => void;
}) {
  return (
    <>
      {/* Top UPI hero */}
      <View style={styles.upiHero}>
        <View style={styles.heroAmountColumn}>
          <AppText variant="body" color={colors.textSecondary}>
            Total Amount
          </AppText>

          <AppText
            variant="displayLarge"
            color={colors.primary}
            style={styles.heroAmount}
          >
            {amount}
          </AppText>

          <AppText
            variant="body"
            color={colors.textSecondary}
            numberOfLines={1}
          >
            to {vpa}
          </AppText>

          <View style={styles.securePill}>
            <Ionicons
              name="shield-checkmark"
              size={18}
              color={colors.primary}
            />
            <AppText
              variant="caption"
              color={colors.primary}
              style={styles.securePillText}
            >
              Secure UPI Payment
            </AppText>
          </View>
        </View>

        <ImageBackground
          source={CHECKOUT_UPI_BANNER}
          resizeMode="contain"
          style={styles.heroArtwork}
          imageStyle={styles.heroArtworkImage}
        />
      </View>

      {/* How it works */}
      <Card style={styles.howCard}>
        <AppText variant="h3" style={styles.sectionTitle}>
          How it works?
        </AppText>

        <PaymentStep
          number="1"
          icon="paper-plane"
          title={`Tap on “Pay ${amount} via UPI”`}
          description="Your phone will open an installed UPI app with the merchant and amount already filled in."
          connected
        />

        <PaymentStep
          number="2"
          icon="shield-checkmark"
          title="Complete the payment"
          description="Approve the payment inside your UPI app (GPay, PhonePe, Paytm, BHIM or any UPI app)."
          connected
        />

        <PaymentStep
          number="3"
          icon="arrow-undo"
          title="Return to this app"
          description="After successful payment, come back to confirm your order status."
        />

        <Pressable
          onPress={onPay}
          style={styles.primaryPaymentButton}
          accessibilityRole="button"
          accessibilityLabel={`Pay ${amount} via UPI`}
        >
          <Ionicons name="paper-plane" size={27} color="#FFFFFF" />
          <AppText
            variant="bodyStrong"
            color="#FFFFFF"
            style={styles.primaryPaymentText}
          >
            Pay {amount} via UPI
          </AppText>
        </Pressable>
      </Card>

      {/* Security message */}
      <View style={styles.securityBanner}>
        <View style={styles.securityIconCircle}>
          <Ionicons name="shield-checkmark" size={28} color={colors.primary} />
        </View>
        <View style={styles.bannerTextContent}>
          <AppText variant="bodyStrong" color={colors.primary}>
            100% Secure Payments
          </AppText>
          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.bannerDescription}
          >
            Your payment information is safe. We do not store your UPI details.
          </AppText>
        </View>
      </View>

      <View style={styles.infoBanner}>
        <Ionicons name="information-circle-outline" size={31} color="#246A92" />
        <AppText
          variant="caption"
          color={colors.textSecondary}
          style={styles.infoText}
        >
          Returning from the UPI app does not automatically confirm your
          payment. The store verifies the transaction before processing your
          order.
        </AppText>
      </View>
    </>
  );
}

function PaymentStep({
  number,
  icon,
  title,
  description,
  connected = false,
}: {
  number: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  connected?: boolean;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepNumberColumn}>
        <View style={styles.stepNumberCircle}>
          <AppText variant="bodyStrong" color={colors.primary}>
            {number}
          </AppText>
        </View>
        {connected && <View style={styles.stepConnector} />}
      </View>

      <View style={styles.stepIconCircle}>
        <Ionicons name={icon} size={29} color={colors.primary} />
      </View>

      <View style={styles.stepContent}>
        <AppText variant="bodyStrong" color={colors.textPrimary}>
          {title}
        </AppText>
        <AppText
          variant="body"
          color={colors.textSecondary}
          style={styles.stepDescription}
        >
          {description}
        </AppText>
        {connected && <View style={styles.stepDivider} />}
      </View>
    </View>
  );
}

function VerificationView({
  amount,
  vpa,
  utr,
  setUtr,
  busy,
  claimed,
  onClaim,
  onPayAgain,
  onViewOrder,
}: {
  amount: string;
  vpa: string;
  utr: string;
  setUtr: (value: string) => void;
  busy: boolean;
  claimed: boolean;
  onClaim: () => void;
  onPayAgain: () => void;
  onViewOrder: () => void;
}) {
  return (
    <>
      {/* Payment pending banner */}
      <Image
        source={CHECKOUT_PENDING_BANNER}
        resizeMode="contain"
        style={styles.pendingHero}
        accessibilityLabel="Payment Pending"
      />

      {/* Amount + store */}
      <View style={styles.amountStoreCard}>
        <View style={styles.amountColumn}>
          <AppText variant="body" color={colors.textSecondary}>
            Amount
          </AppText>
          <AppText
            variant="displayLarge"
            color={colors.primary}
            style={styles.verificationAmount}
          >
            {amount}
          </AppText>
          <AppText
            variant="body"
            color={colors.textSecondary}
            numberOfLines={1}
          >
            to {vpa}
          </AppText>
        </View>

        <View style={styles.verticalDivider} />

        <View style={styles.storeColumn}>
          <View style={styles.storeIconCircle}>
            <Ionicons
              name="storefront-outline"
              size={29}
              color={colors.primary}
            />
          </View>
          <View style={styles.storeTextColumn}>
            <AppText variant="body" color={colors.textSecondary}>
              Store
            </AppText>
            <AppText
              variant="bodyStrong"
              color={colors.textPrimary}
              style={styles.storeName}
            >
              AdiOne
            </AppText>
            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.storeDescription}
            >
              Order will be confirmed after payment verification.
            </AppText>
          </View>
        </View>
      </View>

      {claimed ? (
        <Card style={styles.claimedCard}>
          <View style={styles.claimedIconCircle}>
            <Ionicons name="checkmark" size={27} color={colors.primary} />
          </View>
          <AppText variant="h3">Payment submitted</AppText>
          <AppText
            variant="body"
            color={colors.textSecondary}
            style={styles.claimedDescription}
          >
            Your payment claim has been submitted. The store will verify the
            transaction against its merchant UPI account.
          </AppText>
          <AppText
            variant="bodyStrong"
            color={colors.textSecondary}
            style={styles.pendingStatus}
          >
            Payment status: Pending
          </AppText>
          <Button
            label="View my order"
            variant="secondary"
            onPress={onViewOrder}
            style={{ marginTop: spacing.lg }}
          />
        </Card>
      ) : (
        <Card style={styles.completedCard}>
          <AppText variant="h3">Already completed the payment?</AppText>
          <AppText
            variant="body"
            color={colors.textSecondary}
            style={styles.completedDescription}
          >
            You can enter your UPI reference number to help us verify your
            payment. This is optional.
          </AppText>

          <View style={styles.utrInputWrap}>
            <Ionicons
              name="document-text-outline"
              size={26}
              color={colors.textSecondary}
            />

            <View style={styles.utrInputWrapper}>
              <Input
                value={utr}
                onChangeText={(value) => setUtr(value.replace(/\D/g, ""))}
                placeholder="UPI Reference / UTR (Optional)"
                keyboardType="number-pad"
                maxLength={12}
              />
            </View>
          </View>

          <Pressable
            onPress={onClaim}
            disabled={busy}
            style={[styles.primaryPaymentButton, busy && styles.disabledButton]}
            accessibilityRole="button"
            accessibilityLabel="I have paid"
          >
            <Ionicons name="checkmark" size={29} color="#FFFFFF" />
            <AppText
              variant="bodyStrong"
              color="#FFFFFF"
              style={styles.primaryPaymentText}
            >
              {busy ? "Submitting…" : "I Have Paid"}
            </AppText>
          </Pressable>
        </Card>
      )}

      {!claimed && (
        <>
          {/* OR separator */}
          <View style={styles.orRow}>
            <View />
            <AppText
              variant="body"
              color={colors.textSecondary}
              style={styles.orText}
            >
              OR
            </AppText>
            <View />
          </View>

          {/* Pay again */}
          <View style={styles.payAgainCard}>
            <View style={styles.payAgainIconCircle}>
              <Ionicons name="refresh" size={31} color={colors.primary} />
            </View>
            <View style={styles.payAgainContent}>
              <AppText variant="bodyStrong" color={colors.textPrimary}>
                Didn&apos;t complete the payment?
              </AppText>
              <AppText
                variant="body"
                color={colors.textSecondary}
                style={styles.payAgainDescription}
              >
                You can pay again using UPI.
              </AppText>
            </View>
            <Pressable
              onPress={onPayAgain}
              style={styles.payAgainButton}
              accessibilityRole="button"
              accessibilityLabel="Pay Again"
            >
              <AppText variant="bodyStrong" color={colors.primary}>
                Pay Again
              </AppText>
            </Pressable>
          </View>

          {/* Manual verification info */}
          <View style={styles.infoBanner}>
            <Ionicons
              name="information-circle-outline"
              size={31}
              color="#246A92"
            />
            <View style={styles.infoTextColumn}>
              <AppText variant="bodyStrong" color="#1478A6">
                Don&apos;t worry if you don&apos;t have the UTR.
              </AppText>
              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.bannerDescription}
              >
                The store can also verify your payment manually.
              </AppText>
            </View>
          </View>
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 6,
    backgroundColor: colors.surface,
  },

  back: {
    width: 32,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 0,
  },

  headerText: {
    flex: 1,
    minWidth: 0,
  },

  headerSubtitle: {
    marginTop: 0,
    fontSize: 14,
    lineHeight: 19,
  },

  scrollContent: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 50,
    gap: 12,
  },

  // Ready state
  upiHero: {
    minHeight: 188,
    borderWidth: 1,
    borderColor: "#D7F0E1",
    borderRadius: 16,
    backgroundColor: "#F2FBF6",
    overflow: "hidden",
    flexDirection: "row",
    position: "relative",
    padding: 14,
  },

  heroAmountColumn: {
    width: "46%",
    zIndex: 3,
  },

  heroAmount: {
    fontSize: 34,
    lineHeight: 40,
    marginTop: 1,
    marginBottom: 2,
    fontWeight: "800",
  },

  securePill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#E0F5E8",
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 9,
    gap: 4,
  },

  securePillText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },

  heroArtwork: {
    position: "absolute",
    // left: "77%",
    top: 0,
    bottom: 0,
    width: "100%",
  },

  heroArtworkImage: {
    opacity: 1,
  },

  howCard: {
    padding: 14,
  },

  sectionTitle: {
    marginBottom: 12,
    fontSize: 20,
    lineHeight: 25,
  },

  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: 86,
  },

  stepNumberColumn: {
    width: 34,
    alignItems: "center",
    position: "relative",
  },

  stepNumberCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#E6F7EC",
    justifyContent: "center",
    alignItems: "center",
  },

  stepConnector: {
    position: "absolute",
    top: 34,
    width: 1,
    height: 52,
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: "#A8E3BF",
  },

  stepIconCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#EAF8F0",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
    marginTop: -1,
  },

  stepContent: {
    flex: 1,
    marginLeft: 9,
    paddingTop: 0,
    minWidth: 0,
  },

  stepDescription: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
  },

  stepDivider: {
    height: 1,
    backgroundColor: "#E5E8EC",
    marginTop: 9,
    marginBottom: 9,
  },

  primaryPaymentButton: {
    minHeight: 50,
    borderRadius: 26,
    backgroundColor: colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingHorizontal: 14,
    marginTop: 9,
  },

  primaryPaymentText: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "800",
  },

  disabledButton: {
    opacity: 0.65,
  },

  securityBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#D7F0E1",
    backgroundColor: "#F2FBF6",
    borderRadius: 15,
    padding: 10,
  },

  securityIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#E2F5E9",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 9,
  },

  bannerTextContent: {
    flex: 1,
    minWidth: 0,
  },

  bannerDescription: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
  },

  infoBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#D8E9FA",
    backgroundColor: "#F2F8FF",
    borderRadius: 15,
    padding: 10,
  },

  infoText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 12,
    lineHeight: 17,
  },

  infoTextColumn: {
    flex: 1,
    marginLeft: 8,
    minWidth: 0,
  },

  // Verification state
  pendingHero: {
    width: "100%",
    height: 125,
    borderRadius: 16,
    overflow: "hidden",
  },

  amountStoreCard: {
    borderWidth: 1,
    borderColor: "#E3E7EC",
    borderRadius: 16,
    backgroundColor: colors.surface,
    padding: 11,
    flexDirection: "row",
    minHeight: 125,
  },

  amountColumn: {
    flex: 1,
    justifyContent: "center",
    paddingRight: 7,
    minWidth: 0,
  },

  verificationAmount: {
    fontSize: 29,
    lineHeight: 37,
    marginTop: 1,
    marginBottom: 1,
    fontWeight: "800",
  },

  verticalDivider: {
    width: 1,
    backgroundColor: "#DCE1E7",
    marginVertical: 5,
    marginRight: 9,
  },

  storeColumn: {
    flex: 1.05,
    flexDirection: "row",
    alignItems: "flex-start",
    paddingTop: 1,
    minWidth: 0,
  },

  storeIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#E5F7EC",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 7,
    marginTop: 8,
  },

  storeTextColumn: {
    flex: 1,
    minWidth: 0,
  },

  storeName: {
    marginTop: 1,
    fontSize: 14,
    lineHeight: 18,
  },

  storeDescription: {
    marginTop: 2,
    fontSize: 10,
    lineHeight: 14,
  },

  completedCard: {
    padding: 12,
  },

  completedDescription: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
  },

  utrInputWrap: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "#DDE1E7",
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 9,
    marginTop: 10,
    overflow: "hidden",
  },

  utrInputWrapper: {
    flex: 1,
    marginLeft: 5,
  },

  orRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 6,
    marginVertical: 2,
  },

  orText: {
    marginHorizontal: 9,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },

  payAgainCard: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: "#E3E7EC",
    borderRadius: 16,
    backgroundColor: colors.surface,
    padding: 9,
    flexDirection: "row",
    alignItems: "center",
  },

  payAgainIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#E5F7EC",
    justifyContent: "center",
    alignItems: "center",
  },

  payAgainContent: {
    flex: 1,
    marginLeft: 8,
    paddingRight: 5,
    minWidth: 0,
  },

  payAgainDescription: {
    marginTop: 1,
    fontSize: 11,
    lineHeight: 15,
  },

  payAgainButton: {
    minWidth: 86,
    height: 40,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 9,
  },

  claimedCard: {
    padding: 12,
    alignItems: "center",
  },

  claimedIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#E5F7EC",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 7,
  },

  claimedDescription: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },

  pendingStatus: {
    marginTop: 7,
  },
});

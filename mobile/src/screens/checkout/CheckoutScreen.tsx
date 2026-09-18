/**
 * Checkout (Task 14.10)
 *
 * UI redesigned to match the provided AdiOne checkout design:
 *
 * Step 1: Address
 * Step 2: Payment
 * Step 3: Review
 *
 * IMPORTANT:
 * - Server remains the source of truth for all pricing.
 * - No frontend total calculation is performed.
 * - One idempotency key is reused for one checkout attempt.
 * - expectedTotalPaise is only a safety check.
 * - Payment behaviour remains unchanged.
 *
 * UI changes:
 * - Modern checkout header
 * - 3-step progress indicator
 * - Address cards
 * - No edit address button
 * - No add-new-address option
 * - UPI / COD payment cards
 * - Secure payment section
 * - Review screen
 * - Sticky bottom checkout bar
 */

import { useCallback, useEffect, useState } from "react";
import type { ComponentProps } from "react";
import * as Crypto from "expo-crypto";
import {
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ErrorCode,
  PaymentMethod,
  type AddressDto,
  type CheckoutQuoteResponse,
  type OrderDetailDto,
} from "@shared";

import { formatPaise } from "@shared/money";
import { formatEtaRange } from "@shared/distance";
import { colors, radius, spacing } from "@shared/theme";

import { api, ApiRequestError, resolveImageUrl } from "@/lib/api";
import { clearCartAfterOrder, keys, useCart } from "@/lib/queries";
import { useLocation } from "@/lib/store";

import {
  AppText,
  Button,
  Card,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
} from "@/components/ui";

type Step = "address" | "payment" | "review";

/**
 * Checkout artwork.
 *
 * Put these four supplied background images directly in:
 *   mobile/assets/
 */
// const CHECKOUT_ADDRESS_BANNER = require("@/assets/checkout-delivary-add-banner.png");
// const CHECKOUT_DELIVERY_BANNER = require("@/assets/checkout-delivary-bottom.png");
// const CHECKOUT_REVIEW_ADDRESS_BANNER = require("@/assets/checkout-review-add.png");
// const CHECKOUT_UPI_BANNER = require("@/assets/checkout-review-pay.png");

const CHECKOUT_ADDRESS_BANNER = require("../../../assets/checkout-delivary-add-banner.png");

const CHECKOUT_DELIVERY_BANNER = require("../../../assets/checkout-delivary-bottom.png");

const CHECKOUT_REVIEW_ADDRESS_BANNER = require("../../../assets/checkout-review-add.png");

const CHECKOUT_UPI_BANNER = require("../../../assets/checkout-review-pay.png");

const STEPS: {
  key: Step;
  label: string;
}[] = [
  {
    key: "address",
    label: "Address",
  },
  {
    key: "payment",
    label: "Payment",
  },
  {
    key: "review",
    label: "Review",
  },
];

export default function CheckoutScreen({
  onBack,
  onPlaced,
  onAddAddress,
  onEditAddress,
}: {
  onBack: () => void;
  onPlaced: (order: OrderDetailDto, requiresPayment: boolean) => void;
  onAddAddress: () => void;
  onEditAddress?: (address: AddressDto) => void;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("address");

  const [addressId, setAddressId] = useState<string | null>(null);

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    PaymentMethod.COD,
  );

  const [placing, setPlacing] = useState(false);

  const [error, setError] = useState<string | null>(null);

  /**
   * One idempotency key per checkout attempt.
   *
   * It is regenerated only when the customer must start
   * a new attempt after a basket/price change.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    Crypto.randomUUID(),
  );

  /* ============================================================
   * CART
   * ============================================================
   */

  // Same query key every other cart-reading screen uses (see MainTabs.tsx)
  // — a bare `useCart()` here would default distanceKm to `null`, a second
  // independently-fetched cache entry for the same cart.
  const serviceabilityForCart = useLocation((state) => state.serviceability);
  const cart = useCart(serviceabilityForCart?.distanceKm ?? null);

  /* ============================================================
   * ADDRESSES
   * ============================================================
   */

  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
  });

  /**
   * Automatically select the customer's default serviceable
   * address, otherwise the first serviceable address.
   */
  useEffect(() => {
    if (addressId || !addresses.data) {
      return;
    }

    const preferred =
      addresses.data.find((item) => item.isDefault && item.isServiceable) ??
      addresses.data.find((item) => item.isServiceable);

    if (preferred) {
      setAddressId(preferred.id);
    }
  }, [addresses.data, addressId]);

  /* ============================================================
   * CHECKOUT QUOTE
   * ============================================================
   */

  const quote = useQuery({
    queryKey: ["checkout-quote", addressId],

    queryFn: () =>
      api.post<CheckoutQuoteResponse>("/checkout/quote", {
        addressId,
      }),

    enabled: addressId !== null,
  });

  /**
   * COD can become unavailable between screens.
   *
   * If server says COD is no longer allowed, automatically
   * switch to online/UPI.
   */
  useEffect(() => {
    if (
      quote.data &&
      paymentMethod === PaymentMethod.COD &&
      !quote.data.codAllowed
    ) {
      setPaymentMethod(PaymentMethod.ONLINE);
    }
  }, [quote.data, paymentMethod]);

  /* ============================================================
   * PLACE ORDER
   * ============================================================
   */

  const placeOrder = useCallback(async (): Promise<void> => {
    if (!addressId || !quote.data || placing) {
      return;
    }

    setPlacing(true);
    setError(null);

    try {
      const result = await api.post<{
        order: OrderDetailDto;
        requiresPayment: boolean;
      }>(
        "/orders",
        {
          addressId,
          paymentMethod,

          /**
           * Safety check only.
           *
           * This is NOT the charged amount.
           * The server calculates the real amount.
           */
          expectedTotalPaise: quote.data.bill.totalPaise,
        },
        idempotencyKey,
      );

      // The order transaction already marked the cart CONVERTED server-side
      // (it's genuinely empty now, not an optimistic guess) — write that
      // directly instead of only invalidating, so the badge and every
      // cart-reading screen update in this same tick instead of waiting on
      // a background GET /cart that a slow connection could delay well past
      // the moment the customer is already looking at the success screen.
      clearCartAfterOrder(queryClient);

      // Still reconcile with the server in the background for the fields
      // clearCartAfterOrder doesn't fabricate (checkoutEnabled, changes,
      // etc.) — fire-and-forget, nothing waits on this.
      void queryClient.invalidateQueries({ queryKey: keys.cart });

      await queryClient.invalidateQueries({
        queryKey: keys.orders,
      });

      onPlaced(result.order, result.requiresPayment);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);

        /**
         * Prices/items changed.
         *
         * Refresh quote and create a new checkout
         * attempt with a new idempotency key.
         */
        if (
          err.code === ErrorCode.PRICE_CHANGED ||
          err.code === ErrorCode.ITEM_OUT_OF_STOCK
        ) {
          await quote.refetch();

          setIdempotencyKey(Crypto.randomUUID());
        }
      } else {
        setError("Could not place your order. Please try again.");
      }
    } finally {
      setPlacing(false);
    }
  }, [
    addressId,
    quote,
    placing,
    paymentMethod,
    idempotencyKey,
    queryClient,
    onPlaced,
  ]);

  /* ============================================================
   * LOADING / ERROR
   * ============================================================
   */

  if (addresses.isLoading) {
    return <Loading label="Loading checkout…" />;
  }

  if (addresses.isError) {
    return (
      <ErrorState
        message="We could not load your addresses."
        onRetry={() => void addresses.refetch()}
      />
    );
  }

  const bill = quote.data?.bill;

  const selected =
    addresses.data?.find((item) => item.id === addressId) ?? null;

  const currentStepIndex = STEPS.findIndex((item) => item.key === step);

  const canContinueAddress =
    Boolean(addressId) && Boolean(quote.data?.serviceability.serviceable);

  /* ============================================================
   * MAIN
   * ============================================================
   */

  return (
    <Screen>
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.xs,
          },
        ]}
      >
        <Pressable
          onPress={onBack}
          hitSlop={10}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <AppText variant="h2">←</AppText>
        </Pressable>

        <View style={styles.headerText}>
          <AppText variant="h1" style={styles.headerTitle}>
            Checkout
          </AppText>

          <AppText
            variant="body"
            color={colors.textSecondary}
            style={styles.headerSubtitle}
            numberOfLines={1}
          >
            {step === "review"
              ? "Review and confirm your order"
              : "Complete your order in 3 simple steps"}
          </AppText>
        </View>
      </View>

      <CheckoutStepper currentIndex={currentStepIndex} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: 178 + insets.bottom,
          },
        ]}
      >
        {error && (
          <View style={styles.noticeSpacing}>
            <NoticeStrip message={error} />
          </View>
        )}

        {quote.data?.changes.map((change, index) => (
          <View key={`${change.type}-${index}`} style={styles.noticeSpacing}>
            <NoticeStrip message={change.message} />
          </View>
        ))}

        {step === "address" && (
          <AddressStep
            addresses={addresses.data ?? []}
            selectedId={addressId}
            onSelect={setAddressId}
            quote={quote.data}
            onAddAddress={onAddAddress}
            onEditAddress={onEditAddress}
          />
        )}

        {step === "payment" && (
          <PaymentStep
            paymentMethod={paymentMethod}
            codAllowed={quote.data?.codAllowed ?? false}
            codBlockedReason={quote.data?.codBlockedReason}
            onSelect={setPaymentMethod}
          />
        )}

        {step === "review" && bill && (
          <ReviewStep
            selectedAddress={selected}
            bill={bill}
            paymentMethod={paymentMethod}
            cart={cart.data ?? null}
          />
        )}
      </ScrollView>

      <View
        style={[
          styles.bottomBar,
          {
            paddingBottom: insets.bottom + spacing.sm,
          },
        ]}
      >
        {bill && (
          <View style={styles.paySummary}>
            <View>
              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.toPayLabel}
              >
                To Pay
              </AppText>

              <AppText
                variant="h2"
                color={colors.textPrimary}
                style={styles.toPayAmount}
              >
                {formatPaise(bill.totalPaise)}
              </AppText>
            </View>

            <Ionicons
              name="information-circle-outline"
              size={21}
              color={colors.textSecondary}
              style={styles.infoIcon}
            />
          </View>
        )}

        {step === "review" ? (
          <Button
            label={
              paymentMethod === PaymentMethod.COD
                ? "Place Order  →"
                : "Continue to Payment  →"
            }
            onPress={() => void placeOrder()}
            loading={placing}
            disabled={placing || !bill || !addressId}
            style={styles.bottomButton}
          />
        ) : (
          <Button
            label="Continue  →"
            onPress={() => setStep(step === "address" ? "payment" : "review")}
            disabled={step === "address" ? !canContinueAddress : false}
            style={styles.bottomButton}
          />
        )}
      </View>
    </Screen>
  );
}

/* ==============================================================
 * CHECKOUT STEPPER
 * ============================================================== */

function CheckoutStepper({ currentIndex }: { currentIndex: number }) {
  return (
    <View style={styles.stepperContainer}>
      {STEPS.map((item, index) => {
        const completed = index < currentIndex;
        const active = index === currentIndex;
        const doneOrActive = completed || active;

        return (
          <View key={item.key} style={styles.stepWrapper}>
            {index > 0 && (
              <View
                style={[
                  styles.stepLine,
                  index <= currentIndex && styles.stepLineActive,
                ]}
              />
            )}

            <View
              style={[
                styles.stepCircle,
                doneOrActive && styles.stepCircleActive,
              ]}
            >
              {completed ? (
                <Ionicons name="checkmark" size={17} color={colors.onPrimary} />
              ) : (
                <AppText
                  variant="caption"
                  color={active ? colors.onPrimary : colors.textSecondary}
                  style={styles.stepNumber}
                >
                  {index + 1}
                </AppText>
              )}
            </View>

            <AppText
              variant="caption"
              color={doneOrActive ? colors.primary : colors.textSecondary}
              style={[styles.stepLabel, doneOrActive && styles.stepLabelActive]}
            >
              {item.label}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

/* ==============================================================
 * ADDRESS STEP
 * ============================================================== */

function AddressStep({
  addresses,
  selectedId,
  onSelect,
  quote,
  onAddAddress,
  onEditAddress,
}: {
  addresses: AddressDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  quote: CheckoutQuoteResponse | undefined;
  onAddAddress: () => void;
  onEditAddress?: (address: AddressDto) => void;
}) {
  return (
    <View>
      {/* Delivery address banner */}
      <ImageBackground
        source={CHECKOUT_ADDRESS_BANNER}
        resizeMode="cover"
        style={styles.addressHero}
        imageStyle={styles.addressHeroImage}
      >
        <View style={styles.heroText}>
          <View style={styles.heroTitleRow}>
            <View style={styles.heroIconCircle}>
              <Ionicons name="location" size={20} color={colors.primary} />
            </View>

            <View style={styles.heroTitleContent}>
              <AppText
                variant="bodyStrong"
                color={colors.textPrimary}
                style={styles.heroTitle}
              >
                Delivery Address
              </AppText>

              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.heroDescription}
              >
                Select a delivery address where you want to receive your order
              </AppText>
            </View>
          </View>
        </View>
      </ImageBackground>

      {/* Address list */}
      {addresses.length === 0 ? (
        <Card style={styles.emptyAddressCard}>
          <Ionicons
            name="location-outline"
            size={25}
            color={colors.textMuted}
          />
          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.emptyAddressText}
          >
            No delivery address is available.
          </AppText>
        </Card>
      ) : (
        <View style={styles.addressList}>
          {addresses.map((address) => {
            const selected = address.id === selectedId;
            const disabled = !address.isServiceable;

            return (
              <Pressable
                key={address.id}
                onPress={() => {
                  if (!disabled) {
                    onSelect(address.id);
                  }
                }}
                disabled={disabled}
                style={[
                  styles.addressCard,
                  selected && styles.addressCardSelected,
                  disabled && styles.addressCardDisabled,
                ]}
                accessibilityRole="radio"
                accessibilityState={{
                  selected,
                  disabled,
                }}
              >
                <AddressIcon label={address.label} selected={selected} />

                <View style={styles.addressContent}>
                  <View style={styles.addressTitleRow}>
                    <AppText
                      variant="bodyStrong"
                      color={colors.textPrimary}
                      numberOfLines={1}
                      style={styles.addressTitle}
                    >
                      {address.label}
                    </AppText>

                    {address.isDefault && selected && (
                      <View style={styles.defaultBadge}>
                        <AppText
                          variant="caption"
                          color={colors.primary}
                          style={styles.defaultBadgeText}
                        >
                          Default
                        </AppText>
                      </View>
                    )}
                  </View>

                  <AppText
                    variant="caption"
                    color={colors.textSecondary}
                    numberOfLines={1}
                    style={styles.addressLine}
                  >
                    {address.fullName} • {address.mobile}
                  </AppText>

                  <AppText
                    variant="caption"
                    color={colors.textSecondary}
                    numberOfLines={1}
                    style={styles.addressLine}
                  >
                    {address.area}, {address.city} {address.pincode}
                  </AppText>

                  {!address.isServiceable && (
                    <AppText
                      variant="caption"
                      color={colors.danger}
                      numberOfLines={1}
                      style={styles.unserviceableText}
                    >
                      We don't deliver to this address
                    </AppText>
                  )}
                </View>

                <View style={styles.addressActions}>
                  <Pressable
                    hitSlop={8}
                    style={styles.editAddressButton}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${address.label} address`}
                    onPress={() => onEditAddress?.(address)}
                    disabled={!onEditAddress}
                  >
                    {/* <Ionicons
                      name="create-outline"
                      size={19}
                      color={selected ? colors.primary : colors.textSecondary}
                    /> */}
                  </Pressable>

                  <View
                    style={[
                      styles.radioOuter,
                      selected && styles.radioOuterSelected,
                    ]}
                  >
                    {selected && <View style={styles.radioInner} />}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <Pressable
        onPress={onAddAddress}
        style={styles.addAddressCard}
        accessibilityRole="button"
        accessibilityLabel="Add new address"
      >
        <View style={styles.addAddressIcon}>
          <Ionicons name="add" size={29} color={colors.primary} />
        </View>

        <View style={styles.addAddressContent}>
          <AppText
            variant="bodyStrong"
            color={colors.primary}
            style={styles.addAddressTitle}
          >
            Add New Address
          </AppText>
          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.addAddressSubtitle}
          >
            Save a new address for faster checkout
          </AppText>
        </View>

        <Ionicons name="chevron-forward" size={25} color={colors.primary} />
      </Pressable>

      {/* Delivery ETA banner */}
      {quote?.serviceability.serviceable && (
        <ImageBackground
          source={CHECKOUT_DELIVERY_BANNER}
          resizeMode="cover"
          style={styles.deliveryBanner}
          imageStyle={styles.deliveryBannerImage}
        >
          <View style={styles.deliveryBannerContent}>
            <AppText
              variant="bodyStrong"
              color={colors.primary}
              style={styles.deliveryBannerTitle}
            >
              Delivery in{" "}
              {formatEtaRange(quote.etaMinMinutes, quote.etaMaxMinutes)}
            </AppText>
            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.deliveryBannerSubtitle}
              numberOfLines={1}
            >
              Fresh items, delivered to your doorstep
            </AppText>
          </View>
        </ImageBackground>
      )}
    </View>
  );
}

/* ==============================================================
 * ADDRESS ICON
 * ============================================================== */

function AddressIcon({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}) {
  const normalized = label.toLowerCase();

  let iconName: ComponentProps<typeof Ionicons>["name"] = "home-outline";

  if (normalized.includes("work")) {
    iconName = "briefcase-outline";
  } else if (normalized.includes("other")) {
    iconName = "business-outline";
  }

  return (
    <View style={[styles.addressIcon, selected && styles.addressIconSelected]}>
      <Ionicons
        name={iconName}
        size={22}
        color={selected ? colors.primary : colors.textSecondary}
      />
    </View>
  );
}

/* ==============================================================
 * PAYMENT STEP
 * ============================================================== */

function PaymentStep({
  paymentMethod,
  codAllowed,
  codBlockedReason,
  onSelect,
}: {
  paymentMethod: PaymentMethod;
  codAllowed: boolean;
  codBlockedReason?: string | null;
  onSelect: (method: PaymentMethod) => void;
}) {
  return (
    <View>
      <View style={styles.sectionHeading}>
        <AppText variant="h2" style={styles.sectionTitle}>
          Select Payment Method
        </AppText>

        <AppText
          variant="caption"
          color={colors.textSecondary}
          style={styles.sectionSubtitle}
        >
          Choose a payment method to continue
        </AppText>
      </View>

      <PaymentOption
        method={PaymentMethod.ONLINE}
        title="Pay by UPI"
        subtitle="GPay, PhonePe, Paytm, BHIM or any UPI app"
        badge="Instant & Secure"
        selected={paymentMethod === PaymentMethod.ONLINE}
        onPress={() => onSelect(PaymentMethod.ONLINE)}
      />

      <PaymentOption
        method={PaymentMethod.COD}
        title="Cash on Delivery"
        subtitle={
          codAllowed
            ? "Pay when your order is delivered"
            : (codBlockedReason ?? "Not available for this order")
        }
        selected={paymentMethod === PaymentMethod.COD}
        disabled={!codAllowed}
        onPress={() => onSelect(PaymentMethod.COD)}
      />

      <View style={styles.securityCard}>
        <View style={styles.securityIcon}>
          <Ionicons
            name="shield-checkmark-outline"
            size={23}
            color={colors.primary}
          />
        </View>

        <View style={styles.securityContent}>
          <AppText
            variant="bodyStrong"
            color={colors.textPrimary}
            style={styles.securityTitle}
          >
            100% Secure Payments
          </AppText>

          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.securityDescription}
          >
            Your payment information is safe and encrypted.
          </AppText>

          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.securityDescription}
          >
            We do not store your UPI details.
          </AppText>
        </View>
      </View>
    </View>
  );
}

/* ==============================================================
 * PAYMENT OPTION
 * ============================================================== */

function PaymentOption({
  method,
  title,
  subtitle,
  badge,
  selected,
  disabled,
  onPress,
}: {
  method: PaymentMethod;
  title: string;
  subtitle: string;
  badge?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const isUpi = method === PaymentMethod.ONLINE;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={[
        styles.paymentCard,
        selected && styles.paymentCardSelected,
        disabled && styles.paymentCardDisabled,
      ]}
      accessibilityRole="radio"
      accessibilityState={{
        selected,
        disabled,
      }}
    >
      {isUpi ? (
        <View style={[styles.paymentIcon, styles.upiIcon]}>
          <Ionicons name="qr-code-outline" size={25} color={colors.primary} />
        </View>
      ) : (
        <View style={[styles.paymentIcon, styles.cashIcon]}>
          <Ionicons name="cash-outline" size={25} color={colors.primary} />
        </View>
      )}

      <View style={styles.paymentContent}>
        <AppText
          variant="bodyStrong"
          color={colors.textPrimary}
          style={styles.paymentTitle}
          numberOfLines={1}
        >
          {title}
        </AppText>

        <AppText
          variant="caption"
          color={disabled ? colors.danger : colors.textSecondary}
          numberOfLines={2}
          style={styles.paymentSubtitle}
        >
          {subtitle}
        </AppText>

        {badge && selected && (
          <View style={styles.paymentBadge}>
            <Ionicons
              name="lock-closed-outline"
              size={12}
              color={colors.primary}
            />
            <AppText
              variant="caption"
              color={colors.primary}
              style={styles.paymentBadgeText}
            >
              {badge}
            </AppText>
          </View>
        )}

        {!disabled && !isUpi && selected && (
          <View style={styles.codAvailable}>
            <View style={styles.codAvailableIcon}>
              <Ionicons name="checkmark" size={13} color={colors.onPrimary} />
            </View>

            <View style={styles.codAvailableContent}>
              <AppText
                variant="caption"
                color={colors.primary}
                style={styles.codAvailableTitle}
              >
                Available for your location
              </AppText>

              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.codAvailableSubtitle}
              >
                Keep exact cash ready for a smooth delivery
              </AppText>
            </View>
          </View>
        )}
      </View>

      <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
        {selected && <View style={styles.radioInner} />}
      </View>
    </Pressable>
  );
}

/* ==============================================================
 * REVIEW STEP
 * ============================================================== */

function ReviewStep({
  selectedAddress,
  bill,
  paymentMethod,
  cart,
}: {
  selectedAddress: AddressDto | null;
  bill: CheckoutQuoteResponse["bill"];
  paymentMethod: PaymentMethod;
  cart: any;
}) {
  return (
    <View>
      {/* House/address summary banner */}
      {selectedAddress && (
        <ImageBackground
          source={CHECKOUT_REVIEW_ADDRESS_BANNER}
          resizeMode="cover"
          style={styles.reviewAddressBanner}
          imageStyle={styles.reviewAddressBannerImage}
        >
          <View style={styles.reviewAddressIcon}>
            <Ionicons name="location" size={18} color={colors.primary} />
          </View>

          <View style={styles.reviewAddressContent}>
            <AppText
              variant="bodyStrong"
              color={colors.textPrimary}
              style={styles.reviewAddressTitle}
            >
              {selectedAddress.label}
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.reviewAddressLine}
              numberOfLines={1}
            >
              {selectedAddress.fullName} • {selectedAddress.mobile}
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.reviewAddressLine}
              numberOfLines={1}
            >
              {selectedAddress.area}, {selectedAddress.city}{" "}
              {selectedAddress.pincode}
            </AppText>
          </View>
        </ImageBackground>
      )}

      {/* Payment summary */}
      {paymentMethod === PaymentMethod.COD ? (
        <View style={styles.reviewPaymentCard}>
          <View style={styles.reviewPaymentIcon}>
            <Ionicons name="cash-outline" size={22} color={colors.primary} />
          </View>

          <View style={styles.reviewPaymentContent}>
            <AppText variant="bodyStrong" color={colors.textPrimary}>
              Cash on Delivery
            </AppText>

            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.reviewPaymentSubtitle}
              numberOfLines={1}
            >
              Pay when your order is delivered
            </AppText>
          </View>

          <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
        </View>
      ) : (
        <ImageBackground
          source={CHECKOUT_UPI_BANNER}
          resizeMode="contain"
          style={styles.reviewUpiBanner}
          imageStyle={styles.reviewUpiBannerImage}
        />
      )}

      {/* Items */}
      <View style={styles.reviewCard}>
        <View style={styles.reviewCardHeader}>
          <View style={styles.reviewHeaderIcon}>
            <Ionicons
              name="bag-handle-outline"
              size={17}
              color={colors.primary}
            />
          </View>

          <AppText
            variant="bodyStrong"
            color={colors.textPrimary}
            style={styles.reviewHeaderTitle}
          >
            Items ({bill.itemCount})
          </AppText>
        </View>

        {cart?.items?.map((item: any, index: number) => (
          <ReviewItem
            key={item.id ?? item.variantId ?? index}
            item={item}
            last={index === cart.items.length - 1}
          />
        ))}

        {(!cart?.items || cart.items.length === 0) && (
          <View style={styles.noItemsContainer}>
            <AppText variant="caption" color={colors.textSecondary}>
              Your cart items are ready for review.
            </AppText>
          </View>
        )}
      </View>

      {/* Price details */}
      <View style={styles.priceDetailsCard}>
        <View style={styles.priceHeader}>
          <View style={styles.priceIcon}>
            <Ionicons name="receipt-outline" size={19} color={colors.primary} />
          </View>

          <AppText variant="bodyStrong" color={colors.textPrimary}>
            Price Details
          </AppText>
        </View>

        <ReviewPriceRow
          label={`Item Total (${bill.itemCount} items)`}
          value={formatPaise(bill.itemsSubtotalPaise)}
        />

        {bill.couponDiscountPaise > 0 && (
          <ReviewPriceRow
            label="Coupon Discount"
            value={`− ${formatPaise(bill.couponDiscountPaise)}`}
            good
          />
        )}

        <ReviewPriceRow
          label="Delivery Fee"
          value={
            bill.deliveryFeePaise === 0
              ? "FREE"
              : formatPaise(bill.deliveryFeePaise)
          }
          good={bill.deliveryFeePaise === 0}
        />

        {bill.platformFeePaise > 0 && (
          <ReviewPriceRow
            label="Platform Fee"
            value={formatPaise(bill.platformFeePaise)}
          />
        )}

        {bill.taxPaise > 0 && (
          <ReviewPriceRow
            label="Taxes (included)"
            value={formatPaise(bill.taxPaise)}
          />
        )}

        <View style={styles.reviewTotal}>
          <AppText variant="bodyStrong" color={colors.textPrimary}>
            Total Amount
          </AppText>

          <AppText
            variant="h2"
            color={colors.primary}
            style={styles.reviewTotalAmount}
          >
            {formatPaise(bill.totalPaise)}
          </AppText>
        </View>
      </View>

      {/* Last-step banner */}
      <View style={styles.lastStepBanner}>
        <View style={styles.lastStepContent}>
          <AppText
            variant="bodyStrong"
            color={colors.primary}
            style={styles.lastStepTitle}
          >
            You are at the last step!
          </AppText>

          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.lastStepDescription}
            numberOfLines={2}
          >
            Please review your details and place your order.
          </AppText>
        </View>

        <View style={styles.lastStepArtwork}>
          <View style={styles.lastStepBadge}>
            <Ionicons name="checkmark" size={26} color={colors.onPrimary} />
          </View>
          <Ionicons
            name="sparkles"
            size={18}
            color={colors.primary}
            style={styles.sparkleOne}
          />
          <Ionicons
            name="sparkles"
            size={14}
            color={colors.primary}
            style={styles.sparkleTwo}
          />
        </View>
      </View>
    </View>
  );
}

/* ==============================================================
 * REVIEW ITEM
 * ============================================================== */
function ReviewItem({ item, last }: { item: any; last: boolean }) {
  const imageUrl = item?.imageUrl;
  const resolvedImageUrl = imageUrl ? resolveImageUrl(imageUrl) : null;

  return (
    <View style={[styles.reviewItem, !last && styles.reviewItemBorder]}>
      <View style={styles.reviewItemImage}>
        {resolvedImageUrl ? (
          <Image
            source={{ uri: resolvedImageUrl }}
            resizeMode="contain"
            style={styles.reviewProductImage}
          />
        ) : (
          <Ionicons name="image-outline" size={20} color={colors.textMuted} />
        )}
      </View>

      <View style={styles.reviewItemContent}>
        <AppText
          variant="caption"
          color={colors.textPrimary}
          numberOfLines={1}
          style={styles.reviewItemName}
        >
          {item.productName}
        </AppText>

        <AppText
          variant="caption"
          color={colors.textSecondary}
          style={styles.reviewItemVariant}
          numberOfLines={1}
        >
          {item.variantName} × {item.qty}
        </AppText>
      </View>

      <AppText
        variant="caption"
        color={colors.textPrimary}
        style={styles.reviewItemPrice}
      >
        {formatPaise(item.lineTotalPaise)}
      </AppText>
    </View>
  );
}

/* ==============================================================
 * REVIEW PRICE ROW
 * ============================================================== */

function ReviewPriceRow({
  label,
  value,
  good = false,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <View style={styles.reviewPriceRow}>
      <AppText
        variant="caption"
        color={colors.textSecondary}
        style={styles.reviewPriceLabel}
      >
        {label}
      </AppText>

      <AppText
        variant="caption"
        color={good ? colors.primary : colors.textPrimary}
        style={styles.reviewPriceValue}
      >
        {value}
      </AppText>
    </View>
  );
}

/* ==============================================================
 * STYLES
 * ============================================================== */

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.xs,
    backgroundColor: colors.surface,
  },

  backButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  headerText: {
    flex: 1,
  },

  headerTitle: {
    fontSize: 24,
    lineHeight: 33,
    fontWeight: "800",
  },

  headerSubtitle: {
    marginTop: 1,
    fontSize: 13,
    lineHeight: 19,
  },

  /* ==================== STEPPER ==================== */

  stepperContainer: {
    position: "relative",
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },

  stepWrapper: {
    flex: 1,
    alignItems: "center",
    position: "relative",
  },

  stepCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSunken,
    zIndex: 2,
  },

  stepCircleActive: {
    backgroundColor: colors.primary,
  },

  stepNumber: {
    fontWeight: "700",
    fontSize: 12,
  },

  stepLine: {
    position: "absolute",
    top: 15,
    left: "-50%",
    right: "50%",
    height: 1.5,
    backgroundColor: colors.surfaceSunken,
    zIndex: 0,
  },

  stepLineActive: {
    backgroundColor: colors.primary,
  },

  stepLabel: {
    marginTop: 5,
    fontSize: 12,
    lineHeight: 17,
  },

  stepLabelActive: {
    fontWeight: "700",
  },

  /* ==================== CONTENT ==================== */

  content: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
  },

  noticeSpacing: {
    marginBottom: spacing.sm,
  },

  sectionHeading: {
    marginBottom: spacing.sm,
  },

  sectionTitle: {
    fontSize: 22,
    lineHeight: 27,
  },

  sectionSubtitle: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 19,
  },

  /* ==================== ADDRESS HERO ==================== */

  addressHero: {
    height: 91,
    position: "relative",
    justifyContent: "center",
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#D8F0E1",
    backgroundColor: "#F3FCF6",
    marginBottom: spacing.sm,
    overflow: "hidden",
  },

  addressHeroImage: {
    borderRadius: 17,
  },

  heroText: {
    flex: 1,
    paddingLeft: spacing.sm,
    paddingRight: 122,
  },

  heroTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },

  heroIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary + "15",
    flexShrink: 0,
  },

  heroTitleContent: {
    flex: 1,
    marginLeft: spacing.sm,
  },

  heroTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "700",
  },

  heroDescription: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
  },

  /* Address artwork is provided by addressHeroImage. */

  /* ==================== ADDRESS CARDS ==================== */

  addressList: {
    gap: spacing.sm,
  },

  addressCard: {
    minHeight: 91,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#E2E6EB",
    backgroundColor: colors.surface,
  },

  addressCardSelected: {
    borderColor: colors.primary,
    backgroundColor: "#F2FCF5",
    borderWidth: 1.5,
  },

  addressCardDisabled: {
    opacity: 0.55,
  },

  addressIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EAF4FF",
    flexShrink: 0,
  },

  addressIconSelected: {
    backgroundColor: "#DDF5E5",
  },

  addressContent: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: spacing.sm,
  },

  addressTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },

  addressTitle: {
    fontSize: 17,
    lineHeight: 21,
    flexShrink: 1,
    fontWeight: "700",
  },

  addressLine: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
  },

  defaultBadge: {
    marginLeft: spacing.xs,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 12,
    backgroundColor: colors.primary + "15",
  },

  defaultBadgeText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
  },

  unserviceableText: {
    marginTop: 2,
    fontSize: 11,
  },

  addressActions: {
    width: 27,
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "stretch",
    paddingVertical: 2,
  },

  editAddressButton: {
    width: 25,
    height: 25,
    alignItems: "center",
    justifyContent: "center",
  },

  /* ==================== RADIO ==================== */

  radioOuter: {
    width: 21,
    height: 21,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  radioOuterSelected: {
    borderColor: colors.primary,
  },

  radioInner: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: colors.primary,
  },

  /* ==================== DELIVERY BANNER ==================== */

  addAddressCard: {
    minHeight: 80,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: 17,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "#78D69A",
    backgroundColor: "#FBFFFC",
    marginTop: spacing.sm,
  },

  addAddressIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E1F5E8",
    flexShrink: 0,
  },

  addAddressContent: {
    flex: 1,
    minWidth: 0,
    marginLeft: spacing.sm,
  },

  addAddressTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },

  addAddressSubtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: 18,
  },

  deliveryBanner: {
    height: 78,
    position: "relative",
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: "#F0FBF4",
    marginTop: spacing.sm,
    overflow: "hidden",
  },

  deliveryBannerImage: {
    borderRadius: 17,
  },

  /* Delivery artwork is provided by deliveryBannerImage. */

  deliveryBannerContent: {
    width: "90 %",
    minWidth: 0,
    paddingLeft: spacing.xxxl + 35,
  },

  deliveryBannerTitle: {
    fontSize: 15,
    lineHeight: 20,
  },

  deliveryBannerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
  },

  emptyAddressCard: {
    minHeight: 75,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md,
    marginTop: spacing.xs,
  },

  emptyAddressText: {
    marginTop: spacing.xs,
  },

  /* ==================== PAYMENT ==================== */

  paymentCard: {
    minHeight: 105,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#E2E6EB",
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },

  paymentCardSelected: {
    borderColor: colors.primary,
    backgroundColor: "#F3FCF6",
    borderWidth: 1.5,
  },

  paymentCardDisabled: {
    opacity: 0.55,
  },

  paymentIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  upiIcon: {
    backgroundColor: "#E8F5FE",
  },

  cashIcon: {
    backgroundColor: colors.primary + "12",
  },

  paymentContent: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: spacing.sm,
    zIndex: 2,
  },

  paymentTitle: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "700",
  },

  paymentSubtitle: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
  },

  paymentBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: colors.primary + "15",
  },

  paymentBadgeText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "700",
  },

  codAvailable: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.primary + "0D",
  },

  codAvailableIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },

  codAvailableContent: {
    flex: 1,
    marginLeft: spacing.xs,
  },

  codAvailableTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },

  codAvailableSubtitle: {
    marginTop: 1,
    fontSize: 11,
    lineHeight: 15,
  },

  securityCard: {
    minHeight: 93,
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#E2E6EB",
    backgroundColor: colors.surface,
    marginTop: spacing.sm,
  },

  securityIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#DDF5E5",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  securityContent: {
    flex: 1,
    minWidth: 0,
    marginLeft: spacing.sm,
  },

  securityTitle: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "700",
  },

  securityDescription: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
  },

  /* ==================== REVIEW ==================== */

  reviewAddressBanner: {
    height: 80,
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#D8F0E1",
    backgroundColor: "#F3FCF6",
    overflow: "hidden",
    marginBottom: spacing.sm,
  },

  reviewAddressBannerImage: {
    borderRadius: 17,
  },

  /* Review house artwork is provided by reviewAddressBannerImage. */

  reviewAddressIcon: {
    width: 43,
    height: 43,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#DDF5E5",
    flexShrink: 0,
  },

  reviewAddressContent: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: spacing.sm,
    paddingRight: 35,
  },

  reviewAddressTitle: {
    fontSize: 16,
    lineHeight: 20,
  },

  reviewAddressLine: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
  },

  reviewPaymentCard: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#D8E8F8",
    backgroundColor: "#F5FAFF",
    marginBottom: spacing.sm,
    overflow: "hidden",
  },

  reviewUpiBanner: {
    width: "100%",
    height: 82,
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: spacing.sm,
    backgroundColor: "#F5FAFF",
  },

  reviewUpiBannerImage: {
    borderRadius: 14,
  },

  reviewPaymentIcon: {
    width: 43,
    height: 43,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E7F2FF",
    flexShrink: 0,
    zIndex: 2,
  },

  reviewPaymentContent: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: spacing.sm,
    zIndex: 2,
  },

  reviewPaymentSubtitle: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
  },

  reviewCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },

  reviewCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: spacing.xs,
  },

  reviewHeaderIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary + "12",
  },

  reviewHeaderTitle: {
    marginLeft: spacing.xs,
    fontSize: 17,
    lineHeight: 21,
  },

  reviewItem: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 5,
  },

  reviewItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },

  reviewItemImage: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  },

  reviewProductImage: {
    width: 42,
    height: 42,
  },

  reviewItemContent: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: spacing.sm,
  },

  reviewItemName: {
    fontSize: 13,
    lineHeight: 17,
  },

  reviewItemVariant: {
    marginTop: 2,
    fontSize: 11,
    lineHeight: 15,
  },

  reviewItemPrice: {
    minWidth: 50,
    textAlign: "right",
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "700",
  },

  noItemsContainer: {
    paddingVertical: spacing.sm,
  },

  /* ==================== PRICE DETAILS ==================== */

  priceDetailsCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primary + "20",
    backgroundColor: colors.primary + "07",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },

  priceHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: spacing.xs,
  },

  priceIcon: {
    width: 31,
    height: 31,
    borderRadius: 16,
    backgroundColor: colors.primary + "14",
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.xs,
  },

  reviewPriceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 25,
  },

  reviewPriceLabel: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },

  reviewPriceValue: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: "right",
  },

  reviewTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.primary + "20",
  },

  reviewTotalAmount: {
    fontSize: 22,
    lineHeight: 26,
  },

  /* ==================== LAST STEP ==================== */

  lastStepBanner: {
    minHeight: 82,
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 17,
    backgroundColor: "#EFFAF3",
    marginBottom: spacing.sm,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.sm,
    overflow: "hidden",
  },

  lastStepContent: {
    flex: 1,
    minWidth: 0,
    paddingRight: 80,
  },

  lastStepTitle: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "700",
  },

  lastStepDescription: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 16,
  },

  lastStepArtwork: {
    position: "absolute",
    right: 10,
    bottom: 5,
    width: 72,
    height: 72,
    alignItems: "center",
    justifyContent: "center",
  },

  lastStepBadge: {
    width: 47,
    height: 47,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },

  sparkleOne: {
    position: "absolute",
    left: 0,
    top: 5,
  },

  sparkleTwo: {
    position: "absolute",
    right: 0,
    top: 0,
  },

  /* ==================== BOTTOM BAR ==================== */

  bottomBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: "#E4E8ED",
    elevation: 8,
  },

  paySummary: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },

  toPayLabel: {
    fontSize: 12,
    lineHeight: 16,
  },

  toPayAmount: {
    fontSize: 25,
    lineHeight: 30,
    fontWeight: "800",
  },

  infoIcon: {
    marginLeft: 5,
    marginTop: spacing.sm,
  },

  bottomButton: {
    flex: 1,
    minHeight: 55,
    borderRadius: 30,
  },
});

import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";
import {
  ArrowLeft,
  Bike,
  CalendarDays,
  Check,
  ChefHat,
  Clock3,
  Home,
  Info,
  MapPin,
  MoreVertical,
  Package,
  PackageCheck,
  Phone,
  ShoppingBag,
  Store,
  UserRound,
  XCircle,
} from "lucide-react-native";

import { api, ApiRequestError } from "@/lib/api";

import { OrderStatus, TERMINAL_ORDER_STATUSES } from "@shared";

import { formatPaise } from "@shared/money";
import { formatDateTimeInZone } from "@shared/datetime";
import { formatAddressLine } from "@shared/text";

import { colors, radius, spacing } from "@shared/theme";

import { keys, useOrder } from "@/lib/queries";
import { useTabBarClearance } from "@/lib/tabBarVisibility";

import { useOrderSocket } from "@/lib/socket";

import {
  AppText,
  Button,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
  StatusBadge,
} from "@/components/ui";

/*
|--------------------------------------------------------------------------
| PAYMENT VERIFICATION BANNER — COLORS
|--------------------------------------------------------------------------
|
| The banner is now built entirely from code (no image asset). These are
| the warm cream/brown tones from the approved design — kept as local
| constants rather than theme tokens since they're specific to this one
| "pending" state and aren't part of the app's general color system.
|
*/

const PAYMENT_PENDING_BG = "#FCF0DC";
const PAYMENT_PENDING_BORDER = "#F2DFB8";
const PAYMENT_PENDING_ICON_BG = "#F5DDA8";
const PAYMENT_PENDING_ICON_COLOR = "#6B3A0E";
const PAYMENT_PENDING_HEADING_COLOR = "#6B3A0E";
const PAYMENT_PENDING_DESCRIPTION_COLOR = "#5B6B7C";

/*
|--------------------------------------------------------------------------
| Shared "card" shadow
|--------------------------------------------------------------------------
|
| Every card on this screen (banner, order/store, address, summary, OTP,
| partner, already-paid) uses the same soft elevation so the page reads
| as one consistent system instead of flat, disconnected boxes.
|
*/

const cardShadow = {
  shadowColor: "#0F172A",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.05,
  shadowRadius: 10,
  elevation: 2,
};

/*
|--------------------------------------------------------------------------
| TIMELINE ICONS
|--------------------------------------------------------------------------
|
| Maps a step label to a representative icon so the progress tracker
| feels like a real journey instead of plain dots.
|
*/

function getTimelineIcon(label: string) {
  const key = label.toLowerCase();

  if (key.includes("placed")) return CalendarDays;
  if (key.includes("confirm")) return PackageCheck;
  if (key.includes("prepar") || key.includes("pack")) return ChefHat;
  if (
    key.includes("delivery") ||
    key.includes("transit") ||
    key.includes("way")
  )
    return Bike;
  if (key.includes("delivered")) return Home;

  return Package;
}

/*
|--------------------------------------------------------------------------
| SCREEN
|--------------------------------------------------------------------------
*/

export default function OrderTrackingScreen({
  orderId,
  onBack,
  onChangeAddress,
}: {
  orderId: string;
  onBack: () => void;
  // Wire this to whatever screen/flow already handles changing the
  // delivery address in the rest of the app (e.g. navigation.navigate
  // to an address picker). Left optional so this file compiles even
  // before it's wired up — the button just won't do anything until it is.
  onChangeAddress?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const queryClient = useQueryClient();

  /*
  |--------------------------------------------------------------------------
  | ORDER QUERY
  |--------------------------------------------------------------------------
  */

  const { data: order, isLoading, isError, refetch } = useOrder(orderId, true);

  /*
  |--------------------------------------------------------------------------
  | CANCEL ERROR
  |--------------------------------------------------------------------------
  */

  const [cancelError, setCancelError] = useState<string | null>(null);

  /*
  |--------------------------------------------------------------------------
  | CANCEL ORDER
  |--------------------------------------------------------------------------
  */

  const cancelOrder = useMutation({
    mutationFn: (reason: string) =>
      api.post(`/orders/${orderId}/cancel`, {
        reason,
      }),

    onSuccess: () => {
      setCancelError(null);

      void queryClient.invalidateQueries({
        queryKey: keys.order(orderId),
      });

      void queryClient.invalidateQueries({
        queryKey: keys.orders,
      });

      void queryClient.invalidateQueries({
        queryKey: ["home"],
      });
    },

    onError: (err: Error) => {
      setCancelError(
        err instanceof ApiRequestError
          ? err.message
          : "Could not cancel this order.",
      );
    },
  });

  /*
  |--------------------------------------------------------------------------
  | SOCKET LIVE UPDATE
  |--------------------------------------------------------------------------
  */

  const isLive = order ? !TERMINAL_ORDER_STATUSES.includes(order.status) : true;

  useOrderSocket({
    onStatusChanged: (event) => {
      if (event.orderId === orderId) {
        void queryClient.invalidateQueries({
          queryKey: keys.order(orderId),
        });
      }
    },
  });

  /*
  |--------------------------------------------------------------------------
  | REFRESH ORDER LIST WHEN TERMINAL
  |--------------------------------------------------------------------------
  */

  useEffect(() => {
    if (!isLive) {
      void queryClient.invalidateQueries({
        queryKey: keys.orders,
      });
    }
  }, [isLive, queryClient]);

  /*
  |--------------------------------------------------------------------------
  | LOADING
  |--------------------------------------------------------------------------
  */

  if (isLoading) {
    return <Loading label="Loading your order…" />;
  }

  /*
  |--------------------------------------------------------------------------
  | ERROR
  |--------------------------------------------------------------------------
  */

  if (isError || !order) {
    return (
      <ErrorState
        message="We could not load this order."
        onRetry={() => void refetch()}
      />
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STATES
  |--------------------------------------------------------------------------
  */

  const paymentPending = order.status === OrderStatus.PENDING_PAYMENT;

  const exception =
    TERMINAL_ORDER_STATUSES.includes(order.status) &&
    order.status !== OrderStatus.DELIVERED;

  const delivered = order.status === OrderStatus.DELIVERED;

  /*
  |--------------------------------------------------------------------------
  | ORDER PLACED DATE
  |--------------------------------------------------------------------------
  |
  | Do not use order.createdAt because OrderDetailDto
  | does not contain that field.
  |
  | The existing server timeline already contains the
  | timestamp for "Order Placed".
  |
  */

  const orderPlacedEntry = order.timeline.find(
    (entry) => entry.label.toLowerCase() === "order placed",
  );

  const orderPlacedAt = orderPlacedEntry?.at;

  /*
  |--------------------------------------------------------------------------
  | PRODUCT IMAGE HELPER
  |--------------------------------------------------------------------------
  |
  | We don't assume a particular backend image field.
  |
  | It checks several common fields safely.
  |
  */

  const getProductImage = (item: unknown): string | null => {
    const product = item as {
      imageUrl?: string;
      productImage?: string;
      image?: string;
      thumbnail?: string;
      image_url?: string;
      product?: {
        image?: string;
        imageUrl?: string;
        thumbnail?: string;
        images?: string[];
      };
    };

    return (
      product.imageUrl ||
      product.productImage ||
      product.image ||
      product.thumbnail ||
      product.image_url ||
      product.product?.image ||
      product.product?.imageUrl ||
      product.product?.thumbnail ||
      product.product?.images?.[0] ||
      null
    );
  };

  /*
  |--------------------------------------------------------------------------
  | HEADER STATUS
  |--------------------------------------------------------------------------
  */

  const getStatusTitle = () => {
    if (paymentPending) {
      return "Payment Pending";
    }

    if (exception) {
      return order.statusLabel;
    }

    if (delivered) {
      return "Delivered";
    }

    if (order.etaMinutes) {
      return `${order.etaMinutes} mins`;
    }

    return order.statusLabel;
  };

  /*
  |--------------------------------------------------------------------------
  | STATUS COLOR
  |--------------------------------------------------------------------------
  */

  const statusColor = paymentPending
    ? "#B66A00"
    : exception
      ? "#C94B4B"
      : colors.primary;

  /*
  |--------------------------------------------------------------------------
  | MAIN UI
  |--------------------------------------------------------------------------
  */

  return (
    <Screen>
      {/* ======================================================
          HEADER
      ====================================================== */}

      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.xs,
          },
        ]}
      >
        <Pressable onPress={onBack} hitSlop={12} style={styles.headerButton}>
          <ArrowLeft size={25} strokeWidth={2.2} color={colors.textPrimary} />
        </Pressable>

        <View style={styles.headerTitle}>
          <AppText variant="h3">Order Details</AppText>

          <AppText variant="caption" color={colors.textSecondary}>
            Track your order and view details
          </AppText>
        </View>

        <Pressable hitSlop={10} style={styles.headerButton}>
          <MoreVertical
            size={23}
            strokeWidth={2.2}
            color={colors.textPrimary}
          />
        </Pressable>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          {
            // The tab bar floats over this screen now (see MainTabs.tsx's
            // `AnimatedTabBar`) rather than reserving its own flex space.
            paddingBottom: tabBarClearance + spacing.xxl,
          },
        ]}
      >
        {/* ====================================================
            PAYMENT VERIFICATION PENDING
        ==================================================== */}

        {paymentPending && (
          <>
            {/* ------------------------------------------------
                PAYMENT BANNER — built from code, no image asset
            ------------------------------------------------ */}

            <View style={styles.paymentBanner}>
              <View style={styles.paymentBannerIconWrap}>
                <Clock3
                  size={22}
                  strokeWidth={2}
                  color={PAYMENT_PENDING_ICON_COLOR}
                />
              </View>

              <View style={styles.paymentBannerContent}>
                <View style={styles.paymentBannerTopRow}>
                  <AppText
                    variant="h3"
                    color={PAYMENT_PENDING_HEADING_COLOR}
                    style={styles.paymentBannerHeading}
                  >
                    Payment Verification Pending
                  </AppText>

                  <View style={styles.paymentBannerOrderId}>
                    <AppText variant="caption" color={colors.textSecondary}>
                      Order ID
                    </AppText>

                    <AppText
                      variant="bodyStrong"
                      color={colors.textPrimary}
                      numberOfLines={1}
                    >
                      #{order.orderNumber}
                    </AppText>
                  </View>
                </View>

                <AppText
                  variant="body"
                  color={PAYMENT_PENDING_DESCRIPTION_COLOR}
                  style={styles.paymentBannerDescription}
                >
                  Your payment has been submitted. The store will verify your
                  payment before preparing your order.
                </AppText>
              </View>
            </View>

            {/* ------------------------------------------------
                ORDER PLACED + STORE
            ------------------------------------------------ */}

            <View style={styles.orderStoreCard}>
              {/* ORDER PLACED */}

              <View style={styles.orderStoreColumn}>
                <View style={styles.greenCircle}>
                  <CalendarDays
                    size={24}
                    strokeWidth={2}
                    color={colors.primary}
                  />
                </View>

                <View style={styles.orderStoreText}>
                  <AppText variant="body" color={colors.textPrimary}>
                    Order Placed
                  </AppText>

                  <AppText
                    variant="body"
                    color={colors.textSecondary}
                    style={styles.dateText}
                  >
                    {orderPlacedAt
                      ? formatDateTimeInZone(
                          new Date(orderPlacedAt),
                          "Asia/Kolkata",
                        )
                      : "Order placed"}
                  </AppText>
                </View>
              </View>

              {/* DIVIDER */}

              <View style={styles.verticalDivider} />

              {/* STORE */}

              <View style={styles.orderStoreColumn}>
                <View style={styles.greenCircle}>
                  <Store size={24} strokeWidth={2} color={colors.primary} />
                </View>

                <View style={styles.orderStoreText}>
                  <AppText variant="body" color={colors.textPrimary}>
                    Store
                  </AppText>

                  <AppText
                    variant="bodyStrong"
                    color={colors.textPrimary}
                    style={styles.storeName}
                  >
                    AadiOne
                  </AppText>

                  <AppText variant="caption" color={colors.textSecondary}>
                    Railmagra
                  </AppText>
                </View>
              </View>
            </View>
          </>
        )}

        {/* ====================================================
            NORMAL / REJECTED / DELIVERED HEADER
        ==================================================== */}

        {!paymentPending && (
          <View
            style={[styles.statusHero, exception && styles.statusHeroException]}
          >
            <View style={styles.statusHeroLeft}>
              <AppText variant="caption" color={colors.textSecondary}>
                {exception || delivered ? "Order" : "Estimated delivery"}
              </AppText>

              <AppText
                variant="display"
                color={statusColor}
                style={styles.statusHeroTitle}
              >
                {getStatusTitle()}
              </AppText>
            </View>

            <View style={styles.statusHeroRight}>
              <AppText variant="caption" color={colors.textSecondary}>
                Order ID
              </AppText>

              <AppText
                variant="bodyStrong"
                color={colors.textPrimary}
                numberOfLines={1}
              >
                #{order.orderNumber}
              </AppText>
            </View>
          </View>
        )}

        {/* ====================================================
            REJECTED / CANCELLED
        ==================================================== */}

        {!paymentPending && exception && (
          <View style={styles.exceptionCard}>
            <View style={styles.exceptionIcon}>
              <XCircle size={24} strokeWidth={2} color="#C94B4B" />
            </View>

            <View style={styles.exceptionContent}>
              <AppText variant="h3">{order.statusLabel}</AppText>

              <AppText
                variant="body"
                color={colors.textSecondary}
                style={styles.descriptionSpacing}
              >
                {order.cancellationReason || "This order cannot be processed."}
              </AppText>
            </View>
          </View>
        )}

        {/* ====================================================
            NORMAL ORDER TRACKING
        ==================================================== */}

        {!paymentPending && !exception && (
          <View style={styles.trackingCard}>
            <View style={styles.trackingHeader}>
              <View>
                <AppText variant="h3">Order Status</AppText>

                <AppText
                  variant="caption"
                  color={colors.textSecondary}
                  style={styles.trackingSubtitle}
                >
                  Track your order progress
                </AppText>
              </View>

              <StatusBadge status={order.status} />
            </View>

            <View style={styles.timeline}>
              {order.timeline.map((entry, index) => {
                const done = entry.status === "COMPLETED";

                const active = entry.status === "IN_PROGRESS";

                const last = index === order.timeline.length - 1;

                const StepIcon = getTimelineIcon(entry.label);

                return (
                  <View key={entry.step} style={styles.timelineRow}>
                    {/* LEFT RAIL */}

                    <View style={styles.timelineRail}>
                      <View
                        style={[
                          styles.timelineCircle,
                          (done || active) && styles.timelineCircleActive,
                          active && styles.timelineCircleCurrent,
                        ]}
                      >
                        {done && (
                          <Check
                            size={15}
                            strokeWidth={3}
                            color={colors.onPrimary}
                          />
                        )}

                        {active && (
                          <StepIcon
                            size={15}
                            strokeWidth={2.4}
                            color={colors.primary}
                          />
                        )}

                        {!done && !active && (
                          <StepIcon
                            size={13}
                            strokeWidth={2}
                            color={colors.textMuted}
                          />
                        )}
                      </View>

                      {!last && (
                        <View
                          style={[
                            styles.timelineLine,
                            done && styles.timelineLineDone,
                          ]}
                        />
                      )}
                    </View>

                    {/* CONTENT */}

                    <View style={styles.timelineContent}>
                      <AppText
                        variant="bodyStrong"
                        color={
                          done || active ? colors.textPrimary : colors.textMuted
                        }
                      >
                        {entry.label}
                      </AppText>

                      {entry.at && (
                        <AppText
                          variant="caption"
                          color={colors.textSecondary}
                          style={styles.timelineDate}
                        >
                          {formatDateTimeInZone(
                            new Date(entry.at),
                            "Asia/Kolkata",
                          )}
                        </AppText>
                      )}

                      {active && (
                        <View style={styles.inProgressPill}>
                          <View style={styles.inProgressDot} />
                          <AppText
                            variant="caption"
                            color={colors.primary}
                            style={styles.inProgressLabel}
                          >
                            In progress
                          </AppText>
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* ====================================================
            DELIVERY OTP
        ==================================================== */}

        {order.deliveryOtp && (
          <View style={styles.otpCard}>
            <View style={styles.smallGreenIcon}>
              <Package size={22} strokeWidth={2} color={colors.primary} />
            </View>

            <View style={styles.otpContent}>
              <AppText variant="h3">Delivery OTP</AppText>

              <AppText
                variant="caption"
                color={colors.textSecondary}
                style={styles.otpDescription}
              >
                Share this with the delivery partner when your order arrives.
              </AppText>

              <AppText
                variant="displayLarge"
                color={colors.primary}
                style={styles.otpNumber}
              >
                {order.deliveryOtp}
              </AppText>
            </View>
          </View>
        )}

        {/* ====================================================
            DELIVERY PARTNER
        ==================================================== */}

        {order.deliveryAgent && (
          <View style={styles.partnerCard}>
            <AppText variant="h3">Delivery Partner</AppText>

            <View style={styles.partnerRow}>
              <View style={styles.partnerAvatar}>
                <UserRound size={21} strokeWidth={2} color={colors.primary} />
              </View>

              <View style={styles.partnerInfo}>
                <AppText variant="bodyStrong">
                  {order.deliveryAgent.name}
                </AppText>

                <View style={styles.phoneRow}>
                  <Phone
                    size={14}
                    strokeWidth={2}
                    color={colors.textSecondary}
                  />

                  <AppText variant="caption" color={colors.textSecondary}>
                    {order.deliveryAgent.mobile}
                  </AppText>
                </View>
              </View>
            </View>
          </View>
        )}

        {/* ====================================================
            DELIVERY ADDRESS
        ==================================================== */}

        <View style={styles.addressCard}>
          <View style={styles.addressIcon}>
            <MapPin size={24} strokeWidth={2} color={colors.primary} />
          </View>

          <View style={styles.addressContent}>
            <View style={styles.addressHeaderRow}>
              <AppText variant="h3">Delivery Address</AppText>

              {onChangeAddress && (
                <Pressable
                  onPress={onChangeAddress}
                  hitSlop={8}
                  style={styles.changeAddressButton}
                >
                  <AppText
                    variant="caption"
                    color={colors.primary}
                    style={styles.changeAddressLabel}
                  >
                    Change
                  </AppText>
                </Pressable>
              )}
            </View>

            <AppText
              variant="body"
              color={colors.textSecondary}
              style={styles.addressText}
            >
              {formatAddressLine(order.deliveryAddress)}
            </AppText>
          </View>
        </View>

        {/* ====================================================
            ORDER SUMMARY
        ==================================================== */}

        <View style={styles.summaryCard}>
          <View style={styles.summaryHeader}>
            <View style={styles.summaryTitle}>
              <View style={styles.bagIcon}>
                <ShoppingBag size={23} strokeWidth={2} color={colors.primary} />
              </View>

              <AppText variant="h3">Order Summary</AppText>
            </View>

            <StatusBadge status={order.status} />
          </View>

          {/* PRODUCTS */}

          <View style={styles.products}>
            {order.items.map((item, index) => {
              const productImage = getProductImage(item);

              const isLastItem = index === order.items.length - 1;

              return (
                <View
                  key={item.id}
                  style={[
                    styles.productRow,
                    isLastItem && styles.productRowLast,
                  ]}
                >
                  {/* IMAGE */}

                  <View style={styles.productImageBox}>
                    {productImage ? (
                      <Image
                        source={{
                          uri: productImage,
                        }}
                        contentFit="contain"
                        transition={150}
                        cachePolicy="memory-disk"
                        style={styles.productImage}
                      />
                    ) : (
                      <ShoppingBag
                        size={22}
                        strokeWidth={1.7}
                        color={colors.textSecondary}
                      />
                    )}
                  </View>

                  {/* NAME */}

                  <View style={styles.productDetails}>
                    <AppText variant="body" numberOfLines={2}>
                      {item.productName}
                    </AppText>

                    <AppText
                      variant="caption"
                      color={colors.textSecondary}
                      style={styles.productMeta}
                    >
                      {item.variantName} · Qty {item.qty}
                    </AppText>
                  </View>

                  {/* PRICE */}

                  <AppText variant="bodyStrong" color={colors.textPrimary}>
                    {formatPaise(item.lineTotalPaise)}
                  </AppText>
                </View>
              );
            })}
          </View>

          {/* TOTAL */}

          <View style={styles.totalRow}>
            <AppText variant="h3">Total Amount</AppText>

            <AppText variant="h3">{formatPaise(order.bill.totalPaise)}</AppText>
          </View>

          {/* PAYMENT */}

          <AppText
            variant="caption"
            color={colors.textSecondary}
            style={styles.paymentStatus}
          >
            Paid by{" "}
            {order.paymentMethod === "COD" ? "Cash on Delivery" : "Online"} ·{" "}
            {order.paymentStatus}
          </AppText>
        </View>

        {/* ====================================================
            ALREADY PAID
        ==================================================== */}

        {paymentPending && (
          <View style={styles.alreadyPaidCard}>
            <View style={styles.alreadyPaidIcon}>
              <Info size={27} strokeWidth={2} color="#0879B4" />
            </View>

            <View style={styles.alreadyPaidContent}>
              <AppText variant="h3" color="#0879B4">
                Already paid?
              </AppText>

              <AppText
                variant="body"
                color={colors.textSecondary}
                style={styles.alreadyPaidText}
              >
                If you have completed the payment, please wait.
              </AppText>

              <AppText variant="body" color={colors.textSecondary}>
                The store will verify your payment soon.
              </AppText>
            </View>
          </View>
        )}

        {/* ====================================================
            CANCEL ORDER
        ==================================================== */}

        {order.canCancel && (
          <Button
            label="Cancel order"
            variant="secondary"
            loading={cancelOrder.isPending}
            onPress={() =>
              Alert.alert("Cancel this order?", "This cannot be undone.", [
                {
                  text: "Keep order",
                  style: "cancel",
                },
                {
                  text: "Cancel order",
                  style: "destructive",
                  onPress: () => cancelOrder.mutate("Cancelled by customer"),
                },
              ])
            }
            style={styles.cancelButton}
          />
        )}

        {/* ====================================================
            CANCEL ERROR
        ==================================================== */}

        {cancelError && (
          <View style={styles.errorContainer}>
            <NoticeStrip message={cancelError} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

/*
|--------------------------------------------------------------------------
| STYLES
|--------------------------------------------------------------------------
*/

const styles = StyleSheet.create({
  /*
  |--------------------------------------------------------------------------
  | HEADER
  |--------------------------------------------------------------------------
  */

  header: {
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },

  headerButton: {
    width: 33,
    height: 33,
    alignItems: "center",
    justifyContent: "center",
  },

  headerTitle: {
    flex: 1,
    paddingLeft: spacing.xs,
  },

  /*
  |--------------------------------------------------------------------------
  | CONTENT
  |--------------------------------------------------------------------------
  */

  scrollContent: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
  },

  /*
  |--------------------------------------------------------------------------
  | PAYMENT BANNER (coded, no image asset)
  |--------------------------------------------------------------------------
  */

  paymentBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: 18,
    backgroundColor: PAYMENT_PENDING_BG,
    borderWidth: 1,
    borderColor: PAYMENT_PENDING_BORDER,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  paymentBannerIconWrap: {
    width: 33,
    height: 33,
    borderRadius: 16.5,
    backgroundColor: PAYMENT_PENDING_ICON_BG,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  paymentBannerContent: {
    flex: 1,
    minWidth: 0,
  },

  paymentBannerTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },

  paymentBannerHeading: {
    flex: 1,
    paddingRight: spacing.sm,
    fontSize: 15,
  },

  paymentBannerOrderId: {
    alignItems: "flex-end",
  },

  paymentBannerDescription: {
    marginTop: 4,
    lineHeight: 20,
    fontSize: 12,
  },

  orderIdLabel: {
    fontSize: 10, // "Order ID" label ka size
  },

  orderIdValue: {
    fontSize: 10, // #AD260907... number ka size
  },

  /*
  |--------------------------------------------------------------------------
  | ORDER + STORE
  |--------------------------------------------------------------------------
  */

  orderStoreCard: {
    minHeight: 105,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  orderStoreColumn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
  },

  greenCircle: {
    width: 33,
    height: 33,
    borderRadius: 16.5,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  orderStoreText: {
    flex: 1,
    minWidth: 0,
  },

  dateText: {
    marginTop: 3,
  },

  storeName: {
    marginTop: 2,
  },

  verticalDivider: {
    width: 1,
    height: 62,
    backgroundColor: colors.divider,
    marginHorizontal: spacing.sm,
  },

  /*
  |--------------------------------------------------------------------------
  | STATUS HERO
  |--------------------------------------------------------------------------
  */

  statusHero: {
    minHeight: 105,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.primarySurface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  statusHeroException: {
    backgroundColor: colors.surface,
  },

  statusHeroLeft: {
    flex: 1,
  },

  statusHeroTitle: {
    marginTop: 1,
  },

  statusHeroRight: {
    maxWidth: "43%",
    alignItems: "flex-end",
    paddingLeft: spacing.sm,
  },

  /*
  |--------------------------------------------------------------------------
  | EXCEPTION
  |--------------------------------------------------------------------------
  */

  exceptionCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  exceptionIcon: {
    width: 33,
    height: 33,
    borderRadius: 16.5,
    backgroundColor: "#FFF1F1",
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  exceptionContent: {
    flex: 1,
  },

  descriptionSpacing: {
    marginTop: 4,
  },

  /*
  |--------------------------------------------------------------------------
  | TRACKING
  |--------------------------------------------------------------------------
  */

  trackingCard: {
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  trackingHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  trackingSubtitle: {
    marginTop: 2,
  },

  timeline: {
    marginTop: spacing.md,
  },

  timelineRow: {
    flexDirection: "row",
    minHeight: 54,
  },

  timelineRail: {
    width: 32,
    alignItems: "center",
  },

  timelineCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },

  timelineCircleActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },

  timelineCircleCurrent: {
    backgroundColor: colors.primarySurface,
    borderColor: colors.primary,
  },

  timelineLine: {
    width: 2,
    flex: 1,
    minHeight: 26,
    backgroundColor: colors.border,
  },

  timelineLineDone: {
    backgroundColor: colors.primary,
  },

  timelineContent: {
    flex: 1,
    paddingLeft: spacing.sm,
    paddingBottom: spacing.sm,
  },

  timelineDate: {
    marginTop: 2,
  },

  inProgressPill: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.primarySurface,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },

  inProgressDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
    marginRight: 5,
  },

  inProgressLabel: {
    fontWeight: "600",
  },

  /*
  |--------------------------------------------------------------------------
  | OTP
  |--------------------------------------------------------------------------
  */

  otpCard: {
    flexDirection: "row",
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.primarySurface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  smallGreenIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  otpContent: {
    flex: 1,
  },

  otpDescription: {
    marginTop: 3,
  },

  otpNumber: {
    marginTop: 2,
    letterSpacing: 5,
  },

  /*
  |--------------------------------------------------------------------------
  | DELIVERY PARTNER
  |--------------------------------------------------------------------------
  */

  partnerCard: {
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  partnerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.sm,
  },

  partnerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  partnerInfo: {
    flex: 1,
  },

  phoneRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 3,
  },

  /*
  |--------------------------------------------------------------------------
  | DELIVERY ADDRESS
  |--------------------------------------------------------------------------
  */

  addressCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  addressIcon: {
    width: 40,
    height: 40,
    borderRadius: 23,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  addressContent: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
  },

  addressHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",

  },

  changeAddressButton: {
    backgroundColor: colors.primarySurface,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    marginLeft: spacing.sm,
  },

  changeAddressLabel: {
    fontWeight: "600",
  },

  addressText: {
    marginTop: 4,
    lineHeight: 22,
    fontSize: 13,
  },

  /*
  |--------------------------------------------------------------------------
  | ORDER SUMMARY
  |--------------------------------------------------------------------------
  */

  summaryCard: {
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  summaryTitle: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },

  bagIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primarySurface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  products: {
    marginTop: spacing.xs,
  },

  productRow: {
    minHeight: 65,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },

  productRowLast: {
    borderBottomWidth: 0,
  },

  productImageBox: {
    width: 50,
    height: 50,
    borderRadius: 9,
    backgroundColor: "#F5F5F5",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginRight: spacing.sm,
  },

  productImage: {
    width: "90%",
    height: "90%",
  },

  productDetails: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.sm,
  },

  productMeta: {
    marginTop: 2,
  },

  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: spacing.md,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },

  paymentStatus: {
    marginTop: 3,
    fontSize: 13,
  },

  /*
  |--------------------------------------------------------------------------
  | ALREADY PAID
  |--------------------------------------------------------------------------
  */

  alreadyPaidCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: "#EFF8FF",
    borderWidth: 1,
    borderColor: "#CBE9FA",
    marginBottom: spacing.sm,
    ...cardShadow,
  },

  alreadyPaidIcon: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },

  alreadyPaidContent: {
    flex: 1,
  },

  alreadyPaidText: {
    marginTop: 3,
    fontSize: 13,
  },

  /*
  |--------------------------------------------------------------------------
  | CANCEL
  |--------------------------------------------------------------------------
  */

  cancelButton: {
    marginTop: spacing.xs,
  },

  errorContainer: {
    marginTop: spacing.sm,
  },
});

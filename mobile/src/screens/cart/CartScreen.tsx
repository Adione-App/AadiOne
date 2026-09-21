/**
 * Cart (Task 14.9, merged with checkout).
 *
 * IMPORTANT:
 * The bill is rendered EXACTLY as returned by the server.
 * No subtotal, delivery fee, tax, discount, or total is calculated here.
 *
 * Cart is now the single checkout screen — address and payment method are
 * selected right here instead of on separate wizard steps, and there is no
 * "Review" step. Placing a COD order shows a confirm popup first; UPI orders
 * are created immediately and hand off to the existing UPI payment screen.
 * Everything after order creation (UPI intent, claim, admin verification,
 * order status) is the existing backend flow, untouched.
 *
 * Existing cart behaviour is preserved:
 * - useCart()
 * - useCartActions()
 * - increment()
 * - decrement()
 * - server bill
 * - serviceability
 * - checkoutEnabled
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as Crypto from "expo-crypto";
import {
  ActivityIndicator,
  FlatList,
  Image,
  LayoutAnimation,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ErrorCode,
  PaymentMethod,
  type AddressDto,
  type BillDto,
  type CartItemDto,
  type CheckoutQuoteResponse,
  type OrderDetailDto,
} from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, shadow, spacing } from "@shared/theme";
import { addressPrimaryLine } from "@shared/text";

import { api, ApiRequestError, resolveImageUrl } from "@/lib/api";
import { clearCartAfterOrder, keys } from "@/lib/queries";
import { useCartActions } from "@/lib/useCartActions";
import { useLocation } from "@/lib/store";

import {
  AppText,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
} from "@/components/ui";

import { QuantityStepper } from "@/components/ProductCard";

/**
 * Short, subtle animation for rows leaving the list — Clear Cart and
 * per-item removal already update state instantly (see `useCartActions`),
 * this only softens how that removal LOOKS so it reads as polished rather
 * than an abrupt cut, without a heavy layout animation or added delay.
 */
const CART_ROW_REMOVE_ANIMATION = {
  duration: 200,
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

/* ================================================================
 * MAIN CART SCREEN
 * ================================================================ */

export default function CartScreen({
  onPlaced,
  onAddAddress,
  onBrowse,
  onOpenSearch,
}: {
  onPlaced: (order: OrderDetailDto, requiresPayment: boolean) => void;
  onAddAddress: () => void;
  onBrowse: () => void;
  onOpenSearch: () => void;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { serviceability } = useLocation();

  // The ONE cart source this screen reads — same optimistic, instantly-
  // updating data the product card / cart badge already read through this
  // hook. No separate `useCart()` call here: that would just be a second,
  // independently-lagging copy of the same state (see useCartActions.ts).
  const actions = useCartActions();
  const { cart, isLoading, isError, refetch } = actions;

  /* ==============================================================
   * CHECKOUT STATE — address, order placement
   * ============================================================== */

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressPickerOpen, setAddressPickerOpen] = useState(false);
  const [confirmOrderOpen, setConfirmOrderOpen] = useState(false);
  const [placing, setPlacing] = useState<PaymentMethod | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  /**
   * One idempotency key per checkout attempt. Regenerated only when the
   * customer must start a new attempt after a basket/price change — see
   * `placeOrder`'s PRICE_CHANGED / ITEM_OUT_OF_STOCK handling below.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    Crypto.randomUUID(),
  );

  const addresses = useQuery({
    queryKey: ["addresses"],
    queryFn: () => api.get<AddressDto[]>("/addresses"),
  });

  /** Default serviceable address, otherwise the first serviceable one. */
  useEffect(() => {
    if (addressId || !addresses.data) return;

    const preferred =
      addresses.data.find((item) => item.isDefault && item.isServiceable) ??
      addresses.data.find((item) => item.isServiceable);

    if (preferred) setAddressId(preferred.id);
  }, [addresses.data, addressId]);

  const quote = useQuery({
    queryKey: ["checkout-quote", addressId],
    queryFn: () => api.post<CheckoutQuoteResponse>("/checkout/quote", { addressId }),
    enabled: addressId !== null,
  });

  /**
   * The bill actually shown on screen: the selected address's delivery
   * fee / platform fee / coupon discount (real policy, only `/checkout/quote`
   * knows it) merged with the item-level figures from the OPTIMISTIC cart
   * (instant on every tap — see useCartActions.ts). Without this merge, the
   * quote's own item totals would stay frozen at whatever the cart looked
   * like the moment the address was selected, silently going stale the next
   * time a quantity changed.
   */
  const bill = useMemo<BillDto | null>(() => {
    const base = quote.data?.bill ?? cart?.bill ?? null;
    if (!base || !cart) return base;

    const netItemsPaise = cart.bill.itemsSubtotalPaise - base.couponDiscountPaise;
    const totalPaise = netItemsPaise + base.deliveryFeePaise + base.platformFeePaise;

    return {
      ...base,
      itemCount: cart.bill.itemCount,
      itemsSubtotalPaise: cart.bill.itemsSubtotalPaise,
      itemDiscountPaise: cart.bill.itemDiscountPaise,
      totalSavingsPaise: cart.bill.itemDiscountPaise + base.couponDiscountPaise,
      totalPaise,
    };
  }, [quote.data, cart]);

  const placeOrder = useCallback(async (method: PaymentMethod): Promise<void> => {
    if (!addressId || !quote.data || placing) return;

    setPlacing(method);
    setCheckoutError(null);

    try {
      const result = await api.post<{
        order: OrderDetailDto;
        requiresPayment: boolean;
      }>(
        "/orders",
        {
          addressId,
          paymentMethod: method,
          // Safety check only — the server calculates the real amount. Uses
          // the merged bill (`bill`, not the possibly-stale `quote.data.bill`)
          // so it matches exactly what the customer is looking at on screen.
          expectedTotalPaise: bill?.totalPaise ?? quote.data.bill.totalPaise,
        },
        idempotencyKey,
      );

      // The order transaction already marked the cart CONVERTED server-side,
      // so this is a known-correct state, not an optimistic guess — write it
      // directly instead of only invalidating, so the badge and every
      // cart-reading screen update in this same tick.
      clearCartAfterOrder(queryClient);
      void queryClient.invalidateQueries({ queryKey: keys.cart });
      await queryClient.invalidateQueries({ queryKey: keys.orders });

      onPlaced(result.order, result.requiresPayment);
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setCheckoutError(err.message);

        // Prices/items changed — refresh the quote and start a fresh
        // checkout attempt with a new idempotency key.
        if (
          err.code === ErrorCode.PRICE_CHANGED ||
          err.code === ErrorCode.ITEM_OUT_OF_STOCK
        ) {
          await quote.refetch();
          setIdempotencyKey(Crypto.randomUUID());
        }
      } else {
        setCheckoutError("Could not place your order. Please try again.");
      }
    } finally {
      setPlacing(null);
      setConfirmOrderOpen(false);
    }
  }, [addressId, quote, placing, bill, idempotencyKey, queryClient, onPlaced]);

  // Double-tap / rapid re-press guard: tapping "Cash on Delivery" asks for
  // confirmation first (see the popup below); "Pay Online" goes straight to
  // order creation — the next screen (UPI payment) is itself a clear
  // confirmation surface, so no popup is needed there.
  const handleCodPress = useCallback(() => {
    if (placing) return;
    setConfirmOrderOpen(true);
  }, [placing]);

  const handlePayOnlinePress = useCallback(() => {
    if (placing) return;
    void placeOrder(PaymentMethod.ONLINE);
  }, [placing, placeOrder]);

  /* ==============================================================
   * LOADING
   * ============================================================== */

  if (isLoading) {
    return <Loading label="Loading your cart…" />;
  }

  /* ==============================================================
   * ERROR
   * ============================================================== */

  if (isError || !cart) {
    return (
      <ErrorState
        message="We could not load your cart."
        onRetry={() => void refetch()}
      />
    );
  }

  /* ==============================================================
   * DISPLAYED ITEMS
   *
   * `cart` is already the OPTIMISTIC cart (see useCartActions.ts) — a line
   * decremented to zero is already gone from `cart.items` the instant the
   * tap happens, not once the server confirms it. No separate filtering
   * needed here anymore.
   * ============================================================== */

  const displayItems = cart.items;
  const displayItemCount = cart.bill.itemCount;

  /* ==============================================================
   * EMPTY CART
   * ============================================================== */

  if (displayItems.length === 0) {
    return (
      <Screen>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.headerLeft}>
            <AppText variant="h1" style={styles.headerTitle}>
              Your Cart
            </AppText>

            <AppText variant="body" color={colors.textSecondary} style={styles.headerSubtitle}>
              0 items in your cart
            </AppText>
          </View>

          <Pressable
            style={styles.searchIconButton}
            onPress={onOpenSearch}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Search products"
          >
            <Ionicons name="search" size={20} color={colors.primary} />
          </Pressable>
        </View>

        <EmptyState
          icon={
            <View>
              <Ionicons name="cart-outline" size={52} color={colors.primary} />
              <View style={styles.emptyCartBadge}>
                <Ionicons name="add" size={14} color={colors.onPrimary} />
              </View>
            </View>
          }
          title="Your cart is empty"
          hint="Looks like you haven't added anything yet. Start exploring and fill it up with your favourite groceries!"
          action={{
            label: "Continue Shopping",
            onPress: onBrowse,
          }}
        />
      </Screen>
    );
  }

  /* ==============================================================
   * SERVICEABILITY / CHECKOUT READINESS
   * ============================================================== */

  const outOfArea = serviceability !== null && !serviceability.serviceable;
  const canCheckout = cart.checkoutEnabled && !outOfArea;

  const selectedAddress = addresses.data?.find((item) => item.id === addressId) ?? null;
  const displayBill = bill ?? cart.bill;

  const canPlaceOrderBase =
    canCheckout && !placing && Boolean(addressId) && Boolean(quote.data);
  const canPlaceOrderCod = canPlaceOrderBase && quote.data?.codAllowed === true;
  const canPlaceOrderOnline = canPlaceOrderBase;

  /* ==============================================================
   * PRODUCT ITEM
   * ============================================================== */

  const renderItem = ({ item }: { item: CartItemDto }) => {
    const imageUrl = resolveImageUrl(item.imageUrl);
    const hasDiscount = item.mrpPaise > item.unitPricePaise;
    const itemBusy = actions.isBusy(item.variantId);
    // `item` comes from the optimistic cart, so `item.qty` already IS the
    // pending quantity — no separate `qtyFor` lookup needed.
    const qty = item.qty;

    return (
      <View style={styles.productCard}>
        <View style={styles.productImageBox}>
          {imageUrl ? (
            <Image source={{ uri: imageUrl }} style={styles.productImage} resizeMode="contain" />
          ) : (
            <View style={styles.imagePlaceholder} />
          )}
        </View>

        <View style={styles.productInformation}>
          <AppText variant="bodyStrong" numberOfLines={2} style={styles.productName}>
            {item.productName}
          </AppText>

          <AppText
            variant="body"
            color={colors.textSecondary}
            numberOfLines={1}
            style={styles.productVariant}
          >
            {item.variantName}
          </AppText>

          <View style={styles.priceRow}>
            <AppText variant="h3" color={colors.textPrimary} style={styles.currentPrice}>
              {formatPaise(item.unitPricePaise)}
            </AppText>

            {hasDiscount && (
              <AppText variant="body" color={colors.textMuted} style={styles.mrpPrice}>
                {formatPaise(item.mrpPaise)}
              </AppText>
            )}
          </View>
        </View>

        <View style={styles.productActions}>
          <Pressable
            style={styles.deleteButton}
            onPress={() => {
              LayoutAnimation.configureNext(CART_ROW_REMOVE_ANIMATION);
              void actions.remove(item.variantId);
            }}
            disabled={itemBusy}
            hitSlop={8}
          >
            <TrashIcon color={colors.textPrimary} />
          </Pressable>

          <QuantityStepper
            qty={qty}
            max={item.maxQtyPerOrder}
            busy={itemBusy}
            onIncrement={() => void actions.increment(item.variantId)}
            onDecrement={() => {
              if (qty <= 1) LayoutAnimation.configureNext(CART_ROW_REMOVE_ANIMATION);
              void actions.decrement(item.variantId);
            }}
          />
        </View>
      </View>
    );
  };

  /* ==============================================================
   * MAIN
   * ============================================================== */

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.headerLeft}>
          <AppText variant="h1" style={styles.headerTitle}>
            Your Cart
          </AppText>

          <AppText variant="body" color={colors.textSecondary} style={styles.headerSubtitle}>
            {displayItemCount} {displayItemCount === 1 ? "item" : "items"} in your cart
          </AppText>
        </View>

        <Pressable
          style={styles.searchIconButton}
          onPress={onOpenSearch}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Search products"
        >
          <Ionicons name="search" size={20} color={colors.primary} />
        </Pressable>
      </View>

      <FlatList
        data={displayItems}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: spacing.base,
          paddingTop: spacing.sm,
          // Tall enough to clear the floating checkout bar (address row +
          // total/buttons row + its own padding) so the last item / Bill
          // Details card is never hidden behind it.
          paddingBottom: 290 + insets.bottom,
        }}
        ItemSeparatorComponent={() => <View style={styles.productSeparator} />}
        ListHeaderComponent={
          <View>
            {cart.changes.map((change, index) => (
              <View key={`${change.type}-${index}`} style={styles.noticeContainer}>
                <NoticeStrip message={change.message} />
              </View>
            ))}

            {(actions.error || checkoutError) && (
              <View style={styles.noticeContainer}>
                <NoticeStrip message={checkoutError ?? actions.error ?? ""} />
              </View>
            )}

            {outOfArea && (
              <View style={styles.noticeContainer}>
                <NoticeStrip
                  message="We don't deliver to your current location, so this order can't be placed yet."
                  tone="info"
                />
              </View>
            )}
          </View>
        }
        ListFooterComponent={
          <View>
            <BillDetails bill={displayBill} />
          </View>
        }
      />

      {/* ============================================================
          FLOATING CHECKOUT BAR — delivery address on top, total + the
          two payment buttons below. Sits above the tab bar as one
          rounded, elevated card rather than a flat strip.
      ============================================================ */}

      <View style={[styles.bottomCheckout, { paddingBottom: insets.bottom + spacing.sm }]}>
        <DeliveryAddressSection
          address={selectedAddress}
          loading={addresses.isLoading}
          hasAny={(addresses.data?.length ?? 0) > 0}
          onChange={() => setAddressPickerOpen(true)}
          onAdd={onAddAddress}
        />
        <View style={styles.bottomDivider} />

        {!canCheckout && cart.checkoutBlockedReason && (
          <AppText variant="caption" color={colors.warning} style={styles.checkoutBlockedText}>
            {cart.checkoutBlockedReason}
          </AppText>
        )}

        <View style={styles.paymentBarRow}>
          <View style={styles.paymentBarTotal}>
            <AppText variant="h2" color={colors.textPrimary} style={styles.paymentBarAmount}>
              {formatPaise(displayBill.totalPaise)}
            </AppText>
          </View>

          <View style={styles.paymentBarButtons}>
            <PaymentBarButton
              icon="cash-outline"
              title="Pay Cash"
              subtitle="Cash on Delivery"
              variant="outline"
              onPress={handleCodPress}
              disabled={!canPlaceOrderCod}
              loading={placing === PaymentMethod.COD}
            />
            <PaymentBarButton
              icon="phone-portrait-outline"
              title="Pay Online"
              subtitle="UPI / Card / Wallet"
              variant="filled"
              onPress={handlePayOnlinePress}
              disabled={!canPlaceOrderOnline}
              loading={placing === PaymentMethod.ONLINE}
            />
          </View>
        </View>
      </View>

      <AddressPickerModal
        visible={addressPickerOpen}
        addresses={addresses.data ?? []}
        selectedId={addressId}
        onSelect={(id) => {
          setAddressId(id);
          setAddressPickerOpen(false);
        }}
        onAdd={() => {
          setAddressPickerOpen(false);
          onAddAddress();
        }}
        onClose={() => setAddressPickerOpen(false)}
      />

      <ConfirmOrderModal
        visible={confirmOrderOpen}
        address={selectedAddress}
        itemCount={displayBill.itemCount}
        totalPaise={displayBill.totalPaise}
        busy={placing === PaymentMethod.COD}
        onCancel={() => setConfirmOrderOpen(false)}
        onConfirm={() => void placeOrder(PaymentMethod.COD)}
      />
    </Screen>
  );
}

/* ================================================================
 * ADDRESS CATEGORY VISUAL — a distinct icon/colour per label so "Home",
 * "Work" and "Other" are recognisable at a glance instead of one generic
 * pin everywhere. Matched on the label itself, so it still works for a
 * saved address titled anything else (falls back to a plain pin).
 * ================================================================ */

const ADDRESS_VISUALS: Record<
  string,
  { icon: keyof typeof Ionicons.glyphMap; bg: string; fg: string }
> = {
  home: { icon: "home", bg: "#DDF5E5", fg: colors.primary },
  work: { icon: "briefcase", bg: "#DCEAFE", fg: "#2563EB" },
  other: { icon: "location", bg: "#EDE4FB", fg: "#7C3AED" },
};

function addressVisual(label: string) {
  return ADDRESS_VISUALS[label.trim().toLowerCase()] ?? ADDRESS_VISUALS["other"]!;
}

/* ================================================================
 * DELIVERY ADDRESS SECTION — compact row at the top of the floating
 * checkout bar, not a bordered card of its own (the bar itself is the
 * card).
 * ================================================================ */

function DeliveryAddressSection({
  address,
  loading,
  hasAny,
  onChange,
  onAdd,
}: {
  address: AddressDto | null;
  loading: boolean;
  hasAny: boolean;
  onChange: () => void;
  onAdd: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.addressRow}>
        <AppText variant="caption" color={colors.textSecondary}>
          Loading address…
        </AppText>
      </View>
    );
  }

  if (!hasAny) {
    return (
      <Pressable style={styles.addressRow} onPress={onAdd} accessibilityRole="button">
        <View style={[styles.addressIconCircle, { backgroundColor: colors.primary + "15" }]}>
          <Ionicons name="add" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="bodyStrong" color={colors.primary}>
            Add a delivery address
          </AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            Required to place your order
          </AppText>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.primary} />
      </Pressable>
    );
  }

  const visual = addressVisual(address?.label ?? "");

  return (
    <Pressable style={styles.addressRow} onPress={onChange} accessibilityRole="button">
      <View style={[styles.addressIconCircle, { backgroundColor: visual.bg }]}>
        <Ionicons name={visual.icon} size={18} color={visual.fg} />
      </View>

      <View style={styles.addressCompactContent}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {address?.label ?? "Select address"}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
          {address
            ? `${addressPrimaryLine(address)}, ${address.city}`
            : "Tap to choose a delivery address"}
        </AppText>
      </View>

      {/* Fixed-size, never squeezed by a long address line — the content
          column above has `minWidth: 0` so IT truncates instead. */}
      <View style={styles.addressChangeAction}>
        <AppText variant="bodyStrong" color={colors.primary} numberOfLines={1}>
          Change
        </AppText>
        <Ionicons name="chevron-forward" size={15} color={colors.primary} />
      </View>
    </Pressable>
  );
}

/* ================================================================
 * PAYMENT BAR BUTTON — the two bottom-bar CTAs (Cash on Delivery / Pay
 * Online). Replaces the old single "Place Order" button: the payment
 * method is now chosen by which of these is tapped, not a separate radio
 * selection above.
 * ================================================================ */

function PaymentBarButton({
  icon,
  title,
  subtitle,
  variant,
  onPress,
  disabled,
  loading,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  variant: "filled" | "outline";
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const isFilled = variant === "filled";
  const isDisabled = disabled || loading;
  const fg = isFilled ? colors.onPrimary : colors.primary;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.payBarButton,
        isFilled ? styles.payBarButtonFilled : styles.payBarButtonOutline,
        isDisabled && styles.payBarButtonDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      accessibilityState={{ disabled: isDisabled }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          <Ionicons name={icon} size={20} color={fg} />
          <View style={styles.payBarButtonTextColumn}>
            <AppText
              variant="bodyStrong"
              color={fg}
              numberOfLines={1}
              style={styles.payBarButtonTitle}
            >
              {title}
            </AppText>
            <AppText
              variant="caption"
              color={isFilled ? "rgba(255,255,255,0.85)" : colors.textSecondary}
              numberOfLines={1}
              style={styles.payBarButtonSubtitle}
            >
              {subtitle}
            </AppText>
          </View>
        </>
      )}
    </Pressable>
  );
}

/* ================================================================
 * ADDRESS PICKER — a bottom sheet, not a full-screen page: the Cart stays
 * visible (dimmed) behind it, and tapping a card only highlights it —
 * "Use This Address" is what actually commits the choice and closes the
 * sheet, so a stray tap can't silently swap the delivery address.
 * ================================================================ */

function AddressPickerModal({
  visible,
  addresses,
  selectedId,
  onSelect,
  onAdd,
  onClose,
}: {
  visible: boolean;
  addresses: AddressDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  // The in-sheet highlight, separate from the address actually applied to
  // checkout — reset to match whenever the sheet (re)opens.
  const [pick, setPick] = useState(selectedId);
  useEffect(() => {
    if (visible) setPick(selectedId);
  }, [visible, selectedId]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Backdrop — tapping the dimmed area outside the sheet cancels,
          same as the X button. */}
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        {/* Absorbs taps so they don't fall through to the backdrop above —
            the sheet itself is not a "cancel" target. */}
        <Pressable
          style={[styles.sheetCard, { paddingBottom: insets.bottom + spacing.md }]}
          onPress={() => {}}
        >
          <View style={styles.sheetHandle} />

          <View style={styles.sheetHeader}>
            <AppText variant="h2">Select Address</AppText>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={styles.sheetCloseButton}
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <FlatList
            data={addresses}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.sheetListContent}
            ListHeaderComponent={
              <Pressable
                style={[styles.addAddressPrompt, { marginBottom: spacing.md }]}
                onPress={onAdd}
                accessibilityRole="button"
              >
                <View style={styles.addAddressPromptIcon}>
                  <Ionicons name="add" size={22} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyStrong" color={colors.primary}>
                    Add New Address
                  </AppText>
                  <AppText variant="caption" color={colors.textSecondary}>
                    Save a new address for faster checkout
                  </AppText>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.primary} />
              </Pressable>
            }
            ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
            renderItem={({ item }) => {
              const selected = item.id === pick;
              const disabled = !item.isServiceable;
              const visual = addressVisual(item.label);

              return (
                <Pressable
                  onPress={() => !disabled && setPick(item.id)}
                  disabled={disabled}
                  style={[
                    styles.pickerAddressCard,
                    selected && styles.addressCardSelected,
                    disabled && styles.addressCardDisabled,
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled }}
                >
                  <View style={[styles.addressIconCircle, { backgroundColor: visual.bg }]}>
                    <Ionicons name={visual.icon} size={18} color={visual.fg} />
                  </View>

                  <View style={{ flex: 1, marginLeft: spacing.sm, minWidth: 0 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {item.label}
                      {item.fullName ? ` (${item.fullName})` : ""}
                    </AppText>
                    <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                      {item.mobile}
                    </AppText>
                    <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                      {addressPrimaryLine(item)}, {item.city} {item.pincode}
                    </AppText>
                    {disabled && (
                      <AppText variant="caption" color={colors.danger}>
                        We don't deliver to this address
                      </AppText>
                    )}
                  </View>

                  <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                    {selected && <View style={styles.radioInner} />}
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <AppText
                variant="body"
                color={colors.textSecondary}
                style={{ textAlign: "center", marginTop: spacing.xl }}
              >
                No saved addresses yet.
              </AppText>
            }
          />

          <Button
            label="Use This Address"
            onPress={() => pick && onSelect(pick)}
            disabled={!pick}
            style={styles.sheetUseButton}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ================================================================
 * CONFIRM ORDER MODAL (COD only)
 * ================================================================ */

function ConfirmOrderModal({
  visible,
  address,
  itemCount,
  totalPaise,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  address: AddressDto | null;
  itemCount: number;
  totalPaise: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <Card style={styles.confirmCard}>
          <Pressable
            onPress={onCancel}
            hitSlop={10}
            style={styles.confirmCloseButton}
            accessibilityLabel="Close"
          >
            <Ionicons name="close" size={20} color={colors.textSecondary} />
          </Pressable>

          <View style={styles.confirmIconCircle}>
            <Ionicons name="cash" size={30} color={colors.primary} />
          </View>

          <AppText variant="h2" style={styles.confirmTitle}>
            Confirm Order
          </AppText>

          <AppText variant="body" color={colors.textSecondary} style={styles.confirmSubtitle}>
            Pay {formatPaise(totalPaise)} on delivery?
          </AppText>

          <View style={styles.confirmDetailsCard}>
            {address && (
              <View style={styles.confirmDetailRow}>
                <Ionicons name="location-outline" size={17} color={colors.primary} />
                <AppText
                  variant="caption"
                  color={colors.textPrimary}
                  numberOfLines={1}
                  style={{ marginLeft: spacing.xs, flex: 1 }}
                >
                  {address.label} • {addressPrimaryLine(address)}, {address.city}
                </AppText>
              </View>
            )}

            <View style={styles.confirmDetailRow}>
              <AppText variant="caption" color={colors.textSecondary}>
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </AppText>
              <AppText variant="bodyStrong" color={colors.textPrimary}>
                {formatPaise(totalPaise)}
              </AppText>
            </View>
          </View>

          <View style={styles.confirmButtonRow}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={onCancel}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button
              label="Confirm Order"
              onPress={onConfirm}
              loading={busy}
              disabled={busy}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

/* ================================================================
 * BILL DETAILS
 * ================================================================ */

function BillDetails({ bill }: { bill: BillDto }) {
  return (
    <View style={styles.billWrapper}>
      <Card style={styles.billCard}>
        <View style={styles.billHeader}>
          <View style={styles.billIconContainer}>
            <ReceiptIcon color={colors.primary} />
          </View>

          <AppText variant="h2" style={styles.billTitle}>
            Bill Details
          </AppText>
        </View>

        <View style={styles.billRows}>
          <BillRow
            label={`Item Total (${bill.itemCount} items)`}
            value={formatPaise(bill.itemsSubtotalPaise)}
          />

          {bill.couponDiscountPaise > 0 && (
            <BillRow
              label={`Coupon (${bill.couponCode})`}
              value={`− ${formatPaise(bill.couponDiscountPaise)}`}
              tone="good"
            />
          )}
          <BillRow
            label="Delivery Fee"
            value={bill.deliveryFeePaise === 0 ? "FREE" : formatPaise(bill.deliveryFeePaise)}
            tone={bill.deliveryFeePaise === 0 ? "good" : "default"}
          />

          {bill.platformFeePaise > 0 && (
            <BillRow label="Platform Fee" value={formatPaise(bill.platformFeePaise)} />
          )}

          {bill.taxPaise > 0 && (
            <BillRow label="Taxes (included)" value={formatPaise(bill.taxPaise)} tone="muted" />
          )}
        </View>

        <View style={styles.totalRow}>
          <AppText variant="h2" style={styles.totalLabel}>
            To Pay
          </AppText>

          <AppText variant="h1" color={colors.primary} style={styles.totalAmount}>
            {formatPaise(bill.totalPaise)}
          </AppText>
        </View>

        {bill.totalSavingsPaise > 0 && (
          <View style={styles.savingsContainer}>
            <View style={styles.savingsIcon}>
              <TagIcon color={colors.primary} />
            </View>

            <AppText variant="h3" color={colors.primary} style={styles.savingsText}>
              You save {formatPaise(bill.totalSavingsPaise)} on this order
            </AppText>
          </View>
        )}
      </Card>
    </View>
  );
}

/* ================================================================
 * BILL ROW
 * ================================================================ */

function BillRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "muted";
}) {
  const valueColor: string =
    tone === "good" ? colors.primary : tone === "muted" ? colors.textMuted : colors.textPrimary;

  return (
    <View style={styles.billRow}>
      <AppText variant="body" color={colors.textSecondary} style={styles.billLabel}>
        {label}
      </AppText>

      <AppText variant="body" color={valueColor} style={styles.billValue}>
        {value}
      </AppText>
    </View>
  );
}

/* ================================================================
 * TRASH ICON
 *
 * IMPORTANT:
 * There are NO trashLineLeft / trashLineRight styles.
 * left/right are placed directly inside the JSX style object.
 *
 * This avoids the `{ expected` syntax problem you encountered.
 * ================================================================ */

function TrashIcon({ color }: { color: string }) {
  return (
    <View style={styles.trashIcon}>
      <View style={[styles.trashHandle, { backgroundColor: color }]} />
      <View style={[styles.trashLid, { backgroundColor: color }]} />
      <View style={[styles.trashBody, { borderColor: color }]}>
        <View style={[styles.trashLine, { backgroundColor: color, left: 3 }]} />
        <View style={[styles.trashLine, { backgroundColor: color, right: 3 }]} />
      </View>
    </View>
  );
}

/* ================================================================
 * RECEIPT ICON
 * ================================================================ */

function ReceiptIcon({ color }: { color: string }) {
  return (
    <View style={[styles.receiptIcon, { borderColor: color }]}>
      <View style={[styles.receiptLine, { backgroundColor: color }]} />
      <View style={[styles.receiptLine, { backgroundColor: color }]} />
      <View style={[styles.receiptLineSmall, { backgroundColor: color }]} />
    </View>
  );
}

/* ================================================================
 * TAG ICON
 * ================================================================ */

function TagIcon({ color }: { color: string }) {
  return (
    <View style={[styles.tagShape, { borderColor: color }]}>
      <View style={[styles.tagDot, { backgroundColor: color }]} />
    </View>
  );
}

/* ================================================================
 * STYLES
 * ================================================================ */

const styles = StyleSheet.create({
  /* ============================================================
   * HEADER
   * ============================================================ */

  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },

  headerLeft: { flex: 1 },

  emptyCartBadge: {
    position: "absolute",
    bottom: -2,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: radius.circle,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },

  headerTitle: {
    fontSize: 26,
    lineHeight: 38,
    fontWeight: "800",
    letterSpacing: -0.7,
  },

  headerSubtitle: {
    marginTop: spacing.xs,
    fontSize: 15,
    lineHeight: 22,
  },

  searchIconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.primarySurface,
  },

  noticeContainer: { marginBottom: spacing.sm },

  /* ============================================================
   * PRODUCT CARD
   * ============================================================ */

  productCard: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 80,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },

  productSeparator: { height: spacing.sm },

  productImageBox: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },

  productImage: { width: 44, height: 44 },

  imagePlaceholder: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.skeleton,
  },

  productInformation: {
    flex: 1,
    minWidth: 0,
    marginLeft: spacing.md,
    marginRight: spacing.sm,
  },

  productName: { fontSize: 13, lineHeight: 21, fontWeight: "700" },
  productVariant: { fontSize: 12, lineHeight: 20, marginTop: spacing.xs },

  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },

  currentPrice: { fontSize: 14, lineHeight: 20, fontWeight: "800" },
  mrpPrice: { fontSize: 12, lineHeight: 20, textDecorationLine: "line-through" },

  productActions: {
    alignItems: "flex-end",
    justifyContent: "space-between",
    minHeight: 72,
    flexShrink: 0,
  },

  deleteButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

  /* ============================================================
   * TRASH ICON
   * ============================================================ */

  trashIcon: { width: 21, height: 23, position: "relative", alignItems: "center" },
  trashHandle: { position: "absolute", top: 0, width: 7, height: 3, borderRadius: 2 },
  trashLid: { position: "absolute", top: 4, width: 19, height: 2, borderRadius: 2 },
  trashBody: {
    position: "absolute",
    top: 7,
    width: 15,
    height: 15,
    borderWidth: 1.8,
    borderRadius: 2,
  },
  trashLine: { position: "absolute", top: 2, width: 1.5, height: 8, borderRadius: 1 },

  /* ============================================================
   * DELIVERY ADDRESS ROW — inside the floating checkout bar
   * ============================================================ */

  addressRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
  },

  addressIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
    flexShrink: 0,
  },

  addressCompactContent: { flex: 1, minWidth: 0, marginRight: spacing.sm },

  addressChangeAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },

  addAddressPrompt: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 64,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.primary,
    backgroundColor: colors.primary + "08",
    gap: spacing.sm,
  },

  addAddressPromptIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary + "18",
  },

  /* ============================================================
   * RADIO
   * ============================================================ */

  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  radioOuterSelected: { borderColor: colors.primary },

  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },

  /* ============================================================
   * ADDRESS PICKER — bottom sheet
   * ============================================================ */

  sheetBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },

  sheetCard: {
    maxHeight: "78%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.base,
    ...shadow.lg,
  },

  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },

  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },

  sheetCloseButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },

  sheetListContent: {
    paddingBottom: spacing.md,
  },

  sheetUseButton: {
    minHeight: 54,
  },

  pickerAddressCard: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 80,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },

  addressCardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + "0A",
    borderWidth: 1.5,
  },

  addressCardDisabled: { opacity: 0.55 },

  /* ============================================================
   * CONFIRM ORDER MODAL
   * ============================================================ */

  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },

  confirmCard: {
    width: "100%",
    maxWidth: 400,
    padding: spacing.lg,
    alignItems: "center",
    position: "relative",
  },

  confirmCloseButton: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },

  confirmIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary + "15",
    marginTop: spacing.sm,
  },

  confirmTitle: { marginTop: spacing.md },

  confirmSubtitle: { marginTop: spacing.xs, textAlign: "center" },

  confirmDetailsCard: {
    width: "100%",
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
    gap: spacing.xs,
  },

  confirmDetailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  confirmButtonRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.lg,
    width: "100%",
  },

  /* ============================================================
   * BILL CARD
   * ============================================================ */

  billWrapper: { marginTop: spacing.md, marginBottom: spacing.sm },

  billCard: {
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.primary + "35",
    backgroundColor: colors.primary + "08",
  },

  billHeader: { flexDirection: "row", alignItems: "center", marginBottom: spacing.md },

  billIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary + "15",
  },

  billTitle: { marginLeft: spacing.md, fontSize: 16, lineHeight: 24, fontWeight: "800" },

  billRows: { paddingBottom: spacing.sm },

  billRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 35,
    paddingVertical: spacing.xs,
  },

  billLabel: { flex: 1, fontSize: 14, lineHeight: 24 },
  billValue: { fontSize: 15, lineHeight: 24, marginLeft: spacing.md, textAlign: "right" },

  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.primary + "25",
  },

  totalLabel: { fontSize: 20, lineHeight: 28, fontWeight: "800" },
  totalAmount: { fontSize: 24, lineHeight: 32, fontWeight: "800" },

  savingsContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary + "13",
  },

  savingsIcon: { width: 34, height: 34, alignItems: "center", justifyContent: "center", marginRight: spacing.sm },
  savingsText: { flex: 1, fontSize: 13, lineHeight: 24, fontWeight: "700" },

  /* ============================================================
   * RECEIPT / TAG ICONS
   * ============================================================ */

  receiptIcon: {
    width: 20,
    height: 24,
    borderWidth: 2,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  receiptLine: { width: 11, height: 2, borderRadius: 2 },
  receiptLineSmall: { width: 7, height: 2, borderRadius: 2 },

  tagShape: {
    width: 20,
    height: 16,
    borderWidth: 2,
    borderRadius: 4,
    position: "relative",
    transform: [{ rotate: "-20deg" }],
  },
  tagDot: { position: "absolute", right: 3, top: 4, width: 4, height: 4, borderRadius: 2 },

  /* ============================================================
   * BOTTOM CHECKOUT
   * ============================================================ */

  bottomCheckout: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    // A floating card, not a flat strip flush with the screen edge —
    // rounded top corners + shadow instead of a plain top border.
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    ...shadow.lg,
  },

  bottomDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginTop: spacing.md,
  },

  checkoutBlockedText: {
    textAlign: "center",
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },

  /* Amount on the left, the two payment buttons side by side on the right. */
  paymentBarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.md,
  },

  paymentBarTotal: {
    flexShrink: 0,
  },

  paymentBarAmount: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "800",
  },

  paymentBarButtons: {
    flex: 1,
    flexDirection: "row",
    gap: spacing.sm,
  },

  payBarButton: {
    flex: 1,
    minHeight: 54,
    borderRadius: radius.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },

  payBarButtonFilled: {
    backgroundColor: colors.primary,
  },

  payBarButtonOutline: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },

  payBarButtonDisabled: {
    opacity: 0.5,
  },

  payBarButtonTextColumn: {
    minWidth: 0,
  },

  payBarButtonTitle: {
    fontSize: 14,
    lineHeight: 18,
  },

  payBarButtonSubtitle: {
    fontSize: 11,
    lineHeight: 14,
    marginTop: 1,
  },
});

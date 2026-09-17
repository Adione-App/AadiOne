/**
 * Cart (Task 14.9)
 *
 * IMPORTANT:
 * The bill is rendered EXACTLY as returned by the server.
 * No subtotal, delivery fee, tax, discount, or total is calculated here.
 *
 * UI follows the provided AdiOne Cart design.
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

import { FlatList, Image, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { CartItemDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";

import { useCart } from "@/lib/queries";
import { resolveImageUrl } from "@/lib/api";
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

/* ================================================================
 * MAIN CART SCREEN
 * ================================================================ */

export default function CartScreen({
  onCheckout,
  onBrowse,
}: {
  onCheckout: () => void;
  onBrowse: () => void;
}) {
  const insets = useSafeAreaInsets();

  const { location, serviceability } = useLocation();

  const distanceKm = serviceability?.distanceKm ?? null;


  const { data: cart, isLoading, isError, refetch } = useCart(distanceKm);

  const actions = useCartActions();

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
   * A deleted / decremented-to-zero line must vanish from the list the
   * instant the tap happens, not once the server confirms it — rendering
   * `cart.items` directly left the row on screen until that round trip
   * landed. Filtering by the optimistic qty here is the fix: the same
   * `qtyFor` the stepper already reads decides list membership too.
   * ============================================================== */

  const displayItems = cart.items.filter((item) => actions.qtyFor(item.variantId) > 0);

  // Sum of the same optimistic quantities the list and the stepper already
  // show — matches `itemCount`'s server definition (total units, not line
  // count) without waiting on the server for the header text to agree with
  // what the list below it is currently displaying.
  const displayItemCount = displayItems.reduce(
    (sum, item) => sum + actions.qtyFor(item.variantId),
    0,
  );

  /* ==============================================================
   * EMPTY CART
   * ============================================================== */

  if (displayItems.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        hint="Add your favourite groceries to get started."
        action={{
          label: "Browse products",
          onPress: onBrowse,
        }}
      />
    );
  }

  /* ==============================================================
   * SERVICEABILITY
   * ============================================================== */

  const outOfArea = serviceability !== null && !serviceability.serviceable;

  const canCheckout = cart.checkoutEnabled && !outOfArea;

  /* ==============================================================
   * PRODUCT ITEM
   * ============================================================== */

  const renderItem = ({ item }: { item: CartItemDto }) => {
    const imageUrl = resolveImageUrl(item.imageUrl);

    const hasDiscount = item.mrpPaise > item.unitPricePaise;
    const itemBusy = actions.isBusy(item.variantId);
    const qty = actions.qtyFor(item.variantId);

    return (
      <View style={styles.productCard}>
        {/* ======================================================
         * PRODUCT IMAGE
         * ====================================================== */}

        <View style={styles.productImageBox}>
          {imageUrl ? (
            <Image
              source={{
                uri: imageUrl,
              }}
              style={styles.productImage}
              resizeMode="contain"
            />
          ) : (
            <View style={styles.imagePlaceholder} />
          )}
        </View>

        {/* ======================================================
         * PRODUCT INFORMATION
         * ====================================================== */}

        <View style={styles.productInformation}>
          <AppText
            variant="bodyStrong"
            numberOfLines={2}
            style={styles.productName}
          >
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
            <AppText
              variant="h3"
              color={colors.textPrimary}
              style={styles.currentPrice}
            >
              {formatPaise(item.unitPricePaise)}
            </AppText>

            {hasDiscount && (
              <AppText
                variant="body"
                color={colors.textMuted}
                style={styles.mrpPrice}
              >
                {formatPaise(item.mrpPaise)}
              </AppText>
            )}
          </View>
        </View>

        {/* ======================================================
         * RIGHT SIDE
         * ====================================================== */}

        <View style={styles.productActions}>
          {/* Trash icon */}

          <Pressable
            style={styles.deleteButton}
            onPress={() => void actions.remove(item.variantId)}
            disabled={itemBusy}
            hitSlop={8}
          >
            <TrashIcon color={colors.textPrimary} />
          </Pressable>

          {/* Quantity */}

          <QuantityStepper
            qty={qty}
            max={item.maxQtyPerOrder}
            busy={itemBusy}
            onIncrement={() => void actions.increment(item.variantId)}
            onDecrement={() => void actions.decrement(item.variantId)}
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
      {/* ==========================================================
       * HEADER
       * ========================================================== */}

      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.md,
          },
        ]}
      >
        <View style={styles.headerLeft}>
          <AppText variant="h1" style={styles.headerTitle}>
            Your Cart
          </AppText>

          <AppText
            variant="body"
            color={colors.textSecondary}
            style={styles.headerSubtitle}
          >
            {displayItemCount} {displayItemCount === 1 ? "item" : "items"}{" "}
            in your cart
          </AppText>
        </View>

        {/* ========================================================
         * CLEAR CART — instant: every line is optimistically zeroed
         * before the bulk DELETE /cart request is even sent (see
         * useCartActions' clear()), so the list empties on tap, not
         * once the network round trip finishes.
         * ======================================================== */}

        <Pressable
          style={styles.clearCartContainer}
          onPress={() => void actions.clear()}
          disabled={actions.busy}
          hitSlop={8}
        >
          <TrashIcon color={colors.primary} />

          <AppText
            variant="h3"
            color={colors.primary}
            style={styles.clearCartText}
          >
            Clear Cart
          </AppText>
        </Pressable>
      </View>

      {/* ==========================================================
       * CART LIST
       * ========================================================== */}

      <FlatList
        data={displayItems}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: spacing.base,
          paddingTop: spacing.sm,
          paddingBottom: 190,
        }}
        ItemSeparatorComponent={() => <View style={styles.productSeparator} />}
        ListHeaderComponent={
          <View>
            {/* Server corrections */}

            {cart.changes.map((change, index) => (
              <View
                key={`${change.type}-${index}`}
                style={styles.noticeContainer}
              >
                <NoticeStrip message={change.message} />
              </View>
            ))}

            {/* Cart action error */}

            {actions.error && (
              <View style={styles.noticeContainer}>
                <NoticeStrip message={actions.error} />
              </View>
            )}

            {/* Out of delivery area */}

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
        ListFooterComponent={<BillDetails cart={cart} />}
      />

      {/* ==========================================================
       * CHECKOUT BUTTON
       * ========================================================== */}

      <View
        style={[
          styles.bottomCheckout,
          {
            paddingBottom: insets.bottom + spacing.md,
          },
        ]}
      >
        {!canCheckout && cart.checkoutBlockedReason && (
          <AppText
            variant="caption"
            color={colors.warning}
            style={styles.checkoutBlockedText}
          >
            {cart.checkoutBlockedReason}
          </AppText>
        )}

        <Button
          label={`Checkout · ${formatPaise(cart.bill.totalPaise)}   →`}
          onPress={onCheckout}
          disabled={!canCheckout}
          style={styles.checkoutButton}
        />
      </View>
    </Screen>
  );
}

/* ================================================================
 * BILL DETAILS
 * ================================================================ */

function BillDetails({
  cart,
}: {
  cart: NonNullable<ReturnType<typeof useCart>["data"]>;
}) {
  return (
    <View style={styles.billWrapper}>
      <Card style={styles.billCard}>
        {/* ========================================================
         * BILL HEADER
         * ======================================================== */}

        <View style={styles.billHeader}>
          <View style={styles.billIconContainer}>
            <ReceiptIcon color={colors.primary} />
          </View>

          <AppText variant="h2" style={styles.billTitle}>
            Bill Details
          </AppText>
        </View>

        {/* ========================================================
         * BILL ROWS
         * ======================================================== */}

        <View style={styles.billRows}>
          <BillRow
            label={`Item Total (${cart.bill.itemCount} items)`}
            value={formatPaise(cart.bill.itemsSubtotalPaise)}
          />

          {cart.bill.couponDiscountPaise > 0 && (
            <BillRow
              label={`Coupon (${cart.bill.couponCode})`}
              value={`− ${formatPaise(cart.bill.couponDiscountPaise)}`}
              tone="good"
            />
          )}
          <BillRow
            label="Delivery Fee"
            value={
              cart.bill.deliveryFeePaise === 0
                ? "FREE"
                : formatPaise(cart.bill.deliveryFeePaise)
            }
            tone={cart.bill.deliveryFeePaise === 0 ? "good" : "default"}
          />

          {cart.bill.platformFeePaise > 0 && (
            <BillRow
              label="Platform Fee"
              value={formatPaise(cart.bill.platformFeePaise)}
            />
          )}

          {cart.bill.taxPaise > 0 && (
            <BillRow
              label="Taxes (included)"
              value={formatPaise(cart.bill.taxPaise)}
              tone="muted"
            />
          )}
        </View>

        {/* ========================================================
         * TOTAL
         * ======================================================== */}

        <View style={styles.totalRow}>
          <AppText variant="h2" style={styles.totalLabel}>
            To Pay
          </AppText>

          <AppText
            variant="h1"
            color={colors.primary}
            style={styles.totalAmount}
          >
            {formatPaise(cart.bill.totalPaise)}
          </AppText>
        </View>

        {/* ========================================================
         * SAVINGS
         * ======================================================== */}

        {cart.bill.totalSavingsPaise > 0 && (
          <View style={styles.savingsContainer}>
            <View style={styles.savingsIcon}>
              <TagIcon color={colors.primary} />
            </View>

            <AppText
              variant="h3"
              color={colors.primary}
              style={styles.savingsText}
            >
              You save {formatPaise(cart.bill.totalSavingsPaise)} on this order
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
    tone === "good"
      ? colors.primary
      : tone === "muted"
        ? colors.textMuted
        : colors.textPrimary;

  return (
    <View style={styles.billRow}>
      <AppText
        variant="body"
        color={colors.textSecondary}
        style={styles.billLabel}
      >
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
      {/* Handle */}

      <View
        style={[
          styles.trashHandle,
          {
            backgroundColor: color,
          },
        ]}
      />

      {/* Lid */}

      <View
        style={[
          styles.trashLid,
          {
            backgroundColor: color,
          },
        ]}
      />

      {/* Body */}

      <View
        style={[
          styles.trashBody,
          {
            borderColor: color,
          },
        ]}
      >
        {/* Left line */}

        <View
          style={[
            styles.trashLine,
            {
              backgroundColor: color,
              left: 3,
            },
          ]}
        />

        {/* Right line */}

        <View
          style={[
            styles.trashLine,
            {
              backgroundColor: color,
              right: 3,
            },
          ]}
        />
      </View>
    </View>
  );
}

/* ================================================================
 * RECEIPT ICON
 * ================================================================ */

function ReceiptIcon({ color }: { color: string }) {
  return (
    <View
      style={[
        styles.receiptIcon,
        {
          borderColor: color,
        },
      ]}
    >
      <View
        style={[
          styles.receiptLine,
          {
            backgroundColor: color,
          },
        ]}
      />

      <View
        style={[
          styles.receiptLine,
          {
            backgroundColor: color,
          },
        ]}
      />

      <View
        style={[
          styles.receiptLineSmall,
          {
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

/* ================================================================
 * TAG ICON
 * ================================================================ */

function TagIcon({ color }: { color: string }) {
  return (
    <View
      style={[
        styles.tagShape,
        {
          borderColor: color,
        },
      ]}
    >
      <View
        style={[
          styles.tagDot,
          {
            backgroundColor: color,
          },
        ]}
      />
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

  headerLeft: {
    flex: 1,
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

  /* ============================================================
   * CLEAR CART
   * ============================================================ */

  clearCartContainer: {
    flexDirection: "row",
    alignItems: "center",

    marginLeft: spacing.md,

    marginTop: spacing.md,

    gap: spacing.sm,
  },

  clearCartText: {
    fontSize: 15,
    fontWeight: "700",
  },

  /* ============================================================
   * NOTICES
   * ============================================================ */

  noticeContainer: {
    marginBottom: spacing.sm,
  },

  /* ============================================================
   * PRODUCT CARD
   *
   * Deliberately compact to match the supplied design.
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

  productSeparator: {
    height: spacing.sm,
  },

  /* ============================================================
   * PRODUCT IMAGE
   * ============================================================ */

  productImageBox: {
    width: 52,
    height: 52,

    alignItems: "center",
    justifyContent: "center",

    flexShrink: 0,

    backgroundColor: colors.surface,

    borderRadius: radius.md,
  },

  productImage: {
    width: 44,
    height: 44,
  },

  imagePlaceholder: {
    width: 44,
    height: 44,

    borderRadius: radius.md,

    backgroundColor: colors.skeleton,
  },

  /* ============================================================
   * PRODUCT INFORMATION
   * ============================================================ */

  productInformation: {
    flex: 1,

    minWidth: 0,

    marginLeft: spacing.md,

    marginRight: spacing.sm,
  },

  productName: {
    fontSize: 13,
    lineHeight: 21,
    fontWeight: "700",
  },

  productVariant: {
    fontSize: 12,
    lineHeight: 20,

    marginTop: spacing.xs,
  },

  priceRow: {
    flexDirection: "row",
    alignItems: "center",

    gap: spacing.sm,

    marginTop: spacing.xs,
  },

  currentPrice: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },

  mrpPrice: {
    fontSize: 12,
    lineHeight: 20,

    textDecorationLine: "line-through",
  },

  /* ============================================================
   * PRODUCT ACTIONS
   * ============================================================ */

  productActions: {
    alignItems: "flex-end",
    justifyContent: "space-between",

    minHeight: 72,

    flexShrink: 0,
  },

  deleteButton: {
    width: 28,
    height: 28,

    alignItems: "center",
    justifyContent: "center",
  },

  /* ============================================================
   * TRASH ICON
   * ============================================================ */

  trashIcon: {
    width: 21,
    height: 23,

    position: "relative",

    alignItems: "center",
  },

  trashHandle: {
    position: "absolute",

    top: 0,

    width: 7,
    height: 3,

    borderRadius: 2,
  },

  trashLid: {
    position: "absolute",

    top: 4,

    width: 19,
    height: 2,

    borderRadius: 2,
  },

  trashBody: {
    position: "absolute",

    top: 7,

    width: 15,
    height: 15,

    borderWidth: 1.8,

    borderRadius: 2,
  },

  trashLine: {
    position: "absolute",

    top: 2,

    width: 1.5,
    height: 8,

    borderRadius: 1,
  },

  /* ============================================================
   * BILL CARD
   * ============================================================ */

  billWrapper: {
    marginTop: spacing.md,

    marginBottom: spacing.sm,
  },

  billCard: {
    padding: spacing.md,

    borderRadius: radius.lg,

    borderWidth: 1,

    borderColor: colors.primary + "35",

    backgroundColor: colors.primary + "08",
  },

  billHeader: {
    flexDirection: "row",
    alignItems: "center",

    marginBottom: spacing.md,
  },

  billIconContainer: {
    width: 40,
    height: 40,

    borderRadius: 24,

    alignItems: "center",
    justifyContent: "center",

    backgroundColor: colors.primary + "15",
  },

  billTitle: {
    marginLeft: spacing.md,

    fontSize: 16,
    lineHeight: 24,

    fontWeight: "800",
  },

  /* ============================================================
   * BILL ROWS
   * ============================================================ */

  billRows: {
    paddingBottom: spacing.sm,
  },

  billRow: {
    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    minHeight: 35,

    paddingVertical: spacing.xs,
  },

  billLabel: {
    flex: 1,

    fontSize: 14,
    lineHeight: 24,
  },

  billValue: {
    fontSize: 15,
    lineHeight: 24,

    marginLeft: spacing.md,

    textAlign: "right",
  },

  /* ============================================================
   * TOTAL
   * ============================================================ */

  totalRow: {
    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    marginTop: spacing.sm,

    paddingTop: spacing.md,

    borderTopWidth: 1,

    borderTopColor: colors.primary + "25",
  },

  totalLabel: {
    fontSize: 20,
    lineHeight: 28,

    fontWeight: "800",
  },

  totalAmount: {
    fontSize: 24,
    lineHeight: 32,

    fontWeight: "800",
  },

  /* ============================================================
   * SAVINGS
   * ============================================================ */

  savingsContainer: {
    flexDirection: "row",

    alignItems: "center",

    marginTop: spacing.md,

    paddingVertical: spacing.md,

    paddingHorizontal: spacing.md,

    borderRadius: radius.md,

    backgroundColor: colors.primary + "13",
  },

  savingsIcon: {
    width: 34,
    height: 34,

    alignItems: "center",
    justifyContent: "center",

    marginRight: spacing.sm,
  },

  savingsText: {
    flex: 1,

    fontSize: 13,
    lineHeight: 24,

    fontWeight: "700",
  },

  /* ============================================================
   * RECEIPT ICON
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

  receiptLine: {
    width: 11,
    height: 2,

    borderRadius: 2,
  },

  receiptLineSmall: {
    width: 7,
    height: 2,

    borderRadius: 2,
  },

  /* ============================================================
   * TAG ICON
   * ============================================================ */

  tagShape: {
    width: 20,
    height: 16,

    borderWidth: 2,

    borderRadius: 4,

    position: "relative",

    transform: [
      {
        rotate: "-20deg",
      },
    ],
  },

  tagDot: {
    position: "absolute",

    right: 3,
    top: 4,

    width: 4,
    height: 4,

    borderRadius: 2,
  },

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

    borderTopWidth: 1,

    borderTopColor: colors.divider,
  },

  checkoutButton: {
    width: "100%",

    minHeight: 60,
  },

  checkoutBlockedText: {
    textAlign: "center",

    marginBottom: spacing.sm,

    paddingHorizontal: spacing.md,
  },
});

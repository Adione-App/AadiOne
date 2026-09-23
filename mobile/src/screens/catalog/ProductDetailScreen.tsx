/**
 * Product detail + out-of-stock state (Task 14.8).
 *
 * Variants are selectable rather than collapsed into one price: the cart
 * treats each variant as a separate line, so the customer must be able to see
 * and choose which size they are buying.
 */

import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { ProductSummaryDto, VariantDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, layout, radius, spacing } from "@shared/theme";
import { api, resolveImageUrl } from "@/lib/api";
import { useProduct } from "@/lib/queries";
import { snapshotFromProduct, useCartActions } from "@/lib/useCartActions";
import { flyFromCart, flyToCart } from "@/lib/flyToCart";
import { productDetailFooterHeight } from "@/lib/tabBarVisibility";
import { useGridColumns } from "@/lib/useGridColumns";
import {
  AppText,
  Button,
  Card,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
} from "@/components/ui";
import {
  ActionBarTransition,
  ProductCard,
  QuantityStepper,
} from "@/components/ProductCard";
import ProductGallery from "@/components/ProductGallery";

export default function ProductDetailScreen({
  productId,
  onBack,
  onOpenProduct,
  onGoToCart,
}: {
  productId: string;
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
  onGoToCart: () => void;
}) {
  const insets = useSafeAreaInsets();
  const product = useProduct(productId);
  const cart = useCartActions();
  const relatedColumns = useGridColumns();
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );
  const [notifyRequested, setNotifyRequested] = useState(false);

  const related = useQuery({
    queryKey: ["related", productId],
    queryFn: () =>
      api.get<ProductSummaryDto[]>(`/products/${productId}/related`),
    enabled: product.isSuccess,
  });

  // Computed with optional chaining (product.data may not exist yet) so
  // this is safe to feed into `cart.qtyFor` below before we know
  // `product.data` exists — no hook depends on it, but keeping the shape
  // consistent with the rest of this file's "every value is optional-chained
  // until after the loading/error guards" convention.
  const variant: VariantDto | undefined =
    product.data?.variants.find((item) => item.id === selectedVariantId) ??
    product.data?.variants.find((item) => item.inStock) ??
    product.data?.variants[0];
  const qtyInCart = variant ? cart.qtyFor(variant.id) : 0;

  if (product.isLoading) return <Loading />;
  if (product.isError || !product.data) {
    return (
      <ErrorState
        message="We could not load this product."
        onRetry={() => void product.refetch()}
      />
    );
  }

  const detail = product.data;
  const outOfStock = !variant?.inStock;
  const cartItemCount = cart.cart?.bill.itemCount ?? 0;
  // Same "small square thumbnail drops into the cart" flourish the card's
  // own Add/stepper already has (see ProductCard.tsx) — lands on the global
  // mini-cart overlay (MiniCartBar.tsx), which is what registers the actual
  // landing target on this screen now (it renders here too — see
  // `useMiniCartScreen`'s "productDetail" case).
  const flightImageUrl = resolveImageUrl(variant?.imageUrl ?? detail.imageUrl);

  async function requestNotify(): Promise<void> {
    if (!variant) return;
    // Best-effort: failing to register a back-in-stock alert is not worth an
    // error screen, and the optimistic state is honest either way.
    await api.post(`/products/${variant.id}/notify-me`).catch(() => undefined);
    setNotifyRequested(true);
  }

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
          <AppText variant="h2">←</AppText>
        </Pressable>
        <AppText variant="h3">Product Details</AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          // Clears the footer as before, PLUS the global mini-cart overlay
          // now floating above it once the cart has anything in it (same
          // 76px allowance HomeScreen uses for the identical pill) — the
          // last "You may also like" row would otherwise end up partly
          // hidden behind the two of them stacked.
          paddingBottom: 140 + (cartItemCount > 0 ? 76 : 0),
        }}
      >
        <ProductGallery
          images={detail.images}
          fallbackUrl={detail.imageUrl}
          productName={detail.name}
        />

        <View style={{ padding: spacing.base }}>
          <AppText variant="h1">{detail.name}</AppText>
          {detail.brandName && (
            <AppText variant="body" color={colors.textSecondary}>
              {detail.brandName}
            </AppText>
          )}

          {variant && (
            <View style={styles.priceRow}>
              <AppText variant="display" color={colors.primary}>
                {formatPaise(variant.pricePaise)}
              </AppText>
              {variant.mrpPaise > variant.pricePaise && (
                <>
                  <AppText
                    variant="bodyLarge"
                    color={colors.textMuted}
                    style={{ textDecorationLine: "line-through" }}
                  >
                    {formatPaise(variant.mrpPaise)}
                  </AppText>
                  <View style={styles.discountTag}>
                    <AppText variant="caption" color={colors.discountBadgeText}>
                      {variant.discountPercent}% OFF
                    </AppText>
                  </View>
                </>
              )}
            </View>
          )}

          <AppText variant="caption" color={colors.textSecondary}>
            MRP incl. of all taxes
          </AppText>

          {detail.variants.length > 1 && (
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="h3">Select size</AppText>
              <View style={styles.variantRow}>
                {detail.variants.map((item) => {
                  const active = item.id === variant?.id;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => setSelectedVariantId(item.id)}
                      style={[
                        styles.variantChip,
                        active && {
                          borderColor: colors.primary,
                          backgroundColor: colors.primarySurface,
                        },
                        !item.inStock && { opacity: 0.5 },
                      ]}
                    >
                      <AppText
                        variant="bodyStrong"
                        color={active ? colors.primary : colors.textPrimary}
                      >
                        {item.variantName}
                      </AppText>
                      <AppText variant="caption" color={colors.textSecondary}>
                        {formatPaise(item.pricePaise)}
                      </AppText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {outOfStock && (
            <Card
              style={{
                marginTop: spacing.lg,
                backgroundColor: colors.primarySurface,
              }}
            >
              <AppText variant="h3">Out of stock</AppText>
              <AppText
                variant="body"
                color={colors.textSecondary}
                style={{ marginTop: spacing.xs }}
              >
                We’ve run out of this item. Please check back in some time.
              </AppText>
              <Button
                label={notifyRequested ? "We’ll notify you" : "Notify me"}
                variant="secondary"
                disabled={notifyRequested}
                onPress={() => void requestNotify()}
                style={{ marginTop: spacing.base }}
              />
            </Card>
          )}

          {detail.description && (
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="h3">About this product</AppText>
              <AppText
                variant="body"
                color={colors.textSecondary}
                style={{ marginTop: spacing.xs }}
              >
                {detail.description}
              </AppText>
            </View>
          )}

          {/* Vertical-specific attributes: shelf life, storage, origin for
              grocery; the same slot carries prescription flags at V4. */}
          {Object.keys(detail.attributes).length > 0 && (
            <Card style={{ marginTop: spacing.lg }}>
              {Object.entries(detail.attributes).map(([key, value]) => (
                <View key={key} style={styles.attributeRow}>
                  <AppText variant="body" color={colors.textSecondary}>
                    {key
                      .replace(/([A-Z])/g, " $1")
                      .replace(/^./, (c) => c.toUpperCase())}
                  </AppText>
                  <AppText variant="body">{String(value)}</AppText>
                </View>
              ))}
            </Card>
          )}

          {(related.data?.length ?? 0) > 0 && (
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="h3">You may also like</AppText>

              {/* A responsive wrapping grid (same card, same component —
                  see CategoriesScreen/SearchScreen for the identical
                  pattern), not a single horizontal row: card 1/card 2 side
                  by side, card 3/card 4 below with real row spacing, same
                  as everywhere else products are browsed. A plain
                  `flexWrap` grid, not FlatList — this is already inside the
                  screen's own ScrollView, and nesting a VirtualizedList
                  inside another ScrollView prints RN's "VirtualizedLists
                  should never be nested" warning for no benefit at this
                  size (a handful of related items, not a long list). */}
              <View style={styles.relatedGrid}>
                {(related.data ?? []).map((item) => (
                  <View
                    key={item.id}
                    style={[styles.relatedCell, { width: `${100 / relatedColumns}%` }]}
                  >
                    <ProductCard
                      product={item}
                      qtyInCart={
                        item.defaultVariant
                          ? cart.qtyFor(item.defaultVariant.id)
                          : 0
                      }
                      busy={
                        item.defaultVariant
                          ? cart.isBusy(item.defaultVariant.id)
                          : false
                      }
                      onPress={onOpenProduct}
                      onAdd={cart.add}
                      onIncrement={cart.increment}
                      onDecrement={cart.decrement}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Replaces the bottom tab bar on this screen (see MainTabs — the tab
          bar hides itself whenever "ProductDetail" is the focused nested
          route), so "Go to Cart" is the only way back to the cart from
          here — it has to stay visible next to Add/the stepper no matter
          what state the item is in.

          `onLayout` reports this footer's REAL height into
          `productDetailFooterHeight` (tabBarVisibility.ts) — the global
          mini-cart overlay (MiniCartBar.tsx) rests directly above whatever
          that measures, instead of guessing a fixed value that could drift
          out of sync (e.g. once the error NoticeStrip above makes the
          footer taller). */}
      <View
        style={[styles.footer, { paddingBottom: insets.bottom + spacing.base }]}
        onLayout={(event) => {
          productDetailFooterHeight.value = event.nativeEvent.layout.height;
        }}
      >
        {cart.error && <NoticeStrip message={cart.error} />}

        <View style={styles.footerRow}>
          {/* Same width as the Cart button on the right, in every state —
              ActionBarTransition (native-driven fade+scale) handles making
              the Add-button-to-stepper swap itself feel smooth; the row
              layout around it never changes size. */}
          <View style={styles.footerActionFlex}>
            <ActionBarTransition
              mode={
                outOfStock || !variant
                  ? "outOfStock"
                  : qtyInCart > 0
                    ? "stepper"
                    : "add"
              }
            >
              {variant && !outOfStock ? (
                qtyInCart > 0 ? (
                  <View style={styles.footerStepperFlex}>
                    <QuantityStepper
                      qty={qtyInCart}
                      max={variant.maxQtyPerOrder}
                      busy={cart.isBusy(variant.id)}
                      onIncrement={() => {
                        flyToCart(flightImageUrl);
                        cart.increment(variant.id);
                      }}
                      onDecrement={() => {
                        // Only the tap about to empty the line plays the
                        // "leaving the cart" flight — matches ProductCard's
                        // own stepper exactly.
                        if (qtyInCart === 1) {
                          flyFromCart(flightImageUrl);
                        }
                        cart.decrement(variant.id);
                      }}
                      fullWidth
                      flatButtons
                    />
                  </View>
                ) : (
                  <Button
                    label="Add to Cart"
                    onPress={() => {
                      flyToCart(flightImageUrl);
                      cart.add(variant.id, snapshotFromProduct(detail, variant));
                    }}
                    style={styles.footerAddButton}
                  />
                )
              ) : (
                <View style={styles.footerUnavailable}>
                  <AppText variant="bodyStrong" color={colors.textSecondary}>
                    Currently unavailable
                  </AppText>
                </View>
              )}
            </ActionBarTransition>
          </View>

          <Pressable
            onPress={onGoToCart}
            style={styles.goToCartButton}
            accessibilityRole="button"
            accessibilityLabel="Go to cart"
          >
            <Ionicons name="cart" size={19} color={colors.onPrimary} />
            <AppText variant="bodyStrong" color={colors.onPrimary}>
              Cart
            </AppText>
            {cartItemCount > 0 && (
              <View style={styles.goToCartBadge}>
                <AppText
                  variant="overline"
                  color={colors.primary}
                  style={styles.goToCartBadgeText}
                >
                  {cartItemCount > 99 ? "99+" : cartItemCount}
                </AppText>
              </View>
            )}
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: "center" },
  // "You may also like" — same responsive wrapping-grid pattern as
  // CategoriesScreen/SearchScreen. Bigger vertical than horizontal padding
  // for real breathing room BETWEEN ROWS specifically.
  relatedGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -spacing.xs,
    marginTop: spacing.xs,
  },
  relatedCell: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: spacing.md,
  },
  discountTag: {
    backgroundColor: colors.discountBadge,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  variantRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  variantChip: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 88,
  },
  attributeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.base,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // Same flex:1 on this AND goToCartButton below — equal width in every
  // state (before and after Add is tapped), never a size change.
  footerActionFlex: { flex: 1 },
  footerStepperFlex: { flex: 1 },
  footerAddButton: { flex: 1 },
  footerUnavailable: {
    flex: 1,
    height: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  goToCartButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    height: layout.minTouchTarget,
    paddingHorizontal: spacing.base,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  goToCartBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.circle,
    backgroundColor: colors.onPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  goToCartBadgeText: {
    color: colors.primary,
    fontWeight: "700",
  },
});

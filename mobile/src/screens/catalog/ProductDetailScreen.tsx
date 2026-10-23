/**
 * Product detail + out-of-stock state (Task 14.8).
 *
 * Variants are selectable rather than collapsed into one price: the cart
 * treats each variant as a separate line, so the customer must be able to see
 * and choose which size they are buying.
 *
 * A product with several sizes / options has NO size preselected: Add stays
 * "Select a size" until the customer taps an in-stock one (a sold-out size is
 * shown but cannot be chosen). Until then the price reads "From …" — the
 * lowest in-stock size. A simple item works exactly as before.
 */

import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import type { ProductSummaryDto, VariantDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, layout, radius, spacing } from "@shared/theme";
import { api, resolveImageUrl } from "@/lib/api";
import { requireAuth } from "@/lib/authGate";
import { useProduct } from "@/lib/queries";
import { snapshotFromProduct, useCartActions } from "@/lib/useCartActions";
import { flyToCart } from "@/lib/flyToCart";
import { quantityLimitOf } from "@/lib/quantityLimit";
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
}: {
  productId: string;
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const product = useProduct(productId);
  const cart = useCartActions();
  const relatedColumns = useGridColumns();
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );
  const [notifyRequested, setNotifyRequested] = useState(false);

  // The exact element `flyToCart` measures on Add/+ below — see
  // ProductGallery's own comment for exactly what this points at (whichever
  // slide is currently visible).
  const galleryRef = useRef<View>(null);

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
  const allVariants = product.data?.variants ?? [];
  const needsChoice = allVariants.length > 1;
  // What Add / the stepper act on: the only variant, or the size the customer chose.
  const chosen: VariantDto | undefined = needsChoice
    ? allVariants.find((item) => item.id === selectedVariantId && item.inStock)
    : allVariants[0];
  const inStockVariants = allVariants.filter((item) => item.inStock);
  // What the price shows before a choice: the cheapest size that can be bought.
  const cheapest = inStockVariants.reduce<VariantDto | undefined>((low, item) => (!low || item.pricePaise < low.pricePaise ? item : low), undefined);
  const variant: VariantDto | undefined = chosen ?? cheapest ?? allVariants[0];
  const fromPrice = needsChoice && !chosen && new Set(inStockVariants.map((item) => item.pricePaise)).size > 1;
  const qtyInCart = chosen ? cart.qtyFor(chosen.id) : 0;

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
  // The product (not just one size) cannot be bought right now.
  const outOfStock = inStockVariants.length === 0;
  const optionWord =
    (detail.optionGroups ?? []).length === 1 ? detail.optionGroups[0]!.name.toLowerCase() : (detail.optionGroups ?? []).length > 1 ? 'option' : 'size';
  // Same "small square thumbnail drops into the cart" flourish the card's
  // own Add/stepper already has (see ProductCard.tsx) — lands on the global
  // mini-cart overlay (MiniCartBar.tsx), which is what registers the actual
  // landing target on this screen now (it renders here too — see
  // `useMiniCartScreen`'s "productDetail" case).
  const flightImageUrl = resolveImageUrl(variant?.imageUrl ?? detail.imageUrl);

  function requestNotify(): void {
    if (!variant) return;
    const variantId = variant.id;
    // The alert goes to an account: a guest logs in first, then it is set.
    requireAuth("notify-me", () => {
      // Best-effort: failing to register a back-in-stock alert is not worth an
      // error screen, and the optimistic state is honest either way.
      void api
        .post(`/products/${variantId}/notify-me`)
        .catch(() => undefined)
        .then(() => setNotifyRequested(true));
    });
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
          // Clears the footer, PLUS the global mini-cart overlay that may
          // float above it (same 76px allowance HomeScreen uses for the
          // identical pill) — reserved UNCONDITIONALLY from the very first
          // render rather than toggled on `cartItemCount > 0`. The cart
          // query (useCartActions) resolves independently of this screen's
          // own `product.isLoading` gate, so toggling this padding once it
          // settles changed the ScrollView's content-container size after
          // first paint — see HomeScreen's identical fix for why that's
          // exactly what caused the intermittent first-scroll jump/blink.
          paddingBottom: 140 + 76,
        }}
      >
        <ProductGallery
          ref={galleryRef}
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
                {fromPrice ? `From ${formatPaise(variant.pricePaise)}` : formatPaise(variant.pricePaise)}
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
              <AppText variant="h3">
                {/* Generic option groups (Size, Portion, Color…): name the one group; "Select option" for several. */}
                {(detail.optionGroups ?? []).length === 1
                  ? `Select ${detail.optionGroups[0]!.name.toLowerCase()}`
                  : (detail.optionGroups ?? []).length > 1
                    ? 'Select option'
                    : 'Select size'}
              </AppText>
              <View style={styles.variantRow}>
                {detail.variants.map((item) => {
                  const active = item.id === chosen?.id;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => setSelectedVariantId(item.id)}
                      // A sold-out size stays visible but cannot be chosen.
                      disabled={!item.inStock}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled: !item.inStock }}
                      accessibilityLabel={`${item.variantName}, ${item.inStock ? formatPaise(item.pricePaise) : 'sold out'}`}
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
                        style={!item.inStock ? { textDecorationLine: "line-through" } : undefined}
                      >
                        {item.variantName}
                      </AppText>
                      <AppText variant="caption" color={colors.textSecondary}>
                        {item.inStock ? formatPaise(item.pricePaise) : "Sold out"}
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
                onPress={requestNotify}
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
                      qtyInCart={cart.qtyForCard(item)}
                      cartVariantId={cart.cartVariantForCard(item)}
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
          {/* LEFT — price, discount and the unit/weight this price is for.
              No separate "Go to Cart" button anymore: the global MiniCartBar
              overlay (see the file header) already covers that job on this
              screen, so this footer is free to spend its whole width on
              price info + the Add/stepper control instead of splitting it
              three ways. */}
          {variant && (
            <View style={styles.footerPriceBlock}>
              <View style={styles.footerPriceLine}>
                <AppText variant="h2" numberOfLines={1}>
                  {fromPrice ? `From ${formatPaise(variant.pricePaise)}` : formatPaise(variant.pricePaise)}
                </AppText>
                {variant.mrpPaise > variant.pricePaise && (
                  <AppText
                    variant="caption"
                    color={colors.textMuted}
                    numberOfLines={1}
                    style={styles.footerMrp}
                  >
                    {formatPaise(variant.mrpPaise)}
                  </AppText>
                )}
              </View>

              <View style={styles.footerPriceLine}>
                {variant.discountPercent > 0 && (
                  <AppText
                    variant="caption"
                    color={colors.discountBadgeText}
                    style={styles.footerDiscount}
                  >
                    {variant.discountPercent}% OFF
                  </AppText>
                )}
                <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                  {needsChoice && !chosen ? `Select a ${optionWord}` : variant.variantName}
                </AppText>
              </View>
            </View>
          )}

          {/* RIGHT — Add / the stepper it becomes once qty > 0. Fixed-width
              box (not flex:1 anymore — there's no "Cart" button on this row
              to match widths with) so the rectangular shape never resizes
              between the two states, just like ProductCard's own floating
              overlay. */}
          <View style={styles.footerActionBox}>
            <ActionBarTransition
              mode={
                outOfStock || !chosen
                  ? "outOfStock"
                  : qtyInCart > 0
                    ? "stepper"
                    : "add"
              }
            >
              {chosen && !outOfStock ? (
                qtyInCart > 0 ? (
                  <QuantityStepper
                    qty={qtyInCart}
                    max={quantityLimitOf(chosen).max}
                    busy={cart.isBusy(chosen.id)}
                    onIncrement={() => {
                      // Only an accepted step flies into the cart.
                      if (cart.increment(chosen.id)) flyToCart(flightImageUrl, chosen.id);
                    }}
                    onDecrement={() => {
                      // No "leaving the cart" flight here — matches
                      // ProductCard's own stepper: MiniCartBar's real
                      // thumbnail already plays a correctly position-aware
                      // exit on its own, see its comment for why a second,
                      // generic flying dot only duplicated that.
                      cart.decrement(chosen.id);
                    }}
                    fullWidth
                    style={styles.footerRectShape}
                  />
                ) : (
                  <Button
                    label="Add to Cart"
                    onPress={() => {
                      if (cart.add(chosen.id, snapshotFromProduct(detail, chosen))) flyToCart(flightImageUrl, chosen.id);
                    }}
                    style={[styles.footerAddButton, styles.footerRectShape]}
                  />
                )
              ) : (
                <View style={styles.footerUnavailable}>
                  <AppText variant="bodyStrong" color={colors.textSecondary}>
                    {!outOfStock && needsChoice && !chosen ? `Select a ${optionWord}` : "Currently unavailable"}
                  </AppText>
                </View>
              )}
            </ActionBarTransition>
          </View>
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
  footerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },

  // LEFT — price / discount / unit. Takes whatever width the fixed-width
  // action box on the right doesn't need.
  footerPriceBlock: { flex: 1 },
  footerPriceLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  footerMrp: { textDecorationLine: "line-through" },
  footerDiscount: { fontWeight: "700" },

  // RIGHT — Add / the stepper it becomes. A fixed width (not flex:1 — there
  // is no longer a "Cart" button on this row to match widths with) so the
  // rectangular shape never resizes between the two states.
  footerActionBox: { width: 150 },
  footerAddButton: { width: "100%" },
  // Overrides Button's/QuantityStepper's own default PILL corners — see
  // ProductCard.tsx's identical `floatingStepperShape` for the card's own
  // version of this same rectangular look.
  footerRectShape: { borderRadius: radius.md },
  footerUnavailable: {
    width: "100%",
    height: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
});

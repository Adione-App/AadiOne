/**
 * Product detail + out-of-stock state (Task 14.8).
 *
 * Sizes follow the one customer rule (lib/cardVariant.ts), on the sizes a
 * customer can buy right now — never on every size the product has:
 *
 *   - two or more can be bought: "Select <weight>" with only those sizes,
 *     nothing preselected; Add stays "Select a size" until the customer taps
 *     one, and the price reads "From …" (the lowest) until then;
 *   - exactly one: it IS the product — no selector, no choice to make; the
 *     size shows as ordinary product information and Add adds that exact
 *     size, the same flow (and cart flight) as a simple item;
 *   - none: no selector; Add is disabled with the unavailable state.
 *
 * It follows availability as it changes (hidden, sold out, back in stock):
 * the page re-reads the product whenever it opens, and on the app's
 * availability refreshes. Who sells the product and its SKU are not shown.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, type ViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import type { ProductSummaryDto, VariantDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, layout, radius, spacing } from "@shared/theme";
import { api, resolveImageUrl } from "@/lib/api";
import { requireAuth } from "@/lib/authGate";
import { useProduct } from "@/lib/queries";
import { pageVariantsOf, storeClosedHint } from "@/lib/cardVariant";
import { shownStoreClosedHint } from "@/lib/closureDisplay";
import { useGlobalClosedNotice } from "@/lib/globalOrdering";
import { snapshotFromProduct, useCartActions } from "@/lib/useCartActions";
import { flyToCart } from "@/lib/flyToCart";
import { addAndFly, incrementAndFly } from "@/lib/addToCartFlow";
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
import { ProductGridSkeleton } from "@/components/ProductCardSkeleton";

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
  // Re-read on every visit: a size hidden, sold out or restored since the
  // last one changes what this page offers (the cached copy shows meanwhile).
  const product = useProduct(productId, { refetchOnMount: "always" });
  const cart = useCartActions();
  const globalClosed = useGlobalClosedNotice() !== null;
  const relatedColumns = useGridColumns();
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );
  const [notifyRequested, setNotifyRequested] = useState(false);

  // The exact element `flyToCart` measures on Add/+ below — see
  // ProductGallery's own comment for exactly what this points at (whichever
  // slide is currently visible).
  const galleryRef = useRef<ViewInstance>(null);

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
  // Each size as THIS customer sees it: units their own unpaid checkout
  // holds count as theirs (lib/ownHolds.ts); the catalogue answer otherwise.
  // The sizes that can be bought now (lib/cardVariant.ts) — the same rule as
  // every product card: only these are offered, and their number decides
  // whether the customer has a choice to make at all.
  const sizes = useMemo(
    () => pageVariantsOf(product.data ?? { defaultVariant: null, variantCount: 0, variants: [] }, cart.withOwnHold),
    [product.data, cart.withOwnHold],
  );
  const { visible: allVariants, purchasable } = sizes;
  const needsChoice = sizes.mode === "choose";
  // What Add / the stepper act on: the one buyable size, or the size the
  // customer chose among several (nothing until they choose).
  const chosen: VariantDto | undefined = needsChoice
    ? purchasable.find((item) => item.id === selectedVariantId)
    : purchasable[0];
  // A chosen size that stopped being buyable is dropped, never swapped.
  useEffect(() => {
    if (selectedVariantId && !purchasable.some((item) => item.id === selectedVariantId)) setSelectedVariantId(null);
  }, [purchasable, selectedVariantId]);
  // What the price shows before a choice: the cheapest size that can be bought.
  const cheapest = purchasable.reduce<VariantDto | undefined>((low, item) => (!low || item.pricePaise < low.pricePaise ? item : low), undefined);
  // Nothing can be bought: the server's own pick, for the unavailable state.
  const fallback = allVariants.find((item) => item.id === product.data?.defaultVariant?.id) ?? allVariants[0];
  const variant: VariantDto | undefined = chosen ?? cheapest ?? fallback;
  const fromPrice = needsChoice && !chosen && new Set(purchasable.map((item) => item.pricePaise)).size > 1;
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
  // Nothing can be bought because its store is not taking orders (when it
  // opens again, without naming the store), or because nothing is in stock.
  // While the whole app is closed, not even when the store opens.
  const closedHint = shownStoreClosedHint(storeClosedHint(allVariants), globalClosed);
  const storeClosed = closedHint !== null;
  const outOfStock = purchasable.length === 0 && !storeClosed;
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
          // `insets.bottom`: the footer grows by the Android navigation
          // bar's height (it pads itself by it), so the content clears it too.
          paddingBottom: 140 + 76 + insets.bottom,
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

          {/* One size can be bought: it is simply part of the product. */}
          {chosen && !needsChoice ? (
            <AppText variant="bodyStrong" color={colors.textSecondary}>
              {chosen.variantName}
            </AppText>
          ) : null}

          <AppText variant="caption" color={colors.textSecondary}>
            MRP incl. of all taxes
          </AppText>

          {/* Not orderable right now because the store is closed — said
              before the Add button, never a surprise there. Who sells the
              product is not shown to customers. */}
          {storeClosed && (
            <View
              style={[styles.storeStatus, styles.storeStatusClosed]}
              accessibilityLabel={closedHint ? `Unavailable right now. ${closedHint}` : "Unavailable right now"}
            >
              <AppText variant="bodyStrong" color={colors.danger}>
                Unavailable right now
              </AppText>
              {closedHint ? (
                <AppText variant="caption" color={colors.textSecondary} style={{ marginTop: 2 }}>
                  {closedHint}
                </AppText>
              ) : null}
            </View>
          )}

          {/* A choice only when two or more sizes can be bought — and only those. */}
          {needsChoice && (
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
                {purchasable.map((item) => {
                  const active = item.id === chosen?.id;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => setSelectedVariantId(item.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`${item.variantName}, ${formatPaise(item.pricePaise)}`}
                      style={[
                        styles.variantChip,
                        active && {
                          borderColor: colors.primary,
                          backgroundColor: colors.primarySurface,
                        },
                      ]}
                    >
                      <AppText variant="bodyStrong" color={active ? colors.primary : colors.textPrimary}>
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

          {/* Still loading: one row of the shared product-card skeleton
              under the real heading (never an empty gap that later jumps). */}
          {related.isPending && (
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="h3">You may also like</AppText>
              <ProductGridSkeleton columns={relatedColumns} count={relatedColumns} style={styles.relatedSkeleton} />
            </View>
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
                      withOwnHold={cart.withOwnHold}
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
              {/* Row 1: the selling price, then MRP and discount beside it.
                  The price never shrinks; MRP / discount give way first. */}
              <View style={styles.footerPriceLine}>
                <AppText variant="h2" numberOfLines={1} style={styles.footerPrice}>
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
                {variant.discountPercent > 0 && (
                  <AppText
                    variant="caption"
                    color={colors.discountBadgeText}
                    numberOfLines={1}
                    style={styles.footerDiscount}
                  >
                    {variant.discountPercent}% OFF
                  </AppText>
                )}
              </View>

              {/* Row 2: the weight / size alone, directly under the price. */}
              <AppText variant="caption" color={colors.textSecondary} numberOfLines={1} style={styles.footerUnit}>
                {needsChoice && !chosen ? `Select a ${optionWord}` : variant.variantName}
              </AppText>
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
                outOfStock || !chosen || storeClosed
                  ? "outOfStock"
                  : qtyInCart > 0
                    ? "stepper"
                    : "add"
              }
            >
              {chosen && !outOfStock && !storeClosed ? (
                qtyInCart > 0 ? (
                  <QuantityStepper
                    qty={qtyInCart}
                    max={quantityLimitOf(chosen).max}
                    busy={cart.isBusy(chosen.id)}
                    onIncrement={() => {
                      // Only an accepted step flies into the cart (lib/addToCartFlow.ts).
                      incrementAndFly(cart.increment, flyToCart, chosen.id, flightImageUrl);
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
                      addAndFly(cart.add, flyToCart, chosen.id, snapshotFromProduct(detail, chosen), flightImageUrl);
                    }}
                    style={[styles.footerAddButton, styles.footerRectShape]}
                  />
                )
              ) : (
                <View style={styles.footerUnavailable}>
                  <AppText variant="bodyStrong" color={colors.textSecondary}>
                    {storeClosed
                      ? "Unavailable"
                      : !outOfStock && needsChoice && !chosen
                        ? `Select a ${optionWord}`
                        : "Currently unavailable"}
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
  // The skeleton grid sits exactly where `relatedGrid` will (its cells pad like `relatedCell`).
  relatedSkeleton: {
    padding: 0,
    marginHorizontal: -spacing.xs,
    marginTop: spacing.xs,
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
  // `minWidth: 0` lets the block shrink beside the fixed action box instead
  // of pushing it off a narrow screen; its lines then truncate.
  footerPriceBlock: { flex: 1, minWidth: 0, justifyContent: "center" },
  // Baseline: the small MRP / discount sit on the big price's text line.
  footerPriceLine: { flexDirection: "row", alignItems: "baseline", gap: spacing.xs },
  footerPrice: { flexShrink: 0 },
  footerMrp: { textDecorationLine: "line-through", flexShrink: 1 },
  footerDiscount: { fontWeight: "700", flexShrink: 1 },
  footerUnit: { marginTop: 2 },

  // RIGHT — Add / the stepper it becomes. A fixed width (not flex:1 — there
  // is no longer a "Cart" button on this row to match widths with) so the
  // rectangular shape never resizes between the two states.
  footerActionBox: { width: 150 },
  footerAddButton: { width: "100%" },
  storeStatus: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  storeStatusClosed: { borderColor: colors.danger, backgroundColor: colors.surface },
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

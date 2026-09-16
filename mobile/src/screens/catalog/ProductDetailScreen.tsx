/**
 * Product detail + out-of-stock state (Task 14.8).
 *
 * Variants are selectable rather than collapsed into one price: the cart
 * treats each variant as a separate line, so the customer must be able to see
 * and choose which size they are buying.
 */

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { ProductSummaryDto, VariantDto } from '@shared';
import { formatPaise } from '@shared/money';
import { colors, radius, spacing } from '@shared/theme';
import { api } from '@/lib/api';
import { useProduct } from '@/lib/queries';
import { useCartActions } from '@/lib/useCartActions';
import {
  AppText,
  Button,
  Card,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
} from '@/components/ui';
import { ProductCard, QuantityStepper } from '@/components/ProductCard';
import ProductGallery from '@/components/ProductGallery';

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
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [notifyRequested, setNotifyRequested] = useState(false);

  const related = useQuery({
    queryKey: ['related', productId],
    queryFn: () => api.get<ProductSummaryDto[]>(`/products/${productId}/related`),
    enabled: product.isSuccess,
  });

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
  const variant: VariantDto | undefined =
    detail.variants.find((item) => item.id === selectedVariantId) ??
    detail.variants.find((item) => item.inStock) ??
    detail.variants[0];

  const qtyInCart = variant ? cart.qtyFor(variant.id) : 0;
  const outOfStock = !variant?.inStock;

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

      <ScrollView contentContainerStyle={{ paddingBottom: 140 }}>
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
                    style={{ textDecorationLine: 'line-through' }}
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
                        active && { borderColor: colors.primary, backgroundColor: colors.primarySurface },
                        !item.inStock && { opacity: 0.5 },
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
            <Card style={{ marginTop: spacing.lg, backgroundColor: colors.primarySurface }}>
              <AppText variant="h3">Out of stock</AppText>
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
                We’ve run out of this item. Please check back in some time.
              </AppText>
              <Button
                label={notifyRequested ? 'We’ll notify you' : 'Notify me'}
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
              <AppText variant="body" color={colors.textSecondary} style={{ marginTop: spacing.xs }}>
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
                    {key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
                  </AppText>
                  <AppText variant="body">{String(value)}</AppText>
                </View>
              ))}
            </Card>
          )}

          {(related.data?.length ?? 0) > 0 && (
            <View style={{ marginTop: spacing.lg }}>
              <AppText variant="h3">You may also like</AppText>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {(related.data ?? []).map((item) => (
                  <View key={item.id} style={{ width: 160 }}>
                    <ProductCard
                      product={item}
                      qtyInCart={item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0}
                      busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
                      onPress={() => onOpenProduct(item.id)}
                      onAdd={() => item.defaultVariant && void cart.add(item.defaultVariant.id)}
                      onIncrement={() =>
                        item.defaultVariant && void cart.increment(item.defaultVariant.id)
                      }
                      onDecrement={() =>
                        item.defaultVariant && void cart.decrement(item.defaultVariant.id)
                      }
                    />
                  </View>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.base }]}>
        {cart.error && <NoticeStrip message={cart.error} />}
        {variant && !outOfStock ? (
          qtyInCart > 0 ? (
            <View style={styles.footerRow}>
              <QuantityStepper
                qty={qtyInCart}
                max={variant.maxQtyPerOrder}
                busy={cart.isBusy(variant.id)}
                onIncrement={() => void cart.increment(variant.id)}
                onDecrement={() => void cart.decrement(variant.id)}
              />
              <AppText variant="bodyStrong" color={colors.primary}>
                {formatPaise(variant.pricePaise * qtyInCart)} in cart
              </AppText>
            </View>
          ) : (
            <Button label="Add to Cart" onPress={() => void cart.add(variant.id)} />
          )
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surface,
  },
  back: { width: 40, height: 40, justifyContent: 'center' },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  discountTag: {
    backgroundColor: colors.discountBadge,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  variantRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  variantChip: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 88,
  },
  attributeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.base,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

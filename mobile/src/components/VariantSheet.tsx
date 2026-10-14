/**
 * The variant sheet: picking a size / color / pack size from a product card
 * without leaving the screen. Opened through `useVariantSheet` (lib/
 * variantSheet.ts) by any ProductCard whose product has several variants;
 * mounted once in App.tsx.
 *
 *   - Built from the product's real data (GET /products/:id — the same
 *     cached query the product page uses): its option groups and variants,
 *     via lib/variantSelection.ts. Nothing is preselected unless a group has
 *     one possible value; sold-out values are disabled; a combination that
 *     does not exist can never be chosen.
 *   - Price, image, discount and stock follow the chosen variant ("From …"
 *     the cheapest in-stock one until then).
 *   - Add puts EXACTLY the chosen variant in the cart through the shared
 *     cart actions (server-checked price and stock, the same optimistic
 *     quantities as everywhere else); after that the button becomes the
 *     shared quantity control for that variant. The sheet stays open, so a
 *     second size can be added too; it closes with ✕, a tap outside, or back.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { ChevronRight, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProductSummaryDto, VariantDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { resolveImageUrl } from "@/lib/api";
import { useProduct } from "@/lib/queries";
import { snapshotFromProduct, useCartActions } from "@/lib/useCartActions";
import { useVariantSheet } from "@/lib/variantSheet";
import { quantityLimitOf } from "@/lib/quantityLimit";
import {
  choiceState,
  initialSelection,
  missingGroup,
  pick,
  selectedVariant,
  variantOptions,
  type Selection,
} from "@/lib/variantSelection";
import { QuantityStepper } from "@/components/ProductCard";
import { AppText, Button, NoticeStrip } from "@/components/ui";
import { CartNoticeToast } from "@/components/CartNoticeToast";

const OPEN_MS = 240;
const CLOSE_MS = 180;
/** Height of the footer control — the Add button and the quantity control alike, so swapping them never shifts the sheet. */
const ACTION_HEIGHT = 48;

/** Mounted once (App.tsx). Keeps the last product on screen while the sheet slides away. */
export function VariantSheetHost() {
  const product = useVariantSheet((state) => state.product);
  const onViewDetails = useVariantSheet((state) => state.onViewDetails);
  const close = useVariantSheet((state) => state.close);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<{ product: ProductSummaryDto; onViewDetails: (() => void) | null } | null>(null);

  // Whether the modal is on screen — then an open must animate here, as `onShow` will not fire again.
  const visibleRef = useRef(false);
  visibleRef.current = shown !== null;

  useEffect(() => {
    if (product) {
      if (visibleRef.current) {
        Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      }
      setShown({ product, onViewDetails });
      return;
    }
    // Closed from the store: slide out, then unmount.
    Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) setShown(null);
      },
    );
  }, [product, onViewDetails, progress]);

  if (!shown) return null;

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] });

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
      // Starts once the modal is on screen, so the slide is never skipped.
      onShow={() =>
        Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()
      }
    >
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { maxHeight: height * 0.85, paddingBottom: insets.bottom + spacing.base, transform: [{ translateY }] },
          ]}
        >
          <SheetContent
            key={shown.product.id}
            product={shown.product}
            onClose={close}
            onViewDetails={() => {
              const open = shown.onViewDetails;
              close();
              open?.();
            }}
          />
        </Animated.View>

        {/* The sheet is its own window: cart popups (e.g. a limit reached) must show above it too. */}
        <CartNoticeToast />
      </View>
    </Modal>
  );
}

function SheetContent({
  product,
  onClose,
  onViewDetails,
}: {
  product: ProductSummaryDto;
  onClose: () => void;
  onViewDetails: () => void;
}) {
  const detail = useProduct(product.id);
  const cart = useCartActions();
  const data = detail.data;
  const variants = useMemo(() => data?.variants ?? [], [data]);
  const options = useMemo(() => (data ? variantOptions(data) : null), [data]);
  const [selection, setSelection] = useState<Selection | null>(null);

  // The starting picks, once the product's options are known.
  useEffect(() => {
    if (options && selection === null) setSelection(initialSelection(options, variants));
  }, [options, variants, selection]);

  const picks = selection ?? {};
  const chosen = options ? selectedVariant(options, variants, picks) : undefined;
  const inStock = variants.filter((variant) => variant.inStock);
  const cheapest = inStock.reduce<VariantDto | undefined>((low, item) => (!low || item.pricePaise < low.pricePaise ? item : low), undefined);
  // Before a choice: the cheapest size that can be bought ("From …" when sizes differ in price).
  const shownVariant = chosen ?? cheapest ?? product.defaultVariant ?? undefined;
  const fromPrice = !chosen && new Set(inStock.map((item) => item.pricePaise)).size > 1;
  const image = resolveImageUrl(chosen?.imageUrl ?? data?.images[0]?.thumbUrl ?? product.thumbUrl);
  const qty = chosen ? cart.qtyFor(chosen.id) : 0;
  const busy = chosen ? cart.isBusy(chosen.id) : false;

  return (
    <>
      <View style={styles.handle} />

      {/* Product */}
      <View style={styles.header}>
        <View style={styles.thumb}>
          {image ? <Image source={{ uri: image }} style={styles.thumbImage} contentFit="contain" transition={120} cachePolicy="memory-disk" /> : null}
        </View>
        <View style={styles.headerText}>
          <AppText variant="bodyStrong" numberOfLines={2}>
            {product.name}
          </AppText>
          {shownVariant ? (
            <View style={styles.priceRow}>
              <AppText variant="price">
                {fromPrice ? `From ${formatPaise(shownVariant.pricePaise)}` : formatPaise(shownVariant.pricePaise)}
              </AppText>
              {!fromPrice && shownVariant.mrpPaise > shownVariant.pricePaise ? (
                <>
                  <AppText variant="caption" color={colors.textMuted} style={styles.mrp}>
                    {formatPaise(shownVariant.mrpPaise)}
                  </AppText>
                  {shownVariant.discountPercent > 0 ? (
                    <View style={styles.discount}>
                      <AppText variant="overline" color={colors.discountBadgeText}>
                        {shownVariant.discountPercent}% OFF
                      </AppText>
                    </View>
                  ) : null}
                </>
              ) : null}
            </View>
          ) : null}
          <Pressable onPress={onViewDetails} hitSlop={8} style={styles.viewDetails} accessibilityRole="link" accessibilityLabel={`View details of ${product.name}`}>
            <AppText variant="caption" color={colors.primary} style={styles.viewDetailsText}>
              View Details
            </AppText>
            <ChevronRight size={14} color={colors.primary} strokeWidth={2.5} />
          </Pressable>
        </View>
        <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
          <X size={20} color={colors.textPrimary} strokeWidth={2.25} />
        </Pressable>
      </View>

      {/* Options */}
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false} bounces={false}>
        {detail.isLoading ? (
          <AppText variant="body" color={colors.textSecondary}>
            Loading options…
          </AppText>
        ) : detail.isError || !options ? (
          <View>
            <AppText variant="body" color={colors.textSecondary}>
              We could not load the options for this product.
            </AppText>
            <Button label="Try again" variant="secondary" onPress={() => void detail.refetch()} style={{ marginTop: spacing.md }} />
          </View>
        ) : (
          options.groups.map((group) => (
            <View key={group.name} style={styles.group}>
              <AppText variant="bodyStrong">
                {group.name}
                {picks[group.name] !== undefined ? (
                  <AppText variant="body" color={colors.textSecondary}>
                    {`: ${group.choices.find((choice) => choice.key === picks[group.name])?.label ?? ""}`}
                  </AppText>
                ) : null}
              </AppText>
              <View style={styles.chips}>
                {group.choices.map((choice) => {
                  const state = choiceState(options, variants, picks, group.name, choice.key);
                  const active = picks[group.name] === choice.key;
                  // By-variant choices are whole variants: show each one's own price.
                  const variant = options.byVariant ? variants.find((item) => item.id === choice.key) : undefined;
                  return (
                    <Pressable
                      key={choice.key}
                      disabled={state === "soldOut"}
                      onPress={() => setSelection(pick(options, variants, picks, group.name, choice.key))}
                      style={({ pressed }) => [
                        styles.chip,
                        active && styles.chipActive,
                        state === "conflict" && !active && styles.chipConflict,
                        state === "soldOut" && styles.chipSoldOut,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled: state === "soldOut" }}
                      accessibilityLabel={`${group.name} ${choice.label}${state === "soldOut" ? ", sold out" : ""}`}
                    >
                      <AppText
                        variant="bodyStrong"
                        color={active ? colors.primary : state === "available" ? colors.textPrimary : colors.textMuted}
                        style={state === "soldOut" ? styles.soldOutText : undefined}
                      >
                        {choice.label}
                      </AppText>
                      {variant ? (
                        <AppText variant="caption" color={colors.textSecondary}>
                          {variant.inStock ? formatPaise(variant.pricePaise) : "Sold out"}
                        </AppText>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}

        {chosen && chosen.inStock && chosen.availableQty > 0 && chosen.availableQty <= 5 ? (
          <AppText variant="caption" color={colors.warning}>
            Only {chosen.availableQty} left
          </AppText>
        ) : null}
        {chosen ? (
          <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
            SKU {chosen.sku}
          </AppText>
        ) : null}
      </ScrollView>

      {cart.error ? (
        <View style={styles.notice}>
          <NoticeStrip message={cart.error} />
        </View>
      ) : null}

      {/* Add / quantity */}
      <View style={styles.footer}>
        {!options || detail.isError ? (
          <Button label="Add to cart" onPress={() => undefined} disabled style={styles.action} />
        ) : inStock.length === 0 ? (
          <Button label="Sold out" onPress={() => undefined} disabled style={styles.action} />
        ) : !chosen ? (
          <Button
            label={`Select ${(missingGroup(options, picks) ?? "an option").toLowerCase()}`}
            onPress={() => undefined}
            disabled
            style={styles.action}
          />
        ) : !chosen.inStock ? (
          <Button label="Sold out" onPress={() => undefined} disabled style={styles.action} />
        ) : qty > 0 ? (
          <QuantityStepper
            qty={qty}
            max={quantityLimitOf(chosen).max}
            busy={busy}
            onIncrement={() => cart.increment(chosen.id)}
            onDecrement={() => cart.decrement(chosen.id)}
            fullWidth
            style={styles.action}
          />
        ) : (
          <Button
            label={`Add to cart · ${formatPaise(chosen.pricePaise)}`}
            onPress={() => {
              // A tap while this variant's previous change is still saving is ignored: never added twice.
              if (busy || !data) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
              cart.add(chosen.id, snapshotFromProduct(data, chosen));
            }}
            disabled={busy}
            style={styles.action}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(15, 23, 20, 0.45)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.base,
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    backgroundColor: colors.borderStrong,
  },
  header: {
    flexDirection: "row",
    gap: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.xs,
    backgroundColor: colors.surface,
  },
  thumbImage: { width: "100%", height: "100%" },
  headerText: { flex: 1, minWidth: 0 },
  priceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: spacing.sm,
    rowGap: 2,
    marginTop: 4,
  },
  mrp: { textDecorationLine: "line-through" },
  discount: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.discountBadge,
  },
  viewDetails: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 2,
    marginTop: 6,
  },
  viewDetailsText: { fontWeight: "700" },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceMuted,
  },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingVertical: spacing.md },
  group: { marginBottom: spacing.base },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    minWidth: 56,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySurface,
  },
  chipConflict: {
    borderStyle: "dashed",
  },
  chipSoldOut: {
    opacity: 0.45,
    backgroundColor: colors.surfaceMuted,
  },
  soldOutText: { textDecorationLine: "line-through" },
  pressed: { opacity: 0.7 },
  notice: { paddingBottom: spacing.sm },
  footer: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  action: {
    height: ACTION_HEIGHT,
    minHeight: ACTION_HEIGHT,
    borderRadius: radius.md,
  },
});

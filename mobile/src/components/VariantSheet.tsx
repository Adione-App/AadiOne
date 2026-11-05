/**
 * The variant sheet: picking a size / color / pack size from a product card
 * without leaving the screen. Opened through `useVariantSheet` (lib/
 * variantSheet.ts) by any ProductCard whose product has SEVERAL sizes a
 * customer can buy right now (lib/cardVariant.ts — one is added directly);
 * mounted once in App.tsx.
 *
 *   - Opens on the tap itself: an overlay in the app's own window (not a
 *     native Modal, whose slide waited for Android's `onShow`), sliding up as
 *     soon as its height is known, the backdrop fading with it.
 *   - Rendered at once from the data the card already has — the product's
 *     variants and option groups ride on every product list
 *     (ProductSummaryDto.variants) — or the product page's own copy when it
 *     is fresher. Opening sends no request at all (not the product, not the
 *     cart); the server re-checks the listing, price and stock at Add, and a
 *     refused Add refreshes the product lists (lib/useCartActions.ts).
 *   - Lists only the sizes that can be bought now (in stock, on sale, store
 *     taking orders); hidden, deleted and unreviewed ones never reach the app.
 *     Nothing is preselected unless a group has one possible value; a
 *     combination that does not exist can never be chosen.
 *   - Price, image, discount and stock follow the chosen variant ("From …"
 *     the cheapest until then).
 *   - Add puts EXACTLY the chosen variant in the cart through the shared
 *     cart actions (its own listing and price, re-checked by the server);
 *     after that the button becomes the shared quantity control for that
 *     variant. If the chosen size stops being available while the sheet is
 *     open, the pick is dropped and the customer is told — never swapped for
 *     another. The sheet stays open, so a second size can be added too; it
 *     closes with ✕, a tap outside, or back.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { ChevronRight, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ProductDetailDto, ProductSummaryDto, VariantDto } from "@shared";
import { formatPaise } from "@shared/money";
import { colors, radius, spacing } from "@shared/theme";
import { resolveImageUrl } from "@/lib/api";
import { useProduct } from "@/lib/queries";
import { snapshotFromProduct, useCartActions } from "@/lib/useCartActions";
import { markSheet, useVariantSheet } from "@/lib/variantSheet";
import { quantityLimitOf } from "@/lib/quantityLimit";
import { isPurchasable, storeClosedHint, visibleVariantsOf } from "@/lib/cardVariant";
import {
  choiceState,
  initialSelection,
  missingGroup,
  pick,
  selectedVariant,
  variantOptions,
  type Selection,
  type VariantOptions,
} from "@/lib/variantSelection";
import { QuantityStepper } from "@/components/ProductCard";
import { AppText, Button, NoticeStrip } from "@/components/ui";

const OPEN_MS = 220;
const CLOSE_MS = 180;
/** Height of the footer control — the Add button and the quantity control alike, so swapping them never shifts the sheet. */
const ACTION_HEIGHT = 48;

type Shown = { product: ProductSummaryDto; onViewDetails: (() => void) | null };

/** Mounted once (App.tsx). Keeps the last product on screen while the sheet slides away. */
export function VariantSheetHost() {
  const product = useVariantSheet((state) => state.product);
  const onViewDetails = useVariantSheet((state) => state.onViewDetails);
  const close = useVariantSheet((state) => state.close);
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<Shown | null>(null);
  // The sheet's own height: it slides exactly that far, so it is moving on
  // screen from the first frame (sliding a window's height would leave a
  // short sheet off screen for most of the animation).
  const [sheetHeight, setSheetHeight] = useState(0);
  const waitingForLayout = useRef(false);

  // What is on screen: the open product, or — while sliding away — the last one.
  const current: Shown | null = product ? { product, onViewDetails } : shown;
  if (product && (shown?.product !== product || shown.onViewDetails !== onViewDetails)) {
    // Taken in the same render the tap's state arrives in, not an effect later.
    setShown({ product, onViewDetails });
  }

  const slideIn = useCallback(() => {
    markSheet("animationStart");
    Animated.timing(progress, { toValue: 1, duration: OPEN_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) markSheet("fullyVisible");
      },
    );
  }, [progress]);

  useLayoutEffect(() => {
    if (product) {
      progress.stopAnimation();
      // Already measured (open, or sliding away): slide in now; a first
      // opening slides in once the sheet's height is known (onLayout, the
      // very next frame).
      if (sheetHeight > 0) slideIn();
      else waitingForLayout.current = true;
      return;
    }
    waitingForLayout.current = false;
    Animated.timing(progress, { toValue: 0, duration: CLOSE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) {
          setShown(null);
          setSheetHeight(0);
        }
      },
    );
    // `sheetHeight` is read, not reacted to: a height change must not restart the slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, progress, slideIn]);

  // Android back closes the sheet first (registered last, so asked first).
  useEffect(() => {
    if (!product) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [product, close]);

  const onSheetLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.height);
    if (next !== sheetHeight) setSheetHeight(next);
    if (waitingForLayout.current && next > 0) {
      waitingForLayout.current = false;
      slideIn();
    }
  };

  if (!current) return null;

  const travel = sheetHeight > 0 ? sheetHeight : windowHeight;
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={product ? "box-none" : "none"}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="Close" />
      </Animated.View>

      <Animated.View
        onLayout={onSheetLayout}
        testID="variant-sheet"
        accessibilityViewIsModal
        style={[
          styles.sheet,
          { maxHeight: windowHeight * 0.85, paddingBottom: insets.bottom + spacing.base, transform: [{ translateY }] },
        ]}
      >
        <SheetContent
          key={current.product.id}
          product={current.product}
          onClose={close}
          onViewDetails={() => {
            const open = current.onViewDetails;
            close();
            open?.();
          }}
        />
      </Animated.View>
    </View>
  );
}

/** The sheet's product data: the product page's when it is fresh, else the card's own — never a wait. */
function useSheetProduct(product: ProductSummaryDto): {
  source: ProductSummaryDto | ProductDetailDto | null;
  detail: ProductDetailDto | undefined;
  isError: boolean;
  refetch: () => void;
} {
  const cardHasVariants = (product.variants?.length ?? 0) > 0;
  // Reads the product page's cached copy; fetches only for a card from an
  // older server, which carries no variants.
  const query = useProduct(product.id, { enabled: !cardHasVariants });
  const freshDetail = query.data && !query.isStale ? query.data : undefined;
  const source = freshDetail ?? (cardHasVariants ? product : query.data ?? null);
  return {
    source,
    detail: query.data,
    isError: !source && query.isError,
    refetch: () => void query.refetch(),
  };
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
  const { source, detail, isError, refetch } = useSheetProduct(product);
  // The screen below keeps the cart fresh: opening the sheet must not refetch it.
  const cart = useCartActions({ refetchCart: false });
  // Only what can be bought now, as THIS customer sees it: units their own
  // unpaid checkout holds count as theirs (lib/ownHolds.ts).
  const visible = useMemo(() => (source ? visibleVariantsOf(source, cart.withOwnHold) : []), [source, cart.withOwnHold]);
  const variants = useMemo(() => visible.filter(isPurchasable), [visible]);
  // Nothing can be bought because the store stopped taking orders (not sold
  // out): said without naming the store — customers are not shown who sells it.
  const closedHint = storeClosedHint(visible);
  const closedMessage = closedHint === null ? null : `Unavailable right now.${closedHint ? ` ${closedHint}` : ""}`;
  const options = useMemo<VariantOptions | null>(
    () => (source ? variantOptions({ optionGroups: source.optionGroups ?? [], variants }) : null),
    [source, variants],
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The starting picks; and, when a refresh takes away a chosen option (it
  // sold out meanwhile), the pick is dropped with a word — never swapped.
  useEffect(() => {
    if (!options) return;
    if (selection === null) {
      setSelection(initialSelection(options, variants));
      return;
    }
    const gone = Object.entries(selection).some(
      ([group, key]) => !options.groups.find((item) => item.name === group)?.choices.some((choice) => choice.key === key),
    );
    if (gone) {
      setSelection(initialSelection(options, variants));
      setNotice("That option just sold out. Please choose another.");
    }
  }, [options, variants, selection]);

  useLayoutEffect(() => {
    if (variants.length === 0) return;
    markSheet("firstVariant");
    markSheet("allPrices");
  }, [variants]);

  const picks = selection ?? {};
  const chosen = options ? selectedVariant(options, variants, picks) : undefined;
  const cheapest = variants.reduce<VariantDto | undefined>((low, item) => (!low || item.pricePaise < low.pricePaise ? item : low), undefined);
  // Before a choice: the cheapest size that can be bought ("From …" when sizes differ in price).
  const shownVariant = chosen ?? cheapest ?? product.defaultVariant ?? undefined;
  const fromPrice = !chosen && new Set(variants.map((item) => item.pricePaise)).size > 1;
  const image = resolveImageUrl(chosen?.imageUrl ?? detail?.images[0]?.thumbUrl ?? product.thumbUrl);
  const qty = chosen ? cart.qtyFor(chosen.id) : 0;
  const busy = chosen ? cart.isBusy(chosen.id) : false;
  const name = source?.name ?? product.name;

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
            {name}
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
          <Pressable onPress={onViewDetails} hitSlop={8} style={styles.viewDetails} accessibilityRole="link" accessibilityLabel={`View details of ${name}`}>
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
        {!source ? (
          isError ? (
            <View>
              <AppText variant="body" color={colors.textSecondary}>
                We could not load the options for this product.
              </AppText>
              <Button label="Try again" variant="secondary" onPress={refetch} style={{ marginTop: spacing.md }} />
            </View>
          ) : (
            // Only from an older server, whose product lists carry no variants.
            <AppText variant="body" color={colors.textSecondary}>
              Loading options…
            </AppText>
          )
        ) : variants.length === 0 ? (
          <AppText variant="body" color={colors.textSecondary}>
            {closedMessage ?? "This product just sold out."}
          </AppText>
        ) : (
          options?.groups.map((group) => (
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
                  // A choice that is one whole variant (by-variant choices, or the
                  // only option group, e.g. Weight) shows that variant's own price.
                  const variant = options.byVariant
                    ? variants.find((item) => item.id === choice.key)
                    : options.groups.length === 1
                      ? variants.find((item) => options.keyOf(item, group.name) === choice.key)
                      : undefined;
                  return (
                    <Pressable
                      key={choice.key}
                      disabled={state === "soldOut"}
                      onPress={() => {
                        setNotice(null);
                        setSelection(pick(options, variants, picks, group.name, choice.key));
                      }}
                      style={({ pressed }) => [
                        styles.chip,
                        active && styles.chipActive,
                        state === "conflict" && !active && styles.chipConflict,
                        state === "soldOut" && styles.chipSoldOut,
                        pressed && styles.pressed,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled: state === "soldOut" }}
                      accessibilityLabel={`${group.name} ${choice.label}${variant ? `, ${formatPaise(variant.pricePaise)}` : ""}`}
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
                          {formatPaise(variant.pricePaise)}
                        </AppText>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}

        {chosen && chosen.availableQty > 0 && chosen.availableQty <= 5 ? (
          <AppText variant="caption" color={colors.warning}>
            Only {chosen.availableQty} left
          </AppText>
        ) : null}
      </ScrollView>

      {notice || cart.error ? (
        <View style={styles.notice}>
          <NoticeStrip message={(notice ?? cart.error)!} />
        </View>
      ) : null}

      {/* Add / quantity */}
      <View style={styles.footer}>
        {!source || !options ? (
          <Button label="Add to cart" onPress={() => undefined} disabled style={styles.action} />
        ) : variants.length === 0 ? (
          <Button label={closedMessage ? "Unavailable" : "Sold out"} onPress={() => undefined} disabled style={styles.action} />
        ) : !chosen ? (
          <Button
            label={`Select ${(missingGroup(options, picks) ?? "an option").toLowerCase()}`}
            onPress={() => undefined}
            disabled
            style={styles.action}
          />
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
              if (busy) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
              cart.add(chosen.id, snapshotFromProduct(source, chosen));
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
    // Above the backdrop on Android (elevation orders siblings there).
    elevation: 16,
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

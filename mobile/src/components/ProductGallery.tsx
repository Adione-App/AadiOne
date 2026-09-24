/**
 * Product image gallery.
 *
 * A swipeable pager with dots, the pattern every Indian quick-commerce app
 * uses, so it needs no explanation to a first-time customer.
 *
 * Deliberately degrades: with one image it renders as a plain picture with no
 * dots and no swipe affordance, because a pager showing a single page invites
 * a swipe that does nothing.
 */

import { forwardRef, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Image } from "expo-image";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";

const HEIGHT = 280;

/**
 * `ref` is forwarded to a `View` that tightly wraps whichever image is
 * CURRENTLY VISIBLE — the single-image box, or (for the swipeable pager)
 * a wrapper around just the `ScrollView` itself, excluding the counter/dots
 * below it. Paging always aligns exactly one full-width slide within that
 * box, so this one ref is correct regardless of which slide is active —
 * ProductDetailScreen's footer measures it to fly the tapped-Add product's
 * own on-screen image into the mini-cart (see flyToCart.tsx).
 */
const ProductGallery = forwardRef<
  View,
  {
    images: { id: string; url: string; altText: string | null }[];
    fallbackUrl: string | null;
    productName: string;
  }
>(function ProductGallery({ images, fallbackUrl, productName }, ref) {
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const scroller = useRef<ScrollView>(null);

  // The detail payload carries `images`; older products may only have the
  // summary-level imageUrl, so fall back rather than showing an empty box.
  const sources =
    images.length > 0
      ? images
      : fallbackUrl
        ? [{ id: "fallback", url: fallbackUrl, altText: null }]
        : [];

  if (sources.length === 0) {
    return (
      <View
        style={[
          styles.box,
          { height: HEIGHT, backgroundColor: colors.skeleton },
        ]}
      />
    );
  }

  if (sources.length === 1) {
    return (
      <View ref={ref} style={[styles.box, { height: HEIGHT }]}>
        <Image
          source={{
            uri: resolveImageUrl(sources[0]!.url) ?? undefined,
          }}
          style={styles.image}
          contentFit="contain"
          transition={150}
          cachePolicy="memory-disk"
          accessibilityLabel={sources[0]!.altText ?? productName}
        />
      </View>
    );
  }

  function handleScrollEnd(
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    // Clamped because an over-scroll bounce at either end can compute -1 or n.
    setIndex(Math.max(0, Math.min(sources.length - 1, next)));
  }

  return (
    <View>
      {/* Refed here, not on the outer `<View>` above — this box's bounds
          exactly match whichever single slide is currently paged into
          view (same height, full width), excluding the counter/dots
          below it. */}
      <View ref={ref} style={{ height: HEIGHT }}>
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
        >
          {sources.map((image) => (
            <View key={image.id} style={[styles.box, { width, height: HEIGHT }]}>
              <Image
                source={{
                  uri: resolveImageUrl(image.url) ?? undefined,
                }}
                style={styles.image}
                contentFit="contain"
                transition={150}
                cachePolicy="memory-disk"
                accessibilityLabel={image.altText ?? productName}
              />
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Counter as well as dots: beyond about five images the dots stop being
          countable at a glance, but the fraction still reads. */}
      <View style={styles.counter}>
        <AppText variant="caption" color={colors.textSecondary}>
          {index + 1}/{sources.length}
        </AppText>
      </View>

      <View style={styles.dots}>
        {sources.map((image, position) => (
          <View
            key={image.id}
            style={[
              styles.dot,
              position === index ? styles.dotActive : undefined,
            ]}
          />
        ))}
      </View>
    </View>
  );
});

export default ProductGallery;

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", padding: spacing.lg },
  image: { width: "100%", height: "100%", borderRadius: radius.lg },
  counter: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.base,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    paddingBottom: spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.borderStrong,
  },
  dotActive: {
    width: 18,
    backgroundColor: colors.primary,
  },
});

/**
 * Product image gallery.
 *
 * A swipeable pager with dots, the pattern every Indian quick-commerce app
 * uses, so it needs no explanation to a first-time customer.
 *
 * Deliberately degrades: with one image it renders as a plain picture with no
 * dots and no swipe affordance, because a pager showing a single page invites
 * a swipe that does nothing.
 *
 * Sizing: one square viewport, (nearly) full width, the same for every
 * product and every photo on a given device — capped at MAX_HEIGHT_FRACTION of
 * the screen so the title and price stay in view. Photos are always drawn with
 * `contain`: whole, centred, never cropped or stretched, their own background
 * kept. The viewport used to take the FIRST photo's shape once it had loaded,
 * so the page jumped as it arrived, its height changed from product to
 * product, and the other photos of a product were boxed to the first one's
 * shape (a landscape first photo left the square ones with side bands).
 *
 * Several photos: the counter and dots sit in their own row below the
 * viewport, clear of the photo — never over it.
 */

import { forwardRef, useCallback, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewInstance,
} from "react-native";
import { Image } from "expo-image";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";

/** Space between the photo and the screen edges. */
const SIDE_INSET = spacing.sm;
/** The square viewport is never taller than this share of the screen height. */
const MAX_HEIGHT_FRACTION = 0.6;

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
  ViewInstance,
  {
    images: { id: string; url: string; altText: string | null }[];
    fallbackUrl: string | null;
    productName: string;
  }
>(function ProductGallery({ images, fallbackUrl, productName }, ref) {
  const { width, height: screenHeight } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  /** Photos that failed to load (missing / invalid file) — shown as the placeholder. */
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  // The detail payload carries `images`; older products may only have the
  // summary-level imageUrl, so fall back rather than showing an empty box.
  const sources =
    images.length > 0
      ? images
      : fallbackUrl
        ? [{ id: "fallback", url: fallbackUrl, altText: null }]
        : [];

  const photoWidth = width - SIDE_INSET * 2;
  const height = Math.round(Math.min(photoWidth, screenHeight * MAX_HEIGHT_FRACTION));

  const onPhotoError = useCallback((id: string) => {
    setFailed((current) => new Set(current).add(id));
  }, []);

  function renderPhoto(image: (typeof sources)[number]) {
    const uri = resolveImageUrl(image.url);
    if (!uri || failed.has(image.id)) {
      return <View style={[styles.image, styles.missing]} accessibilityLabel={`${productName}: no photo`} />;
    }
    return (
      <Image
        source={{ uri }}
        style={styles.image}
        contentFit="contain"
        transition={150}
        cachePolicy="memory-disk"
        accessibilityLabel={image.altText ?? productName}
        onError={() => onPhotoError(image.id)}
      />
    );
  }

  if (sources.length === 0) {
    return (
      <View style={[styles.box, { height }]}>
        <View style={[styles.image, styles.missing]} />
      </View>
    );
  }

  if (sources.length === 1) {
    return (
      <View ref={ref} style={[styles.box, { height }]}>
        {renderPhoto(sources[0]!)}
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
      <View ref={ref} style={{ height }}>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
        >
          {sources.map((image) => (
            <View key={image.id} style={[styles.box, { width, height }]}>
              {renderPhoto(image)}
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Its own row below the photo. Counter as well as dots: beyond about
          five images the dots stop being countable at a glance, but the
          fraction still reads. */}
      <View style={styles.pagination}>
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
        <View style={styles.counter}>
          <AppText variant="caption" color={colors.textSecondary}>
            {index + 1}/{sources.length}
          </AppText>
        </View>
      </View>
    </View>
  );
});

export default ProductGallery;

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", paddingHorizontal: SIDE_INSET },
  image: { width: "100%", height: "100%", borderRadius: radius.lg },
  missing: { backgroundColor: colors.skeleton },
  // Dots centred under the photo, the counter at the row's right end.
  pagination: {
    height: 22,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    justifyContent: "center",
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  counter: {
    position: "absolute",
    right: spacing.base,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
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

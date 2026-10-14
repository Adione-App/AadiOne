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
 * Sizing: the image region is (nearly) full width and its height follows the
 * product photo's own shape — measured from the first image once it loads —
 * so a photo fills the region instead of floating in a fixed box. Photos are
 * always drawn with `contain`: never cropped, never stretched. The height is
 * kept between MIN_RATIO × width (wide photos stay prominent) and
 * MAX_HEIGHT_FRACTION of the screen (title and price stay in view), and every
 * slide of a multi-photo product shares it, so swiping never jumps the page.
 */

import { forwardRef, useCallback, useRef, useState } from "react";
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

/** Space between the photo and the screen edges. */
const SIDE_INSET = spacing.sm;
/** Height ÷ width used until the first photo has loaded — 3:4 portrait, the catalogue's most common shape. */
const DEFAULT_RATIO = 4 / 3;
/** The region is never shorter than this × its width. */
const MIN_RATIO = 0.75;
/** …and never taller than this share of the screen height. */
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
  View,
  {
    images: { id: string; url: string; altText: string | null }[];
    fallbackUrl: string | null;
    productName: string;
  }
>(function ProductGallery({ images, fallbackUrl, productName }, ref) {
  const { width, height: screenHeight } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const scroller = useRef<ScrollView>(null);
  /** The first photo's height ÷ width, once known (per photo id); it sizes the whole gallery. */
  const [measured, setMeasured] = useState<{ id: string; ratio: number } | null>(null);
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

  const firstId = sources[0]?.id;
  const ratio = measured && measured.id === firstId ? measured.ratio : null;
  const photoWidth = width - SIDE_INSET * 2;
  const height = Math.round(
    Math.min(
      Math.max(photoWidth * (ratio ?? DEFAULT_RATIO), width * MIN_RATIO),
      screenHeight * MAX_HEIGHT_FRACTION,
    ),
  );

  const onPhotoLoad = useCallback(
    (id: string, sourceWidth: number, sourceHeight: number) => {
      // Only the first photo decides the shape, and only once, so the page
      // never jumps while swiping between differently shaped photos.
      if (id !== firstId || sourceWidth <= 0 || sourceHeight <= 0) return;
      setMeasured((current) => (current?.id === id ? current : { id, ratio: sourceHeight / sourceWidth }));
    },
    [firstId],
  );
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
        onLoad={(event) => onPhotoLoad(image.id, event.source.width, event.source.height)}
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
          ref={scroller}
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
  box: { alignItems: "center", justifyContent: "center", paddingHorizontal: SIDE_INSET },
  image: { width: "100%", height: "100%", borderRadius: radius.lg },
  missing: { backgroundColor: colors.skeleton },
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

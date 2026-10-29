/**
 * An admin banner slot on Home — swipeable, snapping, pagination dots,
 * autoplay that restarts after a manual swipe. One banner shows as a single
 * card; several become a carousel.
 *
 * Slides come from `bannerSlides` (homeEngine.ts): admin banners only, each
 * drawn edge to edge at its own uploaded aspect ratio so nothing is cropped.
 * This component only draws slides; it has no idea what any slide is about.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance } from "react-native";
import { Image } from "expo-image";
import { contentColor } from "@shared";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import type { HomeAction, PromoSlide } from "../homeEngine";

const AUTOPLAY_MS = 3500;
/** Used only for a banner whose image size is unknown. */
const FALLBACK_ASPECT_RATIO = 2.5;
const MAX_SLIDE_WIDTH = 640;
const AXIS = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" } as const;

function SlideContent({ slide }: { slide: PromoSlide }) {
  const artwork = resolveImageUrl(slide.imageUrl);
  return (
    <>
      {artwork ? (
        <Image
          source={{ uri: artwork }}
          style={StyleSheet.absoluteFill}
          // The admin's fit and image position (Admin Panel → Banners); never stretched.
          contentFit={slide.layout.fit}
          contentPosition={{ left: AXIS[slide.layout.alignX], top: AXIS[slide.layout.alignY] }}
          transition={150}
          cachePolicy="memory-disk"
        />
      ) : null}
      {slide.title ? (
        <View style={styles.artworkCaption}>
          <AppText style={styles.artworkTitle} numberOfLines={2}>
            {slide.title}
          </AppText>
          {slide.subtitle ? (
            <AppText style={styles.artworkSubtitle} numberOfLines={1}>
              {slide.subtitle}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** What a tap does, for screen readers. */
function actionHint(action: HomeAction): string | undefined {
  switch (action.type) {
    case "category":
    case "allCategories":
      return "Opens the category";
    case "product":
      return "Opens the product";
    case "food":
      return "Opens food";
    case "coupon":
      return "Copies the coupon code";
    default:
      return undefined;
  }
}

function PromoCarouselImpl({
  slides,
  onAction,
  onBackdrop = false,
}: {
  slides: PromoSlide[];
  onAction: (action: HomeAction) => void;
  /**
   * Drawn on a coloured backdrop (the Home hero): a banner with no background
   * of its own lets the backdrop show around a contained image instead of
   * the light frame colour — which on the hero read as a white strip.
   */
  onBackdrop?: boolean;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const slideWidth = Math.min(MAX_SLIDE_WIDTH, windowWidth - spacing.base * 2);
  const step = slideWidth + spacing.sm;
  // Every slide of a slot shares one height — the widest banner's — so a
  // carousel never jumps between slides and no banner is cropped.
  const ratio = slides.length > 0 ? Math.max(...slides.map((slide) => slide.aspectRatio ?? FALLBACK_ASPECT_RATIO)) : FALLBACK_ASPECT_RATIO;
  // An admin-set fixed height (clamped by resolveBannerLayout) wins over the shape.
  const fixedHeight = slides.find((slide) => slide.layout.height !== null)?.layout.height ?? null;
  const slideHeight = fixedHeight ?? Math.round(slideWidth / ratio);

  const [active, setActive] = useState(0);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoplay = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (slides.length <= 1) return;
    timerRef.current = setInterval(() => {
      setActive((current) => {
        const next = (current + 1) % slides.length;
        scrollRef.current?.scrollTo({ x: next * step, animated: true });
        return next;
      });
    }, AUTOPLAY_MS);
  }, [slides.length, step]);

  useEffect(() => {
    startAutoplay();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startAutoplay]);

  // A shorter slide list (data changed) must not leave the dots past the end.
  useEffect(() => {
    if (active >= slides.length) setActive(0);
  }, [active, slides.length]);

  if (slides.length === 0) return null;

  return (
    <View style={styles.carousel}>
      <ScrollView
        ref={scrollRef}
        horizontal
        scrollEnabled={slides.length > 1}
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={step}
        snapToAlignment="start"
        contentContainerStyle={{ paddingHorizontal: spacing.base }}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / step);
          setActive(Math.max(0, Math.min(slides.length - 1, index)));
          // A manual swipe shouldn't be undone by autoplay moments later.
          startAutoplay();
        }}
      >
        {slides.map((slide, index) => (
          <Pressable
            key={slide.key}
            onPress={() => onAction(slide.action)}
            disabled={slide.action.type === "none"}
            style={[
              styles.slide,
              {
                width: slideWidth,
                height: slideHeight,
                marginRight: index === slides.length - 1 ? 0 : spacing.sm,
                // The banner's own background (Admin Panel); none = the frame colour, or the backdrop on the hero.
                backgroundColor:
                  slide.layout.background !== "none"
                    ? contentColor(slide.layout.background, colors.primarySurface)
                    : onBackdrop
                      ? "transparent"
                      : colors.primarySurface,
              },
            ]}
            accessibilityRole={slide.action.type === "none" ? "image" : "button"}
            accessibilityLabel={[slide.title, slide.subtitle].filter(Boolean).join(", ") || "Promotional banner"}
            accessibilityHint={actionHint(slide.action)}
          >
            <SlideContent slide={slide} />
          </Pressable>
        ))}
      </ScrollView>

      {slides.length > 1 && (
        <View style={styles.dots}>
          {slides.map((slide, index) => (
            <View key={slide.key} style={[styles.dot, index === active && styles.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

export const PromoCarousel = memo(PromoCarouselImpl);

const styles = StyleSheet.create({
  carousel: {
    marginTop: spacing.md,
  },
  slide: {
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.primarySurface,
  },
  artworkCaption: {
    position: "absolute",
    left: spacing.base,
    top: spacing.base,
    right: "40%",
  },
  artworkTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    color: colors.primaryDarker,
  },
  artworkSubtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
    color: colors.textPrimary,
    marginTop: 2,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.borderStrong,
  },
  dotActive: {
    width: 16,
    backgroundColor: colors.primary,
  },
});

/**
 * Home's promotional carousel — swipeable, snapping, pagination dots,
 * autoplay that restarts after a manual swipe.
 *
 * Slides come from `buildPromoSlides` (homeEngine.ts): designed banners from
 * the backend when any are configured, otherwise slides composed from live
 * data. A composed slide's graphic is AdiOne branding plus a category image
 * or icon, a discount badge or a food mark — never a catalogue product photo,
 * since every product may appear only once on Home (as its ProductCard).
 * This component only draws slides; it has no idea what any slide is about.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { ArrowRight, BadgePercent, UtensilsCrossed } from "lucide-react-native";
import { colors, palette, radius, shadow, spacing } from "@shared/theme";
import BrandMark from "@/components/BrandMark";
import CategoryIcon from "@/components/CategoryIcon";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import type { HomeAction, PromoSlide, SlideVisual } from "../homeEngine";

const AUTOPLAY_MS = 3500;
const SLIDE_HEIGHT = 160;
const MAX_SLIDE_WIDTH = 640;

/** Visual themes rotated by slide position — brand greens plus two warm tints. */
const THEMES = [
  { bg: palette.green500, ink: palette.white, sub: "rgba(255,255,255,0.86)", badgeBg: "#FFD84D", badgeInk: palette.grey900, ctaBg: palette.white, ctaInk: palette.green600, bubble: "rgba(255,255,255,0.12)" },
  { bg: palette.green800, ink: palette.white, sub: "rgba(255,255,255,0.8)", badgeBg: palette.green300, badgeInk: palette.green900, ctaBg: palette.white, ctaInk: palette.green700, bubble: "rgba(255,255,255,0.08)" },
  { bg: "#FFF1DD", ink: palette.grey900, sub: palette.grey600, badgeBg: palette.amber500, badgeInk: palette.white, ctaBg: palette.green500, ctaInk: palette.white, bubble: "rgba(245,158,11,0.14)" },
  { bg: palette.green50, ink: palette.green900, sub: palette.grey600, badgeBg: palette.green500, badgeInk: palette.white, ctaBg: palette.green600, ctaInk: palette.white, bubble: "rgba(30,142,62,0.10)" },
] as const;

const ART_SIZE = 112;

/** The slide's right-hand graphic: themed, never a product photo. */
function SlideArt({ visual, accent }: { visual: SlideVisual; accent: string }) {
  return (
    <View style={styles.art}>
      <View style={styles.artRing}>
        <View style={styles.artDisc}>
          {visual.kind === "category" ? (
            <CategoryIcon name={visual.name} imageUrl={visual.imageUrl} size={ART_SIZE - 28} />
          ) : visual.kind === "deals" ? (
            <BadgePercent size={52} color={accent} strokeWidth={1.75} />
          ) : (
            <UtensilsCrossed size={48} color={accent} strokeWidth={1.75} />
          )}
        </View>
      </View>
    </View>
  );
}

function SlideContent({ slide, index }: { slide: PromoSlide; index: number }) {
  const theme = THEMES[index % THEMES.length]!;
  const artwork = resolveImageUrl(slide.artworkUrl);

  if (artwork) {
    return (
      <>
        <Image source={{ uri: artwork }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" />
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

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}>
      {/* Soft decorative circles give the flat colour some depth without a gradient library. */}
      <View style={[styles.bubbleLarge, { backgroundColor: theme.bubble }]} />
      <View style={[styles.bubbleSmall, { backgroundColor: theme.bubble }]} />

      <View style={styles.composed}>
        <View style={styles.copy}>
          <View style={styles.brandRow}>
            <BrandMark size={16} />
            <AppText style={[styles.brandText, { color: theme.sub }]}>AdiOne</AppText>
          </View>
          <AppText style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
            {slide.title}
          </AppText>
          {slide.subtitle ? (
            <AppText style={[styles.subtitle, { color: theme.sub }]} numberOfLines={1}>
              {slide.subtitle}
            </AppText>
          ) : null}
          {slide.badge ? (
            <View style={[styles.badge, { backgroundColor: theme.badgeBg }]}>
              <AppText style={[styles.badgeText, { color: theme.badgeInk }]} numberOfLines={1}>
                {slide.badge}
              </AppText>
            </View>
          ) : null}
          <View style={[styles.cta, { backgroundColor: theme.ctaBg }]}>
            <AppText style={[styles.ctaText, { color: theme.ctaInk }]}>{slide.ctaLabel}</AppText>
            <ArrowRight size={12} color={theme.ctaInk} strokeWidth={2.75} />
          </View>
        </View>

        {slide.visual && <SlideArt visual={slide.visual} accent={palette.green600} />}
      </View>
    </View>
  );
}

function PromoCarouselImpl({
  slides,
  onAction,
}: {
  slides: PromoSlide[];
  onAction: (action: HomeAction) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const slideWidth = Math.min(MAX_SLIDE_WIDTH, windowWidth - spacing.base * 2);
  const step = slideWidth + spacing.sm;

  const [active, setActive] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
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
            style={[
              styles.slide,
              { width: slideWidth, marginRight: index === slides.length - 1 ? 0 : spacing.sm },
            ]}
            accessibilityRole="button"
            accessibilityLabel={[slide.title, slide.badge, slide.ctaLabel].filter(Boolean).join(", ")}
          >
            <SlideContent slide={slide} index={index} />
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
    height: SLIDE_HEIGHT,
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.primarySurface,
  },
  composed: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.base,
    paddingRight: spacing.sm,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.sm,
  },
  title: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    marginTop: 3,
  },
  badge: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "800",
  },
  cta: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 28,
    borderRadius: radius.pill,
  },
  ctaText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "800",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  brandText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  art: {
    width: ART_SIZE + 8,
    alignItems: "center",
    justifyContent: "center",
  },
  artRing: {
    width: ART_SIZE + 8,
    height: ART_SIZE + 8,
    borderRadius: (ART_SIZE + 8) / 2,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  artDisc: {
    width: ART_SIZE - 12,
    height: ART_SIZE - 12,
    borderRadius: (ART_SIZE - 12) / 2,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    ...shadow.md,
  },
  bubbleLarge: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    right: -60,
    top: -70,
  },
  bubbleSmall: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    left: -40,
    bottom: -60,
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

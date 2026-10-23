/**
 * The Food carousel on Home — the "home_food" banners (Admin Panel → Banners
 * & Cards, "Home — food carousel"), three cards by default (Home Page
 * Builder sets how many). Cards peek past the screen edge so the next one is
 * visible, snap one at a time, and show page dots only when there is more
 * than one. No autoplay: it scrolls only when the customer swipes.
 *
 * A card opens what its banner opens; a decorative card (no destination)
 * opens the Food screen, like the standard food banner did.
 */

import { memo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { colors, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import type { HomeAction, PromoSlide } from "../homeEngine";
import { SectionHeader } from "./SectionShell";

const GAP = spacing.md;
const SIDE = spacing.base;
const MAX_CARD_WIDTH = 360;
const AXIS = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" } as const;

function FoodCarouselImpl({
  title,
  subtitle,
  slides,
  onAction,
  onOpenFood,
}: {
  title: string | null;
  subtitle: string | null;
  slides: PromoSlide[];
  onAction: (action: HomeAction) => void;
  onOpenFood: () => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  const [active, setActive] = useState(0);
  if (slides.length === 0) return null;

  const single = slides.length === 1;
  const cardWidth = Math.round(single ? screenWidth - SIDE * 2 : Math.min(MAX_CARD_WIDTH, screenWidth * 0.8));
  // One height for every card: the admin's fixed height, else the first card's shape (kept within sensible limits).
  const fixed = slides.find((slide) => slide.layout.height !== null)?.layout.height ?? null;
  const aspect = slides[0]!.aspectRatio ?? 1.9;
  const cardHeight = Math.round(fixed ?? Math.min(240, Math.max(120, cardWidth / aspect)));
  const step = cardWidth + GAP;

  return (
    <View style={styles.section}>
      {title ? <SectionHeader title={title} subtitle={subtitle} /> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        disableIntervalMomentum
        contentContainerStyle={{ paddingHorizontal: SIDE, gap: GAP }}
        onMomentumScrollEnd={(event) => setActive(Math.max(0, Math.min(slides.length - 1, Math.round(event.nativeEvent.contentOffset.x / step))))}
        scrollEnabled={!single}
      >
        {slides.map((slide) => {
          const uri = resolveImageUrl(slide.imageUrl);
          const open = () => (slide.action.type === "none" ? onOpenFood() : onAction(slide.action));
          return (
            <Pressable
              key={slide.key}
              onPress={open}
              style={({ pressed }) => [styles.card, { width: cardWidth }, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={slide.title ?? "Food offer"}
            >
              <View style={[styles.artwork, { height: cardHeight }]}>
                {uri ? (
                  <Image
                    source={{ uri }}
                    style={StyleSheet.absoluteFill}
                    contentFit={slide.layout.fit === "contain" ? "contain" : "cover"}
                    contentPosition={{ left: AXIS[slide.layout.alignX], top: AXIS[slide.layout.alignY] }}
                    transition={150}
                    cachePolicy="memory-disk"
                  />
                ) : null}
              </View>
              {slide.title || slide.subtitle ? (
                <View style={styles.caption}>
                  {slide.title ? (
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {slide.title}
                    </AppText>
                  ) : null}
                  {slide.subtitle ? (
                    <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                      {slide.subtitle}
                    </AppText>
                  ) : null}
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
      {!single ? (
        <View style={styles.dots} accessibilityRole="adjustable" accessibilityLabel={`Card ${active + 1} of ${slides.length}`}>
          {slides.map((slide, index) => (
            <View key={slide.key} style={[styles.dot, index === active && styles.dotActive]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const FoodCarousel = memo(FoodCarouselImpl);

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  artwork: {
    width: "100%",
    backgroundColor: colors.surfaceMuted,
  },
  caption: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  pressed: {
    opacity: 0.92,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
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
    width: 18,
    backgroundColor: colors.primary,
  },
});

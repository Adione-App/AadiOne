/**
 * The top of Home below the search bar: the promotional area ("home_top"
 * banners) and the top cards, on the admin's background (Admin Panel → Home
 * Page Builder → Top of the page): a solid colour, a gradient or an image
 * with an optional tint.
 *
 * The header and search bar above it are painted in the background's first
 * colour (`heroHeaderColor`), so the background reads as one surface from
 * the very top of the screen down to below the cards. The hero is part of
 * the scrolling list — it scrolls away like any section and never changes
 * the header overlay's own layout (HomeScreen's transform-only header).
 *
 * With no promotional banner and no card live, only a small strip of the
 * background is drawn — never an empty placeholder.
 */

import { memo, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { HOME_SPACING_DP, contentColor, type HomeHeroConfig } from "@shared";
import { spacing } from "@shared/theme";
import { resolveImageUrl } from "@/lib/api";
import type { HomeAction, PromoSlide } from "../homeEngine";
import { FeatureCards } from "./FeatureCards";
import { PromoCarousel } from "./PromoCarousel";

const FALLBACK = "#FFFFFF";

/** The colour the header and search bar sit on — the background's first colour. */
export function heroHeaderColor(hero: HomeHeroConfig): string {
  return contentColor(hero.background.color, FALLBACK);
}

const GRADIENT_END = {
  vertical: { x2: "0", y2: "1" },
  horizontal: { x2: "1", y2: "0" },
  diagonal: { x2: "1", y2: "1" },
} as const;

function Background({ hero, width, height }: { hero: HomeHeroConfig; width: number; height: number }) {
  const background = hero.background;
  if (background.type === "image" && background.imageUrl) {
    const uri = resolveImageUrl(background.imageUrl);
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: contentColor(background.color, FALLBACK) }]}>
        {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={150} /> : null}
        {background.overlayOpacity > 0 ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: contentColor(background.overlayColor, FALLBACK), opacity: background.overlayOpacity }]} />
        ) : null}
      </View>
    );
  }
  if (background.type === "gradient" && width > 0 && height > 0) {
    const end = GRADIENT_END[background.direction];
    return (
      <Svg style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
        <Defs>
          <LinearGradient id="homeHero" x1="0" y1="0" x2={end.x2} y2={end.y2}>
            <Stop offset="0" stopColor={contentColor(background.color, FALLBACK)} />
            <Stop offset="1" stopColor={contentColor(background.colorTo, FALLBACK)} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#homeHero)" />
      </Svg>
    );
  }
  // Solid, and the first frame of a gradient before its size is known.
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: contentColor(background.color, FALLBACK) }]} />;
}

function HomeHeroImpl({ hero, promo, onAction }: { hero: HomeHeroConfig; promo: PromoSlide[]; onAction: (action: HomeAction) => void }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  };
  const pad = HOME_SPACING_DP[hero.padding];
  return (
    <View onLayout={onLayout} style={[styles.hero, { paddingBottom: pad }]}>
      <Background hero={hero} width={size.width} height={size.height} />
      {promo.length > 0 ? (
        <View style={styles.promo}>
          <PromoCarousel slides={promo} onAction={onAction} />
        </View>
      ) : null}
      <View style={{ marginTop: promo.length > 0 ? spacing.sm : pad / 2 }}>
        <FeatureCards config={hero.cards} />
      </View>
    </View>
  );
}

export const HomeHero = memo(HomeHeroImpl);

const styles = StyleSheet.create({
  hero: {
    overflow: "hidden",
    paddingTop: spacing.xs,
  },
  promo: {
    marginTop: spacing.xs,
  },
});

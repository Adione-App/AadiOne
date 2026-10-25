/**
 * The top cards under the promotional area — the "home_cards" banners
 * (Admin Panel → Banners & Cards, placement "Home — top cards"), side by side
 * in one row. Each card's image, title, subtitle, colour, image fit and
 * destination come from its banner; the row's count, height, corners and gap
 * from the Home Page Builder (layout.hero.cards).
 *
 * Widths are computed from the screen so the row never overflows. A row of
 * "show the whole image" cards takes its images' own shape (cardLayout.ts),
 * so the artwork fills each card instead of sitting in empty bands; a card
 * with no background of its own adds none (the hero shows through). A title
 * wraps to at most two lines and a subtitle to one, ending in "…" rather
 * than clipping. A card
 * whose destination is gone (the server sends it as NONE) still shows but
 * does nothing when tapped — never a dead page.
 */

import { memo } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { HOME_CARD_GAP_DP, contentColor, resolveBannerLayout, type BannerDto, type HomeHeroConfig } from "@shared";
import { radius as themeRadius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { bannerIsTappable, openBannerAction } from "@/lib/bannerAction";
import { useBanners } from "@/lib/queries";
import { featureCardSize } from "../cardLayout";

export const HOME_CARDS_PLACEMENT = "home_cards";

const SIDE = spacing.base;
const RADIUS = { sm: themeRadius.sm, md: themeRadius.md, lg: themeRadius.lg } as const;
const TEXT = { dark: { title: "#1D2A20", subtitle: "#4A5A4E" }, light: { title: "#FFFFFF", subtitle: "rgba(255,255,255,0.88)" } } as const;
const AXIS = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" } as const;

function Card({ banner, width, height, radius }: { banner: BannerDto; width: number; height: number; radius: number }) {
  const layout = resolveBannerLayout(banner.layout, "tile");
  const uri = resolveImageUrl(banner.imageUrl);
  const tone = TEXT[layout.textTone];
  const tappable = bannerIsTappable(banner);
  const body = (
    <View style={[styles.card, { width, height, borderRadius: radius, backgroundColor: contentColor(layout.background, "transparent") }]}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit={layout.fit}
          contentPosition={{ left: AXIS[layout.alignX], top: AXIS[layout.alignY] }}
          transition={150}
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {banner.title || banner.subtitle ? (
        <View style={styles.copy}>
          {banner.title ? (
            <AppText style={[styles.title, { color: tone.title }]} numberOfLines={2}>
              {banner.title}
            </AppText>
          ) : null}
          {banner.subtitle ? (
            <AppText style={[styles.subtitle, { color: tone.subtitle }]} numberOfLines={1}>
              {banner.subtitle}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  if (!tappable) return body;
  return (
    <Pressable
      onPress={() => openBannerAction(banner)}
      style={({ pressed }) => pressed && styles.pressed}
      accessibilityRole="button"
      accessibilityLabel={banner.title ?? "Offer"}
    >
      {body}
    </Pressable>
  );
}

function FeatureCardsImpl({ config }: { config: HomeHeroConfig["cards"] }) {
  const { width: screenWidth } = useWindowDimensions();
  const query = useBanners(HOME_CARDS_PLACEMENT);
  const cards = (query.data ?? []).slice(0, config.maxItems);
  if (!config.visible || cards.length === 0) return null;

  const gap = HOME_CARD_GAP_DP[config.gap];
  const { width, height } = featureCardSize({
    screenWidth,
    side: SIDE,
    gap,
    configuredHeight: config.height,
    cards: cards.map((banner) => ({
      fit: resolveBannerLayout(banner.layout, "tile").fit,
      aspectRatio: banner.imageWidth > 0 && banner.imageHeight > 0 ? banner.imageWidth / banner.imageHeight : null,
    })),
  });
  return (
    <View style={[styles.row, { gap }]}>
      {cards.map((banner) => (
        <Card key={banner.id} banner={banner} width={width} height={height} radius={RADIUS[config.radius]} />
      ))}
    </View>
  );
}

export const FeatureCards = memo(FeatureCardsImpl);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: SIDE,
  },
  card: {
    overflow: "hidden",
  },
  copy: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    gap: 2,
  },
  title: {
    fontSize: 14,
    lineHeight: 17,
    fontWeight: "800",
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.9,
  },
});

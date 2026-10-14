/**
 * Admin banners, drawn exactly as configured in the Admin Panel (Banners):
 * each banner's own presentation (`layout`: style, frame shape / height,
 * width, fit, image position, corners, background — resolved and clamped by
 * the shared `resolveBannerLayout`) sized by the shared `bannerFrameSize`,
 * the same numbers the Admin Panel's phone preview uses.
 *
 *   banner / split / strip   several in a row become a swipeable carousel
 *                            that advances on its own
 *   tile                     side by side, up to three per row
 *   card                     stacked
 *
 * Images are never stretched: `contain` shows all of it, `cover` fills the
 * frame and may crop. A tap goes through lib/bannerAction.ts. `PromoSlot`
 * renders NOTHING for a placement with no live banner — no empty frame, no
 * spacer.
 */

import { memo, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { Image, type ImageContentPosition } from "expo-image";
import {
  BANNER_SIDE_MARGIN,
  bannerFrameSize,
  resolveBannerLayout,
  type BannerDto,
  type BannerVariant,
  type ResolvedBannerLayout,
} from "@shared";
import { colors, palette, radius, spacing } from "@shared/theme";
import { AppText } from "@/components/ui";
import { resolveImageUrl } from "@/lib/api";
import { bannerIsTappable, openBannerAction } from "@/lib/bannerAction";
import { useBanners } from "@/lib/queries";

const AUTOPLAY_MS = 4000;
const GAP = 10;
const RADIUS = { none: 0, sm: radius.sm, md: radius.md, lg: radius.lg } as const;
const BACKGROUND = { none: "transparent", white: colors.surface, green: colors.primarySurface, grey: colors.surfaceMuted } as const;
const AXIS = { left: "0%", center: "50%", right: "100%", top: "0%", bottom: "100%" } as const;

const imageAspect = (banner: BannerDto) => (banner.imageWidth > 0 && banner.imageHeight > 0 ? banner.imageWidth / banner.imageHeight : 2);
const position = (layout: ResolvedBannerLayout): ImageContentPosition => ({ left: AXIS[layout.alignX], top: AXIS[layout.alignY] });

/** The image in its frame: corners, background, fit and position from the layout. */
function Artwork({ banner, layout, width, height }: { banner: BannerDto; layout: ResolvedBannerLayout; width: number; height: number }) {
  const uri = resolveImageUrl(banner.imageUrl);
  return (
    <View style={{ width, height, borderRadius: RADIUS[layout.radius], backgroundColor: BACKGROUND[layout.background], overflow: "hidden" }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit={layout.fit}
          contentPosition={position(layout)}
          transition={150}
          cachePolicy="memory-disk"
          accessibilityLabel={banner.title ?? undefined}
        />
      ) : null}
    </View>
  );
}

/** "Good food brings good mood" → the last two words in brand green (the split headline). */
function Headline({ text }: { text: string }) {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return <AppText style={styles.headline}>{text}</AppText>;
  return (
    <AppText style={styles.headline}>
      {words.slice(0, -2).join(" ")} <AppText style={[styles.headline, styles.headlineAccent]}>{words.slice(-2).join(" ")}</AppText>
    </AppText>
  );
}

/** One banner in its style. `onDecorativeCta` is what a button does on a banner with no tap target. */
function BannerItem({
  banner,
  layout,
  screenWidth,
  count,
  onDecorativeCta,
}: {
  banner: BannerDto;
  layout: ResolvedBannerLayout;
  screenWidth: number;
  count: number;
  onDecorativeCta?: (() => void) | undefined;
}) {
  const frame = bannerFrameSize(layout, screenWidth, imageAspect(banner), count);
  const tappable = bannerIsTappable(banner);
  const press = () => (tappable ? openBannerAction(banner) : undefined);

  let body: React.ReactNode;
  if (layout.variant === "split") {
    const cta = banner.ctaLabel ? (
      <Pressable
        onPress={tappable ? press : onDecorativeCta}
        style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
        accessibilityRole="button"
      >
        <AppText style={styles.ctaText}>{banner.ctaLabel}</AppText>
      </Pressable>
    ) : null;
    body = (
      <View style={[styles.split, { width: frame.width }]}>
        <View style={styles.splitCopy}>
          {banner.title ? <Headline text={banner.title} /> : null}
          {banner.subtitle ? (
            <AppText style={styles.subtitle} numberOfLines={3}>
              {banner.subtitle}
            </AppText>
          ) : null}
          {cta}
        </View>
        <Artwork banner={banner} layout={layout} width={frame.imageWidth} height={frame.height} />
      </View>
    );
  } else if (layout.variant === "card") {
    body = (
      <View style={[styles.card, { width: frame.width }]}>
        <Artwork banner={banner} layout={layout} width={frame.imageWidth} height={frame.height} />
        <View style={styles.cardCopy}>
          {banner.title ? (
            <AppText variant="bodyStrong" numberOfLines={2}>
              {banner.title}
            </AppText>
          ) : null}
          {banner.subtitle ? (
            <AppText variant="caption" color={colors.textSecondary} numberOfLines={3}>
              {banner.subtitle}
            </AppText>
          ) : null}
        </View>
      </View>
    );
  } else {
    body = (
      <View style={{ width: frame.width }}>
        <Artwork banner={banner} layout={layout} width={frame.width} height={frame.height} />
        {layout.variant === "banner" && (banner.title || banner.subtitle) ? (
          <View style={styles.caption}>
            {banner.title ? (
              <AppText variant="bodyStrong" numberOfLines={1}>
                {banner.title}
              </AppText>
            ) : null}
            {banner.subtitle ? (
              <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                {banner.subtitle}
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  // The split's own button carries the tap; elsewhere the whole banner does.
  if (!tappable || layout.variant === "split") return <>{body}</>;
  return (
    <Pressable onPress={press} style={({ pressed }) => pressed && styles.pressed} accessibilityRole="button" accessibilityLabel={banner.title ?? "Offer"}>
      {body}
    </Pressable>
  );
}

/** Several banners of a swipeable style: pages that advance on their own, with dots. */
function Carousel({ items, screenWidth, onDecorativeCta }: { items: { banner: BannerDto; layout: ResolvedBannerLayout }[]; screenWidth: number; onDecorativeCta?: (() => void) | undefined }) {
  const first = items[0]!;
  const frameWidth = bannerFrameSize(first.layout, screenWidth, imageAspect(first.banner)).width;
  const step = frameWidth + GAP;
  const [active, setActive] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const userTouching = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (userTouching.current) return;
      setActive((current) => {
        const next = (current + 1) % items.length;
        scroller.current?.scrollTo({ x: next * step, animated: true });
        return next;
      });
    }, AUTOPLAY_MS);
    return () => clearInterval(timer);
  }, [items.length, step]);

  const inset = first.layout.width === "full" ? 0 : BANNER_SIDE_MARGIN;
  return (
    <View>
      <ScrollView
        ref={scroller}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: inset, gap: GAP }}
        onScrollBeginDrag={() => {
          userTouching.current = true;
        }}
        onMomentumScrollEnd={(event) => {
          userTouching.current = false;
          setActive(Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.x / step))));
        }}
      >
        {items.map(({ banner, layout }) => (
          <BannerItem key={banner.id} banner={banner} layout={layout} screenWidth={screenWidth} count={items.length} onDecorativeCta={onDecorativeCta} />
        ))}
      </ScrollView>
      <View style={styles.dots}>
        {items.map(({ banner }, index) => (
          <View key={banner.id} style={[styles.dot, index === active && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

/** Banners as given (already live and in order), grouped by consecutive style. */
function PromoBannersImpl({
  banners,
  defaultVariant = "banner",
  style,
  onDecorativeCta,
}: {
  banners: BannerDto[];
  defaultVariant?: BannerVariant;
  style?: StyleProp<ViewStyle>;
  onDecorativeCta?: () => void;
}) {
  const { width: screenWidth } = useWindowDimensions();
  if (banners.length === 0) return null;

  const items = banners.map((banner) => ({ banner, layout: resolveBannerLayout(banner.layout, defaultVariant) }));
  const groups: (typeof items)[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.layout.variant === item.layout.variant) last.push(item);
    else groups.push([item]);
  }

  return (
    <View style={[styles.slot, style]}>
      {groups.map((group) => {
        const variant = group[0]!.layout.variant;
        const key = group.map((item) => item.banner.id).join("|");
        if (group.length > 1 && (variant === "banner" || variant === "split" || variant === "strip")) {
          return <Carousel key={key} items={group} screenWidth={screenWidth} onDecorativeCta={onDecorativeCta} />;
        }
        const inset = variant !== "tile" && group[0]!.layout.width === "full" ? 0 : BANNER_SIDE_MARGIN;
        return (
          <View key={key} style={[variant === "tile" ? styles.tiles : styles.stack, { paddingHorizontal: inset }]}>
            {group.map(({ banner, layout }) => (
              <BannerItem key={banner.id} banner={banner} layout={layout} screenWidth={screenWidth} count={group.length} onDecorativeCta={onDecorativeCta} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

export const PromoBanners = memo(PromoBannersImpl);

/** A placement's live banners (GET /banners) — nothing at all while none is live. */
export function PromoSlot({ placement, defaultVariant, style }: { placement: string; defaultVariant?: BannerVariant; style?: StyleProp<ViewStyle> }) {
  const query = useBanners(placement);
  const banners = query.data ?? [];
  if (banners.length === 0) return null;
  return <PromoBanners banners={banners} {...(defaultVariant ? { defaultVariant } : {})} style={style} />;
}

const styles = StyleSheet.create({
  slot: { gap: spacing.md },
  stack: { gap: spacing.md },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  pressed: { opacity: 0.9 },
  caption: { marginTop: spacing.xs },
  split: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  splitCopy: { flex: 1, minWidth: 0 },
  headline: { fontSize: 24, lineHeight: 29, fontWeight: "800", color: colors.textPrimary },
  headlineAccent: { color: palette.green600 },
  subtitle: { marginTop: spacing.xs, fontSize: 14, lineHeight: 19, color: colors.textSecondary },
  cta: {
    alignSelf: "flex-start",
    marginTop: spacing.md,
    paddingHorizontal: spacing.base,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: palette.green600,
    justifyContent: "center",
  },
  ctaText: { fontSize: 14, lineHeight: 18, fontWeight: "800", color: colors.textOnPrimary },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  cardCopy: { flex: 1, minWidth: 0, gap: 2 },
  dots: { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: spacing.sm },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  dotActive: { width: 18, backgroundColor: colors.primary },
});

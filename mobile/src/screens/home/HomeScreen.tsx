import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import React, { useEffect, useState } from "react";

import { Ionicons } from "@expo/vector-icons";
import {
  ArrowRight,
  ChevronRight,
  Leaf,
  ShieldCheck,
  MapPin,
  Zap,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { HomeFeedDto, ProductSummaryDto } from "@shared";

type RailKey = HomeFeedDto["rails"][number]["key"];
import { colors, radius, shadow, spacing } from "@shared/theme";
import { formatDistance } from "@shared/distance";

import { useHomeFeed } from "@/lib/queries";
import { useCartActions } from "@/lib/useCartActions";
import { useLocation } from "@/lib/store";

import {
  AppText,
  ErrorState,
  Loading,
  NoticeStrip,
  Screen,
} from "@/components/ui";

import { ProductCard } from "@/components/ProductCard";
import CategoryIcon from "@/components/CategoryIcon";

import adioneHomeBanner from "../../../assets/adione-homebar.png";

/* =====================================================================
   HOME SCREEN
===================================================================== */

export default function HomeScreen({
  onOpenProduct,
  onOpenCategory,
  onOpenAllCategories,
  onOpenRail,
  onOpenSearch,
  onOpenLocation,
  onOpenProfile,
}: {
  onOpenProduct: (productId: string) => void;
  onOpenCategory: (categoryId: string) => void;
  onOpenAllCategories: () => void;
  onOpenRail: (key: RailKey, title: string) => void;
  onOpenSearch: () => void;
  onOpenLocation: () => void;
  onOpenProfile: () => void;
}) {
  const insets = useSafeAreaInsets();

  const feed = useHomeFeed();
  const cart = useCartActions();

  const { location, serviceability, refresh } = useLocation();

  const { width: windowWidth } = useWindowDimensions();
  const [activeBanner, setActiveBanner] = useState(0);

  useEffect(() => {
    void refresh();

    const interval = setInterval(() => {
      void refresh();
    }, 30000);

    return () => clearInterval(interval);
  }, [refresh]);

  /* ================================================================
     LOADING
  ================================================================ */

  if (feed.isLoading) {
    return <Loading label="Loading store…" />;
  }

  /* ================================================================
     ERROR
  ================================================================ */

  if (feed.isError || !feed.data) {
    const offline =
      (feed.error as { isOffline?: boolean } | null)?.isOffline === true;

    return (
      <ErrorState
        message="We could not load the store."
        offline={offline}
        onRetry={() => void feed.refetch()}
      />
    );
  }

  /* ================================================================
     PRODUCT CARD
  ================================================================ */

  // `cart.add`/`increment`/`decrement`/`onOpenProduct` are stable across
  // renders (see useCartActions), and ProductCard only calls them with a
  // real variant id once its own `variant &&` guard passes — so they can be
  // handed to every card directly, instead of a fresh per-item closure on
  // every render. That's what lets React.memo actually skip re-rendering
  // product B's card when product A's quantity changes.
  const renderProduct = ({ item }: { item: ProductSummaryDto }) => (
    <View style={styles.productWrapper}>
      <ProductCard
        product={item}
        qtyInCart={
          item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0
        }
        busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
        onPress={onOpenProduct}
        onAdd={cart.add}
        onIncrement={cart.increment}
        onDecrement={cart.decrement}
      />
    </View>
  );

  /* ================================================================
     PROMOTIONAL BANNERS

     A small, fixed set — not admin-managed — so this stays exactly the
     same shape as the single banner it replaces, just three of them.
  ================================================================ */

  const bannerSlideWidth = Math.min(640, windowWidth - spacing.base * 2);
  const bannerSlideGap = spacing.sm;

  const banners = [
    {
      id: "free-delivery",
      title: "FREE DELIVERY",
      subtitle: "On orders above ₹299",
      actionLabel: "Shop Now",
      onPress: onOpenSearch,
    },
    {
      id: "fresh-produce",
      title: "FRESH FRUITS & VEGETABLES",
      subtitle: "Farm-fresh, delivered fast",
      actionLabel: "Explore",
      onPress: onOpenAllCategories,
    },
    {
      id: "daily-essentials",
      title: "DAILY ESSENTIALS",
      subtitle: "Everything you need, everyday",
      actionLabel: "Shop Now",
      onPress: () => onOpenRail("DAILY_ESSENTIALS", "Daily Essentials"),
    },
  ];

  /* ================================================================
     HOME SECTION ORDER

     A fixed, requested layout — Daily Essentials, then the produce
     category shelf, then Offers, Best Sellers, and Popular (which the
     backend now randomizes rather than ranks — see catalog.repository.ts)
     last. This replaces looping over `rails` and `categoryRails`
     separately in whatever order the API happened to return them, which
     is what let "Popular" and "Daily Essentials" end up showing the exact
     same fixed top-10 every time.
  ================================================================ */

  const railByKey = new Map(feed.data.rails.map((rail) => [rail.key, rail]));
  // Only the highest-priority category shelf is featured on Home — see
  // catalog.service.ts, `categoryRails` is ordered by the category's own
  // `displayOrder`, so this is whichever category the store has configured
  // to come first (Vegetables & Fruits, currently).
  const featuredCategoryRail = feed.data.categoryRails?.[0] ?? null;

  type HomeSection =
    | { kind: "rail"; rail: HomeFeedDto["rails"][number] }
    | { kind: "category"; rail: HomeFeedDto["categoryRails"][number] };

  const homeSections: HomeSection[] = [
    railByKey.get("DAILY_ESSENTIALS"),
    featuredCategoryRail,
    railByKey.get("OFFERS"),
    railByKey.get("BEST_SELLERS"),
    railByKey.get("POPULAR"),
  ]
    .filter((entry): entry is NonNullable<typeof entry> => entry != null)
    .map((entry) =>
      "categoryId" in entry
        ? { kind: "category" as const, rail: entry }
        : { kind: "rail" as const, rail: entry },
    );

  return (
    <Screen style={styles.screen}>
      {/* ============================================================
          TOP LOCATION HEADER
      ============================================================ */}

      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 4,
          },
        ]}
      >
        {/* ----------------------------------------------------------
            LOCATION
        ---------------------------------------------------------- */}

        <Pressable
          onPress={onOpenLocation}
          style={styles.locationSection}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Change delivery location"
        >
          {/* Location Icon */}

          <View style={styles.locationPin}>
            <Ionicons
              name="location-outline"
              size={19}
              color={colors.primary}
            />
          </View>

          {/* Location Text */}

          <View style={styles.locationText}>
            <AppText
              variant="caption"
              color={colors.textSecondary}
              style={styles.deliveringText}
            >
              Delivering to
            </AppText>

            <AppText
              variant="bodyStrong"
              numberOfLines={1}
              style={styles.locationLabel}
            >
              {location?.label ?? "Select a location"}
            </AppText>

            {serviceability?.serviceable && (
              <AppText
                variant="caption"
                color={colors.primary}
                style={styles.distanceText}
              >
                {formatDistance(serviceability.distanceKm)} away from store
              </AppText>
            )}
          </View>

          {/* Chevron */}

          <View style={styles.chevronContainer}>
            <Ionicons
              name="chevron-down"
              size={18}
              color={colors.textSecondary}
            />
          </View>
        </Pressable>

        {/* ----------------------------------------------------------
            ACCOUNT
        ---------------------------------------------------------- */}

        <Pressable
          onPress={onOpenProfile}
          style={styles.profileButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open account"
        >
          <Ionicons name="person-circle" size={38} color={colors.primary} />
        </Pressable>
      </View>

      {/* ============================================================
          SCROLLABLE HOME
      ============================================================ */}

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: insets.bottom + spacing.xxl,
        }}
      >
        {/* ========================================================
            SEARCH
        ======================================================== */}

        <Pressable
          onPress={onOpenSearch}
          style={styles.searchBar}
          accessibilityRole="button"
          accessibilityLabel="Search products"
        >
          <Ionicons
            name="search-outline"
            size={20}
            color={colors.textMuted}
            style={styles.searchIcon}
          />

          <AppText
            variant="body"
            color={colors.textMuted}
            style={styles.searchPlaceholder}
          >
            Search for atta, rice, dal, oil…
          </AppText>

          {/* <Ionicons name="mic-outline" size={19} color={colors.textMuted} /> */}
        </Pressable>

        {/* ========================================================
            SERVICEABILITY / CART NOTICES
        ======================================================== */}

        {cart.error && (
          <View style={styles.noticeContainer}>
            <NoticeStrip message={cart.error} />
          </View>
        )}

        {serviceability && !serviceability.serviceable && (
          <View style={styles.noticeContainer}>
            <NoticeStrip
              message="We don't deliver to your location yet — you can browse, but ordering is unavailable."
              tone="info"
            />
          </View>
        )}

        {serviceability?.storeOpen === false && (
          <View style={styles.noticeContainer}>
            <NoticeStrip message="The store is closed right now. You can still add items and order when we open." />
          </View>
        )}

        {/* ========================================================
            PROMOTIONAL BANNERS — swipeable, with a dot indicator
        ======================================================== */}

        <View style={styles.bannerCarousel}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={bannerSlideWidth + bannerSlideGap}
            snapToAlignment="start"
            contentContainerStyle={{ paddingHorizontal: spacing.base }}
            onMomentumScrollEnd={(event) => {
              const index = Math.round(
                event.nativeEvent.contentOffset.x /
                  (bannerSlideWidth + bannerSlideGap),
              );
              setActiveBanner(
                Math.max(0, Math.min(banners.length - 1, index)),
              );
            }}
          >
            {banners.map((item, index) => (
              <View
                key={item.id}
                style={[
                  styles.bannerWrapper,
                  {
                    width: bannerSlideWidth,
                    marginRight:
                      index === banners.length - 1 ? 0 : bannerSlideGap,
                  },
                ]}
              >
                <Image
                  source={adioneHomeBanner}
                  style={styles.banner}
                  resizeMode="cover"
                  accessibilityLabel={item.title}
                />

                {/* Very light overlay only */}

                <View style={styles.bannerOverlay} />

                {/* ------------------------------------------------
                    Banner Content
                ------------------------------------------------ */}

                <View style={styles.bannerContent}>
                  <AppText style={styles.bannerTitle}>{item.title}</AppText>

                  <AppText style={styles.bannerSubtitle}>
                    {item.subtitle}
                  </AppText>

                  <Pressable
                    onPress={item.onPress}
                    style={styles.shopNowButton}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={item.actionLabel}
                  >
                    <AppText style={styles.shopNowText}>
                      {item.actionLabel}
                    </AppText>
                    <ArrowRight size={13} color="#FFFFFF" strokeWidth={2.5} />
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>

          {banners.length > 1 && (
            <View style={styles.bannerDots}>
              {banners.map((item, index) => (
                <View
                  key={item.id}
                  style={[
                    styles.bannerDot,
                    index === activeBanner && styles.bannerDotActive,
                  ]}
                />
              ))}
            </View>
          )}
        </View>

        {/* ========================================================
            CATEGORIES
        ======================================================== */}

        <SectionHeader title="Categories" onSeeAll={onOpenAllCategories} />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryRow}
        >
          {feed.data.categories
            // `children` is `[]` (not undefined) for a top-level category
            // that has no subcategories of its own — e.g. "Vegetables &
            // Fruits", added as its own root with no children beneath it.
            // `?? [category]` only catches null/undefined, so an empty
            // array silently produced zero icons for it. `.length` catches
            // both cases.
            .flatMap((category) =>
              category.children?.length ? category.children : [category],
            )
            .map((category) => (
              <Pressable
                key={category.id}
                onPress={() => onOpenCategory(category.id)}
                style={styles.categoryTile}
                accessibilityRole="button"
                accessibilityLabel={`Open ${category.name}`}
              >
                <View style={styles.categoryCircle}>
                  <CategoryIcon
                    name={category.name}
                    imageUrl={category.imageUrl}
                    size={56}
                  />
                </View>

                <AppText
                  variant="caption"
                  numberOfLines={2}
                  style={styles.categoryName}
                >
                  {category.name}
                </AppText>
              </Pressable>
            ))}
        </ScrollView>

        {/* ========================================================
            PRODUCT RAILS — Daily Essentials, the featured category shelf,
            Offers, Best Sellers, then Popular, in that fixed order.
        ======================================================== */}

        {homeSections.map((section) => (
          <View
            key={
              section.kind === "rail"
                ? section.rail.key
                : section.rail.categoryId
            }
            style={styles.rail}
          >
            <SectionHeader
              title={section.rail.title}
              onSeeAll={() =>
                section.kind === "rail"
                  ? onOpenRail(section.rail.key, section.rail.title)
                  : onOpenCategory(section.rail.categoryId)
              }
            />

            <FlatList
              horizontal
              data={section.rail.products}
              keyExtractor={(item) => item.id}
              renderItem={renderProduct}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.productRow}
              getItemLayout={(_data, index) => ({
                length: 140,
                offset: 140 * index,
                index,
              })}
            />
          </View>
        ))}

        {/* ========================================================
            TRUST STRIP
        ======================================================== */}

        <View style={styles.trustStrip}>
          <TrustBadge
            icon={Leaf}
            label="Fresh Products"
            hint="From local stores"
          />
          <TrustBadge icon={Zap} label="Fast Delivery" hint="10–20 mins" />
          <TrustBadge
            icon={ShieldCheck}
            label="Trusted & Safe"
            hint="Quality you can rely on"
          />
          <TrustBadge
            icon={MapPin}
            label="Local Business"
            hint="Supporting our community"
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

/* =====================================================================
   TRUST BADGE
===================================================================== */

function TrustBadge({
  icon: Icon,
  label,
  hint,
}: {
  icon: typeof Leaf;
  label: string;
  hint: string;
}) {
  return (
    <View style={styles.trustBadge}>
      <View style={styles.trustIcon}>
        <Icon size={18} color={colors.primary} strokeWidth={2} />
      </View>
      <AppText variant="caption" style={styles.trustLabel}>
        {label}
      </AppText>
      <AppText
        variant="overline"
        color={colors.textSecondary}
        style={styles.trustHint}
      >
        {hint}
      </AppText>
    </View>
  );
}

/* =====================================================================
   SECTION HEADER
===================================================================== */

function SectionHeader({
  title,
  onSeeAll,
}: {
  title: string;
  onSeeAll: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <AppText variant="h2" style={styles.sectionTitle}>
        {title}
      </AppText>

      <Pressable
        onPress={onSeeAll}
        hitSlop={8}
        style={styles.seeAllButton}
        accessibilityRole="button"
        accessibilityLabel={`See all ${title}`}
      >
        <AppText
          variant="bodyStrong"
          color={colors.primary}
          style={styles.seeAll}
        >
          See All
        </AppText>
        <ChevronRight size={16} color={colors.primary} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

/* =====================================================================
   STYLES
===================================================================== */

const styles = StyleSheet.create({
  /* ================================================================
     SCREEN
  ================================================================ */

  screen: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: colors.surface,
  },

  /* ================================================================
     HEADER
  ================================================================ */

  header: {
    flexDirection: "row",
    alignItems: "center",

    paddingHorizontal: spacing.base,

    paddingBottom: 8,

    backgroundColor: colors.surface,

    borderBottomWidth: 1,

    borderBottomColor: colors.divider,
  },

  /* ================================================================
     LOCATION SECTION
  ================================================================ */

  locationSection: {
    flex: 1,

    minHeight: 42,

    flexDirection: "row",

    alignItems: "center",

    // Keeps the location area shorter and creates
    // clear space before the account button.
    marginRight: 90,
  },

  /* ================================================================
     LOCATION ICON
  ================================================================ */

  locationPin: {
    width: 32,

    height: 32,

    borderRadius: radius.circle,

    backgroundColor: colors.primarySurface,

    alignItems: "center",

    justifyContent: "center",

    marginRight: 8,
  },

  /* ================================================================
     LOCATION TEXT
  ================================================================ */

  locationText: {
    flex: 1,

    justifyContent: "center",

    minWidth: 0,
  },

  deliveringText: {
    fontSize: 10,

    lineHeight: 13,

    marginBottom: 0,
  },

  locationLabel: {
    fontSize: 12,

    lineHeight: 18,

    fontWeight: "700",

    maxWidth: "100%",
  },

  distanceText: {
    fontSize: 10,

    lineHeight: 13,

    marginTop: 0,
  },

  /* ================================================================
     CHEVRON
  ================================================================ */

  chevronContainer: {
    width: 22,

    height: 22,

    marginLeft: 3,

    alignItems: "center",

    justifyContent: "center",
  },

  /* ================================================================
     ACCOUNT BUTTON
  ================================================================ */

  profileButton: {
    width: 42,

    height: 42,

    alignItems: "center",

    justifyContent: "center",

    marginLeft: 0,
  },

  /* ================================================================
     SEARCH
  ================================================================ */

  searchBar: {
    marginHorizontal: spacing.base,

    marginTop: spacing.md,

    minHeight: 44,

    borderRadius: radius.pill,

    borderWidth: 1,

    borderColor: colors.border,

    backgroundColor: colors.surface,

    flexDirection: "row",

    alignItems: "center",

    paddingHorizontal: 13,
  },

  searchIcon: {
    marginRight: 8,
  },

  searchPlaceholder: {
    flex: 1,

    fontSize: 13,

    lineHeight: 18,
  },

  /* ================================================================
     NOTICES
  ================================================================ */

  noticeContainer: {
    paddingHorizontal: spacing.base,

    marginTop: spacing.sm,
  },

  /* ================================================================
     BANNER
  ================================================================ */

  bannerCarousel: {
    marginTop: spacing.md,
  },

  bannerWrapper: {
    // Matches the source banner's own proportions (1653x569) so `cover`
    // crops the same small sliver on every screen width instead of an
    // ever-larger chunk as the device gets wider than a phone — on a
    // tablet, a fixed height here forced a wide, short crop that sliced
    // most of the artwork away. Width itself is set per-slide from JS
    // (see `bannerSlideWidth`), capped the same way `maxWidth: 640` used to.
    aspectRatio: 1653 / 569,

    borderRadius: radius.lg,

    overflow: "hidden",

    backgroundColor: colors.primarySurface,

    position: "relative",
  },

  bannerDots: {
    flexDirection: "row",

    justifyContent: "center",

    alignItems: "center",

    gap: 6,

    marginTop: spacing.sm,
  },

  bannerDot: {
    width: 6,

    height: 6,

    borderRadius: 3,

    backgroundColor: colors.border,
  },

  bannerDotActive: {
    width: 16,

    backgroundColor: colors.primary,
  },

  banner: {
    position: "absolute",

    width: "100%",

    height: "100%",

    left: 0,

    top: 0,
  },

  bannerOverlay: {
    position: "absolute",

    left: 0,

    top: 0,

    right: 0,

    bottom: 0,

    backgroundColor: "rgba(255,255,255,0.04)",
  },

  bannerContent: {
    position: "absolute",

    left: 16,

    top: 17,

    zIndex: 5,
  },

  bannerTitle: {
    fontSize: 17,

    lineHeight: 21,

    fontWeight: "800",

    color: colors.primary,
  },

  bannerSubtitle: {
    fontSize: 12,

    lineHeight: 17,

    fontWeight: "600",

    color: colors.textPrimary,

    marginTop: 2,
  },

  /* ================================================================
     SHOP NOW
  ================================================================ */

  shopNowButton: {
    marginTop: 9,

    paddingHorizontal: 13,

    minHeight: 29,

    borderRadius: 7,

    backgroundColor: colors.primary,

    flexDirection: "row",

    alignItems: "center",

    justifyContent: "center",

    gap: 4,

    alignSelf: "flex-start",
  },

  shopNowText: {
    color: "#FFFFFF",

    fontSize: 11,

    lineHeight: 14,

    fontWeight: "700",
  },

  /* ================================================================
     SECTION HEADER
  ================================================================ */

  sectionHeader: {
    flexDirection: "row",

    alignItems: "center",

    justifyContent: "space-between",

    paddingHorizontal: spacing.base,

    marginTop: spacing.lg,

    marginBottom: spacing.sm,
  },

  sectionTitle: {
    fontSize: 22,

    lineHeight: 28,

    fontWeight: "800",

    color: colors.textPrimary,
  },

  seeAllButton: {
    flexDirection: "row",

    alignItems: "center",

    gap: 1,
  },

  seeAll: {
    fontSize: 14,

    lineHeight: 20,

    fontWeight: "700",
  },

  /* ================================================================
     CATEGORIES
  ================================================================ */

  categoryRow: {
    paddingHorizontal: spacing.base,

    gap: 12,

    paddingBottom: spacing.sm,
  },

  categoryTile: {
    width: 76,

    alignItems: "center",
  },

  categoryCircle: {
    width: 64,

    height: 64,

    borderRadius: 32,

    backgroundColor: colors.surface,

    borderWidth: 1,

    borderColor: colors.border,

    alignItems: "center",

    justifyContent: "center",

    ...shadow.sm,
  },

  categoryName: {
    textAlign: "center",

    marginTop: spacing.xs,

    fontSize: 12,

    lineHeight: 17,

    fontWeight: "600",

    color: colors.textPrimary,
  },

  /* ================================================================
     PRODUCT RAILS
  ================================================================ */

  rail: {
    marginTop: spacing.xs,
  },

  productRow: {
    paddingHorizontal: spacing.base,

    gap: 8,
  },

  productWrapper: {
    width: 132,
  },

  /* ================================================================
     TRUST STRIP
  ================================================================ */

  trustStrip: {
    flexDirection: "row",

    flexWrap: "wrap",

    marginHorizontal: spacing.base,

    marginTop: spacing.xl,

    marginBottom: spacing.base,

    borderRadius: radius.lg,

    borderWidth: 1,

    borderColor: colors.divider,

    backgroundColor: colors.surfaceMuted,

    padding: spacing.base,

    gap: spacing.md,
  },

  trustBadge: {
    width: "47%",

    alignItems: "flex-start",
  },

  trustIcon: {
    width: 34,

    height: 34,

    borderRadius: radius.circle,

    backgroundColor: colors.primarySurface,

    alignItems: "center",

    justifyContent: "center",

    marginBottom: spacing.xs,
  },

  trustLabel: {
    fontWeight: "700",

    color: colors.textPrimary,
  },

  trustHint: {
    marginTop: 1,
  },
});

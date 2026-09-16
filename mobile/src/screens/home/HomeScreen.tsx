import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import React, { useEffect } from "react";

import { Ionicons } from "@expo/vector-icons";
import { ArrowRight, ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ProductSummaryDto } from "@shared";
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
  onOpenSearch,
  onOpenLocation,
  onOpenProfile,
}: {
  onOpenProduct: (productId: string) => void;
  onOpenCategory: (categoryId: string) => void;
  onOpenSearch: () => void;
  onOpenLocation: () => void;
  onOpenProfile: () => void;
}) {
  const insets = useSafeAreaInsets();

  const feed = useHomeFeed();
  const cart = useCartActions();

  const { location, serviceability, refresh } = useLocation();

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

  const renderProduct = ({ item }: { item: ProductSummaryDto }) => (
    <View style={styles.productWrapper}>
      <ProductCard
        product={item}
        qtyInCart={
          item.defaultVariant ? cart.qtyFor(item.defaultVariant.id) : 0
        }
        busy={item.defaultVariant ? cart.isBusy(item.defaultVariant.id) : false}
        onPress={() => onOpenProduct(item.id)}
        onAdd={() =>
          item.defaultVariant && void cart.add(item.defaultVariant.id)
        }
        onIncrement={() =>
          item.defaultVariant && void cart.increment(item.defaultVariant.id)
        }
        onDecrement={() =>
          item.defaultVariant && void cart.decrement(item.defaultVariant.id)
        }
      />
    </View>
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
          <Ionicons
            name="person-outline"
            size={21}
            color={colors.textSecondary}
          />
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
            PROMOTIONAL BANNER
        ======================================================== */}

        <View style={styles.bannerWrapper}>
          <Image
            source={adioneHomeBanner}
            style={styles.banner}
            resizeMode="cover"
            accessibilityLabel="AdiOne delivery promotion"
          />

          {/* Very light overlay only */}

          <View style={styles.bannerOverlay} />

          {/* ------------------------------------------------------
              Banner Content
          ------------------------------------------------------ */}

          <View style={styles.bannerContent}>
            <AppText style={styles.bannerTitle}>FREE DELIVERY</AppText>

            <AppText style={styles.bannerSubtitle}>
              On orders above ₹299
            </AppText>

            {/* --------------------------------------------------
                SHOP NOW
            -------------------------------------------------- */}

            <Pressable
              onPress={onOpenSearch}
              style={styles.shopNowButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Shop now"
            >
              <AppText style={styles.shopNowText}>Shop Now</AppText>
              <ArrowRight size={13} color="#FFFFFF" strokeWidth={2.5} />
            </Pressable>
          </View>

          {/* IMPORTANT:
              No extra "10 Delivery" badge here.
          */}
        </View>

        {/* ========================================================
            CATEGORIES
        ======================================================== */}

        <SectionHeader title="Categories" onSeeAll={() => undefined} />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryRow}
        >
          {feed.data.categories
            .flatMap((category) => category.children ?? [category])
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
            PRODUCT RAILS
        ======================================================== */}

        {feed.data.rails.map((rail) => (
          <View key={rail.key} style={styles.rail}>
            <SectionHeader title={rail.title} onSeeAll={() => undefined} />

            <FlatList
              horizontal
              data={rail.products}
              keyExtractor={(item) => item.id}
              renderItem={renderProduct}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.productRow}
              getItemLayout={(_data, index) => ({
                length: 162,
                offset: 162 * index,
                index,
              })}
            />
          </View>
        ))}
      </ScrollView>
    </Screen>
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
    marginRight: 100,
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

    borderRadius: 21,

    borderWidth: 1,

    borderColor: colors.border,

    backgroundColor: colors.primarySurface,

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

  bannerWrapper: {
    marginHorizontal: spacing.base,

    marginTop: spacing.md,

    height: 124,

    borderRadius: radius.lg,

    overflow: "hidden",

    backgroundColor: colors.primarySurface,

    position: "relative",
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
    width: 154,
  },
});

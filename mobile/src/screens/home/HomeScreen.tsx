import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import ReanimatedAnimated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Ionicons } from "@expo/vector-icons";
import { ChevronRight, Package } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";

import { HOME_SPACING_DP, contentColor, type CategoryDto } from "@shared";
import { colors, radius, spacing } from "@shared/theme";

import {
  useHomeFeed,
  usePublicConfig,
  useNotificationUnreadCount,
  useOffers,
  useOrders,
  usePreviouslyOrdered,
  useRestaurants,
  useStores,
} from "@/lib/queries";
import { formatUnreadBadge } from "@/lib/notifications";
import { outOfAreaDetail } from "@/lib/deliveryArea";
import { useCartError } from "@/lib/useCartActions";
import { useLocation, usePreferences } from "@/lib/store";
import { isActiveLiveDestination, liveLocationLabel } from "@/lib/liveLocation";
import { openBannerAction } from "@/lib/bannerAction";

import BrandMark from "@/components/BrandMark";
import { AppText, ErrorState, NoticeStrip, Screen } from "@/components/ui";

import {
  tabBarHiddenByScroll,
  useTabBarClearance,
} from "@/lib/tabBarVisibility";

import {
  buildHomeSections,
  type HomeAction,
  type HomeSection,
  type RailKey,
} from "./homeEngine";

import { CategoryGrid } from "./sections/CategoryGrid";
import { FoodSection } from "./sections/FoodSection";
import { HomeSkeleton } from "./sections/HomeSkeleton";
import { OfferSection } from "./sections/OfferSection";
import { ProductShelf, SHELF_CARD_WIDTH } from "./sections/ProductShelf";
import { PromoCarousel } from "./sections/PromoCarousel";
import { HOME_BACKGROUND } from "./sections/SectionShell";
import { FoodCarousel } from "./sections/FoodCarousel";
import { LatestProducts } from "./sections/LatestProducts";
import { HomeHero, heroHeaderColor } from "./sections/HomeHero";
import { applyHomeLayout, type LaidOutSection } from "./homeLayout";
import { useHomeLayout, useHomeShelves } from "@/lib/homeLayoutQuery";
import { StoreSection } from "./sections/StoreSection";

const NO_RESULTS: never[] = [];

/** Scroll distance (dp) over which the header's solid fill fades in. */
const OVERLAY_FILL_SCROLL = 12;

function RestaurantBanner({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Explore local restaurants"
      style={styles.restaurantBanner}
    >
      <Image
        source={require("../../../assets/restaurant-banner.png")}
        style={styles.restaurantBannerImage}
        resizeMode="cover"
      />
    </Pressable>
  );
}

/* =====================================================================
   ANIMATED SEARCH PLACEHOLDER

   Cycles through example queries (fade + slide, the same idea as
   ProductCard's AnimatedQuantity) instead of sitting on one static line —
   the quick-commerce apps this design follows use the same "rotating
   placeholder" cue to hint at what's searchable without the customer
   having to tap in first. The phrases are built from the live category
   tree (see `searchPhrases`), so they only ever suggest things the
   catalogue actually has.
===================================================================== */

const DEFAULT_SEARCH_PHRASE = "Search products, brands & more…";
const MAX_SEARCH_PHRASES = 8;

function searchPhrases(
  categories: readonly CategoryDto[] | undefined,
): string[] {
  const names = (categories ?? []).flatMap((category) => [
    category.name,
    ...(category.children ?? []).map((child) => child.name),
  ]);
  return [
    DEFAULT_SEARCH_PHRASE,
    ...[...new Set(names)]
      .slice(0, MAX_SEARCH_PHRASES)
      .map((name) => `Search for ${name.toLowerCase()}…`),
  ];
}

const PLACEHOLDER_HOLD_MS = 2200;
const PLACEHOLDER_ANIM_MS = 280;

function AnimatedSearchPlaceholder({ phrases }: { phrases: string[] }) {
  const [index, setIndex] = useState(0);
  const anim = useRef(new Animated.Value(1)).current;
  const count = phrases.length;

  useEffect(() => {
    if (count <= 1) return;
    const timer = setInterval(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: PLACEHOLDER_ANIM_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setIndex((current) => (current + 1) % count);
        anim.setValue(0);
        Animated.timing(anim, {
          toValue: 1,
          duration: PLACEHOLDER_ANIM_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
    }, PLACEHOLDER_HOLD_MS);

    return () => clearInterval(timer);
  }, [anim, count]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  return (
    <View style={styles.searchPlaceholderClip}>
      <Animated.Text
        numberOfLines={1}
        style={[
          styles.searchPlaceholder,
          {
            color: colors.textMuted,
            opacity: anim,
            transform: [{ translateY }],
          },
        ]}
      >
        {phrases[index % Math.max(1, count)] ?? DEFAULT_SEARCH_PHRASE}
      </Animated.Text>
    </View>
  );
}

/* =====================================================================
   HOME SCREEN

   A long, virtualized discovery feed. This component only orchestrates:
   it fetches (one Home feed call — categories, shelves, rails and every
   admin banner — plus stores / restaurants / offers and the customer's
   previously ordered products), hands everything to the section engine
   (homeEngine.ts — section order, duplicate control, banner slots), and
   renders whatever sections come back. Nothing about the catalogue is
   written here.
===================================================================== */

export default function HomeScreen({
  onOpenProduct,
  onOpenCategory,
  onOpenAllCategories,
  onOpenRail,
  onOpenSearch,
  onOpenLocation,
  onOpenCart,
  onOpenProfile,
  onOpenOrders,
  onOpenNotifications,
  onOpenOrderTracking,
  onOpenRestaurant,
  onOpenStore,
  onOpenFood,
}: {
  onOpenProduct: (productId: string) => void;
  onOpenCategory: (categoryId: string) => void;
  onOpenAllCategories: () => void;
  onOpenRail: (key: RailKey, title: string) => void;
  onOpenSearch: () => void;
  onOpenLocation: () => void;
  onOpenCart: () => void;
  onOpenOrders: () => void;
  onOpenNotifications: () => void;
  onOpenOrderTracking: (orderId: string) => void;
  onOpenRestaurant: (sellerId: string) => void;
  onOpenStore: (sellerId: string) => void;
  onOpenFood: () => void;
  onOpenProfile: () => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  // The bell's badge. Polled only while Home is the visible screen — the
  // tab stays mounted behind other tabs and has no reason to ask then.
  const isFocused = useIsFocused();
  const unreadNotifications =
    useNotificationUnreadCount({ poll: isFocused }).data ?? 0;

  const feed = useHomeFeed();
  // App-wide ordering switch (admin): paused = browse and fill the cart, no orders.
  const publicConfig = usePublicConfig().data;
  const orderingPaused = publicConfig?.ORDERING_ENABLED === false;
  // Only the shared cart error — Home does NOT subscribe to the cart
  // itself: each ProductShelf does, so a quantity tap re-renders the shelves,
  // not this whole screen.
  const cartError = useCartError();
  const previouslyOrdered = usePreviouslyOrdered();

  // The most recent order that's still ONGOING (not delivered/cancelled/
  // rejected/failed/refunded — see `bucket`, computed server-side in
  // OrderSummaryDto) — surfaced as a banner below so a customer with an
  // order already in flight can check on it without losing the NEW,
  // already-empty cart they're free to build in the meantime (see
  // useCartActions.ts's `resetPendingCartAfterOrder` for the other half of
  // that: placing an order no longer leaves its own items stuck showing in
  // the Mini Cart). `orders.data.items` is already newest-first (server
  // returns them in placement order), so the first ONGOING one found is
  // the most recent.
  const orders = useOrders();
  const ongoingOrder =
    orders.data?.items.find((order) => order.bucket === "ONGOING") ?? null;

  const { location, liveDestination, serviceability, refresh } = useLocation();
  // A live GPS location is named by its FULL address, from the stored
  // destination itself (not a shortened label saved earlier).
  const locationLabel = isActiveLiveDestination(liveDestination, location)
    ? liveLocationLabel(liveDestination)
    : location?.label;

  const { height: windowHeight } = useWindowDimensions();

  // Collapses the address/profile row as the page scrolls, leaving the
  // search bar as the only thing left looking pinned at the top.
  // `headerHeight` is measured once from the row's own natural layout (it
  // varies by device — depends on `insets.top`) rather than hard-coded, so
  // the collapse always starts from its real expanded distance with no
  // jump. `overlayHeight` is the SAME kind of one-time measurement, but of
  // the whole header+search-bar block — see its own use below.
  //
  // This whole block (header + search bar) is rendered as an ABSOLUTELY
  // POSITIONED OVERLAY on top of the ScrollView, not a normal-flow sibling
  // above it (see the JSX below) — deliberately, so that collapsing it can
  // only ever move ITSELF via `transform`, never resize or reflow the
  // ScrollView (and therefore the product content) underneath. An earlier
  // version animated this block's actual `height`/`marginTop` in normal
  // flow: since the ScrollView was a flex sibling right below it, every
  // point those layout properties changed shifted the ScrollView's own top
  // edge too — and because they were driven directly off raw `scrollY` with
  // no threshold or smoothing at all (unlike `tabBarHiddenByScroll` below,
  // which already had hysteresis), even the smallest sub-pixel scrollY
  // wobble during a slow drag or a held-finger tremor reflowed the entire
  // page beneath it on every single frame — reading as constant product-card/
  // image jitter, exactly the "whole page shakes" bug this fixes.
  //
  // `scrollY` is a Reanimated SHARED VALUE, not an RN `Animated.Value` —
  // `headerAnimatedStyle`/`searchBarAnimatedStyle` below read it inside
  // `useAnimatedStyle` worklets, which run the transform/opacity
  // recalculation directly on the UI thread every frame, with no layout
  // pass at all (a `transform` is purely a compositor-level change) — even
  // cheaper than the old height-based version was, on top of no longer
  // being able to move anything else on screen.
  const scrollY = useSharedValue(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  // The whole overlay's own natural (untransformed) height — insets.top +
  // the header row + the search bar. Used as the ScrollView's constant
  // `paddingTop` (see its `contentContainerStyle` below) so the first row
  // of real content starts exactly where this overlay visually ends at
  // scrollY=0, and stays in sync with it at every scroll position after
  // that — since both the overlay's collapse progress and the ScrollView's
  // own contentOffset are driven by the identical `scrollY` value.
  const [overlayHeight, setOverlayHeight] = useState(0);

  // Bottom tab bar hides on scroll-down, reappears on scroll-up or back
  // near the top — see MainTabs' `AnimatedTabBar`, which reads
  // `tabBarHiddenByScroll` (a module-scoped Reanimated shared value, see
  // tabBarVisibility.ts) directly. `lastScrollY`/`lastDirectionCheckMs` are
  // shared values purely so this worklet has somewhere to keep its own
  // running state between calls — using React refs here wouldn't work,
  // refs aren't reachable from the UI-thread worklet this runs in.
  //
  // `lastScrollY` is a HYSTERESIS ANCHOR, not "the position last sample" —
  // see `scrollHandler` below for why it only ever moves when a direction
  // decision has actually been acted on, never on every sample.
  //
  // Time-gated to roughly 8/sec — `scrollEventThrottle` below still fires
  // this on every native scroll event (needed for the header-collapse
  // animation's own smoothness), but re-running direction detection on
  // literally every one of those has no visible benefit: nobody can
  // perceive "hide the tab bar" reacting inside 16ms vs ~120ms. This all
  // runs as a worklet on the UI thread — the 120ms gate is just to avoid
  // redundant comparisons, not to protect the JS thread (there's no JS
  // thread involvement here at all).
  const lastScrollY = useSharedValue(0);
  const lastDirectionCheckMs = useSharedValue(0);
  // Separate cooldown on the FLIP itself (not just the 120ms sampling gate
  // above) — see `scrollHandler` below for why this is what actually stops
  // the visible blinking during a slow, tightly-held drag.
  const lastFlipMs = useSharedValue(0);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      scrollY.value = y;

      const now = Date.now();
      if (now - lastDirectionCheckMs.value < 120) return;
      lastDirectionCheckMs.value = now;

      // Measured against the ANCHOR (see below), not "y 120ms ago".
      const delta = y - lastScrollY.value;

      // A slow, tightly-held drag isn't one smooth direction — natural hand
      // tremor at low speed makes the delta wobble back and forth across
      // the +/-6px threshold from one 120ms sample to the next. This
      // cooldown rate-limits how often a flip can fire, but on its own it
      // doesn't stop the wobble from RE-tripping a flip every time it
      // expires — with the old code re-anchoring `lastScrollY` to the
      // current position on every single sample (a rolling ~120ms window),
      // tremor kept crossing the threshold again and again, so the bar
      // (and MiniCartBar, and the tab bar's own reserved layout height —
      // see AnimatedTabBar) kept pulsing hidden/visible for as long as the
      // hold continued, reading as the whole page jittering. A confident
      // scroll, fast or slow, never trips this: its deltas stay
      // consistently one-directional, so it only ever needs to flip once
      // every so often anyway.
      if (now - lastFlipMs.value < 320) return;

      let next = tabBarHiddenByScroll.value;
      if (y <= 4) {
        next = false;
      } else if (delta > 6) {
        next = true;
      } else if (delta < -6) {
        next = false;
      } else {
        // No meaningful net movement since the anchor — leave it exactly
        // where it is. This is what makes the threshold a real "moved 6px
        // since the last decision" check instead of "moved 6px since
        // whatever arbitrary instant the last 120ms-gated sample landed
        // on" — tremor that wobbles back and forth around a roughly fixed
        // position can never accumulate past the threshold no matter how
        // many samples it crosses, because it's always measured from the
        // same fixed point rather than from itself one sample ago.
        return;
      }

      // Only re-anchor once a real decision (a threshold crossing, or the
      // near-top reset) has actually been acted on — never unconditionally.
      lastScrollY.value = y;

      if (next !== tabBarHiddenByScroll.value) {
        tabBarHiddenByScroll.value = next;
        lastFlipMs.value = now;
      }
    },
  });

  const headerAnimatedStyle = useAnimatedStyle(() => {
    if (headerHeight === 0) return {};
    return {
      // Slides fully out of its own natural slot over exactly its own
      // height of scroll — replaces the old `height: headerHeight -> 0`
      // collapse with a transform that moves the SAME visual distance
      // without ever changing this view's actual layout size.
      //
      // Deliberately NO `opacity` here anymore (see `headerContentAnimatedStyle`
      // below for where that moved) — this view's own `backgroundColor:
      // colors.surface` (see `styles.header`) needs to stay fully opaque as
      // it translates, not fade away with its content. Its bottom edge
      // moves by the exact same `headerHeight` as the search bar below
      // (`searchBarAnimatedStyle`), so it always ends exactly at the search
      // bar's current top edge, never past it — that's what turns this
      // view's own natural white background into the fill for the empty
      // gap that otherwise opens up above the search bar once the address/
      // profile content (now faded, see below) has visually "collapsed"
      // but the geometry hasn't finished catching up yet. No extra view,
      // no height change: the SAME translateY this already had, just no
      // longer fading the surface color along with the text.
      transform: [
        {
          translateY: interpolate(
            scrollY.value,
            [0, headerHeight],
            [0, -headerHeight],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [headerHeight]);

  // Fades ONLY the address/profile row's own content — the outer
  // `headerAnimatedStyle` view it sits inside keeps its background fully
  // opaque throughout (see that style's own comment for why). Same
  // interpolation range as before, so the content fades exactly as it
  // already did.
  const headerContentAnimatedStyle = useAnimatedStyle(() => {
    if (headerHeight === 0) return {};
    return {
      opacity: interpolate(
        scrollY.value,
        [0, headerHeight * 0.6],
        [1, 0],
        Extrapolation.CLAMP,
      ),
    };
  }, [headerHeight]);

  // Static `marginTop: spacing.md` lives in `styles.searchBarRow` (constant
  // — never animated, see the JSX below). This moves the search bar by
  // EXACTLY the same distance as `headerAnimatedStyle` above (`headerHeight`
  // — not `headerHeight` plus some extra "tightening" amount, which an
  // earlier version of this had). That match matters beyond just the visual
  // motion: the ScrollView's own `paddingTop` (see its contentContainerStyle
  // below) is the header+search-bar block's FULL NATURAL height, and the
  // content's effective top edge only ends up flush against the collapsed
  // search bar's bottom edge if BOTH move by the identical amount. Any
  // mismatch between the two leaves a permanent gap between the docked
  // search bar and the scrolled content for the rest of the scroll — which
  // is exactly the "white space under the search bar" bug this fixes; it
  // was never a header/content sync issue, purely this row moving a few
  // extra pixels further than the header did.
  const searchBarAnimatedStyle = useAnimatedStyle(() => {
    if (headerHeight === 0) return {};
    return {
      transform: [
        {
          translateY: interpolate(
            scrollY.value,
            [0, headerHeight],
            [0, -headerHeight],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  }, [headerHeight]);

  // The header, search bar and status-bar strip are TRANSPARENT at rest, so
  // the Home hero's own background (which starts at the very top of the
  // list, behind them) is what shows — one continuous surface from the top of
  // the screen to below the top cards. Their solid fill fades in over the
  // first few pixels of scroll, so content scrolling underneath is covered
  // again. Opacity only, on each piece's OWN fill layer (inside the view that
  // already translates), so this never changes any layout or re-creates the
  // stale-block bug described on `topOverlay`. A pull-down past the top
  // (iOS bounce) keeps the fill on, so no gap opens above the hero.
  const overlayFillStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [-1, 0, OVERLAY_FILL_SCROLL], [1, 0, 1], Extrapolation.CLAMP),
  }));

  useEffect(() => {
    void refresh();

    const interval = setInterval(() => {
      void refresh();
    }, 30000);

    return () => clearInterval(interval);
  }, [refresh]);

  // Stores and restaurants are filtered to the customer's location by the
  // SERVER (each seller's own delivery radius — the rule checkout enforces).
  const near = useMemo(
    () =>
      location
        ? { latitude: location.latitude, longitude: location.longitude }
        : null,
    [location],
  );
  const restaurantsQuery = useRestaurants(near);
  const storesQuery = useStores(near);
  const offersQuery = useOffers();

  // A food seller with an empty menu has nothing to order yet.
  const restaurants = useMemo(
    () =>
      (restaurantsQuery.data ?? NO_RESULTS).filter(
        (restaurant) => restaurant.menuItemCount > 0,
      ),
    [restaurantsQuery.data],
  );
  const stores = storesQuery.data ?? NO_RESULTS;
  const offers = offersQuery.data ?? NO_RESULTS;

  const sections = useMemo(
    () =>
      feed.data
        ? buildHomeSections({
            feed: feed.data,
            hasFood: restaurants.length > 0,
            hasStores: stores.length > 0,
            hasOffers: offers.length > 0,
            previousOrders: previouslyOrdered.data ?? null,
          })
        : (NO_RESULTS as HomeSection[]),
    [
      feed.data,
      restaurants.length,
      stores.length,
      offers.length,
      previouslyOrdered.data,
    ],
  );

  // The admin's published layout (Home Page Builder / Category Management):
  // order, visibility and style of the sections the engine built above.
  const homeLayout = useHomeLayout();
  // Products of the builder's added product shelves (resolved by the server, keyed by section id).
  const homeShelves = useHomeShelves();
  const language = usePreferences((state) => state.language);
  const laidOut = useMemo(
    () =>
      feed.data
        ? applyHomeLayout({ sections, feed: feed.data, layout: homeLayout, language, shelves: homeShelves })
        : { promo: [], sections: NO_RESULTS as LaidOutSection[] },
    [sections, feed.data, homeLayout, language, homeShelves],
  );
  const headerColor = heroHeaderColor(homeLayout.hero);

  const phrases = useMemo(
    () => searchPhrases(feed.data?.categories),
    [feed.data?.categories],
  );

  /* ----------------------------------------------------------------
     NAVIGATION HANDLERS

     The stack hands this screen fresh inline callbacks whenever it
     re-renders; routing every section through one ref keeps the
     handlers below referentially stable, so the memoized sections don't
     re-render just because the navigator did.
  ---------------------------------------------------------------- */

  const nav = useRef({
    onOpenProduct,
    onOpenCategory,
    onOpenAllCategories,
    onOpenRail,
    onOpenSearch,
    onOpenRestaurant,
    onOpenStore,
    onOpenFood,
    onOpenOrders,
  });
  nav.current = {
    onOpenProduct,
    onOpenCategory,
    onOpenAllCategories,
    onOpenRail,
    onOpenSearch,
    onOpenRestaurant,
    onOpenStore,
    onOpenFood,
    onOpenOrders,
  };

  const handlers = useMemo(
    () => ({
      openProduct: (productId: string) => nav.current.onOpenProduct(productId),
      openCategory: (categoryId: string) =>
        nav.current.onOpenCategory(categoryId),
      openAllCategories: () => nav.current.onOpenAllCategories(),
      openSearch: () => nav.current.onOpenSearch(),
      openRestaurant: (sellerId: string) =>
        nav.current.onOpenRestaurant(sellerId),
      openStore: (sellerId: string) => nav.current.onOpenStore(sellerId),
      openFood: () => nav.current.onOpenFood(),
      action: (action: HomeAction) => {
        switch (action.type) {
          case "rail":
            nav.current.onOpenRail(action.railKey, action.title);
            break;
          case "category":
            nav.current.onOpenCategory(action.categoryId);
            break;
          case "allCategories":
            nav.current.onOpenAllCategories();
            break;
          case "orders":
            nav.current.onOpenOrders();
            break;
          case "product":
            nav.current.onOpenProduct(action.productId);
            break;
          case "food":
            nav.current.onOpenFood();
            break;
          case "coupon":
            void Clipboard.setStringAsync(action.code);
            break;
          case "banner":
            openBannerAction(action.banner);
            break;
          case "none":
            break;
        }
      },
    }),
    [],
  );

  const renderBody = useCallback(
    (item: LaidOutSection) => {
      switch (item.kind) {
        case "banners":
          return (
            <PromoCarousel slides={item.slides} onAction={handlers.action} />
          );
        case "categoryGrid": {
          const viewAll = item.viewAll;
          return (
            <CategoryGrid
              title={item.title}
              subtitle={item.subtitle}
              tiles={item.tiles}
              display={item.display}
              onOpenCategory={handlers.openCategory}
              onViewAll={viewAll ? () => handlers.action(viewAll) : undefined}
            />
          );
        }
        case "foodCarousel":
          return (
            <FoodCarousel
              title={item.title}
              subtitle={item.subtitle}
              slides={item.slides}
              onAction={handlers.action}
              onOpenFood={handlers.openFood}
            />
          );
        case "latest":
          return (
            <LatestProducts
              title={item.title}
              subtitle={item.subtitle}
              maxItems={item.maxItems}
              onOpenProduct={handlers.openProduct}
              onAction={handlers.action}
            />
          );
        case "foodFallback":
          // No live food carousel card (Admin Panel → Banners & Cards): the standard food banner.
          return <RestaurantBanner onPress={handlers.openFood} />;
        case "food":
          return (
            <FoodSection
              restaurants={restaurants}
              onOpenRestaurant={handlers.openRestaurant}
              onOpenFood={handlers.openFood}
            />
          );
        case "stores":
          return (
            <StoreSection
              stores={stores}
              nearby={near !== null}
              onOpenStore={handlers.openStore}
            />
          );
        case "offers":
          return <OfferSection offers={offers} />;
        case "shelf":
          return (
            <ProductShelf
              section={item}
              onOpenProduct={handlers.openProduct}
              onAction={handlers.action}
            />
          );
        case "productShelf":
          // A Home Page Builder shelf: the same ProductShelf and cards, with its own layout.
          return (
            <ProductShelf
              section={item}
              display={item.display}
              onOpenProduct={handlers.openProduct}
              onAction={handlers.action}
            />
          );
        default:
          return null;
      }
    },
    [restaurants, stores, offers, near, handlers],
  );

  // Each section on its admin background, with the admin's spacing around
  // it ("normal" = exactly the spacing Home always had).
  const renderSection = useCallback(
    ({ item }: { item: LaidOutSection }) => {
      const body = renderBody(item);
      if (body === null) return null;
      const tinted = item.frame.background !== "none";
      const extra = HOME_SPACING_DP[item.frame.spacing] - HOME_SPACING_DP.normal;
      if (!tinted && extra === 0) return body;
      return (
        <View
          style={{
            backgroundColor: tinted ? contentColor(item.frame.background, "transparent") : undefined,
            paddingVertical: tinted ? spacing.xs : 0,
            marginVertical: extra / 2,
          }}
        >
          {body}
        </View>
      );
    },
    [renderBody],
  );

  return (
    <Screen style={styles.screen}>
      {/* ============================================================
          TOP LOCATION HEADER + SEARCH

          An ABSOLUTELY POSITIONED OVERLAY on top of the ScrollView below,
          not a normal-flow sibling above it — see `scrollY`'s own comment
          for why. The status-bar-height gap lives on this OUTER, never-
          animated wrapper as an explicit backed spacer (its own comment
          below) — not as the collapsing row's own padding — so the safe-
          area gap at the very top of the screen stays correct and constant
          whether the row below is fully expanded, mid-collapse, or fully
          collapsed. `overflow: hidden` clips the header row once its
          `translateY` carries it up past this wrapper's own top edge.
          `topOverlay` itself carries no `backgroundColor` — see its own
          style comment for why painting one there (covering this whole
          wrapper's constant, never-shrinking natural height) was what left
          a stale white block on screen after the header collapsed.
      ============================================================ */}

      <View
        collapsable={false}
        pointerEvents="box-none"
        onLayout={(event) => {
          // Captured once, same reasoning as `headerHeight` below — this is
          // the overlay's own full natural (untransformed) height, used as
          // the ScrollView's constant top padding so real content starts
          // exactly where this overlay visually ends.
          if (overlayHeight === 0)
            setOverlayHeight(event.nativeEvent.layout.height);
        }}
        style={styles.topOverlay}
      >
        {/* Status-bar-height spacer — deliberately its OWN backed view
            rather than `topOverlay`'s `paddingTop`. `topOverlay` itself
            carries NO backgroundColor (see its own comment): a `View`'s
            `backgroundColor` always paints that view's full, untransformed
            layout box, no matter what `transform`/`opacity` its CHILDREN
            are animated to. The header row and search bar below are
            translated via `transform` as the page scrolls (never resized —
            that's what keeps the scroll jitter fixed), which means their
            OWN backgrounds correctly track exactly where they're visually
            drawn. `topOverlay` painting a blanket background across its
            full original height regardless was the bug: once the header
            fully collapses, only the search bar's own (smaller) footprint
            was actually occupied, but the wrapper kept painting solid white
            across the whole original header+search height anyway — a
            static white block sitting on top of the product rails
            scrolling underneath, right where the header used to be. This
            spacer only ever needs to cover the truly constant, never-
            animated status-bar strip at the very top. */}
        {/* The status-bar strip, header and search bar sit on the Home
            background's first colour (HomeHero below continues it), so the
            background reads as one surface from the very top of the screen.
            Colour only — their layout and transforms are unchanged. */}
        <ReanimatedAnimated.View
          collapsable={false}
          style={[{ height: insets.top, backgroundColor: headerColor }, overlayFillStyle]}
        />

        <ReanimatedAnimated.View
          // Android specifically: this view has NO dynamic style at all
          // until `headerHeight` is measured (`headerAnimatedStyle` returns
          // `{}` — see its own comment), which makes it eligible for
          // Android's view-flattening optimisation (merged into its parent
          // as a plain, non-animatable node). The INSTANT scrolling starts
          // and `headerAnimatedStyle` begins returning real transform/
          // opacity values, Android has to un-flatten it back into a real
          // native view to animate it — that flatten-to-unflatten promotion
          // is a well-documented one-frame flicker on Android, and only
          // ever happens right at this transition, which is exactly the
          // scrollY-leaves-0 blink being fixed here. `collapsable={false}`
          // opts this view out of flattening from the very first frame, so
          // there is never a promotion to cause one — the same fix already
          // used in MiniCartBar.tsx's thumbRowRef for the same reason.
          collapsable={false}
          onLayout={(event) => {
            // Only ever captured once — a later layout pass while the row is
            // already mid-collapse would otherwise overwrite the real
            // expanded height with whatever shrunken height it has at that
            // moment.
            if (headerHeight === 0)
              setHeaderHeight(event.nativeEvent.layout.height);
          }}
          style={[
            styles.header,
            { paddingTop: 4, backgroundColor: "transparent", borderBottomColor: "transparent" },
            headerAnimatedStyle,
          ]}
        >
          <ReanimatedAnimated.View
            pointerEvents="none"
            collapsable={false}
            style={[StyleSheet.absoluteFill, { backgroundColor: headerColor }, overlayFillStyle]}
          />
          {/* Wraps just the address/profile CONTENT with the opacity fade
              that used to sit on the outer view above (see
              `headerContentAnimatedStyle`'s own comment) — the outer view's
              `backgroundColor` (styles.header) now stays opaque through the
              whole scroll instead of fading with this. `flex: 1,
              flexDirection: "row", alignItems: "center"` reproduces exactly
              the row layout `styles.header` itself provides, so LOCATION/
              ACCOUNT below lay out identically to before. */}
          <ReanimatedAnimated.View
            style={[
              { flex: 1, flexDirection: "row", alignItems: "center" },
              headerContentAnimatedStyle,
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
              {/* Brand */}

              {/* Location Text */}

              <View style={styles.locationText}>
                <View style={styles.deliveringRow}>
                  <Ionicons name="location" size={11} color={colors.primary} />
                  <AppText
                    variant="caption"
                    color={colors.textSecondary}
                    style={styles.deliveringText}
                  >
                    Delivering to
                  </AppText>
                </View>

                <AppText
                  variant="bodyStrong"
                  // Two lines: a live location's full address must stay readable.
                  numberOfLines={2}
                  style={styles.locationLabel}
                >
                  {locationLabel ?? "Select a location"}
                </AppText>
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
            NOTIFICATIONS
        ---------------------------------------------------------- */}

            <Pressable
              onPress={onOpenNotifications}
              style={styles.bellButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                unreadNotifications > 0
                  ? `Notifications, ${unreadNotifications} unread`
                  : "Notifications"
              }
            >
              <Ionicons
                name="notifications-outline"
                size={26}
                color={colors.primary}
              />
              {unreadNotifications > 0 && (
                <View style={styles.bellBadge}>
                  <AppText
                    variant="overline"
                    color={colors.textOnPrimary}
                    style={styles.bellBadgeText}
                  >
                    {formatUnreadBadge(unreadNotifications)}
                  </AppText>
                </View>
              )}
            </Pressable>

            {/* ----------------------------------------------------------
            CART — the live item count from the real cart (the same
            optimistic count the Cart tab's badge shows).
        ---------------------------------------------------------- */}

            <Pressable
              onPress={onOpenProfile}
              style={styles.cartButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Profile"
            >
              <Ionicons
                name="person-circle-outline"
                size={34}
                color={colors.primary}
              />
            </Pressable>
          </ReanimatedAnimated.View>
        </ReanimatedAnimated.View>

       
        <ReanimatedAnimated.View
          collapsable={false}
          style={[styles.searchBarRow, { backgroundColor: "transparent" }, searchBarAnimatedStyle]}
        >
          <ReanimatedAnimated.View
            pointerEvents="none"
            collapsable={false}
            style={[StyleSheet.absoluteFill, { backgroundColor: headerColor }, overlayFillStyle]}
          />
          <Pressable
            onPress={onOpenSearch}
            style={styles.searchBar}
            accessibilityRole="button"
            accessibilityLabel="Search products"
          >
            <AnimatedSearchPlaceholder phrases={phrases} />
          </Pressable>
        </ReanimatedAnimated.View>
      </View>

      {/* ============================================================
          SCROLLABLE HOME — a virtualized list of sections. Only the
          sections near the viewport are mounted, and each product shelf
          is itself a virtualized horizontal list, so a catalogue of
          thousands of products never renders more than a screenful of
          cards at a time.
      ============================================================ */}

      <ReanimatedAnimated.FlatList
        data={laidOut.sections}
        keyExtractor={sectionKey}
        renderItem={renderSection}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        initialNumToRender={5}
        maxToRenderPerBatch={4}
        windowSize={9}
        contentContainerStyle={{
          // Constant reservation matching the overlay's own full natural
          // height (measured once — see `overlayHeight` above), so real
          // content starts exactly where the overlay visually ends at
          // scrollY=0. This is what lets the overlay float ABOVE the list
          // (rather than push it down) without covering the first row of
          // content while fully expanded.
          // (The overlay's height is reserved INSIDE the hero — `topInset` —
          // so the hero's background owns that space; see HomeHero.)
          paddingTop: 0,
          // `tabBarClearance` keeps the last section clear of the floating
          // tab bar; the extra `spacing.base` covers MiniCartBar's resting
          // footprint on devices with no bottom inset (see MainTabs.tsx's
          // `AnimatedTabBar` and MiniCartBar.tsx).
          paddingBottom: tabBarClearance + spacing.base,
        }}
        ListHeaderComponent={
          <>
            {/* ====================================================
                TOP OF THE PAGE — promotional area + top cards on the
                admin's background (Home Page Builder).
            ==================================================== */}

            <HomeHero
              hero={homeLayout.hero}
              promo={laidOut.promo}
              onAction={handlers.action}
              topInset={overlayHeight}
            />

            {/* ====================================================
                SERVICEABILITY / CART NOTICES
            ==================================================== */}

            {orderingPaused && (
              <View style={styles.noticeContainer}>
                <NoticeStrip
                  message={
                    publicConfig?.ORDERING_PAUSED_MESSAGE?.trim() ||
                    "Ordering is paused right now. You can keep browsing and adding items to your cart."
                  }
                />
              </View>
            )}

            {cartError && (
              <View style={styles.noticeContainer}>
                <NoticeStrip message={cartError} />
              </View>
            )}

            {/* No delivery location chosen yet: ask here, never at launch. */}
            {!location && (
              <Pressable
                onPress={onOpenLocation}
                style={styles.noticeContainer}
                accessibilityRole="button"
                accessibilityLabel="Set your delivery location"
              >
                <NoticeStrip
                  message="Set your delivery location to see what we deliver to you. Tap to use your current location or choose an address."
                  tone="info"
                />
              </Pressable>
            )}

            {serviceability && !serviceability.serviceable && (
              <View style={styles.noticeContainer}>
                <NoticeStrip
                  message={[
                    "We don't deliver to your location yet — you can browse, but ordering is unavailable.",
                    outOfAreaDetail(serviceability),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  tone="info"
                />
              </View>
            )}

            {serviceability?.sellerOpen === false && (
              <View style={styles.noticeContainer}>
                <NoticeStrip message="Every store near you is closed right now. You can keep browsing — ordering opens when a store opens." />
              </View>
            )}

            {/* ====================================================
                ORDER IN PROGRESS — a customer can start a brand new
                order while an earlier one is still being prepared/
                delivered; this keeps that earlier order reachable.
            ==================================================== */}

            {ongoingOrder && (
              <View style={styles.noticeContainer}>
                <Pressable
                  onPress={() => onOpenOrderTracking(ongoingOrder.id)}
                  style={styles.ongoingOrderCard}
                  accessibilityRole="button"
                  accessibilityLabel={`Order ${ongoingOrder.orderNumber}, ${ongoingOrder.statusLabel}. View order`}
                >
                  <View style={styles.ongoingOrderIcon}>
                    <Package size={20} color={colors.primary} strokeWidth={2} />
                  </View>

                  <View style={styles.ongoingOrderText}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      Order #{ongoingOrder.orderNumber}
                    </AppText>
                    <AppText
                      variant="caption"
                      color={colors.primary}
                      numberOfLines={1}
                      style={styles.ongoingOrderStatus}
                    >
                      {ongoingOrder.statusLabel}
                    </AppText>
                  </View>

                  <View style={styles.ongoingOrderAction}>
                    <AppText
                      variant="bodyStrong"
                      color={colors.primary}
                      style={styles.ongoingOrderActionText}
                    >
                      Track
                    </AppText>
                    <ChevronRight
                      size={16}
                      color={colors.primary}
                      strokeWidth={2.5}
                    />
                  </View>
                </Pressable>
              </View>
            )}

            {/* First load with nothing cached: the page's shape, not a spinner. */}
            {!feed.data && feed.isLoading && (
              <HomeSkeleton cardWidth={SHELF_CARD_WIDTH} />
            )}

            {!feed.data && feed.isError && (
              <View
                style={[styles.errorWrap, { minHeight: windowHeight * 0.6 }]}
              >
                <ErrorState
                  message="We could not load the store."
                  offline={
                    (feed.error as { isOffline?: boolean } | null)
                      ?.isOffline === true
                  }
                  onRetry={() => void feed.refetch()}
                />
              </View>
            )}
          </>
        }
      />
    </Screen>
  );
}

const sectionKey = (section: { key: string }) => section.key;

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
    backgroundColor: HOME_BACKGROUND,
  },

  /* ================================================================
     SCROLLABLE HOME — explicit `flex: 1` so it always fills the full
     Screen height from y=0, with the (absolutely positioned) top overlay
     floating on top of its first portion — see `topOverlay` below.
  ================================================================ */

  scroll: {
    flex: 1,
  },

  /* ================================================================
     TOP OVERLAY — header + search bar, floating over the ScrollView.
     Its own size never animates (only its children's `transform`/`opacity`
     do), so it can never itself cause the ScrollView to resize — see
     `scrollY`'s own comment above for the full reasoning.

     Deliberately NO `backgroundColor` here — see the status-bar spacer's
     own comment in the JSX for why painting one on this wrapper (rather
     than on each piece that actually needs it: the spacer, `header`,
     `searchBarRow`) was what created a solid white block that outlived the
     header's own collapse and sat on top of the product rails underneath.
     `overflow: hidden` still clips the header once it translates above this
     wrapper's own top edge.
  ================================================================ */

  topOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    overflow: "hidden",
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

    // Clear space before the notification and cart buttons.
    marginRight: spacing.sm,
  },

  /* ================================================================
     LOCATION ICON
  ================================================================ */

  deliveringRow: {
    flexDirection: "row",

    alignItems: "center",

    gap: 3,
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
    fontSize: 14,

    lineHeight: 18,

    fontWeight: "700",

    maxWidth: "100%",
  },

  /* ================================================================
     CHEVRON
  ================================================================ */

  chevronContainer: {
    width: 44,

    height: 22,

    marginLeft: 3,

    alignItems: "center",

    justifyContent: "center",
  },

  /* ================================================================
     NOTIFICATION BELL
  ================================================================ */

  bellButton: {
    width: 40,

    height: 42,

    alignItems: "center",

    justifyContent: "center",
  },

  bellBadge: {
    position: "absolute",

    top: 4,

    right: 2,

    minWidth: 16,

    height: 16,

    paddingHorizontal: 3,

    borderRadius: 8,

    alignItems: "center",

    justifyContent: "center",

    backgroundColor: colors.danger,
  },

  bellBadgeText: {
    fontSize: 9,

    lineHeight: 12,
  },

  /* ================================================================
     CART BUTTON (shares the bell's badge style)
  ================================================================ */

  cartButton: {
    width: 42,

    height: 42,

    alignItems: "center",

    justifyContent: "center",

    marginLeft: 2,
  },

  /* ================================================================
     SEARCH
  ================================================================ */

  // Wraps `searchBar` — this is what carries the (now-constant) top margin;
  // `searchBarAnimatedStyle`'s `translateY` handles the rest of the visual
  // collapse distance on top of it (see its own comment).
  //
  // `backgroundColor` here (rather than only on `topOverlay`, see its own
  // comment) is what keeps this row opaque across ITS OWN full footprint —
  // the top margin above the pill and the bottom margin below it included —
  // as it translates to dock under the status bar, independent of whatever
  // `topOverlay`'s own (now transparent) box is doing.
  // searchBarRow: {
  //   marginTop: spacing.md,
  //   backgroundColor: colors.success,
  // },
  searchBarRow: {
    marginTop: spacing.md - 12,
    paddingTop: 10,
    backgroundColor: colors.surface,
  },
  searchBar: {
    marginHorizontal: spacing.base,

    marginBottom: spacing.sm,

    minHeight: 44,

    // Rounded rectangle, not a full pill — matches the radius already used
    // elsewhere for card-shaped surfaces (banner slides, product media
    // boxes use this same `radius.lg`/14 scale).
    borderRadius: radius.lg,

    borderWidth: 1,

    borderColor: colors.border,

    backgroundColor: colors.surface,

    flexDirection: "row",

    alignItems: "center",

    paddingLeft: 13,

    paddingRight: 5,
  },

  // The search action at the end of the bar — the whole bar opens Search.
  searchAction: {
    width: 34,

    height: 34,

    marginLeft: 8,

    borderRadius: radius.md,

    backgroundColor: colors.primary,

    alignItems: "center",

    justifyContent: "center",
  },

  searchPlaceholderClip: {
    flex: 1,
    height: 18,
    overflow: "hidden",
    justifyContent: "center",
  },

  searchPlaceholder: {
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
     ORDER IN PROGRESS
  ================================================================ */

  ongoingOrderCard: {
    flexDirection: "row",
    alignItems: "center",

    padding: spacing.sm,

    borderRadius: radius.lg,

    borderWidth: 1,
    borderColor: colors.primaryLight,

    backgroundColor: colors.primarySurface,
  },

  ongoingOrderIcon: {
    width: 40,
    height: 40,

    borderRadius: radius.circle,

    backgroundColor: colors.surface,

    alignItems: "center",
    justifyContent: "center",

    marginRight: spacing.sm,
  },

  ongoingOrderText: {
    flex: 1,
    minWidth: 0,
  },

  ongoingOrderStatus: {
    marginTop: 1,
    fontWeight: "700",
  },

  ongoingOrderAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,

    marginLeft: spacing.sm,
  },

  ongoingOrderActionText: {
    fontSize: 14,
    lineHeight: 20,
  },

  /* ================================================================
     ERROR (no cached feed)
  ================================================================ */

  errorWrap: {
    justifyContent: "center",
  },

  restaurantBanner: {
    marginHorizontal: spacing.base,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },

  restaurantBannerImage: {
    width: "100%",
    height: 150,
  },
});

import {
  Animated,
  Easing,
  FlatList,
  Pressable,
  ScrollView,
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
import React, { useEffect, useRef, useState } from "react";

import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import {
  ArrowRight,
  ChevronRight,
  Leaf,
  Package,
  ShieldCheck,
  MapPin,
  Zap,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { HomeFeedDto, ProductSummaryDto } from "@shared";

type RailKey = HomeFeedDto["rails"][number]["key"];
import { colors, radius, shadow, spacing } from "@shared/theme";
import { formatDistance } from "@shared/distance";

import { useHomeFeed, useOrders } from "@/lib/queries";
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
import {
  tabBarHiddenByScroll,
  useTabBarClearance,
} from "@/lib/tabBarVisibility";

import adioneHomeBanner from "../../../assets/adione-homebar.png";
import bannerDailyEssentials from "../../../assets/home-banner-daily-essentials.png";
import bannerElectronics from "../../../assets/home-banner-electronics.png";
import bannerVegFruits from "../../../assets/home-banner-vegetables-fruits.png";
import promoClothes from "../../../assets/promo-clothes.png";
import promoElectronics from "../../../assets/promo-electronics.png";
import promoFreshProduce from "../../../assets/promo-fresh-fruits-veggies.png";
import promoGrocery from "../../../assets/promo-grocery.png";

/** Fixed count of the promotional carousel below — see the `banners` array. */
const HOME_BANNER_COUNT = 4;

/* =====================================================================
   ANIMATED SEARCH PLACEHOLDER

   Cycles through example queries (fade + slide, the same idea as
   ProductCard's AnimatedQuantity) instead of sitting on one static line —
   the quick-commerce apps this design follows use the same "rotating
   placeholder" cue to hint at what's searchable without the customer
   having to tap in first.
===================================================================== */

const SEARCH_PLACEHOLDERS = [
  "Search for atta, rice, dal…",
  "Search for milk, bread, eggs…",
  "Search for chips, biscuits…",
  "Search for soap, shampoo…",
  "Search for fruits, vegetables…",
];

const PLACEHOLDER_HOLD_MS = 2200;
const PLACEHOLDER_ANIM_MS = 280;

function AnimatedSearchPlaceholder() {
  const [index, setIndex] = useState(0);
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: PLACEHOLDER_ANIM_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setIndex((current) => (current + 1) % SEARCH_PLACEHOLDERS.length);
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
  }, [anim]);

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
        {SEARCH_PLACEHOLDERS[index]}
      </Animated.Text>
    </View>
  );
}

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
  onOpenOrderTracking,
}: {
  onOpenProduct: (productId: string) => void;
  onOpenCategory: (categoryId: string) => void;
  onOpenAllCategories: () => void;
  onOpenRail: (key: RailKey, title: string) => void;
  onOpenSearch: () => void;
  onOpenLocation: () => void;
  onOpenProfile: () => void;
  onOpenOrderTracking: (orderId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();

  const feed = useHomeFeed();
  const cart = useCartActions();

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
  const ongoingOrder = orders.data?.items.find((order) => order.bucket === "ONGOING") ?? null;

  const { location, serviceability, refresh } = useLocation();

  const { width: windowWidth } = useWindowDimensions();
  const [activeBanner, setActiveBanner] = useState(0);
  const bannerScrollRef = useRef<ScrollView>(null);
  const bannerAutoplayTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );

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

  useEffect(() => {
    void refresh();

    const interval = setInterval(() => {
      void refresh();
    }, 30000);

    return () => clearInterval(interval);
  }, [refresh]);

  // Advances the banner carousel every 2s. A manual swipe (see
  // `onMomentumScrollEnd` below) calls this again to restart the countdown,
  // so autoplay doesn't fight a swipe the customer just made.
  const startBannerAutoplay = () => {
    if (bannerAutoplayTimerRef.current)
      clearInterval(bannerAutoplayTimerRef.current);
    if (HOME_BANNER_COUNT <= 1) return;

    const slideStep =
      Math.min(640, windowWidth - spacing.base * 2) + spacing.sm;

    bannerAutoplayTimerRef.current = setInterval(() => {
      setActiveBanner((current) => {
        const next = (current + 1) % HOME_BANNER_COUNT;
        bannerScrollRef.current?.scrollTo({
          x: next * slideStep,
          animated: true,
        });
        return next;
      });
    }, 2000);
  };

  useEffect(() => {
    startBannerAutoplay();
    return () => {
      if (bannerAutoplayTimerRef.current)
        clearInterval(bannerAutoplayTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowWidth]);

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
     CATEGORY RAIL LOOKUP

     Shared by both the banners (deep-linking "Electronics"/"Fresh
     Produce" banners to their actual shelf) and the Home section order
     below. "Grocery" is deliberately excluded — Daily Essentials already
     covers grocery staples, so its own shelf just duplicated that rail —
     and Vegetables & Fruits always gets the first featured slot when the
     store has it, rather than however it happens to rank by
     `displayOrder`. Everything else still resolves dynamically, so a new
     category the store adds later shows up without a code change.
  ================================================================ */

  const allCategoryRails = feed.data.categoryRails ?? [];
  const isGroceryShelf = (title: string) =>
    title.trim().toLowerCase() === "grocery";
  const isProduceShelf = (title: string) => /fruit|vegetable/i.test(title);
  const isElectronicsShelf = (title: string) => /electronic/i.test(title);
  const isClothesShelf = (title: string) =>
    /cloth|fashion|apparel/i.test(title);

  const produceRail = allCategoryRails.find((rail) =>
    isProduceShelf(rail.title),
  );
  const electronicsRail = allCategoryRails.find((rail) =>
    isElectronicsShelf(rail.title),
  );
  const clothesRail = allCategoryRails.find((rail) =>
    isClothesShelf(rail.title),
  );
  const groceryRail = allCategoryRails.find((rail) =>
    isGroceryShelf(rail.title),
  );
  const otherCategoryRails = allCategoryRails.filter(
    (rail) => rail !== produceRail && !isGroceryShelf(rail.title),
  );

  const featuredCategoryRails = [produceRail, ...otherCategoryRails]
    .filter((rail): rail is NonNullable<typeof rail> => rail != null)
    .slice(0, 2);

  /* ================================================================
     "SHOP BY CATEGORY" PROMO TILES — bottom-of-Home strip, deliberately a
     different shape/interaction (horizontal tile strip, entrance
     animation) from the swipe carousel up top so it doesn't just read as
     a second copy of the same thing. Each tile deep-links to its matching
     shelf when the store has one, same resolution as the banners above.
  ================================================================ */

  const promoTiles = [
    {
      id: "clothes",
      image: promoClothes,
      onPress: clothesRail
        ? () => onOpenCategory(clothesRail.categoryId)
        : onOpenAllCategories,
    },
    {
      id: "electronics",
      image: promoElectronics,
      onPress: electronicsRail
        ? () => onOpenCategory(electronicsRail.categoryId)
        : onOpenAllCategories,
    },
    {
      id: "fresh-produce",
      image: promoFreshProduce,
      onPress: produceRail
        ? () => onOpenCategory(produceRail.categoryId)
        : onOpenAllCategories,
    },
    {
      id: "grocery",
      image: promoGrocery,
      onPress: groceryRail
        ? () => onOpenCategory(groceryRail.categoryId)
        : onOpenAllCategories,
    },
  ];

  /* ================================================================
     PROMOTIONAL BANNERS — auto-rotating carousel

     The first slide is the existing "Free Delivery" banner (unchanged —
     same image, same text overlay). The other three are full marketing
     graphics with their own baked-in text/CTA, so they render as plain
     images with no overlay, the whole slide tappable instead of just a
     button.
  ================================================================ */

  const bannerSlideWidth = Math.min(640, windowWidth - spacing.base * 2);
  const bannerSlideGap = spacing.sm;

  const banners = [
    {
      id: "free-delivery",
      image: adioneHomeBanner,
      title: "FREE DELIVERY",
      subtitle: "On orders above ₹299",
      actionLabel: "Shop Now",
      onPress: onOpenSearch,
    },
    {
      id: "daily-essentials",
      image: bannerDailyEssentials,
      onPress: () => onOpenRail("DAILY_ESSENTIALS", "Daily Essentials"),
    },
    {
      id: "electronics",
      image: bannerElectronics,
      onPress: electronicsRail
        ? () => onOpenCategory(electronicsRail.categoryId)
        : onOpenAllCategories,
    },
    {
      id: "fresh-produce",
      image: bannerVegFruits,
      onPress: produceRail
        ? () => onOpenCategory(produceRail.categoryId)
        : onOpenAllCategories,
    },
  ];

  /* ================================================================
     HOME SECTION ORDER

     A fixed, requested layout — Daily Essentials, then the top two
     category shelves, then Best Sellers, Offers, and Popular (which the
     backend now randomizes rather than ranks — see catalog.repository.ts)
     last. This replaces looping over `rails` and `categoryRails`
     separately in whatever order the API happened to return them, which
     is what let "Popular" and "Daily Essentials" end up showing the exact
     same fixed top-10 every time.
  ================================================================ */

  const railByKey = new Map(feed.data.rails.map((rail) => [rail.key, rail]));

  type HomeSection =
    | { kind: "rail"; rail: HomeFeedDto["rails"][number] }
    | { kind: "category"; rail: HomeFeedDto["categoryRails"][number] };

  const homeSections: HomeSection[] = [
    railByKey.get("DAILY_ESSENTIALS"),
    ...featuredCategoryRails,
    railByKey.get("BEST_SELLERS"),
    railByKey.get("OFFERS"),
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
        <View style={{ height: insets.top, backgroundColor: colors.surface }} />

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
          style={[styles.header, { paddingTop: 4 }, headerAnimatedStyle]}
        >
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
          </ReanimatedAnimated.View>
        </ReanimatedAnimated.View>

        {/* ==========================================================
            SEARCH — once the address/profile row above has collapsed,
            this is the only thing left looking pinned at the top (it's
            still part of the same overlay — see the wrapper's own comment
            — it just stops moving once its own `translateY` clamps).
        ========================================================== */}

        {/* Same `collapsable={false}` reasoning as the header row above —
            its `transform` is also continuously animated in lockstep with
            the header's collapse, so it is exposed to the exact same
            Android flatten/unflatten flicker risk. */}
        <ReanimatedAnimated.View
          collapsable={false}
          style={[styles.searchBarRow, searchBarAnimatedStyle]}
        >
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

            <AnimatedSearchPlaceholder />
          </Pressable>
        </ReanimatedAnimated.View>
      </View>

      {/* ============================================================
          SCROLLABLE HOME
      ============================================================ */}

      <ReanimatedAnimated.ScrollView
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={{
          // Constant reservation matching the overlay's own full natural
          // height (measured once — see `overlayHeight` above), so real
          // content starts exactly where the overlay visually ends at
          // scrollY=0. This is what lets the overlay float ABOVE the
          // ScrollView (rather than push it down) without covering the
          // first row of content while fully expanded.
          paddingTop: overlayHeight,
          // `tabBarClearance` (`layout.tabBarHeight + insets.bottom`, see
          // tabBarVisibility.ts) — NOT `MiniCartBar`'s own footprint. The tab
          // bar is now a genuine floating OVERLAY (see MainTabs.tsx's
          // `AnimatedTabBar`, design #4) with no reserved flex space of its
          // own, so this ScrollView's real content would otherwise render
          // underneath its visible plate at rest — this is what keeps the
          // last product row clear of it, the same job the old flex slot
          // used to do for free. A flat `+ 5` on top covers MiniCartBar:
          // its own resting footprint (`BOTTOM_GAP` 12 + 56px card = 68px,
          // see MiniCartBar.tsx) is ≤ `tabBarClearance` on every device with
          // `insets.bottom >= 4` (effectively all of them), so only the
          // theoretical `insets.bottom === 0` shortfall needs covering —
          // real content should never sit flush against MiniCartBar with
          // zero breathing room. MiniCartBar itself still floats freely over
          // the LAST few px of this padding, exactly as designed — this
          // isn't reserving its full footprint a second time.
          paddingBottom: tabBarClearance + 5,
        }}
      >
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
            ORDER IN PROGRESS — a customer can start a brand new order
            (the Mini Cart is genuinely empty again the instant the last
            one was placed — see useCartActions.ts's
            `resetPendingCartAfterOrder`) while an earlier order is still
            being prepared/delivered. This is the one place that earlier
            order stays visible/reachable instead of just disappearing
            from view the moment its own items stopped showing in the
            cart.
        ======================================================== */}

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
                <AppText variant="bodyStrong" color={colors.primary} style={styles.ongoingOrderActionText}>
                  Track
                </AppText>
                <ChevronRight size={16} color={colors.primary} strokeWidth={2.5} />
              </View>
            </Pressable>
          </View>
        )}

        {/* ========================================================
            PROMOTIONAL BANNERS — swipeable, with a dot indicator
        ======================================================== */}

        <View style={styles.bannerCarousel}>
          <ScrollView
            ref={bannerScrollRef}
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
              setActiveBanner(Math.max(0, Math.min(banners.length - 1, index)));
              // A manual swipe shouldn't be immediately undone by autoplay
              // jumping to the next slide moments later — restart the timer.
              startBannerAutoplay();
            }}
          >
            {banners.map((item, index) => {
              const hasOverlay = "title" in item;
              const slideStyle = [
                styles.bannerWrapper,
                {
                  width: bannerSlideWidth,
                  // The "Free Delivery" banner keeps its own image's native
                  // ratio (1653x569) — forcing it into the marketing
                  // graphics' taller ratio zoomed the image in via `cover`
                  // and cut its baked-in title/clock artwork off the edge.
                  aspectRatio: hasOverlay ? 1653 / 569 : 2000 / 760,
                  marginRight:
                    index === banners.length - 1 ? 0 : bannerSlideGap,
                },
              ];

              // Only the first slide ("Free Delivery") carries a text
              // overlay — the other three are full marketing graphics with
              // their own baked-in title/CTA, so the whole slide is just a
              // tappable image.
              if (!("title" in item)) {
                return (
                  <Pressable
                    key={item.id}
                    onPress={item.onPress}
                    style={slideStyle}
                    accessibilityRole="button"
                    accessibilityLabel={item.id}
                  >
                    <Image
                      source={item.image}
                      style={styles.banner}
                      contentFit="cover"
                      transition={150}
                      cachePolicy="memory-disk"
                    />
                  </Pressable>
                );
              }

              return (
                <View key={item.id} style={slideStyle}>
                  <Image
                    source={item.image}
                    style={styles.banner}
                    contentFit="cover"
                    transition={150}
                    cachePolicy="memory-disk"
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
              );
            })}
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
          {[
            // PASS 1 — every level-0 top category, unconditionally (Grocery,
            // Electronics, Clothing, Vegetables & Fruits, ...), in the
            // server's own order.
            ...feed.data.categories,
            // PASS 2 — every subcategory of every top category, flattened,
            // appended AFTER all of pass 1 — never interleaved per-parent.
            ...feed.data.categories.flatMap(
              (category) => category.children ?? [],
            ),
          ].map((category) => (
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
            SHOP BY CATEGORY — promo tile strip
        ======================================================== */}

        <SectionHeader
          title="Shop by Category"
          onSeeAll={onOpenAllCategories}
        />
        <PromoTileStrip tiles={promoTiles} />

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
      </ReanimatedAnimated.ScrollView>
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
   PROMO TILE STRIP — "Shop by Category" at the bottom of Home

   Deliberately a different shape from the top carousel: several square
   tiles visible at once in a free-scrolling row (no snap, no dots),
   each popping in with a staggered scale/fade entrance the first time
   this section mounts, so it reads as its own distinct block rather than
   a second copy of the swipe banner.
===================================================================== */

function PromoTileStrip({
  tiles,
}: {
  tiles: { id: string; image: number; onPress: () => void }[];
}) {
  const entrance = useRef(tiles.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.stagger(
      90,
      entrance.map((value) =>
        Animated.spring(value, {
          toValue: 1,
          useNativeDriver: true,
          friction: 7,
          tension: 60,
        }),
      ),
    ).start();
    // Runs once, when the strip first mounts — `entrance` is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.promoRow}
    >
      {tiles.map((tile, index) => {
        const value = entrance[index]!;
        return (
          <Animated.View
            key={tile.id}
            style={{
              opacity: value,
              transform: [
                {
                  scale: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.85, 1],
                  }),
                },
                {
                  translateY: value.interpolate({
                    inputRange: [0, 1],
                    outputRange: [16, 0],
                  }),
                },
              ],
            }}
          >
            <Pressable
              onPress={tile.onPress}
              style={({ pressed }) => [
                styles.promoTile,
                pressed && styles.promoTilePressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Shop ${tile.id}`}
            >
              <Image
                source={tile.image}
                style={styles.promoTileImage}
                contentFit="cover"
                transition={150}
                cachePolicy="memory-disk"
              />
            </Pressable>
          </Animated.View>
        );
      })}
    </ScrollView>
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

    // Keeps the location area shorter and creates
    // clear space before the account button.
    marginRight: 50,
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

    paddingHorizontal: 13,
  },

  searchIcon: {
    marginRight: 8,
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
     BANNER
  ================================================================ */

  bannerCarousel: {
    marginTop: spacing.md,
  },

  bannerWrapper: {
    // `aspectRatio` is set per-slide (see the render loop) since the "Free
    // Delivery" banner and the three marketing graphics aren't drawn at the
    // same proportions — forcing them into one shared ratio zoomed `cover`
    // in enough to crop baked-in artwork off the image's edge. Width itself
    // is set per-slide from JS too (see `bannerSlideWidth`), capped the
    // same way `maxWidth: 640` used to.
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
     PROMO TILE STRIP
  ================================================================ */

  promoRow: {
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },

  promoTile: {
    width: 176,
    height: 176,
    borderRadius: radius.xl,
    overflow: "hidden",
    backgroundColor: colors.surfaceMuted,
    ...shadow.md,
  },

  promoTilePressed: {
    opacity: 0.9,
  },

  promoTileImage: {
    width: "100%",
    height: "100%",
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

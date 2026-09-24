/**
 * Bottom tabs:
 * Home · Categories · Food · Wishlist · Account.
 *
 * Search is still fully available — from Home's own search bar and the Cart
 * screen's search icon — it's just reached by pushing onto the current
 * stack (see HomeStack's "SearchHome" screen) instead of living in the tab
 * bar; the center slot there is Food (a placeholder for now).
 *
 * Cart is ALSO registered here (`navigation.navigate("Cart")` works from
 * anywhere), but has no button of its own in the bar (see its own
 * `tabBarButton`/`tabBarItemStyle` below) — MiniCartBar and each screen's own
 * "Go to Cart" cover that job instead. Its route still occupies a slot in
 * `state.routes`, so `tabBarItemStyle` collapses that slot's WIDTH to zero
 * too, not just its button — leaving only `tabBarButton: () => null` here
 * previously hid the button but left its `flex: 1` layout slot reserved,
 * which is exactly what showed up as a dead, tappable-nothing gap in the bar
 * where the Wishlist tab now sits.
 */

import { useEffect, useRef } from "react";
import { Animated, Easing, View, StyleSheet } from "react-native";
import ReanimatedAnimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import {
  BottomTabBar,
  createBottomTabNavigator,
  type BottomTabBarProps,
} from "@react-navigation/bottom-tabs";
import { getFocusedRouteNameFromRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, layout, spacing } from "@shared/theme";
import { useCartActions } from "@/lib/useCartActions";
import { tabBarHiddenByScroll, useMiniCartScreen } from "@/lib/tabBarVisibility";
import MiniCartOverlay from "@/components/MiniCartBar";

import {
  AccountStack,
  CartStack,
  CategoriesStack,
  HomeStack,
  WishlistStack,
} from "./stacks";

import FoodScreen from "@/screens/food/FoodScreen";

import {
  AccountIcon,
  CartIcon,
  CategoriesIcon,
  FoodIcon,
  HomeIcon,
  WishlistIcon,
} from "./TabIcons";

const Tab = createBottomTabNavigator();

function AnimatedTabIcon({
  focused,
  color,
  children,
}: {
  focused: boolean;
  color: string;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(focused ? 1 : 0.85)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: focused ? 1 : 0.85,
      friction: 7,
      tension: 90,
      useNativeDriver: true,
    }).start();
  }, [focused, scale]);

  return (
    <Animated.View
      style={[
        styles.iconWrapper,
        focused && styles.iconWrapperActive,
        {
          transform: [{ scale }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Cart tab badge — a custom one (not `options.tabBarBadge`) specifically so
 * it can pulse on every count change: React Navigation's built-in badge is
 * just a plain Text/View pair it renders internally, with no hook for
 * animating it. This is also the app's one "added to cart" cue that's
 * visible from anywhere — a flying icon from the tapped product card would
 * need to cross between independent per-tab navigators (Home/Category/
 * Product Detail all live in different stacks from the tab bar itself),
 * which is a lot of fragile cross-screen position math for the same
 * "something just changed in your cart" signal this already gives instantly
 * and reliably, wherever the tap happened.
 */
function CartBadge({ count }: { count: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const prevCount = useRef(count);

  useEffect(() => {
    if (count === prevCount.current) return;
    prevCount.current = count;

    scale.setValue(0.6);
    Animated.spring(scale, {
      toValue: 1,
      friction: 5,
      tension: 260,
      useNativeDriver: true,
    }).start();
  }, [count, scale]);

  if (count <= 0) return null;

  return (
    <Animated.View
      style={[styles.badge, { transform: [{ scale }] }]}
      pointerEvents="none"
    >
      <Animated.Text style={styles.badgeText}>{count}</Animated.Text>
    </Animated.View>
  );
}

/**
 * Pops the given scale value once when `trigger` changes — used on the Cart
 * icon itself (not just its badge number) so an add registers as one
 * cohesive pulse of the whole icon, not just a number changing in the
 * corner.
 */
function usePulse(trigger: number) {
  const scale = useRef(new Animated.Value(1)).current;
  const prev = useRef(trigger);

  useEffect(() => {
    if (trigger === prev.current) return;
    prev.current = trigger;

    Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.22,
        duration: 120,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [trigger, scale]);

  return scale;
}

/**
 * A real component (not an inline callback) so `usePulse`'s hook is safe to
 * call. No longer measures/registers a fly-to-cart landing position —
 * this icon's own tab button is hidden (`tabBarButton: () => null` below),
 * so it never actually mounts; MiniCartBar and the other on-screen cart
 * summaries register the landing target now (see flyToCart.tsx).
 */
function CartTabIcon({
  color,
  focused,
  count,
}: {
  color: string;
  focused: boolean;
  count: number;
}) {
  const pulse = usePulse(count);

  return (
    <AnimatedTabIcon color={color} focused={focused}>
      <Animated.View style={{ transform: [{ scale: pulse }] }}>
        <CartIcon color={color} focused={focused} />
      </Animated.View>
      <CartBadge count={count} />
    </AnimatedTabIcon>
  );
}

/**
 * Hides/shows the bottom tab bar via `transform: translateY` (+ opacity) on
 * a `position: absolute` overlay — a true floating overlay, exactly like
 * MiniCartBar's own `MiniCartOverlay`, not a flex sibling that reserves its
 * own layout space at all.
 *
 * This went through FOUR designs before landing here:
 *
 * 1. The original `display: "none"` toggle removed the bar from layout
 *    instantly, snapping screen content to fill the freed space with no
 *    animation at all — read as a jump/shake.
 * 2. A `translateY` slide on a permanently-reserved, constant-height FLEX
 *    slot (a plain sibling of the screen content, sized to `barHeight`)
 *    fixed the jump, but traded it for a blank, unclipped gap once the bar
 *    had slid out of it: the slot's own space was still reserved (and still
 *    needed a solid `backgroundColor` so hiding the bar didn't flash
 *    whatever was behind the whole app through it), but nothing else ever
 *    rendered into that reserved band — so once the bar's own icons faded
 *    away on a Home scroll-down, that band read as a plain dead white strip
 *    sitting right above MiniCartBar, hiding nothing but LOOKING exactly
 *    like it was hiding the last bit of product content.
 * 3. Animating that same slot's actual `height` (0 <-> `barHeight`) instead
 *    of leaving it constant "fixed" #2 by having the screen content's
 *    `flex: 1` container smoothly grow to reclaim the space the instant the
 *    bar hid — but that's a DIFFERENT bug: HomeScreen's `ScrollView` lived
 *    inside that same resizing flex container, so every hide/show tween
 *    resized the ScrollView's own viewport out from under already-rendered
 *    content, reading as the whole page shaking during a slow/held drag.
 * 4. (Here.) Stop reserving ANY flex space for the tab bar at all — make it
 *    a `position: absolute` overlay floating over the full-height screen
 *    content beneath it, the exact same pattern MiniCartBar already uses.
 *    This gets both wins at once: nothing ever resizes when the bar hides
 *    (its own bounds just translate/fade, same as before — screen content's
 *    own size never depends on it, so #3's jitter can't happen), AND once
 *    it's hidden there's no more separate "reserved slot" left over to go
 *    blank — the space is just wherever the screen's OWN content already
 *    is, which is genuinely there and genuinely visible once the bar
 *    translates/fades out of the way, not a dead reserved band. The
 *    tradeoff: every tab's own screen content is now responsible for its
 *    own bottom clearance (so it doesn't sit underneath the bar's visible
 *    plate at rest) instead of getting it for free from the old flex slot —
 *    see `useTabBarClearance` (tabBarVisibility.ts), which each tab-root
 *    screen now calls for exactly this.
 *
 * Product Detail needs no special case here anymore either — it already
 * replaces the tab bar with its own fixed footer and was always built
 * assuming full scene height (see ProductDetailScreen.tsx), which is
 * automatically true now for every route, not just Product Detail. Its
 * `hidden` branch below still exists purely to translate/fade the (now
 * overlapping, would otherwise double up with its own footer) tab bar out
 * of the way.
 *
 * The scroll-driven half of `hidden` (`tabBarHiddenByScroll`, see
 * tabBarVisibility.ts) is a Reanimated SHARED VALUE, read here inside
 * `useAnimatedStyle`'s worklet — so a scroll-direction change slides this
 * bar entirely on the UI thread, with no React re-render of this component
 * (or of HomeScreen, which is what actually sets it) on every crossing.
 * `isProductDetail`/`isHomeRoute` stay plain JS values: they only change on
 * navigation focus changes (rare, not a hot path), so there's no benefit to
 * routing those through a shared value too — `useAnimatedStyle`'s own
 * dependency array already re-runs the worklet when they change.
 */
function AnimatedTabBar(props: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  const focusedRoute = props.state.routes[props.state.index]!;
  const focusedRouteName = getFocusedRouteNameFromRoute(focusedRoute);
  const isProductDetail = focusedRouteName === "ProductDetail";
  const isHomeRoute =
    focusedRoute.name === "Home" &&
    (focusedRouteName === undefined || focusedRouteName === "HomeFeed");
  const isCategoriesRoute =
    focusedRoute.name === "Categories" &&
    (focusedRouteName === undefined || focusedRouteName === "CategoriesHome");

  const barHeight = layout.tabBarHeight + insets.bottom;

  // `MiniCartOverlay` (MiniCartBar.tsx) needs to know WHICH screen it
  // should show itself above — see `useMiniCartScreen`'s own comment for
  // what each value means. Plain React state (not a shared value): this
  // only changes on a genuine navigation focus event, not a scroll-driven
  // hot path, so there's nothing to gain from routing it through the UI
  // thread.
  const miniCartScreen = isProductDetail
    ? "productDetail"
    : isHomeRoute
      ? "home"
      : isCategoriesRoute
        ? "categories"
        : "none";
  const setMiniCartScreen = useMiniCartScreen((state) => state.setScreen);
  useEffect(() => {
    setMiniCartScreen(miniCartScreen);
  }, [miniCartScreen, setMiniCartScreen]);

  // Both the bar's own UI (`BottomTabBar`) AND its backdrop (`tabBarFloat`'s
  // own `backgroundColor`, see its style) live inside this SAME animated
  // view now — so hiding it hides the backdrop right along with the icons,
  // instead of leaving a colored plate behind with nothing on it (see
  // design #2 above).
  const animatedStyle = useAnimatedStyle(() => {
    const hidden = isProductDetail || (isHomeRoute && tabBarHiddenByScroll.value);
    return {
      transform: [
        {
          translateY: withTiming(hidden ? barHeight : 0, {
            duration: 240,
            easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
          }),
        },
      ],
      opacity: withTiming(hidden ? 0 : 1, {
        duration: hidden ? 160 : 220,
        easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
      }),
    };
  }, [isProductDetail, isHomeRoute, barHeight]);

  return (
    <ReanimatedAnimated.View
      pointerEvents="box-none"
      style={[styles.tabBarFloat, { height: barHeight }, animatedStyle]}
    >
      <BottomTabBar {...props} />
    </ReanimatedAnimated.View>
  );
}

export function MainTabs() {
  // Reads through `useCartActions` — same hook every other cart-touching
  // screen uses — rather than calling `useCart()` directly, so the badge
  // shows the exact same OPTIMISTIC count a product card or the Cart screen
  // is already showing, updated the instant a tap happens rather than only
  // once the mutation's response lands. A second, independent `useCart()`
  // call here would still share the underlying server cache entry, but its
  // *count* would lag behind by one network round trip every time — which
  // is exactly the "badge doesn't match what I just tapped" bug this avoids.
  const { cart } = useCartActions();
  const insets = useSafeAreaInsets();

  const cartCount = cart?.bill.itemCount ?? 0;

  return (
    // `MiniCartOverlay` is a SIBLING of `Tab.Navigator`, not a screen
    // inside it — see MiniCartBar.tsx's file header for why that's the
    // whole point (its position must never depend on the per-tab content
    // resize `Tab.Navigator` drives internally).
    <View style={styles.root}>
      <Tab.Navigator
        // Visibility (Product Detail's own footer, Home's hide-on-scroll) is
        // handled entirely inside AnimatedTabBar now, by translating the
        // actual bar within an always-constant-height reserved slot, rather
        // than animating that slot's own height — see its own comment for
        // why. Every tab screen's content is sized against that constant
        // slot exactly as it always was, so nothing here needs to change
        // per-screen. `tabBarStyle.height` below stays constant too: it's
        // `BottomTabBar`'s OWN fixed content height, matching the slot.
        tabBar={(props) => <AnimatedTabBar {...props} />}
        screenOptions={{
          headerShown: false,

          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textSecondary,

          tabBarStyle: {
            height: layout.tabBarHeight + insets.bottom,
            paddingBottom: insets.bottom + spacing.xs,
            paddingTop: spacing.xs,

            borderTopWidth: 1,
            borderTopColor: colors.border,

            backgroundColor: colors.surface,

            elevation: 8,
            shadowOpacity: 0.08,
            shadowRadius: 8,
            shadowOffset: {
              width: 0,
              height: -2,
            },
          },

          tabBarShowLabel: true,

          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: "600",
            marginTop: 2,
            marginBottom: 0,
          },

          tabBarItemStyle: {
            paddingHorizontal: 2,
          },
        }}
      >
        {/* HOME */}
        <Tab.Screen
          name="Home"
          component={HomeStack}
          options={{
            tabBarLabel: "Home",

            tabBarIcon: ({ color, focused }) => (
              <AnimatedTabIcon color={color} focused={focused}>
                <HomeIcon color={color} focused={focused} />
              </AnimatedTabIcon>
            ),
          }}
        />

        {/* CATEGORIES */}
        <Tab.Screen
          name="Categories"
          component={CategoriesStack}
          options={{
            tabBarLabel: "Categories",

            tabBarIcon: ({ color, focused }) => (
              <AnimatedTabIcon color={color} focused={focused}>
                <CategoriesIcon color={color} focused={focused} />
              </AnimatedTabIcon>
            ),
          }}
        />

        {/* FOOD */}
        <Tab.Screen
          name="Food"
          component={FoodScreen}
          options={{
            tabBarLabel: "Food",

            tabBarIcon: ({ color, focused }) => (
              <AnimatedTabIcon color={color} focused={focused}>
                <FoodIcon color={color} focused={focused} />
              </AnimatedTabIcon>
            ),
          }}
        />

        {/* WISHLIST */}
        <Tab.Screen
          name="Wishlist"
          component={WishlistStack}
          options={{
            tabBarLabel: "Wishlist",

            tabBarIcon: ({ color, focused }) => (
              <AnimatedTabIcon color={color} focused={focused}>
                <WishlistIcon color={color} focused={focused} />
              </AnimatedTabIcon>
            ),
          }}
        />

        {/* CART */}
        <Tab.Screen
          name="Cart"
          component={CartStack}
          listeners={({ navigation }) => ({
            // Placing an order lands on Order Tracking (or the UPI payment
            // screen) via `navigation.replace` inside CartStack — deliberately,
            // so the customer can't back-button into re-placing the same
            // order. But `replace` leaves that screen as the top of the Cart
            // tab's OWN stack indefinitely: switch to Home, add something new,
            // tap the Cart tab again, and you'd land right back on the now-
            // finished order instead of your actual cart, with no way back
            // short of the in-screen back button. Re-pointing the tab at
            // CartHome every time it's pressed FROM ANOTHER TAB fixes that,
            // while leaving the normal "already on Cart, tap it again" case
            // (e.g. mid-payment on the UPI screen) untouched — that still just
            // pops to top as usual, so an in-progress payment isn't yanked out
            // from under the customer by their own tab bar.
            tabPress: (event) => {
              if (navigation.isFocused()) return;
              event.preventDefault();
              navigation.navigate("Cart", { screen: "CartHome" });
            },
          })}
          options={{
            tabBarLabel: "Cart",

            // Custom icon (not the built-in `tabBarBadge`) so the badge can
            // pulse on every count change — see CartTabIcon/CartBadge above.
            tabBarIcon: ({ color, focused }) => (
              <CartTabIcon color={color} focused={focused} count={cartCount} />
            ),

            // No button in the bar — MiniCartBar (Home) and Categories' own
            // sticky checkout bar now cover "go to cart" once there's
            // something in it, and Product Detail has its own Go to Cart
            // button. The route itself stays fully registered and navigable
            // (every `navigation.navigate("Cart")` call elsewhere is
            // untouched) — this only removes its entry from the tab bar.
            tabBarButton: () => null,

            // `tabBarButton: () => null` above only hides the BUTTON —
            // BottomTabBar still wraps every route (including this one) in
            // its own `flex: 1` item container regardless, so without this
            // the bar reserved a blank, unlabeled slot the width of a real
            // tab. `flex: 0, width: 0` collapses that slot to nothing so the
            // remaining 5 tabs (Home/Categories/Food/Wishlist/Account) share
            // the bar evenly, with no dead gap between Food and Wishlist.
            tabBarItemStyle: { flex: 0, width: 0, padding: 0, margin: 0 },
          }}
        />

        {/* ACCOUNT */}
        <Tab.Screen
          name="Account"
          component={AccountStack}
          options={{
            tabBarLabel: "Account",

            tabBarIcon: ({ color, focused }) => (
              <AnimatedTabIcon color={color} focused={focused}>
                <AccountIcon color={color} focused={focused} />
              </AnimatedTabIcon>
            ),
          }}
        />
      </Tab.Navigator>

      <MiniCartOverlay />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // A true floating overlay now — see `AnimatedTabBar`'s own comment (design
  // #4) for why this no longer reserves any flex space of its own.
  // `backgroundColor` lives HERE (not on a separate always-present slot)
  // specifically so it hides/fades away together with the bar's own icons
  // via `animatedStyle`, rather than staying behind as a blank plate once
  // the bar itself is gone.
  tabBarFloat: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: colors.surface,
  },
  iconWrapper: {
    width: 44,
    height: 30,
    borderRadius: 16,

    alignItems: "center",
    justifyContent: "center",
  },

  iconWrapperActive: {
    backgroundColor: colors.primarySurface,
  },

  badge: {
    position: "absolute",
    top: -3,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },

  badgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "700",
    color: colors.onPrimary,
  },
});

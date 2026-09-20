/**
 * Bottom tabs (decision O2):
 * Home · Categories · Search · Cart · Account.
 */

import { useEffect, useRef } from "react";
import { Animated, Easing, View, StyleSheet } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, layout, spacing } from "@shared/theme";
import { useCartActions } from "@/lib/useCartActions";

import {
  AccountStack,
  CartStack,
  CategoriesStack,
  HomeStack,
  SearchStack,
} from "./stacks";

import {
  AccountIcon,
  CartIcon,
  CategoriesIcon,
  HomeIcon,
  SearchIcon,
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
      <Animated.Text style={styles.badgeText}>
        {count > 9 ? "9+" : count}
      </Animated.Text>
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

/** A real component (not an inline callback) so `usePulse`'s hook is safe to call. */
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
    <Tab.Navigator
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

      {/* SEARCH */}
      <Tab.Screen
        name="Search"
        component={SearchStack}
        options={{
          tabBarLabel: "Search",

          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon color={color} focused={focused}>
              <SearchIcon color={color} focused={focused} />
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
  );
}

const styles = StyleSheet.create({
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

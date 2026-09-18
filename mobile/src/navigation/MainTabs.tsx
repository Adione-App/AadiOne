/**
 * Bottom tabs (decision O2):
 * Home · Categories · Search · Cart · Account.
 */

import { useEffect, useRef } from "react";
import { Animated, View, StyleSheet } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, layout, spacing } from "@shared/theme";
import { useCart } from "@/lib/queries";
import { useLocation } from "@/lib/store";

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

export function MainTabs() {
  // Every other screen reads the cart through `useCartActions`, which uses
  // the real serviceability distance once location is known. Reading the
  // badge from `useCart()` (distanceKm defaulting to `null`) made this a
  // SECOND, independently-fetched cache entry for the same cart — mutations
  // kept both in sync, but each entry's own background refetches raced
  // independently, which is exactly the kind of split source of truth that
  // let the badge drift out of sync with what the Cart screen showed. Using
  // the same key here collapses the whole app onto one cart query.
  const serviceability = useLocation((state) => state.serviceability);
  const distanceKm = serviceability?.distanceKm ?? null;

  const { data: cart } = useCart(distanceKm);
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

        tabBarBadgeStyle: {
          backgroundColor: colors.danger,
          color: colors.onPrimary,
          fontSize: 10,
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
        options={{
          tabBarLabel: "Cart",

          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon color={color} focused={focused}>
              <CartIcon color={color} focused={focused} />
            </AnimatedTabIcon>
          ),

          ...(cartCount > 0
            ? {
                tabBarBadge: cartCount > 9 ? "9+" : cartCount,
              }
            : {}),
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
});

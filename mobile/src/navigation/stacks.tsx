/**
 * Per-tab stacks (Phase 15).
 *
 * Each tab owns its own stack so back behaviour matches the customer's
 * mental model: backing out of a product opened from Search returns to
 * Search, not to Home.
 *
 * Guests browse every catalogue screen freely. Account screens (cart,
 * orders, addresses, profile, rewards, notifications) are reached through
 * `requireAuth` — which asks for a login first and then continues to the
 * screen — and are wrapped in `RequireAccount`, which shows a login prompt
 * if one is ever on screen without a session (e.g. it expired meanwhile).
 */

import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { requireAuth } from "@/lib/authGate";
import { RequireAccount } from "@/components/RequireAccount";

import type {
  AccountStackParamList,
  CartStackParamList,
  CatalogStackParamList,
  FoodStackParamList,
  WishlistStackParamList,
} from "./types";

import HomeScreen from "@/screens/home/HomeScreen";
import SelectLocationScreen from "@/screens/location/SelectLocationScreen";

import CategoriesScreen from "@/screens/catalog/CategoriesScreen";
import SearchScreen from "@/screens/catalog/SearchScreen";
import ProductDetailScreen from "@/screens/catalog/ProductDetailScreen";
import RailProductsScreen from "@/screens/catalog/RailProductsScreen";
import StoreScreen from "@/screens/catalog/StoreScreen";
import FoodScreen from "@/screens/food/FoodScreen";
import RestaurantMenuScreen from "@/screens/food/RestaurantMenuScreen";

import CartScreen from "@/screens/cart/CartScreen";
import OrderTrackingScreen from "@/screens/orders/OrderTrackingScreen";
import OrdersListScreen from "@/screens/orders/OrdersListScreen";
import NotificationsScreen from "@/screens/notifications/NotificationsScreen";

import AddressesScreen from "@/screens/account/AddressesScreen";
import AddressFormScreen from "@/screens/account/AddressFormScreen";
import AboutScreen from "@/screens/account/AboutScreen";
import HelpScreen from "@/screens/account/HelpScreen";
import PersonalInfoScreen from "@/screens/account/PersonalInfoScreen";
import LegalScreen from "@/screens/account/LegalScreen";
import AccountScreen from "@/screens/account/AccountScreen";
import UpiPaymentScreen from "@/screens/checkout/UpiPaymentScreen";
import WishlistScreen from "@/screens/wishlist/WishlistScreen";
import RewardsScreen from "@/screens/account/RewardsScreen";

/* =====================================================================
   NAVIGATORS
===================================================================== */

const CatalogStack = createNativeStackNavigator<CatalogStackParamList>();
const CartNav = createNativeStackNavigator<CartStackParamList>();
const AccountNav = createNativeStackNavigator<AccountStackParamList>();
const WishlistNav = createNativeStackNavigator<WishlistStackParamList>();
const FoodNav = createNativeStackNavigator<FoodStackParamList>();

const noHeader = {
  headerShown: false,
  // A screen covered by another one (Home under Product Detail, …) is not
  // re-rendered while hidden — a cart tap on the top screen used to
  // re-render every screen below it too. It keeps its state and renders
  // the latest on the way back.
  freezeOnBlur: true,
} as const;

/* =====================================================================
   HOME STACK
===================================================================== */

export function HomeStack() {
  return (
    <CatalogStack.Navigator screenOptions={noHeader}>
      {/* ---------------------------------------------------------------
          HOME
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="HomeFeed">
        {({ navigation }) => (
          <HomeScreen
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", {
                productId,
              })
            }
            onOpenCategory={(categoryId) =>
              navigation.getParent()?.navigate("Categories", {
                screen: "CategoriesHome",
                params: {
                  categoryId,
                },
              })
            }
            onOpenAllCategories={() =>
              navigation.getParent()?.navigate("Categories", {
                screen: "CategoriesHome",
                params: undefined,
              })
            }
            onOpenRail={(key, title) =>
              navigation.navigate("RailProducts", { key, title })
            }
            onOpenSearch={() => navigation.navigate("SearchHome")}
            /*
             * FIX:
             * Previously this function was empty.
             *
             * Now tapping the delivery address opens the
             * Select Location screen.
             */
            onOpenLocation={() => navigation.navigate("SelectLocation")}
            onOpenCart={() =>
              requireAuth("checkout", () =>
                navigation.getParent()?.navigate("Cart", { screen: "CartHome" }),
              )
            }
            onOpenProfile={() =>
              navigation.getParent()?.navigate("Account", {
                screen: "AccountHome",
              })
            }
            onOpenOrders={() =>
              requireAuth("orders", () =>
                navigation.getParent()?.navigate("Account", {
                  screen: "Orders",
                  // Keep Account's home underneath, so "back" lands there.
                  initial: false,
                }),
              )
            }
            onOpenNotifications={() =>
              requireAuth("notifications", () => navigation.navigate("Notifications"))
            }
            onOpenOrderTracking={(orderId) =>
              navigation.navigate("OrderTracking", { orderId })
            }
            onOpenRestaurant={(sellerId) =>
              navigation.navigate("RestaurantMenu", { sellerId })
            }
            onOpenStore={(sellerId) =>
              navigation.navigate("Store", { sellerId })
            }
            onOpenFood={() =>
              navigation.getParent()?.navigate("Food", { screen: "FoodHome" })
            }
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          RESTAURANT / CAFE MENU — from Home's food rail. Pushed onto
          Home's own stack so "back" returns to Home, not the Food tab.
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="RestaurantMenu">
        {({ navigation, route }) => (
          <RestaurantMenuScreen
            sellerId={route.params.sellerId}
            fallbackName={route.params.name}
            onBack={() => navigation.goBack()}
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          STORE PAGE — from Home's stores rail.
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="Store">
        {({ navigation, route }) => (
          <StoreScreen
            sellerId={route.params.sellerId}
            onBack={() => navigation.goBack()}
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", { productId })
            }
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          NOTIFICATIONS — opened from Home's header bell. An order
          notification pushes this stack's own Order Tracking, so "back"
          from there returns to the feed.
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="Notifications">
        {({ navigation }) => (
          <RequireAccount reason="notifications" title="Notifications" onBack={() => navigation.goBack()}>
            <NotificationsScreen
              onBack={() => navigation.goBack()}
              onOpenOrder={(orderId) =>
                navigation.navigate("OrderTracking", { orderId })
              }
            />
          </RequireAccount>
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          PRODUCT DETAIL
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="ProductDetail">
        {({ navigation, route }) => (
          <ProductDetailScreen
            productId={route.params.productId}
            onBack={() => navigation.goBack()}
            onOpenProduct={(productId) =>
              navigation.push("ProductDetail", {
                productId,
              })
            }
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          SELECT LOCATION
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="SelectLocation">
        {({ navigation }) => (
          <SelectLocationScreen
            onBack={() => navigation.goBack()}
            // "Use current location" works for guests; saving an address
            // is an account's.
            onAddAddress={() =>
              requireAuth("addresses", () => navigation.navigate("AddressForm"))
            }
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM (also live-location delivery details)
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="AddressForm">
        {({ navigation, route }) => (
          <RequireAccount reason="addresses" title="Address" onBack={() => navigation.goBack()}>
            <AddressFormScreen
              addressId={route.params?.addressId}
              live={route.params?.live}
              onBack={() => navigation.goBack()}
              // Past Select Location, back to where the choice began.
              onLiveConfirmed={() => navigation.popTo("HomeFeed")}
            />
          </RequireAccount>
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          RAIL "SEE ALL"
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="RailProducts">
        {({ navigation, route }) => (
          <RailProductsScreen
            railKey={route.params.key}
            fallbackTitle={route.params.title}
            onBack={() => navigation.goBack()}
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", { productId })
            }
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          ORDER TRACKING — reachable from Home's own "order in progress"
          banner (see HomeScreen's onOpenOrderTracking), so its "back"
          returns to Home rather than jumping to the Cart/Account stack's
          own copy of this same screen.
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="OrderTracking">
        {({ navigation, route }) => (
          <RequireAccount reason="orders" title="Order details" onBack={() => navigation.goBack()}>
            <OrderTrackingScreen
              orderId={route.params.orderId}
              onBack={() => navigation.goBack()}
            />
          </RequireAccount>
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          SEARCH — pushed onto Home's own stack (see MainTabs) rather than
          living in the tab bar, so its "back" returns to wherever it was
          opened from instead of needing its own tab.
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="SearchHome">
        {({ navigation }) => (
          <SearchScreen
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", { productId })
            }
          />
        )}
      </CatalogStack.Screen>
    </CatalogStack.Navigator>
  );
}

/* =====================================================================
   CATEGORIES STACK
===================================================================== */

export function CategoriesStack() {
  return (
    <CatalogStack.Navigator screenOptions={noHeader}>
      <CatalogStack.Screen name="CategoriesHome">
        {({ navigation, route }) => (
          <CategoriesScreen
            {...(route.params?.categoryId
              ? {
                  initialCategoryId: route.params.categoryId,
                }
              : {})}
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", {
                productId,
              })
            }
          />
        )}
      </CatalogStack.Screen>

      <CatalogStack.Screen name="ProductDetail">
        {({ navigation, route }) => (
          <ProductDetailScreen
            productId={route.params.productId}
            onBack={() => navigation.goBack()}
            onOpenProduct={(productId) =>
              navigation.push("ProductDetail", {
                productId,
              })
            }
          />
        )}
      </CatalogStack.Screen>
    </CatalogStack.Navigator>
  );
}

/* =====================================================================
   FOOD STACK
===================================================================== */

export function FoodStack() {
  return (
    <FoodNav.Navigator screenOptions={noHeader}>
      <FoodNav.Screen name="FoodHome">
        {({ navigation }) => (
          <FoodScreen
            onOpenRestaurant={(sellerId) =>
              navigation.navigate("RestaurantMenu", { sellerId })
            }
            // The Food tab is a root screen: "back" returns to Home.
            onBack={() =>
              navigation.getParent()?.navigate("Home", { screen: "HomeFeed" })
            }
            onOpenLocation={() =>
              navigation
                .getParent()
                ?.navigate("Home", { screen: "SelectLocation", initial: false })
            }
          />
        )}
      </FoodNav.Screen>

      <FoodNav.Screen name="RestaurantMenu">
        {({ navigation, route }) => (
          <RestaurantMenuScreen
            sellerId={route.params.sellerId}
            fallbackName={route.params.name}
            onBack={() => navigation.goBack()}
          />
        )}
      </FoodNav.Screen>
    </FoodNav.Navigator>
  );
}

/* =====================================================================
   WISHLIST STACK
===================================================================== */

export function WishlistStack() {
  return (
    <WishlistNav.Navigator screenOptions={noHeader}>
      <WishlistNav.Screen name="WishlistHome">
        {({ navigation }) => (
          <WishlistScreen
            onOpenProduct={(productId) =>
              navigation.navigate("ProductDetail", { productId })
            }
            onBrowse={() => navigation.getParent()?.navigate("Home")}
          />
        )}
      </WishlistNav.Screen>

      <WishlistNav.Screen name="ProductDetail">
        {({ navigation, route }) => (
          <ProductDetailScreen
            productId={route.params.productId}
            onBack={() => navigation.goBack()}
            onOpenProduct={(productId) =>
              navigation.push("ProductDetail", {
                productId,
              })
            }
          />
        )}
      </WishlistNav.Screen>
    </WishlistNav.Navigator>
  );
}

/* =====================================================================
   CART STACK
===================================================================== */

export function CartStack() {
  return (
    <CartNav.Navigator screenOptions={noHeader}>
      {/* ---------------------------------------------------------------
          CART
      --------------------------------------------------------------- */}

      <CartNav.Screen name="CartHome">
        {({ navigation }) => (
          <RequireAccount reason="checkout" title="Your Cart">
            <CartScreen
              onAddAddress={() => navigation.navigate("AddressForm")}
              onChangeLocation={() => navigation.navigate("SelectLocation")}
              // The selected live location still lacks a detail the order needs.
              onCompleteLiveDetails={(live) => navigation.navigate("AddressForm", { live })}
              onBrowse={() => navigation.getParent()?.navigate("Home")}
              onOpenSearch={() =>
                navigation.getParent()?.navigate("Home", { screen: "SearchHome" })
              }
              onPlaced={(order, requiresPayment) =>
                requiresPayment
                  ? navigation.replace("UpiPayment", {
                      orderId: order.id,
                    })
                  : navigation.replace("OrderTracking", {
                      orderId: order.id,
                    })
              }
            />
          </RequireAccount>
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          UPI PAYMENT
      --------------------------------------------------------------- */}

      <CartNav.Screen
        name="UpiPayment"
        // iOS: no swipe-back past the payment — the header arrow (and
        // Android's system back, see UpiPaymentScreen) asks first.
        options={{ gestureEnabled: false }}
      >
        {({ navigation, route }) => (
          <RequireAccount reason="checkout" title="Payment">
            <UpiPaymentScreen
              orderId={route.params.orderId}
              onPaid={() =>
                navigation.replace("OrderTracking", {
                  orderId: route.params.orderId,
                })
              }
              // Left the screen without cancelling — a real payment attempt
              // may still be in flight, so land on Order Tracking where the
              // customer can check its status later.
              onCancel={() =>
                navigation.replace("OrderTracking", {
                  orderId: route.params.orderId,
                })
              }
              // The order was actually cancelled (nothing was ever attempted)
              // — there's nothing to track, so go back to a normal cart
              // instead of a tracking page for an order that no longer
              // matters.
              onCancelled={() => navigation.replace("CartHome")}
            />
          </RequireAccount>
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ORDER TRACKING
      --------------------------------------------------------------- */}

      <CartNav.Screen name="OrderTracking">
        {({ navigation, route }) => (
          <RequireAccount
            reason="orders"
            title="Order details"
            onBack={() => navigation.getParent()?.navigate("Home")}
          >
            <OrderTrackingScreen
              orderId={route.params.orderId}
              onBack={() => navigation.getParent()?.navigate("Home")}
            />
          </RequireAccount>
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESSES
      --------------------------------------------------------------- */}

      <CartNav.Screen name="Addresses">
        {({ navigation }) => (
          <RequireAccount reason="addresses" title="Addresses" onBack={() => navigation.goBack()}>
            <AddressesScreen
              onBack={() => navigation.goBack()}
              onAddAddress={() => navigation.navigate("AddressForm")}
              onEditAddress={(addressId) =>
                navigation.navigate("AddressForm", { addressId })
              }
            />
          </RequireAccount>
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM
      --------------------------------------------------------------- */}

      {/* ---------------------------------------------------------------
          SELECT LOCATION — the checkout's "Change": a saved address or
          the live location, without leaving the Cart tab
      --------------------------------------------------------------- */}

      <CartNav.Screen name="SelectLocation">
        {({ navigation }) => (
          <SelectLocationScreen
            onBack={() => navigation.goBack()}
            onAddAddress={() => navigation.navigate("AddressForm")}
          />
        )}
      </CartNav.Screen>

      <CartNav.Screen name="AddressForm">
        {({ navigation, route }) => (
          <RequireAccount reason="addresses" title="Address" onBack={() => navigation.goBack()}>
            <AddressFormScreen
              addressId={route.params?.addressId}
              live={route.params?.live}
              onBack={() => navigation.goBack()}
              // Straight back to checkout with the live location selected.
              onLiveConfirmed={() => navigation.popTo("CartHome")}
            />
          </RequireAccount>
        )}
      </CartNav.Screen>
    </CartNav.Navigator>
  );
}

/* =====================================================================
   ACCOUNT STACK
===================================================================== */

export function AccountStack() {
  return (
    <AccountNav.Navigator screenOptions={noHeader}>
      {/* ---------------------------------------------------------------
          ACCOUNT
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="AccountHome">
        {({ navigation }) => (
          <AccountScreen
            onSelect={(key) => {
              // Account-only rows ask a guest to log in first, then open.
              if (key === "personal") {
                requireAuth("profile", () => navigation.navigate("PersonalInfo"));
              }

              if (key === "orders") {
                requireAuth("orders", () => navigation.navigate("Orders"));
              }

              if (key === "addresses") {
                requireAuth("addresses", () => navigation.navigate("Addresses"));
              }

              if (key === "help") {
                navigation.navigate("Help");
              }

              if (key === "about") {
                navigation.navigate("About");
              }

              if (key === "privacy") {
                navigation.navigate("Legal", {
                  slug: "privacy",
                });
              }

              if (key === "terms") {
                navigation.navigate("Legal", {
                  slug: "terms",
                });
              }

              if (key === "wishlist") {
                // Its own bottom tab now (see MainTabs) — not a screen
                // inside AccountStack, so this hops up to the parent
                // Tab.Navigator instead of pushing locally.
                navigation.getParent()?.navigate("Wishlist");
              }

              if (key === "refer") {
                requireAuth("rewards", () => navigation.navigate("ReferEarn"));
              }
            }}
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          REFER & EARN / REWARDS
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="ReferEarn">
        {({ navigation }) => (
          <RequireAccount reason="rewards" title="Refer & Earn" onBack={() => navigation.goBack()}>
            <RewardsScreen
              onBack={() => navigation.goBack()}
              // Pinned to CartHome for the same reason navigationRef.ts's
              // `navigateToCart` is: a bare `navigate("Cart")` re-focuses
              // whatever screen an earlier order's `replace()` left on top of
              // the Cart tab's stack (OrderTracking/UpiPayment), not an
              // actual cart.
              onGoToCart={() =>
                navigation.getParent()?.navigate("Cart", { screen: "CartHome" })
              }
            />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ORDERS
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Orders">
        {({ navigation }) => (
          <RequireAccount reason="orders" title="My Orders" onBack={() => navigation.goBack()}>
            <OrdersListScreen
              onOpenOrder={(orderId) =>
                navigation.navigate("OrderTracking", {
                  orderId,
                })
              }
              onBrowse={() => navigation.getParent()?.navigate("Home")}
            />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ORDER TRACKING
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="OrderTracking">
        {({ navigation, route }) => (
          <RequireAccount reason="orders" title="Order details" onBack={() => navigation.goBack()}>
            <OrderTrackingScreen
              orderId={route.params.orderId}
              onBack={() => navigation.goBack()}
            />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESSES
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Addresses">
        {({ navigation }) => (
          <RequireAccount reason="addresses" title="Addresses" onBack={() => navigation.goBack()}>
            <AddressesScreen
              onBack={() => navigation.goBack()}
              onAddAddress={() => navigation.navigate("AddressForm")}
              onEditAddress={(addressId) =>
                navigation.navigate("AddressForm", { addressId })
              }
            />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="AddressForm">
        {({ navigation, route }) => (
          <RequireAccount reason="addresses" title="Address" onBack={() => navigation.goBack()}>
            <AddressFormScreen
              addressId={route.params?.addressId}
              onBack={() => navigation.goBack()}
            />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          PERSONAL INFORMATION
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="PersonalInfo">
        {({ navigation }) => (
          <RequireAccount reason="profile" title="Personal Information" onBack={() => navigation.goBack()}>
            <PersonalInfoScreen onBack={() => navigation.goBack()} />
          </RequireAccount>
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          HELP
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Help">
        {({ navigation }) => <HelpScreen onBack={() => navigation.goBack()} />}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ABOUT
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="About">
        {({ navigation }) => <AboutScreen onBack={() => navigation.goBack()} />}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          LEGAL
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Legal">
        {({ navigation, route }) => (
          <LegalScreen
            slug={route.params.slug}
            onBack={() => navigation.goBack()}
          />
        )}
      </AccountNav.Screen>
    </AccountNav.Navigator>
  );
}

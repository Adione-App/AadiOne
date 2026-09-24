/**
 * Per-tab stacks (Phase 15).
 *
 * Each tab owns its own stack so back behaviour matches the customer's
 * mental model: backing out of a product opened from Search returns to
 * Search, not to Home.
 */

import { createNativeStackNavigator } from "@react-navigation/native-stack";

import type {
  AccountStackParamList,
  CartStackParamList,
  CatalogStackParamList,
  WishlistStackParamList,
} from "./types";

import HomeScreen from "@/screens/home/HomeScreen";
import SelectLocationScreen from "@/screens/location/SelectLocationScreen";

import CategoriesScreen from "@/screens/catalog/CategoriesScreen";
import SearchScreen from "@/screens/catalog/SearchScreen";
import ProductDetailScreen from "@/screens/catalog/ProductDetailScreen";
import RailProductsScreen from "@/screens/catalog/RailProductsScreen";

import CartScreen from "@/screens/cart/CartScreen";
import OrderTrackingScreen from "@/screens/orders/OrderTrackingScreen";
import OrdersListScreen from "@/screens/orders/OrdersListScreen";

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

const noHeader = {
  headerShown: false,
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
            onOpenProfile={() => navigation.getParent()?.navigate("Account")}
          />
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
            onAddAddress={() => navigation.navigate("AddressForm")}
          />
        )}
      </CatalogStack.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM
      --------------------------------------------------------------- */}

      <CatalogStack.Screen name="AddressForm">
        {({ navigation, route }) => (
          <AddressFormScreen
            addressId={route.params?.addressId}
            onBack={() => navigation.goBack()}
          />
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
          <CartScreen
            onAddAddress={() => navigation.navigate("AddressForm")}
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
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          UPI PAYMENT
      --------------------------------------------------------------- */}

      <CartNav.Screen name="UpiPayment">
        {({ navigation, route }) => (
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
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ORDER TRACKING
      --------------------------------------------------------------- */}

      <CartNav.Screen name="OrderTracking">
        {({ navigation, route }) => (
          <OrderTrackingScreen
            orderId={route.params.orderId}
            onBack={() => navigation.getParent()?.navigate("Home")}
          />
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESSES
      --------------------------------------------------------------- */}

      <CartNav.Screen name="Addresses">
        {({ navigation }) => (
          <AddressesScreen
            onBack={() => navigation.goBack()}
            onAddAddress={() => navigation.navigate("AddressForm")}
            onEditAddress={(addressId) =>
              navigation.navigate("AddressForm", { addressId })
            }
          />
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM
      --------------------------------------------------------------- */}

      <CartNav.Screen name="AddressForm">
        {({ navigation, route }) => (
          <AddressFormScreen
            addressId={route.params?.addressId}
            onBack={() => navigation.goBack()}
          />
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
              if (key === "personal") {
                navigation.navigate("PersonalInfo");
              }

              if (key === "orders") {
                navigation.navigate("Orders");
              }

              if (key === "addresses") {
                navigation.navigate("Addresses");
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
                navigation.navigate("ReferEarn");
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
          <RewardsScreen
            onBack={() => navigation.goBack()}
            onGoToCart={() => navigation.getParent()?.navigate("Cart")}
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ORDERS
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Orders">
        {({ navigation }) => (
          <OrdersListScreen
            onOpenOrder={(orderId) =>
              navigation.navigate("OrderTracking", {
                orderId,
              })
            }
            onBrowse={() => navigation.getParent()?.navigate("Home")}
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ORDER TRACKING
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="OrderTracking">
        {({ navigation, route }) => (
          <OrderTrackingScreen
            orderId={route.params.orderId}
            onBack={() => navigation.goBack()}
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESSES
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="Addresses">
        {({ navigation }) => (
          <AddressesScreen
            onBack={() => navigation.goBack()}
            onAddAddress={() => navigation.navigate("AddressForm")}
            onEditAddress={(addressId) =>
              navigation.navigate("AddressForm", { addressId })
            }
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          ADDRESS FORM
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="AddressForm">
        {({ navigation, route }) => (
          <AddressFormScreen
            addressId={route.params?.addressId}
            onBack={() => navigation.goBack()}
          />
        )}
      </AccountNav.Screen>

      {/* ---------------------------------------------------------------
          PERSONAL INFORMATION
      --------------------------------------------------------------- */}

      <AccountNav.Screen name="PersonalInfo">
        {({ navigation }) => (
          <PersonalInfoScreen onBack={() => navigation.goBack()} />
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

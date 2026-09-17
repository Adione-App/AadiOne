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
} from "./types";

import HomeScreen from "@/screens/home/HomeScreen";
import SelectLocationScreen from "@/screens/location/SelectLocationScreen";

import CategoriesScreen from "@/screens/catalog/CategoriesScreen";
import SearchScreen from "@/screens/catalog/SearchScreen";
import ProductDetailScreen from "@/screens/catalog/ProductDetailScreen";
import RailProductsScreen from "@/screens/catalog/RailProductsScreen";

import CartScreen from "@/screens/cart/CartScreen";
import CheckoutScreen from "@/screens/checkout/CheckoutScreen";
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

/* =====================================================================
   NAVIGATORS
===================================================================== */

const CatalogStack = createNativeStackNavigator<CatalogStackParamList>();
const CartNav = createNativeStackNavigator<CartStackParamList>();
const AccountNav = createNativeStackNavigator<AccountStackParamList>();

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
            onOpenSearch={() => navigation.getParent()?.navigate("Search")}
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
            onOpenCart={() => navigation.getParent()?.navigate("Cart")}
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
   SEARCH STACK
===================================================================== */

export function SearchStack() {
  return (
    <CatalogStack.Navigator screenOptions={noHeader}>
      <CatalogStack.Screen name="SearchHome">
        {({ navigation }) => (
          <SearchScreen
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
            onCheckout={() => navigation.navigate("Checkout")}
            onBrowse={() => navigation.getParent()?.navigate("Home")}
          />
        )}
      </CartNav.Screen>

      {/* ---------------------------------------------------------------
          CHECKOUT
      --------------------------------------------------------------- */}

      <CartNav.Screen name="Checkout">
        {({ navigation }) => (
          <CheckoutScreen
            onBack={() => navigation.goBack()}
            onAddAddress={() => navigation.navigate("Addresses")}
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
            onCancel={() =>
              navigation.replace("OrderTracking", {
                orderId: route.params.orderId,
              })
            }
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
            }}
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

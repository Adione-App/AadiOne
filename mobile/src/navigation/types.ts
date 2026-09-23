/**
 * Typed navigation params.
 *
 * Declaring param lists means a screen cannot be pushed without the data it
 * needs — the OTP screen is unreachable without a mobile number, tracking
 * without an order id.
 */

import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type AuthStackParamList = {
  Splash: undefined;
  MobileEntry: undefined;
  OtpVerify: {
    mobile: string;
    resendAfterSeconds: number;
    devOtp?: string | undefined;
  };
};

/**
 * Product detail, checkout and tracking are declared in EVERY stack that can
 * reach them. Pushing onto the current stack (rather than jumping to a shared
 * one) is what keeps the back button doing what the customer expects — back
 * from a product opened in Search returns to Search, not to Home.
 */
export type CatalogStackParamList = {
  // Named distinctly from the bottom-tab routes ("Home", "Categories",
  // "Search" on the parent Tab.Navigator) that host these stacks — reusing
  // the tab's own name for its stack's landing screen makes React Navigation
  // warn about ambiguous same-name nesting and can misroute a bare
  // `navigate("Home")` between the tab and the screen.
  HomeFeed: undefined;
  CategoriesHome: { categoryId?: string } | undefined;
  SearchHome: undefined;
  ProductDetail: { productId: string };
  SelectLocation: undefined;
  AddressForm: { addressId?: string } | undefined;
  RailProducts: {
    key: "POPULAR" | "DAILY_ESSENTIALS" | "BEST_SELLERS" | "RECENTLY_ADDED" | "OFFERS";
    title: string;
  };
};

export type CartStackParamList = {
  CartHome: undefined;
  UpiPayment: { orderId: string };
  OrderTracking: { orderId: string };
  Addresses: undefined;
  AddressForm: { addressId?: string } | undefined;
  ProductDetail: { productId: string };
};

export type AccountStackParamList = {
  AccountHome: undefined;
  Orders: undefined;
  OrderTracking: { orderId: string };
  Addresses: undefined;
  AddressForm: { addressId?: string } | undefined;
  PersonalInfo: undefined;
  Help: undefined;
  About: undefined;
  Legal: { slug: "privacy" | "terms" };
  ReferEarn: undefined;
};

/** The Wishlist tab's own stack — "My Wishlist" on Account (see stacks.tsx)
 * jumps to this same tab rather than duplicating it inside AccountStack. */
export type WishlistStackParamList = {
  WishlistHome: undefined;
  ProductDetail: { productId: string };
};

export type AuthScreenProps<T extends keyof AuthStackParamList> =
  NativeStackScreenProps<AuthStackParamList, T>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends AuthStackParamList {}
  }
}

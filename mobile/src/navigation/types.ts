/**
 * Typed navigation params.
 *
 * Declaring param lists means a screen cannot be pushed without the data it
 * needs — the OTP screen is unreachable without a mobile number, tracking
 * without an order id.
 */

import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { AddressSuggestion, FixQuality } from "@shared/location";

/**
 * A fresh GPS fix from Select Location, handed to the delivery-details form
 * (AddressForm in live mode). `suggestion` is the reverse-geocoded address —
 * null when the geocoder found nothing (the form then asks for it).
 */
export interface LiveFixParams {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  quality: FixQuality;
  suggestion: AddressSuggestion | null;
}

/** Edit a saved address, add one, or (with `live`) confirm a live location. */
type AddressFormParams = { addressId?: string; live?: LiveFixParams } | undefined;

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
  AddressForm: AddressFormParams;
  RailProducts: {
    key: "POPULAR" | "DAILY_ESSENTIALS" | "BEST_SELLERS" | "RECENTLY_ADDED" | "OFFERS";
    title: string;
  };
  OrderTracking: { orderId: string };
  Notifications: undefined;
  /** A restaurant's / cafe's menu, opened from Home's food rail. */
  RestaurantMenu: { sellerId: string; name?: string };
  /** A marketplace seller's store page, opened from Home's stores rail. */
  Store: { sellerId: string };
};

/** The Food tab's own stack: restaurants & cafes, then a menu. */
export type FoodStackParamList = {
  FoodHome: undefined;
  RestaurantMenu: { sellerId: string; name?: string };
};

export type CartStackParamList = {
  CartHome: undefined;
  UpiPayment: { orderId: string };
  OrderTracking: { orderId: string };
  Addresses: undefined;
  /** "Change" on the checkout address — a saved address or the live location. */
  SelectLocation: undefined;
  AddressForm: AddressFormParams;
  ProductDetail: { productId: string };
};

export type AccountStackParamList = {
  AccountHome: undefined;
  Orders: undefined;
  OrderTracking: { orderId: string };
  Addresses: undefined;
  AddressForm: AddressFormParams;
  PersonalInfo: undefined;
  Help: undefined;
  About: undefined;
  Legal: { slug: "privacy" | "terms" };
  ReferEarn: undefined;
  SellOnAadione: undefined;
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

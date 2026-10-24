/**
 * What tapping an admin banner does — ONE place for every screen (Food,
 * Categories, Store pages, the shared PromoBanner; Home maps its own banners
 * here too). The banner carries only a validated action type and a target
 * reference (an id, a rail key, an https URL); the route is chosen here, so
 * no banner component knows route names. The server already turns a target
 * that has gone into NONE, so a tap never opens a dead page.
 */

import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import { BANNER_RAIL_TARGETS, type BannerDto } from "@shared";
import { navigationRef } from "@/navigation/navigationRef";
import { showCartNotice } from "@/lib/cartNotice";

type BannerAction = Pick<BannerDto, "actionType" | "actionValue">;

/** Only absolute https links are ever opened (the server checks the same on save). */
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Whether a tap does anything — a decorative banner is not a button. */
export function bannerIsTappable(banner: BannerAction): boolean {
  // The Food section needs no target value.
  if (banner.actionType === "FOOD") return true;
  if (banner.actionType === "NONE" || !banner.actionValue) return false;
  return banner.actionType !== "URL" || isHttpsUrl(banner.actionValue);
}

export function openBannerAction(banner: BannerAction): void {
  if (banner.actionType === "FOOD") {
    if (!navigationRef.isReady()) return;
    (navigationRef.navigate as (name: string, params?: object) => void)("Food", { screen: "FoodHome" });
    return;
  }
  const value = banner.actionValue;
  if (!value || !bannerIsTappable(banner)) return;

  if (banner.actionType === "URL") {
    void Linking.openURL(value).catch(() => undefined);
    return;
  }
  if (banner.actionType === "COUPON") {
    void Clipboard.setStringAsync(value);
    showCartNotice(`Code ${value} copied — apply it at checkout.`);
    return;
  }

  if (!navigationRef.isReady()) return;
  // The tab navigator is untyped (see navigationRef.ts) — same cast as navigateToCart.
  const go = navigationRef.navigate as (name: string, params?: object) => void;
  switch (banner.actionType) {
    case "CATEGORY":
      go("Categories", { screen: "CategoriesHome", params: { categoryId: value } });
      break;
    case "PRODUCT":
      go("Home", { screen: "ProductDetail", params: { productId: value } });
      break;
    case "STORE":
      go("Home", { screen: "Store", params: { sellerId: value } });
      break;
    case "RESTAURANT":
      go("Food", { screen: "RestaurantMenu", params: { sellerId: value } });
      break;
    case "RAIL": {
      const rail = BANNER_RAIL_TARGETS.find((entry) => entry.key === value);
      if (rail) go("Home", { screen: "RailProducts", params: { key: rail.key, title: rail.label } });
      break;
    }
    default:
      break;
  }
}

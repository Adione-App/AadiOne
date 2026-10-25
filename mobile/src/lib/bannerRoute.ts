/**
 * Where a banner tap goes inside the app — the tab and the screen in it —
 * for the banner actions that open a screen (lib/bannerAction.ts performs
 * it). Pure, so `npm run test:unit` covers every destination.
 *
 * A screen inside another tab's stack is opened with `initial: false`, so
 * that stack keeps its own first screen underneath. Without it, React
 * Navigation makes the target the ONLY screen of a tab not opened yet: a
 * Home "restaurant" card opened that restaurant's menu as the whole Food tab
 * — Back had no restaurant list to return to, and tapping Food later showed
 * that menu again instead of the restaurants and cafes.
 */

import { BANNER_RAIL_TARGETS, type BannerDto } from "@shared";

export interface BannerRoute {
  /** The tab (MainTabs route). */
  name: "Home" | "Categories" | "Food";
  params: { screen: string; params?: Record<string, unknown>; initial?: boolean };
}

type BannerAction = Pick<BannerDto, "actionType" | "actionValue">;

export function bannerRoute(banner: BannerAction): BannerRoute | null {
  if (banner.actionType === "FOOD") return { name: "Food", params: { screen: "FoodHome" } };
  const value = banner.actionValue;
  if (!value) return null;
  switch (banner.actionType) {
    case "CATEGORY":
      return { name: "Categories", params: { screen: "CategoriesHome", params: { categoryId: value } } };
    case "PRODUCT":
      return { name: "Home", params: { screen: "ProductDetail", params: { productId: value }, initial: false } };
    case "STORE":
      return { name: "Home", params: { screen: "Store", params: { sellerId: value }, initial: false } };
    case "RESTAURANT":
      // The restaurant list stays beneath the menu: Back and the Food tab lead to it.
      return { name: "Food", params: { screen: "RestaurantMenu", params: { sellerId: value }, initial: false } };
    case "RAIL": {
      const rail = BANNER_RAIL_TARGETS.find((entry) => entry.key === value);
      return rail ? { name: "Home", params: { screen: "RailProducts", params: { key: rail.key, title: rail.label }, initial: false } } : null;
    }
    default:
      return null;
  }
}

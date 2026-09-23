/**
 * Whether the bottom tab bar should be hidden because the active screen's
 * own content is being scrolled — a module-scoped Reanimated SHARED VALUE,
 * not React/Zustand state.
 *
 * This is what lets HomeScreen's scroll handler flip it directly from its
 * `useAnimatedScrollHandler` WORKLET (running on the UI thread, once per
 * native scroll event) and MainTabs' `AnimatedTabBar` read it straight from
 * its own `useAnimatedStyle` — neither side ever touches React state or
 * causes a re-render for this. A plain `useState`/Zustand version of this
 * (the previous implementation) required a JS-thread round trip on every
 * scroll-direction change just to notify a completely different component
 * tree, which is exactly the kind of "React re-render tied to a scroll
 * event" this file now avoids entirely — `mutable.value = x` from a worklet
 * updates the UI thread directly, no bridge hop, no re-render.
 *
 * `MainTabs.tsx`'s `AnimatedTabBar` is what actually reads this (see its
 * `useDerivedValue`/`useAnimatedStyle`), combined there with its own reason
 * to hide the bar (Product Detail's screen-replacement footer).
 */

import { makeMutable } from "react-native-reanimated";
import { create } from "zustand";

export const tabBarHiddenByScroll = makeMutable(false);

/**
 * Which screen (if any) the global mini-cart overlay should show itself on
 * — plain Zustand/React state, not a shared value, because it only changes
 * on a genuine navigation focus event (rare, not a scroll-driven hot path),
 * so there's no benefit to routing it through the UI thread the way
 * `tabBarHiddenByScroll` needs to be.
 *
 * `MainTabs.tsx`'s `AnimatedTabBar` is what sets this (it already computes
 * the focused-route checks for its own tab-bar-hide logic). `MiniCartBar
 * .tsx`'s `MiniCartOverlay` reads it both to decide whether to render at
 * all, and — combined with `tabBarHiddenByScroll`/`productDetailFooterHeight`
 * below — to decide what to rest above:
 *
 *   "home"           — Home's own feed. The tab bar hides on scroll there
 *                       (`tabBarHiddenByScroll`), so the mini-cart tracks
 *                       that same shared value to stay glued to it.
 *   "categories"      — Categories' landing/drill-down/product-grid views
 *                       (all one screen, "CategoriesHome"). The tab bar
 *                       never hides on scroll there, so this is a constant
 *                       "sit above the tab bar" position.
 *   "productDetail"   — Product Detail, which replaces the tab bar entirely
 *                       with its OWN fixed Add-to-Cart footer (see
 *                       `productDetailFooterHeight` below) — the mini-cart
 *                       rests above THAT instead.
 *   "none"            — every other screen (Search, Cart, Account, …): the
 *                       overlay renders nothing.
 */
export type MiniCartScreen = "home" | "categories" | "productDetail" | "none";

export const useMiniCartScreen = create<{
  screen: MiniCartScreen;
  setScreen: (screen: MiniCartScreen) => void;
}>((set) => ({
  screen: "home",
  setScreen: (screen) =>
    set((state) => (state.screen === screen ? state : { screen })),
}));

/**
 * Product Detail's own footer's REAL measured height (see its `onLayout`) —
 * a shared value (not React state) purely so `MiniCartOverlay`'s
 * `useAnimatedStyle` worklet can read it directly alongside
 * `tabBarHiddenByScroll`, the same way it already does for Home.
 */
export const productDetailFooterHeight = makeMutable(0);

/**
 * Imperative navigation handle for code that lives OUTSIDE any screen's own
 * navigation context — currently just `MiniCartOverlay` (see
 * MiniCartBar.tsx), which is rendered as a root-level overlay sibling of
 * `Tab.Navigator` (not a screen inside it), so `useNavigation()` isn't
 * available there: that hook only resolves inside a component that's
 * actually part of a navigator's screen tree, and an overlay mounted
 * alongside the navigator itself doesn't qualify. This is React
 * Navigation's own documented pattern for exactly that situation (the other
 * common use is deep-linking from a push notification handler).
 */

import { createNavigationContainerRef } from "@react-navigation/native";

export const navigationRef = createNavigationContainerRef();

/** Go to the Cart tab from anywhere, without needing a screen's own `navigation` prop. */
export function navigateToCart(): void {
  if (!navigationRef.isReady()) return;
  // `RootParamList` (declared in types.ts) only covers the auth stack — the
  // bottom tab navigator (Home/Categories/Food/Cart/Account) was never
  // given its own typed param list (see `MainTabs.tsx`'s untyped
  // `createBottomTabNavigator()`), so every OTHER call site that navigates
  // to a tab by name (e.g. HomeScreen's `navigation.getParent()?.navigate
  // ("Cart")`) is in the same boat — this cast matches that existing,
  // pre-existing looseness rather than inventing a new one.
  navigationRef.navigate("Cart" as never);
}

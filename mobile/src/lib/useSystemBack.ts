/**
 * Android system back (the back button AND the edge-swipe gesture, which
 * Android delivers as the same event) for a screen whose in-app back does
 * more than pop the stack: close its own menu, step back inside the screen,
 * confirm before leaving.
 *
 * The listener only exists while the screen is FOCUSED. A plain
 * `BackHandler` listener in a screen's effect stays registered while the
 * screen sits hidden under another one (tab screens and covered stack
 * screens stay mounted; `freezeOnBlur` stops renders, not effects), and the
 * newest listener runs first — so it swallowed the back press of whichever
 * screen was actually on top (CategoriesScreen's did, once a category was
 * open: system back did nothing on Product Detail, Cart, Search…).
 *
 * `handler` returns true when it handled the press; false (or a null
 * handler) leaves it to React Navigation, which pops the stack as usual.
 */

import { useCallback } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

export function useSystemBack(handler: (() => boolean) | null): void {
  useFocusEffect(
    useCallback(() => {
      if (!handler) return undefined;
      const subscription = BackHandler.addEventListener("hardwareBackPress", handler);
      return () => subscription.remove();
    }, [handler]),
  );
}

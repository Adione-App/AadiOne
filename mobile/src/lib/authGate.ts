/**
 * The one place that decides whether an action needs a login — every screen
 * goes through `requireAuth` instead of opening the login screens itself.
 *
 * Signed in: the action just runs. Signed out (a guest browsing): the existing
 * mobile-number → OTP screens open as a modal OVER the screen the customer is
 * on (the "Login" route in App.tsx), so closing it leaves them exactly where
 * they were, and after a successful login the action they started runs once.
 * The rules live in guestAccess.ts; this file connects them to navigation.
 */

import { StackActions } from "@react-navigation/native";
import { create } from "zustand";

import { navigationRef } from "@/navigation/navigationRef";
import { createAuthGate, type AuthGateState, type AuthReason } from "./guestAccess";
import { useAuth } from "./store";
import { useVariantSheet } from "./variantSheet";

export type { AuthReason } from "./guestAccess";

/** Whether the gate's login flow is open, and why — read by the login screen. */
export const useAuthGate = create<AuthGateState>(() => ({ open: false, reason: null }));

/** The root stack's state when the login modal is on it; otherwise null. */
function rootWithLoginOpen() {
  const root = navigationRef.isReady() ? navigationRef.getRootState() : undefined;
  return root?.routes.some((route) => route.name === "Login") ? root : null;
}

/** Pops the whole login modal off the ROOT stack, back to the app beneath it. */
function closeLoginRoute(): void {
  const root = rootWithLoginOpen();
  if (!root) return;
  // Targets the root stack explicitly: from inside the login flow a plain
  // goBack would only step from OTP back to the mobile-number screen.
  navigationRef.dispatch({ ...StackActions.popTo("Main"), target: root.key });
}

const gate = createAuthGate({
  isAuthenticated: () => useAuth.getState().status === "authenticated",

  presentLogin: () => {
    if (!navigationRef.isReady()) return false;
    // The variant sheet is a root overlay drawn above every screen — it
    // would cover the login screen opened from its own "Add to cart".
    useVariantSheet.getState().close();
    if (!rootWithLoginOpen()) {
      navigationRef.navigate("Login", { screen: "MobileEntry" });
    }
    return true;
  },

  dismissLogin: closeLoginRoute,

  defer: (fn) => {
    setTimeout(fn, 0);
  },

  onChange: (state) => useAuthGate.setState(state),
});

/**
 * Runs `action` when signed in; otherwise asks for a login (once, however
 * many taps) and runs `action` after it succeeds. Returns true only when the
 * action ran now. `action` is held in memory only, never persisted.
 */
export function requireAuth(reason: AuthReason, action?: () => void): boolean {
  return gate.require(reason, action);
}

/** An explicit "Log in" button: the login flow, nothing to resume afterwards. */
export function openLogin(reason: AuthReason = "account"): void {
  gate.require(reason);
}

/** Called by the OTP screen once the session is set. */
export function loginCompleted(): void {
  gate.completed();
}

/** Called when the login flow unmounts — cancelled, unless it already completed. */
export function loginClosed(): void {
  gate.closed();
}

/** "Not now" on the login screen: back to whatever the customer was doing. */
export function cancelLogin(): void {
  closeLoginRoute();
}

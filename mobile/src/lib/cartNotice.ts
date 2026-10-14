/**
 * A short popup message about the cart — e.g. a quantity limit reached —
 * shown by CartNoticeToast (components/CartNoticeToast.tsx), which App.tsx
 * and the variant sheet render. Repeating the same message while it is on
 * screen only restarts its timer, so fast repeated taps never stack popups.
 */

import { create } from "zustand";

interface CartNoticeState {
  message: string | null;
  /** Bumped on every show, so the toast restarts its timer for a repeat. */
  version: number;
  show: (message: string) => void;
  hide: () => void;
}

export const useCartNotice = create<CartNoticeState>((set) => ({
  message: null,
  version: 0,
  show: (message) => set((state) => ({ message, version: state.version + 1 })),
  hide: () => set({ message: null }),
}));

export function showCartNotice(message: string): void {
  useCartNotice.getState().show(message);
}

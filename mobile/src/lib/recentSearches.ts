/**
 * Recent search terms — persisted locally (device-only, no server round
 * trip needed for something this disposable), same manual
 * AsyncStorage-read-then-hydrate pattern `useLocation` in store.ts uses,
 * rather than introducing zustand's `persist` middleware for the first time
 * in this codebase.
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "adione.recent-searches";
const MAX_RECENT = 8;

interface RecentSearchesState {
  terms: string[];
  hydrate: () => Promise<void>;
  add: (term: string) => void;
  remove: (term: string) => void;
  clear: () => void;
}

function persist(terms: string[]): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(terms)).catch(() => {
    // Best-effort — losing recent-search history is not worth surfacing an error for.
  });
}

export const useRecentSearches = create<RecentSearchesState>((set, get) => ({
  terms: [],

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((term) => typeof term === "string")) {
        set({ terms: parsed });
      }
    } catch {
      // Corrupt/unreadable cache — start fresh, same as a first-time customer.
    }
  },

  add(term) {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;

    // Case-insensitive de-dup, re-adding moves it back to the front instead
    // of leaving a stale second copy further down the list.
    const next = [
      trimmed,
      ...get().terms.filter((existing) => existing.toLowerCase() !== trimmed.toLowerCase()),
    ].slice(0, MAX_RECENT);

    set({ terms: next });
    persist(next);
  },

  remove(term) {
    const next = get().terms.filter((existing) => existing !== term);
    set({ terms: next });
    persist(next);
  },

  clear() {
    set({ terms: [] });
    persist([]);
  },
}));

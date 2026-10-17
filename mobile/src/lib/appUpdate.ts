/**
 * Optional / mandatory app updates — the app side of shared/app-version.ts.
 *
 *   - Checked at startup (App.tsx, briefly awaited so a required update shows
 *     before the app does) and again whenever the app returns to the
 *     foreground — e.g. back from the Play Store / App Store.
 *   - REQUIRED: App.tsx replaces ALL navigation with UpdateRequiredScreen —
 *     there is no screen behind it to go back to. It stays until a check of
 *     the INSTALLED version (expo-application) passes; opening the store is
 *     never taken as having updated.
 *   - The server enforces the same minimum on the customer APIs; its
 *     APP_UPDATE_REQUIRED answer (api.ts) also switches the app here.
 *   - OPTIONAL: one prompt (AppUpdatePrompt). "Later" hides it for this exact
 *     release (promptKey) for a few days; a new release asks again.
 *   - Offline: the last answer for THIS installed version is remembered, so a
 *     required update cannot be skipped by starting the app without a network;
 *     with no answer at all the app is not blocked (the server still enforces).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { AppUpdateStatus, type AppUpdateCheckDto } from "@shared";
import { api, onAppUpdateRequired } from "./api";
import { installedApp } from "./appVersion";

const STORAGE_KEY = "adione.app-update.v1";
/** "Later" on an optional update hides that release's prompt for this long. */
export const OPTIONAL_DISMISS_MS = 3 * 24 * 60 * 60_000;
/** Foreground re-checks closer together than this are skipped (unless an update is required). */
const RECHECK_MIN_GAP_MS = 60_000;

interface Persisted {
  /** The installed version the answer was for — a different install ignores it. */
  installedVersion: string | null;
  check: AppUpdateCheckDto | null;
  dismissed: { promptKey: string; at: number } | null;
}

interface AppUpdateState {
  /** The server's latest answer for this installed version. */
  check: AppUpdateCheckDto | null;
  /** "Later" on an optional update. */
  dismissed: { promptKey: string; at: number } | null;
  checking: boolean;
  lastCheckedAt: number;
  hydrate: () => Promise<void>;
  /** Asks the server; keeps the previous answer when the network fails. */
  refresh: (options?: { force?: boolean }) => Promise<void>;
  /** The server refused a request: this version must update. */
  requireUpdate: (update: AppUpdateCheckDto | null) => void;
  dismissOptional: () => void;
}

function persist(state: Pick<AppUpdateState, "check" | "dismissed">): void {
  const value: Persisted = { installedVersion: installedApp.version, check: state.check, dismissed: state.dismissed };
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value)).catch(() => undefined);
}

export const useAppUpdate = create<AppUpdateState>((set, get) => ({
  check: null,
  dismissed: null,
  checking: false,
  lastCheckedAt: 0,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Persisted;
      // An answer for another install (the customer updated meanwhile) is stale.
      const sameInstall = saved.installedVersion === installedApp.version;
      set({
        check: sameInstall ? (saved.check ?? null) : null,
        dismissed: saved.dismissed ?? null,
      });
    } catch {
      // Unreadable: start without a remembered answer.
    }
  },

  refresh: async (options = {}) => {
    const { platform, version } = installedApp;
    if (!platform) return;
    const state = get();
    const required = state.check?.status === AppUpdateStatus.REQUIRED;
    if (state.checking) return;
    if (!options.force && !required && Date.now() - state.lastCheckedAt < RECHECK_MIN_GAP_MS) return;

    set({ checking: true });
    try {
      const query = `platform=${platform}${version ? `&version=${encodeURIComponent(version)}` : ""}`;
      const check = await api.get<AppUpdateCheckDto>(`/app-version/policy?${query}`);
      set({ check, lastCheckedAt: Date.now() });
      persist({ check, dismissed: get().dismissed });
    } catch {
      // Offline or the server is unreachable: keep the last answer.
    } finally {
      set({ checking: false });
    }
  },

  requireUpdate: (update) => {
    const current = get().check;
    const check: AppUpdateCheckDto | null = update
      ? { ...update, status: AppUpdateStatus.REQUIRED }
      : current
        ? { ...current, status: AppUpdateStatus.REQUIRED }
        : null;
    if (check) {
      set({ check });
      persist({ check, dismissed: get().dismissed });
    }
    // Either way, ask for the full, current answer (store link, message).
    void get().refresh({ force: true });
  },

  dismissOptional: () => {
    const check = get().check;
    if (!check || check.status !== AppUpdateStatus.OPTIONAL) return;
    const dismissed = { promptKey: check.promptKey, at: Date.now() };
    set({ dismissed });
    persist({ check, dismissed });
  },
}));

// Any API answer of APP_UPDATE_REQUIRED, from anywhere in the app.
onAppUpdateRequired((update) => useAppUpdate.getState().requireUpdate(update));

/** True while the installed version must update before the app may be used. */
export function selectUpdateRequired(state: Pick<AppUpdateState, "check">): boolean {
  return state.check?.status === AppUpdateStatus.REQUIRED;
}

/** The optional prompt to show now, or null (none, dismissed for this release, or required instead). */
export function selectOptionalPrompt(
  state: Pick<AppUpdateState, "check" | "dismissed">,
  now: number = Date.now(),
): AppUpdateCheckDto | null {
  const check = state.check;
  if (!check || check.status !== AppUpdateStatus.OPTIONAL) return null;
  const dismissed = state.dismissed;
  if (dismissed && dismissed.promptKey === check.promptKey && now - dismissed.at < OPTIONAL_DISMISS_MS) return null;
  return check;
}

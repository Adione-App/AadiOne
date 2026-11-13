/**
 * Branding — the brand assets published in Admin Panel → Branding & Identity
 * (GET /branding), for the logos drawn INSIDE the app.
 *
 * The app's launcher icon and its native splash are part of the installed
 * app and never change from here (they change with an app release).
 *
 * Offline and without flashing: the last branding the app received is kept on
 * the phone (AsyncStorage) and read during start-up (`hydrate`, awaited with
 * the other local reads in App.tsx); images are kept in expo-image's disk
 * cache. A fresh copy is asked for at launch and when the app comes back to
 * the foreground (at most every few minutes); a newly published logo shows
 * from then on. Until anything is published — or if an image cannot be
 * loaded — the bundled Aadione artwork is shown (components/BrandMark.tsx).
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { brandAssetFor, type BrandUse, type PublicBrandAsset, type PublicBrandingDto } from '@shared';
import { api } from './api';

const STORAGE_KEY = 'adione.branding.v1';
/** A foreground refresh at most this often. */
export const BRANDING_REFRESH_MS = 10 * 60_000;

interface BrandingState {
  branding: PublicBrandingDto | null;
  fetchedAt: number;
  hydrate: () => Promise<void>;
  /** Asks the server again (skipped if asked recently, unless forced). */
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

export function isBrandingDto(value: unknown): value is PublicBrandingDto {
  if (!value || typeof value !== 'object') return false;
  const dto = value as Partial<PublicBrandingDto>;
  return typeof dto.revision === 'number' && !!dto.assets && typeof dto.assets === 'object';
}

export const useBranding = create<BrandingState>((set, get) => ({
  branding: null,
  fetchedAt: 0,

  async hydrate() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      // A newer copy fetched meanwhile wins over the disk copy.
      if (isBrandingDto(parsed) && !get().branding) set({ branding: parsed });
    } catch {
      // Unreadable cache: the bundled artwork is shown until the next fetch.
    }
  },

  async refresh(options) {
    if (!options?.force && Date.now() - get().fetchedAt < BRANDING_REFRESH_MS) return;
    set({ fetchedAt: Date.now() });
    try {
      const branding = await api.get<PublicBrandingDto>('/branding');
      if (!isBrandingDto(branding)) return;
      set({ branding });
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(branding)).catch(() => undefined);
    } catch {
      // Offline or the server is unreachable: keep showing the cached branding.
    }
  },
}));

/** The published asset for a place in the app (fallback chain applied), or null for the bundled artwork. */
export function useBrandAsset(use: BrandUse): PublicBrandAsset | null {
  return useBranding((state) => brandAssetFor(state.branding, use));
}

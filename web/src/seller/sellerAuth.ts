/**
 * Seller panel session.
 *
 * Sellers apply themselves (POST /auth/seller/signup — signed in straight
 * away) or are created by Aadione, and sign in with their EMAIL and PASSWORD
 * only (POST /auth/seller/login). There is no seller OTP sign-in: the server
 * refuses a mobile OTP for seller accounts. A forgotten password is reset by
 * the seller through an emailed link (POST /auth/seller/forgot-password, then
 * /auth/seller/reset-password). The session lives in the seller client's own
 * storage key (see sellerApi.ts), fully separate from the admin panel's. What
 * a signed-in seller may open depends on its lifecycle (GET /seller/lifecycle
 * — the server enforces it; SellerApp only mirrors it).
 */

import { create } from 'zustand';
import type { AuthResponse, SellerSignupRequest, UserDto } from '@shared';
import { SELLER_ROLES, sellerApi, sellerClient } from './sellerApi';

/** GET /auth/password-status (backend auth.service getPasswordStatus). */
interface PasswordStatus {
  hasPassword: boolean;
  passwordChangeRequired: boolean;
}

interface SellerAuthState {
  status: 'loading' | 'authenticated' | 'anonymous';
  user: UserDto | null;
  /** Null until known. */
  password: PasswordStatus | null;
  /** Email + password (POST /auth/seller/login) — the only seller sign-in. */
  passwordLogin: (email: string, password: string) => Promise<void>;
  /** "Forgot Password?" — the server answers the same for every email. */
  requestPasswordReset: (email: string) => Promise<string>;
  /** Sets a new password from the emailed link; the seller then signs in. */
  resetPassword: (token: string, newPassword: string) => Promise<string>;
  /** Public seller application — creates an APPLICATION_PENDING seller and signs in. */
  signup: (input: SellerSignupRequest) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  restore: () => Promise<void>;
  logout: () => Promise<void>;
  clear: () => void;
}

/** POST /auth/seller/login adds whether the password must still be changed (an older Aadione-issued one). */
type SellerLoginResponse = AuthResponse & { passwordChangeRequired: boolean };

async function loadPasswordStatus(): Promise<PasswordStatus | null> {
  return sellerApi.get<PasswordStatus>('/auth/password-status').catch(() => null);
}

const isSellerRole = (role: string): boolean => SELLER_ROLES.includes(role);

/** Revokes a refresh token server-side; failures are irrelevant here. */
async function revoke(refreshToken: string | null): Promise<void> {
  if (!refreshToken) return;
  await sellerApi.post('/auth/logout', { refreshToken }).catch(() => undefined);
}

let restoreInFlight: Promise<void> | null = null;

export const useSellerAuth = create<SellerAuthState>((set) => ({
  status: 'loading',
  user: null,
  password: null,

  async passwordLogin(email, password) {
    // The server refuses any account that is not a seller-panel role with an
    // active seller membership, with one generic error.
    const result = await sellerApi.post<SellerLoginResponse>('/auth/seller/login', { email, password });

    // Defence in depth only — authorization is the server's.
    if (!isSellerRole(result.user.role)) {
      await revoke(result.tokens.refreshToken);
      throw new Error('This account is not an Aadione seller account.');
    }

    sellerClient.setTokens(result.tokens.accessToken, result.tokens.refreshToken);
    set({
      user: result.user,
      status: 'authenticated',
      password: { hasPassword: true, passwordChangeRequired: result.passwordChangeRequired },
    });
  },

  async requestPasswordReset(email) {
    const result = await sellerApi.post<{ message: string }>('/auth/seller/forgot-password', { email });
    return result.message;
  },

  async resetPassword(token, newPassword) {
    const result = await sellerApi.post<{ message: string }>('/auth/seller/reset-password', { token, newPassword });
    return result.message;
  },

  async signup(input) {
    const result = await sellerApi.post<SellerLoginResponse>('/auth/seller/signup', input);
    sellerClient.setTokens(result.tokens.accessToken, result.tokens.refreshToken);
    set({ user: result.user, status: 'authenticated', password: { hasPassword: true, passwordChangeRequired: false } });
  },

  async changePassword(currentPassword, newPassword) {
    // Every other session ends server-side; this one continues on the new pair.
    const result = await sellerApi.post<AuthResponse>('/auth/change-password', { currentPassword, newPassword });
    sellerClient.setTokens(result.tokens.accessToken, result.tokens.refreshToken);
    set({ user: result.user, password: { hasPassword: true, passwordChangeRequired: false } });
  },

  async restore() {
    if (restoreInFlight) return restoreInFlight;

    // `.finally` runs after this assignment, on every path — so the guard is
    // always released, including when there was no stored session at all.
    restoreInFlight = (async () => {
      const stored = sellerClient.loadStoredRefreshToken();
      if (!stored) {
        set({ user: null, status: 'anonymous' });
        return;
      }

      try {
        const refreshed = await sellerClient.refreshSession();
        if (!refreshed) {
          sellerClient.clearTokensIfCurrent(stored);
          set({ user: null, status: 'anonymous' });
          return;
        }

        const user = await sellerApi.get<UserDto>('/auth/me');
        if (!isSellerRole(user.role)) {
          await revoke(sellerClient.getStoredRefreshToken());
          sellerClient.setTokens(null, null);
          set({ user: null, status: 'anonymous' });
          return;
        }

        set({ user, status: 'authenticated', password: await loadPasswordStatus() });
      } catch {
        sellerClient.clearTokensIfCurrent(stored);
        set({ user: null, status: 'anonymous' });
      }
    })().finally(() => {
      restoreInFlight = null;
    });

    return restoreInFlight;
  },

  async logout() {
    await revoke(sellerClient.getStoredRefreshToken());
    sellerClient.setTokens(null, null);
    set({ user: null, status: 'anonymous', password: null });
  },

  clear() {
    sellerClient.setTokens(null, null);
    set({ user: null, status: 'anonymous', password: null });
  },
}));

/**
 * API client.
 *
 * SECURITY MODEL
 * --------------
 * - Access token: memory only.
 * - Refresh token: localStorage.
 *
 * REFRESH MODEL
 * -------------
 * - Only one refresh request runs inside the current page instance.
 * - If another browser page/reload rotates the refresh token while this
 *   page is refreshing, this client detects the newer token and retries.
 *
 * This is important when the user presses F5 repeatedly.
 *
 * SESSIONS
 * --------
 * Each client made by `createApiClient` owns ONE session: its own in-memory
 * access token, its own refresh-token localStorage key, its own refresh
 * single-flight and its own "session lost" handler. The admin panel uses the
 * default client exported below (unchanged key "adione.refresh"); the seller
 * panel has a separate client (seller/sellerApi.ts), so signing in as a
 * seller can never replace — or be replaced by — an admin session in the
 * same browser.
 */

import type { ApiError, ApiResponse, ErrorCode } from "@shared";

const BASE =
  (import.meta.env["VITE_API_URL"] as string | undefined) ?? "/api/v1";

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "true",
};

export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface RefreshPayload {
  tokens: {
    accessToken: string;
    refreshToken: string;
  };
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

  body?: unknown;

  /** multipart/form-data body (the browser sets the boundary header). */
  formData?: FormData;

  /** Return the response bytes (e.g. a PDF) instead of the JSON envelope. */
  responseType?: "json" | "blob";

  /**
   * Prevent infinite:
   *
   * request
   * -> 401
   * -> refresh
   * -> retry
   * -> 401
   * -> ...
   */
  retried?: boolean;
}

/**
 * Sleep helper.
 *
 * A tiny delay is useful when two different browser page instances
 * are competing during rapid F5 presses:
 *
 * old page -> refreshes T1
 * new page -> tries T1
 * old page -> stores T2
 *
 * The new page gets a brief chance to observe T2.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/**
 * Perform exactly one HTTP refresh attempt.
 */
async function refreshWithToken(token: string): Promise<RefreshPayload | null> {
  try {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",

      headers: {
        ...BASE_HEADERS,
      },

      body: JSON.stringify({
        refreshToken: token,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as ApiResponse<RefreshPayload>;

    if (!body.success) {
      return null;
    }

    if (!body.data.tokens.accessToken || !body.data.tokens.refreshToken) {
      return null;
    }

    return body.data;
  } catch {
    return null;
  }
}

/**
 * One independent authenticated session against the API.
 */
export function createApiClient(refreshStorageKey: string) {
  /**
   * Access token intentionally remains memory-only.
   */
  let accessToken: string | null = null;

  /**
   * Refresh token has a memory copy but localStorage is the source of truth
   * between browser reloads.
   */
  let refreshToken: string | null = localStorage.getItem(refreshStorageKey);

  let onSessionLost: (() => void) | null = null;

  /**
   * Save token pair.
   */
  function setTokens(access: string | null, refresh: string | null): void {
    accessToken = access;
    refreshToken = refresh;

    if (refresh) {
      localStorage.setItem(refreshStorageKey, refresh);
    } else {
      localStorage.removeItem(refreshStorageKey);
    }
  }

  /**
   * Remove tokens only if the refresh token currently in storage is the
   * token we expect.
   *
   * This protects against this race:
   *
   * Page A:
   *   T1 -> refresh -> stores T2
   *
   * Page B:
   *   T1 -> refresh fails
   *
   * Page B must NOT delete T2.
   */
  function clearTokensIfCurrent(expectedRefreshToken?: string | null): boolean {
    const currentStoredToken = localStorage.getItem(refreshStorageKey);

    /**
     * If another page already stored a newer refresh token,
     * leave it untouched.
     */
    if (
      expectedRefreshToken &&
      currentStoredToken &&
      currentStoredToken !== expectedRefreshToken
    ) {
      return false;
    }

    accessToken = null;
    refreshToken = null;

    localStorage.removeItem(refreshStorageKey);

    return true;
  }

  /**
   * Load persisted refresh token.
   */
  function loadStoredRefreshToken(): string | null {
    refreshToken = localStorage.getItem(refreshStorageKey);

    return refreshToken;
  }

  function getStoredRefreshToken(): string | null {
    return localStorage.getItem(refreshStorageKey);
  }

  function getAccessToken(): string | null {
    return accessToken;
  }

  function onSessionExpired(handler: () => void): void {
    onSessionLost = handler;
  }

  /**
   * Single-flight refresh inside this JavaScript page instance.
   */
  let refreshInFlight: Promise<boolean> | null = null;

  /**
   * Restore/rotate the authentication tokens.
   *
   * Handles:
   *
   * 1. concurrent API requests inside one page;
   * 2. React StrictMode;
   * 3. multiple fast browser reloads where another page rotates the token;
   * 4. another tab refreshing the same session.
   */
  async function refreshSession(): Promise<boolean> {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = (async () => {
      /**
       * We allow a few attempts because another browser page
       * may replace the token while this request is running.
       */
      const maxAttempts = 3;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const tokenUsed = localStorage.getItem(refreshStorageKey);

        if (!tokenUsed) {
          return false;
        }

        refreshToken = tokenUsed;

        const result = await refreshWithToken(tokenUsed);

        /**
         * Successful rotation.
         */
        if (result) {
          setTokens(result.tokens.accessToken, result.tokens.refreshToken);

          return true;
        }

        /**
         * Refresh failed.
         *
         * Before declaring the session dead, check whether another
         * page/tab has rotated the token.
         */
        let latestToken = localStorage.getItem(refreshStorageKey);

        if (latestToken && latestToken !== tokenUsed) {
          /**
           * Another page already stored a newer token.
           *
           * Retry with it.
           */
          continue;
        }

        /**
         * Another refresh may still be finishing.
         *
         * Wait briefly before checking again.
         */
        await sleep(150);

        latestToken = localStorage.getItem(refreshStorageKey);

        if (latestToken && latestToken !== tokenUsed) {
          continue;
        }

        /**
         * Stable token failed.
         *
         * There is no reason to hammer the backend repeatedly.
         */
        return false;
      }

      return false;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  /**
   * Main API request.
   */
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
    };

    // FormData must set its own multipart Content-Type (with the boundary).
    if (options.formData) delete headers["Content-Type"];

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",

      headers,

      ...(options.formData
        ? { body: options.formData }
        : options.body !== undefined
          ? {
              body: JSON.stringify(options.body),
            }
          : {}),
    });

    if (response.status === 204) {
      return undefined as T;
    }

    // A file response: hand back the bytes. Errors still arrive as JSON below.
    if (options.responseType === "blob" && response.ok) {
      return (await response.blob()) as T;
    }

    const body = (await response
      .json()
      .catch(() => null)) as ApiResponse<T> | null;

    /**
     * Access token expired.
     */
    if (response.status === 401 && !options.retried) {
      /**
       * Remember the token that existed when this recovery started.
       */
      const tokenAtFailure = localStorage.getItem(refreshStorageKey);

      const refreshed = await refreshSession();

      if (refreshed) {
        return request<T>(path, {
          ...options,
          retried: true,
        });
      }

      /**
       * Another browser page may have rotated the refresh token while
       * this request was waiting.
       */
      const currentToken = localStorage.getItem(refreshStorageKey);

      if (currentToken && tokenAtFailure && currentToken !== tokenAtFailure) {
        /**
         * Try once more using the newer token.
         */
        const recovered = await refreshSession();

        if (recovered) {
          return request<T>(path, {
            ...options,
            retried: true,
          });
        }
      }

      /**
       * Only clear if nobody replaced the token.
       */
      const cleared = clearTokensIfCurrent(tokenAtFailure);

      if (cleared) {
        onSessionLost?.();
      }
    }

    if (!body || body.success === false) {
      const error = (body as ApiError | null)?.error;

      throw new ApiRequestError(
        (error?.code ?? "INTERNAL_ERROR") as ErrorCode,

        error?.message ?? "Something went wrong. Please try again.",

        response.status,

        error?.requestId,
      );
    }

    return body.data;
  }

  const api = {
    get: <T>(path: string) => request<T>(path),

    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "POST",
        body,
      }),

    patch: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "PATCH",
        body,
      }),

    put: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "PUT",
        body,
      }),

    delete: <T>(path: string) =>
      request<T>(path, {
        method: "DELETE",
      }),

    /** multipart/form-data POST (file uploads). */
    postForm: <T>(path: string, formData: FormData) =>
      request<T>(path, {
        method: "POST",
        formData,
      }),

    /** Authorised file download — never a public URL. */
    getBlob: (path: string) =>
      request<Blob>(path, {
        responseType: "blob",
      }),
  };

  return {
    api,
    request,
    setTokens,
    clearTokensIfCurrent,
    loadStoredRefreshToken,
    getStoredRefreshToken,
    getAccessToken,
    onSessionExpired,
    refreshSession,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/* -------------------------------------------------------------------------- */
/* The admin panel's session — same storage key and exports as before.        */
/* -------------------------------------------------------------------------- */

const adminClient = createApiClient("adione.refresh");

export const {
  api,
  request,
  setTokens,
  clearTokensIfCurrent,
  loadStoredRefreshToken,
  getStoredRefreshToken,
  getAccessToken,
  onSessionExpired,
  refreshSession,
} = adminClient;

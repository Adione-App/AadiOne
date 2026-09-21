/**
 * API client for the customer app.
 *
 * Written around the network this app actually runs on: rural 3G, where a
 * request routinely succeeds server-side while the response never arrives.
 *
 *   - GETs retry twice with backoff + jitter.
 *   - MUTATIONS NEVER auto-retry. A retried POST /orders would be a second
 *     order. Retrying is a user action, and it reuses the same
 *     Idempotency-Key so the server collapses it.
 *   - Refresh is single-flight: concurrent 401s wait on one attempt instead of
 *     stampeding and racing the token rotation.
 *   - Access token in memory, refresh token in the Keychain / Android
 *     Keystore — never AsyncStorage, which is plain text on a rooted device.
 */

import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import type { ApiError, ApiResponse, ErrorCode } from "@shared";

const BASE_URL =
  process.env["EXPO_PUBLIC_API_URL"] ??
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)
    ?.apiBaseUrl ??
  "http://10.0.2.2:4000/api/v1";

/**
 * Converts a backend-relative image path into an absolute URL.
 *
 * Example:
 *
 * /static/products/example.jpg
 *
 * becomes:
 *
 * https://flavored-record-thaw.ngrok-free.dev/static/products/example.jpg
 */
export function resolveImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  // Android emulator:
  // http://10.0.2.2:4000
  const serverBaseUrl = BASE_URL.replace(/\/api\/v1\/?$/, "");

  // If backend returns localhost, replace it with mobile backend host.
  if (/^https?:\/\/localhost(?::\d+)?/i.test(url)) {
    const path = url.replace(/^https?:\/\/localhost(?::\d+)?/i, "");
    return `${serverBaseUrl}${path}`;
  }

  // If backend returns 127.0.0.1, replace it too.
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?/i.test(url)) {
    const path = url.replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, "");
    return `${serverBaseUrl}${path}`;
  }

  // Already an absolute non-local URL.
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  // Relative URL.
  if (url.startsWith("/")) {
    return `${serverBaseUrl}${url}`;
  }

  return `${serverBaseUrl}/${url}`;
}

/**
 * Recursively converts image URLs returned by the backend.
 *
 * The backend can return images in several places:
 *
 *   imageUrl
 *   thumbUrl
 *   cardUrl
 *   images[].url
 *
 * This keeps the UI components simple because they always receive
 * an absolute URL.
 */
function normalizeImageUrls<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  // Handle arrays.
  if (Array.isArray(data)) {
    return data.map((item) => normalizeImageUrls(item)) as T;
  }

  // Handle primitive values.
  if (typeof data !== "object") {
    return data;
  }

  const object = data as Record<string, unknown>;

  // Known image fields in the AdiOne DTOs.
  for (const key of ["imageUrl", "thumbUrl", "cardUrl"]) {
    if (key in object) {
      const value = object[key];

      if (typeof value === "string") {
        object[key] = resolveImageUrl(value);
      }
    }
  }

  // ProductImageDto uses "url".
  //
  // We only convert it when it looks like a local/static image path.
  // This avoids accidentally changing unrelated URLs.
  if ("url" in object) {
    const value = object.url;

    if (
      typeof value === "string" &&
      (value.startsWith("/static/") ||
        value.startsWith("static/") ||
        value.startsWith("/uploads/") ||
        value.startsWith("uploads/"))
    ) {
      object.url = resolveImageUrl(value);
    }
  }

  // Recursively process nested objects.
  for (const key of Object.keys(object)) {
    const value = object[key];

    if (value !== null && typeof value === "object") {
      object[key] = normalizeImageUrls(value);
    }
  }

  return data;
}

/**
 * ngrok's free tier serves an HTML interstitial ("You are about to visit...")
 * to requests it thinks came from a browser.
 *
 * This header suppresses that page.
 */
const NGROK_HEADERS: Record<string, string> = {
  "ngrok-skip-browser-warning": "true",
};

const REFRESH_KEY = "adione.refresh";
const REQUEST_TIMEOUT_MS = 15_000;
const ORDER_TIMEOUT_MS = 30_000;

export class ApiRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    /** Present on 429 responses — seconds until the request may be retried. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** True when retrying might genuinely succeed. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }

  /** True when the device could not reach the server at all. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function saveRefreshToken(token: string | null): Promise<void> {
  if (token) {
    await SecureStore.setItemAsync(REFRESH_KEY, token);
  } else {
    await SecureStore.deleteItemAsync(REFRESH_KEY);
  }
}

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_KEY);
}

export function onSessionExpired(handler: () => void): void {
  onSessionLost = handler;
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = await readRefreshToken();

      if (!refreshToken) {
        return false;
      }

      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...NGROK_HEADERS,
        },
        body: JSON.stringify({
          refreshToken,
        }),
      });

      if (!response.ok) {
        return false;
      }

      const body = (await response.json()) as ApiResponse<{
        tokens: {
          accessToken: string;
          refreshToken: string;
        };
      }>;

      if (!body.success) {
        return false;
      }

      accessToken = body.data.tokens.accessToken;

      await saveRefreshToken(body.data.tokens.refreshToken);

      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;

  /**
   * Sent on order and payment creation so a retry
   * cannot duplicate the operation.
   */
  idempotencyKey?: string;

  timeoutMs?: number;
  retried?: boolean;

  /**
   * An external cancellation signal — e.g. TanStack Query's own `signal`,
   * passed through so a query that's been superseded (search-as-you-type
   * firing a newer term) actually stops the underlying fetch instead of
   * completing uselessly in the background.
   */
  signal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function performRequest<T>(
  path: string,
  options: RequestOptions,
): Promise<T> {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ??
      (options.idempotencyKey ? ORDER_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
  );

  // Bridges an external signal (see RequestOptions.signal) onto our own
  // controller — `fetch` only takes one signal, and we always need ours for
  // the timeout regardless of whether a caller passed their own.
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...NGROK_HEADERS,
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined
        ? {
            body: JSON.stringify(options.body),
          }
        : {}),
      signal: controller.signal,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const body = (await response
      .json()
      .catch(() => null)) as ApiResponse<T> | null;

    if (response.status === 401 && !options.retried) {
      if (await refreshSession()) {
        return performRequest<T>(path, {
          ...options,
          retried: true,
        });
      }

      accessToken = null;

      await saveRefreshToken(null);

      onSessionLost?.();
    }

    if (!body || body.success === false) {
      const error = (body as ApiError | null)?.error;

      throw new ApiRequestError(
        (error?.code ?? "INTERNAL_ERROR") as ErrorCode,

        error?.message ?? "Something went wrong. Please try again.",

        response.status,

        error?.retryAfterSeconds,
      );
    }

    /**
     * IMPORTANT:
     *
     * Convert backend-relative image paths
     * before returning data to the UI.
     */
    return normalizeImageUrls(body.data);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw error;
    }

    throw new ApiRequestError(
      "SERVICE_UNAVAILABLE" as ErrorCode,
      "No internet connection. Please check and try again.",
      0,
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";

  const canRetry = method === "GET";

  const maxAttempts = canRetry ? 3 : 1;

  let lastError: ApiRequestError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await performRequest<T>(path, options);
    } catch (error) {
      lastError = error as ApiRequestError;

      // An externally cancelled request (e.g. React Query dropping a
      // superseded search-as-you-type query) isn't a failure worth
      // retrying — nothing will ever read the result either way.
      if (options.signal?.aborted) throw lastError;

      if (!canRetry || !lastError.isRetryable || attempt === maxAttempts - 1) {
        throw lastError;
      }

      await sleep(400 * 2 ** attempt + Math.random() * 300);
    }
  }

  throw lastError;
}

export const api = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) =>
    request<T>(path, { signal: options?.signal }),

  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, {
      method: "POST",
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),

  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body,
    }),

  delete: <T>(path: string) =>
    request<T>(path, {
      method: "DELETE",
    }),
};

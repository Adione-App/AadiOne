// The Delete Account page's calls to the Aadione API — the SAME endpoints the
// app uses to sign in and to delete an account:
//   POST /auth/send-otp    → the configured SMS provider sends a real OTP
//   POST /auth/verify-otp  → proves the visitor controls the number
//   DELETE /auth/me        → the app's own account deletion, with that proof
// No OTP, token or account detail is ever logged, stored or shown; the
// access token lives only in the page's memory for the few minutes it is used.

import { apiBaseUrl } from '../config/site.js'

export const REQUEST_TIMEOUT_MS = 20_000

/** Words for a failure the server did not explain (or that never reached it). */
export function fallbackMessage(status) {
  if (status === 0) return 'Aadione could not be reached. Check your internet connection and try again.'
  if (status === 401) return 'Your verification has expired. Please verify your mobile number again.'
  if (status === 403) return 'This request was refused. Please try again later or contact Aadione support.'
  if (status === 404) return 'This service is not available right now. Please contact Aadione support.'
  if (status === 408) return 'The request took too long. Please try again.'
  if (status === 429) return 'Too many attempts. Please wait a while before trying again.'
  if (status >= 500) return 'Something went wrong at our end. Please try again in a few minutes.'
  return 'Something went wrong. Please try again.'
}

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * One API call. Every AppError message from the server is written to be shown
 * to a customer (backend/src/common/errors.ts), so it is shown as-is; anything
 * else gets a plain explanation. A blocked or failed network request (offline,
 * CORS, timeout) never pretends to have reached the server.
 */
export async function callApi(path, { method = 'POST', body, accessToken, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    const timedOut = error?.name === 'AbortError'
    throw new ApiError(fallbackMessage(timedOut ? 408 : 0), { status: timedOut ? 408 : 0, code: timedOut ? 'TIMEOUT' : 'NETWORK' })
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 204) return null
  let json = null
  try {
    json = await response.json()
  } catch {
    // No JSON body (a proxy error page, for example).
  }
  if (!response.ok || json?.success === false) {
    throw new ApiError(json?.error?.message || fallbackMessage(response.status), { status: response.status, code: json?.error?.code })
  }
  return json?.data ?? null
}

export const isValidMobile = (mobile) => /^[6-9]\d{9}$/.test(mobile.trim())
export const isValidOtp = (otp) => /^\d{4,8}$/.test(otp.trim())

export const sendOtp = (mobile, opts) => callApi('/auth/send-otp', { ...opts, body: { mobile: mobile.trim() } })

/** Only the fields this page needs — the rest of the response (tokens, profile) is never kept. */
export async function verifyOtp(mobile, otp, opts) {
  const data = await callApi('/auth/verify-otp', { ...opts, body: { mobile: mobile.trim(), otp: otp.trim() } })
  return { accessToken: data?.tokens?.accessToken ?? null, isNewUser: Boolean(data?.user?.isNewUser) }
}

export const deleteAccount = (accessToken, opts) => callApi('/auth/me', { ...opts, method: 'DELETE', accessToken })

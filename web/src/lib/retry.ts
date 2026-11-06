/**
 * Retrying a request that failed on the way (a dropped connection, a server
 * that was briefly unavailable) — never one the server refused on purpose.
 *
 *   retryable   no answer at all (fetch / XHR network error, a thrown
 *               TypeError), or an HTTP 408 / 429 / 5xx;
 *   not         any other answer (400 bad file, 403, 409 under review…):
 *               trying again would only repeat the refusal.
 *
 * Only for requests that are safe to send twice: the storage PUT of an upload
 * (same key, same bytes) and the photo attach (the server treats an upload
 * already on the product as attached — never a second row).
 */

export const RETRY_DELAYS_MS = [700, 2000] as const;

/** An HTTP status worth trying again. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** A failure worth trying again: no answer, or a retryable status (`error.status`). */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 0 || isRetryableStatus(status);
  return (error as { retryable?: unknown } | null)?.retryable === true;
}

/** `run`, tried again after each of `delays` while it fails retryably; the last failure is thrown. */
export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: { delays?: readonly number[]; retryable?: (error: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS;
  const retryable = options.retryable ?? isRetryableError;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= delays.length || !retryable(error)) throw error;
      await sleep(delays[attempt]!);
    }
  }
}

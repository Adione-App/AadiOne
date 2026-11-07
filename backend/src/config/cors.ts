/**
 * The browser-origin allow-list (CORS_ORIGINS) — parsing and matching, pure.
 *
 * CORS_ORIGINS is a comma-separated list of exact origins, e.g.
 *   https://adione.in,https://www.adione.in,https://admin.adione.in
 * Each entry is normalised (trimmed, lower-case scheme and host, no trailing
 * slash), so "https://Adione.in/" and "https://adione.in" are the same. An
 * entry that is not a plain http(s) origin — a path, a wildcard, "*" — is
 * IGNORED (and reported at startup), never treated as "allow everything":
 * these routes are called with credentials, and a wildcard there would let
 * any website act as the signed-in user.
 */

/** "https://Adione.in/" → "https://adione.in"; null when it is not a plain http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
  return url.origin.toLowerCase();
}

export function parseCorsOrigins(raw: string): { origins: string[]; invalid: string[] } {
  const origins = new Set<string>();
  const invalid: string[] = [];
  for (const entry of raw.split(',')) {
    if (!entry.trim()) continue;
    const origin = normalizeOrigin(entry);
    if (origin) origins.add(origin);
    else invalid.push(entry.trim());
  }
  return { origins: [...origins], invalid };
}

/** Whether a request's Origin header is on the list ("null" and malformed origins never are). */
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowed.includes(normalized);
}

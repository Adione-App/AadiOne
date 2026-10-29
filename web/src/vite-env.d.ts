/// <reference types="vite/client" />

/**
 * Typed build-time configuration.
 *
 * Both are optional: when unset the app uses same-origin paths, which is what
 * the Vite dev proxy and the production Nginx container both serve.
 */
interface ImportMetaEnv {
  /** Absolute API base, e.g. https://host/api/v1. Omit for same-origin. */
  readonly VITE_API_URL?: string;
  /** Absolute Socket.IO origin. Omit for same-origin. */
  readonly VITE_SOCKET_URL?: string;
  /** Map tiles for the admin location tools; "off" hides the map. See lib/mapConfig.ts. */
  readonly VITE_MAP_TILE_URL?: string;
  readonly VITE_MAP_TILE_ATTRIBUTION?: string;
  /** Nominatim-compatible reverse-geocoding endpoint; unset = no address suggestions. */
  readonly VITE_REVERSE_GEOCODE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

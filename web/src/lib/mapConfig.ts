/**
 * Map and reverse-geocoding providers for the admin location tools — chosen at
 * build time, never hard-coded keys.
 *
 *   VITE_MAP_TILE_URL          Raster tile template ({z}/{x}/{y}). Default: the
 *                              OpenStreetMap standard tiles, which need no key
 *                              (fine for low-volume admin use; attribution is
 *                              shown). "off" hides the map — the latitude /
 *                              longitude fields still work.
 *   VITE_MAP_TILE_ATTRIBUTION  Attribution HTML for a custom tile provider.
 *   VITE_REVERSE_GEOCODE_URL   A Nominatim-compatible `/reverse` endpoint
 *                              (e.g. a self-hosted Nominatim, or a provider's
 *                              Nominatim-compatible API including its key).
 *                              Unset: no "Suggest address" button. Nothing is
 *                              ever geocoded automatically.
 */

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const env = (key: 'VITE_MAP_TILE_URL' | 'VITE_MAP_TILE_ATTRIBUTION' | 'VITE_REVERSE_GEOCODE_URL'): string =>
  ((import.meta.env[key] as string | undefined) ?? '').trim();

export const MAP_TILES: { url: string; attribution: string } | null =
  env('VITE_MAP_TILE_URL').toLowerCase() === 'off'
    ? null
    : env('VITE_MAP_TILE_URL')
      ? { url: env('VITE_MAP_TILE_URL'), attribution: env('VITE_MAP_TILE_ATTRIBUTION') || 'Map data' }
      : { url: OSM_TILES, attribution: OSM_ATTRIBUTION };

export const REVERSE_GEOCODE_URL: string | null = env('VITE_REVERSE_GEOCODE_URL') || null;

/** An address suggested for a map point — every field optional, never applied without the admin's click. */
export interface SuggestedAddress {
  addressLine: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  /** The provider's one-line description, shown so the admin can judge it. */
  displayName: string | null;
}

/**
 * Reverse-geocodes one point with the configured Nominatim-compatible
 * provider. Throws on any failure; the caller shows it and keeps the form.
 */
export async function suggestAddress(latitude: number, longitude: number): Promise<SuggestedAddress> {
  if (!REVERSE_GEOCODE_URL) throw new Error('No reverse-geocoding provider is configured.');
  const url = new URL(REVERSE_GEOCODE_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'en');
  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The address lookup failed (${response.status}).`);
  const body = (await response.json()) as { display_name?: string; address?: Record<string, string>; error?: string };
  if (body.error || !body.address) throw new Error(body.error ?? 'No address was found for this point.');
  const a = body.address;
  const first = (...keys: string[]): string | null => {
    for (const key of keys) if (a[key]?.trim()) return a[key]!.trim();
    return null;
  };
  const street = [first('house_number'), first('road', 'pedestrian', 'street')].filter(Boolean).join(', ');
  const pincode = first('postcode')?.replace(/\s/g, '') ?? null;
  return {
    addressLine: street || null,
    locality: first('neighbourhood', 'suburb', 'quarter', 'hamlet'),
    city: first('village', 'town', 'city', 'municipality'),
    district: first('state_district', 'county'),
    state: first('state'),
    pincode: pincode && /^\d{6}$/.test(pincode) ? pincode : null,
    displayName: body.display_name ?? null,
  };
}

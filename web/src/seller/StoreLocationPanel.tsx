/**
 * Store location — the seller's own address and map point
 * (GET/PATCH /seller/location).
 *
 * The point is where every distance to a customer is measured from: whether
 * this seller delivers to an address, the delivery fee and the ETA. Every
 * seller — Aadione included — sets its own here; there is no central store
 * location. Changes are audited on the server.
 *
 * Address (Indian structure, @shared/address): shop / building & street,
 * locality, village / city / town, district, state, PIN, landmark — the map
 * point is stored separately and never derived from the text.
 *
 * The browser can read the operator's real position, which is almost always
 * the shop itself: one fresh fix with its accuracy (@shared/location), shown
 * for confirmation before it replaces the point. Nothing is ever filled in
 * silently, and a failed reading never becomes a made-up point.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAddressLines, isValidPincode, landmarkPhrase } from '@shared/address';

/** Aadione operates only in Rajasthan; the server checks the state and the map point. */
const SERVICE_STATE = 'Rajasthan';
import { COORDINATE_PROBLEM_MESSAGE, coordinateProblem } from '@shared/distance';
import { DETECT_MESSAGE, describeAccuracy, type DetectResult } from '@shared/location';
import { Button, ErrorBanner, Field, Panel, inputClass } from '@/components/ui';
import LocationMap from '@/components/LocationMap';
import { detectBrowserLocation } from '@/lib/browserLocation';
import { REVERSE_GEOCODE_URL, suggestAddress, type SuggestedAddress } from '@/lib/mapConfig';
import { sellerApi, sellerErrorMessage } from './sellerApi';
import { sellerKeys } from './sellerQueries';

export interface SellerLocation {
  id: string;
  name: string;
  addressLine: string;
  locality: string | null;
  city: string;
  district: string | null;
  state: string;
  pincode: string;
  landmark: string | null;
  phone: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
  /** Admin read only: the latest audited change of the point / address. */
  lastChange?: { at: string; byName: string | null; byRole: string | null } | null;
}

const LOCATION_KEY = [...sellerKeys.all, 'location'] as const;

/** A seller that has only applied has no map point yet (0, 0 = not set). */
const isUnset = (location: SellerLocation): boolean =>
  location.latitude === 0 && location.longitude === 0 && !location.addressLine.trim();

const mapLink = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

/**
 * Where the panel reads and saves the store point. Default: the signed-in
 * seller's own (/seller/location). The admin panel passes its own
 * (/admin/sellers/:id/location) to correct a store's point.
 */
export interface StoreLocationSource {
  queryKey: readonly unknown[];
  load: () => Promise<SellerLocation>;
  save: (body: Record<string, unknown>) => Promise<SellerLocation>;
  errorMessage: (error: unknown) => string;
  /**
   * "Use my current location" — only for someone standing IN the shop. Never
   * applied silently: a reading is shown with its accuracy and used only on
   * "Use this point".
   */
  deviceLocation: boolean;
  /** The button's wording (the admin's says it is only for someone at the storefront). */
  deviceLocationLabel?: string;
  /** Admin: the store's display name is edited with its address. */
  nameEditable?: boolean;
  /** Admin: a map with a movable pin, and address suggestions when a provider is configured. */
  map?: boolean;
  /** Admin: the delivery radius drawn around the pin. */
  radiusKm?: number | null;
}

const SELLER_SOURCE: StoreLocationSource = {
  queryKey: LOCATION_KEY,
  load: () => sellerApi.get<SellerLocation>('/seller/location'),
  save: (body) => sellerApi.patch<SellerLocation>('/seller/location', body),
  errorMessage: sellerErrorMessage,
  deviceLocation: true,
};

export default function StoreLocationPanel({
  onSaved,
  readOnly = false,
  source = SELLER_SOURCE,
}: {
  onSaved: (message: string) => void;
  /** Onboarding under review: show the location, no Edit. */
  readOnly?: boolean;
  source?: StoreLocationSource;
}) {
  const queryClient = useQueryClient();
  const location = useQuery({
    queryKey: source.queryKey,
    queryFn: source.load,
  });
  const [editing, setEditing] = useState(false);

  if (location.isPending) return <Panel title="Store location">Loading…</Panel>;
  if (location.isError) {
    return (
      <Panel title="Store location">
        <ErrorBanner message={source.errorMessage(location.error)} />
      </Panel>
    );
  }
  const data = location.data;
  const unset = isUnset(data);
  const lines = formatAddressLines({ houseNo: data.addressLine, area: data.locality, city: data.city, district: data.district, state: data.state, pincode: data.pincode, landmark: data.landmark });

  return (
    <Panel
      title="Store location"
      action={
        !editing &&
        !readOnly && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {unset ? 'Add location' : 'Edit location'}
          </Button>
        )
      }
    >
      {editing ? (
        <LocationForm
          initial={data}
          source={source}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            queryClient.setQueryData(source.queryKey, saved);
            // The admin read adds who changed it last — read it again.
            void queryClient.invalidateQueries({ queryKey: source.queryKey });
            void queryClient.invalidateQueries({ queryKey: sellerKeys.onboarding });
            void queryClient.invalidateQueries({ queryKey: sellerKeys.lifecycle });
            setEditing(false);
            onSaved('Store location saved. Customers are now matched to your shop from this point.');
          }}
        />
      ) : unset ? (
        <p className="text-sm text-gray-500">
          Not added yet. Add your store address and set its location on the map — customers are matched to your shop from this point.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <address className="not-italic leading-relaxed text-gray-900">
            {lines.line1}
            {lines.line1 && <br />}
            {lines.line2}
            {lines.landmark && (
              <>
                <br />
                <span className="text-gray-600">{landmarkPhrase(lines.landmark)}</span>
              </>
            )}
          </address>
          {source.nameEditable && <p className="font-semibold text-gray-900">{data.name}</p>}
          {!data.district && <p className="text-xs text-warn-600">District not added yet — edit the location to add it.</p>}
          <p className="text-gray-600">
            Map point {data.latitude.toFixed(5)}, {data.longitude.toFixed(5)} ·{' '}
            <a href={mapLink(data.latitude, data.longitude)} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline">
              View on map
            </a>
          </p>
          <p className="text-xs text-gray-500">
            Whether you deliver to a customer, the delivery fee and the delivery time are all measured from this point (straight-line distance).
          </p>
          {data.lastChange && (
            <p className="text-xs text-gray-500">
              Last changed {new Date(data.lastChange.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              {data.lastChange.byName ? ` by ${data.lastChange.byName}` : ''}
              {data.lastChange.byRole ? ` (${data.lastChange.byRole.replace(/_/g, ' ').toLowerCase()})` : ''}.
            </p>
          )}
          {source.map && <LocationMap pin={{ latitude: data.latitude, longitude: data.longitude }} radiusKm={source.radiusKm ?? null} height={240} label="Store location on the map" />}
        </div>
      )}
    </Panel>
  );
}

function LocationForm({
  initial,
  source,
  onCancel,
  onSaved,
}: {
  initial: SellerLocation;
  source: StoreLocationSource;
  onCancel: () => void;
  onSaved: (saved: SellerLocation) => void;
}) {
  const blank = initial.latitude === 0 && initial.longitude === 0;
  const [name, setName] = useState(initial.name);
  const [lat, setLat] = useState(blank ? '' : String(initial.latitude));
  const [lng, setLng] = useState(blank ? '' : String(initial.longitude));
  const [addressLine, setAddressLine] = useState(initial.addressLine);
  const [locality, setLocality] = useState(initial.locality ?? '');
  const [city, setCity] = useState(initial.city);
  const [district, setDistrict] = useState(initial.district ?? '');
  // Rajasthan by default; an older store's own state is shown as saved (never
  // silently replaced) and must be changed to Rajasthan to save.
  const [state, setState] = useState(initial.state || SERVICE_STATE);
  const [pincode, setPincode] = useState(initial.pincode);
  const [landmark, setLandmark] = useState(initial.landmark ?? '');
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  /** A fresh browser fix waiting for the seller to confirm it. */
  const [detected, setDetected] = useState<Extract<DetectResult, { status: 'OK' }> | null>(null);
  /** An address suggested for the pin, waiting for the admin to apply or discard it. */
  const [suggestion, setSuggestion] = useState<SuggestedAddress | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => setError(null), [name, lat, lng, addressLine, locality, city, district, state, pincode, landmark]);

  const save = useMutation({
    mutationFn: source.save,
    onSuccess: onSaved,
    onError: (err) => setError(source.errorMessage(err)),
  });

  async function useCurrentPosition(): Promise<void> {
    setLocating(true);
    setDetected(null);
    setError(null);
    const result = await detectBrowserLocation();
    setLocating(false);
    if (result.status !== 'OK') return setError(DETECT_MESSAGE[result.status] + ' You can also enter the map point yourself.');
    setDetected(result);
  }

  async function suggestFromPoint(): Promise<void> {
    setSuggesting(true);
    setSuggestion(null);
    setError(null);
    try {
      setSuggestion(await suggestAddress(Number(lat), Number(lng)));
    } catch (err) {
      setError(`${err instanceof Error ? err.message : 'The address lookup failed.'} Enter the address yourself.`);
    } finally {
      setSuggesting(false);
    }
  }

  /** Fills only the fields the provider returned; the rest stay as typed. */
  function applySuggestion(s: SuggestedAddress): void {
    if (s.addressLine) setAddressLine(s.addressLine);
    if (s.locality) setLocality(s.locality);
    if (s.city) setCity(s.city);
    if (s.district) setDistrict(s.district);
    if (s.state) setState(s.state);
    if (s.pincode) setPincode(s.pincode);
    setSuggestion(null);
  }

  const latitude = Number(lat);
  const longitude = Number(lng);
  const pointProblem = lat.trim() && lng.trim() ? coordinateProblem(latitude, longitude, { requireIndia: true }) : 'MISSING';
  // Aadione operates only in Rajasthan — the one choice, plus a saved
  // out-of-state value so it is visible rather than overwritten.
  const states = state && state !== SERVICE_STATE ? [state, SERVICE_STATE] : [SERVICE_STATE];

  function submit(): void {
    if (source.nameEditable && name.trim().length < 2) return setError('Enter the store name (at least 2 characters).');
    if (addressLine.trim().length < 2) return setError('Enter the shop / building and street.');
    if (city.trim().length < 2) return setError('Enter the village, city or town.');
    if (district.trim().length < 2) return setError('Enter the district.');
    if (state !== SERVICE_STATE) return setError('Aadione currently operates only in Rajasthan — the store must be in Rajasthan.');
    if (!isValidPincode(pincode)) return setError('Enter a valid 6-digit PIN code.');
    if (pointProblem) {
      return setError(
        pointProblem === 'MISSING' ? 'Set the map point: use your current location in the shop, or enter its latitude and longitude.' : COORDINATE_PROBLEM_MESSAGE[pointProblem],
      );
    }
    save.mutate({
      ...(source.nameEditable ? { name: name.trim() } : {}),
      latitude,
      longitude,
      addressLine: addressLine.trim(),
      locality: locality.trim() || null,
      city: city.trim(),
      district: district.trim(),
      state: state.trim(),
      pincode: pincode.trim(),
      landmark: landmark.trim() || null,
    });
  }

  return (
    <div className="space-y-3">
      <ErrorBanner message={error} />
      {source.nameEditable && (
        <Field label="Store name" required hint="Shown to customers and on every order of this store, past ones included. The seller code never changes.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={inputClass} />
        </Field>
      )}
      <Field label="Shop / building and street" required>
        <input value={addressLine} onChange={(e) => setAddressLine(e.target.value)} maxLength={300} className={inputClass} placeholder="e.g. Shop 4, Station Road" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Locality / mohalla / colony">
          <input value={locality} onChange={(e) => setLocality(e.target.value)} maxLength={160} className={inputClass} />
        </Field>
        <Field label="Village / City / Town" required hint="Your village, or your city / town — one of them.">
          <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="District" required>
          <input value={district} onChange={(e) => setDistrict(e.target.value)} maxLength={80} className={inputClass} />
        </Field>
        <Field label="State" required>
          <select value={state} onChange={(e) => setState(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {states.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PIN code" required>
          <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className={inputClass} />
        </Field>
      </div>
      <Field label="Landmark" hint="Optional — e.g. near the bus stand">
        <input value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={160} className={inputClass} />
      </Field>

      <div className="space-y-2 rounded-xl border border-gray-200 p-3">
        <p className="text-sm font-semibold text-gray-900">Map point</p>
        <p className="text-xs text-gray-500">
          The exact point of your shop. The address above does not set it — a PIN code or village covers a large area.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Latitude" required>
            <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className={inputClass} placeholder="e.g. 25.12345" />
          </Field>
          <Field label="Longitude" required>
            <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className={inputClass} placeholder="e.g. 74.12345" />
          </Field>
        </div>
        {lat.trim() && lng.trim() && pointProblem && pointProblem !== 'MISSING' && <p className="text-xs text-danger-600">{COORDINATE_PROBLEM_MESSAGE[pointProblem]}</p>}
        {source.map && (
          <div className="space-y-1">
            <LocationMap
              pin={pointProblem ? null : { latitude, longitude }}
              onPinChange={(point) => {
                setLat(String(point.latitude));
                setLng(String(point.longitude));
              }}
              radiusKm={source.radiusKm ?? null}
              label="Store location — click or drag the pin to the storefront"
            />
            <p className="text-xs text-gray-500">
              Click the map or drag the pin onto the shop's entrance; zoom in to place it exactly. The latitude and longitude above follow the pin.
            </p>
          </div>
        )}
        {!pointProblem && (
          <a href={mapLink(latitude, longitude)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-brand-600 hover:underline">
            Check this point on Google Maps
          </a>
        )}
        {source.deviceLocation && (
          <div>
            <button type="button" onClick={() => void useCurrentPosition()} disabled={locating} className="text-left text-sm font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-60">
              {locating ? 'Reading your location…' : (source.deviceLocationLabel ?? 'Use my current location (stand in the shop)')}
            </button>
          </div>
        )}
        {source.map &&
          (REVERSE_GEOCODE_URL ? (
            <div>
              <button
                type="button"
                onClick={() => void suggestFromPoint()}
                disabled={suggesting || pointProblem !== null}
                className="text-sm font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-60"
              >
                {suggesting ? 'Looking up the address…' : 'Suggest the address for this point'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400">Address suggestions are off — no reverse-geocoding provider is configured (VITE_REVERSE_GEOCODE_URL).</p>
          ))}
        {suggestion && (
          <div role="status" className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
            <p className="font-semibold">Suggested address — check it before applying:</p>
            <p className="mt-0.5">{suggestion.displayName ?? 'No description returned.'}</p>
            <p className="mt-1 text-xs">
              {[suggestion.addressLine, suggestion.locality, suggestion.city, suggestion.district, suggestion.state, suggestion.pincode].filter(Boolean).join(' · ') ||
                'No usable address fields.'}
            </p>
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" className="font-semibold underline" onClick={() => applySuggestion(suggestion)}>
                Fill these fields
              </button>
              <button type="button" className="underline" onClick={() => setSuggestion(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
        {detected && (
          <div role="status" className={`rounded-lg px-3 py-2 text-sm ${detected.quality === 'POOR' ? 'bg-warn-50 text-warn-600' : 'bg-brand-50 text-brand-700'}`}>
            <p>
              Found {detected.latitude.toFixed(6)}, {detected.longitude.toFixed(6)} — {describeAccuracy(detected.accuracyM)}.
              {detected.quality === 'POOR' && ' That is not precise enough to be sure it is your shop: check it on the map, or enter the point yourself.'}
            </p>
            <div className="mt-1 flex flex-wrap gap-3">
              <a href={mapLink(detected.latitude, detected.longitude)} target="_blank" rel="noreferrer" className="font-semibold underline">
                Check on map
              </a>
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => {
                  setLat(detected.latitude.toFixed(6));
                  setLng(detected.longitude.toFixed(6));
                  setDetected(null);
                }}
              >
                Use this point
              </button>
              <button type="button" className="underline" onClick={() => setDetected(null)}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save location'}
        </Button>
      </div>
    </div>
  );
}

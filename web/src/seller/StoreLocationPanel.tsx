/**
 * Store location — the seller's own address and map point
 * (GET/PATCH /seller/location).
 *
 * The point is where every distance to a customer is measured from: whether
 * this seller delivers to an address, the delivery fee and the ETA. Every
 * seller — Aadione included — sets its own here; there is no central store
 * location. Changes are audited on the server.
 *
 * The browser can read the operator's real position, which is almost always
 * the shop itself, so the fastest correct fix is one button.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorBanner, Field, Panel, inputClass } from '@/components/ui';
import { sellerApi, sellerErrorMessage } from './sellerApi';
import { sellerKeys } from './sellerQueries';

interface SellerLocation {
  id: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  phone: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
}

const LOCATION_KEY = [...sellerKeys.all, 'location'] as const;

/** A seller that has only applied has no map point yet (0, 0 = not set). */
const isUnset = (location: SellerLocation): boolean =>
  location.latitude === 0 && location.longitude === 0 && !location.addressLine.trim();

export default function StoreLocationPanel({
  onSaved,
  readOnly = false,
}: {
  onSaved: (message: string) => void;
  /** Onboarding under review: show the location, no Edit. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const location = useQuery({
    queryKey: LOCATION_KEY,
    queryFn: () => sellerApi.get<SellerLocation>('/seller/location'),
  });
  const [editing, setEditing] = useState(false);

  if (location.isPending) return <Panel title="Store location">Loading…</Panel>;
  if (location.isError) {
    return (
      <Panel title="Store location">
        <ErrorBanner message={sellerErrorMessage(location.error)} />
      </Panel>
    );
  }
  const data = location.data;
  const unset = isUnset(data);
  const mapUrl = `https://www.google.com/maps?q=${data.latitude},${data.longitude}`;

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
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            queryClient.setQueryData(LOCATION_KEY, saved);
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
            {data.addressLine}
            <br />
            {data.city}, {data.state} – {data.pincode}
          </address>
          <p className="text-gray-600">
            Map point {data.latitude.toFixed(5)}, {data.longitude.toFixed(5)} ·{' '}
            <a href={mapUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline">
              View on map
            </a>
          </p>
          <p className="text-xs text-gray-500">
            Whether you deliver to a customer, the delivery fee and the delivery time are all measured from this point.
          </p>
        </div>
      )}
    </Panel>
  );
}

function LocationForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: SellerLocation;
  onCancel: () => void;
  onSaved: (saved: SellerLocation) => void;
}) {
  const blank = initial.latitude === 0 && initial.longitude === 0;
  const [lat, setLat] = useState(blank ? '' : String(initial.latitude));
  const [lng, setLng] = useState(blank ? '' : String(initial.longitude));
  const [addressLine, setAddressLine] = useState(initial.addressLine);
  const [city, setCity] = useState(initial.city);
  const [state, setState] = useState(initial.state);
  const [pincode, setPincode] = useState(initial.pincode);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => setError(null), [lat, lng, addressLine, city, state, pincode]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => sellerApi.patch<SellerLocation>('/seller/location', body),
    onSuccess: onSaved,
    onError: (err) => setError(sellerErrorMessage(err)),
  });

  function useCurrentPosition(): void {
    if (!('geolocation' in navigator)) return setError('This browser cannot read your location. Enter the map point instead.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(6));
        setLng(position.coords.longitude.toFixed(6));
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError('Could not read your location. Allow location access, or enter the map point.');
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  function submit(): void {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!lat.trim() || !lng.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return setError('Enter the map point as two numbers (latitude and longitude).');
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return setError('That map point is not valid.');
    if (latitude === 0 && longitude === 0) return setError('That map point looks wrong (0, 0). Please set it again.');
    if (addressLine.trim().length < 2 || city.trim().length < 2 || state.trim().length < 2) return setError('Fill in the address, city and state.');
    if (!/^\d{6}$/.test(pincode.trim())) return setError('Pincode must be 6 digits.');
    save.mutate({
      latitude,
      longitude,
      addressLine: addressLine.trim(),
      city: city.trim(),
      state: state.trim(),
      pincode: pincode.trim(),
    });
  }

  return (
    <div className="space-y-3">
      <ErrorBanner message={error} />
      <Field label="Address" required>
        <input value={addressLine} onChange={(e) => setAddressLine(e.target.value)} maxLength={300} className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="City" required>
          <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} className={inputClass} />
        </Field>
        <Field label="State" required>
          <input value={state} onChange={(e) => setState(e.target.value)} maxLength={80} className={inputClass} />
        </Field>
        <Field label="Pincode" required>
          <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Latitude" required>
          <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className={inputClass} />
        </Field>
        <Field label="Longitude" required>
          <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className={inputClass} />
        </Field>
      </div>
      <button type="button" onClick={useCurrentPosition} disabled={locating} className="text-sm font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-60">
        {locating ? 'Reading your location…' : 'Use my current location (stand in the shop)'}
      </button>
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

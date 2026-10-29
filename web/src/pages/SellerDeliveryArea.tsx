/**
 * Seller detail — Delivery area (SELLER_MANAGE).
 *
 *   radius   GET / PATCH /admin/sellers/:id/delivery-area — this store's own
 *            radius, or the app-wide MAX_SERVICE_RADIUS_KM (Configuration →
 *            Delivery) when it has none. One value; checkout uses the same.
 *   check    GET /admin/sellers/:id/delivery-check?lat=&lng= — would an order
 *            from this store be delivered to that point? Answered by the
 *            server with checkout's own rule, never computed here.
 *
 * Distances are STRAIGHT-LINE from the store's map point: a 12 km radius is a
 * circle, and the road trip to a point inside it can be longer.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatPaise } from '@shared';
import LocationMap, { type MapPoint } from '@/components/LocationMap';
import { Button, ErrorBanner, Field, Panel, inputClass } from '@/components/ui';
import { adminSellerKeys, sellerErrorMessage, sellersApi, useAdminSellerDeliveryArea, useSellerPermissions, type AdminDeliveryPointCheck } from '@/lib/sellers';

/** "25.0745, 74.1010" (or space-separated) → a point; null when it is not two numbers. */
export function parsePoint(text: string): MapPoint | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [latitude, longitude] = parts.map(Number) as [number, number];
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

export default function SellerDeliveryArea({ sellerId }: { sellerId: string }) {
  const { canManage } = useSellerPermissions();
  const area = useAdminSellerDeliveryArea(sellerId, canManage);
  if (!canManage) return null;
  if (area.isPending) return <Panel title="Delivery area">Loading…</Panel>;
  if (area.isError) {
    return (
      <Panel title="Delivery area">
        <ErrorBanner message={sellerErrorMessage(area.error, 'Could not load the delivery area.')} />
      </Panel>
    );
  }
  return <DeliveryAreaBody sellerId={sellerId} data={area.data} />;
}

function DeliveryAreaBody({ sellerId, data }: { sellerId: string; data: NonNullable<ReturnType<typeof useAdminSellerDeliveryArea>['data']> }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'default' | 'custom'>(data.maxServiceRadiusKm === null ? 'default' : 'custom');
  const [km, setKm] = useState(data.maxServiceRadiusKm === null ? '' : String(data.maxServiceRadiusKm));
  const [saved, setSaved] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pointText, setPointText] = useState('');
  const [pointError, setPointError] = useState<string | null>(null);
  const [probe, setProbe] = useState<MapPoint | null>(null);
  const [result, setResult] = useState<AdminDeliveryPointCheck | null>(null);

  const save = useMutation({
    mutationFn: (value: number | null) => sellersApi.setDeliveryRadius(sellerId, value),
    onSuccess: (next) => {
      queryClient.setQueryData(adminSellerKeys.deliveryArea(sellerId), next);
      setResult(null);
      setSaved(
        next.maxServiceRadiusKm === null
          ? `This store now uses the app-wide radius (${next.defaultRadiusKm} km).`
          : `This store now delivers within ${next.maxServiceRadiusKm} km (straight line).`,
      );
    },
  });

  const check = useMutation({
    mutationFn: (point: MapPoint) => sellersApi.deliveryCheck(sellerId, point.latitude, point.longitude),
    onSuccess: setResult,
  });

  function submitRadius(): void {
    setSaved(null);
    setFormError(null);
    if (mode === 'default') return save.mutate(null);
    const value = Number(km);
    if (!km.trim() || !Number.isFinite(value) || value <= 0 || value > data.radiusLimitKm) {
      return setFormError(`Enter a radius above 0 and at most ${data.radiusLimitKm} km.`);
    }
    save.mutate(value);
  }

  function runCheck(point: MapPoint): void {
    setPointError(null);
    setProbe(point);
    setPointText(`${point.latitude}, ${point.longitude}`);
    setResult(null);
    check.mutate(point);
  }

  const unchanged = mode === 'default' ? data.maxServiceRadiusKm === null : Number(km) === data.maxServiceRadiusKm;
  const store = data.storeLocationSet ? { latitude: data.latitude, longitude: data.longitude } : null;

  return (
    <Panel title="Delivery area">
      <div className="space-y-4 text-sm">
        {!data.storeLocationSet && (
          <p role="alert" className="rounded-lg bg-warn-50 px-3 py-2 text-gray-800">
            This store has no map point yet, so it delivers to nobody. Set its location above first.
          </p>
        )}

        <div className="space-y-2">
          <p className="text-gray-700">
            Customers can order from this store when their delivery point is within{' '}
            <span className="font-semibold text-gray-900">{data.effectiveRadiusKm} km</span> of the store's map point
            {data.maxServiceRadiusKm === null ? ' (the app-wide radius)' : ' (this store’s own radius)'}.
          </p>
          <fieldset className="space-y-2">
            <legend className="sr-only">Delivery radius</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name={`radius-${sellerId}`} checked={mode === 'default'} onChange={() => setMode('default')} />
              <span>
                Use the app-wide radius — {data.defaultRadiusKm} km (
                <Link to="/config" className="font-semibold text-brand-600 hover:underline">
                  Configuration → Delivery
                </Link>
                )
              </span>
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="radio" name={`radius-${sellerId}`} checked={mode === 'custom'} onChange={() => setMode('custom')} />
              <span>This store only:</span>
              <input
                type="number"
                min={0.1}
                max={data.radiusLimitKm}
                step={0.1}
                value={km}
                onFocus={() => setMode('custom')}
                onChange={(event) => setKm(event.target.value)}
                className={`${inputClass} w-28`}
                aria-label="Store delivery radius in kilometres"
                placeholder="e.g. 10"
              />
              <span>km</span>
            </label>
          </fieldset>
          <ErrorBanner message={formError ?? (save.isError ? sellerErrorMessage(save.error, 'Could not save the radius.') : null)} />
          {saved && <p className="text-brand-700">{saved}</p>}
          <Button onClick={submitRadius} disabled={save.isPending || unchanged}>
            {save.isPending ? 'Saving…' : 'Save radius'}
          </Button>
          <p className="text-xs text-gray-500">
            Straight-line distance (as the crow flies), measured from the store's map point — not the road route. A point inside a{' '}
            {data.effectiveRadiusKm} km radius can be further by road; the delivery fee and time estimate the road trip as the straight line ×{' '}
            {data.roadDistanceFactor}.
          </p>
        </div>

        <div className="space-y-2 border-t border-gray-100 pt-4">
          <p className="font-semibold text-gray-900">Check a delivery point</p>
          <p className="text-xs text-gray-500">
            Paste a customer's latitude, longitude (e.g. from their order or address) or click the map. The server answers with the same rule checkout
            uses.
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const point = parsePoint(pointText);
              if (!point) {
                check.reset();
                setResult(null);
                setPointError('Enter the point as "latitude, longitude", e.g. 25.0745, 74.1010.');
                return;
              }
              runCheck(point);
            }}
          >
            <Field label="Latitude, longitude">
              <input value={pointText} onChange={(event) => setPointText(event.target.value)} className={`${inputClass} w-64`} placeholder="25.0745, 74.1010" />
            </Field>
            <Button type="submit" variant="secondary" disabled={check.isPending || !data.storeLocationSet}>
              {check.isPending ? 'Checking…' : 'Check'}
            </Button>
          </form>
          <ErrorBanner message={pointError ?? (check.isError ? sellerErrorMessage(check.error, 'Could not check that point.') : null)} />
          {result && <CheckResult result={result} />}
          {store && (
            <LocationMap
              pin={store}
              radiusKm={data.effectiveRadiusKm}
              probe={probe}
              onProbeChange={runCheck}
              height={300}
              label="Store, delivery radius and the checked point — click to check a point"
            />
          )}
          {store && (
            <p className="text-xs text-gray-500">
              Store {store.latitude.toFixed(6)}, {store.longitude.toFixed(6)} (green pin) · the circle is the {data.effectiveRadiusKm} km radius · the
              blue dot is the checked point.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function CheckResult({ result }: { result: AdminDeliveryPointCheck }) {
  return (
    <div role="status" className={`rounded-lg px-3 py-2 ${result.deliverable ? 'bg-brand-50 text-brand-700' : 'bg-danger-50 text-danger-600'}`}>
      <p className="font-semibold">{result.deliverable ? 'Delivered — inside the delivery area.' : 'Not delivered.'}</p>
      {result.reason && <p>{result.reason}</p>}
      <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-gray-700 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Straight-line distance: </dt>
          <dd className="inline">{result.distanceKm} km (radius {result.effectiveRadiusKm} km)</dd>
        </div>
        <div>
          <dt className="inline font-medium">Estimated road distance: </dt>
          <dd className="inline">≈ {result.estimatedRoadDistanceKm} km</dd>
        </div>
        <div>
          <dt className="inline font-medium">Store: </dt>
          <dd className="inline">
            {result.store.latitude.toFixed(6)}, {result.store.longitude.toFixed(6)}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Delivery point: </dt>
          <dd className="inline">
            {result.destination.latitude.toFixed(6)}, {result.destination.longitude.toFixed(6)}
          </dd>
        </div>
        {result.deliverable && (
          <div>
            <dt className="inline font-medium">Delivery fee: </dt>
            <dd className="inline">{formatPaise(result.deliveryFeePaise)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

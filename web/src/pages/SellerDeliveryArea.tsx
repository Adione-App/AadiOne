/**
 * Seller detail — Delivery area (SELLER_MANAGE).
 *
 * There is ONE delivery area, the admin's, the same for every store: the
 * service location (App Settings → Global Availability, PLATFORM_LOCATION)
 * and the delivery radius (MAX_SERVICE_RADIUS_KM). A store's own map point
 * and its old own radius do not decide delivery, so nothing here edits them.
 *
 *   area     GET /admin/sellers/:id/delivery-area — the admin area as it is now
 *   check    GET /admin/sellers/:id/delivery-check?lat=&lng= — would an order
 *            be delivered to that point? Answered by the server with
 *            checkout's own rule, never computed here.
 *
 * Distances are STRAIGHT-LINE from the service location: a 12 km radius is a
 * circle, and the road trip to a point inside it can be longer.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { formatPaise } from '@shared';
import LocationMap, { type MapPoint } from '@/components/LocationMap';
import { Button, ErrorBanner, Field, Panel, inputClass } from '@/components/ui';
import { sellerErrorMessage, sellersApi, useAdminSellerDeliveryArea, useSellerPermissions, type AdminDeliveryPointCheck } from '@/lib/sellers';

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
  const [pointText, setPointText] = useState('');
  const [pointError, setPointError] = useState<string | null>(null);
  const [probe, setProbe] = useState<MapPoint | null>(null);
  const [result, setResult] = useState<AdminDeliveryPointCheck | null>(null);

  const check = useMutation({
    mutationFn: (point: MapPoint) => sellersApi.deliveryCheck(sellerId, point.latitude, point.longitude),
    onSuccess: setResult,
  });

  function runCheck(point: MapPoint): void {
    setPointError(null);
    setProbe(point);
    setPointText(`${point.latitude}, ${point.longitude}`);
    setResult(null);
    check.mutate(point);
  }

  // Older servers do not send `areaConfigured`; their `storeLocationSet` meant the store's pin.
  const configured = data.areaConfigured ?? data.storeLocationSet;
  const origin = configured ? { latitude: data.latitude, longitude: data.longitude } : null;

  return (
    <Panel title="Delivery area">
      <div className="space-y-4 text-sm">
        {!configured && (
          <p role="alert" className="rounded-lg bg-warn-50 px-3 py-2 text-gray-800">
            No service location is set, so nobody can order. Set it in{' '}
            <Link to="/settings" className="font-semibold text-brand-600 hover:underline">
              App Settings → Global Availability
            </Link>
            .
          </p>
        )}

        <div className="space-y-2">
          <p className="text-gray-700">
            Whether a customer can order is decided by the Approved Delivery Villages list (Configuration) — the same for every store. Distances
            for the delivery fee and time are measured from Aadione’s service location{data.originName ? ` (${data.originName})` : ''}; the nearby
            radius is <span className="font-semibold text-gray-900">{data.effectiveRadiusKm} km</span>. This store’s own map point is not used.
          </p>
          <p className="text-xs text-gray-500">
            Change the service location or the radius in{' '}
            <Link to="/settings" className="font-semibold text-brand-600 hover:underline">
              App Settings → Global Availability
            </Link>
            . A point inside the radius can be further by road; the delivery fee and time estimate the road trip as the straight line ×{' '}
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
            <Button type="submit" variant="secondary" disabled={check.isPending || !configured}>
              {check.isPending ? 'Checking…' : 'Check'}
            </Button>
          </form>
          <ErrorBanner message={pointError ?? (check.isError ? sellerErrorMessage(check.error, 'Could not check that point.') : null)} />
          {result && <CheckResult result={result} />}
          {origin && (
            <LocationMap
              pin={origin}
              radiusKm={data.effectiveRadiusKm}
              fitRadius
              probe={probe}
              onProbeChange={runCheck}
              height={300}
              label="Service location, delivery radius and the checked point — click to check a point"
            />
          )}
          {origin && (
            <p className="text-xs text-gray-500">
              Service location {origin.latitude.toFixed(6)}, {origin.longitude.toFixed(6)} (green pin) · the circle is the {data.effectiveRadiusKm} km
              radius · the blue dot is the checked point.
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
      <p className="font-semibold">{result.deliverable ? 'Inside the nearby radius.' : 'Outside the nearby radius.'}</p>
      <p className="text-xs">Orders are decided by the address&apos;s village and PIN code (Approved Delivery Villages), not by this distance.</p>
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
          <dt className="inline font-medium">Service location: </dt>
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

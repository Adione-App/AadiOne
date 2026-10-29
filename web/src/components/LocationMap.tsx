/**
 * A small Leaflet map for the admin location tools.
 *
 *   pin         the store's point. With `onPinChange` it can be dragged, and a
 *               click on the map moves it there — always an explicit action.
 *   radiusKm    a circle of that radius around the pin (straight-line delivery
 *               area).
 *   probe       a second point (e.g. a customer address being checked); with
 *               `onProbeChange` a click on the map sets it instead of the pin.
 *   fitRadius   zoom out to show the whole radius circle (and the probe),
 *               instead of the street-level view around the pin.
 *
 * Coordinates handed back are rounded to 6 decimals (~0.1 m). Without a tile
 * provider (VITE_MAP_TILE_URL=off) nothing is rendered, and the latitude /
 * longitude fields around it remain the way to set a point.
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MAP_TILES } from '@/lib/mapConfig';

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/** Rajasthan, for a store with no point yet. */
const DEFAULT_VIEW: { center: L.LatLngTuple; zoom: number } = { center: [26.9, 74.6], zoom: 7 };

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

// Div icons: no marker image files to bundle.
const pinIcon = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#16a34a;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);transform:rotate(-45deg)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});
const probeIcon = L.divIcon({
  className: '',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export default function LocationMap({
  pin,
  onPinChange,
  radiusKm = null,
  fitRadius = false,
  probe = null,
  onProbeChange,
  height = 320,
  label = 'Map',
}: {
  pin: MapPoint | null;
  onPinChange?: (point: MapPoint) => void;
  radiusKm?: number | null;
  fitRadius?: boolean;
  probe?: MapPoint | null;
  onProbeChange?: (point: MapPoint) => void;
  height?: number;
  label?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const pinMarker = useRef<L.Marker | null>(null);
  const probeMarker = useRef<L.Marker | null>(null);
  const circle = useRef<L.Circle | null>(null);
  // Latest callbacks, so the map's own listeners never go stale.
  const handlers = useRef({ onPinChange, onProbeChange });
  handlers.current = { onPinChange, onProbeChange };
  // Effects follow the numbers, not the objects (new on every render).
  const pinLat = pin?.latitude ?? null;
  const pinLng = pin?.longitude ?? null;
  const probeLat = probe?.latitude ?? null;
  const probeLng = probe?.longitude ?? null;
  const draggable = Boolean(onPinChange);

  // Create the map once.
  useEffect(() => {
    if (!MAP_TILES || !container.current) return undefined;
    const instance = L.map(container.current, { scrollWheelZoom: false });
    L.tileLayer(MAP_TILES.url, { attribution: MAP_TILES.attribution, maxZoom: 19 }).addTo(instance);
    if (pinLat !== null && pinLng !== null) instance.setView([pinLat, pinLng], 16);
    else instance.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const point = { latitude: round6(event.latlng.lat), longitude: round6(event.latlng.lng) };
      if (handlers.current.onProbeChange) handlers.current.onProbeChange(point);
      else handlers.current.onPinChange?.(point);
    });
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      pinMarker.current = null;
      probeMarker.current = null;
      circle.current = null;
    };
    // Created once; the effects below follow the props.
  }, []);

  // The pin (and the view, the first time there is one).
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (pinLat === null || pinLng === null) {
      pinMarker.current?.remove();
      pinMarker.current = null;
      return;
    }
    const at: L.LatLngTuple = [pinLat, pinLng];
    if (!pinMarker.current) {
      const marker = L.marker(at, { icon: pinIcon, draggable, keyboard: true, title: 'Store location' }).addTo(instance);
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        handlers.current.onPinChange?.({ latitude: round6(lat), longitude: round6(lng) });
      });
      pinMarker.current = marker;
      instance.setView(at, Math.max(instance.getZoom(), 15));
    } else {
      pinMarker.current.setLatLng(at);
      if (!instance.getBounds().contains(at)) instance.panTo(at);
    }
  }, [pinLat, pinLng, draggable]);

  // The delivery-radius circle.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    circle.current?.remove();
    circle.current = null;
    if (pinLat !== null && pinLng !== null && radiusKm && radiusKm > 0) {
      circle.current = L.circle([pinLat, pinLng], {
        radius: radiusKm * 1000,
        color: '#16a34a',
        weight: 2,
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(instance);
      if (fitRadius) {
        const bounds = circle.current.getBounds();
        if (probeLat !== null && probeLng !== null) bounds.extend([probeLat, probeLng]);
        instance.fitBounds(bounds, { padding: [12, 12] });
      }
    }
  }, [pinLat, pinLng, radiusKm, fitRadius]);

  // The probe point, kept in view together with the pin.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (probeLat === null || probeLng === null) {
      probeMarker.current?.remove();
      probeMarker.current = null;
      return;
    }
    const at: L.LatLngTuple = [probeLat, probeLng];
    if (!probeMarker.current) probeMarker.current = L.marker(at, { icon: probeIcon, title: 'Delivery point', keyboard: false }).addTo(instance);
    else probeMarker.current.setLatLng(at);
    if (fitRadius && circle.current) instance.fitBounds(circle.current.getBounds().extend(at), { padding: [12, 12] });
    else if (pinLat !== null && pinLng !== null) instance.fitBounds(L.latLngBounds([at, [pinLat, pinLng]]).pad(0.25), { maxZoom: 16 });
  }, [probeLat, probeLng, pinLat, pinLng, fitRadius]);

  if (!MAP_TILES) {
    return (
      <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
        The map is turned off (VITE_MAP_TILE_URL=off). Enter the latitude and longitude instead.
      </p>
    );
  }
  return <div ref={container} role="application" aria-label={label} className="relative z-0 w-full overflow-hidden rounded-xl border border-gray-200" style={{ height }} />;
}

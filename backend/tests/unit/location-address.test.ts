/**
 * The shared location system: Haversine distance, units, the radius
 * boundary, coordinate validation, device-fix handling (permission, services,
 * timeout, accuracy), reverse-geocode → address fields, and Indian address
 * structure / display.
 */

import { describe, expect, it } from 'vitest';
import {
  checkServiceability,
  coordinateProblem,
  distanceKmExact,
  formatDistance,
  formatStraightLineDistance,
  kmToMetres,
  metresToKm,
  roundUpKm,
} from '../../src/shared/distance';
import {
  LocationError,
  assessFix,
  describeAccuracy,
  detectLocation,
  suggestionFromPlace,
  suggestionLabel,
  type DeviceFix,
  type LocationDeps,
} from '../../src/shared/location';
import { formatAddressLines, formatAddressOneLine, isValidPincode, landmarkPhrase, missingAddressFields } from '../../src/shared/address';

const SIKAR = { lat: 27.6094, lng: 75.1399 };

describe('Haversine distance', () => {
  it('matches known coordinate pairs', () => {
    // One degree of latitude on the IUGG mean sphere.
    expect(distanceKmExact(0, 0, 1, 0)).toBeCloseTo(111.195, 3);
    // Delhi -> Mumbai city centres: the commonly cited ~1,148 km great-circle distance.
    const delhiMumbai = distanceKmExact(28.6139, 77.209, 19.076, 72.8777);
    expect(delhiMumbai).toBeGreaterThan(1143);
    expect(delhiMumbai).toBeLessThan(1153);
    // Symmetric, zero for one point.
    expect(distanceKmExact(SIKAR.lat, SIKAR.lng, 26.9124, 75.7873)).toBeCloseTo(distanceKmExact(26.9124, 75.7873, SIKAR.lat, SIKAR.lng), 9);
    expect(distanceKmExact(SIKAR.lat, SIKAR.lng, SIKAR.lat, SIKAR.lng)).toBe(0);
  });

  it('converts metres and kilometres consistently', () => {
    expect(metresToKm(1250)).toBe(1.25);
    expect(kmToMetres(1.25)).toBe(1250);
    expect(metresToKm(kmToMetres(9.999))).toBeCloseTo(9.999, 12);
  });

  it('rounds reported distances UP to 10 m, and a zero stays zero', () => {
    expect(roundUpKm(10.0001)).toBe(10.01);
    expect(roundUpKm(9.9999)).toBe(10);
    expect(roundUpKm(2.0000000001)).toBe(2);
    expect(Object.is(roundUpKm(0), 0)).toBe(true);
  });
});

describe('delivery radius boundary', () => {
  const north = (km: number) => SIKAR.lat + km / 111.19508;

  it('decides on the exact distance: 10.004 km is outside a 10 km radius (rounding used to let it in)', () => {
    const outside = checkServiceability(north(10.004), SIKAR.lng, SIKAR.lat, SIKAR.lng, 10);
    expect(outside.serviceable).toBe(false);
    expect(outside.distanceKm).toBeGreaterThan(10);
    const inside = checkServiceability(north(9.996), SIKAR.lng, SIKAR.lat, SIKAR.lng, 10);
    expect(inside.serviceable).toBe(true);
    expect(inside.distanceKm).toBeLessThanOrEqual(10);
  });

  it('the shown distance never contradicts the decision, all around the boundary', () => {
    for (let metres = -20; metres <= 20; metres += 1) {
      const result = checkServiceability(north(10 + metres / 1000), SIKAR.lng, SIKAR.lat, SIKAR.lng, 10);
      if (result.serviceable) expect(result.distanceKm, `${metres} m`).toBeLessThanOrEqual(10);
      else expect(result.distanceKm, `${metres} m`).toBeGreaterThan(10);
    }
  });
});

describe('coordinate validation', () => {
  it('accepts a real Indian point and reports what is wrong with others', () => {
    expect(coordinateProblem(SIKAR.lat, SIKAR.lng)).toBeNull();
    expect(coordinateProblem(SIKAR.lat, SIKAR.lng, { requireIndia: true })).toBeNull();
    expect(coordinateProblem(null, SIKAR.lng)).toBe('MISSING');
    expect(coordinateProblem(Number.NaN, SIKAR.lng)).toBe('MISSING');
    expect(coordinateProblem('27.6', '75.1')).toBe('MISSING');
    expect(coordinateProblem(Infinity, 0)).toBe('MISSING');
    // Latitude and longitude the wrong way round.
    expect(coordinateProblem(SIKAR.lng, SIKAR.lat)).toBe('SWAPPED');
    expect(coordinateProblem(0, 0)).toBe('NULL_ISLAND');
    expect(coordinateProblem(95, 200)).toBe('OUT_OF_RANGE');
    expect(coordinateProblem(-91, 10)).toBe('OUT_OF_RANGE');
    // Abroad: fine for a query, refused for a saved Indian address.
    expect(coordinateProblem(51.5072, -0.1276)).toBeNull();
    expect(coordinateProblem(51.5072, -0.1276, { requireIndia: true })).toBe('OUTSIDE_INDIA');
  });
});

describe('device fixes', () => {
  it('grades accuracy and refuses unusable fixes', () => {
    expect(assessFix({ latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 12 })).toMatchObject({ ok: true, quality: 'GOOD' });
    expect(assessFix({ latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 120 })).toMatchObject({ ok: true, quality: 'FAIR' });
    expect(assessFix({ latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 650 })).toMatchObject({ ok: true, quality: 'POOR' });
    // No reported accuracy: usable but never presented as precise.
    expect(assessFix({ latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: null })).toMatchObject({ ok: true, quality: 'POOR' });
    expect(assessFix({ latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 4500 })).toMatchObject({ ok: false, reason: 'TOO_INACCURATE' });
    expect(assessFix({ latitude: 0, longitude: 0, accuracyM: 10 })).toMatchObject({ ok: false, reason: 'INVALID_COORDINATES' });
    expect(describeAccuracy(18)).toBe('Accurate to about 20 m');
    expect(describeAccuracy(null)).toMatch(/unknown/);
  });

  const deps = (over: Partial<LocationDeps> & { fix?: DeviceFix } = {}) => {
    let positionCalls = 0;
    const d: LocationDeps = {
      requestPermission: async () => true,
      servicesEnabled: async () => true,
      getPosition: async () => {
        positionCalls += 1;
        return over.fix ?? { latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 15 };
      },
      ...over,
    };
    return { d, calls: () => positionCalls };
  };

  it('success: one fresh fix, assessed', async () => {
    const { d, calls } = deps();
    expect(await detectLocation(d)).toEqual({ status: 'OK', latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 15, quality: 'GOOD' });
    expect(calls()).toBe(1);
  });

  it('permission denied (refused or failing) never asks for a position', async () => {
    const refused = deps({ requestPermission: async () => false });
    expect(await detectLocation(refused.d)).toEqual({ status: 'PERMISSION_DENIED' });
    expect(refused.calls()).toBe(0);
    const failing = deps({ requestPermission: async () => Promise.reject(new Error('no')) });
    expect((await detectLocation(failing.d)).status).toBe('PERMISSION_DENIED');
  });

  it('location services off', async () => {
    const { d, calls } = deps({ servicesEnabled: async () => false });
    expect(await detectLocation(d)).toEqual({ status: 'SERVICES_DISABLED' });
    expect(calls()).toBe(0);
  });

  it('times out instead of waiting forever — and never substitutes a position', async () => {
    const { d } = deps({ getPosition: () => new Promise<DeviceFix>(() => undefined) });
    expect(await detectLocation(d, { timeoutMs: 30 })).toEqual({ status: 'TIMEOUT' });
  });

  it('passes on the platform’s own reason, and maps anything else to unavailable', async () => {
    expect((await detectLocation(deps({ getPosition: () => Promise.reject(new LocationError('TIMEOUT')) }).d)).status).toBe('TIMEOUT');
    expect((await detectLocation(deps({ getPosition: () => Promise.reject(new LocationError('PERMISSION_DENIED')) }).d)).status).toBe('PERMISSION_DENIED');
    expect((await detectLocation(deps({ getPosition: () => Promise.reject(new Error('boom')) }).d)).status).toBe('UNAVAILABLE');
  });

  it('missing or inaccurate GPS coordinates are refused, not used', async () => {
    expect((await detectLocation(deps({ fix: { latitude: 0, longitude: 0, accuracyM: 5 } }).d)).status).toBe('INVALID');
    expect((await detectLocation(deps({ fix: { latitude: Number.NaN, longitude: 75, accuracyM: 5 } }).d)).status).toBe('INVALID');
    expect(await detectLocation(deps({ fix: { latitude: SIKAR.lat, longitude: SIKAR.lng, accuracyM: 3000 } }).d)).toEqual({ status: 'TOO_INACCURATE', accuracyM: 3000 });
  });
});

describe('reverse geocoding → address fields', () => {
  it('urban: the sub-locality is the locality and the subregion the district (not the other way round)', () => {
    const s = suggestionFromPlace({
      streetNumber: '12',
      street: 'JLN Marg',
      district: 'Malviya Nagar', // OS "district" = sub-locality
      subregion: 'Jaipur', // OS "subregion" = the Indian district
      city: 'Jaipur',
      region: 'Rajasthan',
      postalCode: '302017',
    });
    expect(s).toEqual({ houseNo: '12', street: 'JLN Marg', area: 'Malviya Nagar', city: 'Jaipur', district: 'Jaipur', state: 'Rajasthan', pincode: '302017' });
    expect(suggestionLabel(s)).toBe('Malviya Nagar, Jaipur, 302017');
  });

  it('rural: a village with its district; an invalid PIN is not suggested', () => {
    const s = suggestionFromPlace({ city: 'Palsana', subregion: 'Sikar', region: 'Rajasthan', postalCode: '33240', district: 'Palsana' });
    expect(s).toEqual({ houseNo: null, street: null, area: null, city: 'Palsana', district: 'Sikar', state: 'Rajasthan', pincode: null });
    expect(suggestionFromPlace(null)).toBeNull();
    expect(suggestionFromPlace({})).toBeNull();
    expect(suggestionLabel(null)).toBe('Current location');
  });
});

describe('Indian addresses', () => {
  it('validates six-digit PIN codes (never starting with 0)', () => {
    expect(isValidPincode('332001')).toBe(true);
    expect(isValidPincode(' 110001 ')).toBe(true);
    expect(isValidPincode('012345')).toBe(false);
    expect(isValidPincode('33200')).toBe(false);
    expect(isValidPincode('3320011')).toBe(false);
    expect(isValidPincode('33200a')).toBe(false);
  });

  it('requires village / city, district, state and PIN — one place field, not both village and city', () => {
    const village = { area: 'Gujar Mohalla', city: 'Palsana', district: 'Sikar', state: 'Rajasthan', pincode: '332402' };
    expect(missingAddressFields(village, { requireArea: true })).toEqual([]);
    expect(missingAddressFields({ ...village, district: '' })).toEqual(['district']);
    expect(missingAddressFields({ ...village, pincode: '012345', state: null })).toEqual(['state', 'pincode']);
    expect(missingAddressFields({ ...village, area: '' }, { requireArea: true })).toEqual(['area']);
  });

  it('formats rural and urban addresses, and older ones without a district', () => {
    const rural = formatAddressLines({ area: 'Gujar Mohalla', city: 'Palsana', district: 'Sikar', state: 'Rajasthan', pincode: '332402', landmark: 'Near the school' });
    expect(rural).toEqual({ line1: 'Gujar Mohalla', line2: 'Palsana, District Sikar, Rajasthan 332402', landmark: 'Near the school' });
    // A district named like its city is not repeated.
    expect(formatAddressLines({ houseNo: '12', street: 'Station Road', area: 'Shastri Nagar', city: 'Sikar', district: 'sikar', state: 'Rajasthan', pincode: '332001' }).line2).toBe(
      'Sikar, Rajasthan 332001',
    );
    // Older address: no district, house number repeated as the locality — nothing invented, nothing doubled.
    expect(formatAddressOneLine({ houseNo: 'Main Road', area: 'Main Road', city: 'Sikar', district: null, state: 'Rajasthan', pincode: '332001', landmark: 'Shiv Mandir' })).toBe(
      'Main Road, Near Shiv Mandir, Sikar, Rajasthan 332001',
    );
    // A landmark that already says where it is is not prefixed again.
    expect(landmarkPhrase('Opposite the post office')).toBe('Opposite the post office');
    expect(landmarkPhrase('near bus stand')).toBe('near bus stand');
    expect(landmarkPhrase('Nearby Kirana')).toBe('Near Nearby Kirana');
    expect(formatAddressOneLine({ area: 'Gujar Mohalla', city: 'Palsana', district: 'Sikar', state: 'Rajasthan', pincode: '332402', landmark: 'Near the school' })).toContain('Gujar Mohalla, Near the school, Palsana');
  });

  it('displays straight-line distances with honest precision', () => {
    expect(formatDistance(0.004)).toBe('under 10 m');
    expect(formatDistance(0.8049)).toBe('800 m');
    expect(formatDistance(3.24)).toBe('3.2 km');
    expect(formatDistance(Number.NaN)).toBe('—');
    expect(formatStraightLineDistance(3.24)).toBe('3.2 km (straight line)');
  });
});

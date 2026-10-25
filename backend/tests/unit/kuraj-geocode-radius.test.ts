/**
 * Regression — a manually typed Kuraj address (Rajsamand, Rajasthan, 313328)
 * was given a wrong point, and a store ~5–6 km away then read as "outside the
 * delivery radius".
 *
 * Root cause: the delivery-radius maths was right; the POINT was not. A
 * forward-geocoder result naming a different village (Railmagra — the tehsil
 * town, PIN 313329) with no PIN of its own only counted as a "conflict" the
 * customer could confirm, and the manual form also offered the phone's own
 * position for a typed address. Either way a point that is not the typed
 * village could be saved — and every distance after that was measured from it.
 *
 * Real coordinates (OpenStreetMap): Kuraj village 25.0739, 74.0988 (313328);
 * the 313329 PIN area 25.0251, 74.0967; production's Railmagra stores 25.029,
 * 74.11. Pure — no database (the server-side checks are in
 * tests/integration/address-serviceability-kuraj.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { checkServiceability, distanceKmExact } from '../../src/shared/distance';
import { classifyGeocodeCandidate, pincodeAllowed, sortGeocodeCandidates, type AddressSuggestion } from '../../src/shared/location';

const KURAJ_TYPED = { city: 'Kuraj', district: 'Rajsamand', state: 'Rajasthan', pincode: '313328' };
const KURAJ = { latitude: 25.0739038, longitude: 74.0988101 };
const PIN_313328_CENTRE = { latitude: 25.0840089, longitude: 74.097245 };
const RAILMAGRA_313329 = { latitude: 25.0251132, longitude: 74.0966808 };
const STORE = { latitude: 25.029, longitude: 74.11 };
/** Rajsamand town — where a district-level fallback lands, ~22 km away. */
const RAJSAMAND_TOWN = { latitude: 25.0716, longitude: 73.8805 };
const RADIUS_KM = 12;

const place = (p: Partial<AddressSuggestion>): AddressSuggestion => ({
  houseNo: null,
  street: null,
  area: null,
  city: null,
  district: null,
  state: null,
  pincode: null,
  ...p,
});

describe('Kuraj 313328 versus the geocoder\'s Railmagra 313329', () => {
  it('the Railmagra 313329 result is refused — a different PIN is a different place', () => {
    const result = classifyGeocodeCandidate(KURAJ_TYPED, {
      ...RAILMAGRA_313329,
      place: place({ city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' }),
    });
    expect(result.reason).toBe('DIFFERENT_PLACE');
  });

  it('"Railmagra" with no PIN of its own is refused too (it used to be offered for confirmation)', () => {
    const result = classifyGeocodeCandidate(KURAJ_TYPED, {
      ...RAILMAGRA_313329,
      place: place({ city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan' }),
    });
    expect(result.reason).toBe('DIFFERENT_VILLAGE');
  });

  it('a district-level fallback (Rajsamand town, no PIN) is refused — it is 20+ km from Kuraj', () => {
    const result = classifyGeocodeCandidate(KURAJ_TYPED, { ...RAJSAMAND_TOWN, place: place({ city: 'Rajsamand', district: 'Rajsamand', state: 'Rajasthan' }) });
    expect(result.reason).toBe('DIFFERENT_VILLAGE');
    expect(distanceKmExact(KURAJ.latitude, KURAJ.longitude, RAJSAMAND_TOWN.latitude, RAJSAMAND_TOWN.longitude)).toBeGreaterThan(20);
  });

  it('the PIN-area centre alone is not an address: refused, even though the PIN matches', () => {
    const result = classifyGeocodeCandidate(KURAJ_TYPED, { ...PIN_313328_CENTRE, place: place({ district: 'Rajsamand', state: 'Rajasthan', pincode: '313328' }) });
    expect(result.reason).toBe('PIN_AREA_ONLY');
  });

  it('only the real Kuraj result is usable — village and PIN first, village alone next', () => {
    const { usable, rejected } = sortGeocodeCandidates(KURAJ_TYPED, [
      { ...RAILMAGRA_313329, place: place({ city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' }) },
      { ...PIN_313328_CENTRE, place: place({ pincode: '313328', state: 'Rajasthan' }) },
      { ...KURAJ, place: place({ city: 'Kuraj', district: 'Rajsamand', state: 'Rajasthan', pincode: '313328' }) },
    ]);
    expect(usable).toHaveLength(1);
    expect(usable[0]).toMatchObject({ ...KURAJ, reason: 'VILLAGE_AND_PIN' });
    expect(rejected.map((r) => r.reason).sort()).toEqual(['DIFFERENT_PLACE', 'PIN_AREA_ONLY']);

    const villageOnly = sortGeocodeCandidates(KURAJ_TYPED, [{ ...KURAJ, place: place({ city: 'Kuraj Village', state: 'Rajasthan' }) }]);
    expect(villageOnly.usable.map((u) => u.reason)).toEqual(['VILLAGE']);
  });

  it('geocoder failure / nothing found: nothing usable — no fallback point is ever made up', () => {
    expect(sortGeocodeCandidates(KURAJ_TYPED, [])).toEqual({ usable: [], rejected: [] });
    // (0, 0) — what a failed lookup returns — and swapped coordinates are refused even when the name matches.
    const named = place({ city: 'Kuraj', pincode: '313328' });
    const { usable, rejected } = sortGeocodeCandidates(KURAJ_TYPED, [
      { latitude: 0, longitude: 0, place: named },
      { latitude: KURAJ.longitude, longitude: KURAJ.latitude, place: named },
    ]);
    expect(usable).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['INVALID_POINT', 'INVALID_POINT']);
  });
});

describe('distance and radius', () => {
  it('Kuraj is ~5 km from the Railmagra store: inside the 12 km radius (latitude first, kilometres, exact)', () => {
    const check = checkServiceability(KURAJ.latitude, KURAJ.longitude, STORE.latitude, STORE.longitude, RADIUS_KM);
    expect(check.serviceable).toBe(true);
    expect(check.distanceKm).toBeGreaterThan(4.5);
    expect(check.distanceKm).toBeLessThan(6.5);
    // Coordinate order matters: the swapped pair is ~5,000 km off, never "nearby".
    expect(distanceKmExact(KURAJ.longitude, KURAJ.latitude, STORE.latitude, STORE.longitude)).toBeGreaterThan(1000);
  });

  it('a genuinely far address is outside the radius', () => {
    const check = checkServiceability(RAJSAMAND_TOWN.latitude, RAJSAMAND_TOWN.longitude, STORE.latitude, STORE.longitude, RADIUS_KM);
    expect(check.serviceable).toBe(false);
    expect(check.distanceKm).toBeGreaterThan(RADIUS_KM);
  });

  it('radius boundary: exactly at the radius is inside, a few metres past it is outside; the shown km never contradicts the decision', () => {
    // Points due north of the store at a chosen distance (1° of latitude ≈ 111.195 km).
    const north = (km: number) => STORE.latitude + km / 111.19492664455873;
    const at = checkServiceability(north(RADIUS_KM - 0.0005), STORE.longitude, STORE.latitude, STORE.longitude, RADIUS_KM);
    const past = checkServiceability(north(RADIUS_KM + 0.005), STORE.longitude, STORE.latitude, STORE.longitude, RADIUS_KM);
    expect(at.serviceable).toBe(true);
    expect(at.distanceKm).toBeLessThanOrEqual(RADIUS_KM);
    expect(past.serviceable).toBe(false);
    expect(past.distanceKm).toBeGreaterThan(RADIUS_KM);
  });
});

describe('approved PIN codes', () => {
  it('no list: every PIN allowed (the radius decides); with a list: only listed PINs — never a PIN alone ruling delivery in', () => {
    expect(pincodeAllowed('313328', [])).toBe(true);
    expect(pincodeAllowed('313 328', ['313328', '313329'])).toBe(true);
    expect(pincodeAllowed('313324', ['313328', '313329'])).toBe(false);
    expect(pincodeAllowed(null, ['313328'])).toBe(false);
    expect(pincodeAllowed('31332', ['313328'])).toBe(false);
  });
});

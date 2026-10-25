/**
 * Typed address <-> point validation (shared/location.ts) — pure, no network.
 * Geocoder answers are given as AddressSuggestion values (what the app gets
 * after reverse-geocoding a point); nothing here calls a real provider.
 */

import { describe, expect, it } from 'vitest';
import {
  checkPointAgainstAddress,
  geocodeQueryFor,
  normalizePincode,
  normalizePlaceName,
  placeChanged,
  sortGeocodeCandidates,
  type AddressSuggestion,
} from '../../src/shared/location';

const RAILMAGRA = { city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' };
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

describe('geocodeQueryFor — the full address, never the village or PIN alone', () => {
  it('joins every part that says where it is, cleans it, adds the country and leaves the landmark out', () => {
    expect(
      geocodeQueryFor({ houseNo: ' 12 ', street: 'Bus  Stand Road', area: 'Teli Mohalla', ...RAILMAGRA, pincode: '313 329' }),
    ).toBe('12, Bus Stand Road, Teli Mohalla, Railmagra, Rajsamand, Rajasthan, 313329, India');
    // A part repeated (village = locality) is sent once; an invalid PIN is dropped, never guessed.
    expect(geocodeQueryFor({ area: 'Railmagra', city: 'railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '31332' })).toBe(
      'Railmagra, Rajsamand, Rajasthan, India',
    );
    expect(geocodeQueryFor({ city: '', district: null, state: undefined, pincode: null })).toBe('');
  });
});

describe('normalisation compares places, never rewrites them', () => {
  it('ignores case, spacing, accents, "District" / "Tehsil" wording and common state misspellings', () => {
    expect(normalizePlaceName('  RAJSAMAND   District ')).toBe('rajsamand');
    expect(normalizePlaceName('Railmagra Tehsil')).toBe('railmagra');
    expect(normalizePlaceName('राजस्थान')).toBe('rajasthan');
    expect(normalizePlaceName('rajsathan')).toBe('rajasthan');
    expect(normalizePincode('313 329')).toBe('313329');
    expect(normalizePincode('31332')).toBeNull();
  });
});

describe('checkPointAgainstAddress', () => {
  it('MATCH: the point is where the address says (PIN agrees; "District" wording is no difference)', () => {
    expect(checkPointAgainstAddress(RAILMAGRA, place({ city: 'Railmagra', district: 'Rajsamand District', state: 'Rajasthan', pincode: '313329' })).verdict).toBe(
      'MATCH',
    );
  });

  it('MISMATCH: a different PIN, district or state is a different place — the next village (Kuraj, 313328) is never accepted silently', () => {
    const kuraj = place({ city: 'Kuraj', district: 'Rajsamand', state: 'Rajasthan', pincode: '313328' });
    expect(checkPointAgainstAddress(RAILMAGRA, kuraj)).toMatchObject({ verdict: 'MISMATCH', fields: { pincode: 'MISMATCH', city: 'MISMATCH' } });
    expect(checkPointAgainstAddress(RAILMAGRA, place({ city: 'Railmagra', district: 'Bhilwara', state: 'Rajasthan' })).verdict).toBe('MISMATCH');
    expect(checkPointAgainstAddress(RAILMAGRA, place({ city: 'Railmagra', state: 'Gujarat' })).verdict).toBe('MISMATCH');
  });

  it('CONFLICT: only the village name differs (geocoders name areas coarsely) — the person must confirm', () => {
    expect(checkPointAgainstAddress(RAILMAGRA, place({ city: 'Chokri', district: 'Rajsamand', state: 'Rajasthan' })).verdict).toBe('CONFLICT');
  });

  it('UNVERIFIED: the geocoder said nothing usable — unknown is never a match, nor a mismatch', () => {
    expect(checkPointAgainstAddress(RAILMAGRA, null)).toMatchObject({
      verdict: 'UNVERIFIED',
      fields: { city: 'UNKNOWN', district: 'UNKNOWN', state: 'UNKNOWN', pincode: 'UNKNOWN' },
    });
    expect(checkPointAgainstAddress(RAILMAGRA, place({ state: 'Rajasthan' })).verdict).toBe('UNVERIFIED');
  });
});

describe('sortGeocodeCandidates — never "take the first result"', () => {
  it('several villages with the same name: district, state and PIN pick the right one; the others are rejected', () => {
    const { usable, rejected } = sortGeocodeCandidates(RAILMAGRA, [
      // Listed first by the geocoder, but in another district.
      { latitude: 25.35, longitude: 74.63, place: place({ city: 'Railmagra', district: 'Bhilwara', state: 'Rajasthan', pincode: '311001' }) },
      { latitude: 25.029, longitude: 74.1096, place: place({ city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' }) },
    ]);
    expect(usable).toHaveLength(1);
    expect(usable[0]).toMatchObject({ latitude: 25.029, check: { verdict: 'MATCH' } });
    expect(rejected.map((r) => r.place?.district)).toEqual(['Bhilwara']);
  });

  it('an unrelated result (the next village\'s PIN) is rejected, not offered', () => {
    const { usable, rejected } = sortGeocodeCandidates(RAILMAGRA, [
      { latitude: 25.0745, longitude: 74.101, place: place({ city: 'Kuraj', district: 'Rajsamand', state: 'Rajasthan', pincode: '313328' }) },
    ]);
    expect(usable).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it('invalid, (0, 0) and swapped coordinates are never usable, whatever the place says', () => {
    const ok = place({ city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' });
    const { usable, rejected } = sortGeocodeCandidates(RAILMAGRA, [
      { latitude: 0, longitude: 0, place: ok },
      { latitude: 74.1096, longitude: 25.029, place: ok },
      { latitude: 95, longitude: 74, place: ok },
    ]);
    expect(usable).toEqual([]);
    expect(rejected).toHaveLength(3);
  });

  it('only results naming the typed village are usable, village + PIN first; a different village or an unnamed spot is refused with its reason', () => {
    const { usable, rejected } = sortGeocodeCandidates(RAILMAGRA, [
      { latitude: 25.0291, longitude: 74.1097, place: place({ state: 'Rajasthan' }) }, // unnamed, 15 m from the match
      { latitude: 25.029, longitude: 74.1096, place: place({ city: 'Railmagra', pincode: '313329' }) }, // village + PIN
      { latitude: 25.04, longitude: 74.12, place: place({ city: 'Chokri', state: 'Rajasthan' }) }, // another village, 1.6 km away
      { latitude: 25.0295, longitude: 74.1099, place: place({ city: 'Railmagra' }) }, // the same village, 60 m away: merged
    ]);
    expect(usable.map((u) => u.reason)).toEqual(['VILLAGE_AND_PIN']);
    expect(rejected.map((r) => r.reason).sort()).toEqual(['DIFFERENT_VILLAGE', 'UNNAMED']);
  });
});

describe('placeChanged — when a saved point must be confirmed again', () => {
  it('a new village, district, state or PIN is a different place', () => {
    expect(placeChanged(RAILMAGRA, { ...RAILMAGRA, city: 'Kuraj' })).toBe(true);
    expect(placeChanged(RAILMAGRA, { ...RAILMAGRA, pincode: '313328' })).toBe(true);
    expect(placeChanged(RAILMAGRA, { ...RAILMAGRA, district: 'Bhilwara' })).toBe(true);
    expect(placeChanged({ ...RAILMAGRA, district: null }, RAILMAGRA)).toBe(true);
  });

  it('case, spacing, "District" wording and PIN formatting are not a change', () => {
    expect(placeChanged(RAILMAGRA, { city: ' railmagra ', district: 'Rajsamand District', state: 'RAJASTHAN', pincode: '313 329' })).toBe(false);
  });
});

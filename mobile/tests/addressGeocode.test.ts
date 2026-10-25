/**
 * Add / Edit Address — which map results may become a typed address's point
 * (the app's copy of @shared/location, as AddressFormScreen and
 * lib/deviceLocation findAddressCandidates use it). Run with `npm run test:unit`.
 *
 * Regression: "Kuraj, Rajsamand, Rajasthan, 313328" was offered the
 * geocoder's "Railmagra, Rajasthan, 313329" (and coarser fallbacks); once
 * saved, a store ~5 km from Kuraj could read as out of range.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEOCODE_REJECTION_TEXT,
  isAcceptedGeocodeCandidate,
  sortGeocodeCandidates,
  type AddressSuggestion,
  type GeocodeCandidateReason,
} from "@shared/location";

const KURAJ_TYPED = { city: "Kuraj", district: "Rajsamand", state: "Rajasthan", pincode: "313328" };
const place = (p: Partial<AddressSuggestion>): AddressSuggestion => ({ houseNo: null, street: null, area: null, city: null, district: null, state: null, pincode: null, ...p });

describe("finding a typed address on the map", () => {
  it("the geocoder's Railmagra 313329 — with or without its PIN — is never offered for Kuraj 313328", () => {
    const { usable, rejected } = sortGeocodeCandidates(KURAJ_TYPED, [
      { latitude: 25.0251, longitude: 74.0967, place: place({ city: "Railmagra", district: "Rajsamand", state: "Rajasthan", pincode: "313329" }) },
      { latitude: 25.0251, longitude: 74.0967, place: place({ city: "Railmagra", district: "Rajsamand", state: "Rajasthan" }) },
    ]);
    assert.deepEqual(usable, []);
    assert.deepEqual(rejected.map((r) => r.reason), ["DIFFERENT_PLACE", "DIFFERENT_VILLAGE"]);
  });

  it("the real Kuraj result is offered; the PIN-area centre is not", () => {
    const { usable, rejected } = sortGeocodeCandidates(KURAJ_TYPED, [
      { latitude: 25.084, longitude: 74.0972, place: place({ pincode: "313328", state: "Rajasthan" }) },
      { latitude: 25.0739, longitude: 74.0988, place: place({ city: "Kuraj", district: "Rajsamand", state: "Rajasthan", pincode: "313328" }) },
    ]);
    assert.equal(usable.length, 1);
    assert.equal(usable[0]!.latitude, 25.0739);
    assert.ok(usable.every(isAcceptedGeocodeCandidate));
    assert.deepEqual(rejected.map((r) => r.reason), ["PIN_AREA_ONLY"]);
  });

  it("a failed or empty lookup offers nothing (the form then asks the customer to check the address)", () => {
    assert.deepEqual(sortGeocodeCandidates(KURAJ_TYPED, []), { usable: [], rejected: [] });
  });

  it("every refusal has words for the customer", () => {
    const refusals: GeocodeCandidateReason[] = ["DIFFERENT_PLACE", "DIFFERENT_VILLAGE", "PIN_AREA_ONLY", "UNNAMED", "INVALID_POINT"];
    for (const reason of refusals) assert.ok((GEOCODE_REJECTION_TEXT as Record<string, string>)[reason], reason);
  });
});

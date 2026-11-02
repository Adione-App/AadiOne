/**
 * Approved delivery villages — the shared pair rules (src/shared/address.ts)
 * and the app's helpers (src/lib/deliveryLocations.ts). Run with
 * `npm run test:unit`. The server applies the same shared rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { activePincodesFor, activeVillages, deliveryPairMessage, deliveryPairVerdict } from "../src/shared/address.ts";
import { approvedVillage, matchApprovedPair, pincodesFor } from "../src/lib/deliveryLocations.ts";

const PAIRS = [
  { village: "Kuraj", pincode: "313328", active: true },
  { village: "Charbhuja", pincode: "313325", active: true },
  { village: "Kelwara", pincode: "313334", active: true },
  { village: "Amet", pincode: "313332", active: false },
  { village: "Kuraj", pincode: "313301", active: true },
];

const LIST = [
  { village: "Charbhuja", pincodes: ["313325"] },
  { village: "Kelwara", pincodes: ["313334"] },
  { village: "Kuraj", pincodes: ["313301", "313328"] },
];

describe("the approved-pair rule", () => {
  it("approved village + its PIN: APPROVED (case and spacing aside); the admin spelling is returned", () => {
    const result = deliveryPairVerdict(PAIRS, "  kuraj ", "313328");
    assert.equal(result.verdict, "APPROVED");
    assert.equal(result.pair?.village, "Kuraj");
  });

  it("approved village + another PIN: PIN_MISMATCH", () => {
    assert.equal(deliveryPairVerdict(PAIRS, "Kuraj", "313325").verdict, "PIN_MISMATCH");
  });

  it("unapproved village: VILLAGE_NOT_APPROVED", () => {
    assert.equal(deliveryPairVerdict(PAIRS, "Deogarh", "313331").verdict, "VILLAGE_NOT_APPROVED");
  });

  it("disabled pair: DISABLED", () => {
    assert.equal(deliveryPairVerdict(PAIRS, "Amet", "313332").verdict, "DISABLED");
  });

  it("missing village or PIN: MISSING", () => {
    assert.equal(deliveryPairVerdict(PAIRS, "Kuraj", "").verdict, "MISSING");
    assert.equal(deliveryPairVerdict(PAIRS, "", "313328").verdict, "MISSING");
  });

  it("dropdowns: active villages A–Z, each with its own active PINs", () => {
    assert.deepEqual(activeVillages(PAIRS), ["Charbhuja", "Kelwara", "Kuraj"]);
    assert.deepEqual(activePincodesFor(PAIRS, "kuraj"), ["313301", "313328"]);
    assert.deepEqual(activePincodesFor(PAIRS, "Amet"), []);
  });

  it("every refusal has a reason in words", () => {
    assert.match(deliveryPairMessage("PIN_MISMATCH", "Kuraj", "313325"), /only with its own PIN code/);
    assert.match(deliveryPairMessage("VILLAGE_NOT_APPROVED", "Deogarh", "313331"), /not delivering to Deogarh 313331/);
    assert.match(deliveryPairMessage("MISSING", null, null), /Choose your village/);
  });
});

describe("the app's helpers on the server's list", () => {
  it("a village's PIN codes for the PIN dropdown", () => {
    assert.deepEqual(pincodesFor(LIST, "Kuraj"), ["313301", "313328"]);
    assert.deepEqual(pincodesFor(LIST, "Deogarh"), []);
    assert.equal(approvedVillage(LIST, "KELWARA"), "Kelwara");
  });

  it("GPS: an exact approved pair is prefilled (admin spelling)", () => {
    assert.deepEqual(matchApprovedPair(LIST, "kuraj", "313328"), { village: "Kuraj", pincode: "313328" });
  });

  it("GPS: an unapproved village, a wrong PIN or a missing part is never matched — no nearby substitute", () => {
    assert.equal(matchApprovedPair(LIST, "Railmagra", "313329"), null);
    assert.equal(matchApprovedPair(LIST, "Kuraj", "313329"), null);
    assert.equal(matchApprovedPair(LIST, "Kuraj", null), null);
    assert.equal(matchApprovedPair(LIST, null, "313328"), null);
  });
});

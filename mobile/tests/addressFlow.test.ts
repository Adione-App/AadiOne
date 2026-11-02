/**
 * The checkout address flow — two clear choices, then a confirmation form.
 * Validation rules run as pure functions; the screens (which need a device)
 * are checked on their source. Run with `npm run test:unit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatAddressLines, isValidPincode, missingAddressFields } from "../src/shared/address.ts";
import { normalizeIndianMobile } from "../src/shared/phone.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const cart = read("src/screens/cart/CartScreen.tsx");
const form = read("src/screens/account/AddressFormScreen.tsx");
const stacks = read("src/navigation/stacks.tsx");

describe("address validation (unchanged rules)", () => {
  it("required: locality, village / town, district, state and a valid PIN; house, street and landmark are optional", () => {
    const full = { area: "Shastri Nagar", city: "Kuraj", district: "Rajsamand", state: "Rajasthan", pincode: "313328" };
    assert.deepEqual(missingAddressFields(full, { requireArea: true }), []);
    assert.deepEqual(missingAddressFields({ ...full, area: "", city: " " }, { requireArea: true }), ["area", "city"]);
    assert.deepEqual(missingAddressFields({ ...full, pincode: "31332" }, { requireArea: true }), ["pincode"]);
  });

  it("PIN code: exactly 6 digits, not starting with 0", () => {
    assert.equal(isValidPincode("313328"), true);
    for (const bad of ["31332", "3133280", "013328", "31332a", ""]) assert.equal(isValidPincode(bad), false, bad);
  });

  it("mobile number: a valid 10-digit Indian number (with or without +91 / 0)", () => {
    assert.equal(normalizeIndianMobile("9414000001"), "9414000001");
    assert.equal(normalizeIndianMobile("+91 94140 00001"), "9414000001");
    assert.equal(normalizeIndianMobile("12345"), null);
    assert.equal(normalizeIndianMobile("1234567890"), null);
  });

  it("the readable address shows house, street, locality, village, PIN and the landmark", () => {
    const lines = formatAddressLines({
      houseNo: "12",
      street: "Station Road",
      area: "Shastri Nagar",
      city: "Kuraj",
      district: "Rajsamand",
      state: "Rajasthan",
      pincode: "313328",
      landmark: "Shiv Mandir",
    });
    assert.match(lines.line1, /12/);
    assert.match(lines.line1, /Station Road/);
    assert.match(lines.line2, /Kuraj/);
    assert.match(lines.line2, /313328/);
    assert.equal(lines.landmark, "Shiv Mandir");
  });
});

describe("step 1 — the address sheet offers two clearly labelled choices", () => {
  it("Use Current Location (with the permission explanation) and Enter Address Manually", () => {
    assert.match(cart, /Use Current Location\n/);
    assert.match(cart, /allow location permission when asked/);
    assert.match(cart, /Enter Address Manually\n/);
    assert.match(cart, /Type your name, phone, house and street, village or town, and PIN code/);
  });

  it("Use Current Location reads the GPS and goes straight to the confirmation form — no intermediate screen", () => {
    const flow = cart.slice(cart.indexOf("const useCurrentLocationForCheckout"), cart.indexOf("}, [onCompleteLiveDetails]);"));
    assert.match(flow, /refreshCurrentLocation\("user", \{ prompt: true \}\)/);
    assert.match(flow, /onCompleteLiveDetails\(liveFixParams\(current\.liveDestination\)\)/);
    assert.doesNotMatch(cart, /navigate\("SelectLocation"\)|onChangeLocation\(\)/);
  });

  it("GPS denied / unavailable: the reason, with the manual option right below — and no hardcoded state rule", () => {
    const flow = cart.slice(cart.indexOf("const useCurrentLocationForCheckout"), cart.indexOf("}, [onCompleteLiveDetails]);"));
    assert.match(flow, /setLocateError\(GPS_FAILURE_MESSAGE\[outcome\.failure\]\)/);
    assert.doesNotMatch(flow, /Rajasthan/);
    assert.match(cart, /You can enter your address manually instead\./);
  });

  it("no address yet: the same sheet (not a separate screen)", () => {
    assert.match(cart, /onAdd=\{\(\) => setAddressPickerOpen\(true\)\}/);
  });
});

describe("step 2 — the form: clear fields, validation, Save Address", () => {
  it("every field has a plain label and an example", () => {
    for (const label of [
      'label="Full Name"',
      'label="Mobile Number"',
      'label="House / Flat Number" hint={optional}',
      'label="Street / Road" hint={optional}',
      'label="Locality / Mohalla / Colony"',
      'label="Village / Town / City"',
      'label="District"',
      'label="Landmark"',
      'label="PIN Code"',
      'label="State"',
      'label="Address Type"',
    ]) {
      assert.ok(form.includes(label), label);
    }
    for (const hint of ["Enter your house number", "Enter your street", "Choose your village or town", "Add a nearby landmark (optional)"]) {
      assert.ok(form.includes(hint), hint);
    }
  });

  it("each field is saved to its own existing column (no new or duplicate fields)", () => {
    assert.match(form, /houseNo: houseNo \|\| null,\n\s*street: street \|\| null,\n\s*landmark: landmark \|\| null,/);
  });

  it("an invalid mobile number is explained; Save stays disabled until complete", () => {
    assert.match(form, /Enter a valid 10-digit mobile number\./);
    assert.match(form, /label=\{isEditing \? 'Save Changes' : 'Save Address'\}[\s\S]{0,120}disabled=\{!complete\}/);
  });

  it("village and PIN are dropdowns of the admin-approved pairs only — never free text", () => {
    const village = form.slice(form.indexOf('<Field label="Village / Town / City">'), form.indexOf('<Field label="Village / Town / City">') + 500);
    assert.match(village, /<OptionPicker[\s\S]*options=\{villageOptions\}/);
    const pin = form.slice(form.indexOf('<Field label="PIN Code">'), form.indexOf('<Field label="PIN Code">') + 500);
    assert.match(pin, /<OptionPicker[\s\S]*options=\{pinOptions\}/);
    assert.match(form, /const pinOptions = useMemo\(\(\) => pincodesFor\(villages, fields\.city\)/);
    // What is sent is the approved pair (the admin's spelling).
    assert.match(form, /city: pair\.village,/);
    assert.match(form, /pincode: pair\.pincode,/);
  });

  it("the map verification step is gone; a typed address is placed on the map quietly (server fallback otherwise)", () => {
    for (const gone of ["Check address on map", "Not confirmed yet", "Fields marked", "This is my village"]) {
      assert.ok(!form.includes(gone), gone);
    }
    assert.match(form, /const placed = needsPoint \? await placeOnMap\(\) : null;/);
  });

  it("live location: the village + PIN are prefilled only for an EXACT approved pair; otherwise the customer chooses", () => {
    assert.match(form, /matchApprovedPair\(villages, s\?\.city, s\?\.pincode\)/);
    assert.match(form, /city: match\?\.village \?\? '',/);
    assert.match(form, /pincode: match\?\.pincode \?\? '',/);
    assert.match(form, /is not on our delivery list/);
    // The customer's GPS point is kept.
    assert.match(form, /setPoint\(\{ latitude: live\.latitude, longitude: live\.longitude, source: 'GPS'/);
  });

  it("the GPS confirmation form shows the found address to check, with Save Address when saving it", () => {
    assert.match(form, /'Confirm your address'/);
    assert.match(form, /saveAsAddress \? 'Save Address' : 'Deliver to this address'/);
  });

  it("an address saved from checkout becomes the selected one, so the Cart shows it", () => {
    assert.match(form, /if \(selectWhenSaved && !isEditing && saved\) \{\n\s*selectAddress\(saved\.id\);/);
    const cartStackForm = stacks.slice(stacks.indexOf('<CartNav.Screen name="AddressForm">'));
    assert.match(cartStackForm.slice(0, 900), /selectWhenSaved/);
  });
});

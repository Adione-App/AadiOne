/**
 * Legal acceptance prompt (lib/legalConsent.ts, components/LegalConsentPrompt)
 * and seller details (components/SellerDetails) — run with `npm run test:unit`.
 * Server sides: backend tests/integration/legal-consent.test.ts and
 * seller-disclosure.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consentPromptKey, dismissConsentPrompt, dismissedConsentKey, resetConsentDismissal, shouldShowConsentPrompt } from "../src/lib/legalConsent.ts";
import { legalConsentRequired, type LegalConsentStatusDto } from "../src/shared/info-pages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const due: LegalConsentStatusDto = { required: true, privacyVersion: 2, termsVersion: 3, accepted: null };

describe("when the prompt shows", () => {
  it("only to a signed-in customer, only when the server says acceptance is due", () => {
    assert.equal(shouldShowConsentPrompt(false, due, null), false);
    assert.equal(shouldShowConsentPrompt(true, { ...due, required: false }, null), false);
    assert.equal(shouldShowConsentPrompt(true, { ...due, privacyVersion: null }, null), false);
    assert.equal(shouldShowConsentPrompt(true, due, null), true);
  });

  it("'Not now' hides it for these versions in this app session; a newer version asks again", () => {
    resetConsentDismissal();
    dismissConsentPrompt(consentPromptKey(due));
    assert.equal(shouldShowConsentPrompt(true, due, dismissedConsentKey()), false);
    assert.equal(shouldShowConsentPrompt(true, { ...due, privacyVersion: 3 }, dismissedConsentKey()), true);
    resetConsentDismissal();
    assert.equal(dismissedConsentKey(), null);
  });

  it("the shared rule asks again only for a newer required version", () => {
    assert.equal(legalConsentRequired(null, null), false);
    assert.equal(legalConsentRequired({ privacy: 1, terms: 1 }, null), true);
    assert.equal(legalConsentRequired({ privacy: 1, terms: 1 }, { privacyVersion: 1, termsVersion: 1 }), false);
    assert.equal(legalConsentRequired({ privacy: 2, terms: 1 }, { privacyVersion: 1, termsVersion: 3 }), true);
  });
});

describe("wiring", () => {
  const prompt = read("src/components/LegalConsentPrompt.tsx");
  const app = read("App.tsx");
  const store = read("src/lib/store.ts");

  it("records consent only from the 'I agree' action, with the versions shown", () => {
    assert.match(prompt, /api\.post<LegalConsentStatusDto>\('\/legal\/consent'/);
    assert.match(prompt, /<Button label="I agree" onPress=\{onAccept\}/);
    // "Not now" never calls the server.
    const later = prompt.slice(prompt.indexOf("onLater={() => {"), prompt.indexOf("rerender((n) => n + 1);"));
    assert.doesNotMatch(later, /api\./);
  });

  it("is mounted for signed-in customers only, and sign-out resets 'Not now'", () => {
    assert.match(app, /status === "authenticated" && startupReady && !isRestoring \? <LegalConsentPrompt \/> : null/);
    assert.equal((store.match(/resetConsentDismissal\(\);/g) ?? []).length, 2);
  });

  it("guest browsing, the cart and checkout never wait for acceptance", () => {
    // Accepting is never a condition for ordering: nothing outside the prompt,
    // its rule and sign-out reads the consent status or the endpoint.
    for (const file of ["src/lib/authGate.ts", "src/lib/useCartActions.ts", "src/navigation/stacks.tsx", "src/screens/cart/CartScreen.tsx", "src/screens/checkout/UpiPaymentScreen.tsx", "src/screens/catalog/ProductDetailScreen.tsx"]) {
      assert.doesNotMatch(read(file), /legalConsent|LegalConsent|legal\/consent|consentPrompt/i, file);
    }
    // The prompt never shows to a guest, and "Not now" (onLater) only hides it.
    assert.equal(shouldShowConsentPrompt(false, due, null), false);
    assert.match(prompt, /onLater=\{\(\) => \{/);
  });

  it("the product page shows no seller name or seller contact (product decision, 2026-11-07)", () => {
    const pdp = read("src/screens/catalog/ProductDetailScreen.tsx");
    assert.doesNotMatch(pdp, /SoldBy|SellerDetails|sellerName|customerCare|Sold by|Seller details/);
  });

  it("seller details are reachable from the restaurant menu and the order", () => {
    assert.match(read("src/screens/food/RestaurantMenuScreen.tsx"), /<SoldBy sellerId=\{restaurant\.sellerId\} sellerName=\{restaurant\.name\} label="Food by" \/>/);
    const order = read("src/screens/orders/OrderTrackingScreen.tsx");
    assert.match(order, /<SoldBy key=\{sellerOrder\.id\} sellerId=\{sellerOrder\.sellerId\} sellerName=\{sellerOrder\.sellerName\} \/>/);
    assert.doesNotMatch(order, /AadiOne|Railmagra/);
    const sheet = read("src/components/SellerDetails.tsx");
    assert.match(sheet, /\/stores\/\$\{sellerId\}\/details/);
    assert.doesNotMatch(sheet, /ownerMobile|seller\.phone|panNumber|aadhaar/i);
  });
});

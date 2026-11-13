/**
 * Branding inside the customer app (lib/branding.ts, components/BrandMark.tsx,
 * the start-up screen) and the customer policies in Account → About —
 * run with `npm run test:unit`. Server: backend tests/integration/branding.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brandAssetFor } from "../src/shared/branding.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("logos inside the app", () => {
  it("each brand image shows the published logo for its place, else the bundled artwork — never a broken image", () => {
    const mark = read("src/components/BrandMark.tsx");
    assert.match(mark, /source=\{published \?\? \(fallback as number\)\}/);
    assert.match(mark, /placeholder=\{published \? \(fallback as number\) : undefined\}/);
    assert.match(mark, /onError=\{\(\) => asset && setFailed\(asset\.url\)\}/);
    assert.match(mark, /cachePolicy="disk"/);
    assert.match(mark, /<BrandImage use="customerApp" fallback=\{MARK\}/);
    assert.match(read("src/components/ui.tsx"), /<BrandImage\n\s+use="customerSplash"\n\s+fallback=\{require\("..\/..\/assets\/adione-start-logo.png"\)\}/);
    assert.match(read("src/screens/auth/MobileEntryScreen.tsx"), /<BrandImage use="light" fallback=\{adioneLogo\}/);
  });

  it("the last branding is read from the phone at start-up and refreshed at launch and on return", () => {
    const app = read("App.tsx");
    assert.match(app, /useBranding\.getState\(\)\.hydrate\(\),/);
    assert.match(app, /void useBranding\.getState\(\)\.refresh\(\{ force: true \}\);/);
    assert.match(app, /void useBranding\.getState\(\)\.refresh\(\);/);
    const lib = read("src/lib/branding.ts");
    assert.match(lib, /\/\/ Offline or the server is unreachable: keep showing the cached branding\./);
    assert.match(lib, /AsyncStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(branding\)\)/);
  });

  it("the launcher icon and native splash are never changed from the server", () => {
    const lib = read("src/lib/branding.ts");
    assert.match(lib, /The app's launcher icon and its native splash are part of the installed\n \* app and never change from here/);
    // Only dynamic places are used in the app.
    const a = (url: string) => ({ url, pngUrl: url, width: 1, height: 1 });
    assert.equal(brandAssetFor({ assets: { customer_app_logo: a("https://cdn.example/m.webp") } }, "customerApp")?.url, "https://cdn.example/m.webp");
  });

  it("the visible name is Aadione", () => {
    for (const file of [
      "src/components/BrandMark.tsx",
      "src/components/ui.tsx",
      "src/screens/account/AccountScreen.tsx",
      "src/screens/account/RewardsScreen.tsx",
      "src/screens/auth/MobileEntryScreen.tsx",
      "src/screens/checkout/UpiPaymentScreen.tsx",
    ]) {
      assert.doesNotMatch(read(file), /accessibilityLabel="A(?:a)?diOne|'AdiOne customer'|Join me on AdiOne|friends to AdiOne|^\s+AdiOne$/m, file);
    }
  });
});

describe("customer policies", () => {
  it("Refund & Cancellation and Shipping & Delivery appear in Account only once published, on the same Legal screen", () => {
    const account = read("src/screens/account/AccountScreen.tsx");
    assert.match(account, /page\?\.source === 'published'/);
    assert.match(account, /key: 'refund-policy', label: 'Refund & Cancellation'/);
    assert.match(account, /key: 'shipping-policy', label: 'Shipping & Delivery'/);
    assert.match(read("src/navigation/types.ts"), /export type CustomerLegalSlug = "privacy" \| "terms" \| "refund-policy" \| "shipping-policy";/);
    assert.match(read("src/navigation/stacks.tsx"), /if \(key === "refund-policy" \|\| key === "shipping-policy"\) \{\n\s+navigation\.navigate\("Legal", \{ slug: key \}\);/);
  });
});

/**
 * Branding & Identity and Legal & Policies in the Admin and Seller Panels
 * (pages/Branding.tsx, lib/branding.ts, components/BrandLogo.tsx,
 * seller/sellerLegal.tsx, pages/InfoPages.tsx) — run with `npm run test:unit`.
 * The server side: backend tests/integration/branding.test.ts and
 * legal-policies.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRAND_ASSET_SLOTS,
  BRAND_ASSET_SPECS,
  DYNAMIC_BRAND_SLOTS,
  brandAssetFor,
  changedBrandSlots,
  isSafeAssetUrl,
} from "../src/shared/branding.ts";
import { INFO_PAGE_AUDIENCE, INFO_PAGE_SLUGS, asksForAcceptance, infoPagePublicPath } from "../src/shared/info-pages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("brand assets", () => {
  it("app icons are build-time assets; everything else updates live", () => {
    const build = BRAND_ASSET_SLOTS.filter((slot) => BRAND_ASSET_SPECS[slot].delivery === "build");
    assert.deepEqual(build, ["android_launcher_foreground", "android_launcher_background", "ios_app_icon"]);
    assert.ok(!DYNAMIC_BRAND_SLOTS.some((slot) => build.includes(slot)));
    // Never SVG (it can carry script, and PDFs cannot draw it).
    for (const slot of BRAND_ASSET_SLOTS) assert.ok(!(BRAND_ASSET_SPECS[slot].formats as readonly string[]).includes("svg"), slot);
  });

  it("each surface follows its fallback chain and only ever shows a safe address", () => {
    const a = (url: string) => ({ url, pngUrl: url, width: 10, height: 10 });
    const branding = { assets: { logo_main: a("https://cdn.example/main.webp"), logo_light: a("data:image/png;base64,AAAA") } };
    assert.equal(brandAssetFor(branding, "light")?.url, "https://cdn.example/main.webp");
    assert.equal(brandAssetFor(branding, "seller")?.url, "https://cdn.example/main.webp");
    assert.equal(brandAssetFor(branding, "favicon"), null);
    assert.equal(isSafeAssetUrl("http://localhost:4100/static/a.png"), true);
    assert.equal(isSafeAssetUrl("http://evil.example/a.png"), false);
    assert.equal(isSafeAssetUrl("javascript:alert(1)"), false);
  });

  it("knows which slots a draft changes", () => {
    const asset = (pngUrl: string) => ({ url: pngUrl, pngUrl, width: 1, height: 1, bytes: 1, hasAlpha: false, fileName: "x", uploadedAt: "" });
    assert.deepEqual(changedBrandSlots({ assets: { favicon: asset("a") } }, { assets: { favicon: asset("b"), logo_main: asset("c") } }), ["logo_main", "favicon"]);
    assert.deepEqual(changedBrandSlots({ assets: { favicon: asset("a") } }, { assets: { favicon: null } }), ["favicon"]);
  });
});

describe("panels show the published branding", () => {
  it("the Admin and Seller Panels draw BrandLogo (built-in wordmark as fallback), and the tab icon follows the favicon", () => {
    assert.match(read("src/App.tsx"), /<BrandLogo use="light" className="h-8" wordmarkClassName="text-2xl" \/>/);
    assert.match(read("src/App.tsx"), /useFaviconSync\(\);/);
    assert.match(read("src/seller/SellerApp.tsx"), /<BrandLogo use="seller"/);
    assert.match(read("src/components/PartnerLogin.tsx"), /<BrandLogo use=\{role === 'seller' \? 'seller' : 'light'\}/);
    const logo = read("src/components/BrandLogo.tsx");
    assert.match(logo, /if \(!asset \|\| failed === asset\.url\) return <AadioneWordmark/);
    assert.match(logo, /onError=\{\(\) => setFailed\(asset\.url\)\}/);
  });

  it("the last published branding is shown at once from the browser and refreshed in the background", () => {
    const lib = read("src/lib/branding.ts");
    assert.match(lib, /initialData: readCachedBranding/);
    assert.match(lib, /refetchOnWindowFocus: true/);
    assert.match(lib, /writeCachedBranding\(branding\)/);
    // A publish refreshes what this panel shows.
    assert.match(lib, /void refreshPublic\(\);/);
  });

  it("the visible name is Aadione in the panel's title and manifest", () => {
    assert.match(read("index.html"), /<title>Aadione — Admin &amp; Seller Panel<\/title>/);
    assert.doesNotMatch(read("index.html") + read("public/site.webmanifest"), /AdiOne|AadiOne/);
  });
});

describe("Branding & Identity page", () => {
  const page = read("src/pages/Branding.tsx");
  const app = read("src/App.tsx");

  it("is under Settings, for Configuration readers; changes need Configuration write", () => {
    assert.match(app, /to: '\/branding',\n\s+label: 'Branding & Identity',[\s\S]*?section: 'SETTINGS',[\s\S]*?permission: Permission\.CONFIG_READ,/);
    assert.match(app, /to: '\/info-pages',\n\s+label: 'Legal & Policies',[\s\S]*?section: 'SETTINGS',/);
    assert.match(page, /roleHasPermission\(role, Permission\.CONFIG_WRITE\)/);
  });

  it("offers upload, preview on light and dark, default, earlier files, publish all / selected and restore", () => {
    for (const text of ["Publish all changes", "Publish selected", "Use built-in default", "Use again", "Restore to draft", "Discard draft"]) assert.ok(page.includes(text), text);
    assert.match(page, /on a light background/);
    assert.match(page, /on a dark background/);
    for (const surface of ["Admin Panel header", "Seller Panel header", "Website header and footer", "Browser tab (favicon)", "Customer app — Home footer / About", "Customer app — start-up screen"]) {
      assert.ok(page.includes(surface), surface);
    }
  });

  it("says plainly that app icons change only with a new app release", () => {
    assert.match(page, /Needs a new app release/);
    assert.match(page, /A server cannot change the icon of an app that is already installed\./);
    assert.match(page, /phones keep the current icon until that release is approved, built and installed/);
  });
});

describe("Legal & Policies", () => {
  it("every document has an audience; only Privacy / Terms and the seller documents ask for acceptance", () => {
    assert.deepEqual(
      INFO_PAGE_SLUGS.filter((slug) => asksForAcceptance(slug)),
      ["privacy", "terms", "seller-terms", "seller-privacy"],
    );
    assert.equal(INFO_PAGE_AUDIENCE["seller-terms"], "seller");
    assert.equal(INFO_PAGE_AUDIENCE["refund-policy"], "customer");
    assert.equal(infoPagePublicPath("seller-terms", 3), "/api/v1/legal/seller-terms/versions/3/page");
  });

  it("the editor shows the public URL and a link to every earlier version", () => {
    const editor = read("src/pages/InfoPages.tsx");
    assert.match(editor, /Public page:/);
    assert.match(editor, /href=\{publicPageUrl\(slug, item\.revision\)\}/);
  });

  it("sellers accept explicitly in the Seller Panel — never by signing in or applying — and can say \"Not now\"", () => {
    const legal = read("src/seller/sellerLegal.tsx");
    assert.match(legal, /sellerApi\.post<SellerLegalConsentStatusDto>\('\/seller\/legal\/consent', body\)/);
    assert.match(legal, /Not now/);
    assert.match(legal, /window\.sessionStorage\.setItem\(DISMISS_KEY, versions\)/);
    const app = read("src/seller/SellerApp.tsx");
    assert.equal((app.match(/<SellerLegalConsentPrompt \/>/g) ?? []).length, 2); // onboarding and the full panel
    // The application form only links the documents; it never claims acceptance.
    const register = read("src/seller/pages/SellerRegister.tsx");
    assert.match(register, /<SellerLegalLinks intro="Before you apply, please read the" \/>/);
    assert.doesNotMatch(register, /legal\/consent/);
  });
});

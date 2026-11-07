/**
 * Admin Information Pages (pages/InfoPages.tsx) and their Configuration
 * settings — run with `npm run test:unit`. The editor's rules come from the
 * shared contract (checked directly); the screen's wiring is checked on the
 * source. The server side: backend tests/integration/info-pages.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { infoPageUnconfirmed, infoPageUnmetRequirements, validateInfoPage } from "../src/shared/info-pages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("editor rules (shared)", () => {
  it("lists every «TO CONFIRM» item with the section it is in", () => {
    const content = {
      title: "Terms",
      effectiveDate: "",
      sections: [{ heading: "Governing law", blocks: [{ type: "paragraph" as const, text: "Courts at «TO CONFIRM: city»." }] }],
    };
    assert.deepEqual(infoPageUnconfirmed(content), [{ section: "Governing law", text: "Courts at «TO CONFIRM: city»." }]);
  });

  it("a legal page needs a support email OR phone, plus the operator and grievance officer", () => {
    const unmet = infoPageUnmetRequirements("terms", { BUSINESS_LEGAL_NAME: "X", BUSINESS_ADDRESS: "Y", SUPPORT_PHONE: "+91 90000 00001" });
    assert.deepEqual(unmet, [["GRIEVANCE_OFFICER_NAME"], ["GRIEVANCE_OFFICER_DESIGNATION"], ["GRIEVANCE_OFFICER_EMAIL"]]);
    assert.deepEqual(infoPageUnmetRequirements("about", {}), []);
  });

  it("an old draft's typed version is ignored; the takes-effect date is optional", () => {
    const checked = validateInfoPage({ title: "About", version: "9.9", effectiveDate: "", sections: [{ heading: "H", blocks: [{ type: "paragraph", text: "T" }] }] });
    assert.ok(checked.ok);
    assert.equal("version" in checked.content, false);
    assert.equal(validateInfoPage({ title: "About", effectiveDate: "2027-13-01", sections: [{ heading: "H", blocks: [{ type: "paragraph", text: "T" }] }] }).ok, false);
  });
});

describe("Information Pages screen", () => {
  const page = read("src/pages/InfoPages.tsx");

  it("version and Last updated come from the server; no version or backdatable date is typed", () => {
    assert.doesNotMatch(page, /label="Version"/);
    assert.match(page, /label="Takes effect on \(optional\)"/);
    assert.match(page, /Version \{data\.nextVersion\}/);
    assert.match(page, /Last updated \{data\.published\.lastUpdatedLabel\}/);
    assert.match(page, /Saving a draft never changes the public date/);
  });

  it("shows who published, the draft's saver, unresolved items and the restore rule", () => {
    assert.match(page, /data\.published\.publishedBy/);
    assert.match(page, /data\.draft\.updatedBy/);
    assert.match(page, /<UnconfirmedPanel items=\{unconfirmed\} \/>/);
    assert.match(page, /re-published text of version/);
    assert.match(page, /keeps its own date in the history/);
  });

  it("warns that the outdated built-in wording is live until a legal page is published", () => {
    assert.match(page, /Customers currently see the OLD built-in privacy wording/);
    assert.match(page, /Only this page is published/);
  });
});

describe("Configuration", () => {
  const config = read("src/pages/Config.tsx");
  it("the business section has the proprietor, website and official social pages", () => {
    for (const key of ["BUSINESS_PROPRIETOR_NAME", "BUSINESS_WEBSITE", "SOCIAL_INSTAGRAM_URL", "SOCIAL_FACEBOOK_URL", "SOCIAL_X_URL", "SOCIAL_YOUTUBE_URL", "SOCIAL_LINKEDIN_URL"]) {
      assert.match(config, new RegExp(`"${key}",`));
    }
  });
});

describe("publishing checklist, acceptance and seller disclosure", () => {
  const page = read("src/pages/InfoPages.tsx");
  const checklist = read("src/lib/legalChecklist.ts");
  const disclosure = read("src/components/SellerDisclosurePanel.tsx");

  it("separates proprietor facts from technical facts, and never marks an unverified one as verified", () => {
    assert.match(page, /<PublishingChecklist settings=\{data\.settings\} \/>/);
    for (const label of ["Minimum customer age", "Jurisdiction", "Refund timelines", "Doorstep waiting time"]) assert.match(checklist, new RegExp(label));
    for (const open of ["Application server region", "Database backup retention", "Application log retention", "Payment and order record retention"]) {
      assert.match(checklist, new RegExp(`label: '${open}[^']*', status: 'open'`));
    }
  });

  it("the publish dialog lets the admin choose whether customers must accept the new version", () => {
    assert.match(page, /Ask signed-in customers to accept this version in the app\./);
    assert.match(page, /editor\.publish\.mutate\(slug === 'about' \? undefined : askAcceptance\)/);
  });

  it("the seller disclosure panel edits only the customer-care contact and shows what is missing", () => {
    assert.match(disclosure, /customerCarePhone: phone\.trim\(\) \|\| null, customerCareEmail: email\.trim\(\) \|\| null/);
    assert.match(disclosure, /data\.gaps\.map/);
    assert.match(read("src/pages/SellerDetail.tsx"), /path=\{`\/admin\/sellers\/\$\{seller\.id\}\/disclosure`\}/);
    assert.match(read("src/seller/pages/SellerProfile.tsx"), /path="\/seller\/disclosure"/);
  });
});

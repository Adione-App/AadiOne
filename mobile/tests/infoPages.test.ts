/**
 * Privacy Policy, Terms & Conditions and About Aadione in the app — run with
 * `npm run test:unit`. The display rules are pure (src/lib/infoPageFormat.ts
 * and the shared info-pages contract); the screens' wiring is checked on the
 * source, since they need a device. The server side:
 * backend tests/integration/info-pages.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { infoPageMeta, sectionBlocks } from "../src/lib/infoPageFormat.ts";
import { resolveInfoPage, validateInfoPage, type InfoPageContent } from "../src/shared/info-pages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("page display rules", () => {
  it("shows version, effective date and last-updated — only the parts the page has", () => {
    assert.equal(infoPageMeta({ version: "2.0", effectiveDate: "2026-11-03", updatedAt: "2026-11-04" }), "Version 2.0 · Effective 2026-11-03 · Last updated 2026-11-04");
    assert.equal(infoPageMeta({ version: null, effectiveDate: null, updatedAt: "2026-08-15" }), "Last updated 2026-08-15");
  });

  it("draws structured blocks, and an older server's plain lines as paragraphs", () => {
    const blocks = [{ type: "bullets" as const, items: ["One", "Two"] }];
    assert.deepEqual(sectionBlocks({ heading: "H", body: ["• One", "• Two"], blocks }), blocks);
    assert.deepEqual(sectionBlocks({ heading: "H", body: ["Line"], blocks: [] }), [{ type: "paragraph", text: "Line" }]);
  });
});

describe("the shared page contract (as the app receives it)", () => {
  const page: InfoPageContent = {
    title: "Privacy Policy",
    version: "2.0",
    effectiveDate: "2026-11-03",
    sections: [{ heading: "Contact", blocks: [{ type: "bullets", items: ["Email: {{SUPPORT_EMAIL}}", "WhatsApp: {{SUPPORT_WHATSAPP}}"] }] }],
  };

  it("a contact line whose setting is empty is left out — never an invented value", () => {
    const resolved = resolveInfoPage(page, { SUPPORT_EMAIL: "help@example.test", SUPPORT_WHATSAPP: "" });
    assert.deepEqual(resolved.sections[0]!.blocks, [{ type: "bullets", items: ["Email: help@example.test"] }]);
  });

  it("only known settings may be used; markup is just text", () => {
    assert.equal(validateInfoPage({ ...page, sections: [{ heading: "X", blocks: [{ type: "paragraph", text: "{{OWNER_PAN}}" }] }] }).ok, false);
    const html = validateInfoPage({ ...page, sections: [{ heading: "X", blocks: [{ type: "paragraph", text: "<b>hi</b>" }] }] });
    assert.ok(html.ok && html.content.sections[0]!.blocks[0]!.type === "paragraph");
  });
});

describe("screens", () => {
  const legal = read("src/screens/account/LegalScreen.tsx");
  const about = read("src/screens/account/AboutScreen.tsx");
  const account = read("src/screens/account/AccountScreen.tsx");
  const hook = read("src/lib/infoPages.ts");

  it("Privacy and Terms come from the server page, with the back button shown while loading or failed", () => {
    assert.match(legal, /const page = useInfoPage\(slug\);/);
    assert.match(legal, /<InfoPageSections page=\{page\.data\} \/>/);
    // The header is rendered before (outside) the loading / error branch.
    assert.ok(legal.indexOf('accessibilityLabel="Back"') < legal.indexOf("page.isLoading ?"));
  });

  it("About shows the published page, and its own introduction only until one is published", () => {
    assert.match(about, /const about = useInfoPage\('about'\);/);
    assert.match(about, /\) : published \? \(\n\s*<InfoPageSections page=\{published\} \/>/);
    assert.match(about, /About Aadione/);
    assert.doesNotMatch(about, /AdiOne/);
  });

  it("an unpublished page is not an error, and pages refresh within minutes", () => {
    assert.match(hook, /error\.code === ErrorCode\.NOT_FOUND\) return null;/);
    assert.match(hook, /staleTime: 5 \* 60_000/);
  });

  it("no contact detail is written into these screens", () => {
    for (const text of [legal, about, read("src/components/InfoPageView.tsx")]) {
      assert.doesNotMatch(text, /@adione\.in|support@|\+91\s?\d/);
    }
  });

  it("the Account menu lists all three pages for guests and customers alike (no login gate)", () => {
    assert.match(account, /\{ key: 'about', label: 'About Aadione'/);
    assert.match(account, /\{ key: 'privacy', label: 'Privacy Policy'/);
    assert.match(account, /\{ key: 'terms', label: 'Terms & Conditions'/);
    const stacks = read("src/navigation/stacks.tsx");
    assert.match(stacks, /if \(key === "about"\) \{\n\s*navigation\.navigate\("About"\);/);
    assert.match(stacks, /if \(key === "privacy"\) \{\n\s*navigation\.navigate\("Legal", \{/);
  });
});

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

import { infoPageEffectiveNotice, infoPageMeta, sectionBlocks, supportContactRows } from "../src/lib/infoPageFormat.ts";
import { infoTextSegments, resolveInfoPage, validateInfoPage, type BusinessInfoDto, type InfoPageContent } from "../src/shared/info-pages.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("page display rules", () => {
  it("shows the server's Last updated date and version — the same text as the website", () => {
    assert.equal(infoPageMeta({ version: "3", updatedAt: "2026-11-07", lastUpdatedLabel: "7 November 2026" }), "Last updated 7 November 2026 · Version 3");
    // Built-in wording has no version; an older server sends no label.
    assert.equal(infoPageMeta({ version: null, updatedAt: "2026-08-15" }), "Last updated 15 August 2026");
  });

  it("a takes-effect notice only for wording published ahead of its date", () => {
    assert.equal(infoPageEffectiveNotice({ effectiveLabel: "1 January 2027" }), "This version takes effect on 1 January 2027.");
    assert.equal(infoPageEffectiveNotice({ effectiveLabel: null }), null);
  });

  it("draws structured blocks, and an older server's plain lines as paragraphs", () => {
    const blocks = [{ type: "bullets" as const, items: ["One", "Two"] }];
    assert.deepEqual(sectionBlocks({ body: ["• One", "• Two"], blocks }), blocks);
    assert.deepEqual(sectionBlocks({ body: ["Line"], blocks: [] }), [{ type: "paragraph", text: "Line" }]);
  });

  it("prefers the formatted blocks (sub-headings, numbered lists, bold, links) when the server sends them", () => {
    const rich = [
      { type: "subheading" as const, level: 2 as const, text: "Steps" },
      { type: "numbered" as const, items: ["Write to us"], itemRuns: [[{ text: "Write", bold: true as const }, { text: " to us" }]] },
    ];
    const blocks = [{ type: "paragraph" as const, text: "Steps" }, { type: "paragraph" as const, text: "1. Write to us" }];
    assert.deepEqual(sectionBlocks({ body: ["Steps", "1. Write to us"], blocks, rich }), rich);
    assert.deepEqual(sectionBlocks({ body: [], blocks }), blocks);
    const view = read("src/components/InfoPageView.tsx");
    assert.match(view, /infoRichSegments\(text, runs\)/);
    assert.match(view, /block\.type === 'numbered' \?/);
  });

  it("contact rows exist only for configured values, each with the right link", () => {
    const info: BusinessInfoDto = {
      tradeName: "Aadione",
      legalName: null,
      proprietorName: null,
      businessType: null,
      address: null,
      gstin: null,
      website: "https://adione.example/",
      support: { email: "help@example.test", phone: null, whatsapp: "97760 29985", hours: null },
      grievanceOfficer: { name: null, designation: null, email: null, phone: null, address: null },
      socials: [],
    };
    assert.deepEqual(
      supportContactRows(info).map((row) => [row.key, row.href]),
      [
        ["email", "mailto:help@example.test"],
        ["whatsapp", "https://wa.me/919776029985"],
        ["website", "https://adione.example/"],
      ],
    );
    assert.deepEqual(supportContactRows(null), []);
  });

  it("email, phone, WhatsApp and web addresses in the text become links — nothing else does", () => {
    assert.deepEqual(
      infoTextSegments("WhatsApp: +91 97760 29985").map((segment) => segment.href ?? null),
      [null, "https://wa.me/919776029985"],
    );
    assert.deepEqual(infoTextSegments("<a href=javascript:x>hi</a>"), [{ text: "<a href=javascript:x>hi</a>" }]);
  });
});

describe("the shared page contract (as the app receives it)", () => {
  const page: InfoPageContent = {
    title: "Privacy Policy",
    effectiveDate: "",
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
  const view = read("src/components/InfoPageView.tsx");

  it("Privacy and Terms come from the server page, with the back button shown while loading or failed", () => {
    assert.match(legal, /const page = useInfoPage\(slug\);/);
    assert.match(legal, /<InfoPageHeading title=\{title\} page=\{page\.data\} \/>/);
    assert.match(legal, /<InfoPageSections page=\{page\.data\} \/>/);
    assert.match(legal, /RefreshControl/);
    // The header is rendered before (outside) the loading / error branch.
    assert.ok(legal.indexOf('accessibilityLabel="Back"') < legal.indexOf("page.isLoading ?"));
  });

  it("About shows the published page, and a short claim-free introduction only until one is published", () => {
    assert.match(about, /const about = useInfoPage\('about'\);/);
    assert.match(about, /<InfoPageSections page=\{published\} \/>/);
    assert.match(about, /About Aadione/);
    assert.doesNotMatch(about, /AdiOne/);
    assert.doesNotMatch(about, /DELIVERY_PROMISE_TEXT|Best Prices|always here|Fast Delivery/);
  });

  it("an unpublished page is not an error, and pages refresh within about a minute", () => {
    assert.match(hook, /error\.code === ErrorCode\.NOT_FOUND\) return null;/);
    assert.match(hook, /const FRESH_FOR_MS = 60_000;/);
  });

  it("links open through the shared link rules only", () => {
    assert.match(view, /infoTextSegments\(text\)/);
    assert.match(view, /accessibilityRole="header"/);
  });

  it("no contact detail is written into these screens", () => {
    for (const text of [legal, about, view]) {
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

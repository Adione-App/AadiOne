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

describe("Legal & Policies editor screen", () => {
  const page = read("src/pages/InfoPages.tsx");
  const editor = read("src/components/PolicyDocumentEditor.tsx");
  const has = (source: string, text: string) => assert.ok(source.includes(text), text);

  it("is one document editor with the compact toolbar — no per-block textareas or reorder buttons", () => {
    has(page, "<PolicyDocumentEditor ref={documentRef}");
    assert.doesNotMatch(page, /<textarea/);
    assert.doesNotMatch(page, /\+ Paragraph|\+ Bullet list|\+ Add section|Move section/);
    for (const label of ["Normal text", "Heading 1 (section)", "Heading 2", "Heading 3", 'label="Bold"', 'label="Italic"', 'label="Underline"', 'label="Bullet list"', 'label="Numbered list"', "Add link", 'label="Undo"', 'label="Redo"']) {
      has(editor, label);
    }
  });

  it("the editor schema holds only what a policy stores, and is loaded only when a policy is opened", () => {
    has(editor, "Heading.extend({ content: 'text*', marks: '' }).configure({ levels: [1, 2, 3] })");
    has(editor, "ListItem.extend({ content: 'paragraph' })");
    for (const off of ["blockquote: false", "code: false", "codeBlock: false", "horizontalRule: false", "strike: false"]) has(editor, off);
    has(editor, "isAllowedUri: (url: string) => infoLinkHref(url) !== null");
    has(page, "lazy(() => import('@/components/PolicyDocumentEditor'))");
  });

  it("keeps Save draft, Preview and Publish at the top; publishing still confirms and shows what blocks it", () => {
    for (const label of ["Save draft", "Preview", "Publish now", "Before publishing:", "Not yet:"]) has(page, label);
    has(page, "disabled={!data.draft || dirty || busy}");
    has(page, "disabled={blockers.length > 0}");
    has(page, "const accepts = asksForAcceptance(slug);");
    has(page, "editor.publish.mutate(accepts ? askAcceptance : undefined");
    has(page, "Ask signed-in {readers} to accept this version.");
  });

  it("checks the page as the server does before saving or previewing, and says what to fix in plain words", () => {
    has(page, "const check = currentCheck();");
    has(page, "Fix {problems.length === 1 ? 'this' : 'these'} first:");
  });

  it("folds the effective date, business details, version history and discard into Advanced settings", () => {
    has(page, "Advanced settings");
    has(page, 'label="Takes effect on (optional)"');
    has(page, "documentRef.current?.insertText(`{{${token}}}`)");
    has(page, "Version history{versions > 0");
    has(page, "Discard draft");
  });

  it("version and Last updated still come from the server; the history shows who published and restored text", () => {
    assert.doesNotMatch(page, /label="Version"/);
    has(page, "Becomes version ${data.nextVersion}, last updated today");
    has(page, "last updated {data.published.lastUpdatedLabel}");
    has(page, "item.publishedBy");
    has(page, "data.draft.updatedBy");
    has(page, "text of version ${item.restoredFromVersion}");
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

// The publishing checklist (lib/legalChecklist.ts) was removed with the
// simplified Legal & Policies screen (2e960b4); acceptance is covered above.
describe("seller disclosure", () => {
  const disclosure = read("src/components/SellerDisclosurePanel.tsx");

  it("the seller disclosure panel edits only the customer-care contact and shows what is missing", () => {
    assert.match(disclosure, /customerCarePhone: phone\.trim\(\) \|\| null, customerCareEmail: email\.trim\(\) \|\| null/);
    assert.match(disclosure, /data\.gaps\.map/);
    assert.match(read("src/pages/SellerDetail.tsx"), /path=\{`\/admin\/sellers\/\$\{seller\.id\}\/disclosure`\}/);
    assert.match(read("src/seller/pages/SellerProfile.tsx"), /path="\/seller\/disclosure"/);
  });
});

describe("unsaved changes are protected everywhere a policy editor can be left", () => {
  const guard = read("src/lib/unsavedChanges.ts");
  const page = read("src/pages/InfoPages.tsx");
  const has = (source: string, text: string) => assert.ok(source.includes(text), text);

  it("reload / tab close, panel links, browser Back and Forward", () => {
    has(guard, "window.addEventListener('beforeunload', warn)");
    has(guard, "document.addEventListener('click', guardLinks, true)");
    has(guard, "window.addEventListener('popstate', onPop)");
    has(guard, "window.history.pushState({ ...((window.history.state as object | null) ?? {}), [GUARD_KEY]: lastPosition }, '', window.location.href)");
    has(guard, "if (position.current >= from) return;");
    has(page, "useUnsavedChangesGuard({ dirty, isDirty: () => dirtyRef.current, message: LEAVE_PROMPT })");
    has(page, "if (changedNow) armLeaveGuard();");
    has(page, "onKeyDownCapture={onEditorInput}");
    has(page, "if (!confirmLeave()) return;");
  });

  it("Sign out, notifications and new-order alerts ask before leaving", () => {
    has(read("src/App.tsx"), "if (!confirmLeave()) return;\n                    disconnectSocket();");
    has(read("src/components/NotificationBell.tsx"), "if (destination && confirmLeave()) {");
    const alerts = read("src/components/OrderAlerts.tsx");
    has(alerts, "if (confirmLeave()) navigate(to);");
    assert.doesNotMatch(alerts, /onClick=\{\(\) => navigate\(/);
  });
});

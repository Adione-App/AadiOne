/**
 * The Legal & Policies document editor's model (src/lib/policyDocument.ts):
 * stored page ⇄ editor document — run with `npm run test:unit`.
 *
 *   - every existing policy (all Aadione templates and the built-in wording)
 *     opens in the editor and saves back EXACTLY as it was;
 *   - formatting (headings, lists, bold / italic / underline, links, line
 *     breaks) survives save and reload;
 *   - what a pasted document brings that a policy cannot hold (nested lists,
 *     several paragraphs in a point) is folded in, never dropped;
 *   - problems are said in plain words, named by their Heading 1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateInfoPage, type InfoPageContent } from "../src/shared/info-pages.ts";
import { BLANK_DOC, checkPolicy, contentToDoc, docToContent, samePage, type DocNode } from "../src/lib/policyDocument.ts";
import { INFO_PAGE_TEMPLATES } from "../../backend/src/modules/legal/info-page-templates.ts";
import { BUILTIN_INFO_PAGES } from "../../backend/src/modules/legal/legal.content.ts";

const META = { title: "Privacy Policy", effectiveDate: "" };
const metaOf = ({ sections: _s, ...meta }: InfoPageContent) => meta;

/** Open in the editor, then save: the page the server would store. */
function roundTrip(content: InfoPageContent): InfoPageContent {
  const check = checkPolicy(contentToDoc(content), metaOf(content));
  assert.ok(check.ok, check.ok ? "" : check.problems.join("\n"));
  return check.content;
}

const text = (value: string, marks?: string[], href?: string): DocNode => ({
  type: "text",
  text: value,
  ...(marks || href ? { marks: [...(marks ?? []).map((type) => ({ type })), ...(href ? [{ type: "link", attrs: { href } }] : [])] } : {}),
});
const h = (level: number, value: string): DocNode => ({ type: "heading", attrs: { level }, content: value ? [text(value)] : undefined });
const p = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const item = (...content: DocNode[]): DocNode => ({ type: "listItem", content });
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });

describe("existing policies load and save back unchanged", () => {
  const pages: [string, InfoPageContent][] = [
    ...Object.entries(INFO_PAGE_TEMPLATES).map(([slug, content]) => [`template ${slug}`, content] as [string, InfoPageContent]),
    ...Object.entries(BUILTIN_INFO_PAGES).map(([slug, page]) => [`built-in ${slug}`, page!.content] as [string, InfoPageContent]),
  ];
  for (const [name, content] of pages) {
    it(name, () => {
      const stored = validateInfoPage(content);
      assert.ok(stored.ok);
      assert.deepEqual(roundTrip(stored.content), stored.content);
    });
  }

  it("a paragraph typed with line breaks in the old editor keeps them", () => {
    const content = { ...META, sections: [{ heading: "Address", blocks: [{ type: "paragraph" as const, text: "Main Road\nKuraj" }] }] };
    const editor = contentToDoc(content);
    assert.deepEqual(editor.content![1], p(text("Main Road"), { type: "hardBreak" }, text("Kuraj")));
    assert.deepEqual(roundTrip(content), content);
  });
});

describe("formatting survives save and reload", () => {
  const editorDoc = doc(
    h(1, "Who we are"),
    p(text("We are "), text("Aadione", ["bold"]), text(", a "), text("local", ["italic", "underline"]), text(" marketplace. See "), text("our terms", [], "https://adione.in/terms")),
    h(2, "Contact"),
    { type: "orderedList", attrs: { start: 1 }, content: [item(p(text("Email "), text("{{SUPPORT_EMAIL}}", ["bold"]))), item(p(text("Call us")))] },
    h(3, "Hours"),
    { type: "bulletList", content: [item(p(text("9 am – 6 pm")))] },
    p(), // a blank line is not stored
  );

  it("is stored as headings, lists and formatted pieces", () => {
    const check = checkPolicy(editorDoc, META);
    assert.ok(check.ok);
    assert.deepEqual(check.content.sections, [
      {
        heading: "Who we are",
        blocks: [
          {
            type: "paragraph",
            text: "We are Aadione, a local marketplace. See our terms",
            runs: [
              { text: "We are " },
              { text: "Aadione", bold: true },
              { text: ", a " },
              { text: "local", italic: true, underline: true },
              { text: " marketplace. See " },
              { text: "our terms", href: "https://adione.in/terms" },
            ],
          },
          { type: "subheading", level: 2, text: "Contact" },
          { type: "numbered", items: ["Email {{SUPPORT_EMAIL}}", "Call us"], itemRuns: [[{ text: "Email " }, { text: "{{SUPPORT_EMAIL}}", bold: true }], [{ text: "Call us" }]] },
          { type: "subheading", level: 3, text: "Hours" },
          { type: "bullets", items: ["9 am – 6 pm"] },
        ],
      },
    ]);
  });

  it("reloads into the same editor document and saves the same page again", () => {
    const first = checkPolicy(editorDoc, META);
    assert.ok(first.ok);
    const reopened = contentToDoc(first.content);
    const second = checkPolicy(reopened, META);
    assert.ok(second.ok);
    assert.deepEqual(second.content, first.content);
    assert.ok(samePage(first.content, second.content));
    // The reloaded document has the editor's own shapes: Heading 1, marks, numbered list.
    assert.deepEqual(reopened.content![0], h(1, "Who we are"));
    assert.equal(reopened.content![3]!.type, "orderedList");
    assert.deepEqual(reopened.content![1]!.content![1], text("Aadione", ["bold"]));
  });
});

describe("what a paste can bring", () => {
  it("nested lists become points of the outer list; several paragraphs in a point join with a line break", () => {
    const pasted = doc(
      h(1, "Rights"),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(text("Access")), { type: "bulletList", content: [item(p(text("a copy")))] }] },
          item(p(text("Correction")), p(text("within 30 days"))),
        ],
      },
    );
    const check = checkPolicy(pasted, META);
    assert.ok(check.ok);
    assert.deepEqual(check.content.sections[0]!.blocks, [{ type: "bullets", items: ["Access", "a copy", "Correction\nwithin 30 days"] }]);
  });
});

describe("problems, in plain words", () => {
  const problems = (editorDoc: DocNode, meta = META) => {
    const check = checkPolicy(editorDoc, meta);
    assert.equal(check.ok, false);
    return check.ok ? [] : check.problems;
  };

  it("text above the first Heading 1 is kept and explained, never dropped", () => {
    const editorDoc = doc(p(text("This policy explains…")), h(1, "Who we are"), p(text("Aadione.")));
    assert.equal(docToContent(editorDoc, META).sections[0]!.blocks.length, 1);
    assert.match(problems(editorDoc)[0]!, /needs a Heading 1 above it/);
  });

  it("a heading with nothing under it, an empty title, an unknown placeholder and a long list", () => {
    assert.match(problems(doc(h(1, "Who we are"), h(1, "Contact"), p(text("x"))))[0]!, /“Who we are” has no text under it/);
    assert.match(problems(doc(h(1, "A"), p(text("x"))), { ...META, title: " " })[0]!, /Give the policy a title/);
    assert.match(problems(doc(h(1, "Contact"), p(text("Call {{CEO_PHONE}}"))))[0]!, /\{\{CEO_PHONE\}\} under “Contact” is not a business detail/);
    const long = { type: "bulletList", content: Array.from({ length: 41 }, (_, i) => item(p(text(`point ${i}`)))) };
    assert.match(problems(doc(h(1, "Data"), long))[0]!, /A list under “Data” is too long \(at most 40 points\)/);
  });

  it("a blank page is just empty, and an empty Heading 1 left at the end is ignored", () => {
    assert.match(problems(BLANK_DOC)[0]!, /The policy is empty/);
    const check = checkPolicy(doc(h(1, "A"), p(text("x")), h(1, "")), META);
    assert.ok(check.ok);
  });
});

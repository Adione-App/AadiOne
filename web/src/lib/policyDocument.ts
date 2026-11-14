/**
 * The Legal & Policies document editor's model — between the stored page
 * (@shared InfoPageContent: sections → paragraphs, lists, sub-headings, with
 * formatted pieces of text) and the editor's document (Tiptap / ProseMirror
 * JSON). Pure, no React or editor code, so `npm run test:unit` covers it
 * (tests/policyDocument.test.ts).
 *
 * The editor's schema allows exactly what a page can store, so what the admin
 * sees is what is saved and read back:
 *
 *   editor                     stored
 *   Heading 1                  a section's heading (its anchor, its place in "Contents")
 *   Heading 2 / Heading 3      a `subheading` block (level 2 / 3)
 *   Paragraph                  a `paragraph` block (Shift+Enter line breaks are "\n")
 *   Bullet / numbered list     a `bullets` / `numbered` block, one point per item
 *   Bold, italic, underline,   formatted pieces (`runs` / `itemRuns`), links checked
 *   link                       by the shared infoLinkHref
 *
 * Empty paragraphs (blank lines) are not stored: published pages space their
 * blocks themselves.
 */

import {
  INFO_PAGE_LIMITS,
  validateInfoPage,
  type InfoPageBlock,
  type InfoPageContent,
  type InfoPageProblem,
  type InfoPageSection,
  type InfoTextRun,
} from '@shared';

/** The editor document's JSON (a structural subset of Tiptap's JSONContent). */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** What the page has besides its sections (kept as it was; the editor does not change it). */
export type PolicyMeta = Omit<InfoPageContent, 'sections'>;

/** A new, empty policy: one Heading 1 and a paragraph to type into. */
export const BLANK_DOC: DocNode = {
  type: 'doc',
  content: [{ type: 'heading', attrs: { level: 1 } }, { type: 'paragraph' }],
};

/* -------------------------------------------------------------------------- */
/* Stored page → editor                                                        */
/* -------------------------------------------------------------------------- */

function marksOf(run: InfoTextRun): DocNode['marks'] {
  const marks: NonNullable<DocNode['marks']> = [];
  if (run.bold) marks.push({ type: 'bold' });
  if (run.italic) marks.push({ type: 'italic' });
  if (run.underline) marks.push({ type: 'underline' });
  if (run.href) marks.push({ type: 'link', attrs: { href: run.href } });
  return marks.length > 0 ? marks : undefined;
}

/** Text (and its formatting) as inline nodes; "\n" becomes a line break. */
function inlineNodes(text: string, runs?: readonly InfoTextRun[]): DocNode[] {
  const nodes: DocNode[] = [];
  for (const run of runs && runs.length > 0 ? runs : [{ text }]) {
    const marks = marksOf(run);
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) nodes.push({ type: 'hardBreak' });
      if (part) nodes.push({ type: 'text', text: part, ...(marks ? { marks } : {}) });
    });
  }
  return nodes;
}

const withContent = (node: DocNode, content: DocNode[]): DocNode => (content.length > 0 ? { ...node, content } : node);

function blockToNodes(block: InfoPageBlock): DocNode {
  switch (block.type) {
    case 'paragraph':
      return withContent({ type: 'paragraph' }, inlineNodes(block.text, block.runs));
    case 'subheading':
      return withContent({ type: 'heading', attrs: { level: block.level } }, block.text ? [{ type: 'text', text: block.text }] : []);
    case 'bullets':
    case 'numbered':
      return {
        type: block.type === 'numbered' ? 'orderedList' : 'bulletList',
        ...(block.type === 'numbered' ? { attrs: { start: 1 } } : {}),
        content: block.items.map((item, i) => ({
          type: 'listItem',
          content: [withContent({ type: 'paragraph' }, inlineNodes(item, block.itemRuns?.[i]))],
        })),
      };
  }
}

/** A stored page's sections as the editor's document. */
export function contentToDoc(content: Pick<InfoPageContent, 'sections'>): DocNode {
  const nodes = content.sections.flatMap((section) => [
    withContent({ type: 'heading', attrs: { level: 1 } }, section.heading ? [{ type: 'text', text: section.heading }] : []),
    ...section.blocks.map(blockToNodes),
  ]);
  return nodes.length > 0 ? { type: 'doc', content: nodes } : BLANK_DOC;
}

/* -------------------------------------------------------------------------- */
/* Editor → stored page                                                        */
/* -------------------------------------------------------------------------- */

/** The plain text of a node (headings: formatting ignored, line breaks as spaces). */
function plainText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(plainText).join('');
}

function runOf(node: DocNode): InfoTextRun {
  const run: InfoTextRun = { text: node.text ?? '' };
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') run.bold = true;
    else if (mark.type === 'italic') run.italic = true;
    else if (mark.type === 'underline') run.underline = true;
    else if (mark.type === 'link' && typeof mark.attrs?.['href'] === 'string') run.href = mark.attrs['href'];
  }
  return run;
}

/** A paragraph's inline content as formatted pieces ("\n" for a line break). */
function runsOf(node: DocNode): InfoTextRun[] {
  const runs: InfoTextRun[] = [];
  const visit = (child: DocNode) => {
    if (child.type === 'text') runs.push(runOf(child));
    else if (child.type === 'hardBreak') runs.push({ text: '\n' });
    else (child.content ?? []).forEach(visit);
  };
  (node.content ?? []).forEach(visit);
  return runs;
}

const joined = (runs: readonly InfoTextRun[]) => runs.map((run) => run.text).join('');

/** One list point: its paragraphs (a pasted item may hold several) joined by line breaks. */
function itemRuns(item: DocNode): InfoTextRun[] {
  const paragraphs = (item.content ?? []).filter((child) => child.type !== 'bulletList' && child.type !== 'orderedList');
  return paragraphs.flatMap((paragraph, i) => [...(i > 0 ? [{ text: '\n' }] : []), ...runsOf(paragraph)]);
}

/** Nested lists (pasted from elsewhere — the editor itself cannot make them) become points of the outer list. */
function flatItems(list: DocNode): DocNode[] {
  return (list.content ?? []).flatMap((item) => [
    item,
    ...(item.content ?? []).filter((child) => child.type === 'bulletList' || child.type === 'orderedList').flatMap(flatItems),
  ]);
}

function nodeToBlock(node: DocNode): InfoPageBlock | null {
  if (node.type === 'heading') {
    const text = plainText(node).trim();
    const level = node.attrs?.['level'] === 3 ? 3 : 2;
    return text ? { type: 'subheading', level, text } : null;
  }
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const points = flatItems(node).map(itemRuns).filter((runs) => joined(runs).trim().length > 0);
    if (points.length === 0) return null;
    return { type: node.type === 'orderedList' ? 'numbered' : 'bullets', items: points.map(joined), itemRuns: points };
  }
  // A paragraph — or anything else holding text.
  const runs = runsOf(node);
  const text = joined(runs);
  return text.trim() ? { type: 'paragraph', text, runs } : null;
}

/**
 * The editor's document as a page: every Heading 1 starts a section. Text
 * above the first Heading 1 is kept in a section without a heading, which
 * saving refuses with a plain explanation (policyProblems) — nothing typed
 * is ever dropped silently. The result is not yet checked: validateInfoPage
 * tidies it (formatting, trimming) exactly as the server will.
 */
export function docToContent(doc: DocNode, meta: PolicyMeta): InfoPageContent {
  const sections: InfoPageSection[] = [];
  let current: InfoPageSection | null = null;
  for (const node of doc.content ?? []) {
    if (node.type === 'heading' && node.attrs?.['level'] === 1) {
      current = { heading: plainText(node).trim(), blocks: [] };
      sections.push(current);
      continue;
    }
    const block = nodeToBlock(node);
    if (!block) continue;
    if (!current) {
      current = { heading: '', blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  // A trailing empty Heading 1 with nothing under it is just where the cursor was.
  const last = sections[sections.length - 1];
  if (last && !last.heading && last.blocks.length === 0) sections.pop();
  return { ...meta, sections };
}

/* -------------------------------------------------------------------------- */
/* Checking, in plain words                                                    */
/* -------------------------------------------------------------------------- */

export type PolicyCheck = { ok: true; content: InfoPageContent } | { ok: false; problems: string[] };

/** The section a problem's field points at ("sections.3.blocks.2…" → 3). */
const sectionIndex = (field: string): number | null => {
  const match = /^sections\.(\d+)/.exec(field);
  return match ? Number(match[1]) : null;
};

/** One shared-validator problem, said the way an admin reads the document. */
function describe(problem: InfoPageProblem, sections: readonly InfoPageSection[]): string {
  const { field, message } = problem;
  if (field === 'title') return message === 'is required' ? 'Give the policy a title.' : `Title: ${message}.`;
  if (field === 'sections') {
    return message.startsWith('add') ? 'The policy is empty. Add a Heading 1 and some text under it.' : `The policy has too many Heading 1 parts (${message}).`;
  }
  if (field === 'content') return `The policy is too long — ${message}.`;
  if (field === 'effectiveDate') return 'The "takes effect" date in Advanced settings is not a valid date.';
  const s = sectionIndex(field);
  const heading = s !== null ? sections[s]?.heading : undefined;
  const where = heading ? `under “${heading}”` : s === 0 ? 'at the top of the policy' : `in part ${s === null ? '?' : s + 1}`;

  if (/^sections\.\d+\.heading$/.test(field)) {
    if (message === 'is required') {
      return s === 0 ? 'The text at the top of the policy needs a Heading 1 above it (choose “Heading 1” in the style menu).' : `A Heading 1 is empty (after “${sections[(s ?? 1) - 1]?.heading ?? ''}”). Type its name or delete it.`;
    }
    return `The Heading 1 “${heading ?? ''}” ${message}.`;
  }
  if (/^sections\.\d+$/.test(field)) return `“${heading || 'A Heading 1'}” has no text under it. Add a paragraph or list, or delete the heading.`;
  if (/^sections\.\d+\.blocks$/.test(field)) return `The part ${where} is too long (at most ${INFO_PAGE_LIMITS.blocksPerSection} paragraphs, lists and sub-headings). Split it with another Heading 1.`;
  if (/\.items$/.test(field) || /\.itemRuns$/.test(field)) return `A list ${where} is too long (at most ${INFO_PAGE_LIMITS.bulletItems} points). Split it into two lists.`;
  if (/\.href$/.test(field)) return `A link ${where} is not a web address, email address or phone number. Select it and use the link button to correct it.`;
  if (message.startsWith('must be at most')) return `A paragraph or point ${where} is too long (${message.replace('must be ', '')}). Split it into shorter ones.`;
  if (message.includes('is not a known setting')) return `${message.replace(' is not a known setting', '')} ${where} is not a business detail the policy can use. Insert placeholders from Advanced settings.`;
  if (message.includes('not allowed')) return `Text ${where} contains hidden characters that are not allowed. Retype that line.`;
  return `Something ${where} ${message}.`;
}

/**
 * The editor's document checked as the server will check it: the tidied page,
 * or the problems in plain words (each named by the Heading 1 it is under,
 * duplicates removed).
 */
export function checkPolicy(doc: DocNode, meta: PolicyMeta): PolicyCheck {
  const content = docToContent(doc, meta);
  const checked = validateInfoPage(content);
  if (checked.ok) return { ok: true, content: checked.content };
  return { ok: false, problems: [...new Set(checked.problems.map((problem) => describe(problem, content.sections)))] };
}

/** Whether two pages are the same once tidied (e.g. the saved draft and the editor). */
export function samePage(a: InfoPageContent | null, b: InfoPageContent | null): boolean {
  if (!a || !b) return a === b;
  const tidy = (content: InfoPageContent) => {
    const checked = validateInfoPage(content);
    return JSON.stringify(checked.ok ? checked.content : content);
  };
  return tidy(a) === tidy(b);
}

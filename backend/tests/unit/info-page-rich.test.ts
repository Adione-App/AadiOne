/**
 * Formatted policy text (shared/info-pages.ts) — what the Legal & Policies
 * document editor stores: sub-headings, numbered lists, bold / italic /
 * underline and links, as text pieces beside the plain wording.
 *
 *   - every page saved before formatting existed is valid and unchanged;
 *   - formatting is tidied (merged, trimmed), a token stays in one piece,
 *     unknown fields are dropped and only safe links are accepted;
 *   - tokens are filled inside formatted pieces, and a line with an empty
 *     setting is still left out;
 *   - older readers get plain blocks that lose no words or addresses.
 */

import { describe, expect, it } from 'vitest';
import {
  infoLinkHref,
  infoPageBodyLines,
  infoPagePlainBlocks,
  infoPageUnconfirmed,
  infoPlainText,
  infoRichSegments,
  resolveInfoPage,
  validateInfoPage,
  type InfoPageContent,
} from '../../src/shared';
import { INFO_PAGE_TEMPLATES } from '../../src/modules/legal/info-page-templates';
import { BUILTIN_INFO_PAGES } from '../../src/modules/legal/legal.content';

const page = (blocks: unknown[], heading = 'Contact'): unknown => ({ title: 'Privacy Policy', effectiveDate: '', sections: [{ heading, blocks }] });

function valid(input: unknown): InfoPageContent {
  const checked = validateInfoPage(input);
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  return checked.content;
}

describe('pages saved before formatting existed', () => {
  it('every template and built-in page validates to exactly itself (nothing to migrate)', () => {
    for (const content of [...Object.values(INFO_PAGE_TEMPLATES), ...Object.values(BUILTIN_INFO_PAGES).map((b) => b!.content)]) {
      const checked = valid(content);
      expect(checked).toEqual(content);
      // No formatting fields appear on plain text.
      expect(JSON.stringify(checked)).not.toMatch(/"runs"|"itemRuns"/);
      // Older readers get the very same blocks as before.
      for (const section of checked.sections) expect(infoPagePlainBlocks(section.blocks)).toEqual(section.blocks);
    }
  });
});

describe('formatted text', () => {
  it('keeps bold, italic, underline and links; derives the plain text from the pieces; merges and trims', () => {
    const content = valid(
      page([
        {
          type: 'paragraph',
          text: 'ignored — the pieces are the source',
          runs: [
            { text: '  Read ' },
            { text: 'our', bold: true },
            { text: ' terms', bold: true },
            { text: ' at ', italic: false, colour: 'red' },
            { text: 'this page', href: 'adione.in/terms', underline: true },
            { text: '.  ' },
          ],
        },
      ]),
    );
    expect(content.sections[0]!.blocks[0]).toEqual({
      type: 'paragraph',
      text: 'Read our terms at this page.',
      runs: [
        { text: 'Read ' },
        { text: 'our terms', bold: true },
        { text: ' at ' },
        { text: 'this page', underline: true, href: 'https://adione.in/terms' },
        { text: '.' },
      ],
    });
  });

  it('pieces with no formatting at all store as plain text', () => {
    const content = valid(page([{ type: 'paragraph', text: '', runs: [{ text: 'Plain ' }, { text: 'words', bold: false }] }]));
    expect(content.sections[0]!.blocks[0]).toEqual({ type: 'paragraph', text: 'Plain words' });
  });

  it('a {{TOKEN}} split across formatting takes the formatting of its first character', () => {
    const content = valid(page([{ type: 'paragraph', text: '', runs: [{ text: 'Write to {{SUPPORT_', bold: true }, { text: 'EMAIL}} today' }] }]));
    expect(content.sections[0]!.blocks[0]).toMatchObject({ runs: [{ text: 'Write to {{SUPPORT_EMAIL}}', bold: true }, { text: ' today' }] });
  });

  it('numbered lists and sub-headings are kept; list points have one formatting entry each', () => {
    const content = valid(
      page([
        { type: 'subheading', level: 2, text: 'How to complain' },
        { type: 'numbered', items: ['Write to us', 'Wait'], itemRuns: [[{ text: 'Write', bold: true }, { text: ' to us' }], null] },
        { type: 'subheading', level: 3, text: 'Timelines' },
        { type: 'bullets', items: ['48 hours'] },
      ]),
    );
    expect(content.sections[0]!.blocks).toEqual([
      { type: 'subheading', level: 2, text: 'How to complain' },
      { type: 'numbered', items: ['Write to us', 'Wait'], itemRuns: [[{ text: 'Write', bold: true }, { text: ' to us' }], [{ text: 'Wait' }]] },
      { type: 'subheading', level: 3, text: 'Timelines' },
      { type: 'bullets', items: ['48 hours'] },
    ]);
  });

  it('refuses unsafe links, wrong sub-heading levels, mismatched point lists and sections of sub-headings only', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'ftp://adione.in', 'https://{{BUSINESS_WEBSITE}}', 'not a link', '']) {
      const checked = validateInfoPage(page([{ type: 'paragraph', text: '', runs: [{ text: 'x', href }] }]));
      expect(checked.ok, href).toBe(false);
    }
    expect(validateInfoPage(page([{ type: 'subheading', level: 1, text: 'X' }, { type: 'paragraph', text: 'y' }])).ok).toBe(false);
    expect(validateInfoPage(page([{ type: 'numbered', items: ['a', 'b'], itemRuns: [[{ text: 'a' }]] }])).ok).toBe(false);
    const onlySub = validateInfoPage(page([{ type: 'subheading', level: 2, text: 'Alone' }]));
    expect(onlySub.ok).toBe(false);
    expect(onlySub.ok ? [] : onlySub.problems.map((p) => p.field)).toContain('sections.0');
    expect(validateInfoPage(page([{ type: 'quote', text: 'x' }])).ok).toBe(false);
  });

  it('HTML typed or pasted is text, never markup', () => {
    const content = valid(page([{ type: 'paragraph', text: '', runs: [{ text: '<script>alert(1)</script>', bold: true }] }]));
    expect(content.sections[0]!.blocks[0]).toMatchObject({ text: '<script>alert(1)</script>' });
  });

  it('links: web, email and phone only, normalised', () => {
    expect(infoLinkHref('adione.in')).toBe('https://adione.in/');
    expect(infoLinkHref('http://adione.in/x')).toBe('http://adione.in/x');
    expect(infoLinkHref('support@adione.in')).toBe('mailto:support@adione.in');
    expect(infoLinkHref('mailto:support@adione.in')).toBe('mailto:support@adione.in');
    // Phone numbers as people write them.
    expect(infoLinkHref('+91 90000 00001')).toBe('tel:+919000000001');
    expect(infoLinkHref('tel:+91-90000-00001')).toBe('tel:+919000000001');
    expect(infoLinkHref('tel:call me')).toBeNull();
    expect(infoLinkHref('adione .in')).toBeNull();
    expect(infoLinkHref('JavaScript:alert(1)')).toBeNull();
  });
});

describe('reading formatted text', () => {
  const content = valid(
    page([
      { type: 'paragraph', text: '', runs: [{ text: 'Email ' }, { text: '{{SUPPORT_EMAIL}}', bold: true }, { text: ' or visit ' }, { text: 'our site', href: 'https://adione.in/' }] },
      { type: 'numbered', items: ['a', 'b'], itemRuns: [[{ text: 'WhatsApp {{SUPPORT_WHATSAPP}}', italic: true }], [{ text: 'Officer «TO CONFIRM: name»', underline: true }]] },
      { type: 'subheading', level: 2, text: 'Hours: {{SUPPORT_HOURS}}' },
    ]),
  );

  it('fills tokens inside formatted pieces; a line with an empty setting is still left out', () => {
    const resolved = resolveInfoPage(content, { SUPPORT_EMAIL: 'help@adione.in' });
    const [paragraph, list, sub] = resolved.sections[0]!.blocks;
    expect(paragraph).toMatchObject({ text: 'Email help@adione.in or visit our site', runs: [{ text: 'Email ' }, { text: 'help@adione.in', bold: true }, { text: ' or visit ' }, { text: 'our site', href: 'https://adione.in/' }] });
    // No WhatsApp: that point (and its formatting entry) is gone.
    expect(list).toEqual({ type: 'numbered', items: ['Officer «TO CONFIRM: name»'], itemRuns: [[{ text: 'Officer «TO CONFIRM: name»', underline: true }]] });
    expect(sub).toEqual({ type: 'subheading', level: 2, text: 'Hours:' });
    expect(resolved.missing).toEqual(expect.arrayContaining(['SUPPORT_WHATSAPP', 'SUPPORT_HOURS']));
  });

  it('«TO CONFIRM» notes are found in numbered lists and sub-headings too', () => {
    const notes = valid(page([{ type: 'subheading', level: 3, text: '«TO CONFIRM: title»' }, { type: 'numbered', items: ['ok', '«TO CONFIRM: x»'] }]));
    expect(infoPageUnconfirmed(notes).map((item) => item.text)).toEqual(['«TO CONFIRM: title»', '«TO CONFIRM: x»']);
  });

  it('older readers get plain blocks: links keep their address, numbers are written, sub-headings are paragraphs', () => {
    const resolved = resolveInfoPage(content, { SUPPORT_EMAIL: 'help@adione.in', SUPPORT_WHATSAPP: '+91 98765 43210', SUPPORT_HOURS: '9–6' });
    expect(infoPagePlainBlocks(resolved.sections[0]!.blocks)).toEqual([
      { type: 'paragraph', text: 'Email help@adione.in or visit our site (https://adione.in/)' },
      { type: 'paragraph', text: '1. WhatsApp +91 98765 43210' },
      { type: 'paragraph', text: '2. Officer «TO CONFIRM: name»' },
      { type: 'paragraph', text: 'Hours: 9–6' },
    ]);
    expect(infoPageBodyLines(resolved.sections[0]!)[1]).toBe('1. WhatsApp +91 98765 43210');
    // A link whose words already show its address is not repeated.
    expect(infoPlainText('see adione.in', [{ text: 'see ' }, { text: 'adione.in', href: 'https://adione.in/' }])).toBe('see adione.in');
    expect(infoPlainText('mail us', [{ text: 'mail us', href: 'mailto:help@adione.in' }])).toBe('mail us (help@adione.in)');
  });

  it('readers draw formatting and links; addresses in unlinked text still become links; an unsafe stored link never does', () => {
    expect(infoRichSegments('x', [{ text: 'Call ', bold: true }, { text: '+91 98765 43210', bold: true }])).toEqual([
      { text: 'Call ', bold: true },
      { text: '+91 98765 43210', href: 'tel:+919876543210', bold: true },
    ]);
    expect(infoRichSegments('x', [{ text: 'click', href: 'javascript:alert(1)' }])).toEqual([{ text: 'click' }]);
    expect(infoRichSegments('plain help@adione.in')).toEqual([{ text: 'plain ' }, { text: 'help@adione.in', href: 'mailto:help@adione.in' }]);
  });
});

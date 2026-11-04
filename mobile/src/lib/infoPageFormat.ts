/**
 * How an information page's metadata and sections are shown — pure (no
 * React Native), so `npm run test:unit` covers it (tests/infoPages.test.ts).
 */

import type { InfoPageDto } from '../shared/info-pages';

/** "Version 2.0 · Effective 2026-11-03 · Last updated 2026-11-03" — whichever parts the page has. */
export function infoPageMeta(page: Pick<InfoPageDto, 'version' | 'effectiveDate' | 'updatedAt'>): string {
  return [
    page.version ? `Version ${page.version}` : null,
    page.effectiveDate ? `Effective ${page.effectiveDate}` : null,
    page.updatedAt ? `Last updated ${page.updatedAt}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The page's structured blocks, or — from a server older than this app —
 * its plain lines as paragraphs.
 */
export function sectionBlocks(section: InfoPageDto['sections'][number]): InfoPageDto['sections'][number]['blocks'] {
  if (Array.isArray(section.blocks) && section.blocks.length > 0) return section.blocks;
  return (section.body ?? []).map((text) => ({ type: 'paragraph' as const, text }));
}

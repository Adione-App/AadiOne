/**
 * How an information page's metadata, sections and contact rows are shown —
 * pure (no React Native), so `npm run test:unit` covers it
 * (tests/infoPages.test.ts). The dates and versions are the server's: the app
 * shows the same "Last updated 7 November 2026 · Version 3" as the website.
 */

import {
  formatInfoPageDate,
  telHref,
  webHref,
  whatsappHref,
  type BusinessInfoDto,
  type InfoPageBlock,
  type InfoPageDto,
} from '../shared/info-pages';

type PageMeta = Pick<InfoPageDto, 'version' | 'updatedAt'> & Partial<Pick<InfoPageDto, 'lastUpdatedLabel'>>;

/** "Last updated 7 November 2026 · Version 3" — whichever parts the page has (an older server sends no label). */
export function infoPageMeta(page: PageMeta): string {
  const date = page.lastUpdatedLabel || formatInfoPageDate(page.updatedAt) || page.updatedAt;
  return [date ? `Last updated ${date}` : null, page.version ? `Version ${page.version}` : null].filter(Boolean).join(' · ');
}

/** "This version takes effect on 1 January 2027." — only for wording published ahead of its date. */
export function infoPageEffectiveNotice(page: Partial<Pick<InfoPageDto, 'effectiveLabel'>>): string | null {
  return page.effectiveLabel ? `This version takes effect on ${page.effectiveLabel}.` : null;
}

/**
 * The page's blocks, newest form first: the formatted ones (`rich`:
 * sub-headings, numbered lists, bold / italic / underline, links), else the
 * plain structured ones, else — from a server older than both — its plain
 * lines as paragraphs.
 */
export function sectionBlocks(section: Pick<InfoPageDto['sections'][number], 'body' | 'blocks' | 'rich'>): InfoPageBlock[] {
  if (Array.isArray(section.rich) && section.rich.length > 0) return section.rich;
  if (Array.isArray(section.blocks) && section.blocks.length > 0) return section.blocks;
  return (section.body ?? []).map((text) => ({ type: 'paragraph' as const, text }));
}

export interface ContactRow {
  key: string;
  label: string;
  value: string;
  /** mailto: / tel: / https: link, or null for plain text. */
  href: string | null;
}

/** Support contact rows with a value — an empty setting has no row (never a placeholder). */
export function supportContactRows(info: BusinessInfoDto | null | undefined): ContactRow[] {
  if (!info) return [];
  const rows: (ContactRow | null)[] = [
    info.support.email ? { key: 'email', label: 'Email', value: info.support.email, href: `mailto:${info.support.email}` } : null,
    info.support.phone ? { key: 'phone', label: 'Phone', value: info.support.phone, href: telHref(info.support.phone) } : null,
    info.support.whatsapp ? { key: 'whatsapp', label: 'WhatsApp', value: info.support.whatsapp, href: whatsappHref(info.support.whatsapp) } : null,
    info.support.hours ? { key: 'hours', label: 'Support hours', value: info.support.hours, href: null } : null,
    info.website ? { key: 'website', label: 'Website', value: info.website.replace(/^https?:\/\//, '').replace(/\/$/, ''), href: webHref(info.website) } : null,
  ];
  return rows.filter((row): row is ContactRow => row !== null);
}

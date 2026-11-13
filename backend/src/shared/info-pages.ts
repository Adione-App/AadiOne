/**
 * Information pages — the legal documents (customer Privacy Policy and Terms,
 * Refund & Cancellation, Shipping & Delivery and Cookie policies, Seller
 * Terms and Seller Privacy Policy) and About Aadione. Admin Panel → Settings →
 * Legal & Policies.
 *
 * Each page is one `content_documents` key (draft → publish → archive, like
 * the Home layout). The content is STRUCTURED PLAIN TEXT — headings,
 * paragraphs and bullet lists — never HTML: nothing an admin types is ever
 * interpreted as markup, in the app, on the website or on the public web page.
 * Email addresses, web addresses and phone numbers in the text are turned into
 * links by the readers (infoTextSegments), never by markup in the text.
 *
 * Business and contact details are never typed into the text. A page names
 * them as {{TOKENS}} that are filled from Admin Configuration each time the
 * page is read, so a changed phone number shows at once, without a new
 * publish or app release. A line whose token has no value (an empty setting)
 * is left out, never shown half-empty or with an invented fallback.
 *
 * Publication metadata is the SERVER's, never typed by an admin:
 *   - Version       = the published revision number (1, 2, 3 …), assigned at
 *                     publish; a restored older text is published as a NEW
 *                     version, so history is never rewritten;
 *   - Last updated  = the publish date (India), from the server clock;
 *   - Takes effect  = optional, a FUTURE date the admin may set for wording
 *                     published in advance (e.g. rules starting 1 January
 *                     2027); an earlier date is never shown (no backdating).
 *
 * Undecided business wording in a template is marked «TO CONFIRM: …»; a page
 * still containing such a marker cannot be published.
 *
 * Pure and dependency-free (shared by backend, web admin, mobile and website).
 */

export const INFO_PAGE_SLUGS = [
  'privacy',
  'terms',
  'refund-policy',
  'shipping-policy',
  'cookie-policy',
  'seller-terms',
  'seller-privacy',
  'about',
] as const;
export type InfoPageSlug = (typeof INFO_PAGE_SLUGS)[number];

/** The content_documents key of each page. */
export const INFO_PAGE_KEYS: Readonly<Record<InfoPageSlug, string>> = {
  privacy: 'legal_privacy',
  terms: 'legal_terms',
  'refund-policy': 'legal_refund_cancellation',
  'shipping-policy': 'legal_shipping_delivery',
  'cookie-policy': 'legal_cookies',
  'seller-terms': 'legal_seller_terms',
  'seller-privacy': 'legal_seller_privacy',
  about: 'page_about',
};

export const INFO_PAGE_TITLES: Readonly<Record<InfoPageSlug, string>> = {
  privacy: 'Privacy Policy',
  terms: 'Terms & Conditions',
  'refund-policy': 'Refund & Cancellation Policy',
  'shipping-policy': 'Shipping & Delivery Policy',
  'cookie-policy': 'Cookie Policy',
  'seller-terms': 'Seller Terms & Conditions',
  'seller-privacy': 'Seller Privacy Policy',
  about: 'About Aadione',
};

/**
 * Who a page is for: customers (the app, the website), sellers (the Seller
 * Panel), or everyone (About; the Cookie Policy covers every website).
 */
export type InfoPageAudience = 'customer' | 'seller' | 'general';
export const INFO_PAGE_AUDIENCE: Readonly<Record<InfoPageSlug, InfoPageAudience>> = {
  privacy: 'customer',
  terms: 'customer',
  'refund-policy': 'customer',
  'shipping-policy': 'customer',
  'cookie-policy': 'general',
  'seller-terms': 'seller',
  'seller-privacy': 'seller',
  about: 'general',
};

/** Legal documents (everything but About): publishing needs the operator and grievance details. */
export const LEGAL_DOCUMENT_SLUGS = INFO_PAGE_SLUGS.filter((slug) => slug !== 'about');

/**
 * Documents a signed-in user is asked to ACCEPT when an admin marks a new
 * version as needing it — customers in the app, sellers in the Seller Panel.
 * The other customer policies are part of what customers accept through the
 * Terms.
 */
export const CUSTOMER_ACCEPTANCE_SLUGS = ['privacy', 'terms'] as const;
export const SELLER_ACCEPTANCE_SLUGS = ['seller-terms', 'seller-privacy'] as const;
export type AcceptanceSlug = (typeof CUSTOMER_ACCEPTANCE_SLUGS)[number] | (typeof SELLER_ACCEPTANCE_SLUGS)[number];

export function asksForAcceptance(slug: InfoPageSlug): slug is AcceptanceSlug {
  return (CUSTOMER_ACCEPTANCE_SLUGS as readonly string[]).includes(slug) || (SELLER_ACCEPTANCE_SLUGS as readonly string[]).includes(slug);
}

export function isInfoPageSlug(value: string): value is InfoPageSlug {
  return (INFO_PAGE_SLUGS as readonly string[]).includes(value);
}

export type InfoPageBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] };

export interface InfoPageSection {
  heading: string;
  blocks: InfoPageBlock[];
}

export interface InfoPageContent {
  title: string;
  /**
   * Optional "takes effect on" date (YYYY-MM-DD, India) for wording published
   * ahead of the day it applies from. Empty = applies from publication. A date
   * on or before the publish day is dropped when publishing.
   */
  effectiveDate: string;
  /** Set when the draft was restored from an earlier version (kept for the history). */
  restoredFromVersion?: number;
  /**
   * Set at publish (documents in CUSTOMER_/SELLER_ACCEPTANCE_SLUGS only):
   * signed-in customers (app) or sellers (Seller Panel) are asked to accept
   * this version. Off for corrections that change nothing material, so nobody
   * is interrupted for every edit.
   */
  requiresAcceptance?: boolean;
  sections: InfoPageSection[];
}

export const INFO_PAGE_LIMITS = {
  title: 120,
  sections: 60,
  heading: 160,
  blocksPerSection: 40,
  paragraph: 3000,
  bulletItems: 40,
  bulletItem: 1000,
  /** How far ahead a "takes effect" date may be. */
  effectiveDaysAhead: 730,
  /** Whole document, as JSON. */
  totalChars: 150_000,
} as const;

/** Every {{TOKEN}} a page may use. Anything else is refused on save. */
export const INFO_PAGE_TOKENS = [
  'BUSINESS_TRADE_NAME',
  'BUSINESS_LEGAL_NAME',
  'BUSINESS_PROPRIETOR_NAME',
  'BUSINESS_TYPE',
  'BUSINESS_ADDRESS',
  'BUSINESS_WEBSITE',
  'GSTIN',
  'SUPPORT_EMAIL',
  'SUPPORT_PHONE',
  'SUPPORT_WHATSAPP',
  'SUPPORT_HOURS',
  'GRIEVANCE_OFFICER_NAME',
  'GRIEVANCE_OFFICER_DESIGNATION',
  'GRIEVANCE_OFFICER_EMAIL',
  'GRIEVANCE_OFFICER_PHONE',
  'GRIEVANCE_OFFICER_ADDRESS',
  'MIN_ORDER_VALUE',
  'FREE_DELIVERY_THRESHOLD',
  'PLATFORM_FEE',
] as const;
export type InfoPageToken = (typeof INFO_PAGE_TOKENS)[number];

/** Token values for one read: a missing or blank value means "not configured". */
export type InfoPageValues = Partial<Record<InfoPageToken, string>>;

/**
 * What a LEGAL document cannot be published without: who operates the
 * platform and where, a customer-care contact, and the grievance officer
 * users can write to (Consumer Protection (E-Commerce) Rules, 2020, rule 4).
 * Each entry is met when ANY of its settings is filled. The About page has no
 * required settings.
 */
const LEGAL_REQUIREMENTS: readonly (readonly InfoPageToken[])[] = [
  ['BUSINESS_LEGAL_NAME'],
  ['BUSINESS_ADDRESS'],
  ['SUPPORT_EMAIL', 'SUPPORT_PHONE'],
  ['GRIEVANCE_OFFICER_NAME'],
  ['GRIEVANCE_OFFICER_DESIGNATION'],
  ['GRIEVANCE_OFFICER_EMAIL'],
];
export const INFO_PAGE_REQUIREMENTS: Readonly<Record<InfoPageSlug, readonly (readonly InfoPageToken[])[]>> = {
  privacy: LEGAL_REQUIREMENTS,
  terms: LEGAL_REQUIREMENTS,
  'refund-policy': LEGAL_REQUIREMENTS,
  'shipping-policy': LEGAL_REQUIREMENTS,
  'cookie-policy': LEGAL_REQUIREMENTS,
  'seller-terms': LEGAL_REQUIREMENTS,
  'seller-privacy': LEGAL_REQUIREMENTS,
  about: [],
};

/** The requirements of a page that today's settings do not meet. */
export function infoPageUnmetRequirements(slug: InfoPageSlug, values: InfoPageValues): InfoPageToken[][] {
  return INFO_PAGE_REQUIREMENTS[slug].filter((anyOf) => !anyOf.some((token) => values[token]?.trim())).map((anyOf) => [...anyOf]);
}

/** Marks wording the owner still has to decide; a page containing it cannot be published. */
export const INFO_PAGE_UNCONFIRMED_MARKER = '«TO CONFIRM';

const TOKEN_PATTERN = /\{\{([A-Z_]+)\}\}/g;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Control characters (except tab / newline) never belong in page text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface InfoPageProblem {
  field: string;
  message: string;
}

/** The tokens one piece of text uses. */
export function infoPageTokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN_PATTERN)].map((match) => match[1]!);
}

export function isValidInfoPageDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Checks an admin's page. Returns the cleaned content (trimmed text, empty
 * blocks and bullet items dropped) or every problem found. Fields from older
 * drafts (an admin-typed "version") are ignored.
 */
export function validateInfoPage(input: unknown): { ok: true; content: InfoPageContent } | { ok: false; problems: InfoPageProblem[] } {
  const problems: InfoPageProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const known = new Set<string>(INFO_PAGE_TOKENS);

  const checkText = (field: string, value: unknown, max: number, required: boolean): string => {
    if (typeof value !== 'string') {
      add(field, 'must be text');
      return '';
    }
    const text = value.trim();
    if (required && text.length === 0) add(field, 'is required');
    if (text.length > max) add(field, `must be at most ${max} characters`);
    if (CONTROL_CHARS.test(text)) add(field, 'contains characters that are not allowed');
    for (const token of infoPageTokensIn(text)) {
      if (!known.has(token)) add(field, `{{${token}}} is not a known setting`);
    }
    return text;
  };

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ field: 'content', message: 'must be a page' }] };
  }
  if (JSON.stringify(input).length > INFO_PAGE_LIMITS.totalChars) {
    return { ok: false, problems: [{ field: 'content', message: `the page is too long (at most ${INFO_PAGE_LIMITS.totalChars} characters)` }] };
  }
  const raw = input as Record<string, unknown>;
  const title = checkText('title', raw['title'], INFO_PAGE_LIMITS.title, true);
  const effectiveDate = typeof raw['effectiveDate'] === 'string' ? raw['effectiveDate'].trim() : '';
  if (effectiveDate && !isValidInfoPageDate(effectiveDate)) add('effectiveDate', 'must be a date (YYYY-MM-DD) or empty');
  const restored = raw['restoredFromVersion'];
  const restoredFromVersion = typeof restored === 'number' && Number.isInteger(restored) && restored > 0 ? restored : undefined;
  const requiresAcceptance = raw['requiresAcceptance'] === true ? true : undefined;

  const sections: InfoPageSection[] = [];
  const rawSections = raw['sections'];
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    add('sections', 'add at least one section');
  } else if (rawSections.length > INFO_PAGE_LIMITS.sections) {
    add('sections', `at most ${INFO_PAGE_LIMITS.sections} sections`);
  } else {
    rawSections.forEach((rawSection, s) => {
      const section = (rawSection ?? {}) as Record<string, unknown>;
      const heading = checkText(`sections.${s}.heading`, section['heading'], INFO_PAGE_LIMITS.heading, true);
      const blocks: InfoPageBlock[] = [];
      const rawBlocks = section['blocks'];
      if (!Array.isArray(rawBlocks) || rawBlocks.length > INFO_PAGE_LIMITS.blocksPerSection) {
        add(`sections.${s}.blocks`, `must be a list of at most ${INFO_PAGE_LIMITS.blocksPerSection} paragraphs or lists`);
      } else {
        rawBlocks.forEach((rawBlock, b) => {
          const block = (rawBlock ?? {}) as Record<string, unknown>;
          const field = `sections.${s}.blocks.${b}`;
          if (block['type'] === 'paragraph') {
            const text = checkText(`${field}.text`, block['text'], INFO_PAGE_LIMITS.paragraph, false);
            if (text) blocks.push({ type: 'paragraph', text });
          } else if (block['type'] === 'bullets') {
            const rawItems = block['items'];
            if (!Array.isArray(rawItems) || rawItems.length > INFO_PAGE_LIMITS.bulletItems) {
              add(`${field}.items`, `must be a list of at most ${INFO_PAGE_LIMITS.bulletItems} points`);
              return;
            }
            const items = rawItems
              .map((item, i) => checkText(`${field}.items.${i}`, item, INFO_PAGE_LIMITS.bulletItem, false))
              .filter((item) => item.length > 0);
            if (items.length > 0) blocks.push({ type: 'bullets', items });
          } else {
            add(`${field}.type`, 'must be a paragraph or a bullet list');
          }
        });
      }
      if (blocks.length === 0) add(`sections.${s}`, 'needs at least one paragraph or point');
      sections.push({ heading, blocks });
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  const content: InfoPageContent = { title, effectiveDate, sections };
  if (restoredFromVersion !== undefined) content.restoredFromVersion = restoredFromVersion;
  if (requiresAcceptance) content.requiresAcceptance = true;
  return { ok: true, content };
}

export interface InfoPageUnconfirmedItem {
  /** The section heading it is in ("Title" for the title). */
  section: string;
  text: string;
}

/** Wording still marked «TO CONFIRM» (publishing is refused while any remains). */
export function infoPageUnconfirmed(content: InfoPageContent): InfoPageUnconfirmedItem[] {
  const found: InfoPageUnconfirmedItem[] = [];
  if (content.title.includes(INFO_PAGE_UNCONFIRMED_MARKER)) found.push({ section: 'Title', text: content.title });
  for (const section of content.sections) {
    const texts = [section.heading, ...section.blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items))];
    for (const text of texts) if (text.includes(INFO_PAGE_UNCONFIRMED_MARKER)) found.push({ section: section.heading, text });
  }
  return found;
}

export interface ResolvedInfoPage {
  title: string;
  effectiveDate: string;
  sections: InfoPageSection[];
  /** Tokens the page uses that had no value — each line using one was left out. */
  missing: InfoPageToken[];
}

/**
 * Fills the tokens. A paragraph or bullet point that uses a token with no
 * value is LEFT OUT (never shown with a gap or a made-up value); a list or
 * section left empty that way goes too. A heading's tokens are filled, and a
 * missing one leaves the heading without it.
 */
export function resolveInfoPage(content: InfoPageContent, values: InfoPageValues): ResolvedInfoPage {
  const missing = new Set<InfoPageToken>();
  const valueOf = (token: string): string | null => {
    const value = (values as Record<string, string | undefined>)[token]?.trim();
    if (value) return value;
    missing.add(token as InfoPageToken);
    return null;
  };
  /** The text with its tokens filled, or null when any token has no value. */
  const fill = (text: string): string | null => {
    let complete = true;
    const filled = text.replace(TOKEN_PATTERN, (_match, token: string) => {
      const value = valueOf(token);
      if (value === null) complete = false;
      return value ?? '';
    });
    return complete ? filled : null;
  };

  const sections: InfoPageSection[] = [];
  for (const section of content.sections) {
    const blocks: InfoPageBlock[] = [];
    for (const block of section.blocks) {
      if (block.type === 'paragraph') {
        const text = fill(block.text);
        if (text !== null) blocks.push({ type: 'paragraph', text });
      } else {
        const items = block.items.map(fill).filter((item): item is string => item !== null);
        if (items.length > 0) blocks.push({ type: 'bullets', items });
      }
    }
    if (blocks.length === 0) continue;
    const heading = section.heading.replace(TOKEN_PATTERN, (_match, token: string) => valueOf(token) ?? '').replace(/\s{2,}/g, ' ').trim();
    sections.push({ heading, blocks });
  }

  const title = content.title.replace(TOKEN_PATTERN, (_match, token: string) => valueOf(token) ?? '').trim();
  return { title, effectiveDate: content.effectiveDate, sections, missing: [...missing] };
}

/** One section's blocks as plain lines (bullets prefixed) — for app versions that only read `body`. */
export function infoPageBodyLines(section: InfoPageSection): string[] {
  return section.blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items.map((item) => `• ${item}`)));
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** India has one time zone and no daylight saving: UTC+05:30 all year. */
const INDIA_OFFSET_MS = 330 * 60_000;

/** The calendar date in India (YYYY-MM-DD) of a moment. */
export function indiaDateOf(moment: Date | string): string {
  const time = typeof moment === 'string' ? Date.parse(moment) : moment.getTime();
  return new Date(time + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-11-07" → "7 November 2026" (the same on every platform; '' for anything else). */
export function formatInfoPageDate(date: string | null | undefined): string {
  if (!date || !isValidInfoPageDate(date)) return '';
  const [year, month, day] = date.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** The "takes effect" date shown for a page published on `publishedOn`: only a LATER date, else null. */
export function effectiveDateAfter(effectiveDate: string | null | undefined, publishedOn: string): string | null {
  return effectiveDate && isValidInfoPageDate(effectiveDate) && effectiveDate > publishedOn ? effectiveDate : null;
}

/* -------------------------------------------------------------------------- */
/* Links and anchors                                                           */
/* -------------------------------------------------------------------------- */

/** A run of page text; `href` (mailto:, tel:, https:) when it is a contact or web address. */
export interface InfoTextSegment {
  text: string;
  href?: string;
}

// Email | web address | Indian mobile (optionally +91) | 1800 toll-free number.
const LINK_PATTERN =
  /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|((?:https?:\/\/|www\.)[^\s<>"'«»]+)|((?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}|1800[\s-]?\d{2,4}[\s-]?\d{3,4})/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** tel: link for a phone number as written ("+91 97760 29985" → "tel:+919776029985"). */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return `tel:${digits}`;
}

/** WhatsApp chat link for a number; a bare 10-digit Indian mobile gets +91. */
export function whatsappHref(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  return `https://wa.me/${digits}`;
}

/** An admin-entered web address as a safe https/http link, or null. */
export function webHref(address: string): string | null {
  const trimmed = address.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Splits text into plain runs and links: email addresses (mailto:), web
 * addresses (https:) and Indian phone numbers (tel:, or a wa.me chat link
 * right after "WhatsApp"). Only these schemes are ever produced — never
 * javascript: or anything typed as markup.
 */
export function infoTextSegments(text: string): InfoTextSegment[] {
  const segments: InfoTextSegment[] = [];
  let last = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous && !previous.href) previous.text += value;
    else segments.push({ text: value });
  };
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    let value = match[0];
    const before = start > 0 ? text[start - 1]! : '';
    let href: string | null = null;
    if (match[1]) {
      href = `mailto:${value}`;
    } else if (match[2]) {
      if (/[A-Za-z0-9@]/.test(before)) continue;
      value = value.replace(TRAILING_PUNCTUATION, '');
      href = webHref(value);
    } else if (match[3]) {
      // Not inside a longer number or word.
      const after = text[start + value.length] ?? '';
      if (/[\dA-Za-z+]/.test(before) || /\d/.test(after)) continue;
      // "WhatsApp: +91 …" opens a chat, not a call.
      href = /whatsapp\W*$/i.test(text.slice(Math.max(0, start - 20), start)) ? whatsappHref(value) : telHref(value);
    }
    if (!href) continue;
    pushText(text.slice(last, start));
    segments.push({ text: value, href });
    last = start + value.length;
  }
  pushText(text.slice(last));
  return segments.length > 0 ? segments : [{ text }];
}

/** URL-safe anchor of a heading ("Cancellation & refunds" → "cancellation-refunds"). */
export function infoSectionAnchor(heading: string): string {
  const slug = heading
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'section';
}

/** Unique anchors for a page's headings, in order (a repeated heading gets "-2", "-3" …). */
export function infoSectionAnchors(headings: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headings.map((heading) => {
    const base = infoSectionAnchor(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /legal/:slug — the same JSON for the app, the website and the public
 * HTML page. `sections[].body` is what app versions before the structured
 * format read (plain lines); `blocks` is the structured form.
 * `source`: "published" (an admin-published revision) or "builtin" (nothing
 * published yet — the wording the app had before).
 */
export interface InfoPageDto {
  slug: InfoPageSlug;
  title: string;
  /** Last updated, YYYY-MM-DD (India): the publish date; the built-in wording's own date otherwise. */
  updatedAt: string;
  /** "7 November 2026" — show this, so every platform shows the same text. */
  lastUpdatedLabel: string;
  /** The exact publish moment (ISO), or null for built-in wording. */
  publishedAt: string | null;
  /** The published revision number as text ("3"); null for built-in wording. */
  version: string | null;
  /** A later "takes effect on" date (YYYY-MM-DD), or null when it applies from publication. */
  effectiveDate: string | null;
  /** "1 January 2027", or null. */
  effectiveLabel: string | null;
  revision: number;
  source: 'published' | 'builtin';
  sections: { id: string; heading: string; body: string[]; blocks: InfoPageBlock[] }[];
  /**
   * GET /legal/:slug/versions/:version only: false for an earlier version
   * (kept readable — e.g. the version someone accepted), true for the latest.
   */
  isLatest?: boolean;
}

/** GET /legal/:slug/versions — every published version, newest first (public). */
export interface InfoPageVersionSummaryDto {
  version: string;
  publishedAt: string | null;
  /** "7 November 2026" (India). */
  lastUpdatedLabel: string;
  effectiveLabel: string | null;
  isLatest: boolean;
}

/** The public address of a page (the HTML page the API serves), for the admin's "Public URL". */
export function infoPagePublicPath(slug: InfoPageSlug, version?: number): string {
  return version ? `/api/v1/legal/${slug}/versions/${version}/page` : `/api/v1/legal/${slug}/page`;
}

/** One publication event in the history. */
export interface InfoPageRevisionDto {
  id: string;
  revision: number;
  /** The version customers saw ("3"). */
  version: string;
  /** The "takes effect" date it was published with ('' = from publication). */
  effectiveDate: string;
  publishedAt: string | null;
  /** "7 November 2026" (India). */
  lastUpdatedLabel: string;
  publishedBy: string | null;
  /** When this publication re-used the text of an earlier version. */
  restoredFromVersion: number | null;
  /** Signed-in customers were asked to accept this version. */
  requiresAcceptance: boolean;
}

export interface InfoPageSettingDto {
  token: InfoPageToken;
  /** The Configuration setting it comes from. */
  configKey: string;
  label: string;
  filled: boolean;
  /** Part of a requirement before a legal page can be published. */
  required: boolean;
}

/** GET /admin/content/pages/:slug */
export interface AdminInfoPageDto {
  slug: InfoPageSlug;
  published: (InfoPageRevisionDto & { content: InfoPageContent }) | null;
  draft: { basedOnRevision: number; updatedAt: string; updatedBy: string | null; content: InfoPageContent } | null;
  history: InfoPageRevisionDto[];
  /** What customers see right now (built-in wording until the first publish). */
  live: { source: InfoPageDto['source']; version: string | null; lastUpdatedLabel: string };
  /** The version the next publish creates. */
  nextVersion: number;
  /** Privacy / Terms: whether customers have ever been asked to accept a version (the first publish always asks). */
  acceptanceEverRequired: boolean;
  /** Requirements today's settings do not meet, as admin-readable labels. */
  missingRequired: string[];
  /** The Aadione starting wording an admin can load into the draft. */
  template: InfoPageContent;
  settings: InfoPageSettingDto[];
}

/** POST /admin/content/pages/:slug/preview */
export interface InfoPagePreviewDto {
  page: ResolvedInfoPage;
  /** Requirements that are unmet (publishing is refused until they are set), as labels. */
  missingRequired: string[];
  unconfirmed: InfoPageUnconfirmedItem[];
  /** The metadata customers would see if this were published now. */
  onPublish: { version: string; lastUpdatedLabel: string; effectiveLabel: string | null };
}

/* -------------------------------------------------------------------------- */
/* Business and contact details (GET /legal/business)                          */
/* -------------------------------------------------------------------------- */

export const SOCIAL_NETWORKS = ['instagram', 'facebook', 'x', 'youtube', 'linkedin'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const SOCIAL_NETWORK_LABELS: Readonly<Record<SocialNetwork, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X (Twitter)',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
};

/**
 * Who runs Aadione and how to reach them — every value from Admin
 * Configuration, null when the setting is empty (the reader hides that row;
 * nothing is ever substituted). The app's About screen, the website's footer,
 * contact and support pages read this instead of keeping their own copy.
 */
export interface BusinessInfoDto {
  tradeName: string;
  legalName: string | null;
  proprietorName: string | null;
  businessType: string | null;
  address: string | null;
  gstin: string | null;
  website: string | null;
  support: { email: string | null; phone: string | null; whatsapp: string | null; hours: string | null };
  grievanceOfficer: { name: string | null; designation: string | null; email: string | null; phone: string | null; address: string | null };
  socials: { network: SocialNetwork; label: string; url: string }[];
}

/* -------------------------------------------------------------------------- */
/* Customer acceptance (GET / POST /legal/consent)                             */
/* -------------------------------------------------------------------------- */

export const LEGAL_CONSENT_SOURCES = ['ANDROID', 'IOS', 'WEB'] as const;
export type LegalConsentSource = (typeof LEGAL_CONSENT_SOURCES)[number];

/**
 * Whether the signed-in customer must accept the current Privacy Policy and
 * Terms. Only when BOTH are published (built-in wording is never "accepted"),
 * and only when the customer has not accepted a version at least as new as
 * the latest one an admin marked as needing acceptance.
 */
export interface LegalConsentStatusDto {
  required: boolean;
  /** The versions published now (what accepting records), or null while not published. */
  privacyVersion: number | null;
  termsVersion: number | null;
  /** The customer's latest acceptance, if any. */
  accepted: { privacyVersion: number; termsVersion: number; acceptedAt: string } | null;
}

/** POST /legal/consent — the versions the customer saw and accepted. */
export interface AcceptLegalRequest {
  privacyVersion: number;
  termsVersion: number;
  source: LegalConsentSource;
  appVersion?: string;
}

/** Pure rule: must the customer accept again? */
export function legalConsentRequired(
  required: { privacy: number; terms: number } | null,
  accepted: { privacyVersion: number; termsVersion: number } | null,
): boolean {
  if (!required) return false;
  if (!accepted) return true;
  return accepted.privacyVersion < required.privacy || accepted.termsVersion < required.terms;
}

/* -------------------------------------------------------------------------- */
/* Seller acceptance (GET / POST /seller/legal/consent)                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether the signed-in seller user must accept the current Seller Terms and
 * Seller Privacy Policy. Only when BOTH are published, and only when the user
 * has not accepted, for this seller, a version at least as new as the latest
 * one an admin marked as needing acceptance.
 */
export interface SellerLegalConsentStatusDto {
  required: boolean;
  termsVersion: number | null;
  privacyVersion: number | null;
  accepted: { termsVersion: number; privacyVersion: number; acceptedAt: string } | null;
}

/** POST /seller/legal/consent — the versions the seller saw and accepted. */
export interface AcceptSellerLegalRequest {
  termsVersion: number;
  privacyVersion: number;
}

/** GET /legal/pages — the pages a reader can open now (footers, menus): never an unpublished one. */
export interface InfoPageIndexEntryDto {
  slug: InfoPageSlug;
  title: string;
  audience: InfoPageAudience;
  /** null for built-in wording (privacy / terms before their first publish). */
  version: string | null;
  lastUpdatedLabel: string;
  source: 'published' | 'builtin';
}

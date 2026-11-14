/**
 * Information pages — the legal documents (customer Privacy Policy and Terms,
 * Refund & Cancellation, Shipping & Delivery and Cookie policies, Seller
 * Terms and Seller Privacy Policy) and About Aadione. Admin Panel → Settings →
 * Legal & Policies.
 *
 * Each page is one `content_documents` key (draft → publish → archive, like
 * the Home layout). The content is STRUCTURED TEXT — sections with a heading,
 * then paragraphs, bullet and numbered lists and sub-headings — never HTML:
 * nothing an admin types is ever interpreted as markup, in the app, on the
 * website or on the public web page. Bold, italic, underline and links the
 * admin adds in the document editor are stored as formatted pieces of text
 * (InfoTextRun) beside the plain wording; links are checked (infoLinkHref:
 * https:, http:, mailto:, tel: only). Email addresses, web addresses and phone
 * numbers in the text are also turned into links by the readers
 * (infoTextSegments), never by markup in the text.
 *
 * Every document saved before formatting existed is valid as it is — the
 * format only gained optional fields and block types — so nothing was
 * migrated, and every earlier version reads exactly as it was published.
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

/**
 * A piece of formatted text — what a paragraph or list point is made of when
 * the admin used bold, italic, underline or a link (the Admin Panel's document
 * editor). Text only, never markup: readers draw the formatting themselves.
 */
export interface InfoTextRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  /** A link the admin added — https:, http:, mailto: or tel: only (infoLinkHref, checked on save and on every read). */
  href?: string;
}

/**
 * One block of a section. `text` / `items` are ALWAYS the plain wording (what
 * tokens, «TO CONFIRM» notes and limits are checked on, and what older
 * readers show). `runs` / `itemRuns` are present only when the wording has
 * formatting; they join up to exactly the plain text.
 *
 * Headings: the section heading is the editor's "Heading 1"; a `subheading`
 * block is "Heading 2" (level 2) or "Heading 3" (level 3) inside a section.
 */
export type InfoPageBlock =
  | { type: 'paragraph'; text: string; runs?: InfoTextRun[] }
  | { type: 'bullets'; items: string[]; itemRuns?: InfoTextRun[][] }
  | { type: 'numbered'; items: string[]; itemRuns?: InfoTextRun[][] }
  | { type: 'subheading'; level: 2 | 3; text: string };

/**
 * The plain blocks every reader has always understood — the wire format's
 * `blocks`, for app versions released before formatting existed
 * (infoPagePlainBlocks).
 */
export type InfoPagePlainBlock = { type: 'paragraph'; text: string } | { type: 'bullets'; items: string[] };

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
  /** Paragraphs, lists and sub-headings in one section. */
  blocksPerSection: 80,
  paragraph: 3000,
  bulletItems: 40,
  bulletItem: 1000,
  /** Differently formatted pieces in one paragraph or point. */
  runs: 400,
  /** One link address. */
  link: 500,
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

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * A link an admin added, as a safe address — or null. Only web addresses
 * (https:/http:, "adione.in" becomes https://adione.in/), email addresses
 * (mailto:) and phone numbers (tel:) are links; javascript:, data: and every
 * other scheme are refused, and so is a {{TOKEN}} inside an address.
 */
export function infoLinkHref(value: string): string | null {
  const address = value.trim();
  if (!address || address.length > INFO_PAGE_LIMITS.link || address.includes('{{')) return null;
  // A phone number, as people write it ("+91 90000 00001", "tel:0294-2412345").
  const isTel = /^tel:/i.test(address);
  const number = (isTel ? address.slice('tel:'.length) : address).replace(/[\s\-().]/g, '');
  if (/^\+?\d{6,15}$/.test(number)) return `tel:${number}`;
  if (isTel || /\s/.test(address)) return null;
  if (/^mailto:/i.test(address)) {
    const email = address.slice('mailto:'.length);
    return EMAIL_PATTERN.test(email) ? `mailto:${email}` : null;
  }
  if (EMAIL_PATTERN.test(address)) return `mailto:${address}`;
  // Any other scheme ("javascript:", "data:", "ftp:" …) is never a link.
  if (/^[a-z][a-z0-9+.-]*:/i.test(address) && !/^https?:\/\//i.test(address)) return null;
  return webHref(address);
}

type RunFormat = Omit<InfoTextRun, 'text'>;
const formatOf = (run: Partial<InfoTextRun>): RunFormat => ({
  ...(run.bold ? { bold: true as const } : {}),
  ...(run.italic ? { italic: true as const } : {}),
  ...(run.underline ? { underline: true as const } : {}),
  ...(run.href ? { href: run.href } : {}),
});
const sameFormat = (a: RunFormat, b: RunFormat) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.href === b.href;
const hasFormat = (format: RunFormat) => Boolean(format.bold || format.italic || format.underline || format.href);

/**
 * Checks and tidies the formatted pieces of one paragraph or point: unknown
 * fields dropped, links checked, the whole trimmed, neighbours with the same
 * formatting merged, and a {{TOKEN}} kept in ONE piece (it takes the
 * formatting of its first character, so it can always be filled). Returns the
 * plain text and the pieces — `runs` undefined when nothing is formatted — or
 * null after recording a problem.
 */
function normalizeRuns(
  field: string,
  value: unknown,
  add: (field: string, message: string) => void,
): { text: string; runs?: InfoTextRun[] } | null {
  if (!Array.isArray(value) || value.length > INFO_PAGE_LIMITS.runs) {
    add(field, `must be a list of at most ${INFO_PAGE_LIMITS.runs} formatted pieces`);
    return null;
  }
  // One entry per character (code unit), with its formatting.
  const chars: { char: string; format: RunFormat }[] = [];
  let valid = true;
  value.forEach((raw, r) => {
    const run = (raw ?? {}) as Record<string, unknown>;
    if (typeof run['text'] !== 'string') {
      add(`${field}.${r}.text`, 'must be text');
      valid = false;
      return;
    }
    let href: string | undefined;
    if (run['href'] !== undefined) {
      const safe = typeof run['href'] === 'string' ? infoLinkHref(run['href']) : null;
      if (!safe) {
        add(`${field}.${r}.href`, 'a link must be a web address (https://…), an email address or a phone number');
        valid = false;
        return;
      }
      href = safe;
    }
    const format = formatOf({ bold: run['bold'] === true || undefined, italic: run['italic'] === true || undefined, underline: run['underline'] === true || undefined, href });
    for (const char of run['text']) {
      // Split surrogate pairs keep their formatting together.
      for (let i = 0; i < char.length; i += 1) chars.push({ char: char[i]!, format });
    }
  });
  if (!valid) return null;

  // Trim the whole, as plain text is trimmed.
  const joined = chars.map((c) => c.char).join('');
  const lead = joined.length - joined.trimStart().length;
  const trail = joined.length - joined.trimEnd().length;
  const kept = chars.slice(lead, chars.length - trail);
  const text = kept.map((c) => c.char).join('');

  // A token takes the formatting of its first character.
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    for (let i = start + 1; i < start + match[0].length; i += 1) kept[i]!.format = kept[start]!.format;
  }

  const runs: InfoTextRun[] = [];
  for (const { char, format } of kept) {
    const last = runs[runs.length - 1];
    if (last && sameFormat(formatOf(last), format)) last.text += char;
    else runs.push({ text: char, ...format });
  }
  return runs.some((run) => hasFormat(formatOf(run))) ? { text, runs } : { text };
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
            // Formatted: the pieces are the source of truth and the plain text is derived from them.
            const rich = block['runs'] !== undefined ? normalizeRuns(`${field}.runs`, block['runs'], add) : null;
            const text = checkText(`${field}.text`, rich ? rich.text : block['text'], INFO_PAGE_LIMITS.paragraph, false);
            if (text) blocks.push(rich?.runs ? { type: 'paragraph', text, runs: rich.runs } : { type: 'paragraph', text });
          } else if (block['type'] === 'bullets' || block['type'] === 'numbered') {
            const type = block['type'];
            const rawItems = block['items'];
            if (!Array.isArray(rawItems) || rawItems.length > INFO_PAGE_LIMITS.bulletItems) {
              add(`${field}.items`, `must be a list of at most ${INFO_PAGE_LIMITS.bulletItems} points`);
              return;
            }
            const rawItemRuns = block['itemRuns'];
            if (rawItemRuns !== undefined && (!Array.isArray(rawItemRuns) || rawItemRuns.length !== rawItems.length)) {
              add(`${field}.itemRuns`, 'must have one entry per point');
              return;
            }
            const items: string[] = [];
            const itemRuns: InfoTextRun[][] = [];
            let formatted = false;
            rawItems.forEach((item, i) => {
              const raw = Array.isArray(rawItemRuns) ? rawItemRuns[i] : undefined;
              const rich = raw !== undefined && raw !== null ? normalizeRuns(`${field}.itemRuns.${i}`, raw, add) : null;
              const text = checkText(`${field}.items.${i}`, rich ? rich.text : item, INFO_PAGE_LIMITS.bulletItem, false);
              if (!text) return;
              items.push(text);
              itemRuns.push(rich?.runs ?? [{ text }]);
              if (rich?.runs) formatted = true;
            });
            if (items.length > 0) blocks.push(formatted ? { type, items, itemRuns } : { type, items });
          } else if (block['type'] === 'subheading') {
            const level = block['level'] === 2 || block['level'] === 3 ? block['level'] : null;
            if (level === null) add(`${field}.level`, 'must be 2 or 3');
            const text = checkText(`${field}.text`, block['text'], INFO_PAGE_LIMITS.heading, false);
            if (text && level !== null) blocks.push({ type: 'subheading', level, text });
          } else {
            add(`${field}.type`, 'must be a paragraph, a list or a sub-heading');
          }
        });
      }
      if (!blocks.some((block) => block.type !== 'subheading')) add(`sections.${s}`, 'needs at least one paragraph or point');
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

/** The plain wording of a block (one entry per paragraph, point or sub-heading). */
function blockTexts(block: InfoPageBlock): string[] {
  return block.type === 'bullets' || block.type === 'numbered' ? block.items : [block.text];
}

/** Wording still marked «TO CONFIRM» (publishing is refused while any remains). */
export function infoPageUnconfirmed(content: InfoPageContent): InfoPageUnconfirmedItem[] {
  const found: InfoPageUnconfirmedItem[] = [];
  if (content.title.includes(INFO_PAGE_UNCONFIRMED_MARKER)) found.push({ section: 'Title', text: content.title });
  for (const section of content.sections) {
    const texts = [section.heading, ...section.blocks.flatMap(blockTexts)];
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

  /** A formatted piece's tokens filled (only called once its whole text is known to be complete). */
  const fillRuns = (runs: InfoTextRun[]): InfoTextRun[] =>
    runs.map((run) => ({ ...run, text: run.text.replace(TOKEN_PATTERN, (_match, token: string) => valueOf(token) ?? '') }));
  /** A heading's tokens filled; a missing one leaves the heading without it. */
  const fillHeading = (text: string): string =>
    text.replace(TOKEN_PATTERN, (_match, token: string) => valueOf(token) ?? '').replace(/\s{2,}/g, ' ').trim();

  const sections: InfoPageSection[] = [];
  for (const section of content.sections) {
    const blocks: InfoPageBlock[] = [];
    for (const block of section.blocks) {
      if (block.type === 'paragraph') {
        const text = fill(block.text);
        if (text !== null) blocks.push(block.runs ? { type: 'paragraph', text, runs: fillRuns(block.runs) } : { type: 'paragraph', text });
      } else if (block.type === 'bullets' || block.type === 'numbered') {
        const items: string[] = [];
        const itemRuns: InfoTextRun[][] = [];
        block.items.forEach((item, i) => {
          const text = fill(item);
          if (text === null) return;
          items.push(text);
          if (block.itemRuns) itemRuns.push(fillRuns(block.itemRuns[i] ?? [{ text: item }]));
        });
        if (items.length > 0) blocks.push(block.itemRuns ? { type: block.type, items, itemRuns } : { type: block.type, items });
      } else {
        const text = fillHeading(block.text);
        if (text) blocks.push({ type: 'subheading', level: block.level, text });
      }
    }
    // A section left with nothing to read (sub-headings alone) goes too.
    if (!blocks.some((block) => block.type !== 'subheading')) continue;
    sections.push({ heading: fillHeading(section.heading), blocks });
  }

  const title = content.title.replace(TOKEN_PATTERN, (_match, token: string) => valueOf(token) ?? '').trim();
  return { title, effectiveDate: content.effectiveDate, sections, missing: [...missing] };
}

/* -------------------------------------------------------------------------- */
/* Formatting for readers                                                      */
/* -------------------------------------------------------------------------- */

/** How a link's address reads as text: the email, the number, or the web address without "https://". */
function linkAddressText(href: string): string {
  if (href.startsWith('mailto:')) return href.slice('mailto:'.length);
  if (href.startsWith('tel:')) return href.slice('tel:'.length);
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Formatted wording as plain text, for readers without formatting: a link
 * whose words do not already show its address gets it in brackets
 * ("our website (https://adione.in/)"), so nothing is lost — older readers
 * make the address itself a link.
 */
export function infoPlainText(text: string, runs?: readonly InfoTextRun[]): string {
  if (!runs) return text;
  return runs
    .map((run) => {
      if (!run.href) return run.text;
      const address = linkAddressText(run.href);
      const shown = run.text.replace(/\s+/g, '').toLowerCase().includes(address.replace(/\s+/g, '').toLowerCase());
      return shown ? run.text : `${run.text} (${run.href.startsWith('http') ? run.href : address})`;
    })
    .join('');
}

/**
 * The blocks as older readers understand them (the wire format's `blocks`):
 * formatting dropped (links kept as addresses), a numbered list as numbered
 * paragraphs ("1. …"), a sub-heading as a paragraph.
 */
export function infoPagePlainBlocks(blocks: readonly InfoPageBlock[]): InfoPagePlainBlock[] {
  return blocks.flatMap((block): InfoPagePlainBlock[] => {
    switch (block.type) {
      case 'paragraph':
        return [{ type: 'paragraph', text: infoPlainText(block.text, block.runs) }];
      case 'bullets':
        return [{ type: 'bullets', items: block.items.map((item, i) => infoPlainText(item, block.itemRuns?.[i])) }];
      case 'numbered':
        return block.items.map((item, i) => ({ type: 'paragraph' as const, text: `${i + 1}. ${infoPlainText(item, block.itemRuns?.[i])}` }));
      case 'subheading':
        return [{ type: 'paragraph', text: block.text }];
    }
  });
}

/** One section's blocks as plain lines (bullets prefixed) — for app versions that only read `body`. */
export function infoPageBodyLines(section: Pick<InfoPageSection, 'blocks'>): string[] {
  return infoPagePlainBlocks(section.blocks).flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items.map((item) => `• ${item}`)));
}

/** A run of text as a reader draws it: its formatting, and a link (made by the admin, or an address found in the text). */
export interface InfoRichSegment extends InfoTextSegment {
  bold?: true;
  italic?: true;
  underline?: true;
}

/**
 * A paragraph's or point's wording as segments to draw. Formatted pieces keep
 * their bold / italic / underline; a piece the admin linked is one link
 * (re-checked: only https:, http:, mailto: and tel: ever become links); in
 * the other pieces, email addresses, web addresses and phone numbers are made
 * links exactly as in plain text (infoTextSegments).
 */
export function infoRichSegments(text: string, runs?: readonly InfoTextRun[]): InfoRichSegment[] {
  const source = runs && runs.length > 0 ? runs : [{ text }];
  return source.flatMap((run): InfoRichSegment[] => {
    const format: Omit<InfoRichSegment, 'text' | 'href'> = {
      ...(run.bold ? { bold: true as const } : {}),
      ...(run.italic ? { italic: true as const } : {}),
      ...(run.underline ? { underline: true as const } : {}),
    };
    const href = run.href ? infoLinkHref(run.href) : null;
    if (href) return [{ text: run.text, href, ...format }];
    return infoTextSegments(run.text).map((segment) => ({ ...segment, ...format }));
  });
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
 * HTML page. Three forms of each section, newest first:
 *   - `rich`   the full wording: sub-headings, bullet and numbered lists,
 *              bold / italic / underline and links (readers since Nov 2026);
 *   - `blocks` the same wording as plain paragraphs and bullet lists
 *              (infoPagePlainBlocks), for app versions released before;
 *   - `body`   plain lines, for app versions before the structured format.
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
  sections: {
    id: string;
    heading: string;
    body: string[];
    blocks: InfoPagePlainBlock[];
    /** Absent from servers older than the document editor — read `blocks` then. */
    rich?: InfoPageBlock[];
  }[];
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

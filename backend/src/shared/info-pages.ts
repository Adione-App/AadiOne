/**
 * Information pages — Privacy Policy, Terms & Conditions, About Aadione.
 *
 * Each page is one `content_documents` key (draft → publish → archive, like
 * the Home layout). The content is STRUCTURED PLAIN TEXT — headings,
 * paragraphs and bullet lists — never HTML: nothing an admin types is ever
 * interpreted as markup, in the app or on the public web page.
 *
 * Business and contact details are never typed into the text. A page names
 * them as {{TOKENS}} that are filled from Admin Configuration each time the
 * page is read, so a changed phone number shows at once, without a new
 * publish or app release. A line whose token has no value (an empty setting)
 * is left out, never shown half-empty or with an invented fallback.
 *
 * Undecided business wording in a template is marked «TO CONFIRM: …»; a page
 * still containing such a marker cannot be published.
 *
 * Pure and dependency-free (shared by backend, web admin and mobile).
 */

export const INFO_PAGE_SLUGS = ['privacy', 'terms', 'about'] as const;
export type InfoPageSlug = (typeof INFO_PAGE_SLUGS)[number];

/** The content_documents key of each page. */
export const INFO_PAGE_KEYS: Readonly<Record<InfoPageSlug, string>> = {
  privacy: 'legal_privacy',
  terms: 'legal_terms',
  about: 'page_about',
};

export const INFO_PAGE_TITLES: Readonly<Record<InfoPageSlug, string>> = {
  privacy: 'Privacy Policy',
  terms: 'Terms & Conditions',
  about: 'About Aadione',
};

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
  /** Shown as "Version …", e.g. "2.0". */
  version: string;
  /** YYYY-MM-DD — the date the published wording applies from. */
  effectiveDate: string;
  sections: InfoPageSection[];
}

export const INFO_PAGE_LIMITS = {
  title: 120,
  version: 20,
  sections: 60,
  heading: 160,
  blocksPerSection: 40,
  paragraph: 3000,
  bulletItems: 40,
  bulletItem: 1000,
  /** Whole document, as JSON. */
  totalChars: 150_000,
} as const;

/** Every {{TOKEN}} a page may use. Anything else is refused on save. */
export const INFO_PAGE_TOKENS = [
  'BUSINESS_TRADE_NAME',
  'BUSINESS_LEGAL_NAME',
  'BUSINESS_TYPE',
  'BUSINESS_ADDRESS',
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
 * Settings a LEGAL page (privacy, terms) cannot be published without: who
 * operates the platform, where, and the grievance officer customers can write
 * to. The About page has no required settings.
 */
export const INFO_PAGE_REQUIRED_TOKENS: Readonly<Record<InfoPageSlug, readonly InfoPageToken[]>> = {
  privacy: ['BUSINESS_LEGAL_NAME', 'BUSINESS_ADDRESS', 'GRIEVANCE_OFFICER_NAME', 'GRIEVANCE_OFFICER_DESIGNATION', 'GRIEVANCE_OFFICER_EMAIL'],
  terms: ['BUSINESS_LEGAL_NAME', 'BUSINESS_ADDRESS', 'GRIEVANCE_OFFICER_NAME', 'GRIEVANCE_OFFICER_DESIGNATION', 'GRIEVANCE_OFFICER_EMAIL'],
  about: [],
};

/** Marks wording the owner still has to decide; a page containing it cannot be published. */
export const INFO_PAGE_UNCONFIRMED_MARKER = '«TO CONFIRM';

const TOKEN_PATTERN = /\{\{([A-Z_]+)\}\}/g;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z .\-]*$/;
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

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Checks an admin's page. Returns the cleaned content (trimmed text, empty
 * blocks and bullet items dropped) or every problem found.
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
  const version = checkText('version', raw['version'], INFO_PAGE_LIMITS.version, true);
  if (version && !VERSION_PATTERN.test(version)) add('version', 'use letters, numbers, dots or dashes, e.g. 2.0');
  const effectiveDate = typeof raw['effectiveDate'] === 'string' ? raw['effectiveDate'].trim() : '';
  if (!isValidDate(effectiveDate)) add('effectiveDate', 'must be a date (YYYY-MM-DD)');

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
  return { ok: true, content: { title, version, effectiveDate, sections } };
}

/** Wording still marked «TO CONFIRM» (publishing is refused while any remains). */
export function infoPageUnconfirmed(content: InfoPageContent): string[] {
  const found: string[] = [];
  for (const section of content.sections) {
    const texts = [section.heading, ...section.blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items))];
    for (const text of texts) if (text.includes(INFO_PAGE_UNCONFIRMED_MARKER)) found.push(text);
  }
  return found;
}

export interface ResolvedInfoPage {
  title: string;
  version: string;
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
  return { title, version: content.version, effectiveDate: content.effectiveDate, sections, missing: [...missing] };
}

/** One section's blocks as plain lines (bullets prefixed) — for app versions that only read `body`. */
export function infoPageBodyLines(section: InfoPageSection): string[] {
  return section.blocks.flatMap((block) => (block.type === 'paragraph' ? [block.text] : block.items.map((item) => `• ${item}`)));
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /legal/:slug. `sections[].body` is what app versions before this change
 * read (plain lines); `blocks` is the structured form the current app shows.
 * `source`: "published" (an admin-published revision) or "builtin" (nothing
 * published yet — the wording the app had before).
 */
export interface InfoPageDto {
  slug: InfoPageSlug;
  title: string;
  /** Last updated (the publish date; the built-in wording's own date otherwise). YYYY-MM-DD. */
  updatedAt: string;
  version: string | null;
  effectiveDate: string | null;
  revision: number;
  source: 'published' | 'builtin';
  sections: { heading: string; body: string[]; blocks: InfoPageBlock[] }[];
}

export interface InfoPageRevisionDto {
  id: string;
  revision: number;
  version: string;
  effectiveDate: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface InfoPageSettingDto {
  token: InfoPageToken;
  /** The Configuration setting it comes from. */
  configKey: string;
  label: string;
  filled: boolean;
  /** Required before a legal page can be published. */
  required: boolean;
}

/** GET /admin/content/pages/:slug */
export interface AdminInfoPageDto {
  slug: InfoPageSlug;
  published: (InfoPageRevisionDto & { content: InfoPageContent }) | null;
  draft: { basedOnRevision: number; updatedAt: string; updatedBy: string | null; content: InfoPageContent } | null;
  history: InfoPageRevisionDto[];
  /** The Aadione starting wording an admin can load into the draft. */
  template: InfoPageContent;
  settings: InfoPageSettingDto[];
}

/** POST /admin/content/pages/:slug/preview */
export interface InfoPagePreviewDto {
  page: ResolvedInfoPage;
  /** Required settings that are empty (publishing is refused until they are set). */
  missingRequired: InfoPageToken[];
  unconfirmed: string[];
}

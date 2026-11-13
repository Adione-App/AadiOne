/**
 * Information pages — Privacy Policy ("legal_privacy"), Terms & Conditions
 * ("legal_terms") and About Aadione ("page_about") — on the same
 * content_documents revisions as the Home layout (home-layout.service.ts):
 *
 *   draft      saved freely by an admin; never shown to customers, and
 *              saving it never changes the public "Last updated" date
 *   publish    validates the draft (shared validateInfoPage), refuses a page
 *              still containing «TO CONFIRM» wording, and refuses a LEGAL
 *              page while a requirement (operator, address, customer-care
 *              contact, grievance officer) is unmet; then archives the current
 *              revision and makes the draft revision N+1 in ONE transaction.
 *              N+1 is the public Version, and the server clock's publish
 *              moment is the public "Last updated" date (India). A "takes
 *              effect" date on or before the publish day is dropped — a page
 *              is never backdated
 *   restore    copies an earlier revision's TEXT into the draft (publish to
 *              apply). Publishing it creates a NEW version dated that day;
 *              the earlier version's own dates stay untouched in the history
 *
 * Customers get the published revision, with its {{TOKENS}} filled from
 * Admin Configuration on every read (shared resolveInfoPage: a line whose
 * setting is empty is left out). The published ROW is cached for a minute and
 * dropped on publish; the settings themselves come through the configuration
 * cache, so an updated phone number shows without a new publish.
 *
 * Nothing is ever published automatically. Until an admin publishes, the
 * privacy policy and terms are the built-in wording the app always had
 * (legal.content.ts) and the About page has no published content (the app
 * shows its own screen). The Aadione templates (legal/info-page-templates.ts)
 * are offered to the admin as a starting draft only.
 *
 * Every write is audited (entityType "ContentDocument").
 */

import { ContentDocumentStatus, Prisma, type ContentDocument } from '@prisma/client';
import {
  ConfigKey,
  ErrorCode,
  INFO_PAGE_KEYS,
  INFO_PAGE_LIMITS,
  INFO_PAGE_REQUIREMENTS,
  INFO_PAGE_TOKENS,
  SOCIAL_NETWORK_LABELS,
  effectiveDateAfter,
  formatInfoPageDate,
  formatPaise,
  indiaDateOf,
  infoPageBodyLines,
  infoPageUnconfirmed,
  infoPageUnmetRequirements,
  infoSectionAnchors,
  resolveInfoPage,
  validateInfoPage,
  webHref,
  asksForAcceptance,
  INFO_PAGE_AUDIENCE,
  INFO_PAGE_TITLES,
  type AcceptanceSlug,
  type InfoPageIndexEntryDto,
  type AdminInfoPageDto,
  type InfoPageVersionSummaryDto,
  type BusinessInfoDto,
  type InfoPageContent,
  type InfoPageDto,
  type InfoPagePreviewDto,
  type InfoPageRevisionDto,
  type InfoPageSettingDto,
  type InfoPageSlug,
  type InfoPageToken,
  type InfoPageValues,
  type SocialNetwork,
} from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { cache } from '../../infra/cache';
import * as configService from '../configuration/configuration.service';
import { INFO_PAGE_TEMPLATES } from '../legal/info-page-templates';
import { BUILTIN_INFO_PAGES } from '../legal/legal.content';

const log = moduleLogger('content');

const CACHE_SECONDS = 60;
const HISTORY_LIMIT = 20;
const cacheKey = (slug: InfoPageSlug) => `content:${INFO_PAGE_KEYS[slug]}`;

/* -------------------------------------------------------------------------- */
/* Settings → tokens                                                           */
/* -------------------------------------------------------------------------- */

/** Where each token's value comes from, and its label in the Admin Panel. */
const TOKEN_SOURCES: Readonly<Record<InfoPageToken, { configKey: string; label: string }>> = {
  BUSINESS_TRADE_NAME: { configKey: ConfigKey.BUSINESS_TRADE_NAME, label: 'Brand name' },
  BUSINESS_LEGAL_NAME: { configKey: ConfigKey.BUSINESS_LEGAL_NAME, label: 'Legal name (as on PAN / GST)' },
  BUSINESS_PROPRIETOR_NAME: { configKey: ConfigKey.BUSINESS_PROPRIETOR_NAME, label: 'Proprietor name' },
  BUSINESS_TYPE: { configKey: ConfigKey.BUSINESS_TYPE, label: 'Business structure' },
  BUSINESS_ADDRESS: { configKey: ConfigKey.BUSINESS_ADDRESS, label: 'Principal place of business' },
  BUSINESS_WEBSITE: { configKey: ConfigKey.BUSINESS_WEBSITE, label: 'Website' },
  GSTIN: { configKey: ConfigKey.STORE_GSTIN, label: 'GSTIN' },
  SUPPORT_EMAIL: { configKey: ConfigKey.SUPPORT_EMAIL, label: 'Support email' },
  SUPPORT_PHONE: { configKey: ConfigKey.SUPPORT_PHONE, label: 'Support phone' },
  SUPPORT_WHATSAPP: { configKey: ConfigKey.SUPPORT_WHATSAPP, label: 'Support WhatsApp' },
  SUPPORT_HOURS: { configKey: ConfigKey.SUPPORT_HOURS, label: 'Support hours' },
  GRIEVANCE_OFFICER_NAME: { configKey: ConfigKey.GRIEVANCE_OFFICER_NAME, label: 'Grievance Officer name' },
  GRIEVANCE_OFFICER_DESIGNATION: { configKey: ConfigKey.GRIEVANCE_OFFICER_DESIGNATION, label: 'Grievance Officer designation' },
  GRIEVANCE_OFFICER_EMAIL: { configKey: ConfigKey.GRIEVANCE_OFFICER_EMAIL, label: 'Grievance Officer email' },
  GRIEVANCE_OFFICER_PHONE: { configKey: ConfigKey.GRIEVANCE_OFFICER_PHONE, label: 'Grievance Officer phone' },
  GRIEVANCE_OFFICER_ADDRESS: { configKey: ConfigKey.GRIEVANCE_OFFICER_ADDRESS, label: 'Grievance Officer address (or the business address)' },
  MIN_ORDER_VALUE: { configKey: ConfigKey.MIN_ORDER_VALUE_PAISE, label: 'Minimum order value' },
  FREE_DELIVERY_THRESHOLD: { configKey: ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE, label: 'Free delivery from' },
  PLATFORM_FEE: { configKey: ConfigKey.PLATFORM_FEE_PAISE, label: 'Platform fee' },
};

const money = (paise: number): string => (Number.isFinite(paise) && paise > 0 ? formatPaise(paise) : '');
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const SOCIAL_KEYS: Readonly<Record<SocialNetwork, ConfigKey>> = {
  instagram: ConfigKey.SOCIAL_INSTAGRAM_URL,
  facebook: ConfigKey.SOCIAL_FACEBOOK_URL,
  x: ConfigKey.SOCIAL_X_URL,
  youtube: ConfigKey.SOCIAL_YOUTUBE_URL,
  linkedin: ConfigKey.SOCIAL_LINKEDIN_URL,
};

/** Today's token values, from Admin Configuration. An empty setting is an empty value (its lines are left out). */
export async function infoPageValues(): Promise<InfoPageValues> {
  const c = await configService.getMany([
    ConfigKey.BUSINESS_TRADE_NAME,
    ConfigKey.BUSINESS_LEGAL_NAME,
    ConfigKey.BUSINESS_PROPRIETOR_NAME,
    ConfigKey.BUSINESS_TYPE,
    ConfigKey.BUSINESS_ADDRESS,
    ConfigKey.BUSINESS_WEBSITE,
    ConfigKey.STORE_GSTIN,
    ConfigKey.SUPPORT_EMAIL,
    ConfigKey.SUPPORT_PHONE,
    ConfigKey.SUPPORT_WHATSAPP,
    ConfigKey.SUPPORT_HOURS,
    ConfigKey.GRIEVANCE_OFFICER_NAME,
    ConfigKey.GRIEVANCE_OFFICER_DESIGNATION,
    ConfigKey.GRIEVANCE_OFFICER_EMAIL,
    ConfigKey.GRIEVANCE_OFFICER_PHONE,
    ConfigKey.GRIEVANCE_OFFICER_ADDRESS,
    ConfigKey.MIN_ORDER_VALUE_PAISE,
    ConfigKey.FREE_DELIVERY_THRESHOLD_PAISE,
    ConfigKey.PLATFORM_FEE_PAISE,
  ]);
  return {
    BUSINESS_TRADE_NAME: text(c.BUSINESS_TRADE_NAME),
    BUSINESS_LEGAL_NAME: text(c.BUSINESS_LEGAL_NAME),
    BUSINESS_PROPRIETOR_NAME: text(c.BUSINESS_PROPRIETOR_NAME),
    BUSINESS_TYPE: text(c.BUSINESS_TYPE),
    BUSINESS_ADDRESS: text(c.BUSINESS_ADDRESS),
    BUSINESS_WEBSITE: text(c.BUSINESS_WEBSITE),
    GSTIN: text(c.STORE_GSTIN),
    SUPPORT_EMAIL: text(c.SUPPORT_EMAIL),
    SUPPORT_PHONE: text(c.SUPPORT_PHONE),
    SUPPORT_WHATSAPP: text(c.SUPPORT_WHATSAPP),
    SUPPORT_HOURS: text(c.SUPPORT_HOURS),
    GRIEVANCE_OFFICER_NAME: text(c.GRIEVANCE_OFFICER_NAME),
    GRIEVANCE_OFFICER_DESIGNATION: text(c.GRIEVANCE_OFFICER_DESIGNATION),
    GRIEVANCE_OFFICER_EMAIL: text(c.GRIEVANCE_OFFICER_EMAIL),
    GRIEVANCE_OFFICER_PHONE: text(c.GRIEVANCE_OFFICER_PHONE),
    // Its own address when set, else the business address.
    GRIEVANCE_OFFICER_ADDRESS: text(c.GRIEVANCE_OFFICER_ADDRESS) || text(c.BUSINESS_ADDRESS),
    MIN_ORDER_VALUE: money(c.MIN_ORDER_VALUE_PAISE),
    FREE_DELIVERY_THRESHOLD: money(c.FREE_DELIVERY_THRESHOLD_PAISE),
    PLATFORM_FEE: money(c.PLATFORM_FEE_PAISE),
  };
}

/**
 * GET /legal/business — who runs Aadione and how to reach them, for the app's
 * About screen and the website. Every value is a Configuration setting; an
 * empty one is null (hidden by the reader), never a stand-in.
 */
export async function getBusinessInfo(): Promise<BusinessInfoDto> {
  const [values, socials] = await Promise.all([infoPageValues(), configService.getMany(Object.values(SOCIAL_KEYS))]);
  const value = (token: InfoPageToken): string | null => values[token]?.trim() || null;
  const website = value('BUSINESS_WEBSITE');
  return {
    tradeName: value('BUSINESS_TRADE_NAME') ?? 'Aadione',
    legalName: value('BUSINESS_LEGAL_NAME'),
    proprietorName: value('BUSINESS_PROPRIETOR_NAME'),
    businessType: value('BUSINESS_TYPE'),
    address: value('BUSINESS_ADDRESS'),
    gstin: value('GSTIN'),
    website: website && webHref(website) ? website : null,
    support: { email: value('SUPPORT_EMAIL'), phone: value('SUPPORT_PHONE'), whatsapp: value('SUPPORT_WHATSAPP'), hours: value('SUPPORT_HOURS') },
    grievanceOfficer: {
      name: value('GRIEVANCE_OFFICER_NAME'),
      designation: value('GRIEVANCE_OFFICER_DESIGNATION'),
      email: value('GRIEVANCE_OFFICER_EMAIL'),
      phone: value('GRIEVANCE_OFFICER_PHONE'),
      address: value('GRIEVANCE_OFFICER_ADDRESS'),
    },
    socials: (Object.keys(SOCIAL_KEYS) as SocialNetwork[]).flatMap((network) => {
      const url = text((socials as Record<string, unknown>)[SOCIAL_KEYS[network]]);
      return url.startsWith('https://') ? [{ network, label: SOCIAL_NETWORK_LABELS[network], url }] : [];
    }),
  };
}

/** Unmet publishing requirements as labels ("Support email or Support phone"). */
function missingRequired(slug: InfoPageSlug, values: InfoPageValues): string[] {
  return infoPageUnmetRequirements(slug, values).map((anyOf) => anyOf.map((token) => TOKEN_SOURCES[token].label).join(' or '));
}

function settingsDto(slug: InfoPageSlug, values: InfoPageValues): InfoPageSettingDto[] {
  const required = new Set<InfoPageToken>(INFO_PAGE_REQUIREMENTS[slug].flat());
  return INFO_PAGE_TOKENS.map((token) => ({
    token,
    configKey: TOKEN_SOURCES[token].configKey,
    label: TOKEN_SOURCES[token].label,
    filled: Boolean(values[token]?.trim()),
    required: required.has(token),
  }));
}

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

function toPublicDto(
  slug: InfoPageSlug,
  content: InfoPageContent,
  values: InfoPageValues,
  meta: { revision: number; updatedAt: string; publishedAt: string | null; source: InfoPageDto['source'] },
): InfoPageDto {
  const page = resolveInfoPage(content, values);
  const published = meta.source === 'published';
  const effectiveDate = published ? effectiveDateAfter(page.effectiveDate, meta.updatedAt) : null;
  const anchors = infoSectionAnchors(page.sections.map((section) => section.heading));
  return {
    slug,
    title: page.title,
    updatedAt: meta.updatedAt,
    lastUpdatedLabel: formatInfoPageDate(meta.updatedAt),
    publishedAt: meta.publishedAt,
    version: published ? String(meta.revision) : null,
    effectiveDate,
    effectiveLabel: effectiveDate ? formatInfoPageDate(effectiveDate) : null,
    revision: meta.revision,
    source: meta.source,
    sections: page.sections.map((section, s) => ({ id: anchors[s]!, heading: section.heading, body: infoPageBodyLines(section), blocks: section.blocks })),
  };
}

interface CachedPublished {
  revision: number;
  publishedAt: string | null;
  content: InfoPageContent;
}

async function loadPublished(slug: InfoPageSlug): Promise<CachedPublished | null> {
  const key = cacheKey(slug);
  const cached = await cache.get(key).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedPublished | { none: true };
      return 'none' in parsed ? null : parsed;
    } catch {
      // A damaged cache entry is simply rebuilt.
    }
  }
  const row = await prisma.contentDocument.findFirst({ where: { key: INFO_PAGE_KEYS[slug], status: ContentDocumentStatus.PUBLISHED } });
  const checked = row ? validateInfoPage(row.content) : null;
  const value: CachedPublished | null =
    row && checked?.ok ? { revision: row.revision, publishedAt: row.publishedAt?.toISOString() ?? null, content: checked.content } : null;
  if (row && !checked?.ok) log.error({ key: INFO_PAGE_KEYS[slug], id: row.id }, 'published information page failed validation — serving the built-in wording');
  await cache.set(key, JSON.stringify(value ?? { none: true }), CACHE_SECONDS).catch((error: unknown) => log.warn({ err: error }, 'information page not cached'));
  return value;
}

/**
 * GET /legal/:slug — the published page with today's settings, or the
 * built-in wording while nothing is published. Null: no content at all (the
 * About page before its first publish — the app shows its own screen).
 */
export async function getPublicInfoPage(slug: InfoPageSlug): Promise<InfoPageDto | null> {
  const [published, values] = await Promise.all([loadPublished(slug), infoPageValues()]);
  if (published) {
    return toPublicDto(slug, published.content, values, {
      revision: published.revision,
      // The India calendar day of the server's publish moment.
      updatedAt: indiaDateOf(published.publishedAt ?? new Date()),
      publishedAt: published.publishedAt,
      source: 'published',
    });
  }
  const builtin = BUILTIN_INFO_PAGES[slug];
  if (!builtin) return null;
  return toPublicDto(slug, builtin.content, values, { revision: 0, updatedAt: builtin.updatedAt, publishedAt: null, source: 'builtin' });
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((user) => [user.id, user.fullName ?? user.email ?? 'Admin']));
}

/** A stored revision's content; an unreadable one (never expected) shows as the template so it can be fixed. */
function storedContent(slug: InfoPageSlug, row: ContentDocument): InfoPageContent {
  const checked = validateInfoPage(row.content);
  return checked.ok ? checked.content : INFO_PAGE_TEMPLATES[slug];
}

const revisionDto = (slug: InfoPageSlug, row: ContentDocument, names: Map<string, string>): InfoPageRevisionDto => {
  const content = storedContent(slug, row);
  return {
    id: row.id,
    revision: row.revision,
    version: String(row.revision),
    effectiveDate: content.effectiveDate,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    lastUpdatedLabel: row.publishedAt ? formatInfoPageDate(indiaDateOf(row.publishedAt)) : '',
    publishedBy: row.publishedByUserId ? names.get(row.publishedByUserId) ?? null : null,
    restoredFromVersion: content.restoredFromVersion ?? null,
    requiresAcceptance: content.requiresAcceptance === true,
  };
};

/** The template as a starting draft: it applies from its publication (no date to go stale). */
function templateFor(slug: InfoPageSlug): InfoPageContent {
  return structuredClone({ ...INFO_PAGE_TEMPLATES[slug], effectiveDate: '' });
}

/** The revision number the next publish of a page gets (every earlier one, archived or live, counts). */
async function nextRevision(db: Pick<Prisma.TransactionClient, 'contentDocument'>, key: string): Promise<number> {
  const max = await db.contentDocument.aggregate({ where: { key, status: { not: ContentDocumentStatus.DRAFT } }, _max: { revision: true } });
  return (max._max.revision ?? 0) + 1;
}

/** The "takes effect" date a page is published with on `today`: a later date, or '' (from publication). */
function effectiveOnPublish(content: InfoPageContent, today: string): string {
  return effectiveDateAfter(content.effectiveDate, today) ?? '';
}

function assertEffectiveDateInRange(content: InfoPageContent, today: string): void {
  if (!content.effectiveDate) return;
  const limit = indiaDateOf(new Date(Date.parse(`${today}T00:00:00Z`) + INFO_PAGE_LIMITS.effectiveDaysAhead * 86_400_000));
  if (content.effectiveDate > limit) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `The "takes effect" date can be at most ${INFO_PAGE_LIMITS.effectiveDaysAhead} days ahead.` });
  }
}

/** GET /admin/content/pages/:slug — published, draft, history, template and the settings it uses. */
export async function getAdminInfoPage(slug: InfoPageSlug): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  const [rows, values, nextVersion] = await Promise.all([
    prisma.contentDocument.findMany({ where: { key }, orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }], take: HISTORY_LIMIT + 2 }),
    infoPageValues(),
    nextRevision(prisma, key),
  ]);
  const published = rows.find((row) => row.status === ContentDocumentStatus.PUBLISHED) ?? null;
  const draft = rows.find((row) => row.status === ContentDocumentStatus.DRAFT) ?? null;
  const archived = rows.filter((row) => row.status === ContentDocumentStatus.ARCHIVED).slice(0, HISTORY_LIMIT);
  const names = await userNames(rows.flatMap((row) => [row.updatedByUserId, row.publishedByUserId]));
  return {
    slug,
    published: published ? { ...revisionDto(slug, published, names), content: storedContent(slug, published) } : null,
    draft: draft
      ? {
          basedOnRevision: draft.revision,
          updatedAt: draft.updatedAt.toISOString(),
          updatedBy: draft.updatedByUserId ? names.get(draft.updatedByUserId) ?? null : null,
          content: storedContent(slug, draft),
        }
      : null,
    history: archived.map((row) => revisionDto(slug, row, names)),
    live: published
      ? { source: 'published', version: String(published.revision), lastUpdatedLabel: formatInfoPageDate(indiaDateOf(published.publishedAt ?? published.updatedAt)) }
      : { source: 'builtin', version: null, lastUpdatedLabel: formatInfoPageDate(BUILTIN_INFO_PAGES[slug]?.updatedAt) },
    nextVersion,
    acceptanceEverRequired:
      asksForAcceptance(slug) && rows.some((row) => row.status !== ContentDocumentStatus.DRAFT && storedContent(slug, row).requiresAcceptance === true),
    missingRequired: missingRequired(slug, values),
    template: templateFor(slug),
    settings: settingsDto(slug, values),
  };
}

function assertValid(input: unknown): InfoPageContent {
  const checked = validateInfoPage(input);
  if (checked.ok) return checked.content;
  const first = checked.problems[0]!;
  throw new AppError(ErrorCode.VALIDATION_ERROR, {
    message: checked.problems.length === 1 ? `${first.field}: ${first.message}` : `${first.field}: ${first.message} (and ${checked.problems.length - 1} more to fix)`,
    details: checked.problems.map((problem) => ({ field: problem.field, message: problem.message })),
  });
}

/** POST /admin/content/pages/:slug/preview — any page (the unsaved one on screen) as customers would see it if published now. Nothing is stored. */
export async function previewInfoPage(slug: InfoPageSlug, input: unknown): Promise<InfoPagePreviewDto> {
  const content = assertValid(input);
  const [values, version] = await Promise.all([infoPageValues(), nextRevision(prisma, INFO_PAGE_KEYS[slug])]);
  const today = indiaDateOf(new Date());
  const effective = effectiveOnPublish(content, today);
  return {
    page: resolveInfoPage(content, values),
    missingRequired: missingRequired(slug, values),
    unconfirmed: infoPageUnconfirmed(content),
    onPublish: { version: String(version), lastUpdatedLabel: formatInfoPageDate(today), effectiveLabel: effective ? formatInfoPageDate(effective) : null },
  };
}

async function audit(tx: Prisma.TransactionClient, actorUserId: string, action: string, entityId: string, before: unknown, after: unknown) {
  await tx.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType: 'ContentDocument',
      entityId,
      before: (before ?? null) as Prisma.InputJsonValue,
      after: (after ?? null) as Prisma.InputJsonValue,
    },
  });
}

/** Serialises every write to one page (two admins saving at once queue here). */
async function lockDocument(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`content_documents:${key}`}))`;
}

const asJson = (content: InfoPageContent) => content as unknown as Prisma.InputJsonValue;

/** PUT /admin/content/pages/:slug/draft — saves the draft (validated; never shown to customers). */
export async function saveInfoPageDraft(slug: InfoPageSlug, input: unknown, actorUserId: string): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  const content = assertValid(input);
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx, key);
    const [draft, published] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.PUBLISHED }, select: { revision: true } }),
    ]);
    if (draft) {
      await tx.contentDocument.update({ where: { id: draft.id }, data: { content: asJson(content), updatedByUserId: actorUserId } });
      await audit(tx, actorUserId, 'content.draft.update', draft.id, null, { key, basedOnRevision: draft.revision });
    } else {
      const created = await tx.contentDocument.create({
        data: { key, status: ContentDocumentStatus.DRAFT, revision: published?.revision ?? 0, content: asJson(content), updatedByUserId: actorUserId },
      });
      await audit(tx, actorUserId, 'content.draft.create', created.id, null, { key, basedOnRevision: created.revision });
    }
  });
  return getAdminInfoPage(slug);
}

/** DELETE /admin/content/pages/:slug/draft — throws away unpublished changes. */
export async function discardInfoPageDraft(slug: InfoPageSlug, actorUserId: string): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx, key);
    const draft = await tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } });
    if (!draft) return;
    await tx.contentDocument.delete({ where: { id: draft.id } });
    await audit(tx, actorUserId, 'content.draft.discard', draft.id, { key, basedOnRevision: draft.revision }, null);
  });
  return getAdminInfoPage(slug);
}

/**
 * POST /admin/content/pages/:slug/publish — the draft becomes the next
 * published revision. `basedOnRevision` (what the admin's screen showed) must
 * still be the live revision: if someone else published meanwhile, nothing
 * changes and the admin is asked to reload.
 */
export async function publishInfoPage(
  slug: InfoPageSlug,
  basedOnRevision: number,
  actorUserId: string,
  requireAcceptance?: boolean,
): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  const draft = await prisma.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } });
  if (!draft) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'There are no unpublished changes to publish.' });
  const content = assertValid(draft.content);

  const unconfirmed = infoPageUnconfirmed(content);
  if (unconfirmed.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Replace every «TO CONFIRM» note with the final wording before publishing (${unconfirmed.length} left).`,
      details: unconfirmed.slice(0, 20).map((item) => ({ field: item.section, message: item.text.slice(0, 200) })),
    });
  }
  const values = await infoPageValues();
  const unmet = infoPageUnmetRequirements(slug, values);
  if (unmet.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Fill these settings in Configuration → Business, Support & Grievance Officer before publishing: ${missingRequired(slug, values).join(', ')}.`,
      details: unmet.map((anyOf) => ({ field: anyOf.map((token) => TOKEN_SOURCES[token].configKey).join(' | '), message: 'required' })),
    });
  }
  const today = indiaDateOf(new Date());
  assertEffectiveDateInRange(content, today);
  // Documents users accept (customer Privacy / Terms, Seller Terms / Seller
  // Privacy): ask signed-in users to accept this version? The admin decides;
  // a page's FIRST publication always asks. Never for the other pages.
  const isLegal = asksForAcceptance(slug);
  const askedBefore =
    isLegal &&
    (await prisma.contentDocument.findMany({ where: { key, status: { not: ContentDocumentStatus.DRAFT } }, select: { content: true } })).some(
      (row) => (row.content as { requiresAcceptance?: unknown } | null)?.requiresAcceptance === true,
    );
  const asks = isLegal && (requireAcceptance ?? !askedBefore);
  const { requiresAcceptance: _ignored, ...rest } = content;
  const finalContent: InfoPageContent = { ...rest, effectiveDate: effectiveOnPublish(content, today), ...(asks ? { requiresAcceptance: true } : {}) };

  await prisma.$transaction(async (tx) => {
    await lockDocument(tx, key);
    const [current, latestDraft] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.PUBLISHED } }),
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } }),
    ]);
    const liveRevision = current?.revision ?? 0;
    if (!latestDraft || latestDraft.id !== draft.id || latestDraft.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'The draft changed while publishing. Reload and publish again.' });
    }
    if (basedOnRevision !== liveRevision || draft.revision !== liveRevision) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'Someone published a newer version meanwhile. Reload to see it before publishing.' });
    }
    const next = await nextRevision(tx, key);
    // The server's clock, never a date typed by an admin.
    const publishedAt = new Date();
    if (current) await tx.contentDocument.update({ where: { id: current.id }, data: { status: ContentDocumentStatus.ARCHIVED } });
    await tx.contentDocument.update({
      where: { id: draft.id },
      data: { status: ContentDocumentStatus.PUBLISHED, revision: next, content: asJson(finalContent), publishedAt, publishedByUserId: actorUserId },
    });
    await audit(tx, actorUserId, 'content.publish', draft.id, current ? { key, revision: current.revision } : null, {
      key,
      revision: next,
      version: String(next),
      publishedAt: publishedAt.toISOString(),
      lastUpdated: indiaDateOf(publishedAt),
      effectiveDate: finalContent.effectiveDate || null,
      restoredFromVersion: finalContent.restoredFromVersion ?? null,
      requiresAcceptance: asks,
    });
  });
  await cache.delete(cacheKey(slug)).catch((error: unknown) => log.warn({ err: error }, 'information page cache not cleared — refreshes within a minute'));
  return getAdminInfoPage(slug);
}

/**
 * POST /admin/content/pages/:slug/restore/:id — an earlier revision's text
 * becomes the draft (publish to apply it). Its old "takes effect" date is
 * dropped and the draft remembers where it came from; publishing it creates a
 * new version dated that day, and the earlier version keeps its own dates.
 */
export async function restoreInfoPageRevision(slug: InfoPageSlug, id: string, actorUserId: string): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx, key);
    const source = await tx.contentDocument.findFirst({ where: { id, key, status: { not: ContentDocumentStatus.DRAFT } } });
    if (!source) throw new AppError(ErrorCode.NOT_FOUND, { message: 'That version was not found.' });
    const [draft, published] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.PUBLISHED }, select: { revision: true } }),
    ]);
    const content = asJson({ ...storedContent(slug, source), effectiveDate: '', restoredFromVersion: source.revision });
    const base = published?.revision ?? 0;
    const row = draft
      ? await tx.contentDocument.update({ where: { id: draft.id }, data: { content, revision: base, updatedByUserId: actorUserId } })
      : await tx.contentDocument.create({ data: { key, status: ContentDocumentStatus.DRAFT, revision: base, content, updatedByUserId: actorUserId } });
    await audit(tx, actorUserId, 'content.draft.restore', row.id, null, { key, fromRevision: source.revision });
  });
  return getAdminInfoPage(slug);
}

/* -------------------------------------------------------------------------- */
/* Versions customers accept (legal/legal-consent.service.ts)                  */
/* -------------------------------------------------------------------------- */

export interface LegalPageVersions {
  /** The published revision now, and its row. */
  current: { revision: number; documentId: string };
  /** The latest revision an admin marked as needing acceptance (or the first published one). */
  required: number;
}

/** A document users accept: what is published and which version they must have accepted; null while unpublished. */
export async function legalPageVersions(slug: AcceptanceSlug): Promise<LegalPageVersions | null> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: INFO_PAGE_KEYS[slug], status: { not: ContentDocumentStatus.DRAFT } },
    select: { id: true, revision: true, status: true, content: true },
    orderBy: { revision: 'asc' },
  });
  const current = rows.find((row) => row.status === ContentDocumentStatus.PUBLISHED);
  if (!current) return null;
  const flagged = rows.filter((row) => (row.content as { requiresAcceptance?: unknown } | null)?.requiresAcceptance === true);
  const required = flagged.length > 0 ? flagged[flagged.length - 1]!.revision : rows[0]!.revision;
  return { current: { revision: current.revision, documentId: current.id }, required };
}

/* -------------------------------------------------------------------------- */
/* Earlier versions, public (GET /legal/:slug/versions[/:version])             */
/* -------------------------------------------------------------------------- */

/** Every published version of a page, newest first; empty while never published. */
export async function listPublicInfoPageVersions(slug: InfoPageSlug): Promise<InfoPageVersionSummaryDto[]> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: INFO_PAGE_KEYS[slug], status: { not: ContentDocumentStatus.DRAFT } },
    orderBy: { revision: 'desc' },
    select: { revision: true, status: true, publishedAt: true, content: true },
  });
  return rows.map((row) => {
    const publishedOn = indiaDateOf(row.publishedAt ?? new Date());
    const effective = effectiveDateAfter((row.content as { effectiveDate?: string } | null)?.effectiveDate, publishedOn);
    return {
      version: String(row.revision),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      lastUpdatedLabel: formatInfoPageDate(publishedOn),
      effectiveLabel: effective ? formatInfoPageDate(effective) : null,
      isLatest: row.status === ContentDocumentStatus.PUBLISHED,
    };
  });
}

/**
 * One published version — the latest or an earlier one, never a draft — so
 * the exact text someone accepted stays readable after a newer version is
 * published. Its business details are today's settings (as on every read).
 */
export async function getPublicInfoPageVersion(slug: InfoPageSlug, revision: number): Promise<InfoPageDto | null> {
  const row = await prisma.contentDocument.findFirst({
    where: { key: INFO_PAGE_KEYS[slug], revision, status: { not: ContentDocumentStatus.DRAFT } },
  });
  if (!row) return null;
  const checked = validateInfoPage(row.content);
  if (!checked.ok) return null;
  const values = await infoPageValues();
  return {
    ...toPublicDto(slug, checked.content, values, {
      revision: row.revision,
      updatedAt: indiaDateOf(row.publishedAt ?? row.updatedAt),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      source: 'published',
    }),
    isLatest: row.status === ContentDocumentStatus.PUBLISHED,
  };
}

/** Pages a reader can open now: privacy and terms always (built-in wording), the others once published. */
export async function availableInfoPageSlugs(): Promise<InfoPageSlug[]> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: { in: Object.values(INFO_PAGE_KEYS) }, status: ContentDocumentStatus.PUBLISHED },
    select: { key: true },
  });
  const published = new Set(rows.map((row) => row.key));
  return (Object.keys(INFO_PAGE_KEYS) as InfoPageSlug[]).filter((slug) => published.has(INFO_PAGE_KEYS[slug]) || BUILTIN_INFO_PAGES[slug] !== undefined);
}

/** GET /legal/pages — every page a reader can open now, with its version and date. */
export async function listAvailableInfoPages(): Promise<InfoPageIndexEntryDto[]> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: { in: Object.values(INFO_PAGE_KEYS) }, status: ContentDocumentStatus.PUBLISHED },
    select: { key: true, revision: true, publishedAt: true, content: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const entries: InfoPageIndexEntryDto[] = [];
  for (const slug of Object.keys(INFO_PAGE_KEYS) as InfoPageSlug[]) {
    const row = byKey.get(INFO_PAGE_KEYS[slug]);
    if (row) {
      const title = (row.content as { title?: unknown } | null)?.title;
      entries.push({
        slug,
        title: typeof title === 'string' && title.trim() && !title.includes('{{') ? title.trim() : INFO_PAGE_TITLES[slug],
        audience: INFO_PAGE_AUDIENCE[slug],
        version: String(row.revision),
        lastUpdatedLabel: formatInfoPageDate(indiaDateOf(row.publishedAt ?? new Date())),
        source: 'published',
      });
    } else if (BUILTIN_INFO_PAGES[slug]) {
      entries.push({
        slug,
        title: INFO_PAGE_TITLES[slug],
        audience: INFO_PAGE_AUDIENCE[slug],
        version: null,
        lastUpdatedLabel: formatInfoPageDate(BUILTIN_INFO_PAGES[slug]!.updatedAt),
        source: 'builtin',
      });
    }
  }
  return entries;
}

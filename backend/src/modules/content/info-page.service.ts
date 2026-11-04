/**
 * Information pages — Privacy Policy ("legal_privacy"), Terms & Conditions
 * ("legal_terms") and About Aadione ("page_about") — on the same
 * content_documents revisions as the Home layout (home-layout.service.ts):
 *
 *   draft      saved freely by an admin; never shown to customers
 *   publish    validates the draft (shared validateInfoPage), refuses a page
 *              still containing «TO CONFIRM» wording, and refuses a LEGAL
 *              page while a required setting (operator, address, grievance
 *              officer) is empty; then archives the current revision and makes
 *              the draft revision N+1 in ONE transaction
 *   restore    copies an earlier revision into the draft (publish to apply)
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
  INFO_PAGE_REQUIRED_TOKENS,
  INFO_PAGE_TOKENS,
  formatPaise,
  infoPageBodyLines,
  infoPageUnconfirmed,
  resolveInfoPage,
  validateInfoPage,
  type AdminInfoPageDto,
  type InfoPageContent,
  type InfoPageDto,
  type InfoPagePreviewDto,
  type InfoPageRevisionDto,
  type InfoPageSettingDto,
  type InfoPageSlug,
  type InfoPageToken,
  type InfoPageValues,
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
  BUSINESS_TYPE: { configKey: ConfigKey.BUSINESS_TYPE, label: 'Business structure' },
  BUSINESS_ADDRESS: { configKey: ConfigKey.BUSINESS_ADDRESS, label: 'Principal place of business' },
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

/** Today's token values, from Admin Configuration. An empty setting is an empty value (its lines are left out). */
export async function infoPageValues(): Promise<InfoPageValues> {
  const c = await configService.getMany([
    ConfigKey.BUSINESS_TRADE_NAME,
    ConfigKey.BUSINESS_LEGAL_NAME,
    ConfigKey.BUSINESS_TYPE,
    ConfigKey.BUSINESS_ADDRESS,
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
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  return {
    BUSINESS_TRADE_NAME: text(c.BUSINESS_TRADE_NAME),
    BUSINESS_LEGAL_NAME: text(c.BUSINESS_LEGAL_NAME),
    BUSINESS_TYPE: text(c.BUSINESS_TYPE),
    BUSINESS_ADDRESS: text(c.BUSINESS_ADDRESS),
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

function settingsDto(slug: InfoPageSlug, values: InfoPageValues): InfoPageSettingDto[] {
  const required = new Set(INFO_PAGE_REQUIRED_TOKENS[slug]);
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
  meta: { revision: number; updatedAt: string; source: InfoPageDto['source']; versioned: boolean },
): InfoPageDto {
  const page = resolveInfoPage(content, values);
  return {
    slug,
    title: page.title,
    updatedAt: meta.updatedAt,
    version: meta.versioned ? page.version : null,
    effectiveDate: meta.versioned ? page.effectiveDate : null,
    revision: meta.revision,
    source: meta.source,
    sections: page.sections.map((section) => ({ heading: section.heading, body: infoPageBodyLines(section), blocks: section.blocks })),
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
      updatedAt: published.publishedAt?.slice(0, 10) ?? published.content.effectiveDate,
      source: 'published',
      versioned: true,
    });
  }
  const builtin = BUILTIN_INFO_PAGES[slug];
  if (!builtin) return null;
  return toPublicDto(slug, builtin.content, values, { revision: 0, updatedAt: builtin.updatedAt, source: 'builtin', versioned: false });
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
    version: content.version,
    effectiveDate: content.effectiveDate,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedByUserId ? names.get(row.publishedByUserId) ?? null : null,
  };
};

/** The template, dated today (India) so a fresh draft does not start with a stale date. */
function templateFor(slug: InfoPageSlug): InfoPageContent {
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return { ...INFO_PAGE_TEMPLATES[slug], effectiveDate: today };
}

/** GET /admin/content/pages/:slug — published, draft, history, template and the settings it uses. */
export async function getAdminInfoPage(slug: InfoPageSlug): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  const [rows, values] = await Promise.all([
    prisma.contentDocument.findMany({ where: { key }, orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }], take: HISTORY_LIMIT + 2 }),
    infoPageValues(),
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

function missingRequired(slug: InfoPageSlug, values: InfoPageValues): InfoPageToken[] {
  return INFO_PAGE_REQUIRED_TOKENS[slug].filter((token) => !values[token]?.trim());
}

/** POST /admin/content/pages/:slug/preview — any page (the unsaved one on screen) as customers would see it now. */
export async function previewInfoPage(slug: InfoPageSlug, input: unknown): Promise<InfoPagePreviewDto> {
  const content = assertValid(input);
  const values = await infoPageValues();
  return { page: resolveInfoPage(content, values), missingRequired: missingRequired(slug, values), unconfirmed: infoPageUnconfirmed(content) };
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
export async function publishInfoPage(slug: InfoPageSlug, basedOnRevision: number, actorUserId: string): Promise<AdminInfoPageDto> {
  const key = INFO_PAGE_KEYS[slug];
  const draft = await prisma.contentDocument.findFirst({ where: { key, status: ContentDocumentStatus.DRAFT } });
  if (!draft) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'There are no unpublished changes to publish.' });
  const content = assertValid(draft.content);

  const unconfirmed = infoPageUnconfirmed(content);
  if (unconfirmed.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Replace every «TO CONFIRM» note with the final wording before publishing (${unconfirmed.length} left).`,
      details: unconfirmed.slice(0, 20).map((text) => ({ field: 'content', message: text.slice(0, 200) })),
    });
  }
  const missing = missingRequired(slug, await infoPageValues());
  if (missing.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Fill these settings in Configuration → Business & Grievance Officer before publishing: ${missing.map((token) => TOKEN_SOURCES[token].label).join(', ')}.`,
      details: missing.map((token) => ({ field: TOKEN_SOURCES[token].configKey, message: 'required' })),
    });
  }

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
    const maxRevision = await tx.contentDocument.aggregate({ where: { key, status: { not: ContentDocumentStatus.DRAFT } }, _max: { revision: true } });
    const next = (maxRevision._max.revision ?? 0) + 1;
    if (current) await tx.contentDocument.update({ where: { id: current.id }, data: { status: ContentDocumentStatus.ARCHIVED } });
    await tx.contentDocument.update({
      where: { id: draft.id },
      data: { status: ContentDocumentStatus.PUBLISHED, revision: next, content: asJson(content), publishedAt: new Date(), publishedByUserId: actorUserId },
    });
    await audit(tx, actorUserId, 'content.publish', draft.id, current ? { key, revision: current.revision } : null, {
      key,
      revision: next,
      version: content.version,
      effectiveDate: content.effectiveDate,
    });
  });
  await cache.delete(cacheKey(slug)).catch((error: unknown) => log.warn({ err: error }, 'information page cache not cleared — refreshes within a minute'));
  return getAdminInfoPage(slug);
}

/** POST /admin/content/pages/:slug/restore/:id — an earlier revision becomes the draft (publish to apply it). */
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
    const content = asJson(storedContent(slug, source));
    const base = published?.revision ?? 0;
    const row = draft
      ? await tx.contentDocument.update({ where: { id: draft.id }, data: { content, revision: base, updatedByUserId: actorUserId } })
      : await tx.contentDocument.create({ data: { key, status: ContentDocumentStatus.DRAFT, revision: base, content, updatedByUserId: actorUserId } });
    await audit(tx, actorUserId, 'content.draft.restore', row.id, null, { key, fromRevision: source.revision });
  });
  return getAdminInfoPage(slug);
}

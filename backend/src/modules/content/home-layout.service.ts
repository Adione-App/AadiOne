/**
 * Home Page Builder and category display — the "home_layout" content
 * document (shared HomeLayoutContent, content_documents table).
 *
 *   draft      saved freely by an admin; never shown to customers
 *   publish    validates the draft (every referenced category still live,
 *              the background image one this server stored), archives the
 *              current published revision and makes the draft revision N+1
 *              in ONE transaction; customers see it on their next refresh
 *   restore    copies an earlier revision into the draft (publish to apply)
 *
 * Customers only ever receive the published layout (or the built-in
 * defaults while nothing is published), resolved by the shared
 * `resolveHomeLayout`: complete, clamped, never throwing. It is cached in the
 * shared cache for a minute and dropped on publish.
 *
 * Every write is audited (entityType "ContentDocument").
 */

import { ContentDocumentStatus, Prisma, type ContentDocument } from '@prisma/client';
import {
  CATEGORY_PLACEMENT_KEYS,
  DEFAULT_HOME_LAYOUT,
  ErrorCode,
  resolveHomeLayout,
  type AdminCategoryOptionDto,
  type AdminHomeLayoutDto,
  type HomeLayoutContent,
  type HomeLayoutDto,
  type HomeLayoutRevisionDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { cache } from '../../infra/cache';
import { storageKeyFromUrl } from '../../infra/storage';
import { MARKETPLACE_SELLER_SQL } from '../catalog/catalog.repository';
import { assertAdminKey } from '../admin/admin-upload.service';
import { processUploadedImage } from '../catalog/uploaded-image.service';

const log = moduleLogger('content');

export const HOME_LAYOUT_KEY = 'home_layout';
const CACHE_KEY = `content:${HOME_LAYOUT_KEY}`;
const CACHE_SECONDS = 60;
const HISTORY_LIMIT = 20;

/* -------------------------------------------------------------------------- */
/* Customers                                                                   */
/* -------------------------------------------------------------------------- */

function publishedDto(row: ContentDocument | null): HomeLayoutDto {
  if (!row) return { revision: 0, publishedAt: null, layout: resolveHomeLayout(DEFAULT_HOME_LAYOUT) };
  return { revision: row.revision, publishedAt: row.publishedAt?.toISOString() ?? null, layout: resolveHomeLayout(row.content) };
}

/** GET /content/home-layout — the published layout, or the defaults while nothing is published. */
export async function getPublishedHomeLayout(): Promise<HomeLayoutDto> {
  const cached = await cache.get(CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as HomeLayoutDto;
    } catch {
      // A damaged cache entry is simply rebuilt.
    }
  }
  const row = await prisma.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.PUBLISHED } });
  const dto = publishedDto(row);
  await cache.set(CACHE_KEY, JSON.stringify(dto), CACHE_SECONDS).catch((error: unknown) => log.warn({ err: error }, 'home layout not cached'));
  return dto;
}

/* -------------------------------------------------------------------------- */
/* Admin — reading                                                             */
/* -------------------------------------------------------------------------- */

async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((user) => [user.id, user.fullName ?? user.email ?? 'Admin']));
}

const revisionDto = (row: ContentDocument, names: Map<string, string>): HomeLayoutRevisionDto => ({
  id: row.id,
  revision: row.revision,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  publishedBy: row.publishedByUserId ? names.get(row.publishedByUserId) ?? null : null,
});

/** GET /admin/content/home-layout — published, draft and earlier revisions. */
export async function getAdminHomeLayout(): Promise<AdminHomeLayoutDto> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: HOME_LAYOUT_KEY },
    orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    take: HISTORY_LIMIT + 2,
  });
  const published = rows.find((row) => row.status === ContentDocumentStatus.PUBLISHED) ?? null;
  const draft = rows.find((row) => row.status === ContentDocumentStatus.DRAFT) ?? null;
  const archived = rows.filter((row) => row.status === ContentDocumentStatus.ARCHIVED).slice(0, HISTORY_LIMIT);
  const names = await userNames(rows.flatMap((row) => [row.updatedByUserId, row.publishedByUserId]));
  return {
    published: published ? { ...revisionDto(published, names), layout: resolveHomeLayout(published.content) } : null,
    draft: draft
      ? {
          basedOnRevision: draft.revision,
          updatedAt: draft.updatedAt.toISOString(),
          updatedBy: draft.updatedByUserId ? names.get(draft.updatedByUserId) ?? null : null,
          layout: resolveHomeLayout(draft.content),
        }
      : null,
    history: archived.map((row) => revisionDto(row, names)),
  };
}

/** GET /admin/content/home-layout/preview — what customers would get if the draft were published now. */
export async function previewHomeLayout(): Promise<HomeLayoutDto> {
  const draft = await prisma.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } });
  if (draft) return { revision: draft.revision, publishedAt: null, layout: resolveHomeLayout(draft.content) };
  return publishedDto(await prisma.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.PUBLISHED } }));
}

/**
 * GET /admin/content/category-options — live marketplace categories merged by
 * path, as customers see them: each path once (its earliest row represents
 * it), with seller and live-product counts. Restaurants' menu sections are
 * not marketplace categories and are left out.
 */
export async function listCategoryOptions(): Promise<AdminCategoryOptionDto[]> {
  const rows = await prisma.$queryRaw<
    { id: string; path: string; depth: number; name: string; name_hi: string | null; image_url: string | null; seller_count: number; product_count: number }[]
  >(Prisma.sql`
    WITH live AS (
      SELECT c.id, c.path, c.depth, c.name, c.name_hi, c.image_url, c.seller_id, c.created_at, c.display_order
      FROM categories c
      JOIN sellers s ON s.id = c.seller_id
      WHERE c.deleted_at IS NULL AND c.is_active AND ${MARKETPLACE_SELLER_SQL}
    ),
    rep AS (
      SELECT DISTINCT ON (path) id, path, depth, name, name_hi, image_url
      FROM live ORDER BY path, created_at, id
    ),
    products_by_path AS (
      SELECT l.path, count(*)::int AS n
      FROM products p JOIN live l ON l.id = p.category_id
      WHERE p.deleted_at IS NULL AND p.status = 'ACTIVE' AND p.approval_status = 'APPROVED'
      GROUP BY l.path
    )
    SELECT r.id, r.path, r.depth, r.name, r.name_hi, r.image_url,
      (SELECT count(DISTINCT l.seller_id)::int FROM live l WHERE l.path = r.path) AS seller_count,
      (SELECT coalesce(sum(pp.n), 0)::int FROM products_by_path pp WHERE pp.path = r.path OR pp.path LIKE r.path || '/%') AS product_count
    FROM rep r
    ORDER BY split_part(r.path, '/', 1), r.depth, r.name`);
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    parentPath: row.path.includes('/') ? row.path.split('/')[0]! : null,
    depth: row.depth,
    name: row.name,
    nameHi: row.name_hi,
    imageUrl: row.image_url,
    sellerCount: row.seller_count,
    productCount: row.product_count,
  }));
}

/* -------------------------------------------------------------------------- */
/* Admin — writing                                                             */
/* -------------------------------------------------------------------------- */

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

/** Serialises every write to the document (two admins saving at once queue here). */
async function lockDocument(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`content_documents:${HOME_LAYOUT_KEY}`}))`;
}

const asJson = (layout: HomeLayoutContent) => layout as unknown as Prisma.InputJsonValue;

/**
 * PUT /admin/content/home-layout/draft — saves the draft. The layout is
 * stored resolved (complete and within every limit), so what is saved is
 * exactly what the preview and, once published, customers get.
 */
export async function saveHomeLayoutDraft(layout: unknown, actorUserId: string): Promise<AdminHomeLayoutDto> {
  const resolved = resolveHomeLayout(layout);
  assertBackgroundImage(resolved);
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx);
    const [draft, published] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.PUBLISHED }, select: { revision: true } }),
    ]);
    if (draft) {
      await tx.contentDocument.update({ where: { id: draft.id }, data: { content: asJson(resolved), updatedByUserId: actorUserId } });
      await audit(tx, actorUserId, 'content.draft.update', draft.id, null, { key: HOME_LAYOUT_KEY, basedOnRevision: draft.revision });
    } else {
      const created = await tx.contentDocument.create({
        data: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT, revision: published?.revision ?? 0, content: asJson(resolved), updatedByUserId: actorUserId },
      });
      await audit(tx, actorUserId, 'content.draft.create', created.id, null, { key: HOME_LAYOUT_KEY, basedOnRevision: created.revision });
    }
  });
  return getAdminHomeLayout();
}

/** DELETE /admin/content/home-layout/draft — throws away unpublished changes. */
export async function discardHomeLayoutDraft(actorUserId: string): Promise<AdminHomeLayoutDto> {
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx);
    const draft = await tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } });
    if (!draft) return;
    await tx.contentDocument.delete({ where: { id: draft.id } });
    await audit(tx, actorUserId, 'content.draft.discard', draft.id, { key: HOME_LAYOUT_KEY, basedOnRevision: draft.revision }, null);
  });
  return getAdminHomeLayout();
}

/** A background image must be one this server stored (uploaded through the Admin Panel), never an outside link. */
function assertBackgroundImage(layout: HomeLayoutContent): void {
  const url = layout.hero.background.imageUrl;
  if (url && !storageKeyFromUrl(url)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Upload the background image here — links to other websites are not allowed.',
      details: [{ field: 'hero.background.imageUrl', message: 'not a stored image' }],
    });
  }
}

/** Every category a layout names must still be live — a published layout never lists a vanished category. */
async function assertCategoriesLive(layout: HomeLayoutContent): Promise<void> {
  const paths = new Set<string>();
  for (const key of CATEGORY_PLACEMENT_KEYS) {
    const placement = layout.categoryPlacements[key];
    if (placement.mode !== 'manual') continue;
    if (placement.paths.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'A placement set to "Choose categories" needs at least one category (or switch it back to automatic).',
        details: [{ field: `categoryPlacements.${key}`, message: 'no categories chosen' }],
      });
    }
    placement.paths.forEach((path) => paths.add(path));
  }
  layout.categoryStyles.forEach((style) => paths.add(style.path));
  if (paths.size === 0) return;
  const live = new Set((await listCategoryOptions()).map((option) => option.path));
  const missing = [...paths].filter((path) => !live.has(path));
  if (missing.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `These categories are no longer live: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. Remove them, then publish again.`,
      details: missing.map((path) => ({ field: 'categories', message: path })),
    });
  }
}

/**
 * POST /admin/content/home-layout/publish — the draft becomes the next
 * published revision. `basedOnRevision` (what the admin's screen showed)
 * must still be the live revision: if someone else published meanwhile,
 * nothing changes and the admin is asked to reload.
 */
export async function publishHomeLayout(basedOnRevision: number, actorUserId: string): Promise<AdminHomeLayoutDto> {
  const draft = await prisma.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } });
  if (!draft) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'There are no unpublished changes to publish.' });
  const layout = resolveHomeLayout(draft.content);
  assertBackgroundImage(layout);
  await assertCategoriesLive(layout);

  await prisma.$transaction(async (tx) => {
    await lockDocument(tx);
    const [current, latestDraft] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.PUBLISHED } }),
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } }),
    ]);
    const liveRevision = current?.revision ?? 0;
    if (!latestDraft || latestDraft.id !== draft.id || latestDraft.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'The draft changed while publishing. Reload and publish again.' });
    }
    if (basedOnRevision !== liveRevision || draft.revision !== liveRevision) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'Someone published a newer version meanwhile. Reload to see it before publishing.' });
    }
    const maxRevision = await tx.contentDocument.aggregate({ where: { key: HOME_LAYOUT_KEY, status: { not: ContentDocumentStatus.DRAFT } }, _max: { revision: true } });
    const next = (maxRevision._max.revision ?? 0) + 1;
    if (current) await tx.contentDocument.update({ where: { id: current.id }, data: { status: ContentDocumentStatus.ARCHIVED } });
    await tx.contentDocument.update({
      where: { id: draft.id },
      data: {
        status: ContentDocumentStatus.PUBLISHED,
        revision: next,
        content: asJson(layout),
        publishedAt: new Date(),
        publishedByUserId: actorUserId,
      },
    });
    await audit(tx, actorUserId, 'content.publish', draft.id, current ? { revision: current.revision } : null, { key: HOME_LAYOUT_KEY, revision: next });
  });
  await cache.delete(CACHE_KEY).catch((error: unknown) => log.warn({ err: error }, 'home layout cache not cleared — refreshes within a minute'));
  return getAdminHomeLayout();
}

/** POST /admin/content/home-layout/restore/:id — an earlier revision becomes the draft (publish to apply it). */
export async function restoreHomeLayoutRevision(id: string, actorUserId: string): Promise<AdminHomeLayoutDto> {
  await prisma.$transaction(async (tx) => {
    await lockDocument(tx);
    const source = await tx.contentDocument.findFirst({ where: { id, key: HOME_LAYOUT_KEY, status: { not: ContentDocumentStatus.DRAFT } } });
    if (!source) throw new AppError(ErrorCode.NOT_FOUND, { message: 'That version was not found.' });
    const [draft, published] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.PUBLISHED }, select: { revision: true } }),
    ]);
    const content = asJson(resolveHomeLayout(source.content));
    const base = published?.revision ?? 0;
    const row = draft
      ? await tx.contentDocument.update({ where: { id: draft.id }, data: { content, revision: base, updatedByUserId: actorUserId } })
      : await tx.contentDocument.create({ data: { key: HOME_LAYOUT_KEY, status: ContentDocumentStatus.DRAFT, revision: base, content, updatedByUserId: actorUserId } });
    await audit(tx, actorUserId, 'content.draft.restore', row.id, null, { key: HOME_LAYOUT_KEY, fromRevision: source.revision });
  });
  return getAdminHomeLayout();
}

/** POST /admin/content/home-layout/background-image — an uploaded image through the shared pipeline (WebP, resized). */
export async function processBackgroundImage(key: string): Promise<{ url: string; width: number | null; height: number | null }> {
  assertAdminKey(key);
  const image = await processUploadedImage(key, 'banner');
  return { url: image.url, width: image.width ?? null, height: image.height ?? null };
}

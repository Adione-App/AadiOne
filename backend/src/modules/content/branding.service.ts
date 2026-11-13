/**
 * Branding & Identity (Admin Panel → Settings → Branding & Identity) — the
 * brand assets of every Aadione surface, on the same content_documents
 * revisions as the Home layout and the legal pages (key "branding"):
 *
 *   upload     the browser PUTs the file to storage (POST /admin/uploads/presign,
 *              purpose "branding"); attaching it here reads the stored bytes,
 *              checks them against the slot's rules (shared brandAssetProblems:
 *              real format, size, dimensions, shape, transparency — from the
 *              file itself, never the browser's word), writes optimised copies
 *              under admin/branding/<slot>/ and puts them in the DRAFT. The raw
 *              upload is deleted.
 *   draft      never shown to anyone but admins.
 *   publish    all of the draft, or only the slots chosen: the published
 *              revision N becomes archived and N+1 is published, in ONE
 *              transaction. Slots not chosen stay in the draft.
 *   default    a slot set back to the built-in Aadione artwork (draft; publish to apply).
 *   history    every earlier file of a slot can be put back in the draft, and a
 *              whole earlier revision restored — files are never deleted, so
 *              any revision can be shown again.
 *
 * GET /api/v1/branding serves the published DYNAMIC slots (cached for a
 * minute, dropped on publish). Build-time slots (launcher icons) are never
 * served: they are the source for the next native build only.
 *
 * Every write is audited (entityType "Branding").
 */

import { createHash, randomUUID } from 'node:crypto';
import { ContentDocumentStatus, Prisma, type ContentDocument } from '@prisma/client';
import sharp, { type Sharp } from 'sharp';
import type { PdfLogo } from '../../infra/pdf/branded-pdf';
import {
  BRAND_ASSET_MAX_BYTES,
  BRAND_ASSET_SLOTS,
  BRAND_ASSET_SPECS,
  BRAND_NAME,
  DYNAMIC_BRAND_SLOTS,
  ErrorCode,
  brandAssetProblems,
  changedBrandSlots,
  type AdminBrandingDto,
  type AdminBrandingRevisionDto,
  type BrandAsset,
  type BrandAssetSlot,
  type BrandImageFacts,
  type BrandingContent,
  type DynamicBrandSlot,
  type PublicBrandingDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { cache } from '../../infra/cache';
import { storage } from '../../infra/storage';
import { MAX_INPUT_PIXELS } from '../../infra/storage/image-optimizer';
import { assertAdminKey } from '../admin/admin-upload.service';

const log = moduleLogger('branding');

export const BRANDING_KEY = 'branding';
const CACHE_KEY = 'content:branding';
const CACHE_SECONDS = 60;
const HISTORY_LIMIT = 30;
/** Raw uploads for branding come only from here (admin-upload.service FOLDER.branding). */
const UPLOAD_PREFIX = 'admin/branding/uploads/';
/** Logos are stored no larger than this on their long side (crisp at 2× in every header). */
const LOGO_MAX_SIDE = 1600;
/** Launcher / store icons keep their full size up to this. */
const ICON_MAX_SIDE = 2048;

const LOGO_SLOTS: ReadonlySet<BrandAssetSlot> = new Set(['logo_main', 'logo_light', 'logo_dark', 'customer_app_logo', 'customer_splash_logo', 'seller_app_logo']);

/* -------------------------------------------------------------------------- */
/* Reading revisions                                                           */
/* -------------------------------------------------------------------------- */

/** A stored revision's content, defensively re-read (a damaged row reads as "all defaults"). */
export function readBrandingContent(value: unknown): BrandingContent {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const rawAssets = raw['assets'] && typeof raw['assets'] === 'object' ? (raw['assets'] as Record<string, unknown>) : {};
  const assets: BrandingContent['assets'] = {};
  for (const slot of BRAND_ASSET_SLOTS) {
    const asset = rawAssets[slot];
    if (asset && typeof asset === 'object' && typeof (asset as BrandAsset).url === 'string' && typeof (asset as BrandAsset).pngUrl === 'string') {
      assets[slot] = asset as BrandAsset;
    }
  }
  const restored = raw['restoredFromRevision'];
  return {
    assets,
    ...(typeof restored === 'number' && Number.isInteger(restored) && restored > 0 ? { restoredFromRevision: restored } : {}),
  };
}

const asJson = (content: BrandingContent) => content as unknown as Prisma.InputJsonValue;

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

const EMPTY: PublicBrandingDto = { brandName: BRAND_NAME, revision: 0, publishedAt: null, assets: {} };

function toPublic(row: ContentDocument | null): PublicBrandingDto {
  if (!row) return EMPTY;
  const content = readBrandingContent(row.content);
  const assets: PublicBrandingDto['assets'] = {};
  for (const slot of DYNAMIC_BRAND_SLOTS as DynamicBrandSlot[]) {
    const asset = content.assets[slot];
    if (!asset) continue;
    assets[slot] = {
      url: asset.url,
      pngUrl: asset.pngUrl,
      width: asset.width,
      height: asset.height,
      ...(asset.variants ? { variants: asset.variants } : {}),
    };
  }
  return { brandName: BRAND_NAME, revision: row.revision, publishedAt: row.publishedAt?.toISOString() ?? null, assets };
}

/** GET /api/v1/branding — the published dynamic assets (built-in defaults while nothing is published). */
export async function getPublicBranding(): Promise<PublicBrandingDto> {
  const cached = await cache.get(CACHE_KEY).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as PublicBrandingDto;
    } catch {
      // A damaged cache entry is rebuilt below.
    }
  }
  const row = await prisma.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.PUBLISHED } });
  const dto = toPublic(row);
  await cache.set(CACHE_KEY, JSON.stringify(dto), CACHE_SECONDS).catch((error: unknown) => log.warn({ err: error }, 'branding not cached'));
  return dto;
}

/**
 * The published MAIN logo as PNG bytes, for PDFs; null = use the built-in one.
 * Read from storage once per published revision.
 */
let pdfLogo: { revision: number; png: Buffer | null } | null = null;
export async function publishedMainLogoPng(): Promise<Buffer | null> {
  try {
    const branding = await getPublicBranding();
    if (pdfLogo && pdfLogo.revision === branding.revision) return pdfLogo.png;
    const asset = branding.assets.logo_main;
    let png: Buffer | null = null;
    if (asset) {
      const key = keyOf(asset.pngUrl);
      png = key ? await storage.get(key, BRAND_ASSET_MAX_BYTES) : null;
    }
    pdfLogo = { revision: branding.revision, png };
    return png;
  } catch (error) {
    log.warn({ err: error }, 'published logo unavailable for a PDF — using the built-in logo');
    return null;
  }
}

/** The published main logo for a PDF (with its pixel size); null = the built-in logo. */
export async function brandedPdfLogo(): Promise<PdfLogo | null> {
  const png = await publishedMainLogoPng();
  if (!png) return null;
  try {
    const meta = await sharp(png).metadata();
    return meta.width && meta.height ? { png, width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

/** The storage key of one of OUR branding files, or null. */
function keyOf(url: string): string | null {
  const marker = '/admin/branding/';
  const index = url.indexOf(marker);
  if (index < 0) return null;
  const key = decodeURIComponent(url.slice(index + 1));
  return /^admin\/branding\/[A-Za-z0-9/_.-]+$/.test(key) && !key.includes('..') ? key : null;
}

/* -------------------------------------------------------------------------- */
/* Admin view                                                                  */
/* -------------------------------------------------------------------------- */

async function userNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((user) => [user.id, user.fullName ?? user.email ?? 'Admin']));
}

/** GET /admin/branding — every slot with its published / draft file, history and revisions. */
export async function getAdminBranding(): Promise<AdminBrandingDto> {
  const rows = await prisma.contentDocument.findMany({
    where: { key: BRANDING_KEY },
    orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    take: HISTORY_LIMIT + 2,
  });
  const published = rows.find((row) => row.status === ContentDocumentStatus.PUBLISHED) ?? null;
  const draft = rows.find((row) => row.status === ContentDocumentStatus.DRAFT) ?? null;
  const releases = rows.filter((row) => row.status !== ContentDocumentStatus.DRAFT).sort((a, b) => b.revision - a.revision);
  const names = await userNames(rows.flatMap((row) => [row.updatedByUserId, row.publishedByUserId]));
  const publishedContent = published ? readBrandingContent(published.content) : { assets: {} };
  const draftContent = draft ? readBrandingContent(draft.content) : null;

  const history: AdminBrandingRevisionDto[] = releases.map((row, i) => {
    const content = readBrandingContent(row.content);
    const previous = releases[i + 1] ? readBrandingContent(releases[i + 1]!.content) : { assets: {} };
    return {
      id: row.id,
      revision: row.revision,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      publishedBy: row.publishedByUserId ? names.get(row.publishedByUserId) ?? null : null,
      changed: changedBrandSlots(previous, content),
      restoredFromRevision: content.restoredFromRevision ?? null,
    };
  });

  return {
    slots: BRAND_ASSET_SLOTS.map((slot) => {
      const live = publishedContent.assets[slot] ?? null;
      const inDraft = draftContent ? draftContent.assets[slot] ?? null : live;
      // Earlier files of this slot, newest first, each once (not the live one).
      const seen = new Set<string>([live?.pngUrl ?? '']);
      const earlier: AdminBrandingDto['slots'][number]['history'] = [];
      for (const row of releases) {
        const asset = readBrandingContent(row.content).assets[slot];
        if (!asset || seen.has(asset.pngUrl)) continue;
        seen.add(asset.pngUrl);
        earlier.push({ ...asset, revision: row.revision });
      }
      return {
        slot,
        spec: BRAND_ASSET_SPECS[slot],
        published: live,
        draft: inDraft,
        changed: (live?.pngUrl ?? null) !== (inDraft?.pngUrl ?? null),
        history: earlier,
      };
    }),
    published: published
      ? {
          revision: published.revision,
          publishedAt: published.publishedAt?.toISOString() ?? null,
          publishedBy: published.publishedByUserId ? names.get(published.publishedByUserId) ?? null : null,
        }
      : null,
    draft: draft
      ? {
          basedOnRevision: draft.revision,
          updatedAt: draft.updatedAt.toISOString(),
          updatedBy: draft.updatedByUserId ? names.get(draft.updatedByUserId) ?? null : null,
          changed: changedBrandSlots(publishedContent, draftContent),
        }
      : null,
    history,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

async function audit(tx: Prisma.TransactionClient, actorUserId: string, action: string, entityId: string, after: unknown) {
  await tx.auditLog.create({
    data: { actorUserId, action, entityType: 'Branding', entityId, before: Prisma.JsonNull, after: (after ?? null) as Prisma.InputJsonValue },
  });
}

/** Serialises every write (two admins saving at once queue here). */
async function lock(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`content_documents:${BRANDING_KEY}`}))`;
}

/**
 * Applies `change` to the draft (creating it from the published revision when
 * there is none) — the draft always holds the full desired state.
 */
async function editDraft(actorUserId: string, action: string, change: (content: BrandingContent) => BrandingContent, details: unknown): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const [draft, published] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.PUBLISHED } }),
    ]);
    const base = draft ? readBrandingContent(draft.content) : published ? readBrandingContent(published.content) : { assets: {} };
    // Each change returns the whole next state; only a restore keeps "restored from".
    const next = change(base);
    const row = draft
      ? await tx.contentDocument.update({ where: { id: draft.id }, data: { content: asJson(next), updatedByUserId: actorUserId } })
      : await tx.contentDocument.create({
          data: { key: BRANDING_KEY, status: ContentDocumentStatus.DRAFT, revision: published?.revision ?? 0, content: asJson(next), updatedByUserId: actorUserId },
        });
    await audit(tx, actorUserId, action, row.id, details);
  });
}

/** Reads what the file really is (not what the browser said). */
async function factsOf(source: Buffer): Promise<{ facts: BrandImageFacts; image: Sharp }> {
  try {
    const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const [meta, stats] = await Promise.all([image.metadata(), image.stats()]);
    return {
      image,
      facts: {
        format: meta.format ?? '',
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        bytes: source.byteLength,
        hasAlpha: meta.hasAlpha === true,
        opaque: stats.isOpaque,
      },
    };
  } catch {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, { message: 'This file is not an image we can read. Upload a PNG, JPEG or WebP image.' });
  }
}

async function put(key: string, body: Buffer, contentType: string): Promise<string> {
  return (await storage.put(key, body, contentType)).url;
}

/** Writes the optimised files of one upload; returns the asset (nothing is in the draft yet). */
async function storeAsset(slot: BrandAssetSlot, source: Buffer, facts: BrandImageFacts, fileName: string): Promise<BrandAsset> {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `admin/branding/${slot.replace(/_/g, '-')}/${stamp}/${randomUUID()}`;
  const png = (input: Sharp) => input.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
  const decoded = () => sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();

  if (slot === 'favicon') {
    const sizes = [32, 180, 512] as const;
    const files = await Promise.all(sizes.map((size) => png(decoded().resize(size, size, { fit: 'cover' }))));
    const [u32, u180, u512] = await Promise.all(files.map((file: { data: Buffer }, i: number) => put(`${base}-${sizes[i]}.png`, file.data, 'image/png')));
    return {
      url: u512!,
      pngUrl: u512!,
      variants: { png32: u32!, png180: u180!, png512: u512! },
      width: 512,
      height: 512,
      bytes: files[2]!.info.size,
      hasAlpha: facts.hasAlpha && !facts.opaque,
      fileName,
      uploadedAt: new Date().toISOString(),
    };
  }

  if (LOGO_SLOTS.has(slot)) {
    const resized = () => decoded().resize(LOGO_MAX_SIDE, LOGO_MAX_SIDE, { fit: 'inside', withoutEnlargement: true });
    const [pngFile, webpFile] = await Promise.all([
      png(resized()),
      resized().webp({ quality: 90, alphaQuality: 100, effort: 5 }).toBuffer({ resolveWithObject: true }),
    ]);
    const [pngUrl, webpUrl] = await Promise.all([put(`${base}.png`, pngFile.data, 'image/png'), put(`${base}.webp`, webpFile.data, 'image/webp')]);
    return {
      url: webpUrl,
      pngUrl,
      width: pngFile.info.width,
      height: pngFile.info.height,
      bytes: webpFile.info.size,
      hasAlpha: facts.hasAlpha && !facts.opaque,
      fileName,
      uploadedAt: new Date().toISOString(),
    };
  }

  // Build-time icons: lossless PNG at full size — the source for the next native build.
  const file = await png(decoded().resize(ICON_MAX_SIDE, ICON_MAX_SIDE, { fit: 'inside', withoutEnlargement: true }));
  const url = await put(`${base}.png`, file.data, 'image/png');
  return {
    url,
    pngUrl: url,
    width: file.info.width,
    height: file.info.height,
    bytes: file.info.size,
    hasAlpha: facts.hasAlpha && !facts.opaque,
    fileName,
    uploadedAt: new Date().toISOString(),
  };
}

/** The uploaded file's name for the history: letters, digits and . _ - only. */
const cleanFileName = (name: string | undefined, fallback: string) =>
  (name ?? '').replace(/[^\w.\- ]+/g, '').trim().slice(0, 120) || fallback;

/**
 * POST /admin/branding/assets/:slot { key, fileName } — checks and stores an
 * uploaded file and puts it in the draft. A refused file is deleted and
 * nothing changes.
 */
export async function attachBrandAsset(slot: BrandAssetSlot, key: string, fileName: string | undefined, actorUserId: string): Promise<AdminBrandingDto> {
  assertAdminKey(key);
  if (!key.startsWith(UPLOAD_PREFIX)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Upload the file from Branding & Identity, then try again.' });
  }
  const source = await storage.get(key, BRAND_ASSET_MAX_BYTES);
  if (!source) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The uploaded file could not be found. Please upload it again.' });
  const removeUpload = () => storage.remove(key).catch((error: unknown) => log.warn({ err: error, key }, 'raw branding upload not removed'));

  let asset: BrandAsset;
  try {
    const { facts } = await factsOf(source);
    const problems = brandAssetProblems(slot, facts);
    if (problems.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `${BRAND_ASSET_SPECS[slot].label}: ${problems.join(' ')}`,
        details: problems.map((message) => ({ field: slot, message })),
      });
    }
    asset = await storeAsset(slot, source, facts, cleanFileName(fileName, `${slot}.png`));
  } finally {
    await removeUpload();
  }

  await editDraft(actorUserId, 'branding.draft.upload', (content) => ({ assets: { ...content.assets, [slot]: asset } }), {
    slot,
    file: asset.pngUrl,
    width: asset.width,
    height: asset.height,
    sha256: createHash('sha256').update(source).digest('hex'),
  });
  return getAdminBranding();
}

/** POST /admin/branding/assets/:slot/default — the slot goes back to the built-in artwork (in the draft). */
export async function resetBrandAsset(slot: BrandAssetSlot, actorUserId: string): Promise<AdminBrandingDto> {
  await editDraft(actorUserId, 'branding.draft.default', (content) => ({ assets: { ...content.assets, [slot]: null } }), { slot });
  return getAdminBranding();
}

/** POST /admin/branding/assets/:slot/reuse { revision } — that revision's file of this slot goes back in the draft. */
export async function reuseBrandAsset(slot: BrandAssetSlot, revision: number, actorUserId: string): Promise<AdminBrandingDto> {
  const source = await prisma.contentDocument.findFirst({
    where: { key: BRANDING_KEY, revision, status: { not: ContentDocumentStatus.DRAFT } },
  });
  const asset = source ? readBrandingContent(source.content).assets[slot] : null;
  if (!asset) throw new AppError(ErrorCode.NOT_FOUND, { message: 'That earlier file was not found.' });
  await editDraft(actorUserId, 'branding.draft.reuse', (content) => ({ assets: { ...content.assets, [slot]: asset } }), { slot, fromRevision: revision });
  return getAdminBranding();
}

/** POST /admin/branding/restore/:id — an earlier published revision becomes the draft (publish to apply). */
export async function restoreBrandingRevision(id: string, actorUserId: string): Promise<AdminBrandingDto> {
  const source = await prisma.contentDocument.findFirst({ where: { id, key: BRANDING_KEY, status: { not: ContentDocumentStatus.DRAFT } } });
  if (!source) throw new AppError(ErrorCode.NOT_FOUND, { message: 'That version was not found.' });
  const restored = readBrandingContent(source.content);
  await editDraft(actorUserId, 'branding.draft.restore', () => ({ assets: restored.assets, restoredFromRevision: source.revision }), { fromRevision: source.revision });
  return getAdminBranding();
}

/** DELETE /admin/branding/draft — throws away unpublished changes. */
export async function discardBrandingDraft(actorUserId: string): Promise<AdminBrandingDto> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const draft = await tx.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.DRAFT } });
    if (!draft) return;
    await tx.contentDocument.delete({ where: { id: draft.id } });
    await audit(tx, actorUserId, 'branding.draft.discard', draft.id, { basedOnRevision: draft.revision });
  });
  return getAdminBranding();
}

/**
 * POST /admin/branding/publish { basedOnRevision, slots? } — publishes the
 * draft's choice for `slots` (every changed slot when omitted). The admin's
 * screen must still show the live revision; changes not chosen stay in the
 * draft.
 */
export async function publishBranding(basedOnRevision: number, slots: BrandAssetSlot[] | undefined, actorUserId: string): Promise<AdminBrandingDto> {
  await prisma.$transaction(async (tx) => {
    await lock(tx);
    const [draft, current] = await Promise.all([
      tx.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.DRAFT } }),
      tx.contentDocument.findFirst({ where: { key: BRANDING_KEY, status: ContentDocumentStatus.PUBLISHED } }),
    ]);
    if (!draft) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'There are no unpublished changes to publish.' });
    const liveRevision = current?.revision ?? 0;
    if (basedOnRevision !== liveRevision || draft.revision !== liveRevision) {
      throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'Someone published newer branding meanwhile. Reload to see it before publishing.' });
    }
    const live = current ? readBrandingContent(current.content) : { assets: {} };
    const wanted = readBrandingContent(draft.content);
    const changed = changedBrandSlots(live, wanted);
    const chosen = slots ? changed.filter((slot) => slots.includes(slot)) : changed;
    if (chosen.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose at least one changed asset to publish.' });
    }

    const nextAssets: BrandingContent['assets'] = { ...live.assets };
    for (const slot of chosen) nextAssets[slot] = wanted.assets[slot] ?? null;
    const restoredFromRevision = chosen.length === changed.length ? wanted.restoredFromRevision : undefined;
    const next: BrandingContent = { assets: nextAssets, ...(restoredFromRevision ? { restoredFromRevision } : {}) };

    const max = await tx.contentDocument.aggregate({ where: { key: BRANDING_KEY, status: { not: ContentDocumentStatus.DRAFT } }, _max: { revision: true } });
    const revision = (max._max.revision ?? 0) + 1;
    const publishedAt = new Date();
    if (current) await tx.contentDocument.update({ where: { id: current.id }, data: { status: ContentDocumentStatus.ARCHIVED } });
    const row = await tx.contentDocument.create({
      data: { key: BRANDING_KEY, status: ContentDocumentStatus.PUBLISHED, revision, content: asJson(next), publishedAt, publishedByUserId: actorUserId, updatedByUserId: actorUserId },
    });

    // What was not chosen stays in the draft (now based on the new revision).
    const leftover = changed.filter((slot) => !chosen.includes(slot));
    if (leftover.length === 0) await tx.contentDocument.delete({ where: { id: draft.id } });
    else await tx.contentDocument.update({ where: { id: draft.id }, data: { revision } });

    await audit(tx, actorUserId, 'branding.publish', row.id, {
      revision,
      publishedAt: publishedAt.toISOString(),
      slots: chosen,
      files: Object.fromEntries(chosen.map((slot) => [slot, next.assets[slot]?.pngUrl ?? 'built-in default'])),
      buildRequired: chosen.filter((slot) => BRAND_ASSET_SPECS[slot].delivery === 'build'),
      stillInDraft: leftover,
    });
  });
  await cache.delete(CACHE_KEY).catch((error: unknown) => log.warn({ err: error }, 'branding cache not cleared — refreshes within a minute'));
  return getAdminBranding();
}

/** Test-only: forget the PDF logo held in memory. */
export function resetBrandingMemoForTests(): void {
  pdfLogo = null;
}

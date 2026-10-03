/**
 * Seller onboarding — business profile, bank details, documents, and the
 * per-document admin review.
 *
 * LIFECYCLE — the two-gate seller lifecycle (`Seller.lifecycleStatus`) is
 * owned by seller-lifecycle.service.ts: submitting for verification and both
 * admin gates live there. This module stores and reads the onboarding DATA,
 * and reports the checklist (seller-lifecycle-rules.ts) and the `stage`
 * derived from the lifecycle. WHEN a seller may write here is enforced before
 * any of this runs (middleware/sellerLifecycle.ts) — edits are locked while
 * onboarding is under review.
 *
 * Every mutation here is a dedicated method, not a generic PATCH — the same
 * discipline `transitionSellerOrder`/`reviewBatchItem` already apply: a
 * decision requires the row to currently be PENDING, or it is refused as
 * INVALID_STATUS_TRANSITION rather than silently reapplied.
 *
 * `scopeSellerId` mirrors seller-order.service.ts / product-approval.service.ts
 * exactly: seller-panel routes pass `req.sellerId`, admin routes pass
 * `undefined`.
 *
 * MASKING: `SellerProfileDto.panNumber/aadhaarNumber` and
 * `SellerBankDetailDto.accountNumber` are masked for every caller except
 * admin's own single-seller review view (GET /admin/sellers/:id/onboarding,
 * per those DTOs' own doc comments in shared/dto.ts) — never in a list —
 * controlled by the `unmask` flag threaded through every read here, never by
 * which route happens to call it.
 */

import type { Prisma } from '@prisma/client';
import {
  ActorType,
  ApprovalStatus,
  DocumentStatus,
  ErrorCode,
  SellerLifecycleStatus,
  SellerType,
  type AdminSellerOnboardingSummaryDto,
  type SellerDocumentDto,
  type SellerDocumentType,
  type SellerOnboardingDetailDto,
  type SellerOnboardingRequirementsDto,
  type SellerOnboardingStage,
} from '../../shared';
import { normalizeIndianMobile } from '../../shared/phone';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { SellerAuditAction } from './seller-audit';
import { buildDocumentKey, privateDocuments } from '../../infra/storage/private-documents';
import {
  MAX_DOCUMENT_BYTES,
  PDF_CONTENT_TYPE,
  hasPdfSignature,
  isPdfMimeType,
  maskDocumentNumber,
  normaliseDocumentNumber,
  safeDocumentFileName,
} from './seller-document-rules';
import {
  buildOnboardingChecklist,
  checklistComplete,
  lifecycleStatesForStage,
  stageFor,
} from './seller-lifecycle-rules';

/**
 * Who is writing onboarding data, for the audit log. The seller's own routes
 * pass the seller; admin data entry (admin-seller-management.service.ts)
 * passes the admin — the same service code runs either way.
 */
export interface OnboardingActor {
  userId: string;
  type: typeof ActorType.SELLER | typeof ActorType.ADMIN;
}

/** Field names whose value differs between an existing row and new data. */
function changedFieldsOf<K extends string>(
  fields: readonly K[],
  before: Record<K, unknown> | null,
  after: Record<K, unknown>,
): K[] {
  return fields.filter((field) => before?.[field] !== after[field]);
}

/* -------------------------------------------------------------------------- */
/* Masking                                                                    */
/* -------------------------------------------------------------------------- */

/** "AAAAA0000A" -> "AAA***000A". Never touched when already short/odd. */
function maskTail(value: string, keep = 3): string {
  if (value.length <= keep + 1) return '*'.repeat(value.length);
  return `${value.slice(0, keep)}${'*'.repeat(value.length - keep - 1)}${value.slice(-1)}`;
}

/** "1234567890123456" -> "************3456" — last 4 digits only. */
function maskAccountNumber(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/* Seller profile                                                            */
/* -------------------------------------------------------------------------- */

export interface UpsertSellerProfileInput {
  businessName: string;
  businessType?: string | null;
  ownerFullName: string;
  ownerMobile: string;
  ownerEmail?: string | null;
  panNumber?: string | null;
  aadhaarNumber?: string | null;
  gstNumber?: string | null;
  fssaiNumber?: string | null;
}

const PROFILE_FIELDS = [
  'businessName',
  'businessType',
  'ownerFullName',
  'ownerMobile',
  'ownerEmail',
  'panNumber',
  'aadhaarNumber',
  'gstNumber',
  'fssaiNumber',
] as const;

/** Profile fields whose VALUES may go into the audit log. Every tax/ID number
 * (PAN, Aadhaar, GST, FSSAI) and the owner's personal contact details are
 * recorded by field name only — document numbers never reach audit rows. */
const PROFILE_AUDIT_VALUE_FIELDS: readonly (typeof PROFILE_FIELDS)[number][] = [
  'businessName',
  'businessType',
  'ownerFullName',
];

/**
 * Creates or replaces the seller's business profile, and audits it: who
 * (seller or admin), whether it was created, and which fields changed — with
 * values only for the non-sensitive ones. A re-save that changes nothing
 * writes no audit entry.
 *
 * PAN and Aadhaar are only ever READ back masked, so a form can never send
 * their current value: for these two fields an OMITTED value keeps what is
 * stored, `null` clears it, and a string replaces it. Every other field keeps
 * its full-replace behaviour (omitted = cleared).
 */
/**
 * A tax/ID number typed into the business profile, normalised and validated
 * with the same per-type rules as document numbers. `undefined` stays
 * undefined (keep), empty becomes null (clear).
 */
function profileIdNumber(
  type: SellerDocumentType,
  value: string | null | undefined,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  const result = normaliseDocumentNumber(type, value);
  if (!result.ok) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: `${label}: ${result.message}` });
  return result.value;
}

export async function upsertSellerProfile(sellerId: string, rawInput: UpsertSellerProfileInput, actor: OnboardingActor) {
  const input: UpsertSellerProfileInput = {
    ...rawInput,
    panNumber: profileIdNumber('PAN_CARD', rawInput.panNumber, 'PAN'),
    aadhaarNumber: profileIdNumber('AADHAAR_CARD', rawInput.aadhaarNumber, 'Aadhaar'),
    gstNumber: profileIdNumber('GST_CERTIFICATE', rawInput.gstNumber, 'GST number'),
    fssaiNumber: profileIdNumber('FSSAI_LICENSE', rawInput.fssaiNumber, 'FSSAI number'),
  };
  const ownerMobile = normalizeIndianMobile(input.ownerMobile);
  if (!ownerMobile) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter a valid owner mobile number.' });
  }
  if (!input.businessName.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the business name.' });
  }
  if (!input.ownerFullName.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: "Enter the owner's full name." });
  }

  return runInTransaction(async (tx) => {
    const before = await tx.sellerProfile.findUnique({ where: { sellerId } });
    const data = {
      businessName: input.businessName.trim(),
      businessType: input.businessType ?? null,
      ownerFullName: input.ownerFullName.trim(),
      ownerMobile,
      ownerEmail: input.ownerEmail ?? null,
      panNumber: input.panNumber === undefined ? (before?.panNumber ?? null) : input.panNumber,
      aadhaarNumber: input.aadhaarNumber === undefined ? (before?.aadhaarNumber ?? null) : input.aadhaarNumber,
      gstNumber: input.gstNumber ?? null,
      fssaiNumber: input.fssaiNumber ?? null,
    };
    const profile = await tx.sellerProfile.upsert({
      where: { sellerId },
      update: data,
      create: { sellerId, ...data },
    });

    const changedFields = changedFieldsOf(PROFILE_FIELDS, before, data);
    if (before && changedFields.length === 0) return profile;

    const values = (row: Record<(typeof PROFILE_FIELDS)[number], string | null>) =>
      Object.fromEntries(
        changedFields.filter((f) => PROFILE_AUDIT_VALUE_FIELDS.includes(f)).map((f) => [f, row[f]]),
      );
    await tx.auditLog.create({
      data: {
        actorUserId: actor.userId,
        action: SellerAuditAction.PROFILE_UPDATE,
        entityType: 'SellerProfile',
        entityId: profile.id,
        ...(before ? { before: values(before) } : {}),
        after: { sellerId, source: actor.type, created: !before, changedFields, ...values(data) },
      },
    });
    return profile;
  });
}

function toProfileDto(
  profile: {
    businessName: string;
    businessType: string | null;
    ownerFullName: string;
    ownerMobile: string;
    ownerEmail: string | null;
    panNumber: string | null;
    aadhaarNumber: string | null;
    gstNumber: string | null;
    fssaiNumber: string | null;
  } | null,
  unmask: boolean,
) {
  if (!profile) return null;
  return {
    businessName: profile.businessName,
    businessType: profile.businessType,
    ownerFullName: profile.ownerFullName,
    ownerMobile: profile.ownerMobile,
    ownerEmail: profile.ownerEmail,
    panNumber: profile.panNumber && !unmask ? maskTail(profile.panNumber) : profile.panNumber,
    aadhaarNumber:
      profile.aadhaarNumber && !unmask ? maskTail(profile.aadhaarNumber) : profile.aadhaarNumber,
    gstNumber: profile.gstNumber,
    fssaiNumber: profile.fssaiNumber,
  };
}

/* -------------------------------------------------------------------------- */
/* Bank details                                                               */
/* -------------------------------------------------------------------------- */

const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export interface UpsertBankDetailInput {
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName?: string | null;
}

const BANK_FIELDS = ['accountHolderName', 'accountNumber', 'ifscCode', 'bankName'] as const;

/** What the audit log records about a payout account: never the full number. */
function bankAuditValues(bank: {
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string | null;
  isVerified: boolean;
}) {
  return {
    accountHolderName: bank.accountHolderName,
    accountNumberMasked: maskAccountNumber(bank.accountNumber),
    ifscCode: bank.ifscCode,
    bankName: bank.bankName,
    isVerified: bank.isVerified,
  };
}

/**
 * Creates or replaces the seller's payout account. `isVerified` is never
 * taken from the caller: every save leaves the account UNVERIFIED (as it
 * always has — a re-saved account must be re-checked), and only
 * `verifyBankDetail` sets it true.
 *
 * Every save is audited — seller or admin, masked account number only —
 * with `approvedSeller: true` when the seller is already live, which is
 * the payout-redirection case an admin must look at.
 */
export async function upsertBankDetail(sellerId: string, input: UpsertBankDetailInput, actor: OnboardingActor) {
  if (!input.accountHolderName.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter the account holder name.' });
  }
  const accountNumber = input.accountNumber.trim();
  if (!/^\d{6,20}$/.test(accountNumber)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter a valid account number.' });
  }
  const ifscCode = input.ifscCode.trim().toUpperCase();
  if (!IFSC_PATTERN.test(ifscCode)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter a valid IFSC code.' });
  }

  const data = {
    accountHolderName: input.accountHolderName.trim(),
    accountNumber,
    ifscCode,
    bankName: input.bankName ?? null,
  };

  return runInTransaction(async (tx) => {
    const seller = await tx.seller.findUnique({ where: { id: sellerId }, select: { onboardingStatus: true } });
    if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
    const before = await tx.sellerBankDetail.findUnique({ where: { sellerId } });

    // Re-adding bank details resets any prior verification — a changed
    // account must be re-checked, never left "verified" against old numbers.
    const bank = await tx.sellerBankDetail.upsert({
      where: { sellerId },
      update: { ...data, isVerified: false },
      create: { sellerId, ...data },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: actor.userId,
        action: SellerAuditAction.BANK_DETAIL_UPDATE,
        entityType: 'SellerBankDetail',
        entityId: bank.id,
        ...(before ? { before: bankAuditValues(before) } : {}),
        after: {
          sellerId,
          source: actor.type,
          created: !before,
          changedFields: changedFieldsOf(BANK_FIELDS, before, data),
          verificationReset: before?.isVerified ?? false,
          approvedSeller: seller.onboardingStatus === ApprovalStatus.APPROVED,
          ...bankAuditValues(bank),
        },
      },
    });
    return bank;
  });
}

/** The bank state the admin reviewed, as read from `SellerBankDetailDto`. */
export interface ReviewedBankDetail {
  bankDetailId: string;
  expectedUpdatedAt: string;
}

/**
 * Admin verification of EXACTLY the payout account the admin reviewed.
 *
 * STALE-VIEW PROTECTION: the request carries the row's `id` and `updatedAt`
 * as the admin read them. The row is updated in place (one per seller), so
 * the id alone cannot tell two accounts apart — but `updatedAt` changes on
 * every save (Prisma @updatedAt; no trigger or raw write touches it), cannot
 * be chosen by the seller, and says nothing about the account. Any save since
 * the admin's read -> 409, nothing verified; the admin must re-read and
 * review the new details. (The last 4 digits were rejected as the token: a
 * seller can pick a new account that shares them.)
 *
 * The flip itself is a compare-and-set on that same version, and keeps
 * `updatedAt` unchanged: it tracks the account DATA, so retrying a successful
 * verification with the same version is a no-op rather than a 409.
 * Verification is recorded in the audit log (actor + time) — the model has
 * no verifier/timestamp columns.
 */
export async function verifyBankDetail(
  sellerId: string,
  reviewed: ReviewedBankDetail,
  actorUserId: string,
): Promise<void> {
  const expectedUpdatedAt = new Date(reviewed.expectedUpdatedAt);

  await runInTransaction(async (tx) => {
    const bank = await tx.sellerBankDetail.findUnique({ where: { sellerId } });
    if (!bank) throw new AppError(ErrorCode.NOT_FOUND, { message: 'This seller has no bank details to verify.' });

    const stale = (why: string) =>
      new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: 'These bank details have changed since you reviewed them. Review them again before verifying.',
        internalMessage: `stale bank verification for seller ${sellerId}: ${why}`,
      });

    if (bank.id !== reviewed.bankDetailId || bank.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw stale(`reviewed ${reviewed.bankDetailId}@${reviewed.expectedUpdatedAt}, current ${bank.id}@${bank.updatedAt.toISOString()}`);
    }
    if (bank.isVerified) return; // this exact account is already verified

    const { count } = await tx.sellerBankDetail.updateMany({
      where: { id: bank.id, isVerified: false, updatedAt: bank.updatedAt },
      data: { isVerified: true, updatedAt: bank.updatedAt },
    });
    if (count === 0) throw stale('changed during verification');

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: SellerAuditAction.BANK_DETAIL_VERIFY,
        entityType: 'SellerBankDetail',
        entityId: bank.id,
        before: { isVerified: false },
        after: { sellerId, ...bankAuditValues({ ...bank, isVerified: true }) },
      },
    });
  });
}

function toBankDetailDto(
  bank: {
    id: string;
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string | null;
    isVerified: boolean;
    updatedAt: Date;
  } | null,
  unmask: boolean,
) {
  if (!bank) return null;
  return {
    id: bank.id,
    // The version an admin must echo back to verify exactly this account —
    // see `verifyBankDetail`.
    updatedAt: bank.updatedAt.toISOString(),
    accountHolderName: bank.accountHolderName,
    accountNumber: unmask ? bank.accountNumber : maskAccountNumber(bank.accountNumber),
    ifscCode: bank.ifscCode,
    bankName: bank.bankName,
    isVerified: bank.isVerified,
  };
}

/* -------------------------------------------------------------------------- */
/* Restaurant profile (data only — no food/ordering logic here)              */
/* -------------------------------------------------------------------------- */

export interface UpsertRestaurantProfileInput {
  cuisine: string[];
  isVegOnly?: boolean;
  avgPrepMins?: number | null;
}

/** Creates or replaces a restaurant's profile; audited (nothing here is
 * sensitive) unless the save changes nothing. */
export async function upsertRestaurantProfile(
  sellerId: string,
  input: UpsertRestaurantProfileInput,
  actor: OnboardingActor,
) {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { sellerType: true } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  if (seller.sellerType !== SellerType.RESTAURANT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Restaurant details only apply to a RESTAURANT-type seller.',
    });
  }

  const data = {
    cuisine: input.cuisine,
    isVegOnly: input.isVegOnly ?? false,
    avgPrepMins: input.avgPrepMins ?? null,
  };

  return runInTransaction(async (tx) => {
    const before = await tx.restaurantProfile.findUnique({ where: { sellerId } });
    const profile = await tx.restaurantProfile.upsert({
      where: { sellerId },
      update: data,
      create: { sellerId, ...data },
    });

    const unchanged =
      before !== null &&
      before.isVegOnly === data.isVegOnly &&
      before.avgPrepMins === data.avgPrepMins &&
      before.cuisine.join('\u0000') === data.cuisine.join('\u0000');
    if (unchanged) return profile;

    await tx.auditLog.create({
      data: {
        actorUserId: actor.userId,
        action: SellerAuditAction.RESTAURANT_PROFILE_UPDATE,
        entityType: 'RestaurantProfile',
        entityId: profile.id,
        ...(before
          ? { before: { cuisine: before.cuisine, isVegOnly: before.isVegOnly, avgPrepMins: before.avgPrepMins } }
          : {}),
        after: { sellerId, source: actor.type, created: !before, ...data },
      },
    });
    return profile;
  });
}

function toRestaurantProfileDto(
  profile: { cuisine: string[]; isVegOnly: boolean; avgPrepMins: number | null } | null,
) {
  if (!profile) return null;
  return { cuisine: profile.cuisine, isVegOnly: profile.isVegOnly, avgPrepMins: profile.avgPrepMins };
}

/* -------------------------------------------------------------------------- */
/* Documents — PDF uploads into PRIVATE storage + document numbers            */
/* -------------------------------------------------------------------------- */

export interface AddDocumentInput {
  type: SellerDocumentType;
  /** The number printed on the document; normalised and validated per type. */
  documentNumber?: string | null;
  expiresAt?: string | null;
}

/** The uploaded PDF as received (multer memory storage). */
export interface UploadedDocumentFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * Always INSERTS a new row, never updates an existing one — "one row per
 * document, re-uploadable on expiry/rejection": a replacement is a fresh
 * PENDING row of the same type; the earlier row stays as history.
 *
 * The file is checked by its BYTES (PDF signature), its declared type and its
 * size, then written to PRIVATE storage under a server-generated key. Only
 * metadata goes into the row; the audit entry records type/status/source —
 * never the number, the file name or the storage key.
 *
 * The seller's own upload and admin data entry both come through here, so an
 * admin-entered document is indistinguishable from a seller's: PENDING,
 * reviewed the same way, counted by the same completeness rule.
 */
export async function addDocument(
  sellerId: string,
  input: AddDocumentInput,
  file: UploadedDocumentFile | undefined,
  actor: OnboardingActor,
) {
  if (!file || file.size === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose the PDF to upload.' });
  }
  if (file.size > MAX_DOCUMENT_BYTES || file.buffer.length > MAX_DOCUMENT_BYTES) {
    throw new AppError(ErrorCode.FILE_TOO_LARGE, { message: 'The PDF must be 10 MB or smaller.' });
  }
  if (!isPdfMimeType(file.mimetype) || !hasPdfSignature(file.buffer)) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
      message: 'That file is not a PDF. Upload the document as a PDF file.',
      internalMessage: `rejected document upload: type ${file.mimetype}, pdf signature ${hasPdfSignature(file.buffer)}`,
    });
  }
  const number = normaliseDocumentNumber(input.type, input.documentNumber);
  if (!number.ok) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: number.message });

  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null }, select: { id: true } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const fileKey = buildDocumentKey(sellerId);
  await privateDocuments.put(fileKey, file.buffer, PDF_CONTENT_TYPE);

  let document;
  try {
    document = await prisma.sellerDocument.create({
      data: {
        sellerId,
        type: input.type,
        documentNumber: number.value,
        fileKey,
        fileName: safeDocumentFileName(file.originalname),
        fileSize: file.buffer.length,
        contentType: PDF_CONTENT_TYPE,
        status: DocumentStatus.PENDING,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
  } catch (error) {
    // Never leave an orphaned private file behind a failed insert.
    await privateDocuments.remove(fileKey);
    throw error;
  }

  await prisma.auditLog.create({
    data: {
      actorUserId: actor.userId,
      action: SellerAuditAction.DOCUMENT_SUBMIT,
      entityType: 'SellerDocument',
      entityId: document.id,
      after: { sellerId, type: input.type, status: document.status, source: actor.type, hasNumber: number.value !== null },
    },
  });

  return toDocumentDto(document);
}

export async function listDocuments(sellerId: string) {
  const rows = await prisma.sellerDocument.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
  return rows.map(toDocumentDto);
}

type DocumentRow = {
  id: string;
  type: SellerDocumentType;
  documentNumber: string | null;
  fileKey: string | null;
  fileName: string | null;
  fileSize: number | null;
  fileUrl: string | null;
  status: DocumentStatus;
  rejectionReason: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

/** Every document read: the number MASKED, the file by name only (never a URL or key). */
function toDocumentDto(document: DocumentRow): SellerDocumentDto {
  return {
    id: document.id,
    type: document.type,
    documentNumberMasked: maskDocumentNumber(document.type, document.documentNumber),
    hasDocumentNumber: document.documentNumber !== null,
    fileName: document.fileName,
    fileSizeBytes: document.fileSize,
    hasFile: document.fileKey !== null,
    legacyLink: document.fileKey === null && document.fileUrl !== null,
    status: document.status,
    rejectionReason: document.rejectionReason,
    expiresAt: document.expiresAt?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString(),
  };
}

/** The document, if it belongs to this (non-deleted) seller — otherwise NOT_FOUND, never "someone else's". */
async function loadOwnedDocument(sellerId: string, documentId: string) {
  const document = await prisma.sellerDocument.findFirst({
    where: { id: documentId, sellerId, seller: { deletedAt: null } },
  });
  if (!document) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Document not found.' });
  return document;
}

export interface DocumentFile {
  body: Buffer;
  fileName: string;
  contentType: string;
}

/**
 * The uploaded PDF of one of `sellerId`'s documents, read from private
 * storage. Callers (the seller's own route, the admin route) decide WHO may
 * ask; this decides WHICH document — scoped to the seller in the path.
 * Admin views are audited.
 */
export async function getDocumentFile(
  sellerId: string,
  documentId: string,
  viewer: { type: 'SELLER' | 'ADMIN'; userId: string },
): Promise<DocumentFile> {
  const document = await loadOwnedDocument(sellerId, documentId);
  if (!document.fileKey) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'This document has no uploaded PDF (it was added as a link before uploads existed). Ask the seller to upload the PDF.',
    });
  }
  const body = await privateDocuments.get(document.fileKey);
  if (viewer.type === 'ADMIN') {
    await prisma.auditLog.create({
      data: {
        actorUserId: viewer.userId,
        action: SellerAuditAction.DOCUMENT_FILE_VIEW,
        entityType: 'SellerDocument',
        entityId: document.id,
        after: { sellerId, type: document.type },
      },
    });
  }
  return { body, fileName: document.fileName ?? 'document.pdf', contentType: document.contentType ?? PDF_CONTENT_TYPE };
}

/**
 * Admin "Show": the full document number of one document. Audited (who and
 * which document — never the number itself).
 */
export async function revealDocumentNumber(sellerId: string, documentId: string, actorUserId: string) {
  const document = await loadOwnedDocument(sellerId, documentId);
  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: SellerAuditAction.DOCUMENT_NUMBER_REVEAL,
      entityType: 'SellerDocument',
      entityId: document.id,
      after: { sellerId, type: document.type },
    },
  });
  return { documentId: document.id, type: document.type, documentNumber: document.documentNumber };
}

/** Admin decision on ONE document. Only a currently-PENDING document may be
 * decided — mirrors every other review action in this codebase. The document
 * must belong to `sellerId` (the seller named in the route), and that seller
 * must not be deleted: anything else is reported exactly like a missing
 * document. */
export async function reviewDocument(
  sellerId: string,
  documentId: string,
  status: typeof DocumentStatus.VERIFIED | typeof DocumentStatus.REJECTED,
  rejectionReason: string | null | undefined,
  actorUserId: string,
) {
  if (status === DocumentStatus.REJECTED && !rejectionReason?.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'A reason is required when rejecting a document.' });
  }

  const document = await prisma.sellerDocument.findUnique({
    where: { id: documentId },
    include: { seller: { select: { deletedAt: true } } },
  });
  if (!document || document.sellerId !== sellerId || document.seller.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, {
      message: 'Document not found.',
      internalMessage: !document
        ? `document ${documentId} does not exist`
        : document.sellerId !== sellerId
          ? `document ${documentId} belongs to seller ${document.sellerId}, not ${sellerId}`
          : `document ${documentId} belongs to deleted seller ${sellerId}`,
    });
  }

  if (document.status !== DocumentStatus.PENDING) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: `This document has already been ${document.status.toLowerCase()}.`,
      internalMessage: `illegal document review transition ${document.status} -> ${status} on ${documentId}`,
    });
  }

  const updated = await prisma.sellerDocument.update({
    where: { id: documentId },
    data: {
      status,
      verifiedByUserId: actorUserId,
      verifiedAt: new Date(),
      rejectionReason: status === DocumentStatus.REJECTED ? rejectionReason!.trim() : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action: status === DocumentStatus.VERIFIED ? 'seller_document.verify' : 'seller_document.reject',
      entityType: 'SellerDocument',
      entityId: documentId,
      after: { status, rejectionReason: rejectionReason ?? null },
    },
  });

  return updated;
}

/* -------------------------------------------------------------------------- */
/* Completeness / stage                                                       */
/* -------------------------------------------------------------------------- */

/** The PAN document that satisfies the identity-document requirement. */
const IDENTITY_DOCUMENT_TYPES: readonly SellerDocumentType[] = ['PAN_CARD'];

/** The three original parts of the completeness rule, kept for the admin
 * summary's `requirements`. The full rule is `buildOnboardingChecklist`
 * (seller-lifecycle-rules.ts) — store address/location, PAN number,
 * licences — which the seller's submit and admin's approval both enforce. */
export function onboardingRequirements(
  profile: unknown,
  bank: unknown,
  documents: { type: SellerDocumentType; status: DocumentStatus }[],
): SellerOnboardingRequirementsDto {
  return {
    profile: !!profile,
    bankDetail: !!bank,
    identityDocument: documents.some(
      (d) => IDENTITY_DOCUMENT_TYPES.includes(d.type) && d.status !== DocumentStatus.REJECTED,
    ),
  };
}

export const ONBOARDING_STAGES = [
  'PENDING',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
] as const satisfies readonly SellerOnboardingStage[];

/** Every seller this filter matches has exactly `stage` (`stageFor` its lifecycle). */
export function onboardingStageWhere(stage: SellerOnboardingStage): Prisma.SellerWhereInput {
  return { lifecycleStatus: { in: lifecycleStatesForStage(stage) } };
}

type ChecklistSeller = {
  sellerType: SellerType;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
};

function checklistFor(
  seller: ChecklistSeller,
  profile: Parameters<typeof buildOnboardingChecklist>[0]['profile'],
  bankDetail: Parameters<typeof buildOnboardingChecklist>[0]['bankDetail'],
  documents: DocumentRow[],
  restaurantProfile: { cuisine: string[] } | null,
) {
  return buildOnboardingChecklist({
    sellerType: seller.sellerType,
    store: seller,
    profile,
    bankDetail,
    documents: documents.map((d) => ({
      type: d.type,
      status: d.status,
      documentNumber: d.documentNumber,
      hasFile: d.fileKey !== null,
    })),
    restaurantProfile,
  });
}

/* -------------------------------------------------------------------------- */
/* Combined detail read — shared by seller (masked) and admin (unmasked)     */
/* -------------------------------------------------------------------------- */

async function loadSellerOrThrow(sellerId: string, scopeSellerId?: string) {
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  if (!seller || (scopeSellerId && seller.id !== scopeSellerId)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  }
  return seller;
}

export async function getOnboardingDetail(
  sellerId: string,
  scopeSellerId: string | undefined,
  unmask: boolean,
): Promise<SellerOnboardingDetailDto> {
  const seller = await loadSellerOrThrow(sellerId, scopeSellerId);
  // Admin reads (no seller scope) never see a deleted seller. The seller's
  // own view is left exactly as it was.
  if (scopeSellerId === undefined && seller.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  }
  const [profile, bankDetail, documents, restaurantProfile] = await Promise.all([
    prisma.sellerProfile.findUnique({ where: { sellerId } }),
    prisma.sellerBankDetail.findUnique({ where: { sellerId } }),
    prisma.sellerDocument.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } }),
    prisma.restaurantProfile.findUnique({ where: { sellerId } }),
  ]);

  const checklist = checklistFor(seller, profile, bankDetail, documents, restaurantProfile);
  const lifecycleStatus = seller.lifecycleStatus as SellerLifecycleStatus;

  return {
    sellerId: seller.id,
    sellerName: seller.name,
    sellerType: seller.sellerType,
    onboardingStatus: seller.onboardingStatus,
    lifecycleStatus,
    lifecycleReason: seller.lifecycleReason,
    stage: stageFor(lifecycleStatus),
    isComplete: checklistComplete(checklist),
    checklist,
    profile: toProfileDto(profile, unmask),
    bankDetail: toBankDetailDto(bankDetail, unmask),
    documents: documents.map(toDocumentDto),
    restaurantProfile: toRestaurantProfileDto(restaurantProfile),
  };
}

/** The store address — shown read-only on the seller's own Profile page. */
export interface SellerStoreAddressDto {
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
}

/**
 * The seller's own onboarding view: the same masked detail as
 * getOnboardingDetail plus the store address (no seller API exposed it
 * before). Admin reads are unchanged.
 */
export async function getSellerOnboardingView(
  sellerId: string,
): Promise<SellerOnboardingDetailDto & { storeAddress: SellerStoreAddressDto | null }> {
  const [detail, seller] = await Promise.all([
    getOnboardingDetail(sellerId, sellerId, false),
    prisma.seller.findUnique({ where: { id: sellerId }, select: { addressLine: true, city: true, state: true, pincode: true } }),
  ]);
  return { ...detail, storeAddress: seller };
}

/**
 * The Admin Web's onboarding read (GET /admin/sellers/:id/onboarding/summary).
 * Safe by construction rather than by filtering:
 *   - PAN, Aadhaar and the account number go through the same masking as
 *     every other non-review read (`toProfileDto`/`toBankDetailDto`, unmask
 *     false). The masks are idempotent, so an already-masked value is not
 *     changed further.
 *   - Documents carry their number MASKED and the file by name only — no
 *     storage key and no URL (legacy links are only flagged).
 *   - Only the fields below are returned; nothing is spread from a model.
 * The bank detail keeps `id` + `updatedAt`, which the stale-view-safe
 * verification needs. A missing or deleted seller is NOT_FOUND.
 */
export async function getOnboardingSummary(sellerId: string): Promise<AdminSellerOnboardingSummaryDto> {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const [profile, bankDetail, documents, restaurantProfile, lastRejection] = await Promise.all([
    prisma.sellerProfile.findUnique({ where: { sellerId } }),
    prisma.sellerBankDetail.findUnique({ where: { sellerId } }),
    prisma.sellerDocument.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        rejectionReason: true,
        expiresAt: true,
        createdAt: true,
        verifiedAt: true,
        documentNumber: true,
        fileKey: true,
        fileName: true,
        fileSize: true,
        fileUrl: true,
      },
    }),
    prisma.restaurantProfile.findUnique({ where: { sellerId }, select: { cuisine: true } }),
    getLastOnboardingRejection(sellerId),
  ]);

  const checklist = checklistFor(seller, profile, bankDetail, documents, restaurantProfile);
  const lifecycleStatus = seller.lifecycleStatus as SellerLifecycleStatus;

  return {
    sellerId: seller.id,
    sellerName: seller.name,
    sellerType: seller.sellerType,
    onboardingStatus: seller.onboardingStatus,
    lifecycleStatus,
    lifecycleReason: seller.lifecycleReason,
    onboardingSubmittedAt: seller.onboardingSubmittedAt?.toISOString() ?? null,
    stage: stageFor(lifecycleStatus),
    isComplete: checklistComplete(checklist),
    requirements: onboardingRequirements(profile, bankDetail, documents),
    checklist,
    lastRejectionReason: lastRejection?.reason ?? null,
    lastRejectedAt: lastRejection?.rejectedAt.toISOString() ?? null,
    profile: toProfileDto(profile, false),
    bankDetail: toBankDetailDto(bankDetail, false),
    documents: documents.map((document) => ({
      id: document.id,
      type: document.type,
      documentNumberMasked: maskDocumentNumber(document.type, document.documentNumber),
      hasDocumentNumber: document.documentNumber !== null,
      fileName: document.fileName,
      fileSizeBytes: document.fileSize,
      hasFile: document.fileKey !== null,
      legacyLink: document.fileKey === null && document.fileUrl !== null,
      status: document.status,
      rejectionReason: document.rejectionReason,
      expiresAt: document.expiresAt?.toISOString() ?? null,
      createdAt: document.createdAt.toISOString(),
      reviewedAt: document.verifiedAt?.toISOString() ?? null,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Review history and queue                                                   */
/* -------------------------------------------------------------------------- */
/*
 * Submitting and deciding onboarding — Gate 1 and Gate 2 — live in
 * seller-lifecycle.service.ts.
 */

/**
 * The most recent FINAL onboarding rejection (Gate 2), read back from its
 * AuditLog entry. Null when the seller was never rejected, or when that entry
 * carries no usable reason — never a guess.
 */
export async function getLastOnboardingRejection(
  sellerId: string,
): Promise<{ reason: string; rejectedAt: Date } | null> {
  const entry = await prisma.auditLog.findFirst({
    where: { entityType: 'Seller', entityId: sellerId, action: SellerAuditAction.ONBOARDING_REJECT },
    orderBy: { createdAt: 'desc' },
    select: { after: true, createdAt: true },
  });
  if (!entry) return null;

  const after = entry.after;
  const raw = after !== null && typeof after === 'object' && !Array.isArray(after) ? after['reason'] : undefined;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  return reason ? { reason, rejectedAt: entry.createdAt } : null;
}

/** Admin's Gate 2 queue — every seller whose onboarding is submitted and
 * waiting for verification, cross-platform. MASKED: a list never carries
 * full PAN/Aadhaar/account numbers. Deleted sellers are never queued. */
export async function listOnboardingQueue(options: { cursor?: string | null; limit: number }) {
  const sellers = await prisma.seller.findMany({
    where: {
      lifecycleStatus: SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
      deletedAt: null,
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: options.limit + 1,
  });

  const hasMore = sellers.length > options.limit;
  const page = hasMore ? sellers.slice(0, options.limit) : sellers;
  const last = page[page.length - 1];

  const items = await Promise.all(page.map((s) => getOnboardingDetail(s.id, undefined, false)));

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

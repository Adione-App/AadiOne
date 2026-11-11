/**
 * Payment proof (screenshot / receipt) for a seller settlement's MANUAL
 * payout. Purely a record: nothing here moves money, and no amount, status or
 * rule of the settlement changes (seller-settlement.service.ts owns those).
 *
 *   attach — admin (SETTLEMENT_MANAGE), while the settlement is PROCESSING
 *            (about to be marked paid) or already PAID. Replacing a proof
 *            keeps the audit trail; the old file is removed after commit.
 *   read   — admin (SETTLEMENT_READ) any time a proof exists; the seller
 *            only for its OWN settlement and only once it is PAID.
 *
 * The file's type is decided from its bytes (image signature or `%PDF-`),
 * never from its name or the browser's claim; it is stored in PRIVATE storage
 * under a server-generated key and only ever streamed through these checks.
 */

import { ErrorCode, SettlementStatus } from '../../shared';
import { AppError } from '../../common/errors';
import { moduleLogger } from '../../common/logger';
import { prisma } from '../../infra/db/prisma';
import { buildPayoutProofKey, privateDocuments, type PayoutProofContentType } from '../../infra/storage/private-documents';
import { sniffImageType } from '../refunds/refund-request-rules';
import { hasPdfSignature } from './seller-document-rules';

const log = moduleLogger('settlement-proof');

const ATTACHABLE: readonly SettlementStatus[] = [SettlementStatus.PROCESSING, SettlementStatus.PAID];

/** The proof's real type from its bytes, or null when it is not an accepted image or PDF. */
export function detectProofType(bytes: Buffer): PayoutProofContentType | null {
  return sniffImageType(bytes) ?? (hasPdfSignature(bytes) ? 'application/pdf' : null);
}

const PROOF_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Download name of a proof: `payment-proof-<first 8 of the settlement id>.<ext>`. */
export const proofFileName = (settlementId: string, contentType: string) =>
  `payment-proof-${settlementId.slice(0, 8)}.${PROOF_EXT[contentType] ?? 'bin'}`;

const notFound = () => new AppError(ErrorCode.NOT_FOUND, { message: 'Settlement not found.' });

export async function attachPayoutProof(settlementId: string, file: Buffer | undefined, actorUserId: string) {
  if (!file || file.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Choose a screenshot or receipt to upload.' });
  }
  const contentType = detectProofType(file);
  if (!contentType) {
    throw new AppError(ErrorCode.UNSUPPORTED_FILE_TYPE, {
      message: 'The file is not a JPEG, PNG or WebP image or a PDF.',
      internalMessage: 'payout proof failed the signature check',
    });
  }
  const settlement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    select: { id: true, sellerId: true, status: true, payoutProofKey: true },
  });
  if (!settlement) throw notFound();
  if (!ATTACHABLE.includes(settlement.status)) {
    throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
      message: 'A payment proof can be attached once the payout is being processed or has been paid.',
      internalMessage: `payout proof refused on a ${settlement.status} settlement ${settlementId}`,
    });
  }

  const key = buildPayoutProofKey(settlementId, contentType);
  await privateDocuments.put(key, file, contentType);
  const uploadedAt = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      // Compare-and-set on the key we read: two concurrent uploads cannot
      // both replace the same proof without one of them noticing.
      const changed = await tx.sellerSettlement.updateMany({
        where: { id: settlementId, payoutProofKey: settlement.payoutProofKey, status: { in: [...ATTACHABLE] } },
        data: { payoutProofKey: key, payoutProofContentType: contentType, payoutProofUploadedAt: uploadedAt },
      });
      if (changed.count === 0) {
        throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
          message: 'This settlement changed while the proof was uploading. Please try again.',
          internalMessage: `payout proof race on ${settlementId}`,
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'settlement.payout_proof',
          entityType: 'SellerSettlement',
          entityId: settlementId,
          before: { hadProof: Boolean(settlement.payoutProofKey) },
          after: { contentType, bytes: file.length, sellerId: settlement.sellerId, status: settlement.status },
        },
      });
    });
  } catch (error) {
    await privateDocuments.remove(key).catch(() => undefined);
    throw error;
  }
  if (settlement.payoutProofKey) await privateDocuments.remove(settlement.payoutProofKey).catch(() => undefined);
  log.info({ settlementId, contentType, bytes: file.length }, 'payout proof attached');
  return { hasPayoutProof: true, payoutProofContentType: contentType, payoutProofUploadedAt: uploadedAt.toISOString() };
}

/**
 * The proof's bytes. `scopeSellerId` set = a seller asking: its own
 * settlement only (another seller's is indistinguishable from none), and only
 * once PAID.
 */
export async function readPayoutProof(settlementId: string, scopeSellerId?: string) {
  const settlement = await prisma.sellerSettlement.findUnique({
    where: { id: settlementId },
    select: { sellerId: true, status: true, payoutProofKey: true, payoutProofContentType: true },
  });
  if (!settlement || (scopeSellerId && settlement.sellerId !== scopeSellerId)) throw notFound();
  if (!settlement.payoutProofKey || !settlement.payoutProofContentType || (scopeSellerId && settlement.status !== SettlementStatus.PAID)) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'No payment proof has been attached to this settlement.' });
  }
  const body = await privateDocuments.get(settlement.payoutProofKey);
  return { body, contentType: settlement.payoutProofContentType };
}

/**
 * Sellers' acceptance of the Seller Terms and Seller Privacy Policy
 * (table legal_acceptances, one row per document accepted).
 *
 *   GET  /seller/legal/consent   the signed-in seller user's status, for the seller it acts as
 *   POST /seller/legal/consent   records an explicit "I agree" in the Seller Panel
 *
 * The same rules as customers' consent (legal-consent.service.ts):
 *   - recorded ONLY by this explicit action — never by signing in;
 *   - only while BOTH documents are published, and only for the versions
 *     published at that moment (any other version is refused: reload first);
 *   - asked again only when an admin published a version marked "ask to
 *     accept" after the last acceptance — not for every correction;
 *   - append-only: a new row per document with the server's timestamp, the
 *     published row id and the platform — no IP address or device data.
 *     Accepting the same versions twice adds nothing.
 * Acceptance is recorded per seller account: a user staffing two sellers
 * accepts for each.
 */

import {
  ErrorCode,
  INFO_PAGE_KEYS,
  legalConsentRequired,
  type AcceptSellerLegalRequest,
  type SellerLegalConsentStatusDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { legalPageVersions } from '../content/info-page.service';

const TERMS_KEY = INFO_PAGE_KEYS['seller-terms'];
const PRIVACY_KEY = INFO_PAGE_KEYS['seller-privacy'];

async function publishedVersions() {
  const [terms, privacy] = await Promise.all([legalPageVersions('seller-terms'), legalPageVersions('seller-privacy')]);
  return terms && privacy ? { terms, privacy } : null;
}

/** The latest accepted version of each document, for this user and seller. */
async function latestAcceptance(userId: string, sellerId: string) {
  const [terms, privacy] = await Promise.all(
    [TERMS_KEY, PRIVACY_KEY].map((documentKey) =>
      prisma.legalAcceptance.findFirst({
        where: { userId, sellerId, documentKey },
        orderBy: [{ revision: 'desc' }, { acceptedAt: 'desc' }],
        select: { revision: true, acceptedAt: true },
      }),
    ),
  );
  if (!terms || !privacy) return null;
  return {
    termsVersion: terms.revision,
    privacyVersion: privacy.revision,
    acceptedAt: (terms.acceptedAt > privacy.acceptedAt ? terms.acceptedAt : privacy.acceptedAt).toISOString(),
  };
}

export async function getSellerConsentStatus(userId: string, sellerId: string): Promise<SellerLegalConsentStatusDto> {
  const [versions, latest] = await Promise.all([publishedVersions(), latestAcceptance(userId, sellerId)]);
  return {
    // The shared rule, with Seller Terms in the "terms" place and Seller Privacy in "privacy".
    required: legalConsentRequired(versions ? { terms: versions.terms.required, privacy: versions.privacy.required } : null, latest),
    termsVersion: versions?.terms.current.revision ?? null,
    privacyVersion: versions?.privacy.current.revision ?? null,
    accepted: latest,
  };
}

export async function acceptSellerLegal(userId: string, sellerId: string, input: AcceptSellerLegalRequest): Promise<SellerLegalConsentStatusDto> {
  const versions = await publishedVersions();
  if (!versions) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The Seller Terms and Seller Privacy Policy have not been published yet.' });
  }
  if (input.termsVersion !== versions.terms.current.revision || input.privacyVersion !== versions.privacy.current.revision) {
    throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'The Seller Terms or Seller Privacy Policy were just updated. Please read the latest version.' });
  }
  const latest = await latestAcceptance(userId, sellerId);
  const rows = [
    { documentKey: TERMS_KEY, revision: input.termsVersion, documentId: versions.terms.current.documentId, already: latest?.termsVersion === input.termsVersion },
    { documentKey: PRIVACY_KEY, revision: input.privacyVersion, documentId: versions.privacy.current.documentId, already: latest?.privacyVersion === input.privacyVersion },
  ].filter((row) => !row.already);
  if (rows.length > 0) {
    await prisma.legalAcceptance.createMany({
      data: rows.map(({ already: _skip, ...row }) => ({ ...row, userId, sellerId, source: 'WEB' })),
    });
  }
  return getSellerConsentStatus(userId, sellerId);
}

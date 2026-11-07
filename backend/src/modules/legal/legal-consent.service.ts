/**
 * Customers' acceptance of the Privacy Policy and Terms (table legal_consents).
 *
 *   GET  /legal/consent   the signed-in customer's status
 *   POST /legal/consent   records an explicit "I agree" in the app
 *
 * Rules:
 *   - consent is recorded ONLY by this explicit action — never by signing in,
 *     never by browsing; guests are never asked;
 *   - only while BOTH pages are published (built-in wording is never
 *     "accepted"), and only for the versions published at that moment: a
 *     request naming any other version is refused (the customer reloads and
 *     sees the newer text first);
 *   - a customer is asked again only when an admin published a version marked
 *     "ask customers to accept" after their last acceptance — not for every
 *     correction;
 *   - append-only: each acceptance is a new row with the server's timestamp,
 *     the published row ids, the platform and app version — no IP address,
 *     device identifier or other personal data. Accepting the same versions
 *     twice adds nothing.
 */

import { ErrorCode, legalConsentRequired, type AcceptLegalRequest, type LegalConsentStatusDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { legalPageVersions } from '../content/info-page.service';

async function publishedVersions() {
  const [privacy, terms] = await Promise.all([legalPageVersions('privacy'), legalPageVersions('terms')]);
  return privacy && terms ? { privacy, terms } : null;
}

async function latestAcceptance(userId: string) {
  return prisma.legalConsent.findFirst({
    where: { userId },
    orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
    select: { privacyVersion: true, termsVersion: true, acceptedAt: true },
  });
}

export async function getConsentStatus(userId: string): Promise<LegalConsentStatusDto> {
  const [versions, latest] = await Promise.all([publishedVersions(), latestAcceptance(userId)]);
  return {
    required: legalConsentRequired(versions ? { privacy: versions.privacy.required, terms: versions.terms.required } : null, latest),
    privacyVersion: versions?.privacy.current.revision ?? null,
    termsVersion: versions?.terms.current.revision ?? null,
    accepted: latest ? { privacyVersion: latest.privacyVersion, termsVersion: latest.termsVersion, acceptedAt: latest.acceptedAt.toISOString() } : null,
  };
}

export async function acceptLegal(userId: string, input: AcceptLegalRequest): Promise<LegalConsentStatusDto> {
  const versions = await publishedVersions();
  if (!versions) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'The Privacy Policy and Terms have not been published yet.' });
  }
  if (input.privacyVersion !== versions.privacy.current.revision || input.termsVersion !== versions.terms.current.revision) {
    throw new AppError(ErrorCode.CONTENT_CHANGED, { message: 'The Privacy Policy or Terms were just updated. Please read the latest version.' });
  }
  const latest = await latestAcceptance(userId);
  if (!latest || latest.privacyVersion !== input.privacyVersion || latest.termsVersion !== input.termsVersion) {
    await prisma.legalConsent.create({
      data: {
        userId,
        privacyVersion: input.privacyVersion,
        termsVersion: input.termsVersion,
        privacyDocumentId: versions.privacy.current.documentId,
        termsDocumentId: versions.terms.current.documentId,
        source: input.source,
        appVersion: input.appVersion?.trim() || null,
      },
    });
  }
  return getConsentStatus(userId);
}

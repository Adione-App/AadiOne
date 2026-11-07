/**
 * Asking a signed-in customer to accept the published Privacy Policy and
 * Terms (GET / POST /legal/consent; backend legal-consent.service.ts).
 *
 * Consent is recorded ONLY when the customer taps "I agree" — never because
 * they signed in or kept using the app. Guests are never asked. "Not now"
 * hides the prompt until the app is next opened (nothing is recorded), so a
 * customer is not interrupted again and again; a newer version that an admin
 * marked "ask customers to accept" brings it back.
 *
 * The decision is pure (`shouldShowConsentPrompt`) so it is unit tested
 * (tests/legalConsent.test.ts).
 */

import type { LegalConsentStatusDto } from '../shared/info-pages';

/** Identifies what is being asked, so "Not now" applies to exactly these versions. */
export function consentPromptKey(status: Pick<LegalConsentStatusDto, 'privacyVersion' | 'termsVersion'>): string {
  return `${status.privacyVersion ?? 0}:${status.termsVersion ?? 0}`;
}

export function shouldShowConsentPrompt(
  signedIn: boolean,
  status: LegalConsentStatusDto | null | undefined,
  dismissedKey: string | null,
): boolean {
  if (!signedIn || !status?.required) return false;
  if (!status.privacyVersion || !status.termsVersion) return false;
  return dismissedKey !== consentPromptKey(status);
}

/** "Not now" for this app session only (module memory, never stored). */
let dismissed: string | null = null;
export const dismissedConsentKey = (): string | null => dismissed;
export function dismissConsentPrompt(key: string): void {
  dismissed = key;
}
export function resetConsentDismissal(): void {
  dismissed = null;
}

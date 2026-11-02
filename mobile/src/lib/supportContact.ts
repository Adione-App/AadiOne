/**
 * The support contacts the admin configured (Configuration → Platform:
 * SUPPORT_EMAIL, SUPPORT_PHONE — public config), checked before they are
 * shown: a blank, malformed or placeholder value is never shown or linked.
 * Pure — unit-tested (tests/supportContact.test.ts).
 */

export interface SupportContact {
  /** A usable email address, or null. */
  email: string | null;
  /** The number as configured (for display), or null. */
  phone: string | null;
  /** `mailto:` / `tel:` links for them (null when not usable). */
  mailto: string | null;
  tel: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Values that are clearly not real contact details. */
const PLACEHOLDER = /example\.|test@|placeholder|xxxx|0{6,}|1234567890|undefined|null/i;

export function supportContact(config: { SUPPORT_EMAIL?: string | null; SUPPORT_PHONE?: string | null } | null | undefined): SupportContact {
  const rawEmail = (config?.SUPPORT_EMAIL ?? '').trim();
  const rawPhone = (config?.SUPPORT_PHONE ?? '').trim();

  const email = EMAIL.test(rawEmail) && !PLACEHOLDER.test(rawEmail) ? rawEmail : null;

  // A dialable number: an optional + then 10–13 digits once spaces / dashes go.
  const dial = rawPhone.replace(/[\s()-]/g, '');
  const phone = /^\+?\d{10,13}$/.test(dial) && !PLACEHOLDER.test(dial) ? rawPhone : null;

  return {
    email,
    phone,
    mailto: email ? `mailto:${email}` : null,
    tel: phone ? `tel:${dial}` : null,
  };
}

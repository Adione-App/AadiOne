/** String, slug and identifier helpers. */

/** URL-safe slug: "Atta, Rice & Dal" -> "atta-rice-dal". */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Ambiguous characters (0/O, 1/I/L) removed — these get read out over a phone. */
const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFrom(alphabet: string, length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet.charAt(Math.floor(random() * alphabet.length));
  }
  return out;
}

/**
 * Order number in the mockup's format: `AD` + YYMMDD + 6 random chars.
 * Random rather than sequential so competitors cannot infer daily volume, and
 * short enough to read aloud to support.
 */
export function generateOrderNumber(now: Date = new Date(), random: () => number = Math.random): string {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `AD${yy}${mm}${dd}${randomFrom(UNAMBIGUOUS_ALPHABET, 6, random)}`;
}

export function generateReferralCode(random: () => number = Math.random): string {
  return `ADI${randomFrom(UNAMBIGUOUS_ALPHABET, 5, random)}`;
}

/** A referral reward coupon's code — same alphabet/shape as an order number
 * or a referral code, distinct prefix so it reads clearly as a reward. */
export function generateRewardCouponCode(random: () => number = Math.random): string {
  return `REF${randomFrom(UNAMBIGUOUS_ALPHABET, 6, random)}`;
}

/** Numeric OTP of the requested length, using a caller-supplied RNG. */
export function generateNumericOtp(length: number, random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(random() * 10);
  return out;
}

/**
 * The specific, house/street part of an address, shown FIRST wherever an
 * address appears compactly (Cart's address bar, the address picker, Order
 * Tracking, the COD confirm popup) — `area` alone is what the customer typed
 * as "Address Line 2" on the address form (see AddressFormScreen), so
 * showing only `area, city` was really showing line 2 while dropping line 1
 * (house number/street) entirely. Falls back to `area` only when there's no
 * house/street at all, so an older address saved without one still shows
 * something.
 */
export function addressPrimaryLine(parts: {
  houseNo?: string | null;
  street?: string | null;
  area?: string | null;
}): string {
  const line = [parts.houseNo, parts.street].filter((v): v is string => Boolean(v && v.trim())).join(', ');
  return line || parts.area || '';
}

/** "Near Shiv Mandir, Main Road, Sikar, Rajasthan 332001" from address parts. */
export function formatAddressLine(parts: {
  houseNo?: string | null;
  street?: string | null;
  area?: string | null;
  landmark?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}): string {
  const head = [
    parts.landmark ? `Near ${parts.landmark}` : null,
    parts.houseNo,
    parts.street,
    parts.area,
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(', ');

  const tail = [parts.city, parts.state].filter(Boolean).join(', ');
  return [head, tail && parts.pincode ? `${tail} ${parts.pincode}` : tail]
    .filter(Boolean)
    .join(', ');
}

export function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength - 1)}…`;
}

/** Pluralises for UI copy: "2 items", "1 item". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

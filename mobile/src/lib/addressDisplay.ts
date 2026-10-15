/**
 * Customer-facing address text for the address form, Select Location and
 * checkout.
 *
 * House number and street are ONE field in the form now. The `addresses`
 * table still has both columns: new / edited text is stored whole in
 * `street` (houseNo null), and older rows that filled both are shown joined —
 * nothing is migrated or rewritten (see AddressFormScreen).
 */

import type { StructuredAddress } from '@shared/address';

const clean = (value: string | null | undefined): string => value?.trim().replace(/\s+/g, ' ') ?? '';
const same = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** "12, Station Road" — the combined House No. + Street / Road text. */
export function houseAndStreet(address: { houseNo?: string | null; street?: string | null }): string {
  const house = clean(address.houseNo);
  const street = clean(address.street);
  if (!house) return street;
  if (!street || same(house, street)) return house;
  return `${house}, ${street}`;
}

/**
 * The complete address as short readable lines, meant to WRAP, never be cut:
 *
 *   12, Station Road
 *   Shastri Nagar, Railmagra
 *   District Rajsamand, Rajasthan 313329
 *
 * Empty parts are skipped and nothing is invented. Landmark (no longer
 * collected) and coordinates are deliberately not part of it.
 */
export function addressDetailLines(address: StructuredAddress): string[] {
  const house = houseAndStreet(address);
  const area = clean(address.area);
  const city = clean(address.city);
  const district = clean(address.district);
  const statePin = [clean(address.state), clean(address.pincode)].filter(Boolean).join(' ');

  const place = [area && !same(area, house) ? area : '', city && !same(city, area) ? city : ''].filter(Boolean).join(', ');
  const region = [district ? `District ${district}` : '', statePin].filter(Boolean).join(', ');

  return [house, place, region].filter(Boolean);
}

/**
 * The address as ONE compact line for tight spaces (the checkout bar):
 *
 *   21 B, Ram Davra, Kus Stand Kuraj, Kuraj, Rajsamand, Rajasthan 313328
 *
 * Same parts as `addressDetailLines`, each once (a district equal to the
 * town, or a part repeating an earlier one, is left out); no "District"
 * prefix. Callers clamp it to two lines — the full address stays in the
 * detailed views.
 */
export function addressSummary(address: StructuredAddress): string {
  const statePin = [clean(address.state), clean(address.pincode)].filter(Boolean).join(' ');
  const parts = [houseAndStreet(address), clean(address.area), clean(address.city), clean(address.district), statePin];
  const kept: string[] = [];
  for (const part of parts) {
    if (part && !kept.some((existing) => same(existing, part))) kept.push(part);
  }
  return kept.join(', ');
}

/**
 * A saved address's landmark when it adds something — older addresses often
 * repeat the locality (or the house / street) there. No longer collected, but
 * kept on the row and shown, never invented.
 */
export function distinctLandmark(address: StructuredAddress): string | null {
  const landmark = clean(address.landmark);
  if (!landmark) return null;
  const repeats = [houseAndStreet(address), clean(address.area)].some((part) => same(part, landmark));
  return repeats ? null : landmark;
}

/**
 * An order's delivery address from its snapshot: `line` already carries
 * house / street / locality ("Near landmark" first) and usually the town,
 * state and PIN too. Only the parts it does not already contain are added —
 * the district always is, since the snapshot line never had it.
 */
export function orderAddressText(
  line: string,
  parts: { city?: string | null; district?: string | null; state?: string | null; pincode?: string | null },
): string {
  // Stored snapshots can repeat a part ("Near Shastri Nagar, Shastri Nagar"
  // from an old landmark that copied the locality; "12, 12"): each part once,
  // and "Near X" only when X is not itself a part.
  const segments = clean(line).split(',').map((segment) => segment.trim()).filter(Boolean);
  const plain = new Set(segments.filter((s) => !/^near\s/i.test(s)).map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  const text = segments
    .filter((segment) => {
      const key = segment.toLowerCase();
      const nearOf = /^near\s+(.+)$/i.exec(segment)?.[1]?.toLowerCase();
      if (seen.has(key) || (nearOf !== undefined && plain.has(nearOf))) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
  const has = (part: string) => text.toLowerCase().includes(part.toLowerCase());
  const city = clean(parts.city);
  const district = clean(parts.district);
  const state = clean(parts.state);
  const pincode = clean(parts.pincode);
  const extra = [
    city && !has(city) ? city : '',
    district ? `District ${district}` : '',
    state && !has(state) ? state : '',
    pincode && !has(pincode) ? pincode : '',
  ].filter(Boolean);
  return [text, ...extra].filter(Boolean).join(', ');
}

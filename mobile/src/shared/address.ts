/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Indian addresses — the one structure every address form and display uses.
 *
 *   1. House / building / shop number   (houseNo, or the store's addressLine)
 *   2. Street / road                    (street)
 *   3. Locality / mohalla / colony      (area)
 *   4. Village / city / town            (city)      required — ONE field: a
 *                                                   rural address has a village,
 *                                                   an urban one a city
 *   5. District                         (district)  required, its own field
 *   6. State                            (state)     required
 *   7. PIN code                         (pincode)   required, 6 digits
 *   8. Landmark                         (landmark)  optional
 *   9. Latitude / longitude             stored separately; never derived from
 *                                       these strings or the PIN.
 *
 * A PIN code covers many villages and localities: it is validated as a PIN,
 * never used as a location.
 */

import { isValidPincode } from './phone';

export { isValidPincode };

/** States and union territories, for the State picker. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const;

export interface StructuredAddress {
  houseNo?: string | null;
  street?: string | null;
  /** Locality / mohalla / colony. */
  area?: string | null;
  /** Village / city / town. */
  city?: string | null;
  district?: string | null;
  state?: string | null;
  pincode?: string | null;
  landmark?: string | null;
}

export type AddressField = keyof StructuredAddress;

export const ADDRESS_FIELD_LABEL: Record<AddressField, string> = {
  houseNo: 'House / building / shop no.',
  street: 'Street / road',
  area: 'Locality / mohalla / colony',
  city: 'Village / City / Town',
  district: 'District',
  state: 'State',
  pincode: 'PIN code',
  landmark: 'Landmark',
};

const filled = (value: string | null | undefined) => !!value && value.trim().length >= 2;

/** Required fields still missing or invalid, in form order. */
export function missingAddressFields(address: StructuredAddress, options: { requireArea?: boolean } = {}): AddressField[] {
  const missing: AddressField[] = [];
  if (options.requireArea && !filled(address.area)) missing.push('area');
  if (!filled(address.city)) missing.push('city');
  if (!filled(address.district)) missing.push('district');
  if (!filled(address.state)) missing.push('state');
  if (!address.pincode || !isValidPincode(address.pincode)) missing.push('pincode');
  return missing;
}

const part = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Two display lines:
 *   line1  house / shop, street, locality
 *   line2  village / city, district (when different), state PIN
 * plus the landmark. Older addresses without a district show without one —
 * nothing is invented.
 */
export function formatAddressLines(address: StructuredAddress): { line1: string; line2: string; landmark: string | null } {
  const city = part(address.city);
  const district = part(address.district);
  const line1 = [part(address.houseNo), part(address.street), part(address.area)]
    .filter((v, i, all): v is string => !!v && all.findIndex((x) => same(x, v)) === i)
    .join(', ');
  const statePin = [part(address.state), part(address.pincode)].filter(Boolean).join(' ');
  const line2 = [city, district && !same(district, city) ? `District ${district}` : null, statePin].filter(Boolean).join(', ');
  return { line1, line2, landmark: part(address.landmark) };
}

const POSITION_WORD = /^(near|opp\.?|opposite|behind|beside|next to|in front of|close to|adjacent to|infront of)\b/i;

/** "Near Shiv Mandir" — but "Opposite the post office" / "Near the school" are left as typed. */
export function landmarkPhrase(landmark: string): string {
  return POSITION_WORD.test(landmark) ? landmark : `Near ${landmark}`;
}

/** One line: "12, Station Road, Shastri Nagar, Sikar, District Sikar…" — for lists and summaries. */
export function formatAddressOneLine(address: StructuredAddress): string {
  const { line1, line2, landmark } = formatAddressLines(address);
  return [line1, landmark ? landmarkPhrase(landmark) : null, line2].filter(Boolean).join(', ');
}

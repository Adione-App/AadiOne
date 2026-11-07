/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * What customers are shown about the seller behind a product, a restaurant or
 * an order ("Seller details").
 *
 * The Consumer Protection (E-Commerce) Rules, 2020 (rule 5(3), in force since
 * July 2020) require a marketplace to give customers details of each seller,
 * including the name of its business, its geographic address and a customer-
 * care number. Every value here is the seller's own record — nothing is made
 * up — and nothing beyond the disclosure is exposed:
 *   - the store's business address (where the shop is), never the owner's;
 *   - the customer-care phone / email the seller CHOSE to publish
 *     (sellers.customer_care_*), never `sellers.phone`, which holds the
 *     owner's personal mobile from sign-up;
 *   - the FSSAI licence / registration number for food sellers.
 * PAN, Aadhaar, bank details, the owner's name and mobile are never included.
 *
 * Missing details are shown to admins as warnings (`sellerDisclosureGaps`).
 * Pure and dependency-free (shared by backend, web admin and mobile).
 */

export interface SellerDetailsDto {
  sellerId: string;
  /** The name customers see on the store / restaurant. */
  displayName: string;
  /** The registered business name, when the seller gave one. */
  businessName: string | null;
  sellerType: string;
  /** One line, e.g. "Shop 4, Main Bazaar, Railmagra, Rajsamand, Rajasthan 313329". */
  address: string;
  customerCare: { phone: string | null; email: string | null };
  /** Food sellers' FSSAI licence / registration number, when recorded. */
  fssaiNumber: string | null;
}

export interface SellerAddressParts {
  addressLine: string;
  locality?: string | null;
  city: string;
  district?: string | null;
  state: string;
  pincode: string;
}

/** The store address as one line, skipping empty or repeated parts. */
export function formatSellerAddress(parts: SellerAddressParts): string {
  const seen = new Set<string>();
  const pieces = [parts.addressLine, parts.locality, parts.city, parts.district]
    .map((part) => part?.trim() ?? '')
    .filter((part) => {
      const key = part.toLowerCase();
      if (!part || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const tail = [parts.state?.trim(), parts.pincode?.trim()].filter(Boolean).join(' ');
  return [...pieces, tail].filter(Boolean).join(', ');
}

export interface SellerDisclosureInput {
  businessName: string | null | undefined;
  customerCarePhone: string | null | undefined;
  customerCareEmail: string | null | undefined;
  fssaiNumber: string | null | undefined;
  isFoodSeller: boolean;
}

/** What a seller has not provided yet, as admin-readable warnings (empty = complete). */
export function sellerDisclosureGaps(input: SellerDisclosureInput): string[] {
  const gaps: string[] = [];
  if (!input.businessName?.trim()) gaps.push('Registered business name');
  if (!input.customerCarePhone?.trim() && !input.customerCareEmail?.trim()) gaps.push('Customer-care phone or email for customers');
  if (input.isFoodSeller && !input.fssaiNumber?.trim()) gaps.push('FSSAI licence / registration number');
  return gaps;
}

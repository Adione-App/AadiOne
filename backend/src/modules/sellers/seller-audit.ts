/**
 * AuditLog `action` names for seller management — kept in one place so the
 * code that writes an entry and the code that reads it back (e.g.
 * `getLastOnboardingRejection`) can never drift apart. Same `entity.verb`
 * naming as every other action in the audit log; action strings that already
 * existed inline elsewhere are unchanged.
 */

export const SellerAuditAction = {
  /** Admin switched a (non-platform) seller's `isActive` on. */
  ACTIVATE: 'seller.activate',
  /** Admin switched a (non-platform) seller's `isActive` off. */
  DEACTIVATE: 'seller.deactivate',
  /** Admin edited a seller's basic details (name/phone/address/location). */
  UPDATE: 'seller.update',
  /** SellerProfile created or changed — by the seller or by admin. */
  PROFILE_UPDATE: 'seller_profile.update',
  /** SellerBankDetail created or changed — by the seller or by admin. */
  BANK_DETAIL_UPDATE: 'seller_bank_detail.update',
  /** Admin verified a seller's payout account. */
  BANK_DETAIL_VERIFY: 'seller_bank_detail.verify',
  /** RestaurantProfile created or changed. */
  RESTAURANT_PROFILE_UPDATE: 'restaurant_profile.update',
  /** Onboarding document added — by the seller or entered by admin
   * (`after.source`). Type/status only; never the link or contents. */
  DOCUMENT_SUBMIT: 'seller_document.submit',
  /** Admin revealed a document NUMBER (Show). The number itself is never stored here. */
  DOCUMENT_NUMBER_REVEAL: 'seller_document.number_reveal',
  /** Admin opened an uploaded document PDF. */
  DOCUMENT_FILE_VIEW: 'seller_document.file_view',
  /** Onboarding rejected; `after.reason` holds the only stored copy of the reason. */
  ONBOARDING_REJECT: 'seller_onboarding.reject',
} as const;

export type SellerAuditAction = (typeof SellerAuditAction)[keyof typeof SellerAuditAction];

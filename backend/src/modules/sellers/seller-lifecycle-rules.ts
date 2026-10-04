/**
 * Seller lifecycle rules — pure, no I/O.
 *
 * The two-gate lifecycle (schema.prisma's SellerLifecycleStatus):
 *
 *   APPLICATION_PENDING --Gate 1 approve--> ONBOARDING_PENDING
 *                       --Gate 1 reject---> APPLICATION_REJECTED (terminal)
 *   ONBOARDING_PENDING / ONBOARDING_CHANGES_REQUIRED --submit--> ONBOARDING_PENDING_REVIEW
 *   ONBOARDING_PENDING_REVIEW --Gate 2 approve---------> ACTIVE
 *                             --Gate 2 request changes-> ONBOARDING_CHANGES_REQUIRED
 *                             --Gate 2 reject----------> ONBOARDING_REJECTED (terminal)
 *
 * This file decides (1) which Seller Panel API paths a seller in each state
 * may call — enforced by middleware/sellerLifecycle.ts on every /seller
 * request — and (2) the onboarding checklist that must be complete before a
 * submission. Both are plain functions so they can be unit-tested and so the
 * seller panel, the admin review and the submit/approve checks all read the
 * same rule.
 */

import {
  ApprovalStatus,
  DocumentStatus,
  SellerLifecycleStatus,
  SellerType,
  isFoodSellerType,
  type SellerDocumentType,
  type SellerOnboardingChecklistItemDto,
  type SellerOnboardingStage,
} from '../../shared';
import { isValidCoordinates } from '../../shared/distance';
import { normalizeIndianMobile } from '../../shared/phone';

/* -------------------------------------------------------------------------- */
/* State facts                                                                */
/* -------------------------------------------------------------------------- */

/** The seller fills in / corrects its onboarding in these states. */
export const EDITABLE_ONBOARDING_STATES: readonly SellerLifecycleStatus[] = [
  SellerLifecycleStatus.ONBOARDING_PENDING,
  SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED,
];

/** Past Gate 1: the seller may at least READ its onboarding record. */
const ONBOARDING_VISIBLE_STATES: readonly SellerLifecycleStatus[] = [
  SellerLifecycleStatus.ONBOARDING_PENDING,
  SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
  SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED,
  SellerLifecycleStatus.ONBOARDING_REJECTED,
  SellerLifecycleStatus.ACTIVE,
];

export function isOnboardingEditable(status: SellerLifecycleStatus): boolean {
  return EDITABLE_ONBOARDING_STATES.includes(status);
}

/** `Seller.onboardingStatus` for a lifecycle state — the column every
 * "is this seller live" rule reads (CHECK sellers_lifecycle_matches_onboarding). */
export function onboardingStatusFor(status: SellerLifecycleStatus): ApprovalStatus {
  if (status === SellerLifecycleStatus.ACTIVE) return ApprovalStatus.APPROVED;
  if (status === SellerLifecycleStatus.ONBOARDING_REJECTED) return ApprovalStatus.REJECTED;
  return ApprovalStatus.PENDING;
}

/** The coarse stage older screens show. */
export function stageFor(status: SellerLifecycleStatus): SellerOnboardingStage {
  switch (status) {
    case SellerLifecycleStatus.ACTIVE:
      return 'APPROVED';
    case SellerLifecycleStatus.APPLICATION_REJECTED:
    case SellerLifecycleStatus.ONBOARDING_REJECTED:
      return 'REJECTED';
    case SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW:
      return 'SUBMITTED';
    default:
      return 'PENDING';
  }
}

/** Lifecycle states a coarse `stage` filter covers (inverse of `stageFor`). */
export function lifecycleStatesForStage(stage: SellerOnboardingStage): SellerLifecycleStatus[] {
  return (Object.values(SellerLifecycleStatus) as SellerLifecycleStatus[]).filter((s) => stageFor(s) === stage);
}

/* -------------------------------------------------------------------------- */
/* Seller Panel API access                                                    */
/* -------------------------------------------------------------------------- */

export type SellerPanelAccess =
  | { allowed: true }
  | { allowed: false; reason: 'NOT_ACTIVE' | 'UNDER_REVIEW' | 'NO_ONBOARDING' };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for `/<segment>` itself or anything below it. */
function under(path: string, segment: string): boolean {
  return path === segment || path.startsWith(`${segment}/`);
}

/**
 * May a seller in `status` call `method path` (path relative to the /seller
 * mount, e.g. `/orders/123`)?
 *
 *   /lifecycle            — always (the panel must always be able to explain itself).
 *   /onboarding/**, /location
 *                         — read once past Gate 1; write only while onboarding
 *                           is editable (or once ACTIVE, as before: bank
 *                           details, documents, store location stay the
 *                           seller's own). Locked while under review.
 *   everything else       — ACTIVE only (orders, products, categories,
 *                           inventory, availability, earnings, settlements,
 *                           commission, notifications, activity, menu…).
 *
 * Deny by default: a path not named here needs ACTIVE.
 */
export function sellerPanelAccess(status: SellerLifecycleStatus, method: string, path: string): SellerPanelAccess {
  const normalised = path.replace(/\/+$/, '') || '/';
  const isRead = READ_METHODS.has(method.toUpperCase());

  if (normalised === '/lifecycle' && isRead) return { allowed: true };

  if (status === SellerLifecycleStatus.ACTIVE) return { allowed: true };

  const onboardingArea = under(normalised, '/onboarding') || normalised === '/location';
  if (!onboardingArea) return { allowed: false, reason: 'NOT_ACTIVE' };

  if (!ONBOARDING_VISIBLE_STATES.includes(status)) return { allowed: false, reason: 'NO_ONBOARDING' };
  if (isRead) return { allowed: true };
  if (isOnboardingEditable(status)) return { allowed: true };
  return {
    allowed: false,
    reason: status === SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW ? 'UNDER_REVIEW' : 'NOT_ACTIVE',
  };
}

/**
 * Is `method path` (relative to the /seller mount) a write to the seller's
 * own onboarding data — business/contact/tax profile, bank account,
 * restaurant details, documents, store address/location, or the submission?
 *
 * That data is the SELLER's: admin views and reviews it (admin-seller.routes
 * has read and decision routes only) but never writes it, not even through
 * a seller route — middleware/sellerLifecycle.ts refuses these for admin roles.
 */
export function isSellerOnboardingWrite(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  const normalised = path.replace(/\/+$/, '') || '/';
  return under(normalised, '/onboarding') || normalised === '/location';
}

/* -------------------------------------------------------------------------- */
/* Onboarding checklist                                                       */
/* -------------------------------------------------------------------------- */

export interface ChecklistInput {
  sellerType: SellerType;
  store: {
    addressLine: string;
    city: string;
    state: string;
    pincode: string;
    latitude: number;
    longitude: number;
  };
  profile: {
    businessName: string;
    ownerFullName: string;
    ownerMobile: string;
    ownerEmail: string | null;
    panNumber: string | null;
    gstNumber: string | null;
    fssaiNumber: string | null;
  } | null;
  bankDetail: { accountHolderName: string; accountNumber: string; ifscCode: string } | null;
  documents: { type: SellerDocumentType; status: DocumentStatus; documentNumber?: string | null; hasFile?: boolean }[];
  restaurantProfile: { cuisine: string[] } | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A current (not rejected) uploaded document of `type` carrying its number. */
function hasDocument(input: ChecklistInput, type: SellerDocumentType): boolean {
  return input.documents.some(
    (d) =>
      d.type === type &&
      d.status !== DocumentStatus.REJECTED &&
      d.hasFile !== false &&
      (d.documentNumber === undefined || (d.documentNumber !== null && d.documentNumber.trim() !== '')),
  );
}

/**
 * Every item the seller must complete before "Submit for Verification" —
 * and that admin must see complete before Gate 2 approval. GST is optional
 * (small/unregistered sellers), but a declared GSTIN needs its certificate;
 * FSSAI and the restaurant profile apply to restaurants.
 */
export function buildOnboardingChecklist(input: ChecklistInput): SellerOnboardingChecklistItemDto[] {
  const { profile, store } = input;
  const isRestaurant = isFoodSellerType(input.sellerType);
  const items: SellerOnboardingChecklistItemDto[] = [
    {
      key: 'business',
      label: 'Business details',
      met: !!profile && profile.businessName.trim().length >= 2 && profile.ownerFullName.trim().length >= 2,
      hint: 'Add your business name and the owner’s full name.',
    },
    {
      key: 'contact',
      label: 'Contact details',
      met: !!profile && !!normalizeIndianMobile(profile.ownerMobile) && !!profile.ownerEmail && EMAIL_PATTERN.test(profile.ownerEmail),
      hint: 'Add the owner’s mobile number and email address.',
    },
    {
      key: 'storeAddress',
      label: 'Store address',
      met:
        store.addressLine.trim().length >= 2 &&
        store.city.trim().length >= 2 &&
        store.state.trim().length >= 2 &&
        /^\d{6}$/.test(store.pincode),
      hint: 'Add the full store address with city, state and 6-digit pincode.',
    },
    {
      key: 'storeLocation',
      label: 'Store location on map',
      met: isValidCoordinates(store.latitude, store.longitude) && !(store.latitude === 0 && store.longitude === 0),
      hint: 'Set your store’s location (use current location or enter the coordinates).',
    },
    {
      key: 'bank',
      label: 'Bank account',
      met: !!input.bankDetail,
      hint: 'Add the bank account your settlements are paid into.',
    },
    {
      key: 'panNumber',
      label: 'PAN number',
      met: !!profile?.panNumber?.trim(),
      hint: 'Enter your PAN in Business details.',
    },
    {
      key: 'panDocument',
      label: 'PAN card (PDF)',
      met: hasDocument(input, 'PAN_CARD'),
      hint: 'Upload your PAN card as a PDF with its number.',
    },
  ];

  if (profile?.gstNumber?.trim()) {
    items.push({
      key: 'gstDocument',
      label: 'GST certificate (PDF)',
      met: hasDocument(input, 'GST_CERTIFICATE'),
      hint: 'You entered a GST number — upload the GST certificate as a PDF.',
    });
  }

  if (isRestaurant) {
    items.push(
      {
        key: 'fssaiNumber',
        label: 'FSSAI licence number',
        met: !!profile?.fssaiNumber?.trim(),
        hint: 'Restaurants need an FSSAI licence — enter its number in Business details.',
      },
      {
        key: 'fssaiDocument',
        label: 'FSSAI licence (PDF)',
        met: hasDocument(input, 'FSSAI_LICENSE'),
        hint: 'Upload your FSSAI licence as a PDF with its number.',
      },
      {
        key: 'restaurantProfile',
        label: 'Restaurant details',
        met: !!input.restaurantProfile && input.restaurantProfile.cuisine.length > 0,
        hint: 'Add at least one cuisine in Restaurant details.',
      },
    );
  }

  return items;
}

export function checklistComplete(items: readonly SellerOnboardingChecklistItemDto[]): boolean {
  return items.every((item) => item.met);
}

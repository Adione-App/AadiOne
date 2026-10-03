/**
 * Seller labels and status pills shared by the Sellers list and the Seller
 * detail page, so both describe a seller in exactly the same words.
 *
 * Three facts are always kept apart:
 *   isActive            — the ADMIN switch;
 *   isAcceptingOrders   — the SELLER's own Store Open/Closed switch;
 *   acceptingOrdersNow  — what the two, plus hours/closures, mean right now.
 * And a seller that is not APPROVED cannot be ordered from whatever they say.
 */

import type { ReactNode } from 'react';
import {
  ApprovalStatus,
  SellerType,
  type SellerClosedReason,
  type SellerLifecycleFilter,
  type SellerOnboardingStage,
} from '@shared';
import { Pill, type Tone } from '@/components/ui';

/** One label/value line of a seller detail panel. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="text-sm text-gray-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-gray-900">{children ?? '—'}</dd>
    </div>
  );
}

export const SELLER_TYPE_LABEL: Record<SellerType, string> = {
  [SellerType.GROCERY]: 'Grocery',
  [SellerType.FASHION]: 'Fashion',
  [SellerType.ELECTRONICS]: 'Electronics',
  [SellerType.BEAUTY]: 'Beauty',
  [SellerType.HOME]: 'Home',
  [SellerType.PHARMACY]: 'Pharmacy',
  [SellerType.RESTAURANT]: 'Restaurant',
  [SellerType.SPORTS]: 'Sports',
  [SellerType.BOOKS]: 'Books',
  [SellerType.KIDS]: 'Kids',
  [SellerType.AUTOMOTIVE]: 'Automotive',
  [SellerType.PETS]: 'Pets',
  [SellerType.SERVICES]: 'Services',
  [SellerType.OTHER]: 'Other',
};

export const ONBOARDING_LOOK: Record<string, { label: string; tone: Tone }> = {
  [ApprovalStatus.PENDING]: { label: 'Pending', tone: 'amber' },
  [ApprovalStatus.APPROVED]: { label: 'Approved', tone: 'brand' },
  [ApprovalStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

export const STAGE_LOOK: Record<SellerOnboardingStage, { label: string; tone: Tone; hint: string }> = {
  PENDING: { label: 'Pending', tone: 'gray', hint: 'Profile, bank details or an identity document still missing' },
  SUBMITTED: { label: 'Submitted', tone: 'blue', hint: 'Complete and ready for review' },
  APPROVED: { label: 'Approved', tone: 'brand', hint: 'Onboarding approved' },
  REJECTED: { label: 'Rejected', tone: 'red', hint: 'Onboarding rejected' },
};

/**
 * The two-gate lifecycle as admin sees it. Gate 1 = the application, Gate 2 =
 * verification of the submitted onboarding. SUSPENDED is an ACTIVE seller
 * switched off by admin.
 */
export const LIFECYCLE_LOOK: Record<SellerLifecycleFilter, { label: string; tone: Tone; hint: string }> = {
  APPLICATION_PENDING: { label: 'Application Pending', tone: 'amber', hint: 'Gate 1 — waiting for admin approval of the application' },
  APPLICATION_REJECTED: { label: 'Application Rejected', tone: 'red', hint: 'Gate 1 — application rejected' },
  ONBOARDING_PENDING: { label: 'Onboarding Pending', tone: 'blue', hint: 'Application approved — seller is filling in onboarding' },
  ONBOARDING_CHANGES_REQUIRED: { label: 'Changes Required', tone: 'amber', hint: 'Gate 2 — admin asked the seller for changes' },
  ONBOARDING_PENDING_REVIEW: { label: 'Under Review', tone: 'purple', hint: 'Gate 2 — onboarding submitted, waiting for verification' },
  ACTIVE: { label: 'Active', tone: 'brand', hint: 'Verified — full Seller Panel' },
  SUSPENDED: { label: 'Suspended', tone: 'gray', hint: 'Active seller switched off by admin' },
  ONBOARDING_REJECTED: { label: 'Rejected', tone: 'red', hint: 'Gate 2 — seller rejected' },
};

export function LifecyclePill({ status, isActive = true }: { status: SellerLifecycleFilter; isActive?: boolean }) {
  const key: SellerLifecycleFilter = status === 'ACTIVE' && !isActive ? 'SUSPENDED' : status;
  const look = LIFECYCLE_LOOK[key] ?? { label: status, tone: 'gray' as Tone, hint: '' };
  return (
    <span title={look.hint}>
      <Pill tone={look.tone}>{look.label}</Pill>
    </span>
  );
}

export const CLOSED_REASON_LABEL: Record<SellerClosedReason, string> = {
  SELLER_DELETED: 'Deleted',
  SELLER_INACTIVE: 'Switched off by admin',
  MANUALLY_CLOSED: 'Closed by seller',
  CLOSURE: 'Holiday closure today',
  CLOSED_TODAY: 'Closed today',
  OUTSIDE_HOURS: 'Outside opening hours',
};

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
});
export const formatSellerDate = (iso: string): string => dateFormat.format(new Date(iso));

export function OnboardingPill({ status }: { status: string }) {
  const look = ONBOARDING_LOOK[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

export function StagePill({ stage }: { stage: SellerOnboardingStage }) {
  const look = STAGE_LOOK[stage] ?? { label: stage, tone: 'gray' as Tone, hint: '' };
  return (
    <span title={look.hint}>
      <Pill tone={look.tone}>{look.label}</Pill>
    </span>
  );
}

export function ActivePill({ isActive }: { isActive: boolean }) {
  return <Pill tone={isActive ? 'brand' : 'gray'}>{isActive ? 'Active' : 'Inactive'}</Pill>;
}

export interface SellerAvailabilityFacts {
  isActive: boolean;
  isAcceptingOrders: boolean;
  acceptingOrdersNow: boolean;
  isOpenNow: boolean;
  closedReason: SellerClosedReason | null;
  onboardingStatus: string;
}

/** Orders availability: open / closed (with why) / inactive. */
export function SellerAvailability({ facts }: { facts: SellerAvailabilityFacts }) {
  const pill = !facts.isActive ? (
    <Pill tone="gray">Inactive</Pill>
  ) : facts.acceptingOrdersNow ? (
    <Pill tone="brand">{facts.isOpenNow ? 'Open' : 'Accepting (closed hours)'}</Pill>
  ) : (
    <Pill tone="amber">Closed</Pill>
  );

  const detail = !facts.isActive
    ? 'Switched off by admin'
    : !facts.acceptingOrdersNow && facts.closedReason
      ? CLOSED_REASON_LABEL[facts.closedReason] ?? facts.closedReason
      : null;

  return (
    <div>
      {pill}
      {detail && <p className="mt-1 text-xs text-gray-500">{detail}</p>}
      {facts.onboardingStatus !== ApprovalStatus.APPROVED && (
        <p className="mt-1 text-xs text-warn-500">Not live until approved</p>
      )}
    </div>
  );
}

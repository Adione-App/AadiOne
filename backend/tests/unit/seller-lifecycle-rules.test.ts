/**
 * Seller two-gate lifecycle rules — which Seller Panel APIs each lifecycle
 * state may call, the onboarding checklist, and the onboardingStatus/stage
 * mapping. DB-free.
 */

import { describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerLifecycleStatus, SellerType } from '../../src/shared';
import {
  buildOnboardingChecklist,
  checklistComplete,
  isOnboardingEditable,
  isSellerOnboardingWrite,
  lifecycleStatesForStage,
  onboardingStatusFor,
  sellerPanelAccess,
  stageFor,
  type ChecklistInput,
} from '../../src/modules/sellers/seller-lifecycle-rules';

const S = SellerLifecycleStatus;
const ALL = Object.values(S);

/** Every operational area of the Seller Panel API (relative to /seller). */
const OPERATIONAL: [string, string][] = [
  ['GET', '/orders'],
  ['GET', '/orders/summary'],
  ['PATCH', '/orders/abc/status'],
  ['GET', '/products'],
  ['POST', '/products'],
  ['GET', '/categories'],
  ['POST', '/categories'],
  ['POST', '/subcategories'],
  ['GET', '/listings'],
  ['POST', '/listings/abc/stock-adjust'],
  ['GET', '/earnings'],
  ['GET', '/earnings/today'],
  ['GET', '/settlements'],
  ['GET', '/availability'],
  ['PATCH', '/availability'],
  ['PUT', '/hours'],
  ['GET', '/commission'],
  ['GET', '/notifications'],
  ['GET', '/activity'],
  ['GET', '/menu-sections'],
  ['POST', '/uploads/presign'],
  ['POST', '/approval-batches'],
];

describe('sellerPanelAccess', () => {
  it('lets every state read its own lifecycle', () => {
    for (const status of ALL) expect(sellerPanelAccess(status, 'GET', '/lifecycle')).toEqual({ allowed: true });
  });

  it('blocks every operational API for every state except ACTIVE', () => {
    for (const status of ALL) {
      for (const [method, path] of OPERATIONAL) {
        expect(sellerPanelAccess(status, method, path).allowed, `${status} ${method} ${path}`).toBe(
          status === S.ACTIVE,
        );
      }
    }
  });

  it('gives applicants (pending or rejected) no onboarding access at all', () => {
    for (const status of [S.APPLICATION_PENDING, S.APPLICATION_REJECTED]) {
      expect(sellerPanelAccess(status, 'GET', '/onboarding').allowed).toBe(false);
      expect(sellerPanelAccess(status, 'PUT', '/onboarding/profile').allowed).toBe(false);
      expect(sellerPanelAccess(status, 'POST', '/onboarding/documents').allowed).toBe(false);
      expect(sellerPanelAccess(status, 'PATCH', '/location').allowed).toBe(false);
    }
  });

  it('lets onboarding / changes-required sellers read AND write onboarding, documents and location', () => {
    for (const status of [S.ONBOARDING_PENDING, S.ONBOARDING_CHANGES_REQUIRED]) {
      for (const [method, path] of [
        ['GET', '/onboarding'],
        ['PUT', '/onboarding/profile'],
        ['PUT', '/onboarding/bank-detail'],
        ['PUT', '/onboarding/restaurant-profile'],
        ['POST', '/onboarding/documents'],
        ['GET', '/onboarding/documents/123/file'],
        ['POST', '/onboarding/submit'],
        ['GET', '/location'],
        ['PATCH', '/location'],
      ] as const) {
        expect(sellerPanelAccess(status, method, path).allowed, `${status} ${method} ${path}`).toBe(true);
      }
    }
  });

  it('locks onboarding writes while under review, but still lets the seller read it', () => {
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'GET', '/onboarding').allowed).toBe(true);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'GET', '/location').allowed).toBe(true);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'PUT', '/onboarding/profile')).toEqual({
      allowed: false,
      reason: 'UNDER_REVIEW',
    });
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'POST', '/onboarding/documents').allowed).toBe(false);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'POST', '/onboarding/submit').allowed).toBe(false);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING_REVIEW, 'PATCH', '/location').allowed).toBe(false);
  });

  it('keeps a finally-rejected seller read-only', () => {
    expect(sellerPanelAccess(S.ONBOARDING_REJECTED, 'GET', '/onboarding').allowed).toBe(true);
    expect(sellerPanelAccess(S.ONBOARDING_REJECTED, 'PUT', '/onboarding/profile').allowed).toBe(false);
    expect(sellerPanelAccess(S.ONBOARDING_REJECTED, 'GET', '/orders').allowed).toBe(false);
  });

  it('is not fooled by look-alike paths, trailing slashes or method case', () => {
    expect(sellerPanelAccess(S.ONBOARDING_PENDING, 'GET', '/onboardingX').allowed).toBe(false);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING, 'GET', '/locations').allowed).toBe(false);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING, 'GET', '/onboarding/').allowed).toBe(true);
    expect(sellerPanelAccess(S.ONBOARDING_PENDING, 'get', '/orders').allowed).toBe(false);
    expect(sellerPanelAccess(S.APPLICATION_PENDING, 'POST', '/lifecycle').allowed).toBe(false);
  });

  it('gives ACTIVE sellers the whole panel', () => {
    for (const [method, path] of OPERATIONAL) expect(sellerPanelAccess(S.ACTIVE, method, path).allowed).toBe(true);
    expect(sellerPanelAccess(S.ACTIVE, 'PUT', '/onboarding/bank-detail').allowed).toBe(true);
  });
});

describe('lifecycle mappings', () => {
  it('maps onboardingStatus so only ACTIVE is APPROVED (customer visibility)', () => {
    for (const status of ALL) {
      expect(onboardingStatusFor(status)).toBe(
        status === S.ACTIVE
          ? ApprovalStatus.APPROVED
          : status === S.ONBOARDING_REJECTED
            ? ApprovalStatus.REJECTED
            : ApprovalStatus.PENDING,
      );
    }
  });

  it('derives the coarse stage and its inverse filter consistently', () => {
    expect(stageFor(S.ACTIVE)).toBe('APPROVED');
    expect(stageFor(S.ONBOARDING_PENDING_REVIEW)).toBe('SUBMITTED');
    expect(stageFor(S.APPLICATION_REJECTED)).toBe('REJECTED');
    expect(stageFor(S.APPLICATION_PENDING)).toBe('PENDING');
    for (const stage of ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const) {
      for (const status of lifecycleStatesForStage(stage)) expect(stageFor(status)).toBe(stage);
    }
  });

  it('only onboarding and changes-required are editable', () => {
    expect(ALL.filter(isOnboardingEditable)).toEqual([S.ONBOARDING_PENDING, S.ONBOARDING_CHANGES_REQUIRED]);
  });
});

const complete: ChecklistInput = {
  sellerType: SellerType.GROCERY,
  store: { addressLine: '12 Station Road', city: 'Sikar', state: 'Rajasthan', pincode: '332001', latitude: 27.61, longitude: 75.14 },
  profile: {
    businessName: 'Sharma Kirana',
    ownerFullName: 'Ravi Sharma',
    ownerMobile: '9876543210',
    ownerEmail: 'ravi@example.com',
    panNumber: 'ABCDE1234F',
    gstNumber: null,
    fssaiNumber: null,
  },
  bankDetail: { accountHolderName: 'Ravi Sharma', accountNumber: '123456789012', ifscCode: 'SBIN0001234' },
  documents: [{ type: 'PAN_CARD', status: 'PENDING', documentNumber: 'ABCDE1234F', hasFile: true }],
  restaurantProfile: null,
};

const unmet = (input: ChecklistInput) => buildOnboardingChecklist(input).filter((i) => !i.met).map((i) => i.key);

describe('buildOnboardingChecklist', () => {
  it('is complete for a grocery seller with business, contact, address, location, bank and PAN', () => {
    expect(unmet(complete)).toEqual([]);
    expect(checklistComplete(buildOnboardingChecklist(complete))).toBe(true);
  });

  it('flags a fresh application: no address, no location, no bank, no PAN', () => {
    const fresh: ChecklistInput = {
      ...complete,
      store: { addressLine: '', city: '', state: '', pincode: '', latitude: 0, longitude: 0 },
      profile: { ...complete.profile!, panNumber: null },
      bankDetail: null,
      documents: [],
    };
    expect(unmet(fresh)).toEqual(['storeAddress', 'storeLocation', 'bank', 'panNumber', 'panDocument']);
  });

  it('does not count a rejected, number-less or file-less PAN document', () => {
    expect(unmet({ ...complete, documents: [{ type: 'PAN_CARD', status: 'REJECTED', documentNumber: 'ABCDE1234F', hasFile: true }] })).toEqual(['panDocument']);
    expect(unmet({ ...complete, documents: [{ type: 'PAN_CARD', status: 'PENDING', documentNumber: null, hasFile: true }] })).toEqual(['panDocument']);
    expect(unmet({ ...complete, documents: [{ type: 'PAN_CARD', status: 'PENDING', documentNumber: 'ABCDE1234F', hasFile: false }] })).toEqual(['panDocument']);
    // A rejected one replaced by a fresh upload is fine.
    expect(
      unmet({
        ...complete,
        documents: [
          { type: 'PAN_CARD', status: 'REJECTED', documentNumber: 'ABCDE1234F', hasFile: true },
          { type: 'PAN_CARD', status: 'PENDING', documentNumber: 'ABCDE1234F', hasFile: true },
        ],
      }),
    ).toEqual([]);
  });

  it('requires an email and a valid mobile for contact', () => {
    expect(unmet({ ...complete, profile: { ...complete.profile!, ownerEmail: null } })).toEqual(['contact']);
    expect(unmet({ ...complete, profile: { ...complete.profile!, ownerMobile: '12345' } })).toEqual(['contact']);
  });

  it('asks for the GST certificate only when a GSTIN was entered', () => {
    expect(unmet({ ...complete, profile: { ...complete.profile!, gstNumber: '08ABCDE1234F1Z5' } })).toEqual(['gstDocument']);
  });

  it('asks a restaurant for FSSAI number + licence and restaurant details', () => {
    const restaurant: ChecklistInput = { ...complete, sellerType: SellerType.RESTAURANT };
    expect(unmet(restaurant)).toEqual(['fssaiNumber', 'fssaiDocument', 'restaurantProfile']);
    expect(
      unmet({
        ...restaurant,
        profile: { ...complete.profile!, fssaiNumber: '12345678901234' },
        documents: [...complete.documents, { type: 'FSSAI_LICENSE', status: 'PENDING', documentNumber: '12345678901234', hasFile: true }],
        restaurantProfile: { cuisine: ['North Indian'] },
      }),
    ).toEqual([]);
  });

  it('rejects the 0,0 "broken GPS" location', () => {
    expect(unmet({ ...complete, store: { ...complete.store, latitude: 0, longitude: 0 } })).toEqual(['storeLocation']);
  });
});

describe('isSellerOnboardingWrite (admin never writes seller onboarding data)', () => {
  it('flags every write to the onboarding area and the store location', () => {
    for (const [method, path] of [
      ['PUT', '/onboarding/profile'],
      ['PUT', '/onboarding/bank-detail'],
      ['PUT', '/onboarding/restaurant-profile'],
      ['POST', '/onboarding/documents'],
      ['DELETE', '/onboarding/documents/123'],
      ['POST', '/onboarding/submit'],
      ['PATCH', '/location'],
      ['PATCH', '/location/'],
    ] as const) {
      expect(isSellerOnboardingWrite(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it('leaves reads and every other seller route alone', () => {
    for (const [method, path] of [
      ['GET', '/onboarding'],
      ['GET', '/onboarding/documents/123/file'],
      ['GET', '/location'],
      ['HEAD', '/onboarding'],
      ['PATCH', '/orders/1/status'],
      ['POST', '/products'],
      ['PATCH', '/availability'],
      ['PUT', '/onboardings'],
    ] as const) {
      expect(isSellerOnboardingWrite(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

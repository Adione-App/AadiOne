/**
 * Admin seller management.
 *
 * CREATION — the minimum required to onboard a new seller account (#4).
 * Sellers do not self-register; admin creates the Seller row AND its first
 * SellerStaff (OWNER) in one step. Deliberately NOT the onboarding portal:
 * profile/bank/documents and the review decision live in
 * seller-onboarding.service.ts.
 *
 * DIRECTORY — the admin seller list and overview (GET /admin/sellers,
 * GET /admin/sellers/:id). Read-only, and built from the existing rules
 * rather than new ones: onboarding stage/completeness from
 * seller-onboarding.service.ts, open/closed state from seller.service.ts's
 * `evaluateSellerAvailability`. Neither view ever carries a full PAN,
 * Aadhaar or bank account number.
 *
 * MANAGEMENT — the admin trading switch, basic-detail edits, onboarding data
 * entry, bank verification and the seller's products/listings. Every one
 * starts from `loadSellerForAdmin`: a missing or soft-deleted seller is
 * NOT_FOUND. Every seller — Aadione included — goes through the same
 * routes; there is no separately managed platform store.
 */

import type { Prisma } from '@prisma/client';
import {
  ActorType,
  UserRole,
  DocumentStatus,
  ErrorCode,
  type AdminSellerDetailDto,
  type AdminSellerListRowDto,
  type AdminSellerOnboardingSummaryDto,
  type AdminSetSellerStatusRequest,
  type AdminUpdateSellerRequest,
  type AdminVerifyBankDetailRequest,
  type ApprovalStatus,
  type CreateSellerRequest,
  type CursorPage,
  type SellerListingDto,
  type SellerOnboardingStage,
  type SellerProductDto,
  type SellerType,
} from '../../shared';
import { normalizeIndianMobile } from '../../shared/phone';
import { isValidCoordinates } from '../../shared/distance';
import { slugify } from '../../shared/text';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction, type Tx } from '../../infra/db/prisma';
import { listOwnListings } from '../catalog/seller-listing.service';
import { listOwnProducts } from '../catalog/seller-product.service';
import * as onboardingService from './seller-onboarding.service';
import * as sellerService from './seller.service';
import { SellerAuditAction } from './seller-audit';

export interface CreateSellerResult {
  sellerId: string;
  ownerUserId: string;
  /** False when an existing customer account was promoted to SELLER_OWNER
   * instead of a brand-new user being created — see the role-conflict note
   * below. */
  isNewOwnerAccount: boolean;
}

/** Roles that can never ALSO own a seller — mixing platform-staff/rider
 * identity with a seller account is a genuine conflict, not just multi-role
 * flexibility (unlike CUSTOMER -> SELLER_OWNER promotion, or a user already
 * staffing one seller being added to another, both of which are allowed). */
const SELLER_INCOMPATIBLE_ROLES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
  UserRole.STAFF,
  UserRole.DELIVERY_AGENT,
];

/**
 * Allocates a unique `Seller.code` from the seller's name, with the same
 * bounded-retry shape used elsewhere in this codebase for unique code
 * generation (see referral.service.ts's `allocateRewardCouponCode`).
 */
async function allocateSellerCode(name: string, tx: Tx): Promise<string> {
  const base = slugify(name).toUpperCase().replace(/-/g, '').slice(0, 20) || 'SELLER';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = attempt === 0 ? base : `${base}${Math.floor(100 + Math.random() * 900)}`;
    const existing = await tx.seller.findUnique({ where: { code }, select: { id: true } });
    if (!existing) return code;
  }

  throw new AppError(ErrorCode.INTERNAL_ERROR, {
    internalMessage: `could not allocate a unique seller code from "${name}" after 5 attempts`,
  });
}

/**
 * Gives a seller that has NO active owner an owner account, so its team can
 * use the Seller Panel — e.g. Aadione's own store, which was created without
 * one. Same identity rules as `createSeller`; it never replaces an existing
 * owner (that is refused), so it cannot be used to take over a seller.
 */
export async function assignSellerOwner(
  sellerId: string,
  input: { ownerMobile: string; ownerFullName: string },
  actorUserId: string,
): Promise<{ sellerId: string; ownerUserId: string; isNewOwnerAccount: boolean }> {
  const ownerMobile = normalizeIndianMobile(input.ownerMobile);
  if (!ownerMobile) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Enter a valid owner mobile number.' });
  if (!input.ownerFullName.trim()) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: "Enter the owner's full name." });

  return runInTransaction(async (tx) => {
    const seller = await tx.seller.findFirst({ where: { id: sellerId, deletedAt: null }, select: { id: true } });
    if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

    const currentOwner = await tx.sellerStaff.findFirst({
      where: { sellerId, role: 'OWNER', isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (currentOwner) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'This seller already has an owner account.' });
    }

    const existingUser = await tx.user.findUnique({ where: { mobile: ownerMobile } });
    if (existingUser && SELLER_INCOMPATIBLE_ROLES.includes(existingUser.role)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'This mobile number already belongs to a staff or delivery account and cannot also own a seller.',
        internalMessage: `ownerMobile ${ownerMobile} belongs to existing user with role ${existingUser.role}`,
      });
    }

    let ownerUserId: string;
    let isNewOwnerAccount: boolean;
    if (existingUser) {
      ownerUserId = existingUser.id;
      isNewOwnerAccount = false;
      if (existingUser.role === UserRole.CUSTOMER) {
        await tx.user.update({ where: { id: existingUser.id }, data: { role: UserRole.SELLER_OWNER } });
      }
    } else {
      const created = await tx.user.create({
        data: { mobile: ownerMobile, fullName: input.ownerFullName.trim(), role: UserRole.SELLER_OWNER },
      });
      ownerUserId = created.id;
      isNewOwnerAccount = true;
    }

    // (sellerId, userId) is unique: an earlier, deactivated membership is revived as OWNER.
    await tx.sellerStaff.upsert({
      where: { sellerId_userId: { sellerId, userId: ownerUserId } },
      create: { sellerId, userId: ownerUserId, role: 'OWNER' },
      update: { role: 'OWNER', isActive: true, deletedAt: null },
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'seller.owner.assign',
        entityType: 'Seller',
        entityId: sellerId,
        after: { ownerUserId, ownerMobile, isNewOwnerAccount },
      },
    });

    return { sellerId, ownerUserId, isNewOwnerAccount };
  });
}

export async function createSeller(
  input: CreateSellerRequest,
  actorUserId: string,
): Promise<CreateSellerResult> {
  const ownerMobile = normalizeIndianMobile(input.ownerMobile);
  if (!ownerMobile) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Enter a valid owner mobile number.',
    });
  }

  if (!input.ownerFullName.trim()) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: "Enter the owner's full name.",
    });
  }

  if (!isValidCoordinates(input.latitude, input.longitude)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Those coordinates are not valid.',
    });
  }

  return runInTransaction(async (tx) => {
    // Duplicate-ownership / duplicate-identity check, race-safe: this runs
    // inside the same transaction that creates the Seller/User/SellerStaff
    // rows below, and the schema's own unique constraints
    // (users.mobile, sellers.code, seller_staff (seller_id, user_id)) are
    // the final backstop against a concurrent duplicate regardless.
    const existingUser = await tx.user.findUnique({ where: { mobile: ownerMobile } });

    if (existingUser && SELLER_INCOMPATIBLE_ROLES.includes(existingUser.role)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message:
          'This mobile number already belongs to a staff or delivery account and cannot also own a seller.',
        internalMessage: `ownerMobile ${ownerMobile} belongs to existing user with role ${existingUser.role}`,
      });
    }

    const code = await allocateSellerCode(input.name, tx);

    const seller = await tx.seller.create({
      data: {
        name: input.name,
        code,
        sellerType: input.sellerType,
        onboardingStatus: 'PENDING',
        addressLine: input.addressLine,
        city: input.city,
        state: input.state,
        pincode: input.pincode,
        latitude: input.latitude,
        longitude: input.longitude,
        phone: input.phone ?? null,
        defaultCommissionBp: input.defaultCommissionBp ?? 0,
      },
    });

    let ownerUserId: string;
    let isNewOwnerAccount: boolean;

    if (existingUser) {
      ownerUserId = existingUser.id;
      isNewOwnerAccount = false;
      // Promote a plain customer to seller owner. A user who is ALREADY a
      // seller role (staffing another seller) is left exactly as they are —
      // multi-seller staffing is a supported case, not a conflict.
      if (existingUser.role === UserRole.CUSTOMER) {
        await tx.user.update({ where: { id: existingUser.id }, data: { role: UserRole.SELLER_OWNER } });
      }
    } else {
      const created = await tx.user.create({
        data: {
          mobile: ownerMobile,
          fullName: input.ownerFullName,
          role: UserRole.SELLER_OWNER,
        },
      });
      ownerUserId = created.id;
      isNewOwnerAccount = true;
    }

    await tx.sellerStaff.create({
      data: {
        sellerId: seller.id,
        userId: ownerUserId,
        role: 'OWNER',
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'seller.create',
        entityType: 'Seller',
        entityId: seller.id,
        after: {
          name: seller.name,
          code: seller.code,
          sellerType: seller.sellerType,
          ownerMobile,
          isNewOwnerAccount,
        },
      },
    });

    return { sellerId: seller.id, ownerUserId, isNewOwnerAccount };
  });
}

/* -------------------------------------------------------------------------- */
/* Directory — list                                                           */
/* -------------------------------------------------------------------------- */

export interface ListSellersOptions {
  search?: string;
  onboardingStatus?: ApprovalStatus;
  stage?: SellerOnboardingStage;
  isActive?: boolean;
  sellerType?: SellerType;
  cursor?: string | null;
  limit: number;
}

/**
 * Every non-deleted seller (Aadione included, like any other),
 * newest first, cursor-paginated on `createdAt` like the other admin lists.
 * Every filter — `stage` included — is applied in the query, so a page is
 * never short because rows were dropped after fetching.
 */
export async function listSellers(options: ListSellersOptions): Promise<CursorPage<AdminSellerListRowDto>> {
  const filters: Prisma.SellerWhereInput[] = [{ deletedAt: null }];
  if (options.onboardingStatus) filters.push({ onboardingStatus: options.onboardingStatus });
  if (options.stage) filters.push(onboardingService.onboardingStageWhere(options.stage));
  if (options.isActive !== undefined) filters.push({ isActive: options.isActive });
  if (options.sellerType) filters.push({ sellerType: options.sellerType });
  if (options.search) {
    const contains = { contains: options.search, mode: 'insensitive' as const };
    filters.push({ OR: [{ name: contains }, { code: contains }, { city: contains }] });
  }
  if (options.cursor) filters.push({ createdAt: { lt: new Date(options.cursor) } });

  const sellers = await prisma.seller.findMany({
    where: { AND: filters },
    include: {
      hours: { orderBy: { dayOfWeek: 'asc' } },
      // Presence and document type/status only — exactly what `isComplete`
      // reads. No profile or bank field is ever loaded for the list.
      profile: { select: { id: true } },
      bankDetail: { select: { id: true } },
      documents: { select: { type: true, status: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });

  const hasMore = sellers.length > options.limit;
  const page = hasMore ? sellers.slice(0, options.limit) : sellers;
  const last = page[page.length - 1];

  const items = await Promise.all(
    page.map(async (seller): Promise<AdminSellerListRowDto> => {
      const availability = await sellerService.evaluateSellerAvailability(seller);
      const complete = onboardingService.isComplete(seller.profile, seller.bankDetail, seller.documents);
      return {
        id: seller.id,
        code: seller.code,
        name: seller.name,
        sellerType: seller.sellerType,
        city: seller.city,
        state: seller.state,
        onboardingStatus: seller.onboardingStatus,
        stage: onboardingService.computeStage(seller.onboardingStatus, complete),
        isActive: seller.isActive,
        isAcceptingOrders: seller.isAcceptingOrders,
        isOpenNow: availability.isOpen,
        acceptingOrdersNow: availability.acceptingOrders,
        closedReason: availability.closedReason,
        createdAt: seller.createdAt.toISOString(),
      };
    }),
  );

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Directory — overview                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One seller's admin overview. Profile and bank details come from the
 * onboarding module's own read with `unmask: false` — the same masking the
 * seller sees — and documents are summarised as counts, never links. A
 * deleted seller is NOT_FOUND, like every other seller-scoped admin read.
 */
export async function getSellerDetail(sellerId: string): Promise<AdminSellerDetailDto> {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    include: {
      hours: { orderBy: { dayOfWeek: 'asc' } },
      staff: {
        where: { deletedAt: null },
        include: { user: { select: { fullName: true, mobile: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });

  const [onboarding, availability, lastRejection] = await Promise.all([
    onboardingService.getOnboardingDetail(seller.id, undefined, false),
    sellerService.evaluateSellerAvailability(seller),
    onboardingService.getLastOnboardingRejection(seller.id),
  ]);

  const countDocuments = (status?: DocumentStatus) =>
    onboarding.documents.filter((d) => status === undefined || d.status === status).length;

  return {
    id: seller.id,
    code: seller.code,
    name: seller.name,
    sellerType: seller.sellerType,
    addressLine: seller.addressLine,
    city: seller.city,
    state: seller.state,
    pincode: seller.pincode,
    latitude: seller.latitude,
    longitude: seller.longitude,
    phone: seller.phone,
    onboardingStatus: onboarding.onboardingStatus,
    stage: onboarding.stage,
    isComplete: onboarding.isComplete,
    lastRejectionReason: lastRejection?.reason ?? null,
    lastRejectedAt: lastRejection?.rejectedAt.toISOString() ?? null,
    isActive: seller.isActive,
    isAcceptingOrders: seller.isAcceptingOrders,
    availability: {
      timezone: seller.timezone,
      isOpenNow: availability.isOpen,
      acceptingOrdersNow: availability.acceptingOrders,
      closedReason: availability.closedReason,
      nextOpenText: availability.nextOpenText,
      hoursConfigured: availability.hoursConfigured,
    },
    defaultCommissionBp: seller.defaultCommissionBp,
    settlementCycleHours: seller.settlementCycleHours,
    profile: onboarding.profile,
    bankDetail: onboarding.bankDetail,
    restaurantProfile: onboarding.restaurantProfile,
    documentSummary: {
      total: countDocuments(),
      pending: countDocuments(DocumentStatus.PENDING),
      verified: countDocuments(DocumentStatus.VERIFIED),
      rejected: countDocuments(DocumentStatus.REJECTED),
    },
    staff: seller.staff.map((member) => ({
      id: member.id,
      userId: member.userId,
      fullName: member.user.fullName,
      mobile: member.user.mobile,
      role: member.role,
      isActive: member.isActive,
      createdAt: member.createdAt.toISOString(),
    })),
    createdAt: seller.createdAt.toISOString(),
    updatedAt: seller.updatedAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Management — shared entry point                                            */
/* -------------------------------------------------------------------------- */

/** A missing or soft-deleted seller is NOT_FOUND for every admin action. */
async function loadSellerForAdmin(sellerId: string) {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

/* -------------------------------------------------------------------------- */
/* Management — admin trading switch                                          */
/* -------------------------------------------------------------------------- */

/**
 * Admin activation/deactivation of a seller (`Seller.isActive`) — any seller,
 * Aadione included.
 *
 * Touches `isActive` ONLY: the seller's own `isAcceptingOrders` switch, its
 * hours/closures and its onboarding/approval state are left exactly as they
 * are, so reactivating hands control straight back to them. Off makes the
 * seller non-orderable through the existing rules (availability reports
 * SELLER_INACTIVE; orderability refuses its listings).
 *
 * Setting the value it already has is a no-op — nothing written, nothing
 * audited — the same convention as `setTradingStatus`/`setAcceptingOrders`.
 * The write is a compare-and-set, so two concurrent identical requests
 * produce one change and one audit entry.
 */
export async function setSellerStatus(
  sellerId: string,
  input: AdminSetSellerStatusRequest,
  actorUserId: string,
): Promise<AdminSellerDetailDto> {
  const seller = await loadSellerForAdmin(sellerId);

  if (seller.isActive !== input.isActive) {
    await runInTransaction(async (tx) => {
      const { count } = await tx.seller.updateMany({
        where: { id: sellerId, deletedAt: null, isActive: !input.isActive },
        data: { isActive: input.isActive },
      });
      if (count === 0) return; // someone else already set it
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: input.isActive ? SellerAuditAction.ACTIVATE : SellerAuditAction.DEACTIVATE,
          entityType: 'Seller',
          entityId: sellerId,
          before: { isActive: !input.isActive },
          after: { isActive: input.isActive, reason: input.reason },
        },
      });
    });
  }

  return getSellerDetail(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Management — basic details                                                 */
/* -------------------------------------------------------------------------- */

const EDITABLE_SELLER_FIELDS = [
  'name',
  'phone',
  'addressLine',
  'city',
  'state',
  'pincode',
  'latitude',
  'longitude',
] as const;

/**
 * Edits a seller's basic details — and nothing else: type,
 * status, onboarding, commission and bank details each have their own
 * dedicated route. Only fields that actually change are written and audited
 * (with before/after values — none of these are sensitive); a request that
 * changes nothing writes nothing.
 */
export async function updateSeller(
  sellerId: string,
  input: AdminUpdateSellerRequest,
  actorUserId: string,
): Promise<AdminSellerDetailDto> {
  const seller = await loadSellerForAdmin(sellerId);

  if (input.latitude !== undefined || input.longitude !== undefined) {
    const { latitude, longitude } = input;
    if (latitude === undefined || longitude === undefined || !isValidCoordinates(latitude, longitude)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Those coordinates are not valid.' });
    }
    // Same guard as the seller's own location update: 0,0 is what a
    // broken geolocation call produces, never a real shop.
    if (latitude === 0 && longitude === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'Those coordinates look wrong (0, 0). Please set the location again.',
      });
    }
  }

  const changedFields = EDITABLE_SELLER_FIELDS.filter(
    (field) => input[field] !== undefined && input[field] !== seller[field],
  );
  if (changedFields.length === 0) return getSellerDetail(sellerId);

  const changed = new Set<string>(changedFields);
  const data: Prisma.SellerUpdateManyMutationInput = {
    ...(changed.has('name') ? { name: input.name } : {}),
    ...(changed.has('phone') ? { phone: input.phone ?? null } : {}),
    ...(changed.has('addressLine') ? { addressLine: input.addressLine } : {}),
    ...(changed.has('city') ? { city: input.city } : {}),
    ...(changed.has('state') ? { state: input.state } : {}),
    ...(changed.has('pincode') ? { pincode: input.pincode } : {}),
    ...(changed.has('latitude') ? { latitude: input.latitude } : {}),
    ...(changed.has('longitude') ? { longitude: input.longitude } : {}),
  };
  const valuesOf = (source: Partial<Record<(typeof EDITABLE_SELLER_FIELDS)[number], string | number | null>>) =>
    Object.fromEntries(changedFields.map((field) => [field, source[field] ?? null]));

  await runInTransaction(async (tx) => {
    const { count } = await tx.seller.updateMany({ where: { id: sellerId, deletedAt: null }, data });
    if (count === 0) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: SellerAuditAction.UPDATE,
        entityType: 'Seller',
        entityId: sellerId,
        before: valuesOf(seller),
        after: { changedFields, ...valuesOf(input) },
      },
    });
  });

  return getSellerDetail(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Management — onboarding data entry and bank verification                  */
/* -------------------------------------------------------------------------- */
/*
 * All four saves below respond with the admin onboarding SUMMARY
 * (`getOnboardingSummary`, the same read as GET .../onboarding/summary):
 * PAN, Aadhaar and the account number masked, documents as metadata only —
 * no document links. Only the reviewer's GET .../onboarding shows those.
 */

/**
 * Admin-entered business profile — the path that un-sticks a seller who was
 * created by admin but cannot fill in its own profile. The same service (and
 * the same audit entry, marked `source: ADMIN`) as the seller's own save; the
 * seller's type, status and ownership are not touched.
 */
export async function upsertOnboardingProfile(
  sellerId: string,
  input: onboardingService.UpsertSellerProfileInput,
  actorUserId: string,
): Promise<AdminSellerOnboardingSummaryDto> {
  await loadSellerForAdmin(sellerId);
  await onboardingService.upsertSellerProfile(sellerId, input, { userId: actorUserId, type: ActorType.ADMIN });
  return onboardingService.getOnboardingSummary(sellerId);
}

/** Admin-entered payout account. Always saved UNVERIFIED (see
 * `upsertBankDetail`); verification is its own step. */
export async function upsertOnboardingBankDetail(
  sellerId: string,
  input: onboardingService.UpsertBankDetailInput,
  actorUserId: string,
): Promise<AdminSellerOnboardingSummaryDto> {
  await loadSellerForAdmin(sellerId);
  await onboardingService.upsertBankDetail(sellerId, input, { userId: actorUserId, type: ActorType.ADMIN });
  return onboardingService.getOnboardingSummary(sellerId);
}

/** Marks verified exactly the payout account the admin reviewed (409 if it
 * changed since — see `onboardingService.verifyBankDetail`). Does not (yet)
 * gate settlement creation. */
export async function verifyBankDetail(
  sellerId: string,
  reviewed: AdminVerifyBankDetailRequest,
  actorUserId: string,
): Promise<AdminSellerOnboardingSummaryDto> {
  await loadSellerForAdmin(sellerId);
  await onboardingService.verifyBankDetail(sellerId, reviewed, actorUserId);
  return onboardingService.getOnboardingSummary(sellerId);
}

/** Admin-entered onboarding document, supplied by the seller out-of-band.
 * The same service as the seller's own upload: PENDING, never auto-verified,
 * reviewed with the normal document review. The link is stored, never echoed. */
export async function addOnboardingDocument(
  sellerId: string,
  input: onboardingService.AddDocumentInput,
  file: onboardingService.UploadedDocumentFile | undefined,
  actorUserId: string,
): Promise<AdminSellerOnboardingSummaryDto> {
  await loadSellerForAdmin(sellerId);
  await onboardingService.addDocument(sellerId, input, file, { userId: actorUserId, type: ActorType.ADMIN });
  return onboardingService.getOnboardingSummary(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Management — the seller's catalogue (read-only)                            */
/* -------------------------------------------------------------------------- */

/** The seller's own listings — exactly what the seller panel shows it. */
export async function listSellerListings(sellerId: string): Promise<SellerListingDto[]> {
  await loadSellerForAdmin(sellerId);
  return listOwnListings(sellerId);
}

/** Products this seller submitted, with its own listing, approval state and
 * last rejection note — exactly what the seller panel shows it. */
export async function listSellerProducts(sellerId: string): Promise<SellerProductDto[]> {
  await loadSellerForAdmin(sellerId);
  return listOwnProducts(sellerId);
}

/**
 * Admin seller management.
 *
 * CREATION — the minimum required to onboard a new seller account (#4).
 * Admin can still create a seller directly (besides public signup —
 * seller-lifecycle.service.ts): the Seller row AND its first SellerStaff
 * (OWNER) in one step, starting at ONBOARDING_PENDING (Gate 1 passed).
 * Deliberately NOT the onboarding portal: profile/bank/documents live in
 * seller-onboarding.service.ts, the gate decisions in
 * seller-lifecycle.service.ts.
 *
 * DIRECTORY — the admin seller list and overview (GET /admin/sellers,
 * GET /admin/sellers/:id). Read-only, and built from the existing rules
 * rather than new ones: onboarding stage/completeness from
 * seller-onboarding.service.ts, open/closed state from seller.service.ts's
 * `evaluateSellerAvailability`. Neither view ever carries a full PAN,
 * Aadhaar or bank account number.
 *
 * MANAGEMENT — the admin trading switch, bank verification and the seller's
 * products/listings. Onboarding data itself is READ-ONLY for admin (the
 * seller enters and corrects it; admin reviews and decides). Every one
 * starts from `loadSellerForAdmin`: a missing or soft-deleted seller is
 * NOT_FOUND. Every seller — Aadione included — goes through the same
 * routes; there is no separately managed platform store.
 */

import type { Prisma } from '@prisma/client';
import {
  UserRole,
  DocumentStatus,
  ErrorCode,
  SellerLifecycleStatus,
  type AdminSellerDetailDto,
  type AdminSellerListRowDto,
  type AdminSellerOnboardingSummaryDto,
  type AdminSetSellerStatusRequest,
  type AdminVerifyBankDetailRequest,
  type ApprovalStatus,
  type CreateSellerRequest,
  type CursorPage,
  type SellerLifecycleFilter,
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
import { stageFor } from './seller-lifecycle-rules';

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
export async function allocateSellerCode(name: string, tx: Tx): Promise<string> {
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
        // Created by admin = Gate 1 already passed: the owner goes straight
        // to onboarding, and still needs Gate 2 before going live.
        lifecycleStatus: SellerLifecycleStatus.ONBOARDING_PENDING,
        lifecycleUpdatedAt: new Date(),
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
  /** A lifecycle stage, or SUSPENDED (ACTIVE but switched off by admin). */
  lifecycle?: SellerLifecycleFilter;
  isActive?: boolean;
  sellerType?: SellerType;
  cursor?: string | null;
  limit: number;
}

function lifecycleWhere(filter: SellerLifecycleFilter): Prisma.SellerWhereInput {
  return filter === 'SUSPENDED'
    ? { lifecycleStatus: SellerLifecycleStatus.ACTIVE, isActive: false }
    : { lifecycleStatus: filter };
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
  if (options.lifecycle) filters.push(lifecycleWhere(options.lifecycle));
  if (options.isActive !== undefined) filters.push({ isActive: options.isActive });
  if (options.sellerType) filters.push({ sellerType: options.sellerType });
  if (options.search) {
    const contains = { contains: options.search, mode: 'insensitive' as const };
    filters.push({ OR: [{ name: contains }, { code: contains }, { city: contains }] });
  }
  if (options.cursor) filters.push({ createdAt: { lt: new Date(options.cursor) } });

  const sellers = await prisma.seller.findMany({
    where: { AND: filters },
    // No profile, bank or document field is ever loaded for the list.
    include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });

  const hasMore = sellers.length > options.limit;
  const page = hasMore ? sellers.slice(0, options.limit) : sellers;
  const last = page[page.length - 1];

  const items = await Promise.all(
    page.map(async (seller): Promise<AdminSellerListRowDto> => {
      const availability = await sellerService.evaluateSellerAvailability(seller);
      const lifecycleStatus = seller.lifecycleStatus as SellerLifecycleStatus;
      return {
        id: seller.id,
        code: seller.code,
        name: seller.name,
        sellerType: seller.sellerType,
        city: seller.city,
        state: seller.state,
        onboardingStatus: seller.onboardingStatus,
        lifecycleStatus,
        stage: stageFor(lifecycleStatus),
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
        include: { user: { select: { fullName: true, mobile: true, email: true } } },
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
  const owner = seller.staff.find((member) => member.role === 'OWNER' && member.isActive)?.user ?? null;

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
    lifecycleStatus: onboarding.lifecycleStatus,
    lifecycleReason: seller.lifecycleReason,
    lifecycleUpdatedAt: seller.lifecycleUpdatedAt?.toISOString() ?? null,
    applicationSubmittedAt: seller.applicationSubmittedAt?.toISOString() ?? null,
    onboardingSubmittedAt: seller.onboardingSubmittedAt?.toISOString() ?? null,
    activatedAt: seller.activatedAt?.toISOString() ?? null,
    owner: owner ? { fullName: owner.fullName, mobile: owner.mobile, email: owner.email } : null,
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
/* Management — bank verification (review only)                              */
/* -------------------------------------------------------------------------- */
/*
 * Onboarding data is READ-ONLY for admin: the seller enters and corrects it
 * (Seller Panel). Admin only reviews — this verification, document review
 * (seller-onboarding.service's reviewDocument) and the two gates.
 */

/** Marks verified exactly the payout account the admin reviewed (409 if it
 * changed since — see `onboardingService.verifyBankDetail`). */
export async function verifyBankDetail(
  sellerId: string,
  reviewed: AdminVerifyBankDetailRequest,
  actorUserId: string,
): Promise<AdminSellerOnboardingSummaryDto> {
  await loadSellerForAdmin(sellerId);
  await onboardingService.verifyBankDetail(sellerId, reviewed, actorUserId);
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

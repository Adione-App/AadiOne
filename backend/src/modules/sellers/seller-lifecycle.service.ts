/**
 * Seller registration and the two-gate onboarding lifecycle.
 *
 *   signup (public)            -> APPLICATION_PENDING
 *   Gate 1 (admin)             -> ONBOARDING_PENDING | APPLICATION_REJECTED
 *   submit (seller)            -> ONBOARDING_PENDING_REVIEW
 *   Gate 2 (admin)             -> ACTIVE | ONBOARDING_CHANGES_REQUIRED | ONBOARDING_REJECTED
 *   resubmit after changes     -> ONBOARDING_PENDING_REVIEW
 *
 * Every transition is a compare-and-set on the state it starts from (a
 * concurrent or repeated decision is a 409, never applied twice), writes
 * `onboardingStatus` in step (onboardingStatusFor — the column every "is this
 * seller live" rule reads, CHECK-enforced), and is audited. Audit rows carry
 * statuses and admin reasons only — never a password or a document number.
 *
 * Signup reuses the existing account model rather than a second auth system:
 * a SELLER_OWNER user with an email + password (the same credentials
 * POST /auth/seller/login checks) linked to its new Seller as OWNER.
 * Authorization, not authentication, then limits the account to its
 * status/onboarding screens until Gate 2 (middleware/sellerLifecycle.ts).
 */

import { Prisma, SessionScope, type User } from '@prisma/client';
import {
  ErrorCode,
  NotificationType,
  Permission,
  SellerLifecycleStatus,
  UserRole,
  UserStatus,
  type AdminSellerApplicationDto,
  type AuthResponse,
  type CursorPage,
  type SellerLifecycleDto,
  type SellerOnboardingChecklistItemDto,
  type SellerSignupRequest,
} from '../../shared';
import { AppError } from '../../common/errors';
import { hashPassword } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import { maskMobile } from '../../shared/phone';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import * as notificationService from '../notifications/notification.service';
import * as tokenService from '../auth/token.service';
import { toUserDto, type RequestContextInput } from '../auth/auth.service';
import { allocateSellerCode } from './admin-seller-management.service';
import { SellerAuditAction } from './seller-audit';
import {
  buildOnboardingChecklist,
  checklistComplete,
  isOnboardingEditable,
  onboardingStatusFor,
} from './seller-lifecycle-rules';

const log = moduleLogger('seller-lifecycle');

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Loads everything the onboarding checklist reads, for one seller. */
export async function loadChecklist(sellerId: string): Promise<SellerOnboardingChecklistItemDto[]> {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: {
      sellerType: true,
      addressLine: true,
      city: true,
      state: true,
      pincode: true,
      latitude: true,
      longitude: true,
      profile: true,
      bankDetail: { select: { accountHolderName: true, accountNumber: true, ifscCode: true } },
      documents: { select: { type: true, status: true, documentNumber: true, fileKey: true } },
      restaurantProfile: { select: { cuisine: true } },
    },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return buildOnboardingChecklist({
    sellerType: seller.sellerType,
    store: seller,
    profile: seller.profile,
    bankDetail: seller.bankDetail,
    documents: seller.documents.map((d) => ({
      type: d.type,
      status: d.status,
      documentNumber: d.documentNumber,
      hasFile: d.fileKey !== null,
    })),
    restaurantProfile: seller.restaurantProfile,
  });
}

function invalidTransition(sellerId: string, from: string, attempted: string, message: string): AppError {
  return new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
    message,
    internalMessage: `illegal seller lifecycle transition ${from} -> ${attempted} on seller ${sellerId}`,
  });
}

async function loadLiveSeller(sellerId: string) {
  const seller = await prisma.seller.findFirst({ where: { id: sellerId, deletedAt: null } });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return seller;
}

/**
 * Moves a seller from exactly `from` to `to` (compare-and-set) and writes the
 * audit entries in the same transaction. A seller that is no longer in `from`
 * — another admin decided first, a double click — is a 409.
 */
async function transition(
  sellerId: string,
  from: readonly SellerLifecycleStatus[],
  to: SellerLifecycleStatus,
  data: Omit<Prisma.SellerUpdateManyMutationInput, 'lifecycleStatus' | 'onboardingStatus'>,
  audit: { actorUserId: string; action: string; after: Prisma.InputJsonObject }[],
  conflictMessage: string,
): Promise<void> {
  await runInTransaction(async (tx) => {
    const { count } = await tx.seller.updateMany({
      where: { id: sellerId, deletedAt: null, lifecycleStatus: { in: [...from] } },
      data: {
        ...data,
        lifecycleStatus: to,
        onboardingStatus: onboardingStatusFor(to),
        lifecycleUpdatedAt: new Date(),
      },
    });
    if (count === 0) {
      throw new AppError(ErrorCode.INVALID_STATUS_TRANSITION, {
        message: conflictMessage,
        internalMessage: `seller ${sellerId} was not in [${from.join(', ')}] when moving to ${to}`,
      });
    }
    for (const entry of audit) {
      await tx.auditLog.create({
        data: {
          actorUserId: entry.actorUserId,
          action: entry.action,
          entityType: 'Seller',
          entityId: sellerId,
          before: { lifecycleStatus: from.length === 1 ? from[0]! : from.join('|') },
          after: { lifecycleStatus: to, ...entry.after },
        },
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Public signup — the seller application                                    */
/* -------------------------------------------------------------------------- */

export interface SellerSignupResult extends AuthResponse {
  sellerId: string;
  lifecycleStatus: SellerLifecycleStatus;
  passwordChangeRequired: false;
}

/**
 * POST /auth/seller/signup. Creates, in one transaction: the owner account
 * (SELLER_OWNER, email + password — the normal seller login), the Seller at
 * APPLICATION_PENDING, its OWNER membership, and a business profile
 * pre-filled from the application (the seller completes the rest during
 * onboarding). The store address/location are NOT collected here: they are
 * empty until onboarding (the checklist requires them; an unapproved seller
 * is never shown to customers — onboardingStatus stays PENDING).
 *
 * An existing account's mobile or email is refused (409), as in customer
 * signup — never silently attached: the applicant has proven neither.
 */
export async function signupSeller(
  input: SellerSignupRequest,
  context: RequestContextInput = {},
): Promise<SellerSignupResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const businessName = input.businessName.trim();

  const [byMobile, byEmail] = await Promise.all([
    prisma.user.findUnique({ where: { mobile: input.mobile }, select: { id: true } }),
    prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
  ]);
  if (byMobile) {
    throw new AppError(ErrorCode.MOBILE_ALREADY_REGISTERED, {
      message: 'An Aadione account with this mobile number already exists. Sign in instead, or use another number.',
      internalMessage: `seller signup: mobile ${maskMobile(input.mobile)} already registered`,
    });
  }
  if (byEmail) {
    throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED, {
      message: 'An Aadione account with this email already exists. Sign in instead, or use another email.',
      internalMessage: `seller signup: email already registered (user ${byEmail.id})`,
    });
  }

  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  let created: { user: User; sellerId: string };
  try {
    created = await runInTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          mobile: input.mobile,
          email,
          fullName,
          passwordHash,
          role: UserRole.SELLER_OWNER,
          status: UserStatus.ACTIVE,
          lastLoginAt: now,
        },
      });

      const seller = await tx.seller.create({
        data: {
          name: businessName,
          code: await allocateSellerCode(businessName, tx),
          sellerType: input.sellerType,
          lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
          onboardingStatus: onboardingStatusFor(SellerLifecycleStatus.APPLICATION_PENDING),
          lifecycleUpdatedAt: now,
          applicationSubmittedAt: now,
          // Filled in during onboarding (required by the checklist).
          addressLine: '',
          city: '',
          state: '',
          pincode: '',
          latitude: 0,
          longitude: 0,
          phone: input.mobile,
          // Never chosen by the seller: commission is platform-controlled.
          defaultCommissionBp: 0,
        },
      });

      await tx.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER' } });

      await tx.sellerProfile.create({
        data: {
          sellerId: seller.id,
          businessName,
          ownerFullName: fullName,
          ownerMobile: input.mobile,
          ownerEmail: email,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: SellerAuditAction.APPLICATION_SUBMIT,
          entityType: 'Seller',
          entityId: seller.id,
          ip: context.ip ?? null,
          after: {
            lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
            name: seller.name,
            code: seller.code,
            sellerType: seller.sellerType,
            ownerUserId: user.id,
          },
        },
      });

      return { user, sellerId: seller.id };
    });
  } catch (error) {
    // A concurrent signup with the same mobile/email lost the race.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: 'This mobile number or email is already registered.',
      });
    }
    throw error;
  }

  await notificationService.notifyAdmins(Permission.SELLER_ONBOARDING_REVIEW, {
    type: NotificationType.ADMIN_SELLER_APPLICATION_SUBMITTED,
    dedupeKey: `seller-application:${created.sellerId}:submitted`,
    context: { sellerName: businessName },
  });

  const tokens = await tokenService.issueTokens({
    userId: created.user.id,
    role: created.user.role,
    mobile: created.user.mobile,
    // Seller self-signup with email + password: a Seller Panel session.
    scope: SessionScope.FULL,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  log.info({ sellerId: created.sellerId, userId: created.user.id }, 'seller application submitted');
  return {
    user: toUserDto(created.user),
    tokens,
    sellerId: created.sellerId,
    lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
    passwordChangeRequired: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Seller's own status                                                        */
/* -------------------------------------------------------------------------- */

/** GET /seller/lifecycle — the seller's own state, reason and checklist. */
export async function getSellerLifecycle(sellerId: string): Promise<SellerLifecycleDto> {
  const seller = await loadLiveSeller(sellerId);
  const status = seller.lifecycleStatus as SellerLifecycleStatus;
  const editable = isOnboardingEditable(status);
  const checklist = await loadChecklist(sellerId);
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    sellerType: seller.sellerType,
    lifecycleStatus: status,
    reason: seller.lifecycleReason,
    panelUnlocked: status === SellerLifecycleStatus.ACTIVE,
    canEditOnboarding: editable,
    canSubmit: editable && checklistComplete(checklist),
    checklist,
    applicationSubmittedAt: seller.applicationSubmittedAt?.toISOString() ?? null,
    onboardingSubmittedAt: seller.onboardingSubmittedAt?.toISOString() ?? null,
    activatedAt: seller.activatedAt?.toISOString() ?? null,
    lifecycleUpdatedAt: seller.lifecycleUpdatedAt?.toISOString() ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 1 — the application                                                   */
/* -------------------------------------------------------------------------- */

export async function reviewApplication(
  sellerId: string,
  input: { decision: 'APPROVE' | 'REJECT'; reason?: string | null },
  actorUserId: string,
): Promise<void> {
  const reason = input.reason?.trim() || null;
  if (input.decision === 'REJECT' && !reason) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'A reason is required when rejecting an application.' });
  }
  const seller = await loadLiveSeller(sellerId);
  if (seller.lifecycleStatus !== SellerLifecycleStatus.APPLICATION_PENDING) {
    throw invalidTransition(
      sellerId,
      seller.lifecycleStatus,
      input.decision,
      'This application has already been decided.',
    );
  }

  const approve = input.decision === 'APPROVE';
  await transition(
    sellerId,
    [SellerLifecycleStatus.APPLICATION_PENDING],
    approve ? SellerLifecycleStatus.ONBOARDING_PENDING : SellerLifecycleStatus.APPLICATION_REJECTED,
    { lifecycleReason: approve ? null : reason },
    [
      {
        actorUserId,
        action: approve ? SellerAuditAction.APPLICATION_APPROVE : SellerAuditAction.APPLICATION_REJECT,
        after: { reason },
      },
    ],
    'This application has already been decided.',
  );

  await notificationService.notifySeller(sellerId, {
    type: approve ? NotificationType.SELLER_APPLICATION_APPROVED : NotificationType.SELLER_APPLICATION_REJECTED,
    dedupeKey: `seller-application:${sellerId}:${approve ? 'approved' : 'rejected'}`,
    context: { reason },
  });
}

/** Admin "Seller Applications" view — applicant contact included, by design. */
export async function listApplications(options: {
  status?: SellerLifecycleStatus;
  cursor?: string | null;
  limit: number;
}): Promise<CursorPage<AdminSellerApplicationDto>> {
  const sellers = await prisma.seller.findMany({
    where: {
      deletedAt: null,
      ...(options.status
        ? { lifecycleStatus: options.status }
        : { applicationSubmittedAt: { not: null } }),
      ...(options.cursor ? { createdAt: { lt: new Date(options.cursor) } } : {}),
    },
    include: {
      staff: {
        where: { role: 'OWNER', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 1,
        include: { user: { select: { fullName: true, mobile: true, email: true } } },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
  });

  const hasMore = sellers.length > options.limit;
  const page = hasMore ? sellers.slice(0, options.limit) : sellers;
  const last = page[page.length - 1];

  return {
    items: page.map((seller) => {
      const owner = seller.staff[0]?.user ?? null;
      return {
        sellerId: seller.id,
        businessName: seller.name,
        sellerType: seller.sellerType,
        applicantName: owner?.fullName ?? null,
        mobile: owner?.mobile ?? null,
        email: owner?.email ?? null,
        lifecycleStatus: seller.lifecycleStatus as SellerLifecycleStatus,
        lifecycleReason: seller.lifecycleReason,
        applicationSubmittedAt: seller.applicationSubmittedAt?.toISOString() ?? null,
        createdAt: seller.createdAt.toISOString(),
      };
    }),
    hasMore,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Submit for verification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The seller submits its completed onboarding for Gate 2. Only from an
 * editable state and only when every checklist item is met; the onboarding
 * is then locked (the lifecycle gate refuses onboarding writes) until admin
 * decides.
 */
export async function submitForVerification(sellerId: string, actorUserId: string): Promise<SellerLifecycleDto> {
  const seller = await loadLiveSeller(sellerId);
  const status = seller.lifecycleStatus as SellerLifecycleStatus;
  if (status === SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW) {
    throw invalidTransition(sellerId, status, 'submit', 'Your onboarding has already been submitted and is under review.');
  }
  if (!isOnboardingEditable(status)) {
    throw invalidTransition(sellerId, status, 'submit', 'There is no onboarding to submit right now.');
  }

  const checklist = await loadChecklist(sellerId);
  const missing = checklist.filter((item) => !item.met);
  if (missing.length > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Complete these before submitting: ${missing.map((m) => m.label).join(', ')}.`,
      details: missing.map((m) => ({ field: m.key, message: m.hint })),
    });
  }

  const resubmission = status === SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED;
  await transition(
    sellerId,
    [status],
    SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
    { onboardingSubmittedAt: new Date(), lifecycleReason: null },
    [{ actorUserId, action: SellerAuditAction.ONBOARDING_SUBMIT, after: { resubmitted: resubmission } }],
    'Your onboarding status changed — refresh and try again.',
  );

  // One notice per review round.
  const round = await prisma.auditLog.count({
    where: { entityType: 'Seller', entityId: sellerId, action: SellerAuditAction.ONBOARDING_SUBMIT },
  });
  await notificationService.notifyAdmins(Permission.SELLER_ONBOARDING_REVIEW, {
    type: NotificationType.ADMIN_ONBOARDING_SUBMITTED,
    dedupeKey: `onboarding:${sellerId}:submitted:${round}`,
    context: { sellerName: seller.name },
  });

  return getSellerLifecycle(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Gate 2 — verification                                                      */
/* -------------------------------------------------------------------------- */

export async function reviewVerification(
  sellerId: string,
  input: { decision: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT'; reason?: string | null },
  actorUserId: string,
): Promise<void> {
  const reason = input.reason?.trim() || null;
  if (input.decision !== 'APPROVE' && !reason) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message:
        input.decision === 'REQUEST_CHANGES'
          ? 'Tell the seller what needs to change.'
          : 'A reason is required when rejecting a seller.',
    });
  }

  const seller = await loadLiveSeller(sellerId);
  if (seller.lifecycleStatus !== SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW) {
    throw invalidTransition(
      sellerId,
      seller.lifecycleStatus,
      input.decision,
      'This seller is not waiting for verification.',
    );
  }
  const from = [SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW] as const;
  const conflict = 'This seller was already decided — refresh to see the current status.';
  const round = await prisma.auditLog.count({
    where: { entityType: 'Seller', entityId: sellerId, action: SellerAuditAction.ONBOARDING_SUBMIT },
  });

  if (input.decision === 'APPROVE') {
    const missing = (await loadChecklist(sellerId)).filter((item) => !item.met);
    if (missing.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `This seller's onboarding is incomplete (${missing.map((m) => m.label).join(', ')}). Request changes instead.`,
      });
    }
    await transition(
      sellerId,
      from,
      SellerLifecycleStatus.ACTIVE,
      { lifecycleReason: null, activatedAt: new Date() },
      [
        { actorUserId, action: SellerAuditAction.ONBOARDING_APPROVE, after: { status: 'APPROVED', reason } },
        { actorUserId, action: SellerAuditAction.LIFECYCLE_ACTIVATE, after: {} },
      ],
      conflict,
    );
    await notificationService.notifySeller(sellerId, {
      type: NotificationType.SELLER_ONBOARDING_APPROVED,
      dedupeKey: `onboarding:${sellerId}:APPROVED:${round}`,
      context: {},
    });
    return;
  }

  if (input.decision === 'REQUEST_CHANGES') {
    await transition(
      sellerId,
      from,
      SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED,
      { lifecycleReason: reason },
      [{ actorUserId, action: SellerAuditAction.ONBOARDING_REQUEST_CHANGES, after: { reason } }],
      conflict,
    );
    await notificationService.notifySeller(sellerId, {
      type: NotificationType.SELLER_ONBOARDING_CHANGES_REQUESTED,
      dedupeKey: `onboarding:${sellerId}:CHANGES:${round}`,
      context: { reason },
    });
    return;
  }

  await transition(
    sellerId,
    from,
    SellerLifecycleStatus.ONBOARDING_REJECTED,
    { lifecycleReason: reason },
    // ONBOARDING_REJECT keeps `after.reason` — getLastOnboardingRejection reads it.
    [{ actorUserId, action: SellerAuditAction.ONBOARDING_REJECT, after: { status: 'REJECTED', reason } }],
    conflict,
  );
  await notificationService.notifySeller(sellerId, {
    type: NotificationType.SELLER_ONBOARDING_REJECTED,
    dedupeKey: `onboarding:${sellerId}:REJECTED:${round}`,
    context: { reason },
  });
}

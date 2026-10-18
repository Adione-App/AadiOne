/**
 * Seller registration and the two-gate onboarding lifecycle.
 *
 *   signup (public)            -> APPLICATION_PENDING
 *   Gate 1 (admin)             -> ONBOARDING_PENDING | APPLICATION_REJECTED
 *   resubmit application       -> APPLICATION_PENDING (from APPLICATION_REJECTED)
 *   submit (seller)            -> ONBOARDING_PENDING_REVIEW
 *   Gate 2 (admin)             -> ACTIVE | ONBOARDING_CHANGES_REQUIRED | ONBOARDING_REJECTED
 *   resubmit after changes /
 *   after a final rejection    -> ONBOARDING_PENDING_REVIEW
 *
 * Every rejection / request for changes needs a reason of at least
 * MIN_DECISION_REASON_LENGTH characters: the seller reads it and acts on it.
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
  type SellerApplicationResubmitRequest,
  type SellerLifecycleDto,
  type SellerOnboardingChecklistItemDto,
  type SellerSignupRequest,
  type SellerType,
  type SellerApplicationStatusDto,
  type SellerApplyRequest,
  type SellerApplyResult,
} from '../../shared';
import { AppError } from '../../common/errors';
import { hashPassword } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import { maskMobile } from '../../shared/phone';
import { canApplyWithExistingAccount, findMobileConflict, sellerSignupConflictError } from './seller-mobile-conflict';
import { maskEmail } from '../../infra/email';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import * as notificationService from '../notifications/notification.service';
import * as tokenService from '../auth/token.service';
import { toUserDto, type RequestContextInput } from '../auth/auth.service';
import { allocateSellerCode } from './admin-seller-management.service';
import { SellerAuditAction } from './seller-audit';
import {
  MIN_DECISION_REASON_LENGTH,
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

/**
 * The reason a seller must act on (a rejection / request for changes):
 * required, and long enough to say something — "no" or "bad docs" tells the
 * seller nothing to fix. Returns the trimmed reason.
 */
function requireDecisionReason(reason: string | null | undefined, missingMessage: string): string {
  const text = reason?.trim() ?? '';
  if (!text) throw new AppError(ErrorCode.VALIDATION_ERROR, { message: missingMessage });
  if (text.length < MIN_DECISION_REASON_LENGTH) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `Give the seller a clear reason they can act on (at least ${MIN_DECISION_REASON_LENGTH} characters).`,
    });
  }
  return text;
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

/** The application rows themselves — the same for a brand-new applicant and a signed-in customer. */
async function createSellerApplication(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    businessName: string;
    sellerType: SellerType;
    ownerFullName: string;
    ownerMobile: string;
    ownerEmail: string;
    now: Date;
    ip: string | null;
    linkedExistingAccount: boolean;
  },
): Promise<string> {
  const seller = await tx.seller.create({
    data: {
      name: input.businessName,
      code: await allocateSellerCode(input.businessName, tx),
      sellerType: input.sellerType,
      lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
      onboardingStatus: onboardingStatusFor(SellerLifecycleStatus.APPLICATION_PENDING),
      lifecycleUpdatedAt: input.now,
      applicationSubmittedAt: input.now,
      // Filled in during onboarding (required by the checklist).
      addressLine: '',
      city: '',
      state: '',
      pincode: '',
      latitude: 0,
      longitude: 0,
      phone: input.ownerMobile,
      // Never chosen by the seller: commission is platform-controlled.
      defaultCommissionBp: 0,
    },
  });

  await tx.sellerStaff.create({ data: { sellerId: seller.id, userId: input.userId, role: 'OWNER' } });

  await tx.sellerProfile.create({
    data: {
      sellerId: seller.id,
      businessName: input.businessName,
      ownerFullName: input.ownerFullName,
      ownerMobile: input.ownerMobile,
      ownerEmail: input.ownerEmail,
    },
  });

  await tx.auditLog.create({
    data: {
      actorUserId: input.userId,
      action: SellerAuditAction.APPLICATION_SUBMIT,
      entityType: 'Seller',
      entityId: seller.id,
      ip: input.ip,
      after: {
        lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
        name: seller.name,
        code: seller.code,
        sellerType: seller.sellerType,
        ownerUserId: input.userId,
        // The store was added to an account that already existed (a signed-in customer).
        linkedExistingAccount: input.linkedExistingAccount,
      },
    },
  });

  return seller.id;
}

/**
 * POST /auth/seller/signup — the public Partner Portal form, for a NEW
 * account. Creates, in one transaction: the owner account (SELLER_OWNER,
 * email + password — the normal seller login), the Seller at
 * APPLICATION_PENDING, its OWNER membership, and a business profile
 * pre-filled from the application (the seller completes the rest during
 * onboarding). The store address/location are NOT collected here: they are
 * empty until onboarding (the checklist requires them; an unapproved seller
 * is never shown to customers — onboardingStatus stays PENDING).
 *
 * This form is unauthenticated, so it NEVER attaches to an existing account:
 * the mobile number in the body proves nothing. An existing account's number
 * or email is refused (409), naming WHICH kind of account holds the number
 * (seller-mobile-conflict.ts). For a shopper (or a former seller) that is not
 * a dead end — details.signInToApply sends them to sign in to the Aadione app
 * and apply there (applyToSellAsSignedInUser), on the same account. A lost
 * race on the unique index answers the same way.
 */
export async function signupSeller(
  input: SellerSignupRequest,
  context: RequestContextInput = {},
): Promise<SellerSignupResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const businessName = input.businessName.trim();

  const [mobileConflict, byEmail] = await Promise.all([
    findMobileConflict(prisma, input.mobile),
    prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
  ]);
  if (mobileConflict.kind !== 'NONE') throw sellerSignupConflictError(mobileConflict, input.mobile);
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
      const sellerId = await createSellerApplication(tx, {
        userId: user.id,
        businessName,
        sellerType: input.sellerType,
        ownerFullName: fullName,
        ownerMobile: input.mobile,
        ownerEmail: email,
        now,
        ip: context.ip ?? null,
        linkedExistingAccount: false,
      });
      return { user, sellerId };
    });
  } catch (error) {
    // A concurrent signup with the same mobile/email lost the race: say
    // exactly what now holds the number (or the email), as above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const conflict = await findMobileConflict(prisma, input.mobile);
      if (conflict.kind !== 'NONE') throw sellerSignupConflictError(conflict, input.mobile);
      throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED, {
        message: 'An Aadione account with this email already exists. Sign in instead, or use another email.',
        internalMessage: `seller signup: unique conflict for mobile ${maskMobile(input.mobile)}`,
      });
    }
    throw error;
  }

  await notifyApplicationSubmitted(created.sellerId, businessName);

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

async function notifyApplicationSubmitted(sellerId: string, businessName: string): Promise<void> {
  await notificationService.notifyAdmins(Permission.SELLER_ONBOARDING_REVIEW, {
    type: NotificationType.ADMIN_SELLER_APPLICATION_SUBMITTED,
    dedupeKey: `seller-application:${sellerId}:submitted`,
    context: { sellerName: businessName },
  });
}

/* -------------------------------------------------------------------------- */
/* Signed-in Apply to Sell (customer app → same account)                     */
/* -------------------------------------------------------------------------- */

/** The session's own account — never anything named in a request body. */
async function sessionAccount(db: Prisma.TransactionClient | typeof prisma, userId: string): Promise<User> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, { message: 'Please sign in again.', internalMessage: `apply-to-sell: user ${userId} not usable` });
  }
  return user;
}

/**
 * GET /auth/seller/application — the signed-in account's own seller status,
 * so the app shows either the application form (with only the Seller Panel
 * credentials this account still lacks) or the application's progress.
 */
export async function getOwnSellerApplication(userId: string): Promise<SellerApplicationStatusDto> {
  const user = await sessionAccount(prisma, userId);
  const conflict = await findMobileConflict(prisma, user.mobile);
  const store =
    conflict.kind === 'SELLER'
      ? await prisma.seller.findFirst({
          where: { deletedAt: null, staff: { some: { userId: user.id, isActive: true, deletedAt: null } } },
          orderBy: { createdAt: 'asc' },
          select: { name: true, lifecycleStatus: true, lifecycleReason: true },
        })
      : null;
  return {
    status: store ? (store.lifecycleStatus as SellerLifecycleStatus) : 'NONE',
    canApply: canApplyWithExistingAccount(conflict.kind),
    sellerName: store?.name ?? null,
    reason: store?.lifecycleReason ?? null,
    sellerPanelEmail: user.email,
    needsEmail: !user.email,
    needsPassword: !user.passwordHash,
  };
}

/**
 * POST /auth/seller/apply — a SIGNED-IN customer opens a store on the account
 * of that session. Nothing in the body identifies the account (there is no
 * mobile field): the session already proved who this is, so there is no OTP
 * step and no "existing account" warning.
 *
 *   - The account is reused: role → SELLER_OWNER, plus the Seller at
 *     APPLICATION_PENDING, its OWNER membership and profile. No second user.
 *   - Nothing of the customer's changes: orders, addresses, coupons, wallet,
 *     referrals and every app session stay as they are. The account's OWN
 *     email and password are never replaced — `email` / `password` are only
 *     accepted (and then required) when the account has none, to give it the
 *     Seller Panel sign-in; sending one the account already has is refused.
 *   - One store per account: a live seller membership is a 409; staff,
 *     delivery and blocked accounts cannot open a store (403).
 *   - The application waits for an admin exactly like any other: the Seller
 *     Panel shows only its status until approval (sellerPanelAccess).
 *   - The account row is locked for the whole transaction, so two taps (or two
 *     devices) create exactly one store.
 */
export async function applyToSellAsSignedInUser(
  userId: string,
  input: SellerApplyRequest,
  context: RequestContextInput = {},
): Promise<SellerApplyResult> {
  const businessName = input.businessName.trim();
  const email = input.email?.trim().toLowerCase();
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const now = new Date();

  let result: SellerApplyResult;
  try {
    result = await runInTransaction(async (tx) => {
      // Lock first: a second, concurrent application waits here and then sees the first's store.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await sessionAccount(tx, userId);

      const conflict = await findMobileConflict(tx, user.mobile);
      if (conflict.kind === 'SELLER') {
        throw new AppError(ErrorCode.MOBILE_ALREADY_REGISTERED, {
          message: 'Your account already has a store on Aadione. Track it under Account → Sell on Aadione, or sign in to the Seller Panel.',
          internalMessage: `apply-to-sell: user ${user.id} already staffs a live seller`,
        });
      }
      if (!canApplyWithExistingAccount(conflict.kind)) {
        throw new AppError(ErrorCode.FORBIDDEN, {
          message: 'This account cannot open a store on Aadione. Contact Aadione support.',
          internalMessage: `apply-to-sell: user ${user.id} is ${conflict.kind}`,
        });
      }

      // Seller Panel sign-in: the account's own email/password, or — only if it has none — the ones given now.
      if (user.email && email !== undefined) {
        const message = `Your account already uses the email ${maskEmail(user.email)} — the Seller Panel signs in with it.`;
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message, details: [{ field: 'email', message }] });
      }
      if (user.passwordHash && passwordHash) {
        const message = 'Your account already has a Seller Panel password. Sign in with it, or reset it with "Forgot password".';
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message, details: [{ field: 'password', message }] });
      }
      const sellerPanelEmail = user.email ?? email;
      if (!sellerPanelEmail) {
        const message = 'Enter an email address — you will sign in to the Seller Panel with it.';
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message, details: [{ field: 'email', message }] });
      }
      if (!user.passwordHash && !passwordHash) {
        const message = 'Choose a password for the Seller Panel.';
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message, details: [{ field: 'password', message }] });
      }
      if (!user.email) {
        const taken = await tx.user.findFirst({
          where: { email: { equals: sellerPanelEmail, mode: 'insensitive' }, id: { not: user.id } },
          select: { id: true },
        });
        if (taken) {
          throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED, {
            message: 'Another Aadione account already uses this email. Enter a different email.',
            internalMessage: `apply-to-sell: email of user ${taken.id}`,
          });
        }
      }

      const ownerFullName = input.ownerFullName?.trim() || user.fullName;
      if (!ownerFullName) {
        const message = "Enter the owner's full name.";
        throw new AppError(ErrorCode.VALIDATION_ERROR, { message, details: [{ field: 'ownerFullName', message }] });
      }

      // Only what the account does not have yet is filled in.
      await tx.user.update({
        where: { id: user.id },
        data: {
          role: UserRole.SELLER_OWNER,
          ...(user.email ? {} : { email: sellerPanelEmail }),
          ...(user.passwordHash ? {} : { passwordHash }),
          ...(user.fullName ? {} : { fullName: ownerFullName }),
        },
      });

      const sellerId = await createSellerApplication(tx, {
        userId: user.id,
        businessName,
        sellerType: input.sellerType,
        ownerFullName,
        ownerMobile: user.mobile,
        ownerEmail: sellerPanelEmail,
        now,
        ip: context.ip ?? null,
        linkedExistingAccount: true,
      });
      return { sellerId, lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING, sellerPanelEmail };
    });
  } catch (error) {
    // The email was taken between the check and the write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED, {
        message: 'Another Aadione account already uses this email. Enter a different email.',
        internalMessage: `apply-to-sell: unique conflict for user ${userId}`,
      });
    }
    throw error;
  }

  await notifyApplicationSubmitted(result.sellerId, businessName);
  log.info({ sellerId: result.sellerId, userId }, 'seller application submitted by a signed-in customer (same account)');
  return result;
}

/* -------------------------------------------------------------------------- */
/* Seller's own status                                                        */
/* -------------------------------------------------------------------------- */

/** GET /seller/lifecycle — the seller's own state, reason and checklist. */
export async function getSellerLifecycle(sellerId: string): Promise<SellerLifecycleDto> {
  const seller = await loadLiveSeller(sellerId);
  const status = seller.lifecycleStatus as SellerLifecycleStatus;
  const editable = isOnboardingEditable(status);
  const [checklist, profile] = await Promise.all([
    loadChecklist(sellerId),
    prisma.sellerProfile.findUnique({ where: { sellerId }, select: { ownerFullName: true } }),
  ]);
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    ownerFullName: profile?.ownerFullName ?? null,
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
  const reason =
    input.decision === 'REJECT'
      ? requireDecisionReason(input.reason, 'A reason is required when rejecting an application.')
      : input.reason?.trim() || null;
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

/**
 * POST /seller/lifecycle/application — a rejected applicant corrects its
 * application (the same business fields as signup: business name, owner
 * name, seller type) and sends it back to Gate 1. Only from
 * APPLICATION_REJECTED, compare-and-set like every transition: the state
 * goes back to APPLICATION_PENDING (never approved here), the previous
 * reason is cleared from the seller row but kept in the audit trail, and
 * onboarding stays locked until an admin approves the application.
 * Mobile and email are the login identity and are not part of this.
 */
export async function resubmitApplication(
  sellerId: string,
  input: SellerApplicationResubmitRequest,
  actorUserId: string,
): Promise<SellerLifecycleDto> {
  const seller = await loadLiveSeller(sellerId);
  if (seller.lifecycleStatus !== SellerLifecycleStatus.APPLICATION_REJECTED) {
    throw invalidTransition(
      sellerId,
      seller.lifecycleStatus,
      'resubmit_application',
      seller.lifecycleStatus === SellerLifecycleStatus.APPLICATION_PENDING
        ? 'Your application has already been sent and is waiting for review.'
        : 'Only a rejected application can be resubmitted.',
    );
  }
  const businessName = input.businessName.trim();
  const fullName = input.fullName.trim();
  const now = new Date();

  await runInTransaction(async (tx) => {
    const { count } = await tx.seller.updateMany({
      where: { id: sellerId, deletedAt: null, lifecycleStatus: SellerLifecycleStatus.APPLICATION_REJECTED },
      data: {
        name: businessName,
        sellerType: input.sellerType,
        lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING,
        onboardingStatus: onboardingStatusFor(SellerLifecycleStatus.APPLICATION_PENDING),
        lifecycleReason: null,
        lifecycleUpdatedAt: now,
        applicationSubmittedAt: now,
      },
    });
    if (count === 0) {
      throw invalidTransition(sellerId, seller.lifecycleStatus, 'resubmit_application', 'Your application status changed — refresh and try again.');
    }
    await tx.sellerProfile.upsert({
      where: { sellerId },
      create: { sellerId, businessName, ownerFullName: fullName, ownerMobile: seller.phone ?? '', ownerEmail: null },
      update: { businessName, ownerFullName: fullName },
    });
    // The applicant's own account name (what the admin applications list shows).
    await tx.user.update({ where: { id: actorUserId }, data: { fullName } });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: SellerAuditAction.APPLICATION_RESUBMIT,
        entityType: 'Seller',
        entityId: sellerId,
        before: { lifecycleStatus: SellerLifecycleStatus.APPLICATION_REJECTED, name: seller.name, sellerType: seller.sellerType, reason: seller.lifecycleReason },
        after: { lifecycleStatus: SellerLifecycleStatus.APPLICATION_PENDING, name: businessName, sellerType: input.sellerType },
      },
    });
  });

  const round = await prisma.auditLog.count({
    where: { entityType: 'Seller', entityId: sellerId, action: SellerAuditAction.APPLICATION_RESUBMIT },
  });
  await notificationService.notifyAdmins(Permission.SELLER_ONBOARDING_REVIEW, {
    type: NotificationType.ADMIN_SELLER_APPLICATION_SUBMITTED,
    dedupeKey: `seller-application:${sellerId}:resubmitted:${round}`,
    context: { sellerName: businessName },
  });
  log.info({ sellerId, round }, 'seller application resubmitted');
  return getSellerLifecycle(sellerId);
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

  // After a request for changes or a final rejection: a resubmission for final approval.
  const resubmission =
    status === SellerLifecycleStatus.ONBOARDING_CHANGES_REQUIRED || status === SellerLifecycleStatus.ONBOARDING_REJECTED;
  await transition(
    sellerId,
    [status],
    SellerLifecycleStatus.ONBOARDING_PENDING_REVIEW,
    { onboardingSubmittedAt: new Date(), lifecycleReason: null },
    [{ actorUserId, action: SellerAuditAction.ONBOARDING_SUBMIT, after: { resubmitted: resubmission, from: status } }],
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
  const reason =
    input.decision === 'APPROVE'
      ? input.reason?.trim() || null
      : requireDecisionReason(
          input.reason,
          input.decision === 'REQUEST_CHANGES' ? 'Tell the seller what needs to change.' : 'A reason is required when rejecting a seller.',
        );

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

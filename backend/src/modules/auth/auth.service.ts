/**
 * Authentication orchestration.
 *
 * Customers authenticate by OTP only — they have no password. Store staff
 * authenticate by email + password (decision O4: an owner opening the panel at
 * 7 a.m. should not wait for an SMS, and every login would otherwise cost an
 * SMS credit).
 */

import { SessionScope, type User } from '@prisma/client';
import {
  ACTIVE_ORDER_STATUSES,
  ErrorCode,
  UserStatus,
  isAdminRole,
  isSellerRole,
  type AuthResponse,
  type UserDto,
} from '../../shared';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { sha256 } from '../../common/crypto';
import { generateReferralCode } from '../../shared/text';
import { maskMobile } from '../../shared/phone';
import { AppError } from '../../common/errors';
import { hashPassword, verifyPassword } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import * as repository from './auth.repository';
import * as otpService from './otp.service';
import * as tokenService from './token.service';

const log = moduleLogger('auth');

/**
 * A real bcrypt hash of a value nothing can match.
 *
 * Compared against when the account does not exist, so a login attempt takes
 * the same time whether or not the email is registered. Without it, "no such
 * user" returns in ~1 ms and a wrong password in ~250 ms, and that difference
 * alone enumerates accounts.
 */
const DUMMY_PASSWORD_HASH =
  '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Kx5Z3sQzYt0lRQ4Zk4uZ5nY3hK1sPa';

export interface RequestContextInput {
  userAgent?: string | null;
  ip?: string | null;
}

export function toUserDto(user: User, extra?: { isNewUser?: boolean }): UserDto {
  return {
    id: user.id,
    mobile: user.mobile,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    referralCode: user.referralCode,
    mobileVerified: user.mobileVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
    ...(extra?.isNewUser !== undefined ? { isNewUser: extra.isNewUser } : {}),
  };
}

/** Rejects logins for blocked or deleted accounts, with distinct messages. */
function assertUsable(user: User): void {
  if (user.deletedAt || user.status === UserStatus.DELETED) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, {
      message: 'This account has been deleted.',
      internalMessage: `login attempt on deleted user ${user.id}`,
    });
  }
  if (user.status === UserStatus.BLOCKED) {
    throw new AppError(ErrorCode.ACCOUNT_BLOCKED, {
      internalMessage: `login attempt on blocked user ${user.id}`,
    });
  }
}

/**
 * Generates a referral code that is not already taken.
 *
 * Bounded retries rather than a loop: the alphabet has 31^5 ≈ 28.6 million
 * combinations, so a collision is already improbable; five attempts makes
 * repeated failure effectively impossible while guaranteeing the function
 * terminates.
 */
async function allocateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    if (!(await repository.referralCodeExists(code))) return code;
  }
  throw new AppError(ErrorCode.INTERNAL_ERROR, {
    internalMessage: 'could not allocate a unique referral code after 5 attempts',
  });
}

/* -------------------------------------------------------------------------- */
/* Task 2.1 — send OTP                                                        */
/* -------------------------------------------------------------------------- */

export async function sendOtp(mobile: string): Promise<otpService.SendOtpOutcome> {
  // A blocked user is stopped here rather than after they have paid for an SMS
  // and typed the code.
  const existing = await repository.findUserByMobile(mobile);
  if (existing) assertUsable(existing);

  return otpService.sendOtp(mobile);
}

/* -------------------------------------------------------------------------- */
/* Task 2.2 — verify OTP, then create or log in                               */
/* -------------------------------------------------------------------------- */

export async function verifyOtpAndAuthenticate(
  mobile: string,
  code: string,
  context: RequestContextInput = {},
): Promise<AuthResponse> {
  await otpService.verifyOtp(mobile, code);

  let user = await repository.findUserByMobile(mobile);
  let isNewUser = false;

  if (user) {
    assertUsable(user);
    // OTP is the CUSTOMER-APP sign-in, for every account — a seller owner or
    // an admin may shop for themselves with their own number. The session is
    // CUSTOMER-scoped (below), so an SMS code still never opens the Seller or
    // Admin Panel: those need the email + password login.
    await repository.touchLastLogin(user.id);
    // A password-signup account proves its number here, on the first OTP login.
    if (!user.mobileVerifiedAt) {
      await repository.markMobileVerified(user.id);
      user = { ...user, mobileVerifiedAt: new Date() };
    }
  } else {
    // First successful OTP creates the account. There is no separate signup
    // step — the mockup's flow is "enter number, enter OTP, you are in".
    user = await repository.createCustomer({
      mobile,
      referralCode: await allocateReferralCode(),
    });
    isNewUser = true;
  }

  const tokens = await tokenService.issueTokens({
    userId: user.id,
    role: user.role,
    mobile: user.mobile,
    // Customer app: a shopper session, whatever the account role.
    scope: SessionScope.CUSTOMER,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  log.info(
    { userId: user.id, mobile: maskMobile(mobile), isNewUser },
    isNewUser ? 'customer registered' : 'customer logged in',
  );

  return { user: toUserDto(user, { isNewUser }), tokens };
}

/* -------------------------------------------------------------------------- */
/* Task 2.6 — email + password signup                                         */
/* -------------------------------------------------------------------------- */

export interface SignupInput {
  fullName: string;
  email: string;
  password: string;
  mobile: string;
}

/**
 * Registers a customer with email + password.
 *
 * NOTE ON MOBILE VERIFICATION: nothing here proves the number belongs to the
 * person signing up — they simply typed it. The account is created with
 * `mobileVerifiedAt = null`, and one OTP login clears it. This matters because
 * the rider phones that number and COD settlement depends on reaching a real
 * person; treating a typed number as verified would be a delivery and fraud
 * hole, not a cosmetic detail. The `mobileVerified` flag is returned to the
 * client so the app can prompt before checkout.
 *
 * Conflicts are reported honestly rather than generically: unlike LOGIN, a
 * signup form must tell the user their email or number is already registered,
 * otherwise they cannot proceed. The information is disclosed either way by
 * the fact that signup fails, so a vague message would only frustrate.
 */
export async function signup(
  input: SignupInput,
  context: RequestContextInput = {},
): Promise<AuthResponse> {
  const email = input.email.toLowerCase();

  const [byMobile, byEmail] = await Promise.all([
    repository.findUserByMobile(input.mobile),
    repository.findUserByEmail(email),
  ]);

  if (byMobile) {
    throw new AppError(ErrorCode.MOBILE_ALREADY_REGISTERED, {
      internalMessage: `signup: mobile ${maskMobile(input.mobile)} already registered`,
    });
  }
  if (byEmail) {
    throw new AppError(ErrorCode.EMAIL_ALREADY_REGISTERED, {
      internalMessage: `signup: email already registered (user ${byEmail.id})`,
    });
  }

  const user = await repository.createCustomerWithPassword({
    mobile: input.mobile,
    email,
    fullName: input.fullName,
    passwordHash: await hashPassword(input.password),
    referralCode: await allocateReferralCode(),
  });

  const tokens = await tokenService.issueTokens({
    userId: user.id,
    role: user.role,
    mobile: user.mobile,
    // Customer sign-up with a password — a CUSTOMER account either way.
    scope: SessionScope.FULL,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  log.info({ userId: user.id, mobile: maskMobile(user.mobile) }, 'customer signed up');
  return { user: toUserDto(user, { isNewUser: true }), tokens };
}

/* -------------------------------------------------------------------------- */
/* Task 2.5 — email + password login (customers and staff)                    */
/* -------------------------------------------------------------------------- */

export interface PasswordLoginOptions {
  /**
   * Set by the admin-panel endpoint. A customer with valid credentials must
   * not be able to sign in to the store panel, even though the credentials
   * themselves are correct.
   */
  requireStaffRole?: boolean;
  /**
   * Set by the seller-panel endpoint: a seller-panel role (SELLER_PANEL_ROLES)
   * that is an ACTIVE member of a live seller. Anything else — an admin, a
   * customer, a seller account whose membership was revoked — gets the same
   * generic error as a wrong password.
   */
  requireSellerRole?: boolean;
}

export async function loginWithPassword(
  email: string,
  password: string,
  context: RequestContextInput = {},
  options: PasswordLoginOptions = {},
): Promise<AuthResponse> {
  const user = await repository.findUserByEmail(email);

  // ONE generic error for "no such account", "no password set", "wrong role"
  // and "wrong password". Distinguishing them would turn this endpoint into an
  // oracle for which emails have accounts — and for staff emails in
  // particular, that is a targeting list.
  const invalid = (internalMessage: string): AppError =>
    new AppError(ErrorCode.INVALID_CREDENTIALS, { internalMessage });

  if (!user) {
    // Still spend the time a real bcrypt comparison would, so response timing
    // does not reveal whether the account exists.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw invalid(`login: no user for ${email}`);
  }
  if (!user.passwordHash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw invalid(`login: user ${user.id} has no password (OTP-only account)`);
  }
  if (options.requireStaffRole && !isAdminRole(user.role)) {
    throw invalid(`login: user ${user.id} is not staff`);
  }
  if (options.requireSellerRole && !isSellerRole(user.role)) {
    throw invalid(`seller login: user ${user.id} has role ${user.role}`);
  }

  assertUsable(user);

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw invalid(`login: bad password for ${user.id}`);
  }

  if (options.requireSellerRole && !(await repository.hasActiveSellerMembership(user.id))) {
    throw invalid(`seller login: user ${user.id} has no active seller membership`);
  }

  await repository.touchLastLogin(user.id);

  const tokens = await tokenService.issueTokens({
    userId: user.id,
    role: user.role,
    mobile: user.mobile,
    // Panel login (admin / seller / customer password): the account's own role.
    scope: SessionScope.FULL,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  log.info({ userId: user.id, role: user.role }, 'password login');
  return { user: toUserDto(user), tokens };
}

/* -------------------------------------------------------------------------- */
/* Seller panel — email + password, change password                           */
/* -------------------------------------------------------------------------- */

/**
 * Audit actions that decide whether a password is TEMPORARY: the latest for
 * a user wins. ISSUED_BY_ADMIN is history only — admins can no longer issue
 * seller passwords (a password set that way before stays "change required"
 * until the seller changes or resets it). The other two are the user choosing
 * their own password. Kept in the audit log (entityType 'User') rather than a
 * new column, so every change is also on record.
 */
export const PASSWORD_AUDIT = {
  ISSUED_BY_ADMIN: 'seller_login.credentials_issued',
  CHANGED_BY_USER: 'auth.password_changed',
  RESET_BY_USER: 'auth.password_reset',
} as const;

export async function isPasswordChangeRequired(userId: string): Promise<boolean> {
  const latest = await prisma.auditLog.findFirst({
    where: {
      entityType: 'User',
      entityId: userId,
      action: { in: [PASSWORD_AUDIT.ISSUED_BY_ADMIN, PASSWORD_AUDIT.CHANGED_BY_USER, PASSWORD_AUDIT.RESET_BY_USER] },
    },
    orderBy: { createdAt: 'desc' },
    select: { action: true },
  });
  return latest?.action === PASSWORD_AUDIT.ISSUED_BY_ADMIN;
}

export interface SellerAuthResponse extends AuthResponse {
  /** The password was issued by AdiOne and has not been changed yet. */
  passwordChangeRequired: boolean;
}

/**
 * POST /auth/seller/login. The role the login screen had selected is never
 * sent or trusted — the account's own role and seller membership decide.
 */
export async function sellerLogin(
  email: string,
  password: string,
  context: RequestContextInput = {},
): Promise<SellerAuthResponse> {
  const auth = await loginWithPassword(email, password, context, { requireSellerRole: true });
  return { ...auth, passwordChangeRequired: await isPasswordChangeRequired(auth.user.id) };
}

export async function getPasswordStatus(
  userId: string,
): Promise<{ hasPassword: boolean; passwordChangeRequired: boolean }> {
  const user = await repository.findUserById(userId);
  if (!user || user.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Account not found.' });
  }
  return {
    hasPassword: user.passwordHash !== null,
    passwordChangeRequired: user.passwordHash !== null && (await isPasswordChangeRequired(userId)),
  };
}

/**
 * Changes the signed-in user's own password. Every existing session ends
 * (anything signed in with the old password — or a temporary one someone else
 * saw — is out), and a fresh pair is returned so THIS device stays signed in.
 * A wrong current password is a 400, not a 401: the session itself is fine.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  /** The scope of the session making the change (req.user.sessionScope). */
  scope: SessionScope,
  context: RequestContextInput = {},
): Promise<AuthResponse> {
  const user = await repository.findUserById(userId);
  if (!user || user.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Account not found.' });
  }
  assertUsable(user);
  if (!user.passwordHash) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'This account signs in with an OTP and has no password to change.',
    });
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Your current password is incorrect.',
      internalMessage: `change password: wrong current password for ${userId}`,
    });
  }
  if (currentPassword === newPassword) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Choose a new password that is different from the current one.',
    });
  }

  const passwordHash = await hashPassword(newPassword);
  await runInTransaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.auditLog.create({
      data: {
        actorUserId: userId,
        action: PASSWORD_AUDIT.CHANGED_BY_USER,
        entityType: 'User',
        entityId: userId,
        ip: context.ip ?? null,
      },
    });
  });

  await tokenService.revokeAllSessions(userId);
  const tokens = await tokenService.issueTokens({
    userId,
    role: user.role,
    mobile: user.mobile,
    // The new session keeps the scope of the one that changed the password —
    // a customer-app session can never trade itself up to a panel session.
    scope,
    userAgent: context.userAgent ?? null,
    ip: context.ip ?? null,
  });

  log.info({ userId, role: user.role }, 'password changed');
  return { user: toUserDto(user), tokens };
}

/* -------------------------------------------------------------------------- */
/* Task 2.3 — refresh, logout, profile                                        */
/* -------------------------------------------------------------------------- */

export async function refresh(
  refreshToken: string,
  context: RequestContextInput = {},
): Promise<AuthResponse> {
  const { tokens, userId } = await tokenService.rotateRefreshToken(refreshToken, context);

  const user = await repository.findUserById(userId);
  if (!user) {
    throw new AppError(ErrorCode.TOKEN_INVALID, {
      internalMessage: `refresh succeeded but user ${userId} is gone`,
    });
  }

  return { user: toUserDto(user), tokens };
}

export async function logout(refreshToken: string): Promise<void> {
  await tokenService.revokeSession(refreshToken);
}

export async function logoutEverywhere(userId: string): Promise<number> {
  return tokenService.revokeAllSessions(userId);
}

export async function getProfile(userId: string): Promise<UserDto> {
  const user = await repository.findUserById(userId);
  if (!user || user.deletedAt) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: 'Account not found.' });
  }
  return toUserDto(user);
}

export async function updateProfile(
  userId: string,
  data: { fullName?: string; email?: string | null },
): Promise<UserDto> {
  const user = await repository.updateProfile(userId, data);
  return toUserDto(user);
}

/* -------------------------------------------------------------------------- */
/* Account deletion                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deletes the customer's account.
 *
 * Required by Google Play (an in-app deletion path) and by the DPDP Act
 * (erasure on request). This is a real erasure, not a flag:
 *
 *   - all personal data is scrubbed — name, email, saved addresses, device
 *     tokens, notifications;
 *   - the mobile number is replaced with an irreversible tombstone, so the
 *     account cannot be found or reactivated, and the number is freed for a
 *     genuinely new signup;
 *   - the USER ROW SURVIVES, anonymised, because `orders` reference it and a
 *     shop must keep its financial records. The orders remain; the person
 *     behind them does not.
 *
 * Blocked while an order is still in flight — a rider is on the way to an
 * address we would be deleting.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const user = await repository.findUserById(userId);
  if (!user || user.deletedAt) return; // deleting twice is not an error

  const activeOrders = await prisma.order.count({
    where: { userId, status: { in: [...ACTIVE_ORDER_STATUSES] } },
  });

  if (activeOrders > 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message:
        'You have an order in progress. Please wait until it is delivered or cancelled before deleting your account.',
    });
  }

  const now = new Date();
  // A hash of the id, so the tombstone is unique, irreversible, and cannot
  // collide with a real 10-digit number.
  //
  // Exactly 15 characters, because `users.mobile` is VarChar(15). An earlier
  // `deleted_` + 8 prefix was 16 and every deletion failed with Prisma P2000.
  // 11 hex characters is 44 bits, so a collision — which the UNIQUE index
  // would reject and thereby block a deletion — is not a practical concern.
  const tombstone = `del_${sha256(userId).slice(0, 11)}`;

  await runInTransaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        mobile: tombstone,
        email: null,
        fullName: null,
        passwordHash: null,
        referralCode: null,
        mobileVerifiedAt: null,
        status: UserStatus.DELETED,
        deletedAt: now,
      },
    });

    // Addresses are the most sensitive thing we hold — where the person lives.
    await tx.address.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { userId } });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.cart.deleteMany({ where: { userId, status: 'ACTIVE' } });
  });

  log.info({ userId }, 'account deleted and personal data erased');
}

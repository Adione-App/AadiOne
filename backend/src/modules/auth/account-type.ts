/**
 * The two account types one mobile number can have — SEPARATE accounts,
 * never merged:
 *
 *   customer  role CUSTOMER — the shopping app (OTP sign-in, or email +
 *             password signup). At most one per number.
 *   partner   every other role — the Seller Panel (seller owner / staff),
 *             admin, staff, delivery. At most one per number.
 *
 * The database enforces "one of each type per number" (and per email) with
 * partial unique indexes keyed on the same role test
 * (migration v2_separate_customer_partner_accounts). Every lookup by mobile or
 * email therefore names the account type it wants — with the filters below —
 * so each portal always reaches its own account, even when both share a number.
 */

import type { Prisma } from '@prisma/client';
import { UserRole } from '../../shared';

export type AccountType = 'customer' | 'partner';

/** Prisma filter for the customer account of a number/email. */
export const CUSTOMER_ACCOUNT = { role: UserRole.CUSTOMER } satisfies Prisma.UserWhereInput;

/** Prisma filter for the partner (Seller Panel / admin / staff / delivery) account. */
export const PARTNER_ACCOUNT = { role: { not: UserRole.CUSTOMER } } satisfies Prisma.UserWhereInput;

export function accountFilter(type: AccountType): Prisma.UserWhereInput {
  return type === 'customer' ? CUSTOMER_ACCOUNT : PARTNER_ACCOUNT;
}

export function accountTypeOf(role: UserRole | string): AccountType {
  return role === UserRole.CUSTOMER ? 'customer' : 'partner';
}

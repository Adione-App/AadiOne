/**
 * Supertest harness.
 *
 * Exercises the real Express app — every middleware, the real validation, the
 * real error handler — rather than calling controllers directly. A test that
 * bypasses the middleware stack cannot catch a rate limiter wired in the wrong
 * order, which is exactly the kind of bug that reaches production.
 */

import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { isSellerRole, type ApiError, type ApiSuccess } from '../../src/shared';
import { prisma } from '../../src/infra/db/prisma';
import { hashPassword } from '../../src/common/crypto';

let app: Express | undefined;

export function api(): request.Agent {
  app ??= createApp();
  return request(app);
}

export function expectSuccess<T>(body: unknown): ApiSuccess<T> {
  const typed = body as ApiSuccess<T> | ApiError;
  if (typed.success !== true) {
    throw new Error(
      `expected a success envelope, got: ${JSON.stringify((typed as ApiError).error)}`,
    );
  }
  return typed;
}

export function expectError(body: unknown): ApiError['error'] {
  const typed = body as ApiSuccess<unknown> | ApiError;
  if (typed.success !== false) {
    throw new Error(`expected an error envelope, got: ${JSON.stringify(typed)}`);
  }
  return typed.error;
}

/** The password `loginAs` gives a seller account that has none (tests only). */
export const TEST_SELLER_PASSWORD = 'SellerTest@123';
let testSellerPasswordHash: Promise<string> | undefined;

/**
 * Signs a user in and returns the tokens.
 *
 *   customer (or a new number)  the full OTP login (send + verify)
 *   seller-role account         the Seller Panel login, EMAIL + PASSWORD
 *                               (a seller's OTP login is a customer-app
 *                               session, which no seller route accepts);
 *                               a seeded seller with no email/password gets
 *                               test ones first.
 */
export async function loginAs(mobile: string): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
}> {
  const existing = await prisma.user.findFirst({
    where: { mobile, deletedAt: null },
    select: { id: true, role: true, email: true, passwordHash: true },
  });
  if (existing && isSellerRole(existing.role)) return loginSellerWithPassword(existing);

  const sent = await api().post('/api/v1/auth/send-otp').send({ mobile }).expect(200);
  const otp = expectSuccess<{ devOtp?: string }>(sent.body).data.devOtp;
  if (!otp) throw new Error('console OTP provider did not return devOtp');

  const verified = await api().post('/api/v1/auth/verify-otp').send({ mobile, otp });
  const data = expectSuccess<{
    user: { id: string };
    tokens: { accessToken: string; refreshToken: string };
  }>(verified.body).data;

  return {
    accessToken: data.tokens.accessToken,
    refreshToken: data.tokens.refreshToken,
    userId: data.user.id,
  };
}

async function loginSellerWithPassword(user: { id: string; email: string | null; passwordHash: string | null }) {
  if (!user.email || !user.passwordHash) {
    testSellerPasswordHash ??= hashPassword(TEST_SELLER_PASSWORD);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        email: user.email ?? `seller-${user.id.slice(0, 8)}@sellers.adione.test`,
        passwordHash: await testSellerPasswordHash,
      },
    });
  }
  const email = (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } })).email!;
  const res = await api().post('/api/v1/auth/seller/login').send({ email, password: TEST_SELLER_PASSWORD });
  const data = expectSuccess<{ user: { id: string }; tokens: { accessToken: string; refreshToken: string } }>(res.body).data;
  return { accessToken: data.tokens.accessToken, refreshToken: data.tokens.refreshToken, userId: data.user.id };
}

export const bearer = (token: string): string => `Bearer ${token}`;

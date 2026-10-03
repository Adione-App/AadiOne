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
import type { ApiError, ApiSuccess } from '../../src/shared';

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

/** Runs the full OTP login and returns the tokens. */
export async function loginAs(mobile: string): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
}> {
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

export const bearer = (token: string): string => `Bearer ${token}`;

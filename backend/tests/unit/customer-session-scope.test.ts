/**
 * Customer-app sessions for every account — and why that is safe.
 *
 * A mobile OTP opens a CUSTOMER-scoped session for any registered number: a
 * customer, a seller owner, an admin. The session's access token claims role
 * CUSTOMER whatever the account's role, and refresh keeps that scope, so the
 * unchanged role/permission gates treat it as a shopper: it can shop, and it
 * can never reach a Seller or Admin Panel API. Panel logins stay FULL.
 *
 * No database: the repository and OTP store are mocked; the route checks run
 * through the real Express app, whose seller/admin gates refuse BEFORE any
 * query.
 */

import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/auth/auth.repository', () => ({
  createRefreshToken: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rt-1', revokedAt: null, ...input })),
  findRefreshTokenByHash: vi.fn(),
  revokeRefreshToken: vi.fn(async () => undefined),
  revokeTokenFamily: vi.fn(async () => 0),
  revokeAllUserTokens: vi.fn(async () => 0),
  findUserById: vi.fn(),
  findUserByMobile: vi.fn(),
  findUserByEmail: vi.fn(),
  touchLastLogin: vi.fn(async () => undefined),
  markMobileVerified: vi.fn(async () => undefined),
  referralCodeExists: vi.fn(async () => false),
  createCustomer: vi.fn(),
}));
vi.mock('../../src/modules/auth/otp.service', () => ({
  verifyOtp: vi.fn(async () => undefined),
  sendOtp: vi.fn(),
  clearOtpState: vi.fn(),
}));

import { SessionScope } from '@prisma/client';
import { createApp } from '../../src/app';
import { authenticate, requireAdmin, requirePermission, requireSellerOrAdmin } from '../../src/middleware/auth';
import * as repository from '../../src/modules/auth/auth.repository';
import { verifyOtpAndAuthenticate } from '../../src/modules/auth/auth.service';
import { issueTokens, rotateRefreshToken, verifyAccessToken } from '../../src/modules/auth/token.service';
import { ErrorCode, Permission, UserRole, UserStatus } from '../../src/shared';

const repo = vi.mocked(repository);

function account(role: UserRole, over: Record<string, unknown> = {}) {
  return {
    id: `user-${role.toLowerCase()}`,
    mobile: '9400000201',
    fullName: `${role} account`,
    email: `${role.toLowerCase()}@example.test`,
    passwordHash: 'not-used',
    role,
    status: UserStatus.ACTIVE,
    codBlocked: false,
    mobileVerifiedAt: new Date('2026-10-01'),
    referralCode: 'REF123',
    referredByUserId: null,
    lastLoginAt: null,
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    deletedAt: null,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('customer-app OTP login (verifyOtpAndAuthenticate)', () => {
  for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
    it(`${role} account: allowed — the SAME account, a shopper session`, async () => {
      repo.findUserByMobile.mockResolvedValueOnce(account(role));

      const result = await verifyOtpAndAuthenticate('9400000201', '123456');

      expect(result.user.id).toBe(`user-${role.toLowerCase()}`);
      expect(result.user.role).toBe(role); // the profile is the real account
      expect(repo.createCustomer).not.toHaveBeenCalled(); // no duplicate identity
      expect(repo.createRefreshToken).toHaveBeenCalledWith(expect.objectContaining({ userId: `user-${role.toLowerCase()}`, scope: SessionScope.CUSTOMER }));
      const claims = verifyAccessToken(result.tokens.accessToken);
      expect(claims).toMatchObject({ sub: `user-${role.toLowerCase()}`, role: UserRole.CUSTOMER, scp: 'customer' });
    });
  }

  it('existing customer: unchanged — a CUSTOMER session', async () => {
    repo.findUserByMobile.mockResolvedValueOnce(account(UserRole.CUSTOMER));
    const result = await verifyOtpAndAuthenticate('9400000201', '123456');
    expect(result.user.role).toBe(UserRole.CUSTOMER);
    expect(verifyAccessToken(result.tokens.accessToken)).toMatchObject({ role: UserRole.CUSTOMER, scp: 'customer' });
  });

  it('new number: still creates a customer account on first OTP', async () => {
    repo.findUserByMobile.mockResolvedValueOnce(null);
    repo.createCustomer.mockResolvedValueOnce(account(UserRole.CUSTOMER, { id: 'new-user' }));
    const result = await verifyOtpAndAuthenticate('9400000299', '123456');
    expect(repo.createCustomer).toHaveBeenCalledTimes(1);
    expect(result.user.isNewUser).toBe(true);
    expect(verifyAccessToken(result.tokens.accessToken)).toMatchObject({ sub: 'new-user', role: UserRole.CUSTOMER });
  });

  it('blocked account: still refused', async () => {
    repo.findUserByMobile.mockResolvedValueOnce(account(UserRole.SELLER_OWNER, { status: UserStatus.BLOCKED }));
    await expect(verifyOtpAndAuthenticate('9400000201', '123456')).rejects.toMatchObject({ code: ErrorCode.ACCOUNT_BLOCKED });
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('session tokens', () => {
  it('a FULL (panel) session keeps the account role', async () => {
    const tokens = await issueTokens({ userId: 'u', role: UserRole.SELLER_OWNER, mobile: '9', scope: SessionScope.FULL });
    expect(verifyAccessToken(tokens.accessToken)).toMatchObject({ role: UserRole.SELLER_OWNER, scp: 'full' });
    expect(repo.createRefreshToken).toHaveBeenCalledWith(expect.objectContaining({ scope: SessionScope.FULL }));
  });

  it('refresh keeps a customer-app session CUSTOMER even though the account is a seller/admin', async () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN]) {
      repo.findRefreshTokenByHash.mockResolvedValueOnce({
        id: 'rt',
        userId: 'u',
        familyId: '11111111-1111-4111-8111-111111111111',
        scope: SessionScope.CUSTOMER,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      });
      repo.findUserById.mockResolvedValueOnce(account(role, { id: 'u' }));

      const { tokens } = await rotateRefreshToken('presented-refresh-token');

      expect(verifyAccessToken(tokens.accessToken)).toMatchObject({ sub: 'u', role: UserRole.CUSTOMER, scp: 'customer' });
      expect(repo.createRefreshToken).toHaveBeenLastCalledWith(expect.objectContaining({ scope: SessionScope.CUSTOMER }));
    }
  });

  it('refresh keeps a panel session FULL', async () => {
    repo.findRefreshTokenByHash.mockResolvedValueOnce({
      id: 'rt',
      userId: 'u',
      familyId: '11111111-1111-4111-8111-111111111111',
      scope: SessionScope.FULL,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    repo.findUserById.mockResolvedValueOnce(account(UserRole.ADMIN, { id: 'u' }));
    const { tokens } = await rotateRefreshToken('presented-refresh-token');
    expect(verifyAccessToken(tokens.accessToken)).toMatchObject({ role: UserRole.ADMIN, scp: 'full' });
  });
});

/* -------------------------------------------------------------------------- */

/** Runs a middleware chain against a bearer token; resolves with the error code, or 'passed'. */
async function gate(token: string, ...chain: Array<(req: Request, res: Response, next: NextFunction) => void>): Promise<string> {
  const req = { header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) } as unknown as Request;
  for (const middleware of chain) {
    const error = await new Promise<unknown>((resolve) => middleware(req, {} as Response, resolve as NextFunction));
    if (error) return (error as { code: string }).code;
  }
  return 'passed';
}

describe('authorization gates (unchanged) see a customer-app session as a shopper', () => {
  const customerSession = async (role: UserRole) => (await issueTokens({ userId: 'u', role, mobile: '9', scope: SessionScope.CUSTOMER })).accessToken;
  const panelSession = async (role: UserRole) => (await issueTokens({ userId: 'u', role, mobile: '9', scope: SessionScope.FULL })).accessToken;

  it('seller owner / admin customer-app sessions may shop', async () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN]) {
      const token = await customerSession(role);
      for (const permission of [Permission.CART_MANAGE, Permission.ADDRESS_MANAGE, Permission.ORDER_CREATE, Permission.ORDER_READ_OWN, Permission.ORDER_CANCEL_OWN]) {
        expect(await gate(token, authenticate, requirePermission(permission))).toBe('passed');
      }
    }
  });

  it('customer-app sessions can never pass a Seller or Admin Panel gate', async () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      const token = await customerSession(role);
      expect(await gate(token, authenticate, requireSellerOrAdmin)).toBe(ErrorCode.FORBIDDEN);
      expect(await gate(token, authenticate, requireAdmin)).toBe(ErrorCode.FORBIDDEN);
      expect(await gate(token, authenticate, requirePermission(Permission.SELLER_CATALOG_MANAGE))).toBe(ErrorCode.FORBIDDEN);
      expect(await gate(token, authenticate, requirePermission(Permission.ORDER_READ_ALL))).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it('panel sessions are unchanged: seller passes the seller gate, admin the admin gate, a customer neither', async () => {
    expect(await gate(await panelSession(UserRole.SELLER_OWNER), authenticate, requireSellerOrAdmin)).toBe('passed');
    expect(await gate(await panelSession(UserRole.SELLER_OWNER), authenticate, requireAdmin)).toBe(ErrorCode.FORBIDDEN);
    expect(await gate(await panelSession(UserRole.ADMIN), authenticate, requireAdmin)).toBe('passed');
    expect(await gate(await panelSession(UserRole.CUSTOMER), authenticate, requireSellerOrAdmin)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('the real app refuses customer-app tokens on management routes', () => {
  const app = createApp();
  const routes: Array<[string, string]> = [
    ['get', '/api/v1/seller/lifecycle'],
    ['get', '/api/v1/seller/products'],
    ['get', '/api/v1/seller/orders'],
    ['get', '/api/v1/admin/orders'],
    ['get', '/api/v1/admin/sellers'],
    ['get', '/api/v1/admin/customers'],
  ];

  it('seller-owner and admin customer-app sessions get 403 on every Seller/Admin Panel route', async () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN]) {
      const token = (await issueTokens({ userId: 'u', role, mobile: '9', scope: SessionScope.CUSTOMER })).accessToken;
      for (const [method, path] of routes) {
        const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set('Authorization', `Bearer ${token}`);
        expect({ role, path, status: res.status, code: res.body?.error?.code }).toEqual({ role, path, status: 403, code: ErrorCode.FORBIDDEN });
      }
    }
  });
});

/**
 * Admin-managed content (category images, banners) — the checks that need no
 * database: who may reach the routes, which upload keys an admin endpoint
 * accepts, and which placement slugs are valid.
 *
 * The route checks run through the real Express app; the admin/permission
 * gates refuse BEFORE any query, so nothing here touches a database.
 */

import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

// Tokens only: the refresh-token row is never needed here.
vi.mock('../../src/modules/auth/auth.repository', async (original) => ({
  ...(await original<object>()),
  createRefreshToken: vi.fn(async (input: Record<string, unknown>) => ({ id: 'rt-1', revokedAt: null, ...input })),
}));
import { SessionScope } from '@prisma/client';
import { createApp } from '../../src/app';
import { issueTokens } from '../../src/modules/auth/token.service';
import { assertAdminKey } from '../../src/modules/admin/admin-upload.service';
import { PLACEMENT_PATTERN } from '../../src/modules/banners/banner.service';
import { ErrorCode, UserRole } from '../../src/shared';

const CATEGORY_ID = '5b0c5f7e-9a59-4f3e-9d0e-6a3f1c2b7d10';
const BANNER_ID = '0f7c1f2a-2b3c-4d5e-8f90-a1b2c3d4e5f6';

/** Every admin content mutation, with a body that passes validation. */
const MUTATIONS: Array<[method: 'post' | 'put' | 'patch' | 'delete', path: string, body?: object]> = [
  ['post', '/api/v1/admin/uploads/presign', { fileName: 'a.jpg', contentType: 'image/jpeg', purpose: 'category' }],
  ['put', `/api/v1/admin/categories/${CATEGORY_ID}/image`, { key: 'admin/categories/2026-10-09/x.jpg' }],
  ['delete', `/api/v1/admin/categories/${CATEGORY_ID}/image`],
  ['post', '/api/v1/admin/banners', { placement: 'home_top', imageKey: 'admin/banners/2026-10-09/x.jpg' }],
  ['patch', `/api/v1/admin/banners/${BANNER_ID}`, { isActive: false }],
  ['delete', `/api/v1/admin/banners/${BANNER_ID}`],
];

async function token(role: UserRole, scope: SessionScope): Promise<string> {
  return (await issueTokens({ userId: 'u', role, mobile: '9', scope })).accessToken;
}

describe('admin content routes refuse everyone but a panel admin with catalogue write', () => {
  const app = createApp();

  async function call(method: string, path: string, body: object | undefined, accessToken?: string) {
    let req = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    if (accessToken) req = req.set('Authorization', `Bearer ${accessToken}`);
    return body ? req.send(body) : req;
  }

  it('customer-app (OTP) sessions of a seller owner or an admin get 403', async () => {
    for (const role of [UserRole.SELLER_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      const accessToken = await token(role, SessionScope.CUSTOMER);
      for (const [method, path, body] of [...MUTATIONS, ['get', '/api/v1/admin/banners'] as const]) {
        const res = await call(method, path, body, accessToken);
        expect({ role, path, status: res.status, code: res.body?.error?.code }).toEqual({ role, path, status: 403, code: ErrorCode.FORBIDDEN });
      }
    }
  });

  it('a Seller Panel session and a customer get 403 — seller permissions are unchanged', async () => {
    for (const accessToken of [await token(UserRole.SELLER_OWNER, SessionScope.FULL), await token(UserRole.CUSTOMER, SessionScope.FULL)]) {
      for (const [method, path, body] of MUTATIONS) {
        const res = await call(method, path, body, accessToken);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
    }
  });

  it('admin staff (catalogue read only) cannot change content', async () => {
    const accessToken = await token(UserRole.STAFF, SessionScope.FULL);
    for (const [method, path, body] of MUTATIONS) {
      const res = await call(method, path, body, accessToken);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it('no token: 401', async () => {
    for (const [method, path, body] of MUTATIONS) {
      expect((await call(method, path, body)).status).toBe(401);
    }
  });
});

describe('assertAdminKey', () => {
  it('accepts keys from the admin upload folders', () => {
    expect(() => assertAdminKey('admin/categories/2026-10-09/0b6f.jpg')).not.toThrow();
    expect(() => assertAdminKey('admin/banners/2026-10-09/0b6f.png')).not.toThrow();
  });

  it('refuses a seller upload, path traversal and odd characters', () => {
    for (const key of ['sellers/abc/images/x.jpg', 'admin/../sellers/abc/x.jpg', 'admin/banners/x y.jpg', 'https://evil.test/admin/x.jpg', '']) {
      expect(() => assertAdminKey(key), key).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }));
    }
  });
});

describe('banner placements', () => {
  it('are lowercase slugs, optionally scoped (category:<id>)', () => {
    for (const ok of ['home_top', 'home_middle', 'home_bottom', 'food', `category:${CATEGORY_ID}`]) expect(PLACEMENT_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['Home', 'home top', '1home', 'home-top', 'category:', 'a:b:c', '']) expect(PLACEMENT_PATTERN.test(bad), bad).toBe(false);
  });
});

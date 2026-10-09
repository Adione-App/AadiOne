import { UserRole, UserStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { bootstrapGate, planAdminBootstrap, type BootstrapUser } from '../../src/modules/auth/admin-bootstrap.service';

const user = (over: Partial<BootstrapUser> = {}): BootstrapUser => ({
  id: 'u1',
  email: 'owner@adione.in',
  fullName: 'Store Owner',
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  deletedAt: null,
  hasPassword: true,
  ...over,
});

describe('bootstrapGate', () => {
  const base = { mode: 'auto' as const, nodeEnv: 'development', onRailway: true, email: 'admin@example.com', password: 'S3cure-Passw0rd' };

  it('runs on Railway even with NODE_ENV=development (Cashfree sandbox deployments)', () => {
    expect(bootstrapGate(base).run).toBe(true);
  });

  it('never runs from a developer machine in auto mode, even with ADMIN_* set (.env.v2)', () => {
    expect(bootstrapGate({ ...base, onRailway: false })).toMatchObject({ run: false });
  });

  it('runs with NODE_ENV=production', () => {
    expect(bootstrapGate({ ...base, onRailway: false, nodeEnv: 'production' }).run).toBe(true);
  });

  it('can be switched off, and needs both email and password', () => {
    expect(bootstrapGate({ ...base, mode: 'false' }).run).toBe(false);
    expect(bootstrapGate({ ...base, password: undefined }).run).toBe(false);
    expect(bootstrapGate({ ...base, email: undefined }).run).toBe(false);
  });

  it('refuses to provision the published example password', () => {
    expect(bootstrapGate({ ...base, password: 'ChangeMe@123' })).toMatchObject({ run: false, reason: expect.stringContaining('example') });
  });
});

describe('planAdminBootstrap', () => {
  it('keeps an existing admin found by email and never resets its password', () => {
    expect(planAdminBootstrap({ name: 'Store Owner' }, { byEmail: user(), admins: [user()] })).toEqual({
      kind: 'sync',
      userId: 'u1',
      setName: false,
      setPassword: false,
    });
  });

  it('updates only the name when ADMIN_NAME differs', () => {
    expect(planAdminBootstrap({ name: 'madan Khuntia' }, { byEmail: user(), admins: [user()] })).toMatchObject({ kind: 'sync', setName: true, setPassword: false });
  });

  it('sets a password only when the admin has none', () => {
    expect(planAdminBootstrap({}, { byEmail: user({ hasPassword: false }), admins: [] })).toMatchObject({ kind: 'sync', setPassword: true });
  });

  it('re-links the single existing admin when ADMIN_EMAIL is new — no duplicate', () => {
    expect(planAdminBootstrap({ name: 'madan Khuntia' }, { byEmail: null, admins: [user()] })).toEqual({ kind: 'relink', userId: 'u1', setName: true });
  });

  it('creates an admin only when there is none', () => {
    expect(planAdminBootstrap({ name: 'Owner' }, { byEmail: null, admins: [] })).toEqual({ kind: 'create' });
    expect(planAdminBootstrap({}, { byEmail: null, admins: [user({ deletedAt: new Date() })] })).toEqual({ kind: 'create' });
  });

  it('refuses to turn a seller or customer account into an admin', () => {
    expect(planAdminBootstrap({}, { byEmail: user({ role: UserRole.SELLER_OWNER }), admins: [user({ id: 'a' })] })).toMatchObject({ kind: 'refuse' });
    expect(planAdminBootstrap({}, { byEmail: user({ role: UserRole.CUSTOMER }), admins: [] })).toMatchObject({ kind: 'refuse' });
  });

  it('refuses disabled accounts and ambiguous multi-admin setups', () => {
    expect(planAdminBootstrap({}, { byEmail: user({ status: UserStatus.BLOCKED }), admins: [] })).toMatchObject({ kind: 'refuse' });
    expect(planAdminBootstrap({}, { byEmail: null, admins: [user({ status: UserStatus.BLOCKED })] })).toMatchObject({ kind: 'refuse' });
    expect(planAdminBootstrap({}, { byEmail: null, admins: [user({ id: 'a' }), user({ id: 'b' })] })).toMatchObject({ kind: 'refuse' });
  });
});

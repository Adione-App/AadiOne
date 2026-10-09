import { UserRole, UserStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import bcrypt from 'bcryptjs';

import {
  applyAdminBootstrap,
  bootstrapGate,
  describeDbError,
  planAdminBootstrap,
  type BootstrapUser,
} from '../../src/modules/auth/admin-bootstrap.service';

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

/* -------------------------------------------------------------------------- */
/* applyAdminBootstrap — the database step, against a fake transaction        */
/* -------------------------------------------------------------------------- */

type Row = { id: string; email: string | null; fullName: string | null; role: UserRole; status: UserStatus; deletedAt: Date | null; passwordHash: string | null; createdAt: Date };

/** In-memory stand-in for the Prisma transaction client — only what the bootstrap uses. */
function fakeTx(rows: Row[]) {
  const calls = { executeRaw: [] as string[], updates: [] as Array<{ id: string; data: Record<string, unknown> }>, audits: [] as unknown[], creates: 0 };
  const tx = {
    // P2010 regression: pg_advisory_xact_lock() returns void, which $queryRaw cannot deserialize.
    $queryRaw: () => {
      throw Object.assign(new Error("Raw query failed. Code: `N/A`. Message: `Failed to deserialize column of type 'void'.`"), { code: 'P2010' });
    },
    $executeRaw: (strings: TemplateStringsArray) => {
      calls.executeRaw.push(strings.join('?'));
      return Promise.resolve(1);
    },
    user: {
      findFirst: ({ where }: any) => Promise.resolve(rows.find((r) => r.email?.toLowerCase() === where.email.equals.toLowerCase()) ?? null),
      findMany: ({ where }: any) => Promise.resolve(rows.filter((r) => where.role.in.includes(r.role))),
      count: () => Promise.resolve(0),
      create: () => {
        calls.creates += 1;
        return Promise.resolve({ id: 'new' });
      },
      update: ({ where, data }: any) => {
        calls.updates.push({ id: where.id, data });
        return Promise.resolve({});
      },
    },
    auditLog: { create: ({ data }: any) => (calls.audits.push(data), Promise.resolve({})) },
  };
  return { tx: tx as any, calls };
}

const adminRow = (over: Partial<Row> = {}): Row => ({
  id: '408f2b22-0773-449a-ae2a-42cf523cee78',
  email: 'owner@adione.in',
  fullName: 'Store Owner',
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  deletedAt: null,
  passwordHash: '$2a$12$abcdefghijklmnopqrstuuMx8Kq2m3Q9eQkq1D7m1oH8VYb1r0b6S',
  createdAt: new Date('2026-10-02'),
  ...over,
});

describe('applyAdminBootstrap', () => {
  const config = { email: 'admin@example.com', name: 'madan Khuntia', password: 'S3cure-Passw0rd!' };

  it('takes the advisory lock with $executeRaw (never $queryRaw — P2010 on a void column)', async () => {
    const { tx, calls } = fakeTx([adminRow()]);
    await applyAdminBootstrap(tx, config);
    expect(calls.executeRaw).toEqual([expect.stringContaining('pg_advisory_xact_lock')]);
  });

  it('re-links the existing admin in place: same id, new email, name and a bcrypt hash of the new password', async () => {
    const { tx, calls } = fakeTx([adminRow()]);
    const result = await applyAdminBootstrap(tx, config);

    expect(result).toMatchObject({ plan: { kind: 'relink' }, userId: '408f2b22-0773-449a-ae2a-42cf523cee78' });
    expect(calls.creates).toBe(0);
    expect(calls.updates).toHaveLength(1);
    const { id, data } = calls.updates[0]!;
    expect(id).toBe('408f2b22-0773-449a-ae2a-42cf523cee78');
    expect(data).toMatchObject({ email: 'admin@example.com', fullName: 'madan Khuntia' });
    expect(data['passwordHash']).not.toBe(config.password);
    expect(await bcrypt.compare(config.password, data['passwordHash'] as string)).toBe(true);
    expect(calls.audits).toEqual([expect.objectContaining({ action: 'admin.bootstrap.relink', after: { fields: ['email', 'passwordHash', 'fullName'] } })]);
  });

  it('on the next start finds the admin by email and changes nothing — the password is not reset', async () => {
    const { tx, calls } = fakeTx([adminRow({ email: 'admin@example.com', fullName: 'madan Khuntia' })]);
    const result = await applyAdminBootstrap(tx, config);
    expect(result).toMatchObject({ plan: { kind: 'sync', setPassword: false, setName: false }, changed: [] });
    expect(calls.updates).toHaveLength(0);
    expect(calls.audits).toHaveLength(0);
  });

  it('writes nothing when refusing (blocked admin)', async () => {
    const { tx, calls } = fakeTx([adminRow({ status: UserStatus.BLOCKED })]);
    expect((await applyAdminBootstrap(tx, config)).plan.kind).toBe('refuse');
    expect(calls.updates).toHaveLength(0);
    expect(calls.creates).toBe(0);
  });
});

describe('describeDbError', () => {
  it('reports the Prisma code and the driver message of a P2010', () => {
    const error = Object.assign(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `N/A`. Message: `Failed to deserialize column`'), {
      code: 'P2010',
      meta: { code: 'N/A', message: "Failed to deserialize column of type 'void'." },
    });
    expect(describeDbError(error)).toEqual({ prismaCode: 'P2010', sqlState: undefined, message: "Failed to deserialize column of type 'void'." });
  });

  it('keeps the SQLSTATE and redacts emails, hashes and connection strings', () => {
    const error = Object.assign(new Error('x'), {
      code: 'P2010',
      meta: {
        code: '23505',
        message: 'Key (lower(email))=(someone@gmail.com) exists; hash $2a$12$abcdefghijklmnopqrstuuMx8Kq2m3Q9eQkq1D7m1oH8VYb1r0b6S via postgresql://u:p@h:5432/db',
      },
    });
    const described = describeDbError(error);
    expect(described.sqlState).toBe('23505');
    expect(described.message).not.toMatch(/someone@gmail\.com|\$2a\$|postgresql:\/\/|u:p@/);
    expect(described.message).toContain('[email]');
    expect(described.message).toContain('[hash]');
    expect(described.message).toContain('[url]');
  });
});

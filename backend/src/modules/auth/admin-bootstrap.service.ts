/**
 * Production admin provisioning from deployment configuration.
 *
 * ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME (Railway variables) describe the
 * intended admin account. PostgreSQL stays the source of truth: login only
 * ever checks the database (auth.service.ts `loginWithPassword`). At startup
 * this brings the database in line with the configuration — idempotently:
 *
 *   - an ADMIN with ADMIN_EMAIL exists  -> keep it; set ADMIN_NAME if it
 *     differs; set the password ONLY if the account has none. A password the
 *     admin changed later is never reset by a restart.
 *   - no account has ADMIN_EMAIL, and exactly one active ADMIN exists
 *     -> that is the intended account: re-link it (email + password + name)
 *     and revoke its sessions. The next start finds it by email (case above).
 *   - no ADMIN at all -> create one.
 *   - anything ambiguous (ADMIN_EMAIL belongs to a seller/customer, a disabled
 *     account, several admins) -> change nothing and log why.
 *
 * Runs only on Railway or with NODE_ENV=production (ADMIN_BOOTSTRAP=auto):
 * never from a developer machine, whose .env.v2 may point at the same
 * database. The password is bcrypt-hashed before it is stored; neither it
 * nor the email is ever logged in full.
 */

import { UserRole, UserStatus } from '@prisma/client';

import { hashPassword } from '../../common/crypto';
import { moduleLogger } from '../../common/logger';
import { env } from '../../config/env';
import { prisma } from '../../infra/db/prisma';
import { maskEmail } from '../../infra/email';
import * as tokenService from './token.service';

const log = moduleLogger('admin-bootstrap');

/** Roles that ARE an admin account (STAFF is admin-panel staff, not the owner). */
const ADMIN_ACCOUNT_ROLES: readonly UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

/** The seed's reserved, non-dialable mobile for the admin row (mobile is unique and required). */
export const ADMIN_RESERVED_MOBILE = '0000000001';

/** Example values from .env.example / old defaults — never provisioned. */
const KNOWN_EXAMPLE_PASSWORDS = new Set(['ChangeMe@123']);

/* -------------------------------------------------------------------------- */
/* Decisions (pure — unit tested)                                             */
/* -------------------------------------------------------------------------- */

export interface BootstrapGateInput {
  mode: 'auto' | 'true' | 'false';
  nodeEnv: string;
  onRailway: boolean;
  email?: string;
  password?: string;
}

export function bootstrapGate(input: BootstrapGateInput): { run: boolean; reason: string } {
  if (input.mode === 'false') return { run: false, reason: 'ADMIN_BOOTSTRAP=false' };
  if (!input.email || !input.password) return { run: false, reason: 'ADMIN_EMAIL / ADMIN_PASSWORD not set' };
  if (input.mode === 'auto' && input.nodeEnv !== 'production' && !input.onRailway) {
    return { run: false, reason: 'not a deployment (ADMIN_BOOTSTRAP=auto runs only on Railway or with NODE_ENV=production)' };
  }
  if (KNOWN_EXAMPLE_PASSWORDS.has(input.password) || /change-?me/i.test(input.password)) {
    return { run: false, reason: 'ADMIN_PASSWORD is a published example value — refusing to provision it' };
  }
  return { run: true, reason: input.mode === 'true' ? 'ADMIN_BOOTSTRAP=true' : 'deployment' };
}

export interface BootstrapUser {
  id: string;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  status: UserStatus;
  deletedAt: Date | null;
  hasPassword: boolean;
}

export type AdminBootstrapPlan =
  | { kind: 'create' }
  | { kind: 'relink'; userId: string; setName: boolean }
  | { kind: 'sync'; userId: string; setName: boolean; setPassword: boolean }
  | { kind: 'refuse'; reason: string };

const isUsable = (u: BootstrapUser) => u.status === UserStatus.ACTIVE && u.deletedAt === null;

export function planAdminBootstrap(
  config: { name?: string | null },
  state: { byEmail: BootstrapUser | null; admins: BootstrapUser[] },
): AdminBootstrapPlan {
  const wantsName = (u: BootstrapUser) => Boolean(config.name) && u.fullName !== config.name;

  if (state.byEmail) {
    const user = state.byEmail;
    if (!ADMIN_ACCOUNT_ROLES.includes(user.role)) {
      return { kind: 'refuse', reason: `ADMIN_EMAIL belongs to an existing ${user.role} account — refusing to make it an admin` };
    }
    if (!isUsable(user)) {
      return { kind: 'refuse', reason: `the admin account with ADMIN_EMAIL is ${user.deletedAt ? 'deleted' : user.status} — not reactivating it` };
    }
    return { kind: 'sync', userId: user.id, setName: wantsName(user), setPassword: !user.hasPassword };
  }

  const admins = state.admins.filter((a) => a.deletedAt === null);
  if (admins.length === 0) return { kind: 'create' };
  if (admins.length === 1) {
    const only = admins[0]!;
    if (!isUsable(only)) {
      return { kind: 'refuse', reason: `the only admin account is ${only.status} — not re-linking it` };
    }
    return { kind: 'relink', userId: only.id, setName: wantsName(only) };
  }
  return { kind: 'refuse', reason: `${admins.length} admin accounts exist and none has ADMIN_EMAIL — not guessing which one is intended` };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  deletedAt: true,
  passwordHash: true,
} as const;

type SelectedUser = { id: string; email: string | null; fullName: string | null; role: UserRole; status: UserStatus; deletedAt: Date | null; passwordHash: string | null };
const toBootstrapUser = ({ passwordHash, ...rest }: SelectedUser): BootstrapUser => ({ ...rest, hasPassword: Boolean(passwordHash) });

export interface AdminBootstrapResult {
  ran: boolean;
  reason: string;
  plan?: AdminBootstrapPlan;
  userId?: string;
  changed?: string[];
}

/**
 * Brings the admin account in line with ADMIN_* (see the file comment).
 * Never throws: a failure is logged and the server starts with the database
 * as it is, so login keeps working with the existing account.
 */
export async function syncBootstrapAdmin(): Promise<AdminBootstrapResult> {
  const onRailway = Boolean(process.env['RAILWAY_ENVIRONMENT_ID'] || process.env['RAILWAY_PROJECT_ID']);
  const gate = bootstrapGate({
    mode: env.ADMIN_BOOTSTRAP,
    nodeEnv: env.NODE_ENV,
    onRailway,
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  });
  if (!gate.run) {
    // A refused example password on a deployment is a real problem; "not a deployment" is the normal local case.
    if (/example/.test(gate.reason)) log.error({ reason: gate.reason }, 'admin bootstrap refused');
    else log.debug({ reason: gate.reason }, 'admin bootstrap skipped');
    return { ran: false, reason: gate.reason };
  }

  const email = env.ADMIN_EMAIL!.toLowerCase();
  const name = env.ADMIN_NAME ?? null;
  try {
    const result = await prisma.$transaction(
      async (tx): Promise<{ plan: AdminBootstrapPlan; userId?: string; changed: string[] }> => {
        // One booting instance at a time.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('aadione:admin-bootstrap'))`;

        const byEmail = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: USER_SELECT });
        const admins = await tx.user.findMany({ where: { role: { in: [...ADMIN_ACCOUNT_ROLES] } }, select: USER_SELECT, orderBy: { createdAt: 'asc' } });
        const plan = planAdminBootstrap({ name }, { byEmail: byEmail ? toBootstrapUser(byEmail) : null, admins: admins.map(toBootstrapUser) });

        if (plan.kind === 'refuse') return { plan, changed: [] };

        if (plan.kind === 'create') {
          const mobileTaken = await tx.user.count({ where: { mobile: ADMIN_RESERVED_MOBILE } });
          if (mobileTaken) {
            return { plan: { kind: 'refuse', reason: `reserved admin mobile ${ADMIN_RESERVED_MOBILE} is already used by another account` }, changed: [] };
          }
          const created = await tx.user.create({
            data: {
              mobile: ADMIN_RESERVED_MOBILE,
              email,
              fullName: name ?? 'Admin',
              passwordHash: await hashPassword(env.ADMIN_PASSWORD!),
              role: UserRole.ADMIN,
            },
            select: { id: true },
          });
          await tx.auditLog.create({
            data: { action: 'admin.bootstrap.create', entityType: 'User', entityId: created.id, after: { fields: ['email', 'fullName', 'passwordHash', 'role'] } },
          });
          return { plan, userId: created.id, changed: ['created'] };
        }

        const data: { email?: string; fullName?: string; passwordHash?: string } = {};
        if (plan.kind === 'relink') {
          data.email = email;
          data.passwordHash = await hashPassword(env.ADMIN_PASSWORD!);
        }
        if (plan.kind === 'sync' && plan.setPassword) data.passwordHash = await hashPassword(env.ADMIN_PASSWORD!);
        if (plan.setName && name) data.fullName = name;

        const changed = Object.keys(data);
        if (changed.length > 0) {
          await tx.user.update({ where: { id: plan.userId }, data });
          await tx.auditLog.create({
            data: { action: `admin.bootstrap.${plan.kind}`, entityType: 'User', entityId: plan.userId, after: { fields: changed } },
          });
        }
        return { plan, userId: plan.userId, changed };
      },
      { timeout: 30_000, maxWait: 15_000 },
    );

    if (result.plan.kind === 'refuse') {
      log.error({ reason: result.plan.reason, email: maskEmail(email) }, 'admin bootstrap refused — nothing changed');
      return { ran: true, reason: gate.reason, plan: result.plan, changed: [] };
    }
    // New credentials: sessions issued under the old ones must not survive.
    if (result.changed.includes('passwordHash') || result.changed.includes('email')) {
      const revoked = await tokenService.revokeAllSessions(result.userId!);
      log.info({ userId: result.userId, revokedSessions: revoked }, 'admin sessions revoked after credential change');
    }
    log.info(
      { action: result.plan.kind, userId: result.userId, email: maskEmail(email), changed: result.changed },
      result.changed.length ? 'admin account provisioned from configuration' : 'admin account already in sync',
    );
    return { ran: true, reason: gate.reason, plan: result.plan, userId: result.userId, changed: result.changed };
  } catch (error) {
    log.error({ err: { message: (error as Error).message, code: (error as { code?: string }).code } }, 'admin bootstrap failed — database left unchanged');
    return { ran: true, reason: `failed: ${(error as Error).message}` };
  }
}

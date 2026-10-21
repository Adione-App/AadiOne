/**
 * Database-level guards for the Supabase deployment
 * (migration v2_lock_down_supabase_data_api):
 *
 *   - every table in `public` has Row-Level Security enabled — so the Supabase
 *     Data API roles (anon / authenticated) see nothing, even if a grant
 *     slips through. A migration that adds a table must ENABLE ROW LEVEL
 *     SECURITY on it; this test fails until it does.
 *   - the role the backend connects as OWNS every one of those tables — RLS
 *     does not apply to the owner, so the application keeps working. (If a
 *     table were owned by another role, RLS without policies would lock the
 *     backend out of it.)
 */

import { describe, expect, it } from 'vitest';
import { prisma } from '../helpers/db';

describe('database security', () => {
  it('every public table has Row-Level Security enabled and is owned by the backend role', async () => {
    const tables = await prisma.$queryRaw<{ table: string; rls: boolean; owner: string; me: string }[]>`
      SELECT c.relname AS table, c.relrowsecurity AS rls, pg_get_userbyid(c.relowner) AS owner, current_user AS me
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`;
    expect(tables.length).toBeGreaterThan(40);
    expect(tables.filter((t) => !t.rls).map((t) => t.table)).toEqual([]);
    expect(tables.filter((t) => t.owner !== t.me).map((t) => `${t.table} (owner ${t.owner})`)).toEqual([]);
  });

  it('with RLS on, the backend (owner) still reads and writes normally', async () => {
    const user = await prisma.user.create({ data: { mobile: '9876500999', fullName: 'RLS Owner Check' } });
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
    await prisma.user.delete({ where: { id: user.id } });
  });
});

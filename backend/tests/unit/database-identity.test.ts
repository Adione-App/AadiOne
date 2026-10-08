import { describe, expect, it } from 'vitest';

import { evaluateDatabaseIdentity, V1_MIGRATIONS, V2_BASELINE_MIGRATION } from '../../src/infra/db/database-identity';

const v2 = {
  hasMigrationsTable: true,
  hasV1StoresTable: false,
  hasV2SellersTable: true,
  appliedMigrations: [V2_BASELINE_MIGRATION, '20261008120000_v2_hot_path_indexes'],
};

describe('evaluateDatabaseIdentity', () => {
  it('accepts a migrated V2 database', () => {
    expect(evaluateDatabaseIdentity(v2)).toEqual({ ok: true });
  });

  it('refuses a database with V1 migration history', () => {
    const result = evaluateDatabaseIdentity({
      hasMigrationsTable: true,
      hasV1StoresTable: true,
      hasV2SellersTable: false,
      appliedMigrations: [...V1_MIGRATIONS],
    });
    expect(result).toMatchObject({ ok: false, reason: 'V1_DATABASE' });
  });

  it('refuses V1 history even when V2 migrations were also applied over it', () => {
    const result = evaluateDatabaseIdentity({ ...v2, appliedMigrations: [...v2.appliedMigrations, V1_MIGRATIONS[0]!] });
    expect(result).toMatchObject({ ok: false, reason: 'V1_DATABASE' });
  });

  it('refuses a V1 "stores" schema without migration history', () => {
    const result = evaluateDatabaseIdentity({
      hasMigrationsTable: false,
      hasV1StoresTable: true,
      hasV2SellersTable: false,
      appliedMigrations: [],
    });
    expect(result).toMatchObject({ ok: false, reason: 'V1_DATABASE' });
  });

  it('refuses an empty or unmigrated database', () => {
    expect(
      evaluateDatabaseIdentity({ hasMigrationsTable: false, hasV1StoresTable: false, hasV2SellersTable: false, appliedMigrations: [] }),
    ).toMatchObject({ ok: false, reason: 'NOT_MIGRATED' });
    expect(evaluateDatabaseIdentity({ ...v2, appliedMigrations: ['20261008120000_v2_hot_path_indexes'] })).toMatchObject({
      ok: false,
      reason: 'NOT_MIGRATED',
    });
  });
});

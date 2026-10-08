/**
 * Startup guard: the generated Prisma Client must come from THIS codebase's
 * V2 schema (prisma/schema.prisma).
 *
 * `@prisma/client` is generated code in node_modules, not part of the repo.
 * After pulling a schema change (e.g. a new column) without re-running
 * `prisma generate` — or after generating from the V1 schema in the same
 * checkout — the API still boots (tsx does not type-check), and then every
 * query touching the new field fails at runtime with a
 * PrismaClientValidationError ("Unknown field … for select statement"),
 * i.e. a 500 on otherwise healthy endpoints. This check turns that into one
 * clear startup error.
 *
 * `prisma generate` stores a copy of the schema it was generated from next to
 * the client (node_modules/.prisma/client/schema.prisma), re-formatted — so
 * the two are compared with whitespace collapsed.
 */

import fs from 'node:fs';
import path from 'node:path';

const backendRoot = path.resolve(__dirname, '../../..'); // src|dist/infra/db -> backend/
const V2_SCHEMA = path.join(backendRoot, 'prisma', 'schema.prisma');

function generatedSchemaPath(): string | null {
  try {
    // node_modules/@prisma/client/index.js -> node_modules/.prisma/client/schema.prisma
    const clientEntry = require.resolve('@prisma/client', { paths: [backendRoot] });
    return path.join(path.dirname(clientEntry), '..', '..', '.prisma', 'client', 'schema.prisma');
  } catch {
    return null;
  }
}

const normalize = (schema: string): string => schema.replace(/\s+/g, ' ').trim();

export type PrismaClientCheck = { ok: true } | { ok: false; reason: 'STALE_CLIENT'; message: string } | { ok: true; skipped: string };

/** Compares the generated client's schema with prisma/schema.prisma. */
export function checkPrismaClientMatchesSchema(): PrismaClientCheck {
  const generated = generatedSchemaPath();
  if (!generated || !fs.existsSync(generated)) return { ok: true, skipped: 'generated client schema not found' };
  if (!fs.existsSync(V2_SCHEMA)) return { ok: true, skipped: 'prisma/schema.prisma not found' };
  if (normalize(fs.readFileSync(generated, 'utf8')) === normalize(fs.readFileSync(V2_SCHEMA, 'utf8'))) return { ok: true };
  return {
    ok: false,
    reason: 'STALE_CLIENT',
    message:
      'The generated Prisma Client does not match prisma/schema.prisma (it is stale, or was generated from the archived V1 schema). ' +
      'Run `npm run db:generate:v2` (or `npm run db:generate`) in backend/, apply pending migrations with ' +
      '`npm run db:migrate:deploy:v2`, then restart the API.',
  };
}

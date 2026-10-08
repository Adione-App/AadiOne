# `prisma/` — the V2 schema, migrations and seed

| Path | What it is |
|---|---|
| `schema.prisma` | The V2 (multi-seller marketplace) schema — the only active schema |
| `migrations/` | The complete V2 migration history, oldest first |
| `seed/` | The seed (`npm run db:seed`, `db:seed:v2`, `migrate reset`) |

- `package.json` sets `"prisma": { "schema": "prisma/schema.prisma" }`, and every
  `db:*` npm script also passes `--schema=prisma/schema.prisma` explicitly.
- Every schema-changing script (`migrate dev`, `migrate deploy`, `migrate reset`,
  `db push`), the seed, the test global setup and the production container
  first run `scripts/assert-v2-database.mjs`, which refuses a database that
  carries V1 migration history. The API refuses to start against a V1 or
  unmigrated database (`src/infra/db/database-identity.ts`).
- `.gitattributes` pins each `migrations/**/migration.sql` to the line endings
  it was applied with. Prisma checksums every applied migration, so never
  re-save, re-format or edit an applied migration — add a new one instead.

The V1 single-store schema and its migration history are archived, read-only,
in [`../prisma-v1-archive/`](../prisma-v1-archive). Nothing generates, migrates
or deploys from there.

# `prisma/` — frozen V1 reference + shared seed

On the V2 branch this folder holds two unrelated things:

| Path | What it is | Used on V2? |
|---|---|---|
| `schema.prisma` | The **V1** schema, byte-identical to `main` | **No** — reference only |
| `migrations/` | The **V1** migration history, identical to `main` | **No** — never applied |
| `seed/` | The seed (`npm run db:seed`, `db:seed:v2`, `migrate reset`) | Yes — written for the V2 client |

V2's schema and migration history live in [`../prisma-v2/`](../prisma-v2):

- `package.json` sets `"prisma": { "schema": "prisma-v2/schema.prisma" }`, so
  even a bare `npx prisma …` (including `@prisma/client`'s postinstall
  generate) resolves to V2.
- Every `db:*` npm script also passes `--schema=prisma-v2/schema.prisma`
  explicitly, and every schema-changing one (`migrate dev`, `migrate deploy`,
  `migrate reset`, `db push`) first runs `scripts/assert-v2-database.mjs`,
  which refuses a database that carries V1 migration history.
- The test global setup and the production container do the same.

Do not edit `schema.prisma` or `migrations/` here on the V2 branch: they stay
identical to `main` so that V1 history is preserved and merges from `main`
apply cleanly.

# `prisma-v1-archive/` — frozen V1 reference (read-only)

The V1 single-store schema (`schema.prisma`) and its migration history
(`migrations/`), byte-identical to `main` as of the V2 fork. Kept so the V1
history is never lost; nothing in this codebase generates, migrates or deploys
from here, and the production image does not contain it.

- V1 production keeps running from `main` until the V1-to-V2 cutover.
- `scripts/assert-v2-database.mjs` reads the migration names here (on top of
  its built-in list) to recognise — and refuse — a V1 database.

The active V2 schema and migrations live in [`../prisma/`](../prisma).

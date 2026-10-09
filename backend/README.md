# AdiOne — Backend API

> The **sole authority** for price, discount, total, stock, COD eligibility and
> serviceability. No client is ever trusted with any of these.

Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Socket.IO

- **Technical documentation:** [../docs/03-backend-technical.md](../docs/03-backend-technical.md)
- **API reference:** [../docs/04-api-reference.md](../docs/04-api-reference.md)
- **Deployment:** [../docs/06-deployment.md](../docs/06-deployment.md)

---

## What this service does

It backs two clients — the customer mobile app and the store admin panel — with
one versioned REST API under `/api/v1`, plus a Socket.IO channel for live order
status. It owns:

| Area | Responsibility |
|---|---|
| Auth | OTP login, email + password login/signup, JWT access + rotating refresh tokens |
| Catalogue | Categories, products, variants, per-store pricing and stock, search |
| Cart | Server-held cart, revalidated on every read against live price and stock |
| Pricing | The only place a bill is computed — subtotal, discounts, delivery fee, platform fee, tax, total |
| Serviceability | Distance from the store, delivery radius, ETA, delivery fee band |
| Orders | Order placement in a transaction, the order state machine, cancellation |
| Payments | Cashfree / UPI intent / mock behind one port, webhooks, manual verification, refunds |
| Inventory | Stock ledger, reservations, low-stock reporting |
| Delivery | Agents, assignment, delivery OTP, cash settlement |
| Notifications | Push + in-app, one row per notification |
| Configuration | Every business rule, stored in the database and editable by the store owner |

---

## Requirements

- **Node.js ≥ 20**
- **PostgreSQL ≥ 14**
- Redis — **optional**. `REDIS=false` falls back to an in-process `node-cache`
  driver, so nothing but Postgres is needed for local development.

---

## Quick start

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
#   edit .env — at minimum DATABASE_URL, JWT_SECRET, OTP_PEPPER

npm run db:migrate            # create the schema
npm run db:seed               # reference data + admin user + demo catalogue
npm run dev                   # http://localhost:4000
```

Verify:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/health/ready
curl http://localhost:4000/api/v1/config/public
```

The seed creates the first store-owner login from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`. **Change that password immediately after first login.**

With `OTP_PROVIDER=console` the OTP is printed to the server log *and* returned
as `devOtp` in the `POST /auth/send-otp` response, so you can log in without an
SMS provider. Both are blocked in production.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch src/server.ts` — reload on change |
| `npm run build` | `tsc` + `tsc-alias` → `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Vitest — unit, integration and e2e |
| `npm run test:watch` | Vitest in watch mode |
| `npm run db:migrate` | `prisma migrate dev` on the V2 schema (`prisma/`) — create/apply a migration |
| `npm run db:migrate:deploy` | `prisma migrate deploy` on the **V2** schema — apply migrations in CI/production |
| `npm run db:seed` | Seed reference data, admin user and demo catalogue |
| `npm run db:reset` | Drop, re-migrate and re-seed (destructive) |
| `npm run db:studio` | Prisma Studio |
| `npm run sync:shared` | Copy `src/shared/` into `web/` and `mobile/` |
| `npm run sync:shared -- --check` | Fail if either copy is stale (CI guard) |

**Schema and migrations.** `prisma/schema.prisma` and `prisma/migrations/` are
the V2 schema and its migration history — the only active ones (`package.json`
→ `"prisma": { "schema": … }`, plus an explicit `--schema` on every script).
The V1 schema and history are archived, read-only, in `prisma-v1-archive/` and
are never generated or applied (see `prisma/README.md`).
The `:v2` variants (`db:migrate:v2`, `db:migrate:deploy:v2`, `db:push:v2`,
`db:generate:v2`, `db:studio:v2`, `db:seed:v2`, `dev:v2`) read only
`backend/.env.v2`. Every schema-changing script — and the test setup and the
production container — first runs `scripts/assert-v2-database.mjs`, which
refuses a database that carries V1 migration history; the seed and report
scripts run it too, and the API itself refuses to start against a V1 or
unmigrated database (`src/infra/db/database-identity.ts`). The test database
(`.env.test`, must end in `_test`) is migrated from `prisma/migrations/`.

---

## Environment

`.env.example` is the annotated source of truth. The process **refuses to
start** if a required variable is missing or malformed, and prints exactly
which keys are wrong — a server that boots with an undefined `JWT_SECRET` is
worse than one that does not boot.

The essentials:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Must be a `postgres…` connection string |
| `JWT_SECRET` | ≥ 32 characters |
| `OTP_PEPPER` | ≥ 32 characters; peppers the OTP hash |
| `REDIS` / `REDIS_URL` | `false` uses the in-process cache; `true` requires a URL |
| `CORS_ORIGINS` | Comma-separated allow-list. The mobile app sends no `Origin`, so it is unaffected |
| `OTP_PROVIDER` | `console` (dev) \| `msg91` |
| `PAYMENT_PROVIDER` | `mock` (dev) \| `upi_intent` \| `cashfree` |
| `STORAGE_PROVIDER` | `local` (dev) \| `s3` |
| `NOTIFICATION_PROVIDER` | `console` (dev) \| `fcm` |

### Production guards

`NODE_ENV=production` rejects every development stub outright:

- `OTP_PROVIDER=console` — prints OTPs to the log
- `PAYMENT_PROVIDER=mock` — takes no real money
- `STORAGE_PROVIDER=local` — not durable
- `REDIS=false` — unless `ALLOW_MEMORY_CACHE_IN_PRODUCTION=true` is set
  deliberately for a single-instance deployment
- `JWT_SECRET` / `OTP_PEPPER` still holding their example values

### Test guard

`NODE_ENV=test` loads **only** `.env.test`, and refuses to run unless
`DATABASE_URL` names a database ending in `_test`. The suite truncates every
table, so this guard is the difference between a failed test and a destroyed
development database.

---

## Layout

```
src/
├── app.ts                 Express assembly — middleware order is load-bearing
├── server.ts              Boot, realtime, jobs, graceful shutdown
├── config/env.ts          Fail-fast environment validation
├── common/                Errors, logger, response envelope, request context, crypto
├── middleware/            auth · validate · idempotency · rateLimit · requestLogger · errorHandler
├── infra/                 Ports + adapters: db · cache · otp · payment · storage · search
├── modules/               One folder per domain (routes → controller → service → repository)
├── realtime/socket.ts     Socket.IO rooms and emitters
├── jobs/                  In-process scheduler (reservation release, payment reconciliation)
├── routes/index.ts        The /api/v1 route table
└── shared/                THE CANONICAL CONTRACT — mirrored into both clients
```

`prisma/` holds the schema, migrations and seed. `tests/` holds unit,
integration and end-to-end suites.

---

## The shared contract

`src/shared/` is canonical. It holds the domain enums, error codes, wire DTOs,
the order state machine, permissions, the config registry and pure business
helpers (money, distance, COD resolution, dates, phone, text, theme). Everything
in it is dependency-free and platform-neutral, so the same file runs under Node,
in a browser and under Hermes.

After changing anything there:

```bash
npm run sync:shared
```

This copies the folder into `web/src/shared/` and `mobile/src/shared/`, both of
which carry a generated banner and must not be edited by hand.

---

## Non-negotiable rules

1. **The server decides.** Price, discount, total, stock, COD eligibility and
   serviceability are never accepted from a client. `expectedTotalPaise` on
   order creation is a *safety check* that triggers `PRICE_CHANGED`, never the
   charged amount.
2. **No hardcoded business rules.** Radius, fees, hours, COD policy, ETA
   parameters and limits live in the `configurations` table.
3. **Money is integer paise** (`Int`). Never floats. Field names end in
   `Paise`.
4. **Only `transitionOrder()` writes `orders.status`**, validating against the
   state machine and recording history.
5. **Order creation, payment confirmation and stock movement run in database
   transactions** with row-level locking. Third-party calls never happen inside
   a transaction.
6. **Idempotency keys** guard order placement and payment creation.
7. **Every external provider sits behind a port.** No SDK is imported outside
   `src/infra/`.
8. **Secrets come only from the environment.**

---

## Testing

```bash
npm test
```

Requires a database whose name ends in `_test` and a `.env.test` file. The
suite covers the shared helpers (unit), auth / store / order / payment
(integration, via supertest) and the full order lifecycle (e2e).

---

## Docker

```bash
# From the repository root
docker compose up -d          # Postgres :5433, Redis :6379, MinIO :9000/:9001
```

Postgres is mapped to **5433** so it does not collide with a natively installed
instance on 5432. Point `DATABASE_URL` at 5433 and set `REDIS=true` to use it.

The service image is built from `Dockerfile` in this folder; see
[../docs/06-deployment.md](../docs/06-deployment.md).

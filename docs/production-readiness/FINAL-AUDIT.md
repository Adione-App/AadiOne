# Aadione — Production Readiness Audit (V2)

**Date:** 2026-10-21 · **Code audited:** `main` @ `bcd17a5` + the uncommitted audit changes listed in §20
**Scope:** backend (Express 5 / Prisma / PostgreSQL on Supabase), customer mobile app (Expo SDK 54), web admin/seller panel (Vite + React)

> This report does not claim that Aadione is "secure" or "crash-proof". It records what was tested, how, and what is still open.

---

## 0. Verdict

> **Updated 2026-10-21 (afternoon) after read-only production verification. See §21–§24.** Production is `bcd17a5`, healthy, on Redis, `NODE_ENV=production`.
>
> | Blocker | Before | Now |
> |---|---|---|
> | B1 security migration | "P0, prod exposure unknown" | **Re-rated P2 (hardening).** Production `anon`/`authenticated` have **no** SELECT/INSERT/UPDATE/DELETE on any table today, but RLS is off on all 50 tables and the Data API (PostgREST) is live. Migration refined, replica-tested and backed up. **Waiting for approval to apply.** |
> | B2 accounts migration | "probably not on prod" | **RESOLVED.** Applied 2026-10-18 11:33 UTC; checksum matches git; indexes present. |
> | B3 payments config | unverified | **PARTIAL.** `NODE_ENV=production` is proven, and the boot guard then forces Cashfree **live** mode. Key validity and the dashboard webhook URL are unverifiable without a real payment or the Cashfree dashboard. |
> | B4 crash reporting on device | not tested | **OPEN.** Needs a release build on a phone. |
>
> **Decision now: NO-GO to deploy the uncommitted audit changes until they are committed, reviewed and smoke-tested (§24). Production as it runs today has no open P0.** Applying the security migration is low-risk and independent of the code, and needs only the owner's approval (§23). A new **P1** surfaced: production Home takes 3.4–5.9 s (§21.6).
>
> The original verdict follows, kept for the record.

**(Original) NO-GO for a production release of these changes until the blockers in §19 are closed. After that: CONDITIONAL GO.**

The code is in good shape for a launch at the current scale (a handful of sellers in one area). Payments, orders, stock, refunds and settlements are idempotent and race-safe in every scenario tested. This audit found and fixed four real concurrency defects:
- double payment initiation;
- coupon over-use;
- the first cart write failing with a 409;
- storage calls that could hang forever.

It also fixed one database exposure (Supabase Data API).

The release is held back by **production state that this audit could not verify or change without approval**:

| # | Blocker | Why it blocks |
|---|---------|---------------|
| B1 | RLS lock-down migration `20261021120000` not applied to production | Fixes **P0-1**. If the production project still has default Supabase grants, anyone with the public anon key can read and write every table through the Data API. |
| B2 | Migration `20261018120000` (separate customer/seller accounts) may not be on production, although its code (`bcd17a5`) is already on `aadione/main`, which Railway deploys | Without it, a seller who never shopped cannot sign in to the customer app, and an existing customer cannot sign up as a seller (both get 409). No data is damaged. |
| B3 | Payment environment on Railway not re-verified (live Cashfree keys, live webhook URL and secret) | On 2026-10-17 production was still on the Cashfree **sandbox**. Real money cannot be collected until live keys are set. |
| B4 | Crash reporting verified only in tests and the JS bundle, not on a real device. Native crashes are not covered. | A crash in production would otherwise be invisible. |

---

## 1. Environment and method

| Item | Value |
|------|-------|
| Test database | Disposable local PostgreSQL 18 cluster on `localhost:55432` (`adione_test`, truncated per test). A second throwaway DB, `adione_load_test`, was used for load tests and **dropped afterwards**. |
| Production database | **Not touched.** No reads, writes or migrations. Production checks below are marked BLOCKED. |
| Payments | Mock provider and an in-memory Cashfree double (`tests/helpers`). **No real payment, payout or Cashfree sandbox call** was made. |
| OTP / SMS | Console provider (no SMS sent). |
| Load generator | `autocannon` 7.15.0 on the same laptop (12 logical CPUs) as the server and DB. **Local only.** No load reached production, Railway, Supabase or Cashfree. |
| Proof of fixes | Each fixed defect has a test that **fails on `HEAD` (`bcd17a5`) and passes with the fix**. Each one was run in a clean `git archive HEAD` copy. |

---

## 2. Baseline (Phase A)

- **Security headers and CORS:** helmet headers and a CORS allow-list are in place. Production runs `NODE_ENV=production` (checked earlier in this session).
- **Rate limits:**
  - per-IP API limit of 120 requests/min; authenticated users 300/min;
  - OTP: 3/hour per number and 10/hour per IP;
  - orders: 10/hour per user;
  - payment actions: 60/min per user.
- **Liveness and readiness:** `/health/live` and `/health/ready` (DB + cache) exist. The Docker `HEALTHCHECK` uses `/health/ready`. **The Railway health-check setting is not in the repository** (NOT VERIFIED).
- **Graceful shutdown:** present.
- **Secrets:** no secrets are committed (`git grep` for keys and URLs).
- **Dependency audit:**
  - backend: `npm audit` clean;
  - web: 2 moderate;
  - mobile: 33, almost all in Expo/Metro build tooling, with no safe automatic fix. Plan an Expo SDK patch update.

## 3. Safety plan (Phase B) — rules followed

- No production DB access, deploy, push, commit, migration or setting change.
- No real accounts, payments, payouts or orders. All test data is synthetic.
- No authentication, RLS, webhook signature or rate limit was disabled. Where a load test needed many simulated users, distinct `X-Forwarded-For` addresses were used locally. This is valid only because the app trusts exactly one proxy hop, as Railway provides.
- No test was weakened or skipped. One obsolete scratch-harness test, for the "Sell on Aadione" screen removed in `bcd17a5`, was retired outside the repository.

---

## 4. Findings

| ID | Sev | Area | Finding | Status |
|----|-----|------|---------|--------|
| P0-1 | **P0** | Database | All `public` tables had RLS disabled and kept Supabase's default `anon`/`authenticated` grants. On a Supabase project, the anon key (public by design) would then give read/write access to every table through the Data API. Reproduced on a scratch DB: `anon` read `users`; `authenticated` updated `users`. | **FIXED in code** (migration `20261021120000`). **Production apply pending (B1).** **Re-rated P2 after the production read (§21.3):** production grants anon/authenticated only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, none of which PostgREST can use, so there is no data exposure today. RLS is off on all 50 tables. |
| P1-1 | **P1** | Payments | Two simultaneous "Pay" taps (or two devices) on one order opened **two payable Cashfree orders**, so the customer could be charged twice. On `HEAD`, 3 concurrent requests created 3 Cashfree orders. | **FIXED + TESTED** |
| P1-2 | **P1** | Coupons | A coupon's total use limit was checked outside the order transaction, so simultaneous checkouts overspent it. On `HEAD`, 4 of 4 shoppers used a "1 use" coupon. | **FIXED + TESTED** |
| P1-3 | **P1** | Accounts | Separate customer/seller accounts code is deployed. If its migration is not, some sign-ins and seller sign-ups fail with 409. | **RESOLVED**: applied on production 2026-10-18 11:33:25 UTC (§21.2). |
| P1-4 | **P1** | Observability | The mobile app had **no crash reporting**. A render error showed a blank screen and nobody was told. | **FIXED (interim, JS-level)**. Native crashes and Sentry: BLOCKED (B4). |
| P2-1 | P2 | Cart | Two simultaneous first cart requests for a new customer: the loser got **409 "This already exists."** Found by the load test (P2002 in the server log). On `HEAD`: `[409, 200]`. | **FIXED + TESTED** |
| P2-2 | P2 | Resilience | The S3 / private-document storage `fetch` calls had **no timeout**. A stalled storage endpoint would hang uploads and document views indefinitely. | **FIXED** (60 s timeout) |
| P2-3 | P2 | Performance | `GET /home` is the slowest endpoint: about 113 requests/s locally with a 174 ms median at 20 connections, against 370–900 requests/s for other catalogue reads. It rebuilds an identical, customer-independent feed on every request with about 12 sequential queries. It is the first screen of every session. | **OPEN, re-rated P1 (§21.6):** in production, Home takes 3.4–5.9 s server time because Railway (Singapore) and Supabase (Mumbai) are in different regions. Recommendation only: the cache is a product decision (§14). |
| P2-4 | P2 | Ops | Production ran `NODE_ENV=development` with Cashfree sandbox on 2026-10-17. `NODE_ENV` is now production; the Cashfree mode was not re-checked. | **PARTIAL (§21.4):** `NODE_ENV=production` is proven from the outside; the boot guard then forces Cashfree live mode. Key validity and the webhook URL are not verifiable read-only. |
| P2-5 | P2 | Ops | Railway `healthcheckPath` is **null**. Railway ignores the Dockerfile `HEALTHCHECK`, so a deploy that boots but cannot reach the DB or Redis still replaces the working one. | OPEN: set the Railway health check to `/health/ready` (a settings change; needs approval) |
| P3-1 | P3 | Cart | Two simultaneous "+1" taps on the **same** item can merge into +1 (last write wins). The quantity is never wrong in a harmful direction, and stock and limits are re-checked at checkout. | Accepted |
| P3-2 | P3 | Tests | 4 pre-existing type errors in test files not touched by this audit (`admin-content`, `home-feed`, `image-optimizer`: `sharp` namespace and possibly-undefined fields). They do not affect runtime. | OPEN |
| P3-3 | P3 | Dependencies | Web: 2 moderate advisories. Mobile: 33 (build tooling). | OPEN — schedule an Expo patch update |

---

## 5. Payments (Phase C)

### 5.1 Duplicate-prevention evidence

| Scenario | Protection | Evidence | Status |
|----------|-----------|----------|--------|
| Double tap / two devices on "Pay" | **New:** per-order single-flight lock (`CacheKey.paymentInit`, Redis in production). The second request waits, then reuses the first checkout session. The lock is released only by its owner (token compare). If the lock times out, the request fails safely with a "try again" message. The lock is never held across a DB transaction. | `cashfree-payment.test.ts` › "simultaneous Pay requests … open ONE Cashfree order": 3 concurrent → 1 provider order, 1 session, 1 payment row. **Fails on `HEAD` (3 orders).** | **PASS** |
| Order placed twice (retry, double tap) | `Idempotency-Key` per checkout | existing order tests | PASS |
| Webhook replayed or out of order | Status updates are conditional (`updateMany … WHERE status IN (CREATED, PENDING)`); the order row is locked `FOR UPDATE`; an already-PAID order returns early | `payment.test.ts`, `payment-security.test.ts`, `cashfree-payment.test.ts` | PASS |
| Verify call and webhook arriving together | The same conditional transitions; whichever arrives second is a no-op | `cashfree-payment.test.ts` | PASS |
| Customer charged twice anyway (two captures) | Duplicate capture is detected and **auto-refunded** | `cashfree-payment.test.ts` | PASS |
| Uncertain outcome (timeout, app killed) | Payment stays `PENDING`; `/payments/:orderId/refresh` and the webhook reconcile it against the provider; the app shows a pending state and never re-charges blindly | Code review of `payment.service.ts` (refresh/reconcile) and webhook tests | PASS (code review). Real device: NOT TESTED. |
| Webhook authenticity | HMAC signature verified; public route; never disabled in tests | `payment-security.test.ts` | PASS |
| Refund requested twice at once | Conditional refund transitions; ambiguous refunds held for review | `payment.test.ts`, `final-order-refund.test.ts` | PASS |

### 5.2 State transitions (from code)

**Payment row** (`PaymentStatus`):

| From → To | Trigger | Guard |
|-----------|---------|-------|
| — → `CREATED` | checkout session opened | single-flight lock (new) |
| `CREATED`/`PENDING` → `PENDING` | provider reports pending | `updateMany WHERE status IN (CREATED, PENDING)` |
| `CREATED`/`PENDING` → `CAPTURED` | verified webhook / verify / refresh | order row `FOR UPDATE`; no-op if order already PAID |
| `CREATED`/`PENDING` → `FAILED` | provider failure / expiry | `updateMany WHERE status IN (CREATED, PENDING)` |
| `CAPTURED` → `REFUNDED` | refund completed | inside refund transaction |
| — → `CAPTURED` (manual UPI) | admin confirms UTR | order row `FOR UPDATE`; refused unless `PENDING_PAYMENT` |

**Order** (`src/shared/order-state-machine.ts`, `ALLOWED_TRANSITIONS`):
- `PENDING_PAYMENT` → `PAYMENT_CONFIRMED` | `PAYMENT_FAILED` | `CANCELLED`
- `PAYMENT_CONFIRMED` → `PROCESSING`
- `PROCESSING` → `READY_FOR_PICKUP` | `PARTIALLY_CANCELLED` | `CANCELLED`
- `PARTIALLY_CANCELLED` → `READY_FOR_PICKUP` | `CANCELLED`
- `READY_FOR_PICKUP` → `PICKED_UP` → `OUT_FOR_DELIVERY` → `DELIVERED`
- `REFUNDED` is reachable only once the money is actually back.
- Every change goes through `canTransition`; anything else is refused.

---

## 6. Orders, inventory, coupons, refunds, settlements (Phase D)

| Invariant | Evidence | Status |
|-----------|----------|--------|
| Stock never oversold | Load test C: **300 simultaneous COD checkouts for 20 units → exactly 20 orders, 280 clean `ITEM_OUT_OF_STOCK`, 0 errors**. DB afterwards: stock 0, 20 units ordered, 0 listings negative or over-reserved. Also an existing last-unit race test. | **PASS** |
| Coupon total and per-user limits hold | **New:** atomic claim `UPDATE coupons … WHERE used_count < usage_limit_total RETURNING …` inside the order transaction (row lock serialises checkouts), then the per-user count. `coupon-concurrency.test.ts`: limit 1 → exactly 1, limit 2 → exactly 2. **Both fail on `HEAD`.** | **PASS** |
| One live cart per customer | Partial unique index plus **new** conflict handling. `cart-concurrency.test.ts` (fails on `HEAD`). | **PASS** |
| Refunds never exceed the amount paid; no double refund | `payment.test.ts`, `final-order-refund.test.ts` | PASS |
| Settlements are idempotent | `seller-settlement.test.ts`, `coupon-settlement.test.ts` | PASS |
| Notifications never break an order | Queued, de-duplicated, failures caught | PASS |

## 7. Authentication and authorization (Phase E)

| Check | Evidence | Status |
|-------|----------|--------|
| Every private router authenticates | Static sweep. Cart, addresses, orders, notifications, referrals: router-wide `authenticate`. Payments: all routes except the signed webhook. Admin: `authenticate + requireAdmin`. Seller: `authenticate + requireSellerOrAdmin + lifecycle gate`. | PASS |
| Ownership (IDOR): a customer or seller cannot read or change another's data | Cross-owner cases in 18 integration files (orders, payments, addresses, seller catalogue, settlements…) plus unit tests `order-visibility`, `seller-catalog-access` | PASS |
| An SMS OTP never opens the Seller/Admin panel | `customer-session-scope.test.ts`, `customer-app-staff-accounts.test.ts` | PASS |
| JWT: HS256 pinned (no `alg: none`), issuer and audience checked, 15-minute access tokens, refresh rotation with reuse detection | `token.service.ts`, `auth.test.ts` | PASS |
| OTP brute force | 3/hour per number, 10/hour per IP, max attempts per code | PASS (tests). **Limits are in-process unless `REDIS` is set**, so with more than one instance they are per instance. Confirm Redis on Railway. |

## 8. PostgreSQL / RLS (Phase F)

| Role | Before fix (scratch DB) | After migration `20261021120000` |
|------|------------------------|-------------------------------|
| `anon` | could `SELECT` `users` | `permission denied` on every table, including tables created later |
| `authenticated` | could `UPDATE` `users` | `permission denied` |
| table owner (backend) | full access | full access (the owner bypasses RLS). `database-security.test.ts`: create/delete works. |

The migration:
- enables RLS (no policies) on every `public` table;
- revokes table, sequence and function grants from `anon`/`authenticated`;
- revokes Supabase's **default privileges**, so future tables are not exposed.

It is idempotent and skips roles that don't exist. `database-security.test.ts` now fails if a new table is added without RLS.

**Production: BLOCKED.** To check without changing anything, run this in the Supabase SQL editor (read-only):

```sql
select c.relname, c.relrowsecurity,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by 1;
```

The Supabase **Security Advisor** shows the same.

## 9. Network and offline (Phase G)

Mobile API client (`mobile/src/lib/api.ts`):
- request timeouts;
- GET retries with exponential backoff and jitter;
- **mutations are never retried automatically**; idempotency keys are sent on order creation;
- `429 retryAfter` is honoured;
- the session-expiry hook;
- the React Query cache persisted for offline display.

Status: **PASS by code review and the scratch harness**. Real-device airplane-mode testing: NOT TESTED.

## 10. Dependency outages (Phase H)

| Dependency down | Behaviour | Status |
|-----------------|-----------|--------|
| PostgreSQL | `/health/ready` reports `database: down`; requests fail with 5xx, no partial writes (transactions) | PASS (code) |
| Redis/cache | Payment lock: falls back to running unlocked with a warning (availability over strictness; DB guards still prevent double capture) | PASS (code) |
| Cashfree | Payment creation errors are surfaced; order stays `PENDING_PAYMENT`; reconcile later | PASS (code review) |
| S3 / storage | **New:** 60 s timeout on every call | PASS (code) |
| FCM push | Already had a timeout; failures caught | PASS |

## 11. Database concurrency (Phase I)

Covered in §5–§6: payment initiation, coupon claim, cart creation, last-unit stock, webhook/verify races, refunds and settlements. All PASS with tests. The order transaction does no network I/O (enforced by `runInTransaction`).

## 12. Crash reporting

**Sentry was evaluated** and is the recommended long-term solution: native crashes, release health and source maps. It needs an account, a DSN and a native rebuild, so it is **BLOCKED** on those.

**Implemented now (dependency-free, interim):**

1. **`AppErrorBoundary`** around the whole app. A render error shows "Something went wrong / Try again" instead of a blank app.
2. **Global JS error handler** (`ErrorUtils`), chained so React Native's own behaviour is unchanged.
3. **Unhandled promise rejections** (Hermes tracker, release builds).
4. Reports go to **`POST /api/v1/client-errors`**: public, strict schema, server-side redaction of emails, phone numbers, bearer tokens, JWTs and long tokens, 30/hour per IP, **log-only** (`module: client-errors`, level `error`).
   - Each report carries the app version, build, platform, screen and the last API `X-Request-Id`, so it can be matched to server logs.
   - The client sends at most 10 reports per session, never retries, never throws, and times out after 5 s.

| Verification | Result |
|--------------|--------|
| Backend `client-errors.test.ts` (accept, redaction, validation, rate limit) | 4/4 PASS |
| Mobile harness `crash.test.tsx`: boundary shows recovery and recovers; report fields; request-id; global handler chains; rejection tracker; 10-report cap; offline never throws; oversize cut | 6/6 PASS |
| Existing mobile harness (54 tests, including the real `App.tsx` update flow) | 54/54 PASS |
| Mobile `tsc --noEmit` | PASS |
| `expo export --platform android` (3,559 modules) contains the boundary and the reporter | PASS |
| Real device, release build | **NOT TESTED (B4)** |
| Native (Java/Kotlin) crashes | **NOT COVERED**: needs Sentry or a similar native SDK |

## 13. Observability

- **Already in place:**
  - structured JSON logs (pino) with a request id on every response (`X-Request-Id`);
  - module loggers; Prisma errors mapped and logged;
  - rate-limit warnings; health endpoints.
- **New:** app crash reports in the same logs; the mobile app now records the last request id.
- **Missing (recommendation):**
  - alerting on 5xx rate and `client-errors` volume;
  - an uptime monitor on `/health/ready`;
  - log retention beyond the Railway default.

## 14. Load and stress (local only)

Local backend (`NODE_ENV=test` config, in-process cache, local DB, logging at `warn`) on one Node process, with the load generator on the same machine. Production adds network latency to Supabase (Mumbai) and uses Redis, so treat these as **relative** numbers, not production capacity.

**A — public browsing mix** (home 25%, categories, product lists, search, stores; 20 s each):

| Connections | req/s | p50 | p90 | p99 | errors |
|---|---|---|---|---|---|
| 10 | 192 | 34 ms | 118 ms | 170 ms | 0 |
| 50 | 213 | 159 ms | 491 ms | 604 ms | 0 |
| 100 | 224 | 310 ms | 947 ms | 1,092 ms | 0 |
| 200 | 223 | 611 ms | 1,843 ms | 2,142 ms | 0 |

**B — signed-in mix** (cart reads 45%, order list 30%, add to cart 25%; 300 users; 15 s each):

| Connections | req/s | p50 | p99 | non-2xx |
|---|---|---|---|---|
| 10 | 264 | 29 ms | 95 ms | 1 (→ P2-1, fixed) |
| 50 | 250 | 159 ms | 458 ms | 0 |
| 100 | 242 | 322 ms | 837 ms | 0 |

**Per endpoint** (20 connections): `/health/live` 3,957/s · categories 897/s · stores 453/s · store 417/s · products 368/s · search 231/s · **home 113/s**.

**C — checkout race:** 300 simultaneous COD orders for 20 units. All finished in 3.9 s (p99 3.9 s, single hot stock row). Exactly 20 placed, 280 refused cleanly, no errors.

**D — rate limit:** 130 requests from one IP → 120 × 200, 10 × 429. PASS.

**Reading:**
- One instance saturates at about 220–260 requests/s on this machine. Beyond that, latency grows in a straight line with load and there are **no errors or timeouts up to 200 concurrent connections**, so it degrades gracefully.
- The biggest win available is `/home` (P2-3). A 30–60 s shared cache, with invalidation on banner, category and config changes, would remove about a quarter of all browsing load. It is left as a product decision because it delays stock and open/closed changes on Home by up to the cache lifetime.
- **Production-side checks NOT DONE:**
  - Prisma `connection_limit` vs the Supabase pooler limit (the session pooler caps at 15 clients; use the transaction pooler, port 6543);
  - Railway instance size;
  - a staging load test (needs a staging environment and approval).

## 15. Security tests

| Test | Status |
|------|--------|
| Data API exposure (anon/authenticated) | FIXED in code (§8); production BLOCKED |
| Webhook forgery (bad or missing signature) | PASS (`payment-security.test.ts`) |
| Admin "mark paid" bypass, capture-vs-cancel, ambiguous refunds (from the 2026-10-15 audit) | PASS (tests in suite) |
| JWT `alg: none` / wrong audience / expired | PASS |
| Crash-report endpoint abuse (unknown fields, HTML in screen names, oversize, flood) | PASS (`client-errors.test.ts`) |
| Private seller documents (no public URLs, PDF magic bytes, size limit) | PASS (existing tests) |
| Secrets in repo or logs | PASS (no secrets committed; OTP/phone masked in logs; crash reports redacted) |
| Dependency advisories | Backend clean; web 2 moderate; mobile 33 tooling (P3-3) |
| External penetration test | NOT DONE (recommended before scaling) |

## 16. End-to-end

- **Covered stage by stage across the backend integration suite** (real HTTP through Express to the real DB; not one single scripted journey):
  - OTP sign-in, address, cart, checkout (COD and the Cashfree double), webhook;
  - seller order handling, delivery states, settlement;
  - cancellation and refund paths.
- **Scratch mobile harness:** real screens and hooks against a fake API.
- **Device E2E** (Detox/Maestro on a real phone): **NOT DONE**.

## 17. Quality gates

| Gate | Result |
|------|--------|
| Backend full test suite | PASS: 1,036 passed, 0 failed (§17.1) |
| Backend `tsc` (src) | PASS |
| Backend `tsc` (tests) | 4 pre-existing errors in untouched files (P3-2); 0 in files changed by this audit |
| Web `tsc` | PASS |
| Web production build | PASS |
| Mobile `tsc` | PASS |
| Mobile bundle (`expo export`, Android) | PASS |
| ESLint on every file changed in this audit | PASS (0 problems) |
| New tests fail on `HEAD`, pass with fixes | PASS (payment init, coupon ×2, cart add) |

### 17.1 Suite and build results

- **Backend suite (`vitest run`, full, with all audit changes):**
  - **89 files, 1,036 passed, 0 failed, 1 skipped**, in 1,108 s;
  - the skip is the opt-in image-throughput perf test (`RUN_PERF_TESTS`), skipped by design before this audit.
- **Web `vite build`:** PASS (16.5 s), with only the usual large-chunk size warning. It was built to a scratch folder, so the repository was not touched.
- **Mobile scratch harness:** 60/60 (54 existing + 6 new crash-handling tests).

## 18. Test-data cleanup

| Item | Result |
|------|--------|
| Production data | Never touched; nothing to clean |
| Load-test DB `adione_load_test` (synthetic store, 61 products, 300 customers, 20 orders) | **Dropped**. Only `adione_test` remains on the local cluster. |
| Minted load-test sessions (`data.json`) | **Deleted** |
| Scratch RLS DB and roles | Dropped (earlier in the audit) |
| `HEAD` comparison copies | Removed (node_modules junction unlinked first) |
| Local load server (port 4100) | Stopped; process tree killed; port free |
| Local test PostgreSQL (55432) | Stopped at the end of the audit |
| Temporary files in the repository | None (one temporary helper in `backend/` was removed right after use) |

## 19. Remaining blockers — production steps that need approval

In this order, each needing the owner's explicit go-ahead:

1. **Back up production** and verify the backup (`npm run db:verify-backup`).
2. **Check migration status** on V2: `node scripts/with-env.mjs .env.v2 npx prisma migrate status --schema=prisma/schema.prisma`.
3. **Apply** `20261018120000_v2_separate_customer_partner_accounts` (B2) and `20261021120000_v2_lock_down_supabase_data_api` (B1) with `npm run db:migrate:deploy:v2`. Railway never runs migrations.
4. Re-run the RLS query in §8, or the Supabase Security Advisor: expect `relrowsecurity = true` and no anon/authenticated `SELECT`.
5. **Deploy the audit changes** (commit → push to `aadione/main`).
6. **Railway variables:** confirm live Cashfree keys and the live webhook URL/secret (B3), `REDIS` set (shared rate limits and payment lock across instances), and the `DATABASE_URL` transaction pooler with a sane `connection_limit`.
7. **Mobile release build on a real phone** (B4):
   - force a test crash and confirm a `client-errors` log line;
   - pay with a UPI app;
   - check that airplane mode shows cached data.
8. Recommended next: Sentry (native crashes), alerting, a staging environment for load tests, and the `/home` cache decision.

## 20. Changes made by this audit (uncommitted)

**Backend**
- `prisma/migrations/20261021120000_v2_lock_down_supabase_data_api/migration.sql`: RLS on, grants and default privileges revoked (P0-1; refined in §22 with a 5 s lock timeout and an owned-functions-only revoke).
- `src/modules/payments/payment.service.ts`, `src/infra/cache/types.ts`: per-order payment initiation lock (P1-1).
- `src/modules/orders/order.service.ts`: atomic coupon claim (P1-2).
- `src/modules/cart/cart.service.ts`: concurrent cart creation uses the winning cart (P2-1).
- `src/infra/storage/index.ts`, `src/infra/storage/private-documents.ts`: storage timeouts (P2-2).
- `src/modules/client-errors/client-errors.routes.ts`, `src/routes/index.ts`, `src/middleware/rateLimit.ts`: crash-report endpoint (P1-4).
- Tests:
  - new: `database-security.test.ts`, `coupon-concurrency.test.ts`, `cart-concurrency.test.ts`, `client-errors.test.ts`;
  - extended: `cashfree-payment.test.ts`.

**Mobile**
- `src/components/AppErrorBoundary.tsx`, `src/lib/crashReporter.ts` (new).
- `App.tsx`: handlers installed and the root wrapped. 7 substantive lines; the rest is re-indentation.
- `src/lib/api.ts`: exports the base URL and records the last request id.


---

# Part 2 — Release-blocker resolution (2026-10-21, read-only phase)

Everything in Part 2 was obtained **read-only**:
- Prisma `migrate status`;
- `psql` inside `BEGIN READ ONLY … ROLLBACK`;
- `pg_dump`;
- Railway metadata;
- a few public GETs.

**No production write, migration, deploy, push or setting change was made.** Credentials were passed to tools through environment variables and never printed.

## 21. Production evidence

### 21.1 Git and deployment

| Item | Evidence |
|---|---|
| Local branch | `main` @ `bcd17a5`, identical to `origin/main` and `aadione/main` |
| Live deployment | Railway project `secure-energy` / env `production` / service `AadiOne`: commit `bcd17a5`, created 2026-10-18 11:30:09 UTC, status SUCCESS, 1 replica, region `asia-southeast1` (Singapore), Dockerfile build, custom domain `api.adione.in` |
| Railway health check | `healthcheckPath = null` → **P2-5** |
| Uncommitted work | The audit files (§20), plus one change **not made by the audit**: `mobile/src/screens/home/homeEngine.ts`, a single added leading space before `export function offerHeadline` (saved 12:57 local time, no runtime effect). Left untouched and **must not be staged** unless its owner wants it. |

### 21.2 Production database target and migrations

- **Target:**
  - `backend/.env.v2` → Supabase pooler `aws-0-ap-south-1.pooler.supabase.com:5432` (session mode), database `postgres`, `connection_limit=5`.
  - `.env` (V1) is a **different** Supabase project (project refs compared by hash).
  - `with-env.mjs` loads `.env.v2` with `override: true` before Prisma starts, so `migrate status` read V2.
- **Prisma `migrate status`** (V2): 28 migrations in the folder; **only `20261021120000_v2_lock_down_supabase_data_api` is not applied.**
- **`_prisma_migrations`:** 27 rows, 0 unfinished, 0 rolled back, 27 distinct names.
- **Accounts migration** `20261018120000_v2_separate_customer_partner_accounts`:
  - **applied** 2026-10-18 11:33:25 UTC (3 min after the deploy), `applied_steps_count = 1`, no logs;
  - production checksum `2639aeff…488a75` = sha256 of the file in git;
  - the indexes `users_customer_mobile_key`, `users_partner_mobile_key`, `users_mobile_idx`, `users_customer_email_unique` and `users_partner_email_unique` exist.
  - *Why it was needed:* it replaces the global `users_mobile_key` / `users_email_unique` with per-type partial unique indexes (CUSTOMER vs partner). Without it, OTP sign-in for a number that only has a seller account, and seller sign-up for a number that already has a customer account, both fail with 409.

### 21.3 Supabase Data API — actual production state

| Check | Result |
|---|---|
| Who the backend connects as | `postgres`: owner of all 50 `public` tables, `BYPASSRLS` |
| Data API in use by Aadione? | **No.** No Supabase/PostgREST SDK in `mobile`, `web` or `backend`; all clients call the backend. Supabase Storage is used only through its S3 protocol (`storage` schema, untouched). |
| Data API enabled on the project? | **Yes.** PostgREST 14.5 is connected as `authenticator`. |
| RLS | **off on 50/50 tables**; 0 policies |
| `anon`/`authenticated` table privileges | **0 tables** with SELECT/INSERT/UPDATE/DELETE. **50/50** with TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (`Dxtm`, from Supabase's default ACL for `postgres`). PostgREST cannot issue these. |
| Views / materialized views / sequences in `public` | none |
| Functions executable by `anon` | 31 `pg_trgm` functions (owned by `supabase_admin`, harmless) + `products_search_vector_update` (trigger function, not callable through RPC) |
| Default privileges | `postgres` → tables: anon/authenticated/service_role `Dxtm`. `supabase_admin` → full rights for those roles, but **no `public` table is owned by `supabase_admin`**. |
| Legitimate access after the migration | Unaffected: backend = owner + BYPASSRLS; dashboard = `postgres`; service_role = BYPASSRLS and untouched |

**Conclusion:** no exploitable exposure today. The migration is defence-in-depth: if a future table or grant ever gives these roles data privileges, RLS still denies access, and the Supabase Security Advisor's "RLS disabled" errors are cleared. **No RLS policies are needed** because no legitimate client uses the Data API. Public grants must **not** be restored.

### 21.4 Railway, payments, Redis, database connections

`railway variables` failed ("Problem processing request") for the logged-in account, so **no variable values were read**. The evidence below is behavioural plus code guarantees, each labelled as one or the other.

| Item | Evidence | Kind | Status |
|---|---|---|---|
| `NODE_ENV=production` | The live API sends the CSP `default-src 'none'; img-src 'self' data:` and HSTS `max-age=31536000; includeSubDomains`, which `app.ts` emits **only** when `isProduction` | behaviour | **VERIFIED** |
| Cashfree live mode | `env.ts` refuses to start with `NODE_ENV=production` + `PAYMENT_PROVIDER=cashfree` unless `CASHFREE_ENV=production`; `mock` is refused in production | code guard + the above | **INFERRED**: live if the provider is Cashfree. Provider choice and key validity: **NOT VERIFIED** |
| Webhook URL | Not sent per order; configured **account-wide in the Cashfree dashboard**. Must be `https://api.adione.in/api/v1/payments/webhook` | config elsewhere | **NOT VERIFIED** (owner checks the dashboard) |
| Webhook security | HMAC-SHA256 over timestamp + raw body with the secret key; unsigned → rejected (tests) | code + tests | PASS |
| Webhook delivery fallback | `reconcile-payments` job every 5 min (`src/jobs`) settles payments without a webhook | code | PASS |
| Redis | `/health/ready` → `cache: up, cacheDriver: redis`; Redis service running in the project | **connectivity** | **VERIFIED** |
| Database | `/health/ready` → `database: up` (≈0.4 s) | connectivity | VERIFIED |
| DB connections | 6 `postgres` sessions through Supavisor (5 idle backend connections, consistent with `connection_limit=5`); 19 of 60 server connections in use | read-only `pg_stat_activity` | OK. Pooler port (5432 session vs 6543 transaction) on Railway: NOT VERIFIED |
| DB timeouts | `statement_timeout` 2 min, `lock_timeout` 0 (role defaults) | read-only | noted; the migration sets its own 5 s lock timeout |
| Fail-fast validation | `env.ts` refuses to boot in production without Redis (unless explicitly overridden), with console OTP, mock payments, local storage, a missing private document bucket, a non-https image URL, or example secrets | code | PASS |
| Crash reporting | No configuration needed; endpoint redacts and rate-limits (§12). Not yet deployed. | code | pending deploy |

### 21.5 Backup

| Item | Result |
|---|---|
| Newest backup before today | `v2-before-seller-type-home-kitchen-2026-10-16…dump`, older than the accounts migration and 5 days of data. **Not current.** |
| New backup | `C:/Users/mahir/aadione-db-backups/v2-before-data-api-lockdown-2026-10-21T08-04-47Z.dump`: `pg_dump -Fc -n public`, 500,467 bytes, sha256 `f2274f9e…24c6206`, 50 table-data entries |
| Restore drill (`scripts/verify-backup-restore.mjs`, local only) | `RESTORE CHECK OK`, no errors (sellers 8, products 139, users 36, orders 0) |
| Independent comparison | Restored into a separate local DB: **row counts of all 50 tables identical** to live production at dump time |
| Note | Restoring requires `pg_trgm` to exist first (the drill script handles it) |

Production currently holds **0 orders, payments and refunds**, which lowers the blast radius of any migration.

### 21.6 Production latency (3 GETs each, not a load test)

| Endpoint | Time to first byte |
|---|---|
| `/health/live` | 0.30–0.31 s |
| `/health/ready` (1 DB + 1 Redis call) | 0.39–0.45 s |
| **`/api/v1/home`** | **3.4 / 4.9 / 5.9 s** |

Home runs dozens of sequential queries, and each one crosses Singapore (Railway) ↔ Mumbai (Supabase). Locally the same code answers in about 0.17 s. **P1 (user experience), existing behaviour, not caused by the audit changes.**

Options:
- a short shared cache for the customer-independent feed (recommended);
- fewer sequential round trips;
- co-locating the API and the database (Railway has no Mumbai region, so this means moving Supabase or the host).

## 22. Security migration: final SQL review

File: `backend/prisma/migrations/20261021120000_v2_lock_down_supabase_data_api/migration.sql`, sha256 **`c54986bce8f7bddc4292dbffd17ce93a4fe5612c59c8561298af44f2b4dbe33d`** (still **untracked**; not in any commit).

Changes since the audit draft (both found by the production read):
1. `SET LOCAL lock_timeout = '5s'`. Production `lock_timeout` is 0, so without this a busy table would queue all traffic behind the migration. Now it fails and rolls back instead.
2. The function revoke is limited to functions **owned by the backend role and not part of an extension**. `pg_trgm` belongs to `supabase_admin` and is left alone.

What it does, in one transaction:
- `ENABLE ROW LEVEL SECURITY` on every `public` table (no policies, not FORCEd);
- revokes all table, sequence and owned-function privileges from `anon`/`authenticated`;
- revokes the `postgres` default privileges for them.

It does not touch data, `service_role`, other schemas, or Supabase-owned objects.

**Replica test.** Local PostgreSQL rebuilt with production's privilege layout:
- a non-superuser owner with BYPASSRLS;
- `anon`/`authenticated`/`service_role`;
- `pg_trgm` owned by the platform role;
- `Dxtm` default grants;
- all 27 production migrations via `prisma migrate deploy`.

Before state matched production exactly (50 tables, RLS 0, anon TRUNCATE 50, anon SELECT 0).

| Test | Result |
|---|---|
| Apply while another session holds a read lock on `users` | Failed after ≈5 s; **nothing changed** (RLS 0, grants intact); Prisma recorded it as failed |
| Recovery | `prisma migrate resolve --rolled-back 20261021120000_v2_lock_down_supabase_data_api`, then `migrate deploy` → applied; `migrate status` up to date |
| After | RLS 50/50; anon and authenticated hold **no** privilege on any table; `pg_trgm` untouched (31 functions); service_role unchanged |
| Data API roles | `select`, `update` and `truncate` as anon/authenticated → `permission denied` |
| Owner | insert / select / delete on `users` OK |
| Table created later by the owner | anon has no privileges |
| Re-run the SQL | no error (idempotent) |
| Test suite DB recreated with the final file | `database-security.test.ts` + `client-errors.test.ts` 6/6 PASS |

Replica DB and simulated roles were dropped afterwards.

## 23. Controlled migration procedure (awaiting approval)

**Dependency on application code: none.** `schema.prisma` is unchanged vs `HEAD`. The backend does not rely on RLS or grants. The migration can be applied **before, and independently of**, any deploy of the uncommitted audit code.

**Preconditions:**
1. The owner reviews the SQL and its sha256 above.
2. Commit **only** the migration folder (and `tests/integration/database-security.test.ts`) so the applied file is a reviewed git revision. Do **not** push yet. Pushing deploys code: a commit with only these two files changes no runtime behaviour, but push it only together with an approved release.
3. `git status --porcelain backend/prisma` is empty, and `sha256sum` of the file = `c54986bc…dbe33d`.
4. A fresh backup and restore drill immediately before (§21.5 procedure); a quiet period.
5. No long transactions: `select state, max(now()-xact_start) from pg_stat_activity where datname = current_database() group by 1;`

**Commands** (from `backend/`):
```
node scripts/with-env.mjs .env.v2 npx prisma migrate status --schema=prisma/schema.prisma   # expect exactly 1 pending: 20261021120000_…
npm run db:migrate:deploy:v2                                                                  # assert-v2-database + prisma migrate deploy
node scripts/with-env.mjs .env.v2 npx prisma migrate status --schema=prisma/schema.prisma   # expect "Database schema is up to date"
```
Never use `migrate reset`, `db push`, or hand edits to `_prisma_migrations`.

**Verification** (read-only, in the Supabase SQL editor or `psql`):
```sql
select count(*) filter (where c.relrowsecurity) as rls_on, count(*) as tables,
       count(*) filter (where has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as anon_any,
       count(*) filter (where has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as auth_any
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p');      -- expect 50, 50, 0, 0
```
Then `GET https://api.adione.in/health/ready` → `database: up`, and the app smoke checks (§24).

**Expected impact:**
- a brief exclusive lock per table, inside one transaction (milliseconds when idle);
- no data change and no app behaviour change;
- the Supabase Security Advisor "RLS disabled" errors clear.

**If it fails** (lock timeout): nothing has changed. Run `npx prisma migrate resolve --rolled-back 20261021120000_v2_lock_down_supabase_data_api` (via `with-env .env.v2`), then retry when quiet. This was tested on the replica.

**Rollback** (only if a legitimate Data API consumer is discovered, which this audit found none of): a new forward migration that runs `ALTER TABLE … DISABLE ROW LEVEL SECURITY` per table. It must **not** re-grant data privileges. Last resort: restore the §21.5 backup, which loses writes made after the dump.

## 24. Production smoke checklist (after an approved deploy)

Non-destructive and small. Sandbox payments only, unless a live-payment procedure is approved. **No load testing against production.**

| # | Check | Expected |
|---|---|---|
| 1 | `GET /health/ready` | `database: up`, `cache: up`, `cacheDriver: redis` |
| 2 | Customer OTP sign-in with the owner's own test number | signed in; a second sign-in reuses the same account |
| 3 | Same number in the Seller Panel sign-up / sign-in | a separate partner account; the customer account is unaffected; an OTP session never opens the panel |
| 4 | Data API with the public anon key (owner, from the Supabase API docs page) | `GET /rest/v1/users` → permission denied / empty, never rows |
| 5 | Browse Home, a category, search, a store; add 2 items; double-tap "add" on a new account | 200s; one cart; no "already exists" |
| 6 | Checkout COD (owner's test order, then cancel) | one order; stock decremented then restored on cancel |
| 7 | Online payment: double-tap Pay | **one** Cashfree order/session (check the Cashfree dashboard) |
| 8 | Kill the app during payment; reopen | status reconciles (refresh or the 5-min job); no second charge |
| 9 | Webhook | Cashfree dashboard "test webhook" → 2xx; a replay → no duplicate state change |
| 10 | Order status | customer, seller and admin views agree at each step |
| 11 | Crash report: debug-only crash trigger in a release build, or `POST /api/v1/client-errors` with a sample | a `client-errors` log line in Railway, with no PII |
| 12 | Dependency failure (staging only, never production) | covered by tests and code review (§10) |

**Final decision (this phase):** production as it runs today has **no open P0**. The security migration is **ready for approval** (§23). The uncommitted audit code is **NO-GO** until it is committed, reviewed, deployed through the normal path and checked against §24. Open: B3 (Cashfree dashboard and live-key confirmation), B4 (device crash test), P1 Home latency, P2-5 (Railway health check).


## 25. Pre-apply evidence for `20261021120000` (2026-10-21, 08:38 UTC)

**Commits (local, not pushed; `main` is 2 commits ahead of `origin/main` = `aadione/main` = `bcd17a5`):**
- `6ccd43c` fix(security): lock down Supabase Data API access (migration + `database-security.test.ts`);
- `f39eb05` docs(migration): comment-only. The header now states the audited exposure accurately (no data grants were found). The comment-stripped SQL hashes identically before and after (`73b2b04e…`).

**Final migration checksum** (file = committed blob = what Prisma records):
`7c125eebb50b298110c881a5783780fb75f443d8d9908557f4fd37855be688e0`.
This supersedes `c54986bc…` in §22–§23, which was the pre-comment version and was never applied anywhere outside local test databases.

**Local validation:**
- `database-security.test.ts` 2/2;
- fresh `prisma migrate deploy` of all 28 migrations → up to date, RLS 50/50, recorded checksum `7c125eeb…`;
- re-running the SQL exits 0.

**Backup:**

| Item | Value |
|---|---|
| Target | Supabase pooler `aws-0-ap-south-1…:5432`, db `postgres`, V2 project (ref hash `62689ffd`; V1 is `630f058c`) |
| File | `C:/Users/mahir/aadione-db-backups/v2-before-data-api-lockdown-2026-10-21T08-38-29Z.dump` |
| Format / size | `pg_dump -Fc -n public`, 500,467 bytes, 50 table-data entries |
| sha256 | `3a926ba443c601901f7c4bb19f636d86adad49ae22071459e52b8f1b022183ee` |
| Restore drill (`verify-backup-restore.mjs`) | `RESTORE CHECK OK`, no errors |
| Independent restore (`pg_trgm` created first) | Columns 647 and indexes 170: identical hashes. Constraints excluding PG18 NOT-NULL rows 171: identical hash. Triggers 1 = 1. Migration history 27 = 27. **All 50 table row counts identical** to live production (users 36, sellers 8, products 139, orders 0, payments 0). |
| Note | The local server is PostgreSQL 18 and production is 17.6. PG18 stores NOT NULL as constraint rows, which explains the raw 606 vs 171. |

**Production preflight (read-only):**
- `prisma migrate status` (V2): 28 found; **only `20261021120000_v2_lock_down_supabase_data_api` is not applied**.
- `_prisma_migrations`: 27 rows / 27 distinct, 0 unfinished, 0 rolled back, 0 with logs, 0 rows for `20261021…`.
- `20261018120000_v2_separate_customer_partner_accounts`: finished 2026-10-18 11:33:25 UTC, not rolled back, checksum `2639aeff…` = local file.
- Baseline: 50 tables, RLS 0, anon data privileges 0, anon TRUNCATE/REFERENCES/TRIGGER 50, tables not owned by the backend role 0.
- Sessions: 11 idle, 1 active (the check itself); longest transaction 0 s; 0 ungranted locks.
- The migrations folder on disk = `HEAD` (28 directories); `backend/prisma` has no uncommitted changes.
- `assert-v2-database.mjs` (the first half of the deploy script; SELECT-only) exits 0 against V2.

**Proposed command (awaiting approval)**, working directory `backend/`:
```
npm run db:migrate:deploy:v2
```
It runs `with-env .env.v2 assert-v2-database.mjs`, then `with-env .env.v2 prisma migrate deploy --schema=prisma/schema.prisma`. Verification and recovery are as in §23.


## 26. Production apply of `20261021120000` — RESULT: APPLIED (2026-10-21 08:53 UTC)

**Pre-flight (all passed):**
- target is the V2 project (ref hash `62689ffd`; V1 differs);
- `main` @ `f39eb05`; migration sha256 `7c125eeb…e688e0` = on disk = committed blob = expected;
- `backend/prisma` clean;
- Prisma: only this migration pending;
- backup `v2-before-data-api-lockdown-2026-10-21T08-38-29Z.dump` readable (500,467 bytes, 50 table-data entries);
- `assert-v2-database` exit 0;
- 0 ungranted locks, no long transactions;
- history 27 rows, 0 unfinished or rolled back.

**Command:** `npm run db:migrate:deploy:v2` from `backend/`, 08:53:41 → 08:53:47 UTC, exit 0. "All migrations have been successfully applied."

**Verification (read-only):**

| Check | Result |
|---|---|
| `prisma migrate status` | 28 found, "Database schema is up to date" |
| `_prisma_migrations` | 28 rows / 28 distinct, 0 unfinished, 0 rolled back, 0 with logs. The `20261021…` row finished at 08:53:47.34, `applied_steps_count = 1`, checksum `7c125eeb…e688e0` |
| RLS | **50/50 tables**, 0 forced, 0 policies |
| `anon` / `authenticated` | **0 tables** with any of SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER |
| Backend role | `postgres`, BYPASSRLS, owns 50/50, full CRUD privileges on 50/50; a read under RLS succeeded (users 36, sellers 8, products 139) |
| Default privileges (`postgres`, `public`) | tables: `postgres` + `service_role=Dxtm` only (anon/authenticated removed); functions: `postgres` only |
| Schema | columns, indexes and triggers fingerprint **identical** to pre-migration; constraints (excluding NOT NULL) identical (171) |
| Data | row counts identical to the pre-apply backup, except `_prisma_migrations` (+1, this migration) and `refresh_tokens` (+1, a user sign-in at 08:40:13 UTC, **before** the apply, after the backup) |
| `GET /health/ready` (08:54:18 UTC) | `database: up`, `cache: up`, `cacheDriver: redis` |

**Residual note:** `products_search_vector_update()` (a trigger function) stays executable through the default `PUBLIC` grant (`=X/postgres`); `anon`'s own grant is removed. PostgREST cannot invoke trigger functions, so there is no exposure.

**Not done (by instruction):** no push, no app deploy, no Railway change, no load test, no business-data change. The application smoke checks in §24 apply after the next approved deploy. Check 4 (Data API with the anon key) can be run by the owner at any time.


## 27. Review of the uncommitted audit code, Home latency, Railway health check (2026-10-21)

Review only: no code was changed. No production access or write. Railway untouched.

### 27.1 Uncommitted audit files (excluding the owner's `mobile/src/screens/home/homeEngine.ts`)

**Modified:**
- `backend/src/infra/cache/types.ts`
- `backend/src/infra/storage/index.ts`
- `backend/src/infra/storage/private-documents.ts`
- `backend/src/middleware/rateLimit.ts`
- `backend/src/modules/cart/cart.service.ts`
- `backend/src/modules/orders/order.service.ts`
- `backend/src/modules/payments/payment.service.ts`
- `backend/src/routes/index.ts`
- `backend/tests/integration/cashfree-payment.test.ts`
- `mobile/App.tsx`
- `mobile/src/lib/api.ts`

**New:**
- `backend/src/modules/client-errors/client-errors.routes.ts`
- `backend/tests/integration/cart-concurrency.test.ts`
- `backend/tests/integration/client-errors.test.ts`
- `backend/tests/integration/coupon-concurrency.test.ts`
- `mobile/src/components/AppErrorBoundary.tsx`
- `mobile/src/lib/crashReporter.ts`
- `docs/production-readiness/FINAL-AUDIT.md`

Nothing is staged.

### 27.2 Findings

| Sev | Where | Finding |
|---|---|---|
| **P1** | `catalog.service.ts:703-717`, `:737-748`; `catalog.repository.ts:150-167` | **Home latency** (§27.4): 47 SQL statements per request, almost all sequential. Production 3.4–5.9 s, reproduced locally at a 60 ms round trip (3.35–4.93 s). |
| P2 | `payment.service.ts:380`, `cashfree.provider.ts:229` | The lock lives 30 s, but the slowest path in `createCheckoutSession` makes two Cashfree calls with a 15 s timeout each (`fetchOrder` + `createIntent`) plus DB work, so it can exceed 30 s. The lock would expire mid-call, and a waiting request could open a second gateway order. This needs Cashfree to be nearly timing out twice. The duplicate-capture refund remains the backstop. Fix: lock TTL ≥ 45–60 s; keep the wait (`:381`, 20 s) shorter than the TTL. |
| P3 | `payment.service.ts:211-234` | The order is read **before** the lock. A request that waited acts on that snapshot. For a double tap this is harmless: the waiter only waits while the checkout is being opened, then reuses it. Fix: re-read the order (status, `reservationExpiresAt`) inside the lock. |
| P3 | `payment.service.ts:419` | Release is GET-then-DELETE, not atomic. It can only delete another holder's lock if this one already expired, so it depends on the P2 item. Fix together: compare-and-delete (Redis Lua) or rely on a longer TTL. |
| P3 | `order.service.ts:1101-1110` (pre-existing behaviour) | Coupon uses are **never released**. A cancelled, failed or expired-unpaid order keeps its redemption and `used_count`, so an abandoned online checkout can use up a "1 use" coupon and block the customer's retry. The atomic claim did not change this. Product decision: release on `PAYMENT_FAILED` / unpaid expiry. |
| P3 | tests | Missing: payment-lock wait-timeout (503) and cache-unavailable paths; same-customer concurrent orders with one coupon (per-user limit under race); storage timeout behaviour. |
| P3 | `mobile/package.json:12` | `npm test` runs `jest`, which is not installed. The mobile crash tests (6) and app-update tests live only in a scratch harness, **not in the repo**, so CI cannot catch regressions. |
| OK | `order.service.ts:1101-1110` | The atomic claim is correct under READ COMMITTED: the row lock serialises concurrent claims, and the per-user count runs after acquiring it, so it sees committed redemptions. A refusal rolls back the increment. `usage_limit_per_user` is `NOT NULL DEFAULT 1` (no null comparison). |
| OK | `cart.service.ts:74-100` | P2002 → re-read; no caller passes a transaction. Item adds use a native upsert. |
| OK | `storage/index.ts:122` + 3 calls; `private-documents.ts` 3 calls | 60 s timeouts. Both GET paths buffer the body (never streamed to clients), so the timeout bounds only the storage transfer. |
| OK | `client-errors.routes.ts`; `requestLogger.ts:36-47`; `errorHandler.ts:36-56` | No secret or PII logging. Reports are redacted before logging. The request logger never logs bodies. Validation failures log only an issue count. Redis is configured to fail fast (`enableOfflineQueue: false`), so the lock's "continue unlocked" fallback works. |

### 27.3 Tests run (all local; test DB `adione_test` on 55432)

| Suite | Result |
|---|---|
| `cashfree-payment` (39), `payment-security` (18), `coupon-settlement` (13), `order` (17), `payment` (10), `coupon-concurrency` (2), `client-errors` (4), `cart-concurrency` (2), `database-security` (2) | **9 files, 107/107 pass** |
| Backend `tsc` (src), mobile `tsc` | pass |
| Mobile scratch harness `crash.test.tsx` + `app-update.test.tsx` | 22/22 pass |

### 27.4 Home latency: profile and query analysis

**Method:**
- the verified production backup restored into a throwaway local DB (dropped afterwards);
- the **real** `getHomeFeed()` called with Prisma `connection_limit=5` (as in production);
- every SQL statement counted from Prisma query events;
- run twice: direct, and through a local TCP proxy adding 30 ms each way (a 60 ms round trip ≈ Railway Singapore ↔ Supabase Mumbai).

| Run | Wall time per call | Statements |
|---|---|---|
| Direct | 155–175 ms | 47 |
| 60 ms RTT | **3,350–4,930 ms** (production measured 3.4–5.9 s) | 47 |

**Statement mix per call:**
- 6 rail-candidate SQL;
- 1 shelf-candidate SQL;
- **5 × `hydrateProducts`**, each 7 statements (products, brands, categories, images, variants, seller_listings, sellers), because Prisma 5.22 without `relationJoins` runs one query per `include` level;
- 7 × categories, 2 × banners, 1 × category counts.

**There is no N+1:** `toSummaryDto` uses the in-memory 60 s category cache.

**Root cause:** the rails loop (`catalog.service.ts:703`) awaits each rail's candidate query and then its own hydrate, one rail after another. With the per-query round trip this gives about 50 sequential round trips.

**Building blocks at 60 ms RTT** (warm pool, best of 3):

| | Now | Restructured |
|---|---|---|
| 6 rail-candidate queries | 701 ms sequential | **184 ms** in parallel |
| Hydration | 2,550 ms (5 × hydrate of 10, sequential) | **922 ms** (1 × hydrate of all 40) |

**Safe restructuring (same output, no cache):**
1. Fetch all 6 rail candidate lists **and** the shelf candidates in one `Promise.all`.
2. Keep the existing dedupe exactly as it is, in memory, in the same rail order.
3. Hydrate the **union** of rail and shelf IDs **once**.
4. Deal the products back out per rail and shelf.

The projection is about **3.4 s → about 1.2 s**. `tests/integration/home-feed.test.ts` guards the output and ordering semantics.

**Further options, each with its trade-off:**
- Prisma `relationJoins` (a preview feature in 5.x, changes the SQL of every `include` query) would make hydrate about 1–2 round trips (→ well under 1 s). Needs a full regression run.
- **Caching the feed** gives about 0 DB time, but:
  - **stock**: a product that sells out keeps showing as in stock on Home for up to the cache lifetime (cart and checkout still re-validate, so no oversell, only a worse experience);
  - **seller open/closed**: changes appear late on Home;
  - **banners, categories and admin edits**: also appear late;
  - mitigation: a short TTL (30–60 s), single-flight, and invalidation on admin banner, category and config writes. Not recommended until 1–4 are done and measured.
- Structural: co-locate the API and the DB (Railway has no Mumbai region; moving Supabase to Singapore or the API host to Mumbai). This affects every endpoint, not only Home.

### 27.5 Railway health check (documented, not changed)

| Setting | Value | Why |
|---|---|---|
| Service → Settings → Deploy → **Healthcheck Path** | `/health/ready` | Returns 200 only when the DB **and** Redis respond (`health.controller.ts:32-52`), otherwise 503; no auth; quiet in logs (`requestLogger.ts:15`) |
| **Healthcheck Timeout** | 120 s (Railway default 300 s) | Covers Prisma connect plus the first Redis connect, with headroom; Docker's own check allows a 20 s start period |
| Port | the service's `PORT` (the app listens on `env.PORT`; the custom domain targets **4000**) | Railway probes the port the app listens on. Confirm `PORT` resolves to 4000 (variables were not readable from this account). |
| Optional, as code | `railway.json` with `"deploy": {"healthcheckPath": "/health/ready", "healthcheckTimeout": 120}` | A reviewed repo change; needs approval |

**Behaviour once set:** each new deployment must answer 200 before it replaces the running one. A deploy that cannot reach the DB or Redis fails, and the current version keeps serving.

**Limits:** Railway checks only at deploy time. Continuous monitoring still needs an external uptime check on `/health/ready`.

### 27.6 Outstanding blockers and recommended order of fixes (awaiting approval)

1. Payment lock: TTL ≥ 45–60 s, wait < TTL, re-read the order inside the lock, compare-and-delete release, plus tests for the 503 and cache-down paths.
2. Home: parallel candidates + single union hydrate (§27.4 steps 1–4), plus a timing assertion in a local profile.
3. Add a test for same-customer concurrent orders with one coupon.
4. Railway health check `/health/ready` (owner, in the dashboard, or via `railway.json`).
5. Commit the audit changes in reviewable groups; deploy; run the §24 smoke checklist.
6. Product decisions: coupon release on failed or expired orders; Home cache; region co-location.
7. Still open from earlier:
   - B3: Cashfree dashboard webhook URL and live keys;
   - B4: crash test on a real device;
   - mobile tests should live in the repo.

**Unchanged by this review:** production database (not accessed), Railway (still `bcd17a5`), git (no commits, nothing staged), and `homeEngine.ts`.


## 28. Test-environment isolation (2026-10-21/22)

No production database, Redis, Railway or external account was touched. No production `.env` was edited. Nothing is committed or staged; the owner reviews the diff first. Values are never printed in this section.

### 28.1 What was wrong

1. **`.env` leaked into tests.** `tests/setup.ts` and `tests/global-setup.ts` loaded `backend/.env` (V1 production settings) and then `.env.test`, both with `override: true`.
   - 22 of 44 `.env` settings were not redefined by `.env.test` and reached every test process.
   - These included the MSG91 SMS key, the Firebase (FCM) service-account private key, the S3 access keys for a Supabase storage bucket, the UPI VPA, and the Play-review number and fixed OTP.
   - A `REDIS=true` given on the command line was silently overwritten by the file.
   - `global-setup.ts` printed the full `DATABASE_URL`, password included, when it refused a non-test database.
2. **Prisma loads `.env` by itself.** Measured by key name and value length only:
   - The generated Prisma 5.22 client has `relativeEnvPaths.schemaEnvPath = ../../../.env`, which is `backend/.env`. It loads that file into `process.env` every time a `PrismaClient` is created. It never overrides values already set, and there is no setting to turn it off; only a driver adapter skips it.
   - The admin client in `global-setup.ts` therefore put all `backend/.env` settings into the main vitest process, and every test worker inherited them.
   - The Prisma CLI does the same when run from `backend/` ("Environment variables loaded from .env").
3. **`.env.test` was not reproducible.**
   - It has been ignored since the initial commit (`backend/.gitignore:17`, plus `**/.env.*` in both ignore files) and never committed, so a fresh clone or CI has no test configuration.
   - It also contained an old local Postgres password in a comment and a corrupted byte that made it binary ("data").

### 28.2 What changed (test configuration only)

| File | Change |
|---|---|
| `backend/tests/test-env.ts` (new) | `loadTestEnv`: `.env.test` only, `override: false` (command line / CI wins). `assertSafeTestEnv`: the fail-closed gate (below). `removeUnapprovedSettings`: drops app settings a stray `.env` load added. `runPrismaCli`: the Prisma CLI started from an empty temporary folder with an absolute schema path; it **throws if Prisma reports loading any env file**; output has URL credentials masked. |
| `backend/tests/setup.ts` | Load, gate, then a `beforeAll` that removes what the app's Prisma client loaded and re-runs the gate before any test |
| `backend/tests/global-setup.ts` | **No Prisma client in the main process any more.** The database is created with `prisma db execute` and migrated with `prisma migrate deploy`, both through `runPrismaCli`. Final cleanup and gate before workers start. No URL is printed. |
| `backend/tests/unit/test-env.test.ts` (new) | 56 tests (below) |
| `backend/.env.test` | Rewritten as ASCII with the same values. The old local-password comment and the garbled path are removed. `EMAIL_PROVIDER=console` is added. The header explains the overrides. |
| `backend/.gitignore` | Removed the explicit `.env.test` line. Added one anchored exception, `!/.env.test`, after the `**/.env.*` rules. |

**The gate** runs before any database is created or migrated, and again before the first test in every file:
- **NODE_ENV:** must be `test`.
- **Database:** PostgreSQL on localhost (or a host listed in `TEST_SERVICE_HOSTS`), named `*_test`.
- **Redis:** off, or an explicitly selected local instance.
- **Hosted platforms** (Supabase, Railway, Upstash, AWS, Google APIs, Cashfree, MSG91, `adione.in`) are refused even if listed in `TEST_SERVICE_HOSTS`.
- **Services:** every one explicitly on its stand-in (OTP, e-mail and push on console; payments on mock; storage local; search on Postgres). Live Cashfree is refused.
- **Real-service settings must be absent:** MSG91, Cashfree, Razorpay, UPI, FCM, S3, `PLAY_REVIEW_*`, `ENV_FILE`, `RAILWAY_*`.
- **Secrets:** JWT, OTP-pepper and admin secrets must contain "test"; the admin e-mail must use a reserved test domain.
- **URLs:** localhost or reserved test hosts only.
- **Errors** name keys, never values.

### 28.3 Evidence

| Check | Result |
|---|---|
| `.env.test` values | All dummy or local: a local passwordless `*_test` database; JWT and OTP secrets prefixed `test-only-`; admin on `@adione.test`; all stand-in providers. No credentials. |
| Ignore rules (`git check-ignore`) | `backend/.env`, `backend/.env.v2`, `web/.env`, `mobile/.env` and `.env.test` anywhere else are still **ignored**. Only `backend/.env.test` is not. `git ls-files --others --exclude-standard` shows `backend/.env.test` as the only untracked env file. `git add -n backend/` lists `.env.test` and never `.env`/`.env.v2`. Staged files: none. |
| Prisma CLI from `backend/` vs isolated | From `backend/`: "Environment variables loaded from .env". Isolated: no such line, migrations "up to date". The test re-checks this on every run. |
| Main process and workers after global setup (names-only probe) | Before the fix: all 19 `.env` service settings present in the main process **and** inherited by the worker. After: **none** in either. |
| Test worker after the app's Prisma client loads `.env` | Cleaned before the first test. `test-env.test.ts` imports the real Prisma client and asserts no real-service setting is present. |
| Child processes started by tests | A spawned child inherits no real-service setting (tested, names only). `payment-env-guards` children start from the cleaned environment, load only their own temp env file, and create no Prisma client. |
| Fresh clone / fresh database | Dropped the local `adione_test`. Global setup re-created it through the isolated CLI and applied all 28 migrations. Existing-database path also passes. |
| Command line wins | `REDIS=true REDIS_URL=redis://127.0.0.1:…` reached the app unchanged |
| Fail closed | A production-style `DATABASE_URL` (fake) on the command line stopped the run before global setup did anything. The message names only `DATABASE_URL`, with no host or password. |
| Tests | `test-env.test.ts` 56/56, `payment-env-guards` 5/5, `database-security` 2/2. Full suite: see §28.5. |
| Typecheck / lint | Source clean; test typecheck only the 4 errors that predate this work, in untouched files; changed files lint-clean |

### 28.4 Remaining risks and limitations (stated, not hidden)

1. **The Prisma client still reads `backend/.env`** in any process that creates one, on a machine where that file exists:
   - **Test workers** (the app's client): settings are added at import and removed before the first test. The app's own config (`src/config/env.ts`) is parsed before the client exists, so the app never uses them. They sit in that process's memory during module loading only.
   - **`scripts/assert-v2-database.mjs`** (a short-lived child of global setup): loads them into its own process; it prints only host, database and migration names, and nothing returns to the parent.
   - This is **mitigated, not prevented**. On CI, or a clone without `backend/.env`, nothing is loaded at all.
2. **Smallest change that would fully prevent it** (not done; it touches the developer's production configuration, which needs the owner's decision): stop keeping real credentials in a file named `backend/.env`.
   - Move the V1/production values to an explicitly named file (e.g. `backend/.env.v1`), loaded through the existing `scripts/with-env.mjs`, exactly as V2 already uses `.env.v2`.
   - Prisma and dotenv then have no `.env` to auto-load anywhere. That changes how `npm run dev` (V1) is started.
   - Alternatives: Prisma 6 with `prisma.config.ts` (automatic `.env` loading off), or a Prisma driver adapter. Both are larger changes.
3. **`runPrismaCli` assumptions.** It relies on no `.env` existing in a parent of the OS temp folder: `C:\Users\mahir\package.json` exists, with no `.env` beside it. If one appears, the run **stops** rather than leaking.
4. **Cleanup and gate coverage.** The cleanup matches the app's own setting names. A future external service with a new, unrelated name prefix must be added to `tests/test-env.ts`.
5. **CI is not set up.** `TEST_SERVICE_HOSTS` exists for CI service containers; CI must override `DATABASE_URL` (the committed default is this machine's port 55432).

### 28.5 Full backend suite

| Run | Result | Assessment |
|---|---|---|
| 1 (overnight, 2026-10-22 00:47) | 90/91 files, 1,105 passed, **1 failed**: `payment.test.ts`, "Hook timed out in 60000ms" | The whole run was abnormally slow (collection 713 s against the usual ~130 s; that file took 289 s). Re-running the file alone **passed 10/10 twice in 27 s**. |
| 2 (started 01:34) | stopped by me: 4 timeouts in the first 29 files | Windows logged repeated **sleep/wake** (Kernel-Power 42/107) during the run. Reported test durations of up to ~8.7 h confirm the clock jumped across suspends. Results discarded. |
| **3 (11:46, machine held awake for the run only)** | **91/91 files, 1,106 passed, 0 failed, 1 skipped** (the opt-in performance test), wall 1,683 s | No sleep events during the run. **This is the result of record.** |

Run 3 used Windows `SetThreadExecutionState` from the test runner's shell only for its duration. No power setting was changed.


## 29. Home feed: batched build (2026-10-22) — measured locally, NOT deployed

Code only. No caching. No production access; all numbers are local measurements, not projections. Not committed, not deployed: production Home is unchanged (§21.6 still applies until a release).

### 29.1 Change

`backend/src/modules/catalog/catalog.service.ts` (`getHomeFeed`) and `home-selection.ts`.

**Before:**
- the six rails ran one after another, each doing its candidate query and then its own `hydrateProducts`;
- each hydration is 7 sequential statements (products, brands, categories, images, variants, listings, sellers);
- every category shelf's query was started at once.

**After, three database rounds:**
1. Everything independent at once: context, the category tree, Home order, banners, the category map and **all six rails' candidates**. That is a fixed set of about 11 queries.
2. Category-shelf candidates, **at most 4 at a time** (the production pool has 5 connections).
3. **One** hydration of every product any rail or shelf shows: de-duplicated, in batches of 100 ids, 2 batches at a time, so the `IN` lists stay bounded.

The rail de-duplication is the same algorithm, moved into the pure function `pickRailProducts`.

**Unchanged:**
- every SQL statement;
- stock, availability, seller and approval rules (inside the queries);
- the response shape, ordering, de-duplication and fallback;
- no transactions are involved;
- no location input: Home was and is location-independent.

### 29.2 Measurements (same local synthetic dataset, before = `HEAD`, after = working tree)

**Dataset:** `home_perf_test` on the local cluster. It has 5 sellers: 3 live, plus one switched-off seller and one restaurant, which Home excludes. It also has 96 categories (8 top × 3 subcategories, merged across sellers), 168 products, 224 variants and 224 listings, including out-of-stock and switched-off listings. **Synthetic data, not production data.**

`getHomeFeed()` was called directly with Prisma `connection_limit=5`, after 2 warm-up calls. Distance was simulated by a local TCP proxy adding 30 ms each way (60 ms round trip), as for Railway Singapore ↔ Supabase Mumbai.

| | Statements per call | Median | p95 | min–max |
|---|---|---|---|---|
| Before, direct (21 runs) | 60 | 199 ms | 254 ms | 189–341 ms |
| After, direct (21 runs) | **25** | **94 ms** | **126 ms** | 62–160 ms |
| Before, 60 ms RTT (15 runs) | 60 | 3,988 ms | 5,880 ms | 3,829–5,880 ms |
| After, 60 ms RTT (15 runs) | **25** | **1,046 ms** | **1,591 ms** | 982–1,591 ms |

**Statement mix:**
- Before: 8 shelf, 6 rail, 42 hydration (6 × 7) and 4 other.
- After: 8 shelf, 6 rail, 7 hydration (1 × 7) and 4 other.

**Output equivalence:** with `RANDOM()` made deterministic in that throwaway database only, the canonical JSON of the before and after feeds is **byte-identical** (144,028 bytes).

### 29.3 Regression tests

**`tests/integration/home-feed-batching.test.ts` (new, 5 tests).** The test rebuilds the feed the old way (one rail at a time, hydration per rail) from the same repository queries, and requires an exact match:
- **Empty catalogue:** no rails, shelves or categories.
- **Large catalogue (12 top categories; more than 100 products shown, so two hydration batches):**
  - identical rails and shelves;
  - products of switched-off, unapproved and restaurant sellers, and out-of-stock or switched-off listings, never shown;
  - no repeats across rails;
  - rails ≤ 10;
  - hydration statements = ⌈shown/100⌉;
  - a bound on total statements.
- **Tiny catalogue:** later rails repeat products exactly as before.
- **Location:** `GET /home` with, without and with far-away coordinates gives identical results.
- **Live data:** a product selling out, and then the seller switching off, disappear on the very next call.

**Sensitivity:**
- Run against the **old** code, the equivalence checks pass and only the batching check fails ("expected 6 to be 2").
- Against a **mutant** with no rail de-duplication, the large-catalogue equivalence check fails.

**`tests/unit/home-selection.test.ts` (+6):**
- `pickRailProducts`: de-duplication, fallback, empty input;
- `mapWithConcurrency`: order kept, peak concurrency equals the limit, errors propagate, empty input.

**Focused catalog and Home suites:** 10 files, 90/90. Source typecheck clean; changed files lint clean. Full suite: §29.5.

### 29.4 Remaining risks

- **Production unmeasured.** The production figure (3.4–5.9 s, §21.6) can only be re-measured after a deploy. The real distance, pool behaviour and data size will differ from the simulation.
- **Peak concurrency per Home call** rises from about 1–2 to about 11 queries in round 1 (fixed, not data-dependent), against a 5-connection pool. Prisma queues the excess, with a 10 s pool timeout per query. Under heavy concurrent Home traffic this queueing could show up. It is not load-tested here: no production load testing.
- **Round 3 batching** now hydrates the products of all rails and shelves together. Above 100 distinct products this means 2 or more queries (2 at a time).
- **POPULAR** is still random by design; its equivalence was checked with randomness pinned in a throwaway database and in the tests.
- **Caching** is not part of this change (§14 trade-offs unchanged).

### 29.5 Full backend suite

**Full backend suite** (2026-10-22 13:32–13:52, PC held awake for the run; no sleep events during it): **92/92 files, 1,117 passed, 0 failed, 1 skipped** (the opt-in performance test), wall time 1,207 s.


### 29.6 Concurrency review (2026-10-22) — local, synthetic, measured

**Static review of `getHomeFeed()`** (no defect found; no application code changed):

- **Phase 1:** one `Promise.all` over a fixed, data-independent set. That is about 11 statements at most: 6 rail queries, 2 for the category tree, 2 banner queries, and the category map (60 s cache, single-flight). Config reads come from the config cache. Nothing in it scales with the catalogue.
- **Phase 2:** shelf queries through `mapWithConcurrency(…, 4)`. It starts exactly `min(4, n)` workers that pull the next index. Enforced: the unit test measured a peak of exactly the limit.
- **Phase 3:** one hydration of the de-duplicated ids, split only above 100 ids, at most 2 batches at a time. No duplicate or unnecessary batches.
- **No per-request shared state:** `getHomeFeed()` takes no location or user input. Module state is the read-only category cache and constants. Banners are read fresh per call. The rail de-duplication set is per call.
- **Pool:** a request never holds a connection while waiting for another query; there are no transactions. So concurrent requests can only queue for the pool (Prisma `connection_limit`, 5 in production, 10 s pool timeout), not deadlock.

**Benchmark:**
- Real `getHomeFeed()` of `HEAD` (before) and the working tree (after), against the same disposable local `home_perf_test`: the synthetic dataset of §29.2, with `RANDOM()` pinned there only.
- Prisma pool 5. Rounds of N simultaneous calls; 40 requests per level at no delay, 20 at 60 ms RTT.
- Every result was compared with the single-call feed.
- Pool use was sampled from `pg_stat_activity` (`application_name` tag) every 10 ms on a separate monitoring connection.

| Concurrency | Before: req/s · median · p95 | After: req/s · median · p95 |
|---|---|---|
| **No network delay** | | |
| 1 | 8.3 · 117 · 164 ms | **18.4 · 55 · 75 ms** |
| 5 | 36.1 · 125 · 139 ms | **58.8 · 72 · 81 ms** |
| 10 | 35.2 · 217 · 384 ms | **65.2 · 122 · 141 ms** |
| 20 | 41.1 · 408 · 466 ms | **58.2 · 254 · 344 ms** |
| **60 ms round trip** | | |
| 1 | 0.2 · 3,911 · 5,462 ms | **1.0 · 950 · 1,501 ms** |
| 5 | 1.1 · 4,396 · 4,721 ms | **2.6 · 1,913 · 1,961 ms** |
| 10 | 1.1 · 8,742 · 9,182 ms | **2.6 · 3,296 · 3,846 ms** |
| 20 | 1.1 · 16,512 · 17,661 ms | **2.7 · 6,286 · 7,365 ms** |
| 40 (one round) | 1.1 · 35,297 · 37,463 ms | **2.5 · 13,928 · 15,916 ms** |

At every level, in both versions:
- **0 errors**, including no `P2024` pool timeouts up to 40 concurrent;
- **0 results** different from the single-call feed;
- statements per request about 25 after, about 60 before;
- the app pool saturated at its limit (max 5 active connections), which the old code also reached with a single request, because Prisma runs a hydration's related-table reads in parallel.

**Reading:**
- The batched build is better at every level: about 2.4× throughput and about 2.6× lower latency at 60 ms RTT.
- It does **not** remove the capacity limit. With 5 connections at a 60 ms round trip, throughput plateaus at about **2.5–2.7 Home requests/s per instance**. Beyond about 5 simultaneous requests, latency grows linearly (20 concurrent → p95 about 7.4 s).
- Pool wait time itself is **not directly measurable** without Prisma's `metrics` preview feature (not enabled; enabling it needs a schema change). Saturation is shown by the 5-active-connection ceiling and the linear latency growth.

**Correctness under concurrency, a new test** (`home-feed-batching.test.ts`, deterministic, synthetic data):
- 8 simultaneous `getHomeFeed()` calls each equal a deep snapshot of the single-call feed;
- each keeps the rules (no repeats across rails, no out-of-stock or switched-off-seller products);
- mutating one response changes neither another response nor the next call.

Its sensitivity was checked with a mutant that shares the `categories` array across requests: it **fails** there. An earlier draft of the test, comparing against a non-cloned baseline, **passed** the mutant and was corrected.

**Not changed, by decision:**
- **No global Home semaphore.** The pool already serialises, so a semaphore would not raise throughput. It would only shield other endpoints from Home bursts, at the cost of more Home queueing; mixed-traffic latency (Home bursts versus checkout) was **not measured**.
- **No cache.**
- **No pool change.**

The capacity levers are infrastructure and product decisions:
- a larger `connection_limit` through Supabase's transaction pooler;
- co-locating the API and the database;
- a short Home cache (§14 trade-offs).

**Tests after this review:**
- Focused Home/catalog suites: 10 files, 91/91.
- Source typecheck clean; changed files lint-clean.
- Full suite (2026-10-22 14:19–14:41, PC held awake): 92 files, **1,117 passed, 1 failed, 1 skipped**.
- The failure is `tests/unit/product-import-hardening.test.ts`, "XLSX parsing stays linear…". It is a pre-existing wall-clock threshold test (`ratio < 8`, `tLarge < 1500 ms`), unchanged since `e39a9b0`, unrelated to Home, and it **passed 5/5 when re-run alone**. It is recorded as a timing flake under full-suite CPU load, not fixed here.

## 30. XLSX timing-test change and mixed-traffic Home comparison (2026-10-22/23) — local, synthetic, NOT deployed

No application code changed. No production or hosted database was touched. Nothing was staged, committed, pushed or deployed. `mobile/src/screens/home/homeEngine.ts` is byte-for-byte unchanged (SHA-256 checked before and after).

### 30.1 XLSX timing test: what changed and why

**File:** `backend/tests/unit/product-import-hardening.test.ts`, test "XLSX parsing stays linear on adversarial XML". This is the only file in this change. Its diff against `HEAD` contains nothing else.

**Change.** The helper `scaling()` now times each input as the **fastest of 5 runs** instead of the **median of 3**.
- The reason: interference (GC pauses, the OS scheduler, other work on the machine) only ever adds time. The fastest run is therefore the closest measure of the code's own cost.
- A median of 3 lets one result through when 2 of the 3 runs are disturbed.
- The old `median()` helper is kept for the two absolute-time tests, which are unchanged.

**Unchanged:**
- the five inputs and their sizes (`n` = 10,000 / 10,000 / 50,000 / 20,000 / 20,000, measured at n and 4n);
- the 1 ms floor on the small time;
- both thresholds: `ratio < 8` and `tLarge < 1500 ms`.

**New control test**, "control: the same measurement flags quadratic work". It runs a deliberately O(n²) function through the same `scaling()` and requires `ratio > 8`. This proves the fastest-of-5 measurement can still fail when the work is quadratic.

**Evidence.**

| | median of 3 (old) | fastest of 5 (new) |
|---|---|---|
| Full-suite runs with this test in the log (2026-10-17 → 22) | **1 failure in 9 runs**: 2026-10-22 14:19, case "unterminated comment", `ratio < 8` false | **1 of 1 passed** (§30.2) |
| Isolated study: idle, 30 executions | 0/30 failed, max ratio 5.6 | 0/30 failed, max ratio 4.9 |
| Isolated study: 12 busy threads on 12 logical cores, 30 executions | 0/30 failed, max ratio 5.6 | 0/30 failed, max ratio 4.9 |
| Isolated study: 36 busy threads (3× oversubscribed), 30 executions | 0/30 failed, max ratio 5.1 | 0/30 failed, max ratio 5.0 |
| Quadratic control, minimum ratio over all runs (must be > 8) | 10.3 | 10.8 |
| Quadratic control, not flagged | 0/90 | 0/90 |

**Reading:**
- The only observed failure rate is the full-suite record: **1 in 9 runs** with the old method.
- Synthetic CPU saturation did **not** reproduce the failure with either method, so the full-suite trigger is not plain CPU load. GC or allocation pressure inside the vitest worker is plausible but not proven.
- The new method lowers the maximum observed ratio (5.6 → 4.9 idle).
- The control test confirms that quadratic work is still flagged (minimum ratio 10.3–14.2 across all conditions).
- One full-suite pass under the new method is too few to state a new failure rate.
- The earlier note that ratios reached "~45" (test comment) comes from the previous session's notes. Its raw output was not kept and is not re-verified here.

### 30.2 Quality gates after the change

| Check | Command (in `backend/`) | Result |
|---|---|---|
| Full backend suite | `npm test` (= `vitest run`), PC held awake | **93/93 files; 1,133 passed, 0 failed, 1 skipped** (the opt-in performance test in `product-import.test.ts`). 2026-10-22 18:56–19:20, 1,411 s. The XLSX tests passed in the full run. |
| Source typecheck | `npm run typecheck` | clean |
| Test typecheck | `npm run typecheck:tests` | **4 errors, all pre-existing.** Identical at `HEAD` (checked on a `git archive` copy), all in files this work did not touch: `admin-content.test.ts:106` and `image-optimizer.test.ts:7` (`Cannot find namespace 'sharp'`), `home-feed.test.ts:350-351` (`possibly 'undefined'`). |
| Changed-file lint | throwaway ESLint 9 + typescript-eslint `recommended` (the backend has no lint setup), over the 27 changed or new backend `.ts` files | **0 new findings.** The same 2 `no-unused-vars` findings exist at `HEAD`, in `tests/helpers/fake-cashfree.ts` and in this test file (the unused `_next` parameter of an Express error handler). |

### 30.3 Mixed-traffic benchmark: method

**What is compared.** Two copies of `backend/` in a scratchpad, outside the repository:
- **new** = the working tree's `src/`, byte-identical;
- **old** = the same tree with `catalog.service.ts` and `home-selection.ts` taken from `HEAD`.

`diff -r` shows exactly those two files differ. The old copy is identical to the one used for §29. Both copies use the same `node_modules`; the Prisma schema and client are unchanged. Neither copy contains any real `.env`: each loads only a local `.env.bench`. A guard refuses to start unless the database is `home_perf_run` on `localhost:55432` with `connection_limit=5`, and it rechecks `current_database()` after connecting.

**Data:**
- `home_perf_base` is a frozen copy of the disposable `home_perf_test`: the synthetic §29.2 catalogue, 12 synthetic shoppers and 352 synthetic orders from earlier runs.
- **Every trial runs on a fresh clone** (`CREATE DATABASE home_perf_run TEMPLATE home_perf_base`, then `CHECKPOINT`), dropped afterwards. So both versions always start from identical data.
- `home_perf_test` itself was not modified.

**Environment:**
- AMD Ryzen 5 5500U (12 logical cores), Windows 11, Node 24.3.0, Prisma 5.22.0.
- Local PostgreSQL 18.6, default settings: `shared_buffers` 128 MB, `work_mem` 4 MB, `fsync` and `synchronous_commit` on, `max_connections` 100.
- One Node process per trial represents one API instance, with a single Prisma pool of `connection_limit=5`, as in production.
- `NODE_ENV=development`, because Prisma query events are needed to count statements. `LOG_LEVEL=silent`.
- In-memory cache, payment settings withheld (mock provider, COD only), console notifications. Nothing leaves the machine.

**Workload.** Closed-loop workers: each sends its next operation when the previous one returns. The real service functions are called directly; there is no HTTP layer.

| Workers | Operations per loop |
|---|---|
| catalog × 2 | `listProducts` (top category, 20 items), then `getProductDetail` |
| cart × 2 | `addItem`, `getCart`, `clearCart` |
| checkout × 2 | `clearCart`, `addItem` (qty 2), `placeOrder` (COD, new idempotency key) |
| Home | **no-home:** none · **with-home-8:** 8 closed-loop workers calling `getHomeFeed()` · **home-rate-N (supplementary):** open-loop arrivals at a fixed N req/s, the same Home demand for both versions; in-flight cap 40, excess shed (none was shed) |

**Runs:**
- **No network delay:** 10 s warm-up (with-home-8 mix, discarded), then 30 s per scenario. **4 trials per version**, in the order old, new, new, old, old, new, new, old. Supplementary rate 8 req/s.
- **60 ms round trip:** 20 s warm-up, then 60 s per scenario. **3 trials per version**, in the order old, new, new, old, old, new. Supplementary rate 1 req/s.

**Measures:**
- Each figure is the mean over trials (min–max in brackets) of each trial's throughput, median and p95.
- Throughput = completions per second.
  - No delay: includes the at most one in-flight operation per worker that finishes during the 0.05–0.25 s drain (≤ about 1%).
  - 60 ms: only completions inside the window.
- Statements per Home request: 5 sequential calls with nothing else running.
- Pool: `pg_stat_activity` sampled every 50 ms on a separate connection.

**Hang protection** (the earlier 60 ms run hung for 54 minutes; see §30.5):
- each operation is bounded at 30 s (120 s at 60 ms) and recorded as `TIMEOUT` with a `pg_stat_activity` dump;
- each scenario's drain is bounded;
- a watchdog runs inside the process, plus an outer `timeout -k`;
- after each trial, any leftover benchmark connection stops the run.

**None of these protections fired:** every trial exited 0, with 0 timeouts and 0 leftover connections.

### 30.4 Results

**Statements per Home request:**
- old: **60** with no delay (20 of 20 calls), 60–65 at 60 ms;
- new: **25** in every one of the 35 calls.

**Errors:** **0** for every operation, in every trial, in both versions and both network conditions. That includes no `P2024` pool timeout and no `P2028` transaction-start timeout.

**No network delay (local socket)** — req/s · median · p95 (ms):

| Scenario | Operation | Old (`HEAD` Home) | New (batched Home) |
|---|---|---|---|
| no-home | checkout `placeOrder` | 13.9 (11.7–15.1) · 84 · 108 | 14.4 (13.3–15.1) · 80 · 102 |
| | checkout add-to-cart | 13.9 · 41 · 53 | 14.4 · 39 · 51 |
| | cart add | 25.2 · 43 · 55 | 25.8 · 41 · 54 |
| | catalog list / detail | 50.9 · 27 / 12 · 36 / 16 | 52.4 · 26 / 11 · 34 / 15 |
| with-home-8 | checkout `placeOrder` | **5.1** (4.5–5.3) · 181 · 235 | **2.9** (2.6–3.0) · 286 · 394 |
| | checkout add-to-cart | 5.1 · 137 · 182 | 2.9 · 259 · 355 |
| | cart add | 6.8 · 148 · 198 | 3.7 · 271 · 363 |
| | catalog list / detail | 18.4 · 78 / 27 · 110 / 47 | 10.1 · 146 / 50 · 210 / 79 |
| | **Home** | **18.5** (16.5–19.2) · 422 · 556 | **35.4** (31.4–36.9) · 219 · 288 |
| home-rate-8 (supplementary) | checkout `placeOrder` | 9.4 (8.7–10.2) · 110 · 139 | **11.8** (11.7–11.9) · 93 · 118 |
| | cart add | 14.3 · 73 · 98 | 19.2 · 55 · 76 |
| | catalog list / detail | 34.8 · 41 / 15 · 58 / 24 | 43.6 · 30 / 12 · 47 / 25 |
| | **Home** (8.0 req/s offered) | 8.0 · 338 · 401 | 8.0 · **111 · 173** |

**60 ms round trip** (order-preserving local proxy, §30.5) — req/s · median · p95 (ms):

| Scenario | Operation | Old (`HEAD` Home) | New (batched Home) |
|---|---|---|---|
| no-home | checkout `placeOrder` | 0.33 · 3,218 · 4,162 | 0.30 · 3,284 · 4,489 |
| | cart add | 0.57 · 1,908 · 2,266 | 0.56 · 1,913 · 2,440 |
| | catalog list | 1.37 · 863 · 1,175 | 1.36 · 866 · 1,187 |
| with-home-8 | checkout `placeOrder` | 0.13 · 6,383 · 7,350 | 0.10 · 6,955 · 8,682 |
| | cart add | 0.19 · 5,597 · 6,750 | 0.13 · 7,026 · 8,322 |
| | catalog list | 0.56 · 2,366 · 3,743 | 0.42 · 3,192 · 4,289 |
| | **Home** | **0.54** · 12,262 · 13,229 | **1.69** · 4,548 · 5,237 |
| home-rate-1 (supplementary) | checkout `placeOrder` | 0.10 · 8,021 · 11,126 | **0.20 · 4,559 · 5,376** |
| | cart add | 0.13 · 7,922 · 11,251 | 0.30 · 3,401 · 4,635 |
| | catalog list | 0.42 · 3,361 · 5,988 | 0.79 · 1,716 · 2,178 |
| | **Home** (1.0 req/s offered) | **0.62 completed** (25 in flight at peak) · 20,883 · 24,638 | **0.97** (4 in flight at peak) · 2,427 · 2,965 |

**Variance:**
- Trial-to-trial coefficient of variation of throughput was ≤ 12% with no delay (≤ 8% with Home) and ≤ 7% at 60 ms (one value of 15%).
- The widest median range was old-version cart add with no delay (40–51 ms). The ranges are shown in the tables.
- The **no-home control** (cart, catalog and checkout code identical in both copies) agrees between versions within that noise. This confirms that the two copies and the trial order are comparable.

### 30.5 The earlier 60 ms proxy hang: cause found, harness replaced

The run that hung for 54 minutes used `homeprof/proxy.cjs` and the earlier `mixed.ts`. Two defects, the first one demonstrated:

1. **The proxy could reorder bytes.**
   - Each chunk got its own `setTimeout`, with a delay computed from two separate `Date.now()` calls.
   - Node orders timers by its cached loop clock, so two chunks from one tick can get delays of 30 and 29 ms. The later chunk is then delivered first.
   - It also destroyed the other side only `delay + 5 ms` after a close, which can drop queued data.
   - **Database-free test:** 16 concurrent clients streaming numbered bytes through the proxy.

     | | Streams corrupted | Byte counts in = out |
     |---|---|---|
     | Old proxy | **9 of 96** (6 runs: 3, 0, 2, 1, 3, 0) | not checked |
     | Replacement (`proxy-fifo.cjs`: one FIFO queue per direction, close forwarded only after the queue drains) | **0 of 96** | yes, every run |

   - A reordered Postgres stream leaves a client waiting for a reply that never arrives.
2. **The harness had no operation timeout, drain bound or watchdog.** `Promise.all(workers)` could therefore wait forever. The new harness bounds all three (§30.3).

That (1) caused that particular hang is the most likely explanation, not a proven one: the hung run left no diagnostic dump. The replacement passed a bounded smoke test (2 trials, 23 MB, 0 mismatches) before the measured runs. Over all six 60 ms trials it carried 184 MB with **0 mismatches**, then stopped cleanly.

On Windows the proxy's effective round trip is 61–93 ms (median 63–77 ms) for a nominal 60 ms, because of timer granularity.

### 30.6 Reading: checkout impact of Home traffic and remaining capacity concern

**Same Home demand (supplementary fixed-rate scenarios).** The batched Home is better for everyone, not just for Home.

| | No delay, 8 Home req/s | 60 ms RTT, 1 Home req/s |
|---|---|---|
| Checkout throughput lost vs no-home | old −32%, new **−18%** | old −69%, new **−33%** |
| Checkout median vs no-home | old +31%, new **+16%** | old 3.2 s → 8.0 s, new 3.3 s → **4.6 s** |
| Checkout p95 | — | old 11.1 s, new **5.4 s** |
| Did Home keep up? | both, but the old Home's median was 3× higher | **only the new one**: the old Home fell behind (0.62 of 1.0 req/s completed, 25 requests queued, 21 s median) |

**Unlimited Home demand (8 closed-loop Home workers).** The new Home serves **1.9×** (no delay) and **3.1×** (60 ms) as many Home requests, at about half and one third of the latency. Because each Home worker immediately sends its next request, the faster Home takes the capacity it frees, and the other operations get less:
- **No delay:** checkout throughput **−63%** (old) and **−80%** (new) against no-home; checkout p95 rises from about 105 ms to 235 ms (old) and 394 ms (new).
- **60 ms:** checkout 0.13 → 0.10 req/s; median 6.4 → 7.0 s; p95 7.4 → 8.7 s (old → new).

So under Home saturation, checkout is somewhat worse with the new code. The cause is that it serves more Home traffic; each Home request is cheaper (25 vs 60 statements; less pool time per request).

**Where the limit is:**
- **No delay:** not the connection pool. Pool mean-active stayed at about 2 of 5. Database statements per second *fell* when Home was added (no-home 2,827/s old and 2,911/s new; with-home-8 2,048/s old and 1,408/s new). The cost appears to be the per-request work of building the large Home response (about 144 KB, §29.2) inside the single Node process, and/or Postgres CPU on the same machine; this benchmark does not separate the two.
- **60 ms:** every statement holds a connection for at least one round trip. Server-side `active` samples undercount this, because a connection waiting for the network shows as idle. The pool of 5 is the limit:
  - with this mix, about **1.7 Home req/s per instance** (new) against 0.5 (old);
  - even **1 Home req/s** raises the new code's checkout median from 3.3 s to 4.6 s.

**Remaining capacity concern** (unchanged recommendation, now with mixed-traffic evidence; decisions for the owner, nothing changed here):
- Home traffic directly slows checkout on a single instance with 5 connections.
- At a production-like round trip, checkout is already **3.2–3.3 s without any Home traffic**: many sequential statements, each paying the network delay.
- The levers are the ones in §29.6: co-locating the API and the database, a larger `connection_limit` through the transaction pooler, and a short Home cache. A Home concurrency limit would protect checkout from Home bursts at the cost of Home queueing; this benchmark now quantifies that trade-off.

### 30.7 Limitations (stated, not hidden)

- **Synthetic local data**, one machine, one instance:
  - catalogue of 5 sellers, 96 categories and 168 products;
  - Postgres, Node and the load generator share the same CPU.
- **Closed-loop workers** (plus one open-loop Home stream): no HTTP, no authentication, no rate limits, no JSON serialization to a client, no Redis.
- **No production measurements.** The 60 ms figures come from a local proxy simulating Railway Singapore ↔ Supabase Mumbai, with real effective round trips of 61–93 ms. They are not production latencies. Production also adds Supavisor, TLS and real data sizes.
- `NODE_ENV=development` (Prisma query events on) in both versions. Production runs `NODE_ENV=production`.
- Short windows (30 s / 60 s): at 60 ms only 6–20 checkouts per scenario per trial, so their p95 values are approximate.
- The number of trials (4 / 3 per version) gives ranges, not confidence intervals.

### 30.8 Artifacts and cleanup

**Kept outside the repository**, in the session scratchpad:
- the harness (`mixed-bench.ts`, `run-trials.sh`, `delay-run.sh`, `proxy-fifo.cjs`, `proxy-integrity.cjs`, `summarize.cjs`);
- raw JSONL results;
- `xlsx-ratio-study.ts` and its log.

**Removed:** the clone databases (`home_perf_run`, `home_perf_base`), the two backend copies with their `node_modules` junctions and throwaway `.env.bench` files, and the `HEAD` copy used for the typecheck and lint comparison.

**Left as they were:**
- the local cluster on 55432 and the `adione_test` / `home_perf_test` databases;
- the previous session's scratchpad, which still holds copies of `backend/.env`, `.env.v2` and two `v2-production-*.dump` files inside `home-before/backend` (§30.9).

### 30.9 Remaining release blockers (unchanged by this section)

- **Benchmarks:** none. They are local evidence, not a gate.
- **From §0, §19 and §27.6:**
  - B3: Cashfree live keys and the dashboard webhook URL;
  - B4: crash test on a real device;
  - committing the uncommitted audit changes in reviewable groups, then deploying and running the §24 smoke checklist (§29 Home batching included);
  - the Railway health check;
  - the product decisions: Home cache or concurrency limit, region co-location, coupon release.
- **Housekeeping for the owner:** delete the earlier scratchpad copy of `home-before/backend`. It contains copies of the real env files and production dumps.

## 31. Credential incident, release-readiness review and status checklist (2026-10-23)

Read-only towards production except one approved read-only query (§31.2). No credential was rotated or revoked, nothing was pushed or deployed, and no production setting or data was changed. `homeEngine.ts` is byte-for-byte unchanged (SHA-256 checked). No secret value appears in this section.

### 31.1 Status checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Repository state | **Verified** | `main` @ `f39eb05`. **Two commits ahead of both remotes** (`6ccd43c`, `f39eb05`: the Data API migration and its docs). The remotes are at `bcd17a5` (production). Nothing staged. |
| 2 | Stray-file evidence | **Verified** | The evidence copy's SHA-256 matches the recorded value (`cecaad00…`). |
| 3 | Old `home-before` scratchpad copy | **Completed** | All 2,429 files had an identical copy elsewhere before deletion. The `node_modules` junction was removed as a link; the real `node_modules` is intact. The test cluster (port 55432, data in `C:\Users\mahir\aadione-test-pg`) was untouched. |
| 4 | `tatus --short` | **Awaiting approval** | A tracked file (`3550b17`, on both remotes). It contains no secret. Removal is part of commit group I. |
| 5 | Root `.gitignore` `*.dump` | **Completed** | Ignored at any depth; no dump is tracked. |
| 6 | Memory note `v2-production-candidate.md` | **Completed** | The public example password was removed (1 → 0). |
| 7 | Production admin password | **Verified** | One `admin.bootstrap.relink` event, 2026-10-09 08:46 UTC, fields `email`, `passwordHash`, `fullName`. One active admin account. The example password is therefore no longer in use. Whether the current value equals the exposed local `.env` value can only be checked with the hidden-input comparison (§31.3). |
| 8 | V1 project still used? | **Partly verified** | 0 of 14 URL-like production columns reference the V1 project. No tracked file, Railway-bound file or client points at it. Only local `backend/.env` storage settings do. The V1 dashboard's activity is not visible from here. |
| 9 | `JWT_SECRET` ↔ image-folder coupling | **Completed (uncommitted)** | New optional `SELLER_IMAGE_FOLDER_KEY` (defaults to `JWT_SECRET`, so behaviour is unchanged) with 5 unit tests. A mutant that ignores the key fails the test. |
| 10 | Credential rotation | **Awaiting approval and dashboard access** | Runbook in §31.3. |
| 11 | Cashfree dashboard (live mode, webhook URL) | **Blocked: dashboard access** | Not verifiable from here. |
| 12 | App Store / Play status | **Blocked: account access** | No App Store Connect or Play Console access in this environment. |
| 13 | Real-device tests | **Blocked: device** | Checklist in §31.7. |
| 14 | Coupon release rule | **Awaiting business decision** | §31.6. |
| 15 | Railway health check | **Proposal** | §31.9. |

### 31.2 Production read (approved, read-only)

- **How:** one connection using `.env.v2`, with `connection_limit=1`, `SET TRANSACTION READ ONLY` (confirmed `transaction_read_only = on`) and a 15 s statement timeout.
- **Printed:** only audit actions, timestamps and field names, plus counts.
- **Side result:** the current V2 database password connects successfully, so the earlier P1000 is resolved.

### 31.3 Credential rotation runbook (no action taken)

**Step 0 for every credential: compare without revealing anything.**
- Run `node compare-secret.cjs <envFile> <KEY>` (scratchpad helper) and paste the Railway or dashboard value at the hidden prompt.
- It prints only MATCH or DIFFERENT. Nothing is stored.
- Local values are **not** assumed to equal Railway's.

**Order:**
1. Step-0 comparisons.
2. V1 database password and V1 S3 keys (no production dependency found).
3. MSG91 and FCM (create new → deploy → validate → revoke old).
4. `JWT_SECRET` + `OTP_PEPPER` in one off-peak deploy.
5. Admin password.

Steps 3–4 need a Railway deploy and wait while deploys are paused. Every external change needs its own approval.

| Credential | Exposed copy | Depends on it | Procedure | Validation | Recovery |
|---|---|---|---|---|---|
| FCM service-account key | local `.env` (Claude transcript 2026-09-23) | push notifications | Google Cloud → service account → add a key → set Railway `FCM_PRIVATE_KEY` (the client email is unchanged for the same account) and local `.env` → deploy | a test push to a known device; no FCM auth errors in the log | keep the old key until validated; a deleted key cannot be restored |
| MSG91 auth key | local `.env` (2026-09-23) | OTP SMS | MSG91 → create a new auth key → Railway + local → deploy | one OTP login on a test number (3 OTPs/hour/number limit) | the old key stays active until validated |
| V1 S3 keys | local `.env` (2026-09-23) | local development storage only (0 production references) | **First check that Railway's `S3_ENDPOINT` is the V2 project.** Then V1 Supabase → Storage → S3 keys → revoke | local `.env` storage stops working; switch it to `STORAGE_PROVIDER=local` | irreversible; create a new key if ever needed |
| `JWT_SECRET` | both `.env` values (2026-09-23, 2026-09-26) | access-token signing; image folders (now decoupled) | Set `SELLER_IMAGE_FOLDER_KEY` = the **current** `JWT_SECRET` on Railway (folders stay), then a new random `JWT_SECRET` (≥ 48 bytes; generate locally, store in a password manager), then deploy. **Requires group J deployed first.** | sign in; a refresh after 15 min; seller image upload; product import with images | set the old value back. Refresh tokens are random and hashed and do not depend on it, so customers refresh once rather than being logged out. |
| `OTP_PEPPER` | both `.env` values | OTP hashing only | same deploy as `JWT_SECRET` | one OTP login | old value back; OTPs from the last ≤ 5 min must be requested again |
| Admin password | local `.env` value (2026-09-23) | admin login (Railway `ADMIN_PASSWORD` set it on 2026-10-09) | step 0 against Railway `ADMIN_PASSWORD`. If it matches: change it in the admin panel, or set a new unique Railway value (the bootstrap relinks on the next boot), stored in a password manager | sign in with the new password; the old one fails | change it again |
| Old V1 Supabase DB password | old env copies (2026-09-23, 2026-10-16) | none found | V1 dashboard → check database connections and API requests over 7 days → reset the password, or pause the project (deleting it needs separate approval) | — | reset again or unpause |

**Not to rotate without new evidence:** the current V2 database password and the Cashfree keys. Neither value was found outside the env files.

### 31.4 Test-environment safety

- `.env.test` holds only test-marked dummy values and a local database (`postgres@localhost:55432/adione_test`, no password). It is tracked only via `backend/.gitignore`'s `!/.env.test`.
- `tests/test-env.ts` refuses a run when:
  - the database is not a local `*_test` database;
  - any production host is configured (Supabase, Railway, Cashfree, MSG91, Google, AWS, hosted Redis);
  - any `FORBIDDEN_KEYS` value is present (MSG91, Cashfree, FCM, S3, Play-review, `SELLER_IMAGE_FOLDER_KEY`);
  - a secret lacks a test marker.
- Prisma's own loading of `backend/.env` in test workers is undone in `beforeAll` before any test runs. At `HEAD` the old setup loaded `backend/.env` first.
- The Cashfree tests use an injected fake `fetch`. Live-host URLs in tests are assertions or test data, not calls. This is static evidence plus the runtime guard; the suite was not run in a network-isolated sandbox.

**Developer setup — risk and proposal (not applied).** `backend/.env` runs `NODE_ENV=development` against the **production V2 database**, with real MSG91 SMS and FCM. `.env.v2` does the same with the **live** Cashfree key. A local `npm run dev` therefore acts on production. Proposal:
1. A local development database (the existing `docker-compose.yml`) plus console OTP and notifications in `backend/.env`.
2. Rename `.env.v2` to make its production nature explicit, and keep the live Cashfree key only on Railway.
3. A startup guard: outside `NODE_ENV=production`, refuse a non-local `DATABASE_URL` unless `ALLOW_REMOTE_DATABASE=true` is set and logged loudly.

This changes your workflow, so it needs your decision.

### 31.5 Payment and checkout review

**Verified in code and tests:**
- **Payment lock** (Redis-shared, owned token, Lua compare-and-delete, fail-closed 503 with `Retry-After`, order re-checked under the lock). 10 integration tests: double tap, busy, cache down, release failure, slow Cashfree, expiry race, cancelled/paid while waiting.
- **Webhook** HMAC-SHA256 over timestamp + raw body, constant-time comparison.
- **Duplicate-capture refund** and reconciliation (unchanged since §5).
- **Coupon claim:** an atomic `UPDATE` holds the coupon row lock until commit. `usage_limit_per_user` is `NOT NULL DEFAULT 1`.
- **Cart:** a duplicate create falls back to the existing cart.
- **Storage:** 60 s timeouts on images and private documents.

**Operational requirement:** Redis must be monitored. While it is down, online payments cannot start (503) and `/health/ready` returns 503.

**Cashfree dashboard (owner, not verified here):**
- the environment is **Live**;
- the webhook URL is `https://api.adione.in/api/v1/payments/webhook`;
- the webhook version matches the integration (`x-webhook-signature` / `x-webhook-timestamp`);
- the Railway secret key matches the dashboard key (step 0 comparison).

**Payment test plan (each step needs approval; none run):**
1. Locally against Cashfree **sandbox** keys with a tunnel for webhooks: success, failure, double tap, app closed during payment.
2. In production, one owner-paid ₹1 order with immediate refund:
   - webhook received (log line);
   - order `PAID`;
   - refund `SUCCESS`;
   - a repeated Pay returns the same checkout.

### 31.6 Business decision required: coupon release

Today a coupon use is consumed at order placement and **never released** when payment fails, the order is cancelled or expires, or it is refunded. Only the seller-cleanup tool decrements usage. Options:
- **(a) Keep as is.** Simplest; customers can lose a one-time coupon.
- **(b) Release on payment failure, expiry and cancellation before payment.**
- **(c) Also release on full refund.**

Not changed pending your decision.

### 31.7 Mobile readiness

- **Automated:** typecheck clean; `test:unit` 21/21 (guest gate, private-cache roots, refresh failure, login copy).
- **Jest:** `npm test` → `jest` cannot run. Jest is not installed or configured (pre-existing).
- **Native crash reporting: none.** No Sentry, Crashlytics or Bugsnag. Crash reporting is JavaScript-only: the error boundary, global handler and unhandled rejections post to `/client-errors`.
- **Release config:** version 1.0.9, iOS build 4, Android `versionCode` 10, `in.adione.app`, production API `https://api.adione.in/api/v1`. `appVersionSource: local` without `autoIncrement`, so bump the build numbers by hand before any new upload. One internal profile points at an ngrok URL.

**Real-device checklist (production API, Android and iOS):**
1. Fresh install → browse Home, categories, search and product as a guest.
2. Add to cart → login prompt with the right copy → OTP login → the item lands in the cart.
3. Logout → no private data is visible.
4. Tap Pay three times quickly → one checkout.
5. Slow network (3G throttle), then airplane mode during checkout and Home → clear errors, recovery on reconnect, a 503 shows "try again".
6. Cart consistency across two devices on one account.
7. Kill the app during payment and resume → order status refreshes.
8. Payment success and payment failure screens.
9. Force a JavaScript crash (developer build) → recovery screen plus a `client-errors` log line, without personal data.
10. Restart after 20 minutes → silent token refresh, no logout.

### 31.8 Home feed (group F) — before approval

The benchmarks in §30 stand and were not repeated.
- **At the same Home demand**, the batched build is better for checkout.
- **Under unlimited Home demand on one 5-connection instance**, Home traffic slows checkout in both versions.

**Options (production changes need approval):**
1. **Single-flight + short shared cache.** Home has no user or location input, so a 10–15 s cache with single-flight (one build per instance per window) removes Home's database load. The trade-off: stock and availability can be stale for up to the window, and the "sold out disappears on the next call" test changes to "within N s".
2. **Per-instance concurrency cap** of 2 simultaneous Home builds, queue the rest. This protects checkout at the cost of Home queueing.
3. **Investigate co-locating the API and the database** (the round trip dominates: checkout takes 3.2 s at a simulated 60 ms).

**Production metrics to watch:**
- p50/p95 of `GET /home`, `POST /orders` and payment creation;
- 5xx rate;
- `P2024`/`P2028` counts in the log;
- Supavisor client connections;
- Redis ping or latency (`/health/ready`);
- the `client-errors` rate.

**Rollback:** revert the F commit (code only, no migration) or roll Railway back to the previous deployment.

### 31.9 Railway and operations

- `/health/ready` checks the database and the cache, answering 200 or 503. Startup checks database reachability, refuses a V1 or unmigrated database, syncs the admin account, then listens. No migrations run at startup.
- **Proposed** (not created): Railway health check path `/health/ready`, timeout 120 s. A Redis outage then blocks a deploy rather than shipping one without the lock.
- **Log redaction** covers auth headers, cookies, passwords, OTPs, tokens, signatures and document numbers, one level deep. Deeper nesting is not covered (low).
- Client crash reports are re-redacted on the server.
- **Backups:** dumps up to 2026-10-22 exist locally (`~/aadione-db-backups`, `backend/aadione-production-backup.dump`). `npm run db:verify-backup` must run before any migration (§21.5).

### 31.10 Release status

**NO-GO**, until these are done:
- credential rotation (§31.3);
- Cashfree dashboard verification;
- approved commits pushed and deployed;
- the §24 smoke checklist;
- real-device tests;
- the coupon decision;
- the Railway health check.

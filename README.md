# AdiOne — Hyperlocal Quick-Commerce Platform

> **Sab kuch, abhi ke abhi!** — daily essentials delivered fast, from one local store.

A production-oriented quick-commerce platform for a small-city / town market.
V1 ships **Grocery & Daily Essentials** from **one store** inside a configurable
delivery radius, with an architecture built so Vegetables, Café, Pharmacy,
Clothing and multi-store expansion are additions — not rewrites.

---

## The three projects

| Project | What it is | Stack | README |
|---|---|---|---|
| **`backend/`** | The API — the sole authority for price, stock, COD and serviceability | Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Socket.IO | [backend/README.md](backend/README.md) |
| **`web/`** | The store / admin panel the shopkeeper runs at the counter | React 18 · Vite · TypeScript · Tailwind · TanStack Query | [web/README.md](web/README.md) |
| **`mobile/`** | The customer app | React Native 0.76 · Expo 52 · TypeScript · React Navigation | [mobile/README.md](mobile/README.md) |

They are **independent** projects. Each has its own `package.json`, its own
`node_modules` and its own build. There is no monorepo tooling, no npm
workspaces and no cross-project linking — you can clone, install and run any one
of them on its own.

```
adione/
├── backend/                        API, database, jobs, realtime
├── web/                            Store / admin panel
├── mobile/                         Customer app
├── docs/                           PRD, architecture, technical docs, API reference
├── docker-compose.yml              Optional Postgres + Redis + MinIO for local dev
├── docker-compose.prod.yml         Production composition
├── PROGRESS.md                     Task-by-task build tracker
├── AdiOne_ClaudeCode_TaskList.md   Full scope definition
└── README.md                       You are here
```

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/01-PRD-and-Architecture.md](docs/01-PRD-and-Architecture.md) | PRD, journeys, architecture, DB/API design, security, payments, risks |
| [docs/02-decisions.md](docs/02-decisions.md) | Locked technical decisions and their rationale |
| [docs/03-backend-technical.md](docs/03-backend-technical.md) | Backend internals: pipeline, data model, pricing, orders, payments, jobs |
| [docs/04-api-reference.md](docs/04-api-reference.md) | **Every endpoint**, error codes, realtime events, enumerations |
| [docs/05-web-technical.md](docs/05-web-technical.md) | Admin panel internals: shell, state, uploads, realtime, serving |
| [docs/06-deployment.md](docs/06-deployment.md) | Environments, deployment sequence, operations |
| [docs/07-mobile-technical.md](docs/07-mobile-technical.md) | Mobile internals: navigation, offline behaviour, checkout, push, native config |
| [PROGRESS.md](PROGRESS.md) | Task-by-task build tracker |

Start with **01** for the product and the architecture, **04** if you are
integrating against the API, and the matching technical doc if you are working
inside one of the three projects.

---

## Quick start

**Prerequisites:** Node.js ≥ 20 and PostgreSQL ≥ 14 running locally.
Redis and Docker are **optional** — the backend falls back to an in-process
cache driver for local development.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env          # Windows: copy .env.example .env
#   edit .env — at minimum DATABASE_URL, JWT_SECRET, OTP_PEPPER
npm run db:migrate
npm run db:seed
npm run dev                   # http://localhost:4000/health
```

The seed creates the first store-owner login from `ADMIN_EMAIL` /
`ADMIN_PASSWORD`. **Change that password after first login.**

### 2. Admin panel

```bash
cd web
npm install
npm run dev                   # http://localhost:5173
```

With no `.env` it proxies `/api`, `/socket.io` and `/static` to the backend on
:4000, so the browser sees a same-origin API.

### 3. Customer app

```bash
cd mobile
npm install
npm start                     # Expo dev server
```

Set `EXPO_PUBLIC_API_URL` in `mobile/.env` — `http://10.0.2.2:4000/api/v1` for
the Android emulator, your LAN IP for a physical device.

With `OTP_PROVIDER=console`, `POST /auth/send-otp` returns the OTP as `devOtp`,
so you can sign in without an SMS provider.

### Optional infrastructure

```bash
docker compose up -d          # Postgres :5433, Redis :6379, MinIO :9000
```

Postgres is mapped to **5433** so it does not collide with a natively installed
instance on 5432.

---

## The shared contract

Domain enums, the order state machine, error codes, wire DTOs, pure business
helpers (money, distance, COD resolution, dates) and the design tokens are
defined **once** in `backend/src/shared/` and mirrored into the two clients:

```
backend/src/shared/     canonical — edit here
web/src/shared/         generated copy — do not edit
mobile/src/shared/      generated copy — do not edit
```

After changing anything in the canonical folder:

```bash
cd backend && npm run sync:shared
```

CI verifies the copies are current with `npm run sync:shared -- --check`.

**Trade-off, stated plainly:** independent folders mean the shared contract is
copied rather than imported from a linked package, so a stale copy is possible
if the sync is skipped. The `--check` guard exists for exactly that reason.
Everything in `shared/` is dependency-free and platform-neutral so the same
file runs under Node, in a browser and under Hermes.

This is what makes it a **compile error** for a client to invent a field the
server does not send, or to switch on a status string the server never emits.

---

## Architecture rules (non-negotiable)

1. **The server is the only authority** for price, discount, total, stock,
   COD eligibility and serviceability. Client-sent values for these are never
   accepted as input.
2. **No hardcoded business rules.** Radius, fees, hours, COD policy, ETA
   parameters and limits all live in the `configurations` table.
3. **Money is integer paise** (`Int`) everywhere. Never floats. `Int` caps at
   ₹21,474,836 per column — far above any grocery order — and avoids dragging
   `BigInt` handling through every DTO and JSON serialiser.
4. **Order status changes go through the state machine only** — one service
   writes `orders.status`, validating the transition and recording history.
5. **Order creation, payment confirmation and stock movement run in database
   transactions** with row-level locking; third-party calls never happen inside
   a transaction.
6. **Idempotency keys** guard order placement and payment creation.
7. **Every external provider sits behind a port** (`PaymentProvider`,
   `OtpProvider`, `NotificationProvider`, `SearchProvider`, `StorageProvider`,
   `CacheStore`). No SDK is imported outside `backend/src/infra/`.
8. **Secrets only come from the environment.** The backend refuses to boot if a
   required variable is missing, or if a development stub (console OTP, mock
   payments, in-memory cache, local disk storage) is configured in production.

---

## How the pieces fit

```
                    ┌──────────────────┐         ┌──────────────────┐
                    │  mobile/         │         │  web/            │
                    │  Customer app    │         │  Admin panel     │
                    └────────┬─────────┘         └────────┬─────────┘
                             │  REST /api/v1              │
                             │  Socket.IO                 │
                             └────────────┬───────────────┘
                                          │
                                 ┌────────▼─────────┐
                                 │  backend/        │
                                 │  Express API     │
                                 │  ├ modules/      │  business logic
                                 │  ├ infra/        │  ports & adapters
                                 │  ├ jobs/         │  scheduled work
                                 │  └ shared/       │  THE contract
                                 └────────┬─────────┘
                                          │
              ┌───────────────┬───────────┼───────────┬────────────────┐
              │               │           │           │                │
        ┌─────▼─────┐   ┌─────▼────┐ ┌────▼─────┐ ┌───▼────┐  ┌────────▼──────┐
        │ PostgreSQL│   │  Redis   │ │ Object   │ │  SMS   │  │ Payments      │
        │           │   │(optional)│ │ storage  │ │ (MSG91)│  │ (Cashfree)    │
        └───────────┘   └──────────┘ └──────────┘ └────────┘  └───────────────┘
```

Both clients speak the same versioned REST API and the same Socket.IO channel.
Realtime is an optimisation on both — each client also polls, because a dropped
socket must never cause the store to miss an order or the customer to miss a
delivery.

---

## Working on this project

| Task | Where |
|---|---|
| Add or change an endpoint | `backend/src/modules/<domain>/`, then update [docs/04](docs/04-api-reference.md) |
| Change a wire shape or enum | `backend/src/shared/`, then `npm run sync:shared` |
| Change a business rule | The `configurations` table — via the admin panel, or `config-keys.ts` for a new key |
| Add an admin screen | `web/src/pages/`, route in `web/src/App.tsx` |
| Add a customer screen | `mobile/src/screens/`, register in the relevant stack |
| Swap an external provider | A new adapter in `backend/src/infra/` |

Before opening a PR:

```bash
cd backend && npm run typecheck && npm test && npm run sync:shared -- --check
cd ../web  && npm run typecheck && npm run lint
cd ../mobile && npm run typecheck
```

---

## Licence

Proprietary — all rights reserved.

# AdiOne — Store / Admin Panel

The web panel the shopkeeper runs at the counter: new orders, order status,
catalogue, stock, delivery agents and every business rule.

React 18 · Vite 5 · TypeScript · Tailwind CSS · TanStack Query · Zustand · Socket.IO

- **Technical documentation:** [../docs/05-web-technical.md](../docs/05-web-technical.md)
- **API reference:** [../docs/04-api-reference.md](../docs/04-api-reference.md)
- **Deployment:** [../docs/06-deployment.md](../docs/06-deployment.md)

---

## Quick start

```bash
npm install
npm run dev                   # http://localhost:5173 -> V2 API on http://localhost:4100
```

`npm run dev` points the panel at the local V2 backend (`V2_API_ORIGIN` picks
another host), whatever `.env` says — `.env`'s `VITE_API_URL` is for production
builds. `npm run dev:prod-api` is a plain Vite dev server that uses `.env` (or,
with no `.env`, proxies `/api`, `/socket.io` and `/static` to
`http://localhost:4000`).

Sign in with the store-owner account created by the backend seed
(`ADMIN_EMAIL` / `ADMIN_PASSWORD` in `backend/.env`). The login endpoint is
`POST /auth/admin/login`, which additionally requires a staff role — a customer
with correct credentials cannot get in.

---

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` (= `dev:v2`) | Vite dev server on :5173 against the local V2 API |
| `npm run dev:prod-api` | Vite dev server using `.env`'s API (production) — opt-in only |
| `npm run build` | `tsc -b` then `vite build` → `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint over `src` |

---

## Environment

Vite inlines every `VITE_*` variable at **build** time — restart the dev server
or rebuild after changing one. These values ship to the browser, so **no
secrets belong here**.

| Variable | Effect |
|---|---|
| `VITE_API_URL` | Absolute API base. Leave blank to use the dev proxy / same-origin Nginx |
| `VITE_SOCKET_URL` | Absolute Socket.IO origin. Blank means same-origin |

Both are only needed when the API lives on another host (a tunnel, a deployed
backend).

---

## Layout

```
src/
├── main.tsx               Entry — QueryClient, Router
├── App.tsx                Shell: sidebar, top bar, routes, session restore
├── pages/                 One file per route
│   ├── Login.tsx          Admin sign-in
│   ├── Dashboard.tsx      Today's orders, revenue, low stock
│   ├── Orders.tsx         The order board — tabs, status actions, assignment
│   ├── Products.tsx       Product + variant CRUD, image upload
│   ├── Categories.tsx     Category tree
│   ├── Inventory.tsx      Stock, pricing, availability, ledger
│   ├── Customers.tsx      Customers derived from the order feed
│   ├── Delivery.tsx       Agents and cash settlement
│   └── Config.tsx         Every business rule, with descriptions
├── components/            ui.tsx (design-system primitives), StoreLocationCard
├── lib/
│   ├── api.ts             fetch wrapper, envelope unwrapping, single-flight refresh
│   ├── auth.ts            Zustand session store
│   ├── socket.ts          Socket.IO subscription hook
│   ├── upload.ts          Presign → PUT → attach image flow
│   ├── image.ts           Rewrites stored image URLs to a same-origin path
│   └── format.ts          Paise → ₹, dates, relative times
└── shared/                GENERATED — mirrored from backend/src/shared
```

Path aliases: `@/…` → `src/…`, `@shared` → the mirrored contract.

---

## Routes

| Path | Page |
|---|---|
| `/` | Dashboard |
| `/orders` | Orders |
| `/products` | Products |
| `/categories` | Categories |
| `/inventory` | Inventory |
| `/customers` | Customers |
| `/delivery` | Delivery |
| `/settings` | Configuration |

Unauthenticated users never reach the router: `App.tsx` renders the login page
until the session is restored.

---

## How it talks to the API

- **Access token in memory, refresh token in `localStorage`.** An XSS on the
  panel must not hand over a session that can refund orders; the refresh token
  is persisted because the owner should not re-login every 15 minutes at the
  counter.
- **One refresh per 401.** Concurrent requests wait on a single in-flight
  refresh instead of each firing their own and racing the rotation.
- **Server messages are displayed as-is.** Every API error carries a stable
  `code` and a message that is safe to show a user by contract, so there is no
  string mapping in this app.
- **Realtime is an optimisation, never the only path.** The panel subscribes to
  `order.created` and `order.status_changed`, and *also* polls, because a
  missed new order is the most expensive failure at the counter.

---

## The shared contract

`src/shared/` is a **generated copy** of `backend/src/shared/`. Do not edit it —
the next sync overwrites it. Change the canonical folder and run:

```bash
cd ../backend && npm run sync:shared
```

That copy is what makes it a compile error for this app to invent a field the
server does not send, or to switch on a status string the server never emits.

---

## Production build

```bash
npm run build       # → dist/
```

`Dockerfile` builds the app and serves `dist/` from Nginx (~25 MB image, no
Node process at runtime). `nginx.conf` proxies `/api/`, `/socket.io/` and
`/static/` to the API container so the browser sees one origin, caches hashed
assets for a year, and never caches `index.html`.

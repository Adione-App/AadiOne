# AdiOne — API Reference

**Document:** 04 — API reference
**Base URL:** `{API_BASE_URL}/api/v1`
**Realtime:** Socket.IO on the same origin, path `/socket.io`

Everything here is generated from the route table in
[`backend/src/routes/index.ts`](../backend/src/routes/index.ts) and the DTOs in
[`backend/src/shared/dto.ts`](../backend/src/shared/dto.ts). The DTO file is the
machine-readable version of this document; when the two disagree, the DTO wins.

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Errors](#2-errors)
3. [Authentication](#3-authentication)
4. [Rate limits](#4-rate-limits)
5. [Idempotency](#5-idempotency)
6. [Health](#6-health)
7. [Configuration](#7-configuration)
8. [Legal](#8-legal)
9. [Auth endpoints](#9-auth-endpoints)
10. [Store & serviceability](#10-store--serviceability)
11. [Catalogue](#11-catalogue)
12. [Cart](#12-cart)
13. [Addresses](#13-addresses)
14. [Checkout & orders](#14-checkout--orders)
15. [Payments](#15-payments)
16. [Notifications & devices](#16-notifications--devices)
17. [Admin — dashboard & orders](#17-admin--dashboard--orders)
18. [Admin — catalogue](#18-admin--catalogue)
19. [Admin — inventory](#19-admin--inventory)
20. [Admin — delivery](#20-admin--delivery)
21. [Admin — store & configuration](#21-admin--store--configuration)
22. [Realtime events](#22-realtime-events)
23. [Enumerations](#23-enumerations)

---

## 1. Conventions

### Versioning

Every endpoint is under `/api/v1`. A mobile app already installed on a
customer's phone cannot be forced to upgrade, so a breaking change must be able
to live alongside the old contract under a new prefix.

### Response envelope

Every response is one of exactly two shapes. Clients branch on `success`.

**Success**

```json
{
  "success": true,
  "data": { },
  "meta": {
    "requestId": "01J…",
    "nextCursor": null,
    "total": 42
  }
}
```

`meta.nextCursor` appears on cursor-paginated endpoints. `meta.total` appears
only on admin endpoints where a count is cheap.

**Error**

```json
{
  "success": false,
  "error": {
    "code": "ITEM_OUT_OF_STOCK",
    "message": "This item is out of stock.",
    "details": [{ "field": "qty", "message": "Only 3 left" }],
    "requestId": "01J…",
    "retryAfterSeconds": 30
  }
}
```

`retryAfterSeconds` is present on `429` responses only.

### Money

**Every monetary value is an integer number of paise** (₹1 = 100 paise) and its
field name ends in `Paise`. There are no floats and no currency strings.
Clients format; clients never compute.

### Dates

ISO-8601 strings in UTC (`2026-08-15T09:30:00.000Z`). Store opening hours are
evaluated in the store's timezone (`STORE_TIMEZONE`, default `Asia/Kolkata`).

### Pagination

**Cursor pagination is the default.** Catalogue and order lists are read while
rows are being inserted, and offset pagination silently duplicates or skips rows
when that happens.

```jsonc
// data
{
  "items": [ ],
  "nextCursor": "2026-08-15T09:30:00.000Z",
  "hasMore": true
}
```

Query parameters: `cursor` (opaque; pass back what you received) and `limit`
(default **20**, max **100**).

Offset pagination (`page`, `limit`, `total`, `totalPages`) is used only where an
admin table wants a total count.

### Request headers

| Header | When | Notes |
|---|---|---|
| `Authorization: Bearer <accessToken>` | Authenticated endpoints | |
| `Content-Type: application/json` | Any request with a body | |
| `Idempotency-Key` | `POST /orders`, `POST /payments/create` | 8–120 characters; see [§5](#5-idempotency) |
| `X-Request-Id` | Optional | Echoed back; generated if absent |
| `X-Client-Version`, `X-Client-Platform` | Optional | Client telemetry |

### Response headers

| Header | Notes |
|---|---|
| `X-Request-Id` | Quote this when reporting a problem — it is the log key |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining` | On rate-limited routes |
| `Retry-After` | On `429` |

### CORS

`CORS_ORIGINS` is a comma-separated allow-list, and credentials are enabled, so
`*` is never used. Requests with **no** `Origin` header (the native app, curl,
server-to-server) are not browser cross-origin requests and are allowed
through.

---

## 2. Errors

`code` is stable and switched on programmatically. `message` is **always safe
to display to an end user as-is** — that is the contract, and it is what keeps
"user-friendly errors, not technical errors" a property of the protocol rather
than a pile of string mapping in each app. Technical detail (stack, SQL,
provider payloads) never crosses the wire; it is logged against `requestId`.

### Generic

| Code | HTTP | Default message |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Please check the details you entered and try again. |
| `NOT_FOUND` | 404 | We could not find what you were looking for. |
| `INTERNAL_ERROR` | 500 | Something went wrong at our end. Please try again. |
| `SERVICE_UNAVAILABLE` | 503 | Service is temporarily unavailable. Please try again shortly. |
| `RATE_LIMITED` | 429 | Too many requests. Please wait a moment and try again. |

### Auth

| Code | HTTP | Default message |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Please log in to continue. |
| `TOKEN_EXPIRED` | 401 | Your session has expired. Please log in again. |
| `TOKEN_INVALID` | 401 | Your session is no longer valid. Please log in again. |
| `FORBIDDEN` | 403 | You do not have permission to do this. |
| `ACCOUNT_BLOCKED` | 403 | This account has been blocked. Please contact support. |
| `INVALID_CREDENTIALS` | 401 | Incorrect email or password. |
| `EMAIL_ALREADY_REGISTERED` | 409 | An account with this email already exists. Please log in. |
| `MOBILE_ALREADY_REGISTERED` | 409 | An account with this mobile number already exists. Please log in. |
| `PASSWORD_NOT_SET` | 409 | This account uses OTP login. Please continue with your mobile number. |

### OTP

| Code | HTTP |
|---|---|
| `OTP_INVALID` | 400 |
| `OTP_EXPIRED` | 400 |
| `OTP_MAX_ATTEMPTS` | 429 |
| `OTP_RATE_LIMITED` | 429 |
| `OTP_RESEND_TOO_SOON` | 429 |
| `OTP_SEND_FAILED` | 502 |

### Location & store

| Code | HTTP |
|---|---|
| `OUT_OF_SERVICE_AREA` | 422 |
| `STORE_CLOSED` | 409 |
| `STORE_INACTIVE` | 503 |
| `INVALID_COORDINATES` | 400 |

### Catalogue & inventory

| Code | HTTP |
|---|---|
| `PRODUCT_UNAVAILABLE` | 409 |
| `ITEM_OUT_OF_STOCK` | 409 |
| `INSUFFICIENT_STOCK` | 409 |
| `QTY_LIMIT_EXCEEDED` | 422 |

### Cart & checkout

| Code | HTTP |
|---|---|
| `CART_EMPTY` | 422 |
| `PRICE_CHANGED` | 422 |
| `MIN_ORDER_NOT_MET` | 422 |
| `COD_NOT_ALLOWED` | 422 |
| `COUPON_INVALID` | 422 |
| `COUPON_EXPIRED` | 422 |
| `COUPON_LIMIT_REACHED` | 422 |
| `COUPON_MIN_ORDER_NOT_MET` | 422 |

### Address

| Code | HTTP |
|---|---|
| `ADDRESS_LIMIT_REACHED` | 422 |
| `ADDRESS_NOT_SERVICEABLE` | 422 |

### Orders

| Code | HTTP |
|---|---|
| `ORDER_IN_PROGRESS` | 409 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `IDEMPOTENCY_KEY_REUSED` | 409 |
| `INVALID_STATUS_TRANSITION` | 409 |
| `ORDER_NOT_CANCELLABLE` | 409 |
| `DELIVERY_AGENT_REQUIRED` | 422 |
| `DELIVERY_OTP_INVALID` | 400 |

### Payments

| Code | HTTP |
|---|---|
| `PAYMENT_FAILED` | 402 |
| `PAYMENT_VERIFICATION_FAILED` | 400 |
| `PAYMENT_AMOUNT_MISMATCH` | 400 |
| `PAYMENT_ALREADY_CAPTURED` | 409 |
| `WEBHOOK_SIGNATURE_INVALID` | 400 |
| `REFUND_FAILED` | 502 |

### Uploads

| Code | HTTP |
|---|---|
| `FILE_TOO_LARGE` | 413 |
| `UNSUPPORTED_FILE_TYPE` | 415 |

---

## 3. Authentication

Two credential paths lead to the same session:

- **OTP** (`send-otp` → `verify-otp`) — the customer path. Creates the account
  on first successful verification.
- **Email + password** (`signup`, `login`, `admin/login`) — the staff path, and
  an alternative customer path.

Both return:

```jsonc
{
  "user": {
    "id": "uuid",
    "mobile": "9876543210",
    "fullName": "Asha Devi",
    "email": null,
    "role": "CUSTOMER",
    "referralCode": null,
    "mobileVerified": true,
    "isNewUser": true,
    "createdAt": "2026-08-15T09:30:00.000Z"
  },
  "tokens": {
    "accessToken": "eyJ…",
    "refreshToken": "…",
    "expiresInSeconds": 900
  }
}
```

- **Access token** — JWT, `JWT_ACCESS_TTL` (default 15 minutes). Sent as
  `Authorization: Bearer`.
- **Refresh token** — opaque, `JWT_REFRESH_TTL_DAYS` (default 30), **rotated on
  every use**. Store it in the Keychain / Android Keystore on mobile and in
  `localStorage` on the panel; never store the access token at rest.
- `mobileVerified` is `false` for accounts created by email + password signup
  until one OTP login completes. The number was typed, not proven — and the
  rider phones it.

### Authorisation

Access is expressed as **permissions**, not role checks, so adding a role later
is a map entry rather than a code change. A permission grants the *ability* to
perform an action; it never grants access to a *specific record*. Ownership
("is this the customer's own order?") is checked separately in the service
layer, every time.

| Role | Permissions |
|---|---|
| `CUSTOMER` | `catalog:read`, `order:create`, `order:read_own`, `order:cancel_own`, `cart:manage`, `address:manage` |
| `STAFF` | catalogue read, inventory read/write, `order:read_all`, `order:update_status`, `delivery_agent:read`, `delivery:assign`, `dashboard:read` |
| `STORE_MANAGER` | STAFF + `catalog:write`, `delivery_agent:write`, `customer:read`, `coupon:read`, `config:read` |
| `ADMIN` / `STORE_OWNER` | STORE_MANAGER + `order:refund`, `customer:write`, `config:write`, `coupon:write` |
| `SUPER_ADMIN` | Everything |
| `DELIVERY_AGENT` | `delivery:self_update`, `order:read_all` |

Roles allowed to sign in to the admin panel: `ADMIN`, `STORE_OWNER`,
`SUPER_ADMIN`, `STORE_MANAGER`, `STAFF`.

V1 uses `CUSTOMER`, `ADMIN` and `STORE_OWNER` only; the rest are declared so
RBAC is extensible.

---

## 4. Rate limits

Fixed-window counters. The window's TTL is set only when the counter is
created, so a caller cannot extend their own window by making more requests.
Several limiters stack on one route.

| Scope | Limit | Window | Applies to |
|---|---|---|---|
| `api:ip` | 120 | 1 min | Every `/api/v1` request |
| `api:user` | 300 | 1 min | Every `/api/v1/admin` request |
| `otp:mobile:hour` | 3 | 1 h | `POST /auth/send-otp` |
| `otp:mobile:day` | 10 | 24 h | `POST /auth/send-otp` |
| `otp:ip:hour` | 10 | 1 h | `POST /auth/send-otp` |
| `otp:verify:ip` | 30 | 1 h | `POST /auth/verify-otp` |
| `login:email` | 8 | 15 min | `POST /auth/login`, `POST /auth/admin/login` |
| `login:ip` | 40 | 15 min | `POST /auth/login` |
| `admin:login:ip` | 10 | 15 min | `POST /auth/admin/login` |
| `signup:mobile` | 3 | 1 h | `POST /auth/signup` |
| `signup:ip` | 5 | 1 h | `POST /auth/signup` |
| `orders:create` | 10 | 1 h | `POST /orders` (per user) |

`/auth/send-otp` carries three limiters on purpose. Per-mobile alone lets one
attacker SMS-bomb many numbers; per-IP alone is defeated by a mobile network's
shared NAT, where thousands of genuine users share an address.

Validation runs **before** the per-mobile limiters so they see the normalised
10-digit number — otherwise `+91 98765 43210` and `9876543210` would get
separate counters and an attacker could reset the limit by reformatting.

---

## 5. Idempotency

Required on `POST /orders` and `POST /payments/create`.

On a 3G connection a request routinely succeeds server-side while the response
never arrives. The customer taps again. Without idempotency they get two orders
and two charges.

Send `Idempotency-Key: <8–120 chars>`, unique per logical operation and
**reused on every retry of that operation**. The database is the arbiter, via
`UNIQUE (user_id, key)`.

| Situation | Result |
|---|---|
| New key | Processed normally; the response is stored for 24 h |
| Same key, same body, first request finished | The stored response is replayed verbatim, with no side effects |
| Same key, same body, first request still running | `409 ORDER_IN_PROGRESS` |
| Same key, **different** body | `409 IDEMPOTENCY_KEY_REUSED` — a client bug, not a retry |
| Missing or malformed key | `400 IDEMPOTENCY_KEY_REQUIRED` |

On `POST /orders` the middleware runs **last** in the chain
(`authenticate → permission → rate limit → validate → idempotency`) so a
rejected or malformed request never consumes the key: the customer must be able
to fix the problem and retry with the same key.

---

## 6. Health

Two distinct checks, because they answer different questions.

### `GET /health` · `GET /health/live` — liveness

Public. Never touches a dependency, so a database blip does not cause an
orchestrator to kill a healthy process.

```json
{
  "status": "ok",
  "service": "adione-api",
  "environment": "production",
  "uptimeSeconds": 8421,
  "timestamp": "2026-08-15T09:30:00.000Z"
}
```

### `GET /health/ready` — readiness

Public. Checks the database and cache. Returns **503** when either is down, so
a load balancer can act on the status code rather than parsing the body.

```json
{
  "status": "ok",
  "checks": { "database": "up", "cache": "up", "cacheDriver": "redis" },
  "timestamp": "2026-08-15T09:30:00.000Z"
}
```

### `GET /api/v1/` — service banner

```json
{ "name": "AdiOne API", "version": "v1", "documentation": "/docs/04-api-reference.md" }
```

---

## 7. Configuration

### `GET /config/public`

Public. Returns **only** the keys on the public allow-list. Everything else
(COD caps, ETA parameters, payment hold windows, road-distance factor) stays
server-side.

The app reads this on cold start and caches it. It is never a source of truth
for a decision — only for what to display.

```jsonc
{
  "MAX_SERVICE_RADIUS_KM": 10,
  "MIN_ORDER_VALUE_PAISE": 9900,
  "FREE_DELIVERY_THRESHOLD_PAISE": 29900,
  "PLATFORM_FEE_PAISE": 500,
  "DEFAULT_MAX_QTY_PER_ORDER": 10,
  "MAX_ADDRESSES_PER_USER": 5,
  "FEATURE_REFERRAL_ENABLED": false,
  "FEATURE_COUPONS_ENABLED": true,
  "FEATURE_RATINGS_ENABLED": false,
  "FEATURE_WISHLIST_ENABLED": false,
  "SUPPORT_PHONE": "",
  "SUPPORT_WHATSAPP": "",
  "SUPPORT_EMAIL": "support@adione.in",
  "DELIVERY_PROMISE_TEXT": "in 30 minutes",
  "STORE_TIMEZONE": "Asia/Kolkata"
}
```

Admin read/write lives at [`/admin/config`](#21-admin--store--configuration).

---

## 8. Legal

One definition, two shapes, so they can never drift apart.

### `GET /legal/{slug}`

Public. `slug` ∈ `privacy` | `terms`. JSON, for the in-app screens.

```jsonc
{
  "title": "Privacy Policy",
  "updatedAt": "2026-08-14",
  "sections": [{ "heading": "…", "body": ["…", "…"] }]
}
```

### `GET /legal/{slug}/page`

Public. The same document rendered as plain HTML at a public URL. This exists
because Google Play requires a privacy policy reachable without installing or
logging into anything — a screen inside the app does not satisfy that.

Store name, address, hours and support contacts are substituted from live
configuration at render time.

---

## 9. Auth endpoints

### `POST /auth/send-otp`

Public.

```jsonc
// request
{ "mobile": "9876543210" }     // "+91 98765 43210" and "098765 43210" also accepted

// response 200
{ "resendAfterSeconds": 30, "expiresInSeconds": 300, "devOtp": "123456" }
```

`devOtp` is present in non-production environments only.

### `POST /auth/verify-otp`

Public. Creates the account on first successful verification.

```jsonc
// request
{ "mobile": "9876543210", "otp": "123456" }
```

Returns the auth payload from [§3](#3-authentication). **201** when this call
created the account, **200** when it already existed.

Errors: `OTP_INVALID`, `OTP_EXPIRED`, `OTP_MAX_ATTEMPTS`.

### `POST /auth/signup`

Public. Email + password registration. Returns **201** with tokens, so the
customer is logged in immediately rather than bounced to a login screen.

```jsonc
{
  "fullName": "Asha Devi",
  "email": "asha@example.com",
  "password": "…",           // ≥ 8 chars, must contain a letter and a number
  "mobile": "9876543210"
}
```

`user.mobileVerified` is `false` on the response.

Errors: `EMAIL_ALREADY_REGISTERED`, `MOBILE_ALREADY_REGISTERED`.

### `POST /auth/login`

Public. Email + password, any role.

```jsonc
{ "email": "asha@example.com", "password": "…" }
```

Errors: `INVALID_CREDENTIALS`, `PASSWORD_NOT_SET` (the account uses OTP login),
`ACCOUNT_BLOCKED`.

### `POST /auth/admin/login`

Public. Same credential path, but additionally requires a staff role — a
customer with correct credentials must not get into the store panel.

Errors: as above, plus `FORBIDDEN`.

### `POST /auth/refresh`

Public (the access token has expired by definition).

```jsonc
{ "refreshToken": "…" }
```

Returns a fresh auth payload. **The refresh token is rotated**: the one you
sent is revoked and a new one is issued. Reuse of a revoked token invalidates
the session.

### `POST /auth/logout`

```jsonc
{ "refreshToken": "…" }     // optional; falls back to the authenticated session
```

**204.** Revoking is idempotent, so logging out twice is not an error. With no
body and an authenticated session, every refresh token for that user is
revoked.

### `GET /auth/me`

Authenticated. Returns `UserDto`.

### `PATCH /auth/me`

Authenticated.

```jsonc
{ "fullName": "Asha Devi", "email": "asha@example.com" }   // email: null clears it
```

At least one field is required.

### `DELETE /auth/me`

Authenticated. **204.** Actually erases the account.

Google Play requires an in-app deletion path and India's DPDP Act requires
erasure on request; a "Delete Account" button that does nothing is a listing
rejection.

---

## 10. Store & serviceability

Both endpoints are **public**. The app must be able to check serviceability
*before* asking anyone to log in — requiring auth first would mean a customer
outside the delivery area has to create an account only to be told no.

### `GET /store`

```jsonc
{
  "id": "uuid",
  "name": "AdiOne Store",
  "addressLine": "Main Road",
  "city": "…", "state": "…", "pincode": "123456",
  "latitude": 25.1, "longitude": 82.3,
  "phone": "…",
  "timezone": "Asia/Kolkata",
  "isActive": true,
  "isOpenNow": true,
  "opensAt": null,
  "closesAt": "2026-08-15T16:30:00.000Z",
  "todayHours": { "dayOfWeek": 5, "opensAt": "08:00", "closesAt": "22:00", "isClosed": false }
}
```

`isActive` is the owner's trading switch, set from the admin panel.
`isOpenNow` is `false` whenever the store is switched off, closed for the day,
or outside today's window — the app does not need to combine the two.

A switched-off store still serves this endpoint and the whole catalogue.
Customers can browse and fill a cart; only checkout is refused
(`STORE_INACTIVE`). A dark app looks broken, a closed one looks shut.

### `GET /store/serviceability?lat={lat}&lng={lng}`

```jsonc
{
  "serviceable": true,
  "distanceKm": 3.2,
  "maxRadiusKm": 10,
  "etaMinutes": 28,
  "etaMinMinutes": 25,
  "etaMaxMinutes": 35,
  "deliveryFeePaise": 2000,
  "storeOpen": true
}
```

ETA and fee are `null` when not serviceable.

`lat` and `lng` are range-checked and `0` is rejected explicitly: a failed GPS
fix on Android frequently yields `0, 0`, which is ~6,000 km away in the Gulf of
Guinea. Without the check the customer would just see "we don't deliver here"
and blame the app.

Serviceability uses **straight-line** distance against `MAX_SERVICE_RADIUS_KM`.
`ROAD_DISTANCE_FACTOR` is applied to the ETA and delivery fee, never to the
boundary itself.

---

## 11. Catalogue

**Catalogue reads are public.** Browsing must work before login and outside the
delivery area: serviceability gates *ordering*, not *looking*. An out-of-area
visitor who can browse is a demand signal for the next store.

All commercial data on a variant (`pricePaise`, `mrpPaise`, `inStock`,
`availableQty`, `maxQtyPerOrder`, `allowCod`) is resolved **server-side against
the active store**. It is never derived by a client.

### `GET /categories`

| Query | Type | Notes |
|---|---|---|
| `parentId` | uuid | Omit for top level |
| `includeChildren` | boolean | Nest children under each category |
| `withCounts` | boolean | Include `productCount` |

Returns `CategoryDto[]`:

```jsonc
{
  "id": "uuid", "parentId": null,
  "name": "Grocery", "nameHi": "किराना", "slug": "grocery",
  "imageUrl": "…", "depth": 0, "displayOrder": 1,
  "productCount": 42, "children": []
}
```

### `GET /categories/{id}/subcategories`

Returns `CategoryDto[]`.

### `GET /products`

Cursor-paginated `ProductSummaryDto`.

| Query | Type | Notes |
|---|---|---|
| `categoryId` | uuid | |
| `subcategoryId` | uuid | |
| `brandId` | uuid | |
| `inStock` | boolean | |
| `sort` | enum | `RELEVANCE` \| `PRICE_ASC` \| `PRICE_DESC` \| `NEWEST` \| `POPULAR` \| `DISCOUNT` |
| `cursor` | string | |
| `limit` | int | ≤ 100, default 20 |

```jsonc
// ProductSummaryDto
{
  "id": "uuid", "name": "Aashirvaad Atta", "nameHi": null, "slug": "aashirvaad-atta",
  "brandName": "Aashirvaad", "categoryId": "uuid",
  "imageUrl": "…", "thumbUrl": "…",
  "defaultVariant": {
    "id": "uuid", "sku": "ATTA-5KG", "variantName": "5 kg",
    "unit": "KG", "unitValue": 5, "imageUrl": null, "isDefault": true,
    "mrpPaise": 28000, "pricePaise": 25500, "discountPercent": 8,
    "inStock": true, "availableQty": 12, "maxQtyPerOrder": 10, "allowCod": true
  },
  "variantCount": 3
}
```

### `GET /products/search`

Cursor-paginated `ProductSummaryDto`.

| Query | Type | Notes |
|---|---|---|
| `q` | string | **Required.** 1–80 characters |
| `inStock` | boolean | |
| `cursor`, `limit` | | |

`q` is bounded because it reaches the Smart Search index (trigram and btree
lookups); an unbounded string is an easy way to make the database work hard
for free. Matching is multilingual and typo-tolerant (English, Hindi, Hinglish,
dictionary synonyms) and ranked exact-first — see
`SMART-SEARCH-IMPLEMENTATION.md`. The cursor resumes after the last result's
(rank, id).

> Registered **before** `/products/:id` in the route table, or Express would
> match `search` as an id.

### `GET /restaurants/search`

Food search: live restaurants / cafes matching `q` by their name, cuisine or
a dish on their public menu, best first. Public (guests too).

| Query | Type | Notes |
|---|---|---|
| `q` | string | **Required.** 1–80 characters |
| `diet` | `VEG` \| `NON_VEG` | as on `GET /restaurants` |
| `type` | `RESTAURANT` \| `CAFE` | as on `GET /restaurants` |

```jsonc
[{ "sellerId": "uuid", "rank": 6890.5, "matchedItems": ["Chicken Momos (Steam)"] }]
```

Ids only: the app keeps its `GET /restaurants` list (with delivery details for
the customer's location) and orders / filters it by these.

### `GET /products/{id}`

Returns `ProductDetailDto` — `ProductSummaryDto` plus `description`,
`descriptionHi`, `status`, `images[]`, `variants[]`, `attributes` and
`categoryPath[]`.

### `GET /products/{id}/related`

Returns `ProductSummaryDto[]`.

### `GET /home`

One call that fills the whole Home screen.

```jsonc
{
  "banners": [{ "id": "…", "imageUrl": "…", "title": "…", "subtitle": "…",
                "actionType": "CATEGORY", "actionValue": "uuid" }],
  "categories": [ ],
  "rails": [{ "key": "DAILY_ESSENTIALS", "title": "Daily Essentials", "products": [ ] }]
}
```

`actionType` ∈ `CATEGORY` | `PRODUCT` | `COUPON` | `NONE`.
`rails[].key` ∈ `POPULAR` | `DAILY_ESSENTIALS` | `BEST_SELLERS` |
`RECENTLY_ADDED` | `OFFERS`.

### `POST /products/{variantId}/notify-me`

**Authenticated.** Back-in-stock subscription for the out-of-stock screen —
there is nobody to notify otherwise. **204.**

---

## 12. Cart

All cart endpoints require authentication and `cart:manage`. The cart lives on
the server, and **every read revalidates it** against live price, stock and
limits, reporting what changed rather than silently altering it.

### `GET /cart`

```jsonc
{
  "id": "uuid",
  "items": [{
    "id": "uuid", "variantId": "uuid", "productId": "uuid",
    "productName": "Aashirvaad Atta", "variantName": "5 kg", "brandName": "Aashirvaad",
    "imageUrl": "…", "qty": 2,
    "mrpPaise": 28000, "unitPricePaise": 25500,
    "lineTotalPaise": 51000, "lineDiscountPaise": 5000,
    "inStock": true, "availableQty": 12, "maxQtyPerOrder": 10, "allowCod": true
  }],
  "bill": {
    "itemCount": 2,
    "itemsSubtotalPaise": 51000,
    "itemDiscountPaise": 5000,
    "couponCode": null,
    "couponDiscountPaise": 0,
    "deliveryFeePaise": 0,
    "deliveryFeeWaivedReason": "Free delivery on orders above ₹299",
    "platformFeePaise": 500,
    "taxPaise": 2430,
    "totalPaise": 51500,
    "totalSavingsPaise": 5000
  },
  "changes": [],
  "checkoutEnabled": true,
  "checkoutBlockedReason": null,
  "minOrderValuePaise": 9900,
  "shortfallPaise": 0
}
```

`changes[]` are corrections the server applied during revalidation, rendered by
the app as a notice strip:

| `type` | Meaning |
|---|---|
| `ITEM_REMOVED_UNAVAILABLE` | The product is no longer sellable |
| `ITEM_REMOVED_OUT_OF_STOCK` | Stock reached zero |
| `QTY_REDUCED_STOCK` | Reduced to available stock |
| `QTY_REDUCED_LIMIT` | Reduced to `maxQtyPerOrder` |
| `PRICE_INCREASED` / `PRICE_DECREASED` | Price moved since the item was added |
| `COUPON_REMOVED` | The coupon no longer applies |

`taxPaise` is tax **included within** the item prices, extracted for display
only. It is never added on top.

### `POST /cart/items`

```jsonc
{ "variantId": "uuid", "qty": 1 }     // qty: 1–1000
```

Errors: `ITEM_OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `QTY_LIMIT_EXCEEDED`,
`PRODUCT_UNAVAILABLE`.

### `PATCH /cart/items/{id}`

```jsonc
{ "qty": 3 }     // 0–1000; zero removes the line
```

Zero is what the stepper sends when the customer taps minus on the last unit.

### `DELETE /cart/items/{id}` · `DELETE /cart`

Return the revalidated cart.

### `POST /cart/coupon` · `DELETE /cart/coupon`

```jsonc
{ "code": "WELCOME50" }
```

Errors: `COUPON_INVALID`, `COUPON_EXPIRED`, `COUPON_LIMIT_REACHED`,
`COUPON_MIN_ORDER_NOT_MET`.

---

## 13. Addresses

Authenticated, `address:manage`. Capped by `MAX_ADDRESSES_PER_USER` (default 5).

### `GET /addresses`

Returns `AddressDto[]`, each carrying a **server-computed** `isServiceable` and
`distanceKm`.

### `POST /addresses` → 201 · `PATCH /addresses/{id}` (partial)

```jsonc
{
  "label": "Home",
  "fullName": "Asha Devi",
  "mobile": "9876543210",
  "houseNo": "12",            // optional
  "street": "Gali No 3",      // optional
  "area": "Near Shiv Mandir", // REQUIRED
  "city": "…", "state": "…", "pincode": "123456",
  "landmark": "Opposite the bus stand",   // optional
  "latitude": 25.1, "longitude": 82.3,
  "isDefault": true
}
```

`area` and `landmark` carry more weight than street or house number in this
market — "Near Shiv Mandir, Main Road" often *is* the whole address, and it is
what the rider navigates by. So `area` is required while house number and
street are not.

Errors: `ADDRESS_LIMIT_REACHED`, `VALIDATION_ERROR`.

### `DELETE /addresses/{id}` → 204 · `POST /addresses/{id}/default`

---

## 14. Checkout & orders

### `POST /checkout/quote`

Authenticated, `order:create`. **Side-effect-free**, and runs the *same* pricing
engine as order creation — it exists so the Review screen renders the server's
bill. The app never computes a total.

```jsonc
// request
{ "addressId": "uuid", "couponCode": "WELCOME50" }

// response
{
  "bill": { },
  "changes": [ ],
  "serviceability": { },
  "codAllowed": false,
  "codBlockedReason": "Cash on Delivery is not available for Fortune Oil 1 L",
  "availablePaymentMethods": ["ONLINE"],
  "etaMinutes": 28, "etaMinMinutes": 25, "etaMaxMinutes": 35
}
```

`codBlockedReason` names the item blocking COD, so the UI can explain rather
than hide.

**COD resolution** — first non-`INHERIT` wins:

```
storeVariant → productVariant → product → category (leaf…root) → store → DEFAULT_COD_POLICY
```

Order-level eligibility is the **AND** of every resolved line item, plus the
store policy, plus `COD_MAX_ORDER_VALUE_PAISE` and (on a first order)
`COD_FIRST_ORDER_MAX_PAISE`. Most restrictive wins.

### `POST /orders`

Authenticated, `order:create`. **Requires `Idempotency-Key`.**

```jsonc
{
  "addressId": "uuid",
  "paymentMethod": "COD",              // COD | ONLINE
  "couponCode": null,
  "notes": "Please call on arrival",
  "expectedTotalPaise": 51500          // optional safety check
}
```

**201.** `expectedTotalPaise` is a safety check only: if it disagrees with the
server's recomputed total the order is rejected with `PRICE_CHANGED` so the
customer re-confirms. It is **never** used as the charged amount.

The order is created in a database transaction with row-level locking on the
inventory rows. For `ONLINE`, stock is reserved and the order starts at
`PENDING_PAYMENT` with a reservation that expires after
`PAYMENT_HOLD_MINUTES`. For `COD`, it goes straight to `ORDER_PLACED`.

Errors: `CART_EMPTY`, `PRICE_CHANGED`, `MIN_ORDER_NOT_MET`, `COD_NOT_ALLOWED`,
`ADDRESS_NOT_SERVICEABLE`, `OUT_OF_SERVICE_AREA`, `STORE_CLOSED`,
`INSUFFICIENT_STOCK`, `IDEMPOTENCY_KEY_REQUIRED`, `ORDER_IN_PROGRESS`.

### `GET /orders`

Authenticated, `order:read_own`. Cursor-paginated `OrderSummaryDto`.

| Query | Notes |
|---|---|
| `status` | An `OrderStatus` |
| `cursor` | ISO-8601 datetime |
| `limit` | ≤ 100, default 20 |

```jsonc
{
  "id": "uuid", "orderNumber": "ADI-2026-000123",
  "status": "OUT_FOR_DELIVERY", "statusLabel": "Out for Delivery",
  "bucket": "ONGOING",
  "paymentMethod": "COD", "paymentStatus": "PENDING",
  "totalPaise": 51500, "itemCount": 2,
  "itemThumbnails": ["…"],
  "placedAt": "2026-08-15T09:30:00.000Z", "deliveredAt": null
}
```

### `GET /orders/{id}`

Authenticated, `order:read_own`. **Ownership is enforced in the service**, not
by the route guard. Returns `OrderDetailDto` — the summary plus `items[]`,
`bill`, `deliveryAddress`, `distanceKm`, `etaMinutes`, `promisedAt`,
`timeline[]`, `cancellationReason`, `canCancel`, `deliveryAgent`,
`deliveryOtp` and `notes`.

`timeline[]` is the five-step customer view:

```jsonc
[{ "step": "PLACED",           "label": "Order Placed",     "status": "COMPLETED",   "at": "…" },
 { "step": "CONFIRMED",        "label": "Order Confirmed",  "status": "COMPLETED",   "at": "…" },
 { "step": "PACKED",           "label": "Order Packed",     "status": "IN_PROGRESS", "at": null },
 { "step": "OUT_FOR_DELIVERY", "label": "Out for Delivery", "status": "PENDING",     "at": null },
 { "step": "DELIVERED",        "label": "Delivered",        "status": "PENDING",     "at": null }]
```

Twelve internal statuses map onto these five steps. In an exception state
(`PENDING_PAYMENT`, `PAYMENT_FAILED`, `CANCELLED`, `REJECTED`, `REFUNDED`) the
step is `null` and the UI shows a banner instead of a progress timeline.

`deliveryOtp` is shown to the customer to read out at the door on COD orders.

### `POST /orders/{id}/cancel`

Authenticated, `order:cancel_own`.

```jsonc
{ "reason": "Ordered by mistake" }
```

Self-service cancellation is permitted up to `CANCELLATION_ALLOWED_UNTIL`
(default `PREPARING`). Beyond that: `ORDER_NOT_CANCELLABLE`.

### Order state machine

```
PENDING_PAYMENT ──► PAYMENT_CONFIRMED ──► ORDER_PLACED ──► STORE_ACCEPTED
       │                                       │                  │
       ├─► PAYMENT_FAILED                      ├─► REJECTED       ▼
       └─► CANCELLED                           └─► CANCELLED   PREPARING
                                                                  │
                          READY_FOR_PICKUP ◄──────────────────────┘
                                 │
                                 ▼
                        OUT_FOR_DELIVERY ──► DELIVERED

CANCELLED ──► REFUNDED          REJECTED ──► REFUNDED
```

Terminal: `DELIVERED`, `CANCELLED`, `PAYMENT_FAILED`, `REJECTED`, `REFUNDED`.

Who may perform each transition:

| Transition | Actors |
|---|---|
| `PENDING_PAYMENT → PAYMENT_CONFIRMED` / `PAYMENT_FAILED` | `SYSTEM`, `PAYMENT_WEBHOOK` |
| `PENDING_PAYMENT → CANCELLED` | `CUSTOMER`, `SYSTEM` |
| `PAYMENT_CONFIRMED → ORDER_PLACED` | `SYSTEM`, `PAYMENT_WEBHOOK` |
| `ORDER_PLACED → STORE_ACCEPTED` / `REJECTED` | `ADMIN` |
| `ORDER_PLACED → CANCELLED` | `CUSTOMER`, `ADMIN` |
| `STORE_ACCEPTED → PREPARING` | `ADMIN` |
| `STORE_ACCEPTED → CANCELLED` | `CUSTOMER`, `ADMIN` |
| `PREPARING → READY_FOR_PICKUP` / `CANCELLED` | `ADMIN` |
| `READY_FOR_PICKUP → OUT_FOR_DELIVERY` | `ADMIN`, `DELIVERY_AGENT` |
| `READY_FOR_PICKUP → CANCELLED` | `ADMIN` |
| `OUT_FOR_DELIVERY → DELIVERED` | `ADMIN`, `DELIVERY_AGENT` |
| `OUT_FOR_DELIVERY → CANCELLED` | `ADMIN` only |
| `CANCELLED`/`REJECTED` → `REFUNDED` | `SYSTEM`, `PAYMENT_WEBHOOK` |

`OUT_FOR_DELIVERY → CANCELLED` is admin-only because it is an exception path
(customer unreachable, address wrong) requiring a reason and a manual decision
about the goods. Anything without an explicit entry is system-only — it fails
closed, never open.

---

## 15. Payments

Three provider modes, selected by `PAYMENT_PROVIDER`:

| Mode | Behaviour |
|---|---|
| `mock` | Dev stub, deterministic signatures, no network calls. Blocked in production |
| `upi_intent` | Pay directly to the shop's VPA via a `upi://` deep link. **No callback exists** — the store confirms each payment in the panel |
| `razorpay` | Full gateway: client verification, webhooks, automatic refunds |

### `POST /payments/create`

Authenticated, `order:create`. **Requires `Idempotency-Key`** — a double-tap on
"Pay" must not create two provider orders and two chances to be charged.

```jsonc
// request
{ "orderId": "uuid" }

// response
{
  "paymentId": "uuid",
  "provider": "upi_intent",
  "providerOrderId": "…",
  "publicKey": "…",
  "amountPaise": 51500,
  "currency": "INR",
  "prefill": { "name": "Asha Devi", "email": null, "contact": "9876543210" },

  "upiIntentUrl": "upi://pay?pa=shop@ybl&pn=AdiOne&am=515.00&tn=ADI-2026-000123&cu=INR",
  "upiVpa": "shop@ybl",
  "requiresManualConfirmation": true
}
```

`requiresManualConfirmation` is `true` when no gateway will confirm the
payment. The app must then show "I have paid" and tell the customer the store
will verify — waiting for a callback that never comes leaves them staring at a
spinner.

### `POST /payments/verify`

Authenticated. The gateway's client-side callback.

```jsonc
{
  "orderId": "uuid",
  "providerOrderId": "…",
  "providerPaymentId": "…",
  "signature": "…"
}
```

```jsonc
{ "verified": true, "orderStatus": "ORDER_PLACED", "paymentStatus": "PAID" }
```

The signature is verified server-side and the amount is checked against the
order. Errors: `PAYMENT_VERIFICATION_FAILED`, `PAYMENT_AMOUNT_MISMATCH`,
`PAYMENT_ALREADY_CAPTURED`.

### `POST /payments/claim`

Authenticated. The customer says they paid by UPI.

```jsonc
{ "orderId": "uuid", "utr": "123456789012" }   // 12 digits, optional
```

This **records the claim and puts the order in the store's verification queue.
It confirms nothing** — accepting a self-reported payment would hand out goods
for free. The UTR is optional because plenty of customers will not find it, and
refusing the claim over a missing reference just moves the problem to a phone
call.

### `GET /payments/{orderId}/status`

Authenticated, scoped to the caller's own order.

```jsonc
{ "status": "PENDING_PAYMENT", "paymentStatus": "PENDING", "totalPaise": 51500 }
```

Returns `null` if no such order belongs to the caller.

### `POST /payments/webhook`

**Public and unauthenticated** — the payment provider has no token.
Authenticity comes from an HMAC over the **raw** body.

`express.raw()` is mounted for this path *above* the JSON parser: signatures are
computed over the exact bytes, and a parsed-then-re-serialised body changes key
order and whitespace, so the signature would never verify.

Errors: `WEBHOOK_SIGNATURE_INVALID`.

### Settlement paths

There are three, because each can fail independently:

1. The client callback (`/payments/verify`)
2. The provider webhook (`/payments/webhook`)
3. A background reconciliation job that polls the provider for orders that are
   still unpaid — covering the case where the customer paid but neither the
   callback nor the webhook arrived

---

## 16. Notifications & devices

### `GET /notifications`

Authenticated. Returns `NotificationDto[]`.

```jsonc
{
  "id": "uuid", "type": "ORDER_OUT_FOR_DELIVERY",
  "title": "On the way", "body": "Your order is out for delivery.",
  "orderId": "uuid", "readAt": null, "createdAt": "…"
}
```

### `POST /notifications/{id}/read` → 204

### `POST /devices`

Authenticated. Registers a push token. Upserted **on the token**, so a
reinstall moves it to the new user rather than leaving the previous customer's
order updates going to a shared phone.

```jsonc
{ "token": "…", "platform": "ANDROID", "appVersion": "1.0.0" }
```

**204.**

---

## 17. Admin — dashboard & orders

Everything under `/admin` is gated by `authenticate` + a staff role + the
`api:user` rate limit, and each route additionally declares the specific
permission it needs.

### `GET /admin/dashboard`

`dashboard:read`.

```jsonc
{
  "todayOrderCount": 18, "todayRevenuePaise": 942500,
  "totalOrderCount": 1240, "totalRevenuePaise": 61200000,
  "ordersByStatus": [{ "status": "ORDER_PLACED", "count": 3 }],
  "pendingOrderCount": 3, "completedTodayCount": 12, "cancelledTodayCount": 1,
  "lowStockCount": 4,
  "lowStockItems": [{
    "storeVariantId": "uuid", "productName": "…", "variantName": "1 kg",
    "availableQty": 2, "lowStockThreshold": 5
  }]
}
```

### `GET /admin/orders`

`order:read_all`. Cursor-paginated `AdminOrderSummaryDto`.

| Query | Notes |
|---|---|
| `tab` | See the tab table below |
| `search` | ≤ 60 characters — order number, customer name or mobile |
| `cursor` | ISO-8601 datetime |
| `limit` | ≤ 100, default 25 |

| Tab | Statuses |
|---|---|
| `PAYMENT_PENDING` | `PENDING_PAYMENT` |
| `NEW` | `ORDER_PLACED` |
| `ACCEPTED` | `STORE_ACCEPTED` |
| `PREPARING` | `PREPARING` |
| `READY` | `READY_FOR_PICKUP` |
| `OUT_FOR_DELIVERY` | `OUT_FOR_DELIVERY` |
| `COMPLETED` | `DELIVERED` |
| `CANCELLED` | `CANCELLED`, `REJECTED`, `PAYMENT_FAILED`, `REFUNDED` |

`PAYMENT_PENDING` only matters with direct-UPI payments, where no gateway
confirms anything — without the tab those orders would be invisible until they
expired.

`AdminOrderSummaryDto` adds `customerName`, `customerMobile`, `distanceKm`,
`addressSummary`, `deliveryAgentName`, `minutesSincePlaced` and:

```jsonc
"paymentClaim": { "utr": "123456789012", "claimedAt": "…" }
```

set when a customer has claimed a direct-UPI payment the store has not yet
confirmed. The UTR is what the shopkeeper matches against their own UPI app —
without it they are searching by amount and time alone.

### `GET /admin/orders/{id}`

`order:read_all`. Full order detail with customer, address, items, bill,
payment history and status history.

### `PATCH /admin/orders/{id}/status`

`order:update_status`. **204.**

```jsonc
{
  "toStatus": "OUT_FOR_DELIVERY",
  "reason": "…",                    // required for rejections and cancellations
  "deliveryOtp": "1234",            // required to deliver a COD order when DELIVERY_OTP_REQUIRED_FOR_COD
  "cashCollectedPaise": 51500       // COD settlement
}
```

Validated against the state machine and the actor table. Errors:
`INVALID_STATUS_TRANSITION`, `DELIVERY_AGENT_REQUIRED` (before
`OUT_FOR_DELIVERY`), `DELIVERY_OTP_INVALID`.

### `POST /admin/orders/{id}/assign`

`delivery:assign`.

```jsonc
{ "agentId": "uuid" }
```

### `POST /admin/orders/{id}/confirm-payment`

`order:update_status`. **204.** The store has seen the money in its UPI app.

```jsonc
{ "reference": "123456789012" }     // optional
```

Deliberately admin-only, so nothing a customer sends can reach it.

### `POST /admin/orders/{id}/refund`

`order:refund`.

```jsonc
{ "reason": "Item unavailable after acceptance" }
```

Errors: `REFUND_FAILED`.

---

## 18. Admin — catalogue

All routes require `catalog:write` unless noted.

| Method | Path | Body / notes |
|---|---|---|
| `POST` | `/admin/categories` | → 201 |
| `PATCH` | `/admin/categories/{id}` | Partial → 204 |
| `DELETE` | `/admin/categories/{id}` | → 204 |
| `POST` | `/admin/products` | → 201 |
| `PATCH` | `/admin/products/{id}` | Partial → 204 |
| `DELETE` | `/admin/products/{id}` | → 204 |
| `POST` | `/admin/variants` | → 201 |
| `DELETE` | `/admin/variants/{id}` | → 204 |
| `POST` | `/admin/uploads/presign` | Returns an upload target |
| `PUT` | `/admin/uploads/direct?key=…` | **Local dev only**; raw `image/*` body |
| `POST` | `/admin/product-images` | Attach an uploaded image → 201 |
| `DELETE` | `/admin/product-images/{id}` | → 204 |

**Category body**

```jsonc
{
  "name": "Grocery", "nameHi": "किराना",
  "parentId": null, "imageUrl": "…", "displayOrder": 1, "isActive": true,
  "vertical": "GROCERY",         // future behaviour branches on this, never on a name
  "allowCod": "INHERIT"
}
```

**Product body**

```jsonc
{
  "name": "Aashirvaad Atta", "nameHi": null,
  "categoryId": "uuid", "brandId": null,
  "description": "…", "descriptionHi": null,
  "searchKeywords": ["atta", "flour", "gehu"],   // ≤ 30 entries
  "taxRateBp": 500,          // basis points: 5% GST = 500. Capped at 10000
  "hsnCode": "1101",
  "allowCod": "INHERIT",
  "status": "ACTIVE",
  "attributes": { "shelfLife": "6 months" },
  "isDailyEssential": true,
  "popularityScore": 120
}
```

`taxRateBp` is in **basis points** and capped at 100% to catch a percent/bp
mix-up.

**Variant body**

```jsonc
{
  "productId": "uuid", "sku": "ATTA-5KG", "variantName": "5 kg",
  "unit": "KG", "unitValue": 5,
  "isDefault": true, "displayOrder": 1, "allowCod": "INHERIT",
  "mrpPaise": 28000, "pricePaise": 25500,
  "stockQty": 20, "maxQtyPerOrder": 10, "lowStockThreshold": 5
}
```

### Image upload flow

```
POST /admin/uploads/presign   { fileName, contentType }
   → { uploadUrl, key, headers, expiresInSeconds }

PUT  <uploadUrl>   (raw bytes, with the returned headers)

POST /admin/product-images    { productId, variantId?, key, altText? }   → 201
```

Bytes go straight to object storage and never through the API's JSON body. In
production the presigned URL points at S3-compatible storage and
`/admin/uploads/direct` is never called; locally the presign returns that route
instead, so the same client flow works with no storage service installed.

Accepted content types: `image/jpeg`, `image/png`, `image/webp`, `image/avif`.
Errors: `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`.

---

## 19. Admin — inventory

| Method | Path | Permission | Body |
|---|---|---|---|
| `PATCH` | `/admin/store-variants/{id}/stock` | `inventory:write` | `{ "stockQty": 20, "note": "…" }` → 204 |
| `PATCH` | `/admin/store-variants/{id}/availability` | `inventory:write` | `{ "isAvailable": true }` → 204 |
| `PATCH` | `/admin/store-variants/{id}/pricing` | `inventory:write` | `{ "pricePaise": 25500, "mrpPaise": 28000 }` → 204 |
| `PATCH` | `/admin/store-variants/{id}/limits` | `inventory:write` | `{ "maxQtyPerOrder": 10, "lowStockThreshold": 5 }` → 204 |
| `GET` | `/admin/inventory/low-stock` | `inventory:read` | Items at or below their threshold |
| `GET` | `/admin/store-variants/{id}/ledger` | `inventory:read` | Stock movement history |

Every change to stock writes one ledger row, with a reason:

`PURCHASE` · `MANUAL_ADJUST` · `ORDER_RESERVE` · `ORDER_RELEASE` ·
`ORDER_COMMIT` · `ORDER_CANCEL_RESTOCK` · `DAMAGE` · `EXPIRY` · `RETURN`

The ledger is the audit trail: current stock and the sum of its movements must
always agree.

---

## 20. Admin — delivery

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/admin/delivery-agents` | `delivery_agent:read` | `DeliveryAgentDto[]` |
| `POST` | `/admin/delivery-agents` | `delivery_agent:write` | → 201 |
| `PATCH` | `/admin/delivery-agents/{id}` | `delivery_agent:write` | Partial → 204 |
| `DELETE` | `/admin/delivery-agents/{id}` | `delivery_agent:write` | → 204 |
| `GET` | `/admin/delivery/cash-summary` | `delivery_agent:read` | `?from=&to=` (ISO dates; defaults to the last 24 h) |

**Agent body**

```jsonc
{ "name": "Ramesh", "mobile": "9876543210", "vehicleNumber": "UP65 AB 1234" }
```

`PATCH` additionally accepts `isActive` and `isAvailable`.

**Cash summary**

```jsonc
[{ "agentId": "uuid", "agentName": "Ramesh", "orderCount": 7, "cashPaise": 384500 }]
```

Counts only `DELIVERED` assignments in the window.

---

## 21. Admin — store & configuration

### `PATCH /admin/store`

`config:write`. Updates the store's location and details. Moving the pin moves
the serviceability circle, so it is treated as a configuration change.

```jsonc
{
  "latitude": 25.1, "longitude": 82.3,
  "name": "…", "addressLine": "…", "city": "…", "state": "…",
  "pincode": "123456", "phone": "…"
}
```

Latitude and longitude are required; the rest are optional.

### `GET /admin/store/availability`

`config:write`. The trading switch and the full weekly schedule — the two
things the availability card on the Configuration page edits.

Always returns **seven** days, Sunday (`0`) through Saturday (`6`); a day with
no row is reported closed rather than omitted. Unlike `GET /store`, it answers
while the store is switched off, which is what makes the switch reversible.

```jsonc
{
  "isActive": true,
  "isOpenNow": true,
  "timezone": "Asia/Kolkata",
  "hours": [
    { "dayOfWeek": 0, "opensAt": "08:00", "closesAt": "22:00", "isClosed": false }
    // … one entry per day
  ],
  "nextOpenText": "Opens tomorrow at 8:00 AM"
}
```

`nextOpenText` is `null` while the store is open or switched off.

### `PATCH /admin/store/status`

`config:write`. The on/off switch. Takes effect on the next request — nothing
caches the store row. Audited as `store.pause_trading` / `store.resume_trading`.

```jsonc
{ "isActive": false }
```

Returns the same payload as `GET /admin/store/availability`.

Switching off does not hide the catalogue; it stops orders being accepted and
reports the store closed. It is checked **before** `ALLOW_ORDERS_WHEN_CLOSED`,
so that config cannot be used to order around a switched-off store.

### `PATCH /admin/store/hours`

`config:write`. Sets opening and closing times. Audited as
`store.update_hours`.

```jsonc
{
  "hours": [
    { "dayOfWeek": 1, "opensAt": "08:00", "closesAt": "22:00", "isClosed": false }
  ]
}
```

Partial by design — one to seven entries, and a day not listed is left exactly
as it was. "Apply these hours to every day" and "Sunday is now closed" are the
same call with a different number of entries.

Times are `HH:mm`, 24-hour, in the store's timezone. `closesAt` earlier than
`opensAt` is a window across midnight (`08:00`–`01:00` is a 17-hour day); the
two being equal means open 24 hours. A day listed twice is rejected with
`VALIDATION_ERROR`. Returns the same payload as `GET /admin/store/availability`.

### `GET /admin/config`

`config:read`. Every key, resolved value, description and whether it has been
overridden for this store.

```jsonc
[{
  "key": "MAX_SERVICE_RADIUS_KM",
  "value": 10,
  "description": "Maximum straight-line delivery distance from the store, in km.",
  "isPublic": true,
  "isOverridden": false
}]
```

### `PATCH /admin/config`

`config:write`.

```jsonc
{ "key": "DELIVERY_FEE_SLABS", "value": [{ "maxKm": 3, "feePaise": 2000 }] }
```

The value is validated **per key** — a malformed fee slab or a negative radius
would otherwise silently corrupt every price.

### Configuration keys

Money is in paise throughout.

| Key | Default | Meaning |
|---|---|---|
| `MAX_SERVICE_RADIUS_KM` | `10` | Straight-line delivery limit |
| `ROAD_DISTANCE_FACTOR` | `1.3` | Straight-line → road multiplier, for ETA and fee only |
| `STORE_TIMEZONE` | `Asia/Kolkata` | Used to evaluate opening hours |
| `ALLOW_ORDERS_WHEN_CLOSED` | `false` | |
| `STORE_GSTIN` | `""` | When set, receipts show a tax invoice breakdown |
| `MIN_ORDER_VALUE_PAISE` | `9900` | ₹99 |
| `DELIVERY_FEE_SLABS` | `[{3,₹20},{6,₹30},{10,₹40}]` | First slab covering the distance wins |
| `FREE_DELIVERY_THRESHOLD_PAISE` | `29900` | ₹299 |
| `PLATFORM_FEE_PAISE` | `500` | ₹5; `0` hides the line |
| `DEFAULT_COD_POLICY` | `ALLOW` | Fallback when no rule applies |
| `COD_MAX_ORDER_VALUE_PAISE` | `300000` | ₹3,000 |
| `COD_FIRST_ORDER_MAX_PAISE` | `100000` | ₹1,000 on a first order |
| `BASE_PREPARATION_MINUTES` | `10` | |
| `PER_ITEM_PICK_SECONDS` | `20` | |
| `AVG_DELIVERY_SPEED_KMPH` | `25` | |
| `ORDERS_PER_RIDER_BATCH` | `3` | Active orders before ETA extends |
| `BATCH_DELAY_MINUTES` | `8` | Added per extra batch |
| `ETA_BUFFER_MINUTES` | `3` | |
| `PAYMENT_HOLD_MINUTES` | `10` | How long stock stays reserved for an unpaid order |
| `CANCELLATION_ALLOWED_UNTIL` | `PREPARING` | Last status a customer may self-cancel at |
| `DEFAULT_MAX_QTY_PER_ORDER` | `10` | |
| `MAX_ADDRESSES_PER_USER` | `5` | |
| `LOW_STOCK_THRESHOLD` | `5` | |
| `DELIVERY_OTP_REQUIRED_FOR_COD` | `true` | |
| `FEATURE_REFERRAL_ENABLED` | `false` | |
| `FEATURE_COUPONS_ENABLED` | `true` | |
| `FEATURE_RATINGS_ENABLED` | `false` | |
| `FEATURE_WISHLIST_ENABLED` | `false` | |
| `SUPPORT_PHONE` / `SUPPORT_WHATSAPP` / `SUPPORT_EMAIL` | | Shown on Help & Support |
| `DELIVERY_PROMISE_TEXT` | `in 30 minutes` | Marketing copy only; the per-order ETA is always computed |

The literal `10` for the service radius appears in exactly one place in the
repository — `CONFIG_DEFAULTS.MAX_SERVICE_RADIUS_KM` — which the seed writes
into the database once. Nothing in the API, the panel or the app hardcodes any
of these.

---

## 22. Realtime events

Socket.IO on the API origin, path `/socket.io`, transports `['polling',
'websocket']` in that order. Some Indian mobile networks and corporate proxies
block websocket upgrades outright, and falling back silently is better than a
dead tracking screen.

### Handshake

```js
io(SOCKET_URL, { auth: { token: accessToken }, transports: ['polling', 'websocket'] })
```

Sockets are authenticated exactly like HTTP requests — an expired token is
rejected with `unauthenticated`, so it cannot leak another customer's order
updates. The token may also be sent as `Authorization: Bearer …` on the
handshake headers.

### Rooms

| Room | Joined |
|---|---|
| `user:{userId}` | Automatically, on connect |
| `store:{storeId}` | By emitting `store:subscribe` with the store id — **staff roles only**; a non-staff attempt is logged and ignored |

### Server → client

| Event | Payload | Sent to |
|---|---|---|
| `order.status_changed` | `{ orderId, orderNumber, status, statusLabel, etaMinutes? }` | The customer's `user:` room, and the `store:` room |
| `order.created` | Same shape | The `store:` room |

The panel plays a repeating chime on `order.created` until acknowledged — a
missed new order is the single most costly failure at the counter.

### Client → server

| Event | Payload |
|---|---|
| `store:subscribe` | `storeId: string` |

> **Realtime is an optimisation, never the only path.** Both clients also poll
> (the app every 30 s while an order is live, the panel every 20 s). A dropped
> socket must never cause the store to miss an order.

---

## 23. Enumerations

Declared once in [`backend/src/shared/enums.ts`](../backend/src/shared/enums.ts)
and mirrored into both clients. No status string is ever typed as a literal
anywhere else.

| Enum | Values |
|---|---|
| `UserRole` | `CUSTOMER` `ADMIN` `STORE_OWNER` · reserved: `SUPER_ADMIN` `STORE_MANAGER` `DELIVERY_AGENT` `STAFF` `PHARMACIST` `RESTAURANT_MANAGER` |
| `UserStatus` | `ACTIVE` `BLOCKED` `DELETED` |
| `CatalogVertical` | `GROCERY` `VEGETABLES` `FRUITS` `DAIRY` `CAFE` `FOOD` `PHARMACY` `CLOTHING` `ELECTRONICS` `HOUSEHOLD` `OTHER` |
| `ProductStatus` | `DRAFT` `ACTIVE` `INACTIVE` `ARCHIVED` |
| `UnitType` | `G` `KG` `ML` `L` `PIECE` `PACK` `DOZEN` `BUNDLE` |
| `CodPolicy` | `ALLOW` `DENY` `INHERIT` |
| `OrderStatus` | `PENDING_PAYMENT` `PAYMENT_CONFIRMED` `ORDER_PLACED` `STORE_ACCEPTED` `PREPARING` `READY_FOR_PICKUP` `OUT_FOR_DELIVERY` `DELIVERED` `CANCELLED` `PAYMENT_FAILED` `REJECTED` `REFUNDED` |
| `PaymentMethod` | `ONLINE` `COD` |
| `OrderPaymentStatus` | `PENDING` `PAID` `FAILED` `REFUNDED` `PARTIALLY_REFUNDED` |
| `PaymentStatus` | `CREATED` `PENDING` `AUTHORIZED` `CAPTURED` `FAILED` `REFUNDED` `PARTIALLY_REFUNDED` |
| `RefundStatus` | `PENDING` `PROCESSING` `COMPLETED` `FAILED` |
| `ActorType` | `CUSTOMER` `ADMIN` `DELIVERY_AGENT` `SYSTEM` `PAYMENT_WEBHOOK` |
| `CancelledBy` | `CUSTOMER` `ADMIN` `SYSTEM` |
| `StockLedgerReason` | `PURCHASE` `MANUAL_ADJUST` `ORDER_RESERVE` `ORDER_RELEASE` `ORDER_COMMIT` `ORDER_CANCEL_RESTOCK` `DAMAGE` `EXPIRY` `RETURN` |
| `DeliveryAssignmentStatus` | `ASSIGNED` `ACCEPTED` `PICKED_UP` `DELIVERED` `CANCELLED` |
| `NotificationType` | `ORDER_PLACED` `ORDER_ACCEPTED` `ORDER_REJECTED` `ORDER_PREPARING` `ORDER_READY` `ORDER_OUT_FOR_DELIVERY` `ORDER_DELIVERED` `ORDER_CANCELLED` `PAYMENT_FAILED` `PAYMENT_SUCCESS` `REFUND_INITIATED` `REFUND_COMPLETED` `BACK_IN_STOCK` |
| `NotificationChannel` | `PUSH` `SMS` `WHATSAPP` `EMAIL` `IN_APP` |
| `NotificationStatus` | `QUEUED` `SENT` `FAILED` `READ` |
| `DevicePlatform` | `ANDROID` `IOS` `WEB` |
| `CouponType` | `PERCENT` `FLAT` `FREE_DELIVERY` |
| `IdempotencyStatus` | `IN_PROGRESS` `COMPLETED` |
| `CustomerTimelineStep` | `PLACED` `CONFIRMED` `PACKED` `OUT_FOR_DELIVERY` `DELIVERED` |
| `OrderBucket` | `ONGOING` `DELIVERED` `CANCELLED` |
| `AdminOrderTab` | `PAYMENT_PENDING` `NEW` `ACCEPTED` `PREPARING` `READY` `OUT_FOR_DELIVERY` `COMPLETED` `CANCELLED` |

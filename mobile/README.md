# AdiOne — Customer Mobile App

The customer-facing app: browse, cart, checkout, pay, track. Built for the
network it actually runs on — rural 3G, mid-range Android, and users for whom
this may be the first delivery app they have installed.

React Native 0.86 · Expo SDK 57 · TypeScript · React Navigation 7 · TanStack Query · Zustand · Socket.IO

- **Technical documentation:** [../docs/07-mobile-technical.md](../docs/07-mobile-technical.md)
- **API reference:** [../docs/04-api-reference.md](../docs/04-api-reference.md)
- **Deployment:** [../docs/06-deployment.md](../docs/06-deployment.md)

---

## Quick start

```bash
npm install
npm start                     # Expo dev server — scan the QR or press "a"
```

Point the app at a running backend by setting `EXPO_PUBLIC_API_URL` in `.env`:

| Target | Value |
|---|---|
| Android emulator | `http://10.0.2.2:4000/api/v1` |
| iOS simulator | `http://localhost:4000/api/v1` |
| Physical device on the same LAN | `http://<your-lan-ip>:4000/api/v1` |
| Tunnel / deployed API | the public base URL + `/api/v1` |

Expo inlines `EXPO_PUBLIC_*` at **build** time, so a change needs
`npx expo start --clear` (or a rebuild), not just a reload.

With the backend on `OTP_PROVIDER=console`, `POST /auth/send-otp` returns the
OTP as `devOtp`, so you can sign in without an SMS provider.

---

## Scripts

| Script | What it does |
|---|---|
| `npm start` | Expo dev server |
| `npm run android` | `expo run:android` — native debug build |
| `npm run ios` | `expo run:ios` |
| `npm run typecheck` | Type check without emitting |
| `npm test` | Jest |

---

## Layout

```
├── App.tsx                    Root — QueryClient, NavigationContainer, auth gate
├── app.json                   Expo config: package id, permissions, plugins
├── eas.json                   EAS build profiles (development / preview / production)
├── plugins/withUpiQueries.js  Declares UPI package visibility in AndroidManifest
└── src/
    ├── navigation/            Bottom tabs + one stack per tab
    ├── screens/
    │   ├── auth/              Splash · MobileEntry · OtpVerify
    │   ├── location/          Location permission and serviceability check
    │   ├── home/              Home feed
    │   ├── catalog/           Categories · Search · ProductDetail
    │   ├── cart/              Cart
    │   ├── checkout/          Checkout · UpiPayment
    │   ├── orders/            OrdersList · OrderTracking
    │   └── account/           Account · PersonalInfo · Addresses · Help · About · Legal
    ├── components/            ProductCard · ProductGallery · ui.tsx
    ├── lib/
    │   ├── api.ts             fetch wrapper: retries, timeouts, refresh, idempotency
    │   ├── queries.ts         TanStack Query hooks and cache keys
    │   ├── store.ts           Zustand — session, location, preferences
    │   ├── useCartActions.ts  Cart mutations with optimistic updates
    │   ├── socket.ts          Live order status
    │   └── push.ts            Push registration
    └── shared/                GENERATED — mirrored from backend/src/shared
```

Path aliases (Babel + tsconfig): `@/…` → `src/…`, `@shared` → the mirrored
contract.

---

## Navigation

Auth state drives navigation, not imperative `navigate` calls — a session
expiring mid-flow lands the customer on login rather than on a screen that
silently fails every request.

```
status = loading         → Loading
status = anonymous       → Auth stack:  Splash → MobileEntry → OtpVerify
status = authenticated   → Location screen (once)  →  MainTabs
```

Each tab owns its own stack, so backing out of a product opened from Search
returns to Search, not to Home. `ProductDetail` is therefore registered in
several stacks — deliberate duplication, and cheaper than a shared modal stack
that breaks the back button.

---

## How it talks to the API

- **GETs retry twice** with exponential backoff **plus jitter** — without
  jitter, every phone that lost signal in the same tunnel retries in lockstep.
- **Mutations never auto-retry.** A retried `POST /orders` is a second order.
  Retrying is a user action, and it reuses the same `Idempotency-Key` so the
  server collapses it.
- **Access token in memory, refresh token in `expo-secure-store`** (Keychain /
  Android Keystore) — never `AsyncStorage`, which is plain text on a rooted
  device.
- **One refresh per 401**, shared by concurrent requests.
- **Status 0 means offline**, and is rendered as "no internet", never as a
  server error.
- **Server messages are shown as-is** — every error carries a stable `code` and
  user-safe copy by contract.
- **Realtime is best-effort.** Screens subscribe to `order.status_changed` *and*
  poll while an order is live, because a socket that dies quietly on a flaky
  network must never be the only way a customer learns their order is out for
  delivery.

The app never computes a price, a total, a delivery fee, an ETA or
serviceability. It asks and displays.

---

## Permissions

| Permission | Why | When asked |
|---|---|---|
| Location (`when in use`) | Serviceability check and ETA | **After** login, not before — a customer who has not yet decided to use the app should not be met with a system dialog |
| Notifications | Order status updates | On first session; declined is fine and never blocks shopping |

`plugins/withUpiQueries.js` adds a `<queries>` entry for the `upi` scheme to
the Android manifest. Without it, Android 11+ makes
`Linking.canOpenURL('upi://pay?…')` return `false` even with GPay, PhonePe and
Paytm installed, and every customer would be told "No UPI app found". It lives
in a config plugin because `expo prebuild --clean` regenerates `android/`.

---

## The shared contract

`src/shared/` is a **generated copy** of `backend/src/shared/`. Do not edit it.
Change the canonical folder and run:

```bash
cd ../backend && npm run sync:shared
```

---

## Builds

```bash
npx eas build --profile preview    --platform android   # internal APK
npx eas build --profile production --platform android   # Play Store AAB
```

Profiles live in `eas.json`; each pins its own `EXPO_PUBLIC_API_URL`.
Application id: `in.adione.app`.

**Play Store note:** `DELETE /auth/me` is wired to the in-app "Delete account"
action because Google Play requires an in-app deletion path and India's DPDP
Act requires erasure on request. The privacy policy is also served as a public
HTML page at `GET /api/v1/legal/privacy/page`, since a screen inside the app
does not satisfy the listing requirement.

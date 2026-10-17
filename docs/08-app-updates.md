# App updates — optional and mandatory

Admin → **App Updates** controls whether customers on an older Aadione app are
asked to update (optional) or must update (mandatory). The policy is stored in
the `configurations` table under `APP_UPDATE_POLICY` — no table or migration of
its own. Shared rules: `backend/src/shared/app-version.ts`.

## Policy rules

Each platform (Android, iOS) has its own latest version, minimum supported
version and store link. For an installed version `v` on one platform:

| Condition | Result |
|---|---|
| Policy off | No prompt, no block |
| `v` unknown or malformed | No prompt, no block (see "apps without a version" below) |
| `v` < minimum supported | **Required** (in either mode) |
| `v` < latest, mode Optional | Optional prompt ("Update Now" / "Later") |
| `v` < latest, mode Mandatory | **Required** — Mandatory means "the latest version is the minimum" |
| otherwise | Normal use |

Versions compare by SemVer precedence, never as strings: `1.0.10` > `1.0.9`,
`1.0` = `1.0.0`, `1.1.0-beta.1` < `1.1.0`, and `+build` metadata is ignored.
Anything that is not a version is rejected, never guessed.

Saving is refused unless every version is valid, the minimum is not newer than
the latest, a minimum has a latest beside it, and each store link is the
official `https://play.google.com/…` / `https://apps.apple.com/…` listing
(required for a platform with versions while the policy is on).

Turning the policy off, or back to Optional, needs no app release; it takes
effect within about a minute (configuration cache 60 s, per-instance memo 5 s).
A policy that cannot be read — database error, or a row that no longer
validates — counts as **off**. A broken setting never locks customers out.

## API

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/app-version/policy?platform=android&version=1.0.8` | public | What this installed app must do (`AppUpdateCheckDto`). Platform and version may also come from the headers below. Never version-gated. |
| `GET /api/v1/admin/app-update-policy` | `CONFIG_READ` | The saved policy and when it last changed |
| `PUT /api/v1/admin/app-update-policy` | `CONFIG_WRITE` | Replace the policy. Validated, audited (`app_update_policy.update`, before/after), effective immediately |

The generic `PATCH /admin/config` applies the same validation to this key.

## Server-side enforcement

The app sends on every request:

```
X-App-Platform: android | ios
X-App-Version:  1.0.8      (installed marketing version)
X-App-Build:    9          (Android versionCode / iOS buildNumber; informational)
```

`middleware/appVersion.ts` runs on the customer routers `/cart`, `/addresses`,
`/checkout`, `/orders`, `/payments`, `/referrals` and `/rewards`. A request whose
version is **Required** gets HTTP **426** with `error.code = APP_UPDATE_REQUIRED`
and `error.details[0].update` (the same `AppUpdateCheckDto`). The app switches to
its update screen on that answer wherever it came from.

Never gated:

- `/auth`, `/config`, `/app-version`;
- catalogue, restaurants, offers and banners;
- `/notifications`, `/devices`;
- `/admin/*`, `/seller/*`, `/health`;
- payment recovery: `POST /payments/webhook`, `POST /payments/verify`,
  `POST /payments/:orderId/refresh` and `GET /payments/:orderId/status`, so money
  already taken can always be verified.

Requests without app headers (the admin and seller panels, gateway webhooks,
integrations) pass untouched.

**Apps without a version.** Builds released before this feature (≤ 1.0.8 today)
send no version and cannot show the update screen. Leave the switch *"Also block
app versions that do not report a version"* off at first. When it is on, a
customer-app session (token scope `customer`) on an enforced route without a
usable version gets the same 426. Its message ("Please update Aadione…") is shown
by those older builds as an ordinary error. Admin and seller sessions are never
affected.

**Limitation.** A modified client can send a fake version. The headers enforce
the policy for genuine apps; they are not an authentication mechanism.

## Mobile behaviour

- The installed version comes from `expo-application` (the native
  versionName / CFBundleShortVersionString), not from the JS bundle.
- **When it checks:** at startup (waits at most 2.5 s, so a required update shows
  before the app), on every return to the foreground (at most once a minute
  unless an update is required), on "I've updated — check again", and on any 426.
- **Required:** `UpdateRequiredScreen` replaces the whole app; no navigator is
  mounted. Android back leaves the app. "Update Now" opens the store
  (`market://` / `itms-apps://`, falling back to the https listing). Opening the
  store does not count as updating: the screen only goes once the server accepts
  the installed version.
- **Optional:** one prompt. "Later" hides it for that release for 3 days; a new
  release asks again.
- **Offline:** the last answer for the same installed version is remembered, so
  going offline cannot skip a required update. With no answer at all, the app is
  not blocked and the server still enforces.

## Release workflow

1. Build a new binary with a higher `expo.version` and a higher
   `android.versionCode` / `ios.buildNumber` in `mobile/app.json` (all three are
   separate). OTA updates are disabled, so a binary release is the only update.
2. Publish it and wait until it is live in the store **for everyone** (staged
   rollouts included).
3. Then, in Admin → App Updates, set the latest version for that platform
   (Optional), or raise the minimum supported version or switch to Mandatory.
4. The iOS App Store link must be added once the iOS app is published. Until then
   iOS has no store link and should have no versions set.

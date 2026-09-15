# Aadione — Official Website

Marketing, category-discovery and legal website for **Aadione**, a local multi-category
everyday-shopping app (groceries, fresh produce, household essentials, personal care,
clothing, electronics and more — not a grocery-only app). This is an informational site
only — it does **not** include cart, checkout, product catalog, or a new backend/database.
It exists to explain the app, drive downloads, and host the required legal and
account-deletion pages for Google Play compliance.

## Tech stack

- React 18 + Vite
- Tailwind CSS
- React Router v6
- lucide-react (icons)

## Getting started

This project's dependencies were **not installed or built** in the environment that
generated it (no network access there), so please run these steps yourself:

```bash
npm install
npm run dev       # start local dev server
npm run build     # production build -> dist/
npm run preview   # preview the production build locally
```

After building, do a full pass: test every route, direct URL access to each route
(especially the legal pages and `/delete-account`), responsive layouts, the FAQ
accordion, and the Delete Account form's loading/success/error states.

## Project structure

```
src/
  config/
    site.js            <- EDIT HERE: brand copy, app store links, contact info,
                          business/legal placeholders, service rules (delivery
                          radius, free-delivery threshold), category list, and
                          deleteAccountApiUrl.
    categoryIcons.js    <- maps category ids to Lucide icons
  lib/
    useSEO.js           <- sets per-page title/meta/canonical tags
  components/           <- shared UI (Navbar, Footer, Button, cards, forms, etc.)
  pages/                <- one file per top-level route
  pages/legal/           <- Privacy Policy, Terms, Cancellation & Refund, Delivery Policy
  App.jsx                <- route definitions
  main.jsx                <- app entry point
public/
  assets/                <- logo, hero illustrations, OG image (SVG placeholders —
                             swap for real brand art any time)
  robots.txt, sitemap.xml, favicon.svg
  _redirects              <- Netlify SPA fallback (direct URL access to every route)
vercel.json                <- Vercel SPA fallback (same purpose, for Vercel deployments)
```

If you deploy somewhere other than Netlify or Vercel (Nginx, Apache, S3+CloudFront,
etc.), add an equivalent rewrite-to-`index.html` rule so that direct links to
`/privacy-policy`, `/delete-account`, etc. work without a server-side 404 — this is
required for Google Play's account-deletion and privacy-policy URL requirements.

## Configuration

Almost everything business-specific lives in `src/config/site.js`:

- `site` — brand name, tagline, description, canonical URL
- `appLinks` — Play Store / App Store URLs (`#` until you have live listings)
- `contact` — support email/phone/address; intentionally blank until you have real,
  confirmed values (the site never displays invented contact details)
- `business` — legal entity name, CIN/GSTIN, registered office, governing-law
  jurisdiction, and "last updated" date for legal pages — bracketed placeholders
  until finalised
- `serviceInfo` — delivery radius (10 km), free-delivery threshold (₹299), and the
  cancellation/COD/delivery-timing copy used across the site. No fixed delivery time
  is claimed anywhere, per the brand's business rules.
- `deleteAccountApiUrl` — point this at the **existing** Aadione backend's
  account-deletion endpoint. Until it's set, the Delete Account form shows a clear
  "not yet connected" message instead of a fake success. If your backend's deletion
  flow needs an extra verification step (e.g. OTP), extend
  `src/components/DeleteAccountForm.jsx` to follow that exact flow — see the comment
  in that file.
- `categories` — the 12 shopping categories shown on Home and the Categories page

## Notes

- No backend, database, admin panel, or new authentication system is included by
  design — this is a static marketing site that talks to the *existing* Aadione
  backend only for account deletion, via `deleteAccountApiUrl`.
- No delivery-time promises, invented pricing rules (e.g. minimum order values or
  small-order fees), or unimplemented features appear anywhere on the site.
- The brand name **"Aadione"** is used consistently everywhere — no variant spellings.
- Replace the SVG placeholder logo/hero art in `public/assets/` with real brand assets
  whenever they're ready.

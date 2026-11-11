# adione.in — information still needed (updated after the functional audit)

These items were found while upgrading the website. None of them was guessed:
where a fact is missing, the site hides it or says only what is verified.

## Resolved

1. **API access from https://adione.in** — now allowed by the production API
   (preflight 204 with `Access-Control-Allow-Origin: https://adione.in`; an unknown
   origin is still refused). Delete Account, categories and delivery areas work
   from the live domain.

## Business details to confirm (Admin → Configuration)

2. **Support hours** are saved as `9 AM – 9 PM,, every day` (two commas). The site
   tidies the display. **Pending owner action:** change it in Admin to
   `9 AM – 9 PM, every day` (it is also used in the app and the legal pages).
3. **Instagram** — owner confirmed `@aadione.in` is official. Admin still holds the
   post URL (`/p/DfeZ89oTfMr/`), which the site hides. **Pending owner action:**
   Admin Panel → Configuration → "Business, Support & Grievance Officer" →
   Social: Instagram → `https://www.instagram.com/aadione.in/` → Save. The site
   shows it automatically (no code change).
4. **WhatsApp** — owner confirmed `9776029985` is active. The website switch is
   removed; the Admin "Support WhatsApp" field is the only source, shown as
   `https://wa.me/919776029985`. (The mobile app's Help screen link still lacks
   the country code — not changed, by instruction.)
5. **Proprietor name** is published as `MADAN KHUNTIA`. Earlier notes spelled it
   "Madan Khunita" — confirm the spelling against the PAN.
6. **GSTIN** (Admin field "Store GSTIN") is empty — shown in the footer
   automatically once entered.
7. **PAN** has no Admin field. Nothing on the site needs it; it is not shown.

## Content to approve or publish

7. **About page** is not published in Admin → Information Pages. Until it is, the
   site shows a short factual About built from verified app behaviour and the
   business settings.
8. **Privacy Policy and Terms**: the API still serves the older built-in text
   (last updated 15 Aug 2026). The reviewed drafts are not published.
9. **Refund and cancellation policy**: there is no separate approved policy; the
   footer links to the cancellation section of the Terms (as before).

## Catalogue and delivery claims

10. **Categories**: only Grocery and Vegetables & Fruits are live (plus two food
    sellers). Electronics, Clothing & Fashion, Beauty & Wellness and Home & Kitchen
    are shown as "As local sellers join". **Ice cream** is not a category or a
    seller type in the app, so it is not shown — tell us if it should be.
11. **Delivery areas** are read live from the approved village + PIN list (21
    villages today), so nothing needs approving — but please check the list in
    Admin is complete.

## Seller data

14. **AS Kitchen cuisine** reads "Burge, Pizza, Momos" — probably "Burger". It is
    shown as entered (seller/admin data).

## Images

12. **App screenshots**: no genuine screenshots of the current app exist in the
    repository. The site uses the official logo, the app icon and the app's own
    category artwork instead. Please provide real screenshots (e.g. from the
    Play / App Store listings) to add a screenshot gallery.
13. Not used on the website because they show third-party brands or products:
    `promo-grocery.png` (Lay's, Amul), `home-banner-daily-essentials.png`
    (Aashirvaad, Tata Salt) and `promo-electronics.png` (Apple-like products).
    Confirm you have rights to these before any public marketing use.

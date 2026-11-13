// ---------------------------------------------------------------------------
// Aadione — central site configuration
// Edit the values below to update content across the entire website.
// Nothing outside this file should need to change for basic rebrand /
// business-detail updates.
// ---------------------------------------------------------------------------

export const site = {
  name: 'Aadione',
  tagline: 'Everything You Need, Delivered.',
  supportingTagline: 'Groceries, essentials and more — all in one place.',
  description:
    'Aadione makes everyday shopping simple and convenient. Shop groceries, fresh produce, daily essentials and more within the supported delivery area.',
  url: 'https://adione.in',
}

// The official store listings — the only download links used anywhere on the
// site (tests/website.test.mjs checks these exact URLs). The QR codes in
// public/badges/ were generated from, and decoded back to, these URLs.
export const appLinks = {
  playStore: 'https://play.google.com/store/apps/details?id=in.adione.app',
  appStore: 'https://apps.apple.com/in/app/aadione/id6817763486',
}

// Contact, business, grievance-officer and social details are NOT kept here.
// They come from Admin Configuration through the public API
// (GET {apiBaseUrl}/legal/business — see src/lib/publicApi.js), exactly as the
// app shows them; an empty setting is hidden, never replaced by a placeholder.
// The legal pages' text, "Last updated" date and version come from the same
// API (GET {apiBaseUrl}/legal/privacy | terms | about).

// General service wording used across Home, How It Works, Features & FAQ.
// No numbers here: the delivery area (approved villages and PIN codes),
// delivery charges, minimum order and free-delivery amount are admin settings
// shown in the app and in the published Terms & Conditions.
export const serviceInfo = {
  model: 'Hyperlocal multi-seller marketplace',
  areaNote:
    'Aadione delivers to the villages and towns shown as served in the app. The app checks your address before you order.',
  deliveryChargeNote:
    'Any delivery charge depends on the distance to your address and is shown in your cart before you pay. Orders above an amount shown in the app may get free delivery.',
  cancellationNote:
    'You can cancel an order in the app until the seller starts preparing it. How a payment for a cancelled order is refunded is explained in the Terms & Conditions.',
  codNote: 'Cash on Delivery is available where it is shown at checkout; it may be limited by order value, seller or product.',
  deliveryTimingNote:
    'Delivery times shown in the app are estimates. They depend on your location, the seller and operational conditions.',
}

// Public base URL of the existing Aadione backend API (same one the mobile
// app and admin web app call). No secrets live here — only a public URL.
//
// The Delete Account page reuses the backend's real, existing auth endpoints
// rather than a bespoke "delete by phone number" API:
//   1. POST {apiBaseUrl}/auth/send-otp    — same OTP used for app sign-in
//   2. POST {apiBaseUrl}/auth/verify-otp  — proves the requester controls the
//      number and returns a short-lived access token
//   3. DELETE {apiBaseUrl}/auth/me        — the SAME account-deletion logic
//      the mobile app's "Delete Account" screen uses, called with that token
//
// This means deletion is never possible from a phone number alone — it
// requires a live OTP proof exactly like logging into the app would.
// VITE_API_BASE_URL (build-time) points a staging or local build elsewhere.
export const apiBaseUrl = import.meta.env?.VITE_API_BASE_URL || 'https://api.adione.in/api/v1'

export const nav = [
  { label: 'Home', to: '/' },
  { label: 'Categories', to: '/categories' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'Delivery Areas', to: '/delivery-areas' },
  { label: 'About', to: '/about' },
  { label: 'Contact', to: '/contact' },
]

export const companyNav = [
  { label: 'About', to: '/about' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'Categories', to: '/categories' },
  { label: 'Delivery Areas', to: '/delivery-areas' },
  { label: 'Download the App', to: '/download' },
  { label: 'Features', to: '/features' },
  { label: 'FAQ', to: '/faq' },
  { label: 'Contact', to: '/contact' },
  { label: 'Support', to: '/support' },
]

// Cancellation, refund and delivery rules are sections of the published
// Terms & Conditions; the old policy addresses redirect there.
export const legalNav = [
  { label: 'Privacy Policy', to: '/privacy-policy' },
  { label: 'Terms & Conditions', to: '/terms-and-conditions' },
  // These pages show the stand-alone policy once published, else the Terms sections.
  { label: 'Cancellations & Refunds', to: '/cancellation-refund-policy' },
  { label: 'Shipping & Delivery', to: '/delivery-policy' },
  { label: 'Contact & Grievance Officer', to: '/contact#grievance-officer' },
  { label: 'Delete Account', to: '/delete-account' },
]

// The kinds of shop the Aadione marketplace is built for (the seller types the
// platform supports). What a customer can actually buy right now is the live
// catalogue, read from the API (useCatalogueCategories); a kind with no live
// category yet is shown as "as local sellers join" — never as available.
// `match` finds a live top-level category for the kind by name.
export const marketplaceKinds = [
  { id: 'grocery', name: 'Grocery & Daily Essentials', description: 'Staples, snacks, oil and ghee, masala, drinks and household needs.', match: /grocery|essential/i },
  { id: 'fruits-vegetables', name: 'Fruits & Vegetables', description: 'Fresh fruits and vegetables from local sellers.', match: /fruit|vegetable/i, image: '/images/fruits-vegetables.webp', imagePosition: 'object-[50%_80%]' },
  { id: 'food', name: 'Food from Local Restaurants', description: 'Meals from local restaurants and cafés, in the Food section of the app.', food: true, image: '/images/restaurants.webp', imagePosition: 'object-[70%_50%]' },
  { id: 'clothing-fashion', name: 'Clothing & Fashion', description: 'Everyday clothing and fashion from local shops.', match: /cloth|fashion|apparel/i, image: '/images/clothing-fashion.webp', imagePosition: 'object-[50%_78%]' },
  { id: 'electronics-accessories', name: 'Electronics & Accessories', description: 'Everyday electronics and accessories from local shops.', match: /electronic|accessor|mobile/i },
  { id: 'beauty-wellness', name: 'Beauty & Wellness', description: 'Beauty and personal-care products from local shops.', match: /beauty|wellness|cosmetic/i },
  { id: 'home-kitchen', name: 'Home & Kitchen', description: 'Kitchenware and everyday home items.', match: /home|kitchen/i },
]

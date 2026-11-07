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

// Replace "#" with your live store listing URLs when ready.
export const appLinks = {
  playStore: '#',
  appStore: '#',
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
    'You can cancel an order in the app until the seller starts preparing it. If you paid online, the amount is refunded to your original payment method.',
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
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'https://api.adione.in/api/v1'

export const nav = [
  { label: 'Home', to: '/' },
  { label: 'About', to: '/about' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'Categories', to: '/categories' },
  { label: 'Features', to: '/features' },
  { label: 'FAQ', to: '/faq' },
  { label: 'Contact', to: '/contact' },
]

export const companyNav = [
  { label: 'About', to: '/about' },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'Categories', to: '/categories' },
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
  { label: 'Cancellations & Refunds', to: '/terms-and-conditions#cancelling-an-order' },
  { label: 'Delivery', to: '/terms-and-conditions#delivery-area-charges-and-timing' },
  { label: 'Delete Account', to: '/delete-account' },
]

// Shopping categories shown on the Home and Categories pages.
// Category availability may vary by location — copy reflects this deliberately.
export const categories = [
  {
    id: 'grocery-food',
    name: 'Grocery & Food',
    description: 'Everyday staples, packaged food and pantry items.',
  },
  {
    id: 'fruits-vegetables',
    name: 'Fruits & Vegetables',
    description: 'Fresh produce sourced for daily needs.',
  },
  {
    id: 'dairy-bakery',
    name: 'Dairy & Bakery',
    description: 'Milk, bread, eggs and bakery favourites.',
  },
  {
    id: 'beverages',
    name: 'Beverages',
    description: 'Everyday drinks, juices and more.',
  },
  {
    id: 'household-essentials',
    name: 'Household Essentials',
    description: 'Cleaning, laundry and home care items.',
  },
  {
    id: 'personal-care',
    name: 'Personal Care',
    description: 'Everyday personal care products.',
  },
  {
    id: 'beauty-wellness',
    name: 'Beauty & Wellness',
    description: 'Skincare, haircare and wellness essentials.',
  },
  {
    id: 'clothing-fashion',
    name: 'Clothing & Fashion',
    description: 'Everyday fashion and apparel.',
  },
  {
    id: 'electronics-accessories',
    name: 'Electronics & Accessories',
    description: 'Everyday electronics and accessories.',
  },
  {
    id: 'home-kitchen',
    name: 'Home & Kitchen',
    description: 'Kitchenware and everyday home items.',
  },
  {
    id: 'daily-essentials',
    name: 'Daily Essentials',
    description: 'The small things you reach for every day.',
  },
  {
    id: 'more',
    name: 'More',
    description: 'A growing range of everyday products.',
  },
]

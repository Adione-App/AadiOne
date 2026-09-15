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

export const contact = {
  supportEmail: 'adione.app@gmail.com',
  phone: '+91 97760 29985',
  address: 'Aadione, Dhan Mandi, Nathdwara Road, Railmagra - 313329, Rajsamand, Rajasthan, India',
  hours: '',
}

// Business / legal details referenced across the legal pages.
// CIN/GSTIN are left bracketed until a real registration number is provided —
// never invent one.
export const business = {
  legalEntityName: 'Aadione',
  brandName: 'Aadione',
  cin: '[CIN / Registration Number]',
  gstin: '[GSTIN]',
  registeredOffice: contact.address,
  jurisdiction: 'Rajsamand, Rajasthan, India',
  grievanceOfficer: {
    name: '[Grievance Officer Name]',
    email: '',
    phone: '',
  },
}

// Per-policy "Last Updated" dates — update the relevant one whenever that
// specific policy's text changes. Keep the format human-readable (e.g. "15
// September 2026") since it is shown directly on each legal page.
export const legalDates = {
  privacyLastUpdated: '15 September 2026',
  termsLastUpdated: '15 September 2026',
  refundLastUpdated: '15 September 2026',
  deliveryLastUpdated: '15 September 2026',
}

// V1 operating parameters — shown across Home, How It Works, Features & FAQ.
// Keep in sync with the values referenced throughout the legal pages.
export const serviceInfo = {
  model: 'Local multi-category shopping platform',
  deliveryRadiusKm: 10,
  freeDeliveryThreshold: 299,
  currency: '₹',
  cancellationNote:
    'Cancellation availability depends on the order status. Once the store accepts an order, cancellation may no longer be available.',
  codNote: 'Cash on Delivery (COD) availability depends on product and order eligibility.',
  deliveryTimingNote:
    'Delivery timing may vary depending on location, order conditions and operational factors.',
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
export const apiBaseUrl = 'https://api.adione.in/api/v1'

// Leave blank to hide a social link in the footer.
export const socials = {
  instagram: '',
  facebook: '',
  twitter: '',
  linkedin: '',
}

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

export const legalNav = [
  { label: 'Privacy Policy', to: '/privacy-policy' },
  { label: 'Terms & Conditions', to: '/terms-and-conditions' },
  { label: 'Cancellation & Refund Policy', to: '/cancellation-refund-policy' },
  { label: 'Delivery Policy', to: '/delivery-policy' },
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

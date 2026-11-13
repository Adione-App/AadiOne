/**
 * ⚠️  GENERATED FILE — DO NOT EDIT.
 *
 * Copied from backend/src/shared by `npm run sync:shared`.
 * Edit the canonical file in backend/src/shared and re-run the sync.
 */

/**
 * Branding & Identity — the brand assets every Aadione surface shows, managed
 * in Admin Panel → Settings → Branding & Identity and published like the
 * Home layout and the legal pages (one `content_documents` key, "branding":
 * draft → publish → archive, with history and restore).
 *
 * TWO KINDS OF ASSET — never confused in the Admin Panel:
 *
 *   dynamic  shown by the apps and websites from GET /api/v1/branding: a
 *            publish reaches the Admin Panel, Seller Panel, website and the
 *            customer app (on its next refresh) without any app release.
 *   build    part of the installed Android / iOS app itself (the launcher
 *            icons). A server can never change an icon on a phone: the
 *            published file is only the SOURCE for the next native build,
 *            and the icon on phones changes when that build is released
 *            (docs/branding-native-assets.md). Never served to the apps.
 *
 * The customer app's native splash is intentionally a blank 1×1 image
 * (mobile/app.json); the logo customers see while the app starts is the app's
 * own startup screen — a DYNAMIC asset here.
 *
 * Every client falls back to its built-in Aadione artwork for anything not
 * published (brandAssetFor), so nothing is ever shown broken or empty.
 *
 * Pure and dependency-free (shared by backend, admin/seller panel, mobile
 * and the website).
 */

export const BRAND_NAME = 'Aadione';

export const BRAND_ASSET_SLOTS = [
  'logo_main',
  'logo_light',
  'logo_dark',
  'favicon',
  'customer_app_logo',
  'customer_splash_logo',
  'seller_app_logo',
  'android_launcher_foreground',
  'android_launcher_background',
  'ios_app_icon',
] as const;
export type BrandAssetSlot = (typeof BRAND_ASSET_SLOTS)[number];

export function isBrandAssetSlot(value: string): value is BrandAssetSlot {
  return (BRAND_ASSET_SLOTS as readonly string[]).includes(value);
}

export type BrandAssetDelivery = 'dynamic' | 'build';
export type BrandAssetGroup = 'brand' | 'web' | 'customer_app' | 'seller' | 'native';
export type BrandAssetTransparency = 'required' | 'forbidden' | 'allowed';
export type BrandImageFormat = 'png' | 'jpeg' | 'webp';

export interface BrandAssetSpec {
  label: string;
  /** What it is, for the admin. */
  description: string;
  group: BrandAssetGroup;
  delivery: BrandAssetDelivery;
  /** Where it is shown (dynamic) or what it becomes (build). */
  usedIn: string[];
  minWidth: number;
  minHeight: number;
  /** Width ÷ height must lie within this range (square: 1–1). */
  aspect: { min: number; max: number };
  transparency: BrandAssetTransparency;
  /** Uploads accepted (SVG never: it can carry script, and PDFs cannot draw it). */
  formats: readonly BrandImageFormat[];
  /** Shown next to the upload button. */
  recommended: string;
}

const LOGO_FORMATS: readonly BrandImageFormat[] = ['png', 'webp', 'jpeg'];
const ICON_FORMATS: readonly BrandImageFormat[] = ['png'];

export const BRAND_ASSET_SPECS: Readonly<Record<BrandAssetSlot, BrandAssetSpec>> = {
  logo_main: {
    label: 'Main brand logo',
    description: 'The full Aadione logo. Used wherever no more specific logo is set.',
    group: 'brand',
    delivery: 'dynamic',
    usedIn: ['Fallback for every logo below', 'Seller statement and financial PDFs (logo at the top)'],
    minWidth: 240,
    minHeight: 48,
    aspect: { min: 1, max: 8 },
    transparency: 'allowed',
    formats: LOGO_FORMATS,
    recommended: 'PNG with a transparent background, at least 960 px wide.',
  },
  logo_light: {
    label: 'Logo for light backgrounds',
    description: 'Dark artwork that reads well on white.',
    group: 'web',
    delivery: 'dynamic',
    usedIn: ['Admin Panel sidebar and sign-in page', 'Website header'],
    minWidth: 240,
    minHeight: 48,
    aspect: { min: 1, max: 8 },
    transparency: 'allowed',
    formats: LOGO_FORMATS,
    recommended: 'PNG with a transparent background, at least 960 px wide.',
  },
  logo_dark: {
    label: 'Logo for dark backgrounds',
    description: 'Light (e.g. white) artwork that reads well on dark colours.',
    group: 'web',
    delivery: 'dynamic',
    usedIn: ['Website footer'],
    minWidth: 240,
    minHeight: 48,
    aspect: { min: 1, max: 8 },
    transparency: 'required',
    formats: ['png', 'webp'],
    recommended: 'PNG with a transparent background, at least 960 px wide.',
  },
  favicon: {
    label: 'Website favicon',
    description: 'The small square icon in browser tabs and bookmarks.',
    group: 'web',
    delivery: 'dynamic',
    usedIn: ['Browser tab of the Admin Panel, Seller Panel and website', 'Phone home-screen shortcut of the websites'],
    minWidth: 192,
    minHeight: 192,
    aspect: { min: 1, max: 1 },
    transparency: 'allowed',
    formats: ICON_FORMATS,
    recommended: 'Square PNG, 512 × 512 px. Keep it simple: it is shown as small as 16 px.',
  },
  customer_app_logo: {
    label: 'Customer app logo',
    description: 'The square Aadione mark inside the customer app.',
    group: 'customer_app',
    delivery: 'dynamic',
    usedIn: ['Customer app: Home page footer, About screen, update screen'],
    minWidth: 192,
    minHeight: 192,
    aspect: { min: 1, max: 1 },
    transparency: 'allowed',
    formats: LOGO_FORMATS,
    recommended: 'Square PNG, 1024 × 1024 px.',
  },
  customer_splash_logo: {
    label: 'Customer app start-up logo',
    description: 'The logo on the screen customers see while the app starts.',
    group: 'customer_app',
    delivery: 'dynamic',
    usedIn: ['Customer app start-up screen (from the launch after the app has downloaded it)'],
    minWidth: 256,
    minHeight: 256,
    aspect: { min: 0.5, max: 4 },
    transparency: 'required',
    formats: ['png', 'webp'],
    recommended: 'PNG with a transparent background, about 1024 × 1024 px.',
  },
  seller_app_logo: {
    label: 'Seller Panel logo',
    description: 'The logo sellers see. Aadione has no separate seller mobile app: sellers use the Seller Panel.',
    group: 'seller',
    delivery: 'dynamic',
    usedIn: ['Seller Panel sidebar, sign-in, registration and onboarding pages'],
    minWidth: 240,
    minHeight: 48,
    aspect: { min: 1, max: 8 },
    transparency: 'allowed',
    formats: LOGO_FORMATS,
    recommended: 'PNG with a transparent background, at least 960 px wide.',
  },
  android_launcher_foreground: {
    label: 'Android launcher icon (foreground)',
    description: 'The artwork of the Android app icon. Android crops it to the phone\'s icon shape: keep it inside the central 66%.',
    group: 'native',
    delivery: 'build',
    usedIn: ['Android app icon — from the next Android app release'],
    minWidth: 1024,
    minHeight: 1024,
    aspect: { min: 1, max: 1 },
    transparency: 'required',
    formats: ICON_FORMATS,
    recommended: 'Square PNG, exactly 1024 × 1024 px, transparent background.',
  },
  android_launcher_background: {
    label: 'Android launcher icon (background)',
    description: 'The background layer behind the Android icon artwork.',
    group: 'native',
    delivery: 'build',
    usedIn: ['Android app icon — from the next Android app release'],
    minWidth: 1024,
    minHeight: 1024,
    aspect: { min: 1, max: 1 },
    transparency: 'forbidden',
    formats: ICON_FORMATS,
    recommended: 'Square PNG, exactly 1024 × 1024 px, no transparency.',
  },
  ios_app_icon: {
    label: 'iOS app icon',
    description: 'The iPhone app icon. Apple rejects icons with any transparency.',
    group: 'native',
    delivery: 'build',
    usedIn: ['iPhone app icon — from the next iOS app release'],
    minWidth: 1024,
    minHeight: 1024,
    aspect: { min: 1, max: 1 },
    transparency: 'forbidden',
    formats: ICON_FORMATS,
    recommended: 'Square PNG, exactly 1024 × 1024 px, no transparency, no rounded corners.',
  },
};

export const BRAND_ASSET_GROUP_LABELS: Readonly<Record<BrandAssetGroup, string>> = {
  brand: 'Brand',
  web: 'Websites and Admin Panel',
  customer_app: 'Customer app',
  seller: 'Seller Panel',
  native: 'App icons (need a new app release)',
};

/** The slots a client may show (the build-time ones are never served). */
export const DYNAMIC_BRAND_SLOTS = BRAND_ASSET_SLOTS.filter((slot) => BRAND_ASSET_SPECS[slot].delivery === 'dynamic');
export type DynamicBrandSlot = Exclude<BrandAssetSlot, 'android_launcher_foreground' | 'android_launcher_background' | 'ios_app_icon'>;

/** Largest accepted upload (the same limit as every other image). */
export const BRAND_ASSET_MAX_BYTES = 5 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** What the server read from the uploaded file itself (never the browser's word). */
export interface BrandImageFacts {
  format: string;
  width: number;
  height: number;
  bytes: number;
  /** The image has an alpha channel. */
  hasAlpha: boolean;
  /** Every pixel is fully opaque. */
  opaque: boolean;
}

/** Problems with an upload for a slot, as admin-readable sentences; empty = accepted. */
export function brandAssetProblems(slot: BrandAssetSlot, facts: BrandImageFacts): string[] {
  const spec = BRAND_ASSET_SPECS[slot];
  const problems: string[] = [];
  const format = facts.format === 'jpg' ? 'jpeg' : facts.format;
  if (!(spec.formats as readonly string[]).includes(format)) {
    problems.push(`Upload a ${spec.formats.map((f) => f.toUpperCase()).join(' or ')} image (this file is ${format ? format.toUpperCase() : 'not an image'}).`);
    return problems;
  }
  if (facts.bytes > BRAND_ASSET_MAX_BYTES) problems.push('The file must be 5 MB or smaller.');
  if (facts.width < spec.minWidth || facts.height < spec.minHeight) {
    problems.push(`The image is ${facts.width} × ${facts.height} px; it must be at least ${spec.minWidth} × ${spec.minHeight} px.`);
  }
  const ratio = facts.height > 0 ? facts.width / facts.height : 0;
  // A rounding pixel is not a different shape.
  const tolerance = 0.01;
  if (ratio < spec.aspect.min - tolerance || ratio > spec.aspect.max + tolerance) {
    problems.push(
      spec.aspect.min === spec.aspect.max
        ? `The image must be square (it is ${facts.width} × ${facts.height} px).`
        : `The image must be between ${spec.aspect.min}:1 and ${spec.aspect.max}:1 wide (it is ${facts.width} × ${facts.height} px).`,
    );
  }
  if (spec.transparency === 'required' && (!facts.hasAlpha || facts.opaque)) {
    problems.push('The image needs a transparent background.');
  }
  if (spec.transparency === 'forbidden' && !facts.opaque) {
    problems.push('The image must not have any transparent pixels.');
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* Stored and published shapes                                                 */
/* -------------------------------------------------------------------------- */

/** One processed asset, as stored in a branding revision. */
export interface BrandAsset {
  /** Best format for screens (WebP for logos; PNG for icons). */
  url: string;
  /** Always a PNG (PDFs, favicons, native builds). */
  pngUrl: string;
  /** Favicon only: the sizes browsers ask for. */
  variants?: { png32?: string; png180?: string; png512?: string };
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  /** The admin's original file name (shown in history only). */
  fileName: string;
  uploadedAt: string;
}

/** A branding revision: the asset of each slot; absent or null = the built-in default. */
export interface BrandingContent {
  assets: Partial<Record<BrandAssetSlot, BrandAsset | null>>;
  /** Set when the draft was restored from an earlier published revision. */
  restoredFromRevision?: number;
}

/** GET /api/v1/branding — what every client shows. Dynamic slots only. */
export interface PublicBrandingDto {
  brandName: string;
  /** 0 while nothing has been published (every client shows its built-in artwork). */
  revision: number;
  publishedAt: string | null;
  assets: Partial<Record<DynamicBrandSlot, PublicBrandAsset>>;
}

export interface PublicBrandAsset {
  url: string;
  pngUrl: string;
  width: number;
  height: number;
  variants?: BrandAsset['variants'];
}

/**
 * Which published asset a surface shows, following the fallback chain; null =
 * the client's own built-in Aadione artwork.
 */
export type BrandUse = 'light' | 'dark' | 'seller' | 'customerApp' | 'customerSplash' | 'favicon' | 'main';

const FALLBACKS: Readonly<Record<BrandUse, readonly DynamicBrandSlot[]>> = {
  main: ['logo_main'],
  light: ['logo_light', 'logo_main'],
  // Light artwork only: the main logo may be dark-on-white, unreadable on dark.
  dark: ['logo_dark'],
  seller: ['seller_app_logo', 'logo_light', 'logo_main'],
  customerApp: ['customer_app_logo'],
  customerSplash: ['customer_splash_logo'],
  favicon: ['favicon'],
};

export function brandAssetFor(branding: Pick<PublicBrandingDto, 'assets'> | null | undefined, use: BrandUse): PublicBrandAsset | null {
  if (!branding) return null;
  for (const slot of FALLBACKS[use]) {
    const asset = branding.assets[slot];
    if (asset && isSafeAssetUrl(asset.url)) return asset;
  }
  return null;
}

/**
 * Only https (or a local development host over http) — a client never shows
 * anything else from the branding response.
 */
export function isSafeAssetUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url.length > 1000) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Slots whose asset differs between two revisions (by file). */
export function changedBrandSlots(a: BrandingContent | null | undefined, b: BrandingContent | null | undefined): BrandAssetSlot[] {
  return BRAND_ASSET_SLOTS.filter((slot) => (a?.assets[slot]?.pngUrl ?? null) !== (b?.assets[slot]?.pngUrl ?? null));
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export interface AdminBrandSlotDto {
  slot: BrandAssetSlot;
  spec: BrandAssetSpec;
  /** What clients show now (null = built-in default). */
  published: BrandAsset | null;
  /** The draft's choice, when a draft exists (null = built-in default). */
  draft: BrandAsset | null;
  /** The draft differs from what is published. */
  changed: boolean;
  /** Earlier files used for this slot (newest first), for "use again". */
  history: (BrandAsset & { revision: number })[];
}

export interface AdminBrandingRevisionDto {
  id: string;
  revision: number;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Slots this publication changed. */
  changed: BrandAssetSlot[];
  restoredFromRevision: number | null;
}

/** GET /admin/branding */
export interface AdminBrandingDto {
  slots: AdminBrandSlotDto[];
  published: { revision: number; publishedAt: string | null; publishedBy: string | null } | null;
  draft: { basedOnRevision: number; updatedAt: string; updatedBy: string | null; changed: BrandAssetSlot[] } | null;
  history: AdminBrandingRevisionDto[];
}

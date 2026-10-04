/** Builds a minimal but realistic seller + catalogue for integration tests.
 *
 * NOTE (V2 migration): exported names (`seedStore`, `storeId`,
 * `storeVariantId`) are kept as-is even though they now create a `Seller`
 * row (`isPlatformOwned: true`) — renaming them would cascade into every
 * integration test file that calls them, none of which have been migrated
 * to the V2 multi-seller order flow yet (see the migration's final report).
 * Only the Prisma calls inside this file were updated to match the new
 * schema.
 */

import { ApprovalStatus, CodPolicy, ProductStatus, SellerLifecycleStatus, UnitType } from '../../src/shared';
import { prisma } from '../../src/infra/db/prisma';

/**
 * The `Seller` lifecycle columns for a seeded seller whose admin onboarding
 * outcome is `onboardingStatus`. Seeds must set both: the two-gate lifecycle
 * migration's CHECK `sellers_lifecycle_matches_onboarding` refuses a row where
 * they disagree, and `lifecycleStatus` defaults to APPLICATION_PENDING.
 *
 *   APPROVED -> ACTIVE              passed both gates (operational panel)
 *   PENDING  -> ONBOARDING_PENDING  created by admin: past Gate 1, onboarding
 *   REJECTED -> ONBOARDING_REJECTED Gate 2 final rejection
 */
export function sellerLifecycleFields(onboardingStatus: ApprovalStatus): {
  onboardingStatus: ApprovalStatus;
  lifecycleStatus: SellerLifecycleStatus;
} {
  const lifecycleStatus =
    onboardingStatus === ApprovalStatus.APPROVED
      ? SellerLifecycleStatus.ACTIVE
      : onboardingStatus === ApprovalStatus.REJECTED
        ? SellerLifecycleStatus.ONBOARDING_REJECTED
        : SellerLifecycleStatus.ONBOARDING_PENDING;
  return { onboardingStatus, lifecycleStatus };
}

export const STORE_COORDS = { latitude: 27.6094, longitude: 75.1399 };
export const NEARBY = { latitude: 27.6364, longitude: 75.1399 }; // ~3 km
export const FAR = { latitude: 26.9124, longitude: 75.7873 }; // Jaipur, ~100 km

export async function seedStore(options: { open?: boolean } = {}): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: 'TEST',
      name: 'Test Store',
      isPlatformOwned: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
      addressLine: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      ...STORE_COORDS,
      timezone: 'Asia/Kolkata',
      isActive: true,
      allowCod: CodPolicy.ALLOW,
    },
  });

  const open = options.open ?? true;
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      sellerId: seller.id,
      dayOfWeek,
      opensAt: open ? '00:00' : '08:00',
      closesAt: open ? '23:59' : '08:01',
      isClosed: false,
    })),
  });

  return seller.id;
}

export interface SeededProduct {
  productId: string;
  variantId: string;
  storeVariantId: string;
  categoryId: string;
}

export async function seedProduct(
  storeId: string,
  options: {
    name?: string;
    pricePaise?: number;
    mrpPaise?: number;
    stockQty?: number;
    maxQtyPerOrder?: number;
    categoryAllowCod?: CodPolicy;
    productAllowCod?: CodPolicy;
    taxRateBp?: number;
  } = {},
): Promise<SeededProduct> {
  const name = options.name ?? `Test Product ${Math.random().toString(36).slice(2, 8)}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const category = await prisma.category.create({
    data: {
      name: `Cat ${slug}`,
      slug: `cat-${slug}`,
      path: `cat-${slug}`,
      depth: 0,
      allowCod: options.categoryAllowCod ?? CodPolicy.INHERIT,
    },
  });

  const product = await prisma.product.create({
    data: {
      name,
      slug,
      categoryId: category.id,
      status: ProductStatus.ACTIVE,
      approvalStatus: 'APPROVED',
      taxRateBp: options.taxRateBp ?? 0,
      allowCod: options.productAllowCod ?? CodPolicy.INHERIT,
      searchKeywords: [],
    },
  });

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `SKU-${slug}`.toUpperCase().slice(0, 60),
      variantName: '1 kg',
      unit: UnitType.KG,
      unitValue: 1,
      isDefault: true,
      status: ProductStatus.ACTIVE,
    },
  });

  const pricePaise = options.pricePaise ?? 10000;
  // Defaults to 20% above the selling price. Without this, a test that sets
  // only `pricePaise` above the old flat default trips the CHECK constraint
  // `price_paise <= mrp_paise` — which is the constraint doing its job, but a
  // confusing way to learn it.
  const mrpPaise = options.mrpPaise ?? Math.round(pricePaise * 1.2);

  const offer = await prisma.sellerListing.create({
    data: {
      sellerId: storeId,
      variantId: variant.id,
      mrpPaise,
      pricePaise,
      stockQty: options.stockQty ?? 50,
      maxQtyPerOrder: options.maxQtyPerOrder ?? 10,
      isAvailable: true,
    },
  });

  return {
    productId: product.id,
    variantId: variant.id,
    storeVariantId: offer.id,
    categoryId: category.id,
  };
}

export async function seedAddress(
  userId: string,
  coords: { latitude: number; longitude: number } = NEARBY,
): Promise<string> {
  const address = await prisma.address.create({
    data: {
      userId,
      label: 'Home',
      fullName: 'Test Customer',
      mobile: '9876543210',
      area: 'Main Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      landmark: 'Near Shiv Mandir',
      ...coords,
      isDefault: true,
      isServiceable: true,
    },
  });
  return address.id;
}

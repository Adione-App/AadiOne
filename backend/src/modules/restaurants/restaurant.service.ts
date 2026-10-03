/**
 * Food / restaurant module (V2).
 *
 * Reuses the marketplace model as-is — nothing here is a parallel "food"
 * catalog:
 *   - a restaurant is a Seller with `sellerType = RESTAURANT`, plus its
 *     optional RestaurantProfile (cuisine / veg-only / prep time — managed
 *     through seller onboarding, see seller-onboarding.service.ts);
 *   - its menu SECTIONS are Category rows scoped to it (`Category.sellerId`),
 *     exactly as the Category model's own doc comment prescribes;
 *   - its menu ITEMS are ordinary Products submitted through the Product
 *     Approval workflow, sold through ordinary SellerListings, ordered through
 *     the ordinary cart/checkout/SellerOrder lifecycle.
 *
 * CUSTOMER VISIBILITY: a restaurant is shown only when it is live — active,
 * not deleted, and `onboardingStatus = APPROVED` ("A seller cannot go live
 * while this is not APPROVED", Seller.onboardingStatus doc comment). A menu
 * item is shown only when its Product is ACTIVE + APPROVED, its variant is
 * ACTIVE, its listing is available, and it sits in one of the restaurant's
 * own active menu sections.
 *
 * The grocery catalog (catalog.service.ts) is untouched apart from keeping
 * restaurant menu sections out of the shared category tree.
 */

import { ApprovalStatus, ErrorCode, ProductStatus, SellerType } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { slugify } from '../../shared/text';
import { invalidateCategoryCache } from '../catalog/catalog.service';
import { getSellerOpenState } from '../sellers/seller.service';

/* -------------------------------------------------------------------------- */
/* Seller — own menu sections                                                */
/* -------------------------------------------------------------------------- */

async function loadRestaurantOrThrow(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, sellerType: true, deletedAt: true },
  });
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  if (seller.sellerType !== SellerType.RESTAURANT) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Menu sections only apply to a RESTAURANT-type seller.',
    });
  }
  return seller;
}

function toMenuSectionDto(category: { id: string; name: string; slug: string; displayOrder: number; isActive: boolean }) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    displayOrder: category.displayOrder,
    isActive: category.isActive,
  };
}

export interface CreateMenuSectionInput {
  name: string;
  displayOrder?: number;
}

/** A restaurant's own menu section: a root Category scoped to it, vertical FOOD. */
export async function createMenuSection(sellerId: string, input: CreateMenuSectionInput) {
  await loadRestaurantOrThrow(sellerId);
  const slug = slugify(input.name);

  const duplicate = await prisma.category.findFirst({
    where: { sellerId, slug, deletedAt: null },
    select: { id: true },
  });
  if (duplicate) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      status: 409,
      message: 'This menu already has a section with that name.',
    });
  }

  const category = await prisma.category.create({
    data: {
      sellerId,
      parentId: null,
      name: input.name,
      slug,
      path: slug,
      depth: 0,
      displayOrder: input.displayOrder ?? 0,
      isActive: true,
      vertical: 'FOOD',
    },
  });
  invalidateCategoryCache();
  return toMenuSectionDto(category);
}

export async function listMenuSections(sellerId: string) {
  await loadRestaurantOrThrow(sellerId);
  const sections = await prisma.category.findMany({
    where: { sellerId, deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
  return sections.map(toMenuSectionDto);
}

/* -------------------------------------------------------------------------- */
/* Restaurant + menu reads                                                   */
/* -------------------------------------------------------------------------- */

const LIVE_RESTAURANT_WHERE = {
  sellerType: SellerType.RESTAURANT,
  isActive: true,
  deletedAt: null,
  onboardingStatus: ApprovalStatus.APPROVED,
} as const;

const RESTAURANT_INCLUDE = {
  restaurantProfile: true,
  hours: { orderBy: { dayOfWeek: 'asc' as const } },
} as const;

type RestaurantRow = NonNullable<Awaited<ReturnType<typeof findRestaurant>>>;

function findRestaurant(sellerId: string) {
  return prisma.seller.findFirst({
    where: { id: sellerId, sellerType: SellerType.RESTAURANT, deletedAt: null },
    include: RESTAURANT_INCLUDE,
  });
}

async function toRestaurantDto(seller: RestaurantRow) {
  const open = await getSellerOpenState(seller);
  return {
    sellerId: seller.id,
    name: seller.name,
    addressLine: seller.addressLine,
    city: seller.city,
    pincode: seller.pincode,
    latitude: seller.latitude,
    longitude: seller.longitude,
    phone: seller.phone,
    cuisine: seller.restaurantProfile?.cuisine ?? [],
    isVegOnly: seller.restaurantProfile?.isVegOnly ?? false,
    avgPrepMins: seller.restaurantProfile?.avgPrepMins ?? null,
    isOpen: open.isOpen,
    nextOpenText: open.nextOpenText,
  };
}

/** Menu listings for one restaurant; `publicOnly` applies the customer gates. */
async function loadMenu(sellerId: string, publicOnly: boolean) {
  const [sections, listings] = await Promise.all([
    prisma.category.findMany({
      where: { sellerId, deletedAt: null, ...(publicOnly ? { isActive: true } : {}) },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.sellerListing.findMany({
      where: {
        sellerId,
        ...(publicOnly
          ? {
              isAvailable: true,
              variant: {
                status: ProductStatus.ACTIVE,
                deletedAt: null,
                product: {
                  status: ProductStatus.ACTIVE,
                  approvalStatus: ApprovalStatus.APPROVED,
                  deletedAt: null,
                  category: { sellerId, isActive: true, deletedAt: null },
                },
              },
            }
          : {}),
      },
      include: {
        variant: {
          include: {
            product: { select: { id: true, name: true, description: true, categoryId: true, approvalStatus: true, attributes: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { sections, listings };
}

function toMenuItemDto(
  restaurant: { id: string; name: string },
  listing: Awaited<ReturnType<typeof loadMenu>>['listings'][number],
) {
  const available = Math.max(0, listing.stockQty - listing.reservedQty);
  return {
    sellerListingId: listing.id,
    sellerId: restaurant.id,
    restaurantName: restaurant.name,
    productId: listing.variant.product.id,
    variantId: listing.variantId,
    name: listing.variant.product.name,
    description: listing.variant.product.description,
    variantName: listing.variant.variantName,
    imageUrl: listing.variant.imageUrl,
    mrpPaise: listing.mrpPaise,
    pricePaise: listing.pricePaise,
    inStock: listing.isAvailable && available > 0,
    maxQtyPerOrder: listing.maxQtyPerOrder,
  };
}

function groupBySection(
  sections: Awaited<ReturnType<typeof loadMenu>>['sections'],
  items: ReturnType<typeof toMenuItemDto>[],
  categoryOf: Map<string, string>,
) {
  return sections.map((section) => ({
    ...toMenuSectionDto(section),
    items: items.filter((item) => categoryOf.get(item.sellerListingId) === section.id),
  }));
}

/** Customer: every live restaurant, each identified as its own seller. */
export async function listRestaurants() {
  const sellers = await prisma.seller.findMany({
    where: LIVE_RESTAURANT_WHERE,
    include: RESTAURANT_INCLUDE,
    orderBy: { name: 'asc' },
  });
  const counts = await prisma.sellerListing.groupBy({
    by: ['sellerId'],
    where: {
      sellerId: { in: sellers.map((s) => s.id) },
      isAvailable: true,
      variant: {
        status: ProductStatus.ACTIVE,
        deletedAt: null,
        product: { status: ProductStatus.ACTIVE, approvalStatus: ApprovalStatus.APPROVED, deletedAt: null },
      },
    },
    _count: { _all: true },
  });
  const countBy = new Map(counts.map((c) => [c.sellerId, c._count._all]));
  return Promise.all(
    sellers.map(async (seller) => ({ ...(await toRestaurantDto(seller)), menuItemCount: countBy.get(seller.id) ?? 0 })),
  );
}

/** Customer: one live restaurant and its public menu. A restaurant that is
 * not live is reported as not found, never as "exists but hidden". */
export async function getRestaurantMenu(sellerId: string) {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, ...LIVE_RESTAURANT_WHERE },
    include: RESTAURANT_INCLUDE,
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Restaurant not found.' });

  const { sections, listings } = await loadMenu(seller.id, true);
  const items = listings.map((l) => toMenuItemDto(seller, l));
  const categoryOf = new Map(listings.map((l) => [l.id, l.variant.product.categoryId]));
  return { restaurant: await toRestaurantDto(seller), sections: groupBySection(sections, items, categoryOf) };
}

/* -------------------------------------------------------------------------- */
/* Admin — every restaurant, whatever its state                              */
/* -------------------------------------------------------------------------- */

export async function listRestaurantsForAdmin() {
  const sellers = await prisma.seller.findMany({
    where: { sellerType: SellerType.RESTAURANT, deletedAt: null },
    include: {
      ...RESTAURANT_INCLUDE,
      _count: { select: { categories: true, listings: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return Promise.all(
    sellers.map(async (seller) => ({
      ...(await toRestaurantDto(seller)),
      isActive: seller.isActive,
      onboardingStatus: seller.onboardingStatus,
      defaultCommissionBp: seller.defaultCommissionBp,
      hasRestaurantProfile: seller.restaurantProfile !== null,
      menuSectionCount: seller._count.categories,
      listingCount: seller._count.listings,
    })),
  );
}

export async function getRestaurantForAdmin(sellerId: string) {
  const seller = await findRestaurant(sellerId);
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Restaurant not found.' });

  const { sections, listings } = await loadMenu(seller.id, false);
  const items = listings.map((l) => ({
    ...toMenuItemDto(seller, l),
    approvalStatus: l.variant.product.approvalStatus,
    isAvailable: l.isAvailable,
  }));
  const categoryOf = new Map(listings.map((l) => [l.id, l.variant.product.categoryId]));
  return {
    restaurant: {
      ...(await toRestaurantDto(seller)),
      isActive: seller.isActive,
      onboardingStatus: seller.onboardingStatus,
      defaultCommissionBp: seller.defaultCommissionBp,
    },
    sections: groupBySection(sections, items, categoryOf),
  };
}

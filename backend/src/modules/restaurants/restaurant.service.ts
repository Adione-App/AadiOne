/**
 * Food / restaurant module (V2) — restaurants AND cafes (the FOOD seller
 * types, `isFoodSellerType`).
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

import {
  ApprovalStatus,
  ErrorCode,
  FOOD_SELLER_TYPES,
  ProductStatus,
  SellerType,
  foodDietOf,
  isFoodSellerType,
  optionGroupsOf,
  optionValuesOf,
  type RestaurantDto,
  type RestaurantMenuDto,
  type RestaurantMenuItemDto,
  type RestaurantSummaryDto,
} from '../../shared';
import { AppError } from '../../common/errors';
import { prisma, runInTransaction } from '../../infra/db/prisma';
import { invalidateCategoryCache } from '../catalog/catalog.service';
import { createOwnTopCategory } from '../catalog/seller-category.service';
import { createOwnSubcategory } from '../catalog/seller-subcategory.service';
import { checkServiceability, getSellerOpenState } from '../sellers/seller.service';

/* -------------------------------------------------------------------------- */
/* Seller — own menu sections                                                */
/* -------------------------------------------------------------------------- */

async function loadRestaurantOrThrow(sellerId: string) {
  const seller = await prisma.seller.findUnique({
    where: { id: sellerId },
    select: { id: true, sellerType: true, deletedAt: true },
  });
  if (!seller || seller.deletedAt) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  if (!isFoodSellerType(seller.sellerType)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Menu sections only apply to a restaurant or cafe seller.',
    });
  }
  return seller;
}

type SectionRow = {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isActive: boolean;
  imageUrl: string | null;
  parent?: { id: string; name: string } | null;
};

function toMenuSectionDto(category: SectionRow) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    displayOrder: category.displayOrder,
    isActive: category.isActive,
    imageUrl: category.imageUrl,
    menuId: category.parent?.id ?? null,
    menuName: category.parent?.name ?? null,
  };
}

export const DEFAULT_MENU_NAME = 'Main Menu';

/**
 * The menu a section goes into when none is named: the seller's first menu,
 * or a new "Main Menu" (a top category in the seller's own tree) when it has
 * none yet — so the older one-level "add a menu section" call keeps working.
 */
async function defaultMenuId(sellerId: string, actorUserId: string): Promise<string> {
  const first = await prisma.category.findFirst({
    where: { sellerId, parentId: null, deletedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  if (first) return first.id;
  const tree = await createOwnTopCategory(sellerId, { name: DEFAULT_MENU_NAME }, actorUserId);
  return tree.categories.find((menu) => menu.name === DEFAULT_MENU_NAME)!.id;
}

export interface CreateMenuSectionInput {
  name: string;
  /** The menu (one of the seller's own top categories); default: its first menu. */
  menuId?: string;
  displayOrder?: number;
}

/**
 * A restaurant's / cafe's menu section = a subcategory in its own category
 * tree, under one of its menus (top categories). Created by the same service
 * as every seller's subcategories — same ownership, naming and delete rules.
 */
export async function createMenuSection(sellerId: string, input: CreateMenuSectionInput, actorUserId: string) {
  await loadRestaurantOrThrow(sellerId);
  const menuId = input.menuId ?? (await defaultMenuId(sellerId, actorUserId));
  const created = await createOwnSubcategory(
    sellerId,
    { parentId: menuId, name: input.name, ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}) },
    actorUserId,
  );
  const [section] = (await listMenuSections(sellerId)).filter((row) => row.id === created.id);
  return section!;
}

/** Every menu section of the seller (all menus), in menu order, with its food item count. */
export async function listMenuSections(sellerId: string) {
  await loadRestaurantOrThrow(sellerId);
  const sections = await prisma.category.findMany({
    where: { sellerId, parentId: { not: null }, deletedAt: null, parent: { deletedAt: null } },
    orderBy: [{ parent: { displayOrder: 'asc' } }, { parent: { name: 'asc' } }, { displayOrder: 'asc' }, { name: 'asc' }],
    include: {
      parent: { select: { id: true, name: true } },
      _count: { select: { products: { where: { deletedAt: null } } } },
    },
  });
  return sections.map((section) => ({ ...toMenuSectionDto(section), itemCount: section._count.products }));
}

/**
 * PUT /seller/menu-sections/order — one menu's sections in their new order
 * (every live section of that menu exactly once); positions become 0..n-1.
 */
export async function reorderMenuSections(sellerId: string, menuId: string, ids: string[], actorUserId: string) {
  await loadRestaurantOrThrow(sellerId);
  const menu = await prisma.category.findFirst({ where: { id: menuId, sellerId, parentId: null, deletedAt: null }, select: { id: true } });
  if (!menu) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Menu not found.' });
  const own = await prisma.category.findMany({ where: { sellerId, parentId: menuId, deletedAt: null }, select: { id: true } });
  const ownIds = new Set(own.map((s) => s.id));
  if (new Set(ids).size !== ids.length || ids.length !== ownIds.size || ids.some((id) => !ownIds.has(id))) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'List every menu section of this menu exactly once.' });
  }
  await runInTransaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.category.update({ where: { id }, data: { displayOrder: index } });
    }
  });
  await prisma.auditLog.create({
    data: { actorUserId, action: 'restaurant.menu_section.reorder', entityType: 'Category', entityId: menuId, after: { order: ids } },
  });
  invalidateCategoryCache();
  return listMenuSections(sellerId);
}

/* -------------------------------------------------------------------------- */
/* Restaurant + menu reads                                                   */
/* -------------------------------------------------------------------------- */

/** Restaurants and cafes — the FOOD seller types. */
const FOOD_TYPES: SellerType[] = [...FOOD_SELLER_TYPES];

const LIVE_RESTAURANT_WHERE = {
  sellerType: { in: FOOD_TYPES },
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
    where: { id: sellerId, sellerType: { in: FOOD_TYPES }, deletedAt: null },
    include: RESTAURANT_INCLUDE,
  });
}

async function toRestaurantDto(seller: RestaurantRow): Promise<RestaurantDto> {
  const open = await getSellerOpenState(seller);
  return {
    sellerId: seller.id,
    sellerType: seller.sellerType,
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
    // Menu sections (subcategories of the seller's menus), in menu order.
    prisma.category.findMany({
      where: {
        sellerId,
        parentId: { not: null },
        deletedAt: null,
        parent: { deletedAt: null, ...(publicOnly ? { isActive: true } : {}) },
        ...(publicOnly ? { isActive: true } : {}),
      },
      orderBy: [{ parent: { displayOrder: 'asc' } }, { parent: { name: 'asc' } }, { displayOrder: 'asc' }, { name: 'asc' }],
      include: { parent: { select: { id: true, name: true } } },
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
                  category: { sellerId, isActive: true, deletedAt: null, parent: { isActive: true, deletedAt: null } },
                },
              },
            }
          : { variant: { deletedAt: null, product: { deletedAt: null } } }),
      },
      include: {
        variant: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                description: true,
                categoryId: true,
                approvalStatus: true,
                attributes: true,
                optionGroups: true,
                // A food item's photos are product images (the Food Item
                // form uploads them there); the variant image is usually empty.
                images: { orderBy: { displayOrder: 'asc' }, take: 1, select: { url: true, thumbUrl: true } },
              },
            },
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
): RestaurantMenuItemDto {
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
    // One menu entry per sellable variant (its own price / cart line); the
    // dish's option groups say how to present them together, e.g. Size: Half / Full.
    optionValues: optionValuesOf(listing.variant.optionValues),
    optionGroups: optionGroupsOf(listing.variant.product.optionGroups),
    imageUrl:
      listing.variant.imageUrl ??
      listing.variant.product.images[0]?.thumbUrl ??
      listing.variant.product.images[0]?.url ??
      null,
    mrpPaise: listing.mrpPaise,
    pricePaise: listing.pricePaise,
    // A made-to-order food item (tracksStock = false) is "in stock" whenever
    // the seller has it switched on.
    inStock: listing.isAvailable && (!listing.tracksStock || available > 0),
    diet: foodDietOf(listing.variant.product.attributes),
    maxQtyPerOrder: listing.maxQtyPerOrder,
  };
}

function groupBySection<T extends { sellerListingId: string }>(
  sections: Awaited<ReturnType<typeof loadMenu>>['sections'],
  items: T[],
  categoryOf: Map<string, string>,
) {
  return sections.map((section) => ({
    ...toMenuSectionDto(section),
    items: items.filter((item) => categoryOf.get(item.sellerListingId) === section.id),
  }));
}

/** The same sections, grouped under their menus (Menu → Menu Section → Food Item). */
function groupByMenu<T extends { menuId: string | null; menuName: string | null }>(sections: T[]) {
  const menus: { id: string; name: string; sections: T[] }[] = [];
  for (const section of sections) {
    if (!section.menuId) continue;
    let menu = menus.find((m) => m.id === section.menuId);
    if (!menu) menus.push((menu = { id: section.menuId, name: section.menuName ?? '', sections: [] }));
    menu.sections.push(section);
  }
  return menus;
}

/**
 * One real photo per restaurant: the first image of its most popular live
 * menu item. Restaurants have no logo field, so this is the only uploaded
 * imagery there is to show.
 */
async function coverImages(sellerIds: string[]): Promise<Map<string, string>> {
  if (sellerIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ seller_id: string; url: string }[]>`
    SELECT DISTINCT ON (c.seller_id) c.seller_id, COALESCE(pi.card_url, pi.thumb_url, pi.url) AS url
    FROM product_images pi
    JOIN products p ON p.id = pi.product_id
      AND p.status = 'ACTIVE' AND p.approval_status = 'APPROVED' AND p.deleted_at IS NULL
    JOIN categories c ON c.id = p.category_id AND c.is_active AND c.deleted_at IS NULL
    WHERE c.seller_id = ANY(${sellerIds}::uuid[])
    ORDER BY c.seller_id, p.popularity_score DESC, p.created_at ASC, pi.display_order ASC`;
  return new Map(rows.map((row) => [row.seller_id, row.url]));
}

/**
 * Customer: every live restaurant and cafe, each identified as its own
 * seller. With a location, only those that deliver there (each seller's own
 * radius — the rule checkout enforces), nearest first.
 */
export async function listRestaurants(location: { lat: number; lng: number } | null = null): Promise<RestaurantSummaryDto[]> {
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
  const covers = await coverImages(sellers.map((s) => s.id));

  const distances = new Map<string, number>();
  let visible = sellers;
  if (location) {
    const checks = await Promise.all(
      sellers.map(async (seller) => ({ seller, check: await checkServiceability(location.lat, location.lng, seller) })),
    );
    for (const { seller, check } of checks) distances.set(seller.id, check.distanceKm);
    visible = checks
      .filter((entry) => entry.check.serviceable)
      .sort((a, b) => a.check.distanceKm - b.check.distanceKm)
      .map((entry) => entry.seller);
  }

  return Promise.all(
    visible.map(async (seller) => ({
      ...(await toRestaurantDto(seller)),
      menuItemCount: countBy.get(seller.id) ?? 0,
      coverImageUrl: covers.get(seller.id) ?? null,
      distanceKm: distances.get(seller.id) ?? null,
    })),
  );
}

/** Customer: one live restaurant and its public menu. A restaurant that is
 * not live is reported as not found, never as "exists but hidden". */
export async function getRestaurantMenu(sellerId: string): Promise<RestaurantMenuDto> {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, ...LIVE_RESTAURANT_WHERE },
    include: RESTAURANT_INCLUDE,
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Restaurant not found.' });

  const { sections, listings } = await loadMenu(seller.id, true);
  const items = listings.map((l) => toMenuItemDto(seller, l));
  const categoryOf = new Map(listings.map((l) => [l.id, l.variant.product.categoryId]));
  const grouped = groupBySection(sections, items, categoryOf);
  return { restaurant: await toRestaurantDto(seller), menus: groupByMenu(grouped), sections: grouped };
}

/* -------------------------------------------------------------------------- */
/* Admin — every restaurant, whatever its state                              */
/* -------------------------------------------------------------------------- */

export async function listRestaurantsForAdmin() {
  const sellers = await prisma.seller.findMany({
    where: { sellerType: { in: FOOD_TYPES }, deletedAt: null },
    include: {
      ...RESTAURANT_INCLUDE,
      _count: { select: { categories: { where: { parentId: { not: null }, deletedAt: null } }, listings: true } },
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
    menus: groupByMenu(groupBySection(sections, items, categoryOf)),
    sections: groupBySection(sections, items, categoryOf),
  };
}

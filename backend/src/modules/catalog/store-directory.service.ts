/**
 * Store directory — "stores near you" (GET /stores) and a store page's header
 * (GET /stores/:sellerId).
 *
 * A store is a live MARKETPLACE seller — the same gate as every customer
 * listing (not deleted, active, onboarding APPROVED, not a food seller; see
 * MARKETPLACE_SELLER_WHERE) — with at least one customer-visible product.
 * Restaurants and cafes are listed by /restaurants instead.
 *
 * With a location, only sellers that deliver there are returned, nearest
 * first, using each seller's own radius (seller.service's serviceability
 * rule — the same one checkout enforces). Without one, every store is
 * returned, largest catalogue first.
 */

import { ErrorCode, formatSellerAddress, isFoodSellerType, type SellerDetailsDto, type StoreSummaryDto } from "../../shared";
import { prisma } from "../../infra/db/prisma";
import { AppError } from "../../common/errors";
import { findLiveSellers, findSellerById, type SellerWithHours } from "../sellers/seller.repository";
import { checkServiceability, getSellerOpenState } from "../sellers/seller.service";
import { sellerCatalogueStats, type SellerCatalogueStats } from "./catalog.repository";

export interface CustomerLocation {
  lat: number;
  lng: number;
}

const MAX_CATEGORY_NAMES = 3;

async function toStoreDto(
  seller: SellerWithHours,
  stats: SellerCatalogueStats,
  distanceKm: number | null,
): Promise<StoreSummaryDto> {
  const open = await getSellerOpenState(seller);
  return {
    id: seller.id,
    name: seller.name,
    sellerType: seller.sellerType,
    city: seller.city,
    productCount: stats.productCount,
    categoryNames: stats.categoryNames.slice(0, MAX_CATEGORY_NAMES),
    previewImageUrls: stats.previewImageUrls,
    isOpen: open.isOpen,
    nextOpenText: open.nextOpenText,
    distanceKm,
  };
}

function isMarketplaceSeller(seller: SellerWithHours): boolean {
  return (
    seller.deletedAt === null &&
    seller.isActive &&
    seller.onboardingStatus === "APPROVED" &&
    !isFoodSellerType(seller.sellerType)
  );
}

export async function listStores(location: CustomerLocation | null): Promise<StoreSummaryDto[]> {
  const sellers = (await findLiveSellers()).filter(isMarketplaceSeller);
  const stats = await sellerCatalogueStats(sellers.map((seller) => seller.id));
  const stocked = sellers.filter((seller) => (stats.get(seller.id)?.productCount ?? 0) > 0);

  if (!location) {
    const stores = await Promise.all(stocked.map((seller) => toStoreDto(seller, stats.get(seller.id)!, null)));
    return openFirst(stores.sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)));
  }

  const checked = await Promise.all(
    stocked.map(async (seller) => ({
      seller,
      check: await checkServiceability(location.lat, location.lng, seller),
    })),
  );

  return openFirst(
    await Promise.all(
      checked
        .filter((entry) => entry.check.serviceable)
        .sort((a, b) => a.check.distanceKm - b.check.distanceKm)
        .map((entry) => toStoreDto(entry.seller, stats.get(entry.seller.id)!, entry.check.distanceKm)),
    ),
  );
}

/**
 * Closed stores stay listed (customers may browse them; the card says when it
 * opens) but after every open one — each group keeps its own order (stable sort).
 */
function openFirst(stores: StoreSummaryDto[]): StoreSummaryDto[] {
  return stores.sort((a, b) => Number(b.isOpen) - Number(a.isOpen));
}

/** One store; a seller that is not a live, stocked marketplace store is NOT_FOUND. */
/**
 * GET /stores/:sellerId/details — the seller disclosure customers see from a
 * product, a restaurant or an order (shared/seller-disclosure.ts). Any
 * approved, not-deleted seller — grocery, food or other — so a past order's
 * seller can still be looked up after the shop closes. Only the disclosure
 * fields are read; nothing personal leaves the server.
 */
export async function getSellerDetails(sellerId: string): Promise<SellerDetailsDto> {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null, onboardingStatus: "APPROVED" },
    select: {
      id: true,
      name: true,
      sellerType: true,
      addressLine: true,
      locality: true,
      city: true,
      district: true,
      state: true,
      pincode: true,
      customerCarePhone: true,
      customerCareEmail: true,
      profile: { select: { businessName: true, fssaiNumber: true } },
    },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: "Seller not found." });
  const businessName = seller.profile?.businessName?.trim() || null;
  return {
    sellerId: seller.id,
    displayName: seller.name,
    businessName: businessName && businessName.toLowerCase() !== seller.name.trim().toLowerCase() ? businessName : null,
    sellerType: seller.sellerType,
    address: formatSellerAddress(seller),
    customerCare: { phone: seller.customerCarePhone?.trim() || null, email: seller.customerCareEmail?.trim() || null },
    fssaiNumber: isFoodSellerType(seller.sellerType) ? seller.profile?.fssaiNumber?.trim() || null : null,
  };
}

export async function getStore(sellerId: string, location: CustomerLocation | null): Promise<StoreSummaryDto> {
  const seller = await findSellerById(sellerId);
  const stats = seller && isMarketplaceSeller(seller) ? (await sellerCatalogueStats([seller.id])).get(seller.id) : undefined;
  if (!seller || !stats || stats.productCount === 0) {
    throw new AppError(ErrorCode.NOT_FOUND, { message: "Store not found." });
  }

  const distanceKm = location
    ? (await checkServiceability(location.lat, location.lng, seller)).distanceKm
    : null;
  return toStoreDto(seller, stats, distanceKm);
}

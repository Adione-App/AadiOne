/**
 * Seller disclosure — the customer-care contact a seller publishes, and what
 * is still missing (shared/seller-disclosure.ts).
 *
 *   GET   /admin/sellers/:sellerId/disclosure   SELLER_MANAGE
 *   PATCH /admin/sellers/:sellerId/disclosure   SELLER_MANAGE
 *   GET   /seller/disclosure                    SELLER_PROFILE_MANAGE (own store)
 *   PATCH /seller/disclosure                    SELLER_PROFILE_MANAGE (own store)
 *
 * The contact is opt-in: it is never copied from `sellers.phone` (the owner's
 * personal mobile from sign-up). Every change is audited. A seller can only
 * reach its own row (the seller id comes from the session, never the body).
 */

import { ErrorCode, isFoodSellerType, sellerDisclosureGaps, type SellerDetailsDto } from '../../shared';
import { AppError } from '../../common/errors';
import { prisma } from '../../infra/db/prisma';
import { getSellerDetails } from '../catalog/store-directory.service';

export interface SellerDisclosureAdminDto {
  sellerId: string;
  customerCarePhone: string | null;
  customerCareEmail: string | null;
  /** What customers are shown now; null while the seller is not approved (not public yet). */
  preview: SellerDetailsDto | null;
  /** Missing details, as warnings (empty = complete). */
  gaps: string[];
}

export async function getSellerDisclosure(sellerId: string): Promise<SellerDisclosureAdminDto> {
  const seller = await prisma.seller.findFirst({
    where: { id: sellerId, deletedAt: null },
    select: {
      id: true,
      sellerType: true,
      onboardingStatus: true,
      customerCarePhone: true,
      customerCareEmail: true,
      profile: { select: { businessName: true, fssaiNumber: true } },
    },
  });
  if (!seller) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Seller not found.' });
  return {
    sellerId: seller.id,
    customerCarePhone: seller.customerCarePhone,
    customerCareEmail: seller.customerCareEmail,
    preview: seller.onboardingStatus === 'APPROVED' ? await getSellerDetails(seller.id) : null,
    gaps: sellerDisclosureGaps({
      businessName: seller.profile?.businessName,
      customerCarePhone: seller.customerCarePhone,
      customerCareEmail: seller.customerCareEmail,
      fssaiNumber: seller.profile?.fssaiNumber,
      isFoodSeller: isFoodSellerType(seller.sellerType),
    }),
  };
}

export async function updateSellerCustomerCare(
  sellerId: string,
  input: { customerCarePhone?: string | null; customerCareEmail?: string | null },
  actorUserId: string,
): Promise<SellerDisclosureAdminDto> {
  const before = await getSellerDisclosure(sellerId);
  const clean = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null);
  const data = {
    ...(input.customerCarePhone !== undefined ? { customerCarePhone: clean(input.customerCarePhone) } : {}),
    ...(input.customerCareEmail !== undefined ? { customerCareEmail: clean(input.customerCareEmail) } : {}),
  };
  await prisma.$transaction(async (tx) => {
    await tx.seller.update({ where: { id: sellerId }, data });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'seller.update_customer_care',
        entityType: 'Seller',
        entityId: sellerId,
        before: { customerCarePhone: before.customerCarePhone, customerCareEmail: before.customerCareEmail },
        after: data,
      },
    });
  });
  return getSellerDisclosure(sellerId);
}

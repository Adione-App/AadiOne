/**
 * Who a customer may buy from — cart/orderability.ts, enforced at cart add,
 * cart revalidation (read + quote) and, authoritatively, order placement.
 * A listing of a seller whose onboarding is still PENDING is not buyable
 * until the seller is approved.
 *
 * Each seller owns its catalogue, so listings are seeded in the seller's own
 * catalogue — the admin panel is read-only for catalogues (the old admin
 * "create listing for a seller" route no longer exists).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, PaymentMethod } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedAddress, seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

async function seedSeller(onboardingStatus: ApprovalStatus): Promise<string> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: `Seller ${onboardingStatus}`,
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.62,
      longitude: 75.14,
      isActive: true,
      ...sellerLifecycleFields(onboardingStatus),
    },
  });
  return seller.id;
}

/** A listing of an approved product in the seller's own catalogue. */
async function listingFor(sellerId: string, pricePaise = 15000): Promise<string> {
  const product = await seedProduct(sellerId, { pricePaise, mrpPaise: pricePaise + 1000, stockQty: 10 });
  return product.storeVariantId;
}

async function customer() {
  await otpService.clearOtpState('9600000001');
  const session = await loginAs('9600000001');
  return { token: session.accessToken, addressId: await seedAddress(session.userId) };
}

const addToCart = (token: string, sellerListingId: string) =>
  api().post('/api/v1/cart/items').set('Authorization', bearer(token)).send({ sellerListingId, qty: 1 });

const placeOrder = (token: string, addressId: string) =>
  api()
    .post('/api/v1/orders')
    .set('Authorization', bearer(token))
    .set('Idempotency-Key', randomUUID())
    .send({ addressId, paymentMethod: PaymentMethod.COD });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

describe('orderability', () => {
  it('an approved, active seller listing can be ordered', async () => {
    const listing = await listingFor(await seedSeller(ApprovalStatus.APPROVED));
    const cust = await customer();
    await addToCart(cust.token, listing).expect(200);
    await placeOrder(cust.token, cust.addressId).expect(201);
  });

  it('a listing of a seller still PENDING onboarding cannot be bought', async () => {
    const listing = await listingFor(await seedSeller(ApprovalStatus.PENDING));
    const cust = await customer();
    const res = await addToCart(cust.token, listing);
    expect(res.status).toBe(409);
    expect(expectError(res.body).code).toBe(ErrorCode.PRODUCT_UNAVAILABLE);
  });

  // Since partial checkout: the line is KEPT (marked, outside the bill) so it
  // can be ordered again if the admin reactivates the seller — never ordered
  // meanwhile. A deactivated store is a closed store (SELLER_CLOSED).
  it('a line whose seller stops trading after it was added is kept, marked, and refused at checkout', async () => {
    const sellerId = await seedSeller(ApprovalStatus.APPROVED);
    const listing = await listingFor(sellerId);
    const cust = await customer();
    await addToCart(cust.token, listing).expect(200);

    await prisma.seller.update({ where: { id: sellerId }, data: { isActive: false } });
    const order = await placeOrder(cust.token, cust.addressId);
    expect(order.status).toBe(409);
    expect(expectError(order.body).code).toBe(ErrorCode.SELLER_CLOSED);
    expect(await prisma.order.count()).toBe(0);

    const cart = expectSuccess<{ items: { available: boolean; storeClosedReason: string | null }[]; changes: { type: string }[] }>(
      (await api().get('/api/v1/cart').set('Authorization', bearer(cust.token)).expect(200)).body,
    ).data;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]!.available).toBe(false);
    expect(cart.items[0]!.storeClosedReason).toBe('SELLER_INACTIVE');
    expect(cart.changes).toEqual([]);
  });

  it('a deleted seller, an unavailable listing and an unapproved product cannot be ordered', async () => {
    const cust = await customer();

    const deletedSeller = await seedSeller(ApprovalStatus.APPROVED);
    const deletedListing = await listingFor(deletedSeller);
    await prisma.seller.update({ where: { id: deletedSeller }, data: { deletedAt: new Date() } });
    expect((await addToCart(cust.token, deletedListing)).status).toBe(409);

    const unavailableListing = await listingFor(await seedSeller(ApprovalStatus.APPROVED));
    await prisma.sellerListing.update({ where: { id: unavailableListing }, data: { isAvailable: false } });
    expect((await addToCart(cust.token, unavailableListing)).status).toBe(409);

    const reviewListing = await listingFor(await seedSeller(ApprovalStatus.APPROVED));
    const variant = await prisma.sellerListing.findUniqueOrThrow({ where: { id: reviewListing }, select: { variant: { select: { productId: true } } } });
    await prisma.product.update({ where: { id: variant.variant.productId }, data: { approvalStatus: 'PENDING' } });
    expect((await addToCart(cust.token, reviewListing)).status).toBe(409);
  });
});

/**
 * Seller details shown to customers (GET /stores/:sellerId/details) and the
 * customer-care contact behind them (seller-disclosure.service.ts).
 *
 *   - business name, store address and the published customer-care contact
 *     — for grocery and food sellers alike; FSSAI for food sellers;
 *   - never the owner's personal mobile (`sellers.phone`), PAN, Aadhaar,
 *     bank details or owner name;
 *   - no invented contact: until the seller or an admin publishes one, there
 *     is none, and the admin sees a warning;
 *   - a seller edits only its own contact; every change is audited;
 *   - unapproved or deleted sellers are not disclosed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SellerType, UserRole, type SellerDetailsDto, formatSellerAddress, sellerDisclosureGaps } from '../../src/shared';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { panelToken, seedSeller } from '../helpers/refund-fixtures';
import { sellerLifecycleFields } from '../helpers/fixtures';
import type { SellerDisclosureAdminDto } from '../../src/modules/sellers/seller-disclosure.service';

const details = async (sellerId: string, status = 200) => api().get(`/api/v1/stores/${sellerId}/details`).expect(status);

async function seedFullSeller(name: string, mobile: string, sellerType: SellerType = SellerType.GROCERY) {
  const sellerId = await seedSeller(name, mobile);
  await prisma.seller.update({
    where: { id: sellerId },
    data: { sellerType, phone: '9876500000', addressLine: 'Shop 4, Main Bazaar', locality: 'Ward 2', district: 'Sikar' },
  });
  await prisma.sellerProfile.create({
    data: {
      sellerId,
      businessName: `${name} Traders`,
      ownerFullName: 'Private Owner',
      ownerMobile: '9876500000',
      panNumber: 'ABCDE1234F',
      fssaiNumber: '12345678901234',
    },
  });
  return sellerId;
}

beforeEach(async () => {
  await truncateAll();
});

describe('what customers see', () => {
  it('business name, store address and nothing private; no contact until one is published', async () => {
    const sellerId = await seedFullSeller('Kirana', '9400000921');
    const shown = expectSuccess<SellerDetailsDto>((await details(sellerId)).body).data;
    expect(shown).toEqual({
      sellerId,
      displayName: 'Kirana',
      businessName: 'Kirana Traders',
      sellerType: 'GROCERY',
      address: 'Shop 4, Main Bazaar, Ward 2, Sikar, Rajasthan 332001',
      customerCare: { phone: null, email: null },
      fssaiNumber: null, // FSSAI is disclosed for food sellers only
    });
    const text = JSON.stringify(shown);
    for (const secret of ['9876500000', 'ABCDE1234F', 'Private Owner']) expect(text).not.toContain(secret);
  });

  it('food sellers show their FSSAI number; the published contact appears for grocery and food alike', async () => {
    const restaurant = await seedFullSeller('Dhaba', '9400000922', SellerType.RESTAURANT);
    await prisma.seller.update({ where: { id: restaurant }, data: { customerCarePhone: '+91 90000 00022', customerCareEmail: 'dhaba@example.test' } });
    const shown = expectSuccess<SellerDetailsDto>((await details(restaurant)).body).data;
    expect(shown.fssaiNumber).toBe('12345678901234');
    expect(shown.customerCare).toEqual({ phone: '+91 90000 00022', email: 'dhaba@example.test' });
  });

  it('an unapproved, deleted or unknown seller is not disclosed', async () => {
    const pending = await seedFullSeller('Pending', '9400000923');
    await prisma.seller.update({ where: { id: pending }, data: sellerLifecycleFields('PENDING') });
    await details(pending, 404);
    const deleted = await seedFullSeller('Gone', '9400000924');
    await prisma.seller.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    await details(deleted, 404);
    await details('00000000-0000-4000-8000-000000000000', 404);
  });
});

describe('admin warnings and editing', () => {
  it('lists what is missing, and an admin can publish the contact (audited)', async () => {
    const sellerId = await seedFullSeller('Fresh', '9400000925', SellerType.CAFE);
    await prisma.sellerProfile.update({ where: { sellerId }, data: { fssaiNumber: null } });
    const { token } = await panelToken(UserRole.ADMIN);
    const before = expectSuccess<SellerDisclosureAdminDto>(
      (await api().get(`/api/v1/admin/sellers/${sellerId}/disclosure`).set('Authorization', bearer(token)).expect(200)).body,
    ).data;
    expect(before.gaps).toEqual(['Customer-care phone or email for customers', 'FSSAI licence / registration number']);

    const after = expectSuccess<SellerDisclosureAdminDto>(
      (
        await api()
          .patch(`/api/v1/admin/sellers/${sellerId}/disclosure`)
          .set('Authorization', bearer(token))
          .send({ customerCarePhone: '+91 90000 00025' })
          .expect(200)
      ).body,
    ).data;
    expect(after.gaps).toEqual(['FSSAI licence / registration number']);
    expect(after.preview?.customerCare.phone).toBe('+91 90000 00025');
    expect(await prisma.auditLog.count({ where: { action: 'seller.update_customer_care', entityId: sellerId } })).toBe(1);

    expect((await api().patch(`/api/v1/admin/sellers/${sellerId}/disclosure`).set('Authorization', bearer(token)).send({ customerCarePhone: 'call me' })).status).toBe(400);
    expect((await api().patch(`/api/v1/admin/sellers/${sellerId}/disclosure`).set('Authorization', bearer(token)).send({ phone: '9999999999' })).status).toBe(400);
  });

  it('a seller edits only its own contact; a customer cannot', async () => {
    const mine = await seedFullSeller('Mine', '9400000926');
    const theirs = await seedFullSeller('Theirs', '9400000927');
    const seller = await loginAs('9400000926');
    await api().patch('/api/v1/seller/disclosure').set('Authorization', bearer(seller.accessToken)).send({ customerCareEmail: 'help@mine.example' }).expect(200);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: mine } })).customerCareEmail).toBe('help@mine.example');
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: theirs } })).customerCareEmail).toBeNull();
    // Clearing it removes the contact again.
    await api().patch('/api/v1/seller/disclosure').set('Authorization', bearer(seller.accessToken)).send({ customerCareEmail: '' }).expect(200);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: mine } })).customerCareEmail).toBeNull();

    const customer = await loginAs('9400000928');
    expect((await api().patch('/api/v1/seller/disclosure').set('Authorization', bearer(customer.accessToken)).send({ customerCareEmail: 'x@y.example' })).status).toBe(403);
  });
});

describe('shared rules', () => {
  it('formats the address without repeats and reports gaps', () => {
    expect(formatSellerAddress({ addressLine: 'Main Road', locality: 'Railmagra', city: 'Railmagra', district: 'Rajsamand', state: 'Rajasthan', pincode: '313329' })).toBe(
      'Main Road, Railmagra, Rajsamand, Rajasthan 313329',
    );
    expect(sellerDisclosureGaps({ businessName: ' ', customerCarePhone: null, customerCareEmail: null, fssaiNumber: null, isFoodSeller: false })).toEqual([
      'Registered business name',
      'Customer-care phone or email for customers',
    ]);
  });
});

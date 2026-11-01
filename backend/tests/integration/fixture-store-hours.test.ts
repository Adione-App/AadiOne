/**
 * The "always open" test store really is open every minute of the day.
 *
 * It used to be 00:00–23:59, which the store-hours rule (open <= now < close)
 * treats as CLOSED from 23:59 to 00:00 IST: a full test run crossing midnight
 * failed customer-seller-same-mobile.test.ts with 409 on POST /cart/items.
 * The fixture now uses 00:00–00:00 — the app's own all-day form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, bearer, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { evaluateSellerAvailability } from '../../src/modules/sellers/seller.service';
import { seedProduct, seedStore } from '../helpers/fixtures';

const MOBILE = '9400000951';

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fixture store hours', () => {
  it('is open at 23:59:30 IST — the minute that used to fail — and at 00:00:30', async () => {
    const storeId = await seedStore();
    const seller = await prisma.seller.findUniqueOrThrow({ where: { id: storeId }, include: { hours: true } });
    for (const iso of ['2026-11-01T18:29:30.000Z', '2026-11-01T18:30:30.000Z', '2026-11-01T06:00:00.000Z']) {
      const availability = await evaluateSellerAvailability(seller, new Date(iso));
      expect(availability.isOpen, iso).toBe(true);
      expect(availability.acceptingOrders, iso).toBe(true);
    }
  });

  it('a cart add at 23:59:30 IST succeeds (it returned 409 before)', async () => {
    const storeId = await seedStore();
    const product = await seedProduct(storeId, { stockQty: 10 });
    await otpService.clearOtpState(MOBILE);
    const session = await loginAs(MOBILE);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T18:29:30.000Z')); // 23:59:30 Asia/Kolkata
    await api()
      .post('/api/v1/cart/items')
      .set('Authorization', bearer(session.accessToken))
      .send({ sellerListingId: product.storeVariantId, qty: 1 })
      .expect(200);
  });
});

/**
 * A store's trading switch and opening-hours editor — V2: the SELLER's own
 * controls (`/seller/availability`, `/seller/hours`).
 *
 * V1 had one platform store run from `/admin/store/*` and a customer-facing
 * `GET /store`. V2 is a marketplace: every seller runs its own switch and
 * week, the admin view is read-only, and customers see each store through
 * `/stores/:sellerId` and `/store/serviceability`. These are the same
 * guarantees as before, on the routes that exist now.
 *
 * The switch is the one setting whose failure mode is silent and expensive: a
 * shop that thinks it is taking orders but is not, or — worse — one that
 * cannot be switched back on because turning it off broke the endpoint that
 * turns it on. Both are covered here.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { seedProduct, sellerLifecycleFields } from '../helpers/fixtures';

const OWNER_MOBILE = '9700000101';

interface Availability {
  sellerId: string;
  isActive: boolean;
  isAcceptingOrders: boolean;
  isOpenNow: boolean;
  timezone: string;
  hoursConfigured: boolean;
  hours: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }[];
}

let sellerId: string;
let token: string;

/** A live grocery store at the Sikar fixture point, open 00:00–23:59 every day, with its owner signed in. */
async function seedOwnStore(): Promise<{ id: string; token: string }> {
  const seller = await prisma.seller.create({
    data: {
      code: `SEL-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: 'Test Store',
      sellerType: 'GROCERY',
      addressLine: 'Station Road',
      city: 'Sikar',
      state: 'Rajasthan',
      pincode: '332001',
      latitude: 27.6094,
      longitude: 75.1399,
      timezone: 'Asia/Kolkata',
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  await prisma.sellerHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ sellerId: seller.id, dayOfWeek, opensAt: '00:00', closesAt: '23:59', isClosed: false })),
  });
  const user = await prisma.user.create({ data: { mobile: OWNER_MOBILE, fullName: 'Store Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(OWNER_MOBILE);
  return { id: seller.id, token: (await loginAs(OWNER_MOBILE)).accessToken };
}

const getAvailability = async (): Promise<Availability> =>
  expectSuccess<Availability>((await api().get('/api/v1/seller/availability').set('Authorization', bearer(token)).expect(200)).body).data;

const setSwitch = (body: object) => api().patch('/api/v1/seller/availability').set('Authorization', bearer(token)).send(body);
const putHours = (hours: object[]) => api().put('/api/v1/seller/hours').set('Authorization', bearer(token)).send({ hours });

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  // The rate limiters are fixed-window counters in the cache, and this file
  // logs in on every case.
  await cache.clear();
  ({ id: sellerId, token } = await seedOwnStore());
});

describe('GET /seller/availability', () => {
  it('reports the saved week — and, with no hours saved, says so instead of inventing closed days', async () => {
    const saved = await getAvailability();
    expect(saved.sellerId).toBe(sellerId);
    expect(saved.hoursConfigured).toBe(true);
    expect(saved.hours.map((h) => h.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // V2: a seller with no weekly schedule has no hour restriction (asserted
    // in seller-availability.test.ts); the response must say none is set.
    await prisma.sellerHours.deleteMany({ where: { sellerId } });
    const none = await getAvailability();
    expect(none.hoursConfigured).toBe(false);
    expect(none.hours).toEqual([]);
  });

  it('requires authentication', async () => {
    await api().get('/api/v1/seller/availability').expect(401);
  });
});

describe('PATCH /seller/availability (the Store Open / Closed switch)', () => {
  it('switches the store off and back on', async () => {
    const off = expectSuccess<Availability>((await setSwitch({ isAcceptingOrders: false }).expect(200)).body).data;
    expect(off.isAcceptingOrders).toBe(false);
    expect(off.isOpenNow).toBe(false);

    const on = expectSuccess<Availability>((await setSwitch({ isAcceptingOrders: true }).expect(200)).body).data;
    expect(on.isAcceptingOrders).toBe(true);
    expect(on.isOpenNow).toBe(true);
  });

  /**
   * The regression this whole feature turns on: the seller lookup must not
   * filter on the switch, or switching off makes the store unreachable and
   * the switch becomes one-way.
   */
  it('can still be read and re-enabled after being switched off', async () => {
    await prisma.seller.update({ where: { id: sellerId }, data: { isAcceptingOrders: false } });

    const data = await getAvailability();
    expect(data.isAcceptingOrders).toBe(false);
    expect(data.hours).toHaveLength(7);

    await setSwitch({ isAcceptingOrders: true }).expect(200);
    expect((await getAvailability()).isAcceptingOrders).toBe(true);
  });

  it('records who switched the store off', async () => {
    await setSwitch({ isAcceptingOrders: false }).expect(200);

    const owner = await prisma.user.findFirstOrThrow({ where: { mobile: OWNER_MOBILE } });
    const log = await prisma.auditLog.findFirst({ where: { action: 'seller.store_close' } });
    expect(log).not.toBeNull();
    expect(log?.entityId).toBe(sellerId);
    expect(log?.actorUserId).toBe(owner.id);
  });

  it('rejects a non-boolean — and never lets the seller touch admin deactivation', async () => {
    await setSwitch({ isAcceptingOrders: 'yes' }).expect(400);
    await setSwitch({ isActive: false }).expect(400);
    expect((await prisma.seller.findUniqueOrThrow({ where: { id: sellerId } })).isActive).toBe(true);
  });
});

describe('PUT /seller/hours', () => {
  it('sets one day without disturbing the rest of the week', async () => {
    const data = expectSuccess<Availability>(
      (await putHours([{ dayOfWeek: 3, opensAt: '10:30', closesAt: '19:45', isClosed: false }]).expect(200)).body,
    ).data;
    expect(data.hours.find((h) => h.dayOfWeek === 3)).toMatchObject({ opensAt: '10:30', closesAt: '19:45', isClosed: false });
    // The store opened every day 00:00–23:59; the untouched days keep that.
    expect(data.hours.find((h) => h.dayOfWeek === 4)?.opensAt).toBe('00:00');
  });

  it('applies one window to the whole week', async () => {
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, opensAt: '08:00', closesAt: '22:00', isClosed: false }));
    const data = expectSuccess<Availability>((await putHours(hours).expect(200)).body).data;
    expect(data.hours.every((h) => h.opensAt === '08:00' && h.closesAt === '22:00')).toBe(true);
  });

  it('rejects a malformed time rather than storing it', async () => {
    await putHours([{ dayOfWeek: 1, opensAt: '8am', closesAt: '22:00', isClosed: false }]).expect(400);
    await putHours([{ dayOfWeek: 1, opensAt: '25:00', closesAt: '22:00', isClosed: false }]).expect(400);

    const monday = await prisma.sellerHours.findFirst({ where: { sellerId, dayOfWeek: 1 } });
    expect(monday?.opensAt).toBe('00:00');
  });

  it('rejects a day listed twice', async () => {
    const res = await putHours([
      { dayOfWeek: 1, opensAt: '08:00', closesAt: '12:00', isClosed: false },
      { dayOfWeek: 1, opensAt: '16:00', closesAt: '22:00', isClosed: false },
    ]);
    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a day outside 0–6', async () => {
    await putHours([{ dayOfWeek: 7, opensAt: '08:00', closesAt: '22:00', isClosed: false }]).expect(400);
  });
});

describe('customer-facing effect of the switch', () => {
  it('reports the store closed on its store page instead of failing the request', async () => {
    await seedProduct(sellerId, { pricePaise: 15000 });
    await setSwitch({ isAcceptingOrders: false }).expect(200);

    const res = await api().get(`/api/v1/stores/${sellerId}`).expect(200);
    expect(expectSuccess<{ id: string; isOpen: boolean }>(res.body).data).toMatchObject({ id: sellerId, isOpen: false });
  });

  it('still answers serviceability, with the store marked closed', async () => {
    await setSwitch({ isAcceptingOrders: false }).expect(200);

    const res = await api().get('/api/v1/store/serviceability?lat=27.6364&lng=75.1399').expect(200);
    const data = expectSuccess<{ serviceable: boolean; sellerOpen: boolean }>(res.body).data;
    expect(data.serviceable).toBe(true);
    expect(data.sellerOpen).toBe(false);
  });
});

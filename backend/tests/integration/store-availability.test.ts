/**
 * The admin trading switch and the opening-hours editor.
 *
 * The switch is the one setting whose failure mode is silent and expensive: a
 * shop that thinks it is taking orders but is not, or — worse — one that
 * cannot be switched back on because turning it off broke the endpoint that
 * turns it on. Both are covered here.
 *
 * V2: these endpoints act on the platform-owned Seller row (route paths kept
 * as `/admin/store*` — see admin-seller.routes.ts's own doc comment).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole } from '../../src/shared';
import { api, bearer, expectError, expectSuccess } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { hashPassword } from '../../src/common/crypto';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import { seedStore } from '../helpers/fixtures';

const ADMIN = { email: 'owner@adione.test', password: 'TestAdmin@123' };

interface Availability {
  isActive: boolean;
  isOpenNow: boolean;
  timezone: string;
  hours: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }[];
  nextOpenText: string | null;
}

async function loginAdmin(): Promise<string> {
  await prisma.user.create({
    data: {
      mobile: '0000000001',
      email: ADMIN.email,
      fullName: 'Store Owner',
      passwordHash: await hashPassword(ADMIN.password),
      role: UserRole.ADMIN,
    },
  });

  const res = await api().post('/api/v1/auth/admin/login').send(ADMIN).expect(200);
  return expectSuccess<{ tokens: { accessToken: string } }>(res.body).data.tokens.accessToken;
}

function getAvailability(token: string): Promise<Availability> {
  return api()
    .get('/api/v1/admin/store/availability')
    .set('Authorization', bearer(token))
    .expect(200)
    .then((res) => expectSuccess<Availability>(res.body).data);
}

let sellerId: string;
let token: string;

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  // The rate limiters are fixed-window counters in the cache, and this file
  // logs in on every case; without this the admin login limiter trips midway
  // through the suite and every later test fails on a 429 it never provoked.
  await cache.clear();
  sellerId = await seedStore({ open: true });
  token = await loginAdmin();
});

describe('GET /admin/store/availability', () => {
  it('always returns seven days, even when the store has no hours rows', async () => {
    await prisma.sellerHours.deleteMany({ where: { sellerId } });

    const data = await getAvailability(token);

    expect(data.hours).toHaveLength(7);
    expect(data.hours.map((h) => h.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // A missing day must read as closed, never as accidentally open 24h.
    expect(data.hours.every((h) => h.isClosed)).toBe(true);
  });

  it('requires authentication', async () => {
    await api().get('/api/v1/admin/store/availability').expect(401);
  });
});

describe('PATCH /admin/store/status', () => {
  it('switches the store off and back on', async () => {
    const off = await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: false })
      .expect(200);

    expect(expectSuccess<Availability>(off.body).data.isActive).toBe(false);
    expect(expectSuccess<Availability>(off.body).data.isOpenNow).toBe(false);

    const on = await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: true })
      .expect(200);

    expect(expectSuccess<Availability>(on.body).data.isActive).toBe(true);
  });

  /**
   * The regression this whole feature turns on: the seller lookup must not
   * filter by `isActive`, or switching off makes the store unreachable and
   * the switch becomes one-way.
   */
  it('can still be read and re-enabled after being switched off', async () => {
    await prisma.seller.update({ where: { id: sellerId }, data: { isActive: false } });

    const data = await getAvailability(token);
    expect(data.isActive).toBe(false);
    expect(data.hours).toHaveLength(7);

    await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: true })
      .expect(200);

    expect((await getAvailability(token)).isActive).toBe(true);
  });

  it('records who switched the store off', async () => {
    await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: false })
      .expect(200);

    const log = await prisma.auditLog.findFirst({ where: { action: 'seller.pause_trading' } });
    expect(log).not.toBeNull();
    expect(log?.entityId).toBe(sellerId);
  });

  it('rejects a non-boolean', async () => {
    await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: 'yes' })
      .expect(400);
  });
});

describe('PATCH /admin/store/hours', () => {
  it('sets one day without disturbing the rest of the week', async () => {
    const res = await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({ hours: [{ dayOfWeek: 3, opensAt: '10:30', closesAt: '19:45', isClosed: false }] })
      .expect(200);

    const data = expectSuccess<Availability>(res.body).data;
    const wednesday = data.hours.find((h) => h.dayOfWeek === 3);
    expect(wednesday).toMatchObject({ opensAt: '10:30', closesAt: '19:45', isClosed: false });

    // seedStore opened every day 00:00–23:59; the untouched days keep that.
    expect(data.hours.find((h) => h.dayOfWeek === 4)?.opensAt).toBe('00:00');
  });

  it('applies one window to the whole week', async () => {
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      opensAt: '08:00',
      closesAt: '22:00',
      isClosed: false,
    }));

    const res = await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({ hours })
      .expect(200);

    const data = expectSuccess<Availability>(res.body).data;
    expect(data.hours.every((h) => h.opensAt === '08:00' && h.closesAt === '22:00')).toBe(true);
  });

  it('rejects a malformed time rather than storing it', async () => {
    await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({ hours: [{ dayOfWeek: 1, opensAt: '8am', closesAt: '22:00', isClosed: false }] })
      .expect(400);

    await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({ hours: [{ dayOfWeek: 1, opensAt: '25:00', closesAt: '22:00', isClosed: false }] })
      .expect(400);

    const monday = await prisma.sellerHours.findFirst({ where: { sellerId, dayOfWeek: 1 } });
    expect(monday?.opensAt).toBe('00:00');
  });

  it('rejects a day listed twice', async () => {
    const res = await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({
        hours: [
          { dayOfWeek: 1, opensAt: '08:00', closesAt: '12:00', isClosed: false },
          { dayOfWeek: 1, opensAt: '16:00', closesAt: '22:00', isClosed: false },
        ],
      });

    expect(res.status).toBe(400);
    expect(expectError(res.body).code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a day outside 0–6', async () => {
    await api()
      .patch('/api/v1/admin/store/hours')
      .set('Authorization', bearer(token))
      .send({ hours: [{ dayOfWeek: 7, opensAt: '08:00', closesAt: '22:00', isClosed: false }] })
      .expect(400);
  });
});

describe('customer-facing effect of the switch', () => {
  async function switchOff(): Promise<void> {
    await api()
      .patch('/api/v1/admin/store/status')
      .set('Authorization', bearer(token))
      .send({ isActive: false })
      .expect(200);
  }

  it('reports the store closed instead of failing the request', async () => {
    await switchOff();

    const res = await api().get('/api/v1/store').expect(200);
    const data = expectSuccess<{ isActive: boolean; isOpenNow: boolean }>(res.body).data;

    expect(data.isActive).toBe(false);
    expect(data.isOpenNow).toBe(false);
  });

  it('still answers serviceability, with the store marked closed', async () => {
    await switchOff();

    const res = await api()
      .get('/api/v1/store/serviceability?lat=27.6364&lng=75.1399')
      .expect(200);

    const data = expectSuccess<{ serviceable: boolean; sellerOpen: boolean }>(res.body).data;
    expect(data.serviceable).toBe(true);
    expect(data.sellerOpen).toBe(false);
  });
});

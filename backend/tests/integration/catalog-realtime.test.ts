/**
 * `catalog.changed` end to end: the real realtime server (initRealtime) on a
 * real HTTP server, and the CUSTOMER APP's own Socket.IO client
 * (mobile/node_modules/socket.io-client, connected the way mobile/src/lib/
 * socket.ts connects: polling first, access token in `auth`). A seller's
 * category changes and an admin's Home changes reach the connected app;
 * nothing is sent for a change that was refused.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStatus, SellerType, UserRole } from '../../src/shared';
import { createApp } from '../../src/app';
import { initRealtime, shutdownRealtime } from '../../src/realtime/socket';
import { api, bearer, expectSuccess, loginAs } from '../helpers/api';
import { prisma, truncateAll } from '../helpers/db';
import { sellerLifecycleFields } from '../helpers/fixtures';
import { cache } from '../../src/infra/cache';
import * as configService from '../../src/modules/configuration/configuration.service';
import * as otpService from '../../src/modules/auth/otp.service';
import { getAdminHomeMainCategories, saveHomeMainCategories } from '../../src/modules/content/home-categories.service';
// The customer app's client library, exactly the version it ships.
import { io as connect, type Socket } from '../../../mobile/node_modules/socket.io-client/build/esm-debug/index.js';

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer(createApp());
  initRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  shutdownRealtime();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await truncateAll();
  await configService.invalidateAll();
  await cache.clear();
});

async function customerSocket(mobile: string): Promise<{ socket: Socket; events: () => number; next: () => Promise<void> }> {
  await prisma.user.create({ data: { mobile, fullName: 'Customer', role: UserRole.CUSTOMER } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  const socket = connect(url, { auth: { token }, transports: ['polling', 'websocket'], reconnection: false, forceNew: true });
  let count = 0;
  const waiters: (() => void)[] = [];
  socket.on('catalog.changed', () => {
    count += 1;
    waiters.splice(0).forEach((resolve) => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return {
    socket,
    events: () => count,
    next: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no catalog.changed within 5 s')), 5_000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

async function sellerOwner(mobile: string) {
  const seller = await prisma.seller.create({
    data: {
      code: `RT-${randomUUID().slice(0, 8)}`,
      name: 'Realtime Store',
      sellerType: SellerType.GROCERY,
      addressLine: 'Main Road',
      city: 'Railmagra',
      state: 'Rajasthan',
      pincode: '313329',
      latitude: 25.03,
      longitude: 74.11,
      isActive: true,
      ...sellerLifecycleFields(ApprovalStatus.APPROVED),
    },
  });
  const user = await prisma.user.create({ data: { mobile, fullName: 'Owner', role: UserRole.SELLER_OWNER } });
  await prisma.sellerStaff.create({ data: { sellerId: seller.id, userId: user.id, role: 'OWNER', isActive: true } });
  await otpService.clearOtpState(mobile);
  const token = (await loginAs(mobile)).accessToken;
  return {
    post: (path: string, body: object) => api().post(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
    patch: (path: string, body: object) => api().patch(`/api/v1/seller${path}`).set('Authorization', bearer(token)).send(body),
    del: (path: string) => api().delete(`/api/v1/seller${path}`).set('Authorization', bearer(token)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('a connected customer app receives catalog.changed', () => {
  it('for add, hide, unhide, re-order and delete of a category — and nothing for a refused delete', async () => {
    const app = await customerSocket('9400000951');
    const seller = await sellerOwner('9400000952');
    try {
      let next = app.next();
      const tree = expectSuccess<{ categories: { id: string; name: string }[] }>((await seller.post('/categories', { name: 'Grocery' }).expect(201)).body).data;
      await next;
      const groceryId = tree.categories.find((c) => c.name === 'Grocery')!.id;

      next = app.next();
      const teaId = expectSuccess<{ id: string }>((await seller.post('/subcategories', { parentId: groceryId, name: 'Tea & Coffee' }).expect(201)).body).data.id;
      await next;

      for (const change of [{ isActive: false }, { isActive: true }, { displayOrder: 7 }]) {
        next = app.next();
        await seller.patch(`/subcategories/${teaId}`, change).expect(200);
        await next;
      }

      // A refused delete (a product is attached) changes nothing and announces nothing.
      const product = await prisma.product.create({
        data: { name: 'Assam Tea', slug: `t-${randomUUID().slice(0, 6)}`, categoryId: teaId, status: 'ACTIVE', approvalStatus: 'APPROVED', searchKeywords: [] },
      });
      const before = app.events();
      await seller.del(`/subcategories/${teaId}`).expect(409);
      await settle();
      expect(app.events()).toBe(before);

      // Emptied (product moved, never deleted), the delete goes through and is announced.
      const otherId = expectSuccess<{ id: string }>((await seller.post('/subcategories', { parentId: groceryId, name: 'Drinks' }).expect(201)).body).data.id;
      await prisma.product.update({ where: { id: product.id }, data: { categoryId: otherId } });
      await settle();
      next = app.next();
      await seller.del(`/subcategories/${teaId}`).expect(200);
      await next;
      expect(await prisma.product.count({ where: { id: product.id, deletedAt: null } })).toBe(1);
      // Grocery, Tea & Coffee, 3 edits, Drinks, the delete — the refused delete sent nothing.
      expect(app.events()).toBe(7);
    } finally {
      app.socket.disconnect();
    }
  });

  it('for an admin saving the Home page main categories (hide / re-order)', async () => {
    const app = await customerSocket('9400000953');
    try {
      const admin = await prisma.user.create({ data: { mobile: '9400000954', fullName: 'Admin', role: UserRole.ADMIN } });
      const current = await getAdminHomeMainCategories();
      const next = app.next();
      await saveHomeMainCategories({ order: [], hidden: [], featured: [], newCategoriesVisible: true, basedOnUpdatedAt: current.updatedAt }, admin.id);
      await next;
      expect(app.events()).toBe(1);
    } finally {
      app.socket.disconnect();
    }
  });
});

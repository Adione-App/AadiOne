/**
 * Realtime order status (Phase 12).
 *
 * Socket.IO rather than a bare WebSocket: automatic reconnection and
 * long-polling fallback matter far more on rural 3G than raw efficiency.
 *
 * REALTIME IS AN OPTIMISATION, NEVER THE ONLY PATH. Both clients also poll
 * (mobile every 30 s while an order is live, admin/seller panel every 20 s).
 * A dropped socket must never cause a seller to miss an order.
 *
 * V2: `rooms.seller` replaces V1's single `rooms.store` — sellers only ever
 * see events for their OWN SellerOrders. `rooms.admin` is new: one shared
 * room every admin-role connection joins automatically, since admin has
 * full cross-seller visibility (#26) and previously relied on there being
 * only one store room to subscribe to.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { corsOrigins } from '../config/env';
import { moduleLogger } from '../common/logger';
import { verifyAccessToken } from '../modules/auth/token.service';
import { prisma } from '../infra/db/prisma';
import { isAdminRole, isSellerRole, type OrderStatus, type SellerOrderStatus } from '../shared';

const log = moduleLogger('realtime');

let io: Server | null = null;

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  seller: (sellerId: string) => `seller:${sellerId}`,
  admin: () => `admin`,
} as const;

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: corsOrigins.length > 0 ? corsOrigins : true, credentials: true },
    // Polling first, upgrading to websocket: some Indian mobile networks and
    // corporate proxies block websocket upgrades outright, and falling back
    // silently is better than a dead tracking screen.
    transports: ['polling', 'websocket'],
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth as { token?: string }).token ??
        socket.handshake.headers.authorization?.replace(/^Bearer /i, '');

      if (!token) return next(new Error('unauthenticated'));

      const claims = verifyAccessToken(token);
      socket.data.userId = claims.sub;
      socket.data.role = claims.role;
      next();
    } catch {
      // Sockets are authenticated exactly like HTTP requests — an expired
      // token must not leak another customer's order updates.
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    const role = socket.data.role as Parameters<typeof isAdminRole>[0];

    // Every client joins its own user room.
    void socket.join(rooms.user(userId));

    // Admin staff get every order across every seller automatically — there
    // is no per-seller subscription step for them (#26: full visibility).
    if (isAdminRole(role)) {
      void socket.join(rooms.admin());
    }

    socket.on('seller:subscribe', (sellerId: string) => {
      if (isAdminRole(role)) {
        void socket.join(rooms.seller(sellerId));
        return;
      }
      if (!isSellerRole(role)) {
        log.warn({ userId, role }, 'non-seller attempted to subscribe to a seller room');
        return;
      }
      // Ownership check: a seller role only gets events for a seller it is
      // actually staff of (#15/#27) — never trusted from the client alone.
      void prisma.sellerStaff
        .findFirst({ where: { userId, sellerId, isActive: true }, select: { id: true } })
        .then((staff) => {
          if (!staff) {
            log.warn({ userId, sellerId }, 'seller subscribe denied — not staff of this seller');
            return;
          }
          void socket.join(rooms.seller(sellerId));
        });
    });

    socket.on('disconnect', (reason) => {
      log.debug({ userId, reason }, 'socket disconnected');
    });
  });

  log.info('realtime server initialised');
  return io;
}

export interface OrderStatusEvent {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  etaMinutes?: number | null;
}

export interface SellerOrderStatusEvent {
  orderId: string;
  sellerOrderId: string;
  orderNumber: string;
  status: SellerOrderStatus;
  statusLabel: string;
}

/** Push a status change to the customer's devices. */
export function emitOrderStatus(userId: string, event: OrderStatusEvent): void {
  io?.to(rooms.user(userId)).emit('order.status_changed', event);
}

/**
 * Tell admin (every staff connection, cross-seller) a new order arrived.
 * The panel plays a repeating chime on this until acknowledged — a missed
 * new order is the single most costly failure at the counter (PRD §20 R7).
 */
export function emitNewOrder(event: OrderStatusEvent): void {
  io?.to(rooms.admin()).emit('order.created', event);
}

export function emitAdminOrderStatus(event: OrderStatusEvent): void {
  io?.to(rooms.admin()).emit('order.status_changed', event);
}

/** Tell one seller a new SellerOrder landed, or one of theirs changed. */
export function emitNewSellerOrder(sellerId: string, event: SellerOrderStatusEvent): void {
  io?.to(rooms.seller(sellerId)).emit('seller_order.created', event);
  io?.to(rooms.admin()).emit('seller_order.created', event);
}

export function emitSellerOrderStatus(sellerId: string, event: SellerOrderStatusEvent): void {
  io?.to(rooms.seller(sellerId)).emit('seller_order.status_changed', event);
  io?.to(rooms.admin()).emit('seller_order.status_changed', event);
}

export function shutdownRealtime(): void {
  io?.close();
  io = null;
}

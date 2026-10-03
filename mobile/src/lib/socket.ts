/**
 * Live order updates (Task 12.1, client side).
 *
 * Best-effort by design. Every screen using this ALSO polls, because a socket
 * that dies quietly on a flaky mobile network must never be the only way a
 * customer learns their order is out for delivery.
 */

import { useEffect, useRef } from 'react';
import Constants from 'expo-constants';
import { io, type Socket } from 'socket.io-client';
import type { OrderStatus } from '@shared';

export interface OrderStatusEvent {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  etaMinutes?: number | null;
}

interface Handlers {
  onStatusChanged?: (event: OrderStatusEvent) => void;
}

const SOCKET_URL = (
  process.env['EXPO_PUBLIC_API_URL'] ??
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ??
  'http://10.0.2.2:4100/api/v1' // V2 dev backend (see api.ts)
).replace(/\/api\/v1\/?$/, '');

let socket: Socket | null = null;
let currentToken: string | null = null;

/** Called after login/refresh so the socket authenticates with a live token. */
export function connectSocket(accessToken: string): void {
  if (socket && currentToken === accessToken) return;

  socket?.disconnect();
  currentToken = accessToken;
  socket = io(SOCKET_URL, {
    auth: { token: accessToken },
    // Polling first: some Indian mobile networks and proxies block websocket
    // upgrades outright, and a silent fallback beats a dead tracking screen.
    transports: ['polling', 'websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    // Suppresses ngrok's HTML interstitial on the polling handshake, which
    // would otherwise break the connection before it starts.
    extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
  });
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  currentToken = null;
}

export function useOrderSocket(handlers: Handlers): void {
  // Held in a ref so re-renders do not tear down and rebuild the subscription.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!socket) return;

    const handleChanged = (event: OrderStatusEvent): void => {
      ref.current.onStatusChanged?.(event);
    };

    socket.on('order.status_changed', handleChanged);
    return () => {
      socket?.off('order.status_changed', handleChanged);
    };
  }, []);
}

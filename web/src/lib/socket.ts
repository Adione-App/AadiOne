/**
 * Realtime subscription for the store panel.
 *
 * Deliberately best-effort. Every screen that uses this ALSO polls, because a
 * missed new order is the most expensive failure at the counter and a socket
 * that silently dies on a flaky connection must not be the only signal.
 */

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from './api';

interface OrderEvent {
  orderId: string;
  orderNumber: string;
  status: string;
}

interface Handlers {
  onNewOrder?: (event: OrderEvent) => void;
  onStatusChanged?: (event: OrderEvent) => void;
}

let socket: Socket | null = null;

function ensureSocket(): Socket | null {
  const token = getAccessToken();
  if (!token) return null;

  // Absolute URL when the API is on another host (ngrok, a deployed backend);
  // same-origin otherwise, which the Nginx container proxies.
  const socketUrl = import.meta.env['VITE_SOCKET_URL'] as string | undefined;

  socket ??= io(socketUrl ?? '/', {
    path: '/socket.io',
    auth: { token },
    transports: ['polling', 'websocket'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    // Suppresses ngrok's HTML interstitial on the polling handshake.
    extraHeaders: { 'ngrok-skip-browser-warning': 'true' },
  });

  return socket;
}

export function useOrderSocket(handlers: Handlers, storeId?: string): void {
  // Handlers are held in a ref so re-renders do not tear down and rebuild the
  // subscription on every keystroke in the search box.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const instance = ensureSocket();
    if (!instance) return;

    const handleCreated = (event: OrderEvent) => ref.current.onNewOrder?.(event);
    const handleChanged = (event: OrderEvent) => ref.current.onStatusChanged?.(event);
    // Without this, a rejected handshake (wrong/expired token, or the
    // origin missing from the backend's CORS_ORIGINS) fails completely
    // silently — socket.io-client just keeps retrying forever in the
    // background with nothing in the UI or console to explain why the "new
    // order" chime never fires. The REST poll this screen also runs is what
    // was masking this: the order list still updates (just up to ~20s late),
    // making the missing socket connection easy to miss.
    const handleConnectError = (error: Error) => {
      // eslint-disable-next-line no-console
      console.error(
        '[socket] connection failed — realtime order updates/chime are down, falling back to polling:',
        error.message,
      );
    };

    instance.on('order.created', handleCreated);
    instance.on('order.status_changed', handleChanged);
    instance.on('connect_error', handleConnectError);
    instance.on('connect', () => {
      if (storeId) instance.emit('store:subscribe', storeId);
    });

    if (instance.connected && storeId) instance.emit('store:subscribe', storeId);

    return () => {
      instance.off('order.created', handleCreated);
      instance.off('order.status_changed', handleChanged);
      instance.off('connect_error', handleConnectError);
    };
  }, [storeId]);
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

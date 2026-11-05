/**
 * New-order alerts (GET /admin/order-alerts): the Orders badge count and the
 * "NEW ORDER" popups. Read state is the server's, per admin.
 *
 * Never only the socket: the list is re-read on load, on window focus, on a
 * 30 s timer, on every realtime "order.created" and on every socket
 * (re)connect — so an event missed while offline or asleep still shows.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminOrderAlertsDto } from '@shared';
import { api } from './api';

/** Under "admin-orders": every Orders refresh re-reads the alerts too. */
export const orderAlertsKey = ['admin-orders', 'alerts'] as const;

export function useOrderAlerts(enabled = true) {
  return useQuery({
    queryKey: orderAlertsKey,
    queryFn: () => api.get<AdminOrderAlertsDto>('/admin/order-alerts'),
    enabled,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Always re-read on a reconnect / an event (no 10 s staleness window).
    staleTime: 0,
    // A read started by an event during a network blip is retried (1 s, 2 s,
    // 4 s) — the order then shows seconds after the link is back, not at the
    // next 30 s poll.
    retry: 3,
  });
}

/** The admin opened an order: read for them (idempotent; a no-op when it had no alert). */
export function useMarkOrderRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => api.post<{ unread: number }>(`/admin/order-alerts/${orderId}/read`),
    onMutate: async (orderId) => {
      // The badge drops at once; the server answer confirms it.
      await queryClient.cancelQueries({ queryKey: orderAlertsKey });
      const previous = queryClient.getQueryData<AdminOrderAlertsDto>(orderAlertsKey);
      if (previous && previous.items.some((item) => item.orderId === orderId)) {
        queryClient.setQueryData<AdminOrderAlertsDto>(orderAlertsKey, {
          unread: Math.max(0, previous.unread - 1),
          items: previous.items.filter((item) => item.orderId !== orderId),
        });
      }
      return { previous };
    },
    onError: (_error, _orderId, context) => {
      if (context?.previous) queryClient.setQueryData(orderAlertsKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orderAlertsKey }),
  });
}

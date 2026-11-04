/**
 * The admin warning for orders that are PAID but NOT PLACED: Cashfree
 * confirmed (and the server verified) the payment, yet the order is still not
 * with its sellers well after the webhook, the app's own check and several
 * reconciliation runs had their chance (GET /admin/payment-anomalies,
 * backend listPaidNotPlaced). Rare, and money is involved — so it is loud.
 *
 * Read-only: nothing here retries, places or refunds — reconciliation keeps
 * trying by itself. Derived live from the server, so an order leaves the
 * warning on its own the moment its placement succeeds. Shown on Orders,
 * Dashboard and Payments; renders nothing when all is well (or when the
 * viewer cannot read orders).
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Permission, roleHasPermission, type AdminPaidNotPlacedDto } from '@shared';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Icon } from '@/components/ui';

/** Under "admin-orders", so every order refresh re-reads it too. */
export const paidNotPlacedKey = ['admin-orders', 'payment-anomalies'] as const;

export function PaidNotPlacedAlert({ paymentsLink = true }: { paymentsLink?: boolean }) {
  // The Payments page is ORDER_REFUND only (Admin / Super Admin) — the same
  // rule the sidebar uses. Staff see the warning, but no link they could not open.
  const role = useAuth((state) => state.user?.role);
  const canOpenPayments = role !== undefined && roleHasPermission(role, Permission.ORDER_REFUND);
  const anomalies = useQuery({
    queryKey: paidNotPlacedKey,
    queryFn: () => api.get<AdminPaidNotPlacedDto>('/admin/payment-anomalies'),
    refetchInterval: 60_000,
    retry: false,
  });
  const data = anomalies.data;
  if (!data || data.total === 0) return null;

  return (
    <div role="alert" className="rounded-2xl border border-danger-500/40 bg-danger-50 px-4 py-3 text-sm text-danger-600">
      <p className="flex items-center gap-2 font-semibold">
        <Icon name="alert" className="h-4 w-4 shrink-0" />
        {data.total === 1 ? '1 paid order is not placed' : `${data.total} paid orders are not placed`}
      </p>
      <p className="mt-1 text-gray-700">
        Cashfree confirmed these payments more than {data.afterMinutes} minutes ago, but the orders have not reached their sellers. The
        system keeps retrying automatically and this warning clears by itself once an order is placed. Never ask the customer to pay again;
        if an order stays here, check the server logs for that order.
      </p>
      <ul className="mt-2 divide-y divide-danger-500/10">
        {data.items.slice(0, 5).map((item) => (
          <li key={item.orderId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-gray-800">
            <span className="font-mono font-semibold">#{item.orderNumber}</span>
            <span className="font-semibold tabular-nums">{formatPaise(item.amountPaise)}</span>
            <span className="text-gray-600">{item.customerName ?? 'Customer'}</span>
            <span className="text-gray-600">paid {item.minutesSinceCapture} min ago</span>
            {item.providerOrderId && <span className="font-mono text-xs text-gray-500">Cashfree {item.providerOrderId}</span>}
            {paymentsLink && canOpenPayments && (
              <Link to={`/payments?q=${encodeURIComponent(item.orderNumber)}`} className="font-medium text-brand-600 hover:underline">
                Payment →
              </Link>
            )}
          </li>
        ))}
      </ul>
      {data.total > 5 && <p className="mt-1 text-xs text-gray-600">…and {data.total - 5} more.</p>}
    </div>
  );
}

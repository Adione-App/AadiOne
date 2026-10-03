/**
 * Customers.
 *
 * There is no /admin/customers endpoint yet, and inventing one on the client
 * would be worse than being honest about where this comes from: the list is
 * derived from orders, so it shows people who have ordered, not everyone who
 * has registered. That is also the list the shop actually cares about.
 *
 * Replace this with a real endpoint when customer records need addresses,
 * blocking, or lifetime value across a longer window than the order tabs hold.
 */

import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AdminOrderSummaryDto, CursorPage } from '@shared';
import { formatPaise } from '@shared/money';
import { formatIndianMobile } from '@shared/phone';
import { api } from '@/lib/api';
import { V2_ADMIN_ORDER_TABS } from '@/lib/v2Orders';
import {
  EmptyState,
  Icon,
  SearchInput,
  Spinner,
  StatCard,
  TableWrap,
  Td,
  Th,
} from '@/components/ui';

// V2's tabs — the only values GET /admin/orders accepts.
const TABS = V2_ADMIN_ORDER_TABS.map((tab) => tab.key);

interface CustomerRow {
  mobile: string;
  name: string | null;
  orderCount: number;
  totalPaise: number;
  lastOrderAt: string;
}

export default function CustomersPage() {
  const [search, setSearch] = useState('');

  // One query per tab: the admin order list is tab-scoped, so a full picture
  // means asking for each bucket and merging.
  const results = useQueries({
    queries: TABS.map((tab) => ({
      queryKey: ['admin-orders', tab, ''],
      queryFn: () =>
        api.get<CursorPage<AdminOrderSummaryDto>>(`/admin/orders?tab=${tab}&limit=50`),
      staleTime: 60_000,
    })),
  });

  const isLoading = results.some((result) => result.isLoading);

  const customers = useMemo(() => {
    const byMobile = new Map<string, CustomerRow>();

    for (const result of results) {
      for (const order of result.data?.items ?? []) {
        const existing = byMobile.get(order.customerMobile);
        if (existing) {
          existing.orderCount += 1;
          existing.totalPaise += order.totalPaise;
          existing.name ??= order.customerName;
          if (order.placedAt > existing.lastOrderAt) existing.lastOrderAt = order.placedAt;
        } else {
          byMobile.set(order.customerMobile, {
            mobile: order.customerMobile,
            name: order.customerName,
            orderCount: 1,
            totalPaise: order.totalPaise,
            lastOrderAt: order.placedAt,
          });
        }
      }
    }

    return [...byMobile.values()].sort((a, b) => b.totalPaise - a.totalPaise);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((result) => result.dataUpdatedAt).join(',')]);

  const term = search.trim().toLowerCase();
  const visible = customers.filter(
    (customer) =>
      !term ||
      customer.mobile.includes(term) ||
      (customer.name ?? '').toLowerCase().includes(term),
  );

  const totalRevenue = customers.reduce((sum, customer) => sum + customer.totalPaise, 0);
  const repeat = customers.filter((customer) => customer.orderCount > 1).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name or mobile number…"
          className="min-w-[240px] flex-1"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard icon="customers" label="Customers" value={customers.length} tone="brand" />
        <StatCard icon="orders" label="Repeat Customers" value={repeat} tone="purple" />
        <StatCard
          icon="rupee"
          label="Revenue (visible orders)"
          value={formatPaise(totalRevenue)}
          tone="blue"
        />
      </div>

      {isLoading ? (
        <Spinner label="Loading customers…" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={customers.length === 0 ? 'No customers yet' : 'Nothing matches that search'}
          hint={
            customers.length === 0
              ? 'Customers appear here once they place their first order.'
              : undefined
          }
        />
      ) : (
        <TableWrap>
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <Th>Customer</Th>
                <Th>Mobile</Th>
                <Th>Orders</Th>
                <Th>Total Spent</Th>
                <Th>Last Order</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((customer) => (
                <tr key={customer.mobile} className="transition hover:bg-gray-50/60">
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gray-100 text-gray-500">
                        <Icon name="user" className="h-5 w-5" />
                      </span>
                      <span className="font-medium text-gray-900">
                        {customer.name ?? 'Unnamed customer'}
                      </span>
                    </div>
                  </Td>
                  <Td className="text-gray-600">{formatIndianMobile(customer.mobile)}</Td>
                  <Td className="text-gray-600">{customer.orderCount}</Td>
                  <Td className="font-semibold text-gray-900">
                    {formatPaise(customer.totalPaise)}
                  </Td>
                  <Td className="text-gray-600">
                    {new Date(customer.lastOrderAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      <p className="text-sm text-gray-500">
        Built from the most recent orders in each status tab, so long-dormant customers may not
        appear.
      </p>
    </div>
  );
}

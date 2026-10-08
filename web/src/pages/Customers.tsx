/**
 * Customers — GET /admin/customers.
 *
 * Every figure here is aggregated by the backend with the single sale
 * definition (shared PLACED_ORDER_STATUSES / COMPLETED_SALE_STATUSES):
 *   - Orders       placed orders that still stand (in progress or delivered)
 *   - Total Spent  delivered orders only, net of any cancelled seller portion
 *   - Cancelled    cancelled / payment-failed / refunded orders — shown for
 *                  context, never counted as orders or spend
 * Nothing is summed in the browser, so the page can't disagree with the
 * dashboard or count a cancelled order as a sale.
 */

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdminCustomersDto } from '@shared';
import { formatPaise } from '@shared/money';
import { formatIndianMobile } from '@shared/phone';
import { api } from '@/lib/api';
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
import { Pager } from '@/components/MarketplaceUi';
import { useDebouncedValue } from '@/seller/sellerQueries';

const PAGE_SIZE = 25;

export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 350);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q]);

  const customers = useQuery({
    queryKey: ['admin-customers', q, page],
    queryFn: () =>
      api.get<AdminCustomersDto>(
        `/admin/customers?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page), pageSize: String(PAGE_SIZE) })}`,
      ),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const summary = customers.data?.summary;
  const rows = customers.data?.items ?? [];

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
        <StatCard icon="customers" label="Customers" value={summary?.customerCount ?? '—'} tone="brand" />
        <StatCard icon="orders" label="Repeat Customers" value={summary?.repeatCustomerCount ?? '—'} tone="purple" />
        <StatCard
          icon="rupee"
          label="Revenue (delivered orders)"
          value={summary ? formatPaise(summary.revenuePaise) : '—'}
          tone="blue"
        />
      </div>

      {customers.isPending ? (
        <Spinner label="Loading customers…" />
      ) : customers.isError ? (
        <EmptyState title="Could not load customers" hint="Please refresh the page and try again." />
      ) : rows.length === 0 ? (
        <EmptyState
          title={q ? 'Nothing matches that search' : 'No customers yet'}
          hint={q ? undefined : 'Customers appear here once they place their first order.'}
        />
      ) : (
        <>
          <TableWrap>
            <table className="w-full min-w-[760px] text-sm">
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
                {rows.map((customer) => (
                  <tr key={customer.userId} className="transition hover:bg-gray-50/60">
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
                    <Td>
                      <span className="font-medium text-gray-900">{customer.orderCount}</span>
                      {customer.activeOrderCount > 0 && (
                        <span className="block text-xs text-gray-500">{customer.activeOrderCount} in progress</span>
                      )}
                      {customer.cancelledOrderCount > 0 && (
                        <span className="block text-xs font-medium text-danger-600">
                          {customer.cancelledOrderCount} cancelled / failed
                        </span>
                      )}
                    </Td>
                    <Td className="font-semibold text-gray-900">{formatPaise(customer.totalSpentPaise)}</Td>
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
          <Pager page={page} pageSize={PAGE_SIZE} total={customers.data?.total ?? 0} onPage={setPage} />
        </>
      )}

      <p className="text-sm text-gray-500">
        Orders count only placed orders that weren't cancelled or failed. Total Spent and Revenue count delivered
        orders only; cancelled, payment-failed and unpaid orders are never included.
      </p>
    </div>
  );
}

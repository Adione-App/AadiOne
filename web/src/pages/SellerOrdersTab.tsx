/**
 * Seller detail — Orders tab (READ-ONLY in Phase 6).
 *
 * One existing read: GET /admin/seller-orders?sellerId=&status=&cursor=&limit=
 * (admin-mounted, SELLER_ORDER_READ_OWN — admin's cross-seller override, #26).
 *
 * Every row is a SELLER ORDER: this seller's part of a customer's order. The
 * order number belongs to the parent customer order, which may also hold other
 * sellers' items; the amount is SellerOrder.subtotalPaise (this seller's
 * tax-inclusive share), never the parent order's total.
 *
 * Not in this API, so not shown: parent order status, payment, delivery,
 * refunds, commission / earnings. The response also carries the customer's
 * name and mobile; lib/sellers.ts drops them before anything is cached.
 *
 * Server-side: status filter + cursor pages ("Load more"). No text search.
 */

import { useMemo, useState } from 'react';
import { SellerOrderStatus, type AdminSellerDetailDto } from '@shared';
import { formatPaise } from '@/lib/format';
import {
  sellerErrorMessage,
  useAdminSellerOrders,
  useResetSellerOrders,
  type AdminSellerOrderRow,
} from '@/lib/sellers';
import { sellerOrderStatusLabel, sellerOrderStatusStyle } from '@/lib/v2Orders';
import { Button, EmptyState, ErrorBanner, Panel, Spinner, Td, Th, inputClass } from '@/components/ui';

const STATUSES = Object.values(SellerOrderStatus);

const placedFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

function SellerOrderStatusPill({ row }: { row: AdminSellerOrderRow }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${sellerOrderStatusStyle(row.status)}`}
    >
      {row.statusLabel || sellerOrderStatusLabel(row.status)}
    </span>
  );
}

export default function SellerOrdersTab({ seller }: { seller: AdminSellerDetailDto }) {
  const [status, setStatus] = useState<SellerOrderStatus | null>(null);
  const orders = useAdminSellerOrders(seller.id, status);
  const reset = useResetSellerOrders(seller.id);

  // Cursor pages do not overlap; keyed by id anyway so a row can never repeat.
  const rows = useMemo(() => {
    const byId = new Map<string, AdminSellerOrderRow>();
    for (const page of orders.data?.pages ?? []) for (const row of page.items) if (!byId.has(row.id)) byId.set(row.id, row);
    return [...byId.values()];
  }, [orders.data]);

  const statusName = status ? sellerOrderStatusLabel(status) : null;

  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">
        Each row is a seller order — this seller's part of a customer's order. The order number is the customer order's,
        which may include other sellers' items; the amount is this seller's share only. Payment, delivery and the customer
        order's own status aren't part of this list — look the order number up on the Orders board.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          Status
          <select
            value={status ?? ''}
            onChange={(event) => setStatus((event.target.value || null) as SellerOrderStatus | null)}
            className={`${inputClass} w-auto`}
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {sellerOrderStatusLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={() => void reset()} disabled={orders.isFetching}>
          Refresh
        </Button>
      </div>

      <Panel
        title="Seller orders"
        bodyClass=""
        action={
          rows.length > 0 && (
            <span className="text-sm text-gray-500">
              {orders.hasNextPage ? `${rows.length} shown · more available` : `${rows.length} order${rows.length === 1 ? '' : 's'}`}
            </span>
          )
        }
      >
        {orders.isPending ? (
          <Spinner label="Loading orders…" />
        ) : rows.length === 0 && orders.isError ? (
          <div className="space-y-3 p-5 pt-0">
            <ErrorBanner message={sellerErrorMessage(orders.error, 'Could not load orders.')} />
            <Button variant="secondary" onClick={() => void orders.refetch()}>
              Try again
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title={statusName ? `No ${statusName.toLowerCase()} orders` : 'No orders yet'}
              hint={statusName ? 'Choose another status, or All statuses.' : "This seller hasn't received an order yet."}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-gray-200 bg-gray-50">
                  <tr>
                    <Th>Customer order</Th>
                    <Th>Placed</Th>
                    <Th>Seller order status</Th>
                    <Th className="text-right">Item qty</Th>
                    <Th className="text-right">Seller amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <Td className="whitespace-nowrap font-medium text-gray-900">{row.orderNumber}</Td>
                      <Td className="whitespace-nowrap text-gray-600">{placedFormat.format(new Date(row.createdAt))}</Td>
                      <Td>
                        <SellerOrderStatusPill row={row} />
                      </Td>
                      <Td className="text-right text-gray-900">{row.itemCount}</Td>
                      <Td className="whitespace-nowrap text-right font-medium text-gray-900">{formatPaise(row.subtotalPaise)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {orders.isFetchNextPageError && (
              <div className="px-5 pt-3">
                <ErrorBanner message={sellerErrorMessage(orders.error, 'Could not load more orders.')} />
              </div>
            )}
            {orders.hasNextPage && (
              <div className="border-t border-gray-100 p-4 text-center">
                <Button variant="secondary" onClick={() => void orders.fetchNextPage()} disabled={orders.isFetchingNextPage}>
                  {orders.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

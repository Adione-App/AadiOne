/**
 * One order's complete details on the admin Orders page — opened from its
 * row. Built from GET /admin/orders/:id through `toAdminOrderDetailView`
 * (lib/v2Orders.ts), which keeps only what is shown here:
 *
 *   - every line grouped by seller, like the Seller Panel's order view: the
 *     ordered photo (whole, never cropped), name, the size the customer chose
 *     (or its option picks), SKU, the ordered QUANTITY of that size, unit
 *     price and line total — and, for a weight / volume, the total
 *     ("500 g × 2 = 1 kg") from the variant's structured unit;
 *   - each seller's subtotal and its status, with the admin's existing
 *     seller-order actions (passed in, unchanged);
 *   - the bill exactly as the customer was charged (one total, never one per
 *     seller), the payment method separate from its status, payment
 *     attempts with their reference, and the customer's refunds;
 *   - customer, delivery address and rider; the status history of the order
 *     and of each seller's part.
 *
 * Display only: nothing here changes an order.
 */

import type { ReactNode } from 'react';
import { formatPaise } from '@shared/money';
import { Pill, Thumb } from '@/components/ui';
import {
  customerRefunds,
  lineTotalMeasure,
  orderItemTotals,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusView,
  sellerOrderStatusLabel,
  sellerOrderStatusStyle,
  type AdminOrderDetailView,
  type SellerOrderItemView,
  type SellerOrderView,
} from '@/lib/v2Orders';

const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});
const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '—');

const ATTEMPT_TONE: Record<string, 'brand' | 'amber' | 'red' | 'gray'> = {
  CAPTURED: 'brand',
  AUTHORIZED: 'amber',
  PENDING: 'amber',
  CREATED: 'gray',
  FAILED: 'red',
  REFUNDED: 'gray',
  PARTIALLY_REFUNDED: 'gray',
};
const REFUND_TONE = { COMPLETED: 'brand', PENDING: 'amber', FAILED: 'red' } as const;
const REFUND_LABEL = { COMPLETED: 'Refunded', PENDING: 'In progress', FAILED: 'Failed' } as const;

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{children}</h3>;
}

function Row({ label, value, strong = false }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'text-base font-bold text-gray-900' : 'text-sm text-gray-700'}`}>
      <dt className="min-w-0">{label}</dt>
      <dd className="shrink-0 text-right tabular-nums">{value}</dd>
    </div>
  );
}

/** One ordered line: the selected size and the ordered quantity are separate values. */
function OrderLine({ item }: { item: SellerOrderItemView }) {
  const total = lineTotalMeasure(item.measure, item.qty);
  const size = item.options.length > 0 ? item.options.map(([name, value]) => `${name}: ${value}`).join(' · ') : item.variantName;
  return (
    <li className="flex gap-3 py-3">
      <Thumb src={item.imageUrl} alt={item.productName} size="lg" fit="contain" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <p className="break-words text-sm font-semibold text-gray-900">{item.productName}</p>
            {item.brandName && <p className="text-xs text-gray-500">{item.brandName}</p>}
          </div>
          <p className="shrink-0 text-sm font-semibold text-gray-900 tabular-nums">{formatPaise(item.lineTotalPaise)}</p>
        </div>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-gray-500">{item.options.length > 0 ? 'Options' : 'Unit / size'}</dt>
            <dd className="font-medium text-gray-900">{size || '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Quantity ordered</dt>
            <dd className="font-medium text-gray-900">{item.qty}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Unit price</dt>
            <dd className="font-medium text-gray-900 tabular-nums">
              {formatPaise(item.unitPricePaise)}
              {item.mrpPaise > item.unitPricePaise && <span className="ml-1 text-gray-400 line-through">{formatPaise(item.mrpPaise)}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">{total ? 'Total quantity' : 'Line'}</dt>
            <dd className="font-medium text-gray-900">{total ?? `${item.qty} × ${size || 'item'}`}</dd>
          </div>
        </dl>
        {item.sku && <p className="mt-1 font-mono text-[11px] text-gray-400">SKU {item.sku}</p>}
      </div>
    </li>
  );
}

function SellerGroup({ sellerOrder, actions }: { sellerOrder: SellerOrderView; actions: ReactNode }) {
  const units = sellerOrder.items.reduce((sum, item) => sum + item.qty, 0);
  return (
    <section className="rounded-xl border border-gray-200">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900">{sellerOrder.sellerName}</span>
            <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${sellerOrderStatusStyle(sellerOrder.status)}`}>
              {sellerOrderStatusLabel(sellerOrder.status)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            {sellerOrder.items.length} product{sellerOrder.items.length === 1 ? '' : 's'} · {units} unit{units === 1 ? '' : 's'} · Seller subtotal{' '}
            <span className="font-semibold text-gray-700">{formatPaise(sellerOrder.subtotalPaise)}</span>
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">{actions}</div>
      </header>
      {sellerOrder.items.length > 0 ? (
        <ul className="divide-y divide-gray-100 px-3">
          {sellerOrder.items.map((item) => (
            <OrderLine key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-sm text-gray-500">No items recorded for this seller.</p>
      )}
      {(sellerOrder.rejectionReason || sellerOrder.cancellationReason) && (
        <p className="mx-3 mb-3 rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-600">
          <span className="font-semibold">{sellerOrder.rejectionReason ? 'Rejected' : 'Cancelled'}:</span>{' '}
          {sellerOrder.rejectionReason ?? sellerOrder.cancellationReason}
        </p>
      )}
    </section>
  );
}

export function AdminOrderDetail({
  view,
  sellerActions,
}: {
  view: AdminOrderDetailView;
  /** The existing per-seller-order actions (Accept, Reject, …) — unchanged. */
  sellerActions: (sellerOrder: SellerOrderView) => ReactNode;
}) {
  const totals = orderItemTotals(view.sellerOrders);
  const payment = paymentStatusView(view.paymentMethod, view.paymentStatus);
  const refunds = customerRefunds(view.refunds);
  const { bill, delivery } = view;
  const address = [delivery.addressLine, delivery.city, delivery.district && delivery.district.toLowerCase() !== delivery.city.toLowerCase() ? `District ${delivery.district}` : null, delivery.state, delivery.pincode]
    .filter(Boolean)
    .join(', ');
  const mapsUrl =
    delivery.latitude !== null && delivery.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${delivery.latitude},${delivery.longitude}`
      : null;

  return (
    <div className="mt-3 space-y-4 border-t border-gray-100 pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>
          Placed <span className="font-medium text-gray-700">{when(view.placedAt)}</span>
        </span>
        <span>
          {totals.products} product{totals.products === 1 ? '' : 's'} · {totals.units} unit{totals.units === 1 ? '' : 's'} ·{' '}
          {view.sellerOrders.length} seller{view.sellerOrders.length === 1 ? '' : 's'}
        </span>
      </div>

      {view.cancellationReason && (
        <p className="rounded-xl bg-danger-50 px-3 py-2 text-sm text-danger-600">
          <span className="font-semibold">Order cancelled:</span> {view.cancellationReason}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Items, by seller */}
        <div className="min-w-0 space-y-3">
          <SectionTitle>Items</SectionTitle>
          {view.sellerOrders.map((sellerOrder) => (
            <SellerGroup key={sellerOrder.id} sellerOrder={sellerOrder} actions={sellerActions(sellerOrder)} />
          ))}
        </div>

        <aside className="min-w-0 space-y-4">
          {/* Bill — the customer's one consolidated total */}
          <section className="space-y-2 rounded-xl bg-gray-50 p-3">
            <SectionTitle>Bill</SectionTitle>
            <dl className="space-y-1.5">
              <Row label="Item subtotal" value={formatPaise(bill.itemsSubtotalPaise)} />
              {bill.couponDiscountPaise > 0 && (
                <Row label={`Coupon${bill.couponCode ? ` (${bill.couponCode})` : ''}`} value={<span className="text-brand-600">−{formatPaise(bill.couponDiscountPaise)}</span>} />
              )}
              <Row label="Delivery fee" value={bill.deliveryFeePaise > 0 ? formatPaise(bill.deliveryFeePaise) : 'Free'} />
              <Row label="Platform fee" value={bill.platformFeePaise > 0 ? formatPaise(bill.platformFeePaise) : '—'} />
              <div className="border-t border-gray-200 pt-1.5">
                <Row label="Total" value={formatPaise(bill.totalPaise)} strong />
              </div>
              {view.currentPayablePaise !== view.totalPaise && (
                <Row label="Payable now (after cancellations)" value={formatPaise(view.currentPayablePaise)} />
              )}
            </dl>
            {(bill.mrpSavingsPaise > 0 || bill.taxPaise > 0) && (
              <p className="text-xs text-gray-500">
                {bill.mrpSavingsPaise > 0 && <>Saved {formatPaise(bill.mrpSavingsPaise)} on MRP. </>}
                {bill.taxPaise > 0 && <>Includes {formatPaise(bill.taxPaise)} tax.</>}
              </p>
            )}
          </section>

          {/* Payment — method and status kept apart */}
          <section className="space-y-2 rounded-xl border border-gray-200 p-3">
            <SectionTitle>Payment</SectionTitle>
            <dl className="space-y-1.5">
              <Row label="Method" value={<span className="font-medium text-gray-900">{paymentMethodLabel(view.paymentMethod, view.payments)}</span>} />
              <Row label="Status" value={<Pill tone={payment.tone}>{payment.label}</Pill>} />
            </dl>
            {view.payments.length > 0 && (
              <ul className="space-y-1.5 border-t border-gray-100 pt-2">
                {view.payments.map((attempt) => (
                  <li key={attempt.id} className="text-xs text-gray-600">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        {when(attempt.capturedAt ?? attempt.createdAt)} · {formatPaise(attempt.amountPaise)}
                      </span>
                      <Pill tone={ATTEMPT_TONE[attempt.status] ?? 'gray'}>{attempt.status === 'CAPTURED' ? 'Captured' : attempt.status.charAt(0) + attempt.status.slice(1).toLowerCase().replace(/_/g, ' ')}</Pill>
                    </div>
                    {attempt.reference && (
                      <p className="mt-0.5 break-all font-mono text-[11px] text-gray-500">Ref {attempt.reference}</p>
                    )}
                    {attempt.failureReason && <p className="mt-0.5 text-danger-600">{attempt.failureReason}</p>}
                  </li>
                ))}
              </ul>
            )}
            {refunds.refunds.length > 0 && (
              <div className="space-y-1.5 border-t border-gray-100 pt-2">
                <dl className="space-y-1">
                  <Row label="Refunded" value={formatPaise(refunds.refundedPaise)} />
                  {refunds.pendingPaise > 0 && <Row label="Refund in progress" value={formatPaise(refunds.pendingPaise)} />}
                </dl>
                <ul className="space-y-1.5">
                  {refunds.refunds.map((refund) => (
                    <li key={refund.id} className="text-xs text-gray-600">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {formatPaise(refund.amountPaise)} · {refund.parts.join(', ')}
                        </span>
                        <Pill tone={REFUND_TONE[refund.status]}>{REFUND_LABEL[refund.status]}</Pill>
                      </div>
                      {refund.reason && <p className="mt-0.5 text-gray-500">{refund.reason}</p>}
                      {refund.reference && <p className="mt-0.5 break-all font-mono text-[11px] text-gray-500">Ref {refund.reference}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Customer and delivery */}
          <section className="space-y-2 rounded-xl border border-gray-200 p-3 text-sm">
            <SectionTitle>Customer &amp; delivery</SectionTitle>
            <div>
              <p className="font-medium text-gray-900">{delivery.name || view.customer.name || 'Customer'}</p>
              {delivery.mobile && <p className="text-gray-600">{delivery.mobile}</p>}
              {view.customer.email && <p className="break-all text-gray-600">{view.customer.email}</p>}
              {view.customer.name && view.customer.name !== delivery.name && (
                <p className="text-xs text-gray-500">Account: {view.customer.name}{view.customer.mobile ? ` · ${view.customer.mobile}` : ''}</p>
              )}
            </div>
            <div>
              {delivery.mode === 'LIVE_LOCATION' && <Pill tone="blue">Live location</Pill>}
              {delivery.label && delivery.mode !== 'LIVE_LOCATION' && <Pill>{delivery.label}</Pill>}
              <p className="mt-1 text-gray-700">{address || '—'}</p>
              {delivery.landmark && <p className="text-gray-600">Landmark: {delivery.landmark}</p>}
              {mapsUrl && (
                <a href={mapsUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-brand-600 hover:underline">
                  Open in Maps
                </a>
              )}
            </div>
            {delivery.agentName && <p className="text-gray-700">Rider: <span className="font-medium">{delivery.agentName}</span></p>}
            {delivery.notes && <p className="rounded-lg bg-gray-50 px-2 py-1.5 text-gray-700">Note: {delivery.notes}</p>}
          </section>
        </aside>
      </div>

      {/* Status history */}
      {view.history.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>Status history</SectionTitle>
          <ol className="space-y-1.5 border-l-2 border-gray-200 pl-4">
            {view.history.map((entry) => (
              <li key={`${entry.scope}-${entry.id}`} className="relative text-sm">
                <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-brand-500" aria-hidden="true" />
                <span className="font-medium text-gray-900">
                  {entry.scope === 'Order' ? orderStatusLabel(entry.toStatus) : sellerOrderStatusLabel(entry.toStatus)}
                </span>
                <span className="text-gray-500">
                  {' '}
                  · {entry.scope === 'Order' ? 'Order' : entry.scope} · {when(entry.at)}
                  {entry.actorName ? ` · by ${entry.actorName}` : entry.actorType !== 'SYSTEM' ? ` · by ${entry.actorType.toLowerCase()}` : ''}
                </span>
                {entry.reason && <p className="text-xs text-gray-500">{entry.reason}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * Commission — the marketplace view (GET /admin/commission/overview,
 * COMMISSION_MANAGE): each seller's default rate and active category /
 * product rules, the commission the settlement service has computed on its
 * orders, and the latest rule changes. Rules are edited per seller (Sellers →
 * a seller → Commission), with the existing commission logic — nothing here
 * calculates a rate or an amount.
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { api } from '@/lib/api';
import { adminErrorMessage, marketplaceKeys, percentBp, shortDateTime, type CommissionOverview } from '@/lib/marketplace';
import { Pill, Surface } from '@/components/ui';
import { SellerLink } from '@/components/MarketplaceUi';
import { CardHeader, EmptyPanel, LoadError, SkeletonList } from '@/seller/sellerUi';

export default function CommissionPage() {
  const overview = useQuery({
    queryKey: marketplaceKeys.commission,
    queryFn: () => api.get<CommissionOverview>('/admin/commission/overview'),
  });

  if (overview.isPending) return <SkeletonList rows={6} label="Loading commission…" />;
  if (overview.isError) return <LoadError message={adminErrorMessage(overview.error)} onRetry={() => void overview.refetch()} />;
  const o = overview.data;

  return (
    <div className="space-y-5">
      <section aria-label="Marketplace totals" className="grid gap-3 sm:grid-cols-3">
        {[
          ['Gross sales', o.totals.grossSalesPaise, 'Orders still standing, all sellers'],
          ['Aadione commission', o.totals.commissionPaise, 'From each order’s commission snapshot'],
          ['Sellers’ net earnings', o.totals.netPayablePaise, 'Gross − commission'],
        ].map(([label, value, hint]) => (
          <Surface key={label as string} className="p-4">
            <p className="text-sm font-medium text-gray-500">{label}</p>
            <p className="mt-1 text-xl font-bold text-gray-900">{formatPaise(value as number)}</p>
            <p className="mt-0.5 text-xs text-gray-500">{hint}</p>
          </Surface>
        ))}
      </section>

      <Surface className="overflow-hidden">
        <div className="p-4 sm:p-5">
          <CardHeader title="Commission by seller" subtitle="Rules resolve product › category › seller default. Edit them on the seller’s Commission tab." />
        </div>
        <div className="overflow-x-auto border-t border-gray-100">
          <table className="w-full min-w-[860px] text-sm">
            <caption className="sr-only">Commission by seller</caption>
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th scope="col" className="px-4 py-3">Seller</th>
                <th scope="col" className="px-3 py-3 text-right">Default rate</th>
                <th scope="col" className="px-3 py-3 text-right">Category rules</th>
                <th scope="col" className="px-3 py-3 text-right">Product rules</th>
                <th scope="col" className="px-3 py-3 text-right">Gross sales</th>
                <th scope="col" className="px-3 py-3 text-right">Commission</th>
                <th scope="col" className="px-4 py-3 text-right">Rules</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {o.sellers.map((s) => (
                <tr key={s.sellerId} className="hover:bg-gray-50/60">
                  <td className="px-4 py-3">
                    <SellerLink seller={{ id: s.sellerId, name: s.sellerName }} tab="commission" />
                    {!s.isActive && <span className="ml-2"><Pill tone="red">Paused</Pill></span>}
                  </td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums">{percentBp(s.defaultCommissionBp)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.categoryRules}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.productRules}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatPaise(s.grossSalesPaise)}</td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatPaise(s.commissionPaise)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/sellers/${s.sellerId}?tab=commission`} className="text-xs font-semibold text-brand-600 hover:underline">
                      Edit rules
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>

      <Surface className="p-4 sm:p-5">
        <CardHeader title="Recent rule changes" subtitle="The latest category and product rules, newest first." />
        {o.recentRules.length === 0 ? (
          <div className="mt-3">
            <EmptyPanel icon="rupee" title="No category or product rules yet" hint="Every seller uses its default rate." />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100">
            {o.recentRules.map((rule) => (
              <li key={rule.ruleId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">{rule.seller.name}</span>
                  <span className="text-gray-500">
                    {' '}
                    · {rule.scope === 'PRODUCT' ? 'Product' : 'Category'}: {rule.targetName ?? '—'}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold tabular-nums">{percentBp(rule.rateBp)}</span>
                  <Pill tone={rule.isActive ? 'brand' : 'gray'}>{rule.isActive ? 'Active' : 'Removed'}</Pill>
                  <span className="text-xs text-gray-400">{shortDateTime.format(new Date(rule.changedAt))}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}

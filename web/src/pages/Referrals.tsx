/**
 * Referrals — read-only Refer & Earn board.
 *
 * Deliberately no "issue reward" action anywhere on this page: rewards are
 * minted exactly once, automatically, the moment a referred customer's
 * first eligible order is delivered (see backend's referral.service.ts).
 * A manual override here would be the exact "casual button that can
 * accidentally generate duplicate referral rewards" the spec warns against.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OffsetPage, ReferralAdminRowDto, ReferralAdminStatsDto } from '@shared';
import { formatIndianMobile } from '@shared/phone';
import { api } from '@/lib/api';
import { EmptyState, Spinner, StatCard, TableWrap, Td, Th } from '@/components/ui';

const PAGE_SIZE = 20;

function StatusBadge({ status }: { status: ReferralAdminRowDto['status'] }) {
  const styleByStatus: Record<ReferralAdminRowDto['status'], string> = {
    REGISTERED: 'bg-gray-100 text-gray-600',
    FIRST_ORDER_PENDING: 'bg-warn-50 text-warn-500',
    COMPLETED: 'bg-info-50 text-info-500',
    REWARD_ISSUED: 'bg-brand-50 text-brand-600',
  };
  const labelByStatus: Record<ReferralAdminRowDto['status'], string> = {
    REGISTERED: 'Registered',
    FIRST_ORDER_PENDING: 'Awaiting first order',
    COMPLETED: 'Completed',
    REWARD_ISSUED: 'Reward issued',
  };

  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${styleByStatus[status]}`}>
      {labelByStatus[status]}
    </span>
  );
}

function CouponBadge({ row }: { row: ReferralAdminRowDto }) {
  if (!row.rewardCouponCode) return <span className="text-gray-400">—</span>;

  const toneByStatus: Record<NonNullable<ReferralAdminRowDto['rewardCouponStatus']>, string> = {
    ACTIVE: 'text-brand-600',
    USED: 'text-gray-500',
    EXPIRED: 'text-danger-500',
  };

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      {row.rewardCouponCode}
      {row.rewardCouponStatus && (
        <span className={toneByStatus[row.rewardCouponStatus]}>({row.rewardCouponStatus.toLowerCase()})</span>
      )}
    </span>
  );
}

export default function ReferralsPage() {
  const [page, setPage] = useState(1);

  const stats = useQuery({
    queryKey: ['admin-referrals-stats'],
    queryFn: () => api.get<ReferralAdminStatsDto>('/admin/referrals/stats'),
  });

  const list = useQuery({
    queryKey: ['admin-referrals', page],
    queryFn: () =>
      api.get<OffsetPage<ReferralAdminRowDto>>(`/admin/referrals?page=${page}&limit=${PAGE_SIZE}`),
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard icon="gift" label="Total Referrals" value={stats.data?.totalReferrals ?? '—'} tone="brand" />
        <StatCard
          icon="check"
          label="Successful Referrals"
          value={stats.data?.completedReferrals ?? '—'}
          tone="blue"
        />
        <StatCard
          icon="clock"
          label="Pending Referrals"
          value={stats.data?.pendingReferrals ?? '—'}
          tone="amber"
        />
        <StatCard icon="rupee" label="Rewards Issued" value={stats.data?.rewardsIssued ?? '—'} tone="purple" />
        <StatCard icon="check" label="Coupons Used" value={stats.data?.couponsUsed ?? '—'} tone="blue" />
        <StatCard icon="clock" label="Coupons Expired" value={stats.data?.couponsExpired ?? '—'} tone="gray" />
      </div>

      {list.isLoading ? (
        <Spinner label="Loading referrals…" />
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No referrals yet"
          hint="Referral activity appears here once a customer shares their code and a friend signs up."
        />
      ) : (
        <>
          <TableWrap>
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <Th>Referrer</Th>
                  <Th>Referred User</Th>
                  <Th>Code</Th>
                  <Th>Status</Th>
                  <Th>Reward Coupon</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.data?.items.map((row) => (
                  <tr key={row.id} className="transition hover:bg-gray-50/60">
                    <Td>
                      <div className="font-medium text-gray-900">{row.referrerName ?? 'Unnamed'}</div>
                      <div className="text-xs text-gray-500">{formatIndianMobile(row.referrerMobile)}</div>
                    </Td>
                    <Td>
                      <div className="font-medium text-gray-900">{row.referredName ?? 'Unnamed'}</div>
                      <div className="text-xs text-gray-500">{formatIndianMobile(row.referredMobile)}</div>
                    </Td>
                    <Td className="font-mono text-xs text-gray-600">{row.referralCode}</Td>
                    <Td>
                      <StatusBadge status={row.status} />
                    </Td>
                    <Td>
                      <CouponBadge row={row} />
                    </Td>
                    <Td className="text-gray-600">
                      {new Date(row.createdAt).toLocaleDateString('en-IN', {
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

          {list.data && list.data.totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-gray-600">
              <span>
                Page {list.data.page} of {list.data.totalPages} · {list.data.total} referrals
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(list.data!.totalPages, p + 1))}
                  disabled={page >= list.data.totalPages}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-sm text-gray-500">
        Rewards are issued automatically the moment a referred customer's first eligible order (≥
        the configured minimum) is delivered — there is no manual way to issue or edit a reward
        from here, by design.
      </p>
    </div>
  );
}

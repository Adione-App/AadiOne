/**
 * Formatting and settlement pieces shared by Earnings and Settlements.
 * Every amount these show is a value the backend computed (paise); nothing
 * here adds, subtracts or derives money.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { formatPaise } from '@shared/money';
import { Icon, type IconName, type Tone } from '@/components/ui';
import { sellerApi, toSettlementPage, type SellerSettlement, type SellerSettlementPage } from './sellerApi';
import { sellerKeys } from './sellerQueries';

/** Money on these pages always shows paise: ₹1,234.00. */
export const inr = (paise: number): string => formatPaise(paise, { alwaysShowDecimals: true });
export const date = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** Backend commissionBp is display-only basis points: 1250 -> "12.5%". */
export const percent = (bp: number): string => `${(bp / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

export const SETTLEMENT_STATUS: Record<string, { label: string; tone: Tone; icon: IconName; note?: string }> = {
  PENDING: { label: 'Pending', tone: 'amber', icon: 'clock', note: 'Created — waiting to be processed by Aadione.' },
  PROCESSING: { label: 'Processing', tone: 'blue', icon: 'clock', note: 'Aadione is sending this payout.' },
  PAID: { label: 'Paid', tone: 'brand', icon: 'check' },
  FAILED: { label: 'Failed', tone: 'red', icon: 'alert', note: 'This payout did not go through. Aadione will retry it — contact Aadione if you have questions.' },
};

const BADGE: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700',
  blue: 'bg-info-50 text-info-500',
  amber: 'bg-warn-50 text-warn-500',
  red: 'bg-danger-50 text-danger-600',
  purple: 'bg-purple-50 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
};

/** Status with an icon as well as a colour. */
export function SettlementBadge({ status }: { status: string }) {
  const look = SETTLEMENT_STATUS[status] ?? { label: status, tone: 'gray' as Tone, icon: 'clock' as IconName };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${BADGE[look.tone]}`}>
      <Icon name={look.icon} className="h-3.5 w-3.5" />
      {look.label}
    </span>
  );
}

export const SETTLEMENT_PAGE_SIZE = 25;

/** GET /seller/settlements, newest first, cursor pages. */
export function useSettlementPages() {
  return useInfiniteQuery({
    queryKey: sellerKeys.settlements,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: String(SETTLEMENT_PAGE_SIZE) });
      if (pageParam) query.set('cursor', pageParam);
      return sellerApi.get<SellerSettlementPage>(`/seller/settlements?${query.toString()}`).then(toSettlementPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
  });
}

/** Pages flattened, first copy of each id kept. */
export function settlementRows(pages: readonly SellerSettlementPage[] | undefined): SellerSettlement[] {
  const seen = new Set<string>();
  return (pages ?? []).flatMap((p) => p.items).filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

/**
 * Seller detail — Categories and Earnings tabs.
 *
 *   Categories     GET /admin/sellers/:id/categories — the seller's OWN top
 *                  categories and subcategories (or a restaurant's menu
 *                  sections). READ-ONLY: every seller manages its own.
 *   Earnings       GET /admin/sellers/:id/earnings + GET /admin/settlements
 *                  (SETTLEMENT_READ). READ-ONLY.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { AdminSellerDetailDto } from '@shared';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { imageSrc } from '@/lib/image';
import { sellerErrorMessage } from '@/lib/sellers';
import { formatSellerDate } from '@/components/SellerBadges';
import { EmptyState, ErrorBanner, Icon, Panel, Pill, Spinner, Surface, type Tone } from '@/components/ui';

function CategoryImage({ src, alt }: { src: string | null; alt: string }) {
  const resolved = imageSrc(src);
  return resolved ? (
    <img src={resolved} alt={alt} loading="lazy" className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 object-cover" />
  ) : (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-500">
      <Icon name="categories" className="h-5 w-5" />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Categories — the seller's own tree, read only                              */
/* -------------------------------------------------------------------------- */

interface SellerCategoryTree {
  usesMenuSections: boolean;
  categories: {
    id: string;
    name: string;
    imageUrl: string | null;
    isActive: boolean;
    productCount: number;
    subcategories: { id: string; name: string; imageUrl: string | null; isActive: boolean; productCount: number }[];
  }[];
}

export function SellerCategoriesTab({ seller }: { seller: AdminSellerDetailDto }) {
  const query = useQuery({
    queryKey: ['admin', 'sellers', seller.id, 'categories'],
    queryFn: () => api.get<SellerCategoryTree>(`/admin/sellers/${seller.id}/categories`),
  });
  if (query.isPending) return <Spinner label="Loading categories…" />;
  if (query.isError) return <ErrorBanner message={sellerErrorMessage(query.error, 'Could not load categories.')} />;
  const { categories, usesMenuSections } = query.data;
  if (categories.length === 0) {
    return (
      <EmptyState
        title={usesMenuSections ? 'No menu sections yet' : 'No categories yet'}
        hint={`${seller.name} creates its own ${usesMenuSections ? 'menu sections' : 'top categories and subcategories'} in the Seller Panel.`}
      />
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">
        Read-only — {seller.name} creates and manages its own {usesMenuSections ? 'menu sections' : 'categories and subcategories'} in the
        Seller Panel. See the whole marketplace in{' '}
        <Link to={`/categories?seller=${seller.id}`} className="font-semibold text-brand-600 hover:underline">
          Marketplace Catalogue
        </Link>
        .
      </p>
      {categories.map((top) => (
        <section key={top.id} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryImage src={top.imageUrl} alt={top.name} />
            <h3 className="font-semibold text-gray-900">{top.name}</h3>
            <Pill tone={top.isActive ? 'brand' : 'gray'}>{top.isActive ? 'Active' : 'Hidden'}</Pill>
            <span className="text-xs text-gray-500">
              {top.productCount} product{top.productCount === 1 ? '' : 's'} directly in it
            </span>
          </div>
          {top.subcategories.length === 0 ? (
            !usesMenuSections && <p className="pl-1 text-sm text-gray-500">No subcategories.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {top.subcategories.map((sub) => (
                <li key={sub.id}>
                  <Surface className="flex items-center gap-3 p-3">
                    <CategoryImage src={sub.imageUrl} alt={sub.name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-gray-900">{sub.name}</p>
                      <p className="text-xs text-gray-500">
                        {sub.productCount} product{sub.productCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Pill tone={sub.isActive ? 'brand' : 'gray'}>{sub.isActive ? 'Active' : 'Hidden'}</Pill>
                  </Surface>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Earnings — read only                                                       */
/* -------------------------------------------------------------------------- */

interface EarningsSummary {
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  cancelledAmountPaise: number;
  refundedAmountPaise: number;
  notYetEligiblePaise: number;
  pendingSettlementPaise: number;
  inSettlementPaise: number;
  settledAmountPaise: number;
  lastSettlementPeriodEnd: string | null;
  nextSettlementDueAt: string | null;
}

interface SettlementRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossSalesPaise: number;
  commissionPaise: number;
  netPayablePaise: number;
  status: string;
  paidAt: string | null;
}

const SETTLEMENT_TONE: Record<string, Tone> = { PENDING: 'amber', PROCESSING: 'blue', PAID: 'brand', FAILED: 'red' };

export function SellerEarningsTab({ seller, section = 'earnings' }: { seller: AdminSellerDetailDto; section?: 'earnings' | 'settlements' }) {
  const earnings = useQuery({
    queryKey: ['admin', 'sellers', seller.id, 'earnings'],
    queryFn: () => api.get<EarningsSummary>(`/admin/sellers/${seller.id}/earnings`),
  });
  const settlements = useQuery({
    queryKey: ['admin', 'sellers', seller.id, 'settlements'],
    queryFn: () => api.get<{ items: SettlementRow[] } | SettlementRow[]>(`/admin/settlements?sellerId=${seller.id}&limit=50`),
    enabled: section === 'settlements',
  });

  if (earnings.isPending) return <Spinner label="Loading earnings…" />;
  if (earnings.isError) return <ErrorBanner message={sellerErrorMessage(earnings.error, 'Could not load earnings.')} />;
  const e = earnings.data;
  const rows = settlements.data ? (Array.isArray(settlements.data) ? settlements.data : settlements.data.items) : [];

  const tiles: { label: string; value: number; hint?: string }[] = [
    { label: 'Gross sales', value: e.grossSalesPaise },
    { label: 'Commission', value: e.commissionPaise },
    { label: 'Seller net', value: e.netPayablePaise, hint: 'Gross − commission' },
    { label: 'Not yet eligible', value: e.notYetEligiblePaise, hint: 'Undelivered or unpaid' },
    { label: 'Pending settlement', value: e.pendingSettlementPaise },
    { label: 'In settlement', value: e.inSettlementPaise },
    { label: 'Settled (paid)', value: e.settledAmountPaise },
    { label: 'Cancelled / refunded', value: e.cancelledAmountPaise, hint: `${formatPaise(e.refundedAmountPaise)} refunded` },
  ];

  if (section === 'earnings') {
    return (
      <div className="space-y-5">
        <p className="text-sm text-gray-500">Read-only — the same figures the seller sees in its Earnings screen.</p>
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <li key={tile.label}>
              <Surface className="h-full p-3.5">
                <p className="text-xs text-gray-500">{tile.label}</p>
                <p className="mt-1 text-lg font-bold text-gray-900">{formatPaise(tile.value)}</p>
                {tile.hint && <p className="mt-0.5 text-xs text-gray-400">{tile.hint}</p>}
              </Surface>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        This seller's payouts. Create a settlement or change its status on the{' '}
        <Link to={`/settlements?seller=${seller.id}`} className="font-semibold text-brand-600 hover:underline">
          Settlements
        </Link>{' '}
        page.
      </p>
      <Panel title="Settlements">
        {settlements.isPending ? (
          <Spinner label="Loading settlements…" />
        ) : settlements.isError ? (
          <ErrorBanner message={sellerErrorMessage(settlements.error, 'Could not load settlements.')} />
        ) : rows.length === 0 ? (
          <EmptyState title="No settlements yet" />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {formatSellerDate(row.periodStart)} – {formatSellerDate(row.periodEnd)}
                  </p>
                  <p className="text-xs text-gray-500">
                    Gross {formatPaise(row.grossSalesPaise)} · commission {formatPaise(row.commissionPaise)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">{formatPaise(row.netPayablePaise)}</span>
                  <Pill tone={SETTLEMENT_TONE[row.status] ?? 'gray'}>{row.status.charAt(0) + row.status.slice(1).toLowerCase()}</Pill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

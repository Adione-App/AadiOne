/**
 * Shared pieces of the admin marketplace pages (Products, Inventory,
 * Payments, Refunds, Audit Logs): status badges that always carry words (not
 * colour alone) and a simple pager.
 */

import { Link } from 'react-router-dom';
import { Button, Pill, type Tone } from '@/components/ui';
import type { StockState, VisibilityReason } from '@/lib/marketplace';

export const VISIBILITY_LABEL: Record<VisibilityReason, { label: string; tone: Tone }> = {
  VISIBLE: { label: 'Buyable', tone: 'brand' },
  OUT_OF_STOCK: { label: 'Out of stock', tone: 'red' },
  OFF_SALE: { label: 'Off sale (seller)', tone: 'gray' },
  HIDDEN_BY_SELLER: { label: 'Hidden (seller)', tone: 'gray' },
  NOT_LISTED: { label: 'Not listed', tone: 'gray' },
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'amber' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  DISABLED_BY_ADMIN: { label: 'Disabled by Aadione', tone: 'red' },
  STORE_DEACTIVATED: { label: 'Store deactivated', tone: 'red' },
  STORE_NOT_APPROVED: { label: 'Store not approved', tone: 'amber' },
};

export function VisibilityBadge({ reason }: { reason: VisibilityReason }) {
  const look = VISIBILITY_LABEL[reason] ?? { label: reason, tone: 'gray' as Tone };
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

export function ApprovalBadge({ status }: { status: string }) {
  const look: Record<string, { label: string; tone: Tone }> = {
    APPROVED: { label: 'Approved', tone: 'brand' },
    PENDING: { label: 'Pending', tone: 'amber' },
    REJECTED: { label: 'Rejected', tone: 'red' },
  };
  const l = look[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={l.tone}>{l.label}</Pill>;
}

export function ProductStatusBadge({ status }: { status: string }) {
  const look: Record<string, { label: string; tone: Tone }> = {
    ACTIVE: { label: 'Active', tone: 'brand' },
    INACTIVE: { label: 'Hidden', tone: 'gray' },
    ARCHIVED: { label: 'Disabled', tone: 'red' },
    DRAFT: { label: 'Draft', tone: 'gray' },
  };
  const l = look[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={l.tone}>{l.label}</Pill>;
}

export function StockBadge({ state }: { state: StockState }) {
  if (state === 'OUT') return <Pill tone="red">Out of stock</Pill>;
  if (state === 'LOW') return <Pill tone="amber">Low stock</Pill>;
  return <Pill tone="brand">In stock</Pill>;
}

/** Seller name linking to its seller page (tab optional). Every seller — Aadione included — is shown the same way. */
export function SellerLink({ seller, tab }: { seller: { id: string; name: string }; tab?: string }) {
  return (
    <Link to={`/sellers/${seller.id}${tab ? `?tab=${tab}` : ''}`} className="font-medium text-gray-900 hover:text-brand-600 hover:underline">
      {seller.name}
    </Link>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (next: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="px-1 text-sm text-gray-500">{total} result{total === 1 ? '' : 's'}</p>;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1">
      <p className="text-sm text-gray-500">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="text-sm text-gray-600">
          Page {page} of {pages}
        </span>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/**
 * Seller detail — Products tab (READ-ONLY: sellers manage their own products,
 * images, price and stock in the Seller Panel; the API refuses admin writes).
 *
 * Two existing admin reads, both SELLER_ONBOARDING_REVIEW like the page itself:
 *   GET /admin/sellers/:id/listings   every SellerListing of this seller — its
 *        own offer on a master-catalogue variant: price, MRP, stock, on/off.
 *   GET /admin/sellers/:id/products   master Products this seller SUBMITTED to
 *        the catalogue: product status, approval, SKU, category/subcategory,
 *        and whether the seller lists its default variant.
 *
 * Neither endpoint is paginated or searchable — each returns every row — so the
 * filter box only narrows rows already loaded. Nothing here writes: price and
 * stock are the seller's (Seller Panel), approvals live in Product Approvals.
 */

import { useMemo, useState } from 'react';
import { ApprovalStatus, type AdminSellerDetailDto, type SellerListingDto, type SellerProductDto } from '@shared';
import { formatPaise } from '@/lib/format';
import { sellerErrorMessage, useAdminSellerListings, useAdminSellerProducts, useSellerPermissions } from '@/lib/sellers';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatSellerDate } from '@/components/SellerBadges';
import { Button, EmptyState, ErrorBanner, Field, Modal, Panel, Pill, SearchInput, Spinner, Td, Th, Thumb, inputClass, type Tone } from '@/components/ui';

/** Same labels and tones as the Product Approvals page. */
const APPROVAL_LOOK: Record<string, { label: string; tone: Tone }> = {
  [ApprovalStatus.PENDING]: { label: 'Pending review', tone: 'amber' },
  [ApprovalStatus.APPROVED]: { label: 'Approved', tone: 'brand' },
  [ApprovalStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

function ApprovalPill({ status }: { status: string }) {
  const look = APPROVAL_LOOK[status] ?? { label: status, tone: 'gray' as Tone };
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

function ProductStatusPill({ status }: { status: string }) {
  if (status === 'ARCHIVED') return <Pill tone="red">Disabled by Aadione</Pill>;
  return <Pill tone={status === 'ACTIVE' ? 'brand' : 'gray'}>{status.charAt(0) + status.slice(1).toLowerCase()}</Pill>;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const matches = (needle: string, ...values: (string | null | undefined)[]) =>
  values.some((value) => value?.toLowerCase().includes(needle));

function Count({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return (
    <span className="text-sm text-gray-500">{shown === total ? plural(total, noun) : `${shown} of ${plural(total, noun)}`}</span>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3 p-5 pt-0">
      <ErrorBanner message={message} />
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export default function SellerListingsTab({ seller }: { seller: AdminSellerDetailDto }) {
  const canModerate = useSellerPermissions().canManage;
  const listings = useAdminSellerListings(seller.id);
  const products = useAdminSellerProducts(seller.id);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();

  const shownListings = useMemo(
    () => (listings.data ?? []).filter((l) => !needle || matches(needle, l.productName, l.variantName, l.categoryName)),
    [listings.data, needle],
  );
  const shownProducts = useMemo(
    () =>
      (products.data ?? []).filter(
        (p) =>
          !needle ||
          matches(needle, p.name, p.defaultVariant?.variantName, p.defaultVariant?.sku, p.category.name, p.subcategory?.name),
      ),
    [products.data, needle],
  );

  const refreshing = listings.isRefetching || products.isRefetching;
  const refresh = () => {
    void listings.refetch();
    void products.refetch();
  };

  const submittedCount = products.data?.length ?? 0;
  const noListingsHint =
    submittedCount > 0
      ? `This seller has submitted ${plural(submittedCount, 'product')} (below), but none is listed for sale.`
      : "This seller isn't selling any product yet.";

  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-600">
        A listing is this seller's own offer on a catalogue product — its price, MRP, stock and on/off switch. Submitted
        products are master-catalogue products this seller added for approval. Read-only: the seller manages listings in
        the Seller Panel, and approvals happen in Product Approvals.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter by product, variant, SKU or category"
          className="min-w-0 flex-1 sm:max-w-md"
        />
        <Button variant="secondary" onClick={refresh} disabled={listings.isFetching || products.isFetching}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Panel
        title="Listings"
        bodyClass=""
        action={listings.data && <Count shown={shownListings.length} total={listings.data.length} noun="listing" />}
      >
        {listings.isPending ? (
          <Spinner label="Loading listings…" />
        ) : listings.isError ? (
          <LoadError
            message={sellerErrorMessage(listings.error, 'Could not load listings.')}
            onRetry={() => void listings.refetch()}
          />
        ) : listings.data.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No listings" hint={noListingsHint} />
          </div>
        ) : shownListings.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No listing matches this filter" hint={`Clear the filter to see all ${plural(listings.data.length, 'listing')}.`} />
          </div>
        ) : (
          <>
            {listings.data.every((l) => !l.isAvailable) && (
              <p className="px-5 pb-3 text-sm text-warn-500">None of these listings is switched on for sale.</p>
            )}
            <ListingsTable rows={shownListings} />
          </>
        )}
      </Panel>

      <Panel
        title="Submitted products"
        bodyClass=""
        action={products.data && <Count shown={shownProducts.length} total={products.data.length} noun="product" />}
      >
        {products.isPending ? (
          <Spinner label="Loading submitted products…" />
        ) : products.isError ? (
          <LoadError
            message={sellerErrorMessage(products.error, 'Could not load submitted products.')}
            onRetry={() => void products.refetch()}
          />
        ) : products.data.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title="No submitted products"
              hint="This seller hasn't added any product to the master catalogue. It can still list existing catalogue products."
            />
          </div>
        ) : shownProducts.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No product matches this filter" hint={`Clear the filter to see all ${plural(products.data.length, 'product')}.`} />
          </div>
        ) : (
          <ProductsTable rows={shownProducts} sellerId={seller.id} canModerate={canModerate} onModerated={() => void products.refetch()} />
        )}
      </Panel>
    </div>
  );
}

function ListingsTable({ rows }: { rows: SellerListingDto[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-y border-gray-200 bg-gray-50">
          <tr>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th className="text-right">Price</Th>
            <Th className="text-right">MRP</Th>
            <Th className="text-right">Stock</Th>
            <Th>Listing</Th>
            <Th>Product approval</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((listing) => (
            <tr key={listing.id}>
              <Td>
                <p className="font-medium text-gray-900">{listing.productName}</p>
                {listing.variantName && <p className="text-xs text-gray-500">{listing.variantName}</p>}
              </Td>
              <Td className="text-gray-700">{listing.categoryName}</Td>
              <Td className="whitespace-nowrap text-right font-medium text-gray-900">{formatPaise(listing.pricePaise)}</Td>
              <Td className="whitespace-nowrap text-right text-gray-500">{formatPaise(listing.mrpPaise)}</Td>
              <Td className="whitespace-nowrap text-right">
                <p className={listing.stockQty === 0 ? 'font-medium text-danger-600' : 'text-gray-900'}>{listing.stockQty}</p>
                {listing.availableQty !== listing.stockQty && (
                  <p className="text-xs text-gray-500">{listing.availableQty} available</p>
                )}
              </Td>
              <Td>
                <Pill tone={listing.isAvailable ? 'brand' : 'gray'}>{listing.isAvailable ? 'Available' : 'Unavailable'}</Pill>
              </Td>
              <Td>
                <ApprovalPill status={listing.approvalStatus} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductsTable({
  rows,
  sellerId,
  canModerate,
  onModerated,
}: {
  rows: SellerProductDto[];
  sellerId: string;
  canModerate: boolean;
  onModerated: () => void;
}) {
  const [target, setTarget] = useState<SellerProductDto | null>(null);
  return (
    <div className="overflow-x-auto">
      {target && (
        <ModerationModal product={target} sellerId={sellerId} onClose={() => setTarget(null)} onDone={() => { setTarget(null); onModerated(); }} />
      )}
      <table className="w-full text-sm">
        <thead className="border-y border-gray-200 bg-gray-50">
          <tr>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th>Status</Th>
            <Th>Approval</Th>
            <Th>Seller listing</Th>
            <Th>Updated</Th>
            {canModerate && <Th className="text-right">Moderation</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((product) => (
            <tr key={product.id}>
              <Td>
                <div className="flex items-start gap-3">
                <Thumb src={product.images[0]?.thumbUrl ?? product.images[0]?.url ?? null} alt={product.name} />
                <div className="min-w-0">
                <p className="font-medium text-gray-900">{product.name}</p>
                <p className="text-xs text-gray-400">{product.images.length === 0 ? 'No images' : `${product.images.length} image${product.images.length === 1 ? '' : 's'} · first is main`}</p>
                {product.defaultVariant ? (
                  <p className="text-xs text-gray-500">
                    {product.defaultVariant.variantName} · SKU {product.defaultVariant.sku}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">No live variant</p>
                )}
                </div>
                </div>
              </Td>
              <Td className="text-gray-700">
                {product.category.name}
                {product.subcategory && <span className="text-gray-500"> › {product.subcategory.name}</span>}
              </Td>
              <Td>
                <ProductStatusPill status={product.status} />
              </Td>
              <Td>
                <ApprovalPill status={product.approvalStatus} />
                <p className="mt-1 text-xs text-gray-500">
                  {product.latestApproval ? `Submitted ${formatSellerDate(product.latestApproval.submittedAt)}` : 'Never submitted'}
                </p>
                {product.approvalStatus === ApprovalStatus.REJECTED && product.lastRejectionReason && (
                  <p className="mt-0.5 max-w-xs text-xs text-danger-600">{product.lastRejectionReason}</p>
                )}
              </Td>
              <Td>
                {product.listing ? (
                  <>
                  <Pill tone={product.listing.isAvailable ? 'brand' : 'gray'}>
                    {product.listing.isAvailable ? 'Listed' : 'Listed · unavailable'}
                  </Pill>
                  <p className="mt-1 whitespace-nowrap text-xs text-gray-600">
                    {formatPaise(product.listing.pricePaise)} · {product.listing.availableQty} in stock
                  </p>
                  </>
                ) : (
                  <span className="text-gray-500">Not listed</span>
                )}
              </Td>
              <Td className="whitespace-nowrap text-gray-600">{formatSellerDate(product.updatedAt)}</Td>
              {canModerate && (
                <Td className="text-right">
                  <Button variant={product.status === 'ARCHIVED' ? 'soft' : 'ghost'} onClick={() => setTarget(product)}>
                    {product.status === 'ARCHIVED' ? 'Enable' : 'Disable'}
                  </Button>
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * PATCH /admin/sellers/:sellerId/products/:productId/moderation — disable
 * (not buyable; the seller can't lift it) or re-enable (returns hidden; the
 * seller shows it again). Never edits the product's content.
 */
function ModerationModal({
  product,
  sellerId,
  onClose,
  onDone,
}: {
  product: SellerProductDto;
  sellerId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const enabling = product.status === 'ARCHIVED';
  const [reason, setReason] = useState('');
  const moderate = useMutation({
    mutationFn: () =>
      api.patch(`/admin/sellers/${sellerId}/products/${product.id}/moderation`, {
        action: enabling ? 'ENABLE' : 'DISABLE',
        ...(enabling ? {} : { reason: reason.trim() }),
      }),
    onSuccess: onDone,
  });
  return (
    <Modal
      title={enabling ? 'Enable product' : 'Disable product'}
      subtitle={product.name}
      onClose={() => {
        if (!moderate.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={moderate.isPending}>
            Cancel
          </Button>
          <Button
            variant={enabling ? 'primary' : 'danger'}
            disabled={moderate.isPending || (!enabling && reason.trim().length < 3)}
            onClick={() => moderate.mutate()}
          >
            {moderate.isPending ? 'Saving…' : enabling ? 'Enable' : 'Disable'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-gray-600">
        {enabling ? (
          <p>The product comes back hidden — the seller decides when to show it again. Its details are unchanged.</p>
        ) : (
          <>
            <p>Customers can no longer buy it, and the seller cannot switch it back on. Its details, photos, price and stock are unchanged.</p>
            <Field label="Reason shown to the seller" required>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} rows={3} className={inputClass} />
            </Field>
          </>
        )}
        {moderate.isError && <ErrorBanner message={sellerErrorMessage(moderate.error, 'Could not update the product.')} />}
      </div>
    </Modal>
  );
}

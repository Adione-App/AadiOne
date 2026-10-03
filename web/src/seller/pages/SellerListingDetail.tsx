/**
 * Seller listing page — /seller/listings/:id: a catalogue product this seller
 * sells but did NOT submit (GET /seller/listings/:id). Its details and photos
 * are catalogue data — read-only here; the seller controls only its own
 * listing: price, stock and the on-sale switch. (An own product redirects to
 * its product page, which has every section.)
 */

import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api';
import { EmptyState, ErrorBanner, Pill } from '@/components/ui';
import { sellerApi, sellerErrorMessage, type SellerListingInventory } from '../sellerApi';
import { sellerKeys } from '../sellerQueries';
import { ProductImage, VisibilityPill } from '../productUi';
import { InventoryPanel, PricingPanel, Section, VisibilityPanel } from '../productSections';
import { SkeletonBlock } from '../sellerUi';

export default function SellerListingDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const key = [...sellerKeys.listings, id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => sellerApi.get<SellerListingInventory>(`/seller/listings/${id}`),
    retry: (count, error) => !(error instanceof ApiRequestError && error.status === 404) && count < 2,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings, exact: true }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.products }),
    ]);

  const back = (
    <Link to="/seller/products" className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900">
      <span aria-hidden="true">←</span> Products
    </Link>
  );

  if (query.isPending) return <SkeletonBlock lines={5} label="Loading listing…" />;
  if (query.isError) {
    const missing = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {missing ? <EmptyState title="Listing not found" hint="It may belong to another store, or the link is wrong." /> : <ErrorBanner message={sellerErrorMessage(query.error)} />}
      </div>
    );
  }

  const listing = query.data;
  if (listing.ownProduct) return <Navigate to={`/seller/products/${listing.productId}`} replace />;

  return (
    <div className="space-y-4 pb-6">
      {back}
      <header className="flex items-start gap-3">
        <ProductImage src={listing.imageUrl} alt={listing.productName} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight text-gray-900">{listing.productName}</h1>
          <p className="mt-0.5 text-sm text-gray-500">{[listing.variantName, listing.categoryName].filter(Boolean).join(' · ')}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Pill tone="gray">Catalogue product</Pill>
            <VisibilityPill reason={listing.visibility.reason} />
            {listing.visibility.lowStock && <Pill tone="amber">Low stock</Pill>}
          </div>
        </div>
      </header>

      <Section id="info" title="Product information" subtitle="Aadione's catalogue data — you control only your price, stock and on-sale switch.">
        <p className="text-sm text-gray-600">
          {listing.productName}
          {listing.variantName ? ` · ${listing.variantName}` : ''} in {listing.categoryName}.
        </p>
      </Section>
      <Section id="pricing" title="Pricing">
        <PricingPanel key={listing.id} listing={listing} onChanged={refresh} />
      </Section>
      <Section id="inventory" title="Inventory">
        <InventoryPanel key={listing.id} listing={listing} label={listing.productName} onChanged={refresh} />
      </Section>
      <Section id="visibility" title="Visibility">
        <VisibilityPanel
          visibility={listing.visibility}
          listing={{ id: listing.id, isAvailable: listing.isAvailable }}
          product={null}
          adminDisabled={listing.productStatus === 'ARCHIVED' ? { reason: null, at: listing.updatedAt } : null}
          onChanged={refresh}
        />
      </Section>
    </div>
  );
}

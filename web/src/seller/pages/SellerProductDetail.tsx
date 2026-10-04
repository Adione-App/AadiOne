/**
 * Seller product page — /seller/products/:id (one of the seller's OWN
 * products, GET /seller/products/:id). Sections:
 *
 *   1. Product information  read-only; "Edit details" while the product is in
 *                           its editable window (never submitted / rejected).
 *                           Category and other catalogue fields change only
 *                           through that edit + resubmission for approval.
 *   2. Images               add / replace / remove / ★ main / reorder — same
 *                           editable window; locked after approval.
 *   3. Pricing              the seller's own listing price and MRP.
 *   4. Inventory            stock, reserved, available, low stock, +/−.
 *   5. Visibility           what customers see, and the seller's switches.
 *   6. Approval / status    review state, rejection reason, (re)submit.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isFoodSellerType, type SellerProductDto } from '@shared';
import { ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { validateImage } from '@/lib/upload';
import { Button, EmptyState, ErrorBanner, Pill } from '@/components/ui';
import { MAX_PRODUCT_IMAGES, sellerApi, sellerErrorMessage, uploadSellerImage, type SellerProductInventory } from '../sellerApi';
import { sellerKeys, useSellerAvailability } from '../sellerQueries';
import {
  ImageGallery,
  NoticeBar,
  ProductImage,
  UNIT_SHORT,
  VisibilityPill,
  isEditable,
  moved,
  rejectionOf,
  reviewState,
  shortDate,
  type Notice,
} from '../productUi';
import { ProductFormModal, StartSellingModal } from '../productForms';
import { FoodItemModal } from '../foodItemForm';
import { InventoryPanel, PricingPanel, Section, VisibilityPanel } from '../productSections';
import { SkeletonBlock } from '../sellerUi';

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-gray-900">{children}</dd>
    </div>
  );
}

export default function SellerProductDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState(false);
  // Restaurant / cafe: edited with the food item form (no MRP / stock).
  const isFood = isFoodSellerType(useSellerAvailability().data?.sellerType);
  const [starting, setStarting] = useState(false);
  const [imageBusy, setImageBusy] = useState<string | null>(null);

  const key = [...sellerKeys.products, id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => sellerApi.get<SellerProductInventory>(`/seller/products/${id}`),
    retry: (count, error) => !(error instanceof ApiRequestError && error.status === 404) && count < 2,
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.products, exact: true }),
      queryClient.invalidateQueries({ queryKey: sellerKeys.listings }),
    ]);

  const submit = useMutation({
    mutationFn: () => sellerApi.post('/seller/approval-batches', { productIds: [id] }),
  });

  const back = (
    <Link to="/seller/products" className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900">
      <span aria-hidden="true">←</span> Products
    </Link>
  );

  if (query.isPending) return <SkeletonBlock lines={5} label="Loading product…" />;
  if (query.isError) {
    const missing = query.error instanceof ApiRequestError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {missing ? (
          <EmptyState title="Product not found" hint="It may belong to another store, or the link is wrong." />
        ) : (
          <ErrorBanner message={sellerErrorMessage(query.error)} />
        )}
      </div>
    );
  }

  const product = query.data;
  const editable = isEditable(product);
  const underReview = product.approvalStatus === 'PENDING' && product.latestApproval?.status === 'PENDING';
  const review = reviewState(product);
  const rejection = rejectionOf(product);
  const variant = product.defaultVariant;
  const listing = product.listing;

  async function imageAction(label: string, action: () => Promise<unknown>): Promise<void> {
    setNotice(null);
    setImageBusy(label);
    try {
      await action();
      await refresh();
    } catch (error) {
      setNotice({ ok: false, text: error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message });
    } finally {
      setImageBusy(null);
    }
  }

  async function addImages(files: FileList | null): Promise<void> {
    const chosen = Array.from(files ?? []).slice(0, MAX_PRODUCT_IMAGES - product.images.length);
    for (const file of chosen) {
      const invalid = validateImage(file);
      if (invalid) return setNotice({ ok: false, text: `${file.name}: ${invalid}` });
    }
    await imageAction('Uploading…', async () => {
      for (const file of chosen) {
        const imageKey = await uploadSellerImage(file);
        await sellerApi.post(`/seller/products/${id}/images`, { key: imageKey });
      }
    });
  }

  const order = (next: string[]) => imageAction('Saving…', () => sellerApi.put(`/seller/products/${id}/images/order`, { imageIds: next }));
  const ids = product.images.map((image) => image.id);

  return (
    <div className="space-y-4 pb-6">
      {back}
      <header className="flex items-start gap-3">
        <ProductImage src={product.images[0]?.thumbUrl ?? product.images[0]?.url ?? null} alt={product.name} />
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight text-gray-900">{product.name}</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {product.category.name}
            {product.subcategory && <> › {product.subcategory.name}</>}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Pill tone={review.tone}>{review.label}</Pill>
            <VisibilityPill reason={product.visibility.reason} />
            {product.visibility.lowStock && <Pill tone="amber">Low stock</Pill>}
          </div>
        </div>
      </header>

      {/* Jump links — handy on a phone. */}
      <nav aria-label="Product sections" className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:px-0">
        {[
          ['info', 'Details'],
          ['images', 'Images'],
          ['pricing', 'Pricing'],
          ['inventory', 'Inventory'],
          ['visibility', 'Visibility'],
          ['approval', 'Approval'],
        ].map(([anchor, label]) => (
          <a key={anchor} href={`#${anchor}`} className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-gray-200 bg-white px-3.5 text-sm font-medium text-gray-700">
            {label}
          </a>
        ))}
      </nav>

      <NoticeBar notice={notice} />

      <Section
        id="info"
        title="1. Product information"
        subtitle={editable ? 'Editable until you submit it for approval.' : 'Locked — catalogue details change only through review.'}
        action={editable ? <Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button> : undefined}
      >
        <dl className="divide-y divide-gray-100">
          <Detail label="Name">{product.name}</Detail>
          {product.nameHi && <Detail label="Hindi name">{product.nameHi}</Detail>}
          <Detail label="Category">
            {product.category.name}
            {product.subcategory && <> › {product.subcategory.name}</>}
          </Detail>
          {variant && (
            <>
              <Detail label="Variant">
                {variant.variantName} · {variant.unitValue} {UNIT_SHORT[variant.unit] ?? variant.unit}
              </Detail>
              <Detail label="SKU">
                <span className="font-mono">{variant.sku}</span>
              </Detail>
            </>
          )}
          <Detail label="Description">{product.description || <span className="text-gray-400">No description</span>}</Detail>
        </dl>
      </Section>

      <Section
        id="images"
        title="2. Images"
        subtitle={editable ? 'Add, replace, reorder or remove photos. The first one is the main image.' : 'Locked after submission — photos change only through review.'}
      >
        <ImageGallery
          items={product.images.map((image) => ({ id: image.id, src: imageSrc(image.thumbUrl ?? image.url) ?? '' }))}
          readOnly={!editable}
          disabled={imageBusy !== null}
          busyLabel={imageBusy}
          onPick={(files) => void addImages(files)}
          onMakeMain={(index) => void order(moved(ids, index, 0))}
          onMove={(index, direction) => void order(moved(ids, index, index + direction))}
          onRemove={(index) => void imageAction('Removing…', () => sellerApi.delete(`/seller/products/${id}/images/${ids[index]}`))}
          onReplace={(index, file) => {
            const invalid = validateImage(file);
            if (invalid) return setNotice({ ok: false, text: `${file.name}: ${invalid}` });
            void imageAction('Replacing…', async () => {
              const imageKey = await uploadSellerImage(file);
              await sellerApi.patch(`/seller/products/${id}/images/${ids[index]}`, { key: imageKey });
            });
          }}
        />
      </Section>

      <Section id="pricing" title="3. Pricing">
        {listing ? (
          <PricingPanel key={listing.id} listing={listing} onChanged={refresh} />
        ) : variant ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">This product has no price and stock yet. Add them — it can only be submitted for approval once it is complete.</p>
            <Button onClick={() => setStarting(true)}>Add price &amp; stock</Button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">This product has no variant to price.</p>
        )}
      </Section>

      <Section id="inventory" title={listing?.tracksStock === false ? '4. Availability' : '4. Inventory'}>
        {listing ? (
          <InventoryPanel key={listing.id} listing={listing} label={product.name} onChanged={refresh} />
        ) : (
          <p className="text-sm text-gray-500">Stock is tracked once you start selling this product.</p>
        )}
      </Section>

      <Section id="visibility" title="5. Visibility">
        <VisibilityPanel
          visibility={product.visibility}
          listing={listing ? { id: listing.id, isAvailable: listing.isAvailable } : null}
          product={{ id: product.id, status: product.status }}
          adminDisabled={product.adminDisabled}
          onChanged={refresh}
        />
      </Section>

      <Section id="approval" title="6. Approval / status">
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={review.tone}>{review.label}</Pill>
            {product.latestApproval && (
              <span className="text-gray-500">Last submitted {shortDate.format(new Date(product.latestApproval.submittedAt))}</span>
            )}
          </div>
          {product.approvalStatus === 'REJECTED' && (
            <p className="rounded-xl bg-danger-50 px-3 py-2 text-danger-600">
              <span className="font-semibold">Rejection reason:</span> {rejection ?? 'No reason was given.'}
            </p>
          )}
          {underReview && <p className="text-gray-600">Aadione is reviewing it. You can edit it again only if it is rejected.</p>}
          {product.approvalStatus === 'APPROVED' && (
            <p className="text-gray-600">Approved. Its details and photos are locked; your price, stock and visibility stay yours to change.</p>
          )}
          {editable && product.approvalStatus !== 'REJECTED' && (
            <p className="text-gray-600">
              Draft — sent for review with your other drafts when you use{' '}
              <Link to="/seller/products" className="font-semibold text-brand-600">
                Submit for Approval
              </Link>{' '}
              on Products.
            </p>
          )}
          {editable && product.approvalStatus === 'REJECTED' && (
            <Button
              disabled={submit.isPending}
              onClick={() => {
                setNotice(null);
                submit.mutate(undefined, {
                  onSuccess: () => {
                    setNotice({ ok: true, text: `"${product.name}" was resubmitted for approval.` });
                    void refresh();
                  },
                  onError: (error) => setNotice({ ok: false, text: sellerErrorMessage(error) }),
                });
              }}
            >
              {submit.isPending ? 'Resubmitting…' : 'Resubmit for approval'}
            </Button>
          )}
        </div>
      </Section>

      {editing && isFood && (
        <FoodItemModal
          mode={{ kind: 'edit', item: product }}
          onClose={() => setEditing(false)}
          onDone={(result) => {
            setEditing(false);
            setNotice(result);
            void refresh();
          }}
        />
      )}
      {editing && !isFood && (
        <ProductFormModal
          mode={{ kind: 'edit', product: product satisfies SellerProductDto }}
          onClose={() => {
            setEditing(false);
            void refresh();
          }}
          onDone={(result) => {
            setEditing(false);
            setNotice(result);
            void refresh();
          }}
        />
      )}
      {starting && (
        <StartSellingModal
          product={product}
          onClose={() => setStarting(false)}
          onDone={(result) => {
            setStarting(false);
            setNotice(result);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

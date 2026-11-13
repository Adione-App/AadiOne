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
 *      — or, for a product sold in several variants (sizes / options):
 *   3. Variants             every variant with its OWN price, MRP, stock,
 *                           on-sale and show/hide switches, edit and delete,
 *                           and "Add variant" (variantManager.tsx).
 *   5. Visibility           what customers see, and the seller's switches.
 *   6. Approval / status    review state, rejection reason, (re)submit.
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink } from '@/components/BackLink';
import { SELLER_PRODUCT_BACK_FROM } from '../sellerUi';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isFoodSellerType, type SellerProductDto } from '@shared';
import { ApiRequestError } from '@/lib/api';
import { imageSrc } from '@/lib/image';
import { validateImage } from '@/lib/upload';
import { Button, EmptyState, ErrorBanner, Pill } from '@/components/ui';
import {
  MAX_PRODUCT_IMAGES,
  failedUploadsText,
  imageUploadLabel,
  sellerApi,
  sellerErrorMessage,
  uploadSellerImage,
  addSellerProductImages,
  type SellerProductInventory,
} from '../sellerApi';
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
import { VariantManager } from '../variantManager';
import { SkeletonBlock, useScrollToHash } from '../sellerUi';

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
  useScrollToHash(query.isSuccess);

  // Back to the list it was opened from, as it was (filters, scroll) — see BackLink.
  const back = <BackLink to="/seller/products" label="Products" from={SELLER_PRODUCT_BACK_FROM} />;

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
  // Several variants (or options switched on): each is managed on its own row.
  const multi = (product.variants?.length ?? 0) > 1 || (product.optionGroups?.length ?? 0) > 0;
  const n = (single: number) => (multi && single > 3 ? single - 1 : single);

  async function imageAction(label: string, action: () => Promise<unknown>): Promise<void> {
    setNotice(null);
    setImageBusy(label);
    try {
      // Image calls answer with the product: its gallery shows at once.
      const saved = await action();
      if (saved && typeof saved === 'object' && 'images' in saved) showImages((saved as SellerProductDto).images);
      void refresh();
    } catch (error) {
      setNotice({ ok: false, text: error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message });
    } finally {
      setImageBusy(null);
    }
  }

  /** The gallery from an image call's answer — on screen at once; the full re-read follows in the background. */
  const showImages = (images: SellerProductDto['images']) =>
    queryClient.setQueryData<SellerProductInventory>(key, (old) => (old ? { ...old, images } : old));

  /**
   * New photos: resized in the browser and uploaded together (up to 3 at a
   * time, with progress), then attached together in one request in the order
   * chosen — a photo shows as added only once the server has stored it. One that fails
   * never stops the others; it is named so the seller can pick it again.
   */
  async function addImages(files: FileList | null): Promise<void> {
    if (imageBusy !== null) return;
    const chosen = Array.from(files ?? []).slice(0, MAX_PRODUCT_IMAGES - product.images.length);
    if (chosen.length === 0) return;
    for (const file of chosen) {
      const invalid = validateImage(file, true);
      if (invalid) return setNotice({ ok: false, text: `${file.name}: ${invalid}` });
    }
    setNotice(null);
    setImageBusy(imageUploadLabel(0, chosen.length));
    try {
      // Uploaded in parallel, then attached together in one request, in the order chosen.
      const { images, failed } = await addSellerProductImages(id, chosen, (fraction) =>
        setImageBusy(imageUploadLabel(fraction, chosen.length)),
      );
      if (images) showImages(images);
      if (failed.length > 0) setNotice({ ok: false, text: failedUploadsText(failed) });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof ApiRequestError ? sellerErrorMessage(error) : (error as Error).message });
    } finally {
      setImageBusy(null);
      void refresh();
    }
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
        {(multi
          ? [
              ['info', 'Details'],
              ['images', 'Images'],
              ['variants', 'Variants'],
              ['visibility', 'Visibility'],
              ['approval', 'Approval'],
            ]
          : [
              ['info', 'Details'],
              ['images', 'Images'],
              ['pricing', 'Pricing'],
              ['inventory', 'Inventory'],
              ['visibility', 'Visibility'],
              ['approval', 'Approval'],
            ]
        ).map(([anchor, label]) => (
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
          {multi && (
            <Detail label="Variants">
              {(product.variants ?? []).map((v) => v.variantName).join(', ')}
            </Detail>
          )}
          {!multi && variant && (
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
            const invalid = validateImage(file, true);
            if (invalid) return setNotice({ ok: false, text: `${file.name}: ${invalid}` });
            void imageAction(imageUploadLabel(0, 1), async () => {
              const imageKey = await uploadSellerImage(file, {
                optimize: true,
                onProgress: (fraction) => setImageBusy(imageUploadLabel(fraction, 1)),
              });
              setImageBusy('Replacing…');
              showImages((await sellerApi.patch<SellerProductDto>(`/seller/products/${id}/images/${ids[index]}`, { key: imageKey })).images);
            });
          }}
        />
      </Section>

      {multi && (
        <Section id="variants" title="3. Variants" subtitle="Price, MRP, stock and availability of each variant — changed one variant at a time.">
          <VariantManager product={product} food={isFood} onChanged={refresh} onNotice={setNotice} />
        </Section>
      )}

      {!multi && (
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

      )}

      {!multi && (
      <Section id="inventory" title={listing?.tracksStock === false ? '4. Availability' : '4. Inventory'}>
        {listing ? (
          <InventoryPanel key={listing.id} listing={listing} label={product.name} onChanged={refresh} />
        ) : (
          <p className="text-sm text-gray-500">Stock is tracked once you start selling this product.</p>
        )}
      </Section>

      )}

      <Section id="visibility" title={`${n(5)}. Visibility`}>
        <VisibilityPanel
          visibility={product.visibility}
          // Several variants: each one's on-sale switch is in Variants — none here for just the default.
          listing={listing && !multi ? { id: listing.id, isAvailable: listing.isAvailable } : null}
          product={{ id: product.id, status: product.status }}
          adminDisabled={product.adminDisabled}
          onChanged={refresh}
        />
      </Section>

      <Section id="approval" title={`${n(6)}. Approval / status`}>
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

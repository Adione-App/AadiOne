/**
 * Shared pieces of the seller product screens (list, product detail, listing
 * detail, forms). Status wording comes from the server's own fields —
 * `visibility.reason` (backend listing-visibility.ts), `approvalStatus` and
 * the latest batch item — never a second status system.
 */

import { useRef } from 'react';
import type { SellerProductDto } from '@shared';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES } from '@/lib/upload';
import { ErrorBanner, Icon, Pill, type Tone } from '@/components/ui';
import { LISTING_MAX_STOCK, MAX_PRODUCT_IMAGES, type ListingVisibilityReason } from './sellerApi';

export const UNIT_SHORT: Record<string, string> = {
  G: 'g',
  KG: 'kg',
  ML: 'ml',
  L: 'L',
  PIECE: 'piece',
  PACK: 'pack',
  DOZEN: 'dozen',
  BUNDLE: 'bundle',
};

export const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const dateTime = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export type Notice = { ok: boolean; text: string };

export function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return notice.ok ? (
    <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-2.5 text-sm text-brand-700">
      {notice.text}
    </div>
  ) : (
    <ErrorBanner message={notice.text} />
  );
}

/** "₹12.50" / "12.5" -> 1250 paise; null when not a valid amount above 0. */
export function toPaise(value: string): number | null {
  const amount = Number(value.replace(/[₹,\s]/g, ''));
  if (!value.trim() || !Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

/** Whole units from 0 to the backend maximum; null otherwise. */
export function toStock(value: string): number | null {
  const qty = Number(value.trim());
  if (!value.trim() || !Number.isInteger(qty) || qty < 0 || qty > LISTING_MAX_STOCK) return null;
  return qty;
}
export const STOCK_RULE = `Stock must be a whole number from 0 to ${LISTING_MAX_STOCK.toLocaleString('en-IN')}.`;

/** The approval state as the seller reads it — straight from the server. */
export function reviewState(product: Pick<SellerProductDto, 'approvalStatus' | 'latestApproval'> & { listing: unknown }): { label: string; tone: Tone } {
  if (product.approvalStatus === 'APPROVED') return { label: 'Approved', tone: 'brand' };
  if (product.approvalStatus === 'REJECTED') return { label: 'Rejected', tone: 'red' };
  if (product.approvalStatus === 'PENDING') {
    if (product.latestApproval?.status === 'PENDING') return { label: 'Pending Approval', tone: 'amber' };
    // Never submitted: complete (price + stock saved) or still missing them.
    return product.listing ? { label: 'Ready for Submission', tone: 'blue' } : { label: 'Draft', tone: 'gray' };
  }
  return { label: product.approvalStatus, tone: 'gray' };
}

/** A never-submitted or rejected product — the backend's editable window. */
export function isEditable(product: Pick<SellerProductDto, 'approvalStatus' | 'latestApproval'>): boolean {
  if (product.approvalStatus === 'REJECTED') return true;
  return product.approvalStatus === 'PENDING' && product.latestApproval?.status !== 'PENDING';
}

export function rejectionOf(product: Pick<SellerProductDto, 'approvalStatus' | 'latestApproval' | 'lastRejectionReason'>): string | null {
  if (product.approvalStatus !== 'REJECTED') return null;
  return (product.latestApproval?.status === 'REJECTED' ? product.latestApproval.reviewNote : null) ?? product.lastRejectionReason;
}

/**
 * What a customer sees, for each server visibility reason. `admin` marks the
 * restrictions only Aadione can lift.
 */
export const VISIBILITY: Record<ListingVisibilityReason, { label: string; tone: Tone; help: string; admin?: boolean }> = {
  VISIBLE: { label: 'On sale', tone: 'brand', help: 'Customers can buy it now (during your open hours).' },
  OUT_OF_STOCK: { label: 'Out of stock', tone: 'red', help: 'Nothing available — all stock is sold or held for open orders.' },
  OFF_SALE: { label: 'Hidden', tone: 'gray', help: 'You switched this listing off sale.' },
  HIDDEN_BY_SELLER: { label: 'Hidden', tone: 'gray', help: 'You hid this product from customers.' },
  NOT_LISTED: { label: 'No price yet', tone: 'gray', help: 'Add your price and stock (“Add price & stock”).' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'amber', help: 'Customers see it once Aadione approves it.' },
  REJECTED: { label: 'Rejected', tone: 'red', help: 'Fix it and resubmit for approval.' },
  DISABLED_BY_ADMIN: { label: 'Disabled by Aadione', tone: 'red', help: 'Aadione disabled this product. Only Aadione can enable it again.', admin: true },
  STORE_DEACTIVATED: { label: 'Store deactivated', tone: 'red', help: 'Aadione has deactivated your store. Contact support.', admin: true },
  STORE_NOT_APPROVED: { label: 'Store not approved yet', tone: 'amber', help: 'Products go live once Aadione approves your store.' },
};

export function VisibilityPill({ reason }: { reason: ListingVisibilityReason }) {
  const look = VISIBILITY[reason];
  return <Pill tone={look.tone}>{look.label}</Pill>;
}

export function ProductImage({ src, alt, size = 'h-20 w-20' }: { src: string | null; alt: string; size?: string }) {
  const resolved = imageSrc(src);
  return resolved ? (
    <img src={resolved} alt={alt} loading="lazy" className={`${size} shrink-0 rounded-xl border border-gray-200 bg-white object-cover`} />
  ) : (
    <span className={`${size} flex shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-400`}>
      <Icon name="image" className="h-7 w-7" />
    </span>
  );
}

/** −  qty  + : relative changes, applied server-side under a row lock. */
export function StockStepper({
  label,
  availableQty,
  stockQty,
  busy,
  onAdjust,
}: {
  label: string;
  availableQty: number;
  stockQty: number;
  busy: boolean;
  onAdjust: (delta: number) => void;
}) {
  const reserved = stockQty - availableQty;
  const button =
    'flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-lg font-semibold text-gray-700 transition active:scale-95 disabled:opacity-40';
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label={`Decrease stock of ${label}`} disabled={busy || availableQty <= 0} onClick={() => onAdjust(-1)} className={button}>
        −
      </button>
      <div className="min-w-[3.5rem] text-center" aria-live="polite">
        <p className={`text-base font-bold leading-none ${availableQty === 0 ? 'text-danger-600' : 'text-gray-900'}`}>{availableQty}</p>
        <p className="mt-0.5 text-[11px] leading-none text-gray-500">{reserved > 0 ? `+${reserved} held` : 'available'}</p>
      </div>
      <button type="button" aria-label={`Increase stock of ${label}`} disabled={busy} onClick={() => onAdjust(1)} className={button}>
        +
      </button>
    </div>
  );
}

export interface GalleryItem {
  id: string;
  src: string;
}

/**
 * Product photos. The FIRST image is the main one (every product card shows
 * it). ★ makes an image the main one, ‹ › move it, ↻ replaces its file
 * (same position), × removes it. `readOnly` shows the gallery only.
 */
export function ImageGallery({
  items,
  disabled,
  readOnly = false,
  busyLabel,
  onPick,
  onMakeMain,
  onMove,
  onRemove,
  onReplace,
}: {
  items: GalleryItem[];
  disabled: boolean;
  readOnly?: boolean;
  busyLabel: string | null;
  onPick: (files: FileList | null) => void;
  onMakeMain: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onReplace: (index: number, file: File) => void;
}) {
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<number | null>(null);
  const full = items.length >= MAX_PRODUCT_IMAGES;
  const control =
    'flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-gray-700 shadow transition hover:text-gray-900 disabled:opacity-40';
  return (
    <section aria-label="Product images" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-gray-800">Product images</p>
        <p className="text-xs text-gray-500">
          {items.length}/{MAX_PRODUCT_IMAGES}
        </p>
      </div>
      <input
        ref={replaceInput}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && replacing.current !== null) onReplace(replacing.current, file);
          replacing.current = null;
          event.target.value = '';
        }}
      />
      {items.length === 0 && readOnly && <p className="text-sm text-gray-500">No images.</p>}
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {items.map((image, index) => (
          <li key={image.id} className="relative aspect-square">
            <img src={image.src} alt={`Product image ${index + 1}`} className="h-full w-full rounded-xl border border-gray-200 object-cover" />
            {index === 0 && (
              <span className="absolute left-1.5 top-1.5 rounded-md bg-brand-500 px-1.5 py-0.5 text-[11px] font-semibold text-white">★ Main</span>
            )}
            {!readOnly && (
              <>
                {index !== 0 && (
                  <button type="button" aria-label={`Make image ${index + 1} the main image`} disabled={disabled} onClick={() => onMakeMain(index)} className={`absolute left-1.5 top-1.5 ${control}`}>
                    ☆
                  </button>
                )}
                <button type="button" aria-label={`Remove image ${index + 1}`} disabled={disabled} onClick={() => onRemove(index)} className={`absolute right-1.5 top-1.5 ${control} hover:text-danger-600`}>
                  <Icon name="close" className="h-4 w-4" />
                </button>
                <div className="absolute inset-x-1.5 bottom-1.5 flex justify-between">
                  <button type="button" aria-label={`Move image ${index + 1} left`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)} className={control}>
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label={`Replace image ${index + 1}`}
                    disabled={disabled}
                    onClick={() => {
                      replacing.current = index;
                      replaceInput.current?.click();
                    }}
                    className={control}
                  >
                    ↻
                  </button>
                  <button type="button" aria-label={`Move image ${index + 1} right`} disabled={disabled || index === items.length - 1} onClick={() => onMove(index, 1)} className={control}>
                    ›
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
        {!readOnly && !full && (
          <li className="aspect-square">
            <label
              className={`flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-gray-300 text-xs font-medium text-gray-500 transition ${
                disabled ? 'opacity-50' : 'cursor-pointer hover:border-brand-500 hover:text-brand-600'
              }`}
            >
              <Icon name="upload" className="h-6 w-6" />
              {busyLabel ?? 'Add photos'}
              <input
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                multiple
                disabled={disabled}
                className="sr-only"
                onChange={(event) => {
                  onPick(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
          </li>
        )}
      </ul>
      {!readOnly && (
        <p className="text-xs text-gray-500">
          JPEG, PNG, WebP or AVIF, up to 5 MB each, at most {MAX_PRODUCT_IMAGES}. ★ Main is shown on your product card; ↻ replaces a photo.
        </p>
      )}
    </section>
  );
}

/** Moves one item of a list (used for gallery order). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

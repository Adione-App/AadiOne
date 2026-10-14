/**
 * Seller detail — Restaurant tab (RESTAURANT / CAFE sellers only).
 *
 * Editable here: the restaurant's customer-facing PHOTOS — its logo and cover
 * (PUT/DELETE /admin/restaurants/:sellerId/images/:kind, through the admin
 * upload + image pipeline), shown on the Food list and the menu page. Admins
 * with catalogue rights only. Everything else on the tab is read-only: the
 * restaurant manages its profile and menu in the Seller Panel.
 *
 * One read: GET /admin/restaurants/:sellerId (admin session) — the existing
 * admin restaurant view: profile fields plus every menu section and item,
 * whatever their state. Only the fields below are rendered; nothing from the
 * response is spread into the page. Whether a RestaurantProfile exists at all
 * comes from the masked seller overview (the restaurant response fills
 * defaults for a missing one). No bank, PAN, Aadhaar or document data is
 * involved in this tab.
 *
 * The parent never mounts this tab for other seller types, so no restaurant
 * request is ever made for them.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApprovalStatus, Permission, formatPaise, roleHasPermission, type AdminSellerDetailDto } from '@shared';
import { adminSellerKeys, sellerErrorMessage, useAdminRestaurant, type AdminRestaurantSection } from '@/lib/sellers';
import { useAuth } from '@/lib/auth';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { removeRestaurantImage, setRestaurantImage, uploadAdminImage } from '@/lib/content';
import { DetailRow } from '@/components/SellerBadges';
import { Button, EmptyState, ErrorBanner, Panel, Pill, Spinner, Td, Th, type Tone } from '@/components/ui';

const APPROVAL_LOOK: Record<string, { label: string; tone: Tone }> = {
  [ApprovalStatus.PENDING]: { label: 'Pending review', tone: 'amber' },
  [ApprovalStatus.APPROVED]: { label: 'Approved', tone: 'brand' },
  [ApprovalStatus.REJECTED]: { label: 'Rejected', tone: 'red' },
};

export default function SellerRestaurantTab({ seller }: { seller: AdminSellerDetailDto }) {
  const restaurant = useAdminRestaurant(seller.id);

  if (restaurant.isPending) return <Spinner label="Loading restaurant…" />;
  if (restaurant.isError) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={sellerErrorMessage(restaurant.error, 'Could not load the restaurant.')} />
        <Button variant="secondary" onClick={() => void restaurant.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { restaurant: profile, sections } = restaurant.data;
  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);

  return (
    <div className="space-y-5">
      <RestaurantPhotos sellerId={seller.id} logoUrl={profile.logoUrl ?? null} coverImageUrl={profile.coverImageUrl ?? null} />

      <Panel title="Restaurant profile">
        {seller.restaurantProfile === null ? (
          <EmptyState title="No restaurant profile configured" hint="The restaurant adds cuisine, veg-only and preparation time in the Seller Panel." />
        ) : (
          <dl className="divide-y divide-gray-100">
            <DetailRow label="Cuisine">{profile.cuisine.length ? profile.cuisine.join(', ') : '—'}</DetailRow>
            <DetailRow label="Veg only">
              <Pill tone={profile.isVegOnly ? 'brand' : 'gray'}>{profile.isVegOnly ? 'Yes — pure veg' : 'No'}</Pill>
            </DetailRow>
            <DetailRow label="Average preparation time">
              {profile.avgPrepMins !== null ? `${profile.avgPrepMins} min` : '—'}
            </DetailRow>
          </dl>
        )}
      </Panel>

      <Panel title="Menu sections" bodyClass="">
        {sections.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No menu sections" hint="The restaurant creates its menu sections in the Seller Panel." />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-gray-200 bg-gray-50">
              <tr>
                <Th>Section</Th>
                <Th>Status</Th>
                <Th className="text-right">Items</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sections.map((section) => (
                <tr key={section.id}>
                  <Td className="font-medium text-gray-900">{section.name}</Td>
                  <Td>
                    <Pill tone={section.isActive ? 'brand' : 'gray'}>{section.isActive ? 'Active' : 'Inactive'}</Pill>
                  </Td>
                  <Td className="text-right text-gray-700">{section.items.length}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Menu items" bodyClass="">
        {itemCount === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No menu items" hint="Items appear here once the restaurant lists them in a menu section." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-y border-gray-200 bg-gray-50">
                <tr>
                  <Th>Item</Th>
                  <Th>Section</Th>
                  <Th>Approval</Th>
                  <Th>Listing</Th>
                  <Th className="text-right">Price</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sections.flatMap((section: AdminRestaurantSection) =>
                  section.items.map((item) => {
                    const approval = APPROVAL_LOOK[item.approvalStatus] ?? { label: item.approvalStatus, tone: 'gray' as Tone };
                    return (
                      <tr key={item.sellerListingId}>
                        <Td>
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-xs text-gray-500">{item.variantName}</p>
                        </Td>
                        <Td className="text-gray-700">{section.name}</Td>
                        <Td>
                          <Pill tone={approval.tone}>{approval.label}</Pill>
                        </Td>
                        <Td>
                          {!item.isAvailable ? (
                            <Pill tone="gray">Switched off</Pill>
                          ) : item.inStock ? (
                            <Pill tone="brand">Available</Pill>
                          ) : (
                            <Pill tone="amber">Out of stock</Pill>
                          )}
                        </Td>
                        <Td className="whitespace-nowrap text-right text-gray-800">
                          {formatPaise(item.pricePaise)}
                          {item.mrpPaise > item.pricePaise && (
                            <span className="ml-1 text-xs text-gray-400 line-through">{formatPaise(item.mrpPaise)}</span>
                          )}
                        </Td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-xs text-gray-500">
        Photos are managed here; the profile and menu are read-only (the restaurant manages them in the Seller Panel). Items are grouped by the
        restaurant's own menu sections; approval happens in Product Approvals.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Customer-facing photos                                                      */
/* -------------------------------------------------------------------------- */

const PHOTO_COPY = {
  cover: { title: 'Cover photo', hint: 'Wide photo across the top of the menu page and on the Food list card. At least 600 px wide; landscape works best.' },
  logo: { title: 'Logo', hint: 'Shown in a circle on the menu page. A square image works best.' },
} as const;

function RestaurantPhotos({ sellerId, logoUrl, coverImageUrl }: { sellerId: string; logoUrl: string | null; coverImageUrl: string | null }) {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  return (
    <Panel title="Customer-facing photos">
      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <PhotoSlot sellerId={sellerId} kind="cover" url={coverImageUrl} canEdit={canEdit} />
        <PhotoSlot sellerId={sellerId} kind="logo" url={logoUrl} canEdit={canEdit} />
      </div>
      {!coverImageUrl && <p className="mt-3 text-xs text-gray-500">Without a cover photo the app shows a photo from the restaurant's menu.</p>}
    </Panel>
  );
}

function PhotoSlot({ sellerId, kind, url, canEdit }: { sellerId: string; kind: 'logo' | 'cover'; url: string | null; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const copy = PHOTO_COPY[kind];

  async function run(label: string, action: () => Promise<unknown>, done: string) {
    setNotice(null);
    setBusy(label);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: adminSellerKeys.restaurant(sellerId) });
      setNotice({ ok: true, text: done });
    } catch (failure) {
      setNotice({ ok: false, text: sellerErrorMessage(failure, `The ${copy.title.toLowerCase()} could not be saved. Please try again.`) });
    } finally {
      setBusy(null);
    }
  }

  function upload(file: File | undefined) {
    if (!file) return;
    const invalid = validateImage(file);
    if (invalid) return setNotice({ ok: false, text: invalid });
    void run(
      'Uploading…',
      async () => setRestaurantImage(sellerId, kind, await uploadAdminImage(file, 'restaurant')),
      `${copy.title} saved. The app shows it on its next refresh.`,
    );
  }

  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <p className="text-sm font-semibold text-gray-900">{copy.title}</p>
      <p className="mb-2 text-xs text-gray-500">{copy.hint}</p>
      <div
        className={`flex items-center justify-center overflow-hidden border border-gray-200 bg-gray-50 ${kind === 'logo' ? 'mx-auto h-28 w-28 rounded-full' : 'aspect-[16/7] w-full rounded-xl'}`}
      >
        {url ? (
          <img src={imageSrc(url)} alt={copy.title} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-gray-400">No {copy.title.toLowerCase()}</span>
        )}
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
            {busy === 'Uploading…' ? busy : url ? 'Replace' : 'Upload'}
            <input
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="sr-only"
              disabled={Boolean(busy)}
              onChange={(event) => {
                upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {url && (
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => {
                if (window.confirm(`Remove the ${copy.title.toLowerCase()}? Customers will no longer see it.`)) {
                  void run('Removing…', () => removeRestaurantImage(sellerId, kind), `${copy.title} removed.`);
                }
              }}
            >
              {busy === 'Removing…' ? busy : 'Remove'}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className={`mt-2 text-xs font-medium ${notice.ok ? 'text-brand-700' : 'text-danger-600'}`}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

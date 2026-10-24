/**
 * Seller detail — Restaurant tab (RESTAURANT / CAFE sellers only).
 *
 * Editable here (admins with catalogue rights): the restaurant's customer-
 * facing PHOTOS — Restaurant Image (the Food list card), Menu Cover Image (the
 * top of its menu page) and logo, each on its own (PUT/DELETE
 * /admin/restaurants/:sellerId/images/:kind, through the admin upload + image
 * pipeline) — and its PREPARATION TIME (PUT …/prep-time), which customers see
 * as that time ± 5 min (prepTimeRange). The restaurant can change its cover,
 * menu image and time itself in the Seller Panel. Everything else is read-only.
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
import { ApprovalStatus, Permission, formatPaise, prepTimeRange, roleHasPermission, type AdminSellerDetailDto } from '@shared';
import { adminSellerKeys, sellerErrorMessage, useAdminRestaurant, type AdminRestaurantSection } from '@/lib/sellers';
import { useAuth } from '@/lib/auth';
import { removeRestaurantImage, setRestaurantImage, setRestaurantPrepTime, uploadAdminImage, type RestaurantImageKind } from '@/lib/content';
import { DetailRow } from '@/components/SellerBadges';
import { RestaurantImageSlot, type RestaurantImageSlotKind } from '@/components/RestaurantImageSlot';
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
      <RestaurantPhotos
        sellerId={seller.id}
        logoUrl={profile.logoUrl ?? null}
        coverImageUrl={profile.coverImageUrl ?? null}
        menuImageUrl={profile.menuImageUrl ?? null}
      />

      <Panel title="Restaurant profile">
        {seller.restaurantProfile === null ? (
          <EmptyState title="No restaurant profile configured" hint="The restaurant adds cuisine, veg-only and preparation time in the Seller Panel." />
        ) : (
          <dl className="divide-y divide-gray-100">
            <DetailRow label="Cuisine">{profile.cuisine.length ? profile.cuisine.join(', ') : '—'}</DetailRow>
            <DetailRow label="Veg only">
              <Pill tone={profile.isVegOnly ? 'brand' : 'gray'}>{profile.isVegOnly ? 'Yes — pure veg' : 'No'}</Pill>
            </DetailRow>
            <DetailRow label="Preparation time">
              <PrepTimeEditor sellerId={seller.id} avgPrepMins={profile.avgPrepMins} />
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

const PHOTO_COPY: Record<RestaurantImageKind, { slot: RestaurantImageSlotKind; field: 'coverImageUrl' | 'menuImageUrl' | 'logoUrl'; title: string; hint: string }> = {
  cover: {
    slot: 'restaurant',
    field: 'coverImageUrl',
    title: 'Restaurant Image',
    hint: 'The restaurant or cafe itself (storefront or interior), on its card in the Food list. At least 600 px wide; landscape works best — the card shows the middle of it.',
  },
  menu: {
    slot: 'menuCover',
    field: 'menuImageUrl',
    title: 'Menu Cover Image',
    hint: "The large photo at the top of the restaurant's menu page. Never used on the Food list. At least 600 px wide; landscape (16:9) works best.",
  },
  logo: { slot: 'logo', field: 'logoUrl', title: 'Logo', hint: 'Shown in a circle on the menu page. A square image works best.' },
};

function RestaurantPhotos({
  sellerId,
  logoUrl,
  coverImageUrl,
  menuImageUrl,
}: {
  sellerId: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  menuImageUrl: string | null;
}) {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  const queryClient = useQueryClient();
  const urls: Record<RestaurantImageKind, string | null> = { cover: coverImageUrl, menu: menuImageUrl, logo: logoUrl };

  return (
    <Panel title="Customer-facing photos">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_0.7fr]">
        {(['cover', 'menu', 'logo'] as const).map((kind) => {
          const copy = PHOTO_COPY[kind];
          return (
            <RestaurantImageSlot
              key={kind}
              kind={copy.slot}
              title={copy.title}
              hint={copy.hint}
              url={urls[kind]}
              canEdit={canEdit}
              upload={async (file) => (await setRestaurantImage(sellerId, kind, await uploadAdminImage(file, 'restaurant')))[copy.field] ?? null}
              remove={() => removeRestaurantImage(sellerId, kind)}
              reload={async () => {
                await queryClient.invalidateQueries({ queryKey: adminSellerKeys.restaurant(sellerId) });
                const fresh = queryClient.getQueryData<{ restaurant: Partial<Record<typeof copy.field, string | null>> }>(adminSellerKeys.restaurant(sellerId));
                return fresh?.restaurant[copy.field] ?? null;
              }}
              errorText={(failure) => sellerErrorMessage(failure, `The ${copy.title} could not be saved. Please try again.`)}
            />
          );
        })}
      </div>
      <p className="mt-3 text-xs text-gray-500">
        Each photo is used only in its own place: without a Restaurant Image the Food list card shows a placeholder, and without a Menu Cover
        Image the menu page does — menu item photos are never used for either.
      </p>
    </Panel>
  );
}

/** The configured preparation time, editable, with the range customers see. */
function PrepTimeEditor({ sellerId, avgPrepMins }: { sellerId: string; avgPrepMins: number | null }) {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  const queryClient = useQueryClient();
  const [value, setValue] = useState(avgPrepMins?.toString() ?? '');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const minutes = value.trim() === '' ? null : Number(value);
  const valid = minutes === null || (Number.isInteger(minutes) && minutes >= 1 && minutes <= 240);
  const range = valid ? prepTimeRange(minutes) : null;

  if (!canEdit) {
    return <span>{avgPrepMins !== null ? `${avgPrepMins} min — customers see ${prepTimeRange(avgPrepMins)?.label}` : '—'}</span>;
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-24 rounded-xl border border-gray-300 px-3 py-1.5 text-sm"
          inputMode="numeric"
          value={value}
          placeholder="min"
          aria-label="Preparation time in minutes"
          onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, ''))}
        />
        <span className="text-sm text-gray-600">minutes</span>
        <Button
          variant="secondary"
          disabled={busy || !valid || minutes === avgPrepMins}
          onClick={async () => {
            setBusy(true);
            setNotice(null);
            try {
              await setRestaurantPrepTime(sellerId, minutes);
              await queryClient.invalidateQueries({ queryKey: adminSellerKeys.restaurant(sellerId) });
              setNotice({ ok: true, text: 'Preparation time saved. The app shows it on its next refresh.' });
            } catch (failure) {
              setNotice({ ok: false, text: sellerErrorMessage(failure, 'The preparation time could not be saved.') });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p className={`text-xs ${valid ? 'text-gray-500' : 'text-danger-600'}`}>
        {!valid ? 'A whole number of minutes, 1–240.' : range ? `Customers see “${range.label}”.` : 'Not set — no time is shown to customers.'}
      </p>
      {notice && <p className={`text-xs font-medium ${notice.ok ? 'text-brand-700' : 'text-danger-600'}`}>{notice.text}</p>}
    </div>
  );
}

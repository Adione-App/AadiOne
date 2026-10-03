/**
 * Seller detail — Restaurant tab (READ-ONLY; RESTAURANT sellers only).
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

import { ApprovalStatus, formatPaise, type AdminSellerDetailDto } from '@shared';
import { sellerErrorMessage, useAdminRestaurant, type AdminRestaurantSection } from '@/lib/sellers';
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
        Read-only. Items are grouped by the restaurant's own menu sections; approval happens in Product Approvals.
      </p>
    </div>
  );
}

/**
 * The admin-approved delivery villages (GET /store/delivery-locations — the
 * active village + PIN pairs only) and the app's use of them: the address
 * dropdowns offer exactly these, and a GPS location's address is matched
 * against them. The SERVER checks every saved address and order again
 * (backend addresses/delivery-locations.ts) — this only spares the customer
 * a refused attempt. Pure — unit-tested (tests/deliveryLocations.test.ts).
 */

import { deliveryPairVerdict, normalizeVillageName } from '@shared/address';

/** One approved village and its PIN codes (GET /store/delivery-locations; the hook: useDeliveryLocations.ts). */
export interface ApprovedVillage {
  village: string;
  pincodes: string[];
}

/** The approved villages as the pair list the shared rules read. */
function asPairs(villages: readonly ApprovedVillage[]) {
  return villages.flatMap((v) => v.pincodes.map((pincode) => ({ village: v.village, pincode, active: true })));
}

/** The PIN codes approved for this village (none when the village is not approved). */
export function pincodesFor(villages: readonly ApprovedVillage[], village: string | null | undefined): string[] {
  const name = normalizeVillageName(village);
  return villages.find((v) => normalizeVillageName(v.village) === name)?.pincodes ?? [];
}

/** The approved village matching this name (its admin spelling), or null. */
export function approvedVillage(villages: readonly ApprovedVillage[], village: string | null | undefined): string | null {
  const name = normalizeVillageName(village);
  return name ? (villages.find((v) => normalizeVillageName(v.village) === name)?.village ?? null) : null;
}

/**
 * A GPS location's geocoded village + PIN against the approved list: the
 * pair (admin spelling) only when BOTH match exactly — never a nearby
 * village, never a village with another PIN. Otherwise null: the customer
 * chooses.
 */
export function matchApprovedPair(
  villages: readonly ApprovedVillage[],
  village: string | null | undefined,
  pincode: string | null | undefined,
): { village: string; pincode: string } | null {
  const { verdict, pair } = deliveryPairVerdict(asPairs(villages), village, pincode);
  return verdict === 'APPROVED' && pair ? { village: pair.village, pincode: pair.pincode } : null;
}

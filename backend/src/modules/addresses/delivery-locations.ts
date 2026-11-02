/**
 * Admin-approved delivery villages — THE eligibility list for where Aadione
 * delivers (Configuration DELIVERY_LOCATIONS, edited in the admin panel).
 *
 *   approved village + its approved PIN, active   → delivered to
 *   approved village + another PIN                → not delivered to
 *   unapproved village                            → not delivered to
 *   a disabled pair                               → not delivered to
 *
 * The rules themselves are pure and shared with the app (shared/address.ts
 * `deliveryPairVerdict`), so the dropdowns offer exactly what the server
 * accepts — and the server checks every saved address, quote and order again
 * whatever the app sends. No state and no seller location takes part.
 */

import { ConfigKey, ErrorCode, type DeliveryLocationPair } from '../../shared';
import {
  activePincodesFor,
  activeVillages,
  deliveryPairMessage,
  deliveryPairVerdict,
  type DeliveryPairVerdict,
} from '../../shared/address';
import { AppError } from '../../common/errors';
import * as configService from '../configuration/configuration.service';

export async function deliveryLocations(): Promise<DeliveryLocationPair[]> {
  const list = await configService.get(ConfigKey.DELIVERY_LOCATIONS);
  return Array.isArray(list) ? list : [];
}

export interface PairCheck {
  verdict: DeliveryPairVerdict;
  /** The admin's own spelling of the village (APPROVED / DISABLED), to store. */
  village: string | null;
  pincode: string | null;
}

/** The verdict for (village, PIN) against the current admin list. */
export async function checkDeliveryPair(village: string | null | undefined, pincode: string | null | undefined): Promise<PairCheck> {
  const { verdict, pair } = deliveryPairVerdict(await deliveryLocations(), village, pincode);
  return { verdict, village: pair?.village.trim() ?? null, pincode: pair?.pincode ?? null };
}

/**
 * Throws OUT_OF_SERVICE_AREA (with the reason, in words) unless (village,
 * PIN) is an active approved pair; returns the admin's spelling of it.
 */
export async function assertDeliveryPair(
  village: string | null | undefined,
  pincode: string | null | undefined,
): Promise<{ village: string; pincode: string }> {
  const check = await checkDeliveryPair(village, pincode);
  if (check.verdict !== 'APPROVED') {
    throw new AppError(ErrorCode.OUT_OF_SERVICE_AREA, {
      message: deliveryPairMessage(check.verdict, village, pincode),
      details: [{ field: check.verdict === 'PIN_MISMATCH' ? 'pincode' : 'city', message: check.verdict }],
      internalMessage: `delivery pair ${String(village)} / ${String(pincode)}: ${check.verdict}`,
    });
  }
  return { village: check.village!, pincode: check.pincode! };
}

/** GET /store/delivery-locations — the active pairs the app's dropdowns offer (no ids, no inactive ones). */
export async function listActiveDeliveryLocations(): Promise<{ villages: { village: string; pincodes: string[] }[] }> {
  const list = await deliveryLocations();
  return {
    villages: activeVillages(list).map((village) => ({ village, pincodes: activePincodesFor(list, village) })),
  };
}

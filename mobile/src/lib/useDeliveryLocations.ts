/** The admin-approved villages and their PIN codes, for the address dropdowns (lib/deliveryLocations.ts). */

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { ApprovedVillage } from './deliveryLocations';

export const DELIVERY_LOCATIONS_KEY = ['delivery-locations'] as const;

export function useDeliveryLocations() {
  return useQuery({
    queryKey: DELIVERY_LOCATIONS_KEY,
    queryFn: async () => (await api.get<{ villages: ApprovedVillage[] }>('/store/delivery-locations')).villages,
    // The admin edits the list rarely; a few minutes old is fine (the server re-checks).
    staleTime: 5 * 60_000,
  });
}

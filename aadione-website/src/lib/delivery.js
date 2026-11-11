// Delivery eligibility, exactly as the server decides it (backend
// src/shared/address.ts deliveryPairVerdict): an address is delivered to only
// when its village is on the admin-approved list AND its PIN code is one
// approved for that village. Never "nearby", never by distance. The list comes
// from GET /store/delivery-locations (active villages only, with their PINs).

/** "  kuraj " / "KURAJ" / "Kuraj" → "kuraj": how two village names are compared. */
export const normalizeVillageName = (name) => (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export const isPinFormat = (pin) => /^[1-9]\d{5}$/.test((pin ?? '').trim())

/**
 * @param {{village: string, pincodes: string[]}[]} villages  the approved list
 * @returns {{ verdict: 'APPROVED'|'MISSING'|'INVALID_PIN'|'VILLAGE_NOT_APPROVED'|'PIN_MISMATCH', village: string|null, pincodes: string[] }}
 */
export function checkDelivery(villages, village, pin) {
  const name = normalizeVillageName(village)
  const code = (pin ?? '').trim()
  if (!name || !code) return { verdict: 'MISSING', village: null, pincodes: [] }
  if (!isPinFormat(code)) return { verdict: 'INVALID_PIN', village: null, pincodes: [] }
  const match = villages.find((v) => normalizeVillageName(v.village) === name)
  if (!match) return { verdict: 'VILLAGE_NOT_APPROVED', village: null, pincodes: [] }
  if (!match.pincodes.includes(code)) return { verdict: 'PIN_MISMATCH', village: match.village, pincodes: match.pincodes }
  return { verdict: 'APPROVED', village: match.village, pincodes: match.pincodes }
}

/** The approved villages that use this PIN code (a hint only — the village decides). */
export const villagesForPin = (villages, pin) => villages.filter((v) => v.pincodes.includes((pin ?? '').trim())).map((v) => v.village)

/** What to tell the customer, in the app's own words where it has them. */
export function deliveryMessage({ verdict, village, pincodes }, typedVillage, pin) {
  switch (verdict) {
    case 'APPROVED':
      return `Yes — Aadione delivers to ${village} (${pin.trim()}). The app confirms your full address before you order.`
    case 'INVALID_PIN':
      return 'Enter a valid 6-digit PIN code.'
    case 'PIN_MISMATCH':
      return `Sorry! ${village} is delivered to only with its own PIN code (${pincodes.join(', ')}) — ${pin.trim()} is not one of them.`
    case 'VILLAGE_NOT_APPROVED':
      return `Sorry! Aadione is not delivering to ${[typedVillage?.trim(), pin?.trim()].filter(Boolean).join(' ') || 'this location'} yet. We are working to expand our service area.`
    default:
      return 'Choose your village and enter its PIN code to check delivery.'
  }
}

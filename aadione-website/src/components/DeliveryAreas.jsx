import { useMemo, useState } from 'react'
import { CheckCircle2, Info, MapPin, RefreshCw, XCircle } from 'lucide-react'
import { useDeliveryAreas } from '../lib/publicApi'
import { checkDelivery, deliveryMessage, isPinFormat, villagesForPin } from '../lib/delivery'

// The admin-approved delivery villages and PIN codes, read live from the same
// list the app's address form uses and the server checks every order against
// (GET /store/delivery-locations). The check below is the server's own rule
// (lib/delivery.js): the village AND one of its PIN codes. The final check is
// always the app's, for the full address.

const NOT_LISTED = '__not_listed__'

export default function DeliveryAreas({ showList = true }) {
  const { status, data, retry } = useDeliveryAreas()
  const [village, setVillage] = useState('')
  const [pin, setPin] = useState('')
  const villages = useMemo(() => (status === 'ready' && Array.isArray(data?.villages) ? data.villages : []), [status, data])
  const pincodes = useMemo(() => [...new Set(villages.flatMap((v) => v.pincodes))].sort(), [villages])

  if (status === 'loading') {
    return <div className="h-48 animate-pulse rounded-3xl bg-leaf-50" aria-label="Loading delivery areas" />
  }
  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75">
        <p>The delivery areas could not be loaded just now. The Aadione app checks your address before you order.</p>
        <button type="button" onClick={retry} className="inline-flex items-center gap-1.5 font-semibold text-leaf-700 hover:text-leaf-800">
          <RefreshCw size={15} aria-hidden="true" /> Try again
        </button>
      </div>
    )
  }
  if (villages.length === 0) {
    return <p className="rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75">The delivery areas are being updated. The Aadione app checks your address before you order.</p>
  }

  const notListed = village === NOT_LISTED
  const pinTyped = pin.length > 0
  const pinComplete = pin.length === 6
  const result = notListed ? { verdict: 'VILLAGE_NOT_APPROVED', village: null, pincodes: [] } : checkDelivery(villages, village, pin)
  const pinHint = !village && pinComplete && isPinFormat(pin) ? villagesForPin(villages, pin) : null

  let tone = null
  let message = null
  if (pinTyped && pinComplete && !isPinFormat(pin)) {
    tone = 'bad'
    message = 'Enter a valid 6-digit PIN code.'
  } else if (notListed) {
    tone = 'bad'
    message = 'Sorry! Aadione is not delivering to other villages yet. We are working to expand our service area.'
  } else if (village && pinComplete) {
    tone = result.verdict === 'APPROVED' ? 'good' : 'bad'
    message = deliveryMessage(result, village, pin)
  } else if (pinHint) {
    tone = pinHint.length ? 'info' : 'bad'
    message = pinHint.length
      ? `PIN ${pin} is approved for ${pinHint.join(', ')}. Choose your village above to confirm.`
      : `Sorry! Aadione is not delivering to PIN ${pin} yet. We are working to expand our service area.`
  }

  const Icon = tone === 'good' ? CheckCircle2 : tone === 'info' ? Info : XCircle
  const toneClass = tone === 'good' ? 'border-leaf-200 bg-leaf-50 text-leaf-800' : tone === 'info' ? 'border-leaf-100 bg-white text-ink' : 'border-mango/40 bg-mango-light/30 text-ink'

  return (
    <div className="rounded-3xl border border-leaf-100 bg-white p-5 shadow-card sm:p-7">
      <h3 className="font-display text-base font-bold text-ink">Check delivery to your address</h3>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1fr]">
        <div>
          <label htmlFor="area-village" className="mb-1.5 block text-sm font-semibold text-ink">
            Village / town
          </label>
          <select
            id="area-village"
            value={village}
            onChange={(e) => setVillage(e.target.value)}
            className="w-full rounded-2xl border border-leaf-200 bg-leaf-50/40 px-4 py-3.5 text-base text-ink outline-none focus:border-leaf-500 focus:bg-white"
          >
            <option value="">Choose your village</option>
            {villages.map((v) => (
              <option key={v.village} value={v.village}>
                {v.village}
              </option>
            ))}
            <option value={NOT_LISTED}>My village is not listed</option>
          </select>
        </div>
        <div>
          <label htmlFor="area-pin" className="mb-1.5 block text-sm font-semibold text-ink">
            PIN code
          </label>
          <input
            id="area-pin"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6 digits"
            aria-invalid={pinComplete && !isPinFormat(pin)}
            className="w-full rounded-2xl border border-leaf-200 bg-leaf-50/40 px-4 py-3.5 text-base tracking-wider text-ink outline-none placeholder:tracking-normal placeholder:text-ink-light/40 focus:border-leaf-500 focus:bg-white"
          />
        </div>
      </div>

      <div aria-live="polite" className="mt-4 min-h-[3rem]">
        {message && (
          <p className={`flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
            <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </p>
        )}
      </div>

      {showList && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-sm font-semibold text-leaf-700 hover:text-leaf-800">
            <span className="group-open:hidden">Show all {villages.length} approved villages</span>
            <span className="hidden group-open:inline">Hide the list</span>
          </summary>
          <ul className="mt-3 grid max-h-80 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" aria-label="Approved delivery villages">
            {villages.map((v) => (
              <li key={v.village} className="flex items-center justify-between gap-3 rounded-2xl bg-leaf-50/60 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2 font-medium text-ink">
                  <MapPin size={15} className="text-leaf-600" aria-hidden="true" />
                  {v.village}
                </span>
                <span className="text-xs font-semibold text-leaf-700">{v.pincodes.join(', ')}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="mt-4 text-xs leading-relaxed text-ink-light/60">
        {villages.length} approved {villages.length === 1 ? 'village' : 'villages'} across PIN {pincodes.length === 1 ? 'code' : 'codes'} {pincodes.join(', ')}. Delivery
        charges and estimated times are shown in the app for your address.
      </p>
    </div>
  )
}

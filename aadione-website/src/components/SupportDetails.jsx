import { Clock, Mail, MessageCircle, Phone, RefreshCw } from 'lucide-react'
import { useBusinessInfo } from '../lib/publicApi'
import { phoneHref, whatsappLink } from '../lib/business'

// Support contact options from Admin Configuration (GET /legal/business) —
// the same values the app shows. An empty setting is hidden, never replaced.
// WhatsApp comes only from the Admin "Support WhatsApp" field (never the
// phone number) and appears only when that value is a valid mobile number.

/** Support hours exactly as configured, with accidental repeated commas tidied. */
export const tidyHours = (hours) => (hours ? hours.replace(/\s*,(\s*,)+/g, ',').trim() : hours)

const card = 'flex items-center gap-3 rounded-2xl border border-leaf-100 bg-white p-4 text-sm font-semibold text-ink transition-colors hover:border-leaf-300 hover:bg-leaf-50/40'

export default function SupportDetails({ className = '' }) {
  const { status, data, retry } = useBusinessInfo()
  const support = data?.support ?? {}
  const phoneLink = phoneHref(support.phone)
  const whatsapp = whatsappLink(support.whatsapp)

  if (status === 'loading') return <div className={`h-40 animate-pulse rounded-3xl bg-white/70 ${className}`} aria-label="Loading contact details" />
  if (status === 'error') {
    return (
      <div className={`flex flex-col items-start gap-3 rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75 ${className}`}>
        <p>Contact details could not be loaded just now. You can also reach us from the Help section of the Aadione app.</p>
        <button type="button" onClick={retry} className="inline-flex items-center gap-1.5 font-semibold text-leaf-700">
          <RefreshCw size={15} aria-hidden="true" /> Try again
        </button>
      </div>
    )
  }
  if (!support.email && !support.phone && !whatsapp) {
    return <p className={`rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75 ${className}`}>Please contact us from the Help section of the Aadione app.</p>
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {support.email && (
        <a href={`mailto:${support.email}`} className={card}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-50 text-leaf-700">
            <Mail size={18} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-medium text-ink-light/60">Email</span>
            <span className="block break-all">{support.email}</span>
          </span>
        </a>
      )}
      {support.phone && (() => {
        const body = (
          <>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-50 text-leaf-700">
              <Phone size={18} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-xs font-medium text-ink-light/60">Call us</span>
              <span className="block">{support.phone}</span>
            </span>
          </>
        )
        // A number that cannot be dialled as written is shown, not linked.
        return phoneLink ? <a href={phoneLink} className={card}>{body}</a> : <div className={card}>{body}</div>
      })()}
      {whatsapp && (
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={card}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-50 text-leaf-700">
            <MessageCircle size={18} aria-hidden="true" />
          </span>
          <span>
            <span className="block text-xs font-medium text-ink-light/60">WhatsApp</span>
            <span className="block">{support.whatsapp}</span>
          </span>
        </a>
      )}
      {support.hours && (
        <p className="flex items-center gap-2 px-1 text-sm text-ink-light/75">
          <Clock size={16} className="text-leaf-600" aria-hidden="true" /> Support hours: {tidyHours(support.hours)}
        </p>
      )}
    </div>
  )
}

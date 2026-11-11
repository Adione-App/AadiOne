// Checks on the business details from Admin Configuration (GET /legal/business)
// before the site shows them. A value that is clearly not what it claims to be
// is hidden rather than shown wrong — e.g. a link to one Instagram post saved
// as the "official Instagram" profile.

const NETWORK_HOSTS = {
  instagram: /(^|\.)instagram\.com$/,
  facebook: /(^|\.)(facebook\.com|fb\.com)$/,
  x: /(^|\.)(x\.com|twitter\.com)$/,
  youtube: /(^|\.)youtube\.com$/,
  linkedin: /(^|\.)linkedin\.com$/,
}

// Paths that point at one post, reel, video or story — not a profile or page.
const NOT_A_PROFILE = /^\/(p|reel|reels|stories|tv|posts|status|watch|shorts|photo|photos|video|videos|share|events)(\/|$)|\/status\/|\/posts\/|\/videos?\//i

/** True when `url` is an https link to a profile/page on the given network. */
export function isProfileUrl(network, url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = NETWORK_HOSTS[network]
  if (!host || !host.test(parsed.hostname.toLowerCase())) return false
  const path = parsed.pathname.replace(/\/+$/, '')
  if (!path || path === '/') return false
  return !NOT_A_PROFILE.test(parsed.pathname)
}

/** The configured social links that are real profile pages, in the order given. */
export const officialSocials = (socials) => (Array.isArray(socials) ? socials.filter((s) => isProfileUrl(s.network, s.url)) : [])

// Phone numbers from Admin Configuration are free text (validated by the admin
// panel). A link is built only from a number that is clearly dialable:
// a 10-digit Indian number (6–9 first) becomes +91…; a number already written
// with +91 / 91 is used as is. Anything else gets no link (the pages show the
// number as plain text).

const indianMobileDigits = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`
  if (/^91[6-9]\d{9}$/.test(digits)) return digits
  return null
}

/** tel: link for a support phone, or null when the number is not dialable. */
export function phoneHref(phone) {
  const mobile = indianMobileDigits(phone)
  if (mobile) return `tel:+${mobile}`
  const digits = String(phone ?? '').replace(/[^\d+]/g, '')
  return /^\+?\d{8,15}$/.test(digits) ? `tel:${digits}` : null
}

/** wa.me link for a WhatsApp number (WhatsApp needs the country code), or null. */
export function whatsappLink(phone) {
  const mobile = indianMobileDigits(phone)
  return mobile ? `https://wa.me/${mobile}` : null
}

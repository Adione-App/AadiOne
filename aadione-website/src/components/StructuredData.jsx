import { useEffect } from 'react'
import { appLinks, site } from '../config/site'
import { useBusinessInfo } from '../lib/publicApi'
import { officialSocials } from '../lib/business'

// schema.org data for search engines. index.html carries the static part
// (WebSite, Organization, the two MobileApplication listings) for crawlers
// that do not run scripts; this adds the support contact and official social
// profiles from Admin Configuration once loaded. No rating, review count,
// price or customer number is ever stated.
export function organizationJsonLd(business) {
  const support = business?.support ?? {}
  const contact = support.email || support.phone
    ? [{ '@type': 'ContactPoint', contactType: 'customer support', areaServed: 'IN', ...(support.email ? { email: support.email } : {}), ...(support.phone ? { telephone: support.phone } : {}) }]
    : undefined
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${site.url}/#organization`,
    name: business?.tradeName || site.name,
    url: site.url,
    logo: `${site.url}/icon-512.png`,
    ...(contact ? { contactPoint: contact } : {}),
    ...(officialSocials(business?.socials).length ? { sameAs: officialSocials(business.socials).map((s) => s.url) } : {}),
  }
}

export const STORE_URLS = [appLinks.playStore, appLinks.appStore]

export default function StructuredData() {
  const { data } = useBusinessInfo()
  useEffect(() => {
    if (!data) return
    const el = document.createElement('script')
    el.type = 'application/ld+json'
    el.dataset.dynamic = 'organization'
    el.textContent = JSON.stringify(organizationJsonLd(data))
    document.head.appendChild(el)
    return () => el.remove()
  }, [data])
  return null
}

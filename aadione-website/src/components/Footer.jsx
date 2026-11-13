import { Link } from 'react-router-dom'
import { Mail, Phone, MessageCircle, Clock, Instagram, Facebook, Twitter, Linkedin, Youtube } from 'lucide-react'
import Container from './Container'
import Logo from './Logo'
import { StoreBadge } from './AppStoreButtons'
import { tidyHours } from './SupportDetails'
import { companyNav, legalNav, site } from '../config/site'
import { useAvailablePages, useBusinessInfo } from '../lib/publicApi'
import { officialSocials, phoneHref, whatsappLink } from '../lib/business'

const SOCIAL_ICONS = { instagram: Instagram, facebook: Facebook, x: Twitter, youtube: Youtube, linkedin: Linkedin }

// Contact, operator and social details come from Admin Configuration via the
// public API (same values the app shows); an empty setting is simply not shown.
export default function Footer() {
  const year = new Date().getFullYear()
  const { data: business } = useBusinessInfo()
  // Policies that have their own page only once published (Admin → Legal & Policies).
  const { data: pages } = useAvailablePages()
  const published = new Set((pages ?? []).filter((page) => page.source === 'published').map((page) => page.slug))
  const legalItems = [
    ...legalNav,
    ...(published.has('cookie-policy') ? [{ label: 'Cookie Policy', to: '/cookie-policy' }] : []),
    ...(published.has('seller-terms') ? [{ label: 'Seller Terms', to: '/seller-terms' }] : []),
    ...(published.has('seller-privacy') ? [{ label: 'Seller Privacy Policy', to: '/seller-privacy' }] : []),
  ]
  const support = business?.support ?? {}
  const socials = officialSocials(business?.socials)
  const phoneLink = phoneHref(support.phone)
  // WhatsApp: the Admin "Support WhatsApp" field only, never the phone number.
  const whatsapp = whatsappLink(support.whatsapp)
  const operator = [
    business?.legalName ? `Operated by ${business.legalName}${business.businessType ? ` (${business.businessType})` : ''}` : null,
    business?.address,
    business?.gstin ? `GSTIN ${business.gstin}` : null,
  ].filter(Boolean)

  return (
    <footer className="border-t border-leaf-100 bg-ink text-cream-100">
      <Container className="py-14 sm:py-16">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1.1fr_1.3fr]">
          <div>
            <Link to="/" aria-label="Aadione home" className="inline-flex">
              <Logo className="h-9" onDark />
            </Link>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-cream-100/70">
              {site.tagline} Groceries, fresh produce and food from local restaurants, delivered in Aadione&rsquo;s approved delivery areas.
            </p>
            <div className="mt-6 flex flex-wrap gap-2.5">
              <StoreBadge store="android" height={40} />
              <StoreBadge store="ios" height={40} />
            </div>
            {socials.length > 0 && (
              <div className="mt-6 flex items-center gap-3">
                {socials.map((social) => (
                  <SocialIcon key={social.network} href={social.url} label={social.label} Icon={SOCIAL_ICONS[social.network] ?? Instagram} />
                ))}
              </div>
            )}
          </div>

          <FooterLinks title="Aadione" items={companyNav} />
          <FooterLinks title="Legal" items={legalItems} />

          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">Customer support</h3>
            <ul className="mt-4 space-y-3 text-sm text-cream-100/80">
              {support.email && (
                <li className="flex items-start gap-2.5">
                  <Mail size={17} className="mt-0.5 shrink-0 text-leaf-300" aria-hidden="true" />
                  <a href={`mailto:${support.email}`} className="break-all hover:text-white">
                    {support.email}
                  </a>
                </li>
              )}
              {support.phone && (
                <li className="flex items-start gap-2.5">
                  <Phone size={17} className="mt-0.5 shrink-0 text-leaf-300" aria-hidden="true" />
                  {phoneLink ? (
                    <a href={phoneLink} className="hover:text-white">
                      {support.phone}
                    </a>
                  ) : (
                    support.phone
                  )}
                </li>
              )}
              {whatsapp && (
                <li className="flex items-start gap-2.5">
                  <MessageCircle size={17} className="mt-0.5 shrink-0 text-leaf-300" aria-hidden="true" />
                  <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                    WhatsApp {support.whatsapp}
                  </a>
                </li>
              )}
              {support.hours && (
                <li className="flex items-start gap-2.5 text-cream-100/60">
                  <Clock size={17} className="mt-0.5 shrink-0 text-leaf-300" aria-hidden="true" />
                  {tidyHours(support.hours)}
                </li>
              )}
              <li>
                <Link to="/support" className="font-semibold text-leaf-200 hover:text-white">
                  Help with an order
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-7 text-xs text-cream-100/55 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p>
              © {year} {business?.tradeName || site.name}. All rights reserved.
            </p>
            {operator.length > 0 && <p>{operator.join(' · ')}</p>}
          </div>
          <p className="sm:text-right">Google Play and the Google Play logo are trademarks of Google LLC. App Store is a service mark of Apple Inc.</p>
        </div>
      </Container>
    </footer>
  )
}

function FooterLinks({ title, items }) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wider text-white/50">{title}</h3>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.to}>
            <Link to={item.to} className="text-sm text-cream-100/80 transition-colors hover:text-white">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SocialIcon({ href, label, Icon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens in a new tab)`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-leaf-600 hover:text-white"
    >
      <Icon size={17} aria-hidden="true" />
    </a>
  )
}

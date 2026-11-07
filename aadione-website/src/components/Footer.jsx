import { Link } from 'react-router-dom'
import { Mail, Phone, MessageCircle, Instagram, Facebook, Twitter, Linkedin, Youtube } from 'lucide-react'
import Container from './Container'
import AppStoreButtons from './AppStoreButtons'
import { companyNav, legalNav, site } from '../config/site'
import { useBusinessInfo } from '../lib/publicApi'
import { telHref, whatsappHref } from '../shared/info-pages'

const SOCIAL_ICONS = { instagram: Instagram, facebook: Facebook, x: Twitter, youtube: Youtube, linkedin: Linkedin }

// Contact, operator and social details come from Admin Configuration via the
// public API (same values the app shows); an empty setting is simply not shown.
export default function Footer() {
  const year = new Date().getFullYear()
  const { data: business } = useBusinessInfo()
  const support = business?.support ?? {}
  const socials = business?.socials ?? []
  const operator = [business?.legalName, business?.address, business?.gstin ? `GSTIN ${business.gstin}` : null].filter(Boolean)

  return (
    <footer className="border-t border-leaf-100 bg-ink text-cream-100">
      <Container className="py-16">
        <div className="grid grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1.2fr]">
          <div>
            <Link to="/" className="flex items-center gap-2.5">
              <img src="/assets/logo-white.svg" alt="Aadione" className="h-9 w-9" />
              <span className="font-display text-2xl font-semibold text-white">Aadione</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-cream-100/70">
              {site.description}
            </p>
            {socials.length > 0 && (
              <div className="mt-6 flex items-center gap-3">
                {socials.map((social) => (
                  <SocialIcon key={social.network} href={social.url} label={social.label} Icon={SOCIAL_ICONS[social.network] ?? Instagram} />
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Company
            </h3>
            <ul className="mt-4 space-y-3">
              {companyNav.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="text-sm text-cream-100/80 transition-colors hover:text-white"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">Legal</h3>
            <ul className="mt-4 space-y-3">
              {legalNav.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="text-sm text-cream-100/80 transition-colors hover:text-white"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Get in touch
            </h3>
            <ul className="mt-4 space-y-3 text-sm text-cream-100/80">
              {support.email && (
                <li className="flex items-start gap-2.5">
                  <Mail size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <a href={`mailto:${support.email}`} className="break-all hover:text-white">
                    {support.email}
                  </a>
                </li>
              )}
              {support.phone && (
                <li className="flex items-start gap-2.5">
                  <Phone size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <a href={telHref(support.phone)} className="hover:text-white">
                    {support.phone}
                  </a>
                </li>
              )}
              {support.whatsapp && (
                <li className="flex items-start gap-2.5">
                  <MessageCircle size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <a href={whatsappHref(support.whatsapp)} target="_blank" rel="noopener noreferrer" className="hover:text-white">
                    WhatsApp {support.whatsapp}
                  </a>
                </li>
              )}
              {support.hours && <li className="text-cream-100/60">Support hours: {support.hours}</li>}
              <li>
                <Link to="/contact" className="hover:text-white">
                  All contact options
                </Link>
              </li>
            </ul>
            <div className="mt-6">
              <AppStoreButtons />
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 text-xs text-cream-100/60 sm:flex-row">
          <div className="space-y-1 text-center sm:text-left">
            <p>
              © {year} {business?.tradeName || site.name}. All rights reserved.
            </p>
            {operator.length > 0 && <p className="text-cream-100/50">{operator.join(' · ')}</p>}
          </div>
          <p>{site.tagline}</p>
        </div>
      </Container>
    </footer>
  )
}

function SocialIcon({ href, label, Icon }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-leaf-600 hover:text-white"
    >
      <Icon size={17} />
    </a>
  )
}

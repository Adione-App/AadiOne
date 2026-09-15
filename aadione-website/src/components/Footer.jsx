import { Link } from 'react-router-dom'
import { Mail, Phone, Instagram, Facebook, Twitter, Linkedin } from 'lucide-react'
import Container from './Container'
import AppStoreButtons from './AppStoreButtons'
import { companyNav, legalNav, contact, socials, site } from '../config/site'

export default function Footer() {
  const year = new Date().getFullYear()
  const hasSocials = socials.instagram || socials.facebook || socials.twitter || socials.linkedin

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
            {hasSocials && (
              <div className="mt-6 flex items-center gap-3">
                {socials.instagram && <SocialIcon href={socials.instagram} label="Instagram" Icon={Instagram} />}
                {socials.facebook && <SocialIcon href={socials.facebook} label="Facebook" Icon={Facebook} />}
                {socials.twitter && <SocialIcon href={socials.twitter} label="Twitter" Icon={Twitter} />}
                {socials.linkedin && <SocialIcon href={socials.linkedin} label="LinkedIn" Icon={Linkedin} />}
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
              {contact.supportEmail ? (
                <li className="flex items-start gap-2.5">
                  <Mail size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <a href={`mailto:${contact.supportEmail}`} className="hover:text-white">
                    {contact.supportEmail}
                  </a>
                </li>
              ) : (
                <li className="flex items-start gap-2.5 text-cream-100/50">
                  <Mail size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <Link to="/contact" className="hover:text-white">
                    Contact form
                  </Link>
                </li>
              )}
              {contact.phone && (
                <li className="flex items-start gap-2.5">
                  <Phone size={17} className="mt-0.5 shrink-0 text-leaf-300" />
                  <span>{contact.phone}</span>
                </li>
              )}
            </ul>
            <div className="mt-6">
              <AppStoreButtons />
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 text-xs text-cream-100/60 sm:flex-row">
          <p>
            © {year} {site.name}. All rights reserved.
          </p>
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

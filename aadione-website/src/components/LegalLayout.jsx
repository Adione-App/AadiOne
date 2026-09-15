import Container from './Container'
import { legalNav } from '../config/site'
import { Link, useLocation } from 'react-router-dom'

export default function LegalLayout({ title, intro, updated, children }) {
  const location = useLocation()

  return (
    <>
      <section className="border-b border-leaf-100 bg-leaf-50/60 py-16 sm:py-20">
        <Container>
          <span className="text-sm font-semibold text-leaf-600">Legal</span>
          <h1 className="mt-3 max-w-2xl text-balance font-display text-3xl font-semibold text-ink sm:text-4xl">
            {title}
          </h1>
          {intro && (
            <p className="mt-4 max-w-2xl text-balance text-sm leading-relaxed text-ink-light/70 sm:text-base">
              {intro}
            </p>
          )}
          {updated && (
            <p className="mt-4 text-xs font-medium text-ink-light/50">Last updated: {updated}</p>
          )}
        </Container>
      </section>

      <section className="bg-white py-16 sm:py-20">
        <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[0.75fr_2fr]">
          <nav aria-label="Legal pages" className="lg:sticky lg:top-28 lg:self-start">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-light/40">
              Legal documents
            </p>
            <ul className="space-y-1">
              {legalNav.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={`block rounded-xl px-3 py-2 text-sm transition-colors ${
                      location.pathname === item.to
                        ? 'bg-leaf-100 font-medium text-leaf-800'
                        : 'text-ink-light/70 hover:bg-leaf-50 hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <article className="prose-legal max-w-none">{children}</article>
        </Container>
      </section>
    </>
  )
}

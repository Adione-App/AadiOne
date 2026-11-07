import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AlertTriangle, RotateCw } from 'lucide-react'
import Container from './Container'
import { infoTextSegments } from '../shared/info-pages'
import { infoPageHtmlUrl, useInfoPage } from '../lib/publicApi'
import { legalNav } from '../config/site'

/**
 * One published information page (Privacy Policy, Terms & Conditions, About)
 * as the API serves it — the very same text, "Last updated" date and version
 * the Aadione app shows. Plain text only: links are made solely for email
 * addresses, phone numbers and web addresses (shared infoTextSegments).
 *
 * Long pages get a contents list (sticky on desktop) with an anchor per
 * section, so other pages can link to e.g. /terms-and-conditions#refunds.
 */

export function LinkedText({ text }) {
  return infoTextSegments(text).map((segment, i) =>
    segment.href ? (
      <a key={i} href={segment.href} {...(segment.href.startsWith('http') ? { rel: 'noopener noreferrer', target: '_blank' } : {})}>
        {segment.text}
      </a>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  )
}

export function PageMeta({ page }) {
  const parts = [page.lastUpdatedLabel ? `Last updated ${page.lastUpdatedLabel}` : null, page.version ? `Version ${page.version}` : null].filter(Boolean)
  return (
    <>
      {parts.length > 0 && <p className="mt-4 text-sm font-medium text-ink-light/60">{parts.join(' · ')}</p>}
      {page.effectiveLabel && (
        <p className="mt-4 max-w-2xl rounded-xl border-l-4 border-leaf-600 bg-white/70 px-4 py-3 text-sm text-ink">
          This version takes effect on {page.effectiveLabel}.
        </p>
      )}
    </>
  )
}

export function PageSections({ page }) {
  return page.sections.map((section) => (
    <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-28">
      <h2 id={`${section.id}-title`}>{section.heading}</h2>
      {section.blocks.map((block, b) =>
        block.type === 'paragraph' ? (
          <p key={b}>
            <LinkedText text={block.text} />
          </p>
        ) : (
          <ul key={b}>
            {block.items.map((item, i) => (
              <li key={i}>
                <LinkedText text={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </section>
  ))
}

/** Scrolls to the #section in the address once the page's content is on screen. */
function useScrollToHash(ready) {
  const { hash } = useLocation()
  useEffect(() => {
    if (!ready || !hash) return
    const target = document.getElementById(decodeURIComponent(hash.slice(1)))
    if (target) target.scrollIntoView({ block: 'start' })
  }, [ready, hash])
}

export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-8">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-3">
          <div className="h-6 w-1/2 rounded-lg bg-leaf-100" />
          <div className="h-4 w-full rounded-lg bg-leaf-50" />
          <div className="h-4 w-11/12 rounded-lg bg-leaf-50" />
          <div className="h-4 w-4/5 rounded-lg bg-leaf-50" />
        </div>
      ))}
    </div>
  )
}

export function PageError({ slug, onRetry }) {
  return (
    <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-800">
      <p className="flex items-start gap-2.5 font-medium">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
        We could not load this page just now.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-semibold text-ink shadow-card">
          <RotateCw size={15} /> Try again
        </button>
        <a href={infoPageHtmlUrl(slug)} className="inline-flex items-center rounded-full px-4 py-2 font-semibold text-red-800 underline">
          Open the plain version
        </a>
      </div>
    </div>
  )
}

/** Privacy Policy / Terms & Conditions page: hero, contents, sections, legal navigation. */
export default function LegalDocument({ slug, fallbackTitle }) {
  const { status, data: page, retry } = useInfoPage(slug)
  const location = useLocation()
  useScrollToHash(status === 'ready' && Boolean(page))
  const title = page?.title || fallbackTitle

  return (
    <>
      <section className="border-b border-leaf-100 bg-leaf-50/60 py-14 sm:py-20">
        <Container>
          <span className="text-sm font-semibold text-leaf-600">Legal</span>
          <h1 className="mt-3 max-w-2xl text-balance font-display text-3xl font-semibold text-ink sm:text-4xl">{title}</h1>
          {page && <PageMeta page={page} />}
        </Container>
      </section>

      <section className="bg-white py-12 sm:py-16">
        <Container className="grid grid-cols-1 gap-10 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-14">
          <aside className="lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:self-start lg:overflow-y-auto">
            {page && page.sections.length > 3 && (
              <nav aria-label="On this page" className="mb-8 hidden lg:block">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-light/50">On this page</p>
                <ol className="space-y-1.5 text-sm">
                  {page.sections.map((section) => (
                    <li key={section.id}>
                      <a href={`#${section.id}`} className="block rounded-lg px-2 py-1 text-ink-light/75 hover:bg-leaf-50 hover:text-ink">
                        {section.heading}
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <nav aria-label="Legal pages">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-light/50">Legal documents</p>
              <ul className="space-y-1">
                {legalNav.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className={`block rounded-xl px-3 py-2 text-sm transition-colors ${
                        location.pathname === item.to ? 'bg-leaf-100 font-medium text-leaf-800' : 'text-ink-light/70 hover:bg-leaf-50 hover:text-ink'
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          <article className="prose-legal min-w-0 max-w-3xl break-words">
            {status === 'loading' && <PageSkeleton />}
            {status === 'error' && <PageError slug={slug} onRetry={retry} />}
            {status === 'ready' && page && (
              <>
                {page.sections.length > 3 && (
                  <details className="mb-8 rounded-2xl bg-leaf-50 p-4 lg:hidden">
                    <summary className="cursor-pointer text-sm font-semibold text-ink">Contents</summary>
                    <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
                      {page.sections.map((section) => (
                        <li key={section.id}>
                          <a href={`#${section.id}`}>{section.heading}</a>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                <PageSections page={page} />
              </>
            )}
            {status === 'ready' && !page && <p>This page has not been published yet.</p>}
          </article>
        </Container>
      </section>
    </>
  )
}

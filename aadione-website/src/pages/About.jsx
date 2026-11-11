import { Link } from 'react-router-dom'
import { ArrowRight, Handshake, MapPin, ShoppingBag, Smartphone, Store, Truck } from 'lucide-react'
import Container from '../components/Container'
import SectionHeading from '../components/SectionHeading'
import DownloadSection from '../components/DownloadSection'
import { LiveCategories } from '../components/LiveCatalogue'
import useSEO from '../lib/useSEO'
import { PageError, PageMeta, PageSections, PageSkeleton } from '../components/InfoPageDocument'
import { useBusinessInfo, useInfoPage } from '../lib/publicApi'

// When an "About Aadione" page is published in Admin Panel → Information
// Pages, THAT text is shown here — the same text as the app's About screen.
// Until then this page describes only what the app verifiably does today; the
// operator's details come from Admin Configuration (GET /legal/business).

const PILLARS = [
  { Icon: Store, title: 'A marketplace for local sellers', description: 'Grocery stores, fresh produce sellers, restaurants and cafés from your area list their products in one app. Each seller prepares its own part of your order.' },
  { Icon: ShoppingBag, title: 'Everyday shopping in one place', description: 'Groceries, fruits and vegetables, and meals from local restaurants today — and more kinds of local shop as sellers join.' },
  { Icon: Smartphone, title: 'Convenient by design', description: 'Browse, add to cart and order from your phone. Every charge is shown before you pay, and you can follow your order’s status in the app.' },
  { Icon: Truck, title: 'Doorstep delivery in approved areas', description: 'Aadione delivers to approved villages and PIN codes and checks your address before you order.' },
]

function Fallback() {
  const { data: business } = useBusinessInfo()
  return (
    <>
      <section className="bg-white py-14 sm:py-20">
        <Container className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-5 text-base leading-relaxed text-ink-light/85 sm:text-lg">
            <p>
              <strong className="text-ink">Aadione</strong> is a local shopping app. It brings the shops and restaurants of your own area
              into one place, so you can order groceries, fresh fruits and vegetables and food from your phone and have them delivered
              to your doorstep.
            </p>
            <p>
              Instead of a warehouse, Aadione works with local sellers. When you order, each seller prepares its own items and Aadione
              delivers them to your address in its approved delivery areas.
            </p>
          </div>
          {business?.legalName && (
            <dl className="h-fit rounded-3xl border border-leaf-100 bg-leaf-50/50 p-6 text-sm">
              <dt className="text-xs font-bold uppercase tracking-wider text-leaf-700">Who runs Aadione</dt>
              <dd className="mt-2 text-ink">
                {business.tradeName || 'Aadione'} is operated by <strong>{business.legalName}</strong>
                {business.businessType ? ` (${business.businessType})` : ''}.
              </dd>
              {business.address && (
                <>
                  <dt className="mt-4 text-xs font-bold uppercase tracking-wider text-leaf-700">Address</dt>
                  <dd className="mt-2 text-ink">{business.address}</dd>
                </>
              )}
              <dd className="mt-5">
                <Link to="/contact" className="inline-flex items-center gap-1.5 font-semibold text-leaf-700 hover:text-leaf-800">
                  Contact us <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </dd>
            </dl>
          )}
        </Container>
      </section>

      <section className="bg-leaf-50/60 py-14 sm:py-20">
        <Container>
          <SectionHeading eyebrow="What we do" title="Local shopping, made simple." />
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PILLARS.map(({ Icon, title, description }) => (
              <div key={title} className="rounded-3xl border border-leaf-100 bg-white p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-display text-lg font-bold text-ink">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-light/75">{description}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-white py-14 sm:py-20">
        <Container>
          <SectionHeading eyebrow="Categories" title="What you can order today." />
          <div className="mt-10">
            <LiveCategories />
          </div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold">
            <Link to="/delivery-areas" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
              <MapPin size={16} aria-hidden="true" /> See where we deliver
            </Link>
            <Link to="/how-it-works" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
              <Handshake size={16} aria-hidden="true" /> How ordering works
            </Link>
          </div>
        </Container>
      </section>
    </>
  )
}

export default function About() {
  useSEO({
    title: 'About Aadione',
    description:
      'Aadione is a local shopping app that brings the shops and restaurants of your area into one place, with doorstep delivery in approved villages.',
    path: '/about',
  })
  const { status, data: page, retry } = useInfoPage('about')

  return (
    <>
      <section className="border-b border-leaf-100 bg-gradient-to-b from-leaf-50 to-white py-14 sm:py-20">
        <Container>
          <span className="text-sm font-semibold text-leaf-600">About</span>
          <h1 className="mt-3 max-w-2xl text-balance font-display text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">
            {page?.title || 'About Aadione'}
          </h1>
          {page && <PageMeta page={page} />}
        </Container>
      </section>

      {status === 'loading' && (
        <section className="bg-white py-12">
          <Container>
            <article className="prose-legal mx-auto max-w-3xl">
              <PageSkeleton />
            </article>
          </Container>
        </section>
      )}
      {status === 'error' && (
        <section className="bg-white py-12">
          <Container>
            <article className="prose-legal mx-auto max-w-3xl">
              <PageError slug="about" onRetry={retry} />
            </article>
          </Container>
        </section>
      )}
      {status === 'ready' && page && (
        <section className="bg-white py-12 sm:py-16">
          <Container>
            <article className="prose-legal mx-auto min-w-0 max-w-3xl break-words">
              <PageSections page={page} />
            </article>
          </Container>
        </section>
      )}
      {status === 'ready' && !page && <Fallback />}

      <DownloadSection />
    </>
  )
}

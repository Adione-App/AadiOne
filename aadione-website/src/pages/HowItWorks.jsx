import {
  Download,
  LogIn,
  Search,
  ShoppingCart,
  ClipboardCheck,
  PackageCheck,
  Wallet,
  ShieldCheck,
  Ban,
} from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import AppStoreButtons from '../components/AppStoreButtons'
import useSEO from '../lib/useSEO'
import { serviceInfo, site } from '../config/site'

const detailedSteps = [
  {
    Icon: Download,
    title: `Download ${site.name}`,
    description: `Install the ${site.name} mobile application from the Play Store or App Store.`,
  },
  {
    Icon: LogIn,
    title: 'Sign in',
    description: 'Create or access your account using mobile OTP.',
  },
  {
    Icon: Search,
    title: 'Explore products',
    description: 'Browse different categories and available products.',
  },
  {
    Icon: ShoppingCart,
    title: 'Add to cart',
    description: 'Select the products you need.',
  },
  {
    Icon: ClipboardCheck,
    title: 'Place your order',
    description: 'Review your order and complete checkout.',
  },
  {
    Icon: PackageCheck,
    title: 'Get your order',
    description: 'Receive your order within the supported delivery area.',
  },
]

const rules = [
  {
    Icon: Wallet,
    title: 'Free delivery',
    description: `Orders of ${serviceInfo.currency}${serviceInfo.freeDeliveryThreshold} or more qualify for free delivery.`,
  },
  {
    Icon: Ban,
    title: 'Cancellations',
    description: serviceInfo.cancellationNote,
  },
  {
    Icon: ShieldCheck,
    title: 'Cash on Delivery',
    description: serviceInfo.codNote,
  },
]

export default function HowItWorks() {
  useSEO({
    title: 'How It Works',
    description: 'See how ordering on Aadione works, from downloading the app to getting your order delivered.',
    path: '/how-it-works',
  })

  return (
    <>
      <PageHero
        eyebrow="How it works"
        title="A simple, six-step process."
        description="Here's exactly what happens between opening the app and your order arriving."
      />

      <section className="bg-white py-20 sm:py-28">
        <Container>
          <div className="grid grid-cols-1 gap-x-10 gap-y-14 sm:grid-cols-2">
            {detailedSteps.map((step, i) => (
              <div key={step.title} className="flex gap-5">
                <div className="flex flex-col items-center">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                    <step.Icon size={22} />
                  </div>
                  {i !== detailedSteps.length - 1 && (
                    <span className="mt-2 hidden h-full w-px flex-1 bg-leaf-100 sm:block" />
                  )}
                </div>
                <div className="pb-2">
                  <span className="text-sm font-semibold text-leaf-600">
                    Step {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="mt-1 font-display text-xl font-semibold text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-light/75">
                    {step.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-cream py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="Good to know"
            title="A few rules that keep things fair for everyone."
            align="center"
            className="mx-auto"
          />
          <div className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-6 sm:grid-cols-3">
            {rules.map((rule) => (
              <div
                key={rule.title}
                className="flex flex-col gap-4 rounded-3xl border border-leaf-100 bg-white p-7"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-50 text-leaf-700">
                  <rule.Icon size={22} />
                </div>
                <h3 className="font-display text-lg font-semibold text-ink">{rule.title}</h3>
                <p className="text-sm leading-relaxed text-ink-light/75">{rule.description}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="bg-leaf-900 py-16 sm:py-20">
        <Container className="flex flex-col items-center gap-6 text-center">
          <h2 className="max-w-lg text-balance font-display text-2xl font-semibold text-white sm:text-3xl">
            Ready to get started?
          </h2>
          <AppStoreButtons />
        </Container>
      </section>
    </>
  )
}

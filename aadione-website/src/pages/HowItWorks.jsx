import { Wallet, ShieldCheck, Ban } from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import DownloadSection from '../components/DownloadSection'
import HowSteps from '../components/HowSteps'
import useSEO from '../lib/useSEO'
import { serviceInfo } from '../config/site'

const rules = [
  {
    Icon: Wallet,
    title: 'Delivery charges',
    description: serviceInfo.deliveryChargeNote,
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
        title="From your phone to your doorstep."
        description="Here's exactly what happens between opening the app and your order arriving."
      />

      <section className="bg-white py-16 sm:py-24">
        <Container>
          <HowSteps />
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

      <DownloadSection />
    </>
  )
}

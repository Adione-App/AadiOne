import { LayoutGrid, MapPin, ShieldCheck, Sparkles } from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import FeatureRow from '../components/FeatureRow'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'
import { site, serviceInfo } from '../config/site'

const values = [
  {
    Icon: LayoutGrid,
    title: 'Multi-category shopping',
    description:
      'From groceries and fresh produce to everyday essentials, Aadione brings multiple categories together in a single app.',
  },
  {
    Icon: MapPin,
    title: 'Local, focused delivery',
    description: `${site.name} is initially focused on serving customers within a limited local delivery area, up to ${serviceInfo.deliveryRadiusKm} km from the store.`,
  },
  {
    Icon: Sparkles,
    title: 'Built for convenience',
    description:
      'A clean, straightforward ordering experience designed to make everyday shopping simpler.',
  },
  {
    Icon: ShieldCheck,
    title: 'Simple, secure sign-in',
    description: 'Access your account quickly and securely using mobile OTP authentication.',
  },
]

export default function About() {
  useSEO({
    title: 'About',
    description:
      'Aadione is a local multi-category shopping and delivery platform designed to make everyday shopping more convenient.',
    path: '/about',
  })

  return (
    <>
      <PageHero
        eyebrow={`About ${site.name}`}
        title="Everyday shopping, made convenient."
        description={`${site.name} is a local multi-category shopping and delivery platform designed to make everyday shopping more convenient.`}
      />

      <section className="bg-white py-20 sm:py-28">
        <Container className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div className="relative mx-auto w-full max-w-xs lg:max-w-sm">
            <div
              aria-hidden="true"
              className="absolute inset-x-6 -bottom-6 top-10 rounded-blob bg-leaf-100 blur-2xl"
            />
            <img
              src="/assets/app-screenshot-track.svg"
              alt="Aadione app screen"
              className="relative w-full drop-shadow-2xl"
            />
          </div>

          <div>
            <SectionHeading
              eyebrow="What we do"
              title="Everything you need, without the extra stops."
              description={`Customers can explore groceries, fresh produce, daily essentials and other useful products through the ${site.name} mobile application — browsing, ordering and getting everyday items delivered without needing to visit multiple stores.`}
            />
            <p className="mt-6 max-w-lg text-sm leading-relaxed text-ink-light/75">
              {site.name} is initially focused on serving customers within a limited local
              delivery area, with the goal of making everyday shopping simple, reliable and
              convenient for the community it serves.
            </p>
            <Button to="/how-it-works" variant="primary" className="mt-8">
              See how ordering works
            </Button>
          </div>
        </Container>
      </section>

      <section className="bg-cream py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="What Aadione stands for"
            title="A few simple ideas guide how we build the experience."
            align="center"
            className="mx-auto"
          />
          <div className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-x-10 sm:grid-cols-2">
            {values.map((value) => (
              <FeatureRow key={value.title} {...value} />
            ))}
          </div>
        </Container>
      </section>
    </>
  )
}

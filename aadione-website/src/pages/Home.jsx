import {
  MapPin,
  Wallet,
  Truck,
  ShieldCheck,
  Search,
  PackageCheck,
  LayoutGrid,
  MousePointerClick,
  Sparkles,
  ArrowRight,
} from 'lucide-react'
import Container from '../components/Container'
import Button from '../components/Button'
import AppStoreButtons from '../components/AppStoreButtons'
import SectionHeading from '../components/SectionHeading'
import StepCard from '../components/StepCard'
import FeatureRow from '../components/FeatureRow'
import FAQItem from '../components/FAQItem'
import Stat from '../components/Stat'
import CategoryCard from '../components/CategoryCard'
import useSEO from '../lib/useSEO'
import { serviceInfo, categories, site } from '../config/site'

const steps = [
  {
    Icon: Search,
    title: 'Explore products',
    description: 'Open Aadione and browse groceries, fresh produce and everyday essentials by category.',
  },
  {
    Icon: PackageCheck,
    title: 'Add to cart',
    description: `Build your order and check out. Orders of ${serviceInfo.currency}${serviceInfo.freeDeliveryThreshold} or more get free delivery.`,
  },
  {
    Icon: ShieldCheck,
    title: 'Store accepts your order',
    description: 'Your order is reviewed and prepared as soon as it is accepted.',
  },
  {
    Icon: Truck,
    title: 'Delivered to your door',
    description: `Your order is delivered within the supported service area, up to ${serviceInfo.deliveryRadiusKm} km.`,
  },
]

const whyCards = [
  {
    Icon: Sparkles,
    title: 'Everyday Essentials',
    description: 'Shop products you need for everyday life.',
  },
  {
    Icon: LayoutGrid,
    title: 'Multiple Categories',
    description: 'Explore groceries, fresh produce, household items, clothing, electronics and more.',
  },
  {
    Icon: MousePointerClick,
    title: 'Easy Ordering',
    description: 'Browse products, add them to your cart and place your order easily.',
  },
  {
    Icon: Truck,
    title: 'Convenient Local Delivery',
    description: 'Get your order delivered within the supported Aadione service area.',
  },
]

const faqPreview = [
  {
    question: 'What can I buy on Aadione?',
    answer:
      'Customers can explore available groceries, fruits and vegetables, household essentials, personal care products, clothing, electronics and other everyday products depending on current availability.',
  },
  {
    question: 'Is delivery free?',
    answer: `Orders of ${serviceInfo.currency}${serviceInfo.freeDeliveryThreshold} or more qualify for free delivery.`,
  },
  {
    question: 'How long does delivery take?',
    answer: serviceInfo.deliveryTimingNote,
  },
  {
    question: 'Can I cancel my order after placing it?',
    answer: serviceInfo.cancellationNote,
  },
]

export default function Home() {
  useSEO({
    title: undefined,
    description: site.description,
    path: '/',
  })

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-leaf-900 pb-24 pt-16 sm:pb-32 sm:pt-20">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-32 top-10 h-96 w-96 rounded-blob bg-leaf-700/50 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 bottom-0 h-72 w-72 rounded-blob bg-mango/25 blur-3xl"
        />

        <Container className="relative grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-10">
          <div className="animate-riseIn">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm font-medium text-leaf-100">
              Local quick-commerce, everyday made simple
            </span>
            <h1 className="mt-6 max-w-xl text-balance font-display text-4xl font-semibold leading-[1.1] text-white sm:text-5xl lg:text-[3.4rem]">
              {site.tagline}
            </h1>
            <p className="mt-6 max-w-lg text-balance text-base leading-relaxed text-cream-100/80 sm:text-lg">
              Shop groceries, fresh produce, daily essentials and more — all from {site.name}.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <AppStoreButtons size="lg" />
            </div>

            <div className="mt-6">
              <Button to="/categories" variant="inverse" icon={ArrowRight}>
                Explore Categories
              </Button>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-cream-100/70">
              <span className="flex items-center gap-2">
                <MapPin size={16} className="text-leaf-300" />
                Serving up to {serviceInfo.deliveryRadiusKm} km locally
              </span>
              <span className="flex items-center gap-2">
                <Wallet size={16} className="text-leaf-300" />
                Free delivery over {serviceInfo.currency}
                {serviceInfo.freeDeliveryThreshold}
              </span>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-xs animate-riseIn [animation-delay:150ms] lg:max-w-sm">
            <div
              aria-hidden="true"
              className="absolute inset-x-6 -bottom-6 top-10 rounded-blob bg-leaf-500/30 blur-2xl"
            />
            <img
              src="/assets/app-screenshot-hero.svg"
              alt="Aadione app screen showing shopping categories"
              className="relative w-full animate-floaty drop-shadow-2xl"
            />
          </div>
        </Container>
      </section>

      {/* Trust / quick facts */}
      <section className="bg-white py-16 sm:py-20">
        <Container>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            <Stat value={`${serviceInfo.deliveryRadiusKm} km`} label="Local delivery radius" />
            <Stat value={`${categories.length - 1}+`} label="Everyday product categories" />
            <Stat value="Free" label={`Delivery above ${serviceInfo.currency}${serviceInfo.freeDeliveryThreshold}`} />
            <Stat value="OTP" label="Simple mobile sign-in" />
          </div>
        </Container>
      </section>

      {/* Shop by category */}
      <section className="bg-cream py-20 sm:py-28">
        <Container>
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
            <SectionHeading
              eyebrow="Shop by category"
              title="Everything you need, in one app."
              description="Explore a growing range of everyday products, from fresh groceries to electronics."
            />
            <Button to="/categories" variant="secondary" icon={ArrowRight}>
              View all categories
            </Button>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {categories.slice(0, 8).map((cat) => (
              <CategoryCard key={cat.id} name={cat.name} description={cat.description} />
            ))}
          </div>
        </Container>
      </section>

      {/* Why Aadione */}
      <section className="bg-white py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="Why Aadione"
            title="Everything you need in one place."
            align="center"
            className="mx-auto"
          />
          <div className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-x-10 sm:grid-cols-2">
            {whyCards.map((card) => (
              <FeatureRow key={card.title} {...card} />
            ))}
          </div>
        </Container>
      </section>

      {/* Service area / V1 details */}
      <section className="bg-cream py-20 sm:py-28">
        <Container className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div>
            <SectionHeading
              eyebrow="Serving your local community"
              title="Focused on your neighbourhood, done well."
              description={`${site.name} currently provides delivery within a service radius of up to ${serviceInfo.deliveryRadiusKm} km from the store. Availability depends on your delivery location and the current service area.`}
            />

            <div className="mt-8 space-y-1">
              <FeatureRow
                Icon={MapPin}
                title={`Delivery within ${serviceInfo.deliveryRadiusKm} km`}
                description="Availability depends on your delivery location and the current service area."
              />
              <FeatureRow
                Icon={Wallet}
                title={`Free delivery on orders of ${serviceInfo.currency}${serviceInfo.freeDeliveryThreshold}+`}
                description="Orders below this amount may carry a delivery charge shown at checkout."
                tone="mango"
              />
              <FeatureRow
                Icon={ShieldCheck}
                title="Straightforward cancellations"
                description={serviceInfo.cancellationNote}
              />
              <FeatureRow
                Icon={Truck}
                title="Cash on Delivery, where eligible"
                description={serviceInfo.codNote}
              />
            </div>
          </div>

          <div className="relative mx-auto flex aspect-square w-full max-w-md items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-leaf-100" />
            <div className="absolute inset-8 rounded-full border border-leaf-200" />
            <div className="absolute inset-16 rounded-full border border-dashed border-leaf-300" />
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-leaf-700 text-white shadow-soft">
              <MapPin size={30} />
            </div>
            <span className="absolute bottom-6 right-8 rounded-full bg-white px-3 py-1 text-xs font-semibold text-leaf-700 shadow-card">
              {serviceInfo.deliveryRadiusKm} km radius
            </span>
          </div>
        </Container>
      </section>

      {/* How it works preview */}
      <section className="bg-white py-20 sm:py-28">
        <Container>
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
            <SectionHeading
              eyebrow="How it works"
              title="From browsing to your door, in four simple steps."
              description="See the full six-step process on our How It Works page."
            />
            <Button to="/how-it-works" variant="secondary" icon={ArrowRight}>
              See full process
            </Button>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <StepCard
                key={step.title}
                number={String(i + 1).padStart(2, '0')}
                Icon={step.Icon}
                title={step.title}
                description={step.description}
              />
            ))}
          </div>
        </Container>
      </section>

      {/* FAQ preview */}
      <section className="bg-cream py-20 sm:py-28">
        <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <SectionHeading
            eyebrow="Good to know"
            title="Quick answers before you download."
            description="A few things worth knowing about how Aadione works today. See the full FAQ for everything else."
          />
          <div>
            {faqPreview.map((item) => (
              <FAQItem key={item.question} question={item.question} answer={item.answer} />
            ))}
            <Button to="/faq" variant="ghost" icon={ArrowRight} className="mt-5 px-0">
              View all FAQs
            </Button>
          </div>
        </Container>
      </section>

      {/* Final CTA */}
      <section className="bg-leaf-900 py-20 sm:py-24">
        <Container className="flex flex-col items-center gap-8 text-center">
          <h2 className="max-w-xl text-balance font-display text-3xl font-semibold text-white sm:text-4xl">
            Get Aadione on Your Phone
          </h2>
          <p className="max-w-md text-balance text-cream-100/75">
            Make everyday shopping simpler with {site.name}.
          </p>
          <AppStoreButtons size="lg" />
        </Container>
      </section>
    </>
  )
}

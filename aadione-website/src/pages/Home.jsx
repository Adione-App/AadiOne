import { Link } from 'react-router-dom'
import { ArrowRight, BadgeCheck, Headset, MapPin, PackageSearch, ReceiptText, ShieldCheck, Store } from 'lucide-react'
import Container from '../components/Container'
import SectionHeading from '../components/SectionHeading'
import AppStoreButtons from '../components/AppStoreButtons'
import DownloadSection from '../components/DownloadSection'
import HowSteps from '../components/HowSteps'
import DeliveryAreas from '../components/DeliveryAreas'
import SupportDetails from '../components/SupportDetails'
import { LiveCategories, LiveRestaurants, MarketplaceKinds } from '../components/LiveCatalogue'
import useSEO from '../lib/useSEO'

// Every claim on this page is something the app does today. What is for sale,
// which restaurants are listed and where Aadione delivers are read live from
// the API — nothing here is a number typed into the website.
const WHY = [
  { Icon: Store, title: 'Your local shops in one app', description: 'Grocery stores, fresh produce sellers, restaurants and cafés from your own area.' },
  { Icon: ReceiptText, title: 'Every charge before you pay', description: 'Item prices, any delivery charge and the total are shown in your cart before you order.' },
  { Icon: MapPin, title: 'Clear delivery areas', description: 'Aadione delivers to approved villages and PIN codes, and checks your address before you order.' },
  { Icon: PackageSearch, title: 'Track every order', description: 'Follow your order’s status in the app from the moment you place it.' },
  { Icon: ShieldCheck, title: 'Simple, secure sign-in', description: 'Sign in with your mobile number and a one-time code — no password to remember.' },
  { Icon: Headset, title: 'Real support', description: 'Reach the Aadione team by email or phone, and a Grievance Officer for complaints.' },
]

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:max-w-none" aria-hidden="true">
      <div className="absolute -inset-6 rounded-[3rem] bg-gradient-to-br from-leaf-200/60 via-leaf-100/40 to-transparent blur-2xl" />
      <div className="relative grid grid-cols-2 gap-4">
        <div className="col-span-2 overflow-hidden rounded-[2rem] shadow-soft">
          <img src="/images/restaurants.webp" alt="" width="1200" height="452" className="w-full" fetchpriority="high" decoding="async" />
        </div>
        <div className="overflow-hidden rounded-[2rem] shadow-soft">
          <img src="/images/fruits-vegetables.webp" alt="" width="720" height="720" className="w-full" decoding="async" />
        </div>
        <div className="flex flex-col items-center justify-center gap-4 rounded-[2rem] bg-white p-6 shadow-soft">
          <img src="/images/app-icon-320.webp" alt="" width="320" height="320" className="h-24 w-24 rounded-[1.6rem] shadow-card motion-safe:animate-floaty sm:h-28 sm:w-28" decoding="async" />
          <span className="text-center text-sm font-bold text-ink">The Aadione app</span>
          <span className="-mt-3 text-center text-xs text-ink-light/60">Android &amp; iPhone</span>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  useSEO({
    description:
      'Aadione is a local shopping app: order groceries, fresh fruits and vegetables and food from local restaurants, delivered to your doorstep in approved villages. Download on Google Play and the App Store.',
    path: '/',
  })

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-leaf-50 via-white to-white pb-10 pt-10 sm:pb-14 sm:pt-16">
        <div aria-hidden="true" className="pointer-events-none absolute -right-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-leaf-100/70 blur-3xl" />
        <Container className="relative grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div className="motion-safe:animate-riseIn">
            <span className="inline-flex items-center gap-2 rounded-full border border-leaf-200 bg-white px-4 py-1.5 text-sm font-semibold text-leaf-800 shadow-sm">
              <BadgeCheck size={16} className="text-leaf-600" aria-hidden="true" /> Local shopping, delivered to your door
            </span>
            <h1 className="mt-6 max-w-xl text-balance font-display text-[2.6rem] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              Everything You Need, <span className="text-leaf-700">Delivered.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-light/80">
              Groceries, fresh fruits and vegetables, and food from local restaurants — from the shops in your own area, ordered in
              one app and delivered to your doorstep.
            </p>
            <AppStoreButtons size="lg" className="mt-8" />
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm font-semibold">
              <Link to="/categories" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
                Explore categories <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link to="/delivery-areas" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
                Check delivery areas <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className="motion-safe:animate-riseIn [animation-delay:120ms]">
            <HeroVisual />
          </div>
        </Container>
      </section>

      {/* 1–2. Everyday essentials: the live categories */}
      <section id="shop" className="scroll-mt-24 bg-white py-16 sm:py-24">
        <Container>
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
            <SectionHeading
              eyebrow="Shop everyday essentials"
              title="Groceries, fruits & vegetables — in the app now."
              description="These are the categories you can order from today, with everything inside them. New categories appear here as local sellers add them."
            />
            <Link to="/categories" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-leaf-700 hover:text-leaf-800">
              All categories <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-10">
            <LiveCategories />
          </div>
        </Container>
      </section>

      {/* 3. Food from local restaurants */}
      <section className="bg-leaf-50/60 py-16 sm:py-24">
        <Container className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionHeading
            eyebrow="Food from local restaurants"
            title="Order from restaurants and cafés near you."
            description="The Food section of the app lists local restaurants and cafés with their menus, and shows whether each one is open right now."
          />
          <LiveRestaurants cards />
        </Container>
      </section>

      {/* 4–6. Electronics, clothing and more — marked from the live catalogue */}
      <section className="bg-white py-16 sm:py-24">
        <Container>
          <SectionHeading
            eyebrow="Electronics, fashion and more"
            title="Built for every kind of local shop."
            description="Aadione is a marketplace for local sellers of all kinds. A category is marked “In the app now” only when you can order from it today."
          />
          <div className="mt-10">
            <MarketplaceKinds only={['clothing-fashion', 'electronics-accessories', 'beauty-wellness', 'home-kitchen']} columns={4} />
          </div>
        </Container>
      </section>

      {/* 7. How it works */}
      <section className="bg-leaf-50/60 py-16 sm:py-24">
        <Container>
          <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
            <SectionHeading eyebrow="How Aadione works" title="From your phone to your doorstep." />
            <Link to="/how-it-works" className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-leaf-700 hover:text-leaf-800">
              More about ordering <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <div className="mt-10">
            <HowSteps />
          </div>
        </Container>
      </section>

      {/* 8. Delivery availability */}
      <section id="delivery" className="scroll-mt-24 bg-white py-16 sm:py-24">
        <Container className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <SectionHeading
            eyebrow="Delivery availability"
            title="Do we deliver to you?"
            description="Aadione delivers to approved villages, each with its own PIN code. This is the same list the app uses — when you add your address, the app confirms it before you order."
          />
          <DeliveryAreas />
        </Container>
      </section>

      {/* 9. Why Aadione */}
      <section className="bg-leaf-50/60 py-16 sm:py-24">
        <Container>
          <SectionHeading eyebrow="Why choose Aadione?" title="Simple, local and clear." align="center" className="mx-auto" />
          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WHY.map(({ Icon, title, description }) => (
              <div key={title} className="rounded-3xl border border-leaf-100 bg-white p-6 transition-shadow hover:shadow-card">
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

      {/* 10. Download */}
      <DownloadSection />

      {/* 11. Customer support */}
      <section className="bg-white py-16 sm:py-24">
        <Container className="grid grid-cols-1 items-start gap-10 lg:grid-cols-2">
          <div>
            <SectionHeading
              eyebrow="Customer support"
              title="We’re here to help."
              description="Questions about an order, a payment or your account? Contact the Aadione team. For a complaint, you can also write to our Grievance Officer."
            />
            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold">
              <Link to="/contact" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
                Contact &amp; complaints <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link to="/faq" className="inline-flex items-center gap-1.5 text-leaf-700 hover:text-leaf-800">
                Frequently asked questions <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
          <SupportDetails />
        </Container>
      </section>
    </>
  )
}


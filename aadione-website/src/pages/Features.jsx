import {
  KeyRound,
  LayoutGrid,
  Carrot,
  PackageCheck,
  ShoppingCart,
  CreditCard,
  MapPinned,
  Truck,
  ShieldCheck,
} from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import FeatureRow from '../components/FeatureRow'
import DownloadSection from '../components/DownloadSection'
import useSEO from '../lib/useSEO'
import { serviceInfo, site } from '../config/site'

const groupOne = [
  {
    Icon: KeyRound,
    title: 'Mobile OTP Authentication',
    description: 'Sign in securely using a one-time password sent to your mobile number.',
  },
  {
    Icon: LayoutGrid,
    title: 'Multiple Product Categories',
    description: 'Groceries, essentials and more, organised into easy-to-browse categories.',
  },
  {
    Icon: Carrot,
    title: 'Grocery & Fresh Produce',
    description: 'Order everyday groceries along with fresh fruits and vegetables.',
  },
  {
    Icon: PackageCheck,
    title: 'Everyday Essentials',
    description: 'From household items to personal care, find the everyday things you need.',
  },
]

const groupTwo = [
  {
    Icon: ShoppingCart,
    title: 'Easy Mobile Ordering',
    description: 'Browse products, add them to your cart and place your order easily.',
  },
  {
    Icon: CreditCard,
    title: 'Cart & Checkout',
    description: 'Review your order and complete checkout, with Cash on Delivery where eligible.',
  },
  {
    Icon: MapPinned,
    title: 'Order Status',
    description: 'Keep track of your order status from acceptance through to delivery.',
  },
  {
    Icon: Truck,
    title: 'Local Delivery',
    description: serviceInfo.areaNote,
  },
]

export default function Features() {
  useSEO({
    title: 'Features',
    description:
      'Explore what the Aadione app offers — from mobile OTP sign-in to multi-category shopping and local delivery.',
    path: '/features',
  })

  return (
    <>
      <PageHero
        eyebrow="Features"
        title="Everything you need for everyday shopping."
        description={`${site.name} focuses on getting the essentials right — a broad range of categories, clarity, and a straightforward ordering experience.`}
      />

      <section className="bg-white py-20 sm:py-28">
        <Container className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <SectionHeading eyebrow="Ordering" title="Made for quick, confident decisions." />
            <div className="mt-4">
              {groupOne.map((f) => (
                <FeatureRow key={f.title} {...f} />
              ))}
            </div>
          </div>
          <div className="relative order-1 mx-auto w-full max-w-xs lg:order-2 lg:max-w-sm">
            <div
              aria-hidden="true"
              className="absolute inset-x-6 -bottom-6 top-10 rounded-blob bg-leaf-100 blur-2xl"
            />
            {/* Genuine category artwork from the app — not a mock-up of an app screen. */}
            <img
              src="/images/fruits-vegetables.webp"
              alt="Fresh fruits and vegetables on Aadione"
              width="720"
              height="720"
              loading="lazy"
              decoding="async"
              className="relative w-full rounded-[2rem] shadow-soft"
            />
          </div>
        </Container>
      </section>

      <section className="bg-cream py-20 sm:py-28">
        <Container className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div className="relative mx-auto w-full max-w-xs lg:max-w-sm">
            <div
              aria-hidden="true"
              className="absolute inset-x-6 -bottom-6 top-10 rounded-blob bg-mango-light/60 blur-2xl"
            />
            <div className="relative flex flex-col items-center gap-4 rounded-[2rem] bg-white p-10 text-center shadow-soft">
              <img src="/images/app-icon-320.webp" alt="" width="320" height="320" loading="lazy" className="h-32 w-32 rounded-[1.75rem] shadow-card" />
              <span className="font-display text-lg font-bold text-ink">Follow every order in the app</span>
              <span className="-mt-2 text-sm text-ink-light/70">Android &amp; iPhone</span>
            </div>
          </div>
          <div>
            <SectionHeading eyebrow="Ordering & delivery" title="Simple, secure, and easy to track." />
            <div className="mt-4">
              {groupTwo.map((f) => (
                <FeatureRow key={f.title} tone="mango" {...f} />
              ))}
            </div>
            <div className="mt-6">
              <FeatureRow
                Icon={ShieldCheck}
                title="Secure Account"
                description="Your account is protected with mobile OTP sign-in and secure data handling."
              />
            </div>
          </div>
        </Container>
      </section>

      <DownloadSection />
    </>
  )
}

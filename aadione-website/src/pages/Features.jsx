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
import AppStoreButtons from '../components/AppStoreButtons'
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
    description: `Get your order delivered within the supported service area, up to ${serviceInfo.deliveryRadiusKm} km.`,
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
            <img
              src="/assets/app-screenshot-hero.svg"
              alt="Aadione app catalog screen"
              className="relative w-full drop-shadow-2xl"
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
            <img
              src="/assets/app-screenshot-track.svg"
              alt="Aadione order status screen"
              className="relative w-full drop-shadow-2xl"
            />
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

      <section className="bg-leaf-900 py-16 sm:py-20">
        <Container className="flex flex-col items-center gap-6 text-center">
          <h2 className="max-w-lg text-balance font-display text-2xl font-semibold text-white sm:text-3xl">
            See these features in action.
          </h2>
          <AppStoreButtons />
        </Container>
      </section>
    </>
  )
}

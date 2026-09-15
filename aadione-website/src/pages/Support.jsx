import {
  PackageSearch,
  PackageX,
  PackageOpen,
  RotateCcw,
  UserCog,
  KeyRound,
  Truck,
  ShieldCheck,
  UserX,
} from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SectionHeading from '../components/SectionHeading'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'
import { contact, site } from '../config/site'

const TOPICS = [
  { Icon: PackageSearch, title: 'Order issues', description: 'Help with an order that hasn\u2019t gone as expected.' },
  { Icon: PackageX, title: 'Missing or wrong products', description: 'Something in your order was missing or incorrect.' },
  { Icon: PackageOpen, title: 'Damaged products', description: 'An item arrived damaged or unusable.' },
  { Icon: RotateCcw, title: 'Refund questions', description: 'Questions about a refund for an eligible order.' },
  { Icon: UserCog, title: 'Account problems', description: 'General account access or profile issues.' },
  { Icon: KeyRound, title: 'OTP / login issues', description: 'Trouble receiving or using a login OTP.' },
  { Icon: Truck, title: 'Delivery issues', description: 'Questions about your delivery or delivery address.' },
  { Icon: ShieldCheck, title: 'Privacy requests', description: 'Questions about how your data is used or stored.' },
  { Icon: UserX, title: 'Account deletion', description: `Request to delete your ${site.name} account.` },
]

export default function Support() {
  useSEO({
    title: 'Support',
    description: 'Get help with orders, refunds, account issues, delivery and privacy requests on Aadione.',
    path: '/support',
  })

  return (
    <>
      <PageHero
        eyebrow="Support"
        title="Support Center"
        description={`Find help with your order, account or anything else related to ${site.name}.`}
      />

      <section className="bg-white py-20 sm:py-28">
        <Container>
          <SectionHeading
            eyebrow="What can we help with?"
            title="Browse common support topics."
          />

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TOPICS.map(({ Icon, title, description }) => (
              <div key={title} className="rounded-3xl border border-leaf-100 bg-cream p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                  <Icon size={20} />
                </div>
                <h3 className="mt-4 font-display text-base font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-light/70">{description}</p>
              </div>
            ))}
          </div>

          <div className="mt-12 rounded-3xl bg-leaf-50 p-8 sm:p-10">
            <h3 className="font-display text-lg font-semibold text-ink">
              Still need help?
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-light/75">
              {contact.supportEmail
                ? `Reach our support team at ${contact.supportEmail}, or use the links below.`
                : 'Reach our support team using the links below.'}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button to="/faq" variant="secondary">FAQ</Button>
              <Button to="/contact" variant="secondary">Contact</Button>
              <Button to="/privacy-policy" variant="secondary">Privacy Policy</Button>
              <Button to="/delete-account" variant="secondary">Delete Account</Button>
            </div>
          </div>
        </Container>
      </section>
    </>
  )
}

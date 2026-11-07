import { ShieldAlert, Database, HelpCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import DeleteAccountForm from '../components/DeleteAccountForm'
import useSEO from '../lib/useSEO'
import { site } from '../config/site'

export default function DeleteAccount() {
  useSEO({
    title: 'Delete Your Account',
    description: `Submit a request to delete your ${site.name} account and associated personal data.`,
    path: '/delete-account',
  })

  return (
    <>
      <PageHero
        eyebrow="Account & Data Deletion"
        title={`Delete Your ${site.name} Account`}
        description="Submit a request to delete your Aadione account and associated personal data. This page is publicly accessible — verify your registered mobile number with an OTP to proceed, no app sign-in required."
      />

      <section className="bg-white py-20 sm:py-28">
        <Container className="grid grid-cols-1 gap-14 lg:grid-cols-[1.2fr_1fr]">
          <DeleteAccountForm />

          <div className="space-y-5">
            <div className="rounded-3xl border border-leaf-100 bg-cream p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                <Database size={20} aria-hidden="true" />
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-ink">
                What gets deleted
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-light/75">
                Your name, email address, saved addresses, notifications, notification
                registrations and active cart are deleted. Your mobile number is removed from the
                account, you are signed out on every device, and the account can no longer be used.
              </p>
            </div>

            <div className="rounded-3xl border border-leaf-100 bg-cream p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                <ShieldAlert size={20} aria-hidden="true" />
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-ink">
                What may be retained
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-light/75">
                Records of past orders, payments and refunds — including the delivery name, mobile
                number and address saved with each order — are kept because tax law and dispute
                resolution require them. They are not used to contact you or for marketing. Your
                wishlist and recent searches are only on your phone. See our{' '}
                <Link to="/privacy-policy" className="text-leaf-700 underline underline-offset-2 hover:text-leaf-800">
                  Privacy Policy
                </Link>
                .
              </p>
            </div>

            <div className="rounded-3xl border border-leaf-100 bg-cream p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                <HelpCircle size={20} aria-hidden="true" />
              </div>
              <h3 className="mt-4 font-display text-base font-semibold text-ink">
                Need help?
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-light/75">
                If you have questions before submitting a deletion request, visit our{' '}
                <Link to="/support" className="text-leaf-700 underline underline-offset-2 hover:text-leaf-800">
                  Support Center
                </Link>{' '}
                or{' '}
                <Link to="/contact" className="text-leaf-700 underline underline-offset-2 hover:text-leaf-800">
                  Contact Us
                </Link>
                .
              </p>
            </div>
          </div>
        </Container>
      </section>
    </>
  )
}

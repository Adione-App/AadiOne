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
                Once your request is verified, we delete your account profile, saved addresses,
                and other personal data associated with your {site.name} account.
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
                Some information, such as order and transaction records, may be retained for a
                period as required for legal, security, fraud-prevention or accounting purposes,
                even after your account is deleted.
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

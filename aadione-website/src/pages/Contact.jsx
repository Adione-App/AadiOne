import { Link } from 'react-router-dom'
import { Briefcase, Headset, Mail, PackageSearch, RotateCcw, Scale, ShieldCheck, UserCog } from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import SupportDetails from '../components/SupportDetails'
import useSEO from '../lib/useSEO'
import { useBusinessInfo } from '../lib/publicApi'
import { phoneHref } from '../lib/business'

// There is no message inbox behind this website, so there is no form that
// pretends to "send". Each topic opens an email to the configured support
// address with the topic as its subject — nothing is sent until the visitor
// presses Send in their own email app. Phone support is one tap away.
const TOPICS = [
  { Icon: PackageSearch, title: 'Order support', description: 'Help with an order you have placed.' },
  { Icon: RotateCcw, title: 'Payment or refund', description: 'A payment, refund or charge on your order.' },
  { Icon: UserCog, title: 'Account and sign-in', description: 'Login, OTP or account access issues.' },
  { Icon: ShieldCheck, title: 'Privacy and data', description: 'Questions about your data or a privacy request.' },
  { Icon: Headset, title: 'General question', description: 'Anything else about using Aadione.' },
  { Icon: Briefcase, title: 'Business enquiry', description: 'Selling on Aadione and other business queries.' },
]

export const topicMailto = (email, topic) => `mailto:${email}?subject=${encodeURIComponent(`${topic} — Aadione`)}`

export default function Contact() {
  useSEO({
    title: 'Contact & Support',
    description:
      'Contact Aadione customer support by email or phone, see support hours, and reach the Grievance Officer for complaints.',
    path: '/contact',
  })

  const { status, data: business } = useBusinessInfo()
  const email = business?.support?.email ?? null
  const grievance = business?.grievanceOfficer ?? {}

  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="We're happy to help."
        description="Reach our support team by email or phone. For a complaint that is not resolved, you can write to our Grievance Officer."
      />

      <section className="bg-white py-14 sm:py-20">
        <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <h2 className="font-display text-xl font-bold text-ink">Reach us directly</h2>
            <SupportDetails className="mt-4" />

            <div className="mt-10 rounded-3xl border border-leaf-100 bg-leaf-50/50 p-6">
              <h2 className="font-display text-lg font-bold text-ink">Raising a complaint</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-light/80">
                <li>Contact customer support first by email or phone. Include your registered mobile number and, for an order, its order number.</li>
                <li>Describe the problem and attach photos if it is about an item you received.</li>
                <li>If the problem is not resolved, write to the Grievance Officer below with the same details.</li>
              </ol>
              <p className="mt-3 text-xs text-ink-light/60">
                How complaints are handled is described in our{' '}
                <Link className="underline" to="/terms-and-conditions#complaints-and-grievance-redressal">
                  Terms &amp; Conditions
                </Link>
                .
              </p>
            </div>

            {grievance.name && (
              <div id="grievance-officer" className="mt-10 scroll-mt-24">
                <h2 className="flex items-center gap-2 font-display text-xl font-bold text-ink">
                  <Scale size={20} className="text-leaf-700" aria-hidden="true" /> Grievance Officer
                </h2>
                <dl className="mt-4 space-y-1.5 text-sm text-ink-light/80">
                  <div>
                    <dt className="sr-only">Name</dt>
                    <dd className="font-semibold text-ink">
                      {grievance.name}
                      {grievance.designation ? `, ${grievance.designation}` : ''}
                    </dd>
                  </div>
                  {grievance.email && (
                    <div>
                      <dt className="inline">Email: </dt>
                      <dd className="inline break-all">
                        <a className="text-leaf-700 underline" href={`mailto:${grievance.email}`}>
                          {grievance.email}
                        </a>
                      </dd>
                    </div>
                  )}
                  {grievance.phone && (
                    <div>
                      <dt className="inline">Phone: </dt>
                      <dd className="inline">
                        {phoneHref(grievance.phone) ? (
                          <a className="text-leaf-700 underline" href={phoneHref(grievance.phone)}>
                            {grievance.phone}
                          </a>
                        ) : (
                          grievance.phone
                        )}
                      </dd>
                    </div>
                  )}
                  {grievance.address && (
                    <div>
                      <dt className="inline">Address: </dt>
                      <dd className="inline">{grievance.address}</dd>
                    </div>
                  )}
                </dl>
              </div>
            )}
          </div>

          <div>
            <h2 className="font-display text-xl font-bold text-ink">Email us about…</h2>
            <p className="mt-1 text-sm text-ink-light/70">
              {email
                ? 'Each topic opens a new email to our support team in your email app, with the topic filled in. It is sent only when you press Send.'
                : status === 'loading'
                  ? 'Loading contact details…'
                  : 'Email support is not available right now — please call us or use the Help section of the Aadione app.'}
            </p>
            <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {TOPICS.map(({ Icon, title, description }) => {
                const body = (
                  <>
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-700 text-white">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-display text-sm font-bold text-ink">
                        {title} {email && <Mail size={13} className="text-leaf-600" aria-hidden="true" />}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-light/70">{description}</span>
                    </span>
                  </>
                )
                return (
                  <li key={title}>
                    {email ? (
                      <a href={topicMailto(email, title)} className="flex h-full items-start gap-3 rounded-2xl border border-leaf-100 bg-white p-4 transition-colors hover:border-leaf-300 hover:bg-leaf-50/40">
                        {body}
                      </a>
                    ) : (
                      <div className="flex h-full items-start gap-3 rounded-2xl border border-leaf-100 bg-white p-4 opacity-70">{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="mt-6 text-sm text-ink-light/70">
              Want to delete your account? Use the{' '}
              <Link to="/delete-account" className="font-semibold text-leaf-700 underline">
                Delete Account
              </Link>{' '}
              page.
            </p>
          </div>
        </Container>
      </section>
    </>
  )
}

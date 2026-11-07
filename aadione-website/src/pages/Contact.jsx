import { useState } from 'react'
import {
  Mail,
  Phone,
  MessageCircle,
  Scale,
  Headset,
  PackageSearch,
  RotateCcw,
  UserCog,
  ShieldCheck,
  Briefcase,
  CheckCircle2,
  Send,
} from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'
import { useBusinessInfo } from '../lib/publicApi'
import { telHref, whatsappHref } from '../shared/info-pages'

const TOPICS = [
  { Icon: Headset, title: 'Customer Support', description: 'General questions about using the Aadione app.' },
  { Icon: PackageSearch, title: 'Order Support', description: "Help with an order you've placed." },
  { Icon: RotateCcw, title: 'Refund Support', description: 'Questions about a refund or payment issue.' },
  { Icon: UserCog, title: 'Account Support', description: 'Login, OTP or account access issues.' },
  { Icon: ShieldCheck, title: 'Privacy & Data Requests', description: 'Questions about your data or privacy.' },
  { Icon: Briefcase, title: 'Business Enquiries', description: 'Partnerships and other business queries.' },
]

const cardClass =
  'flex items-center gap-3 rounded-2xl border border-leaf-100 bg-cream p-4 text-sm font-medium text-ink hover:border-leaf-300 break-all'

export default function Contact() {
  useSEO({
    title: 'Contact',
    description:
      'Get in touch with the Aadione team for order support, refunds, account help, privacy requests or business enquiries.',
    path: '/contact',
  })

  const { status: loadStatus, data: business } = useBusinessInfo()
  const support = business?.support ?? {}
  const grievance = business?.grievanceOfficer ?? {}
  const [form, setForm] = useState({ name: '', topic: TOPICS[0].title, message: '' })
  const [opened, setOpened] = useState(false)

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  // There is no message inbox behind this website: the form only prepares an
  // email to the configured support address in the visitor's own email app.
  // It never claims a message was sent. Without a support email it is hidden.
  function handleSubmit(e) {
    e.preventDefault()
    if (!support.email) return
    const subject = `${form.topic} — ${form.name}`.slice(0, 120)
    window.location.href = `mailto:${support.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(form.message)}`
    setOpened(true)
  }

  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="We're happy to help."
        description="Choose a topic below, then reach our support team directly. For complaints, you can also write to our Grievance Officer."
      />

      <section className="bg-white py-20 sm:py-28">
        <Container>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TOPICS.map(({ Icon, title, description }) => (
              <div key={title} className="rounded-3xl border border-leaf-100 bg-cream p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-700 text-white">
                  <Icon size={20} />
                </div>
                <h3 className="mt-4 font-display text-base font-semibold text-ink">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-light/70">{description}</p>
              </div>
            ))}
          </div>

          <div className="mt-14 grid grid-cols-1 gap-14 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <h2 className="font-display text-xl font-semibold text-ink">Reach us directly</h2>
              <div className="mt-4 space-y-3">
                {support.email && (
                  <a href={`mailto:${support.email}`} className={cardClass}>
                    <Mail size={18} className="shrink-0 text-leaf-700" />
                    {support.email}
                  </a>
                )}
                {support.phone && (
                  <a href={telHref(support.phone)} className={cardClass}>
                    <Phone size={18} className="shrink-0 text-leaf-700" />
                    {support.phone}
                  </a>
                )}
                {support.whatsapp && (
                  <a href={whatsappHref(support.whatsapp)} target="_blank" rel="noopener noreferrer" className={cardClass}>
                    <MessageCircle size={18} className="shrink-0 text-leaf-700" />
                    WhatsApp {support.whatsapp}
                  </a>
                )}
                {support.hours && <p className="px-1 text-sm text-ink-light/70">Support hours: {support.hours}</p>}
                {loadStatus === 'ready' && !support.email && !support.phone && !support.whatsapp && (
                  <p className="rounded-2xl border border-dashed border-leaf-200 bg-cream p-4 text-sm text-ink-light/70">
                    Please contact us from the Help section of the Aadione app.
                  </p>
                )}
                {loadStatus === 'error' && (
                  <p className="rounded-2xl border border-dashed border-leaf-200 bg-cream p-4 text-sm text-ink-light/70">
                    Contact details could not be loaded. Please try again, or use the Help section of the Aadione app.
                  </p>
                )}
              </div>

              {grievance.name && (
                <div className="mt-10">
                  <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-ink">
                    <Scale size={20} className="text-leaf-700" /> Grievance Officer
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
                          <a className="text-leaf-700 underline" href={telHref(grievance.phone)}>
                            {grievance.phone}
                          </a>
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
                  <p className="mt-3 text-xs text-ink-light/60">
                    How complaints are handled is described in our{' '}
                    <a className="underline" href="/terms-and-conditions#complaints-and-grievance-redressal">
                      Terms &amp; Conditions
                    </a>
                    .
                  </p>
                </div>
              )}
            </div>

            <div>
              {!support.email ? null : opened ? (
                <div className="rounded-3xl border border-leaf-100 bg-cream p-8 text-center">
                  <CheckCircle2 size={40} className="mx-auto text-leaf-700" />
                  <h3 className="mt-4 font-display text-lg font-semibold text-ink">Your email app should now be open</h3>
                  <p className="mt-2 text-sm text-ink-light/70">
                    Your message is not sent until you press Send in your email app. If nothing opened, write to{' '}
                    <a className="text-leaf-700 underline" href={`mailto:${support.email}`}>
                      {support.email}
                    </a>
                    .
                  </p>
                  <button type="button" onClick={() => setOpened(false)} className="mt-4 text-sm font-semibold text-leaf-700 underline">
                    Back to the form
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="rounded-3xl border border-leaf-100 bg-cream p-6 sm:p-8">
                  <p className="mb-5 text-sm text-ink-light/70">This prepares an email to our support team in your own email app.</p>
                  <Field label="Name" name="name" value={form.name} onChange={update('name')} required />

                  <div className="mt-5">
                    <label htmlFor="topic" className="mb-1.5 block text-sm font-medium text-ink">
                      Topic
                    </label>
                    <select
                      id="topic"
                      value={form.topic}
                      onChange={update('topic')}
                      className="w-full rounded-2xl border border-leaf-200 bg-white px-4 py-3 text-sm text-ink outline-none focus:border-leaf-500"
                    >
                      {TOPICS.map((t) => (
                        <option key={t.title} value={t.title}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-5">
                    <label htmlFor="message" className="mb-1.5 block text-sm font-medium text-ink">
                      Message
                    </label>
                    <textarea
                      id="message"
                      rows={4}
                      required
                      value={form.message}
                      onChange={update('message')}
                      placeholder="How can we help?"
                      className="w-full resize-none rounded-2xl border border-leaf-200 bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-light/40 focus:border-leaf-500"
                    />
                  </div>

                  <Button type="submit" variant="primary" size="lg" icon={Send} className="mt-6 w-full">
                    Open in my email app
                  </Button>
                </form>
              )}
            </div>
          </div>
        </Container>
      </section>
    </>
  )
}

function Field({ label, name, type = 'text', value, onChange, required }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        value={value}
        onChange={onChange}
        className="w-full rounded-2xl border border-leaf-200 bg-white px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-light/40 focus:border-leaf-500"
      />
    </div>
  )
}

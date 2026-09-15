import { useState } from 'react'
import {
  Mail,
  Phone,
  Headset,
  PackageSearch,
  RotateCcw,
  UserCog,
  ShieldCheck,
  Briefcase,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Send,
} from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import Button from '../components/Button'
import useSEO from '../lib/useSEO'
import { contact } from '../config/site'

const TOPICS = [
  { Icon: Headset, title: 'Customer Support', description: 'General questions about using the Aadione app.' },
  { Icon: PackageSearch, title: 'Order Support', description: "Help with an order you've placed." },
  { Icon: RotateCcw, title: 'Refund Support', description: 'Questions about a refund or payment issue.' },
  { Icon: UserCog, title: 'Account Support', description: 'Login, OTP or account access issues.' },
  { Icon: ShieldCheck, title: 'Privacy & Data Requests', description: 'Questions about your data or privacy.' },
  { Icon: Briefcase, title: 'Business Enquiries', description: 'Partnerships and other business queries.' },
]

const STATUS = { IDLE: 'idle', LOADING: 'loading', SUCCESS: 'success', ERROR: 'error' }

export default function Contact() {
  useSEO({
    title: 'Contact',
    description:
      'Get in touch with the Aadione team for order support, refunds, account help, privacy requests or business enquiries.',
    path: '/contact',
  })

  const [form, setForm] = useState({ name: '', email: '', topic: TOPICS[0].title, message: '' })
  const [status, setStatus] = useState(STATUS.IDLE)

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }))

  // Frontend-only for now — no backend endpoint is wired up yet. Kept async
  // so a real API call can be dropped in later without changing the UI.
  async function handleSubmit(e) {
    e.preventDefault()
    setStatus(STATUS.LOADING)
    try {
      await new Promise((resolve) => setTimeout(resolve, 900))
      setStatus(STATUS.SUCCESS)
    } catch {
      setStatus(STATUS.ERROR)
    }
  }

  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="We're happy to help."
        description="Whatever you need help with, we're here for it. Choose a topic below or send us a message directly."
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
                {contact.supportEmail ? (
                  <a
                    href={`mailto:${contact.supportEmail}`}
                    className="flex items-center gap-3 rounded-2xl border border-leaf-100 bg-cream p-4 text-sm font-medium text-ink hover:border-leaf-300"
                  >
                    <Mail size={18} className="text-leaf-700" />
                    {contact.supportEmail}
                  </a>
                ) : (
                  <p className="rounded-2xl border border-dashed border-leaf-200 bg-cream p-4 text-sm text-ink-light/70">
                    Please use the contact form to reach our support team.
                  </p>
                )}
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                    className="flex items-center gap-3 rounded-2xl border border-leaf-100 bg-cream p-4 text-sm font-medium text-ink hover:border-leaf-300"
                  >
                    <Phone size={18} className="text-leaf-700" />
                    {contact.phone}
                  </a>
                )}
              </div>
            </div>

            <div>
              {status === STATUS.SUCCESS ? (
                <div className="rounded-3xl border border-leaf-100 bg-cream p-8 text-center">
                  <CheckCircle2 size={40} className="mx-auto text-leaf-700" />
                  <h3 className="mt-4 font-display text-lg font-semibold text-ink">Message Sent</h3>
                  <p className="mt-2 text-sm text-ink-light/70">
                    Thanks for reaching out. Our team will get back to you soon.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="rounded-3xl border border-leaf-100 bg-cream p-8">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Name" name="name" value={form.name} onChange={update('name')} required />
                    <Field
                      label="Email"
                      name="email"
                      type="email"
                      value={form.email}
                      onChange={update('email')}
                      required
                    />
                  </div>

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

                  {status === STATUS.ERROR && (
                    <div className="mt-5 flex items-start gap-2.5 rounded-2xl bg-red-50 p-4 text-sm text-red-700">
                      <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                      <span>Something went wrong. Please try again.</span>
                    </div>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    icon={status === STATUS.LOADING ? Loader2 : Send}
                    iconClassName={status === STATUS.LOADING ? 'animate-spin' : ''}
                    disabled={status === STATUS.LOADING}
                    className={`mt-6 w-full ${status === STATUS.LOADING ? 'opacity-70' : ''}`}
                  >
                    {status === STATUS.LOADING ? 'Sending…' : 'Send Message'}
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

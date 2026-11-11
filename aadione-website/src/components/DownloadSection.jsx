import { CheckCircle2 } from 'lucide-react'
import Container from './Container'
import { StoreBadge, usePlatform } from './AppStoreButtons'
import { site } from '../config/site'

const POINTS = [
  'Browse local stores, restaurants and categories',
  'Sign in with your mobile number and a one-time code',
  'See every charge in your cart before you pay',
  'Follow your order status in the app',
]

// QR codes (public/badges/qr-*.svg) were generated from the exact store URLs
// in site.js and decoded back to them before being added. They are shown only
// on a computer — on a phone the badge itself is the shortcut.
function QrCard({ store, label, src }) {
  // The badge beside the text is the clickable link; the card is for scanning.
  return (
    <figure className="flex flex-col items-center gap-3 rounded-3xl border border-leaf-100 bg-white p-5 shadow-card">
      <img src={src} alt={`QR code for Aadione on ${label}`} width="148" height="148" className="h-36 w-36" loading="lazy" />
      <figcaption className="text-sm font-bold text-ink">{store === 'android' ? 'Android · Google Play' : 'iPhone · App Store'}</figcaption>
    </figure>
  )
}

export default function DownloadSection({ id = 'download', headingLevel = 'h2' }) {
  const platform = usePlatform()
  const Heading = headingLevel
  return (
    <section id={id} className="scroll-mt-24 bg-gradient-to-b from-leaf-50 to-white py-20 sm:py-28">
      <Container className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <div className="flex items-center gap-4">
            <img src="/images/app-icon-320.webp" alt="" width="72" height="72" className="h-16 w-16 rounded-2xl shadow-card sm:h-[72px] sm:w-[72px]" loading="lazy" />
            <div>
              <span className="text-sm font-semibold text-leaf-600">The {site.name} app</span>
              <Heading className="text-balance font-display text-3xl font-bold text-ink sm:text-4xl">Download {site.name}</Heading>
            </div>
          </div>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-light/80 sm:text-lg">
            Groceries, fresh fruits and vegetables, and food from local restaurants — ordered from your phone and delivered to
            your door in {site.name}&rsquo;s approved delivery areas.
          </p>
          <ul className="mt-6 space-y-2.5">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-2.5 text-sm text-ink-light/85">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-leaf-600" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {platform === 'ios' ? (
              <>
                <StoreBadge store="ios" height={52} />
                <StoreBadge store="android" height={52} />
              </>
            ) : (
              <>
                <StoreBadge store="android" height={52} />
                <StoreBadge store="ios" height={52} />
              </>
            )}
          </div>
        </div>

        {platform === 'desktop' ? (
          <div className="grid grid-cols-2 gap-4 sm:mx-auto sm:max-w-md lg:mx-0">
            <QrCard store="android" label="Google Play" src="/badges/qr-google-play.svg" />
            <QrCard store="ios" label="the App Store" src="/badges/qr-app-store.svg" />
            <p className="col-span-2 text-center text-xs text-ink-light/60">Scan with your phone&rsquo;s camera to open the store.</p>
          </div>
        ) : (
          <div className="hidden" />
        )}
      </Container>
    </section>
  )
}

import { MapPin, ReceiptText, ShieldCheck } from 'lucide-react'
import Container from '../components/Container'
import PageHero from '../components/PageHero'
import DeliveryAreas from '../components/DeliveryAreas'
import DownloadSection from '../components/DownloadSection'
import useSEO from '../lib/useSEO'

const NOTES = [
  { Icon: MapPin, title: 'Village and PIN code', description: 'Each approved village is served with its own PIN code. An address with another PIN code is not delivered to.' },
  { Icon: ShieldCheck, title: 'Checked before you order', description: 'The app checks your address against this list when you add it, and again when you place the order.' },
  { Icon: ReceiptText, title: 'Charges in the app', description: 'Any delivery charge and the estimated delivery time for your address are shown in the app before you pay.' },
]

export default function DeliveryAreasPage() {
  useSEO({
    title: 'Delivery Areas',
    description:
      'Check whether Aadione delivers to your village. See the approved delivery villages and PIN codes, read live from the same list the Aadione app uses.',
    path: '/delivery-areas',
  })

  return (
    <>
      <PageHero
        eyebrow="Delivery areas"
        title="Where Aadione delivers."
        description="Aadione delivers to approved villages, each with its own PIN code. Check yours below — this is the same list the app checks your address against."
      />

      <section className="bg-white py-16 sm:py-24">
        <Container className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.2fr_0.8fr]">
          <DeliveryAreas />
          <div className="space-y-4">
            {NOTES.map(({ Icon, title, description }) => (
              <div key={title} className="flex gap-4 rounded-3xl border border-leaf-100 bg-leaf-50/50 p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-leaf-700 shadow-sm">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <div>
                  <h2 className="font-display text-base font-bold text-ink">{title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-ink-light/75">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <DownloadSection />
    </>
  )
}

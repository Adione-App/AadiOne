import { Download, Store, ShoppingCart, MapPin, Wallet, ClipboardCheck, PackageSearch, Home } from 'lucide-react'
import { site } from '../config/site'

// The customer's real path through the app, in order. No delivery time is
// promised: the app shows an estimate for each order.
export const HOW_STEPS = [
  { Icon: Download, title: `Download ${site.name}`, description: 'Get the app from Google Play or the App Store.' },
  { Icon: Store, title: 'Browse products and local stores', description: 'Explore categories, products, local stores and restaurants.' },
  { Icon: ShoppingCart, title: 'Add products to your cart', description: 'Choose what you need. Your cart shows every charge before you pay.' },
  { Icon: MapPin, title: 'Select your delivery address', description: 'Add your address. The app checks that it is in an approved delivery area.' },
  { Icon: Wallet, title: 'Choose a payment option', description: 'Pick one of the payment options shown at checkout.' },
  { Icon: ClipboardCheck, title: 'Place your order', description: 'Review the bill and place your order. You sign in with your mobile number and a one-time code.' },
  { Icon: PackageSearch, title: 'Track your order', description: 'Follow your order’s status in the app as the seller prepares and dispatches it.' },
  { Icon: Home, title: 'Receive it at your doorstep', description: 'Your order is delivered to the address you chose.' },
]

export default function HowSteps() {
  return (
    <ol className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4`}>
      {HOW_STEPS.map(({ Icon, title, description }, i) => (
        <li key={title} className="relative flex flex-col gap-3 rounded-3xl border border-leaf-100 bg-white p-6 shadow-[0_1px_0_rgba(14,46,34,0.04)] transition-shadow hover:shadow-card">
          <div className="flex items-center justify-between">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-leaf-50 text-leaf-700">
              <Icon size={21} aria-hidden="true" />
            </span>
            <span className="text-sm font-bold text-leaf-300">{String(i + 1).padStart(2, '0')}</span>
          </div>
          <h3 className="font-display text-base font-bold text-ink">{title}</h3>
          <p className="text-sm leading-relaxed text-ink-light/75">{description}</p>
        </li>
      ))}
    </ol>
  )
}

import { useState } from 'react'
import { ImageOff, RefreshCw, Store, UtensilsCrossed } from 'lucide-react'
import { useCatalogueCategories, useRestaurants, useSubcategories } from '../lib/publicApi'
import { marketplaceKinds } from '../config/site'
import { CATEGORY_ICONS, DefaultCategoryIcon } from '../config/categoryIcons'

// What customers can shop in the app right now: the live top-level categories
// with their own images and subcategories, straight from the public API. A
// category the admin adds appears here without a website change.

function LoadError({ what, onRetry }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75">
      <p>{what} could not be loaded just now. You can see everything in the Aadione app.</p>
      <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 font-semibold text-leaf-700 hover:text-leaf-800">
        <RefreshCw size={15} aria-hidden="true" /> Try again
      </button>
    </div>
  )
}

/** An image from the API; if it is missing or fails to load, a neutral placeholder instead. */
function SafeImage({ src, alt = '', className = '', Fallback = ImageOff }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-leaf-50 ${className}`} role={alt ? 'img' : undefined} aria-label={alt || undefined}>
        <Fallback size={32} className="text-leaf-500" aria-hidden="true" />
      </div>
    )
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={className} />
}

function SkeletonCards({ count = 2 }) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-56 animate-pulse rounded-3xl bg-leaf-50" />
      ))}
    </div>
  )
}

function Subcategories({ categoryId }) {
  const { status, data } = useSubcategories(categoryId)
  if (status === 'loading') return <div className="mt-4 h-8 w-2/3 animate-pulse rounded-full bg-leaf-50" aria-hidden="true" />
  if (status !== 'ready' || !Array.isArray(data) || data.length === 0) return null
  return (
    <ul className="mt-4 flex flex-wrap gap-2" aria-label="Includes">
      {data.map((sub) => (
        <li key={sub.id} className="rounded-full border border-leaf-100 bg-leaf-50/70 px-3 py-1 text-xs font-medium text-leaf-800">
          {sub.name}
        </li>
      ))}
    </ul>
  )
}

export function LiveCategories() {
  const { status, data, retry } = useCatalogueCategories()
  if (status === 'loading') return <SkeletonCards />
  if (status === 'error') return <LoadError what="Categories" onRetry={retry} />
  const categories = Array.isArray(data) ? data.filter((c) => !c.parentId) : []
  if (categories.length === 0) {
    return <p className="rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75">Categories are being updated. Open the Aadione app to see what you can order today.</p>
  }
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      {categories.map((category) => (
        <article key={category.id} className="group flex flex-col overflow-hidden rounded-3xl border border-leaf-100 bg-white shadow-[0_1px_0_rgba(14,46,34,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card sm:flex-row">
          <div className="aspect-[4/3] shrink-0 overflow-hidden bg-leaf-50 sm:aspect-auto sm:w-44">
            <SafeImage src={category.imageUrl} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" Fallback={Store} />
          </div>
          <div className="flex flex-1 flex-col p-6">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-leaf-100 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-leaf-800">
              <span className="h-1.5 w-1.5 rounded-full bg-leaf-600" aria-hidden="true" /> In the app now
            </span>
            <h3 className="mt-3 font-display text-xl font-bold text-ink">{category.name}</h3>
            <Subcategories categoryId={category.id} />
          </div>
        </article>
      ))}
    </div>
  )
}

/**
 * Restaurants and cafés in the app's Food section: name, the cover photo the
 * admin uploaded, cuisines and pure-veg flag — never a phone number or address.
 */
export function LiveRestaurants({ cards = false }) {
  const { status, data, retry } = useRestaurants()
  const restaurants = status === 'ready' && Array.isArray(data) ? data : []
  if (status === 'loading') return cards ? <SkeletonCards /> : null
  if (status === 'error') return cards ? <LoadError what="Restaurants" onRetry={retry} /> : null
  if (restaurants.length === 0) {
    return cards ? (
      <p className="rounded-3xl border border-dashed border-leaf-200 bg-white p-6 text-sm text-ink-light/75">
        No restaurants are listed right now. Open the Food section of the Aadione app to see when they are back.
      </p>
    ) : null
  }
  if (!cards) {
    return (
      <ul className="mt-6 flex flex-wrap gap-2" aria-label="Restaurants and cafés in the app">
        {restaurants.map((r) => (
          <li key={r.sellerId} className="inline-flex items-center gap-2 rounded-full border border-leaf-100 bg-white px-3 py-1.5 text-sm font-medium text-ink">
            <UtensilsCrossed size={14} className="text-leaf-600" aria-hidden="true" />
            {r.name}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Restaurants and cafés in the app">
      {restaurants.map((r) => (
        <li key={r.sellerId} className="overflow-hidden rounded-3xl border border-leaf-100 bg-white shadow-[0_1px_0_rgba(14,46,34,0.04)]">
          <SafeImage src={r.coverImageUrl} alt={r.name} className="aspect-[16/9] w-full object-cover" Fallback={UtensilsCrossed} />
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-bold text-ink">{r.name}</h3>
              {/* Live status from the API at the moment the page loaded. */}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${r.isOpen ? 'bg-leaf-100 text-leaf-800' : 'bg-red-50 text-red-700'}`}>
                {r.isOpen ? 'Open now' : 'Closed now'}
              </span>
            </div>
            {Array.isArray(r.cuisine) && r.cuisine.length > 0 && <p className="mt-1 text-sm text-ink-light/70">{r.cuisine.join(' · ')}</p>}
            {r.isVegOnly && <p className="mt-2 inline-block rounded-full bg-leaf-50 px-2 py-0.5 text-[11px] font-bold text-leaf-800">Pure veg</p>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * Every kind of shop the marketplace is built for, each marked from the live
 * catalogue: "In the app now" only when a live category (or, for food, a
 * listed restaurant) exists; otherwise "As local sellers join".
 */
export function MarketplaceKinds({ only, columns = 3 }) {
  const { status, data } = useCatalogueCategories()
  const restaurants = useRestaurants()
  const live = status === 'ready' && Array.isArray(data) ? data.filter((c) => !c.parentId) : []
  const hasFood = restaurants.status === 'ready' && Array.isArray(restaurants.data) && restaurants.data.length > 0
  const kinds = only ? marketplaceKinds.filter((k) => only.includes(k.id)) : marketplaceKinds
  const known = status === 'ready'

  return (
    <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${columns === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {kinds.map((kind) => {
        const available = kind.food ? hasFood : live.some((c) => kind.match.test(c.name))
        const Icon = CATEGORY_ICONS[kind.id] || DefaultCategoryIcon
        return (
          <article key={kind.id} className="flex flex-col overflow-hidden rounded-3xl border border-leaf-100 bg-white transition-shadow hover:shadow-card">
            {kind.image ? (
              <img src={kind.image} alt="" loading="lazy" decoding="async" className={`aspect-[16/9] w-full object-cover ${kind.imagePosition ?? 'object-center'}`} />
            ) : (
              <div className="flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-leaf-50 to-leaf-100/60">
                <Icon size={44} className="text-leaf-600" aria-hidden="true" />
              </div>
            )}
            <div className="flex flex-1 flex-col p-5">
              {known && (
                <span
                  className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                    available ? 'bg-leaf-100 text-leaf-800' : 'bg-mango-light/60 text-mango-dark'
                  }`}
                >
                  {available ? 'In the app now' : 'As local sellers join'}
                </span>
              )}
              <h3 className="mt-3 flex items-center gap-2 font-display text-lg font-bold text-ink">
                {kind.food ? <UtensilsCrossed size={18} className="text-leaf-600" aria-hidden="true" /> : <Store size={18} className="text-leaf-600" aria-hidden="true" />}
                {kind.name}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-light/75">{kind.description}</p>
            </div>
          </article>
        )
      })}
    </div>
  )
}


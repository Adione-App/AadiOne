import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Smartphone } from 'lucide-react'
import { appLinks } from '../config/site'
import { detectPlatform } from '../lib/platform'

// The official store badges (public/badges/: Google's "Get it on Google Play"
// PNG and Apple's "Download on the App Store" SVG, unmodified apart from
// trimming the PNG's transparent padding). Both open the real store listing in
// a new tab. On a phone the matching store comes first and the other stays one
// tap away (a guess from the browser can be wrong); on a computer both show.

const STORE = {
  android: { href: appLinks.playStore, src: '/badges/google-play.png', alt: 'Get it on Google Play', width: 564, height: 168 },
  ios: { href: appLinks.appStore, src: '/badges/app-store.svg', alt: 'Download on the App Store', width: 120, height: 40 },
}

export function usePlatform() {
  const [platform, setPlatform] = useState('desktop')
  useEffect(() => setPlatform(detectPlatform()), [])
  return platform
}

export function StoreBadge({ store, height = 48, className = '' }) {
  const badge = STORE[store]
  return (
    <a
      href={badge.href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-block rounded-[10px] transition-transform duration-200 hover:-translate-y-0.5 ${className}`}
      aria-label={`${badge.alt} (opens in a new tab)`}
    >
      <img
        src={badge.src}
        alt={badge.alt}
        width={Math.round((badge.width / badge.height) * height)}
        height={height}
        style={{ height }}
        className="w-auto"
        loading="lazy"
        decoding="async"
      />
    </a>
  )
}

export default function AppStoreButtons({ className = '', size = 'md', align = 'start', tone = 'light' }) {
  const platform = usePlatform()
  const height = size === 'lg' ? 52 : 44
  const other = platform === 'android' ? 'ios' : 'android'
  const justify = align === 'center' ? 'justify-center' : 'justify-start'

  if (platform === 'desktop') {
    return (
      <div className={`flex flex-wrap items-center gap-3 ${justify} ${className}`}>
        <StoreBadge store="android" height={height} />
        <StoreBadge store="ios" height={height} />
      </div>
    )
  }
  return (
    <div className={`flex flex-col gap-2 ${align === 'center' ? 'items-center' : 'items-start'} ${className}`}>
      <StoreBadge store={platform} height={height} />
      <a
        href={STORE[other].href}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-xs font-semibold underline underline-offset-2 ${tone === 'dark' ? 'text-leaf-100 hover:text-white' : 'text-leaf-700 hover:text-leaf-800'}`}
      >
        {other === 'ios' ? 'Also on the App Store' : 'Also on Google Play'}
      </a>
    </div>
  )
}

/**
 * The header's "Download App" button: straight to the matching store on a
 * phone, to the download page (both stores and their QR codes) on a computer.
 */
export function DownloadAppButton({ className = '' }) {
  const platform = usePlatform()
  const classes = `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full bg-leaf-700 py-2.5 text-sm font-semibold text-white shadow-card transition-colors hover:bg-leaf-800 ${className}`
  if (platform === 'desktop') {
    return (
      <Link to="/download" className={classes}>
        <Smartphone size={17} aria-hidden="true" /> Download App
      </Link>
    )
  }
  return (
    <a href={STORE[platform].href} target="_blank" rel="noopener noreferrer" className={classes}>
      <Smartphone size={17} aria-hidden="true" /> Download App
    </a>
  )
}

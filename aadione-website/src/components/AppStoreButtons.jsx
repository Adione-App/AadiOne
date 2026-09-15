import { appLinks } from '../config/site'

function AppleGlyph() {
  return (
    <svg viewBox="0 0 384 512" className="h-6 w-6 fill-current" aria-hidden="true">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141 0 184.8 0 273.5c0 26.2 4.8 53.3 14.4 81.2 12.8 37.5 59 129.3 107.2 127.8 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-84.1 102.6-121.7-65.2-30.7-57.7-89.9-57.7-92.1zM255.7 65.7c26.9-32 24.5-61.2 23.7-71.7-23.8 1.4-51.3 16.4-67 34.9-17.3 19.8-27.5 44.4-25.4 71.9 25.9 2 49.5-11.2 68.7-35.1z" />
    </svg>
  )
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 512 512" className="h-6 w-6 fill-current" aria-hidden="true">
      <path d="M47 26c-8 6-14 16-14 29v402c0 13 6 23 14 29l3 2 226-226v-5L50 25z" />
      <path d="M354 265l-75-75v-5l75-75 4 2 89 51c25 15 25 39 0 54l-89 51z" />
      <path d="M279 190L50 419c9 9 24 10 40 1l264-150z" />
      <path d="M279 116L90 8c-16-9-31-8-40 1l229 229z" />
    </svg>
  )
}

export default function AppStoreButtons({ className = '', size = 'md' }) {
  const pad = size === 'lg' ? 'px-5 py-3.5' : 'px-4 py-2.5'
  const external = (href) => (href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <a
        href={appLinks.playStore}
        {...external(appLinks.playStore)}
        className={`inline-flex items-center gap-3 rounded-2xl bg-ink text-white ${pad} shadow-card transition-transform hover:-translate-y-0.5`}
      >
        <PlayGlyph />
        <span className="text-left leading-tight">
          <span className="block text-[11px] text-white/70">Get it on</span>
          <span className="block text-sm font-semibold">Google Play</span>
        </span>
      </a>
      <a
        href={appLinks.appStore}
        {...external(appLinks.appStore)}
        className={`inline-flex items-center gap-3 rounded-2xl bg-ink text-white ${pad} shadow-card transition-transform hover:-translate-y-0.5`}
      >
        <AppleGlyph />
        <span className="text-left leading-tight">
          <span className="block text-[11px] text-white/70">Download on the</span>
          <span className="block text-sm font-semibold">App Store</span>
        </span>
      </a>
    </div>
  )
}

import { useState } from 'react'
import { useBrandAsset } from '../lib/branding'

// The Aadione logo. Shows the logo published in Admin Panel → Branding &
// Identity (the light-background one; the dark-background one in the dark
// footer) and falls back to the official built-in wordmark (from the app's own
// artwork, mobile/assets/adione-logo.png, as WebP with a PNG fallback) while
// nothing is published or if the image cannot be loaded. Never redrawn here.
function BuiltInLogo({ className }) {
  return (
    <picture>
      <source type="image/webp" srcSet="/images/aadione-logo-480.webp 1x, /images/aadione-logo-960.webp 2x" />
      <img src="/images/aadione-logo-480.png" alt="Aadione" width="480" height="164" className={`w-auto ${className}`} decoding="async" />
    </picture>
  )
}

export default function Logo({ className = 'h-9', onDark = false }) {
  const asset = useBrandAsset(onDark ? 'dark' : 'light')
  const [failed, setFailed] = useState(null)
  if (asset && failed !== asset.url) {
    return (
      <img
        src={asset.url}
        alt="Aadione"
        width={asset.width}
        height={asset.height}
        className={`w-auto max-w-full object-contain ${className}`}
        decoding="async"
        onError={() => setFailed(asset.url)}
      />
    )
  }
  const img = <BuiltInLogo className={className} />
  // On a dark background the green wordmark sits on a light pill so it stays legible.
  return onDark ? <span className="inline-flex rounded-2xl bg-white px-3 py-2">{img}</span> : img
}

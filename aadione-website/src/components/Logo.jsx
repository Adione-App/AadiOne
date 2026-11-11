// The official Aadione wordmark (from the app's own artwork, mobile/assets/
// adione-logo.png), as WebP with a PNG fallback. Never redrawn here.
export default function Logo({ className = 'h-9', onDark = false }) {
  const img = (
    <picture>
      <source type="image/webp" srcSet="/images/aadione-logo-480.webp 1x, /images/aadione-logo-960.webp 2x" />
      <img src="/images/aadione-logo-480.png" alt="Aadione" width="480" height="164" className={`w-auto ${className}`} decoding="async" />
    </picture>
  )
  // On a dark background the green wordmark sits on a light pill so it stays legible.
  return onDark ? <span className="inline-flex rounded-2xl bg-white px-3 py-2">{img}</span> : img
}

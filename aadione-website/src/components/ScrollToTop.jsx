import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/** Resets scroll position on every route change (useSEO also does this on
 * pages that call it, but this covers pages/edge cases consistently). A link
 * with a #section (e.g. /contact#grievance-officer) scrolls to that section
 * once it has rendered — it may wait for API data, so it is looked for briefly. */
export default function ScrollToTop() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
    if (!hash) return undefined
    let tries = 0
    const timer = setInterval(() => {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)))
      if (target || ++tries > 30) {
        clearInterval(timer)
        target?.scrollIntoView({ block: 'start' })
      }
    }, 100)
    return () => clearInterval(timer)
  }, [pathname, hash])

  return null
}

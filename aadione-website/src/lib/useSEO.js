import { useEffect } from 'react'
import { site } from '../config/site'

// Per-page title, description, canonical URL and social (Open Graph / X)
// tags. index.html carries the same defaults for crawlers that do not run
// scripts; every route also has its own <url> in public/sitemap.xml.

export const OG_IMAGE = `${site.url}/og-image.png`

function setMeta(name, content, attr = 'name') {
  if (!content) return
  let el = document.head.querySelector(`meta[${attr}="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function setCanonical(url) {
  let el = document.head.querySelector('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', url)
}

/** The title shown for a page: "<Page> | Aadione", or the brand line on Home. */
export const pageTitle = (title) => (title ? `${title} | ${site.name}` : `${site.name} — ${site.tagline}`)

/**
 * Sets document title + meta description, canonical and social tags.
 * Usage: useSEO({ title: 'About', description: '...', path: '/about' })
 */
export default function useSEO({ title, description, path = '/', noindex = false }) {
  useEffect(() => {
    const fullTitle = pageTitle(title)
    const desc = description || site.description
    const url = `${site.url}${path === '/' ? '/' : path}`
    document.title = fullTitle

    setMeta('description', desc)
    setCanonical(url)
    setMeta('og:title', fullTitle, 'property')
    setMeta('og:description', desc, 'property')
    setMeta('og:url', url, 'property')
    setMeta('og:image', OG_IMAGE, 'property')
    setMeta('twitter:title', fullTitle)
    setMeta('twitter:description', desc)
    setMeta('twitter:image', OG_IMAGE)
    // The site is a single-page app: an unknown address still answers 200, so
    // the "not found" page tells search engines not to index it.
    let robots = document.head.querySelector('meta[name="robots"]')
    if (noindex) {
      if (!robots) {
        robots = document.createElement('meta')
        robots.setAttribute('name', 'robots')
        document.head.appendChild(robots)
      }
      robots.setAttribute('content', 'noindex')
    } else if (robots) {
      robots.remove()
    }

    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
  }, [title, description, path, noindex])
}

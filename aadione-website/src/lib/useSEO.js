import { useEffect } from 'react'
import { site } from '../config/site'

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

function setCanonical(path) {
  let el = document.head.querySelector('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', `${site.url}${path}`)
}

/**
 * Sets document title + meta description/OG tags for the current page.
 * Usage: useSEO({ title: 'About', description: '...', path: '/about' })
 */
export default function useSEO({ title, description, path = '' }) {
  useEffect(() => {
    const fullTitle = title ? `${title} | ${site.name}` : `${site.name} — ${site.tagline}`
    document.title = fullTitle

    const desc = description || site.description
    setMeta('description', desc)
    setMeta('og:title', fullTitle, 'property')
    setMeta('og:description', desc, 'property')
    setMeta('twitter:title', desc)
    setMeta('twitter:description', desc)
    setCanonical(path)

    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
  }, [title, description, path])
}

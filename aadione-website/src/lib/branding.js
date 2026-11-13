// ---------------------------------------------------------------------------
// The brand assets published in Admin Panel → Branding & Identity
// (GET /branding), for this website's logos and favicon. One source for the
// app, the panels and this site.
//
// No flash, and offline-friendly: the last published branding this browser
// saw is kept in localStorage (only image addresses — nothing about the
// visitor) and used at once on the next visit, then refreshed once per page
// load. Until anything is published — or if an image fails to load — the
// site's own built-in artwork is shown (components/Logo.jsx).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { brandAssetFor, isSafeAssetUrl } from '../shared/branding'
import { fetchPublic } from './publicApi'

export const BRANDING_STORAGE_KEY = 'aadione.branding.v1'

export function readCachedBranding() {
  try {
    const raw = window.localStorage.getItem(BRANDING_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed.revision === 'number' && parsed.assets ? parsed : null
  } catch {
    return null
  }
}

let current = typeof window === 'undefined' ? null : readCachedBranding()
let requested = false
const listeners = new Set()

function load() {
  if (requested) return
  requested = true
  fetchPublic('/branding')
    .then((branding) => {
      if (!branding || typeof branding.revision !== 'number' || !branding.assets) return
      current = branding
      try {
        window.localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(branding))
      } catch {
        // Storage blocked: the site still shows the branding for this visit.
      }
      listeners.forEach((listener) => listener(branding))
    })
    .catch(() => {
      // Offline or unreachable: keep the cached (or built-in) branding.
    })
}

/** The published branding (the cached copy first), refreshed once per page load. */
export function useBranding() {
  const [branding, setBranding] = useState(current)
  useEffect(() => {
    listeners.add(setBranding)
    load()
    return () => listeners.delete(setBranding)
  }, [])
  return branding
}

/** The published asset for a place on the site ('light', 'dark', 'favicon'…), or null for the built-in artwork. */
export function useBrandAsset(use) {
  return brandAssetFor(useBranding(), use)
}

/**
 * Keeps the tab icon and home-screen icon on the published favicon: the page's
 * own icon links (index.html) are pointed at the published PNGs, and put back
 * when the favicon returns to the built-in one.
 */
export function useFaviconSync() {
  const favicon = useBrandAsset('favicon')
  const small = favicon?.variants?.png32
  const touch = favicon?.variants?.png180
  useEffect(() => retargetIcons(small, touch), [small, touch])
}

/** Points every icon link at `small` (apple-touch-icon at `touch`), or restores index.html's own when unset. */
export function retargetIcons(small, touch) {
  for (const link of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')) {
    if (link.dataset.builtinHref === undefined) {
      link.dataset.builtinHref = link.getAttribute('href') ?? ''
      link.dataset.builtinType = link.getAttribute('type') ?? ''
    }
    const published = link.rel === 'apple-touch-icon' ? touch : small
    if (published && isSafeAssetUrl(published)) {
      link.setAttribute('href', published)
      link.setAttribute('type', 'image/png')
    } else {
      link.setAttribute('href', link.dataset.builtinHref)
      if (link.dataset.builtinType) link.setAttribute('type', link.dataset.builtinType)
      else link.removeAttribute('type')
    }
  }
}

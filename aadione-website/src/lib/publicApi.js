// ---------------------------------------------------------------------------
// The published Privacy Policy, Terms & Conditions and About page, and the
// business / contact details, read from the SAME public API the Aadione app
// uses (GET /legal/:slug, GET /legal/business). Nothing legal or contact-
// related is copied into this website: an admin publishes once and the app,
// this site and the public HTML link all show the same text, "Last updated"
// date and version.
//
// Responses are kept in memory for a minute (the API allows the same), so a
// publish shows here within about a minute — and on every full page load.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import { apiBaseUrl } from '../config/site.js'

const FRESH_FOR_MS = 60_000
const memory = new Map()

export const PUBLIC_TIMEOUT_MS = 15_000

/** One public GET. 404 = "nothing published" (null); a timeout or offline is an error, never data. */
export async function fetchPublic(path, { fetchImpl = fetch, timeoutMs = PUBLIC_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, { headers: { Accept: 'application/json' }, signal: controller.signal })
    const body = await response.json().catch(() => null)
    if (response.status === 404) return null
    if (!response.ok || !body?.success) {
      const error = new Error(body?.error?.message || `Request failed (${response.status})`)
      error.status = response.status
      throw error
    }
    return body.data
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error('The request took too long.')
      timeout.status = 408
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(path) {
  const cached = memory.get(path)
  if (cached && Date.now() - cached.at < FRESH_FOR_MS) return cached.promise

  const promise = fetchPublic(path)
  memory.set(path, { at: Date.now(), promise })
  // A failure is not cached: the next visit tries again.
  promise.catch(() => memory.delete(path))
  return promise
}

/** The public HTML version of a page, served by the API (always available as a fallback). */
export const infoPageHtmlUrl = (slug) => `${apiBaseUrl}/legal/${slug}/page`

function useResource(path) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setState((current) => ({ ...current, status: 'loading' }))
    getJson(path)
      .then((data) => active && setState({ status: 'ready', data, error: null }))
      .catch((error) => active && setState({ status: 'error', data: null, error }))
    return () => {
      active = false
    }
  }, [path, attempt])

  return { ...state, retry: () => setAttempt((n) => n + 1) }
}

/** A published page (`data` null = not published yet, e.g. About before its first publish). */
export const useInfoPage = (slug) => useResource(`/legal/${slug}`)

/** The legal pages a reader can open now (GET /legal/pages) — e.g. footer links to published policies only. */
export const useAvailablePages = () => useResource('/legal/pages')

/** Business and contact details; every empty setting is null and must be hidden. */
export const useBusinessInfo = () => useResource('/legal/business')

// ---------------------------------------------------------------------------
// The live catalogue and delivery area, read from the same public endpoints
// the app uses before sign-in. Nothing here is copied into the site: a
// category, restaurant or village the admin adds appears here too.
// ---------------------------------------------------------------------------

/** Top-level categories customers can shop now (name, slug, image). */
export const useCatalogueCategories = () => useResource('/categories')

/** The subcategories inside one top-level category. */
export const useSubcategories = (categoryId) => useResource(`/categories/${categoryId}/subcategories`)

/** Restaurants and cafés listed in the app's Food section. */
export const useRestaurants = () => useResource('/restaurants')

/**
 * The admin-approved delivery villages and their PIN codes — THE list the
 * app's address form offers and the server checks every order against.
 */
export const useDeliveryAreas = () => useResource('/store/delivery-locations')

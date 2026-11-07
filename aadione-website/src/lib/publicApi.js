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
import { apiBaseUrl } from '../config/site'

const FRESH_FOR_MS = 60_000
const memory = new Map()

async function getJson(path) {
  const cached = memory.get(path)
  if (cached && Date.now() - cached.at < FRESH_FOR_MS) return cached.promise

  const promise = fetch(`${apiBaseUrl}${path}`, { headers: { Accept: 'application/json' } }).then(async (response) => {
    const body = await response.json().catch(() => null)
    if (response.status === 404) return null
    if (!response.ok || !body?.success) throw new Error(body?.error?.message || `Request failed (${response.status})`)
    return body.data
  })
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

/** Business and contact details; every empty setting is null and must be hidden. */
export const useBusinessInfo = () => useResource('/legal/business')

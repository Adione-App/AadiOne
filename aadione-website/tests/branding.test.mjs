// Website branding (src/lib/branding.js, components/Logo.jsx) and the policy
// pages from Admin → Legal & Policies — run with `npm test`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

describe('branding', () => {
  it('the logo is the published one for its background, else the built-in wordmark — never a broken image', () => {
    const logo = read('src/components/Logo.jsx')
    assert.match(logo, /useBrandAsset\(onDark \? 'dark' : 'light'\)/)
    assert.match(logo, /onError=\{\(\) => setFailed\(asset\.url\)\}/)
    assert.match(logo, /\/images\/aadione-logo-480\.png/)
  })

  it('the last published branding is used at once from the browser, refreshed once per visit, and offline keeps it', () => {
    const lib = read('src/lib/branding.js')
    assert.match(lib, /let current = typeof window === 'undefined' \? null : readCachedBranding\(\)/)
    assert.match(lib, /fetchPublic\('\/branding'\)/)
    assert.match(lib, /window\.localStorage\.setItem\(BRANDING_STORAGE_KEY, JSON\.stringify\(branding\)\)/)
    assert.match(lib, /\/\/ Offline or unreachable: keep the cached \(or built-in\) branding\./)
    // Only safe addresses become the favicon; the page's own icon links are restored otherwise.
    assert.match(lib, /if \(published && isSafeAssetUrl\(published\)\)/)
    assert.match(lib, /link\.setAttribute\('href', link\.dataset\.builtinHref\)/)
    assert.match(read('src/App.jsx'), /useFaviconSync\(\)/)
  })

  it('the social-share artwork says Aadione', () => {
    assert.doesNotMatch(read('public/assets/og-image.svg'), /AdiOne/)
  })
})

describe('policies', () => {
  it('refund and delivery addresses show the stand-alone policy once published, else the Terms sections', () => {
    const policy = read('src/pages/legal/PolicyPage.jsx')
    assert.match(policy, /if \(fallbackTo && status === 'ready' && !data\) return <Navigate to=\{fallbackTo\} replace \/>/)
    assert.match(read('src/pages/legal/CancellationRefund.jsx'), /slug="refund-policy"/)
    assert.match(read('src/pages/legal/DeliveryPolicy.jsx'), /slug="shipping-policy"/)
    const app = read('src/App.jsx')
    for (const route of ['/cookie-policy', '/seller-terms', '/seller-privacy']) assert.ok(app.includes(`path="${route}"`), route)
    assert.match(app, /path="\/refund-policy" element=\{<Navigate to="\/cancellation-refund-policy" replace \/>\}/)
  })
})

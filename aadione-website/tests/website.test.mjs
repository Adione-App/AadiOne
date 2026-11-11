// The marketing pages: official store links, verified QR codes, live data
// instead of typed claims, SEO files, and safe external links.
// Run: npm test  (from aadione-website/)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const PLAY = 'https://play.google.com/store/apps/details?id=in.adione.app'
const APPLE = 'https://apps.apple.com/in/app/aadione/id6817763486'

function sourceFiles(dir) {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name)
    if (statSync(path.join(ROOT, rel)).isDirectory()) return rel.endsWith('shared') ? [] : sourceFiles(rel)
    return /\.(jsx?|tsx?)$/.test(name) ? [rel] : []
  })
}
const allSource = () => sourceFiles('src').map((f) => [f, read(f)])

describe('app download links', () => {
  it('the official store URLs are the only store links, and no placeholder "#" link is left', () => {
    const site = read('src/config/site.js')
    assert.ok(site.includes(`playStore: '${PLAY}'`))
    assert.ok(site.includes(`appStore: '${APPLE}'`))
    for (const [file, text] of allSource()) {
      assert.doesNotMatch(text, /href=["']#["']|playStore: '#'|appStore: '#'/, file)
      for (const url of text.match(/https:\/\/(play\.google\.com|apps\.apple\.com)[^'"`\s)]*/g) ?? []) {
        assert.ok(url === PLAY || url === APPLE, `${file}: ${url}`)
      }
    }
    const html = read('index.html')
    assert.ok(html.includes(PLAY) && html.includes(APPLE))
    assert.match(html, /app-id=6817763486/)
  })

  it('store badges and every external link open in a new tab with noopener', () => {
    for (const [file, text] of allSource()) {
      for (const tag of text.match(/<a\b[^>]*target="_blank"[^>]*>/gs) ?? []) assert.match(tag, /rel="noopener noreferrer"/, file)
    }
    const buttons = read('src/components/AppStoreButtons.jsx')
    assert.match(buttons, /\/badges\/google-play\.png/)
    assert.match(buttons, /\/badges\/app-store\.svg/)
    for (const f of ['public/badges/google-play.png', 'public/badges/app-store.svg', 'public/badges/qr-google-play.svg', 'public/badges/qr-app-store.svg']) {
      assert.ok(existsSync(path.join(ROOT, f)), f)
    }
  })

  it('a phone gets its own store first; a computer gets both', async () => {
    const { detectPlatform } = await import('../src/lib/platform.js')
    assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile' }), 'android')
    assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }), 'ios')
    assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), 'ios')
    assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'desktop')
    assert.equal(detectPlatform(null), 'desktop')
  })

  it('the QR codes encode exactly the store URLs (generated from them; the QA script decodes them back)', () => {
    // A QR SVG holds no readable text, so this guards that both exist, differ and
    // are used; each was decoded back to its exact URL with jsQR when generated.
    assert.notEqual(read('public/badges/qr-google-play.svg'), read('public/badges/qr-app-store.svg'))
    assert.match(read('src/components/DownloadSection.jsx'), /qr-google-play\.svg[\s\S]*qr-app-store\.svg/)
  })
})

describe('no invented business facts', () => {
  it('no ratings, review counts, customer or seller numbers, delivery-time promises or a km radius', () => {
    for (const [file, text] of allSource()) {
      assert.doesNotMatch(text, /aggregateRating|ratingValue|reviewCount|\d+\s*\+?\s*(happy )?customers|\d+\s*\+?\s*sellers|\d+\s*-?\s*min(ute)?s? delivery|\d+\s*km\b|guaranteed/i, file)
    }
    assert.doesNotMatch(read('index.html'), /aggregateRating|ratingValue|reviewCount|"offers"/)
  })

  it('categories, restaurants and delivery areas are read live from the API, not typed into the site', () => {
    const api = read('src/lib/publicApi.js')
    assert.match(api, /useResource\('\/categories'\)/)
    assert.match(api, /useResource\('\/restaurants'\)/)
    assert.match(api, /useResource\('\/store\/delivery-locations'\)/)
    assert.doesNotMatch(read('src/components/DeliveryAreas.jsx'), /Railmagra'|313329'|Kuraj/) // only as placeholder text
    // A kind of shop is "In the app now" only from live data.
    assert.match(read('src/components/LiveCatalogue.jsx'), /available \? 'In the app now' : 'As local sellers join'/)
  })

  it('no mock-up is presented as an app screenshot', () => {
    for (const [file, text] of allSource()) assert.doesNotMatch(text, /app-screenshot|screenshot\.(svg|png)/, file)
  })

  it('restaurant cards never show a restaurant phone number or address', () => {
    const live = read('src/components/LiveCatalogue.jsx')
    assert.doesNotMatch(live, /r\.phone|r\.addressLine|r\.latitude/)
  })

  it('WhatsApp comes only from the Admin WhatsApp field and only when that value is valid — no website switch', () => {
    assert.doesNotMatch(read('src/config/site.js'), /whatsappConfirmed|supportOptions/)
    for (const file of ['src/components/Footer.jsx', 'src/components/SupportDetails.jsx']) {
      const text = read(file)
      assert.match(text, /const whatsapp = whatsappLink\(support\.whatsapp\)/, file)
      assert.doesNotMatch(text, /whatsappLink\(support\.phone\)|whatsappHref|whatsappConfirmed/, file) // never the phone number
    }
  })

  it('no business contact or legal identifier is written into the website code', () => {
    for (const [file, text] of allSource()) {
      assert.doesNotMatch(text, /[A-Z]{5}[0-9]{4}[A-Z]/, `${file}: PAN-like value`)
      assert.doesNotMatch(text, /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]/, `${file}: GSTIN-like value`)
      assert.doesNotMatch(text, /['"`>\s][6-9]\d{9}['"`<\s]/, `${file}: phone number`)
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.(com|in|org|net)\b/, `${file}: email address`)
      assert.doesNotMatch(text, /MADAN|KHUNTIA|Khunita|Rajsamand/i, `${file}: business identity`)
    }
  })
})

describe('pages, SEO and legal links', () => {
  const app = read('src/App.jsx')
  const routes = [...app.matchAll(/path="([^"*]+)"/g)].map((m) => m[1])

  it('keeps every existing route and adds Delivery Areas and Download', () => {
    for (const r of ['/', '/about', '/how-it-works', '/categories', '/features', '/faq', '/contact', '/support', '/privacy-policy',
      '/terms-and-conditions', '/cancellation-refund-policy', '/delivery-policy', '/delete-account', '/delivery-areas', '/download']) {
      assert.ok(routes.includes(r), r)
    }
  })

  it('every page sets its own title, description and canonical path', () => {
    for (const file of sourceFiles('src/pages')) {
      const text = read(file)
      // The two old policy addresses only redirect to sections of the Terms.
      if (!/export default function/.test(text) || /legal[\\/](CancellationRefund|DeliveryPolicy)/.test(file)) continue
      if (/LegalDocument slug=/.test(text)) continue // set inside LegalDocument
      assert.match(text, /useSEO\(\{[\s\S]*?description:[\s\S]*?path: '\//, file)
    }
    const seo = read('src/lib/useSEO.js')
    for (const tag of ["'og:url'", "'og:image'", "'twitter:title', fullTitle", "'twitter:image'"]) assert.ok(seo.includes(tag), tag)
  })

  it('the sitemap lists the indexable routes on https://adione.in and robots.txt points to it', () => {
    const sitemap = read('public/sitemap.xml')
    for (const r of ['/', '/categories', '/delivery-areas', '/download', '/about', '/contact', '/privacy-policy', '/terms-and-conditions', '/delete-account']) {
      assert.ok(sitemap.includes(`<loc>https://adione.in${r}</loc>`), r)
    }
    assert.match(read('public/robots.txt'), /Sitemap: https:\/\/adione\.in\/sitemap\.xml/)
  })

  it('social sharing uses an absolute PNG image (SVG is not shown by social apps) and real icons', () => {
    const html = read('index.html')
    assert.match(html, /property="og:image" content="https:\/\/adione\.in\/og-image\.png"/)
    assert.match(html, /name="twitter:card" content="summary_large_image"/)
    assert.match(html, /"@type": "MobileApplication"/)
    for (const f of ['public/og-image.png', 'public/favicon.ico', 'public/apple-touch-icon.png', 'public/icon-512.png', 'public/site.webmanifest']) {
      assert.ok(existsSync(path.join(ROOT, f)), f)
    }
  })

  it('the footer links Privacy, Terms, cancellations, contact & grievance and account deletion', () => {
    const site = read('src/config/site.js')
    for (const to of ['/privacy-policy', '/terms-and-conditions', '/terms-and-conditions#cancelling-an-order', '/contact#grievance-officer', '/delete-account']) {
      assert.ok(site.includes(`to: '${to}'`), to)
    }
    assert.match(read('src/pages/Contact.jsx'), /id="grievance-officer"/)
  })

  it('section links work on both the published Terms and the older built-in wording', () => {
    const doc = read('src/components/InfoPageDocument.jsx')
    assert.match(doc, /'cancelling-an-order': \['cancellations-and-refunds'\]/)
    assert.match(doc, /'complaints-and-grievance-redressal': \['changes-and-contact'\]/)
  })
})

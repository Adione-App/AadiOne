// The website's legal, About and contact pages read the published content and
// the business details from the Aadione API — never a copy kept in this site.
// Run: node --test tests/  (from aadione-website/)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

function sourceFiles(dir) {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name)
    if (statSync(path.join(ROOT, rel)).isDirectory()) return rel.endsWith('shared') ? [] : sourceFiles(rel)
    return /\.(jsx?|tsx?)$/.test(name) ? [rel] : []
  })
}

describe('one source for legal and contact content', () => {
  it('no contact detail, legal date or delivery number is written into the site', () => {
    for (const file of sourceFiles('src')) {
      const text = read(file)
      assert.doesNotMatch(text, /@gmail\.com|adione\.app@|\+91\s?\d{5}|97760|Dhan Mandi/, file)
      assert.doesNotMatch(text, /legalDates|deliveryRadiusKm|freeDeliveryThreshold|Last updated: \{/, file)
    }
  })

  it('Privacy, Terms and About render the published API pages', () => {
    assert.match(read('src/pages/legal/PrivacyPolicy.jsx'), /<LegalDocument slug="privacy"/)
    assert.match(read('src/pages/legal/Terms.jsx'), /<LegalDocument slug="terms"/)
    assert.match(read('src/pages/About.jsx'), /useInfoPage\('about'\)/)
    assert.match(read('src/lib/publicApi.js'), /`\/legal\/\$\{slug\}`/)
    assert.match(read('src/lib/publicApi.js'), /'\/legal\/business'/)
  })

  it('the old policy addresses still work and lead to the Terms sections', () => {
    assert.match(read('src/pages/legal/CancellationRefund.jsx'), /\/terms-and-conditions#cancelling-an-order/)
    assert.match(read('src/pages/legal/DeliveryPolicy.jsx'), /\/terms-and-conditions#delivery-area-charges-and-timing/)
    const app = read('src/App.jsx')
    for (const route of ['/privacy-policy', '/terms-and-conditions', '/cancellation-refund-policy', '/delivery-policy', '/about', '/delete-account']) {
      assert.ok(app.includes(`path="${route}"`), route)
    }
  })

  it('the contact form never claims a message was sent', () => {
    const contact = read('src/pages/Contact.jsx')
    assert.doesNotMatch(contact, /Message Sent|setTimeout/)
    assert.match(contact, /mailto:\$\{support\.email\}\?subject=/)
  })

  it('links in page text come only from the shared link rules', () => {
    assert.match(read('src/components/InfoPageDocument.jsx'), /infoTextSegments\(text\)/)
    assert.doesNotMatch(read('src/components/InfoPageDocument.jsx'), /dangerouslySetInnerHTML/)
  })
})

describe('delete account', () => {
  const form = read('src/components/DeleteAccountForm.jsx')
  const page = read('src/pages/DeleteAccount.jsx')

  it('uses the app\'s own OTP sign-in and deletion, and handles an expired verification', () => {
    assert.match(form, /callApi\('\/auth\/send-otp'/)
    assert.match(form, /callApi\('\/auth\/verify-otp'/)
    assert.match(form, /callApi\('\/auth\/me', \{ method: 'DELETE'/)
    assert.match(form, /err\.status === 401/)
  })

  it('removes the empty account a verification creates for an unknown number', () => {
    assert.match(form, /if \(data\.user\?\.isNewUser\) \{[\s\S]*method: 'DELETE'/)
  })

  it('never claims records are anonymised; says what is kept', () => {
    assert.doesNotMatch(form + page, /anonymi[sz]ed/i)
    assert.match(page, /Records of past orders, payments and refunds/)
  })
})

// Behaviour of the website's working parts, with the network replaced by a
// fake: account deletion calls, public data loading, the delivery rule and
// the business-detail checks. No request leaves the machine.
// Run: npm test  (from aadione-website/)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { callApi, deleteAccount, fallbackMessage, isValidMobile, isValidOtp, sendOtp, verifyOtp } from '../src/lib/accountApi.js'
import { fetchPublic } from '../src/lib/publicApi.js'
import { checkDelivery, deliveryMessage, isPinFormat, villagesForPin } from '../src/lib/delivery.js'
import { isProfileUrl, officialSocials } from '../src/lib/business.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** A fetch that answers once with `status`/`body` and records the request. */
function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init })
    return { status, ok: status >= 200 && status < 300, json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body) }
  }
}

describe('account deletion — API calls', () => {
  it('validates the mobile number and OTP format before any request', () => {
    assert.equal(isValidMobile('9876543210'), true)
    for (const bad of ['', '12345', '5876543210', '98765432101', 'abcdefghij']) assert.equal(isValidMobile(bad), false, bad)
    assert.equal(isValidOtp('123456'), true)
    assert.equal(isValidOtp('12a456'), false)
  })

  it('sends the OTP request to the real endpoint with only the number', async () => {
    const calls = []
    await sendOtp(' 9876543210 ', { fetchImpl: fakeFetch(200, { success: true, data: { resendAfterSeconds: 30 } }, calls) })
    assert.match(calls[0].url, /\/auth\/send-otp$/)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { mobile: '9876543210' })
  })

  it('keeps only the access token and new-account flag from verification — never a dev OTP or the profile', async () => {
    const out = await verifyOtp('9876543210', '123456', {
      fetchImpl: fakeFetch(200, { success: true, data: { devOtp: '999999', user: { isNewUser: false, fullName: 'X' }, tokens: { accessToken: 'a', refreshToken: 'r' } } }),
    })
    assert.deepEqual(out, { accessToken: 'a', isNewUser: false })
    for (const file of ['src/components/DeleteAccountForm.jsx', 'src/lib/accountApi.js']) {
      assert.doesNotMatch(read(file), /devOtp|console\.(log|info|debug)|localStorage|sessionStorage/, file)
    }
  })

  it('deletes with the verified token only, and treats 204 as the confirmation', async () => {
    const calls = []
    assert.equal(await deleteAccount('tok', { fetchImpl: fakeFetch(204, undefined, calls) }), null)
    assert.equal(calls[0].init.method, 'DELETE')
    assert.match(calls[0].url, /\/auth\/me$/)
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  })

  it("shows the server's own message for a refused request (invalid OTP, order in progress, rate limit)", async () => {
    for (const [status, code, message] of [
      [400, 'OTP_INVALID', 'The OTP you entered is incorrect. 4 attempts remaining.'],
      [400, 'VALIDATION_ERROR', 'You have an order in progress. Please wait until it is delivered or cancelled before deleting your account.'],
      [429, 'RATE_LIMITED', 'Too many OTP requests. Try again later.'],
    ]) {
      await assert.rejects(callApi('/x', { fetchImpl: fakeFetch(status, { success: false, error: { code, message } }) }), (e) => e.status === status && e.code === code && e.message === message)
    }
  })

  it('explains 401, 403, 404, 429 and 500 when the server sent no message', async () => {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      await assert.rejects(callApi('/x', { fetchImpl: fakeFetch(status, undefined) }), (e) => e.status === status && e.message === fallbackMessage(status))
    }
    assert.match(fallbackMessage(401), /verification has expired/)
    assert.match(fallbackMessage(429), /Too many attempts/)
  })

  it('a blocked request (offline or CORS) or a timeout never looks like a server answer', async () => {
    await assert.rejects(callApi('/x', { fetchImpl: async () => { throw new TypeError('Failed to fetch') } }), (e) => e.status === 0 && /could not be reached/.test(e.message))
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await assert.rejects(callApi('/x', { fetchImpl: hang, timeoutMs: 20 }), (e) => e.status === 408)
  })

  it('the form shows success only after the server confirmed, guards against double requests, and explains what is kept', () => {
    const form = read('src/components/DeleteAccountForm.jsx')
    assert.match(form, /await deleteAccount\(accessToken\)[\s\S]*?setStep\(STEP\.SUCCESS\)/)
    assert.match(form, /if \(busy\.current\) return/)
    assert.match(form, /type="checkbox"[\s\S]*?checked=\{confirmed\}/)
    assert.match(form, /disabled=\{!confirmed \|\| loading\}/)
    assert.match(read('src/pages/DeleteAccount.jsx'), /Records of past orders, payments and refunds/)
  })
})

describe('public data loading', () => {
  it('returns the data, null for "not published" (404), and an error with its status otherwise', async () => {
    assert.deepEqual(await fetchPublic('/categories', { fetchImpl: fakeFetch(200, { success: true, data: [1] }) }), [1])
    assert.equal(await fetchPublic('/legal/about', { fetchImpl: fakeFetch(404, { success: false }) }), null)
    await assert.rejects(fetchPublic('/x', { fetchImpl: fakeFetch(500, { success: false, error: { message: 'boom' } }) }), (e) => e.status === 500)
    await assert.rejects(fetchPublic('/x', { fetchImpl: fakeFetch(403, undefined) }), (e) => e.status === 403)
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await assert.rejects(fetchPublic('/x', { fetchImpl: hang, timeoutMs: 20 }), (e) => e.status === 408)
  })
})

describe('delivery checker — the server rule', () => {
  const villages = [
    { village: 'Railmagra', pincodes: ['313329'] },
    { village: 'Kuraj', pincodes: ['313328'] },
    { village: 'Dariba', pincodes: ['313211'] },
  ]

  it('delivers only to an approved village WITH its own PIN', () => {
    assert.equal(checkDelivery(villages, 'Railmagra', '313329').verdict, 'APPROVED')
    assert.equal(checkDelivery(villages, '  railmagra ', '313329').verdict, 'APPROVED') // case and spacing aside
    assert.equal(checkDelivery(villages, 'Railmagra', '313328').verdict, 'PIN_MISMATCH') // a nearby village's PIN is not enough
    assert.equal(checkDelivery(villages, 'Rajsamand', '313326').verdict, 'VILLAGE_NOT_APPROVED') // geographically near, not approved
    assert.equal(checkDelivery(villages, 'Railmagra', '').verdict, 'MISSING')
    assert.equal(checkDelivery(villages, 'Railmagra', '31332').verdict, 'INVALID_PIN')
    assert.equal(checkDelivery(villages, 'Railmagra', '013329').verdict, 'INVALID_PIN')
  })

  it('a PIN alone only hints at villages; it never says "delivered"', () => {
    assert.deepEqual(villagesForPin(villages, '313329'), ['Railmagra'])
    assert.deepEqual(villagesForPin(villages, '110001'), [])
    assert.equal(isPinFormat('313329'), true)
    assert.equal(isPinFormat('3133'), false)
  })

  it('says why, in the app’s words', () => {
    assert.match(deliveryMessage(checkDelivery(villages, 'Railmagra', '313328'), 'Railmagra', '313328'), /only with its own PIN code \(313329\)/)
    assert.match(deliveryMessage(checkDelivery(villages, 'Delhi', '110001'), 'Delhi', '110001'), /not delivering to Delhi 110001 yet/)
    assert.match(deliveryMessage(checkDelivery(villages, 'Kuraj', '313328'), 'Kuraj', '313328'), /^Yes — Aadione delivers to Kuraj/)
  })

  it('the checker reads the live approved list, not a radius or a typed list', () => {
    const ui = read('src/components/DeliveryAreas.jsx')
    assert.match(ui, /useDeliveryAreas\(\)/)
    assert.doesNotMatch(ui + read('src/lib/delivery.js'), /\bkm\b|radius|haversine|latitude/i)
  })
})

describe('business details', () => {
  it('a social link is shown only when it is a profile page on that network', () => {
    assert.equal(isProfileUrl('instagram', 'https://www.instagram.com/aadione.app/'), true)
    assert.equal(isProfileUrl('instagram', 'https://www.instagram.com/p/DfeZ89oTfMr/'), false) // one post
    assert.equal(isProfileUrl('instagram', 'https://www.instagram.com/reel/abc/'), false)
    assert.equal(isProfileUrl('instagram', 'http://www.instagram.com/aadione/'), false) // not https
    assert.equal(isProfileUrl('instagram', 'https://evil.example/instagram.com/aadione'), false)
    assert.equal(isProfileUrl('facebook', 'https://www.facebook.com/aadione'), true)
    assert.equal(isProfileUrl('x', 'https://x.com/aadione/status/1'), false)
    assert.equal(isProfileUrl('youtube', 'https://www.youtube.com/watch?v=1'), false)
    assert.deepEqual(officialSocials([{ network: 'instagram', url: 'https://www.instagram.com/p/x/' }, { network: 'facebook', url: 'https://facebook.com/aadione' }]).map((s) => s.network), ['facebook'])
    for (const file of ['src/components/Footer.jsx', 'src/components/StructuredData.jsx']) assert.match(read(file), /officialSocials\(/, file)
  })
})

describe('routes', () => {
  const app = read('src/App.jsx')
  it('short addresses redirect to the canonical legal and deletion pages', () => {
    assert.match(app, /path="\/privacy" element=\{<Navigate to="\/privacy-policy" replace \/>\}/)
    assert.match(app, /path="\/terms" element=\{<Navigate to="\/terms-and-conditions" replace \/>\}/)
    assert.match(app, /path="\/account-deletion" element=\{<Navigate to="\/delete-account" replace \/>\}/)
    assert.match(app, /path="\*" element=\{<NotFound \/>\}/)
    assert.match(read('src/pages/NotFound.jsx'), /noindex: true/)
  })

  it('no link points to localhost, an old domain or an empty address', () => {
    const files = ['src/config/site.js', 'src/components/Footer.jsx', 'src/components/Navbar.jsx', 'src/pages/Home.jsx', 'src/pages/Contact.jsx', 'index.html', 'public/sitemap.xml']
    for (const f of files) assert.doesNotMatch(read(f), /localhost|127\.0\.0\.1|href=""|to=""|adione\.app\/|aadione\.com/, f)
  })
})

describe('phone and WhatsApp links from Admin values', async () => {
  const { phoneHref, whatsappLink } = await import('../src/lib/business.js')
  it('a 10-digit Indian mobile dials with +91; WhatsApp gets the country code', () => {
    assert.equal(phoneHref('9876543210'), 'tel:+919876543210')
    assert.equal(phoneHref('+91 98765 43210'), 'tel:+919876543210')
    assert.equal(phoneHref('0294-2412345'), 'tel:02942412345') // landline: digits as written
    assert.equal(whatsappLink('9876543210'), 'https://wa.me/919876543210')
    assert.equal(whatsappLink('+91-98765-43210'), 'https://wa.me/919876543210')
  })
  it('an empty or malformed value gets no link at all', () => {
    for (const bad of [null, undefined, '', 'call us', '12345']) {
      assert.equal(phoneHref(bad), null, String(bad))
      assert.equal(whatsappLink(bad), null, String(bad))
    }
    assert.equal(whatsappLink('0294-2412345'), null) // a landline is not a WhatsApp number
  })
})

describe('WhatsApp link from the Admin value', async () => {
  const { whatsappLink } = await import('../src/lib/business.js')
  it('"91" appears exactly once however the Admin value is written', () => {
    for (const value of ['9776029985', '+91 9776029985', '+91-97760-29985', '919776029985', ' 97760 29985 ']) {
      const link = whatsappLink(value)
      assert.equal(link, 'https://wa.me/919776029985', value)
      assert.equal(link.match(/91/g).length, 1, value) // the number itself has no "91": the country code appears exactly once
    }
  })
})

describe('the official Instagram profile', async () => {
  const { isProfileUrl } = await import('../src/lib/business.js')
  it('https://www.instagram.com/aadione.in/ is shown once saved in Admin; the post URL never is', () => {
    assert.equal(isProfileUrl('instagram', 'https://www.instagram.com/aadione.in/'), true)
    assert.equal(isProfileUrl('instagram', 'https://www.instagram.com/p/DfeZ89oTfMr/'), false)
  })
})

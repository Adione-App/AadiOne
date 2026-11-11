import { useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, Phone, ShieldCheck, RotateCcw } from 'lucide-react'
import Button from './Button'
import { deleteAccount, isValidMobile, isValidOtp, sendOtp, verifyOtp } from '../lib/accountApi'

const STEP = { MOBILE: 'mobile', OTP: 'otp', CONFIRM: 'confirm', SUCCESS: 'success' }

export default function DeleteAccountForm() {
  const [step, setStep] = useState(STEP.MOBILE)
  const [mobile, setMobile] = useState('')
  const [otp, setOtp] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [isNewUser, setIsNewUser] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendIn, setResendIn] = useState(0)
  const timerRef = useRef(null)
  // A second tap (or Enter) while a request is in flight never sends it again —
  // React state alone can lag a fast double tap.
  const busy = useRef(false)

  const mobileValid = isValidMobile(mobile)
  const otpValid = isValidOtp(otp)

  useEffect(() => {
    if (resendIn <= 0) return undefined
    timerRef.current = setInterval(() => setResendIn((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(timerRef.current)
  }, [resendIn])

  async function run(task) {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    try {
      await task()
    } catch (err) {
      setError(err.message)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }

  function requestOtp(e) {
    e?.preventDefault()
    if (!mobileValid) return
    return run(async () => {
      const data = await sendOtp(mobile)
      setResendIn(Math.max(30, data?.resendAfterSeconds ?? 30))
      setOtp('')
      setStep(STEP.OTP)
    })
  }

  function checkOtp(e) {
    e.preventDefault()
    if (!otpValid) return
    return run(async () => {
      const { accessToken: token, isNewUser: created } = await verifyOtp(mobile, otp)
      if (!token) throw new Error('Verification did not complete. Please try again.')
      if (created) {
        // Verifying a number with no account (or one already deleted) signs it
        // up — the app's sign-in has no separate sign-up step. There was nothing
        // to delete, so the empty account just created is removed at once with
        // the same deletion; nothing else is touched.
        await deleteAccount(token).catch(() => undefined)
        setIsNewUser(true)
        setStep(STEP.SUCCESS)
        return
      }
      setAccessToken(token)
      setIsNewUser(false)
      setConfirmed(false)
      setStep(STEP.CONFIRM)
    })
  }

  function confirmDelete(e) {
    e.preventDefault()
    if (!confirmed || !accessToken) return
    return run(async () => {
      try {
        await deleteAccount(accessToken)
      } catch (err) {
        if (err.status === 401) {
          // The verification is valid for a short time only.
          setAccessToken('')
          setOtp('')
          setConfirmed(false)
          setStep(STEP.MOBILE)
        }
        throw err
      }
      // Success is shown only after the server answered 204 No Content.
      setAccessToken('')
      setStep(STEP.SUCCESS)
    })
  }

  function changeNumber() {
    setStep(STEP.MOBILE)
    setOtp('')
    setAccessToken('')
    setError('')
  }

  if (step === STEP.SUCCESS) {
    return (
      <div role="status" className="rounded-3xl border border-leaf-100 bg-leaf-50 p-8 text-center">
        <CheckCircle2 size={40} className="mx-auto text-leaf-700" aria-hidden="true" />
        {/* role=status: read out once the server has confirmed. */}
        <h2 className="mt-4 font-display text-xl font-semibold text-ink">
          {isNewUser ? 'No account found' : 'Account deleted'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-light/75">
          {isNewUser
            ? 'This mobile number was verified, but it has no Aadione account (it may already have been deleted). Nothing was deleted.'
            : 'Your Aadione account has been deleted and you have been signed out everywhere. Records of past orders, payments and refunds are kept as described on this page and in our Privacy Policy.'}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-leaf-100 bg-white p-6 sm:p-8">
      <Steps current={step} />

      {step === STEP.MOBILE && (
        <form onSubmit={requestOtp} className="mt-6" noValidate>
          <label htmlFor="mobile" className="mb-1.5 block text-sm font-medium text-ink">
            Registered mobile number
          </label>
          <div className="flex items-center gap-2 rounded-2xl border border-leaf-200 bg-cream px-4 py-3 focus-within:border-leaf-500">
            <Phone size={16} className="text-ink-light/60" aria-hidden="true" />
            <input
              id="mobile"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="Enter your registered mobile number"
              value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-light/40"
              required
            />
          </div>
          {mobile.length > 0 && !mobileValid && (
            <p className="mt-1.5 text-xs text-red-600">
              Enter the 10-digit mobile number registered on your Aadione account.
            </p>
          )}

          <p className="mt-5 text-sm leading-relaxed text-ink-light/70">
            We&rsquo;ll send a one-time password (OTP) to this number to verify it&rsquo;s really
            you — the same verification used to sign in to the Aadione app.
          </p>

          <ErrorBox message={error} />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={!mobileValid || loading}
            icon={loading ? Loader2 : undefined}
            iconClassName={loading ? 'animate-spin' : ''}
            className={`mt-6 w-full ${!mobileValid || loading ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {loading ? 'Sending OTP…' : 'Send OTP'}
          </Button>
        </form>
      )}

      {step === STEP.OTP && (
        <form onSubmit={checkOtp} className="mt-6" noValidate>
          <p className="text-sm text-ink-light/70">
            Enter the OTP sent to <span className="font-medium text-ink">{mobile}</span>.
          </p>

          <label htmlFor="otp" className="mb-1.5 mt-4 block text-sm font-medium text-ink">
            One-time password
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Enter OTP"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))}
            className="w-full rounded-2xl border border-leaf-200 bg-cream px-4 py-3 text-center text-lg tracking-[0.4em] text-ink outline-none focus:border-leaf-500"
            required
          />

          <div className="mt-3 flex items-center justify-between text-xs text-ink-light/60">
            <button type="button" onClick={changeNumber} className="underline underline-offset-2 hover:text-ink">
              Change number
            </button>
            <button
              type="button"
              onClick={requestOtp}
              disabled={resendIn > 0 || loading}
              className="flex items-center gap-1.5 underline underline-offset-2 hover:text-ink disabled:no-underline disabled:opacity-50"
            >
              <RotateCcw size={12} />
              {resendIn > 0 ? `Resend OTP in ${resendIn}s` : 'Resend OTP'}
            </button>
          </div>

          <ErrorBox message={error} />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={!otpValid || loading}
            icon={loading ? Loader2 : undefined}
            iconClassName={loading ? 'animate-spin' : ''}
            className={`mt-6 w-full ${!otpValid || loading ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {loading ? 'Verifying…' : 'Verify OTP'}
          </Button>
        </form>
      )}

      {step === STEP.CONFIRM && (
        <form onSubmit={confirmDelete} className="mt-6" noValidate>
          <div className="flex items-center gap-2 rounded-2xl bg-leaf-50 px-4 py-3 text-sm font-medium text-leaf-800">
            <ShieldCheck size={18} aria-hidden="true" />
            Mobile number verified
          </div>

          <div className="mt-5 rounded-2xl bg-red-50 p-4 text-sm leading-relaxed text-red-800">
            Account deletion is permanent and cannot be undone. An account with an order still in
            progress cannot be deleted until that order is delivered or cancelled. Records of past
            orders, payments and refunds are kept, as described on this page.
          </div>

          <label className="mt-5 flex items-start gap-3 text-sm text-ink-light/80">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-leaf-300 text-leaf-700 focus:ring-leaf-500"
              required
            />
            <span>I understand that account deletion is permanent and I want to proceed.</span>
          </label>

          <ErrorBox message={error} />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={!confirmed || loading}
            icon={loading ? Loader2 : undefined}
            iconClassName={loading ? 'animate-spin' : ''}
            className={`mt-6 w-full ${!confirmed || loading ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            {loading ? 'Deleting account…' : 'Delete My Account'}
          </Button>
        </form>
      )}
    </div>
  )
}

function Steps({ current }) {
  const items = [
    { key: STEP.MOBILE, label: 'Mobile number' },
    { key: STEP.OTP, label: 'Verify OTP' },
    { key: STEP.CONFIRM, label: 'Confirm' },
  ]
  const currentIndex = items.findIndex((i) => i.key === current)

  return (
    <div className="flex items-center gap-2 text-xs font-medium text-ink-light/50">
      {items.map((item, i) => (
        <span key={item.key} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full ${
              i <= currentIndex ? 'bg-leaf-700 text-white' : 'bg-leaf-50 text-ink-light/50'
            }`}
          >
            {i + 1}
          </span>
          <span className={i <= currentIndex ? 'text-ink' : ''}>{item.label}</span>
          {i < items.length - 1 && <span className="mx-1 h-px w-4 bg-leaf-100" />}
        </span>
      ))}
    </div>
  )
}

function ErrorBox({ message }) {
  if (!message) return null
  return (
    <div role="alert" className="mt-5 flex items-start gap-2.5 rounded-2xl bg-red-50 p-4 text-sm text-red-700">
      <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

/**
 * Seller sign-in (Aadione Partner Portal, Seller tab). Sellers never register
 * themselves: Aadione creates the seller and issues the owner a login email +
 * temporary password (Admin → Seller → Overview → Seller login). That email +
 * password is the primary sign-in here (POST /auth/seller/login — the server
 * checks the account's seller role and membership). The mobile-OTP sign-in
 * (/auth/send-otp + /auth/verify-otp) stays available for accounts not issued
 * a password yet.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorBanner } from '@/components/ui';
import { LoginInput, PartnerLoginLayout, PasswordInput, SubmitButton } from '@/components/PartnerLogin';
import { sellerErrorMessage } from '../sellerApi';
import { useSellerAuth } from '../sellerAuth';

const linkClass = 'font-semibold text-brand-600 hover:text-brand-700 disabled:text-gray-400';

export default function SellerLoginPage() {
  const sendOtp = useSellerAuth((state) => state.sendOtp);
  const verifyOtp = useSellerAuth((state) => state.verifyOtp);
  const passwordLogin = useSellerAuth((state) => state.passwordLogin);
  const navigate = useNavigate();

  const [method, setMethod] = useState<'password' | 'otp'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'mobile' | 'otp'>('mobile');
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState('');
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  async function requestOtp(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendOtp(mobile.trim());
      setStep('otp');
      setResendIn(result.resendAfterSeconds);
      setDevOtp(result.devOtp ?? null);
      if (result.devOtp) setOtp(result.devOtp);
    } catch (err) {
      setError(sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleMobile(event: FormEvent): Promise<void> {
    event.preventDefault();
    await requestOtp();
  }

  async function handlePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await passwordLogin(email.trim(), password);
      // SellerApp redirects to the dashboard once the session is set.
    } catch (err) {
      // One identical message for every failure: wrong password, unknown
      // email, or an account that is not an active seller.
      setError(err instanceof Error ? err.message : sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function switchMethod(next: 'password' | 'otp'): void {
    setMethod(next);
    setError(null);
  }

  async function handleOtp(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(mobile.trim(), otp.trim());
      // SellerApp redirects to the dashboard once the session is set.
    } catch (err) {
      setError(err instanceof Error ? err.message : sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const subtitle =
    method === 'password'
      ? 'Sign in with the email and password Aadione gave you.'
      : step === 'mobile'
        ? 'Enter the mobile number registered with Aadione.'
        : `Enter the 6-digit OTP sent to ${mobile}.`;

  return (
    <PartnerLoginLayout
      role="seller"
      // Choosing Admin returns to the admin sign-in (its own session).
      onRoleChange={() => navigate('/')}
      title="Seller Sign In"
      subtitle={subtitle}
    >
      <div className="space-y-5">
        <ErrorBanner message={error} />

        {method === 'password' ? (
          <form onSubmit={(event) => void handlePassword(event)} className="space-y-5">
            <LoginInput
              label="Email Address"
              icon="mail"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourstore.in"
              autoComplete="username"
              autoFocus
              required
            />
            <PasswordInput
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
            <div className="pt-1">
              <SubmitButton busy={busy} busyLabel="Signing in…" disabled={!email.trim() || !password}>
                Sign In
              </SubmitButton>
            </div>
            <p className="text-center text-sm text-gray-500">
              New seller? Aadione sets up your account and sends your login.{' '}
              <button type="button" onClick={() => switchMethod('otp')} className={linkClass}>
                Sign in with mobile OTP instead
              </button>
            </p>
          </form>
        ) : step === 'mobile' ? (
          <form onSubmit={(event) => void handleMobile(event)} className="space-y-5">
            <LoginInput
              label="Mobile number"
              icon="phone"
              type="tel"
              inputMode="numeric"
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
              placeholder="10-digit mobile number"
              autoComplete="tel"
              autoFocus
              required
            />
            <div className="pt-1">
              <SubmitButton busy={busy} busyLabel="Sending OTP…" disabled={mobile.trim().length < 10}>
                Send OTP
              </SubmitButton>
            </div>
            <p className="text-center text-sm">
              <button type="button" onClick={() => switchMethod('password')} className={linkClass}>
                Sign in with email and password
              </button>
            </p>
          </form>
        ) : (
          <form onSubmit={(event) => void handleOtp(event)} className="space-y-5">
            <LoginInput
              label="OTP"
              icon="lock"
              {...(devOtp ? { hint: `Development OTP: ${devOtp}` } : {})}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
              className="tracking-[0.4em]"
              placeholder="••••••"
              autoComplete="one-time-code"
              autoFocus
              required
            />
            <div className="pt-1">
              <SubmitButton busy={busy} busyLabel="Verifying…" disabled={otp.trim().length !== 6}>
                Verify &amp; Sign In
              </SubmitButton>
            </div>
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => {
                  setStep('mobile');
                  setOtp('');
                  setDevOtp(null);
                  setError(null);
                }}
                className="font-medium text-gray-600 hover:text-gray-900"
              >
                Change number
              </button>
              <button type="button" disabled={busy || resendIn > 0} onClick={() => void requestOtp()} className={linkClass}>
                {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend OTP'}
              </button>
            </div>
          </form>
        )}
      </div>
    </PartnerLoginLayout>
  );
}

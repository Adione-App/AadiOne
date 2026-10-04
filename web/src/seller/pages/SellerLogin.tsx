/**
 * Seller sign-in (Aadione Partner Portal, Seller tab) — EMAIL + PASSWORD only
 * (POST /auth/seller/login; the server checks the account's seller role and
 * membership). There is no mobile/OTP sign-in for sellers. A forgotten
 * password is reset by the seller through "Forgot Password?" — an emailed,
 * single-use link (/seller/forgot-password). After sign-in the seller's
 * lifecycle decides what opens: the application/onboarding status, or — once
 * approved and verified — the full Seller Panel.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorBanner } from '@/components/ui';
import { LoginInput, PartnerLoginLayout, PasswordInput, SubmitButton } from '@/components/PartnerLogin';
import { sellerErrorMessage } from '../sellerApi';
import { useSellerAuth } from '../sellerAuth';

const linkClass = 'font-semibold text-brand-600 hover:text-brand-700';

export default function SellerLoginPage() {
  const passwordLogin = useSellerAuth((state) => state.passwordLogin);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await passwordLogin(email.trim(), password);
      // SellerApp redirects once the session is set.
    } catch (err) {
      // One identical message for every failure: wrong password, unknown
      // email, or an account that is not an active seller.
      setError(err instanceof Error ? err.message : sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PartnerLoginLayout
      role="seller"
      // Choosing Admin returns to the admin sign-in (its own session).
      onRoleChange={() => navigate('/')}
      title="Seller Sign In"
      subtitle="Sign in with your seller email and password."
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <ErrorBanner message={error} />
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
        <div className="space-y-2">
          <PasswordInput
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
            required
          />
          <p className="text-right text-sm">
            <Link to="/seller/forgot-password" className={linkClass}>
              Forgot Password?
            </Link>
          </p>
        </div>
        <SubmitButton busy={busy} busyLabel="Signing in…" disabled={!email.trim() || !password}>
          Sign In
        </SubmitButton>
        <p className="text-center text-sm text-gray-500">
          New to Aadione?{' '}
          <Link to="/seller/register" className={linkClass}>
            Apply to sell on Aadione
          </Link>
        </p>
      </form>
    </PartnerLoginLayout>
  );
}

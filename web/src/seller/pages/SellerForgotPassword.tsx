/**
 * Seller "Forgot Password?" (POST /auth/seller/forgot-password). The seller
 * enters its login email; the server answers the same way for every email —
 * this page never says whether an account exists — and emails an active
 * seller account a single-use link that expires. The link opens
 * /seller/reset-password, where the seller chooses its new password.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorBanner } from '@/components/ui';
import { LoginInput, PartnerLoginLayout, SubmitButton } from '@/components/PartnerLogin';
import { sellerErrorMessage } from '../sellerApi';
import { useSellerAuth } from '../sellerAuth';

const linkClass = 'font-semibold text-brand-600 hover:text-brand-700';

export default function SellerForgotPasswordPage() {
  const requestPasswordReset = useSellerAuth((state) => state.requestPasswordReset);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSent(await requestPasswordReset(email.trim()));
    } catch (err) {
      setError(sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PartnerLoginLayout
      role="seller"
      onRoleChange={() => navigate('/')}
      title="Forgot Password"
      subtitle="Enter the email you sign in with. We will email you a link to set a new password."
    >
      {sent ? (
        <div className="space-y-5">
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-3 text-sm text-brand-700">
            {sent}
          </div>
          <p className="text-sm text-gray-600">Didn’t get it? Check your spam folder, or request a new link in a few minutes.</p>
          <p className="text-center text-sm">
            <Link to="/seller/login" className={linkClass}>
              Back to Sign In
            </Link>
          </p>
        </div>
      ) : (
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
          <SubmitButton busy={busy} busyLabel="Sending…" disabled={!email.trim()}>
            Send Reset Link
          </SubmitButton>
          <p className="text-center text-sm">
            <Link to="/seller/login" className={linkClass}>
              Back to Sign In
            </Link>
          </p>
        </form>
      )}
    </PartnerLoginLayout>
  );
}

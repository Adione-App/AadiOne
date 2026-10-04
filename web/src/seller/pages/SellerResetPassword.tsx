/**
 * Seller password reset from the emailed link (/seller/reset-password?token=…,
 * POST /auth/seller/reset-password). The link works once and expires; the
 * server refuses anything else. On success every old session is signed out
 * and the seller signs in with the new password.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorBanner } from '@/components/ui';
import { PartnerLoginLayout, PasswordInput, SubmitButton } from '@/components/PartnerLogin';
import { sellerErrorMessage } from '../sellerApi';
import { useSellerAuth } from '../sellerAuth';

const linkClass = 'font-semibold text-brand-600 hover:text-brand-700';

/** Mirrors the backend password policy (auth.validation newPasswordSchema). */
function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain a letter.';
  if (!/\d/.test(password)) return 'Password must contain a number.';
  return null;
}

export default function SellerResetPasswordPage() {
  const resetPassword = useSellerAuth((state) => state.resetPassword);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const problem = passwordProblem(password) ?? (password !== confirm ? 'The two passwords do not match.' : null);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      setDone(await resetPassword(token, password));
      setPassword('');
      setConfirm('');
    } catch (err) {
      setError(sellerErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PartnerLoginLayout role="seller" onRoleChange={() => navigate('/')} title="Set a New Password" subtitle="Choose the password you will sign in with.">
      {done ? (
        <div className="space-y-5">
          <div role="status" className="rounded-xl border border-brand-500/30 bg-brand-50 px-3.5 py-3 text-sm text-brand-700">
            {done}
          </div>
          <Link
            to="/seller/login"
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-base font-semibold text-white outline-none transition hover:bg-brand-600 focus-visible:ring-4 focus-visible:ring-brand-200"
          >
            Go to Sign In
          </Link>
        </div>
      ) : !token ? (
        <div className="space-y-5">
          <ErrorBanner message="This reset link is incomplete. Request a new one from “Forgot Password?”." />
          <p className="text-center text-sm">
            <Link to="/seller/forgot-password" className={linkClass}>
              Request a new link
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
          <ErrorBanner message={error} />
          <PasswordInput
            label="New Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Min. 8 characters, letters + a number"
            autoComplete="new-password"
            autoFocus
            required
          />
          <PasswordInput
            label="Confirm New Password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="Type it again"
            autoComplete="new-password"
            required
          />
          <SubmitButton busy={busy} busyLabel="Saving…" disabled={!password || !confirm}>
            Set New Password
          </SubmitButton>
          <p className="text-center text-sm">
            <Link to="/seller/forgot-password" className={linkClass}>
              Request a new link
            </Link>
          </p>
        </form>
      )}
    </PartnerLoginLayout>
  );
}

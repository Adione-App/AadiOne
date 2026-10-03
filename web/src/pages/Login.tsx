import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ErrorBanner } from '@/components/ui';
import { LoginInput, PartnerLoginLayout, PasswordInput, SubmitButton } from '@/components/PartnerLogin';

/**
 * Admin sign-in (Aadione Partner Portal, Admin tab). The entered email and
 * password go only to POST /auth/admin/login via the admin auth store; there
 * is deliberately no password-reset link here.
 */
export default function LoginPage() {
  const login = useAuth((state) => state.login);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      // The server returns one identical message for every failure mode, so
      // this endpoint cannot be used to discover which staff emails exist.
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PartnerLoginLayout
      role="admin"
      // The seller sign-in is the seller panel's own page (its own session);
      // choosing Seller goes there.
      onRoleChange={() => navigate('/seller/login')}
      title="Sign In"
      subtitle="Enter your credentials to continue"
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <ErrorBanner message={error} />

        <LoginInput
          label="Email Address"
          icon="mail"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@aadione.in"
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
          <SubmitButton busy={busy} busyLabel="Signing in…">
            Sign In
          </SubmitButton>
        </div>
      </form>
    </PartnerLoginLayout>
  );
}

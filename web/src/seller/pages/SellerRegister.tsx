/**
 * Seller application (Aadione Partner Portal, Seller tab → "Apply to sell").
 *
 * Collects only what Aadione needs to decide the application (Gate 1): the
 * owner, their contact details and password, the business name and the
 * seller type. POST /auth/seller/signup creates an APPLICATION_PENDING seller
 * and signs the applicant in — they then see their application status, not
 * the Seller Panel. Everything else (address, location, bank, PAN, documents)
 * is collected in onboarding after approval. Commission is never asked for.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SellerType } from '@shared';
import { ErrorBanner, Icon, inputClass } from '@/components/ui';
import { LoginInput, PartnerLoginLayout, PasswordInput, SubmitButton } from '@/components/PartnerLogin';
import { SELLER_TYPE_LABEL } from '@/components/SellerBadges';
import { sellerErrorMessage } from '../sellerApi';
import { useSellerAuth } from '../sellerAuth';

const SELLER_TYPES = Object.values(SellerType);

interface FormState {
  fullName: string;
  mobile: string;
  email: string;
  password: string;
  confirm: string;
  businessName: string;
  sellerType: SellerType | '';
}

/** The same rules the server applies — checked here only to answer sooner. */
function problemWith(form: FormState): string | null {
  if (form.fullName.trim().length < 2) return 'Enter your full name.';
  if (!/^(\+?91)?0?[6-9]\d{9}$/.test(form.mobile.replace(/[\s-]/g, ''))) return 'Enter a valid 10-digit mobile number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Enter a valid email address.';
  if (form.password.length < 8 || !/[a-zA-Z]/.test(form.password) || !/\d/.test(form.password)) {
    return 'Choose a password of at least 8 characters with a letter and a number.';
  }
  if (form.password !== form.confirm) return 'The passwords do not match.';
  if (form.businessName.trim().length < 2) return 'Enter your business or store name.';
  if (!form.sellerType) return 'Choose your seller type.';
  return null;
}

export default function SellerRegisterPage() {
  const signup = useSellerAuth((state) => state.signup);
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>({
    fullName: '',
    mobile: '',
    email: '',
    password: '',
    confirm: '',
    businessName: '',
    sellerType: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K) => (value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const problem = problemWith(form);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await signup({
        fullName: form.fullName.trim(),
        mobile: form.mobile.trim(),
        email: form.email.trim(),
        password: form.password,
        businessName: form.businessName.trim(),
        sellerType: form.sellerType as SellerType,
      });
      // SellerApp shows the application status once the session is set.
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
      title="Apply to Sell"
      subtitle="Tell us about you and your business. Aadione reviews every application before onboarding."
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <ErrorBanner message={error} />
        <LoginInput
          label="Full name (owner)"
          icon="user"
          value={form.fullName}
          onChange={(e) => set('fullName')(e.target.value)}
          maxLength={120}
          autoComplete="name"
          autoFocus
          required
        />
        <LoginInput
          label="Mobile number"
          icon="phone"
          type="tel"
          inputMode="numeric"
          value={form.mobile}
          onChange={(e) => set('mobile')(e.target.value)}
          placeholder="10-digit mobile number"
          autoComplete="tel"
          required
        />
        <LoginInput
          label="Email address"
          icon="mail"
          type="email"
          value={form.email}
          onChange={(e) => set('email')(e.target.value)}
          placeholder="you@yourstore.in"
          autoComplete="email"
          maxLength={160}
          required
        />
        <PasswordInput
          value={form.password}
          onChange={(e) => set('password')(e.target.value)}
          placeholder="At least 8 characters, a letter and a number"
          autoComplete="new-password"
          required
        />
        <PasswordInput
          label="Confirm password"
          value={form.confirm}
          onChange={(e) => set('confirm')(e.target.value)}
          autoComplete="new-password"
          required
        />
        <LoginInput
          label="Business / store name"
          icon="store"
          value={form.businessName}
          onChange={(e) => set('businessName')(e.target.value)}
          maxLength={120}
          autoComplete="organization"
          required
        />
        <div>
          <label htmlFor="seller-type" className="mb-1.5 block text-sm font-medium text-gray-800">
            Seller type
          </label>
          <div className="relative">
            <Icon name="categories" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-gray-400" />
            <select
              id="seller-type"
              value={form.sellerType}
              onChange={(e) => set('sellerType')(e.target.value as SellerType | '')}
              className={`${inputClass} h-12 pl-11`}
              required
            >
              <option value="">Choose what you sell…</option>
              {SELLER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SELLER_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="pt-1">
          <SubmitButton busy={busy} busyLabel="Submitting application…">
            Submit Application
          </SubmitButton>
        </div>
        <p className="text-center text-sm text-gray-500">
          Already applied or selling on Aadione?{' '}
          <Link to="/seller/login" className="font-semibold text-brand-600 hover:text-brand-700">
            Sign in
          </Link>
        </p>
      </form>
    </PartnerLoginLayout>
  );
}

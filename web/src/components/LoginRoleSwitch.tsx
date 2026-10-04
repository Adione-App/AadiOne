/**
 * [ Admin ] [ Seller ] at the top of the web login.
 *
 * Purely a UX choice of WHICH sign-in to show: the admin form calls
 * /auth/admin/login, the seller form /auth/seller/login. No role value is
 * ever sent to the server or trusted — each endpoint checks the account's own
 * role (and, for sellers, an active seller membership). Sellers sign in with
 * email + password only (no OTP); they apply at /seller/register or are
 * created by Aadione, and reset a forgotten password themselves ("Forgot
 * Password?").
 */

import { Icon, type IconName } from '@/components/ui';

export type LoginRole = 'admin' | 'seller';

const OPTIONS: { value: LoginRole; label: string; icon: IconName }[] = [
  { value: 'admin', label: 'Admin', icon: 'shield' },
  { value: 'seller', label: 'Seller', icon: 'store' },
];

export function LoginRoleSwitch({
  value,
  onChange,
}: {
  value: LoginRole;
  onChange: (role: LoginRole) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Sign in as" className="grid grid-cols-2 gap-1 rounded-2xl bg-gray-100 p-1.5">
      {OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400 ${
              selected
                ? 'bg-brand-50 text-brand-600 shadow-sm ring-1 ring-brand-100'
                : 'text-gray-700 hover:bg-white/70 hover:text-gray-900'
            }`}
          >
            <Icon name={option.icon} className={`h-[18px] w-[18px] ${selected ? 'text-brand-500' : 'text-gray-600'}`} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

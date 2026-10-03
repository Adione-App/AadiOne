/**
 * Aadione Partner Portal — the shared look of the admin and seller sign-in
 * pages. Presentation only: each page keeps its own auth store, endpoint and
 * session (admin: pages/Login.tsx, seller: seller/pages/SellerLogin.tsx), and
 * the Admin/Seller switch still just navigates between those two pages.
 */

import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Icon, inputClass, type IconName } from '@/components/ui';
import { LoginRoleSwitch, type LoginRole } from '@/components/LoginRoleSwitch';

/* -------------------------------------------------------------------------- */
/* brand                                                                       */
/* -------------------------------------------------------------------------- */

function Leaf({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M21 2.5C11 2.5 4.5 7.6 4.5 14.8c0 2 .5 3.7 1.4 5 1.4-6.3 6-10.3 11-12.5-4.1 3-7.3 7-8.6 13 1 .4 2 .6 3.1.6 6.7 0 9.6-7.6 9.6-18.4z"
      />
    </svg>
  );
}

/**
 * "Aadione" with a leaf for the dot of the i. The visible glyphs are
 * aria-hidden (the i is a dotless ı) and the whole mark is labelled once.
 */
export function AadioneWordmark({ className = 'text-4xl' }: { className?: string }) {
  return (
    <span role="img" aria-label="Aadione" className={`inline-flex items-baseline font-bold leading-none tracking-tight ${className}`}>
      <span aria-hidden="true" className="text-gray-900">
        Aad
      </span>
      <span aria-hidden="true" className="relative text-brand-500">
        ı
        <Leaf className="absolute left-1/2 top-[-0.2em] h-[0.4em] w-[0.4em] -translate-x-[35%] text-brand-500" />
      </span>
      <span aria-hidden="true" className="text-brand-500">
        one
      </span>
    </span>
  );
}

function Brand({ align = 'left', size = 'text-4xl' }: { align?: 'left' | 'center'; size?: string }) {
  return (
    <div className={align === 'center' ? 'text-center' : ''}>
      <AadioneWordmark className={size} />
      <p className="mt-1.5 text-sm font-medium text-gray-500">Partner Portal</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* illustration                                                                */
/* -------------------------------------------------------------------------- */

const STRIPES = 8;

/**
 * Storefront, awning, shelves, scooter and greenery as one inline SVG (~4 KB)
 * instead of an image: flat colours, crisp at any size, nothing to download.
 */
function StorefrontIllustration({ className = '' }: { className?: string }) {
  const stripeW = 232 / STRIPES;
  return (
    // Scaled down to fit (never cropped), sitting on the bottom of its box.
    <svg viewBox="0 0 560 320" preserveAspectRatio="xMidYMax meet" className={className} aria-hidden="true">
      {/* skyline + clouds */}
      <g fill="#E3F3E7">
        <rect x="46" y="92" width="44" height="170" rx="4" />
        <rect x="96" y="128" width="30" height="134" rx="4" />
        <rect x="408" y="74" width="40" height="188" rx="4" />
        <rect x="454" y="116" width="52" height="146" rx="4" />
      </g>
      <g fill="#F4FBF6">
        {[108, 146, 184, 222].map((y) => (
          <g key={y}>
            <rect x="56" y={y} width="8" height="10" rx="1" />
            <rect x="72" y={y} width="8" height="10" rx="1" />
            <rect x="418" y={y - 12} width="8" height="10" rx="1" />
            <rect x="432" y={y - 12} width="8" height="10" rx="1" />
          </g>
        ))}
      </g>
      <g fill="#FFFFFF" opacity="0.95">
        <ellipse cx="150" cy="58" rx="30" ry="11" />
        <ellipse cx="170" cy="50" rx="18" ry="12" />
        <ellipse cx="470" cy="40" rx="24" ry="9" />
        <ellipse cx="486" cy="33" rx="14" ry="10" />
      </g>

      {/* ground: soft rounded mounds, no hard edges at the viewBox */}
      <ellipse cx="280" cy="290" rx="276" ry="22" fill="#DCF0E1" />
      <ellipse cx="300" cy="298" rx="220" ry="14" fill="#CBE8D3" />

      {/* trees */}
      <rect x="31" y="232" width="5" height="50" rx="2" fill="#6BAE7E" />
      <path d="M33 196c-12 16-16 34-10 50h20c6-16 2-34-10-50z" fill="#8ACB9B" />
      <rect x="535" y="232" width="6" height="52" rx="3" fill="#6BAE7E" />
      <circle cx="538" cy="216" r="20" fill="#A7D9B3" />
      <circle cx="526" cy="232" r="12" fill="#8ACB9B" />

      {/* map pin */}
      <path d="M126 176c-12 0-21 9-21 21 0 15 21 36 21 36s21-21 21-36c0-12-9-21-21-21z" fill="#1E8E3E" />
      <circle cx="126" cy="197" r="7.5" fill="#FFFFFF" />

      {/* plant */}
      <path d="M150 256h26l-4 24h-18z" fill="#E9A06A" />
      <path d="M163 256c-2-14-12-22-20-24 2 10 8 20 20 24zM163 256c2-16 10-26 20-28-2 12-8 22-20 28zM163 256c0-12 0-22 1-30 4 8 4 20-1 30z" fill="#4FB06C" />

      {/* shop */}
      <rect x="190" y="152" width="200" height="130" rx="6" fill="#FBF8F1" stroke="#E6E1D3" strokeWidth="2" />
      <rect x="180" y="130" width="220" height="26" rx="6" fill="#1E8E3E" />
      <rect x="226" y="92" width="128" height="42" rx="9" fill="#1E8E3E" stroke="#17762F" strokeWidth="2" />
      <text x="290" y="120" textAnchor="middle" fill="#FFFFFF" fontSize="21" fontWeight="700" fontFamily="Inter, system-ui, sans-serif">
        Aadione
      </text>
      {/* awning */}
      {Array.from({ length: STRIPES }, (_, index) => {
        const x = 174 + index * stripeW;
        return (
          <path
            key={index}
            d={`M${x} 156h${stripeW}v20a${stripeW / 2} 8 0 0 1 -${stripeW} 0z`}
            fill={index % 2 === 0 ? '#1E8E3E' : '#FFFFFF'}
            stroke="#17762F"
            strokeWidth="1"
          />
        );
      })}
      {/* window with shelves */}
      <rect x="204" y="198" width="76" height="72" rx="4" fill="#EAF6EE" stroke="#1E8E3E" strokeWidth="3" />
      <path d="M206 222h72M206 246h72" stroke="#B6E1C1" strokeWidth="3" />
      <g>
        <rect x="211" y="208" width="10" height="13" rx="2" fill="#4FB06C" />
        <rect x="224" y="211" width="12" height="10" rx="2" fill="#F2C166" />
        <rect x="239" y="207" width="9" height="14" rx="2" fill="#E9795F" />
        <rect x="251" y="210" width="12" height="11" rx="2" fill="#8ACB9B" />
        <rect x="211" y="233" width="13" height="12" rx="2" fill="#F2C166" />
        <rect x="227" y="231" width="9" height="14" rx="2" fill="#4FB06C" />
        <rect x="240" y="234" width="12" height="11" rx="2" fill="#E9795F" />
        <rect x="256" y="232" width="10" height="13" rx="2" fill="#4FB06C" />
        <rect x="213" y="256" width="14" height="12" rx="2" fill="#8ACB9B" />
        <rect x="231" y="255" width="10" height="13" rx="2" fill="#F2C166" />
        <rect x="246" y="257" width="14" height="11" rx="2" fill="#4FB06C" />
      </g>
      {/* door */}
      <rect x="294" y="198" width="52" height="84" rx="4" fill="#EAF6EE" stroke="#1E8E3E" strokeWidth="3" />
      <path d="M296 226h48M296 250h48" stroke="#B6E1C1" strokeWidth="2.5" />
      <circle cx="338" cy="244" r="2.5" fill="#1E8E3E" />
      <rect x="354" y="198" width="26" height="46" rx="4" fill="#EAF6EE" stroke="#1E8E3E" strokeWidth="3" />

      {/* boxes */}
      <rect x="392" y="252" width="34" height="30" rx="3" fill="#E8C79A" />
      <rect x="398" y="226" width="26" height="26" rx="3" fill="#EFD4AC" />
      <path d="M409 252v30M411 226v26" stroke="#D4AE78" strokeWidth="2" />

      {/* delivery scooter, facing right */}
      <g>
        {/* delivery box on the rack */}
        <rect x="430" y="216" width="38" height="32" rx="5" fill="#1E8E3E" />
        <path d="M442 239c0-8 6-13 13-14-1 8-6 13-13 14z" fill="#FFFFFF" />
        {/* rear body + seat */}
        <path d="M432 276c0-14 10-24 24-24h30l12 24z" fill="#1E8E3E" />
        <rect x="454" y="245" width="30" height="8" rx="4" fill="#2F3A33" />
        {/* floorboard + front shield */}
        <rect x="474" y="270" width="30" height="7" rx="3" fill="#17762F" />
        <path d="M494 277l13-42h9l-10 42z" fill="#1E8E3E" />
        {/* fork, handlebar, headlight */}
        <path d="M511 240l6 44" stroke="#2F3A33" strokeWidth="4" strokeLinecap="round" />
        <path d="M509 237l-2-9M501 227h14" stroke="#2F3A33" strokeWidth="4" strokeLinecap="round" />
        <circle cx="518" cy="243" r="3.5" fill="#F2C166" />
        {/* wheels */}
        <circle cx="450" cy="285" r="13" fill="#2F3A33" />
        <circle cx="450" cy="285" r="5" fill="#D1D5DB" />
        <circle cx="517" cy="285" r="13" fill="#2F3A33" />
        <circle cx="517" cy="285" r="5" fill="#D1D5DB" />
      </g>

      {/* floating leaf */}
      <path d="M530 118c-16 2-26 12-26 26 0 3 1 5 2 7 3-11 10-17 18-21-6 5-11 11-13 20 12-2 19-14 19-32z" fill="#4FB06C" opacity="0.85" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* form pieces                                                                 */
/* -------------------------------------------------------------------------- */

const fieldInput = `${inputClass} h-12 pl-11`;

/** A labelled input with a leading icon. Everything else is a plain input. */
export function LoginInput({
  label,
  icon,
  hint,
  ...input
}: { label: string; icon: IconName; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-800">
        {label}
      </label>
      <div className="relative">
        <Icon name={icon} className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-gray-400" />
        <input id={id} {...input} className={`${fieldInput} ${input.className ?? ''}`} />
      </div>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * Password input with a show/hide toggle. Hidden by default; the toggle only
 * flips the input's type on this page — the value is never shown or sent
 * anywhere else.
 */
export function PasswordInput({
  label = 'Password',
  ...input
}: { label?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-800">
        {label}
      </label>
      <div className="relative">
        <Icon name="lock" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-gray-400" />
        <input id={id} {...input} type={visible ? 'text' : 'password'} className={`${fieldInput} pr-12`} />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-gray-500 outline-none transition hover:bg-gray-100 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/** The large green submit. Disabled (and shows progress) while `busy`. */
export function SubmitButton({
  busy,
  busyLabel,
  disabled,
  children,
}: {
  busy: boolean;
  busyLabel: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      aria-busy={busy}
      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-base font-semibold text-white shadow-[0_10px_24px_-12px_rgba(30,142,62,0.8)] outline-none transition hover:bg-brand-600 focus-visible:ring-4 focus-visible:ring-brand-200 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? (
        <>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
          {busyLabel}
        </>
      ) : (
        <>
          {children}
          <Icon name="arrowRight" className="h-5 w-5" />
        </>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* layout                                                                      */
/* -------------------------------------------------------------------------- */

const FEATURES: { icon: IconName; line1: string; line2: string }[] = [
  { icon: 'box', line1: 'Manage', line2: 'Products' },
  { icon: 'clipboard', line1: 'Track', line2: 'Orders' },
  { icon: 'barChart', line1: 'Grow', line2: 'Your Business' },
];

const TRUST: { icon: IconName; line1: string; line2: string }[] = [
  { icon: 'shield', line1: 'Secure', line2: 'Access' },
  { icon: 'zap', line1: 'Fast &', line2: 'Reliable' },
  { icon: 'headset', line1: '24/7', line2: 'Support' },
];

export function PartnerLoginLayout({
  role,
  onRoleChange,
  title,
  subtitle,
  children,
}: {
  role: LoginRole;
  onRoleChange: (role: LoginRole) => void;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  // Desktop fits one viewport (the .partner-login rules in index.css): the
  // card takes the window height up to its natural 820px, the illustration
  // flexes, and each vertical gap shrinks by a share of --login-squeeze — full
  // size on a 900px-tall window, tightest at 720px.
  return (
    <div className="partner-login bg-brand-50 px-3 py-4 sm:px-6 sm:py-8 lg:flex lg:items-center lg:px-8 lg:py-[calc(40px_-_var(--login-squeeze)*0.156)]">
      <div className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-[28px] bg-white shadow-[0_24px_64px_-28px_rgba(18,92,37,0.35)] lg:h-[min(100%,820px)] lg:grid-cols-[1.08fr_1fr] lg:grid-rows-[minmax(0,1fr)]">
        {/* ---- hero: below the form on small screens, left on desktop ---- */}
        <section
          aria-label="About the Aadione Partner Portal"
          className="relative order-2 overflow-hidden bg-gradient-to-b from-[#F5FBF7] to-brand-50 px-6 pb-6 pt-8 sm:px-10 lg:order-1 lg:flex lg:min-h-0 lg:flex-col lg:px-12 lg:pb-[calc(24px_-_var(--login-squeeze)*0.044)] lg:pt-[calc(48px_-_var(--login-squeeze)*0.133)] xl:px-14"
        >
          {/* one soft shape, top right */}
          <svg viewBox="0 0 200 200" className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 text-brand-100/70" aria-hidden="true">
            <path fill="currentColor" d="M44 20c38-26 104-24 136 14s18 104-26 128-110 10-134-34S6 46 44 20z" />
          </svg>

          <div className="relative hidden lg:block">
            <Brand />
          </div>

          <h2 className="relative text-3xl font-bold leading-[1.1] tracking-tight text-gray-900 sm:text-4xl lg:mt-[calc(48px_-_var(--login-squeeze)*0.156)] xl:text-5xl">
            Manage Today
            <br />
            <span className="text-brand-500">Grow Tomorrow</span>
          </h2>
          <p className="relative mt-3 max-w-md text-sm text-gray-600 sm:text-base">
            Access your dashboard to manage your store, orders, products and more.
          </p>

          <ul className="relative mt-6 grid max-w-md grid-cols-3 gap-2 lg:mt-[calc(24px_-_var(--login-squeeze)*0.044)]">
            {FEATURES.map((feature) => (
              <li key={feature.line2} className="flex flex-col items-center text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-100 text-brand-500 sm:h-12 sm:w-12">
                  <Icon name={feature.icon} className="h-5 w-5 sm:h-6 sm:w-6" />
                </span>
                <span className="mt-2 text-xs font-medium leading-tight text-gray-700 sm:text-sm">
                  {feature.line1}
                  <br />
                  {feature.line2}
                </span>
              </li>
            ))}
          </ul>

          {/* Desktop: takes whatever height is left; the drawing scales to fit. */}
          <div className="relative mt-4 flex justify-center lg:mt-0 lg:min-h-0 lg:flex-1 lg:items-end lg:pt-[calc(24px_-_var(--login-squeeze)*0.089)]">
            <StorefrontIllustration className="h-auto w-full max-w-[300px] sm:max-w-[380px] lg:h-full lg:max-w-[520px]" />
          </div>

          <div className="relative mt-3 lg:mt-2">
            <p className="text-sm font-medium leading-snug text-gray-700">
              Reliable Partners
              <br />
              for a Better Tomorrow
            </p>
            <span className="mt-3 block h-0.5 w-10 rounded-full bg-brand-500" aria-hidden="true" />
          </div>
        </section>

        {/* ---- sign in ----------------------------------------------------- */}
        {/* Centred with auto margins, so a long error message on a short
            window scrolls this panel from the top instead of clipping it. */}
        <main className="relative z-10 order-1 flex items-center justify-center bg-white px-5 py-8 sm:px-10 sm:py-10 lg:order-2 lg:min-h-0 lg:overflow-y-auto lg:rounded-l-[28px] lg:px-12 lg:py-[calc(32px_-_var(--login-squeeze)*0.111)] lg:shadow-[-20px_0_48px_-30px_rgba(18,92,37,0.35)] xl:px-16">
          <div className="my-auto w-full max-w-md">
            <Brand align="center" size="text-4xl sm:text-5xl" />

            <div className="mt-7 lg:mt-[calc(28px_-_var(--login-squeeze)*0.067)]">
              <LoginRoleSwitch value={role} onChange={onRoleChange} />
            </div>

            <div className="mt-7 lg:mt-[calc(28px_-_var(--login-squeeze)*0.067)]">
              <h1 className="text-3xl font-bold tracking-tight text-gray-900">{title}</h1>
              <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
            </div>

            <div className="mt-6 lg:mt-[calc(24px_-_var(--login-squeeze)*0.056)]">{children}</div>

            <div className="mt-8 border-t border-gray-200 pt-6 lg:mt-[calc(32px_-_var(--login-squeeze)*0.089)] lg:pt-[calc(24px_-_var(--login-squeeze)*0.056)]">
              <ul className="grid grid-cols-3 divide-x divide-gray-200">
                {TRUST.map((item) => (
                  <li key={item.line2} className="flex items-center justify-center gap-2 px-1">
                    <Icon name={item.icon} className="h-6 w-6 shrink-0 text-brand-500" />
                    <span className="text-xs font-medium leading-tight text-gray-600">
                      {item.line1}
                      <br />
                      {item.line2}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

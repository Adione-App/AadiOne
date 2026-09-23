/**
 * Shared primitives for the admin panel.
 *
 * Everything here is hand-rolled rather than pulled from a component kit: the
 * panel needs about fifteen pieces, and a kit would cost more bundle than the
 * whole app currently ships.
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { OrderStatus, ORDER_STATUS_LABELS } from '@shared';
import { imageSrc } from '@/lib/image';

/* -------------------------------------------------------------------------- */
/* icons                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Inline 24px stroke icons. Inlined rather than installed because an icon
 * package would ship thousands of glyphs to render the twenty we use.
 */
export type IconName =
  | 'dashboard'
  | 'orders'
  | 'products'
  | 'categories'
  | 'inventory'
  | 'customers'
  | 'delivery'
  | 'config'
  | 'bell'
  | 'search'
  | 'filter'
  | 'calendar'
  | 'menu'
  | 'close'
  | 'plus'
  | 'edit'
  | 'trash'
  | 'chevronRight'
  | 'chevronDown'
  | 'upload'
  | 'image'
  | 'box'
  | 'alert'
  | 'rupee'
  | 'clock'
  | 'shield'
  | 'headset'
  | 'lock'
  | 'store'
  | 'phone'
  | 'pin'
  | 'user'
  | 'check'
  | 'gift';

const PATHS: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  orders: 'M8 2h8l1 4H7zM5 6h14l-1 15H6z',
  products: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8',
  categories: 'M4 6h2M9 6h11M4 12h2M9 12h11M4 18h2M9 18h11',
  inventory: 'M4 7h16v13H4zM4 7l2-4h12l2 4M9 12h6',
  customers: 'M16 20v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M21 20v-2a3 3 0 0 0-2-2.8',
  delivery: 'M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4M19 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4M7 16h10M3 8h7l3 8M14 8h3l3 5',
  config: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3H9.8l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  filter: 'M3 5h18M6 12h12M10 19h4',
  calendar: 'M3 6h18v15H3zM3 10h18M8 3v4M16 3v4',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  upload: 'M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  image: 'M3 5h18v14H3zM3 15l5-4 4 3 3-2 6 4',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  alert: 'M12 3l9 17H3zM12 9v5M12 17.5v.5',
  rupee: 'M7 4h10M7 9h10M15 4c0 4-3 5-6 5l7 10',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  headset: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1zM20 14h-3v5h2a1 1 0 0 0 1-1z',
  lock: 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 6 0v4',
  store: 'M4 10v10h16V10M3 4h18l1 5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM10 20v-6h4v6',
  phone: 'M21 16.5v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.2 4 2 2 0 0 1 3.2 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L7.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  check: 'M20 6L9 17l-5-5',
  gift: 'M3 8h18v4H3zM5 12h14v9H5zM12 8v13M12 8c-2-4-7-4-7 0h7zM12 8c2-4 7-4 7 0h-7z',
};

export function Icon({
  name,
  className = 'h-5 w-5',
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* surfaces                                                                    */
/* -------------------------------------------------------------------------- */

/** Bare surface with no padding — the base for anything that lays out its own. */
export function Surface({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-gray-200/80 bg-white shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/**
 * Padded surface. Kept padded by default because the pages written before the
 * redesign rely on it; anything laying out its own padding uses `Surface`.
 */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <Surface className={`p-4 ${className}`}>{children}</Surface>;
}

/** Card with a title row and an optional right-hand action. */
export function Panel({
  title,
  action,
  children,
  bodyClass = 'p-5 pt-0',
  className = '',
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
  className?: string;
}) {
  return (
    <Surface className={className}>
      <div className="flex items-center justify-between gap-3 p-5">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      <div className={bodyClass}>{children}</div>
    </Surface>
  );
}

export type Tone = 'brand' | 'blue' | 'amber' | 'red' | 'purple' | 'gray';

const TONE_BG: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-600',
  blue: 'bg-info-50 text-info-500',
  amber: 'bg-warn-50 text-warn-500',
  red: 'bg-danger-50 text-danger-500',
  purple: 'bg-purple-50 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
};

/** The four-across metric cards at the top of most screens. */
export function StatCard({
  icon,
  label,
  value,
  foot,
  tone = 'brand',
}: {
  icon: IconName;
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  tone?: Tone;
}) {
  return (
    <Surface className="p-5">
      <div className="flex items-start gap-4">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${TONE_BG[tone]}`}>
          <Icon name={icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="mt-0.5 truncate text-2xl font-bold text-gray-900">{value}</p>
          {foot && <div className="mt-1 text-xs text-gray-500">{foot}</div>}
        </div>
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* controls                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'soft';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const styles = {
    primary: 'bg-brand-500 text-white hover:bg-brand-600 shadow-sm',
    secondary: 'bg-white text-gray-800 border border-gray-300 hover:bg-gray-50',
    danger: 'bg-danger-500 text-white hover:bg-danger-600',
    ghost: 'text-gray-600 hover:bg-gray-100',
    soft: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // min-h-11: the panel lives on a counter tablet and is used with a
      // thumb, so touch targets stay comfortably above 44px.
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-0.5 text-danger-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

/**
 * On/off switch.
 *
 * A `role="switch"` button rather than a styled checkbox: the panel is used on
 * a counter tablet by thumb, and this gives a 44px target and an unambiguous
 * announcement to a screen reader without fighting native checkbox rendering.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand-500' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export const inputClass =
  'w-full rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export function SearchInput({
  value,
  onChange,
  placeholder,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Icon
        name="search"
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${inputClass} pl-10`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* feedback                                                                    */
/* -------------------------------------------------------------------------- */

const PILL_TONE: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-600',
  blue: 'bg-info-50 text-info-500',
  amber: 'bg-warn-50 text-warn-500',
  red: 'bg-danger-50 text-danger-500',
  purple: 'bg-purple-50 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
};

export function Pill({ children, tone = 'gray' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_STYLES: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_PAYMENT]: 'bg-warn-50 text-warn-500',
  [OrderStatus.PAYMENT_CONFIRMED]: 'bg-brand-50 text-brand-600',
  [OrderStatus.ORDER_PLACED]: 'bg-info-50 text-info-500',
  [OrderStatus.STORE_ACCEPTED]: 'bg-info-50 text-info-500',
  [OrderStatus.PREPARING]: 'bg-warn-50 text-warn-500',
  [OrderStatus.READY_FOR_PICKUP]: 'bg-brand-100 text-brand-700',
  [OrderStatus.OUT_FOR_DELIVERY]: 'bg-purple-50 text-purple-600',
  [OrderStatus.DELIVERED]: 'bg-brand-50 text-brand-600',
  [OrderStatus.CANCELLED]: 'bg-danger-50 text-danger-500',
  [OrderStatus.PAYMENT_FAILED]: 'bg-danger-50 text-danger-500',
  [OrderStatus.REJECTED]: 'bg-danger-50 text-danger-500',
  [OrderStatus.REFUNDED]: 'bg-gray-100 text-gray-600',
};

export function StatusPill({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[status]}`}
    >
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger-500/30 bg-danger-50 px-3.5 py-2.5 text-sm text-danger-600"
    >
      {message}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 p-10 text-center">
      <p className="font-medium text-gray-700">{title}</p>
      {hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
      {label}
    </div>
  );
}

/** Retained from the first cut of the panel; still used by Delivery and Config. */
export function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    default: 'text-gray-900',
    good: 'text-brand-600',
    warn: 'text-warn-500',
    bad: 'text-danger-500',
  }[tone];

  return (
    <Surface className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
    </Surface>
  );
}

/* -------------------------------------------------------------------------- */
/* overlay                                                                     */
/* -------------------------------------------------------------------------- */

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  // Escape closes, and the body is locked so the page behind does not scroll
  // away under the dialog on a tablet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/40 p-0 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl ${
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>

        {footer && (
          <div className="flex justify-end gap-3 border-t border-gray-200 bg-gray-50 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* table                                                                       */
/* -------------------------------------------------------------------------- */

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <Surface className="overflow-hidden">
      <div className="overflow-x-auto">{children}</div>
    </Surface>
  );
}

export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={`whitespace-nowrap px-5 py-3.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-5 py-3.5 align-middle ${className}`}>{children}</td>;
}

/** Square product thumbnail with a graceful fallback when there is no image. */
export function Thumb({ src, alt }: { src?: string | null; alt: string }) {
  // Rewritten to a same-origin path — see lib/image.ts for why that matters.
  const resolved = imageSrc(src);

  if (!resolved) {
    return (
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-400">
        <Icon name="image" className="h-5 w-5" />
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt}
      loading="lazy"
      className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 bg-white object-cover"
    />
  );
}

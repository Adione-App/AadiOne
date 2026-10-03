/**
 * Seller-panel building blocks on top of components/ui.tsx: skeleton
 * loaders, compact metric tiles, toasts, search + filter controls and empty
 * states. Presentation only — no data fetching here.
 */

import { useEffect, useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { create } from 'zustand';
import { Icon, Surface, type IconName, type Tone } from '@/components/ui';

/* -------------------------------------------------------------------------- */
/* skeletons                                                                   */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-lg bg-gray-200/80 ${className}`} />;
}

/** A labelled loading region: screen readers hear the label, everyone else sees shapes. */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonTiles({ count = 4, label = 'Loading…' }: { count?: number; label?: string }) {
  return (
    <Loading label={label}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: count }, (_, index) => (
          <Surface key={index} className="space-y-2 p-3.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-6 w-14" />
          </Surface>
        ))}
      </div>
    </Loading>
  );
}

export function SkeletonList({ rows = 4, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <Loading label={label}>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <Surface key={index} className="flex items-center gap-3 p-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-8 w-16" />
          </Surface>
        ))}
      </div>
    </Loading>
  );
}

export function SkeletonBlock({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <Loading label={label}>
      <Surface className="space-y-3 p-5">
        <Skeleton className="h-5 w-40" />
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className={`h-4 ${index % 2 ? 'w-3/4' : 'w-full'}`} />
        ))}
      </Surface>
    </Loading>
  );
}

/* -------------------------------------------------------------------------- */
/* metric tile                                                                 */
/* -------------------------------------------------------------------------- */

const TILE_TONE: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-600',
  blue: 'bg-info-50 text-info-500',
  amber: 'bg-warn-50 text-warn-500',
  red: 'bg-danger-50 text-danger-500',
  purple: 'bg-purple-50 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
};

/** Small number card; a link when `to` is given. `value` null = could not load. */
export function MetricTile({
  label,
  value,
  icon,
  tone = 'brand',
  to,
  hint,
}: {
  label: string;
  value: ReactNode | null;
  icon: IconName;
  tone?: Tone;
  to?: string;
  hint?: string;
}) {
  const body = (
    <Surface className={`flex h-full items-start gap-3 p-3.5 transition ${to ? 'hover:border-brand-200 hover:shadow' : ''}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TILE_TONE[tone]}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium leading-tight text-gray-500">{label}</span>
        <span className="mt-0.5 block truncate text-xl font-bold leading-tight text-gray-900">{value ?? '—'}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-tight text-gray-400">{hint}</span>}
      </span>
    </Surface>
  );
  return to ? (
    <Link to={to} className="block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
      {body}
    </Link>
  ) : (
    body
  );
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

const DOT: Record<Tone, string> = {
  brand: 'bg-brand-500',
  blue: 'bg-info-500',
  amber: 'bg-warn-500',
  red: 'bg-danger-500',
  purple: 'bg-purple-500',
  gray: 'bg-gray-400',
};

/** Coloured dot + words — colour is never the only signal. */
export function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-800">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

/** Complete / Pending / Needs attention, with an icon as well as a colour. */
export function CheckState({ state }: { state: 'complete' | 'pending' | 'attention' }) {
  const look = {
    complete: { icon: 'check' as const, text: 'Complete', cls: 'bg-brand-50 text-brand-700' },
    pending: { icon: 'clock' as const, text: 'Pending', cls: 'bg-warn-50 text-warn-500' },
    attention: { icon: 'alert' as const, text: 'Needs attention', cls: 'bg-danger-50 text-danger-600' },
  }[state];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${look.cls}`}>
      <Icon name={look.icon} className="h-3.5 w-3.5" />
      {look.text}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* toasts                                                                      */
/* -------------------------------------------------------------------------- */

interface Toast {
  id: number;
  text: string;
  ok: boolean;
}

interface ToastState {
  toasts: Toast[];
  push: (text: string, ok?: boolean) => void;
  dismiss: (id: number) => void;
}

let nextToastId = 1;

/** Subtle confirmations ("Stock updated") for actions without an inline message. */
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (text, ok = true) =>
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id: nextToastId++, text, ok }] })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** Shorthand: `toast('Price updated')`. */
export function toast(text: string, ok = true): void {
  useToasts.getState().push(text, ok);
}

function ToastItem({ item }: { item: Toast }) {
  const dismiss = useToasts((state) => state.dismiss);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), item.ok ? 3500 : 6000);
    return () => window.clearTimeout(timer);
  }, [item, dismiss]);
  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
        item.ok ? 'bg-gray-900 text-white' : 'bg-danger-600 text-white'
      }`}
    >
      <Icon name={item.ok ? 'check' : 'alert'} className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{item.text}</span>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)} className="-m-1 rounded p-1 text-white/70 hover:text-white">
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Rendered once by the seller layout; above the phone tab bar. */
export function ToastRegion() {
  const toasts = useToasts((state) => state.toasts);
  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-3 bottom-20 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:items-end lg:bottom-6"
    >
      {toasts.map((item) => (
        <div key={item.id} className="w-full max-w-sm">
          <ToastItem item={item} />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* search + filters                                                            */
/* -------------------------------------------------------------------------- */

/** Search input with a clear (×) button. `label` is announced, not shown. */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-10 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** A compact labelled select for filters and sorting. */
export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-500">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Horizontal, scrollable chip row (single choice). */
export function ChipTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; count?: number | null }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="tablist" aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400 ${
              selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
            }`}
          >
            {option.label}
            {option.count !== undefined && option.count !== null && (
              <span className={`text-xs font-medium ${selected ? 'text-white/80' : 'text-gray-400'}`}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* empty + error                                                               */
/* -------------------------------------------------------------------------- */

export function EmptyPanel({
  icon = 'box',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white/60 px-6 py-10 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <p className="mt-3 font-semibold text-gray-800">{title}</p>
      {hint && <p className="mt-1 text-sm text-gray-500">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** A failed load, with a retry. The message is already seller-safe. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger-500/30 bg-danger-50 px-4 py-3 text-sm text-danger-600">
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="rounded-lg border border-danger-500/40 bg-white px-3 py-1.5 text-xs font-semibold text-danger-600 hover:bg-danger-50">
        Try again
      </button>
    </div>
  );
}

/** Card heading with an optional link on the right. */
export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export const linkClass =
  'inline-flex items-center gap-1 rounded-lg text-sm font-semibold text-brand-600 outline-none hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-400';

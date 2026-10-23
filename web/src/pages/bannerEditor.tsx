/**
 * Banner editor pieces (Banners.tsx): the tap-target picker (real categories,
 * products, stores, restaurants and product listings from the live APIs —
 * nothing hardcoded), the presentation controls, the schedule and a
 * phone-sized preview drawn with the SAME sizing rules the app uses
 * (`resolveBannerLayout` + `bannerFrameSize` in @shared).
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BANNER_ASPECT_PRESETS,
  BANNER_BACKGROUNDS,
  BANNER_HEIGHT_LIMITS,
  BANNER_RAIL_TARGETS,
  BANNER_SIDE_MARGIN,
  BANNER_VARIANTS,
  CONTENT_COLOR_PRESETS,
  CONTENT_COLOR_PRESET_LABELS,
  bannerFrameSize,
  isFoodSellerType,
  resolveBannerLayout,
  type AdminBannerDto,
  type BannerBackground,
  type BannerLayoutDto,
  type BannerVariant,
} from '@shared';
import { Field, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { sellersApi } from '@/lib/sellers';
import type { MarketplaceProducts } from '@/lib/marketplace';

type ActionType = AdminBannerDto['actionType'];

export const ACTION_LABEL: Record<ActionType, string> = {
  NONE: 'Nothing (decorative image)',
  CATEGORY: 'Opens a category or subcategory',
  PRODUCT: 'Opens a product',
  STORE: 'Opens a store',
  RESTAURANT: 'Opens a restaurant or cafe',
  RAIL: 'Opens a product listing',
  URL: 'Opens a web link (https)',
  COUPON: 'Copies a coupon code',
};

export const VARIANT_LABEL: Record<BannerVariant, string> = {
  banner: 'Banner — an image, several become a carousel',
  card: 'Card — compact image with its title beside it',
  tile: 'Tile — small images side by side',
  strip: 'Strip — slim full-width announcement',
  split: 'Split — headline left, image right (Food hero)',
};

/* -------------------------------------------------------------------------- */
/* Tap target                                                                  */
/* -------------------------------------------------------------------------- */

function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Search-as-you-type over a live list; picking an entry stores its id. */
type SearchKind = 'product' | 'store' | 'restaurant';

function SearchPick({
  kind,
  label,
  value,
  placeholder,
  onChange,
}: {
  kind: SearchKind;
  label: string;
  value: string;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  const { isFetching, options } = useTargetSearch(kind, useDebounced(term.trim()));
  return (
    <Field label={label} required hint={value ? `Selected: ${pickedLabel ?? value}` : 'Type to search, then pick one.'}>
      <input className={inputClass} value={term} placeholder={placeholder} onChange={(event) => setTerm(event.target.value)} />
      {term.trim().length > 0 && (
        <ul className="mt-1 max-h-48 overflow-auto rounded-xl border border-gray-200 bg-white text-sm shadow-sm">
          {isFetching && options.length === 0 ? (
            <li className="px-3 py-2 text-gray-500">Searching…</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-gray-500">No match.</li>
          ) : (
            options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className={`w-full px-3 py-2 text-left hover:bg-brand-50 ${option.id === value ? 'font-semibold text-brand-700' : 'text-gray-800'}`}
                  onClick={() => {
                    onChange(option.id);
                    setPickedLabel(option.label);
                    setTerm('');
                  }}
                >
                  {option.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </Field>
  );
}

/** Live search for a product, a store or a restaurant — one query per settled term. */
function useTargetSearch(kind: SearchKind, term: string) {
  const query = useQuery({
    queryKey: ['admin', 'banner-target', kind, term],
    queryFn: async (): Promise<{ id: string; label: string }[]> => {
      if (kind === 'product') {
        const page = await api.get<MarketplaceProducts>(`/admin/marketplace/products?q=${encodeURIComponent(term)}&visibility=BUYABLE&pageSize=8`);
        return page.items.map((row) => ({ id: row.productId, label: row.productName }));
      }
      const page = await sellersApi.list({ search: term, isActive: true }, null);
      return page.items
        .filter((seller) => isFoodSellerType(seller.sellerType) === (kind === 'restaurant'))
        .map((seller) => ({ id: seller.id, label: `${seller.name} · ${seller.city}` }));
    },
    enabled: term.length > 0,
  });
  return { isFetching: query.isFetching, options: query.data ?? [] };
}

export function TargetPicker({
  actionType,
  value,
  categoryOptions,
  onChange,
}: {
  actionType: ActionType;
  value: string;
  categoryOptions: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  switch (actionType) {
    case 'CATEGORY':
      return (
        <Field label="Category" required hint="Every live category and subcategory — new ones appear here by themselves.">
          <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose a category…</option>
            {categoryOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'PRODUCT':
      return <SearchPick key="product" kind="product" label="Product" value={value} placeholder="Search products by name" onChange={onChange} />;
    case 'STORE':
      return (
        <SearchPick key="store" kind="store" label="Store" value={value} placeholder="Search stores by name" onChange={onChange} />
      );
    case 'RESTAURANT':
      return (
        <SearchPick key="restaurant" kind="restaurant" label="Restaurant or cafe" value={value} placeholder="Search restaurants by name" onChange={onChange} />
      );
    case 'RAIL':
      return (
        <Field label="Product listing" required hint="Opens that list of products in the app.">
          <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">Choose a listing…</option>
            {BANNER_RAIL_TARGETS.map((rail) => (
              <option key={rail.key} value={rail.key}>
                {rail.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'URL':
      return (
        <Field label="Web link" required hint="Only https:// links. The app opens it in the phone's browser.">
          <input className={inputClass} value={value} maxLength={500} placeholder="https://" onChange={(event) => onChange(event.target.value.trim())} />
        </Field>
      );
    case 'COUPON':
      return (
        <Field label="Coupon code" required hint="Tapping the banner copies this code.">
          <input className={inputClass} value={value} maxLength={40} onChange={(event) => onChange(event.target.value.toUpperCase())} />
        </Field>
      );
    default:
      return <span />;
  }
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

export function LayoutControls({
  layout,
  defaultVariant,
  onChange,
}: {
  layout: BannerLayoutDto;
  defaultVariant: BannerVariant;
  onChange: (layout: BannerLayoutDto) => void;
}) {
  const resolved = resolveBannerLayout(layout, defaultVariant);
  const set = (patch: BannerLayoutDto) => onChange({ ...resolved, ...patch });
  const aspectValue = resolved.aspectRatio === null ? '' : String(resolved.aspectRatio);
  const presetMatch = BANNER_ASPECT_PRESETS.find((preset) => (preset.value === null ? '' : String(preset.value)) === aspectValue);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Display style">
        <select className={inputClass} value={resolved.variant} onChange={(event) => set({ variant: event.target.value as BannerVariant })}>
          {BANNER_VARIANTS.map((variant) => (
            <option key={variant} value={variant}>
              {VARIANT_LABEL[variant]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Frame shape" hint="Used unless a fixed height is set.">
        <select
          className={inputClass}
          value={presetMatch ? aspectValue : 'custom'}
          onChange={(event) => set({ aspectRatio: event.target.value === '' ? null : Number(event.target.value) })}
          disabled={resolved.height !== null}
        >
          {BANNER_ASPECT_PRESETS.map((preset) => (
            <option key={preset.label} value={preset.value === null ? '' : String(preset.value)}>
              {preset.label}
            </option>
          ))}
          {!presetMatch && <option value="custom">Custom ({resolved.aspectRatio?.toFixed(2)} : 1)</option>}
        </select>
      </Field>
      <Field label="Fixed height (optional)" hint={`${BANNER_HEIGHT_LIMITS.min}–${BANNER_HEIGHT_LIMITS.max} dp. Empty = from the frame shape.`}>
        <input
          className={inputClass}
          inputMode="numeric"
          value={resolved.height ?? ''}
          placeholder="Auto"
          onChange={(event) => {
            const raw = event.target.value.replace(/[^0-9]/g, '');
            set({ height: raw === '' ? null : Number(raw) });
          }}
          onBlur={() => onChange(resolveBannerLayout({ ...resolved }, defaultVariant))}
        />
      </Field>
      <Field label="Width">
        <select className={inputClass} value={resolved.width} onChange={(event) => set({ width: event.target.value as 'full' | 'content' })}>
          <option value="content">Inside the screen margins</option>
          <option value="full">Full width, edge to edge</option>
        </select>
      </Field>
      <Field label="Image fit" hint="Contain: shows the whole image, may leave empty space. Cover: fills the frame, may crop the edges. Never stretched.">
        <select className={inputClass} value={resolved.fit} onChange={(event) => set({ fit: event.target.value as 'contain' | 'cover' })}>
          <option value="contain">Contain — whole image</option>
          <option value="cover">Cover — fill the frame</option>
        </select>
      </Field>
      <Field label="Image position" hint="Where the image sits (contain) or which part stays (cover).">
        <div className="flex gap-2">
          <select className={inputClass} value={resolved.alignX} onChange={(event) => set({ alignX: event.target.value as 'left' | 'center' | 'right' })}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
          <select className={inputClass} value={resolved.alignY} onChange={(event) => set({ alignY: event.target.value as 'top' | 'center' | 'bottom' })}>
            <option value="top">Top</option>
            <option value="center">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
      </Field>
      <Field label="Corners">
        <select className={inputClass} value={resolved.radius} onChange={(event) => set({ radius: event.target.value as 'none' | 'sm' | 'md' | 'lg' })}>
          <option value="none">Square</option>
          <option value="sm">Slightly rounded</option>
          <option value="md">Rounded</option>
          <option value="lg">Very rounded</option>
        </select>
      </Field>
      <Field label="Background" hint="Fills any space a contained image leaves; on a top card, the whole card.">
        <div className="flex items-center gap-2">
          <span className="h-6 w-6 shrink-0 rounded border border-gray-300" style={{ background: BACKGROUND[resolved.background] }} aria-hidden />
          <select
            className={inputClass}
            value={resolved.background}
            onChange={(event) => set({ background: event.target.value as BannerBackground })}
          >
            {BANNER_BACKGROUNDS.map((value) => (
              <option key={value} value={value}>
                {CONTENT_COLOR_PRESET_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field label="Text colour" hint="For a title drawn on the image (top cards).">
        <select className={inputClass} value={resolved.textTone} onChange={(event) => set({ textTone: event.target.value as 'dark' | 'light' })}>
          <option value="dark">Dark text (light artwork)</option>
          <option value="light">White text (dark artwork)</option>
        </select>
      </Field>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

/** ISO → the value of an <input type="datetime-local"> (local time); '' for none. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) → ISO; null for empty. */
export function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

/* -------------------------------------------------------------------------- */
/* Phone preview                                                               */
/* -------------------------------------------------------------------------- */

const PHONE_WIDTH = 360;
const RADIUS_PX = { none: 0, sm: 6, md: 10, lg: 14 } as const;
/** The same named colours the app draws (shared CONTENT_COLOR_PRESETS). */
const BACKGROUND = CONTENT_COLOR_PRESETS;
const ALIGN = { left: 'left', center: 'center', right: 'right', top: 'top', bottom: 'bottom' } as const;

/**
 * The banner on a 360-dp-wide phone, drawn with the app's own sizing rules —
 * so the admin sees the frame, fit and cropping before publishing.
 */
export function PhonePreview({
  layout,
  defaultVariant,
  imageUrl,
  imageWidth,
  imageHeight,
  title,
  subtitle,
  ctaLabel,
}: {
  layout: BannerLayoutDto;
  defaultVariant: BannerVariant;
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  title: string;
  subtitle: string;
  ctaLabel: string;
}) {
  const resolved = resolveBannerLayout(layout, defaultVariant);
  const aspect = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 2;
  const frame = bannerFrameSize(resolved, PHONE_WIDTH, aspect, 1);
  const image = imageUrl ? (
    <img
      src={imageUrl}
      alt=""
      style={{
        width: '100%',
        height: '100%',
        objectFit: resolved.fit,
        objectPosition: `${ALIGN[resolved.alignX]} ${ALIGN[resolved.alignY]}`,
      }}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-xs text-gray-400">Image</div>
  );
  const box = (width: number) => ({
    width,
    height: frame.height,
    borderRadius: RADIUS_PX[resolved.radius],
    background: BACKGROUND[resolved.background],
    overflow: 'hidden' as const,
    flexShrink: 0,
  });
  const words = title.trim().split(/\s+/).filter(Boolean);

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Preview — phone {PHONE_WIDTH} dp · frame {frame.width}×{frame.height}
      </p>
      <div className="mx-auto rounded-[28px] border-8 border-gray-800 bg-white py-3" style={{ width: PHONE_WIDTH + 16 }}>
        <div style={{ paddingLeft: resolved.width === 'full' && resolved.variant !== 'tile' ? 0 : BANNER_SIDE_MARGIN }}>
          {resolved.variant === 'split' ? (
            <div className="flex items-center gap-3 rounded-2xl bg-[#F1F9F3] p-3" style={{ width: frame.width }}>
              <div className="min-w-0 flex-1">
                {words.length > 0 && (
                  <p className="text-lg font-extrabold leading-tight text-gray-900">
                    {words.length >= 3 ? words.slice(0, -2).join(' ') : words.join(' ')}{' '}
                    {words.length >= 3 && <span className="text-[#17762F]">{words.slice(-2).join(' ')}</span>}
                  </p>
                )}
                {subtitle.trim() && <p className="mt-1 text-xs text-gray-600">{subtitle}</p>}
                {ctaLabel.trim() && <span className="mt-2 inline-block rounded-full bg-[#17762F] px-3 py-1 text-xs font-bold text-white">{ctaLabel}</span>}
              </div>
              <div style={box(frame.imageWidth)}>{image}</div>
            </div>
          ) : resolved.variant === 'card' ? (
            <div className="flex items-center gap-3 rounded-2xl border border-gray-100 p-2" style={{ width: frame.width }}>
              <div style={box(frame.imageWidth)}>{image}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-gray-900">{title || 'Title'}</p>
                {subtitle && <p className="text-xs text-gray-600">{subtitle}</p>}
              </div>
            </div>
          ) : (
            <div style={box(frame.width)}>{image}</div>
          )}
          {resolved.variant === 'banner' && (title || subtitle) && (
            <div className="mt-1.5" style={{ width: frame.width }}>
              {title && <p className="text-sm font-bold text-gray-900">{title}</p>}
              {subtitle && <p className="text-xs text-gray-600">{subtitle}</p>}
            </div>
          )}
        </div>
        <div className="mx-4 mt-3 h-16 rounded-xl bg-gray-100" aria-hidden />
      </div>
    </div>
  );
}

/** Statuses as the admin list shows them. */
export const VISIBILITY_LABEL: Record<NonNullable<AdminBannerDto['visibility']>, { text: string; tone: 'brand' | 'blue' | 'amber' | 'gray' | 'red' | 'purple' }> = {
  LIVE: { text: 'Live', tone: 'brand' },
  SCHEDULED: { text: 'Scheduled', tone: 'blue' },
  ENDED: { text: 'Ended', tone: 'amber' },
  OFF: { text: 'Switched off', tone: 'gray' },
  DRAFT: { text: 'Draft', tone: 'purple' },
  ARCHIVED: { text: 'Archived', tone: 'gray' },
};

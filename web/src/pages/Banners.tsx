/**
 * Banners — admin-managed promotional images (GET/POST/PATCH/DELETE
 * /admin/banners).
 *
 * A banner belongs to a PLACEMENT — a slug such as "home_top", "home_middle",
 * "food" or "category:<id>". The customer app asks for a placement and gets its
 * active banners in order; today it shows "home_top" (the Home carousel, which
 * falls back to the app's built-in banners while none is active). Images are
 * uploaded like every other image and stored as optimised WebP by the server.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Permission, roleHasPermission, type AdminBannerDto } from '@shared';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Pill, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { adminErrorMessage, useMarketplaceCatalogue } from '@/lib/marketplace';
import {
  BANNER_PLACEMENTS,
  bannerKeys,
  createBanner,
  deleteBanner,
  placementLabel,
  updateBanner,
  uploadAdminImage,
  useAdminBanners,
  type BannerFields,
} from '@/lib/content';

type Notice = { ok: boolean; text: string };
type Editing = { mode: 'create' } | { mode: 'edit'; banner: AdminBannerDto };

const ACTION_LABEL: Record<AdminBannerDto['actionType'], string> = {
  NONE: 'Nothing (image only)',
  CATEGORY: 'Opens a category',
  PRODUCT: 'Opens a product',
  COUPON: 'Applies a coupon',
};

export default function BannersPage() {
  const role = useAuth((state) => state.user?.role);
  const canEdit = role ? roleHasPermission(role, Permission.CATALOG_WRITE) : false;
  const queryClient = useQueryClient();
  const banners = useAdminBanners();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: bannerKeys.all });

  const toggle = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) => updateBanner(input.id, { isActive: input.isActive }),
    onSuccess: (banner) => setNotice({ ok: true, text: `Banner ${banner.isActive ? 'enabled' : 'disabled'}.` }),
    onError: (error) => setNotice({ ok: false, text: adminErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBanner(id),
    onSuccess: () => setNotice({ ok: true, text: 'Banner deleted.' }),
    onError: (error) => setNotice({ ok: false, text: adminErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  const groups = useMemo(() => {
    const byPlacement = new Map<string, AdminBannerDto[]>();
    for (const banner of banners.data ?? []) byPlacement.set(banner.placement, [...(byPlacement.get(banner.placement) ?? []), banner]);
    return [...byPlacement.entries()];
  }, [banners.data]);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="image" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Banners show in the customer app by <span className="font-semibold">placement</span>. The app shows{' '}
          <span className="font-semibold">Home — top carousel</span> today (with its built-in banners while none is active); other
          placements are saved now and shown once the app asks for them. Recommended Home banner size: 1983 × 793 px (2.5 : 1), at
          least 600 px wide. Every image is stored as an optimised WebP.
        </p>
      </div>

      {notice && (
        <p
          role="status"
          className={`rounded-xl px-3.5 py-2.5 text-sm font-medium ${notice.ok ? 'bg-brand-50 text-brand-700' : 'bg-danger-50 text-danger-600'}`}
        >
          {notice.text}
        </p>
      )}

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing({ mode: 'create' })}>
            <Icon name="plus" className="h-4 w-4" /> New banner
          </Button>
        </div>
      )}

      {banners.isPending ? (
        <Spinner label="Loading banners…" />
      ) : banners.isError ? (
        <ErrorBanner message={adminErrorMessage(banners.error)} />
      ) : groups.length === 0 ? (
        <EmptyState title="No banners yet" hint="Create one to replace the app's built-in Home banners." />
      ) : (
        groups.map(([placement, list]) => (
          <Surface key={placement} className="p-3.5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-gray-900">{placementLabel(placement)}</h2>
              <span className="text-xs text-gray-500">
                {placement} · {list.filter((b) => b.isActive).length} active of {list.length}
              </span>
            </div>
            <ul className="space-y-3" aria-label={`${placementLabel(placement)} banners`}>
              {list.map((banner) => (
                <li key={banner.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 p-2.5">
                  <img
                    src={imageSrc(banner.imageUrl)}
                    alt={banner.title ?? 'Banner'}
                    className="w-48 shrink-0 rounded-lg border border-gray-200 object-cover"
                    style={{ aspectRatio: `${banner.imageWidth} / ${banner.imageHeight}` }}
                  />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-semibold text-gray-900">{banner.title || 'Untitled banner'}</p>
                    {banner.subtitle && <p className="text-gray-600">{banner.subtitle}</p>}
                    <p className="mt-1 text-xs text-gray-500">
                      {ACTION_LABEL[banner.actionType]}
                      {banner.actionValue ? `: ${banner.actionValue}` : ''} · order {banner.displayOrder} · {banner.imageWidth}×
                      {banner.imageHeight}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={banner.isActive ? 'brand' : 'gray'}>{banner.isActive ? 'Active' : 'Disabled'}</Pill>
                    {canEdit && (
                      <>
                        <Toggle
                          checked={banner.isActive}
                          label={`${banner.isActive ? 'Disable' : 'Enable'} this banner`}
                          disabled={toggle.isPending}
                          onChange={(next) => toggle.mutate({ id: banner.id, isActive: next })}
                        />
                        <Button variant="secondary" onClick={() => setEditing({ mode: 'edit', banner })}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm('Delete this banner? Its image is removed too.')) remove.mutate(banner.id);
                          }}
                        >
                          <Icon name="trash" className="h-4 w-4" /> Delete
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Surface>
        ))
      )}

      {editing && (
        <BannerModal
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setNotice({ ok: true, text });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function BannerModal({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const current = editing.mode === 'edit' ? editing.banner : null;
  const presetValues = BANNER_PLACEMENTS.map((p) => p.value);
  const [placementChoice, setPlacementChoice] = useState(
    current ? (presetValues.includes(current.placement) ? current.placement : 'OTHER') : 'home_top',
  );
  const [customPlacement, setCustomPlacement] = useState(current && !presetValues.includes(current.placement) ? current.placement : '');
  const [title, setTitle] = useState(current?.title ?? '');
  const [subtitle, setSubtitle] = useState(current?.subtitle ?? '');
  const [actionType, setActionType] = useState<AdminBannerDto['actionType']>(current?.actionType ?? 'NONE');
  const [actionValue, setActionValue] = useState(current?.actionValue ?? '');
  const [displayOrder, setDisplayOrder] = useState(String(current?.displayOrder ?? 0));
  const [isActive, setIsActive] = useState(current?.isActive ?? true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Categories for the "opens a category" picker: one per merged category / subcategory.
  const catalogue = useMarketplaceCatalogue({});
  const categoryOptions = useMemo(
    () =>
      (catalogue.data?.categories ?? []).flatMap((top) => [
        ...(top.sellers[0] ? [{ id: top.sellers[0].categoryId, label: top.name }] : []),
        ...top.subcategories.flatMap((sub) => (sub.sellers[0] ? [{ id: sub.sellers[0].categoryId, label: `${top.name} › ${sub.name}` }] : [])),
      ]),
    [catalogue.data],
  );

  function chooseFile(next: File | undefined): void {
    if (!next) return;
    const invalid = validateImage(next);
    if (invalid) return setError(invalid);
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
  }

  async function save(): Promise<void> {
    setError(null);
    const placement = placementChoice === 'OTHER' ? customPlacement.trim() : placementChoice;
    if (!placement) return setError('Choose where the banner shows.');
    if (!current && !file) return setError('Choose a banner image.');
    if (actionType !== 'NONE' && !actionValue.trim()) return setError('Choose what the banner opens.');
    const order = Number(displayOrder);
    if (!Number.isInteger(order) || order < 0) return setError('Order must be a whole number, 0 or more.');

    const fields: BannerFields = {
      placement,
      title: title.trim() || null,
      subtitle: subtitle.trim() || null,
      actionType,
      actionValue: actionType === 'NONE' ? null : actionValue.trim(),
      displayOrder: order,
      isActive,
    };
    try {
      let imageKey: string | undefined;
      if (file) {
        setSaving('Uploading image…');
        imageKey = await uploadAdminImage(file, 'banner');
      }
      setSaving('Saving…');
      if (current) await updateBanner(current.id, { ...fields, ...(imageKey ? { imageKey } : {}) });
      else await createBanner({ ...fields, imageKey: imageKey! });
      if (preview) URL.revokeObjectURL(preview);
      await onSaved(current ? 'Banner updated.' : 'Banner created.');
    } catch (failure) {
      setError(adminErrorMessage(failure, 'The banner could not be saved. Please try again.'));
    } finally {
      setSaving(null);
    }
  }

  const shown = preview ?? (current ? imageSrc(current.imageUrl) : undefined);

  return (
    <Modal
      title={current ? 'Edit banner' : 'New banner'}
      subtitle="Stored as an optimised WebP image."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={Boolean(saving)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={Boolean(saving)}>
            {saving ?? (current ? 'Save changes' : 'Create banner')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorBanner message={error} />

        <Field label="Banner image" required={!current} hint="JPEG, PNG, WebP or AVIF, up to 5 MB, at least 600 px wide.">
          <div className="space-y-2">
            {shown && (
              <img
                src={shown}
                alt="Banner preview"
                className="w-full max-w-md rounded-xl border border-gray-200 object-cover"
                style={current && !preview ? { aspectRatio: `${current.imageWidth} / ${current.imageHeight}` } : undefined}
              />
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
              <Icon name="upload" className="h-4 w-4" />
              {shown ? 'Replace image' : 'Choose image'}
              <input
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                className="sr-only"
                onChange={(event) => {
                  chooseFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Placement" required>
            <select className={inputClass} value={placementChoice} onChange={(event) => setPlacementChoice(event.target.value)}>
              {BANNER_PLACEMENTS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                  {p.live ? '' : ' (not shown in the app yet)'}
                </option>
              ))}
              <option value="OTHER">Other placement…</option>
            </select>
          </Field>
          {placementChoice === 'OTHER' ? (
            <Field label="Placement key" required hint='Lowercase slug, e.g. "home_offers" or "category:<id>".'>
              <input className={inputClass} value={customPlacement} maxLength={60} onChange={(event) => setCustomPlacement(event.target.value)} />
            </Field>
          ) : (
            <span />
          )}
          <Field label="Title" hint="Optional — for accessibility and admin lists.">
            <input className={inputClass} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Subtitle" hint="Optional.">
            <input className={inputClass} value={subtitle} maxLength={200} onChange={(event) => setSubtitle(event.target.value)} />
          </Field>
          <Field label="On tap">
            <select
              className={inputClass}
              value={actionType}
              onChange={(event) => {
                setActionType(event.target.value as AdminBannerDto['actionType']);
                setActionValue('');
              }}
            >
              {(Object.keys(ACTION_LABEL) as AdminBannerDto['actionType'][]).map((type) => (
                <option key={type} value={type}>
                  {ACTION_LABEL[type]}
                </option>
              ))}
            </select>
          </Field>
          {actionType === 'CATEGORY' ? (
            <Field label="Category" required>
              <select className={inputClass} value={actionValue} onChange={(event) => setActionValue(event.target.value)}>
                <option value="">Choose a category…</option>
                {categoryOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : actionType === 'PRODUCT' ? (
            <Field label="Product id" required hint="The product's id (from the Products page).">
              <input className={inputClass} value={actionValue} onChange={(event) => setActionValue(event.target.value)} />
            </Field>
          ) : actionType === 'COUPON' ? (
            <Field label="Coupon code" required>
              <input className={inputClass} value={actionValue} maxLength={40} onChange={(event) => setActionValue(event.target.value.toUpperCase())} />
            </Field>
          ) : (
            <span />
          )}
          <Field label="Order" hint="Lower numbers show first.">
            <input className={inputClass} inputMode="numeric" value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} />
          </Field>
          <Field label="Status">
            <Toggle checked={isActive} onChange={setIsActive} label={isActive ? 'Active — shown in the app' : 'Disabled — hidden'} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

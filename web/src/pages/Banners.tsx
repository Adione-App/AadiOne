/**
 * Banners — admin-managed promotional images (GET/POST/PATCH/DELETE
 * /admin/banners).
 *
 * A banner belongs to a PLACEMENT from the shared registry (BANNER_PLACEMENTS:
 * Home, Food, Categories and Store positions). Customers get a placement's
 * LIVE banners in order — PUBLISHED, switched on and inside the optional
 * schedule; a draft is saved but never shown, an archived one is retired.
 * Each banner carries its presentation (style, frame, fit, alignment —
 * previewed on a phone-sized frame with the app's own sizing rules) and a
 * validated tap target picked from the live catalogue. A placement with
 * nothing live shows nothing. Images are stored as optimised WebP.
 *
 * Also here: the Home page category order (config HOME_CATEGORY_ORDER) —
 * which top categories Home shows first. Every other category follows
 * automatically.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BANNER_PLACEMENTS,
  HOME_BANNER_PLACEMENTS,
  Permission,
  bannerPlacementInfo,
  roleHasPermission,
  type AdminBannerDto,
  type BannerLayoutDto,
  type BannerStatusDto,
} from '@shared';
import { Button, EmptyState, ErrorBanner, Field, Icon, Modal, Pill, Spinner, Surface, Toggle, inputClass } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { imageSrc } from '@/lib/image';
import { ACCEPTED_IMAGE_TYPES, validateImage } from '@/lib/upload';
import { adminErrorMessage, useMarketplaceCatalogue } from '@/lib/marketplace';
import {
  BANNER_PLACEMENT_OPTIONS,
  bannerKeys,
  createBanner,
  deleteBanner,
  placementLabel,
  reorderBanners,
  saveHomeCategoryOrder,
  updateBanner,
  uploadAdminImage,
  useAdminBanners,
  useCustomerTopCategories,
  useHomeCategoryOrder,
  type BannerFields,
} from '@/lib/content';
import { ACTION_LABEL, LayoutControls, actionNeedsTarget, PhonePreview, TargetPicker, VISIBILITY_LABEL, fromLocalInput, toLocalInput } from './bannerEditor';

type Notice = { ok: boolean; text: string };
type Editing = { mode: 'create' } | { mode: 'edit'; banner: AdminBannerDto };

/** "Mon 14 Oct, 18:00" — a schedule bound in the admin's local time. */
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: BannerStatusDto }) => updateBanner(input.id, { status: input.status }),
    onSuccess: (banner) => setNotice({ ok: true, text: banner.status === 'ARCHIVED' ? 'Banner archived.' : 'Banner restored as a draft.' }),
    onError: (error) => setNotice({ ok: false, text: adminErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  const move = useMutation({
    mutationFn: (input: { placement: string; ids: string[] }) => reorderBanners(input.placement, input.ids),
    onSuccess: () => setNotice({ ok: true, text: 'Order saved.' }),
    onError: (error) => setNotice({ ok: false, text: adminErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBanner(id),
    onSuccess: () => setNotice({ ok: true, text: 'Banner deleted.' }),
    onError: (error) => setNotice({ ok: false, text: adminErrorMessage(error) }),
    onSettled: () => refresh(),
  });

  // Placements in registry order (the app's screens top to bottom), then any others.
  const groups = useMemo(() => {
    const byPlacement = new Map<string, AdminBannerDto[]>();
    for (const banner of banners.data ?? []) byPlacement.set(banner.placement, [...(byPlacement.get(banner.placement) ?? []), banner]);
    const rank = (placement: string) => {
      const index = BANNER_PLACEMENTS.findIndex((entry) => entry.key === placement);
      return index < 0 ? BANNER_PLACEMENTS.length : index;
    };
    return [...byPlacement.entries()].sort(([a], [b]) => rank(a) - rank(b));
  }, [banners.data]);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-info-500/20 bg-info-50 px-4 py-3 text-sm text-gray-700">
        <Icon name="image" className="mt-0.5 h-5 w-5 shrink-0 text-info-500" />
        <p>
          Promotions show in the customer app by <span className="font-semibold">placement</span> — Home, Food, Categories and store
          pages. Only <span className="font-semibold">live</span> banners reach customers: published, switched on and inside their
          schedule. A placement with nothing live shows nothing at all. Changes reach the app on its next refresh — no app update
          needed. Images: at least 600 px wide; every image is stored as an optimised WebP.
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

      <HomeCategoryOrder canEdit={canEdit} onNotice={setNotice} />

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
        <EmptyState title="No banners yet" hint="Create one to show it in the customer app." />
      ) : (
        groups.map(([placement, list]) => (
          <Surface key={placement} className="p-3.5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-gray-900">{placementLabel(placement)}</h2>
              <span className="text-xs text-gray-500">
                {placement} · {list.filter((b) => b.visibility === 'LIVE').length} live of {list.length}
              </span>
            </div>
            <ul className="space-y-3" aria-label={`${placementLabel(placement)} banners`}>
              {list.map((banner, index) => (
                <li key={banner.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-100 p-2.5">
                  {canEdit && (
                    <div className="flex flex-col gap-1">
                      {(['up', 'down'] as const).map((direction) => {
                        const target = direction === 'up' ? index - 1 : index + 1;
                        return (
                          <button
                            key={direction}
                            type="button"
                            disabled={move.isPending || target < 0 || target >= list.length}
                            onClick={() => {
                              const ids = list.map((b) => b.id);
                              [ids[index], ids[target]] = [ids[target]!, ids[index]!];
                              move.mutate({ placement, ids });
                            }}
                            className="rounded-lg border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                            aria-label={`Move ${banner.title || 'banner'} ${direction}`}
                          >
                            {direction === 'up' ? '↑' : '↓'}
                          </button>
                        );
                      })}
                    </div>
                  )}
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
                      {banner.actionValue ? `: ${banner.actionValue}` : ''} · {banner.layout?.variant ?? 'banner'} · {banner.imageWidth}×
                      {banner.imageHeight}
                    </p>
                    {(banner.startsAt || banner.endsAt) && (
                      <p className="mt-0.5 text-xs text-gray-500">
                        {banner.startsAt ? `From ${when(banner.startsAt)}` : 'Now'} → {banner.endsAt ? when(banner.endsAt) : 'no end'}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={VISIBILITY_LABEL[banner.visibility ?? (banner.isActive ? 'LIVE' : 'OFF')].tone}>
                      {VISIBILITY_LABEL[banner.visibility ?? (banner.isActive ? 'LIVE' : 'OFF')].text}
                    </Pill>
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
                          disabled={setStatus.isPending}
                          onClick={() => {
                            if (banner.status === 'ARCHIVED') setStatus.mutate({ id: banner.id, status: 'DRAFT' });
                            else if (window.confirm('Archive this banner? Customers stop seeing it; you can restore it later.')) {
                              setStatus.mutate({ id: banner.id, status: 'ARCHIVED' });
                            }
                          }}
                        >
                          {banner.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
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
  const presetValues = BANNER_PLACEMENT_OPTIONS.map((p) => p.value);
  const [placementChoice, setPlacementChoice] = useState(
    current ? (presetValues.includes(current.placement) ? current.placement : 'OTHER') : 'home_top',
  );
  const [customPlacement, setCustomPlacement] = useState(current && !presetValues.includes(current.placement) ? current.placement : '');
  const [title, setTitle] = useState(current?.title ?? '');
  const [subtitle, setSubtitle] = useState(current?.subtitle ?? '');
  const [ctaLabel, setCtaLabel] = useState(current?.ctaLabel ?? '');
  const [actionType, setActionType] = useState<AdminBannerDto['actionType']>(current?.actionType ?? 'NONE');
  const [actionValue, setActionValue] = useState(current?.actionValue ?? '');
  const [displayOrder, setDisplayOrder] = useState(String(current?.displayOrder ?? 0));
  const [isActive, setIsActive] = useState(current?.isActive ?? true);
  const [status, setStatus] = useState<BannerStatusDto>(current?.status ?? 'PUBLISHED');
  const [startsAt, setStartsAt] = useState(toLocalInput(current?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(current?.endsAt));
  const [layout, setLayout] = useState<BannerLayoutDto>(current?.layout ?? {});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<{ width: number; height: number } | null>(null);
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

  const chosenPlacement = placementChoice === 'OTHER' ? customPlacement.trim() : placementChoice;
  const defaultVariant = bannerPlacementInfo(chosenPlacement.split(':')[0] ?? '')?.defaultVariant ?? 'banner';

  function chooseFile(next: File | undefined): void {
    if (!next) return;
    const invalid = validateImage(next);
    if (invalid) return setError(invalid);
    setError(null);
    if (preview) URL.revokeObjectURL(preview);
    const url = URL.createObjectURL(next);
    setFile(next);
    setPreview(url);
    // Its real size, so the preview frames it exactly as the app will.
    const probe = new Image();
    probe.onload = () => setFileSize({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.src = url;
  }

  async function save(publish: BannerStatusDto): Promise<void> {
    setError(null);
    const placement = chosenPlacement;
    if (!placement) return setError('Choose where the banner shows.');
    if (!current && !file) return setError('Choose a banner image.');
    if (actionNeedsTarget(actionType) && !actionValue.trim()) return setError('Choose what the banner opens.');
    if (placement === HOME_BANNER_PLACEMENTS.CATEGORY && actionType !== 'CATEGORY') {
      return setError('A banner shown above a category shelf must open that category. Choose "Opens a category".');
    }
    const order = Number(displayOrder);
    if (!Number.isInteger(order) || order < 0) return setError('Order must be a whole number, 0 or more.');
    const start = fromLocalInput(startsAt);
    const end = fromLocalInput(endsAt);
    if (start && end && new Date(end) <= new Date(start)) return setError('The end time must be after the start time.');

    const fields: BannerFields = {
      placement,
      title: title.trim() || null,
      subtitle: subtitle.trim() || null,
      ctaLabel: ctaLabel.trim() || null,
      actionType,
      actionValue: actionNeedsTarget(actionType) ? actionValue.trim() : null,
      displayOrder: order,
      isActive,
      status: publish,
      startsAt: start,
      endsAt: end,
      layout,
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
      await onSaved(publish === 'DRAFT' ? 'Saved as a draft — not shown to customers.' : current ? 'Banner updated.' : 'Banner published.');
    } catch (failure) {
      setError(adminErrorMessage(failure, 'The banner could not be saved. Please try again.'));
    } finally {
      setSaving(null);
    }
  }

  const shown = preview ?? (current ? imageSrc(current.imageUrl) : undefined);
  const size = fileSize ?? (current && !preview ? { width: current.imageWidth, height: current.imageHeight } : { width: 0, height: 0 });

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
          {current ? (
            <Button onClick={() => void save(status)} disabled={Boolean(saving)}>
              {saving ?? 'Save changes'}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => void save('DRAFT')} disabled={Boolean(saving)}>
                {saving ?? 'Save as draft'}
              </Button>
              <Button onClick={() => void save('PUBLISHED')} disabled={Boolean(saving)}>
                {saving ?? 'Publish'}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-5">
        <ErrorBanner message={error} />

        <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <Field label="Banner image" required={!current} hint="JPEG, PNG, WebP or AVIF, up to 5 MB, at least 600 px wide.">
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
              {size.width > 0 && <p className="mt-1 text-xs text-gray-500">{size.width} × {size.height} px</p>}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Placement" required>
                <select className={inputClass} value={placementChoice} onChange={(event) => setPlacementChoice(event.target.value)}>
                  {BANNER_PLACEMENT_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value="OTHER">Other placement…</option>
                </select>
                {BANNER_PLACEMENT_OPTIONS.find((p) => p.value === placementChoice)?.hint && (
                  <p className="mt-1 text-xs text-gray-500">{BANNER_PLACEMENT_OPTIONS.find((p) => p.value === placementChoice)?.hint}</p>
                )}
              </Field>
              {placementChoice === 'OTHER' ? (
                <Field label="Placement key" required hint='Lowercase slug — the app only shows placements it knows.'>
                  <input className={inputClass} value={customPlacement} maxLength={60} onChange={(event) => setCustomPlacement(event.target.value)} />
                </Field>
              ) : (
                <Field label="Order" hint="Lower numbers show first (or use ↑ ↓ in the list).">
                  <input className={inputClass} inputMode="numeric" value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} />
                </Field>
              )}
              <Field label="Title" hint="Optional — the headline, and for accessibility.">
                <input className={inputClass} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label="Subtitle" hint="Optional.">
                <input className={inputClass} value={subtitle} maxLength={200} onChange={(event) => setSubtitle(event.target.value)} />
              </Field>
              <Field label="Button text" hint='Optional, e.g. "Order now". Shown by the Split style.'>
                <input className={inputClass} value={ctaLabel} maxLength={40} onChange={(event) => setCtaLabel(event.target.value)} />
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
              <TargetPicker actionType={actionType} value={actionValue} categoryOptions={categoryOptions} onChange={setActionValue} />
            </div>

            <fieldset className="rounded-xl border border-gray-200 p-3">
              <legend className="px-1 text-sm font-semibold text-gray-800">Look</legend>
              <LayoutControls layout={layout} defaultVariant={defaultVariant} onChange={setLayout} />
            </fieldset>

            <fieldset className="rounded-xl border border-gray-200 p-3">
              <legend className="px-1 text-sm font-semibold text-gray-800">Publishing</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {current && (
                  <Field label="Status">
                    <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as BannerStatusDto)}>
                      <option value="PUBLISHED">Published</option>
                      <option value="DRAFT">Draft — never shown</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </Field>
                )}
                <Field label="Switch">
                  <Toggle checked={isActive} onChange={setIsActive} label={isActive ? 'On' : 'Off — hidden even when published'} />
                </Field>
                <Field label="Starts" hint="Optional. Empty = straight away.">
                  <input type="datetime-local" className={inputClass} value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
                </Field>
                <Field label="Ends" hint="Optional. Empty = until switched off.">
                  <input type="datetime-local" className={inputClass} value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
                </Field>
              </div>
            </fieldset>
          </div>

          <PhonePreview
            layout={layout}
            defaultVariant={defaultVariant}
            imageUrl={shown ?? null}
            imageWidth={size.width}
            imageHeight={size.height}
            title={title}
            subtitle={subtitle}
            ctaLabel={ctaLabel}
          />
        </div>
      </div>
    </Modal>
  );
}

/**
 * Home page category order — which top categories the customer Home page
 * shows first (config HOME_CATEGORY_ORDER, a list of category paths). Listed
 * categories get their shelves among the main shopping sections, in this
 * order; every other live category follows automatically further down, so a
 * new category never has to be added here to appear.
 */
function HomeCategoryOrder({ canEdit, onNotice }: { canEdit: boolean; onNotice: (notice: Notice) => void }) {
  const queryClient = useQueryClient();
  const saved = useHomeCategoryOrder();
  const categories = useCustomerTopCategories();
  const [draft, setDraft] = useState<string[] | null>(null);

  // Start from the saved order once it arrives; a save re-reads it.
  useEffect(() => {
    if (saved.data && draft === null) setDraft(saved.data);
  }, [saved.data, draft]);

  const byPath = useMemo(() => new Map((categories.data ?? []).map((category) => [category.slug, category])), [categories.data]);
  const order = draft ?? saved.data ?? [];
  const listed = order.filter((path) => byPath.has(path));
  const stale = order.filter((path) => !byPath.has(path));
  const others = (categories.data ?? []).filter((category) => !order.includes(category.slug));
  const dirty = JSON.stringify(order) !== JSON.stringify(saved.data ?? []);

  const save = useMutation({
    mutationFn: () => saveHomeCategoryOrder(listed),
    onSuccess: async () => {
      onNotice({ ok: true, text: 'Home category order saved. The app shows it on its next Home refresh.' });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (error) => onNotice({ ok: false, text: adminErrorMessage(error) }),
  });

  const move = (index: number, by: -1 | 1) => {
    const next = [...listed];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    setDraft(next);
  };

  return (
    <Surface className="p-3.5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">Home page category order</h2>
        <span className="text-xs text-gray-500">Categories not listed follow automatically</span>
      </div>
      <p className="mb-3 text-sm text-gray-600">
        Choose which top categories the customer Home page shows first, in order (for example groceries, then fruits &amp;
        vegetables). Every other category — including ones sellers add later — appears further down by itself.
      </p>

      {saved.isPending || categories.isPending ? (
        <Spinner label="Loading categories…" />
      ) : saved.isError || categories.isError ? (
        <ErrorBanner message={adminErrorMessage(saved.error ?? categories.error)} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-800">Shown first ({listed.length})</h3>
            {listed.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 px-3 py-4 text-sm text-gray-500">
                None — Home shows every category in its default order.
              </p>
            ) : (
              <ol className="space-y-2" aria-label="Categories shown first on Home">
                {listed.map((path, index) => (
                  <li key={path} className="flex items-center gap-2 rounded-xl border border-gray-100 px-3 py-2 text-sm">
                    <span className="w-5 text-right text-xs font-semibold text-gray-400">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{byPath.get(path)?.name ?? path}</span>
                    {canEdit && (
                      <>
                        <Button variant="ghost" disabled={index === 0} onClick={() => move(index, -1)}>
                          <span aria-hidden="true">↑</span>
                          <span className="sr-only">Move {byPath.get(path)?.name ?? path} up</span>
                        </Button>
                        <Button variant="ghost" disabled={index === listed.length - 1} onClick={() => move(index, 1)}>
                          <span aria-hidden="true">↓</span>
                          <span className="sr-only">Move {byPath.get(path)?.name ?? path} down</span>
                        </Button>
                        <Button variant="ghost" onClick={() => setDraft(listed.filter((p) => p !== path))}>
                          Remove<span className="sr-only"> {byPath.get(path)?.name ?? path}</span>
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {stale.length > 0 && (
              <p className="mt-2 text-xs text-gray-500">
                {stale.length} saved {stale.length === 1 ? 'entry has' : 'entries have'} no live category right now and {stale.length === 1 ? 'is' : 'are'} skipped; saving removes {stale.length === 1 ? 'it' : 'them'}.
              </p>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-800">Other categories (automatic)</h3>
            {others.length === 0 ? (
              <p className="text-sm text-gray-500">Every live category is listed.</p>
            ) : (
              <ul className="space-y-2" aria-label="Other categories">
                {others.map((category) => (
                  <li key={category.id} className="flex items-center gap-2 rounded-xl border border-gray-100 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-gray-700">{category.name}</span>
                    {canEdit && (
                      <Button variant="secondary" onClick={() => setDraft([...listed, category.slug])}>
                        Add<span className="sr-only"> {category.name} to the categories shown first</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setDraft(saved.data ?? [])}>
            Reset
          </Button>
          <Button disabled={(!dirty && stale.length === 0) || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save order'}
          </Button>
        </div>
      )}
    </Surface>
  );
}
